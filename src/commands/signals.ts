import type { Command } from 'commander';
import { DB } from '../db.js';
import type { SignalRow } from '../db.js';
import { normalizeSymbol } from '../symbols.js';
import { renderTable } from '../table.js';

interface SignalsOptions {
  symbol?: string;
  active?: boolean;
  history?: boolean;
  limit: string;
}

function fmtTime(iso: string): string {
  // Trim to minute precision for a compact, readable column.
  return iso.replace('T', ' ').slice(0, 16);
}

export function registerSignals(program: Command): void {
  program
    .command('signals')
    .description('Query persisted signals (active by default, or --history).')
    .option('--symbol <symbol>', 'restrict to one symbol')
    .option('--active', 'show currently-active signals (default)', false)
    .option('--history', 'show recent signal history (active and cleared)', false)
    .option('--limit <n>', 'max rows for --history', '20')
    .action((opts: SignalsOptions) => {
      if (opts.active && opts.history) {
        throw new Error('pass only one of --active / --history');
      }
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error(`--limit must be a positive integer (got "${opts.limit}")`);
      }
      const symbol = opts.symbol ? normalizeSymbol(opts.symbol) : undefined;

      const db = new DB();
      try {
        if (opts.history) {
          const rows: SignalRow[] = db.signalHistory(limit, symbol);
          if (rows.length === 0) {
            console.log('No signal history yet — run "stockagent scan".');
            return;
          }
          const table = rows.map((r) => [
            r.symbol,
            r.severity,
            r.kind,
            r.code,
            fmtTime(r.firedAt),
            r.active ? 'active' : r.clearedAt ? fmtTime(r.clearedAt) : 'cleared',
          ]);
          console.log(
            renderTable(['Symbol', 'Severity', 'Kind', 'Code', 'Fired', 'Cleared/Active'], table),
          );
          console.log(`\n${rows.length} row(s).`);
          return;
        }

        // Default: active signals.
        const rows = db.activeSignals(symbol);
        if (rows.length === 0) {
          console.log('No active signals — run "stockagent scan".');
          return;
        }
        const table = rows.map((r) => [r.symbol, r.severity, r.kind, r.code, r.summary, fmtTime(r.firedAt)]);
        console.log(renderTable(['Symbol', 'Severity', 'Kind', 'Code', 'Summary', 'Since'], table));
        console.log(`\n${rows.length} active signal(s).`);
      } finally {
        db.close();
      }
    });
}
