import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Watchlist config schema. A symbol carries the metadata the data layer needs
 * to route it to the correct provider and (later phases) normalize currency.
 */
const SymbolConfigSchema = z.object({
  symbol: z.string().trim().min(1, 'symbol must not be empty'),
  exchange: z.enum(['US', 'TSX']),
  currency: z.enum(['USD', 'CAD']),
});

/**
 * User preferences. Phase 3 introduces `cadBias` as a *parsed-and-validated
 * stub only*: a knob the later signal layer will read to tilt ranking toward
 * CAD exposure. Nothing in this phase acts on it. Range is [-1, 1] where 0 is
 * neutral, positive favours CAD, negative favours USD.
 */
const PreferencesSchema = z
  .object({
    cadBias: z
      .number({ invalid_type_error: 'preferences.cadBias must be a number' })
      .min(-1, 'preferences.cadBias must be >= -1')
      .max(1, 'preferences.cadBias must be <= 1')
      .default(0),
  })
  .default({ cadBias: 0 });

/**
 * Phase 4 signal-engine tuning. Every indicator period, threshold, and cutoff
 * lives here so sensitivity is adjustable without code changes. Each field has a
 * documented default, so an absent `signals:` block (or any absent sub-key)
 * yields the defaults below. These describe *what is currently true* — none of
 * them implies a prediction.
 */
const SignalsConfigSchema = z
  .object({
    // RSI(14): overbought above `overbought`, oversold below `oversold`.
    rsi: z
      .object({
        period: z.number().int().positive().default(14),
        overbought: z.number().min(0).max(100).default(70),
        oversold: z.number().min(0).max(100).default(30),
      })
      .default({}),
    // MACD: standard 12/26/9 EMA configuration; fires on signal-line crosses.
    macd: z
      .object({
        fastPeriod: z.number().int().positive().default(12),
        slowPeriod: z.number().int().positive().default(26),
        signalPeriod: z.number().int().positive().default(9),
      })
      .default({}),
    // Moving averages used for golden/death crosses and price-vs-MA position.
    movingAverages: z
      .object({
        shortPeriod: z.number().int().positive().default(50),
        longPeriod: z.number().int().positive().default(200),
      })
      .default({}),
    // Bollinger Bands(20, 2): fires when the latest close breaches a band.
    bollinger: z
      .object({
        period: z.number().int().positive().default(20),
        stdDev: z.number().positive().default(2),
      })
      .default({}),
    // Unrealized P&L gain/loss thresholds, as a percentage of cost basis.
    pnl: z
      .object({
        gainPct: z.number().positive().default(20),
        lossPct: z.number().positive().default(15),
      })
      .default({}),
    // A position is "overweight" past this % share of total portfolio value (CAD).
    concentration: z
      .object({
        overweightPct: z.number().positive().max(100).default(25),
      })
      .default({}),
    // Multi-timeframe range position: "near high"/"near low" band cutoffs (0–100).
    context: z
      .object({
        nearHighPct: z.number().min(0).max(100).default(90),
        nearLowPct: z.number().min(0).max(100).default(10),
      })
      .default({}),
    // Portfolio rollup: fire when at least this many held symbols are overbought.
    rollup: z
      .object({
        overboughtCount: z.number().int().positive().default(2),
      })
      .default({}),
  })
  .default({});

const WatchlistSchema = z.object({
  symbols: z.array(SymbolConfigSchema).min(1, 'watchlist must contain at least one symbol'),
  preferences: PreferencesSchema,
  signals: SignalsConfigSchema,
});

export type SymbolConfig = z.infer<typeof SymbolConfigSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type SignalsConfig = z.infer<typeof SignalsConfigSchema>;
export type Watchlist = z.infer<typeof WatchlistSchema>;

/** The fully-defaulted signal-engine config (handy for tests and tooling). */
export function defaultSignalsConfig(): SignalsConfig {
  return SignalsConfigSchema.parse(undefined);
}

export function watchlistPath(): string {
  return process.env.STOCKAGENT_WATCHLIST ?? 'watchlist.yaml';
}

/**
 * Load and validate the watchlist config. Fails loudly with an actionable
 * message on a missing file, malformed YAML, or a schema violation.
 */
export function loadWatchlist(path: string = watchlistPath()): Watchlist {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read watchlist config at "${path}": ${(err as Error).message}\n` +
        `Create one (see watchlist.yaml in the repo) or set STOCKAGENT_WATCHLIST.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Watchlist config at "${path}" is not valid YAML: ${(err as Error).message}`);
  }

  const result = WatchlistSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Watchlist config at "${path}" is invalid:\n${issues}`);
  }

  // Guard against duplicate symbols, which would make per-symbol state ambiguous.
  const seen = new Set<string>();
  for (const s of result.data.symbols) {
    if (seen.has(s.symbol)) {
      throw new Error(`Watchlist config at "${path}" lists "${s.symbol}" more than once.`);
    }
    seen.add(s.symbol);
  }

  return result.data;
}
