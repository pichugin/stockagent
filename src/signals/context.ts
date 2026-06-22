import type { SignalsConfig } from '../config.js';
import type { BarRow } from '../db.js';
import type { ScanResult, Signal } from './types.js';
import { changePct, maxDrawdownPct, rangePosition, volatilityPct } from './windows.js';

const r2 = (n: number): number => Math.round(n * 100) / 100;

type Source = 'minute' | 'daily';

interface WindowSpec {
  key: string; // appears in codes, e.g. "6mo" -> near_6mo_high
  label: string; // human label for summaries
  source: Source;
  durationMs: number;
  minBars: number; // below this we can't meaningfully describe the window
}

const DAY = 86_400_000;

/**
 * The 1-day window is described from intraday minute bars; the longer windows
 * use daily-resolution bars (resampled from the accumulated minute cache). Each
 * window is anchored to the most recent available bar (not wall-clock now), so
 * weekends/closures don't blank it out.
 */
const WINDOWS: WindowSpec[] = [
  { key: '1d', label: '1-day', source: 'minute', durationMs: 1 * DAY, minBars: 3 },
  { key: '1wk', label: '1-week', source: 'daily', durationMs: 7 * DAY, minBars: 3 },
  { key: '1mo', label: '1-month', source: 'daily', durationMs: 30 * DAY, minBars: 5 },
  { key: '6mo', label: '6-month', source: 'daily', durationMs: 182 * DAY, minBars: 10 },
];

/** Select the tail of `bars` (ascending) within `durationMs` of the last bar. */
function windowBars(bars: BarRow[], durationMs: number): BarRow[] {
  if (bars.length === 0) return [];
  const end = bars[bars.length - 1].timestamp;
  const start = end - durationMs;
  return bars.filter((b) => b.timestamp >= start);
}

/**
 * Pure multi-timeframe **context** generator. For each window it emits exactly
 * one `context` signal describing where the latest close sits within that
 * window's realized range, plus the window's trend (start→end % change),
 * realized volatility, and max drawdown.
 *
 * These are *factual context, never extrapolation*: every number describes the
 * window that already happened. Context signals are inputs to later reasoning,
 * not standalone triggers — hence mostly `info`/`notable` severity. Windows
 * without enough bars are skipped silently (context is supplementary; the
 * technical generator owns the overall `insufficient_data` diagnostic).
 *
 * `minuteBars` and `dailyBars` must both be ascending (oldest first).
 */
export function contextSignals(
  symbol: string,
  minuteBars: BarRow[],
  dailyBars: BarRow[],
  cfg: SignalsConfig,
  now: string,
): ScanResult {
  const signals: Signal[] = [];

  for (const spec of WINDOWS) {
    const source = spec.source === 'minute' ? minuteBars : dailyBars;
    const sel = windowBars(source, spec.durationMs);
    if (sel.length < spec.minBars) continue;

    const closes = sel.map((b) => b.close);
    const high = Math.max(...sel.map((b) => b.high));
    const low = Math.min(...sel.map((b) => b.low));
    const currentClose = closes[closes.length - 1];

    const pos = rangePosition(currentClose, low, high);
    const chg = changePct(closes[0], currentClose);
    const vol = volatilityPct(closes);
    const dd = maxDrawdownPct(closes);
    const trend = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';

    let band: 'high' | 'low' | 'mid';
    let code: string;
    let severity: Signal['severity'];
    if (pos >= cfg.context.nearHighPct) {
      band = 'high';
      code = `near_${spec.key}_high`;
      severity = 'notable';
    } else if (pos <= cfg.context.nearLowPct) {
      band = 'low';
      code = `near_${spec.key}_low`;
      severity = 'notable';
    } else {
      band = 'mid';
      code = `within_${spec.key}_range`;
      severity = 'info';
    }

    const where =
      band === 'high'
        ? `near the top`
        : band === 'low'
          ? `near the bottom`
          : `within`;
    const summary =
      `Latest close ${r2(currentClose)} sits at the ${r2(pos)}% mark (${where}) of its ` +
      `${spec.label} range [${r2(low)} – ${r2(high)}]; the window is ${trend} ${r2(chg)}%, ` +
      `realized volatility ${r2(vol)}%, max drawdown ${r2(dd)}%`;

    signals.push({
      symbol,
      kind: 'context',
      code,
      severity,
      summary,
      data: {
        window: spec.key,
        bars: sel.length,
        rangePosition: r2(pos),
        low: r2(low),
        high: r2(high),
        close: r2(currentClose),
        changePct: r2(chg),
        trend,
        volatilityPct: r2(vol),
        maxDrawdownPct: r2(dd),
      },
      firedAt: now,
    });
  }

  return { signals, insufficient: [] };
}
