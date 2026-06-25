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

/**
 * Phase 5 notification discipline. These knobs govern *delivery*, not analysis —
 * only `actionable` signals ever push, and these settings keep that channel from
 * becoming noise. Defaults are deliberately conservative (an alerting tool you
 * can't trust to stay quiet is one you mute).
 */
const NotificationsConfigSchema = z
  .object({
    // Master switch for native macOS pushes. The dashboard/`signals` query are
    // unaffected — this only governs OS notifications.
    enabled: z.boolean().default(true),
    // Rate limit: at most `maxPerWindow` pushes per `windowMinutes`. A burst
    // beyond this coalesces into a single summary notification.
    maxPerWindow: z.number().int().positive().default(5),
    windowMinutes: z.number().int().positive().default(10),
    // When markets are closed, suppress non-threshold actionable pushes (they're
    // still visible in the dashboard / `signals` query). User-set price
    // thresholds are hard alerts and push regardless.
    quietHoursOutsideMarket: z.boolean().default(true),
  })
  .default({});

/**
 * Phase 6 LLM-narration layer. The LLM *explains and prioritizes* what the
 * deterministic engine already found — it never generates signals, predicts, or
 * decides. These knobs govern only that enhancement layer; with it fully off
 * (`enabled: false` or no API key) the tool runs entirely on the deterministic
 * engine. The provider/model are config, not hardcoded, so a backend swap is a
 * settings change. Secrets (the API key) live in `.env`, never here.
 */
const LlmConfigSchema = z
  .object({
    // Master switch for the narration layer. Default on, but it degrades
    // gracefully: with no API key for the chosen provider it behaves as if
    // disabled (deterministic summaries + an "AI explanation unavailable" note).
    enabled: z.boolean().default(true),
    // Which backend to call. Only `openai` is implemented today; the
    // `LlmProvider` interface keeps the rest of the layer backend-agnostic.
    provider: z.enum(['openai']).default('openai'),
    // Model id, passed through to the provider. Documented default below.
    model: z.string().min(1).default('gpt-4o'),
    // Sampling temperature — kept low so narration stays stable/cacheable.
    temperature: z.number().min(0).max(2).default(0.2),
    // Default number of top-ranked symbols `explain` narrates with no symbol arg.
    topN: z.number().int().positive().default(3),
    // Per-symbol headline sentiment (headline text only, never article bodies).
    headlines: z
      .object({
        enabled: z.boolean().default(true),
        max: z.number().int().positive().max(20).default(5),
      })
      .default({}),
  })
  .default({});

const WatchlistSchema = z.object({
  symbols: z.array(SymbolConfigSchema).min(1, 'watchlist must contain at least one symbol'),
  preferences: PreferencesSchema,
  signals: SignalsConfigSchema,
  notifications: NotificationsConfigSchema,
  llm: LlmConfigSchema,
});

export type SymbolConfig = z.infer<typeof SymbolConfigSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type SignalsConfig = z.infer<typeof SignalsConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type Watchlist = z.infer<typeof WatchlistSchema>;

/** The fully-defaulted LLM config (handy for tests and tooling). */
export function defaultLlmConfig(): LlmConfig {
  return LlmConfigSchema.parse(undefined);
}

/** The fully-defaulted notifications config (handy for tests and tooling). */
export function defaultNotificationsConfig(): NotificationsConfig {
  return NotificationsConfigSchema.parse(undefined);
}

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
