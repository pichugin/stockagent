import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSignalsConfig } from '../config.js';
import { suggestedTrimPct } from './positionSizing.js';

const cfg = defaultSignalsConfig(); // overweightPct 25, gainPct 20

test('no reduce-exposure rationale → null (not overweight, not a large gain)', () => {
  assert.equal(suggestedTrimPct({ sharePct: 20, pnlPct: 5 }, cfg), null);
  assert.equal(suggestedTrimPct({ sharePct: null, pnlPct: -10 }, cfg), null);
});

test('overweight alone produces a trim that brings weight toward the line', () => {
  // (40-25)/40*100 = 37.5 → clamp → round to nearest 5 → 40
  assert.equal(suggestedTrimPct({ sharePct: 40, pnlPct: 0 }, cfg), 40);
});

test('a large gain alone produces a small trim', () => {
  // gain term min(15, 24/4=6) = 6 → round to 5
  assert.equal(suggestedTrimPct({ sharePct: null, pnlPct: 24 }, cfg), 5);
});

test('overweight + large gain sum and clamp to 50', () => {
  // (60-25)/60*100 = 58.33 + min(15,10)=10 → 68.3 → clamp 50
  assert.equal(suggestedTrimPct({ sharePct: 60, pnlPct: 40 }, cfg), 50);
});

test('result is always a multiple of 5 within [5,50] when present', () => {
  for (let share = 26; share <= 99; share++) {
    const t = suggestedTrimPct({ sharePct: share, pnlPct: 0 }, cfg);
    if (t != null) {
      assert.ok(t >= 5 && t <= 50, `in range for share ${share}`);
      assert.equal(t % 5, 0, `multiple of 5 for share ${share}`);
    }
  }
});
