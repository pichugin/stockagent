/**
 * Phase 4 signal vocabulary.
 *
 * A Signal describes *what is currently true* about a symbol's price, indicators,
 * or position — never a prediction. The `context` kind describes *where the price
 * sits within past windows* as factual context, not extrapolation. There is
 * deliberately no `expectedMove` / `forecast` / `target` field anywhere: a
 * prediction-shaped field would be a bug, not a feature.
 */

export type SignalKind =
  | 'technical' // RSI, MACD, MA cross, Bollinger
  | 'threshold' // user-defined price levels
  | 'position' // P&L, concentration, overweight
  | 'context'; // multi-timeframe factual context (not a trigger on its own)

export type Severity = 'info' | 'notable' | 'actionable';

export interface Signal {
  symbol: string;
  kind: SignalKind;
  /** Stable id, e.g. "rsi_overbought", "near_6mo_high". */
  code: string;
  severity: Severity;
  /** Plain, present-tense factual statement. No prediction. */
  summary: string;
  /** The numbers behind the signal (everything needed to re-explain it). */
  data: Record<string, number | string | boolean>;
  /** ISO timestamp the signal was computed/fired. */
  firedAt: string;
}

/**
 * A per-symbol diagnostic emitted when there isn't enough history to compute
 * indicators. Kept separate from {@link Signal} (it's transient, re-derivable
 * state, not a fact worth persisting/deduping) so the four signal kinds stay
 * faithful to the spec.
 */
export interface InsufficientData {
  symbol: string;
  /** Human-readable reason, e.g. "12 bars cached, need ≥15 for RSI(14)". */
  reason: string;
}

/** What the pure generators and the engine return for one scan. */
export interface ScanResult {
  signals: Signal[];
  insufficient: InsufficientData[];
}
