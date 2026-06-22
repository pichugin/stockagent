import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convert, decomposeCostBasisFx, money, toCAD } from './convert.js';

const RATE = 1.4; // 1 USD = 1.4 CAD

test('USD → CAD multiplies by the rate', () => {
  const out = toCAD(money(100, 'USD'), RATE);
  assert.equal(out.currency, 'CAD');
  assert.equal(out.amount, 140);
});

test('CAD → USD divides by the rate', () => {
  const out = convert(money(140, 'CAD'), 'USD', RATE);
  assert.equal(out.currency, 'USD');
  assert.ok(Math.abs(out.amount - 100) < 1e-9);
});

test('USD → CAD → USD round-trips within rounding', () => {
  const start = money(250.75, 'USD');
  const back = convert(toCAD(start, RATE), 'USD', RATE);
  assert.equal(back.currency, 'USD');
  assert.ok(Math.abs(back.amount - start.amount) < 1e-9);
});

test('same-currency conversions are the identity', () => {
  assert.equal(convert(money(42, 'USD'), 'USD', RATE).amount, 42);
  assert.equal(convert(money(42, 'CAD'), 'CAD', RATE).amount, 42);
});

test('a non-positive rate is rejected', () => {
  assert.throws(() => convert(money(1, 'USD'), 'CAD', 0));
  assert.throws(() => convert(money(1, 'USD'), 'CAD', -1.4));
});

test('cost-basis decomposition: components sum to the CAD total and split is exact', () => {
  // 10 shares @ $20 USD, bought at fx 1.30, now 1.40.
  const d = decomposeCostBasisFx(10, 20, 1.3, 1.4);
  assert.equal(d.native, 200);
  assert.ok(Math.abs(d.cadAtCost - 260) < 1e-9); // 200 * 1.30
  assert.ok(Math.abs(d.cadAtCurrent - 280) < 1e-9); // 200 * 1.40
  assert.ok(Math.abs(d.fxComponent - 20) < 1e-9); // 200 * (1.40 - 1.30)
  // FX component bridges cost-time CAD to current-time CAD exactly.
  assert.ok(Math.abs(d.cadAtCost + d.fxComponent - d.cadAtCurrent) < 1e-9);
});

test('cost-basis decomposition: a CAD position (rates = 1) has zero FX component', () => {
  const d = decomposeCostBasisFx(50, 95, 1, 1);
  assert.equal(d.native, 4750);
  assert.equal(d.cadAtCost, 4750);
  assert.equal(d.cadAtCurrent, 4750);
  assert.equal(d.fxComponent, 0);
});
