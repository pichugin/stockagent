import assert from 'node:assert/strict';
import { test } from 'node:test';
import { thresholdSignals } from './threshold.js';

const NOW = '2024-06-01T00:00:00.000Z';

test('fires price_at_or_above_sell when the close reaches the sell level', () => {
  const out = thresholdSignals('AAPL', 251, { symbol: 'AAPL', buyBelow: null, sellAbove: 250 }, 'USD', NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'price_at_or_above_sell');
  assert.equal(out[0].severity, 'actionable');
  assert.equal(out[0].data.level, 250);
});

test('fires exactly at the level (inclusive)', () => {
  const out = thresholdSignals('AAPL', 250, { symbol: 'AAPL', buyBelow: null, sellAbove: 250 }, 'USD', NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'price_at_or_above_sell');
});

test('fires price_at_or_below_buy when the close drops to the buy level', () => {
  const out = thresholdSignals('SHOP.TO', 199, { symbol: 'SHOP.TO', buyBelow: 200, sellAbove: null }, 'CAD', NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'price_at_or_below_buy');
  assert.match(out[0].summary, /CAD/);
});

test('no alert, or close inside both bounds, fires nothing', () => {
  assert.equal(thresholdSignals('AAPL', 240, null, 'USD', NOW).length, 0);
  const out = thresholdSignals('AAPL', 240, { symbol: 'AAPL', buyBelow: 200, sellAbove: 250 }, 'USD', NOW);
  assert.equal(out.length, 0);
});
