/**
 * Pure notification-decision logic — the heart of Phase 5's notification
 * discipline, kept free of I/O so it's exhaustively unit-testable without ever
 * firing an OS notification.
 *
 * The decision answers one question per cycle: given the signals eligible to
 * push (active, `actionable`, not yet notified) plus the current market/throttle
 * context, *which* push and *how* (individually vs. coalesced vs. suppressed)?
 *
 * Everything here is descriptive delivery, not analysis — there is no new
 * signal logic and nothing prediction-shaped.
 */

/** The minimal shape the decision needs; {@link import('../db.js').SignalRow} satisfies it. */
export interface NotifiableSignal {
  id: number;
  symbol: string;
  kind: string;
  code: string;
  severity: string;
  summary: string;
}

export interface NotifyContext {
  /** Whether markets are currently open (Phase-1 market-hours gate). */
  marketOpen: boolean;
  /** Suppress non-threshold actionable pushes while markets are closed. */
  quietHoursOutsideMarket: boolean;
  /** Global cap: at most this many pushes per rolling window. */
  maxPerWindow: number;
  /** Pushes already sent within the current rolling window. */
  recentCount: number;
}

/**
 * What to do with this cycle's candidates:
 *  - `individual`: push one notification each (within budget, not suppressed).
 *  - `coalesced`: a burst that exceeds the remaining budget — push ONE summary
 *    notification covering all of them instead of spamming N.
 *  - `quietSuppressed`: held back by quiet hours; surfaced in the dashboard /
 *    `signals` query but never pushed (and never retroactively replayed).
 *
 * `individual` and `coalesced` are mutually exclusive in a single cycle.
 */
export interface NotifyPlan {
  individual: NotifiableSignal[];
  coalesced: NotifiableSignal[] | null;
  quietSuppressed: NotifiableSignal[];
}

/**
 * A user-set price threshold is a *hard* alert: it pushes even during quiet
 * hours, because the user explicitly asked to be told when that level is hit.
 * Every other actionable signal is engine-derived and respects quiet hours.
 */
function isHardThreshold(s: NotifiableSignal): boolean {
  return s.kind === 'threshold';
}

export function decideNotifications(
  candidates: NotifiableSignal[],
  ctx: NotifyContext,
): NotifyPlan {
  const quiet = ctx.quietHoursOutsideMarket && !ctx.marketOpen;

  const pushable: NotifiableSignal[] = [];
  const quietSuppressed: NotifiableSignal[] = [];
  for (const s of candidates) {
    if (quiet && !isHardThreshold(s)) quietSuppressed.push(s);
    else pushable.push(s);
  }

  const budget = Math.max(0, ctx.maxPerWindow - ctx.recentCount);

  if (pushable.length === 0) {
    return { individual: [], coalesced: null, quietSuppressed };
  }
  // Within budget → push each on its own. Otherwise the cycle's burst exceeds
  // what the rate limit allows, so collapse it to a single summary push.
  if (pushable.length <= budget) {
    return { individual: pushable, coalesced: null, quietSuppressed };
  }
  return { individual: [], coalesced: pushable, quietSuppressed };
}

/** Human-friendly short labels for notification titles, by signal code. */
const CODE_LABELS: Record<string, string> = {
  price_at_or_below_buy: 'buy level hit',
  price_at_or_above_sell: 'sell level hit',
  position_overweight: 'overweight position',
  large_unrealized_gain: 'large unrealized gain',
  large_unrealized_loss: 'large unrealized loss',
  multiple_holdings_overbought: 'multiple holdings overbought',
  rsi_overbought: 'overbought (RSI)',
  rsi_oversold: 'oversold (RSI)',
  macd_bullish_cross: 'MACD bullish cross',
  macd_bearish_cross: 'MACD bearish cross',
  ma_golden_cross: 'golden cross',
  ma_death_cross: 'death cross',
  price_below_lower_band: 'below lower band',
  price_above_upper_band: 'above upper band',
};

/** Turn a stable code into a readable phrase, falling back to a humanized form. */
export function codeLabel(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  // Dynamic codes like `near_6mo_high` / `within_1y_range` → readable text.
  return code.replace(/_/g, ' ');
}

/** Carried through every push: makes the mechanical nature explicit. */
export const FRAMING_SUFFIX = ' · signal, not advice.';

/** Notification title for a single signal, e.g. "AAPL — sell level hit". */
export function notificationTitle(s: NotifiableSignal): string {
  return `${s.symbol} — ${codeLabel(s.code)}`;
}

/** Notification body: the factual summary plus the always-on framing suffix. */
export function notificationBody(s: NotifiableSignal): string {
  return `${s.summary}${FRAMING_SUFFIX}`;
}

/** Title/body for a coalesced burst summary. */
export function coalescedNotification(count: number): { title: string; message: string } {
  return {
    title: `${count} actionable signals`,
    message: `${count} actionable signals — run \`stockagent signals --active\`${FRAMING_SUFFIX}`,
  };
}
