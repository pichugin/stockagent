import type { Currency } from '../portfolio/PortfolioProvider.js';

/** An amount tagged with its currency. Pure value object — no I/O. */
export interface Money {
  amount: number;
  currency: Currency;
}

export function money(amount: number, currency: Currency): Money {
  return { amount, currency };
}

/**
 * Convert `m` into `target` using the canonical USD→CAD rate `usdCad`
 * (1 USD = `usdCad` CAD). The four conversions are all derived from this single
 * stored direction:
 *   - USD→CAD: × usdCad
 *   - CAD→USD: ÷ usdCad
 *   - USD→USD / CAD→CAD: identity
 *
 * Full precision is kept; callers round only at display time.
 */
export function convert(m: Money, target: Currency, usdCad: number): Money {
  if (!(usdCad > 0)) {
    throw new Error(`convert: usdCad rate must be positive, got ${usdCad}`);
  }
  if (m.currency === target) return { amount: m.amount, currency: target };
  if (m.currency === 'USD' && target === 'CAD') {
    return { amount: m.amount * usdCad, currency: 'CAD' };
  }
  if (m.currency === 'CAD' && target === 'USD') {
    return { amount: m.amount / usdCad, currency: 'USD' };
  }
  // Unreachable while Currency is USD|CAD, but keeps the function total.
  throw new Error(`convert: unsupported pair ${m.currency}->${target}`);
}

/** Convenience wrapper: convert any `Money` to CAD (the home currency). */
export function toCAD(m: Money, usdCad: number): Money {
  return convert(m, 'CAD', usdCad);
}

/**
 * Underlying-vs-FX decomposition of a position's **cost basis** converted to
 * CAD. Phase 3 has no live market price, so this only describes how the CAD
 * value of the *cost basis* has shifted purely because USD/CAD moved between the
 * rate at purchase (`fxAtCost`) and the current rate (`fxNow`).
 *
 * For a CAD position both rates are 1, so `fxComponent` is 0 and the conversion
 * is trivial.
 *
 * The split is labelled "approximate": full unrealized-P&L decomposition (which
 * also has an underlying-move term and a cross-term) only becomes possible once
 * live prices are wired in a later phase.
 */
export interface CostBasisFx {
  native: number; // shares * avgCost, in the position's native currency
  cadAtCost: number; // native value × fxAtCost  (CAD locked in at purchase)
  cadAtCurrent: number; // native value × fxNow   (CAD value at today's rate)
  /** cadAtCurrent − cadAtCost = native × (fxNow − fxAtCost). Pure FX effect. */
  fxComponent: number;
}

export function decomposeCostBasisFx(
  shares: number,
  avgCost: number,
  fxAtCost: number,
  fxNow: number,
): CostBasisFx {
  const native = shares * avgCost;
  const cadAtCost = native * fxAtCost;
  const cadAtCurrent = native * fxNow;
  return {
    native,
    cadAtCost,
    cadAtCurrent,
    fxComponent: cadAtCurrent - cadAtCost,
  };
}
