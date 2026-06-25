import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSignalsConfig } from '../config.js';
import type { Signal } from '../signals/types.js';
import { buildNarrationInput, type HeldNumbers } from './input.js';

const cfg = defaultSignalsConfig();
const NOW = '2024-06-01T00:00:00.000Z';

function ctxSignal(window: string, rangePosition: number): Signal {
  return {
    symbol: 'AAPL',
    kind: 'context',
    code: `near_${window}_high`,
    severity: 'notable',
    summary: `near ${window} high`,
    data: {
      window,
      rangePosition,
      trend: 'up',
      changePct: 3,
      volatilityPct: 1.2,
      maxDrawdownPct: -2,
      low: 100,
      high: 120,
      close: 119,
    },
    firedAt: NOW,
  };
}

function techSignal(): Signal {
  return {
    symbol: 'AAPL',
    kind: 'technical',
    code: 'rsi_overbought',
    severity: 'notable',
    summary: 'RSI(14) is overbought at 78',
    data: { rsi: 78 },
    firedAt: NOW,
  };
}

test('separates context windows from plain signals and carries no raw bars', () => {
  const input = buildNarrationInput({
    symbol: 'AAPL',
    asOf: NOW,
    signals: [techSignal(), ctxSignal('6mo', 95)],
    signalsCfg: cfg,
  });

  assert.equal(input.signals.length, 1);
  assert.equal(input.signals[0].code, 'rsi_overbought');
  assert.equal(input.context.length, 1);
  assert.equal(input.context[0].window, '6mo');
  assert.equal(input.context[0].rangePosition, 95);
  // No position → no trim suggested.
  assert.equal(input.suggestedTrimPct, null);
  assert.equal(input.position, undefined);
  // The structured payload is plain data — never a `bars`/`series` field.
  assert.ok(!('bars' in input));
});

test('attaches the code-computed trim % for an overweight held position', () => {
  const held: HeldNumbers = {
    shares: 10,
    avgCost: 100,
    currency: 'USD',
    latestClose: 130,
    pnlPct: 30,
    cadPnl: 400,
    sharePct: 40,
  };
  const input = buildNarrationInput({
    symbol: 'AAPL',
    asOf: NOW,
    signals: [techSignal()],
    position: held,
    signalsCfg: cfg,
  });
  assert.equal(input.position?.sharePct, 40);
  // Overweight (40 > 25) and a 30% gain → a positive, code-decided trim %.
  assert.ok(input.suggestedTrimPct != null && input.suggestedTrimPct > 0);
});

test('is pure: does not mutate inputs and is deterministic', () => {
  const signals = [techSignal(), ctxSignal('1mo', 5)];
  const frozen = JSON.parse(JSON.stringify(signals));
  const a = buildNarrationInput({ symbol: 'AAPL', asOf: NOW, signals, signalsCfg: cfg });
  const b = buildNarrationInput({ symbol: 'AAPL', asOf: NOW, signals, signalsCfg: cfg });
  assert.deepEqual(a, b);
  assert.deepEqual(signals, frozen); // inputs untouched
});
