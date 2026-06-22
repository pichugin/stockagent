import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SignalRow } from '../db.js';
import { renderDashboard } from './render.js';
import type { DashboardSnapshot } from './snapshot.js';

const ESC = '\x1b';

function actionableRow(): SignalRow {
  return {
    id: 1,
    symbol: 'AAPL',
    kind: 'threshold',
    code: 'price_at_or_above_sell',
    severity: 'actionable',
    summary: 'Latest close 200 USD is at or above your sell-above level of 190 USD',
    data: '{}',
    firedAt: '2024-06-01T14:00:00.000Z',
    clearedAt: null,
    active: 1,
    notifiedAt: '2024-06-01T14:00:00.000Z',
  };
}

function snapshot(): DashboardSnapshot {
  return {
    generatedAt: '2024-06-01T14:00:00.000Z',
    marketOpen: true,
    lastPoll: Date.parse('2024-06-01T14:00:00.000Z'),
    fx: { rate: 1.37, asOf: '2024-05-31', stale: true },
    rows: [
      {
        symbol: 'AAPL',
        held: true,
        currency: 'USD',
        close: 200,
        closeAsOf: Date.parse('2024-06-01T13:59:00.000Z'),
        shares: 10,
        marketValueCad: 2740,
        unrealizedPnlCad: 274,
        signals: { actionable: 1, notable: 0, info: 0 },
      },
      {
        symbol: 'SHOP.TO',
        held: false,
        currency: 'CAD',
        close: 80,
        closeAsOf: Date.parse('2024-06-01T13:59:00.000Z'),
        shares: null,
        marketValueCad: null,
        unrealizedPnlCad: null,
        signals: { actionable: 0, notable: 1, info: 0 },
      },
    ],
    totalCad: 2740,
    totalPartial: false,
    recentActionable: [actionableRow()],
  };
}

test('plain (non-TTY) render contains no ANSI escapes', () => {
  const out = renderDashboard(snapshot(), { color: false });
  assert.ok(!out.includes(ESC), 'plain output must not contain ANSI escape codes');
});

test('plain render shows held/watch markers, CAD total, stale FX, and actionable star', () => {
  const out = renderDashboard(snapshot(), { color: false });
  assert.ok(out.includes('●'), 'held marker present');
  assert.ok(out.includes('·'), 'watch-only marker present');
  assert.ok(out.includes('2740.00 CAD'), 'CAD total present');
  assert.ok(out.includes('STALE'), 'stale FX flag surfaced');
  assert.ok(out.includes('★'), 'actionable signal highlighted with a star');
  assert.ok(out.includes('last cached close'), 'honesty: as-of-last-close framing present');
  assert.ok(out.includes('signal, not advice'), 'framing carried into the dashboard');
});

test('color render emits ANSI but stays structurally consistent', () => {
  const out = renderDashboard(snapshot(), { color: true });
  assert.ok(out.includes(ESC), 'color output uses ANSI');
  assert.ok(out.includes('AAPL'));
  assert.ok(out.includes('SHOP.TO'));
});
