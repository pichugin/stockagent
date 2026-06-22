import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codeLabel,
  decideNotifications,
  FRAMING_SUFFIX,
  notificationBody,
  notificationTitle,
  type NotifiableSignal,
} from './decision.js';

let nextId = 1;
function sig(partial: Partial<NotifiableSignal> = {}): NotifiableSignal {
  return {
    id: nextId++,
    symbol: 'AAPL',
    kind: 'technical',
    code: 'rsi_overbought',
    severity: 'actionable',
    summary: 'RSI is overbought',
    ...partial,
  };
}

const OPEN = {
  marketOpen: true,
  quietHoursOutsideMarket: true,
  maxPerWindow: 5,
  recentCount: 0,
};

test('within budget → each pushes individually', () => {
  const plan = decideNotifications([sig(), sig()], OPEN);
  assert.equal(plan.individual.length, 2);
  assert.equal(plan.coalesced, null);
  assert.equal(plan.quietSuppressed.length, 0);
});

test('a burst beyond the cap coalesces into one summary, not N', () => {
  const cands = [sig(), sig(), sig(), sig()];
  const plan = decideNotifications(cands, { ...OPEN, maxPerWindow: 3 });
  assert.equal(plan.individual.length, 0);
  assert.ok(plan.coalesced);
  assert.equal(plan.coalesced!.length, 4);
});

test('window already exhausted → remaining coalesce into one summary', () => {
  const plan = decideNotifications([sig(), sig()], { ...OPEN, maxPerWindow: 5, recentCount: 5 });
  assert.equal(plan.individual.length, 0);
  assert.equal(plan.coalesced!.length, 2);
});

test('quiet hours suppress non-threshold actionable but pass hard thresholds', () => {
  const tech = sig({ kind: 'technical', code: 'rsi_overbought' });
  const thr = sig({ kind: 'threshold', code: 'price_at_or_above_sell' });
  const plan = decideNotifications([tech, thr], {
    marketOpen: false,
    quietHoursOutsideMarket: true,
    maxPerWindow: 5,
    recentCount: 0,
  });
  assert.deepEqual(
    plan.individual.map((s) => s.code),
    ['price_at_or_above_sell'],
  );
  assert.deepEqual(
    plan.quietSuppressed.map((s) => s.code),
    ['rsi_overbought'],
  );
});

test('quiet hours disabled → market-closed signals still push', () => {
  const plan = decideNotifications([sig()], {
    marketOpen: false,
    quietHoursOutsideMarket: false,
    maxPerWindow: 5,
    recentCount: 0,
  });
  assert.equal(plan.individual.length, 1);
  assert.equal(plan.quietSuppressed.length, 0);
});

test('no candidates → empty plan', () => {
  const plan = decideNotifications([], OPEN);
  assert.equal(plan.individual.length, 0);
  assert.equal(plan.coalesced, null);
});

test('title and body carry symbol, label, summary and the framing suffix', () => {
  const s = sig({ symbol: 'NVDA', code: 'price_at_or_above_sell', summary: 'close above your level' });
  assert.equal(notificationTitle(s), 'NVDA — sell level hit');
  const body = notificationBody(s);
  assert.ok(body.startsWith('close above your level'));
  assert.ok(body.endsWith(FRAMING_SUFFIX));
});

test('codeLabel humanizes unknown/dynamic codes', () => {
  assert.equal(codeLabel('near_6mo_high'), 'near 6mo high');
  assert.equal(codeLabel('rsi_oversold'), 'oversold (RSI)');
});
