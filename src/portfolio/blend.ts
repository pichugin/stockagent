import type { Currency } from './PortfolioProvider.js';

/** The blended position after folding an additional buy into an existing one. */
export interface BlendResult {
  shares: number;
  avgCost: number; // native-currency weighted-average per-share cost
  fxAtCost: number | null;
}

/**
 * Fold an additional buy into an existing position, keeping the single-record
 * model. All native-currency amounts. The blend is exact for the quantities the
 * cost-basis FX decomposition needs:
 *
 *   shares   = oldShares + buyShares
 *   avgCost  = Σ(qᵢ·pᵢ) / Σqᵢ                 (cost-weighted native average)
 *   fxAtCost = Σ(qᵢ·pᵢ·fᵢ) / Σ(qᵢ·pᵢ)         (cost-weighted USD→CAD rate)
 *
 * `fxAtCost` is `1` for CAD positions (no FX exposure). It is `null` when either
 * side's FX is unknown — a legacy position with no snapshot, or a buy made while
 * FX was unavailable — because there is no honest way to blend an unknown rate;
 * callers surface that rather than guess. Full precision is kept; callers round
 * at display time only.
 */
export function blendBuy(
  oldShares: number,
  oldAvgCost: number,
  oldFx: number | null,
  buyShares: number,
  buyPrice: number,
  buyFx: number | null,
  currency: Currency,
): BlendResult {
  const shares = oldShares + buyShares;
  const oldNative = oldShares * oldAvgCost;
  const buyNative = buyShares * buyPrice;
  const totalNative = oldNative + buyNative;
  const avgCost = shares > 0 ? totalNative / shares : 0;

  let fxAtCost: number | null;
  if (currency === 'CAD') {
    fxAtCost = 1;
  } else if (oldFx == null || buyFx == null) {
    fxAtCost = null;
  } else if (totalNative > 0) {
    fxAtCost = (oldNative * oldFx + buyNative * buyFx) / totalNative;
  } else {
    // Both lots are zero-cost (free shares); cost-weighting is undefined, so
    // fall back to the new buy's rate rather than divide by zero.
    fxAtCost = buyFx;
  }

  return { shares, avgCost, fxAtCost };
}
