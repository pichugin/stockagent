export type Currency = 'USD' | 'CAD';

/** A single held position, in the position's native currency. */
export interface Position {
  symbol: string; // e.g. "AAPL", "SHOP.TO"
  shares: number; // fractional allowed (Wealthsimple supports fractional shares)
  avgCost: number; // per-share, in the position's native currency
  currency: Currency;
  dateAdded: string; // ISO 8601
  note?: string;
  /**
   * Canonical USD→CAD rate captured when the position was added, so the cost
   * basis can be decomposed into underlying vs FX. For CAD positions this is 1
   * (FX is a no-op). Null for legacy rows added before snapshots existed — the
   * FX split is then reported as unavailable rather than guessed.
   */
  fxAtCost?: number | null;
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
