# StockAgent — Phase 1 (data + storage)

A personal stock monitoring agent for macOS (CLI-first). **Phase 1** is the data
foundation only: it polls a watchlist every minute and caches OHLCV bars in
SQLite across US (Alpaca) and TSX (`yahoo-finance2`) symbols. No signals,
portfolio, FX, notifications, or LLM yet.

## Requirements

- Node 20+ (developed on Node 22)
- macOS (or any platform Node + `better-sqlite3` build on)

## Setup

```bash
npm install
cp .env.example .env   # then fill in Alpaca keys (optional — see below)
npm run build
```

### Credentials (optional)

US symbols use **Alpaca** when `ALPACA_KEY` / `ALPACA_SECRET` are set in `.env`
(free tier, IEX feed). **If they're absent, US symbols fall back to
`yahoo-finance2`**, so the app runs fully without an Alpaca account. TSX (`.TO`)
symbols always use `yahoo-finance2`. Secrets live in `.env` (git-ignored) and are
never committed.

## Watchlist

Edit `watchlist.yaml`. Each entry needs `symbol`, `exchange` (`US` | `TSX`), and
`currency` (`USD` | `CAD`). Use the Yahoo `.TO` suffix for TSX symbols:

```yaml
symbols:
  - symbol: AAPL
    exchange: US
    currency: USD
  - symbol: SHOP.TO
    exchange: TSX
    currency: CAD
```

The config is validated with `zod` on load; a malformed file fails loudly.

## Usage

After `npm run build`, run via `node dist/index.js <cmd>` (or `npx stockagent
<cmd>` / link the bin). During development, `npm run dev -- <cmd>` runs the
TypeScript directly via `tsx`.

```bash
# Poll every minute (skips when markets appear closed; Ctrl-C to stop)
node dist/index.js start

# Useful flags:
node dist/index.js start --once          # run a single cycle and exit
node dist/index.js start --force         # poll even when markets are closed
node dist/index.js start --limit 10      # fetch 10 bars/symbol/cycle

# Inspect stored data
node dist/index.js bars AAPL --limit 5
node dist/index.js bars SHOP.TO --limit 5
node dist/index.js status
```

`start` runs one cycle immediately, then schedules a per-minute `node-cron` job.
A provider/network/rate-limit error for one symbol is caught, logged, and
retried with backoff — it never crashes the loop or blocks other symbols.

## Storage

Data is stored in `stockagent.db` (override with `STOCKAGENT_DB`):

- `bars(symbol, timestamp, open, high, low, close, volume)` with a
  `UNIQUE(symbol, timestamp)` constraint, so re-fetches **upsert** rather than
  duplicate.
- `symbols(symbol, exchange, currency, last_fetch)` for watchlist metadata and
  per-symbol last-fetch tracking.

Timestamps are epoch-milliseconds (UTC).

## Project layout

```
src/
  index.ts            commander setup, wires subcommands
  config.ts           load + zod-validate watchlist.yaml
  db.ts               better-sqlite3 schema + prepared statements
  poll.ts             per-minute fetch+upsert cycle, market-hours check
  table.ts            tiny fixed-width table renderer
  util.ts             logging, sleep, retry-with-backoff
  providers/
    types.ts          common Provider interface (getRecentBars)
    alpaca.ts         US bars (Alpaca IEX feed)
    yahoo.ts          TSX + key-less fallback (yahoo-finance2)
    index.ts          routes a symbol to the right provider
  commands/
    start.ts  bars.ts  status.ts
```
