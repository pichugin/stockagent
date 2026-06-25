/**
 * Phase 6 vocabulary. The LLM layer is an *enhancement* on top of the
 * deterministic engine: it phrases and prioritizes what the deterministic layer
 * already found. It never generates signals, never predicts, and never decides.
 *
 * Two hard rules are encoded structurally so a model can't quietly break them:
 *  1. Every read carries BOTH a bull and a bear interpretation of the same facts.
 *  2. A suggested action is ONE option, and any number in it (`basisPct`) is the
 *     code-computed value echoed back — if a number originates in the model it
 *     is a bug, caught in validation.
 */

import type { Severity, SignalKind } from '../signals/types.js';

/** Headline sentiment is the only "classification" the LLM does — text only. */
export type Sentiment = 'positive' | 'negative' | 'neutral';

/** One classified headline (headline text only — never the article body). */
export interface HeadlineSentiment {
  /** The headline text that was classified. */
  text: string;
  sentiment: Sentiment;
  /** One-line neutral summary (no prediction). */
  summary: string;
}

/**
 * The compact, structured payload handed to the LLM for one symbol. Built by the
 * pure {@link buildNarrationInput}. Deliberately contains NO raw price series —
 * only the numbers the deterministic layer already produced — so the model has
 * nothing prediction-shaped to "analyze" freely.
 */
export interface NarrationInput {
  symbol: string;
  /** ISO timestamp the underlying data is as-of (latest cached close). */
  asOf: string;
  /** The currently-true signals for this symbol (compact form). */
  signals: NarrationSignal[];
  /** Multi-timeframe factual context windows (compact form). */
  context: NarrationContext[];
  /** Position numbers, present only when the symbol is held. */
  position?: NarrationPosition;
  /** Classified headlines (text-only sentiment), present when available. */
  headlines: HeadlineSentiment[];
  /**
   * The code-computed suggested-trim percentage, or null when no reduce-exposure
   * rationale exists. The LLM phrases this; it must never invent or alter it.
   */
  suggestedTrimPct: number | null;
}

export interface NarrationSignal {
  kind: SignalKind;
  code: string;
  severity: Severity;
  summary: string;
}

export interface NarrationContext {
  window: string; // "1d" | "1wk" | "1mo" | "6mo"
  rangePosition: number; // % within window's realized range
  trend: string; // "up" | "down" | "flat"
  changePct: number;
  volatilityPct: number;
  maxDrawdownPct: number;
  low: number;
  high: number;
  close: number;
}

export interface NarrationPosition {
  shares: number;
  avgCost: number;
  currency: string;
  latestClose: number;
  pnlPct: number;
  /** CAD-normalized unrealized P&L, or null when no FX rate is available. */
  cadPnl: number | null;
  /** Share of total portfolio value (CAD), or null when concentration is unknown. */
  sharePct: number | null;
}

/**
 * The structured narration the model must return (validated with zod, then
 * semantically checked in code). `bull`/`bear` are mandatory so a single
 * directional verdict is structurally impossible.
 */
export interface Narration {
  symbol: string;
  /** Plain-language factual situation (present tense, no prediction). */
  read: string;
  /** Bullish interpretation of the SAME facts. */
  bull: string;
  /** Bearish interpretation of the SAME facts. */
  bear: string;
  suggestedAction: {
    /** Phrased as one option ("one way to…"), never a directive. */
    option: string;
    /** The code-computed %, echoed back. Must equal the input value. */
    basisPct: number | null;
  };
  /** The always-on "your call — mechanical signal, not advice." line. */
  framingNote: string;
}

/** Token accounting for one provider call, so cost is observable. */
export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Backend-agnostic LLM provider. The rest of the layer depends only on this
 * interface, so OpenAI/Anthropic/etc. are swappable without touching the
 * narration, ranking, validation, or caching code. Implementations do the raw
 * API call and shape-parse the JSON; all *semantic* enforcement (the framing
 * contract) happens in code around them, never trusted to the model.
 */
export interface LlmProvider {
  readonly name: string;
  /** Narrate one symbol. Returns the shape-parsed narration plus token usage. */
  explain(input: NarrationInput): Promise<{ narration: Narration; usage: LlmUsage }>;
  /** Classify one headline's sentiment (headline text only). */
  classifyHeadline(
    symbol: string,
    headline: string,
  ): Promise<{ result: HeadlineSentiment; usage: LlmUsage }>;
}
