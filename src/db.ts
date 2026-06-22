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
    `);
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

  close(): void {
    this.db.close();
  }
}
