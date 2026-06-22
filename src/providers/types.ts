/** A single OHLCV bar as returned by a provider (provider-agnostic shape). */
export interface BarData {
  /** Bar open time, epoch milliseconds (UTC). */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface GetRecentBarsOpts {
  /** How many of the most recent 1-minute bars to return. */
  limit?: number;
}

/**
 * Common interface every data provider implements, so symbols can be routed
 * between providers (and new providers swapped in) without touching the loop.
 */
export interface Provider {
  readonly name: string;
  getRecentBars(symbol: string, opts?: GetRecentBarsOpts): Promise<BarData[]>;
}
