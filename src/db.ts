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

/**
 * A persisted signal. `data` is the JSON-encoded `Signal.data`. `active` tracks
 * dedup state: while a condition stays continuously true we keep ONE active row
 * (`active = 1`, `clearedAt = null`); when it stops being true we set
 * `active = 0` and stamp `clearedAt`, so a later re-trigger records a fresh fire.
 */
export interface SignalRow {
  id: number;
  symbol: string;
  kind: string;
  code: string;
  severity: string;
  summary: string;
  data: string; // JSON-encoded Signal.data
  firedAt: string; // ISO
  clearedAt: string | null; // ISO, null while active
  active: number; // 1 = active, 0 = cleared
  /**
   * Phase 5: ISO timestamp a native notification was dispatched for this fire,
   * or null if not (yet) notified. Set only on the active-edge of an
   * `actionable` signal, so a notification fires exactly once per fire and never
   * re-fires while the condition stays continuously true. A re-trigger after a
   * clear inserts a fresh row (notified_at NULL), so it can notify again.
   */
  notifiedAt: string | null;
}

/** A user-defined price alert, in the symbol's native currency. */
export interface AlertRow {
  symbol: string;
  buyBelow: number | null;
  sellAbove: number | null;
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
  private readonly stmtInsertSignal: Database.Statement;
  private readonly stmtActiveSignals: Database.Statement;
  private readonly stmtActiveSignalsForSymbol: Database.Statement;
  private readonly stmtClearSignal: Database.Statement;
  private readonly stmtSignalHistory: Database.Statement;
  private readonly stmtSignalHistoryForSymbol: Database.Statement;
  private readonly stmtPendingNotifications: Database.Statement;
  private readonly stmtMarkNotified: Database.Statement;
  private readonly stmtSuppressPendingNotifications: Database.Statement;
  private readonly stmtUpsertAlert: Database.Statement;
  private readonly stmtGetAlert: Database.Statement;
  private readonly stmtListAlerts: Database.Statement;
  private readonly stmtDeleteAlert: Database.Statement;

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

    this.stmtInsertSignal = this.db.prepare(
      `INSERT INTO signals (symbol, kind, code, severity, summary, data, fired_at, cleared_at, active)
       VALUES (@symbol, @kind, @code, @severity, @summary, @data, @firedAt, NULL, 1)`,
    );
    const signalCols =
      `id, symbol, kind, code, severity, summary, data,
       fired_at AS firedAt, cleared_at AS clearedAt, active, notified_at AS notifiedAt`;
    this.stmtActiveSignals = this.db.prepare(
      `SELECT ${signalCols} FROM signals WHERE active = 1 ORDER BY symbol, code`,
    );
    this.stmtActiveSignalsForSymbol = this.db.prepare(
      `SELECT ${signalCols} FROM signals WHERE active = 1 AND symbol = ? ORDER BY code`,
    );
    this.stmtClearSignal = this.db.prepare(
      `UPDATE signals SET active = 0, cleared_at = ? WHERE id = ?`,
    );
    this.stmtSignalHistory = this.db.prepare(
      `SELECT ${signalCols} FROM signals ORDER BY fired_at DESC, id DESC LIMIT ?`,
    );
    this.stmtSignalHistoryForSymbol = this.db.prepare(
      `SELECT ${signalCols} FROM signals WHERE symbol = ? ORDER BY fired_at DESC, id DESC LIMIT ?`,
    );

    // Notification candidates: active, actionable, and not yet notified. Only
    // these can ever push (the notification firewall against fatigue).
    this.stmtPendingNotifications = this.db.prepare(
      `SELECT ${signalCols} FROM signals
       WHERE active = 1 AND severity = 'actionable' AND notified_at IS NULL
       ORDER BY symbol, code`,
    );
    this.stmtMarkNotified = this.db.prepare(
      `UPDATE signals SET notified_at = ? WHERE id = ?`,
    );
    // Startup suppression: stamp every currently-pending actionable signal as
    // already-notified so a restart never replays a backlog of pushes.
    this.stmtSuppressPendingNotifications = this.db.prepare(
      `UPDATE signals SET notified_at = ?
       WHERE active = 1 AND severity = 'actionable' AND notified_at IS NULL`,
    );

    this.stmtUpsertAlert = this.db.prepare(
      `INSERT INTO alerts (symbol, buy_below, sell_above)
       VALUES (@symbol, @buyBelow, @sellAbove)
       ON CONFLICT(symbol) DO UPDATE SET
         buy_below  = excluded.buy_below,
         sell_above = excluded.sell_above`,
    );
    this.stmtGetAlert = this.db.prepare(
      `SELECT symbol, buy_below AS buyBelow, sell_above AS sellAbove FROM alerts WHERE symbol = ?`,
    );
    this.stmtListAlerts = this.db.prepare(
      `SELECT symbol, buy_below AS buyBelow, sell_above AS sellAbove FROM alerts ORDER BY symbol`,
    );
    this.stmtDeleteAlert = this.db.prepare(`DELETE FROM alerts WHERE symbol = ?`);
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

      CREATE TABLE IF NOT EXISTS signals (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol     TEXT    NOT NULL,
        kind       TEXT    NOT NULL,
        code       TEXT    NOT NULL,
        severity   TEXT    NOT NULL,
        summary    TEXT    NOT NULL,
        data        TEXT    NOT NULL,  -- JSON-encoded Signal.data
        fired_at    TEXT    NOT NULL,  -- ISO
        cleared_at  TEXT,              -- ISO, NULL while active
        active      INTEGER NOT NULL DEFAULT 1,
        notified_at TEXT               -- ISO, NULL until a push is dispatched
      );

      -- One active row per (symbol, code) is the dedup invariant the engine keeps.
      CREATE INDEX IF NOT EXISTS idx_signals_active
        ON signals (symbol, code, active);
      CREATE INDEX IF NOT EXISTS idx_signals_fired
        ON signals (fired_at DESC);

      CREATE TABLE IF NOT EXISTS alerts (
        symbol     TEXT PRIMARY KEY,
        buy_below  REAL,               -- fire when latest close <= this (native ccy)
        sell_above REAL                -- fire when latest close >= this (native ccy)
      );
    `);

    // Backfill fx_at_cost for DBs created before Phase 3. ADD COLUMN is a no-op
    // to express conditionally, so we probe the column list first.
    const cols = this.db.prepare(`PRAGMA table_info(positions)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'fx_at_cost')) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN fx_at_cost REAL`);
    }

    // Backfill notified_at for DBs created before Phase 5. Same conditional
    // ADD COLUMN dance as fx_at_cost above.
    const sigCols = this.db.prepare(`PRAGMA table_info(signals)`).all() as { name: string }[];
    if (!sigCols.some((c) => c.name === 'notified_at')) {
      this.db.exec(`ALTER TABLE signals ADD COLUMN notified_at TEXT`);
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

  /** Fire a new active signal. `data` must be a JSON string. Returns its id. */
  insertSignal(row: {
    symbol: string;
    kind: string;
    code: string;
    severity: string;
    summary: string;
    data: string;
    firedAt: string;
  }): number {
    return Number(this.stmtInsertSignal.run(row).lastInsertRowid);
  }

  /** Currently-active signals (optionally for one symbol). */
  activeSignals(symbol?: string): SignalRow[] {
    return (
      symbol
        ? this.stmtActiveSignalsForSymbol.all(symbol)
        : this.stmtActiveSignals.all()
    ) as SignalRow[];
  }

  /** Mark an active signal cleared (condition no longer true). */
  clearSignal(id: number, clearedAt: string): void {
    this.stmtClearSignal.run(clearedAt, id);
  }

  /** Most recent signals (active or cleared), newest first. */
  signalHistory(limit: number, symbol?: string): SignalRow[] {
    return (
      symbol
        ? this.stmtSignalHistoryForSymbol.all(symbol, limit)
        : this.stmtSignalHistory.all(limit)
    ) as SignalRow[];
  }

  /**
   * Signals eligible to push a native notification: active, `actionable`, and
   * not yet notified. The notify dispatcher consumes these and stamps
   * {@link markNotified} so each fire pushes at most once.
   */
  pendingNotifications(): SignalRow[] {
    return this.stmtPendingNotifications.all() as SignalRow[];
  }

  /** Record that a notification was dispatched for a signal fire. */
  markNotified(id: number, at: string): void {
    this.stmtMarkNotified.run(at, id);
  }

  /**
   * Startup suppression: mark every currently-pending actionable signal as
   * already-notified so re-running `start` doesn't replay a backlog of pushes.
   * Returns how many were suppressed.
   */
  suppressPendingNotifications(at: string): number {
    return this.stmtSuppressPendingNotifications.run(at).changes;
  }

  /** Insert/update a price alert. Pass null for an unset bound. */
  upsertAlert(row: AlertRow): void {
    this.stmtUpsertAlert.run(row);
  }

  getAlert(symbol: string): AlertRow | null {
    return (this.stmtGetAlert.get(symbol) as AlertRow | undefined) ?? null;
  }

  listAlerts(): AlertRow[] {
    return this.stmtListAlerts.all() as AlertRow[];
  }

  /** Delete an alert; returns true if a row was actually removed. */
  deleteAlert(symbol: string): boolean {
    return this.stmtDeleteAlert.run(symbol).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
