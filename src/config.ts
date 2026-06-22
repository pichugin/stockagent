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

const WatchlistSchema = z.object({
  symbols: z.array(SymbolConfigSchema).min(1, 'watchlist must contain at least one symbol'),
});

export type SymbolConfig = z.infer<typeof SymbolConfigSchema>;
export type Watchlist = z.infer<typeof WatchlistSchema>;

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
