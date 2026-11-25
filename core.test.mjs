import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from './core.mjs';

const {
  hitRate, normalizeUsage, normalizeTurnUsage, throughput, formatTps, subtractUsage,
  classify, wastedUsd, isEvidence, formatRate, formatUsd, isPeakTime, modelNameOf,
  isInterrupted, errorForTurn, tailError, errorLabel, errorDetail, formatSeconds,
  turnFirstTokenMs, averageTtftMs, withTtft,
} = core;

test('hitRate divides cache reads by the whole billed prompt', () => {
  assert.equal(hitRate({ uncachedInputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 0, outputTokens: 500 }), 0.75);
  assert.equal(hitRate({ uncachedInputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 100, outputTokens: 0 }), 0.5);
});

test('hitRate ignores output tokens and refuses an empty prompt', () => {
  assert.equal(hitRate({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 900 }), undefined);
  assert.equal(hitRate(undefined), undefined);
});

test('normalizeUsage drops junk and zero buckets', () => {
  assert.equal(normalizeUsage(undefined), undefined);
  assert.equal(normalizeUsage({ outputTokens: 0 }), undefined);
  assert.deepEqual(normalizeUsage({ uncachedInputTokens: 10, cacheReadTokens: 'x' }), {
    uncachedInputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  });
});

test('normalizeTurnUsage reads the provider token vocabulary', () => {
  assert.deepEqual(normalizeTurnUsage({
    inputTokens: 1200, outputTokens: 400, cacheReadTokens: 8800, cacheWriteTokens: 32,
  }), {
    uncachedInputTokens: 1200, outputTokens: 400, cacheReadTokens: 8800, cacheWriteTokens: 32,
  });
  assert.equal(normalizeTurnUsage({ outputTokens: 0 }), undefined);
  assert.equal(normalizeTurnUsage({ outputTokens: 'junk' }), undefined);
});

test('throughput is the real decode speed, not a smoothed display value', () => {
  const usage = normalizeTurnUsage({ inputTokens: 100, outputTokens: 500, cacheReadTokens: 900 });
  const perf = throughput(usage, {
    stepStartTime: 1000, firstTokenTime: 1500, completedTime: 5500,
  });
  assert.equal(perf.tps, 125);
  assert.equal(perf.ttftMs, 500);
  assert.equal(perf.decodeMs, 4000);
  assert.equal(formatTps(perf.tps), '125 tok/s');
  assert.equal(formatTps(12.34), '12.3 tok/s');
  assert.equal(throughput(usage, { firstTokenTime: 100, completedTime: 150 }), undefined);
  assert.equal(throughput(usage, undefined), undefined);
});

test('throughput survives a missing first-token timestamp', () => {
  const usage = normalizeTurnUsage({ inputTokens: 100, outputTokens: 500, cacheReadTokens: 900 });
  // firstTokenTime is null in windows that recorded no token delta: never treat
  // it as 0 (that produced a five-decade decode duration).
  const perf = throughput(usage, { stepStartTime: 1000, firstTokenTime: null, completedTime: 6000 }, undefined);
  assert.equal(perf.exact, false);
  assert.equal(perf.decodeMs, 5000);
  assert.equal(perf.tps, 100);
  const turnOnly = throughput(usage, { stepStartTime: null, firstTokenTime: null, completedTime: 6000 },
    { startTime: 1000, endTime: 6000 });
  assert.equal(turnOnly.tps, 100);
  assert.equal(throughput(usage, { stepStartTime: null, firstTokenTime: null, completedTime: 6000 }, undefined), undefined);
});

test('turnFirstTokenMs recovers a first token when the final step lacks one', () => {
  const nodes = [
    { kind: 'assistant', turn: 2, timing: { stepStartTime: 1000, firstTokenTime: 1600, completedTime: 5000 } },
    { kind: 'assistant', turn: 2, timing: { stepStartTime: 5000, firstTokenTime: null, completedTime: 8000 } },
    { kind: 'assistant', turn: 3, timing: { stepStartTime: 9000, firstTokenTime: 9500, completedTime: 10000 } },
  ];
  assert.equal(turnFirstTokenMs(nodes, 2, { startTime: 900, endTime: 8000 }), 700);
  assert.equal(turnFirstTokenMs(nodes, 2, undefined), 600);
  assert.equal(turnFirstTokenMs(nodes, 4, undefined), undefined);
  assert.equal(turnFirstTokenMs(undefined, 2, undefined), undefined);
});

test('averageTtftMs falls back to the whole-log average only with counted steps', () => {
  assert.equal(averageTtftMs({ ttftMs: 1500, ttftSteps: 3 }), 500);
  assert.equal(averageTtftMs({ value: { ttftMs: 900, ttftSteps: 2 } }), 450);
  assert.equal(averageTtftMs({ ttftMs: 0, ttftSteps: 0 }), undefined);
  assert.equal(averageTtftMs(undefined), undefined);
});

test('withTtft only fills an absent reading and marks how it was recovered', () => {
  const perf = { tps: 100, decodeMs: 1000, exact: true };
  assert.deepEqual(withTtft(perf, 500, 'turn'), { tps: 100, decodeMs: 1000, exact: true, ttftMs: 500, ttftApprox: 'turn' });
  assert.equal(withTtft({ ...perf, ttftMs: 300 }, 500, 'turn').ttftMs, 300);
  assert.equal(withTtft(undefined, 500, 'turn'), undefined);
});

test('subtractUsage measures one turn and rejects a backwards sample', () => {
  assert.deepEqual(
    subtractUsage(
      { uncachedInputTokens: 500, outputTokens: 300, cacheReadTokens: 4000, cacheWriteTokens: 10 },
      { uncachedInputTokens: 200, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 10 },
    ),
    { uncachedInputTokens: 300, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0 },
  );
  assert.equal(subtractUsage({ uncachedInputTokens: 1 }, { uncachedInputTokens: 5 }), undefined);
});

test('classify uses the 90/80 cut points', () => {
  assert.equal(classify(0.9), 'ok');
  assert.equal(classify(0.95), 'ok');
  assert.equal(classify(0.85), 'warn');
  assert.equal(classify(0.8), 'warn');
  assert.equal(classify(0.79), 'danger');
  assert.equal(classify(0.1), 'danger');
  assert.equal(classify(undefined), 'unknown');
  assert.equal(classify(0.5, { warn: 0.4, danger: 0.2 }), 'ok');
});

test('wastedUsd prices an uncached prompt at the official peak rate', () => {
  const monday = new Date('2026-11-23T02:00:00Z'); // Monday 02:00 UTC = peak
  const priced = wastedUsd({ uncachedInputTokens: 1_000_000 }, 'deepseek-v4.1-flash-1017', monday);
  assert.equal(priced.peak, true);
  assert.equal(priced.usd, 0.3 - 0.006);
});

test('wastedUsd halves the rate off peak and on weekends', () => {
  const mondayNight = new Date('2026-11-23T22:00:00Z');
  const saturdayPeakHours = new Date('2026-11-28T02:00:00Z');
  assert.equal(isPeakTime(mondayNight), false);
  assert.equal(isPeakTime(saturdayPeakHours), false);
  const offPeak = wastedUsd({ uncachedInputTokens: 1_000_000 }, 'deepseek-v4.1-flash-1017', mondayNight);
  assert.equal(offPeak.peak, false);
  assert.equal(offPeak.usd, 0.15 - 0.003);
});

test('wastedUsd picks the pro price and gives up on an unknown model', () => {
  const peak = new Date('2026-11-23T02:00:00Z');
  assert.equal(wastedUsd({ uncachedInputTokens: 1_000_000 }, 'deepseek-v4-pro-0813', peak).usd, 1.32 - 0.044);
  assert.equal(wastedUsd({ uncachedInputTokens: 1000 }, 'gpt-6.1-sol', peak), undefined);
  assert.equal(wastedUsd({ uncachedInputTokens: 1000 }, '', peak), undefined);
});

test('isEvidence skips the cold first turn and negligible prompts', () => {
  const turn = { uncachedInputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
  assert.equal(isEvidence(turn, []), false);
  assert.equal(isEvidence(turn, [{ uncachedInputTokens: 1 }]), true);
  assert.equal(isEvidence({ uncachedInputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, [{ x: 1 }]), false);
});

test('formatters stay readable', () => {
  assert.equal(formatRate(0.824), '82%');
  assert.equal(formatRate(undefined), '—');
  assert.equal(formatUsd(0.00042), '$0.0004');
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(undefined), '');
  assert.equal(formatSeconds(5260), '5.26s');
  assert.equal(formatSeconds(397), '0.40s');
  assert.equal(formatSeconds(undefined), '—');
});

test('modelNameOf reads the common selection shapes', () => {
  assert.equal(modelNameOf({ provider: 'foxrouter', model: 'deepseek-v4.1-flash-1017' }), 'deepseek-v4.1-flash-1017');
  assert.equal(modelNameOf({ route: { model: 'deepseek-pro' } }), 'deepseek-pro');
  assert.equal(modelNameOf({ value: { selected: { modelId: 'm2' } } }), 'm2');
  assert.equal(modelNameOf({ model: { id: 'm3' } }), 'm3');
  assert.equal(modelNameOf(undefined), '');
});

test('an unreadable model still yields a Flash-priced waste figure', () => {
  const usage = { uncachedInputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  assert.equal(wastedUsd(usage, '', Date.UTC(2026, 10, 25, 2, 0)), undefined);
  assert.ok(wastedUsd(usage, 'flash', Date.UTC(2026, 10, 25, 2, 0)).usd > 0);
});

test('a turn error or interrupted assistant maps to the red cross', () => {
  const snapshot = {
    legacy: {
      nodes: [
        { kind: 'user', turn: 1 },
        { kind: 'assistant', turn: 1, messageId: 'm1', usage: { inputTokens: 100, outputTokens: 5 } },
        { kind: 'turn-error', turn: 1, message: 'provider disconnected', code: 'ETIMEDOUT' },
      ],
    },
  };
  assert.equal(errorForTurn(snapshot, 1)?.message, 'provider disconnected');
  assert.equal(tailError(snapshot)?.kind, 'turn-error');
  assert.equal(errorLabel(tailError(snapshot)), '请求失败');
  assert.equal(errorDetail(tailError(snapshot)), 'provider disconnected');
  assert.equal(isInterrupted({ kind: 'assistant', interrupted: true }), true);
  assert.equal(isInterrupted({ kind: 'assistant' }), false);
});

test('tailError ignores an old error once the next user turn starts', () => {
  const snapshot = {
    legacy: {
      nodes: [
        { kind: 'turn-error', turn: 1, message: 'old failure' },
        { kind: 'user', turn: 2 },
      ],
    },
  };
  assert.equal(tailError(snapshot), undefined);
});

test('a settled assistant after a retry is not an error', () => {
  const snapshot = {
    legacy: {
      nodes: [
        { kind: 'model-retry', turn: 1, retryState: 'started', failure: { message: 'timeout' } },
        { kind: 'assistant', turn: 1, messageId: 'm1' },
      ],
    },
  };
  assert.equal(tailError(snapshot), undefined);
  assert.equal(errorLabel({ kind: 'model-retry', retryState: 'scheduled', failure: { message: 'x' } }), '模型请求失败，重试中');
  assert.equal(errorDetail({ kind: 'model-retry', retryState: 'scheduled', failure: { message: 'x' } }), 'x');
});
