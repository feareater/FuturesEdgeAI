# FuturesEdge AI — Databento Integration Project Plan

> **Living document.** Update status column as work progresses.
> Read ../CLAUDE.md and CONTEXT_SUPPLEMENT.md before starting any session.
> This document is the single source of truth for all Databento integration work.

---

## Project overview

Two parallel tracks that converge at validation:

- **Track A — Historical backtest extension:** Replace the current 64-day dataset with 12–18 months of Databento CME + OPRA data to achieve statistically meaningful backtest results (n≥30 per setup per symbol).
- **Track B — Live data feed:** Replace Yahoo Finance seed data with a real-time Databento feed so the scan engine fires on current price with no lag.

These tracks are fully parallel — they touch different files and have zero code conflicts. They converge at **Step C (Validation)**, which requires both tracks complete and 30+ days of live forward-test data collected.

---

## Kanban board

| ID | Track | Step | Status | Notes |
|----|-------|------|--------|-------|
| B1 | Live | `databento.js` adapter — REST polling feed | ✅ **Done** | Implemented with raw `https` module (no npm client — see notes) |
| B2 | Live | `snapshot.js` live gate + feature flag + `/api/datastatus` | ✅ **Done** | Hot-toggle via `POST /api/features {"liveData": true}` |
| B3 | Live | 1m → 5m/15m/30m candle aggregation | ✅ **Done** | Window-aligned; partial bars updated in-place |
| B4 | Live | Event-driven scan on bar close | ✅ **Done** | `runScan({targetSymbols, targetTimeframes})` on each completed window |
| B5 | Live | Forward-test harness, dedup, push notifications | ✅ **Done** | checkLiveOutcomes in simulator.js; alertDedup.js; pushManager.js; sw.js push handler |
| A1 | Historical | Purchase + download Databento data (CME + OPRA) | ✅ **Done** | 16 single-symbol GLBX zips + OPRA zips downloaded to Historical_data/ |
| A2 | Historical | Rewrite pipeline for 16 symbols, 13yr scale, instruments.js | ✅ **Done** | instruments.js, pipeline rewrite, per-symbol extraction fix, OPRA parsing correctness, ohlcv-1d local extraction (see A2 notes) |
| A3 | Historical | Audit front-month roll logic in Phase 1c | ✅ **Done** | Roll audit complete via Phase 1c log evidence: GLBX zips use stype_in=parent (individual contracts), Phase 1c selects front-month by volume per day, 0 lookahead errors confirmed, no phantom gaps. No code fix needed. |
| A4 | Historical | HP recompute over full date range | ✅ **Done** | Phase 1f complete: ~1752 HP snapshots per ETF (2018-09-24 → 2026-04-24), written to options/{etf}/computed/. USO: 1749, all others: 1752. v14.42 closed the 2026-04-02 → 2026-04-24 gap by extracting Jeff's new OPRA zips + DBEQ.BASIC ETF closes + running Phase 1e (96 contract files) and Phase 1f (96 HP files), 0 errors, 65s total. April backtest unblocked: **34 trades / WR 35.3% / PF 3.063 / Net +$2,894** vs 0 trades pre-backfill. |
| A5 | Historical | Full backtest run, validate edge across 12m | ✅ **Done** | Final run (or_breakout+pdh, VIX+DXY active): **Net +$233,540, PF 1.69, 9,679 trades**. or_breakout: Net +$248K (5m only); pdh: Net -$14.6K. VIX: edge holds across all regimes (strongest in normal: +$110K). DXY: no meaningful filter (rising=+$103K, falling=+$97K). zone_rejection disabled (R:R inverted). OR breakout 5m-only enforced by engine guard. |
| A6 | Historical | Market breadth scoring from all 16 symbols — Phase V | ✅ **Done** | marketBreadth.js, breadth in applyMarketContext (±15 pts), trade record fields, Optimize Market Breadth + Inter-market sub-tabs. A5 re-run with breadth active: **Net +$238,040, WR 33.9%, PF 1.584** — +$4,500 vs baseline, MaxDD 9% lower. riskAppetite=neutral best WR (37.2%). dollarRegime inversion already correct in v12.8. |
| B6 | Live | OPRA live TCP feed — real-time OI for HP/GEX/DEX | ✅ **Done** | opraLive.js (OPRA.PILLAR, statistics schema, QQQ+SPY); feature flag `liveOpra`; CBOE fallback; Phase A schema check at startup. **Activated 2026-04-07:** fixed stype_in (underlying→parent), symbol format (QQQ→QQQ.OPT), OCC parser whitespace. Confirmed connected + stable. **v14.42 Stage 1 diagnosis** confirmed live computation path is sound — OPRA OpenInterest broadcast cadence is once/day from OCC overnight clearing file (~06:00–06:30 ET), so post-restart `_strikeData` populates definitions immediately but OI buckets stay empty until next morning broadcast; CBOE fallback during that window is correct behaviour, NOT a bug. |
| B7 | Live | EOS HP snapshot writer — persist live OPRA chain to disk daily | ✅ **Done** (v14.42) | `server/data/opraSnapshot.js snapshotDailyHP()` wired into `dataRefresh.refreshAll()` at 17:30 ET. Per ETF: pulls live OPRA chain → calls `computeHP()` (same code path as Phase 1f) → writes `data/historical/options/{etf}/computed/{date}.json` with `dataSource: 'opra-live'` provenance. Skip-when-no-OI behaviour (post-restart, before morning broadcast). `.bak` sidecar on first overwrite per (etf,date) per day. Manual trigger: `POST /api/opra/snapshot`. Closes the going-forward HP gap that v14.41 audit flagged. |
| C  | Validation | Compare live WR vs backtest WR per setup | ⬜ To do | Depends on A5 + B5 + 30 days live |

**Status key:** ⬜ To do · 🔵 In progress · ✅ Done · 🔴 Blocked · ⏸ Paused

---

## How to use this document with Claude Code

To execute a specific step, say:

> "Execute step B5" or "Now do step A3"

Claude Code will read this document, find the step, check its dependencies, and implement only that step. It will not proceed to the next step unless explicitly told to.

---

## Environment setup

### `.env` additions required
```
DATABENTO_API_KEY=your_key_here
```

### `config/settings.json` — already configured
```json
{
  "features": {
    "liveData": false
  }
}
```

### npm package — NOT required
> **Important:** Databento does NOT have an official Node.js client library on npm.
> The `@databento/client` package does not exist. The adapter (`server/data/databento.js`)
> uses Node.js built-in `https` module to call the REST API directly.

---

## Implementation notes (B1–B4 completed 2026-04-03)

### B1 — Key findings

**No npm client:** `@databento/client` does not exist on npm. Databento's JS client is on their roadmap but unreleased as of April 2026. Implemented using Node.js built-in `https` module with Basic Auth (API key as username, empty password).

**Polling not WebSocket:** The `ohlcv-1m` schema delivers completed bars. An aligned polling approach (every 65s, first poll 5s after next bar close) is equivalent to a streaming connection for this schema — bars close once per minute regardless of connection type. This is simpler, more robust, and avoids WebSocket reconnect complexity.

**Wire format (confirmed from live API, 2026-04-03):**
- `rec.hd.ts_event` — nanosecond timestamp string, e.g. `"1775136600000000000"` (nested under `hd`, not flat)
- `rec.open/high/low/close` — fixed-point integer strings, divide by `1e9` to get price
- `rec.volume` — integer string
- `rec.hd.rtype` — 33 for `ohlcv-1m` on `GLBX.MDP3`

**Symbol map (confirmed live):**

| Internal | Databento | Confirmed |
|---|---|---|
| MNQ | `MNQ.c.0` | ✅ |
| MES | `MES.c.0` | ✅ |
| MGC | `GC.c.0` | ✅ GC proxy — Micro Gold (`MGC.c.0`) not in subscription; GC has identical prices |
| MCL | `MCL.c.0` | ✅ |

**stype_in:** `continuous` (required when using `.c.0` notation)

**Backoff:** `_failCount` + `_backoffDelay` starting at 10s, doubling per consecutive error, capped at 300s.

### B2 — Key findings

**`POST /api/features` was missing from code:** The route was documented in CLAUDE.md but was not in `server/index.js`. Discovered during B2 implementation and restored.

**Settings cache:** `_isLiveMode()` re-reads `settings.json` at most every 5s so hot-toggle via `POST /api/features` takes effect within one poll cycle without a restart.

**`/api/datastatus`:** Returns `{source, wsConnected, lagSeconds, lastBarTime, lastBarTimes, symbols}`. In seed mode returns `source:'seed'`. In live mode delegates to `getLiveFeedStatus()` from `databento.js`.

### B6 — Live bar persistence (v13.9)

`server/data/liveArchive.js` — new module; `writeLiveCandleToDisk(symbol, candle)` is called
from `_onLiveCandle()` in `server/index.js` on every completed 1m bar.

- **Path:** `data/historical/futures/{SYMBOL}/1m/{YYYY-MM-DD}.json`
- **Format:** flat JSON array of `{ ts, open, high, low, close, volume }` — identical to
  historical pipeline output; `ts` mapped from live candle's `time` field.
- **Append-only:** reads file → checks last entry timestamp → appends if new → writes back.
  Directory created with `fs.mkdir({ recursive: true })` on first write per symbol/date.
- **Non-blocking:** all I/O via `fs.promises`; errors caught/logged and never bubble up.
- **Only 1m bars persisted.** Higher-TF files (5m/15m/30m) are not written at runtime —
  run `node scripts/precomputeTimeframes.js` to aggregate 1m→5m/15m/30m when needed for backtest.

**Maintenance:** `scripts/pruneOldLiveBars.js` removes files older than 90 days (configurable
via `--days N`). Use `--dry-run` to preview. Run monthly to prevent unbounded growth.

**API:** `GET /api/livestats` → `{ liveBarCount: { MNQ: N, … }, oldestBar, newestBar, diskMB }`

### B3 — Implementation

`writeLiveCandle(symbol, candle)` now:
1. Stores the incoming 1m bar (dedup by timestamp, trim to 500 bars)
2. For each of `[{tf:'5m', seconds:300}, {tf:'15m', seconds:900}, {tf:'30m', seconds:1800}]`:
   - Computes `windowStart = Math.floor(candle.time / seconds) * seconds`
   - Collects all 1m bars in the current window
   - Detects window close: `Math.floor((candle.time + 60) / seconds) * seconds !== windowStart`
   - On close: builds final aggregated bar, stores it, adds to `completed` return list
   - On partial: updates the in-progress bar in-place (replace last element if same `windowStart`)
3. Returns `[{ tf, candle }, ...]` — one entry per completed higher-TF window

Helper `_mergeWindow(bars, tfSeconds)` handles OHLCV merge; sits alongside existing `_aggregateCandles()`.

### A2 — Implementation (completed 2026-04-03)

**instruments.js** (`server/data/instruments.js`) — new file, single source of truth for all 16 CME symbols and 6 OPRA underlyings. Key fields per symbol: `databento` (`.c.0` ticker), `dbRoot` (for CSV symbol matching), `category`, `pointValue`, `tickSize`, `tickValue`, `optionsProxy`, `rthOnly`, `sessionHours`, `pdh_rr`.

**Proxy instruments** — three CME symbols use a different Databento root for continuous contracts, but their individual contracts use the micro-prefix:
- `MGC` → continuous `GC.c.0`; individual contracts are `MGCJ6`, `MGCM6` etc.
- `SIL` → continuous `SI.c.0`; individual contracts are `SILH9`, `SILZ6` etc.
- `MHG` → continuous `HG.c.0`; individual contracts are `MHGN2` etc.
- `DATABENTO_ROOT_TO_INTERNAL` map covers both: `GC→MGC`, `SI→SIL`, `HG→MHG` (continuous roots) **and** `MGC→MGC`, `SIL→SIL`, `MHG→MHG` (individual contract roots — added as explicit overrides)

**Zip format (confirmed from downloaded data):** Each downloaded GLBX zip contains data for exactly **one** symbol. Files inside use `stype_in=parent` (not `continuous`) so the CSV rows contain individual contract tickers (`MNQM9`, `MGCJ6`, etc.) rather than `.c.0` notation. Each zip's `metadata.json` has `query.symbols: ["MNQ.FUT"]` — this is used by `getGlbxSymbolFromZip()` in Phase 1b to route extraction.

**historicalPipeline.js rewrite** — major changes:
- Phase CLI: `--phase 1a|1b|1c|1d|1e|1f` — run any single phase
- **Phase 1b** — per-symbol subdirectory extraction: each zip extracts to `raw/GLBX/{SYMBOL}/` (not a flat directory). Uses `getGlbxSymbolFromZip()` to read `metadata.json` from inside each zip to determine the symbol before extracting. Eliminates the filename-collision/skip-if-exists bug that caused all non-first-alphabetical symbols to be silently discarded.
- **Phase 1c** — per-symbol directory scan: reads `raw/GLBX/{SYMBOL}/` for each target symbol; processes one symbol at a time. Progress logged every 500 read files and 200 write dates.
- **`--clean-raw` flag** — deletes `raw/GLBX/` tree and all derived `futures/{sym}/` directories before running. Required before first extraction with the new per-symbol layout.
- **`--force` flag** — Phase 1c bypasses skip-if-exists for derived files (reprocesses all dates).
- Phase 1d: all 6 ETFs (QQQ/SPY/GLD/SLV/USO/IWM), unified `etf_closes.json` via `fetchETFDailyCloses()` from `databento.js` — one call per ETF over full date range using `ohlcv-1d` schema on `DBEQ.BASIC` dataset; incremental (starts from last known date)
- `csvSymbolToInternal()`: handles both `.c.0` continuous (`MNQ.c.0`) and individual contract (`MNQM6`) CSV formats
- `aggregateBars()`: window-aligned using `Math.floor(ts/tfSec)*tfSec` — matches live aggregation in snapshot.js
- `errLog()`: appends to `data/historical/errors.log` (non-fatal per-date errors)

**engine.js refactor** — removed hardcoded `POINT_VALUE` and `HP_PROXY` maps; both now imported from `instruments.js`. All backtest symbols now work automatically.

**Streaming zip fix** — `adm-zip` replaced with `unzipper`. The QQQ OPRA zip is 3.3 GB; `adm-zip` hits Node's 2 GiB buffer limit. `unzipper.Open.file()` reads the zip central directory to seek directly to entries without loading the full archive. `adm-zip` removed from `package.json`.

**OPRA Phase 1e correctness notes (confirmed via `--diagnostic`):**
- OPRA `strike_price` field is already dollar-denominated (`"580.000000000"` = $580) — plain `parseFloat()`, no ÷1e9
- OPRA statistics files contain only per-option-contract rows — there is NO underlying ETF spot price in any `stat_type`; `stat_type=9` = open interest (quantity field); all other types are per-option prices
- `parseDefinitionText` returns plain `Map<id → {strike,expiry,type}>`; `parseStatisticsText` returns `{ oiMap }` only
- Underlying price for Phase 1e comes exclusively from `etf_closes.json` written by Phase 1d
- Phase 1d must run before Phase 1e; Phase 1e reads `etf_closes.json` at start and uses it for every date

**Phase 1d — ohlcv-1d local file extraction (updated v12.3):**

Phase 1d no longer calls the Databento API. Instead it parses files already extracted by Phase 1b from the ohlcv-1d zips Jeff downloaded and placed in `Historical_data/OPRA/{etf}/`.

Identification: Phase 1b finds any non-OPRA-prefixed zip (e.g. `DBEQ-*`) in each ETF folder and confirms `schema === 'ohlcv-1d'` via `metadata.json` before extracting to `raw/OPRA/{etf}/ohlcv-1d/`. Phase 1d then reads those extracted files.

Price format auto-detected per row: `parseFloat(close) > 100000` → fixed-point integer ÷ 1e9; otherwise plain decimal. Handles both `pretty_px=true` and `pretty_px=false` downloads.

**Run sequence for first full extraction:**
```bash
# Clean old flat raw files + old derived data, then extract all zips into per-symbol dirs
# (also extracts ohlcv-1d ETF close zips if present in Historical_data/OPRA/{etf}/)
node server/data/historicalPipeline.js --phase 1b --clean-raw

# Process all 16 symbols (expect 20–40 min — ~55k raw files total)
node server/data/historicalPipeline.js --phase 1c

# Parse ohlcv-1d files → etf_closes.json (must run before phase 1e)
node server/data/historicalPipeline.js --phase 1d

# Process OPRA options data (reads etf_closes.json for underlying prices)
node server/data/historicalPipeline.js --phase 1e
```

### B4 — Implementation

`runScan()` refactored to accept `{ targetSymbols, targetTimeframes }` overrides — all existing callers pass no args and get existing behavior unchanged.

`_onLiveCandle(symbol, candle)` in `server/index.js`:
- Calls `writeLiveCandle()`, gets completed TF array back
- Broadcasts `live_candle` event for each (1m always, higher-TF on close)
- Calls `runScan({ targetSymbols: [symbol], targetTimeframes: [tf] })` per completed window

`_startDatabento()` called at startup when `features.liveData === true`. The seed-mode periodic refresh still runs — it handles crypto/SIL (not on Databento feed) and provides a redundant full scan for futures every 2 minutes.

**MTF confluence in live mode:** Only applies within the same targeted scan call. Cross-TF confluence (e.g. 5m alert confirmed by 15m zone) fires naturally on the 15m bar close — that scan sees both 5m and 15m setups in candidates. Single-TF targeted scans won't cross-confirm, which is acceptable.

---

## Step details

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

### A1 — Purchase + download Databento data

**Status:** 🔵 In progress — data downloaded to `Historical_data/`
**Owner:** Jeff (manual action — no code)

#### Data location

Downloaded files are in:
```
Historical_data/
  CME/        ← GLBX.MDP3 futures zip files
  OPRA/
    QQQ/
    SPY/
    GLD/
    SLV/
    USO/
    IWM/      ← OPRA options zip files per underlying
```

#### What was purchased

**CME Globex futures (for backtest candles):**
- Dataset: `GLBX.MDP3`
- Schema: `ohlcv-1m`
- Symbols: MNQ, MES, MGC, MCL (continuous front-month, `.c.0` notation)
- Format: zstd-compressed zip files, daily partition

**OPRA options (for HP computation):**
- Dataset: `OPRA.PILLAR`
- Underlyings: QQQ, SPY, GLD, SLV, USO, IWM option chains
- Format: zstd-compressed zip files, daily partition

#### Next step

Proceed to A3 (audit roll logic) before running the pipeline.

---

### A3 — Audit front-month roll logic

**Status:** ⬜ To do
**File:** `server/data/historicalPipeline.js` (read-only audit, possible fix)
**Branch:** `feature/databento-historical` (if fix needed)
**Depends on:** Nothing (do before A2)

#### What to audit

Read `historicalPipeline.js` Phase 1c carefully. Answer these questions:

**Q1: Does Databento deliver `MNQ.c.0` (continuous front-month) or individual contract symbols (`MNQU5`, `MNQZ5`)?**

Based on B1 work: Databento uses `.c.0` continuous notation with `stype_in=continuous`. This means Databento handles the roll stitching. Verify that the historical pipeline uses the same `stype_in=continuous` parameter.

If using continuous: Databento handles roll stitching. No price adjustment needed. Proceed to A2.

If individual contracts: the pipeline selects front-month by highest volume per day. Continue to Q2–Q4 below.

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
**Depends on:** A1 (data downloaded ✅), A3 (roll audit complete)

#### What to do

**Step 1: Verify disk space**

Check current `data/historical/` size. Multiply by (target months / 3) to estimate new size. Confirm you have 2× that amount free before proceeding.

**Step 2: Confirm input directory**

Verify `historicalPipeline.js` reads from the correct path for the new data in `Historical_data/CME/` and `Historical_data/OPRA/`. Update `INPUT_DIR` constants if needed.

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

| File | Steps | Status |
|------|-------|--------|
| `server/data/instruments.js` | A2 (create) | ✅ Done |
| `server/data/databento.js` | B1 (create), A2 (`fetchETFDailyCloses` for phase 1d) | ✅ Done |
| `server/data/snapshot.js` | B2, B3 | ✅ Done |
| `server/data/historicalPipeline.js` | A2 (rewrite), A3 (audit before running) | ✅ Code done / ⬜ Run pending |
| `server/backtest/engine.js` | A2 (imports from instruments.js) | ✅ Done |
| `server/index.js` | B2 (datastatus route), B4 (live scan wiring) | ✅ Done |
| `public/index.html` | B2 (status pill) | ✅ Done |
| `server/trading/simulator.js` | B5 | ✅ Done — `checkLiveOutcomes()` added |
| `server/storage/log.js` | B5 | ✅ Done — `updateAlertOutcome()` added |
| `server/analysis/alertDedup.js` | B5 (new) | ✅ Done — `isDuplicate`, `applyStaleness`, `pruneExpired` |
| `server/push/pushManager.js` | B5 (new) | ✅ Done — VAPID push manager |
| `sw.js` | B5 | ✅ Done — push + notificationclick handlers, cache v36 |
| `server/data/hpCompute.js` | A2 (`openInterest ?? oi` backward compat), A4 (run) | ✅ Code done / ⬜ Run pending |
| `config/settings.json` | B2 (`liveData` flag added) | ✅ Done |
| `.env` | B1 (`DATABENTO_API_KEY`), B5 (VAPID keys) | ✅ Done |
| `package.json` | A2 (adm-zip → unzipper) | ✅ Done |

---

## Databento reference (corrected)

- **Live feed implementation:** REST polling, 65s interval, aligned to 5s after bar close — NOT WebSocket
- **REST historical endpoint:** `https://hist.databento.com/v0/timeseries.get_range`
- **Authentication:** HTTP Basic Auth — API key as username, empty password
- **CME dataset:** `GLBX.MDP3`
- **OPRA dataset:** `OPRA.PILLAR`
- **Schema for candles:** `ohlcv-1m`
- **Continuous front-month format:** `MNQ.c.0` (not `MNQ1!`) with `stype_in=continuous`
- **Node client:** None available — use Node.js built-in `https` module
- **Docs:** https://docs.databento.com

---

## Git branch strategy

```
main                              ← stable, always working
feature/databento-live            ← B1–B4 (complete, not yet merged to main)
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

---

## Implementation notes (B6 — OPRA live feed)

### B6 — Key findings

**Separate TCP connection:** OPRA.PILLAR uses the same CRAM auth protocol as GLBX.MDP3 but requires a separate TCP connection to its own gateway (`opra-pillar.lsg.databento.com:13000`).  The dataset field in the auth message changes to `OPRA.PILLAR`.

**Schema:** `statistics` via `stype_in=parent` with symbols `QQQ.OPT,SPY.OPT`.  This delivers per-contract open interest (StatMsg, rtype=24, stat_type=7) and optionally settlement prices.  Greeks (delta/gamma) may or may not be present depending on subscription tier — the handler accepts them if present, ignores if absent.

**Symbol map (rtype=22):** `stype_out_symbol` on the mapping record is the OCC option ticker in padded format (e.g., `"QQQ   261218P00239780"` — 6-char padded underlying).  `_parseOcc()` strips whitespace before parsing to extract underlying, expiry, type, and strike.

**Subscription format (corrected 2026-04-07):** The Databento TCP Live API does NOT support `stype_in=underlying`.  Use `stype_in=parent` with `ROOT.OPT` notation (e.g., `QQQ.OPT`).  Original code used `stype_in=underlying` with bare symbols, which the server rejected with `"couldn't convert underlying to dbn::enums::SType"`.

**Phase A schema check:** `checkOpraSchemas()` calls `GET /v0/metadata.list_schemas?dataset=OPRA.PILLAR` via REST at startup and logs the result.  This tells us which schemas are available under the current subscription before attempting the TCP connection.

**Feature flag:** `features.liveOpra=true` (activated 2026-04-07).  Toggle with `POST /api/features { "liveOpra": true|false }` (requires restart to start/stop TCP connection).

**CBOE fallback:** If OPRA TCP fails, loses connection, or has no data yet, `getOptionsData()` silently falls through to the CBOE delayed path.  Zero risk to existing behavior.

---

## Standing infrastructure — post-Phase-5 data-layer remediation (v14.33–v14.38)

The following scripts were added during the 2026-04-21/22 data-layer remediation (audit: [data/analysis/2026-04-21_data_artifact_audit.md](../data/analysis/2026-04-21_data_artifact_audit.md)). They are NOT kanban items — they are ongoing maintenance tooling. Full commit-level detail in [CHANGELOG.md](CHANGELOG.md) entries v14.33 → v14.38.

### `scripts/backfillHistoricalWindow.js` — historical 1m gap-filler (v14.36, extended to 16 symbols in v14.40, standing)

Per-symbol per-day Databento REST pull. **Default pool: all 16 CME symbols** — `TRADEABLE_SYMBOLS.concat(REFERENCE_SYMBOLS)` from `instruments.js` (v14.40, closing Bug 8 from the audit). Chunked per-day to stay well under Databento's 10,000-record and rate-limit constraints. Writes `time` field to match the Phase 1 schema unification. Skip-if-complete gate on any (symbol, date) already holding ≥1,300 bars; today's date is always skipped (live feed is appending, Databento has ~15-min ingest lag). Merge-with-existing uses Phase 2 dedup semantics (highest volume wins; ties broken by last occurrence). Per-file `.bak` sidecars on every modified file. Re-aggregates 5m/15m/30m into both `data/historical/futures/{sym}/{tf}/` and `data/historical/futures_agg/{sym}/{tf}/` for every touched date.

v14.40 also exports `backfillSymbolWindow(symbol, lookbackMinutes, {force})` so `server/data/dataRefresh.js` can delegate manual refreshes with `lookbackMinutes > 1440` to the same per-day chunked fetch without spawning a child process. CLI behavior is unchanged.

```bash
# Full 14-day gap-fill across all 16 CME symbols (tradeable + reference)
node scripts/backfillHistoricalWindow.js --days 14

# Pre-v14.40 behavior — 8 tradeable only
node scripts/backfillHistoricalWindow.js --days 14 --tradeable-only

# Single-symbol spot-fix (any of the 16)
node scripts/backfillHistoricalWindow.js --symbol MCL --days 14
node scripts/backfillHistoricalWindow.js --symbol M6E --days 14

# Dry-run first (plan only, no HTTP, no writes)
node scripts/backfillHistoricalWindow.js --dry-run --days 14

# Force re-pull even for files that already have ≥1,300 bars
node scripts/backfillHistoricalWindow.js --force --days 7
```

Run this whenever `scripts/auditInstruments.js` flags a symbol with thin coverage, or after a prolonged live-feed outage where the 15-min quick refresh can't close the gap on its own.

### `scripts/migrateBarSchema.js` — bar-schema normalizer (v14.35, standing, idempotent)

Walks every per-date file under `data/historical/futures/{sym}/{tf}/{date}.json` and (a) rewrites `ts`-field bars to `time`, (b) dedups by resolved timestamp (highest volume wins, last occurrence breaks volume ties), (c) sorts ascending. Shipped in v14.35 as the initial migration (181,120 files rewritten, 9,059 duplicate timestamps collapsed). Idempotent — safe to re-run anytime. Per-file `.bak` sidecars on every modified file.

### `scripts/backfillETFDailyCloses.js` — ETF daily-close REST fetcher (v14.37)

Uses `fetchETFDailyCloses()` in `server/data/databento.js` to pull ETF daily OHLCV via Databento REST (`DBEQ.BASIC`, `ohlcv-1d`) and merge into `data/historical/etf_closes.json`. Introduced v14.37 to populate DIA (MYM options proxy) whose raw zip was never purchased. See the known-limitations section below for dataset floor and source-divergence caveats.

---

## Known limitations / cleanup items

Recorded during the v14.33–v14.38 remediation, queued for future cleanup. None are gate-blocking.

- **Three-writer date-grouping drift.** `historicalPipeline.js` uses ET-anchored tradingDate grouping (bars from a 17:00-ET → 17:00-ET session window belong to the following calendar date); `dailyRefresh.js` uses a fixed-5h ET approximation (no DST compensation); `backfillHistoricalWindow.js` uses UTC-calendar day boundaries. Downstream readers are date-indifferent (they read bar timestamps directly, not the file-name date), so a given session's bars may live in slightly different date files depending on which writer last touched the directory. Cosmetic only; flagged for a future unification pass.
- **DBEQ.BASIC dataset floor is 2023-03-28.** Passing an earlier `--start` to `scripts/backfillETFDailyCloses.js` (or any direct call through `fetchETFDailyCloses()`) returns HTTP 422 `data_start_before_available_start`. Relevant when adding a new ETF to `etf_closes.json`.
- **DBEQ.BASIC and XNYS.PILLAR report non-identical closes for the same ETF on the same date.** On overlapping IWM dates (2023-03-28 → 2026-04-02) observed deltas were typically $0.02–$0.21 (0.01–0.12% of close), with one outlier at $6.68 on 2025-04-02 attributable to a dividend-adjustment methodology difference. Do not mix sources silently — v14.37 preserved the original 1,740 XNYS.PILLAR IWM values in place and kept only the 11 new DBEQ.BASIC post-2026-04-02 dates. If a future task ever needs to bulk-replace ETF closes from DBEQ.BASIC, audit the source-consistency of any downstream computations (HP scaling ratios, resilience) first.

---

*Last updated: 2026-04-22*
*A1–A6 complete. B1–B6 complete. Full pipeline (1b→1g) operational. Final A5 (breadth active): Net +$238K, WR 33.9%, PF 1.584, 9,286 trades. or_breakout+pdh_breakout only, zone_rejection disabled. B6: OPRA live TCP feed (opraLive.js), dual-source options.js, liveOpra feature flag. Data-layer remediation v14.33–v14.38 shipped 2026-04-21/22 — see standing-infrastructure and known-limitations sections above. Next: enable liveOpra, verify strikeCount>0, collect 30 days live data, proceed to C (validation).*
