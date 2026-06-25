import { createHash } from 'node:crypto';
import type { NarrationInput } from './types.js';

/** sha256 hex of a string. */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Stable hash of a symbol's *situation* — its current signal set, the
 * code-computed trim %, and its headline sentiments. The narration cache is
 * keyed by (symbol, this hash): an unchanged situation reuses the cached read
 * (no API call); any change to a signal, severity, the trim %, or a headline
 * sentiment changes the hash and invalidates the cache.
 *
 * Deterministic across runs: inputs are sorted before hashing, so the same
 * situation always produces the same key.
 */
export function signalSetHash(input: NarrationInput): string {
  const signals = input.signals
    .map((s) => `${s.code}:${s.severity}`)
    .sort()
    .join('|');
  const context = input.context
    .map((c) => `${c.window}:${c.rangePosition}`)
    .sort()
    .join('|');
  const headlines = input.headlines
    .map((h) => `${h.sentiment}:${h.text}`)
    .sort()
    .join('|');
  return sha256([signals, context, headlines, `trim:${input.suggestedTrimPct}`].join('#'));
}

/** Hash of a single headline's text, for the per-headline sentiment cache. */
export function headlineHash(text: string): string {
  return sha256(text.trim());
}
