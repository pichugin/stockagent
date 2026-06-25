import type { Command } from 'commander';
import chalk from 'chalk';
import { loadWatchlist } from '../config.js';
import { DB } from '../db.js';
import { FxService } from '../fx/FxService.js';
import { SqlitePortfolioProvider } from '../portfolio/SqlitePortfolioProvider.js';
import { yahooNewsProvider } from '../providers/news.js';
import { normalizeSymbol } from '../symbols.js';
import { errMsg, log } from '../util.js';
import {
  buildNarrationInput,
  classifyHeadlines,
  gatherBundles,
  narrate,
  rankSymbols,
  resolveLlmProvider,
  type HeadlineSentiment,
  type NarrateResult,
  type NarrationInput,
  type RankedItem,
} from '../llm/index.js';

interface ExplainOptions {
  top?: string;
  /** commander negatable flag: false when `--no-llm` is passed. */
  llm: boolean;
}

/**
 * Resolve which symbols to consider: a single named symbol, otherwise the
 * de-duplicated union of watchlist symbols and held positions (mirrors `scan`).
 */
async function resolveSymbols(
  db: DB,
  portfolio: SqlitePortfolioProvider,
  only: string | undefined,
): Promise<string[]> {
  const watchlist = loadWatchlist();
  for (const meta of watchlist.symbols) db.upsertSymbol(meta);
  if (only) return [normalizeSymbol(only)];
  const set = new Set<string>(watchlist.symbols.map((s) => s.symbol));
  for (const p of await portfolio.list()) set.add(p.symbol);
  return [...set];
}

/** A deterministic, framing-safe one-liner explaining why these were surfaced. */
function rankingNote(ranked: RankedItem[], selected: string[], cadBias: number): string {
  const top = ranked.filter((r) => selected.includes(r.symbol));
  const bias =
    cadBias === 0
      ? 'cadBias 0 (neutral)'
      : `cadBias ${cadBias > 0 ? '+' : ''}${cadBias} (${cadBias > 0 ? 'favouring CAD' : 'favouring USD'})`;
  return `Surfaced by attention score (actionable signals, concentration, context extremes), nudged by ${bias}: ${top
    .map((r) => `${r.symbol} ${r.score.toFixed(1)}`)
    .join(', ')}.`;
}

function printHeadlines(headlines: HeadlineSentiment[]): void {
  if (headlines.length === 0) return;
  console.log(chalk.bold('  Headlines (sentiment of headline text only):'));
  for (const h of headlines) {
    const color =
      h.sentiment === 'positive' ? chalk.green : h.sentiment === 'negative' ? chalk.red : chalk.gray;
    console.log(`    ${color(`[${h.sentiment}]`)} ${h.summary || h.text}`);
  }
}

function printNarration(input: NarrationInput, result: NarrateResult): void {
  const { narration, source, note } = result;
  const tag =
    source === 'llm'
      ? chalk.cyan('[AI]')
      : source === 'cache'
        ? chalk.cyan('[AI · cached]')
        : chalk.yellow('[deterministic]');

  console.log(`\n${chalk.bold.underline(input.symbol)} ${tag}`);
  if (note) console.log(chalk.yellow(`  ${note}`));

  console.log(chalk.bold('  Read:  ') + narration.read);
  console.log(chalk.green.bold('  Bull:  ') + narration.bull);
  console.log(chalk.red.bold('  Bear:  ') + narration.bear);
  console.log(
    chalk.bold('  Option: ') +
      narration.suggestedAction.option +
      (narration.suggestedAction.basisPct != null
        ? chalk.dim(` (basis: ${narration.suggestedAction.basisPct}%, computed by the engine)`)
        : ''),
  );
  printHeadlines(input.headlines);
  console.log(chalk.dim(`  ${narration.framingNote}`));
}

export function registerExplain(program: Command): void {
  program
    .command('explain [symbol]')
    .description('Narrate the top-ranked symbols (or one named symbol): plain read, bull AND bear, one suggested option. Mechanical signal, not advice.')
    .option('--top <n>', 'number of top-ranked symbols to narrate (default: llm.topN)')
    .option('--no-llm', 'run fully on the deterministic layer — no API calls')
    .action(async (symbolArg: string | undefined, opts: ExplainOptions) => {
      const watchlist = loadWatchlist();
      const { llm: llmCfg, signals: signalsCfg, preferences } = watchlist;
      const db = new DB();
      const portfolio = new SqlitePortfolioProvider(db);
      const fx = new FxService(db);

      try {
        // Best-effort FX so CAD-normalized position numbers are available.
        try {
          await fx.ensureRate();
        } catch (err) {
          log.warn(`FX unavailable (${errMsg(err)}); CAD position figures may be limited`);
        }

        const symbols = await resolveSymbols(db, portfolio, symbolArg);
        const now = new Date().toISOString();
        const bundles = await gatherBundles(db, portfolio, fx, signalsCfg, symbols, now);
        const bundleBySymbol = new Map(bundles.map((b) => [b.symbol, b]));

        const ranked = rankSymbols(
          bundles.map((b) => ({
            symbol: b.symbol,
            currency: b.currency,
            signals: b.signals,
            sharePct: b.held?.sharePct ?? null,
            pnlPct: b.held?.pnlPct ?? null,
          })),
          preferences.cadBias,
        );

        let selected: string[];
        if (symbolArg) {
          selected = [normalizeSymbol(symbolArg)];
        } else {
          const n = opts.top ? Math.max(1, Number.parseInt(opts.top, 10) || llmCfg.topN) : llmCfg.topN;
          selected = ranked.slice(0, n).map((r) => r.symbol);
        }

        const { provider, reason } = resolveLlmProvider(llmCfg, opts.llm === false);
        if (!provider) {
          log.info(`LLM off (${reason}) — presenting deterministic summaries`);
        }

        const onUsage = (
          kind: 'narration' | 'headline',
          model: string,
          inputTokens: number,
          outputTokens: number,
        ): void => {
          db.logLlmUsage({ ts: new Date().toISOString(), kind, model, inputTokens, outputTokens });
        };

        console.log(chalk.dim(rankingNote(ranked, selected, preferences.cadBias)));

        for (const symbol of selected) {
          const b = bundleBySymbol.get(symbol);
          if (!b) {
            console.log(`\n${chalk.bold(symbol)}: not tracked (no watchlist entry or position).`);
            continue;
          }

          let headlines: HeadlineSentiment[] = [];
          if (provider && llmCfg.headlines.enabled) {
            headlines = await classifyHeadlines(symbol, llmCfg.headlines.max, {
              db,
              news: yahooNewsProvider,
              llm: provider,
              onUsage,
            });
          }

          const input = buildNarrationInput({
            symbol,
            asOf: now,
            signals: b.signals,
            position: b.held,
            headlines,
            signalsCfg,
          });
          const result = await narrate(input, { db, llm: provider, onUsage });
          printNarration(input, result);
        }

        const totals = db.llmUsageTotals();
        if (totals.calls > 0) {
          console.log(
            chalk.dim(
              `\nLLM usage (cumulative): ${totals.calls} call(s), ` +
                `${totals.inputTokens} input + ${totals.outputTokens} output tokens.`,
            ),
          );
        }
        console.log(chalk.dim('\nEverything above is a mechanical signal, not advice. Your call.'));
      } finally {
        db.close();
      }
    });
}
