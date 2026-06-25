/**
 * Headline sentiment service. Fetches recent headlines (text only) and classifies
 * each via the LLM, caching the result per headline so the same headline is never
 * re-classified. The classified sentiments feed into narration as one more input
 * signal — as context, never as a prediction.
 *
 * Resilient: a fetch or classification failure for a headline is logged and
 * skipped; it never breaks narration.
 */

import type { DB } from '../db.js';
import type { NewsProvider } from '../providers/newsTypes.js';
import { errMsg, log } from '../util.js';
import { headlineHash } from './hash.js';
import type { HeadlineSentiment, LlmProvider } from './types.js';

export interface HeadlineServiceDeps {
  db: DB;
  news: NewsProvider;
  llm: LlmProvider;
  /** Records token usage for a classification call. */
  onUsage: (kind: 'headline', model: string, inputTokens: number, outputTokens: number) => void;
}

/**
 * Fetch up to `max` headlines for `symbol` and return their sentiments. Each
 * headline is classified at most once ever — cache hits skip the API entirely.
 * Only headline TEXT is ever sent to the model.
 */
export async function classifyHeadlines(
  symbol: string,
  max: number,
  deps: HeadlineServiceDeps,
): Promise<HeadlineSentiment[]> {
  let headlines;
  try {
    headlines = await deps.news.getRecentHeadlines(symbol, max);
  } catch (err) {
    log.warn(`headlines for ${symbol} unavailable (${errMsg(err)}); narrating without them`);
    return [];
  }

  const out: HeadlineSentiment[] = [];
  for (const h of headlines) {
    const hash = headlineHash(h.title);
    const cached = deps.db.getHeadlineSentiment(hash);
    if (cached) {
      out.push({ text: cached.text, sentiment: cached.sentiment as HeadlineSentiment['sentiment'], summary: cached.summary });
      continue;
    }
    try {
      const { result, usage } = await deps.llm.classifyHeadline(symbol, h.title);
      deps.db.putHeadlineSentiment(
        hash,
        { text: result.text, sentiment: result.sentiment, summary: result.summary },
        new Date().toISOString(),
      );
      deps.onUsage('headline', usage.model, usage.inputTokens, usage.outputTokens);
      out.push(result);
    } catch (err) {
      log.warn(`headline classification failed for ${symbol} (${errMsg(err)}); skipping that headline`);
    }
  }
  return out;
}
