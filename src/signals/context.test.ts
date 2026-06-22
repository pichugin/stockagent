import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSignalsConfig } from '../config.js';
import type { BarRow } from '../db.js';
import { contextSignals } from './context.js';

const NOW = '2024-06-01T00:00:00.000Z';
const cfg = defaultSignalsConfig();

/** Build ascending daily bars from a close series (flat OHLC = close). */
function dailyFromCloses(closes: number[]): BarRow[] {
  const t0 = Date.parse('2024-01-01T00:00:00Z');
  return closes.map((c, i) => ({
    symbol: 'TEST',
    timestamp: t0 + i * 86_400_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 100,
  }));
}

test('a rising daily series puts the latest close near the 6-month high', () => {
  const daily = dailyFromCloses(Array.from({ length: 130 }, (_, i) => 100 + i));
  const { signals } = contextSignals('TEST', [], daily, cfg, NOW);

  const sixMo = signals.find((s) => s.code === 'near_6mo_high');
  assert.ok(sixMo, 'expected a near_6mo_high context signal');
  assert.equal(sixMo.kind, 'context');
  assert.equal(sixMo.data.rangePosition, 100); // latest close is the window max
  assert.equal(sixMo.data.trend, 'up');
  assert.ok((sixMo.data.changePct as number) > 0);
  // Range bounds are factual numbers from the window.
  assert.equal(sixMo.data.high, 229);
});

test('a falling daily series puts the latest close near the 6-month low', () => {
  const daily = dailyFromCloses(Array.from({ length: 130 }, (_, i) => 300 - i));
  const { signals } = contextSignals('TEST', [], daily, cfg, NOW);
  const sixMo = signals.find((s) => s.code === 'near_6mo_low');
  assert.ok(sixMo, 'expected a near_6mo_low context signal');
  assert.equal(sixMo.data.rangePosition, 0);
  assert.equal(sixMo.data.trend, 'down');
});

test('a window with too few bars is skipped silently (no signal, no throw)', () => {
  // Two daily bars: below every window minBars, so nothing is emitted.
  const { signals } = contextSignals('TEST', [], dailyFromCloses([100, 101]), cfg, NOW);
  assert.equal(signals.length, 0);
});

test('the 1-day window is described from intraday minute bars', () => {
  const t0 = Date.parse('2024-06-01T13:30:00Z');
  const minute: BarRow[] = Array.from({ length: 30 }, (_, i) => {
    const c = 100 + i; // rising through the session
    return { symbol: 'TEST', timestamp: t0 + i * 60_000, open: c, high: c, low: c, close: c, volume: 10 };
  });
  const { signals } = contextSignals('TEST', minute, [], cfg, NOW);
  const oneDay = signals.find((s) => s.code === 'near_1d_high');
  assert.ok(oneDay, 'expected a near_1d_high context signal from minute bars');
  assert.equal(oneDay.data.window, '1d');
});
