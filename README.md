# StockAgent — Phases 1–2 (data, storage & portfolio)

A personal stock monitoring agent for macOS (CLI-first).

- **Phase 1** is the data foundation: it polls a watchlist every minute and
  caches OHLCV bars in SQLite across US (Alpaca) and TSX (`yahoo-finance2`)
  symbols.
- **Phase 2** adds a **portfolio layer** — record what you actually hold via CLI
  subcommands, stored in SQLite behind a backend-agnostic `PortfolioProvider`
  interface (so a future auto-sync backend can drop in). Held symbols are also
  polled for bars, even if they aren't in `watchlist.yaml`.

No FX conversion, live prices, signals, notifications, or LLM yet (later phases).

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

`start` polls the **union of watchlist symbols and held positions**
(de-duplicated), so anything in your portfolio gets bars even if it isn't in
`watchlist.yaml`.

## Portfolio

Record what you hold. Amounts are in each position's **native currency** — there
is no FX conversion or cross-currency total in this phase, so `show` reports
per-currency cost-basis subtotals only.

```bash
# Add (or overwrite) a position. Currency: explicit --cad/--usd wins; otherwise
# it's inferred (.TO -> CAD, else USD).
node dist/index.js add AAPL 10 --cost 180 --usd
node dist/index.js add SHOP.TO 50 --cost 95 --cad
node dist/index.js add ENB.TO 100 --cost 50            # infers CAD
node dist/index.js add MSFT 3 --cost 400               # infers USD
node dist/index.js add AAPL 10 --cost 180 --usd --note "long-term"

# Partially update an existing position (only the fields you pass)
node dist/index.js edit AAPL --shares 12
node dist/index.js edit AAPL --cost 175 --note "added on dip"

# List all positions (symbol, shares, avg cost, currency, cost basis, …)
node dist/index.js show

# Remove a position
node dist/index.js remove SHOP.TO
```

- **`add`** is a full upsert: re-adding an existing symbol overwrites it (with a
  warning) and keeps the original `dateAdded`. Shares must be `> 0`, cost `>= 0`.
- **`edit`** only touches the fields you pass and never creates — editing a
  symbol you don't hold is an error.
- Symbols are upper-cased on input (`aapl` == `AAPL`); the `.TO` suffix is kept.
- Adding a position also registers its routing metadata, so it starts getting
  polled on the next `start`.

## Storage

Data is stored in `stockagent.db` (override with `STOCKAGENT_DB`):

- `bars(symbol, timestamp, open, high, low, close, volume)` with a
  `UNIQUE(symbol, timestamp)` constraint, so re-fetches **upsert** rather than
  duplicate.
- `symbols(symbol, exchange, currency, last_fetch)` for watchlist metadata and
  per-symbol last-fetch tracking.
- `positions(symbol, shares, avg_cost, currency, date_added, note)` for held
  positions (`symbol` is the primary key — one position per symbol).

Timestamps are epoch-milliseconds (UTC).

## Project layout

```
src/
  index.ts            commander setup, wires subcommands
  config.ts           load + zod-validate watchlist.yaml
  db.ts               better-sqlite3 schema + prepared statements
  poll.ts             per-minute fetch+upsert cycle, market-hours check
  symbols.ts          symbol normalization + exchange/currency inference
  table.ts            tiny fixed-width table renderer
  util.ts             logging, sleep, retry-with-backoff
  providers/
    types.ts          common Provider interface (getRecentBars)
    alpaca.ts         US bars (Alpaca IEX feed)
    yahoo.ts          TSX + key-less fallback (yahoo-finance2)
    index.ts          routes a symbol to the right provider
  portfolio/
    PortfolioProvider.ts      backend-agnostic portfolio interface + Position
    SqlitePortfolioProvider.ts  v1 SQLite-backed implementation
  commands/
    start.ts  bars.ts  status.ts  portfolio.ts
```
