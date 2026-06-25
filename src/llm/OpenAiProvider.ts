/**
 * OpenAI implementation of {@link LlmProvider}. The only backend-specific code in
 * the layer — everything else (input assembly, ranking, validation, caching)
 * stays provider-agnostic, so swapping backends means writing one more file like
 * this and pointing `llm.provider` at it.
 *
 * It does the raw API call with a strict JSON-schema response format and
 * shape-parses the result. It performs ONE repair retry on malformed/again-
 * malformed JSON, then throws — the narrator turns a throw into the deterministic
 * fallback. It does NOT do the framing-contract semantic checks (forbidden
 * language, basisPct provenance); those are enforced in code by the narrator so
 * they can't be skipped by swapping providers.
 *
 * What is sent to OpenAI: only the structured market/position numbers the
 * deterministic engine produced, plus headline TEXT for sentiment. No
 * credentials, no raw price series, no article bodies. (See README.)
 */

import OpenAI from 'openai';
import type { LlmConfig } from '../config.js';
import {
  HEADLINE_SYSTEM_PROMPT,
  NARRATION_SYSTEM_PROMPT,
  buildHeadlineUserContent,
  buildNarrationUserContent,
} from './prompt.js';
import { NarrationSchema } from './schema.js';
import type { HeadlineSentiment, LlmProvider, LlmUsage, Narration, NarrationInput } from './types.js';

/** True when an OpenAI API key is available in the environment. */
export function hasOpenAiCredentials(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

// Strict JSON schemas the model must conform to (OpenAI structured outputs).
// `strict` mode requires every property listed in `required` and
// additionalProperties:false; we express "optional number" as a nullable type.
const NARRATION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string' },
    read: { type: 'string' },
    bull: { type: 'string' },
    bear: { type: 'string' },
    suggestedAction: {
      type: 'object',
      additionalProperties: false,
      properties: {
        option: { type: 'string' },
        basisPct: { type: ['number', 'null'] },
      },
      required: ['option', 'basisPct'],
    },
    framingNote: { type: 'string' },
  },
  required: ['symbol', 'read', 'bull', 'bear', 'suggestedAction', 'framingNote'],
};

const HEADLINE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
    summary: { type: 'string' },
  },
  required: ['sentiment', 'summary'],
};

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;

  constructor(private readonly cfg: LlmConfig) {
    // The SDK reads OPENAI_API_KEY from the env; callers gate on
    // hasOpenAiCredentials() before constructing, so this won't throw here.
    this.client = new OpenAI();
  }

  async explain(input: NarrationInput): Promise<{ narration: Narration; usage: LlmUsage }> {
    const messages: ChatMessage[] = [
      { role: 'system', content: NARRATION_SYSTEM_PROMPT },
      { role: 'user', content: buildNarrationUserContent(input) },
    ];
    const { parsed, usage } = await this.callStructured(messages, 'narration', NARRATION_JSON_SCHEMA);
    const result = NarrationSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`narration JSON failed shape validation: ${result.error.message}`);
    }
    return { narration: result.data, usage };
  }

  async classifyHeadline(
    symbol: string,
    headline: string,
  ): Promise<{ result: HeadlineSentiment; usage: LlmUsage }> {
    const messages: ChatMessage[] = [
      { role: 'system', content: HEADLINE_SYSTEM_PROMPT },
      { role: 'user', content: buildHeadlineUserContent(symbol, headline) },
    ];
    const { parsed, usage } = await this.callStructured(messages, 'headline_sentiment', HEADLINE_JSON_SCHEMA);
    const obj = parsed as { sentiment?: unknown; summary?: unknown };
    const sentiment = obj.sentiment;
    if (sentiment !== 'positive' && sentiment !== 'negative' && sentiment !== 'neutral') {
      throw new Error(`headline sentiment not a valid label: ${String(sentiment)}`);
    }
    return {
      result: { text: headline, sentiment, summary: typeof obj.summary === 'string' ? obj.summary : '' },
      usage,
    };
  }

  /**
   * One structured-output call with a single repair retry. Returns the parsed
   * JSON (untyped) plus token usage; throws if both attempts fail to produce
   * parseable JSON.
   */
  private async callStructured(
    messages: ChatMessage[],
    schemaName: string,
    schema: Record<string, unknown>,
  ): Promise<{ parsed: unknown; usage: LlmUsage }> {
    let lastErr: unknown;
    let attemptMessages = messages;
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await this.client.chat.completions.create({
        model: this.cfg.model,
        temperature: this.cfg.temperature,
        messages: attemptMessages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, schema, strict: true },
        },
      });

      const usage: LlmUsage = {
        model: resp.model ?? this.cfg.model,
        inputTokens: resp.usage?.prompt_tokens ?? 0,
        outputTokens: resp.usage?.completion_tokens ?? 0,
      };

      const content = resp.choices[0]?.message?.content ?? '';
      try {
        return { parsed: JSON.parse(content), usage };
      } catch (err) {
        lastErr = err;
        // Repair retry: tell the model its prior output wasn't valid JSON.
        attemptMessages = [
          ...messages,
          {
            role: 'user',
            content: 'Your previous response was not valid JSON for the required schema. Respond again with ONLY the JSON object.',
          },
        ];
      }
    }
    throw new Error(`structured call did not return valid JSON after retry: ${(lastErr as Error)?.message ?? lastErr}`);
  }
}
