import type { BarData, GetRecentBarsOpts, Provider } from './types.js';

const DATA_BASE = 'https://data.alpaca.markets/v2';

/** Look-back window wide enough to span a long weekend (markets-closed). */
const LOOKBACK_MS = 5 * 24 * 60 * 60_000;

export function hasAlpacaCredentials(): boolean {
  return Boolean(process.env.ALPACA_KEY && process.env.ALPACA_SECRET);
}

interface AlpacaBar {
  t: string; // RFC-3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[] | null;
  next_page_token?: string | null;
}

/**
 * Alpaca market-data provider for US equities. Uses the free IEX feed and the
 * 1-minute `bars` endpoint. Requires ALPACA_KEY / ALPACA_SECRET in the env.
 */
export const alpacaProvider: Provider = {
  name: 'alpaca',

  async getRecentBars(symbol: string, opts: GetRecentBarsOpts = {}): Promise<BarData[]> {
    if (!hasAlpacaCredentials()) {
      throw new Error('ALPACA_KEY / ALPACA_SECRET are not set');
    }
    const limit = Math.max(1, opts.limit ?? 5);

    // `sort=desc` + `limit` make Alpaca return only the newest `limit` bars, so
    // a wide start window is cheap and lets us still pick up the last session's
    // bars when markets are closed (e.g. weekends).
    const start = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const url =
      `${DATA_BASE}/stocks/${encodeURIComponent(symbol)}/bars` +
      `?timeframe=1Min&feed=iex&sort=desc&limit=${limit}&start=${encodeURIComponent(start)}`;

    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': process.env.ALPACA_KEY!,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET!,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Alpaca ${res.status} ${res.statusText} for ${symbol}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    const data = (await res.json()) as AlpacaBarsResponse;
    const bars = data.bars ?? [];
    return bars.map((b) => ({
      timestamp: Date.parse(b.t),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  },
};
