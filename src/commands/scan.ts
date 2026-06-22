import type { Command } from 'commander';
import { loadWatchlist } from '../config.js';
import { DB } from '../db.js';
import { FxService } from '../fx/FxService.js';
import { SqlitePortfolioProvider } from '../portfolio/SqlitePortfolioProvider.js';
import { computeSignals, persistSignals, type ReconcileResult } from '../signals/engine.js';
import type { ScanResult, Severity, Signal } from '../signals/types.js';
import { normalizeSymbol } from '../symbols.js';
import { renderTable } from '../table.js';
import { errMsg, log } from '../util.js';

interface ScanOptions {
  symbol?: string;
  once?: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = { actionable: 0, notable: 1, info: 2 };

/** Print fired signals grouped by symbol, severity-sorted, actionable starred. */
export function printScan(result: ScanResult, reconcile: ReconcileResult): void {
  const { signals, insufficient } = result;

  const bySymbol = new Map<string, Signal[]>();
  for (const s of signals) {
    const group = bySymbol.get(s.symbol);
    if (group) group.push(s);
    else bySymbol.set(s.symbol, [s]);
  }

  if (bySymbol.size === 0) {
    console.log('No signals fired.');
  }

  for (const symbol of [...bySymbol.keys()].sort()) {
    const group = bySymbol
      .get(symbol)!
      .slice()
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code),
      );
    console.log(`\n${symbol}`);
    const rows = group.map((s) => [
      s.severity === 'actionable' ? '★' : ' ',
      s.severity,
      s.kind,
      s.code,
      s.summary,
    ]);
    console.log(renderTable([' ', 'Severity', 'Kind', 'Code', 'Summary'], rows));
  }

  if (insufficient.length > 0) {
    console.log('\nInsufficient data:');
    for (const i of insufficient) console.log(`  ${i.symbol}: insufficient_data — ${i.reason}`);
  }

  const actionable = signals.filter((s) => s.severity === 'actionable').length;
  console.log(
    `\n${signals.length} signal(s) currently true (${actionable} actionable). ` +
      `Persisted: ${reconcile.fired} new, ${reconcile.kept} still active, ${reconcile.cleared} cleared.`,
  );
}

/**
 * Resolve which symbols to scan: a single `--symbol`, otherwise the de-duplicated
 * union of watchlist symbols and held positions (mirrors `start`). Symbol
 * metadata is upserted so routing/currency lookups resolve.
 */
async function resolveSymbols(
  db: DB,
  portfolio: SqlitePortfolioProvider,
  only: string | undefined,
): Promise<string[]> {
  const watchlist = loadWatchlist();
  for (const meta of watchlist.symbols) db.upsertSymbol(meta);

  if (only) return [normalizeSymbol(only)];

  const set = new Set<string>(watchlist.symbols.map((s) => s.symbol));
  for (const p of await portfolio.list()) set.add(p.symbol);
  return [...set];
}

export function registerScan(program: Command): void {
  program
    .command('scan')
    .description('Run the signal engine over cached data; print and persist fired signals.')
    .option('--symbol <symbol>', 'scan only this symbol')
    .option('--once', 'compute, print, persist, and exit (the default for a manual scan)', false)
    .action(async (opts: ScanOptions) => {
      const { signals: signalsCfg } = loadWatchlist();
      const db = new DB();
      const portfolio = new SqlitePortfolioProvider(db);
      const fx = new FxService(db);
      try {
        // Best-effort FX so CAD-normalized position numbers are available; the
        // engine itself only ever reads the cache, so a failure here is non-fatal.
        try {
          await fx.ensureRate();
        } catch (err) {
          log.warn(`FX unavailable (${errMsg(err)}); position CAD figures may be limited`);
        }

        const symbols = await resolveSymbols(db, portfolio, opts.symbol);
        const now = new Date().toISOString();
        const result = await computeSignals(db, portfolio, fx, signalsCfg, symbols, now);
        const reconcile = persistSignals(db, result.signals, now);
        printScan(result, reconcile);
      } finally {
        db.close();
      }
    });
}
