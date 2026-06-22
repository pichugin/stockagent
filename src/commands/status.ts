import type { Command } from 'commander';
import { loadWatchlist } from '../config.js';
import { DB } from '../db.js';
import { isMarketHours } from '../poll.js';
import { renderTable } from '../table.js';

function formatLastFetch(ms: number | null): string {
  if (ms == null) return 'never';
  const ageSec = Math.round((Date.now() - ms) / 1000);
  const ageLabel = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
  return `${new Date(ms).toISOString()} (${ageLabel})`;
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show the watchlist, last fetch time per symbol, and total bars stored.')
    .action(() => {
      // Ensure every configured symbol shows up even before its first fetch.
      const watchlist = loadWatchlist();
      const db = new DB();
      try {
        for (const meta of watchlist.symbols) db.upsertSymbol(meta);

        const statuses = db.symbolStatuses();
        const rows = statuses.map((s) => [
          s.symbol,
          s.exchange,
          s.currency,
          String(s.barCount),
          formatLastFetch(s.lastFetch),
        ]);

        console.log(`Market hours right now: ${isMarketHours() ? 'OPEN' : 'closed'}\n`);
        console.log(
          renderTable(
            ['Symbol', 'Exchange', 'Currency', 'Bars', 'Last fetch'],
            rows,
          ),
        );
        console.log(`\nTotal bars stored: ${db.countBars()}`);
      } finally {
        db.close();
      }
    });
}
