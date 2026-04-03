# FuturesEdge AI — Databento Integration Project Plan

> **Living document.** Update status column as work progresses.
> Read CLAUDE.md and CONTEXT_SUPPLEMENT.md before starting any session.
> This document is the single source of truth for all Databento integration work.

---

## Project overview

Two parallel tracks that converge at validation:

- **Track A — Historical backtest extension:** Replace the current 64-day dataset with 12–18 months of Databento CME + OPRA data to achieve statistically meaningful backtest results (n≥30 per setup per symbol).
- **Track B — Live data feed:** Replace Yahoo Finance seed data with a real-time Databento WebSocket feed so the scan engine fires on current price with no lag.

These tracks are fully parallel — they touch different files and have zero code conflicts. They converge at **Step C (Validation)**, which requires both tracks complete and 30+ days of live forward-test data collected.

---

## Kanban board

| ID | Track | Step | Status | Notes |
|----|-------|------|--------|-------|
| B1 | Live | `databento.js` adapter — REST + WebSocket | 🔵 **IN PROGRESS** | First task — execute now |
| B2 | Live | `snapshot.js` live gate + feature flag | ⬜ To do | Depends on B1 |
| B3 | Live | 1m → 5m/15m/30m candle derivation | ⬜ To do | Depends on B2 |
| B4 | Live | Scan engine on live data, re-enable 1m/5m TF | ⬜ To do | Depends on B3 |
| B5 | Live | Forward-test harness, dedup, push notifications | ⬜ To do | Depends on B4 |
| A1 | Historical | Purchase Databento data (CME + OPRA, 12m+) | ⬜ To do | Manual — Jeff action |
| A2 | Historical | Run pipeline on new data (`historicalPipeline.js`) | ⬜ To do | Depends on A1 + A3 |
| A3 | Historical | Audit front-month roll logic in Phase 1c | ⬜ To do | Do before A2, code review only |
| A4 | Historical | HP recompute over full date range | ⬜ To do | Depends on A2 |
| A5 | Historical | Full backtest run, validate edge across 12m | ⬜ To do | Depends on A4 |
| C  | Validation | Compare live WR vs backtest WR per setup | ⬜ To do | Depends on A5 + B5 + 30 days live |

**Status key:** ⬜ To do · 🔵 In progress · ✅ Done · 🔴 Blocked · ⏸ Paused

---

## How to use this document with Claude Code

To execute a specific step, say:

> "Execute step B2" or "Now do step A3"

Claude Code will read this document, find the step, check its dependencies, and implement only that step. It will not proceed to the next step unless explicitly told to.

To update status after completing a step, say:

> "Mark B1 as done"

---

## Environment setup

### `.env` additions required
```
DATABENTO_API_KEY=your_key_here
```

### `config/settings.json` additions required
```json
{
  "features": {
    "liveData": false
  }
}
```

### npm package required
```bash
npm install @databento/client
```

---

## Step details

---

### B1 — `databento.js` adapter

**Status:** 🔵 In progress
**File:** `server/data/databento.js` (new file)
**Branch:** `feature/databento-live`
**Depends on:** Nothing — this is the first task

#### What to build

A single new module with two exports:

**`startLiveFeed(symbols, onCandle)`**

- Connects to Databento Live WebSocket using `@databento/client`
- Dataset: `GLBX.MDP3`
- Schema: `ohlcv-1m`
- Symbols: `MNQ`, `MES`, `MGC`, `MCL` — map to Databento continuous front-month tickers (`MNQ1!`, `MES1!`, `MGC1!`, `MCL1!` — confirm exact ticker format in Databento docs before coding)
- On each 1m bar close, calls `onCandle(symbol, candle)` with normalized shape: `{ time, open, high, low, close, volume }` where `time` is Unix seconds (matching existing candle format throughout the codebase)
- Reconnect on disconnect with exponential backoff — model on existing `coinbaseWS.js` pattern
- Log connection status, disconnects, and reconnects to console (verbose — this is a new critical path)

**`fetchHistoricalCandles(symbol, startIso, endIso)`**

- REST call to Databento timeseries API via `@databento/client`
- Returns array of normalized `{ time, open, high, low, close, volume }` objects sorted ascending
- Used on server startup to seed the in-memory candle store before the WebSocket catches up
- Fetch enough bars to compute all indicators: minimum 100 1m bars (EMA50 needs 50, swing lookback needs more)
- Handle errors gracefully — if historical seed fails, log warning and proceed with WebSocket-only (the live feed will build up bars over time)

#### Normalization contract

The normalized candle object must exactly match what the rest of the codebase expects. Check `server/data/snapshot.js` for the existing candle shape and match it precisely. The scan engine, indicators, and backtest engine all depend on this shape. Do not add extra fields or rename existing ones.

#### What NOT to build in this step

- Do not modify `snapshot.js` yet (that is B2)
- Do not wire into the scan engine yet (that is B4)
- Do not add the feature flag yet (that is B2)

#### Acceptance criteria

- `startLiveFeed` connects successfully and logs incoming bars to console when `DATABENTO_API_KEY` is set
- `fetchHistoricalCandles` returns a correctly shaped array for a test date range
- Disconnection triggers reconnect with backoff (test by temporarily setting wrong API key)
- No modification to any existing file

#### Notes

- Databento's Node client is `@databento/client` — use it, do not write raw WebSocket code
- Databento Live uses an authentication flow different from their REST API — check their docs for the `LiveClient` vs `Historical` client distinction
- The `ohlcv-1m` schema delivers bars on bar close — confirm this in Databento docs (some schemas deliver on tick)
- If Databento uses instrument IDs rather than ticker strings for subscription, the client library handles the lookup — check the `LiveClient.subscribe()` API signature

---

### B2 — `snapshot.js` live gate

**Status:** ⬜ To do
**File:** `server/data/snapshot.js` (modify existing)
**Branch:** `feature/databento-live`
**Depends on:** B1

#### What to build

Add a live data store and a feature flag gate to `snapshot.js`.

**In-memory live store:**

```javascript
const liveCandles = new Map(); // key: `${symbol}:${tf}`, value: candle[]
```

`databento.js` calls a new exported function `writeLiveCandle(symbol, candle)` on each 1m bar. `snapshot.js` aggregates 1m bars into 5m/15m/30m candles (B3 handles aggregation logic — stub this in B2 as a passthrough that just stores 1m bars).

**Feature flag gate in `getCandles(symbol, tf)`:**

```javascript
const settings = loadSettings();
if (settings.features?.liveData && FUTURES_SYMBOLS.includes(symbol)) {
  return liveCandles.get(`${symbol}:${tf}`) ?? [];
}
// existing seed logic below — unchanged
```

**New API route:** `GET /api/datastatus`

Returns:
```json
{
  "source": "live",
  "lastBarTime": "2026-04-03T14:32:00.000Z",
  "lagSeconds": 47,
  "wsConnected": true,
  "symbols": ["MNQ", "MES", "MGC", "MCL"]
}
```

Add to topbar in `index.html` — a small status pill: green dot + "LIVE" when `liveData: true` and lag < 120s, amber dot + "DELAYED" when lag 120–300s, red dot + "SEED" when `liveData: false` or WS disconnected.

#### Acceptance criteria

- `GET /api/datastatus` returns correct state in both seed and live modes
- Toggling `features.liveData` via `POST /api/features` switches data source without restart
- Topbar pill shows correct status
- Existing seed mode behavior completely unchanged when `liveData: false`

---

### B3 — Candle derivation (1m → 5m/15m/30m)

**Status:** ⬜ To do
**File:** `server/data/snapshot.js` (modify existing)
**Branch:** `feature/databento-live`
**Depends on:** B2

#### What to build

On each `writeLiveCandle(symbol, candle)` call, check if a complete higher-TF window has closed and emit the aggregated candle.

Rules:
- 5m: every 5 consecutive 1m bars (aligned to clock: 09:30, 09:35, 09:40...)
- 15m: every 15 consecutive 1m bars
- 30m: every 30 consecutive 1m bars
- Bar alignment: use `Math.floor(unixSeconds / tfSeconds) * tfSeconds` to group bars into windows
- Aggregation: `open` = first bar open, `high` = max of all highs, `low` = min of all lows, `close` = last bar close, `volume` = sum of all volumes, `time` = window start time

The aggregation logic already exists in `snapshot.js` for the seed derivation path. Extract it into a shared `aggregateBars(bars, tfSeconds)` function and reuse it for both paths.

#### Acceptance criteria

- With `liveData: true`, `getCandles('MNQ', '5m')` returns correctly aggregated 5m bars
- Bar timestamps are window-aligned (not the timestamp of the last 1m bar)
- A partial window (e.g. 3 of 5 1m bars received) does not emit a 5m bar until all 5 arrive
- 1m timeframe also available in live mode (pass through directly)

---

### B4 — Scan engine on live data

**Status:** ⬜ To do
**File:** `server/index.js` (modify existing)
**Branch:** `feature/databento-live`
**Depends on:** B3

#### What to build

Wire `databento.js`'s `startLiveFeed` into the server startup sequence. On each completed higher-TF candle from `snapshot.js`, trigger `runScan()` for that symbol.

Currently `runScan()` runs on a timer (polling). In live mode, it should be event-driven: scan fires when a new 5m/15m/30m bar closes, not on a fixed interval.

Implementation:
- In `server/index.js` startup, if `features.liveData === true`, call `databento.startLiveFeed(SCAN_SYMBOLS, onLiveCandle)`
- `onLiveCandle` calls `snapshot.writeLiveCandle(symbol, candle)`, which returns the list of newly completed higher-TF bars
- For each completed higher-TF bar, call `runScan(symbol, tf)` immediately

Re-enable 1m and 5m in `SCAN_TIMEFRAMES` when `liveData: true`. Keep 5m/15m/30m only when `liveData: false` (seed mode — fast TFs are stale).

#### Acceptance criteria

- With `liveData: true`, alerts fire within seconds of a bar close (not on a 60-second polling cycle)
- `runScan` is not called more than once per bar per symbol per timeframe
- Server still functions correctly in seed mode (polling unchanged)
- No duplicate alerts from the same setup within the existing dedup window

---

### B5 — Forward-test harness

**Status:** ⬜ To do
**Files:** `server/trading/simulator.js`, `server/storage/log.js`, `server/index.js`, `sw.js`
**Branch:** `feature/databento-forward-test`
**Depends on:** B4

#### What to build

Three independent pieces:

**1. Real-time outcome tracking**

`simulator.js` currently resolves SL/TP against candle data in backtest replay. Wire it to live candles: on each new live 1m bar, check all open alert positions and resolve any that hit SL or TP. Write the resolved outcome back to `alerts.json` immediately (not deferred). This is the forward-test data collection mechanism.

**2. Alert deduplication with staleness decay**

Implement the dedup logic designed in the Notifications sub-tab of backtest2's Optimize tab:

- Same symbol + setup type + direction + zone level within a 15-minute cooldown window → suppress the second alert entirely
- Alert older than 30 minutes that hasn't resolved → apply freshness decay: confidence × 0.85
- Alert older than 60 minutes that hasn't resolved → apply further decay: confidence × 0.70, flag as `stale: true` on the alert object
- Zone level proximity for dedup: within 0.25 × ATR(14) counts as "same level"

Add `setup.staleness` field to alert schema: `'fresh'` (default), `'aging'`, `'stale'`.

**3. Push notifications**

Implement the `pushNotifications` feature flag (currently reserved, not implemented).

- Use Browser Push API via the existing `sw.js` service worker
- Trigger on: `confidence >= 80` AND `setup.ddBandLabel === 'room_to_run'` AND `setup.staleness === 'fresh'`
- Notification payload: `{ title: 'MNQ Alert', body: 'Zone rejection bullish 82% — 19847.50' }`
- Add subscription management endpoint: `POST /api/push/subscribe`, `DELETE /api/push/unsubscribe`
- Add VAPID keys to `.env`: `VAPID_PUBLIC_KEY=`, `VAPID_PRIVATE_KEY=`

#### Acceptance criteria

- Open alerts show SL/TP resolution in `alerts.json` within 5 seconds of price touching the level
- Duplicate alerts within 15 minutes at the same level are suppressed (check alert feed in dashboard)
- Stale alerts show decay badge in the alert feed UI
- Push notification fires on a qualifying alert when browser permission is granted

---

### A1 — Purchase Databento data

**Status:** ⬜ To do
**Owner:** Jeff (manual action — no code)

#### What to purchase

**CME Globex futures (for backtest candles):**
- Dataset: `GLBX.MDP3`
- Schema: `ohlcv-1m`
- Symbols: `MNQ`, `MES`, `MGC`, `MCL`
- Date range: 12–18 months back from today
- Delivery: daily partition (one file per trading day), zstd compressed
- Format: CSV

**OPRA options (for HP computation):**
- Dataset: `OPRA.PILLAR`
- Schemas: `definition` AND `statistics` (both required)
- Symbols: `QQQ`, `SPY`, `GLD`, `USO` option chains
- Same date range as CME data
- Delivery: daily partition, zstd compressed

#### Notes

- Use Databento's cost estimator before purchasing — filter tightly on symbols and date range
- Daily partition format is required — do not purchase as a single aggregate file
- OPRA data is significantly larger than CME data — check disk space before downloading (estimate: 4× the current `data/historical/` folder size per year of data)
- Download to the same directory that `historicalPipeline.js` Phase 1a reads from

---

### A3 — Audit front-month roll logic

**Status:** ⬜ To do
**File:** `server/data/historicalPipeline.js` (read-only audit, possible fix)
**Branch:** `feature/databento-historical` (if fix needed)
**Depends on:** Nothing (do before A2)

#### What to audit

Read `historicalPipeline.js` Phase 1c carefully. Answer these questions:

**Q1: Does Databento deliver `MNQ1!` (continuous front-month) or individual contract symbols (`MNQU5`, `MNQZ5`)?**

If `MNQ1!` continuous: Databento handles roll stitching. No fix needed. Proceed to A2.

If individual contracts: the pipeline selects front-month by highest volume per day. Continue to Q2.

**Q2: Is front-month selection per-day or per-bar?**

Per-day is correct. Per-bar risks switching contracts mid-session on roll day.

**Q3: On roll day, does the pipeline consistently use one contract for the entire session?**

It should commit to the expiring contract until end of session on roll day, then switch to the next contract at the start of the following session. If it switches mid-day based on volume, there's a risk of a phantom price gap.

**Q4: Are any adjacent bars from different contracts being concatenated without price adjustment?**

Roll basis (the spread between expiring and new contract) can be 2–15 points for MNQ. If bars from two contracts are joined without adjusting for basis, you get an artificial price jump that looks like a breakout and will fire false alerts in the backtest.

#### Fix if needed

If a roll problem is found: commit to the expiring contract for the entire roll day. Switch to the new contract at midnight UTC on the first day after roll. Do not adjust prices — use raw prices from whichever contract is selected, consistently within each day.

#### Acceptance criteria

- Answer all four questions with evidence from the code
- If fix is needed: write it, document it here, then proceed to A2
- If no fix needed: document that finding here and proceed to A2

---

### A2 — Run pipeline on extended data

**Status:** ⬜ To do
**File:** `server/data/historicalPipeline.js` (run, not modify)
**Depends on:** A1 (data downloaded), A3 (roll audit complete)

#### What to do

This is an execution task, not a coding task.

**Step 1: Verify disk space**

Check current `data/historical/` size. Multiply by (target months / 3) to estimate new size. Confirm you have 2× that amount free before proceeding.

**Step 2: Place downloaded files**

Confirm Databento zip files are in the directory that Phase 1a reads from. Check the `INPUT_DIR` or equivalent constant at the top of `historicalPipeline.js`.

**Step 3: Run Phase 1d pre-check**

Phase 1d fetches QQQ/SPY daily closes from Yahoo Finance. Before running the full pipeline, test this in isolation for the extended date range. Yahoo Finance has been unreliable — if it fails, the HP computation in Phase 1f will be missing ETF price references. Check whether Phase 1d has retry logic and whether it fails hard or logs-and-continues.

If it fails hard: add try/catch around the per-date fetch with a log-and-skip on failure. Missing a few ETF closes is acceptable; crashing the pipeline is not.

**Step 4: Run the full pipeline**

```bash
node server/data/historicalPipeline.js
```

Skip-if-exists logic handles existing dates automatically. Monitor console output — each phase should log progress. Phase 1f (HP computation) will be the longest step.

**Step 5: Verify output**

```bash
# Count derived files (should equal trading days × symbols × timeframes)
ls data/historical/derived/ | wc -l

# Count HP computed files (should equal trading days)
ls data/historical/computed/ | wc -l

# Check backtest available date range
curl http://localhost:3000/api/backtest/available
```

#### Acceptance criteria

- `/api/backtest/available` returns the full extended date range for all four symbols
- No gaps in derived files for trading days in the date range
- HP computed files present for all trading days where OPRA data was available

---

### A4 — HP recompute

**Status:** ⬜ To do
**File:** `server/data/hpCompute.js` (run, not modify)
**Depends on:** A2

#### What to do

If Phase 1f of the pipeline already ran HP computation for the new dates during A2, this step may already be done. Check the `data/historical/computed/` file count against the expected trading day count.

If HP files are missing for any dates:

```bash
node server/data/hpCompute.js
```

Skip-if-exists logic processes only missing dates. Use `--recompute` flag only if you need to regenerate all dates (e.g. after a bug fix in `hpCompute.js` itself).

Expected runtime: 2–5 minutes per month of data. For 12 months: 24–60 minutes. Run overnight if needed.

#### Acceptance criteria

- One HP computed file exists for every trading day in the extended range where OPRA data was available
- Spot-check 3–5 random HP files: verify they contain `scaledOiWalls`, `scaledMaxPain`, `gexFlip`, `resilienceLabel`, and `dexBias` fields (the fields the backtest engine reads)

---

### A5 — Full backtest run and validation

**Status:** ⬜ To do
**UI:** `backtest2.html`
**Depends on:** A4

#### What to run

Open `backtest2.html` and run the following jobs:

**Job 1: Full period baseline**
- Date range: full available range
- Symbols: MNQ, MES, MGC, MCL
- Timeframes: 5m, 15m, 30m
- Setup types: all four
- Min confidence: 65%
- HP: enabled
- Starting balance: $10,000
- Label: "Full period baseline"

**Job 2–5: Quarterly slices**

Run four separate jobs, one per quarter, with identical configuration. Label them Q1/Q2/Q3/Q4. These are for the Compare tab — overlaying quarterly equity curves reveals whether the edge is consistent across regimes or curve-fitted to one period.

#### What to look for

**Edge consistency:** In the Compare tab, overlay all four quarterly equity curves. Consistent upward slope across all quarters = real edge. One great quarter masking three bad ones = overfit.

**Confidence floor stability:** In the Optimize tab, check the optimal confidence floor for each setup type. If the optimal floor differs by more than 10pp across quarters (e.g. 70% in Q1 but 80% in Q3), the scoring is regime-sensitive.

**DD Band validation:** In the Optimize → DD Band sub-tab, verify that `room_to_run` shows meaningfully higher WR than `outside_dd_upper`/`outside_dd_lower` across the full period. This validates the v11.0 modifier was worth adding.

**Sample size check:** In the Optimize tab, look for amber "low sample" warnings on any setup × symbol combination. Any combination with n < 30 should not be used to make configuration decisions.

**Go/no-go criteria for proceeding to paper trading:**
- Overall WR ≥ 60%, PF ≥ 1.5
- Max drawdown ≤ 10% of starting balance
- At least 3 of 4 quarters show positive expectancy
- Primary setups (zone_rejection, trendline_break) pass at WR ≥ 60% individually
- No setup shows WR < 50% across the full period (if one does, disable it before paper trading)

#### Acceptance criteria

- All five jobs complete without error
- Full period baseline shows overall WR ≥ 60% and PF ≥ 1.5 (or document why not and what to change)
- Findings documented here under a "Backtest findings" section (add after running)

---

### C — Validation: backtest vs forward-test

**Status:** ⬜ To do
**Depends on:** A5 complete + B5 complete + minimum 30 trading days of live forward-test data collected

#### What to validate

For each active setup type, compare:

| Metric | Backtest (A5) | Forward-test (30d live) | Acceptable gap |
|--------|--------------|------------------------|----------------|
| Win rate | From Job 1 | From `/api/performance` | ≤ 10pp |
| Profit factor | From Job 1 | From `/api/performance` | ≤ 0.3 |
| Avg R | From Job 1 | From `/api/performance` | ≤ 0.3R |

If any setup diverges beyond the acceptable gap: investigate before paper trading. Likely causes are data quality differences, execution lag (seed data vs live price), or genuine regime change.

#### Gate: proceed to paper trading only if

- All primary setups within acceptable divergence range
- Overall forward-test WR ≥ 55% (some degradation from backtest is expected and normal)
- No single setup shows live WR < 45%
- Autotrader kill switch tested and confirmed functional

---

## File map — what each step touches

| File | Steps that touch it |
|------|-------------------|
| `server/data/databento.js` | B1 (create) |
| `server/data/snapshot.js` | B2, B3 |
| `server/index.js` | B2 (datastatus route), B4 (live scan wiring) |
| `server/trading/simulator.js` | B5 |
| `server/storage/log.js` | B5 |
| `sw.js` | B5 |
| `public/index.html` | B2 (status pill) |
| `server/data/historicalPipeline.js` | A3 (audit), A2 (run) |
| `server/data/hpCompute.js` | A4 (run) |
| `config/settings.json` | B2 (liveData flag) |
| `.env` | B1 (DATABENTO_API_KEY), B5 (VAPID keys) |
| `package.json` | B1 (`@databento/client`) |

---

## Databento reference

- **Live WebSocket endpoint:** `wss://live.databento.com/v0/live`
- **REST historical endpoint:** via `@databento/client` `Historical` class
- **CME dataset:** `GLBX.MDP3`
- **OPRA dataset:** `OPRA.PILLAR`
- **Schema for candles:** `ohlcv-1m`
- **Continuous front-month ticker format:** confirm in Databento symbol reference (likely `MNQ1!` or `MNQZ6` format)
- **Node client:** `npm install @databento/client`
- **Docs:** https://docs.databento.com

---

## Git branch strategy

```
main                              ← stable, always working
feature/databento-live            ← B1, B2, B3, B4
feature/databento-forward-test    ← B5
feature/databento-historical      ← A3 fix (if needed)
```

Merge each feature branch to main only after its acceptance criteria are met and tested.

---

## Coding rules (reminder)

- JavaScript only — no Python, no TypeScript
- All API keys via `.env` — never hardcoded
- One file per concern — `databento.js` handles only Databento I/O
- Console.log liberally — this is new critical-path code, visibility matters
- Data layer is source-agnostic — the rest of the engine must never know whether data came from Databento or seed files
- Demo/paper only — `TRADOVATE_API_URL` must always point to `demo.tradovateapi.com`

---

*Last updated: 2026-04-03*
*Next action: Execute B1 — build `server/data/databento.js`*
