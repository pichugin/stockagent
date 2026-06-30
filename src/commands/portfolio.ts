import type { Command } from 'commander';
import { z } from 'zod';
import { DB } from '../db.js';
import { decomposeCostBasisFx } from '../fx/convert.js';
import { FxService } from '../fx/FxService.js';
import type { FxRateView } from '../fx/FxService.js';
import { WS_SPREAD_NOTE } from '../fx/notes.js';
import type { Currency, Position } from '../portfolio/PortfolioProvider.js';
import { SqlitePortfolioProvider } from '../portfolio/SqlitePortfolioProvider.js';
import { inferSymbolMeta, normalizeSymbol } from '../symbols.js';
import { renderTable } from '../table.js';
import { errMsg, log } from '../util.js';

const sharesSchema = z.coerce
  .number({ invalid_type_error: 'shares must be a number' })
  .positive('shares must be greater than 0');
const costSchema = z.coerce
  .number({ invalid_type_error: 'cost must be a number' })
  .nonnegative('cost must be 0 or greater');
const fxRateSchema = z.coerce
  .number({ invalid_type_error: 'FX rate must be a number' })
  .positive('FX rate must be greater than 0');

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

/**
 * The canonical USD→CAD rate to lock in as a position's cost-basis FX snapshot.
 * CAD positions return 1 (no FX exposure, no network needed). USD positions
 * use the current cached/live rate; if FX is entirely unavailable we return
 * null so the position records "FX split unavailable" rather than a guess.
 */
async function snapshotFxAtCost(db: DB, currency: Currency): Promise<number | null> {
  if (currency === 'CAD') return 1;
  try {
    const view = await new FxService(db).ensureRate();
    if (view.stale) {
      log.warn(`snapshotting cost-basis FX from a stale rate (as of ${view.asOf})`);
    }
    return view.rate;
  } catch (err) {
    log.warn(`could not snapshot cost-basis FX (${errMsg(err)}); FX split will be unavailable for this position`);
    return null;
  }
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
  fxAtCost?: string;
}

interface EditOptions {
  shares?: string;
  cost?: string;
  note?: string;
  fxAtCost?: string;
}

/**
 * Resolve the cost-basis FX snapshot for a position. An explicit `--fx-at-cost`
 * (the USD→CAD rate at purchase) wins and needs no network; it's rejected for
 * CAD positions, which have no FX exposure. With no flag, USD positions fall
 * back to the auto-snapshot of the current rate.
 */
async function resolveFxAtCost(
  db: DB,
  currency: Currency,
  rawFxAtCost: string | undefined,
): Promise<number | null> {
  if (rawFxAtCost !== undefined) {
    if (currency === 'CAD') {
      throw new Error('CAD positions have no FX exposure (rate is always 1) — drop --fx-at-cost');
    }
    return parse(fxRateSchema, rawFxAtCost, 'invalid FX rate');
  }
  return snapshotFxAtCost(db, currency);
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
    .option(
      '--fx-at-cost <rate>',
      'USD→CAD rate at purchase (1 USD = <rate> CAD); overrides the auto-snapshot. USD positions only',
    )
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

        // Lock in the USD→CAD rate at cost basis so the FX split is exact later.
        // An explicit --fx-at-cost (the rate at purchase) wins; otherwise we
        // auto-snapshot the current rate. CAD positions have no FX exposure
        // (snapshot 1); a USD position with no rate available stores null and
        // reports its split as unavailable rather than guessing.
        const fxAtCost = await resolveFxAtCost(db, currency, opts.fxAtCost);

        const position = await portfolio.upsert({ symbol, shares, avgCost, currency, note: opts.note, fxAtCost });
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
    .option(
      '--fx-at-cost <rate>',
      'USD→CAD rate at purchase (1 USD = <rate> CAD). USD positions only',
    )
    .action(async (rawSymbol: string, opts: EditOptions) => {
      const symbol = normalizeSymbol(rawSymbol);
      const db = new DB();
      const portfolio = new SqlitePortfolioProvider(db);
      try {
        const existing = await portfolio.get(symbol);
        if (!existing) {
          throw new Error(`${symbol} is not held — use "add" to create it first.`);
        }
        if (
          opts.shares === undefined &&
          opts.cost === undefined &&
          opts.note === undefined &&
          opts.fxAtCost === undefined
        ) {
          throw new Error(
            'nothing to edit — pass at least one of --shares / --cost / --note / --fx-at-cost',
          );
        }

        const shares =
          opts.shares !== undefined
            ? parse(sharesSchema, opts.shares, 'invalid shares')
            : existing.shares;
        const avgCost =
          opts.cost !== undefined ? parse(costSchema, opts.cost, 'invalid cost') : existing.avgCost;
        const note = opts.note !== undefined ? opts.note : existing.note;
        // Only touch the FX snapshot when --fx-at-cost is passed; otherwise omit
        // it so the provider preserves the existing snapshot. Rejected for CAD.
        const fxAtCost =
          opts.fxAtCost !== undefined
            ? await resolveFxAtCost(db, existing.currency, opts.fxAtCost)
            : undefined;

        const position = await portfolio.upsert({
          symbol,
          shares,
          avgCost,
          currency: existing.currency,
          dateAdded: existing.dateAdded,
          note,
          ...(fxAtCost !== undefined ? { fxAtCost } : {}),
        });
        console.log(`Updated position for ${symbol}:\n`);
        printPosition(position);
      } finally {
        db.close();
      }
    });

  program
    .command('show')
    .description('List held positions with native cost basis and CAD-normalized cost basis.')
    .action(async () => {
      const db = new DB();
      const portfolio = new SqlitePortfolioProvider(db);
      try {
        const positions = await portfolio.list();
        if (positions.length === 0) {
          console.log('No positions yet — add one with: stockagent add <symbol> <shares> --cost <x>');
          return;
        }

        // Native-currency view (unchanged from Phase 2).
        const nativeRows = positions.map((p) => [
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
            nativeRows,
          ),
        );

        // Per-currency native subtotals (kept — no FX assumptions).
        const subtotals = new Map<string, number>();
        for (const p of positions) {
          subtotals.set(p.currency, (subtotals.get(p.currency) ?? 0) + p.shares * p.avgCost);
        }
        console.log('\nCost basis by currency (native):');
        for (const [ccy, total] of [...subtotals].sort()) {
          console.log(`  ${ccy}: ${total.toFixed(2)}`);
        }

        // CAD-normalized cost basis. Read FX from cache (refresh-if-needed);
        // never let an FX outage block listing positions.
        let fx: FxRateView;
        try {
          fx = await new FxService(db).ensureRate();
        } catch (err) {
          console.log(`\nCAD-normalized view unavailable: ${errMsg(err)}`);
          return;
        }

        const cadRows: string[][] = [];
        let cadGrandTotal = 0;
        for (const p of positions) {
          // CAD positions have no FX exposure; treat their snapshot as 1.
          const fxNow = p.currency === 'USD' ? fx.rate : 1;
          const f0 = p.currency === 'CAD' ? 1 : p.fxAtCost;

          if (f0 == null) {
            // Legacy USD row without a cost-basis snapshot: convert at current
            // rate but report the underlying-vs-FX split as unavailable.
            const d = decomposeCostBasisFx(p.shares, p.avgCost, fxNow, fxNow);
            cadGrandTotal += d.cadAtCurrent;
            cadRows.push([
              p.symbol,
              p.currency,
              d.native.toFixed(2),
              '?',
              fxNow.toFixed(4),
              d.cadAtCurrent.toFixed(2),
              'n/a',
            ]);
            continue;
          }

          const d = decomposeCostBasisFx(p.shares, p.avgCost, f0, fxNow);
          cadGrandTotal += d.cadAtCurrent;
          cadRows.push([
            p.symbol,
            p.currency,
            d.native.toFixed(2),
            f0.toFixed(4),
            fxNow.toFixed(4),
            d.cadAtCurrent.toFixed(2),
            d.fxComponent.toFixed(2),
          ]);
        }

        console.log(`\nCost basis in CAD (at FX rate as of ${fx.asOf}${fx.stale ? ', ⚠ STALE' : ''}):`);
        console.log(
          renderTable(
            ['Symbol', 'Ccy', 'Native', 'FX@cost', 'FX@now', 'CAD @now', 'FX Δ (CAD)'],
            cadRows,
          ),
        );
        console.log(`\nCAD grand total (cost basis, at rate as of ${fx.asOf}): ${cadGrandTotal.toFixed(2)} CAD`);
        console.log(
          '  "FX Δ (CAD)" = how much the CAD value of the cost basis has moved purely from USD/CAD\n' +
            '  shifting since purchase (approximate; underlying-move split arrives with live prices). ' +
            '"n/a" = no cost-basis FX snapshot.',
        );
        console.log(`\n${WS_SPREAD_NOTE}`);
      } finally {
        db.close();
      }
    });
}
