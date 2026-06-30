# StockAgent — Phases 1–6 (data, storage, portfolio, FX, signals, notifications, dashboard & LLM narration)

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
- **Phase 4** adds the **deterministic signal engine** — technical indicators,
  user price alerts, multi-timeframe factual context, and position-aware flags
  over cached bars, combined into deduplicated, severity-rated **signal objects**
  with plain-language reasoning. No LLM, no notifications. See
  [Signals & alerts](#signals--alerts).
- **Phase 5** adds **delivery** (not new analysis): native macOS **notifications**
  for `actionable` signals only — fire-once, throttled, quiet-hours-aware, and
  suppressed on startup so it never spams — plus a live-updating **CLI
  dashboard**. See [Notifications](#notifications) and [Dashboard](#dashboard).
- **Phase 6** adds the **LLM narration layer** (the `explain` command): for the
  top-ranked symbols it produces a plain-language **read**, an explicit **bull
  AND bear** interpretation of the same facts, and **one suggested action framed
  as a single option** whose percentage is **computed in code, not by the model**.
  It also **ranks** which symbols deserve attention (where `preferences.cadBias`
  is finally consumed) and classifies **news-headline sentiment**. The LLM
  *explains and prioritizes what the deterministic layer already found* — it never
  generates signals, never predicts, and never decides. See
  [LLM narration](#llm-narration-explain).

**Signals describe what is currently true — never a prediction.** There is no
forecast, no price target, no "expected move" anywhere in the engine; the
multi-timeframe module reports *where price sits within past windows* as factual
context only. Every notification body and dashboard cell carries the same
framing — **"signal, not advice"**, "as of last cached close" — so nothing
implies real-time data or a recommendation. The Phase-6 LLM layer preserves this
contract and enforces it **in code, not just the prompt**: it cannot predict,
must always give both sides, and any number it states is the code-computed value
echoed back. "Current price" everywhere means the **latest cached close**, not a
live tick.

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

**`OPENAI_API_KEY`** powers the optional Phase-6 LLM narration (`explain`). If
it's absent, `explain` runs on the deterministic engine and prints deterministic
summaries with an "AI explanation unavailable" note — so the tool is fully
functional without an OpenAI account. See [LLM narration](#llm-narration-explain).

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

`cadBias` tilts the Phase-6 attention **ranking** toward (positive) or away from
(negative) CAD-denominated symbols; `0` is neutral. It's a bounded *nudge*, not
an override — see [LLM narration → ranking](#ranking-where-cadbias-is-consumed)
for the exact formula. An out-of-range value fails loudly on load.

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
node dist/index.js start --dashboard     # also render the live dashboard each cycle
node dist/index.js start --no-notify     # mute native notifications (dashboard/queries still work)

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

# Pin the USD->CAD rate at your actual purchase date (USD positions only).
# Without this, add auto-snapshots *today's* rate — only correct if you add the
# position the same day you buy it.
node dist/index.js add BABA 10 --cost 125 --usd --fx-at-cost 1.35

# Partially update an existing position (only the fields you pass)
node dist/index.js edit AAPL --shares 12
node dist/index.js edit AAPL --cost 175 --note "added on dip"
node dist/index.js edit BABA --fx-at-cost 1.35        # fix/backfill the purchase rate

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
- **`--fx-at-cost <rate>`** (on `add` *and* `edit`) overrides that auto-snapshot
  with the USD→CAD rate at your actual purchase date (1 USD = `<rate>` CAD) — the
  accurate input for the FX split when you record a position after the fact, or
  to backfill a legacy `NULL`/wrong snapshot. It's USD-only (CAD positions are
  always 1 and the flag is rejected for them) and needs no network, so it also
  lets you `add` offline. On `edit`, omitting it leaves the existing snapshot
  untouched.

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

## Signals & alerts

The Phase-4 engine reads cached bars (plus your portfolio and the cached FX rate)
and emits **signal objects** that state what is currently true. Generation is
pure and deterministic — `(bars, position, config) → Signal[]` — kept separate
from persistence and dedup, so the math is unit-tested against synthetic series.

Each signal has a `kind` (`technical` | `threshold` | `position` | `context`), a
stable `code` (e.g. `rsi_overbought`, `near_6mo_high`), a `severity`
(`info` | `notable` | `actionable`), a factual present-tense `summary`, and the
underlying numbers in `data`.

```bash
# Run the engine over current data; print fired signals (actionable starred ★)
# grouped by symbol, and persist them. --once computes, prints, persists, exits.
node dist/index.js scan --once
node dist/index.js scan --symbol AAPL --once

# Query persisted signals
node dist/index.js signals --active                 # currently-active signals
node dist/index.js signals --history --limit 20     # recent fires (active + cleared)
node dist/index.js signals --active --symbol TD.TO
```

`start` recomputes signals after each per-minute poll cycle, then dispatches
notifications for newly-`actionable` ones (Phase 5). Each concern is **isolated**:
a failure in signal computation, notification, or rendering is logged and never
stops the poll loop (the same resilience contract as Phase 1).

### What fires

- **Technical:** RSI(14) overbought/oversold; MACD signal-line crosses; SMA
  golden/death cross and price-vs-short-MA; Bollinger-band breaches.
- **Threshold:** your own per-symbol buy-below / sell-above price levels (below).
- **Context (factual, never extrapolation):** over **1d / 1wk / 1mo / 6mo**
  windows, where the latest close sits within the window's range (`near_6mo_high`
  / `near_6mo_low` / `within_6mo_range`), plus the window's start→end % change,
  realized volatility, and max drawdown — all describing the past window only.
- **Position-aware (held symbols only):** unrealized P&L vs cost basis at the
  latest cached close (CAD-normalized via the FX layer); concentration / overweight
  as a share of total portfolio value (CAD); and a `multiple_holdings_overbought`
  rollup. These degrade gracefully — an empty portfolio just skips them, and a
  USD position with no FX rate reports CAD P&L as `n/a` rather than guessing.

**Multi-timeframe data source.** The 1-day window uses cached **minute** bars;
the longer windows use **daily** bars *resampled from the accumulated minute
cache* (market-clock day boundaries). This keeps the engine cache-first and
deterministic — no parallel fetch path. A consequence: on a fresh install the
longer windows show no context until enough minute history has accumulated
(symbols with too little history report `insufficient_data` rather than crashing
or computing garbage); they fill in as `start` runs over time.

**Severity.** Most signals are `info`/`notable`. A conservative, documented set
is raised to `actionable`: any threshold hit, a **held** symbol that is oversold
*and* near a window low, and a **held** symbol that is overbought *and*
overweight. Dedup keeps **one active signal per (symbol, code)** while the
condition stays continuously true — it only re-fires after clearing and
re-triggering — so the [notification layer](#notifications) won't alert every minute.

### Price alerts

Per-symbol price levels, in the symbol's **native** currency (a single-symbol
level needs no FX):

```bash
node dist/index.js alert set AAPL --sell-above 250
node dist/index.js alert set SHOP.TO --buy-below 90 --sell-above 140
node dist/index.js alert list
node dist/index.js alert clear AAPL
```

A scan whose latest close is at or above `--sell-above` fires
`price_at_or_above_sell`; at or below `--buy-below` fires `price_at_or_below_buy`
(both `actionable`).

### Tuning (settings)

All periods, thresholds, and cutoffs live in an optional `signals:` block in
`watchlist.yaml`, zod-validated with documented defaults — tune sensitivity
without code changes. Any absent key falls back to its default:

```yaml
signals:
  rsi:            { period: 14, overbought: 70, oversold: 30 }
  macd:           { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }
  movingAverages: { shortPeriod: 50, longPeriod: 200 }
  bollinger:      { period: 20, stdDev: 2 }
  pnl:            { gainPct: 20, lossPct: 15 }      # unrealized P&L flags
  concentration:  { overweightPct: 25 }            # % of portfolio (CAD)
  context:        { nearHighPct: 90, nearLowPct: 10 }  # range-position bands
  rollup:         { overboughtCount: 2 }            # held symbols overbought at once
```

`preferences.cadBias` is **still** a parsed stub — it's a ranking input consumed
by a later phase, not here.

## Notifications

Phase 5 pushes **native macOS notifications** (via `node-notifier`) for signals —
but only after passing a deliberately strict discipline, because an alerting tool
you can't trust to stay quiet is one you'll mute. The rules, all load-bearing:

- **`actionable` only.** `info` / `notable` / `context` signals **never** push —
  they're visible in the dashboard and `signals --active` only. This is the
  firewall against notification fatigue.
- **Fire-once.** A signal notifies exactly once, on the active-edge, tied to the
  Phase-4 dedup state (a `notified_at` stamp on the signal row). It does **not**
  re-notify every cycle while it stays true. Only after it clears and genuinely
  re-fires does a new notification go out.
- **Throttle / coalesce.** At most `maxPerWindow` pushes per `windowMinutes`. A
  burst beyond that budget collapses into a **single summary** notification
  (`"4 actionable signals — run stockagent signals --active"`) instead of N.
- **Quiet hours.** While markets are closed (Phase-1 market-hours gate),
  engine-derived actionable signals are held back (still visible in the
  dashboard, never retroactively replayed when markets reopen). **User-set price
  thresholds are hard alerts and push regardless** — you asked to be told when
  that level is hit.
- **Startup suppression.** On `start`, signals already active *before* this run
  began are treated as already-known and never replayed as a backlog. Only
  transitions that happen *during* the run notify.
- **Resilient.** A push failure (e.g. permission not granted) is logged with a
  one-time hint and **never** crashes the poll/signal loop.

Every notification body ends with **"· signal, not advice."** — the same framing
carried through every surface.

Settings live in an optional `notifications:` block in `watchlist.yaml`
(zod-validated, documented defaults):

```yaml
notifications:
  enabled: true                  # master switch for native pushes
  maxPerWindow: 5                # max notifications per window…
  windowMinutes: 10              # …over this many minutes (else coalesce)
  quietHoursOutsideMarket: true  # suppress non-threshold pushes when markets closed
```

`start --no-notify` mutes pushes for a single run (dashboard and queries still
work); `notifications.enabled: false` disables them globally.

### macOS notification permission (one-time setup)

The first time a notification fires, macOS may ask to allow notifications from
your terminal app (`node-notifier` ships `terminal-notifier`). If notifications
never appear, enable them in **System Settings → Notifications**, find your
terminal app (Terminal / iTerm) or **terminal-notifier**, and turn **Allow
Notifications** on. StockAgent logs a one-time hint and keeps running if
permission is denied.

## Dashboard

A live-updating terminal view over your watchlist + held symbols:

```bash
node dist/index.js dashboard              # poll + signal + redraw each cycle
node dist/index.js dashboard --once       # render a single snapshot and exit
node dist/index.js dashboard --no-notify  # dashboard only, no pushes
node dist/index.js start --dashboard      # the monitoring loop *and* the dashboard
```

It renders (via `cli-table3` + `chalk` — chosen over a full TUI to stay close to
the existing dependency-light table aesthetic): per symbol the latest **cached
close** (with its as-of time — not a live tick), native currency, a held vs
watch-only marker (`●` / `·`), and for held positions the CAD-normalized market
value and unrealized P&L (green/red) **as of last close**. A signals column shows
active-signal counts by severity with `actionable` highlighted (`★`). The header
carries the FX rate + as-of date (with a `⚠ STALE` flag when applicable), market
open/closed, and last poll time; the footer shows the total CAD portfolio value
(with the Wealthsimple FX-spread footnote) and the most recent actionable signal
summaries.

**Honesty & resilience.** Everything price/P&L is labelled "as of last cached
close" — never implied real-time. Mixed currencies show native per row, CAD for
totals. The refresh cadence follows the poll cycle (it doesn't redraw faster than
the data changes). In a **non-TTY** (e.g. piping to a file) it degrades to plain
periodic line output — no ANSI redraws, no garbage. And a render fault is caught
and logged: **the monitoring engine is primary; the view is disposable** and can
never take down the loop.

## LLM narration (`explain`)

Phase 6 is the **narration layer**. It takes the deterministic signals,
multi-timeframe context, and your actual position numbers, and produces — per
relevant symbol — a plain-language **read**, an explicit **bull and bear**
interpretation of the same facts, and **one suggested action framed as a single
option**. It also **ranks** which symbols deserve attention and classifies
**news-headline sentiment**.

```bash
# Narrate the top-ranked symbols (default count from llm.topN)
node dist/index.js explain

# Narrate the top 5
node dist/index.js explain --top 5

# Narrate one named symbol
node dist/index.js explain AAPL

# Run fully on the deterministic layer — no API calls
node dist/index.js explain AAPL --no-llm
```

Each symbol prints: **Read** (factual present-tense situation), **Bull** and
**Bear** (two readings of the *same* facts), one **Option** (with the
code-computed basis % shown), the cached **headline** sentiments, and the closing
line **"Your call — mechanical signal, not advice."**

### The framing contract (enforced in code, not just the prompt)

The whole point of the deterministic layers is that the LLM has nothing
prediction-shaped to grab. That contract is enforced **twice** — in the prompt
*and* by a code-side validator on every response, because models drift and a
confident false forecast about your money is the exact failure this architecture
exists to prevent:

1. **No prediction, ever.** A forbidden-language filter (regex for
   `predict`/`forecast`/`will rise|fall`/`expect`/`target price`/`guarantee`/…)
   runs over the `read`/`bull`/`bear`/`option` fields. If a field trips it, that
   field is **discarded and replaced** with the deterministic summary, and the
   event is logged — the model is never trusted to self-police.
2. **Always both sides.** `bull` and `bear` are mandatory fields, so a single
   directional verdict is structurally impossible.
3. **Suggested action = one option, and the % is code-decided.** The trim
   percentage is computed in code (see below) and passed *into* the prompt; the
   model only phrases it. The returned `basisPct` **must equal** the code value —
   if the model invents or alters it, the validator repairs it back. A number that
   originates in the model is a bug, not a feature.
4. **Always ends with "your call — mechanical signal, not advice."**
5. The model is given **only** the structured signal/context/position numbers —
   never raw price series — and is told it has no predictive ability.

If the LLM call fails, times out, rate-limits, or returns malformed JSON (after
one repair retry), `explain` falls back to the **deterministic signal summaries**
for that symbol with an "AI explanation unavailable" note. **The deterministic
engine is the product; the LLM is an enhancement** — and `start`'s poll / signal
/ notify loops never call it, so an LLM outage can't touch monitoring.

### How the suggested trim % is decided (code, not the model)

For a held position the suggested-trim % comes from deterministic
position-sizing, documented and auditable:

- **Concentration term.** If the position is overweight (CAD share above the
  `signals.concentration.overweightPct` line), the base trim is the fraction that
  brings its weight back *to* the line: `(sharePct − line) / sharePct × 100`.
- **Gain term.** A larger unrealized gain adds a small, capped increment:
  `min(15, gainPct / 4)`. Losses add nothing.
- The two sum, then clamp to **[5, 50]%** and round to the nearest 5%. With no
  reduce-exposure rationale (not overweight, not a large gain) the result is
  `null` and no numeric action is offered.

### Ranking (where `cadBias` is consumed)

Code ranks; the LLM only narrates the top-ranked items. A symbol's **base score**
rewards attention-worthiness:

- actionable signals dominate (weight 100 each),
- notable signals matter (10 each),
- context extremes — latest close near a window high/low — add 5 each,
- concentration adds its CAD portfolio-share directly, and unrealized-P&L
  magnitude adds a little,
- every symbol gets a floor of 1 so the bias can still order quiet names.

Then **`preferences.cadBias ∈ [−1, 1]`** applies as a bounded nudge:

```
adjusted = base × (1 + cadBias × dir × 0.5)      dir = +1 for CAD, −1 for USD
```

At `cadBias = 0` the factor is 1 (neutral). Positive favours CAD, negative
favours USD. Because it's a bounded multiplier on the base score, a strong
actionable signal still outranks a quiet CAD name — the bias only breaks
near-ties and tilts the middle of the list.

### Headline sentiment

For each narrated symbol, recent **headlines** are fetched (via the same
`yahoo-finance2` provider, `headline text only` — never article bodies) and each
is classified `positive` / `negative` / `neutral` with a one-line neutral summary.
The sentiments feed into the narration as one more input *signal* (context, not a
prediction). Each headline is classified **at most once ever** — results are
cached per headline.

### Cost, caching & what's sent to the API

- **The LLM is not called every poll cycle.** It's on-demand (`explain`) and the
  narration is **cached by (symbol, signal-set hash)**: re-running `explain` on a
  symbol whose signal set, trim %, and headline sentiments are unchanged reuses
  the cached read with **no API call**; any change to that set invalidates it.
- **Token usage is logged** (`llm_usage` table) and `explain` prints a cumulative
  `calls / input + output tokens` line so cost is observable.
- **What is sent to the API:** only the structured market/position numbers the
  deterministic engine produced (signals, context-window stats, your position's
  shares/avg-cost/P&L/concentration and the code-computed trim %) plus **headline
  text** for sentiment. **No credentials, no raw price series, no article
  bodies.** Your position sizes are your own data — fine to send to your chosen
  provider, but noted here so the choice is informed.

### Disabling the layer / switching provider

- **`--no-llm`** on `explain` runs a single invocation fully deterministically.
- **`llm.enabled: false`** in `watchlist.yaml` disables it globally.
- A missing `OPENAI_API_KEY` behaves the same as disabled (deterministic summaries
  + an "AI explanation unavailable" note).
- The backend is config (`llm.provider` / `llm.model`), not hardcoded, and sits
  behind a backend-agnostic `LlmProvider` interface. **To switch provider:**
  implement that interface in `src/llm/` and add a branch to
  `resolveLlmProvider` — the narration, ranking, validation, and caching code is
  provider-agnostic and stays unchanged.

Settings live in an optional `llm:` block in `watchlist.yaml` (zod-validated,
documented defaults):

```yaml
llm:
  enabled: true            # master switch; false → deterministic only
  provider: openai         # only `openai` implemented today
  model: gpt-4o            # passed through to the provider
  temperature: 0.2         # low, for stable/cacheable narration
  topN: 3                  # default symbols `explain` narrates with no arg
  headlines:
    enabled: true          # per-symbol headline sentiment
    max: 5                 # headlines per symbol
```

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
- `signals(id, symbol, kind, code, severity, summary, data, fired_at, cleared_at,
  active, notified_at)` persists fired signals. `data` is JSON-encoded; `active = 1`
  with `cleared_at = NULL` is a live signal. The dedup invariant is **one active
  row per `(symbol, code)`** while a condition stays true; clearing stamps
  `cleared_at` and flips `active` to 0, so a re-trigger records a fresh row.
  `notified_at` (Phase 5, nullable; legacy rows migrate in as `NULL`) stamps when
  a notification was dispatched for that fire, enforcing fire-once.
- `alerts(symbol, buy_below, sell_above)` holds user price levels (native
  currency; either bound nullable). `symbol` is the primary key.
- `narration_cache(symbol, signal_hash, narration, created_at)` caches one LLM
  narration per `(symbol, signal-set hash)` so an unchanged situation reuses the
  stored read (Phase 6). `(symbol, signal_hash)` is the primary key.
- `headline_sentiment(headline_hash, text, sentiment, summary, created_at)` caches
  per-headline sentiment so the same headline is never re-classified.
- `llm_usage(id, ts, kind, model, input_tokens, output_tokens)` is the append-only
  token-usage log behind the cost readout.

Timestamps are epoch-milliseconds (UTC); FX `date` is an ISO calendar day;
signal `fired_at`/`cleared_at` are ISO timestamps.

## Tests

Pure logic has unit tests (no network needed) — FX conversion/decomposition, and
the Phase-4 signal engine: indicators, window/percentile math, each generator
fed synthetic series with known answers (e.g. a constructed oversold series fires
`rsi_oversold` and nothing else), and the dedup/persistence state machine against
a throwaway SQLite DB.

The Phase-6 LLM layer is tested **without any network or API key** via a mock
provider: input-assembly purity, the zod schema, the `basisPct`-must-match-code
check, the forbidden-language filter (a deliberately prediction-laden mock
response is caught and the deterministic fallback is used), position-sizing,
cadBias ranking reorder, narration caching (an unchanged signal set makes no
second call), and per-headline sentiment caching (headline text only).

```bash
npm test     # node --test via tsx over src/**/*.test.ts
```

## Project layout

```
src/
  index.ts            commander setup, wires subcommands
  config.ts           load + zod-validate watchlist.yaml (incl. notifications)
  db.ts               better-sqlite3 schema + prepared statements
  monitor.ts          shared poll→signal→notify/display loop (start + dashboard)
  poll.ts             per-minute fetch+upsert cycle, market-hours check
  symbols.ts          symbol normalization + exchange/currency inference
  table.ts            tiny fixed-width table renderer
  util.ts             logging, sleep, retry-with-backoff
  providers/
    types.ts          common Provider interface (getRecentBars)
    alpaca.ts         US bars (Alpaca IEX feed)
    yahoo.ts          TSX + key-less fallback (yahoo-finance2)
    index.ts          routes a symbol to the right provider
    newsTypes.ts      Headline / NewsProvider interfaces
    news.ts           recent headlines (text only) via yahoo-finance2 search
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
  signals/
    types.ts          Signal / SignalKind / Severity + ScanResult shapes
    indicators.ts     pure RSI/MACD/SMA/Bollinger helpers (technicalindicators)
    windows.ts        pure window math (range position, vol, drawdown) + resample
    technical.ts      pure technical-signal generator
    context.ts        pure multi-timeframe context generator (factual only)
    position.ts       pure position-aware generator (P&L, concentration, rollup)
    threshold.ts      pure user-price-alert generator
    severity.ts       combination step that raises co-occurring conditions
    engine.ts         impure shell: gather data, run generators, dedup + persist
    *.test.ts         synthetic-series unit tests for the above
  notify/
    decision.ts       pure notify-decision logic (actionable-only, quiet, coalesce)
    decision.test.ts  unit tests for the decision + label/framing helpers
    Notifier.ts       node-notifier delivery: fire-once, throttle, startup-suppress
    Notifier.test.ts  state-transition tests against a throwaway SQLite DB (mock push)
  dashboard/
    snapshot.ts       cache-only point-in-time view model (bars, positions, signals, FX)
    render.ts         cli-table3 + chalk renderer; plain non-TTY fallback
    render.test.ts    plain/color render tests (no-ANSI when piped, markers, totals)
  llm/
    types.ts          LlmProvider / Narration / NarrationInput shapes
    input.ts          buildNarrationInput — pure structured-input assembly
    positionSizing.ts deterministic suggested-trim % (code decides the number)
    ranking.ts        attention ranking; consumes preferences.cadBias
    schema.ts         zod schema + forbidden-language filter + deterministic fallback
    prompt.ts         system prompt (framing contract + few-shot) + user content
    hash.ts           signal-set / headline hashes for the caches
    OpenAiProvider.ts OpenAI implementation (structured outputs, repair retry)
    provider.ts       resolveLlmProvider — config/key-driven backend selection
    headlines.ts      headline fetch + sentiment classification + per-headline cache
    narrator.ts       orchestration: cache → LLM → validate → cache, with fallback
    assemble.ts       runs the engine + attaches CAD position numbers per symbol
    *.test.ts         input purity, schema/forbidden/basisPct, ranking, caching tests
  commands/
    start.ts  dashboard.ts  bars.ts  status.ts  portfolio.ts  fx.ts  scan.ts  signals.ts  alert.ts  explain.ts
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
