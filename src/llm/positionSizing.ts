/**
 * Deterministic position-sizing. **Code decides the number; the LLM only phrases
 * it.** This is the single source of the suggested-trim percentage that flows
 * into the prompt as `suggestedTrimPct` and back out as `basisPct`. If a trim %
 * ever originates in the model, that is a bug the validator rejects.
 *
 * The suggestion is framed downstream as one option to *reduce exposure* — never
 * a prediction and never a directive. We only produce a number when there is a
 * concrete reduce-exposure rationale (overweight concentration and/or a large
 * unrealized gain); otherwise the result is `null` and no trim is suggested.
 */

import type { SignalsConfig } from '../config.js';
import type { NarrationPosition } from './types.js';

/** Inputs the sizing formula reads, all already computed by the deterministic layer. */
export interface TrimInputs {
  /** Share of total portfolio value (CAD), or null when unknown. */
  sharePct: number | null;
  /** Unrealized P&L as a percentage of cost basis at the latest close. */
  pnlPct: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Round to the nearest 5% — a suggestion this soft shouldn't imply false precision. */
const roundTo5 = (n: number): number => Math.round(n / 5) * 5;

/**
 * Compute the suggested-trim percentage, or `null` when no reduce-exposure
 * rationale applies.
 *
 * The formula, documented so it's auditable and tunable:
 *
 *  - **Concentration term.** If the position is overweight (its CAD share exceeds
 *    the configured concentration line), the base trim is the fraction that would
 *    bring it back *to* the line: `(sharePct - line) / sharePct * 100`. Trimming
 *    exactly this much reduces the position's portfolio weight to the line.
 *  - **Gain term.** A larger unrealized gain adds a small increment, capped, so a
 *    big winner nudges the suggestion slightly higher: `min(15, gainPct / 4)`.
 *    Losses contribute nothing (you don't "trim to lock in" a loss here).
 *  - The two terms sum, then clamp to **[5, 50]%** and round to the nearest 5%.
 *
 * Returns `null` when neither term fires (not overweight and not a large gain),
 * meaning: no suggested action with a number — the narration still describes the
 * situation, it just won't offer a trim option.
 */
export function suggestedTrimPct(inputs: TrimInputs, cfg: SignalsConfig): number | null {
  const { sharePct, pnlPct } = inputs;

  const line = cfg.concentration.overweightPct;
  const overweight = sharePct != null && sharePct > line;
  // "Large gain" reuses the P&L generator's own gain threshold for consistency.
  const largeGain = pnlPct >= cfg.pnl.gainPct;

  if (!overweight && !largeGain) return null;

  let pct = 0;
  if (overweight && sharePct != null) {
    pct += ((sharePct - line) / sharePct) * 100;
  }
  if (largeGain) {
    pct += Math.min(15, pnlPct / 4);
  }

  if (pct <= 0) return null;
  return roundTo5(clamp(pct, 5, 50));
}

/** Convenience: derive {@link TrimInputs} from a {@link NarrationPosition}. */
export function trimInputsFromPosition(p: NarrationPosition): TrimInputs {
  return { sharePct: p.sharePct, pnlPct: p.pnlPct };
}
