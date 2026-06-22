import YahooFinance from 'yahoo-finance2';
import type { BarData, GetRecentBarsOpts, Provider } from './types.js';

// One shared client. Suppress the library's survey notice and quiet its schema
// validation logging so the unattended loop's output stays clean.
const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
});

/** Look-back window wide enough to span a long weekend (markets-closed). */
const LOOKBACK_MS = 5 * 24 * 60 * 60_000;

/** Minimal shape we consume from chart()'s (unvalidated) result. */
interface ChartQuote {
  date?: Date | string | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
}

/**
 * yahoo-finance2 provider. Handles TSX (".TO") symbols and doubles as the
 * free, key-less fallback for US symbols when Alpaca is unconfigured.
 */
export const yahooProvider: Provider = {
  name: 'yahoo',

  async getRecentBars(symbol: string, opts: GetRecentBarsOpts = {}): Promise<BarData[]> {
    const limit = Math.max(1, opts.limit ?? 5);

    // Look back far enough to cross a weekend/holiday so we still return the
    // last session's most recent bars when markets are closed; we then slice to
    // the newest `limit`. (Phase-1 simplification — a tighter live-hours window
    // is a later optimization.)
    const period1 = new Date(Date.now() - LOOKBACK_MS);

    const result = await yf.chart(
      symbol,
      { period1, interval: '1m' },
      // Yahoo's response schema drifts; don't let strict validation throw.
      { validateResult: false },
    );

    const quotes = ((result as { quotes?: ChartQuote[] } | null)?.quotes ?? []) as ChartQuote[];
    const bars: BarData[] = [];
    for (const q of quotes) {
      // Yahoo emits null OHLCV for minutes with no trades — skip those.
      if (
        q.open == null ||
        q.high == null ||
        q.low == null ||
        q.close == null ||
        q.date == null
      ) {
        continue;
      }
      bars.push({
        timestamp: new Date(q.date).getTime(),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume ?? 0,
      });
    }

    // Newest first, capped to `limit`, to mirror the Alpaca provider.
    bars.sort((a, b) => b.timestamp - a.timestamp);
    return bars.slice(0, limit);
  },
};
