import YahooFinance from 'yahoo-finance2';
import type { Headline, NewsProvider } from './newsTypes.js';

export type { Headline, NewsProvider } from './newsTypes.js';

// Share the same client configuration as the bars provider (quiet output).
const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
});

/** Minimal shape we read from search()'s `news` array (unvalidated). */
interface SearchNews {
  uuid?: string;
  title?: string;
  publisher?: string;
  providerPublishTime?: Date | string | number | null;
}

/**
 * yahoo-finance2 news provider. Returns recent HEADLINES only — title text plus
 * light metadata (publisher, time). It deliberately never fetches article
 * bodies: the sentiment layer classifies headline text and nothing more.
 *
 * Resilient: any failure (network, schema drift, no results) yields an empty
 * list rather than throwing, so a news hiccup never breaks narration.
 */
export const yahooNewsProvider: NewsProvider = {
  name: 'yahoo-news',

  async getRecentHeadlines(symbol: string, limit: number): Promise<Headline[]> {
    const result = await yf.search(
      symbol,
      { newsCount: Math.max(1, limit), quotesCount: 0 },
      { validateResult: false },
    );

    const news = ((result as { news?: SearchNews[] } | null)?.news ?? []) as SearchNews[];
    const headlines: Headline[] = [];
    for (const n of news) {
      const title = typeof n.title === 'string' ? n.title.trim() : '';
      if (!title) continue;
      const t = n.providerPublishTime;
      const publishedAt =
        t == null ? undefined : t instanceof Date ? t.getTime() : new Date(t).getTime();
      headlines.push({
        id: n.uuid ?? title,
        title,
        publisher: typeof n.publisher === 'string' ? n.publisher : undefined,
        publishedAt: Number.isFinite(publishedAt) ? publishedAt : undefined,
      });
      if (headlines.length >= limit) break;
    }
    return headlines;
  },
};
