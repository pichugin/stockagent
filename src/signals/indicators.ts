import { BollingerBands, MACD, RSI, SMA } from 'technicalindicators';

/**
 * Pure, side-effect-free indicator helpers over an **ascending** close series
 * (oldest first, newest last). They tolerate gappy/sparse input by operating on
 * the ordered sequence of available closes — they never assume contiguous
 * minutes. Each returns `null` when there isn't enough history to compute,
 * leaving the firing decision to the caller.
 *
 * All math is descriptive of the present series; nothing here extrapolates.
 */

export type CrossDirection = 'bullish' | 'bearish';

/** Latest RSI value over `closes`, or null if fewer than `period + 1` closes. */
export function latestRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  const out = RSI.calculate({ period, values: closes });
  return out.length ? out[out.length - 1] : null;
}

export interface MacdSnapshot {
  macd: number;
  signal: number;
  histogram: number;
  /** Set when the MACD line crossed its signal line at the latest bar. */
  cross: CrossDirection | null;
}

/**
 * Latest MACD / signal / histogram plus signal-line cross detection. A
 * "bullish" cross is MACD rising above its signal line (histogram flips from
 * ≤0 to >0); "bearish" is the mirror. Needs two consecutive fully-formed
 * outputs (both MACD and signal defined), else returns null.
 */
export function latestMACD(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MacdSnapshot | null {
  const out = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const formed = out.filter(
    (o): o is { MACD: number; signal: number; histogram: number } =>
      o.MACD != null && o.signal != null && o.histogram != null,
  );
  if (formed.length < 2) return null;
  const prev = formed[formed.length - 2];
  const curr = formed[formed.length - 1];
  let cross: CrossDirection | null = null;
  if (prev.histogram <= 0 && curr.histogram > 0) cross = 'bullish';
  else if (prev.histogram >= 0 && curr.histogram < 0) cross = 'bearish';
  return { macd: curr.MACD, signal: curr.signal, histogram: curr.histogram, cross };
}

/** Latest simple moving average over `closes`, or null if too few closes. */
export function latestSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const out = SMA.calculate({ period, values: closes });
  return out.length ? out[out.length - 1] : null;
}

export interface MaCrossSnapshot {
  shortMA: number;
  longMA: number;
  /** Set when the short MA crossed the long MA at the latest bar. */
  cross: CrossDirection | null;
}

/**
 * Golden/death cross detection between a short and long SMA. Both SMA series
 * end at the latest bar, so they align from the tail: a "bullish" (golden)
 * cross is the short MA moving from at-or-below to above the long MA at the most
 * recent bar; "bearish" (death) is the mirror. Needs `longPeriod + 1` closes
 * (two consecutive long-MA points), else returns null.
 */
export function latestMACross(
  closes: number[],
  shortPeriod: number,
  longPeriod: number,
): MaCrossSnapshot | null {
  if (closes.length < longPeriod + 1) return null;
  const shortArr = SMA.calculate({ period: shortPeriod, values: closes });
  const longArr = SMA.calculate({ period: longPeriod, values: closes });
  if (shortArr.length < 2 || longArr.length < 2) return null;

  const sCurr = shortArr[shortArr.length - 1];
  const sPrev = shortArr[shortArr.length - 2];
  const lCurr = longArr[longArr.length - 1];
  const lPrev = longArr[longArr.length - 2];

  let cross: CrossDirection | null = null;
  if (sPrev <= lPrev && sCurr > lCurr) cross = 'bullish';
  else if (sPrev >= lPrev && sCurr < lCurr) cross = 'bearish';
  return { shortMA: sCurr, longMA: lCurr, cross };
}

export interface BollingerSnapshot {
  upper: number;
  middle: number;
  lower: number;
}

/** Latest Bollinger band triplet, or null if fewer than `period` closes. */
export function latestBollinger(
  closes: number[],
  period: number,
  stdDev: number,
): BollingerSnapshot | null {
  if (closes.length < period) return null;
  const out = BollingerBands.calculate({ period, stdDev, values: closes });
  if (!out.length) return null;
  const last = out[out.length - 1];
  return { upper: last.upper, middle: last.middle, lower: last.lower };
}
