import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blendBuy } from './blend.js';
import { decomposeCostBasisFx } from '../fx/convert.js';

test('blends shares and the native weighted-average cost', () => {
  // 10 @ 125 then 5 @ 110 -> 15 @ 120.
  const r = blendBuy(10, 125, 1.38, 5, 110, 1.4, 'USD');
  assert.equal(r.shares, 15);
  assert.ok(Math.abs(r.avgCost - 120) < 1e-9);
});

test('fxAtCost is the cost-weighted average of the per-lot rates', () => {
  // (1250*1.38 + 550*1.40) / 1800 = 2483.0 / 1800.
  const r = blendBuy(10, 125, 1.38, 5, 110, 1.4, 'USD');
  const expected = (1250 * 1.38 + 550 * 1.4) / 1800;
  assert.ok(r.fxAtCost != null && Math.abs(r.fxAtCost - expected) < 1e-9);
});

test('blended record reproduces the true CAD cost basis exactly', () => {
  // The CAD actually locked in across the two lots.
  const trueCadAtCost = 1250 * 1.38 + 550 * 1.4;
  const r = blendBuy(10, 125, 1.38, 5, 110, 1.4, 'USD');
  const d = decomposeCostBasisFx(r.shares, r.avgCost, r.fxAtCost as number, 1.4232);
  assert.ok(Math.abs(d.cadAtCost - trueCadAtCost) < 1e-6);
});

test('CAD positions always blend to a rate of 1', () => {
  const r = blendBuy(100, 50, 1, 40, 55, 1, 'CAD');
  assert.equal(r.shares, 140);
  assert.ok(Math.abs(r.avgCost - (100 * 50 + 40 * 55) / 140) < 1e-9);
  assert.equal(r.fxAtCost, 1);
});

test('a missing FX snapshot on either side yields null (no guessing)', () => {
  assert.equal(blendBuy(10, 125, null, 5, 110, 1.4, 'USD').fxAtCost, null);
  assert.equal(blendBuy(10, 125, 1.38, 5, 110, null, 'USD').fxAtCost, null);
});

test('zero-cost lots fall back to the buy rate rather than dividing by zero', () => {
  const r = blendBuy(10, 0, 1.3, 5, 0, 1.45, 'USD');
  assert.equal(r.shares, 15);
  assert.equal(r.avgCost, 0);
  assert.equal(r.fxAtCost, 1.45);
});
