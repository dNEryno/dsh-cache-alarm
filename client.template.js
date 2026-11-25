window.__ModuleLoader__.load({
  id: 'dsh-cache-alarm',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

/*__CORE__*/

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
        perf ? (perf.exact ? '解码 ' : '整步耗时 ') + Math.round(perf.decodeMs) + ' ms' : null,
        perf && perf.ttftMs !== undefined ? '首字 ' + Math.round(perf.ttftMs) + ' ms' : null,
        perf ? (perf.exact ? '真实速度 ' : '整步均速 ') + formatTps(perf.tps) : null,
      ];
      return rows.filter(Boolean).join('\n');
    }

    // One compact row, reused by the composer (latest turn) and by the chat
    // action slot (the turn owning that assistant message).
    function TurnLine({ usage, perf, model, compact }) {
      const rate = hitRate(usage);
      const tone = classify(rate);
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
          display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
          padding: compact ? '0' : '2px 4px', fontSize: compact ? 11 : 12, lineHeight: '16px',
          color: 'inherit', opacity: 0.9, whiteSpace: 'nowrap', cursor: 'help',
        },
      },
        h('span', {
          'aria-hidden': true,
          style: { width: 7, height: 7, borderRadius: 4, flex: '0 0 auto', background: TONES[tone] },
        }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        tone === 'danger' && !compact
          ? h('span', { style: { color: TONES.danger } }, '命中过低，建议换模型') : null);
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
      const turnTimings = typeof useChat === 'function' ? useChat(s => s.legacy?.turnTimings) : undefined;
      const usageProjection = normalizeUsage(readProjection('tokenUsage'));
      const durable = readSource(latest);
      const model = durable.model || modelNameOf(unwrap(readProjection('modelSelection')));
      const permanent = normalizeTurnUsage(durable.usage);
      const window = turnTimings?.get?.(turnOf(latest));
      const perf = permanent ? throughput(permanent, durable.timing, window) : undefined;

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
      const usage = permanent ?? (live && (live.uncachedInputTokens || live.cacheReadTokens || live.outputTokens)
        ? live : undefined);
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px 2px 0',
          fontSize: 12, lineHeight: '18px', color: 'inherit', opacity: 0.82, userSelect: 'none',
        },
      },
        h('span', { style: { fontWeight: 600, flex: '0 0 auto' } }, '本轮'),
        h(TurnLine, { usage, perf, model }));
    }

    function MessageLine(props) {
      const useChat = props.useChat;
      if (typeof useChat !== 'function') return null;
      const source = useChat(s => findSource(s, props.messageId));
      const turnTimings = useChat(s => s.legacy?.turnTimings);
      if (!source) return null;
      const durable = readSource(source);
      const usage = normalizeTurnUsage(durable.usage);
      if (!usage) return null;
      const window = turnTimings?.get?.(turnOf(source));
      const perf = throughput(usage, durable.timing, window);
      return h(TurnLine, { usage, perf, model: durable.model, compact: true });
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
