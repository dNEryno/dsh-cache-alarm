window.__ModuleLoader__.load({
  id: 'dsh-cache-alarm',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

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
  if (usd < 0.01) return `${usd.toFixed(4)}`;
  if (usd < 1) return `${usd.toFixed(3)}`;
  return `${usd.toFixed(2)}`;
}

const core = {
  PRICES, isPeakTime, priceFamily, modelNameOf, normalizeUsage, normalizeTurnUsage, hitRate,
  throughput, formatTps, formatSeconds, formatDuration, turnDurationMs,
  turnFirstTokenMs, averageTtftMs, withTtft,
  isTokenDelta, runFirstTokenTime, assistantStreamFirstTokenTime,
  sumUsage, subtractUsage, classify, wastedUsd, isEvidence, usageOfTurn,
  formatTokens, formatRate, formatUsd, unwrap,
  isInterrupted, errorForTurn, tailError, errorLabel, errorDetail,
};

    const TONES = { ok: '#29ad73', warn: '#e4ae28', danger: '#e44f59', unknown: '#9299a5' };
    let sessionContext = null;
    const ttftStores = new Map();

    // The rendered assistant node may have lost its first-token boundary, but
    // the Session's durable event window still carries each attempt's compact
    // stream. Fold those events into exact per-step first-token timings so the
    // number shown is always that step's own latency, not a session average.
    function foldTtftEntry(store, entry) {
      if (!entry || !entry.event) return false;
      const event = entry.event;
      if (entry.type === 'transient') {
        if (event.type !== 'assistant/live-chunk') return false;
        const live = event.data || {};
        const liveKey = String(live.turn) + ':' + String(live.step);
        let liveRecord = store.steps.get(liveKey);
        if (!liveRecord) {
          liveRecord = { turn: live.turn, step: live.step, startTime: null, firstTokenTime: null };
          store.steps.set(liveKey, liveRecord);
        }
        if (liveRecord.firstTokenTime === null && isTokenDelta(live.chunk)) {
          liveRecord.firstTokenTime = event.time;
          return true;
        }
        return false;
      }
      if (entry.type !== 'event') return false;
      const data = event.data || {};
      if (event.type === 'step/start') {
        const key = String(data.turn) + ':' + String(data.step);
        const existing = store.steps.get(key);
        const hadFirstToken = existing ? existing.firstTokenTime !== null : false;
        store.steps.set(key, {
          turn: data.turn, step: data.step, startTime: event.time,
          firstTokenTime: existing ? existing.firstTokenTime : null,
        });
        return hadFirstToken;
      }
      if (event.type !== 'assistant/attempt' && event.type !== 'assistant/message') return false;
      const key = String(data.turn) + ':' + String(data.step);
      let record = store.steps.get(key);
      if (!record) {
        record = { turn: data.turn, step: data.step, startTime: null, firstTokenTime: null };
        store.steps.set(key, record);
      }
      if (record.firstTokenTime === null) {
        const first = assistantStreamFirstTokenTime(data.stream);
        if (first !== undefined) {
          record.firstTokenTime = first;
          return true;
        }
      }
      return false;
    }

    function refreshTtftStore(store) {
      if (!store || !store.source) return false;
      const window = store.source.getSnapshot();
      if (!window || window.revision === store.revision) return false;
      let changed = false;
      const apply = entry => { if (foldTtftEntry(store, entry)) changed = true; };
      const rebuild = store.revision < 0 || window.revision !== store.revision + 1
        || window.change?.kind === 'replace' || window.change?.kind === 'prepend';
      if (rebuild) {
        store.steps.clear();
        for (const entry of window.entries) apply(entry);
      } else if (window.change?.kind === 'append') {
        for (const entry of window.change.entries) apply(entry);
      } else if (window.change?.kind === 'settle-assistant' && window.change.entry) {
        apply(window.change.entry);
      }
      store.revision = window.revision;
      return changed;
    }

    function getTtftStore(sessionId) {
      if (!sessionContext || !sessionContext.sessions || typeof sessionContext.sessions.binding !== 'function'
        || sessionId === undefined || sessionId === null) return undefined;
      const binding = sessionContext.sessions.binding(sessionId);
      if (!binding || !binding.eventSource) return undefined;
      let store = ttftStores.get(sessionId);
      if (!store || store.source !== binding.eventSource) {
        store = { source: binding.eventSource, revision: -1, steps: new Map() };
        ttftStores.set(sessionId, store);
      }
      return store;
    }

    function ttftFromStore(store, turn, step) {
      if (!store || turn === undefined || step === undefined) return undefined;
      const record = store.steps.get(String(turn) + ':' + String(step));
      if (!record || record.startTime === null || record.firstTokenTime === null) return undefined;
      if (record.firstTokenTime < record.startTime) return undefined;
      return record.firstTokenTime - record.startTime;
    }

    function useTtftMs(sessionId, turn, step) {
      const store = getTtftStore(sessionId);
      const [, setTick] = React.useState(0);
      if (store) refreshTtftStore(store);
      const value = store ? ttftFromStore(store, turn, step) : undefined;
      React.useEffect(() => {
        if (value !== undefined) return undefined;
        const current = getTtftStore(sessionId);
        if (!current) return undefined;
        refreshTtftStore(current);
        let alive = true;
        const unsubscribe = current.source.subscribe(() => {
          if (!alive) return;
          if (refreshTtftStore(current)) setTick(tick => tick + 1);
        });
        return () => { alive = false; unsubscribe(); };
      }, [sessionId, store ? store.source : undefined, turn, step, value]);
      return value;
    }

    // The Chat snapshot owns the durable Assistant messages, including the
    // per-message provider usage and the real timing of each decode. The session
    // tokenUsage projection is only a live fallback while a turn is streaming.
    // The selector must return a stable node object (never a fresh wrapper) or
    // React's snapshot subscription would re-render forever.
    function findSource(snapshot, messageId) {
      if (!snapshot) return undefined;
      const nodes = snapshot.legacy?.nodes;
      if (Array.isArray(nodes)) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const node = nodes[i];
          if (node && node.kind === 'assistant' && node.messageId === messageId) return node;
        }
      }
      const values = snapshot.nodes?.values?.();
      if (values) {
        let tail;
        for (const node of values) {
          if (node?.data?.finalNode?.messageId === messageId) return node.data.finalNode;
          if (node?.kind === 'turn-tail' && node.data?.closing?.finalNode?.messageId === messageId) tail = node;
        }
        if (tail) return tail;
      }
      return undefined;
    }

    function latestSource(snapshot) {
      if (!snapshot) return undefined;
      const nodes = snapshot.legacy?.nodes;
      if (Array.isArray(nodes)) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const node = nodes[i];
          if (node && node.kind === 'assistant' && node.messageId !== undefined) return node;
        }
      }
      const values = snapshot.nodes?.values?.();
      if (values) {
        let last;
        for (const node of values) {
          if (node?.kind === 'turn-tail' && node.data?.tokenUsage) last = node;
        }
        return last;
      }
      return undefined;
    }

    function turnOf(source) {
      if (!source) return undefined;
      if (source.kind === 'turn-tail') return source.data?.turn ?? source.data?.closing?.finalNode?.turn;
      return source.turn;
    }

    function stepOf(source) {
      if (!source) return undefined;
      if (source.kind === 'turn-tail') return source.data?.closing?.finalNode?.step;
      return source.step;
    }

    // A durable assistant message carries provider usage; a turn-tail carries
    // the exact aggregate and is the fallback when the message sample is absent.
    function readSource(source) {
      if (!source) return {};
      if (source.kind === 'turn-tail') {
        return {
          usage: source.data?.tokenUsage,
          timing: source.data?.closing?.finalNode?.timing,
          model: String(source.data?.tokenUsage?.routes?.[0]?.model ?? ''),
        };
      }
      return {
        usage: source.usage,
        timing: source.timing,
        model: String(source.usage?.routes?.[0]?.model ?? ''),
      };
    }

    function detailTitle(usage, perf, rate, model, turnMs) {
      if (!usage) return '本轮尚无 token 统计';
      const rows = [
        '本轮消耗（整轮合计，含所有 step）',
        model ? '模型 ' + model : null,
        '提示词命中 ' + formatRate(rate),
        '未命中输入 ' + formatTokens(usage.uncachedInputTokens),
        '缓存读 ' + formatTokens(usage.cacheReadTokens),
        '缓存写 ' + formatTokens(usage.cacheWriteTokens),
        '输出 ' + formatTokens(usage.outputTokens),
        '总计 ' + formatTokens(usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens),
        turnMs !== undefined ? '整轮耗时 ' + formatDuration(turnMs) : null,
        perf ? (perf.exact ? '解码 ' : '整步耗时 ') + (perf.exact ? Math.round(perf.decodeMs) + ' ms' : (perf.decodeMs / 1000).toFixed(2) + ' s') : null,
        perf && perf.ttftMs !== undefined
          ? (perf.ttftApprox === 'session' ? '首字（会话平均）'
            : perf.ttftApprox === 'turn' ? '首字（本轮最早）' : '首字')
            + ' ' + Math.round(perf.ttftMs) + ' ms'
          : null,
        perf ? (perf.exact ? '真实速度 ' : '整步均速 ') + formatTps(perf.tps) : null,
      ];
      return rows.filter(Boolean).join('\n');
    }

    // The second line is always rendered: the user asked not to have to hover
    // for the detail numbers.
    function detailParts(usage, perf, turnMs) {
      if (!usage) return '';
      const parts = [
        '未命中 ' + formatTokens(usage.uncachedInputTokens),
        '缓存读 ' + formatTokens(usage.cacheReadTokens),
        '缓存写 ' + formatTokens(usage.cacheWriteTokens),
      ];
      if (turnMs !== undefined) parts.push('整轮 ' + formatDuration(turnMs));
      if (perf) {
        parts.push((perf.exact ? '解码 ' : '整步 ') + (perf.exact
          ? Math.round(perf.decodeMs) + 'ms'
          : (perf.decodeMs / 1000).toFixed(2) + 's'));
      }
      const ttft = perf && typeof perf.ttftMs === 'number'
        ? (perf.ttftApprox === 'session' ? '均' : perf.ttftApprox === 'turn' ? '约' : '')
          + Math.round(perf.ttftMs) + 'ms'
        : '—';
      parts.push('首字 ' + ttft);
      return parts.join(' · ');
    }

    // One compact block, reused by the composer (latest turn) and by the chat
    // action slot (the turn owning that assistant message). The summary stays
    // on the first line; the per-bucket detail is always on the second.
    // The detail popup is drawn locally instead of using the native `title`
    // attribute: Chromium dismisses a native tooltip the moment its text
    // changes, and this line ticks every 250 ms while a turn streams — with
    // `title` the popup could never update in place, it only flickered. A
    // fixed-position div with pointerEvents:none re-renders on every tick
    // without flicker and without stealing the hover from the anchor.
    function HoverDetail({ text, rect }) {
      if (!text || !rect) return null;
      return h('div', {
        style: {
          position: 'fixed',
          left: rect.left + 'px',
          bottom: rect.bottom + 'px',
          zIndex: 10000,
          pointerEvents: 'none',
          maxWidth: 360,
          padding: '8px 10px',
          borderRadius: 8,
          background: 'rgba(24, 24, 27, 0.97)',
          color: '#f2f2f4',
          border: '1px solid rgba(255, 255, 255, 0.14)',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
          fontSize: 11.5,
          lineHeight: '17px',
          whiteSpace: 'pre',
          textAlign: 'left',
        },
      }, text);
    }

    function TurnLine({ usage, perf, model, compact, error, size, turnMs }) {
      const [spot, setSpot] = React.useState(null);
      const anchor = React.useRef(null);
      const onEnter = () => {
        const el = anchor.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
        const height = typeof window === 'undefined' ? 800 : window.innerHeight;
        setSpot({
          left: Math.max(8, Math.min(r.left, width - 372)),
          bottom: Math.max(8, height - r.top + 6),
        });
      };
      const hoverProps = {
        ref: anchor,
        onMouseEnter: onEnter,
        onMouseLeave: () => setSpot(null),
      };
      const titleText = error
        ? errorDetail(error)
        : detailTitle(usage, perf, hitRate(usage), model, turnMs);
      const withTip = node => h(React.Fragment, null, node,
        h(HoverDetail, { text: spot ? titleText : null, rect: spot }));
      if (error) {
        const detail = errorDetail(error);
        return withTip(h('span', {
          ...hoverProps,
          style: {
            display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
            maxWidth: '100%', padding: compact ? '0' : '2px 4px',
            fontSize: compact ? 11 : 12, lineHeight: '16px', color: 'inherit', opacity: 0.9,
            whiteSpace: 'normal',
          },
        },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' } },
            h('span', {
              'aria-hidden': true,
              style: {
                color: TONES.danger, fontWeight: 700, flex: '0 0 auto',
                fontSize: compact ? 12 : 13, lineHeight: '16px',
              },
            }, '✕'),
            h('span', {
              style: { color: TONES.danger, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, errorLabel(error))),
          detail && !compact
            ? h('span', {
              style: {
                fontSize: compact ? 10 : 11, lineHeight: '14px', opacity: 0.68,
                paddingLeft: 13, whiteSpace: 'normal',
              },
            }, detail)
            : null));
      }
      const rate = hitRate(usage);
      const tone = classify(rate);
      if (compact) {
        const summary = [
          '命中 ' + formatRate(rate),
          '首字 ' + (perf && typeof perf.ttftMs === 'number'
            ? (perf.ttftApprox === 'session' ? '均' : perf.ttftApprox === 'turn' ? '约' : '') + formatSeconds(perf.ttftMs)
            : '—'),
          '整轮 ' + formatDuration(turnMs),
          perf ? formatTps(perf.tps) : '—',
        ].join(' · ');
        return withTip(h('span', {
          ...hoverProps,
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', minWidth: 0,
            fontSize: size ?? 11, lineHeight: Math.round((size ?? 11) * 1.45) + 'px',
            color: 'inherit', opacity: 0.9, whiteSpace: 'nowrap',
          },
        },
          h('span', {
            'aria-hidden': true,
            style: { width: 7, height: 7, borderRadius: 4, flex: '0 0 auto', background: TONES[tone] },
          }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } }, summary)));
      }
      const parts = [];
      if (usage) parts.push('命中 ' + formatRate(rate));
      const total = usage
        ? usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens : 0;
      parts.push('共 ' + formatTokens(total));
      parts.push('出 ' + formatTokens(usage?.outputTokens));
      if (perf) parts.push((perf.exact ? '' : '约 ') + formatTps(perf.tps));
      const label = parts.join(' · ');
      return withTip(h('span', {
        ...hoverProps,
        style: {
          display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
          maxWidth: '100%', padding: compact ? '0' : '2px 4px',
          fontSize: compact ? 11 : 12, lineHeight: '16px', color: 'inherit', opacity: 0.9,
          whiteSpace: 'normal',
        },
      },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' } },
          h('span', {
            'aria-hidden': true,
            style: { width: 7, height: 7, borderRadius: 4, flex: '0 0 auto', background: TONES[tone] },
          }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
          tone === 'danger' && !compact
            ? h('span', { style: { color: TONES.danger } }, '命中过低，建议换模型') : null),
        usage
          ? h('span', {
            style: {
              fontSize: compact ? 10 : 11, lineHeight: '14px', opacity: 0.68,
              paddingLeft: 13, whiteSpace: 'normal',
            },
          }, detailParts(usage, perf, turnMs))
          : null));
    }

    // Session-cumulative projection: used only while the current turn streams,
    // because the Assistant message usage is not published until it settles.
    const liveSessions = new Map();
    function liveOf(sessionId) {
      const key = String(sessionId);
      let store = liveSessions.get(key);
      if (!store) { store = { turns: [], base: undefined }; liveSessions.set(key, store); }
      return store;
    }

    function ComposerLine(props) {
      const sessionId = props.sessionId;
      const useProjection = props.useProjection;
      const useSession = props.useSession;
      const useChat = props.useChat;
      const readProjection = typeof useProjection === 'function' ? useProjection : () => undefined;
      const running = typeof useSession === 'function' ? useSession(state => state.running) : false;
      const latest = typeof useChat === 'function' ? useChat(s => latestSource(s)) : undefined;
      const tail = typeof useChat === 'function' ? useChat(s => tailError(s)) : undefined;
      const nodes = typeof useChat === 'function' ? useChat(s => s.legacy?.nodes) : undefined;
      const turnTimings = typeof useChat === 'function' ? useChat(s => s.legacy?.turnTimings) : undefined;
      const usageProjection = normalizeUsage(readProjection('tokenUsage'));
      const durable = readSource(latest);
      const model = durable.model || modelNameOf(unwrap(readProjection('modelSelection')));
      const permanent = normalizeTurnUsage(durable.usage);
      const turn = turnOf(latest);
      const step = stepOf(latest);
      const turnUsage = usageOfTurn(nodes, turn);
      const window = turnTimings?.get?.(turn);
      const turnMs = turnDurationMs(window, running ? Date.now() : undefined);
      const streamTtft = useTtftMs(sessionId, turn, step);
      const turnTtft = turnFirstTokenMs(nodes, turn, window);
      const fallbackTtft = streamTtft !== undefined ? streamTtft : turnTtft;
      const fallbackKind = streamTtft !== undefined ? 'stream' : turnTtft !== undefined ? 'turn' : undefined;
      const error = tail;
      const basePerf = !error && permanent ? throughput(permanent, durable.timing, window) : undefined;
      const perf = !error ? withTtft(basePerf, fallbackTtft, fallbackKind) : undefined;

      // Delta bookkeeping for streaming turns only. It never feeds the settled
      // row: that one always comes from the durable message usage.
      const store = liveOf(sessionId);
      const [, force] = React.useState(0);
      const previousRunning = React.useRef(running);
      React.useEffect(() => {
        const wasRunning = previousRunning.current;
        previousRunning.current = running;
        if (running && !wasRunning) { store.base = usageProjection ?? store.base; return; }
        if (!running && wasRunning && store.base) {
          const delta = subtractUsage(usageProjection, store.base);
          if (delta) {
            store.turns.push(delta);
            if (store.turns.length > 100) store.turns.shift();
            force(value => value + 1);
          }
        }
        if (!running) store.base = usageProjection ?? store.base;
      }, [running, usageProjection]);

      // While a turn streams, tokenUsage only republishes at step boundaries —
      // the line would sit frozen for minutes. Tick locally so 整轮耗时 counts up
      // and the rate re-evaluates, without hammering the projection.
      React.useEffect(() => {
        if (!running) return undefined;
        const id = setInterval(() => force(value => value + 1), 250);
        return () => clearInterval(id);
      }, [running]);

      const live = running ? (usageProjection && store.base
        ? subtractUsage(usageProjection, store.base) : undefined) : undefined;
      const usage = error ? undefined : (running && live
        && (live.uncachedInputTokens || live.cacheReadTokens || live.cacheWriteTokens || live.outputTokens)
        ? live : (turnUsage ?? permanent));
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 6, padding: 0,
          fontSize: 12, lineHeight: '18px', color: 'inherit', opacity: 0.82, userSelect: 'none',
          minWidth: 0, maxWidth: '100%', overflow: 'hidden',
        },
      },
        h('span', { style: { fontWeight: 600, flex: '0 0 auto', fontSize: 12 } }, '本轮'),
        h(TurnLine, { usage, perf, model, error, compact: true, size: 12, turnMs }));
    }

    function MessageLine(props) {
      const useChat = props.useChat;
      if (typeof useChat !== 'function') return null;
      const useProjection = props.useProjection;
      const readProjection = typeof useProjection === 'function' ? useProjection : () => undefined;
      const source = useChat(s => findSource(s, props.messageId));
      const nodes = useChat(s => s.legacy?.nodes);
      const turnTimings = useChat(s => s.legacy?.turnTimings);
      const turn = turnOf(source);
      const step = stepOf(source);
      const streamTtft = useTtftMs(props.sessionId, turn, step);
      const errorNode = useChat(s => errorForTurn(s, turn));
      if (!source) return null;
      const error = errorNode || (isInterrupted(source) ? { kind: 'assistant', interrupted: true } : undefined);
      const durable = readSource(source);
      const ownUsage = normalizeTurnUsage(durable.usage);
      const window = turnTimings?.get?.(turn);
      const usage = usageOfTurn(nodes, turn) ?? ownUsage;
      if (!usage && !error) return null;
      const turnMs = turnDurationMs(window);
      const turnTtft = turnFirstTokenMs(nodes, turn, window);
      const fallbackTtft = streamTtft !== undefined ? streamTtft : turnTtft;
      const fallbackKind = streamTtft !== undefined ? 'stream' : turnTtft !== undefined ? 'turn' : undefined;
      const basePerf = error ? undefined : throughput(ownUsage, durable.timing, window);
      const perf = error ? undefined : withTtft(basePerf, fallbackTtft, fallbackKind);
      return h(TurnLine, { usage: error ? undefined : usage, perf, model: durable.model, compact: true, error, turnMs });
    }

    // Occupant for a shipped dock cell this plugin retires: renders nothing.
    function RETIRED_PILL() { return null; }

    // Retire a shipped list-slot occupant (`activity` / `usage` on the composer dock).
    // SlotCore.register rejects an (id, priority) duplicate, and entriesOfSlot sorts
    // ascending by (priority, order) then keeps the FIRST entry of each id — so the
    // LOWEST priority claims the cell. The shipped UI registers these ids at priority 0.
    // IMPORTANT: this plugin loads as an `immediately: true` static client half, which
    // does NOT pass through the client runner's guardedSurface — only dynamically loaded
    // plugins get their priority rewritten to a negative allocatePriority(). A static
    // register therefore keeps whatever priority we pass (default 0), which collides with
    // the shipped 0 and crashes boot with "already has an entry with id ... at priority 0".
    // So we must pass an explicit, strictly negative priority to shadow the shipped cell.
    let retirePriority = -1000;
    function retireOccupant(ctx, id, order) {
      const priority = retirePriority--;
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock', id, order, priority,
      }, RETIRED_PILL));
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        sessionContext = ctx;
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'cache-alarm', order: 2,
        }, ComposerLine));
        // The shipped chat module registers two dock cells there (`activity` =
        // decode tok/s, `usage` = cache-hit % and turn tokens). They repeat what
        // this line already prints, so we retire them.
        retireOccupant(ctx, 'activity', 0);
        retireOccupant(ctx, 'usage', 1);
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions', id: 'cache-alarm-turn', order: 20,
        }, MessageLine));
      },
    };
  },
});
