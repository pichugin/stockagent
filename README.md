# StockAgent — Phases 1–3 (data, storage, portfolio & FX)

A personal stock monitoring agent for macOS (CLI-first). Home currency is **CAD**.

- **Phase 1** is the data foundation: it polls a watchlist every minute and
  caches OHLCV bars in SQLite across US (Alpaca) and TSX (`yahoo-finance2`)
  symbols.
- **Phase 2** adds a **portfolio layer** — record what you actually hold via CLI
  subcommands, stored in SQLite behind a backend-agnostic `PortfolioProvider`
  interface (so a future auto-sync backend can drop in). Held symbols are also
  polled for bars, even if they aren't in `watchlist.yaml`.
- **Phase 3** adds the **FX / currency layer** — fetches and caches a daily
  CAD↔USD rate, normalizes the portfolio's cost basis to CAD, and decomposes a
  USD position's CAD cost basis into underlying-vs-FX components. See
  [FX & currency](#fx--currency).

Still **no live market prices, unrealized P&L, signals, notifications, or LLM**
(later phases). Phase 3 converts *cost basis and stored figures only* — it does
not introduce live P&L.

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

### Preferences (optional)

An optional `preferences` block carries user knobs:

```yaml
preferences:
  cadBias: 0        # range [-1, 1]; 0 neutral, >0 favours CAD, <0 favours USD
symbols:
  - symbol: AAPL
    exchange: US
    currency: USD
```

`cadBias` is **parsed and validated only** in this phase — it's a stub the later
signal layer will read to tilt ranking toward/away from CAD exposure. Nothing
acts on it yet. An out-of-range value fails loudly on load.

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

Record what you hold. Amounts are in each position's **native currency**. `show`
reports per-currency native subtotals **and** a CAD-normalized view (see
[FX & currency](#fx--currency)).

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
- **`add` snapshots the USD→CAD rate at cost basis** into `fx_at_cost` (1 for
  CAD positions), so the cost basis can later be split into underlying-vs-FX
  components. If FX is entirely unavailable when adding a USD position, the
  snapshot is stored as `NULL` and that position reports its FX split as `n/a`
  rather than guessing. `edit` preserves the original snapshot.

## FX & currency

The home currency is **CAD**. StockAgent fetches and caches a **daily USD→CAD
rate** (via `yahoo-finance2`'s `CAD=X` quote — no extra API key) and uses it to
express cost basis in CAD.

```bash
# Show the cached USD↔CAD rate, its as-of date, source, and staleness
node dist/index.js fx

# Force a fresh fetch and update the cache
node dist/index.js fx --refresh
```

Only the **canonical USD→CAD** direction is stored; CAD→USD is derived as
`1/rate` and the identity pairs as `1`, so the two directions can never drift.
Re-fetching on the same day **upserts** (one row per date). `start` refreshes FX
once at launch and then daily, on a cadence separate from the per-minute bar
polling, so a slow/failed FX fetch never blocks bar collection.

**Staleness is surfaced, never hidden.** A rate is flagged ⚠ STALE when it isn't
dated today, or when a refresh fails and StockAgent falls back to the last cached
rate. Portfolio reads never block on a live FX call — they read from cache.

`show` adds a **CAD-normalized cost-basis** view:

- the current-rate CAD value of each position's cost basis;
- for USD positions with a known `fx_at_cost`, the **underlying-vs-FX split** of
  the cost-basis conversion — `FX Δ (CAD)` is how much the CAD value of the cost
  basis has moved purely because USD/CAD shifted since purchase (labelled
  *approximate*; the underlying-move term arrives once live prices are wired in);
- CAD positions show a zero FX component and convert trivially;
- a **CAD grand total** across all positions, labelled with the rate's as-of date.

> **Wealthsimple FX-spread caveat:** these figures use the *market* FX rate.
> Wealthsimple applies its own FX spread on USD trades, so your real CAD cost
> differs slightly. StockAgent deliberately doesn't model that spread — it just
> avoids implying false precision. This footnote appears on CAD-normalized output.

## Storage

Data is stored in `stockagent.db` (override with `STOCKAGENT_DB`):

- `bars(symbol, timestamp, open, high, low, close, volume)` with a
  `UNIQUE(symbol, timestamp)` constraint, so re-fetches **upsert** rather than
  duplicate.
- `symbols(symbol, exchange, currency, last_fetch)` for watchlist metadata and
  per-symbol last-fetch tracking.
- `positions(symbol, shares, avg_cost, currency, date_added, note, fx_at_cost)`
  for held positions (`symbol` is the primary key — one position per symbol).
  `fx_at_cost` is the canonical USD→CAD rate snapshotted at add time (nullable;
  legacy rows are migrated in with `NULL`).
- `fx_rates(date, rate, source, fetched_at)` caches the daily USD→CAD rate
  (`date` is the primary key — one row per day, re-fetches upsert).

Timestamps are epoch-milliseconds (UTC); FX `date` is an ISO calendar day.

## Tests

Pure FX conversion/decomposition logic has unit tests (no network needed):

```bash
npm test     # node --test via tsx over src/**/*.test.ts
```

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
  fx/
    types.ts          FxRate / FxProvider interfaces
    convert.ts        pure Money/convert/toCAD + cost-basis decomposition
    convert.test.ts   unit tests for the conversion + decomposition math
    YahooFxProvider.ts  USD→CAD rate via yahoo-finance2 (CAD=X), sanity-checked
    FxService.ts      cache lifecycle + honest staleness
    notes.ts          shared Wealthsimple FX-spread footnote
  commands/
    start.ts  bars.ts  status.ts  portfolio.ts  fx.ts
  scripts/
    smokeAlpaca.ts    one-off live Alpaca bars smoke test
```

## Smoke test: live Alpaca bars

The Alpaca bars path has been untested since Phase 1. To verify it live:

```bash
# 1. Put real credentials in .env:
#      ALPACA_KEY=...
#      ALPACA_SECRET=...
# 2. Run the smoke test (defaults to AAPL; pass a symbol to override):
npm run smoke:alpaca
npm run smoke:alpaca -- MSFT
```

With keys present it fetches through Alpaca and asserts the returned bars match
the documented OHLCV shape (numeric `t/o/h/l/c/v`, positive timestamp). **Without
keys it says so clearly and exercises the `yahoo-finance2` fallback instead**, so
the command is always informative. (Markets-closed runs may return 0 bars; the
script notes this and skips shape assertions rather than failing.)

To exercise the **stale-FX fallback** path on demand, force the FX fetch to fail:

```bash
STOCKAGENT_FX_FORCE_FAIL=1 node dist/index.js fx        # serves cached, flagged ⚠ STALE
STOCKAGENT_FX_FORCE_FAIL=1 node dist/index.js show      # CAD view uses stale cache, warns
```
