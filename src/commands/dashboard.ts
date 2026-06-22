import type { Command } from 'commander';
import { runMonitor } from '../monitor.js';

interface DashboardOptions {
  force: boolean;
  once: boolean;
  limit: string;
  notify: boolean;
}

export function registerDashboard(program: Command): void {
  program
    .command('dashboard')
    .description('Live-updating CLI dashboard: poll, recompute signals, and redraw a table each cycle.')
    .option('--force', 'poll even when markets appear closed', false)
    .option('--once', 'render a single snapshot and exit', false)
    .option('--limit <n>', 'bars to fetch per symbol per cycle', '5')
    .option('--no-notify', 'do not push native notifications while the dashboard runs')
    .action(async (opts: DashboardOptions) => {
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error(`--limit must be a positive integer (got "${opts.limit}")`);
      }

      await runMonitor({
        force: opts.force,
        once: opts.once,
        limit,
        notify: opts.notify,
        dashboard: true,
      });
    });
}
