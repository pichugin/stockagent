import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSignalsConfig } from '../config.js';
import type { BarRow } from '../db.js';
import { technicalSignals } from './technical.js';

const NOW = '2024-06-01T00:00:00.000Z';
const cfg = defaultSignalsConfig();

/** Build ascending 1-minute bars from a close series (flat OHLC = close). */
function barsFromCloses(closes: number[]): BarRow[] {
  const t0 = Date.parse('2024-01-02T15:00:00Z');
  return closes.map((c, i) => ({
    symbol: 'TEST',
    timestamp: t0 + i * 60_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 100,
  }));
}

test('a strictly falling series fires rsi_oversold and nothing else', () => {
  // 16 closes: enough for RSI(14) (needs 15), but fewer than Bollinger(20),
  // SMA(50) and the MACD warm-up — so only RSI can speak.
  const closes = Array.from({ length: 16 }, (_, i) => 100 - i);
  const { signals, insufficient } = technicalSignals('TEST', barsFromCloses(closes), cfg, NOW);
  assert.equal(insufficient.length, 0);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].code, 'rsi_oversold');
  assert.equal(signals[0].kind, 'technical');
  assert.equal(signals[0].severity, 'notable');
  assert.equal(signals[0].data.rsi, 0); // all losses → RSI 0
});

test('a strictly rising series fires rsi_overbought and nothing else', () => {
  const closes = Array.from({ length: 16 }, (_, i) => 100 + i);
  const { signals } = technicalSignals('TEST', barsFromCloses(closes), cfg, NOW);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].code, 'rsi_overbought');
  assert.equal(signals[0].data.rsi, 100); // all gains → RSI 100
});

test('too little history yields insufficient_data, not signals or a throw', () => {
  const { signals, insufficient } = technicalSignals('TEST', barsFromCloses([1, 2, 3]), cfg, NOW);
  assert.equal(signals.length, 0);
  assert.equal(insufficient.length, 1);
  assert.equal(insufficient[0].symbol, 'TEST');
  assert.match(insufficient[0].reason, /need ≥15/);
});

test('a calm mid-range series with ≥50 bars reports price-vs-MA without overbought/oversold', () => {
  // Oscillate tightly around 100 so RSI stays mid-band; 60 bars enables SMA(50).
  const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0.5 : -0.5));
  const { signals } = technicalSignals('TEST', barsFromCloses(closes), cfg, NOW);
  const codes = signals.map((s) => s.code);
  assert.ok(!codes.includes('rsi_overbought'));
  assert.ok(!codes.includes('rsi_oversold'));
  // Exactly one of the price-vs-50MA pair is always true.
  const maPair = codes.filter((c) => c === 'price_above_50ma' || c === 'price_below_50ma');
  assert.equal(maPair.length, 1);
});
