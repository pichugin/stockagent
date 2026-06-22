import type { DB, FxRateRow } from '../db.js';
import { log } from '../util.js';
import { yahooFxProvider } from './YahooFxProvider.js';
import type { FxProvider } from './types.js';

/** Today's date as an ISO calendar day (YYYY-MM-DD, UTC). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A cached rate as consumed by callers, with a `stale` flag made explicit.
 * `stale` is true when the rate's `asOf` date is before today **or** when a
 * requested refresh failed and we fell back to an older cached value — either
 * way the caller must surface it (silently-stale FX is how wrong numbers hide).
 */
export interface FxRateView {
  rate: number; // canonical USD→CAD (1 USD = rate CAD)
  asOf: string; // ISO date the rate is for
  source: string;
  fetchedAt: string;
  stale: boolean;
}

function viewOf(row: FxRateRow, stale: boolean): FxRateView {
  return { rate: row.rate, asOf: row.date, source: row.source, fetchedAt: row.fetchedAt, stale };
}

/**
 * Owns the FX cache lifecycle: read-from-cache by default, fetch-on-demand, and
 * honest staleness. Never blocks portfolio reads on a live call — reads come
 * from SQLite; refreshing is an explicit, separate step.
 */
export class FxService {
  constructor(
    private readonly db: DB,
    private readonly provider: FxProvider = yahooFxProvider,
  ) {}

  /** The latest cached rate (no network), or null if nothing is cached yet. */
  cached(): FxRateView | null {
    const row = this.db.latestFxRate();
    if (!row) return null;
    return viewOf(row, row.date < today());
  }

  /** Force a live fetch and upsert it into the cache. Throws on failure. */
  async refresh(): Promise<FxRateView> {
    const rate = await this.provider.getRate('USD', 'CAD');
    const row: FxRateRow = {
      date: rate.asOf,
      rate: rate.rate,
      source: rate.source,
      fetchedAt: rate.fetchedAt,
    };
    this.db.upsertFxRate(row);
    return viewOf(row, row.date < today());
  }

  /**
   * Return a usable rate for conversions. If today's rate is already cached,
   * use it. Otherwise try a refresh; on failure fall back to the most recent
   * cached rate, **flagged stale**. Throws only if there is no cache at all and
   * the fetch fails (we genuinely have no rate to offer).
   */
  async ensureRate(): Promise<FxRateView> {
    const cached = this.cached();
    if (cached && !cached.stale) return cached;

    try {
      return await this.refresh();
    } catch (err) {
      if (cached) {
        log.warn(`FX refresh failed (${(err as Error).message}); using stale cached rate from ${cached.asOf}`);
        return { ...cached, stale: true };
      }
      throw new Error(
        `No FX rate available and refresh failed: ${(err as Error).message}. ` +
          `Run "stockagent fx --refresh" once you have connectivity.`,
      );
    }
  }
}
