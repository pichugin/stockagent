import type { DB, SignalRow } from '../db.js';
import { convert, money } from '../fx/convert.js';
import type { FxService } from '../fx/FxService.js';
import type { Currency, PortfolioProvider } from '../portfolio/PortfolioProvider.js';
import { isMarketHours } from '../poll.js';
import { inferSymbolMeta } from '../symbols.js';

/**
 * One row of the live dashboard. Everything price/value-derived is "as of the
 * last cached close", never a live tick — the renderer must surface that.
 */
export interface DashboardRow {
  symbol: string;
  held: boolean;
  currency: Currency;
  /** Latest cached close in native currency, or null if nothing cached yet. */
  close: number | null;
  /** Epoch-ms of the latest cached bar, or null. */
  closeAsOf: number | null;
  // Held-only fields (null/undefined for watch-only rows).
  shares: number | null;
  /** Market value in CAD at last close (null if unpriced or FX unavailable). */
  marketValueCad: number | null;
  /** Unrealized P&L in CAD at last close (null if unpriced or FX unavailable). */
  unrealizedPnlCad: number | null;
  /** Active signals for this symbol, split by severity. */
  signals: { actionable: number; notable: number; info: number };
}

export interface DashboardSnapshot {
  generatedAt: string;
  marketOpen: boolean;
  /** Most recent bar fetch across all symbols (epoch-ms), or null. */
  lastPoll: number | null;
  fx: { rate: number; asOf: string; stale: boolean } | null;
  rows: DashboardRow[];
  /** Total CAD portfolio value at last close (sum of priced held rows). */
  totalCad: number | null;
  /** Whether any held row could not be priced/converted (totalCad is partial). */
  totalPartial: boolean;
  /** The most recent active actionable signals, newest first. */
  recentActionable: SignalRow[];
}

const sev = (s: string): 'actionable' | 'notable' | 'info' =>
  s === 'actionable' ? 'actionable' : s === 'notable' ? 'notable' : 'info';

/**
 * Build a point-in-time snapshot for the dashboard from cache only (no network):
 * latest cached bars, held positions, active signals, and the cached FX rate.
 * Read-only and side-effect-free, so a render never perturbs the monitor.
 */
export async function buildSnapshot(
  db: DB,
  portfolio: PortfolioProvider,
  fx: FxService,
  symbols: string[],
  now: string = new Date().toISOString(),
): Promise<DashboardSnapshot> {
  const fxView = fx.cached();
  const usdCad = fxView?.rate ?? null;

  const positions = await portfolio.list();
  const heldBySymbol = new Map(positions.map((p) => [p.symbol, p]));

  // Active signals grouped by symbol.
  const active = db.activeSignals();
  const sigBySymbol = new Map<string, { actionable: number; notable: number; info: number }>();
  for (const r of active) {
    const g = sigBySymbol.get(r.symbol) ?? { actionable: 0, notable: 0, info: 0 };
    g[sev(r.severity)] += 1;
    sigBySymbol.set(r.symbol, g);
  }

  // Union of requested symbols and held symbols, stable-sorted for a steady view.
  const all = new Set<string>(symbols);
  for (const p of positions) all.add(p.symbol);

  let lastPoll: number | null = null;
  for (const st of db.symbolStatuses()) {
    if (st.lastFetch != null) lastPoll = Math.max(lastPoll ?? 0, st.lastFetch);
  }

  let totalCad = 0;
  let totalPartial = false;
  const rows: DashboardRow[] = [];

  for (const symbol of [...all].sort()) {
    const bar = db.getRecentBars(symbol, 1)[0];
    const close = bar?.close ?? null;
    const closeAsOf = bar?.timestamp ?? null;

    const pos = heldBySymbol.get(symbol);
    const currency = (pos?.currency ??
      (db.getSymbol(symbol)?.currency as Currency | undefined) ??
      inferSymbolMeta(symbol).currency) as Currency;

    let marketValueCad: number | null = null;
    let unrealizedPnlCad: number | null = null;
    if (pos && close != null && usdCad != null) {
      const valNative = pos.shares * close;
      const pnlNative = pos.shares * (close - pos.avgCost);
      marketValueCad = convert(money(valNative, currency), 'CAD', usdCad).amount;
      unrealizedPnlCad = convert(money(pnlNative, currency), 'CAD', usdCad).amount;
      totalCad += marketValueCad;
    } else if (pos) {
      // Held but unpriceable (no cached close or no FX) → total is incomplete.
      totalPartial = true;
    }

    rows.push({
      symbol,
      held: pos != null,
      currency,
      close,
      closeAsOf,
      shares: pos?.shares ?? null,
      marketValueCad,
      unrealizedPnlCad,
      signals: sigBySymbol.get(symbol) ?? { actionable: 0, notable: 0, info: 0 },
    });
  }

  const recentActionable = active
    .filter((r) => r.severity === 'actionable')
    .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
    .slice(0, 5);

  return {
    generatedAt: now,
    marketOpen: isMarketHours(),
    lastPoll,
    fx: fxView ? { rate: fxView.rate, asOf: fxView.asOf, stale: fxView.stale } : null,
    rows,
    totalCad: positions.length > 0 ? totalCad : null,
    totalPartial,
    recentActionable,
  };
}
