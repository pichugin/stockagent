/**
 * One-off live smoke test for the Alpaca bars path (untested since Phase 1).
 *
 *   npm run smoke:alpaca            # defaults to AAPL
 *   npm run smoke:alpaca -- MSFT    # any US symbol
 *
 * With ALPACA_KEY / ALPACA_SECRET in `.env` it fetches through Alpaca and
 * asserts the returned bars match the documented OHLCV shape. Without keys it
 * says so clearly and exercises the yahoo-finance2 fallback instead, so the
 * command is always informative.
 */
import 'dotenv/config';
import { alpacaProvider, hasAlpacaCredentials } from '../providers/alpaca.js';
import { yahooProvider } from '../providers/yahoo.js';
import type { BarData } from '../providers/types.js';

const symbol = (process.argv[2] ?? 'AAPL').toUpperCase();

function assertBarShape(bars: BarData[], providerName: string): void {
  if (bars.length === 0) {
    console.log(`⚠ ${providerName} returned 0 bars for ${symbol} (markets may be closed) — shape not verified.`);
    return;
  }
  const b = bars[0];
  const numericKeys: (keyof BarData)[] = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];
  const bad = numericKeys.filter((k) => typeof b[k] !== 'number' || Number.isNaN(b[k]));
  if (bad.length > 0) {
    throw new Error(`bar from ${providerName} has non-numeric field(s): ${bad.join(', ')} -> ${JSON.stringify(b)}`);
  }
  if (!(b.timestamp > 0)) throw new Error(`bar timestamp looks wrong: ${b.timestamp}`);
  console.log(`✓ ${providerName} bar shape OK. Newest of ${bars.length} bars for ${symbol}:`);
  console.log('   ', JSON.stringify(b));
}

async function main(): Promise<void> {
  if (hasAlpacaCredentials()) {
    console.log(`Alpaca credentials present — fetching ${symbol} via Alpaca (IEX feed)…`);
    const bars = await alpacaProvider.getRecentBars(symbol, { limit: 5 });
    assertBarShape(bars, 'alpaca');
  } else {
    console.log('ALPACA_KEY / ALPACA_SECRET absent — Alpaca path skipped; exercising yahoo-finance2 fallback instead.');
    console.log('   (Set the keys in .env and re-run to smoke-test the Alpaca path itself.)');
    const bars = await yahooProvider.getRecentBars(symbol, { limit: 5 });
    assertBarShape(bars, 'yahoo (fallback)');
  }
}

main().catch((err) => {
  console.error(`smoke:alpaca failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
