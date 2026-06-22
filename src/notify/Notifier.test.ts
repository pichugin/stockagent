import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultNotificationsConfig } from '../config.js';
import { DB } from '../db.js';
import { persistSignals } from '../signals/engine.js';
import type { Signal } from '../signals/types.js';
import { Notifier, type PushFn } from './Notifier.js';

const NOW = '2024-06-01T14:00:00.000Z';

function sig(partial: Partial<Signal> = {}): Signal {
  return {
    symbol: 'AAPL',
    kind: 'technical',
    code: 'rsi_overbought',
    severity: 'actionable',
    summary: 'RSI is overbought',
    data: {},
    firedAt: NOW,
    ...partial,
  };
}

/** Fresh in-memory DB + a push spy capturing every notification. */
function harness(cfg = defaultNotificationsConfig()) {
  const db = new DB(':memory:');
  const pushed: { title: string; message: string }[] = [];
  const push: PushFn = async (note) => {
    pushed.push(note);
  };
  const notifier = new Notifier(db, cfg, push, () => 1_000_000);
  return { db, pushed, notifier };
}

test('a newly-fired actionable signal pushes exactly once and does not re-notify', async () => {
  const { db, pushed, notifier } = harness();

  persistSignals(db, [sig()], NOW);
  await notifier.dispatch(NOW, true);
  assert.equal(pushed.length, 1);
  assert.ok(pushed[0].title.includes('AAPL'));
  assert.ok(pushed[0].message.includes('RSI is overbought'));
  assert.ok(pushed[0].message.endsWith('· signal, not advice.'));

  // Still active next cycle → no re-notify.
  persistSignals(db, [sig()], NOW);
  await notifier.dispatch(NOW, true);
  assert.equal(pushed.length, 1, 'must not re-notify while continuously active');

  db.close();
});

test('after a signal clears and re-fires, exactly one new notification', async () => {
  const { db, pushed, notifier } = harness();

  persistSignals(db, [sig()], NOW);
  await notifier.dispatch(NOW, true);
  assert.equal(pushed.length, 1);

  // Condition no longer true → cleared.
  persistSignals(db, [], '2024-06-01T15:00:00.000Z');
  await notifier.dispatch('2024-06-01T15:00:00.000Z', true);
  assert.equal(pushed.length, 1);

  // Re-fires → brand-new row (notified_at NULL) → notifies once more.
  persistSignals(db, [sig({ firedAt: '2024-06-01T16:00:00.000Z' })], '2024-06-01T16:00:00.000Z');
  await notifier.dispatch('2024-06-01T16:00:00.000Z', true);
  assert.equal(pushed.length, 2, 're-fire after a clear notifies again');

  db.close();
});

test('notable / info / context signals never push', async () => {
  const { db, pushed, notifier } = harness();

  persistSignals(
    db,
    [
      sig({ code: 'a', severity: 'notable' }),
      sig({ code: 'b', severity: 'info' }),
      sig({ code: 'c', kind: 'context', severity: 'info' }),
    ],
    NOW,
  );
  await notifier.dispatch(NOW, true);
  assert.equal(pushed.length, 0);

  db.close();
});

test('startup suppression: pre-existing active signals never replay', async () => {
  const { db, pushed, notifier } = harness();

  // Signals active before this run (e.g. from a prior `scan`).
  persistSignals(db, [sig({ code: 'rsi_overbought' }), sig({ code: 'price_at_or_above_sell', kind: 'threshold' })], NOW);

  notifier.seedSuppression(NOW);
  await notifier.dispatch(NOW, true);
  assert.equal(pushed.length, 0, 'pre-existing active signals must not push on startup');

  db.close();
});

test('a burst beyond maxPerWindow coalesces into a single summary push', async () => {
  const cfg = { ...defaultNotificationsConfig(), maxPerWindow: 3, windowMinutes: 10 };
  const { db, pushed, notifier } = harness(cfg);

  persistSignals(
    db,
    [
      sig({ symbol: 'AAPL', code: 'rsi_overbought' }),
      sig({ symbol: 'NVDA', code: 'rsi_overbought' }),
      sig({ symbol: 'SHOP.TO', code: 'rsi_overbought' }),
      sig({ symbol: 'TD.TO', code: 'rsi_overbought' }),
    ],
    NOW,
  );
  await notifier.dispatch(NOW, true);
  assert.equal(pushed.length, 1, 'one coalesced summary, not four');
  assert.ok(/4 actionable signals/.test(pushed[0].title + pushed[0].message));

  db.close();
});

test('quiet hours: non-threshold suppressed (no push, consumed), hard threshold pushes', async () => {
  const { db, pushed, notifier } = harness();

  persistSignals(
    db,
    [
      sig({ symbol: 'AAPL', code: 'rsi_overbought', kind: 'technical' }),
      sig({ symbol: 'NVDA', code: 'price_at_or_above_sell', kind: 'threshold' }),
    ],
    NOW,
  );

  // Markets closed.
  await notifier.dispatch(NOW, false);
  assert.equal(pushed.length, 1, 'only the hard threshold pushes during quiet hours');
  assert.ok(pushed[0].title.includes('NVDA'));

  // The suppressed one is consumed (won't replay when markets reopen).
  await notifier.dispatch(NOW, true);
  assert.equal(pushed.length, 1, 'quiet-suppressed signal is not replayed later');

  db.close();
});

test('a push backend that throws is swallowed and the signal is still consumed', async () => {
  const db = new DB(':memory:');
  let calls = 0;
  const throwing: PushFn = async () => {
    calls += 1;
    throw new Error('permission denied');
  };
  const notifier = new Notifier(db, defaultNotificationsConfig(), throwing, () => 1_000_000);

  persistSignals(db, [sig()], NOW);
  await notifier.dispatch(NOW, true); // must not throw
  assert.equal(calls, 1);

  // Consumed despite the failure → no retry storm.
  await notifier.dispatch(NOW, true);
  assert.equal(calls, 1);

  db.close();
});

test('config master switch off → nothing pushes', async () => {
  const cfg = { ...defaultNotificationsConfig(), enabled: false };
  const { db, pushed, notifier } = harness(cfg);

  persistSignals(db, [sig()], NOW);
  await notifier.dispatch(NOW, true);
  assert.equal(pushed.length, 0);

  db.close();
});
