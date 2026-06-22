import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DB } from '../db.js';
import { persistSignals } from './engine.js';
import type { Signal } from './types.js';

const NOW = '2024-06-01T00:00:00.000Z';
const LATER = '2024-06-01T00:05:00.000Z';
const LATER2 = '2024-06-01T00:10:00.000Z';

function sig(symbol: string, code: string, firedAt = NOW): Signal {
  return {
    symbol,
    kind: 'technical',
    code,
    severity: 'notable',
    summary: `${symbol} ${code}`,
    data: { x: 1 },
    firedAt,
  };
}

/** Run a callback with a throwaway on-disk DB, cleaned up afterward. */
function withTempDb(fn: (db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'stockagent-test-'));
  const db = new DB(join(dir, 'test.db'));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('dedup: a condition that stays true keeps exactly one active signal', () => {
  withTempDb((db) => {
    const a = sig('AAPL', 'rsi_oversold');
    const b = sig('AAPL', 'price_below_lower_band');

    const r1 = persistSignals(db, [a, b], NOW);
    assert.deepEqual({ fired: r1.fired, kept: r1.kept, cleared: r1.cleared }, { fired: 2, kept: 0, cleared: 0 });
    assert.equal(db.activeSignals().length, 2);

    // Same conditions, twice more → no re-fire, still two active rows.
    persistSignals(db, [a, b], LATER);
    const r3 = persistSignals(db, [a, b], LATER2);
    assert.equal(r3.fired, 0);
    assert.equal(r3.kept, 2);
    assert.equal(db.activeSignals().length, 2);
  });
});

test('dedup: clearing then re-triggering records a fresh fire', () => {
  withTempDb((db) => {
    const a = sig('AAPL', 'rsi_oversold');
    const b = sig('AAPL', 'price_below_lower_band');
    persistSignals(db, [a, b], NOW);
    const firstActive = db.activeSignals().sort((x, y) => x.code.localeCompare(y.code));

    // b's condition clears.
    const r2 = persistSignals(db, [a], LATER);
    assert.equal(r2.cleared, 1);
    assert.equal(db.activeSignals().length, 1);

    // b re-triggers → a brand-new active row (new id), a stays the original.
    // Each scan re-stamps firedAt (as computeSignals does), so the re-fire
    // carries the new scan time.
    const r3 = persistSignals(db, [a, sig('AAPL', 'price_below_lower_band', LATER2)], LATER2);
    assert.equal(r3.fired, 1);
    const active = db.activeSignals();
    assert.equal(active.length, 2);
    const aRow = active.find((r) => r.code === 'rsi_oversold')!;
    const bRow = active.find((r) => r.code === 'price_below_lower_band')!;
    assert.equal(aRow.firedAt, NOW); // untouched original
    assert.equal(bRow.firedAt, LATER2); // fresh fire after clearing
    assert.notEqual(bRow.id, firstActive.find((r) => r.code === 'price_below_lower_band')!.id);

    // History retains both the cleared and the re-fired b rows.
    const history = db.signalHistory(50, 'AAPL');
    assert.equal(history.filter((r) => r.code === 'price_below_lower_band').length, 2);
  });
});

test('dedup: duplicate (symbol, code) within one scan never double-inserts', () => {
  withTempDb((db) => {
    const a = sig('AAPL', 'rsi_oversold');
    const r = persistSignals(db, [a, a], NOW);
    assert.equal(r.fired, 1);
    assert.equal(db.activeSignals().length, 1);
  });
});
