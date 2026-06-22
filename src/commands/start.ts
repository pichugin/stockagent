import type { Command } from 'commander';
import cron from 'node-cron';
import { loadWatchlist } from '../config.js';
import { DB } from '../db.js';
import { isMarketHours, runPollCycle } from '../poll.js';
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

      log.info(
        `watching ${watchlist.symbols.length} symbols: ` +
          watchlist.symbols.map((s) => s.symbol).join(', '),
      );

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
          await runPollCycle(db, watchlist, { limit });
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
        db.close();
        return;
      }

      const task = cron.schedule('* * * * *', cycle);
      log.info('scheduled per-minute polling — press Ctrl-C to stop');

      const shutdown = () => {
        log.info('shutting down…');
        task.stop();
        db.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
