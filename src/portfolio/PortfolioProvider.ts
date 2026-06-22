export type Currency = 'USD' | 'CAD';

/** A single held position, in the position's native currency. */
export interface Position {
  symbol: string; // e.g. "AAPL", "SHOP.TO"
  shares: number; // fractional allowed (Wealthsimple supports fractional shares)
  avgCost: number; // per-share, in the position's native currency
  currency: Currency;
  dateAdded: string; // ISO 8601
  note?: string;
}

/** Shape accepted by `upsert`: `dateAdded` is optional (defaulted/preserved). */
export type PositionInput = Omit<Position, 'dateAdded'> & { dateAdded?: string };

/**
 * Backend-agnostic portfolio store. The rest of the app depends only on this
 * interface, never on how holdings are persisted — so a future auto-sync
 * backend (Wealthsimple `ws-api` or SnapTrade REST) can drop in unchanged.
 *
 * Methods are async even though the v1 SQLite backend is synchronous, so an
 * HTTP-backed provider fits the same signatures later.
 */
export interface PortfolioProvider {
  list(): Promise<Position[]>;
  get(symbol: string): Promise<Position | null>;
  upsert(p: PositionInput): Promise<Position>;
  remove(symbol: string): Promise<boolean>;
}
