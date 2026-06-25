/** A single news headline — title text plus light metadata, never the body. */
export interface Headline {
  /** Stable id for caching (provider uuid, else the title text). */
  id: string;
  title: string;
  publisher?: string;
  /** Publish time, epoch milliseconds (UTC), when known. */
  publishedAt?: number;
}

/**
 * Headline source, behind the same backend-agnostic shape as the bars provider.
 * Implementations return HEADLINE TEXT ONLY — the sentiment layer must never see
 * an article body.
 */
export interface NewsProvider {
  readonly name: string;
  getRecentHeadlines(symbol: string, limit: number): Promise<Headline[]>;
}
