import type { Watchlist } from './config.js';
import { DB } from './db.js';
import { getProviderForSymbol } from './providers/index.js';
import { errMsg, log, withRetry } from './util.js';

/**
 * Simple, overridable market-hours check. US and TSX both trade on the
 * America/New_York clock, 09:30–16:00 ET, Mon–Fri. This intentionally ignores
 * exchange holidays — it's a coarse "are markets plausibly open" gate that the
 * caller can bypass with --force.
 */
export function isMarketHours(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  // `hour` can be "24" at midnight in some runtimes; normalize.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

export interface PollOpts {
  /** Bars to fetch per symbol per cycle. */
  limit?: number;
}

/**
 * Run one poll cycle over the whole watchlist. Each symbol is isolated: a
 * provider/network/rate-limit error is caught, logged, and never blocks the
 * other symbols or crashes the loop.
 */
export async function runPollCycle(
  db: DB,
  watchlist: Watchlist,
  opts: PollOpts = {},
): Promise<void> {
  const limit = opts.limit ?? 5;
  let fetched = 0;
  let written = 0;
  let errored = 0;

  for (const meta of watchlist.symbols) {
    const provider = getProviderForSymbol(meta);
    try {
      const bars = await withRetry(
        () => provider.getRecentBars(meta.symbol, { limit }),
        { label: `${meta.symbol} via ${provider.name}` },
      );

      if (bars.length === 0) {
        log.warn(`${meta.symbol}: no bars returned by ${provider.name}`);
        continue;
      }

      const n = db.upsertBars(bars.map((b) => ({ ...b, symbol: meta.symbol })));
      db.markFetched(meta.symbol, Date.now());
      fetched += 1;
      written += n;
    } catch (err) {
      errored += 1;
      log.error(`${meta.symbol}: fetch failed via ${provider.name}: ${errMsg(err)}`);
    }
  }

  log.info(
    `cycle complete — ${fetched}/${watchlist.symbols.length} symbols fetched, ` +
      `${written} bars upserted, ${errored} errored`,
  );
}
