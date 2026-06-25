/**
 * Pure input assembly. Turns a symbol's deterministic signals, multi-timeframe
 * context, and (if held) position numbers into the compact {@link NarrationInput}
 * the prompt is built from. No I/O, no raw bars, no model — fully unit-testable.
 *
 * This is also where the code-computed suggested-trim % is attached, so the
 * number the LLM phrases is decided here, deterministically.
 */

import type { SignalsConfig } from '../config.js';
import type { Signal } from '../signals/types.js';
import { suggestedTrimPct, trimInputsFromPosition } from './positionSizing.js';
import type {
  HeadlineSentiment,
  NarrationContext,
  NarrationInput,
  NarrationPosition,
  NarrationSignal,
} from './types.js';

/** Position numbers the deterministic layer has already computed for a held symbol. */
export interface HeldNumbers {
  shares: number;
  avgCost: number;
  currency: string;
  latestClose: number;
  pnlPct: number;
  cadPnl: number | null;
  sharePct: number | null;
}

export interface BuildNarrationInputArgs {
  symbol: string;
  asOf: string;
  /** All currently-true signals for this symbol (any kind/severity). */
  signals: Signal[];
  /** Position numbers, when the symbol is held. */
  position?: HeldNumbers;
  /** Classified headlines (text-only sentiment). */
  headlines?: HeadlineSentiment[];
  /** Signal-engine config — supplies the concentration/gain thresholds for sizing. */
  signalsCfg: SignalsConfig;
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/**
 * Assemble the structured narration input. Context-kind signals become the
 * `context` windows; every other signal becomes a compact `signals` entry. The
 * suggested-trim % is computed here (code decides; the model only phrases).
 */
export function buildNarrationInput(args: BuildNarrationInputArgs): NarrationInput {
  const { symbol, asOf, signals, position, headlines = [], signalsCfg } = args;

  const context: NarrationContext[] = [];
  const plain: NarrationSignal[] = [];

  for (const s of signals) {
    if (s.kind === 'context') {
      context.push({
        window: str(s.data.window),
        rangePosition: num(s.data.rangePosition),
        trend: str(s.data.trend),
        changePct: num(s.data.changePct),
        volatilityPct: num(s.data.volatilityPct),
        maxDrawdownPct: num(s.data.maxDrawdownPct),
        low: num(s.data.low),
        high: num(s.data.high),
        close: num(s.data.close),
      });
    } else {
      plain.push({ kind: s.kind, code: s.code, severity: s.severity, summary: s.summary });
    }
  }

  let positionOut: NarrationPosition | undefined;
  let trim: number | null = null;
  if (position) {
    positionOut = {
      shares: position.shares,
      avgCost: position.avgCost,
      currency: position.currency,
      latestClose: position.latestClose,
      pnlPct: position.pnlPct,
      cadPnl: position.cadPnl,
      sharePct: position.sharePct,
    };
    trim = suggestedTrimPct(trimInputsFromPosition(positionOut), signalsCfg);
  }

  return {
    symbol,
    asOf,
    signals: plain,
    context,
    position: positionOut,
    headlines,
    suggestedTrimPct: trim,
  };
}
