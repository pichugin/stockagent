import type { Command } from 'commander';
import cron from 'node-cron';
import { loadWatchlist } from '../config.js';
import type { SymbolConfig, Watchlist } from '../config.js';
import { DB } from '../db.js';
import { FxService } from '../fx/FxService.js';
import { isMarketHours, runPollCycle } from '../poll.js';
import { SqlitePortfolioProvider } from '../portfolio/SqlitePortfolioProvider.js';
import { computeSignals, persistSignals } from '../signals/engine.js';
import { inferSymbolMeta } from '../symbols.js';
import { errMsg, log } from '../util.js';

interface StartOptions {
  force: boolean;
  once: boolean;
  limit: string;
}

export function registerStart(program: Command): void {
  program
    .command('start')
    .description('Poll the watchlist every minute and store bars in SQLite.')
    .option('--force', 'poll even when markets appear closed', false)
    .option('--once', 'run a single poll cycle and exit', false)
    .option('--limit <n>', 'bars to fetch per symbol per cycle', '5')
    .action(async (opts: StartOptions) => {
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error(`--limit must be a positive integer (got "${opts.limit}")`);
      }

      const watchlist = loadWatchlist();
      const db = new DB();
      for (const meta of watchlist.symbols) db.upsertSymbol(meta);

      // Poll the union of watchlist symbols and held positions, so holdings get
      // bars even when they aren't in watchlist.yaml. Watchlist metadata wins on
      // conflict; held-only symbols infer their exchange from the suffix and keep
      // the position's currency.
      const portfolio = new SqlitePortfolioProvider(db);
      const bySymbol = new Map<string, SymbolConfig>();
      for (const meta of watchlist.symbols) bySymbol.set(meta.symbol, meta);
      for (const p of await portfolio.list()) {
        if (bySymbol.has(p.symbol)) continue;
        const meta: SymbolConfig = {
          symbol: p.symbol,
          exchange: inferSymbolMeta(p.symbol).exchange,
          currency: p.currency,
        };
        db.upsertSymbol(meta);
        bySymbol.set(p.symbol, meta);
      }
      const polled: Pick<Watchlist, 'symbols'> = { symbols: [...bySymbol.values()] };

      log.info(
        `watching ${polled.symbols.length} symbols: ` +
          polled.symbols.map((s) => s.symbol).join(', '),
      );

      // FX runs on a separate, daily cadence so a slow/failed FX fetch never
      // delays or blocks the per-minute bar polling. Refresh only when the
      // cached rate isn't already current.
      const fx = new FxService(db);
      const refreshFx = async () => {
        try {
          const cached = fx.cached();
          if (cached && !cached.stale) return;
          const view = await fx.refresh();
          log.info(`FX refreshed: 1 USD = ${view.rate.toFixed(4)} CAD (as of ${view.asOf})`);
        } catch (err) {
          log.warn(`FX refresh failed: ${errMsg(err)} (portfolio reads fall back to cache)`);
        }
      };
      // Kick off an initial refresh without awaiting it, so the first bar cycle
      // starts immediately regardless of FX latency. We keep the promise so the
      // one-shot path can await it before closing the DB.
      const initialFx = refreshFx();

      let running = false;
      const cycle = async () => {
        // Guard against overlap if a cycle ever runs longer than a minute.
        if (running) {
          log.warn('previous cycle still running; skipping this tick');
          return;
        }
        running = true;
        try {
          if (!opts.force && !isMarketHours()) {
            log.info('markets appear closed — skipping (use --force to override)');
            return;
          }
          await runPollCycle(db, polled, { limit });

          // Recompute signals after each poll. Isolated from the poll loop: a
          // failure here is logged and swallowed, never stopping the cadence
          // (same resilience contract as Phase 1's per-symbol isolation).
          try {
            const now = new Date().toISOString();
            const result = await computeSignals(
              db,
              portfolio,
              fx,
              watchlist.signals,
              polled.symbols.map((s) => s.symbol),
              now,
            );
            const rec = persistSignals(db, result.signals, now);
            log.info(
              `signals — ${rec.fired} new, ${rec.kept} active, ${rec.cleared} cleared` +
                (result.insufficient.length ? `, ${result.insufficient.length} insufficient_data` : ''),
            );
          } catch (err) {
            log.error(`signal computation failed (poll loop continues): ${errMsg(err)}`);
          }
        } catch (err) {
          // Belt-and-suspenders: runPollCycle isolates per-symbol errors, but
          // never let an unexpected throw kill the scheduler.
          log.error(`poll cycle threw: ${errMsg(err)}`);
        } finally {
          running = false;
        }
      };

      // Run one cycle immediately so the user sees activity without waiting.
      await cycle();

      if (opts.once) {
        // Let the in-flight FX refresh finish writing before we close the DB.
        await initialFx;
        db.close();
        return;
      }

      const task = cron.schedule('* * * * *', cycle);
      // Daily FX refresh at midnight; the refresh itself no-ops if already current.
      const fxTask = cron.schedule('0 0 * * *', refreshFx);
      log.info('scheduled per-minute polling + daily FX refresh — press Ctrl-C to stop');

      const shutdown = () => {
        log.info('shutting down…');
        task.stop();
        fxTask.stop();
        db.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
