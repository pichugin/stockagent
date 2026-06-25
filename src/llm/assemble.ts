/**
 * Bridge from the deterministic engine to the narration layer. Runs the signal
 * engine over the requested symbols (reusing the exact Phase-4 computation —
 * the LLM only ever sees what the engine already found), then attaches
 * CAD-normalized position numbers so ranking and position-sizing have what they
 * need. No LLM here; this is all deterministic and synchronous-ish.
 */

import type { SignalsConfig } from '../config.js';
import type { DB } from '../db.js';
import type { FxService } from '../fx/FxService.js';
import type { Currency, PortfolioProvider } from '../portfolio/PortfolioProvider.js';
import { computeSignals } from '../signals/engine.js';
import { PORTFOLIO_SYMBOL } from '../signals/position.js';
import type { Signal } from '../signals/types.js';
import { inferSymbolMeta } from '../symbols.js';
import type { HeldNumbers } from './input.js';

export interface SymbolBundle {
  symbol: string;
  currency: Currency;
  signals: Signal[];
  /** Position numbers when held. */
  held?: HeldNumbers;
}

/** CAD value of a native amount, or null when a USD amount has no FX rate. */
function cadValue(native: number, currency: Currency, usdCad: number | null): number | null {
  if (currency === 'CAD') return native;
  if (usdCad == null || !(usdCad > 0)) return null;
  return native * usdCad;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Compute per-symbol narration bundles: the engine's current signals plus, for
 * held symbols, P&L %, CAD P&L, and concentration share. Concentration mirrors
 * the position generator — it needs a complete CAD total across all positions,
 * so if any position can't be priced in CAD, `sharePct` is left null.
 */
export async function gatherBundles(
  db: DB,
  portfolio: PortfolioProvider,
  fx: FxService,
  signalsCfg: SignalsConfig,
  symbols: string[],
  now: string,
): Promise<SymbolBundle[]> {
  const scan = await computeSignals(db, portfolio, fx, signalsCfg, symbols, now);

  const signalsBySymbol = new Map<string, Signal[]>();
  for (const s of scan.signals) {
    if (s.symbol === PORTFOLIO_SYMBOL) continue; // portfolio rollup isn't a tradeable symbol
    const arr = signalsBySymbol.get(s.symbol);
    if (arr) arr.push(s);
    else signalsBySymbol.set(s.symbol, [s]);
  }

  // Latest cached close per symbol (newest bar), for pricing positions.
  const latestClose = new Map<string, number>();
  for (const symbol of symbols) {
    const bars = db.getRecentBars(symbol, 1);
    if (bars.length > 0) latestClose.set(symbol, bars[0].close);
  }

  const usdCad = fx.cached()?.rate ?? null;
  const positions = await portfolio.list();

  // Concentration needs a complete CAD total across every priced position.
  const priced = positions
    .map((p) => ({ p, close: latestClose.get(p.symbol) }))
    .filter((x): x is { p: (typeof positions)[number]; close: number } => x.close != null);
  const cadVals = priced.map((x) => cadValue(x.p.shares * x.close, x.p.currency as Currency, usdCad));
  const totalComplete = cadVals.every((v) => v != null);
  const totalCad = cadVals.reduce((sum: number, v) => sum + (v ?? 0), 0);

  const heldBySymbol = new Map<string, HeldNumbers>();
  for (const { p, close } of priced) {
    const pnlPct = p.avgCost > 0 ? ((close - p.avgCost) / p.avgCost) * 100 : 0;
    const nativePnl = (close - p.avgCost) * p.shares;
    const cadPnl = cadValue(nativePnl, p.currency as Currency, usdCad);
    const positionCad = cadValue(p.shares * close, p.currency as Currency, usdCad);
    const sharePct =
      totalComplete && totalCad > 0 && positionCad != null ? (positionCad / totalCad) * 100 : null;
    heldBySymbol.set(p.symbol, {
      shares: p.shares,
      avgCost: p.avgCost,
      currency: p.currency,
      latestClose: close,
      pnlPct: r2(pnlPct),
      cadPnl: cadPnl == null ? null : r2(cadPnl),
      sharePct: sharePct == null ? null : r2(sharePct),
    });
  }

  // One bundle per requested symbol (even if it produced no signals).
  const bundles: SymbolBundle[] = [];
  for (const symbol of symbols) {
    const currency = (db.getSymbol(symbol)?.currency ?? inferSymbolMeta(symbol).currency) as Currency;
    bundles.push({
      symbol,
      currency,
      signals: signalsBySymbol.get(symbol) ?? [],
      held: heldBySymbol.get(symbol),
    });
  }
  return bundles;
}
