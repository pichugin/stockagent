import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BarRow } from '../db.js';
import { changePct, maxDrawdownPct, rangePosition, resampleToDaily, volatilityPct } from './windows.js';

test('rangePosition is min–max position in [0,100]', () => {
  assert.equal(rangePosition(50, 0, 100), 50);
  assert.equal(rangePosition(0, 0, 100), 0);
  assert.equal(rangePosition(100, 0, 100), 100);
  assert.equal(rangePosition(96, 50, 100), 92); // (96-50)/(100-50)*100
});

test('rangePosition of a flat window is neutral (50), never divides by zero', () => {
  assert.equal(rangePosition(42, 42, 42), 50);
});

test('changePct is signed start→end percentage', () => {
  assert.equal(changePct(100, 110), 10);
  assert.equal(changePct(100, 90), -10);
  assert.equal(changePct(0, 50), 0); // guarded
});

test('volatilityPct is 0 for a flat series and positive otherwise', () => {
  assert.equal(volatilityPct([10, 10, 10, 10]), 0);
  assert.ok(volatilityPct([10, 11, 10, 12]) > 0);
  assert.equal(volatilityPct([10]), 0);
});

test('maxDrawdownPct measures the worst peak-to-trough drop', () => {
  assert.equal(maxDrawdownPct([100, 50]), 50); // (100-50)/100
  assert.equal(maxDrawdownPct([100, 120, 60]), 50); // peak 120 -> 60
  assert.equal(maxDrawdownPct([100, 110, 120]), 0); // monotonic up
});

function bar(tsIso: string, o: number, h: number, l: number, c: number, v: number): BarRow {
  return { symbol: 'X', timestamp: Date.parse(tsIso), open: o, high: h, low: l, close: c, volume: v };
}

test('resampleToDaily groups intraday bars into one OHLCV bar per market day', () => {
  // 10:00 and 15:00 ET on 2024-01-02 (same NY day), then 10:00 ET on 2024-01-03.
  const bars = [
    bar('2024-01-02T15:00:00Z', 10, 12, 9, 11, 100), // 10:00 ET
    bar('2024-01-02T20:00:00Z', 11, 15, 8, 14, 200), // 15:00 ET
    bar('2024-01-03T15:00:00Z', 20, 22, 19, 21, 300), // next day 10:00 ET
  ];
  const daily = resampleToDaily(bars);
  assert.equal(daily.length, 2);

  const [d1, d2] = daily;
  assert.equal(d1.open, 10); // first bar's open
  assert.equal(d1.high, 15); // max high across the day
  assert.equal(d1.low, 8); // min low across the day
  assert.equal(d1.close, 14); // last bar's close
  assert.equal(d1.volume, 300); // summed

  assert.equal(d2.open, 20);
  assert.equal(d2.close, 21);
  assert.ok(d1.timestamp < d2.timestamp); // ascending output
});

test('resampleToDaily tolerates unordered input and empty input', () => {
  assert.deepEqual(resampleToDaily([]), []);
  const out = resampleToDaily([
    bar('2024-01-03T15:00:00Z', 20, 22, 19, 21, 300),
    bar('2024-01-02T15:00:00Z', 10, 12, 9, 11, 100),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].close, 11); // earlier day first after sorting
});
