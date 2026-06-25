/**
 * Narration orchestration: cache → LLM → validate → cache, with deterministic
 * fallback at every failure point. The deterministic engine is the product; this
 * layer is an enhancement that must never take the tool down.
 *
 * Trigger / cost discipline: the LLM is called on demand (the `explain` command)
 * and only when a symbol's situation isn't already cached. The cache is keyed by
 * (symbol, signal-set hash), so an unchanged situation reuses the stored read
 * with no API call; any change to the signal set, trim %, or headline sentiments
 * invalidates it.
 */

import type { DB } from '../db.js';
import { errMsg, log } from '../util.js';
import { signalSetHash } from './hash.js';
import { deterministicNarration, validateNarration } from './schema.js';
import type { LlmProvider, Narration, NarrationInput } from './types.js';

export type NarrationSource = 'cache' | 'llm' | 'deterministic';

export interface NarrateResult {
  narration: Narration;
  source: NarrationSource;
  /** Validator repairs applied to the model output (forbidden language, basisPct). */
  repairs: string[];
  /** A user-facing note when the AI explanation is unavailable. */
  note?: string;
}

export interface NarratorDeps {
  db: DB;
  /** The provider, or null when the LLM layer is disabled / has no API key. */
  llm: LlmProvider | null;
  onUsage: (kind: 'narration', model: string, inputTokens: number, outputTokens: number) => void;
}

/**
 * Produce a narration for one already-assembled {@link NarrationInput}.
 *
 *  - No provider → deterministic narration + "unavailable" note.
 *  - Cache hit → the stored narration, no API call.
 *  - LLM success → validated/repaired narration, then cached.
 *  - LLM failure (error, timeout, malformed-after-retry) → deterministic
 *    narration + "unavailable" note. Never throws.
 */
export async function narrate(input: NarrationInput, deps: NarratorDeps): Promise<NarrateResult> {
  if (!deps.llm) {
    return {
      narration: deterministicNarration(input),
      source: 'deterministic',
      repairs: [],
      note: 'AI explanation unavailable (LLM layer disabled)',
    };
  }

  const hash = signalSetHash(input);
  const cached = deps.db.getNarration(input.symbol, hash);
  if (cached) {
    try {
      return { narration: JSON.parse(cached) as Narration, source: 'cache', repairs: [] };
    } catch {
      // Corrupt cache row — fall through and re-narrate.
    }
  }

  try {
    const { narration: raw, usage } = await deps.llm.explain(input);
    deps.onUsage('narration', usage.model, usage.inputTokens, usage.outputTokens);

    const { narration, repairs } = validateNarration(raw, input);
    if (repairs.length > 0) {
      log.warn(`narration for ${input.symbol} repaired by validator: ${repairs.join('; ')}`);
    }
    deps.db.putNarration(input.symbol, hash, JSON.stringify(narration), new Date().toISOString());
    return { narration, source: 'llm', repairs };
  } catch (err) {
    log.warn(`LLM narration failed for ${input.symbol} (${errMsg(err)}); using deterministic fallback`);
    return {
      narration: deterministicNarration(input),
      source: 'deterministic',
      repairs: [],
      note: `AI explanation unavailable (${errMsg(err)})`,
    };
  }
}
