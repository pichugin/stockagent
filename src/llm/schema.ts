/**
 * The framing contract, enforced in code — not trusted to the model.
 *
 * Three layers:
 *  1. **Shape** — zod validates the structured JSON the model must return.
 *  2. **Forbidden language** — a regex sweep over the free-text fields catches
 *     prediction-shaped phrasing (predict/forecast/will rise|fall/expect/target
 *     price/guarantee…). A tripped field is replaced with the deterministic
 *     summary for that symbol and the event is recorded.
 *  3. **Number provenance** — `basisPct` MUST equal the code-computed trim %.
 *     If the model invents or alters it, we repair it back to the code value.
 *
 * The deterministic fallback ({@link deterministicNarration}) is also the
 * complete answer when the LLM is disabled, errors, or returns junk — the engine
 * is the product; the LLM is an enhancement.
 */

import { z } from 'zod';
import type { Narration, NarrationInput } from './types.js';

/** The always-on closing line. Rule 4 of the framing contract, guaranteed in code. */
export const FRAMING_NOTE = 'Your call — mechanical signal, not advice.';

/** zod schema for the model's structured response. */
export const NarrationSchema = z.object({
  symbol: z.string(),
  read: z.string().min(1),
  bull: z.string().min(1),
  bear: z.string().min(1),
  suggestedAction: z.object({
    option: z.string().min(1),
    basisPct: z.number().nullable(),
  }),
  framingNote: z.string(),
});

/**
 * Prediction-shaped phrasing the LLM must never use. Targets *future-tense /
 * forecast* language specifically — factual past-window descriptions ("up 3%",
 * "trend down", "near the top") are fine and must not trip these.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bpredict(s|ed|ing|ion|ions)?\b/i,
  /\bforecast(s|ed|ing)?\b/i,
  /\bexpect(s|ed|ing|ation|ations)?\b/i,
  /\banticipat(e|es|ed|ing|ion)\b/i,
  /\bproject(ed|ing|ion|ions)\b/i,
  /\bwill\s+(rise|fall|drop|climb|rally|reach|hit|go|move|increase|decrease|gain|lose|bounce|rebound|recover|surge|plunge|continue|break|test|retest|head)\b/i,
  /\bwill\s+likely\b/i,
  /\b(likely|set|poised|bound|due|going|headed)\s+to\b/i,
  /\bshould\s+(rise|fall|drop|climb|rally|rebound|bounce|recover|continue|head|go|move|increase|decrease|reach|hit|break)\b/i,
  /\b(price\s+target|target\s+price)\b/i,
  /\bguarantee(s|d)?\b/i,
  /\b(higher|lower)\s+(ahead|from\s+here|going\s+forward)\b/i,
];

/**
 * Returns the first forbidden phrase found in `text`, or null if clean. Exposed
 * for unit tests (feed prediction-laden text → assert it's caught).
 */
export function findForbiddenLanguage(text: string): string | null {
  for (const re of FORBIDDEN_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

// --- Deterministic fallback narration ----------------------------------------

/** Codes that lean constructive (bull) vs cautious (bear), for the both-sides split. */
const BULLISH = [
  /rsi_oversold/,
  /near_.*_low/,
  /price_below_lower_band/,
  /macd_bullish_cross/,
  /ma_golden_cross/,
  /large_unrealized_gain/,
  /price_at_or_below_buy/,
];
const BEARISH = [
  /rsi_overbought/,
  /near_.*_high/,
  /price_above_upper_band/,
  /macd_bearish_cross/,
  /ma_death_cross/,
  /large_unrealized_loss/,
  /position_overweight/,
  /price_at_or_above_sell/,
  /multiple_holdings_overbought/,
];

const matchesAny = (code: string, pats: RegExp[]): boolean => pats.some((p) => p.test(code));

/** A one-line factual digest of the symbol's situation, used as the `read` fallback. */
function factualDigest(input: NarrationInput): string {
  const parts: string[] = [];
  if (input.signals.length > 0) {
    parts.push(input.signals.map((s) => s.summary).join('; '));
  }
  const sixmo = input.context.find((c) => c.window === '6mo') ?? input.context.at(-1);
  if (sixmo) {
    parts.push(
      `over its ${sixmo.window} window the latest close ${sixmo.close} sits at the ` +
        `${sixmo.rangePosition}% mark of [${sixmo.low} – ${sixmo.high}] (${sixmo.trend} ${sixmo.changePct}%)`,
    );
  }
  if (input.position) {
    const p = input.position;
    const cad = p.cadPnl == null ? '' : ` (${p.cadPnl >= 0 ? '+' : ''}${p.cadPnl} CAD)`;
    parts.push(`held: ${p.shares} @ ${p.avgCost} ${p.currency}, ${p.pnlPct}% on cost${cad}`);
  }
  const body = parts.length > 0 ? parts.join('. ') : 'no active signals';
  return `${input.symbol}: ${body}.`;
}

/**
 * Build a deterministic narration purely from the structured input — no model.
 * Honest both-sides framing comes from classifying which signals lean
 * constructive vs cautious. Used both as the whole-symbol fallback and to
 * replace any single field that fails the forbidden-language check.
 */
export function deterministicNarration(input: NarrationInput): Narration {
  const read = factualDigest(input);

  const bullSignals = input.signals.filter((s) => matchesAny(s.code, BULLISH));
  const bearSignals = input.signals.filter((s) => matchesAny(s.code, BEARISH));

  const bull =
    bullSignals.length > 0
      ? `Constructive reading of the same facts (mechanical, describing current conditions only): ${bullSignals
          .map((s) => s.summary)
          .join('; ')}.`
      : 'Constructive reading of the same facts: no individually bullish readings stand out — the picture is mixed or neutral.';

  const bear =
    bearSignals.length > 0
      ? `Cautious reading of the same facts (mechanical, describing current conditions only): ${bearSignals
          .map((s) => s.summary)
          .join('; ')}.`
      : 'Cautious reading of the same facts: no individually bearish readings stand out — the picture is mixed or neutral.';

  const trim = input.suggestedTrimPct;
  const option =
    trim != null
      ? `If you wanted to reduce concentration, trimming ~${trim}% is one mechanical way to bring this position's weight down.`
      : 'No position-sizing option is indicated by the current signals.';

  return {
    symbol: input.symbol,
    read,
    bull,
    bear,
    suggestedAction: { option, basisPct: trim },
    framingNote: FRAMING_NOTE,
  };
}

// --- Validation + repair ------------------------------------------------------

export interface ValidationResult {
  narration: Narration;
  /** Human-readable notes on every repair applied (empty = model output used as-is). */
  repairs: string[];
  /** True if the model's JSON shape was valid (false → full deterministic fallback). */
  shapeOk: boolean;
}

/**
 * Validate and repair a raw model response against the framing contract. The
 * model is never trusted to self-police:
 *  - bad shape → full deterministic fallback;
 *  - any forbidden-language field → that field replaced by the deterministic one;
 *  - `basisPct` forced to the code-computed value (the model cannot invent it);
 *  - `framingNote` forced to the canonical line.
 */
export function validateNarration(raw: unknown, input: NarrationInput): ValidationResult {
  const fallback = deterministicNarration(input);
  const parsed = NarrationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      narration: fallback,
      repairs: [`shape-invalid: ${parsed.error.issues.map((i) => i.path.join('.')).join(',')}`],
      shapeOk: false,
    };
  }

  const out = parsed.data;
  const repairs: string[] = [];

  // Force the symbol — the model echoes it, but code owns it.
  out.symbol = input.symbol;

  // Forbidden-language sweep over each free-text field.
  const checks: Array<[keyof Narration | 'option', string, () => void]> = [
    ['read', out.read, () => (out.read = fallback.read)],
    ['bull', out.bull, () => (out.bull = fallback.bull)],
    ['bear', out.bear, () => (out.bear = fallback.bear)],
    ['option', out.suggestedAction.option, () => (out.suggestedAction.option = fallback.suggestedAction.option)],
  ];
  for (const [field, text, replace] of checks) {
    const hit = findForbiddenLanguage(text);
    if (hit) {
      replace();
      repairs.push(`forbidden-language in ${String(field)}: "${hit}" → deterministic summary`);
    }
  }

  // Number provenance: basisPct MUST equal the code-computed trim %.
  if (out.suggestedAction.basisPct !== input.suggestedTrimPct) {
    repairs.push(
      `basisPct mismatch: model=${out.suggestedAction.basisPct} code=${input.suggestedTrimPct} → repaired`,
    );
    out.suggestedAction.basisPct = input.suggestedTrimPct;
  }

  // Rule 4: always end with the canonical framing line.
  out.framingNote = FRAMING_NOTE;

  return { narration: out, repairs, shapeOk: true };
}
