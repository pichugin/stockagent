import type { SymbolConfig } from './config.js';

/**
 * Canonical symbol form used everywhere: trimmed and upper-cased so `aapl` and
 * `AAPL` resolve to the same position/metadata row. The `.TO` suffix is
 * preserved (it just upper-cases to `.TO`).
 */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Single source of truth for symbol -> exchange/currency inference, shared by
 * the watchlist routing and the portfolio layer:
 *   - a Yahoo-style `.TO` suffix means a TSX listing, quoted in CAD;
 *   - anything else is treated as a US listing, quoted in USD.
 *
 * Exchange and currency are related but not identical concerns — currency can
 * still be overridden by the caller (e.g. an explicit `--cad`/`--usd` flag, or
 * an existing `symbols` row) while the exchange follows the suffix.
 */
export function inferSymbolMeta(rawSymbol: string): SymbolConfig {
  const symbol = normalizeSymbol(rawSymbol);
  if (symbol.endsWith('.TO')) {
    return { symbol, exchange: 'TSX', currency: 'CAD' };
  }
  return { symbol, exchange: 'US', currency: 'USD' };
}
