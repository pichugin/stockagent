import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DB } from '../db.js';
import { FRAMING_NOTE } from './schema.js';
import { narrate, type NarratorDeps } from './narrator.js';
import type { HeadlineSentiment, LlmProvider, Narration, NarrationInput } from './types.js';

const NOW = '2024-06-01T00:00:00.000Z';

function input(overrides: Partial<NarrationInput> = {}): NarrationInput {
  return {
    symbol: 'AAPL',
    asOf: NOW,
    signals: [{ kind: 'technical', code: 'rsi_overbought', severity: 'notable', summary: 'overbought' }],
    context: [],
    headlines: [],
    suggestedTrimPct: 15,
    ...overrides,
  };
}

function clean(symbol = 'AAPL'): Narration {
  return {
    symbol,
    read: 'A factual read of the present situation.',
    bull: 'A constructive reading of the same facts.',
    bear: 'A cautious reading of the same facts.',
    suggestedAction: { option: 'One way to reduce concentration is trimming ~15%.', basisPct: 15 },
    framingNote: FRAMING_NOTE,
  };
}

/** Counts calls so we can assert the cache prevents a second API hit. */
class MockProvider implements LlmProvider {
  readonly name = 'mock';
  explainCalls = 0;
  constructor(
    private readonly narration: Narration | (() => Narration),
    private readonly fail = false,
  ) {}
  async explain(): Promise<{ narration: Narration; usage: any }> {
    this.explainCalls += 1;
    if (this.fail) throw new Error('boom');
    const n = typeof this.narration === 'function' ? this.narration() : this.narration;
    return { narration: n, usage: { model: 'mock', inputTokens: 10, outputTokens: 20 } };
  }
  async classifyHeadline(): Promise<{ result: HeadlineSentiment; usage: any }> {
    return { result: { text: '', sentiment: 'neutral', summary: '' }, usage: { model: 'mock', inputTokens: 1, outputTokens: 1 } };
  }
}

function deps(db: DB, llm: LlmProvider | null): NarratorDeps {
  return { db, llm, onUsage: () => {} };
}

test('with no provider, narrate returns the deterministic narration + unavailable note', async () => {
  const db = new DB(':memory:');
  const res = await narrate(input(), deps(db, null));
  assert.equal(res.source, 'deterministic');
  assert.ok(res.note?.includes('unavailable'));
  assert.ok(res.narration.bull && res.narration.bear);
  db.close();
});

test('an unchanged signal set is served from cache — no second API call', async () => {
  const db = new DB(':memory:');
  const provider = new MockProvider(clean());

  const first = await narrate(input(), deps(db, provider));
  assert.equal(first.source, 'llm');
  assert.equal(provider.explainCalls, 1);

  const second = await narrate(input(), deps(db, provider));
  assert.equal(second.source, 'cache');
  assert.equal(provider.explainCalls, 1); // still one — cache hit

  // Changing the signal set invalidates the cache → a fresh call.
  const changed = input({
    signals: [{ kind: 'technical', code: 'macd_bearish_cross', severity: 'notable', summary: 'cross' }],
  });
  const third = await narrate(changed, deps(db, provider));
  assert.equal(third.source, 'llm');
  assert.equal(provider.explainCalls, 2);
  db.close();
});

test('a provider error degrades to the deterministic fallback without throwing', async () => {
  const db = new DB(':memory:');
  const provider = new MockProvider(clean(), true);
  const res = await narrate(input(), deps(db, provider));
  assert.equal(res.source, 'deterministic');
  assert.ok(res.note?.includes('AI explanation unavailable'));
  db.close();
});

test('a prediction-laden model response is caught; that field uses the deterministic summary', async () => {
  const db = new DB(':memory:');
  const laden = clean();
  laden.read = 'AAPL will rally and is expected to break out next week.';
  const provider = new MockProvider(laden);

  const res = await narrate(input(), deps(db, provider));
  assert.equal(res.source, 'llm');
  assert.ok(res.repairs.some((r) => r.includes('forbidden-language in read')));
  assert.notEqual(res.narration.read, laden.read); // poisoned field replaced
  assert.equal(res.narration.bull, laden.bull); // clean fields preserved
  db.close();
});

test('a model-invented basisPct is repaired to the code value before caching', async () => {
  const db = new DB(':memory:');
  const lying = clean();
  lying.suggestedAction = { option: 'Trim ~40%.', basisPct: 40 };
  const provider = new MockProvider(lying);

  const res = await narrate(input({ suggestedTrimPct: 15 }), deps(db, provider));
  assert.equal(res.narration.suggestedAction.basisPct, 15);
  assert.ok(res.repairs.some((r) => r.includes('basisPct mismatch')));
  db.close();
});
