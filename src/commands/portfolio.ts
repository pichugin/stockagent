import type { Command } from 'commander';
import { z } from 'zod';
import { DB } from '../db.js';
import type { Currency, Position } from '../portfolio/PortfolioProvider.js';
import { SqlitePortfolioProvider } from '../portfolio/SqlitePortfolioProvider.js';
import { inferSymbolMeta, normalizeSymbol } from '../symbols.js';
import { renderTable } from '../table.js';
import { log } from '../util.js';

const sharesSchema = z.coerce
  .number({ invalid_type_error: 'shares must be a number' })
  .positive('shares must be greater than 0');
const costSchema = z.coerce
  .number({ invalid_type_error: 'cost must be a number' })
  .nonnegative('cost must be 0 or greater');

/** Parse with a schema, throwing a flat, user-facing message on failure. */
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label}: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }
  return result.data;
}

/**
 * Resolve a position's currency: an explicit `--cad`/`--usd` flag wins; failing
 * that, an existing `symbols` metadata row; failing that, suffix inference
 * (`.TO` -> CAD, else USD). Inference is total, so this never fails.
 */
function resolveCurrency(
  db: DB,
  symbol: string,
  opts: { cad?: boolean; usd?: boolean },
): Currency {
  if (opts.cad && opts.usd) {
    throw new Error('specify only one of --cad / --usd, not both');
  }
  if (opts.cad) return 'CAD';
  if (opts.usd) return 'USD';

  const known = db.getSymbol(symbol);
  if (known) return known.currency as Currency;

  return inferSymbolMeta(symbol).currency;
}

function printPosition(p: Position): void {
  const rows = [
    [
      p.symbol,
      String(p.shares),
      p.avgCost.toFixed(2),
      p.currency,
      (p.shares * p.avgCost).toFixed(2),
      p.dateAdded,
      p.note ?? '',
    ],
  ];
  console.log(
    renderTable(
      ['Symbol', 'Shares', 'Avg Cost', 'Ccy', 'Cost Basis', 'Date Added', 'Note'],
      rows,
    ),
  );
}

interface AddOptions {
  cost: string;
  cad?: boolean;
  usd?: boolean;
  note?: string;
}

interface EditOptions {
  shares?: string;
  cost?: string;
  note?: string;
}

export function registerPortfolio(program: Command): void {
  program
    .command('add')
    .argument('<symbol>', 'symbol to hold, e.g. AAPL or SHOP.TO')
    .argument('<shares>', 'number of shares (fractional allowed)')
    .description('Record (or overwrite) a held position.')
    .requiredOption('--cost <avgCost>', 'average cost per share, in native currency')
    .option('--cad', 'force the position currency to CAD')
    .option('--usd', 'force the position currency to USD')
    .option('--note <text>', 'free-text note')
    .action(async (rawSymbol: string, rawShares: string, opts: AddOptions) => {
      const symbol = normalizeSymbol(rawSymbol);
      const shares = parse(sharesSchema, rawShares, 'invalid shares');
      const avgCost = parse(costSchema, opts.cost, 'invalid cost');

      const db = new DB();
      const portfolio = new SqlitePortfolioProvider(db);
      try {
        const currency = resolveCurrency(db, symbol, opts);

        if (await portfolio.get(symbol)) {
          log.warn(`${symbol} is already held — overwriting the existing position`);
        }

        // Ensure the symbols metadata row exists so polling/routing can find it.
        // Exchange follows the suffix; currency is the resolved one.
        const { exchange } = inferSymbolMeta(symbol);
        db.upsertSymbol({ symbol, exchange, currency });

        const position = await portfolio.upsert({ symbol, shares, avgCost, currency, note: opts.note });
        console.log(`Saved position for ${symbol}:\n`);
        printPosition(position);
      } finally {
        db.close();
      }
    });

  program
    .command('remove')
    .argument('<symbol>', 'symbol to remove from the portfolio')
    .description('Remove a held position.')
    .action(async (rawSymbol: string) => {
      const symbol = normalizeSymbol(rawSymbol);
      const db = new DB();
      const portfolio = new SqlitePortfolioProvider(db);
      try {
        const removed = await portfolio.remove(symbol);
        console.log(removed ? `Removed ${symbol}.` : `${symbol} was not held — nothing removed.`);
      } finally {
        db.close();
      }
    });

  program
    .command('edit')
    .argument('<symbol>', 'symbol to edit (must already be held)')
    .description('Partially update an existing position (only the fields you pass).')
    .option('--shares <n>', 'new share count')
    .option('--cost <x>', 'new average cost per share')
    .option('--note <text>', 'new note')
    .action(async (rawSymbol: string, opts: EditOptions) => {
      const symbol = normalizeSymbol(rawSymbol);
      const db = new DB();
      const portfolio = new SqlitePortfolioProvider(db);
      try {
        const existing = await portfolio.get(symbol);
        if (!existing) {
          throw new Error(`${symbol} is not held — use "add" to create it first.`);
        }
        if (opts.shares === undefined && opts.cost === undefined && opts.note === undefined) {
          throw new Error('nothing to edit — pass at least one of --shares / --cost / --note');
        }

        const shares =
          opts.shares !== undefined
            ? parse(sharesSchema, opts.shares, 'invalid shares')
            : existing.shares;
        const avgCost =
          opts.cost !== undefined ? parse(costSchema, opts.cost, 'invalid cost') : existing.avgCost;
        const note = opts.note !== undefined ? opts.note : existing.note;

        const position = await portfolio.upsert({
          symbol,
          shares,
          avgCost,
          currency: existing.currency,
          dateAdded: existing.dateAdded,
          note,
        });
        console.log(`Updated position for ${symbol}:\n`);
        printPosition(position);
      } finally {
        db.close();
      }
    });

  program
    .command('show')
    .description('List all held positions (native currency only — no FX in this phase).')
    .action(async () => {
      const db = new DB();
      const portfolio = new SqlitePortfolioProvider(db);
      try {
        const positions = await portfolio.list();
        if (positions.length === 0) {
          console.log('No positions yet — add one with: stockagent add <symbol> <shares> --cost <x>');
          return;
        }

        const rows = positions.map((p) => [
          p.symbol,
          String(p.shares),
          p.avgCost.toFixed(2),
          p.currency,
          (p.shares * p.avgCost).toFixed(2),
          p.dateAdded,
          p.note ?? '',
        ]);

        console.log(
          renderTable(
            ['Symbol', 'Shares', 'Avg Cost', 'Ccy', 'Cost Basis', 'Date Added', 'Note'],
            rows,
          ),
        );

        // Per-currency subtotals only — summing across currencies without FX
        // would be wrong (FX normalization is Phase 3).
        const subtotals = new Map<string, number>();
        for (const p of positions) {
          subtotals.set(p.currency, (subtotals.get(p.currency) ?? 0) + p.shares * p.avgCost);
        }
        console.log('\nCost basis by currency:');
        for (const [ccy, total] of [...subtotals].sort()) {
          console.log(`  ${ccy}: ${total.toFixed(2)}`);
        }
      } finally {
        db.close();
      }
    });
}
