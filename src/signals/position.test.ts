import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSignalsConfig } from '../config.js';
import { positionSignals, type HeldQuote } from './position.js';

const NOW = '2024-06-01T00:00:00.000Z';
const cfg = defaultSignalsConfig();
const RATE = 1.4; // 1 USD = 1.4 CAD
const none = new Set<string>();

test('an empty portfolio yields no position signals', () => {
  assert.equal(positionSignals([], RATE, cfg, NOW, none).length, 0);
});

test('a large gain fires large_unrealized_gain with CAD-normalized P&L', () => {
  const held: HeldQuote[] = [
    { symbol: 'AAPL', shares: 10, avgCost: 100, currency: 'USD', latestClose: 130 },
  ];
  const out = positionSignals(held, RATE, cfg, NOW, none);
  const gain = out.find((s) => s.code === 'large_unrealized_gain');
  assert.ok(gain);
  assert.equal(gain.data.pnlPct, 30);
  assert.equal(gain.data.cadPnl, 420); // (130-100)*10 USD * 1.4
});

test('a large loss fires large_unrealized_loss', () => {
  const held: HeldQuote[] = [
    { symbol: 'AAPL', shares: 10, avgCost: 100, currency: 'USD', latestClose: 80 },
  ];
  const out = positionSignals(held, RATE, cfg, NOW, none);
  const loss = out.find((s) => s.code === 'large_unrealized_loss');
  assert.ok(loss);
  assert.equal(loss.data.pnlPct, -20);
});

test('missing FX reports native P&L and marks CAD as n/a (no guessing)', () => {
  const held: HeldQuote[] = [
    { symbol: 'AAPL', shares: 10, avgCost: 100, currency: 'USD', latestClose: 130 },
  ];
  const out = positionSignals(held, null, cfg, NOW, none);
  const gain = out.find((s) => s.code === 'large_unrealized_gain');
  assert.ok(gain);
  assert.equal(gain.data.cadPnl, 'n/a');
});

test('an outsized holding fires position_overweight on its CAD share', () => {
  const held: HeldQuote[] = [
    { symbol: 'AAPL', shares: 100, avgCost: 1, currency: 'USD', latestClose: 100 }, // 10000 USD -> 14000 CAD
    { symbol: 'TD.TO', shares: 1, avgCost: 1, currency: 'CAD', latestClose: 100 }, // 100 CAD
  ];
  const out = positionSignals(held, RATE, cfg, NOW, none);
  const ow = out.find((s) => s.code === 'position_overweight');
  assert.ok(ow);
  assert.equal(ow.symbol, 'AAPL');
  assert.ok((ow.data.sharePct as number) > 25);
});

test('concentration is skipped when a USD position has no FX rate', () => {
  const held: HeldQuote[] = [
    { symbol: 'AAPL', shares: 100, avgCost: 1, currency: 'USD', latestClose: 100 },
    { symbol: 'TD.TO', shares: 1, avgCost: 1, currency: 'CAD', latestClose: 100 },
  ];
  const out = positionSignals(held, null, cfg, NOW, none);
  assert.equal(out.filter((s) => s.code === 'position_overweight').length, 0);
});

test('multiple overbought holdings fire the portfolio rollup', () => {
  const held: HeldQuote[] = [
    { symbol: 'AAPL', shares: 1, avgCost: 100, currency: 'USD', latestClose: 101 },
    { symbol: 'NVDA', shares: 1, avgCost: 100, currency: 'USD', latestClose: 101 },
  ];
  const overbought = new Set(['AAPL', 'NVDA']);
  const out = positionSignals(held, RATE, cfg, NOW, overbought);
  const rollup = out.find((s) => s.code === 'multiple_holdings_overbought');
  assert.ok(rollup);
  assert.equal(rollup.data.count, 2);
  assert.equal(rollup.symbol, 'PORTFOLIO');
});
