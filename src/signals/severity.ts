import type { Signal } from './types.js';

/**
 * Combination step that *raises* selected signals to `actionable` when several
 * conditions co-occur for the same symbol — the heads-ups a manual trader would
 * actually want surfaced. It only ever raises severity, never lowers it.
 *
 * The actionable set is deliberately conservative and documented here:
 *   1. Threshold hits (`price_at_or_*`) are actionable on their own (set by the
 *      threshold generator) — a level the user themselves chose was crossed.
 *   2. A **held** symbol that is RSI-oversold *and* near a window low: the dip
 *      is corroborated by where price sits in its range.
 *   3. A **held** symbol that is RSI-overbought *and* overweight: a stretched
 *      indicator on an outsized position.
 *
 * Everything else stays at the base `notable`/`info` its generator assigned.
 * `heldSymbols` are the symbols currently in the portfolio.
 */
export function applySeverityCombinations(signals: Signal[], heldSymbols: Set<string>): Signal[] {
  const bySymbol = new Map<string, Signal[]>();
  for (const s of signals) {
    const group = bySymbol.get(s.symbol);
    if (group) group.push(s);
    else bySymbol.set(s.symbol, [s]);
  }

  for (const [symbol, group] of bySymbol) {
    const held = heldSymbols.has(symbol);
    if (!held) continue;

    const codes = new Set(group.map((s) => s.code));
    const nearLow = [...codes].some((c) => c.startsWith('near_') && c.endsWith('_low'));
    const upgrade = (code: string): void => {
      for (const s of group) if (s.code === code) s.severity = 'actionable';
    };

    // Rule 2: oversold dip corroborated by a window low, on a held name.
    if (codes.has('rsi_oversold') && nearLow) upgrade('rsi_oversold');

    // Rule 3: stretched (overbought) and outsized (overweight) held position.
    if (codes.has('rsi_overbought') && codes.has('position_overweight')) {
      upgrade('rsi_overbought');
      upgrade('position_overweight');
    }
  }

  return signals;
}
