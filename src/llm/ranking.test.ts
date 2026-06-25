import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Signal } from '../signals/types.js';
import { rankSymbols, type RankInputItem } from './ranking.js';

const NOW = '2024-06-01T00:00:00.000Z';

function notable(symbol: string): Signal {
  return { symbol, kind: 'technical', code: 'rsi_overbought', severity: 'notable', summary: 's', data: {}, firedAt: NOW };
}
function actionable(symbol: string): Signal {
  return { symbol, kind: 'threshold', code: 'price_at_or_above_sell', severity: 'actionable', summary: 's', data: {}, firedAt: NOW };
}

const usd: RankInputItem = { symbol: 'AAA', currency: 'USD', signals: [notable('AAA')] };
const cad: RankInputItem = { symbol: 'BBB.TO', currency: 'CAD', signals: [notable('BBB.TO')] };

test('cadBias 0 is neutral: equal-base symbols order stably (by name)', () => {
  const ranked = rankSymbols([usd, cad], 0);
  assert.deepEqual(
    ranked.map((r) => r.symbol),
    ['AAA', 'BBB.TO'],
  );
});

test('positive cadBias measurably reorders toward the CAD symbol', () => {
  const ranked = rankSymbols([usd, cad], 1);
  assert.deepEqual(
    ranked.map((r) => r.symbol),
    ['BBB.TO', 'AAA'],
  );
});

test('negative cadBias measurably reorders toward the USD symbol', () => {
  // Start from an arrangement where CAD would otherwise lead, then bias to USD.
  const cadHeavy: RankInputItem = { symbol: 'AAA.TO', currency: 'CAD', signals: [notable('AAA.TO')] };
  const usdItem: RankInputItem = { symbol: 'ZZZ', currency: 'USD', signals: [notable('ZZZ')] };
  const neutral = rankSymbols([cadHeavy, usdItem], 0).map((r) => r.symbol);
  const biased = rankSymbols([cadHeavy, usdItem], -1).map((r) => r.symbol);
  assert.deepEqual(neutral, ['AAA.TO', 'ZZZ']); // tie → alphabetical
  assert.deepEqual(biased, ['ZZZ', 'AAA.TO']); // USD favoured
});

test('cadBias is a nudge, not an override: an actionable signal still ranks first', () => {
  const usdActionable: RankInputItem = { symbol: 'AAA', currency: 'USD', signals: [actionable('AAA')] };
  const cadQuiet: RankInputItem = { symbol: 'BBB.TO', currency: 'CAD', signals: [] };
  const ranked = rankSymbols([usdActionable, cadQuiet], 1); // max bias toward CAD
  assert.equal(ranked[0].symbol, 'AAA');
});

test('concentration and P&L magnitude raise a held symbol score', () => {
  const quiet: RankInputItem = { symbol: 'AAA', currency: 'USD', signals: [] };
  const heldBig: RankInputItem = { symbol: 'BBB', currency: 'USD', signals: [], sharePct: 40, pnlPct: 30 };
  const ranked = rankSymbols([quiet, heldBig], 0);
  assert.equal(ranked[0].symbol, 'BBB');
});
