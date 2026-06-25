/**
 * Phase 6 LLM narration layer. The deterministic engine decides (signals,
 * ranking, trim %); the LLM only phrases. Every model-touched surface carries
 * "mechanical signal, not advice", and the framing contract is enforced in code
 * (see {@link validateNarration}), never trusted to the model.
 */

export * from './types.js';
export { buildNarrationInput, type HeldNumbers } from './input.js';
export { suggestedTrimPct, trimInputsFromPosition, type TrimInputs } from './positionSizing.js';
export {
  deterministicNarration,
  validateNarration,
  findForbiddenLanguage,
  NarrationSchema,
  FRAMING_NOTE,
  type ValidationResult,
} from './schema.js';
export { rankSymbols, baseScore, nudgedScore, type RankInputItem, type RankedItem } from './ranking.js';
export { signalSetHash, headlineHash, sha256 } from './hash.js';
export { narrate, type NarrateResult, type NarratorDeps, type NarrationSource } from './narrator.js';
export { classifyHeadlines, type HeadlineServiceDeps } from './headlines.js';
export { gatherBundles, type SymbolBundle } from './assemble.js';
export { resolveLlmProvider, type ProviderResolution } from './provider.js';
export { OpenAiProvider, hasOpenAiCredentials } from './OpenAiProvider.js';
