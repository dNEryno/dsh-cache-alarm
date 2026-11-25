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

function formatSeconds(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  return (ms / 1000).toFixed(2) + 's';
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
  throughput, formatTps, formatSeconds, sumUsage, subtractUsage, classify, wastedUsd, isEvidence,
  formatTokens, formatRate, formatUsd, unwrap,
  isInterrupted, errorForTurn, tailError, errorLabel, errorDetail,
};

    const TONES = { ok: '#29ad73', warn: '#e4ae28', danger: '#e44f59', unknown: '#9299a5' };

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

    function detailTitle(usage, perf, rate, model) {
      if (!usage) return '本轮尚无 token 统计';
      const rows = [
        '本轮消耗（仅这一条回复）',
        model ? '模型 ' + model : null,
        '提示词命中 ' + formatRate(rate),
        '未命中输入 ' + formatTokens(usage.uncachedInputTokens),
        '缓存读 ' + formatTokens(usage.cacheReadTokens),
        '缓存写 ' + formatTokens(usage.cacheWriteTokens),
        '输出 ' + formatTokens(usage.outputTokens),
        '总计 ' + formatTokens(usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens),
        perf ? (perf.exact ? '解码 ' : '整步耗时 ') + (perf.exact ? Math.round(perf.decodeMs) + ' ms' : (perf.decodeMs / 1000).toFixed(2) + ' s') : null,
        perf && perf.ttftMs !== undefined ? '首字 ' + Math.round(perf.ttftMs) + ' ms' : null,
        perf ? (perf.exact ? '真实速度 ' : '整步均速 ') + formatTps(perf.tps) : null,
      ];
      return rows.filter(Boolean).join('\n');
    }

    // The second line is always rendered: the user asked not to have to hover
    // for the detail numbers.
    function detailParts(usage, perf) {
      if (!usage) return '';
      const parts = [
        '未命中 ' + formatTokens(usage.uncachedInputTokens),
        '缓存读 ' + formatTokens(usage.cacheReadTokens),
        '缓存写 ' + formatTokens(usage.cacheWriteTokens),
      ];
      if (perf) {
        parts.push((perf.exact ? '解码 ' : '整步 ') + (perf.exact
          ? Math.round(perf.decodeMs) + 'ms'
          : (perf.decodeMs / 1000).toFixed(2) + 's'));
      }
      parts.push('首字 ' + (perf && typeof perf.ttftMs === 'number' ? Math.round(perf.ttftMs) + 'ms' : '—'));
      return parts.join(' · ');
    }

    // One compact block, reused by the composer (latest turn) and by the chat
    // action slot (the turn owning that assistant message). The summary stays
    // on the first line; the per-bucket detail is always on the second.
    function TurnLine({ usage, perf, model, compact, error }) {
      if (error) {
        const detail = errorDetail(error);
        return h('span', {
          title: detail,
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
            : null);
      }
      const rate = hitRate(usage);
      const tone = classify(rate);
      if (compact) {
        const summary = [
          '命中 ' + formatRate(rate),
          '首字 ' + formatSeconds(perf && perf.ttftMs),
          '整步 ' + formatSeconds(perf && perf.decodeMs),
          perf ? formatTps(perf.tps) : '—',
        ].join(' · ');
        return h('span', {
          title: detailTitle(usage, perf, rate, model),
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
            fontSize: 11, lineHeight: '16px', color: 'inherit', opacity: 0.9, whiteSpace: 'nowrap',
          },
        },
          h('span', {
            'aria-hidden': true,
            style: { width: 7, height: 7, borderRadius: 4, flex: '0 0 auto', background: TONES[tone] },
          }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, summary));
      }
      const parts = [];
      if (usage) parts.push('命中 ' + formatRate(rate));
      const total = usage
        ? usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens : 0;
      parts.push('共 ' + formatTokens(total));
      parts.push('出 ' + formatTokens(usage?.outputTokens));
      if (perf) parts.push((perf.exact ? '' : '约 ') + formatTps(perf.tps));
      const label = parts.join(' · ');
      return h('span', {
        title: detailTitle(usage, perf, rate, model),
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
          }, detailParts(usage, perf))
          : null);
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
      const turnTimings = typeof useChat === 'function' ? useChat(s => s.legacy?.turnTimings) : undefined;
      const usageProjection = normalizeUsage(readProjection('tokenUsage'));
      const durable = readSource(latest);
      const model = durable.model || modelNameOf(unwrap(readProjection('modelSelection')));
      const permanent = normalizeTurnUsage(durable.usage);
      const window = turnTimings?.get?.(turnOf(latest));
      const error = tail;
      const perf = !error && permanent ? throughput(permanent, durable.timing, window) : undefined;

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

      const live = running ? (usageProjection && store.base
        ? subtractUsage(usageProjection, store.base) : undefined) : undefined;
      const usage = error ? undefined : (permanent ?? (live && (live.uncachedInputTokens || live.cacheReadTokens || live.outputTokens)
        ? live : undefined));
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px 2px 0',
          fontSize: 12, lineHeight: '18px', color: 'inherit', opacity: 0.82, userSelect: 'none',
        },
      },
        h('span', { style: { fontWeight: 600, flex: '0 0 auto' } }, '本轮'),
        h(TurnLine, { usage, perf, model, error }));
    }

    function MessageLine(props) {
      const useChat = props.useChat;
      if (typeof useChat !== 'function') return null;
      const source = useChat(s => findSource(s, props.messageId));
      const turnTimings = useChat(s => s.legacy?.turnTimings);
      const turn = turnOf(source);
      const errorNode = useChat(s => errorForTurn(s, turn));
      if (!source) return null;
      const error = errorNode || (isInterrupted(source) ? { kind: 'assistant', interrupted: true } : undefined);
      const durable = readSource(source);
      const usage = normalizeTurnUsage(durable.usage);
      if (!usage && !error) return null;
      const window = turnTimings?.get?.(turn);
      const perf = error ? undefined : throughput(usage, durable.timing, window);
      return h(TurnLine, { usage: error ? undefined : usage, perf, model: durable.model, compact: true, error });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'cache-alarm', order: 2,
        }, ComposerLine));
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions', id: 'cache-alarm-turn', order: 20,
        }, MessageLine));
      },
    };
  },
});
