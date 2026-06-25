/**
 * Provider selection. Reads the chosen backend from config and its key from the
 * environment — never hardcoded. Returns null (with a reason) when the layer is
 * disabled or unconfigured, so callers degrade to the deterministic engine
 * cleanly. To add a backend: implement {@link LlmProvider} and add a branch here.
 */

import type { LlmConfig } from '../config.js';
import { OpenAiProvider, hasOpenAiCredentials } from './OpenAiProvider.js';
import type { LlmProvider } from './types.js';

export interface ProviderResolution {
  provider: LlmProvider | null;
  /** Why the LLM is off, when provider is null (shown to the user). */
  reason?: string;
}

/**
 * Resolve the configured provider. `disabled` is the per-run `--no-llm` flag.
 * Order: explicit disable → config master switch → credentials present.
 */
export function resolveLlmProvider(cfg: LlmConfig, disabled: boolean): ProviderResolution {
  if (disabled) return { provider: null, reason: '--no-llm flag set' };
  if (!cfg.enabled) return { provider: null, reason: 'llm.enabled is false in config' };

  switch (cfg.provider) {
    case 'openai':
      if (!hasOpenAiCredentials()) {
        return { provider: null, reason: 'OPENAI_API_KEY is not set in the environment' };
      }
      return { provider: new OpenAiProvider(cfg) };
    default:
      return { provider: null, reason: `unknown llm.provider "${cfg.provider}"` };
  }
}
