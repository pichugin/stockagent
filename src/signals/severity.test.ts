import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySeverityCombinations } from './severity.js';
import type { Signal } from './types.js';

const NOW = '2024-06-01T00:00:00.000Z';

function sig(symbol: string, code: string, severity: Signal['severity']): Signal {
  return { symbol, kind: 'technical', code, severity, summary: code, data: {}, firedAt: NOW };
}

test('held + oversold + near a window low raises rsi_oversold to actionable', () => {
  const signals = [sig('AAPL', 'rsi_oversold', 'notable'), sig('AAPL', 'near_6mo_low', 'notable')];
  applySeverityCombinations(signals, new Set(['AAPL']));
  assert.equal(signals.find((s) => s.code === 'rsi_oversold')!.severity, 'actionable');
});

test('the same combination on a non-held symbol stays notable', () => {
  const signals = [sig('AAPL', 'rsi_oversold', 'notable'), sig('AAPL', 'near_6mo_low', 'notable')];
  applySeverityCombinations(signals, new Set()); // not held
  assert.equal(signals.find((s) => s.code === 'rsi_oversold')!.severity, 'notable');
});

test('held + overbought + overweight raises both to actionable', () => {
  const signals = [
    sig('NVDA', 'rsi_overbought', 'notable'),
    sig('NVDA', 'position_overweight', 'notable'),
  ];
  applySeverityCombinations(signals, new Set(['NVDA']));
  assert.equal(signals.find((s) => s.code === 'rsi_overbought')!.severity, 'actionable');
  assert.equal(signals.find((s) => s.code === 'position_overweight')!.severity, 'actionable');
});

test('an isolated oversold (no window low) is left at its base severity', () => {
  const signals = [sig('AAPL', 'rsi_oversold', 'notable')];
  applySeverityCombinations(signals, new Set(['AAPL']));
  assert.equal(signals[0].severity, 'notable');
});
