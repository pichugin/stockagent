import type { DB, PositionRow } from '../db.js';
import { normalizeSymbol } from '../symbols.js';
import type {
  Currency,
  PortfolioProvider,
  Position,
  PositionInput,
} from './PortfolioProvider.js';

function rowToPosition(row: PositionRow): Position {
  return {
    symbol: row.symbol,
    shares: row.shares,
    avgCost: row.avgCost,
    currency: row.currency as Currency,
    dateAdded: row.dateAdded,
    ...(row.note != null ? { note: row.note } : {}),
  };
}

/**
 * v1 portfolio backend: holdings live in the shared SQLite `positions` table.
 * Reuses the single app-wide `DB` connection rather than opening its own.
 */
export class SqlitePortfolioProvider implements PortfolioProvider {
  constructor(private readonly db: DB) {}

  async list(): Promise<Position[]> {
    return this.db.listPositions().map(rowToPosition);
  }

  async get(symbol: string): Promise<Position | null> {
    const row = this.db.getPosition(normalizeSymbol(symbol));
    return row ? rowToPosition(row) : null;
  }

  async upsert(p: PositionInput): Promise<Position> {
    const symbol = normalizeSymbol(p.symbol);
    // Re-adding an existing position keeps its original dateAdded unless the
    // caller explicitly supplies one.
    const existing = this.db.getPosition(symbol);
    const dateAdded = p.dateAdded ?? existing?.dateAdded ?? new Date().toISOString();

    const row: PositionRow = {
      symbol,
      shares: p.shares,
      avgCost: p.avgCost,
      currency: p.currency,
      dateAdded,
      note: p.note ?? null,
    };
    this.db.upsertPosition(row);
    return rowToPosition(row);
  }

  async remove(symbol: string): Promise<boolean> {
    return this.db.deletePosition(normalizeSymbol(symbol));
  }
}
