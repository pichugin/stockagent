import type { Command } from 'commander';
import { DB } from '../db.js';
import { renderTable } from '../table.js';

interface BarsOptions {
  limit: string;
}

export function registerBars(program: Command): void {
  program
    .command('bars')
    .argument('<symbol>', 'symbol to inspect, e.g. AAPL or SHOP.TO')
    .description('Print the most recent stored bars for a symbol.')
    .option('--limit <n>', 'number of bars to show', '10')
    .action((symbol: string, opts: BarsOptions) => {
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error(`--limit must be a positive integer (got "${opts.limit}")`);
      }

      const db = new DB();
      try {
        const bars = db.getRecentBars(symbol, limit);
        if (bars.length === 0) {
          console.log(`No bars stored for ${symbol}.`);
          return;
        }

        const rows = bars.map((b) => [
          new Date(b.timestamp).toISOString(),
          b.open.toFixed(2),
          b.high.toFixed(2),
          b.low.toFixed(2),
          b.close.toFixed(2),
          String(b.volume),
        ]);

        console.log(`Most recent ${bars.length} bar(s) for ${symbol}:\n`);
        console.log(
          renderTable(['Time (UTC)', 'Open', 'High', 'Low', 'Close', 'Volume'], rows),
        );
      } finally {
        db.close();
      }
    });
}
