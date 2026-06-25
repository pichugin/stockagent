import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FRAMING_NOTE,
  deterministicNarration,
  findForbiddenLanguage,
  validateNarration,
} from './schema.js';
import type { Narration, NarrationInput } from './types.js';

function input(overrides: Partial<NarrationInput> = {}): NarrationInput {
  return {
    symbol: 'AAPL',
    asOf: '2024-06-01T00:00:00.000Z',
    signals: [
      { kind: 'technical', code: 'rsi_overbought', severity: 'notable', summary: 'RSI is overbought at 78' },
      { kind: 'position', code: 'position_overweight', severity: 'notable', summary: 'AAPL is 40% of the portfolio' },
    ],
    context: [],
    headlines: [],
    suggestedTrimPct: 15,
    ...overrides,
  };
}

function goodModel(overrides: Partial<Narration> = {}): Narration {
  return {
    symbol: 'AAPL',
    read: 'AAPL is overbought and at 40% of the book, above the 25% line.',
    bull: 'Read constructively, this is a strong, profitable holding near highs.',
    bear: 'Read cautiously, an overbought, oversized position concentrates risk.',
    suggestedAction: { option: 'One way to reduce concentration is trimming ~15%.', basisPct: 15 },
    framingNote: FRAMING_NOTE,
    ...overrides,
  };
}

test('forbidden-language filter catches prediction phrasing, allows factual phrasing', () => {
  assert.ok(findForbiddenLanguage('the stock will rise next week'));
  assert.ok(findForbiddenLanguage('we expect a pullback'));
  assert.ok(findForbiddenLanguage('likely to fall from here'));
  assert.ok(findForbiddenLanguage('this should rebound soon'));
  assert.ok(findForbiddenLanguage('our price target is 250'));
  assert.ok(findForbiddenLanguage('I predict a drop'));
  assert.ok(findForbiddenLanguage('guaranteed gains'));

  assert.equal(findForbiddenLanguage('RSI is overbought and near the top of its 6-month range'), null);
  assert.equal(findForbiddenLanguage('the window is up 3% with a 2% drawdown'), null);
  assert.equal(findForbiddenLanguage('this is 40% of the portfolio, above the line'), null);
});

test('a clean model response passes shape + framing validation unchanged', () => {
  const { narration, repairs, shapeOk } = validateNarration(goodModel(), input());
  assert.equal(shapeOk, true);
  assert.deepEqual(repairs, []);
  assert.equal(narration.read, goodModel().read);
  assert.equal(narration.framingNote, FRAMING_NOTE);
});

test('prediction-laden field is caught and replaced by the deterministic summary', () => {
  const laden = goodModel({ read: 'AAPL will rise sharply and is expected to break out.' });
  const { narration, repairs, shapeOk } = validateNarration(laden, input());
  assert.equal(shapeOk, true);
  assert.ok(repairs.some((r) => r.includes('forbidden-language in read')));
  // The poisoned field is replaced with the deterministic read; the others stay.
  assert.equal(narration.read, deterministicNarration(input()).read);
  assert.equal(narration.bull, laden.bull);
  assert.equal(narration.bear, laden.bear);
});

test('basisPct that differs from the code value is repaired (model cannot invent it)', () => {
  const invented = goodModel({ suggestedAction: { option: 'Trim ~30%.', basisPct: 30 } });
  const { narration, repairs } = validateNarration(invented, input({ suggestedTrimPct: 15 }));
  assert.equal(narration.suggestedAction.basisPct, 15);
  assert.ok(repairs.some((r) => r.includes('basisPct mismatch')));
});

test('basisPct is forced to null when the code computed no trim', () => {
  const invented = goodModel({ suggestedAction: { option: 'Trim ~10%.', basisPct: 10 } });
  const { narration } = validateNarration(invented, input({ suggestedTrimPct: null }));
  assert.equal(narration.suggestedAction.basisPct, null);
});

test('malformed shape falls back to the full deterministic narration', () => {
  const { narration, shapeOk } = validateNarration({ symbol: 'AAPL', read: 'x' }, input());
  assert.equal(shapeOk, false);
  assert.deepEqual(narration, deterministicNarration(input()));
});

test('deterministic narration always has both sides and the framing line', () => {
  const n = deterministicNarration(input());
  assert.ok(n.bull.length > 0 && n.bear.length > 0);
  assert.notEqual(n.bull, n.bear);
  assert.equal(n.framingNote, FRAMING_NOTE);
  assert.equal(n.suggestedAction.basisPct, 15);
  // The deterministic text itself must not trip the forbidden filter.
  for (const field of [n.read, n.bull, n.bear, n.suggestedAction.option]) {
    assert.equal(findForbiddenLanguage(field), null);
  }
});
