import type { Command } from 'commander';
import { DB } from '../db.js';
import { FxService } from '../fx/FxService.js';
import type { FxRateView } from '../fx/FxService.js';
import { WS_SPREAD_NOTE } from '../fx/notes.js';

interface FxOptions {
  refresh?: boolean;
}

function printRate(view: FxRateView): void {
  const inverse = 1 / view.rate;
  console.log(`USD → CAD : 1 USD = ${view.rate.toFixed(4)} CAD`);
  console.log(`CAD → USD : 1 CAD = ${inverse.toFixed(4)} USD`);
  console.log(`as of     : ${view.asOf}${view.stale ? '  ⚠ STALE' : ''}`);
  console.log(`source    : ${view.source}`);
  console.log(`fetched   : ${view.fetchedAt}`);
  if (view.stale) {
    console.log(
      '\n⚠ This rate is stale (not dated today, or the last refresh failed). ' +
        'Run "stockagent fx --refresh".',
    );
  }
  console.log(`\n${WS_SPREAD_NOTE}`);
}

export function registerFx(program: Command): void {
  program
    .command('fx')
    .description('Show the cached USD↔CAD rate (use --refresh to fetch a fresh one).')
    .option('--refresh', 'force a fresh fetch and update the cache', false)
    .action(async (opts: FxOptions) => {
      const db = new DB();
      const fx = new FxService(db);
      try {
        if (opts.refresh) {
          printRate(await fx.refresh());
          return;
        }
        const cached = fx.cached();
        if (cached) {
          printRate(cached);
          return;
        }
        // First run with an empty cache: fetch once so there's something to show.
        console.log('No FX rate cached yet — fetching one…\n');
        printRate(await fx.ensureRate());
      } finally {
        db.close();
      }
    });
}
