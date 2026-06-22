import type { Command } from 'commander';
import { z } from 'zod';
import { DB } from '../db.js';
import { normalizeSymbol } from '../symbols.js';
import { renderTable } from '../table.js';
import { log } from '../util.js';

const priceSchema = z.coerce
  .number({ invalid_type_error: 'price must be a number' })
  .positive('price must be greater than 0');

function parsePrice(value: string, label: string): number {
  const result = priceSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label}: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

interface SetOptions {
  buyBelow?: string;
  sellAbove?: string;
}

/**
 * `alert` manages per-symbol price levels (in the symbol's native currency) that
 * the signal engine fires on. These are the user's own buy/sell levels — stated
 * intent, not a forecast by the tool.
 */
export function registerAlert(program: Command): void {
  const alert = program
    .command('alert')
    .description('Manage per-symbol buy-below / sell-above price alerts.');

  alert
    .command('set')
    .argument('<symbol>', 'symbol to set an alert for, e.g. AAPL or SHOP.TO')
    .description('Set a buy-below and/or sell-above level (native currency). Merges with any existing.')
    .option('--buy-below <price>', 'fire when the latest close is at or below this price')
    .option('--sell-above <price>', 'fire when the latest close is at or above this price')
    .action((rawSymbol: string, opts: SetOptions) => {
      const symbol = normalizeSymbol(rawSymbol);
      if (opts.buyBelow === undefined && opts.sellAbove === undefined) {
        throw new Error('nothing to set — pass at least one of --buy-below / --sell-above');
      }

      const db = new DB();
      try {
        const existing = db.getAlert(symbol);
        const buyBelow =
          opts.buyBelow !== undefined
            ? parsePrice(opts.buyBelow, 'invalid --buy-below')
            : (existing?.buyBelow ?? null);
        const sellAbove =
          opts.sellAbove !== undefined
            ? parsePrice(opts.sellAbove, 'invalid --sell-above')
            : (existing?.sellAbove ?? null);

        if (buyBelow != null && sellAbove != null && buyBelow >= sellAbove) {
          log.warn(
            `buy-below (${buyBelow}) is not below sell-above (${sellAbove}); both will fire constantly`,
          );
        }

        db.upsertAlert({ symbol, buyBelow, sellAbove });
        console.log(
          `Alert for ${symbol}: buy-below = ${buyBelow ?? '—'}, sell-above = ${sellAbove ?? '—'}`,
        );
      } finally {
        db.close();
      }
    });

  alert
    .command('clear')
    .argument('<symbol>', 'symbol to clear the alert for')
    .description('Remove a symbol\'s price alert.')
    .action((rawSymbol: string) => {
      const symbol = normalizeSymbol(rawSymbol);
      const db = new DB();
      try {
        const removed = db.deleteAlert(symbol);
        console.log(removed ? `Cleared alert for ${symbol}.` : `No alert set for ${symbol}.`);
      } finally {
        db.close();
      }
    });

  alert
    .command('list')
    .description('List all configured price alerts.')
    .action(() => {
      const db = new DB();
      try {
        const alerts = db.listAlerts();
        if (alerts.length === 0) {
          console.log('No alerts set — add one with: stockagent alert set <symbol> --sell-above <price>');
          return;
        }
        const rows = alerts.map((a) => [
          a.symbol,
          a.buyBelow != null ? a.buyBelow.toFixed(2) : '—',
          a.sellAbove != null ? a.sellAbove.toFixed(2) : '—',
        ]);
        console.log(renderTable(['Symbol', 'Buy below', 'Sell above'], rows));
      } finally {
        db.close();
      }
    });
}
