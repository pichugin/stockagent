import type { BarRow } from '../db.js';

/**
 * Pure window math for the multi-timeframe **context** module. Every function
 * here is descriptive of a past window of bars — none extrapolates. They operate
 * on the ordered sequence of available bars and tolerate gaps (weekends,
 * closures, sparse minutes): they never assume contiguous samples.
 */

/**
 * Where `currentClose` sits within the window's [low, high] range, as 0–100
 * (0 = at the window low, 100 = at the window high). This is a min–max position,
 * not a rank. A flat window (high === low) has no meaningful position, so we
 * return 50 (neutral/indeterminate) rather than divide by zero.
 */
export function rangePosition(currentClose: number, low: number, high: number): number {
  if (high === low) return 50;
  return ((currentClose - low) / (high - low)) * 100;
}

/** Simple start→end percentage change across the window (sign = direction). */
export function changePct(firstClose: number, lastClose: number): number {
  if (firstClose === 0) return 0;
  return ((lastClose - firstClose) / firstClose) * 100;
}

/**
 * Realized volatility over the window: the population standard deviation of
 * consecutive simple returns (between successive *available* bars), as a
 * percentage. Gap-tolerant by construction — it measures bar-to-bar moves over
 * whatever samples exist, not calendar-spaced returns. Returns 0 for <2 closes.
 */
export function volatilityPct(closes: number[]): number {
  if (closes.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) continue;
    returns.push(closes[i] / closes[i - 1] - 1);
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

/**
 * Maximum peak-to-trough decline over the window's close sequence, as a positive
 * percentage (0 = no drawdown). Describes the worst observed drop within the
 * window; says nothing about the future.
 */
export function maxDrawdownPct(closes: number[]): number {
  if (closes.length === 0) return 0;
  let peak = closes[0];
  let maxDd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) {
      const dd = (peak - c) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

/** The market-clock (America/New_York) calendar day for a timestamp, YYYY-MM-DD. */
function marketDay(timestampMs: number): string {
  // 'en-CA' renders as YYYY-MM-DD; both US and TSX trade on the NY clock.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestampMs));
}

/**
 * Resample an ordered (any-order accepted) series of intraday bars into one
 * daily OHLCV bar per market-clock calendar day. Used to give the longer context
 * windows (1wk/1mo/6mo) daily resolution from the accumulated minute cache.
 *
 * Per day: open = first bar's open, high = max high, low = min low,
 * close = last bar's close, volume = summed, timestamp = the day's last bar.
 * Output is ascending by timestamp. Gap days simply don't appear (no synthetic
 * fill) — downstream window math is gap-tolerant.
 */
export function resampleToDaily(bars: BarRow[]): BarRow[] {
  if (bars.length === 0) return [];
  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  const byDay = new Map<string, BarRow>();
  for (const b of sorted) {
    const day = marketDay(b.timestamp);
    const existing = byDay.get(day);
    if (!existing) {
      byDay.set(day, { ...b });
    } else {
      existing.high = Math.max(existing.high, b.high);
      existing.low = Math.min(existing.low, b.low);
      existing.close = b.close; // sorted ascending, so this is the latest close
      existing.volume += b.volume;
      existing.timestamp = b.timestamp; // last bar of the day
    }
  }
  return [...byDay.values()].sort((a, b) => a.timestamp - b.timestamp);
}
