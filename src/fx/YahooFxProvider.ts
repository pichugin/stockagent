import YahooFinance from 'yahoo-finance2';
import type { Currency, FxProvider, FxRate } from './types.js';

// One shared client, configured like the bars provider: no survey notice, quiet
// schema-validation logging.
const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
});

// Yahoo's FX symbol for USD→CAD: `CAD=X` quotes how many CAD per 1 USD.
const USD_CAD_SYMBOL = 'CAD=X';

// Sanity band for a USD→CAD rate. The classic FX bug is a flipped rate, which
// would land near ~0.7 (CAD→USD); anything outside this band is either inverted
// or absurd, so we fail loudly rather than cache a wrong number.
const MIN_SANE_RATE = 1.0;
const MAX_SANE_RATE = 2.0;

interface QuoteShape {
  regularMarketPrice?: number | null;
  regularMarketTime?: Date | number | string | null;
}

/** ISO calendar date (YYYY-MM-DD, UTC) for a Yahoo market time, or today. */
function toIsoDate(time: Date | number | string | null | undefined): string {
  const d = time != null ? new Date(time) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * FX provider backed by `yahoo-finance2` (the package we already depend on for
 * bars), so no new API keys. Fetches the canonical USD→CAD rate and validates
 * its order of magnitude before returning.
 *
 * Set `STOCKAGENT_FX_FORCE_FAIL=1` to make every fetch throw — used to exercise
 * the stale-rate fallback path (see README).
 */
export const yahooFxProvider: FxProvider = {
  name: 'yahoo',

  async getRate(base: Currency, quote: Currency): Promise<FxRate> {
    if (process.env.STOCKAGENT_FX_FORCE_FAIL === '1') {
      throw new Error('FX fetch forced to fail (STOCKAGENT_FX_FORCE_FAIL=1)');
    }
    // We only support USD↔CAD and always store the canonical USD→CAD direction.
    if (!isUsdCad(base, quote)) {
      throw new Error(`yahooFxProvider only supports USD↔CAD (got ${base}->${quote})`);
    }

    const q = (await yf.quote(USD_CAD_SYMBOL, {}, { validateResult: false })) as QuoteShape | null;
    const rate = q?.regularMarketPrice;
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      throw new Error(`Yahoo returned no usable price for ${USD_CAD_SYMBOL}`);
    }
    if (!(rate >= MIN_SANE_RATE && rate <= MAX_SANE_RATE)) {
      throw new Error(
        `USD→CAD rate ${rate} is outside the sane band [${MIN_SANE_RATE}, ${MAX_SANE_RATE}] — ` +
          `likely inverted or a bad quote; refusing to cache it.`,
      );
    }

    return {
      base: 'USD',
      quote: 'CAD',
      rate,
      asOf: toIsoDate(q?.regularMarketTime),
      source: this.name,
      fetchedAt: new Date().toISOString(),
    };
  },
};

function isUsdCad(base: Currency, quote: Currency): boolean {
  return (
    (base === 'USD' && quote === 'CAD') ||
    (base === 'CAD' && quote === 'USD') ||
    base === quote
  );
}
