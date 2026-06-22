import type { Currency } from '../portfolio/PortfolioProvider.js';
import type { Signal } from './types.js';

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A user-defined price alert for a symbol, in the symbol's **native** currency.
 * Either bound may be unset. Compared against the latest close directly — a
 * single-symbol level needs no FX.
 */
export interface AlertLevel {
  symbol: string;
  buyBelow: number | null;
  sellAbove: number | null;
}

/**
 * Pure threshold generator: fires when the latest close has crossed a
 * user-defined level. Purely descriptive ("close is at or below your level") —
 * the level is the user's stated intent, not a forecast by the tool.
 */
export function thresholdSignals(
  symbol: string,
  latestClose: number,
  alert: AlertLevel | null,
  currency: Currency,
  now: string,
): Signal[] {
  if (!alert) return [];
  const signals: Signal[] = [];

  if (alert.buyBelow != null && latestClose <= alert.buyBelow) {
    signals.push({
      symbol,
      kind: 'threshold',
      code: 'price_at_or_below_buy',
      severity: 'actionable',
      summary: `Latest close ${r2(latestClose)} ${currency} is at or below your buy-below level of ${r2(alert.buyBelow)} ${currency}`,
      data: { close: r2(latestClose), level: r2(alert.buyBelow), currency },
      firedAt: now,
    });
  }

  if (alert.sellAbove != null && latestClose >= alert.sellAbove) {
    signals.push({
      symbol,
      kind: 'threshold',
      code: 'price_at_or_above_sell',
      severity: 'actionable',
      summary: `Latest close ${r2(latestClose)} ${currency} is at or above your sell-above level of ${r2(alert.sellAbove)} ${currency}`,
      data: { close: r2(latestClose), level: r2(alert.sellAbove), currency },
      firedAt: now,
    });
  }

  return signals;
}
