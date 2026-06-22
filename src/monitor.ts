import cron from 'node-cron';
import { loadWatchlist } from './config.js';
import type { SymbolConfig, Watchlist } from './config.js';
import { buildSnapshot } from './dashboard/snapshot.js';
import { renderDashboard } from './dashboard/render.js';
import { DB } from './db.js';
import { FxService } from './fx/FxService.js';
import { isMarketHours, runPollCycle } from './poll.js';
import { Notifier } from './notify/Notifier.js';
import { SqlitePortfolioProvider } from './portfolio/SqlitePortfolioProvider.js';
import { computeSignals, persistSignals } from './signals/engine.js';
import { inferSymbolMeta } from './symbols.js';
import { errMsg, log } from './util.js';

export interface MonitorOptions {
  /** Poll even when markets appear closed. */
  force: boolean;
  /** Run a single cycle and exit. */
  once: boolean;
  /** Bars to fetch per symbol per cycle. */
  limit: number;
  /** Push native notifications for newly-actionable signals. */
  notify: boolean;
  /** Render the live CLI dashboard after each cycle. */
  dashboard: boolean;
}

/**
 * The shared monitoring engine behind both `start` and `dashboard`. It keeps the
 * three concerns cleanly separated so a fault in one is isolated:
 *   1. poll   — fetch bars (per-symbol isolated, Phase 1)
 *   2. signal — recompute + reconcile active/cleared state (Phase 4)
 *   3. notify/display — push actionable signals + redraw the dashboard (Phase 5)
 *
 * The engine is primary; notification and rendering are secondary and disposable
 * — a failure in either is logged and never stops the cadence.
 */
export async function runMonitor(opts: MonitorOptions): Promise<void> {
  const watchlist = loadWatchlist();
  const db = new DB();
  for (const meta of watchlist.symbols) db.upsertSymbol(meta);

  // Poll the union of watchlist symbols and held positions (mirrors the original
  // `start`): holdings get bars even when absent from watchlist.yaml.
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
  const symbolNames = polled.symbols.map((s) => s.symbol);

  log.info(`watching ${polled.symbols.length} symbols: ${symbolNames.join(', ')}`);

  // FX on a separate daily cadence so a slow/failed FX fetch never blocks polling.
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
  const initialFx = refreshFx();

  // Notification dispatcher (Phase 5). Only constructed when enabled, and the
  // config master switch can also disable it. Startup suppression runs once,
  // BEFORE the first cycle, so pre-existing active signals never replay.
  let notifier: Notifier | null = null;
  if (opts.notify && watchlist.notifications.enabled) {
    notifier = new Notifier(db, watchlist.notifications);
    notifier.seedSuppression(new Date().toISOString());
  } else if (opts.notify) {
    log.info('notifications disabled in config (notifications.enabled: false)');
  }

  // Dashboard rendering. Fancy ANSI redraw on a real TTY; plain periodic output
  // otherwise so piping to a file stays readable.
  const isTty = Boolean(process.stdout.isTTY);
  const render = async () => {
    if (!opts.dashboard) return;
    try {
      const snapshot = await buildSnapshot(db, portfolio, fx, symbolNames);
      const out = renderDashboard(snapshot, { color: isTty });
      if (isTty) {
        // Clear screen + home cursor, then draw. Transient cycle logs above are
        // wiped, leaving a clean live table.
        process.stdout.write('\x1b[2J\x1b[H');
      } else {
        process.stdout.write('\n');
      }
      process.stdout.write(`${out}\n`);
    } catch (err) {
      // The view is disposable: never let a render fault stop monitoring.
      log.error(`dashboard render failed (loop continues): ${errMsg(err)}`);
    }
  };

  let running = false;
  const cycle = async () => {
    if (running) {
      log.warn('previous cycle still running; skipping this tick');
      return;
    }
    running = true;
    try {
      if (!opts.force && !isMarketHours()) {
        log.info('markets appear closed — skipping (use --force to override)');
        await render();
        return;
      }
      await runPollCycle(db, polled, { limit: opts.limit });

      // Signal recompute + reconcile, isolated from the poll cadence.
      try {
        const now = new Date().toISOString();
        const result = await computeSignals(db, portfolio, fx, watchlist.signals, symbolNames, now);
        const rec = persistSignals(db, result.signals, now);
        log.info(
          `signals — ${rec.fired} new, ${rec.kept} active, ${rec.cleared} cleared` +
            (result.insufficient.length ? `, ${result.insufficient.length} insufficient_data` : ''),
        );

        // Notify on the active-edge of actionable signals, isolated in turn.
        if (notifier) {
          try {
            await notifier.dispatch(now, isMarketHours());
          } catch (err) {
            log.error(`notification dispatch failed (loop continues): ${errMsg(err)}`);
          }
        }
      } catch (err) {
        log.error(`signal computation failed (poll loop continues): ${errMsg(err)}`);
      }

      await render();
    } catch (err) {
      log.error(`poll cycle threw: ${errMsg(err)}`);
    } finally {
      running = false;
    }
  };

  await cycle();

  if (opts.once) {
    await initialFx;
    db.close();
    return;
  }

  const task = cron.schedule('* * * * *', cycle);
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
}
