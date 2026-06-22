import Database from 'better-sqlite3';
import type { SymbolConfig } from './config.js';

export interface BarRow {
  symbol: string;
  /** Bar open time, epoch milliseconds (UTC). */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolStatus {
  symbol: string;
  exchange: string;
  currency: string;
  lastFetch: number | null;
  barCount: number;
}

/**
 * Storage shape of a held position (camelCase, mapped from snake_case columns).
 * Kept separate from the portfolio layer's `Position` so SQLite specifics never
 * leak into the backend-agnostic `PortfolioProvider` interface.
 */
export interface PositionRow {
  symbol: string;
  shares: number;
  avgCost: number;
  currency: string;
  dateAdded: string;
  note: string | null;
  /**
   * Canonical USD→CAD rate snapshotted when the position was added, enabling an
   * exact underlying-vs-FX decomposition of its cost basis. Null for legacy
   * rows added before the snapshot existed (FX split unavailable for those).
   */
  fxAtCost: number | null;
}

/** A cached daily FX observation (canonical USD→CAD direction only). */
export interface FxRateRow {
  date: string; // ISO date YYYY-MM-DD (primary key)
  rate: number; // 1 USD = `rate` CAD
  source: string;
  fetchedAt: string; // ISO timestamp
}

export function dbPath(): string {
  return process.env.STOCKAGENT_DB ?? 'stockagent.db';
}

/**
 * Thin wrapper over better-sqlite3 holding the schema and prepared statements.
 * Timestamps are stored as epoch-ms integers; (symbol, timestamp) is UNIQUE so
 * re-fetched bars upsert in place rather than duplicating.
 */
export class DB {
  private readonly db: Database.Database;

  private readonly stmtUpsertBar: Database.Statement;
  private readonly stmtRecentBars: Database.Statement;
  private readonly stmtCountBarsForSymbol: Database.Statement;
  private readonly stmtCountBarsTotal: Database.Statement;
  private readonly stmtUpsertSymbol: Database.Statement;
  private readonly stmtMarkFetched: Database.Statement;
  private readonly stmtSymbolStatuses: Database.Statement;
  private readonly stmtGetSymbol: Database.Statement;
  private readonly stmtUpsertPosition: Database.Statement;
  private readonly stmtGetPosition: Database.Statement;
  private readonly stmtListPositions: Database.Statement;
  private readonly stmtDeletePosition: Database.Statement;
  private readonly stmtUpsertFxRate: Database.Statement;
  private readonly stmtLatestFxRate: Database.Statement;
  private readonly stmtGetFxRate: Database.Statement;

  constructor(path: string = dbPath()) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();

    this.stmtUpsertBar = this.db.prepare(
      `INSERT INTO bars (symbol, timestamp, open, high, low, close, volume)
       VALUES (@symbol, @timestamp, @open, @high, @low, @close, @volume)
       ON CONFLICT(symbol, timestamp) DO UPDATE SET
         open = excluded.open,
         high = excluded.high,
         low = excluded.low,
         close = excluded.close,
         volume = excluded.volume`,
    );
    this.stmtRecentBars = this.db.prepare(
      `SELECT symbol, timestamp, open, high, low, close, volume
       FROM bars WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?`,
    );
    this.stmtCountBarsForSymbol = this.db.prepare(
      `SELECT COUNT(*) AS n FROM bars WHERE symbol = ?`,
    );
    this.stmtCountBarsTotal = this.db.prepare(`SELECT COUNT(*) AS n FROM bars`);
    this.stmtUpsertSymbol = this.db.prepare(
      `INSERT INTO symbols (symbol, exchange, currency)
       VALUES (@symbol, @exchange, @currency)
       ON CONFLICT(symbol) DO UPDATE SET
         exchange = excluded.exchange,
         currency = excluded.currency`,
    );
    this.stmtMarkFetched = this.db.prepare(
      `UPDATE symbols SET last_fetch = ? WHERE symbol = ?`,
    );
    this.stmtSymbolStatuses = this.db.prepare(
      `SELECT s.symbol AS symbol,
              s.exchange AS exchange,
              s.currency AS currency,
              s.last_fetch AS lastFetch,
              (SELECT COUNT(*) FROM bars b WHERE b.symbol = s.symbol) AS barCount
       FROM symbols s ORDER BY s.symbol`,
    );
    this.stmtGetSymbol = this.db.prepare(
      `SELECT symbol, exchange, currency FROM symbols WHERE symbol = ?`,
    );

    this.stmtUpsertPosition = this.db.prepare(
      `INSERT INTO positions (symbol, shares, avg_cost, currency, date_added, note, fx_at_cost)
       VALUES (@symbol, @shares, @avgCost, @currency, @dateAdded, @note, @fxAtCost)
       ON CONFLICT(symbol) DO UPDATE SET
         shares      = excluded.shares,
         avg_cost    = excluded.avg_cost,
         currency    = excluded.currency,
         date_added  = excluded.date_added,
         note        = excluded.note,
         fx_at_cost  = excluded.fx_at_cost`,
    );
    this.stmtGetPosition = this.db.prepare(
      `SELECT symbol, shares, avg_cost AS avgCost, currency, date_added AS dateAdded,
              note, fx_at_cost AS fxAtCost
       FROM positions WHERE symbol = ?`,
    );
    this.stmtListPositions = this.db.prepare(
      `SELECT symbol, shares, avg_cost AS avgCost, currency, date_added AS dateAdded,
              note, fx_at_cost AS fxAtCost
       FROM positions ORDER BY symbol`,
    );
    this.stmtDeletePosition = this.db.prepare(`DELETE FROM positions WHERE symbol = ?`);

    this.stmtUpsertFxRate = this.db.prepare(
      `INSERT INTO fx_rates (date, rate, source, fetched_at)
       VALUES (@date, @rate, @source, @fetchedAt)
       ON CONFLICT(date) DO UPDATE SET
         rate       = excluded.rate,
         source     = excluded.source,
         fetched_at = excluded.fetched_at`,
    );
    this.stmtLatestFxRate = this.db.prepare(
      `SELECT date, rate, source, fetched_at AS fetchedAt
       FROM fx_rates ORDER BY date DESC LIMIT 1`,
    );
    this.stmtGetFxRate = this.db.prepare(
      `SELECT date, rate, source, fetched_at AS fetchedAt FROM fx_rates WHERE date = ?`,
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        symbol     TEXT PRIMARY KEY,
        exchange   TEXT NOT NULL,
        currency   TEXT NOT NULL,
        last_fetch INTEGER
      );

      CREATE TABLE IF NOT EXISTS bars (
        symbol    TEXT    NOT NULL,
        timestamp INTEGER NOT NULL,
        open      REAL    NOT NULL,
        high      REAL    NOT NULL,
        low       REAL    NOT NULL,
        close     REAL    NOT NULL,
        volume    REAL    NOT NULL,
        UNIQUE (symbol, timestamp)
      );

      CREATE INDEX IF NOT EXISTS idx_bars_symbol_ts
        ON bars (symbol, timestamp DESC);

      CREATE TABLE IF NOT EXISTS positions (
        symbol     TEXT PRIMARY KEY,
        shares     REAL NOT NULL,
        avg_cost   REAL NOT NULL,
        currency   TEXT NOT NULL,
        date_added TEXT NOT NULL,
        note       TEXT,
        fx_at_cost REAL
      );

      CREATE TABLE IF NOT EXISTS fx_rates (
        date       TEXT PRIMARY KEY,   -- ISO date YYYY-MM-DD
        rate       REAL NOT NULL,      -- 1 USD = rate CAD (canonical direction)
        source     TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);

    // Backfill fx_at_cost for DBs created before Phase 3. ADD COLUMN is a no-op
    // to express conditionally, so we probe the column list first.
    const cols = this.db.prepare(`PRAGMA table_info(positions)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'fx_at_cost')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN fx_at_cost REAL`);
    }
  }

  /** Insert/update the watchlist metadata for a symbol. */
  upsertSymbol(meta: SymbolConfig): void {
    this.stmtUpsertSymbol.run(meta);
  }

  /** Upsert a batch of bars in a single transaction. Returns rows written. */
  upsertBars(bars: BarRow[]): number {
    if (bars.length === 0) return 0;
    const txn = this.db.transaction((rows: BarRow[]) => {
      for (const row of rows) this.stmtUpsertBar.run(row);
      return rows.length;
    });
    return txn(bars);
  }

  markFetched(symbol: string, at: number): void {
    this.stmtMarkFetched.run(at, symbol);
  }

  getRecentBars(symbol: string, limit: number): BarRow[] {
    return this.stmtRecentBars.all(symbol, limit) as BarRow[];
  }

  countBars(symbol?: string): number {
    const row = symbol
      ? (this.stmtCountBarsForSymbol.get(symbol) as { n: number })
      : (this.stmtCountBarsTotal.get() as { n: number });
    return row.n;
  }

  symbolStatuses(): SymbolStatus[] {
    return this.stmtSymbolStatuses.all() as SymbolStatus[];
  }

  /** Read a single symbol's routing metadata, or null if not tracked yet. */
  getSymbol(symbol: string): SymbolConfig | null {
    return (this.stmtGetSymbol.get(symbol) as SymbolConfig | undefined) ?? null;
  }

  upsertPosition(row: PositionRow): void {
    this.stmtUpsertPosition.run(row);
  }

  getPosition(symbol: string): PositionRow | null {
    return (this.stmtGetPosition.get(symbol) as PositionRow | undefined) ?? null;
  }

  listPositions(): PositionRow[] {
    return this.stmtListPositions.all() as PositionRow[];
  }

  /** Delete a position; returns true if a row was actually removed. */
  deletePosition(symbol: string): boolean {
    return this.stmtDeletePosition.run(symbol).changes > 0;
  }

  /** Upsert a daily FX rate; re-fetching the same date overwrites in place. */
  upsertFxRate(row: FxRateRow): void {
    this.stmtUpsertFxRate.run(row);
  }

  /** Most recently dated cached FX rate, or null if none cached yet. */
  latestFxRate(): FxRateRow | null {
    return (this.stmtLatestFxRate.get() as FxRateRow | undefined) ?? null;
  }

  /** The cached FX rate for a specific ISO date, or null. */
  getFxRate(date: string): FxRateRow | null {
    return (this.stmtGetFxRate.get(date) as FxRateRow | undefined) ?? null;
  }

  close(): void {
    this.db.close();
  }
}
