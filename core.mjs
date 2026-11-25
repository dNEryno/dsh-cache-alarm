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
  const warn = thresholds?.warn ?? 0.6;
  const danger = thresholds?.danger ?? 0.3;
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
  throughput, formatTps, sumUsage, subtractUsage, classify, wastedUsd, isEvidence,
  formatTokens, formatRate, formatUsd, unwrap,
};
