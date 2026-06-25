import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DB } from '../db.js';
import type { Headline, NewsProvider } from '../providers/newsTypes.js';
import { classifyHeadlines } from './headlines.js';
import type { HeadlineSentiment, LlmProvider, Narration } from './types.js';

function newsProvider(titles: string[], opts: { fail?: boolean } = {}): NewsProvider {
  return {
    name: 'mock-news',
    async getRecentHeadlines(_symbol: string, limit: number): Promise<Headline[]> {
      if (opts.fail) throw new Error('news down');
      return titles.slice(0, limit).map((t, i) => ({ id: `id-${i}`, title: t }));
    },
  };
}

/** Records every string handed to classifyHeadline, to prove only titles are sent. */
class RecordingProvider implements LlmProvider {
  readonly name = 'mock';
  received: string[] = [];
  calls = 0;
  async explain(): Promise<{ narration: Narration; usage: any }> {
    throw new Error('not used');
  }
  async classifyHeadline(_symbol: string, headline: string): Promise<{ result: HeadlineSentiment; usage: any }> {
    this.calls += 1;
    this.received.push(headline);
    return {
      result: { text: headline, sentiment: 'neutral', summary: `summary of: ${headline}` },
      usage: { model: 'mock', inputTokens: 5, outputTokens: 5 },
    };
  }
}

test('classifies each headline once, sending only the headline text', async () => {
  const db = new DB(':memory:');
  const llm = new RecordingProvider();
  const titles = ['Acme beats earnings', 'Acme faces lawsuit'];
  const news = newsProvider(titles);

  const out = await classifyHeadlines('ACME', 5, { db, news, llm, onUsage: () => {} });
  assert.equal(out.length, 2);
  assert.equal(llm.calls, 2);
  assert.deepEqual(llm.received, titles); // exactly the titles — no bodies, no extra text
  db.close();
});

test('per-headline cache prevents re-classification on a second run', async () => {
  const db = new DB(':memory:');
  const llm = new RecordingProvider();
  const news = newsProvider(['Acme beats earnings']);

  await classifyHeadlines('ACME', 5, { db, news, llm, onUsage: () => {} });
  assert.equal(llm.calls, 1);

  // Second run: same headline → served from cache, no further LLM calls.
  const second = await classifyHeadlines('ACME', 5, { db, news, llm, onUsage: () => {} });
  assert.equal(llm.calls, 1);
  assert.equal(second[0].sentiment, 'neutral');
  db.close();
});

test('a news-fetch failure degrades to no headlines (never throws)', async () => {
  const db = new DB(':memory:');
  const llm = new RecordingProvider();
  const news = newsProvider([], { fail: true });
  const out = await classifyHeadlines('ACME', 5, { db, news, llm, onUsage: () => {} });
  assert.deepEqual(out, []);
  assert.equal(llm.calls, 0);
  db.close();
});
