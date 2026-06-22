import type { SignalsConfig } from '../config.js';
import type { Currency } from '../portfolio/PortfolioProvider.js';
import type { Signal } from './types.js';

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Portfolio-level rollups have no single symbol; we tag them with this id. */
export const PORTFOLIO_SYMBOL = 'PORTFOLIO';

/**
 * One held position priced at its latest cached close. `latestClose` is the most
 * recent cached close in the position's native currency — **not** a live tick;
 * this is the first place cost basis meets a (near-)current price.
 */
export interface HeldQuote {
  symbol: string;
  shares: number;
  avgCost: number;
  currency: Currency;
  latestClose: number;
}

/** CAD value of a native amount, or null when a USD amount has no FX rate. */
function cadValue(native: number, currency: Currency, usdCad: number | null): number | null {
  if (currency === 'CAD') return native;
  if (usdCad == null || !(usdCad > 0)) return null;
  return native * usdCad; // USD → CAD
}

/**
 * Pure position-aware generator. Produces unrealized-P&L, concentration, and a
 * portfolio rollup signal — all describing the present (latest cached close vs
 * cost basis, current share of portfolio). Nothing here predicts.
 *
 * Degrades gracefully: an empty `held` list yields no signals; if the FX rate is
 * unavailable, dollar P&L is reported as native-only and concentration (which
 * needs cross-currency CAD totals) is skipped rather than guessed.
 *
 * `overboughtSymbols` are the held symbols flagged RSI-overbought this scan,
 * used only for the `multiple_holdings_overbought` rollup.
 */
export function positionSignals(
  held: HeldQuote[],
  usdCad: number | null,
  cfg: SignalsConfig,
  now: string,
  overboughtSymbols: Set<string>,
): Signal[] {
  const signals: Signal[] = [];
  if (held.length === 0) return signals;

  // --- Unrealized P&L (per position) ---
  for (const p of held) {
    const pnlPct = p.avgCost > 0 ? ((p.latestClose - p.avgCost) / p.avgCost) * 100 : 0;
    const nativePnl = (p.latestClose - p.avgCost) * p.shares;
    const cadPnl = cadValue(nativePnl, p.currency, usdCad);
    const data: Signal['data'] = {
      close: r2(p.latestClose),
      avgCost: r2(p.avgCost),
      pnlPct: r2(pnlPct),
      nativePnl: r2(nativePnl),
      currency: p.currency,
      cadPnl: cadPnl == null ? 'n/a' : r2(cadPnl),
    };
    const cadStr = cadPnl == null ? '' : ` (${cadPnl >= 0 ? '+' : ''}${r2(cadPnl)} CAD)`;

    if (pnlPct >= cfg.pnl.gainPct) {
      signals.push({
        symbol: p.symbol,
        kind: 'position',
        code: 'large_unrealized_gain',
        severity: 'notable',
        summary: `${p.symbol} is up ${r2(pnlPct)}% on cost at the latest close${cadStr}`,
        data,
        firedAt: now,
      });
    } else if (pnlPct <= -cfg.pnl.lossPct) {
      signals.push({
        symbol: p.symbol,
        kind: 'position',
        code: 'large_unrealized_loss',
        severity: 'notable',
        summary: `${p.symbol} is down ${r2(Math.abs(pnlPct))}% on cost at the latest close${cadStr}`,
        data,
        firedAt: now,
      });
    }
  }

  // --- Concentration (needs a complete CAD total across all positions) ---
  const cadValues = held.map((p) => ({
    symbol: p.symbol,
    cad: cadValue(p.shares * p.latestClose, p.currency, usdCad),
  }));
  const totalCad = cadValues.reduce((sum, v) => sum + (v.cad ?? 0), 0);
  const complete = cadValues.every((v) => v.cad != null) && totalCad > 0;
  if (complete) {
    for (const v of cadValues) {
      const share = ((v.cad as number) / totalCad) * 100;
      if (share > cfg.concentration.overweightPct) {
        signals.push({
          symbol: v.symbol,
          kind: 'position',
          code: 'position_overweight',
          severity: 'notable',
          summary: `${v.symbol} is ${r2(share)}% of the portfolio's value (CAD), above the ${cfg.concentration.overweightPct}% concentration line`,
          data: {
            sharePct: r2(share),
            positionCad: r2(v.cad as number),
            totalCad: r2(totalCad),
            overweightPct: cfg.concentration.overweightPct,
          },
          firedAt: now,
        });
      }
    }
  }

  // --- Portfolio rollup: multiple held symbols overbought at once ---
  const overboughtHeld = held.map((p) => p.symbol).filter((s) => overboughtSymbols.has(s));
  if (overboughtHeld.length >= cfg.rollup.overboughtCount) {
    signals.push({
      symbol: PORTFOLIO_SYMBOL,
      kind: 'position',
      code: 'multiple_holdings_overbought',
      severity: 'notable',
      summary: `${overboughtHeld.length} held symbols are RSI-overbought at once: ${overboughtHeld.join(', ')}`,
      data: { count: overboughtHeld.length, symbols: overboughtHeld.join(',') },
      firedAt: now,
    });
  }

  return signals;
}
