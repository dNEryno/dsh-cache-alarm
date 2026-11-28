// Pure helpers for the cache-alarm banner. No React, no DOM, no imports, so the
// same source runs under `node --test` and inside the browser bundle (build.mjs
// inlines it verbatim into client.js).

// DeepSeek official list price, USD per 1M tokens, taken from
// https://api-docs.deepseek.com/quick_start/pricing (fetched 2026-11-25).
// Off-peak is half of peak. A cache write is billed at the miss rate.
const PRICES = {
  flash: { hit: 0.006, miss: 0.3, offHit: 0.003, offMiss: 0.15 },
  pro: { hit: 0.044, miss: 1.32, offHit: 0.022, offMiss: 0.66 },
};

// Peak windows are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday.
// Chinese public holidays are also off-peak; they are not modelled here, so a
// holiday request is priced as peak, which overstates the waste, never under.
function isPeakTime(when) {
  const at = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(at.getTime())) return true;
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function priceFamily(model) {
  const id = String(model ?? '').toLowerCase();
  if (id.length === 0) return undefined;
  if (id.includes('pro')) return PRICES.pro;
  if (id.includes('flash')) return PRICES.flash;
  return undefined;
}

// The model face is one of several shapes depending on where it is read from;
// accept the common ones and fall back to empty so the price lookup degrades.
function modelNameOf(selection) {
  selection = unwrap(selection);
  if (!selection || typeof selection !== 'object') return '';
  const route = selection.route ?? selection.selected ?? selection.current ?? selection;
  const model = route?.model ?? route?.modelId ?? route?.id ?? '';
  return typeof model === 'object' && model !== null ? String(model.id ?? model.name ?? '') : String(model);
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

// A projection face may hand back the bare value or a `{ value }` wrapper
// depending on how the reader subscribes; accept both.
function unwrap(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if ('uncachedInputTokens' in raw) return raw;
  return 'value' in raw ? raw.value : raw;
}

// tokenUsage projection buckets. Cache write is optional upstream, so a missing
// bucket stays 0 rather than poisoning the rate.
function normalizeUsage(raw) {
  raw = unwrap(raw);
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = {
    uncachedInputTokens: count(raw.uncachedInputTokens),
    outputTokens: count(raw.outputTokens),
    cacheReadTokens: count(raw.cacheReadTokens),
    cacheWriteTokens: count(raw.cacheWriteTokens),
  };
  if (usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) {
    return undefined;
  }
  return usage;
}

// Prompt-side hit rate: cache reads over everything the provider billed as
// prompt. Output tokens never enter it, matching the official meter.
function hitRate(usage) {
  if (!usage) return undefined;
  const prompt = count(usage.uncachedInputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens);
  if (prompt === 0) return undefined;
  return count(usage.cacheReadTokens) / prompt;
}

// Per-message provider usage has a different vocabulary from the session
// projection: inputTokens already excludes cached reads. Both faces map to the
// same four buckets so one renderer serves the composer and every chat row.
function normalizeTurnUsage(raw) {
  raw = unwrap(raw);
  if (!raw || typeof raw !== 'object') return undefined;
  const input = count(raw.uncachedInputTokens ?? raw.inputTokens ?? raw.promptTokens);
  const output = count(raw.outputTokens ?? raw.completionTokens);
  const read = count(raw.cacheReadTokens ?? raw.cachedTokens);
  const write = count(raw.cacheWriteTokens);
  const usage = {
    uncachedInputTokens: input,
    outputTokens: output,
    cacheReadTokens: read,
    cacheWriteTokens: write,
  };
  if (input + output + read + write === 0) return undefined;
  return usage;
}

// Decode speed from the durable timing of one Assistant message. The host's
// performance panel smooths this; here it is the plain this-turn number.
// firstTokenTime -> completedTime, and outputTokens (reasoning included).
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

// Real speed for one message. Preferred: provider-visible decode window
// (first token -> assembled message). A window that recorded no token delta
// falls back to the step's full elapsed time, then to the turn window, and is
// labelled approximate so the reading never pretends to be decode-only.
function throughput(usage, timing, turnWindow) {
  if (!usage) return undefined;
  const output = count(usage.outputTokens);
  if (output === 0) return undefined;
  const done = positive(timing && timing.completedTime);
  const first = positive(timing && timing.firstTokenTime);
  const stepStart = positive(timing && timing.stepStartTime);
  if (done !== undefined && first !== undefined && done > first) {
    const decodeMs = done - first;
    if (decodeMs >= 100) {
      const ttftMs = stepStart !== undefined && first >= stepStart ? first - stepStart : undefined;
      return { tps: output * 1000 / decodeMs, ttftMs, decodeMs, outputTokens: output, exact: true };
    }
  }
  if (done !== undefined && stepStart !== undefined && done > stepStart) {
    const elapsed = done - stepStart;
    return { tps: output * 1000 / elapsed, ttftMs: undefined, decodeMs: elapsed, outputTokens: output, exact: false };
  }
  const start = positive(turnWindow && turnWindow.startTime);
  const end = positive(turnWindow && turnWindow.endTime);
  if (start !== undefined && end !== undefined && end > start) {
    const elapsed = end - start;
    return { tps: output * 1000 / elapsed, ttftMs: undefined, decodeMs: elapsed, outputTokens: output, exact: false };
  }
  return undefined;
}

function formatTps(value) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10) + ' tok/s';
}

// The raw Session event stream keeps an attempt's compact stream records, so
// the exact first-token boundary survives even when the rendered assistant
// node dropped its timing. These helpers mirror @deepseek-ai/dsh-llm's
// assistant-stream readers so the client does not depend on that module.
function isTokenDelta(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== '';
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined;
  return false;
}

function runFirstTokenTime(run) {
  if (!run || typeof run !== 'object') return undefined;
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0;
  const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts;
  if (!Array.isArray(fragments) || !Array.isArray(run.dt)) return undefined;
  let time = run.time0;
  if (!Number.isFinite(time)) return undefined;
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) {
      const gap = run.dt[index - 1];
      if (!Number.isFinite(gap)) return undefined;
      time += gap;
    }
    const fragment = fragments[index];
    if (typeof fragment === 'string' && fragment !== '') return time;
  }
  return undefined;
}

function assistantStreamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue;
    const time = record.type === 'chunk'
      ? (isTokenDelta(record.chunk) ? record.time : undefined)
      : runFirstTokenTime(record);
    if (time !== undefined) return time;
  }
  return undefined;
}
function turnFirstTokenMs(nodes, turn, turnWindow) {
  if (!Array.isArray(nodes) || turn === undefined) return undefined;
  const turnStart = positive(turnWindow && turnWindow.startTime);
  let earliest;
  for (const node of nodes) {
    if (!node || node.kind !== 'assistant' || node.turn !== turn) continue;
    const timing = node.timing;
    const first = positive(timing && timing.firstTokenTime);
    if (first === undefined) continue;
    const base = turnStart ?? positive(timing.stepStartTime);
    if (base === undefined || first < base) continue;
    const value = first - base;
    if (earliest === undefined || value < earliest) earliest = value;
  }
  return earliest;
}

// Whole-log average TTFT from the sessionStats projection: the last fallback
// when no per-turn first-token boundary survives in the loaded window.
function averageTtftMs(raw) {
  const stats = unwrap(raw);
  if (!stats || typeof stats !== 'object') return undefined;
  const steps = count(stats.ttftSteps);
  if (steps <= 0) return undefined;
  return count(stats.ttftMs) / steps;
}

// Keep an existing exact TTFT; otherwise attach the recovered one and record
// how it was obtained so the UI can label it instead of implying exactness.
function withTtft(perf, ttftMs, kind) {
  if (!perf || typeof perf !== 'object') return perf;
  if (typeof perf.ttftMs === 'number') return perf;
  if (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0) return perf;
  return { ...perf, ttftMs, ttftApprox: kind };
}

function formatSeconds(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  return (ms / 1000).toFixed(2) + 's';
}

// Whole-turn duration (user presses Enter -> turn settles), rendered in a
// human unit. A 15-minute turn must not read as "900.00s".
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms >= 3600000) {
    const hours = Math.floor(ms / 3600000);
    let minutes = Math.round((ms % 3600000) / 60000);
    if (minutes === 60) return (hours + 1) + '小时';
    return hours + '小时' + minutes + '分';
  }
  if (ms >= 60000) {
    const minutes = Math.floor(ms / 60000);
    let seconds = Math.round((ms % 60000) / 1000);
    if (seconds === 60) return (minutes + 1) + '分';
    return minutes + '分' + seconds + '秒';
  }
  return (ms / 1000).toFixed(2) + 's';
}

function turnDurationMs(turnWindow, now) {
  const start = positive(turnWindow && turnWindow.startTime);
  if (start === undefined) return undefined;
  const end = positive(turnWindow && turnWindow.endTime) ?? positive(now);
  if (end === undefined || end < start) return undefined;
  return end - start;
}

// A failed or stopped turn publishes either a TurnErrorNode or an
// interruption-frozen Assistant prefix. Both get the red cross instead of a
// hit-rate reading, because there is no valid usage to grade.
function isInterrupted(source) {
  if (!source) return false;
  if (source.interrupted === true) return true;
  const finalNode = source.kind === 'turn-tail' ? source.data?.closing?.finalNode : source.finalNode;
  return finalNode?.interrupted === true;
}

function errorForTurn(snapshot, turn) {
  if (turn === undefined) return undefined;
  const nodes = snapshot?.legacy?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  for (const node of nodes) {
    if (node && node.kind === 'turn-error' && node.turn === turn) return node;
  }
  return undefined;
}

// The composer shows the newest turn, so only a terminal error after the
// latest user message counts. A settled assistant row means the turn
// succeeded even if earlier attempts needed a retry.
function tailError(snapshot) {
  const nodes = snapshot?.legacy?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node) continue;
    if (node.kind === 'user' || node.kind === 'steering') return undefined;
    if (node.kind === 'turn-error') return node;
    if (node.kind === 'turn-max-tokens') return undefined;
    if (node.kind === 'assistant') return node.interrupted ? node : undefined;
    if (node.kind === 'model-retry' && (node.retryState === 'scheduled' || node.retryState === 'cancelled')) {
      return node;
    }
  }
  return undefined;
}

function errorLabel(error) {
  if (!error) return '';
  if (error.kind === 'model-retry') {
    return error.retryState === 'cancelled' ? '重试已取消' : '模型请求失败，重试中';
  }
  if (error.kind === 'assistant') return '已中断';
  if (error.code === 'INTERRUPTED') return '已中断';
  if (error.code === 'ACCOUNT_SIGNED_OUT') return '登录已失效';
  return '请求失败';
}

function errorDetail(error) {
  if (!error) return '';
  if (error.kind === 'model-retry') {
    const failure = error.failure || {};
    return failure.message || failure.code || '模型请求失败';
  }
  return error.message || error.code || '模型未返回结果';
}

function sumUsage(list) {
  const total = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const item of list || []) {
    if (!item) continue;
    total.uncachedInputTokens += count(item.uncachedInputTokens);
    total.outputTokens += count(item.outputTokens);
    total.cacheReadTokens += count(item.cacheReadTokens);
    total.cacheWriteTokens += count(item.cacheWriteTokens);
  }
  return total;
}

// A turn can contain several assistant steps (tool calls, retries, ...).
// "命中" is defined per user turn, so combine every durable step's usage
// instead of grading only the last assistant message.
function usageOfTurn(nodes, turn) {
  if (!Array.isArray(nodes) || turn === undefined) return undefined;
  const list = [];
  for (const node of nodes) {
    if (!node || node.kind !== 'assistant' || node.turn !== turn) continue;
    const usage = normalizeTurnUsage(node.usage);
    if (usage) list.push(usage);
  }
  return list.length > 0 ? sumUsage(list) : undefined;
}

function subtractUsage(after, before) {
  const diff = {
    uncachedInputTokens: count(after?.uncachedInputTokens) - count(before?.uncachedInputTokens),
    outputTokens: count(after?.outputTokens) - count(before?.outputTokens),
    cacheReadTokens: count(after?.cacheReadTokens) - count(before?.cacheReadTokens),
    cacheWriteTokens: count(after?.cacheWriteTokens) - count(before?.cacheWriteTokens),
  };
  const negative = Object.values(diff).some(value => value < 0);
  return negative ? undefined : diff;
}

function classify(rate, thresholds) {
  if (rate === undefined || rate === null) return 'unknown';
  const warn = thresholds?.warn ?? 0.9;
  const danger = thresholds?.danger ?? 0.8;
  if (rate < danger) return 'danger';
  if (rate < warn) return 'warn';
  return 'ok';
}

// Money the miss actually spent: had the uncached prompt portion been served
// from cache it would have been billed at the hit rate instead.
function wastedUsd(usage, model, when) {
  const family = priceFamily(model);
  if (!family || !usage) return undefined;
  const peak = isPeakTime(when);
  const hit = peak ? family.hit : family.offHit;
  const miss = peak ? family.miss : family.offMiss;
  const uncached = count(usage.uncachedInputTokens);
  return { usd: uncached * (miss - hit) / 1e6, peak, hit, miss };
}

// The first turn of a session has no prefix to hit, so it is not evidence that
// the route caches badly. Turns that billed almost no prompt are noise too.
function isEvidence(usage, history) {
  if (!usage) return false;
  if ((history?.length ?? 0) === 0) return false;
  return count(usage.uncachedInputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens) >= 1000;
}

function formatTokens(value) {
  const n = count(value);
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function formatRate(rate) {
  if (rate === undefined || rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

function formatUsd(usd) {
  if (usd === undefined || usd === null) return '';
  if (usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export const core = {
  PRICES, isPeakTime, priceFamily, modelNameOf, normalizeUsage, normalizeTurnUsage, hitRate,
  throughput, formatTps, formatSeconds, formatDuration, turnDurationMs,
  turnFirstTokenMs, averageTtftMs, withTtft,
  isTokenDelta, runFirstTokenTime, assistantStreamFirstTokenTime,
  sumUsage, subtractUsage, classify, wastedUsd, isEvidence, usageOfTurn,
  formatTokens, formatRate, formatUsd, unwrap,
  isInterrupted, errorForTurn, tailError, errorLabel, errorDetail,
};
