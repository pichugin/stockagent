import type { Currency } from '../portfolio/PortfolioProvider.js';

export type { Currency };

/**
 * A single FX observation. We only ever store the **canonical USD→CAD**
 * direction (1 USD = `rate` CAD); CAD→USD is derived as `1/rate` and the
 * identity pairs as `1`. Storing one direction and deriving the rest is
 * deliberate — caching both directions independently lets them drift.
 */
export interface FxRate {
  base: 'USD';
  quote: 'CAD';
  rate: number; // 1 USD = `rate` CAD
  asOf: string; // ISO date (YYYY-MM-DD) the rate is for
  source: string; // provider id, e.g. "yahoo"
  fetchedAt: string; // ISO timestamp we pulled it
}

/**
 * Pluggable FX source, mirroring the `PortfolioProvider` pattern so the rate
 * source isn't hardcoded. Implementations fetch the canonical USD→CAD rate and
 * return it as an {@link FxRate}; all four conversions are derived from that.
 */
export interface FxProvider {
  readonly name: string;
  /**
   * Fetch a live rate. The supported pair is USD↔CAD; whichever direction is
   * asked for, the returned {@link FxRate} is always the canonical USD→CAD
   * observation (callers derive the inverse via the conversion helpers).
   */
  getRate(base: Currency, quote: Currency): Promise<FxRate>;
}
