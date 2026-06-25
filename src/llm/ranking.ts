/**
 * Deterministic attention-ranking. **Code ranks; the LLM only narrates the
 * top-ranked items.** This is the one place `preferences.cadBias` is consumed.
 *
 * A symbol's base score rewards attention-worthiness:
 *   - actionable signals dominate (weight 100 each),
 *   - notable signals matter (weight 10),
 *   - context extremes — latest close near a window high/low — add weight (5),
 *   - concentration adds its CAD portfolio-share directly (a 30%-of-book
 *     position contributes 30), and unrealized-P&L magnitude adds a little.
 *   - every symbol gets a small floor (1) so the cadBias nudge can still order
 *     otherwise-quiet names.
 *
 * **cadBias nudge.** `cadBias ∈ [-1, 1]` tilts the ranking toward or away from
 * CAD-denominated symbols as a *nudge, not an override*:
 *
 *     adjusted = base × (1 + cadBias × dir × NUDGE)
 *
 * where `dir = +1` for CAD symbols and `-1` for USD, and `NUDGE = 0.5`. At
 * `cadBias = 0` the factor is 1 (neutral). Positive cadBias scales CAD scores up
 * and USD scores down (favours CAD exposure); negative does the reverse. Because
 * it's a bounded multiplier on the base score, a strong actionable signal still
 * outranks a quiet CAD name — the bias only breaks near-ties and tilts the
 * middle of the list.
 */

import type { Currency } from '../portfolio/PortfolioProvider.js';
import type { Signal } from '../signals/types.js';

/** How strongly cadBias is allowed to scale a base score, at |cadBias| = 1. */
const NUDGE = 0.5;

const W_ACTIONABLE = 100;
const W_NOTABLE = 10;
const W_CONTEXT_EXTREME = 5;
const BASE_FLOOR = 1;

export interface RankInputItem {
  symbol: string;
  currency: Currency;
  /** All currently-true signals for this symbol. */
  signals: Signal[];
  /** Share of total portfolio value (CAD) when held, else null. */
  sharePct?: number | null;
  /** Unrealized P&L percentage when held, else null. */
  pnlPct?: number | null;
}

export interface RankedItem {
  symbol: string;
  currency: Currency;
  base: number;
  score: number;
}

/** The factual base score before any cadBias nudge. */
export function baseScore(item: RankInputItem): number {
  let score = BASE_FLOOR;
  for (const s of item.signals) {
    if (s.kind === 'context') {
      const pos = typeof s.data.rangePosition === 'number' ? s.data.rangePosition : 50;
      if (pos >= 90 || pos <= 10) score += W_CONTEXT_EXTREME;
      continue;
    }
    if (s.severity === 'actionable') score += W_ACTIONABLE;
    else if (s.severity === 'notable') score += W_NOTABLE;
  }
  if (item.sharePct != null) score += item.sharePct;
  if (item.pnlPct != null) score += Math.abs(item.pnlPct) * 0.5;
  return score;
}

/** Apply the cadBias nudge to a base score. */
export function nudgedScore(base: number, currency: Currency, cadBias: number): number {
  const dir = currency === 'CAD' ? 1 : -1;
  return base * (1 + cadBias * dir * NUDGE);
}

/**
 * Rank symbols by attention-worthiness, descending. `cadBias` applies the
 * documented nudge. Ties break by base score, then symbol name (stable order).
 */
export function rankSymbols(items: RankInputItem[], cadBias: number): RankedItem[] {
  return items
    .map((item) => {
      const base = baseScore(item);
      return { symbol: item.symbol, currency: item.currency, base, score: nudgedScore(base, item.currency, cadBias) };
    })
    .sort((a, b) => b.score - a.score || b.base - a.base || a.symbol.localeCompare(b.symbol));
}
