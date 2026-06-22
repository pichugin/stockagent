import type { SymbolConfig } from '../config.js';
import { alpacaProvider, hasAlpacaCredentials } from './alpaca.js';
import { yahooProvider } from './yahoo.js';
import type { Provider } from './types.js';

export type { BarData, GetRecentBarsOpts, Provider } from './types.js';

/**
 * Route a symbol to its data provider based on exchange metadata:
 *   - TSX symbols always use yahoo-finance2 (Alpaca doesn't cover the TSX).
 *   - US symbols use Alpaca when credentials are present, otherwise fall back
 *     to yahoo-finance2 so the app runs out of the box.
 */
export function getProviderForSymbol(meta: SymbolConfig): Provider {
  if (meta.exchange === 'US' && hasAlpacaCredentials()) {
    return alpacaProvider;
  }
  return yahooProvider;
}
