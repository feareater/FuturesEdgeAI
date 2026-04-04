# FuturesEdge AI — Changelog

All notable changes to this project are documented here, newest first.

---

## [v12.5] — 2026-04-04 — Backtest zone_rejection dedup fix + full A5 run

### Backtest engine: zone_rejection dedup overhaul (`server/backtest/engine.js`)
- **Root cause**: dedup key included `setup.time` (unique per bar), so the same zone could add a new key on every 5m/15m/30m bar — 1-trade-at-a-time was the only gate, leaving ~18 zone_rejection trades/day
- **Fix 1 — zone-level bucketing**: changed dedup key for `zone_rejection` from per-bar timestamp to per-zone-level bucket: `${symbol}-${tf}-zone_rejection-${direction}-${Math.round(setup.zoneLevel / atr * 4)}` (0.25 ATR resolution). Same zone can only fire once per day per TF.
- **Fix 2 — 60-min per-direction cooldown**: after any zone_rejection fires, suppress all zone_rejections for the same symbol+direction for 60 minutes, regardless of zone level. Prevents re-entering failed zone clusters.
- **Fix 3 — cross-TF shared cooldown**: `lastZoneRejTs` declared at symbol scope (outside TF loop), keyed by `date-direction`. A fire on 5m blocks 15m and 30m for the same 60-min window. Prevents the same zone being re-entered on a higher TF moments later.
- **Result**: zone_rejection count in 2022 annual slice dropped from ~6,750 to ~3,928 (42% reduction); trades/symbol/day: ~4 (vs ~7 pre-fix), consistent with genuine signal frequency under 60-min cooldown.

### A5 full-period backtest (full available range)
- 2022 validation results: 5,386 trades total, WR 44.6%, PF 1.063, Gross +$29,332, Sharpe 4.28
  - `zone_rejection`: 3,928 trades (15.6/day), WR 47.3%, gross -$22,781
  - `or_breakout`: 1,031 trades (4.1/day), WR 32.2%, gross +$53,524
  - `pdh_breakout`: 427 trades (1.7/day), WR 49.4%, gross -$1,411
- Full-period (2018-09-24 → 2026-04-01): 34,807 trades, WR 45.1%, PF 1.05, Gross +$136,591, Net -$2,637 (fees $139,228)
  - `or_breakout` sole gross-profitable setup: +$258,937 gross, 3.8/day, 32.4% WR (large avg winners)
  - `zone_rejection` gross loser: -$117,591, 14.2/day, 48.0% WR
  - `pdh_breakout`: -$4,754, 1.4/day, 51.1% WR
  - Pre-fix comparison: zone_rejection 34,122→25,442 (-25%); total 43,735→34,807 (-21%); net P&L -$96K→-$2.6K

---

## [v12.4] — 2026-04-04 — Full Pipeline Complete: Phase 1e/1f + ETF close fixes (Phase R)

### Phase 1b: XNYS.PILLAR ETF close extraction (`server/data/historicalPipeline.js`)
- Loop 3 (OPRA ohlcv-1d) now also validates `dataset=OPRA.PILLAR`; rejects XNYS.PILLAR zips with a clear warning directing Jeff to use `Historical_data/ETF_closes/`
- Loop 4 (new): scans `Historical_data/ETF_closes/` for XNYS.PILLAR ohlcv-1d zips; verifies both `dataset=XNYS.PILLAR` and `schema=ohlcv-1d`; derives ticker from `metadata.json query.symbols[0]` (strips suffix); extracts to `raw/ETF_closes/{ticker}/`; skip-if-exists per file

### Phase 1d: rewritten — XNYS.PILLAR local file parser (`server/data/historicalPipeline.js`)
- Reads `raw/ETF_closes/{ticker}/` (written by Phase 1b loop 4); no Databento API dependency
- Auto-detects price format: `parseFloat(close) > 100000` → fixed-point ÷ 1e9, else plain decimal
- Per-ETF expected price range sanity check with `⚠ UNEXPECTED` flag and warn count on out-of-range values
- Expected ranges updated to 2018–2026+ actuals: QQQ $50–$700, SPY $100–$750, GLD $100–$500, SLV $10–$100, USO $5–$200, IWM $70–$300
- Run result: 1740 dates per ETF, 0 errors; 2019-04-12→2019-11-18 gap is a data gap in purchased XNYS data (expected)

### Phase 1e: remove lastKnownPrice fallback (`server/data/historicalPipeline.js`)
- Removed `lastKnownPrice` map and all seeding/update logic — was propagating a wrong/stale price for dates with no ETF close (e.g. seeding from 2026 price and applying it to 2013 OPRA data)
- Now: when `etfCloses[etf][date]` is null/undefined, logs `[WARN] Phase 1e: {etf} {date}: no ETF close available — skipping` and continues to next date
- Skip-if-exists simplified: no longer reads existing output file to accumulate `underlyingPrice` back into map
- Run result: 10,427 option chain files written (1738/ETF); 9,198 dates correctly skipped (pre-2018-09-24 + 2019 gap); 0 errors

### Phase 1f: HP computation complete
- No code changes required — Phase 1f was already writing to the correct path (`options/{etf}/computed/{date}.json`); engine reads from same path
- HP snapshot path confirmed: `data/historical/options/{etf}/computed/YYYY-MM-DD.json` (NOT a top-level `computed/` dir — docs corrected)
- Run result: ~1736 HP snapshots per ETF (QQQ/SPY/GLD/IWM/SLV: 1736, USO: 1733); date range 2018-09-24 → 2026-04-01; fields: `etfClose`, `futuresClose`, `atmIV`, `totalGex`, `dexBias`, `resilienceLabel`, `scaledMaxPain`, `scaledOiWalls`, `scaledGexFlip`, `computedAt`
- Removed unused `sleep()` helper and stale `symManifest` read in verify phase

### Docs
- CONTEXT_SUPPLEMENT.md: corrected output structure — `options/{etf}/computed/` not `computed/{etf}/`; added note explaining HP path matches engine read path
- CLAUDE.md: added Phase R (v12.3) row to build phases table

---

## [v12.3] — 2026-04-03 — ohlcv-1d ETF Close Extraction (Phase 1b/1d local files)

### Phase 1b: ohlcv-1d zip detection and extraction (`server/data/historicalPipeline.js`)
- New helper `findETFCloseZips(etf)` — finds any non-OPRA zip in `Historical_data/OPRA/{etf}/` (e.g. `DBEQ-*` downloads placed alongside the options zips)
- New helper `findAllETFCloseZips()` — calls above for all 6 ETFs
- New helper `getZipSchema(zipPath)` — reads `metadata.json` inside a zip and returns its `query.schema` string
- Phase 1b now runs a third extraction loop after the OPRA section: identifies ohlcv-1d zips by confirming `schema === 'ohlcv-1d'` via `getZipSchema` (warns and skips any mismatched file), extracts `.csv.zst` files to `data/historical/raw/OPRA/{etf}/ohlcv-1d/` — separate from the options raw files which stay in `raw/OPRA/{etf}/`
- Skip-if-exists applies per extracted file; dry-run mode supported

### Phase 1d: rewritten to parse local extracted files (`server/data/historicalPipeline.js`)
- **Replaced Databento API call** with local file parser — no longer requires `DATABENTO_API_KEY` or `DBEQ.BASIC` subscription; reads files already extracted by Phase 1b
- New helper `tsEventToDate(tsVal)` — converts both `pretty_ts=true` ISO strings and raw nanosecond integers to `YYYY-MM-DD`
- New helper `dateFromFilename(fname)` — extracts 8-digit date from Databento filename pattern (`dbeq-basic-20130401.ohlcv-1d.csv.zst`)
- **Auto-detects price format**: if `parseFloat(close) > 100000` → fixed-point integer, divides by 1e9; otherwise treats as plain decimal. Handles both `pretty_px=true` and `pretty_px=false` downloads
- Logs progress every 200 files per ETF; logs total date count and 3 spot-check samples per ETF (first / middle / last date → close price) for visual sanity check
- Always overwrites `etf_closes.json` as a full rebuild (Phase 1d reads all extracted files each run)
- Warns and continues if a per-file decompression or CSV parse error occurs (`errLog`)

### Run sequence
```bash
node server/data/historicalPipeline.js --phase 1b   # extract ohlcv-1d zips → raw/OPRA/{etf}/ohlcv-1d/
node server/data/historicalPipeline.js --phase 1d   # parse → etf_closes.json
node server/data/historicalPipeline.js --phase 1e   # reads etf_closes.json for underlying prices
```

---

## [v12.2] — 2026-04-03 — OPRA Pipeline Correctness Fixes (Phase P, A2 continued)

### Phase 1d: ETF daily closes via Databento `ohlcv-1d`
- `fetchETFDailyCloses(ticker, startIso, endIso)` added to `server/data/databento.js`
  - Dataset: `DBEQ.BASIC` (configurable via `DATABENTO_EQUITY_DATASET` env var)
  - Schema: `ohlcv-1d`, `stype_in: raw_symbol`
  - Prices: fixed-point ÷ 1e9; date derived from `ts_event` nanosecond timestamp
  - Returns `{ 'YYYY-MM-DD': closePrice }` map
- `phase1d()` rewritten — fetches QQQ/SPY/GLD/SLV/USO/IWM closes from Databento in one call per ETF over full date range; writes/merges `data/historical/etf_closes.json`
  - Incremental: starts from last known date per ticker so re-runs only fetch new dates
  - Graceful no-op if `DATABENTO_API_KEY` not set

### Phase 1e: OPRA parsing correctness fixes
- **Strike price confirmed dollar-denominated**: OPRA `strike_price` field is already in dollars (`"580.000000000"` = $580). Changed to plain `parseFloat()` — no ÷1e9 scaling applied
- **`parseDefinitionText`** simplified: returns plain `Map<id → {strike,expiry,type}>` (previously returned `{ optionMap, nonOptionIds }`); captures only C/P rows; no strike scaling heuristic
- **`parseStatisticsText`** rewritten to OI-only extraction:
  - Removed `nonOptionIds` parameter, `underlyingCandidates`, `UNDERLYING_PRICE_STAT_TYPES`, `underlyingPrice` return value — all dead code
  - Root cause confirmed via `--diagnostic`: OPRA statistics files contain only per-option-contract rows; no underlying ETF spot price row exists in any `stat_type`
  - Now scans only `stat_type=9` (open interest) rows, returns `{ oiMap }` only
- **Phase 1e main loop** updated: loads `etf_closes.json` (written by Phase 1d) at start; `underlyingPrice` resolved from `etfCloses[etf][date]` with rolling last-known-price fallback; removed dead `etf_closes.json` write side-effect at end of loop
- **`phase1e_diagnostic`**: updated to new signatures; loads `underlyingPrice` from `etf_closes.json`; removed "non-option IDs" section; notes that Phase 1d must run first

### `hpCompute.js`: backward-compatible OI field
- All OI reads changed to `c.openInterest ?? c.oi` — supports both old (`oi`) and new (`openInterest`) field name
- Phase 1e output contracts use `openInterest` field; old files with `oi` continue to work

---

## [v12.1] — 2026-04-03 — Historical Pipeline v2 + instruments.js (Phase P, A2)

### A2: instruments.js — single source of truth (`server/data/instruments.js`)
- New file: all 16 CME futures symbols with `databento`, `dbRoot`, `category`, `pointValue`, `tickSize`, `tickValue`, `optionsProxy`, `rthOnly`, `sessionHours`, `pdh_rr`
- Symbols: MNQ, MES, M2K, MYM (equity index); MGC, SIL, MHG (commodity metal); MCL (energy); M6E, M6B (FX); ZT, ZF, ZN, ZB, UB (fixed income); MBT (crypto futures)
- `DATABENTO_ROOT_TO_INTERNAL` map built dynamically — handles GC→MGC, SI→SIL, HG→MHG proxies
- Exports: `INSTRUMENTS`, `ALL_SYMBOLS`, `OPRA_UNDERLYINGS`, `POINT_VALUE`, `HP_PROXY`, `ETF_TO_FUTURES`, `FUTURES_TO_ETF`, groupings by category

### A2: historicalPipeline.js rewrite (`server/data/historicalPipeline.js`)
- **All 16 CME symbols** — reads from `instruments.js` (no hardcoded lists)
- **6 OPRA underlyings** — QQQ, SPY, GLD, SLV, USO, IWM
- **`--phase 1a|1b|1c|1d|1e|1f`** CLI arg — run any single phase independently
- **Full resumability** — `existingDates` Set per symbol pre-computed to skip already-processed dates; memory-safe at 13yr × 16 symbol scale
- **`errLog()`** — appends errors to `data/historical/errors.log` rather than crashing pipeline
- **`eta()`** — ETA estimation logged every 100 dates during Phase 1c
- **Window-aligned `aggregateBars()`** — derives 5m/15m/30m using `Math.floor(ts/tfSec)*tfSec` bucketing (matches live aggregation in snapshot.js)
- **`csvSymbolToInternal()`** — handles both `.c.0` continuous and individual contract (`MNQM6`, `M2KH5`) symbol formats
- **Per-underlying OPRA dirs** — extracts to `raw/OPRA/{underlying}/`; reads from same structure in Phase 1e
- **Unified `etf_closes.json`** — single file for all 6 ETF close prices; 3× retry with 2s delay per date

### A2: engine.js refactor (`server/backtest/engine.js`)
- Removed hardcoded `POINT_VALUE = { MNQ: 2, MES: 5, MGC: 10, MCL: 100 }`
- Removed hardcoded `HP_PROXY = { MNQ: 'QQQ', MES: 'SPY', MGC: null, MCL: null }`
- Both now imported from `server/data/instruments.js` — all symbols supported automatically

### Infrastructure: streaming zip extraction
- Replaced `adm-zip` with `unzipper` (streaming) — `adm-zip` loads entire archive into memory, crashing on 3.3 GB QQQ OPRA zip (Node 2 GiB buffer limit)
- `streamZip(zipPath, onEntry)` — streams entries one-by-one via `unzipper.Open.file()`
- `readZipEntry(zipPath, entryName)` — reads a single named entry without loading full archive
- `adm-zip` removed from `package.json`; `unzipper` added

---

## [v12.0] — 2026-04-03 — Databento Live Data Feed (Phase O, B1–B4)

### B1: Databento REST adapter (`server/data/databento.js`)
- `fetchHistoricalCandles(symbol, startIso, endIso)` — HTTPS Basic Auth, NDJSON parse, normalized output
- `startLiveFeed(symbols, onCandle)` — aligned polling loop (65s, first poll 5s after next bar close)
- `getLiveFeedStatus()` — connected state, lag seconds, last bar times per symbol
- Symbol map: MNQ→`MNQ.c.0`, MES→`MES.c.0`, MGC→`GC.c.0` (GC proxy — same price/oz), MCL→`MCL.c.0`
- Wire format normalization: `rec.hd.ts_event` (nanosecond string), fixed-point prices ÷ 1e9
- Exponential backoff on poll errors: 10s base, 5min cap

### B2: snapshot.js live gate (`server/data/snapshot.js`, `server/index.js`)
- `_isLiveMode()` — reads `features.liveData` from settings.json (5s cache) for hot-toggle support
- `writeLiveCandle(symbol, candle)` — stores incoming 1m bars, deduplicates by timestamp, trims to 500 bars
- `getCandles()` — live gate: when `liveData=true` and symbol is in `LIVE_FUTURES`, returns from in-memory store
- `POST /api/features` route restored in `server/index.js` (was documented but missing from code)
- `GET /api/datastatus` — returns source, lag, last bar times; data source status pill in dashboard topbar

### B3: Real-time candle aggregation (`server/data/snapshot.js`)
- `writeLiveCandle()` now aggregates 1m → 5m / 15m / 30m on every call
- Window alignment: `Math.floor(time / tfSeconds) * tfSeconds` — no lookahead
- Completed windows returned as `[{ tf, candle }, ...]`; partial (in-progress) bars updated in-place
- `_mergeWindow(bars, tfSeconds)` helper extracted alongside existing `_aggregateCandles()`

### B4: Event-driven scan on bar close (`server/index.js`)
- `_onLiveCandle(symbol, candle)` — calls `writeLiveCandle`, broadcasts `live_candle` event for chart, fires `runScan({ targetSymbols, targetTimeframes })` on each completed higher-TF window
- `_startDatabento()` — called at startup when `features.liveData === true`
- `runScan()` refactored to accept `{ targetSymbols, targetTimeframes }` overrides — all existing callers unaffected
- Seed-mode auto-refresh kept for crypto/SIL (not on Databento feed); futures served live

### Infrastructure
- Removed stale Databento zip downloads from project root (GLBX-*/OPRA-* files)
- `Historical_data/` folder added to `.gitignore` (large zip files, not committed)
- `data/` folder added to `.gitignore` — seed files, logs, and backtest results excluded from version control
- `DATABENTO_PROJECT.md` added to repo (integration plan and progress tracker)

---

## [v11.0] — 2026-04-02 — DD Band / CME SPAN Margin Levels (Phase N)

### New: DD Band / SPAN margin-derived price levels
- `riskInterval = CME initial margin ÷ point value` (futures); `priorClose × (0.30 / √252)` (crypto)
- Point values: MNQ=2, MES=5, MGC=10, MCL=100 (USD per point)
- Crypto symbols with DD Band support: BTC, ETH, XRP, XLM
- Five levels per symbol: `priorClose`, `ddBandUpper`, `ddBandLower`, `spanUpper`, `spanLower`
- `computeDDBands()` added to `server/analysis/indicators.js` (exported); used in scan, backtest engine, `/api/ddbands`
- SPAN margins stored in `config/settings.json → spanMargin` block: MNQ=1320, MES=660, MGC=1650, MCL=1200

### New: `scoreDDBandProximity()` confidence modifier in `server/analysis/setups.js`
- Labels and scores (directional — upper/lower variants exist for outside/beyond):
  - `room_to_run` → +8 (price well inside DD band, target has room)
  - `approaching_dd` → +4 (near DD band but not at it)
  - `neutral` → 0 (ambiguous)
  - `outside_dd_upper` / `outside_dd_lower` → −7 (price already outside band)
  - `beyond_dd_upper` / `beyond_dd_lower` → −12 (price significantly extended, close to SPAN)
  - `at_span_extreme` → −20 (price at or beyond SPAN level)
  - `pdh_beyond_dd` → −12 special case for PDH breakouts where prior day's high is beyond the DD band
- `setup.ddBandLabel` and `setup.scoreBreakdown.ddBand` added to every scored setup

### New: Chart layer — DD Bands (`public/js/chart.js`, `layers.js`)
- `ChartAPI.setDDBands(dd)` — draws 5 price lines: DD upper/lower (solid orange), SPAN upper/lower (dashed orange), prior close (dotted gray)
- Layer toggle `ddBands` added to layers.js DEFAULTS and index.html layer list

### New: DD Band topbar widget (`public/index.html`, `alerts.js`, `dashboard.css`)
- `#ddband-widget` shows DD↑ / DD↓ levels and position badge (INSIDE DD / ABOVE DD / BELOW DD / AT SPAN)
- `_fetchDDBands(symbol)` called on page load, symbol change, and SPAN margin save
- `_updateDDBandWidget(dd)` updates badge color based on price position

### New: SPAN Margin settings panel (`public/index.html`, `alerts.js`)
- Collapsible panel in the Layers sidebar with 4 numeric inputs (MNQ/MES/MGC/MCL)
- Save button POSTs to `/api/settings/span` and re-fetches DD bands

### New: Pine Script DD Band lines (`server/index.js` → `/api/pine-script`)
- 5 `plot()` calls for DD/SPAN levels baked in as float constants at generation time
- Grouped under `group_dd` input with toggle

### Backtest: historically accurate DD Bands (`server/backtest/engine.js`)
- `computeDDBands(visibleBars, ...)` called per-bar — no lookahead
- `trade.ddBandLabel` and `trade.ddBandScore` added to each trade record

### Backtest2 UI additions (`public/backtest2.html`, `backtest2.js`)
- New "DD Band" sub-tab in Optimize tab — breakdown table by label (WR, PF, Net P&L)
- DD Band stat card in Summary tab (best/worst label WR) — shown only if ≥10 labelled trades

### Performance stats (`server/analysis/performanceStats.js`)
- `byDDBand` grouping added to `computePerformanceStats()` output

### AI commentary (`server/ai/commentary.js`)
- DD Band context line added to prompt when `setup.ddBandLabel` is set and `extras.ddBands` available

### Infrastructure
- New API routes: `GET /api/ddbands`, `POST /api/settings/span`
- `/api/ddbands` now includes `currentPrice` for widget position badge
- Service worker: `futuresedge-v34` → `futuresedge-v35`

---

## [v10.3.1] — 2026-04-03 — Backtest2 UX: Run Labels, Compare Fixes, Config Restore

### Run labels for backtest jobs (`public/js/backtest2.js`)
- `_jobLabels` object in localStorage (`bt2_job_labels`) stores rename overrides keyed by jobId
- `_getJobLabel(jobId, config)` resolves: override → `config.label` → auto-generated name (`symbols · MM-DD → MM-DD`)
- Optional label input (`#bt2-run-label`) shown in config panel before running — saved into `config.label`
- Inline rename button (✏) on each job row in the Previous Runs list — click to rename in-place
- Job delete also clears the label override from localStorage

### Compare tab fixes (`public/js/backtest2.js`, `backtest2.css`)
- Fixed broken equity curve fetch URL: `/api/backtest/jobs/${jobId}/results` → `/api/backtest/results/${jobId}`
- Compare selector dropdowns now display run label/name instead of raw job ID
- Fixed selector styling: `background: var(--bg-panel)`, `color: var(--text)`, `border: 1px solid var(--border)` — previously unreadable dark-on-dark

### Config panel restore when loading a previous job (`public/js/backtest2.js`)
- `_populateConfigFromJob(cfg)` restores all config fields when clicking a previous job:
  - Date range, symbols, timeframes, setup types, confidence, balance, contracts, fee, max hold
  - Trading hours checkboxes (calls `setExcludeHours(cfg.excludeHours || [])`)
  - Run label input pre-populated (so a rename is obvious)

---

## [v10.3] — 2026-04-02 — Optimize Tab in backtest2 (from trade data)

### New: Optimize tab in backtest2.html (`public/backtest2.html`, `backtest2.js`, `backtest2.css`)
- Fifth tab "Optimize" added to the backtest2 results area — works entirely from
  `_currentResults.trades` already in memory; no new API calls.
- Shows placeholder message when no job is loaded; renders on tab click.

**Confidence sub-tab**
- Setup type + symbol selects (populated dynamically from loaded trades; selection preserved).
- 4 metric cards: optimal confidence floor, WR at optimal, PF at optimal, trade count.
- Threshold table (floors 60/65/70/75/80/85/90%): N, win rate bar, PF, avg R, grade badge.
- Optimal row highlighted with accent left-border + ★; low-N rows get amber badge.
- Sample warning banner when fewer than 30 completed trades.
- MTF confluence impact section (shown when both groups have n ≥ 3).

**Regime sub-tab**
- Direction card: bullish vs bearish win rate bars.
- HP Proximity card: at_level / near_level / other (shown when HP enabled in run).
- Informational notice: regime type / trend alignment / calendar gate not captured in
  backtest trade records (v10.x limitation — gates applied upstream in signal detection).

**Time of Day sub-tab**
- Heatmap grid covering ET hours 9–18, one row per setup type + "All setups" header row.
- Colors: green ≥ 72%, amber ≥ 55%, red < 55%, gray when n < 3.
- RTH hours (9–16) marked with accent top border.
- Trade count shown in cell tooltip.
- Static info note about −10 confidence penalty for sub-50% hours.

**Notifications sub-tab** (static design reference)
- Three tier cards (Tier 1: sound; Tier 2: sound + flash; Tier 3: full alert + banner).
- 5-step deduplication logic list.
- Staleness decay visual with 4 opacity levels.

**CSS** (`backtest2.css`): Added `bt2-opt-*` class family matching existing bt2 variables.

---

## [v10.2] — 2026-04-02 — Optimize Tab (backtest.html)

### New API Route — `/api/performance/optimize` (`server/index.js`, `server/analysis/performanceStats.js`)
- Added `computeOptimizeStats(alerts)` to `performanceStats.js` — computes:
  - `bySetupAndThreshold`: WR/PF/avgR at confidence floors 60/65/70/75/80/85/90% with `optimalFloor` (highest PF where n≥10) and `sampleWarning` (n<30).
  - `byRegime`: trend+aligned / trend+misaligned / range win rates per setup type.
  - `byAlignment`: aligned vs misaligned win rates per setup type.
  - `byCalendar`: nearEvent true vs false win rates.
  - `byMtf`: MTF confluence group win rates (groups with n<5 merged into "MTF other").
  - `byHour`: UTC hour win rates (groups with n<3 excluded).
  - `rawAlerts`: minimal alert fields for client-side per-symbol recomputation.
- Added `GET /api/performance/optimize` route with 5-minute response cache.
- Falls back to archived alerts if alertCache is empty.

### Optimize Tab — `backtest.html`
- New **Optimize** tab alongside the existing **Replay** tab.
- Shared controls: Setup Type and Symbol selects (state saved to localStorage).
- Four sub-tabs:
  - **Confidence Threshold**: metric cards (optimal floor, WR, PF, sample n) + threshold table with inline bar charts, assessment badges (strong edge / marginal / noise zone / no data), MTF confluence impact table.
  - **Regime Gate**: 3 bar-list cards — Regime Type+Alignment, Trend Alignment Gate, Calendar Gate. Inline notice when alignment WR difference <5pp.
  - **Time of Day**: UTC hour heatmap for all 4 setup types (green ≥65%, amber 50–64%, red <50%, gray = no data).
  - **Notifications**: static tier cards (Tier 1/2/3), deduplication logic steps, staleness decay reference.
- Per-symbol recomputation: when Symbol ≠ All, full `_computeOptForAlerts()` runs client-side on `rawAlerts`.
- Loading spinner while fetching; sub-tab selection persisted to localStorage.

---

## [v10.1] — 2026-04-02 — Backtest Bias Fixes, Hour Filter & Compare

### Backtest Engine — Bias Fixes (`server/backtest/engine.js`)
- **Current-bar filter**: Added `if (setup.time !== detectTs) continue` in both backtest loops. Setups only fire when the triggering candle IS the bar that just closed. Eliminates stale entry prices — prior to this fix, `setup.entry = c.close` from a candle 10–20 bars in the past was used as entry, with price already past TP, creating phantom bar-1 wins.
- **OR breakout per-session dedup**: Changed dedup key to `${symbol}-${date}-or_breakout-${direction}` so OR breakout fires at most once per session per direction (first clean break only). Previously fired on every 1m bar above the OR level (63–88 trades/day in some sessions).
- **maxDrawdown from trade sequence**: Replaced daily equity-based drawdown calculation with trade-by-trade running peak-to-trough. Daily netting was masking intraday losses, reporting $0 drawdown on runs with hundreds of losing trades.
- **`seenSetupKeys` dedup key**: Changed from `${symbol}-${date}-${tf}-${type}-${direction}-${round(zoneLevel)}` to `${symbol}-${tf}-${setup.time}-${type}-${direction}`. Zone level was fractional and shifted slightly across bar iterations, allowing the same zone to re-fire with a stale price.

### Backtest Engine — Hour Filter (`server/backtest/engine.js`)
- Added `excludeHours` config parameter (array of ET hours 0–23 to skip).
- Trades whose entry falls in an excluded hour are skipped before outcome resolution.

### Backtest UI — Hour Filter (`public/backtest2.html`, `backtest2.js`, `backtest2.css`)
- New **Trading Hours (ET)** section inside Advanced panel.
- Three session groups: Overnight (18–8 ET), RTH (9–16), After Hours (17).
- Each hour is a checkbox tile — unchecked = skip.
- Preset buttons: **All**, **RTH Only**, **None**.
- Excluded hours saved/restored with config via localStorage.

### Backtest UI — Compare Tab (`public/backtest2.html`, `backtest2.js`, `backtest2.css`)
- New **Compare** tab supporting up to 6 runs side by side.
- Color-coded run selectors with remove buttons; populates from previous runs list.
- **Overlaid equity curves** using TradingView Lightweight Charts, x-axis = trade number (normalizes across different date ranges).
- **Full comparison table** with six sections:
  - Configuration: date range, symbols, timeframes, setup types, min confidence, max hold, fee/RT, contracts, excluded hours
  - Overall Performance: WR, PF, gross P&L, max drawdown, avg win/loss, avg R, expectancy, Sharpe, won/lost/timeout, largest win/loss
  - By Setup Type: WR + P&L per setup (dynamic, based on what's in each run)
  - By Timeframe: WR + P&L per timeframe
  - By Symbol: WR + P&L per symbol (only shown when multiple symbols)
  - By Direction: bullish vs bearish WR + P&L
  - By Confidence: WR per confidence bucket (65–70%, 70–80%, 80–90%, 90%+)
- Best value in each metric row highlighted in green.
- **Export CSV** exports the full rendered table.
- New `GET /api/backtest/jobs/:jobId/results` route used to fetch equity curves for comparison chart.

### Service Worker
- Bumped to `futuresedge-v31`.

---

## [v10.0] — 2026-04-02 — Historical Backtesting System

### Data Pipeline (`server/data/historicalPipeline.js`)
- Phase 1a: Zip inventory — discovers and logs all GLBX/OPRA zip file structure
- Phase 1b: Extracts `.csv.zst` files from zips to `data/historical/raw/`
- Phase 1c: Processes GLBX 1m futures bars → daily JSON files per symbol per TF (1m/5m/15m); front-month selection by volume; lookahead validation
- Phase 1d: Fetches QQQ/SPY daily closes from Yahoo Finance v8 API
- Phase 1e: Processes OPRA definition + statistics CSVs → per-date options OI files; filters ±25% spot, ≤45 DTE, OI > 0
- Phase 1f: Runs Black-Scholes HP computation for each date → `computed/YYYY-MM-DD.json`
- Data coverage: 64 trading days (2025-12-31 – 2026-03-31), MNQ/MES/MGC/MCL, QQQ/SPY options
- Uses `@mongodb-js/zstd` for zstd decompression and `adm-zip` for zip reading (Node 24 native zstd had multi-frame issues)
- Standalone script — runs independently of the server

### HP Computation (`server/data/hpCompute.js`)
- Pure Black-Scholes implementation in JavaScript (no external libraries)
- normalCDF via Horner method (7-decimal accuracy), Black-Scholes delta/gamma
- IV approximation: realized vol proxy from 20-day log returns × term structure factor
- Computes: GEX/DEX, max pain, call/put walls, GEX flip, OI walls, hedge pressure zones, resilience score
- Scales all levels to futures price space via historical ETF→futures ratio
- Skip-if-exists logic + `--recompute` flag

### Backtest Engine (`server/backtest/engine.js`)
- Stateless bar-by-bar replay — `runBacktestMTF()` uses pre-derived 5m/15m/30m files
- CRITICAL: `visibleBars = bars.slice(0, i+1)` — zero lookahead bias
- Outcome resolution via 1m bars: SL/TP touch detection, timeout after configurable max bars
- P&L calculation: point value × contracts − fee per RT
- Full statistics package: WR, PF, avg R, Sharpe, max drawdown, expectancy
- Breakdown by symbol, setup type, timeframe, hour, confidence bucket, HP proximity, resilience label
- `buildMarketContextFromHP()` — applies v9.0 HP scoring from historical snapshots
- Async job system: `launchBacktest()` → jobId; poll `/api/backtest/status/:id`
- Results saved to `data/backtest/results/{jobId}.json` (immutable)

### API Routes (added to `server/index.js`)
- `POST /api/backtest/run` — launch async backtest, returns jobId
- `GET /api/backtest/status/:jobId` — poll status
- `GET /api/backtest/results/:jobId` — full results JSON
- `GET /api/backtest/jobs` — list all jobs
- `DELETE /api/backtest/jobs/:jobId` — delete job + results
- `GET /api/backtest/replay/:jobId?symbol=MNQ&date=2026-01-15` — replay data for chart

### Backtest UI (`public/backtest2.html` + `backtest2.js` + `backtest2.css`)
- Config panel: date range, symbols, timeframes, setup types, min confidence, HP toggle, advanced options
- Summary tab: 9 stat cards, equity curve (TradingView Lightweight Charts), 7 breakdown bar charts
- Trades tab: sortable/filterable table, click-to-replay, CSV export
- Replay tab: animated 1m chart with playback controls (play/pause/step/skip-to-alert), speed selector (1x-500x), HP level lines, running P&L
- Config saved/restored from localStorage
- Previous runs panel with quick load

### Integration
- `buildMarketContextFromHP()` maps historical HP snapshots to v9.0 `marketContext` shape
- `applyMarketContext()` from `setups.js` runs on historical setups → full HP-adjusted confidence in backtest results
- Nav "Backtest" link added to all pages
- Service worker bumped to v26, backtest2 assets added to SHELL_ASSETS

---

## [v9.0] — 2026-04-01 — Three-Layer Confidence Scoring (HP × VIX × DXY)

### New Module: `server/analysis/marketContext.js`
- `buildMarketContext(symbol, indicators, options, getCandles, corrMatrix)` — async, builds a per-symbol context object once per scan cycle
- **HP sub-object**: nearest HP level (type, price, distance_atr), pressureDirection (support/resistance/neutral), inCorridor flag with corridorBounds, freshness decay pts, base multiplier
- **VIX sub-object**: live level, regime (low/normal/elevated/crisis), direction (rising/falling/flat), stressFlag
- **DXY sub-object**: direction, correlationWithSymbol from rolling matrix, instrument-specific alignment bonuses (long/short)
- **Options sub-object**: dexScore, dexBias, resilienceLabel, stressFlag mirror
- All sub-objects degrade gracefully to safe defaults when data is unavailable

### Setup Scoring: `server/analysis/setups.js`
- New exported function `applyMarketContext(baseScore, setup, marketContext)`
- **HP multiplier**: at level ≤0.3 ATR → 1.20 (aligned), 1.05 (neutral), 0.85 (opposing); near level 0.3–0.75 ATR → 1.10; corridor → 1.08 reversal / 0.88 breakout; no nearby → 1.00
- **Resilience multiplier**: resilient → ×1.15 reversal / ×0.90 breakout; fragile → ×0.90 reversal / ×1.15 breakout
- **VIX multiplier**: low → ×1.10 breakout; elevated → ×1.10 reversal / ×0.90 breakout; crisis → ×0.90 reversal / ×0.85 breakout; direction nudge ±0.05
- Combined multiplier clamped to 0.80–1.30
- **Additive bonuses**: DEX ±3–8 pts (direction-aware), DXY ±3–8 pts (instrument-gated), freshness decay 0/−5/−10/−15 pts (halved on 0DTE days)
- `scoreBreakdown.context` field added to every setup object with full breakdown
- Applied after all base scoring and calendar gating in `detectSetups()`

### Scan Engine: `server/index.js`
- `buildMarketContext` called once per symbol per scan cycle before the per-TF loop
- `marketContext` passed to `detectSetups` via `opts.marketContext`
- Economic calendar fetch is now always-on (removed stale `settings.features?.economicCalendar` guard)
- `features` key removed from `computeIndicators` opts (no longer in settings)

### Frontend: `public/js/alerts.js` + `dashboard.css`
- `_fmtContextBreakdown(ctx)` renders context row below base score breakdown
- Shows: base score, combined multiplier (×N.NN), VIX regime badge (color-coded), HP nearest level + distance, DEX/DXY bonuses if non-zero, freshness decay if negative, stress flag warning if high VIX + fragile structure

### Prerequisites resolved
- `server/data/snapshot.js`: `MACRO_SYMBOLS` set added (DXY, VIX, QQQ, SPY, GLD, USO, SLV); exported alongside CRYPTO_SYMBOLS
- `server/analysis/indicators.js`: VP/OR/sessionLevels skip macro symbols (`!isMacro` guard)
- `server/data/options.js`: `lastFetchedAt: Date.now()` added to result before caching; available in all return paths via object spread

---

## [v8.0] — 2026-03-31 — QQQ Options Intelligence + Pine Script Export

### Added — CBOE Options Data Source
- `server/data/options.js` — complete rewrite from Yahoo Finance v7 (broken, requires crumb auth) to CBOE Delayed Quotes API (`cdn.cboe.com/api/global/delayed_quotes/options/QQQ.json`). Free, no auth, returns full chain with delta/gamma/iv/OI per contract.
- Option ticker parser: CBOE format `QQQ260330C00500000` → expiry/type/strike.
- Strike filter: ±25% of spot (excludes deep ITM/OTM which distort GEX and max pain).
- Expiry filter: next 30 days only (nearest-term OI most actionable).

### Added — DEX (Dealer Delta Exposure)
- Computed from CBOE delta × OI across all strikes. Dealers are short options they sold; to stay delta-neutral they hold offsetting futures positions.
- Normalized to −100/+100 score. Bias labels: `bullish` (>20), `bearish` (<−20), `neutral`.
- Displayed in options widget topbar: `DEX: +72 bullish`.

### Added — Resilience Score
- 0–100 composite: GEX sign component (±50), flip proximity adjustment (±30), DEX alignment bonus (±15).
- Labels: `resilient` (≥65), `neutral` (40–64), `fragile` (<40).
- Displayed in options widget topbar: `Resilience: 68 resilient`.

### Added — Liquidity Zones
- Clusters of adjacent strikes where combined OI ≥ 70th percentile. Adjacent strikes grouped into zones.
- Each zone: `{ low, high, center, totalOI, bias }`. Bias: `call` (overhead resistance), `put` (below support), `balanced` (contested pivot).
- Top 5 zones returned; scaled to futures price space.
- Drawn on chart as filled horizontal bands (blue/teal/yellow by bias).

### Added — Hedge Pressure Zones
- Top 5 strikes by |GEX|. Positive GEX = dealer buying support (green). Negative = dealer selling resistance (red).
- Top 3 shown on chart as dashed lines with ▲/▼ labels.

### Added — Pivot Candidates
- Strikes where |callOI − putOI| / totalOI < 25% AND totalOI ≥ median. No dominant dealer direction → natural turning points.
- Top 3 shown on chart as orange dotted lines.

### Added — Accurate ETF→Futures Scaling
- `_fetchDailyLevels()` fetches `MNQ=F` and `QQQ` live prices simultaneously from Yahoo Finance.
- Ratio = `liveFuturesPrice / liveEtfPrice` captured at same moment — eliminates prior ~10% error from mixing stale seed candles with CBOE delayed prices.

### Added — QQQ Daily Reference Levels
- `prevDayOpen`, `prevDayClose`, `curDayOpen` fetched from Yahoo daily endpoint.
- Intraday 5m fallback for `curDayOpen` when daily in-progress candle open is null.
- All three scaled to futures price space and drawn on chart (purple/amber/silver dotted lines).

### Added — Pine Script Export
- `GET /api/pine-script?symbol=MNQ` — generates complete TradingView Pine Script v6 with all levels baked in as constants.
- All levels rendered as `plot()` series — integrated with chart price scale and data window (not overlay drawings).
- `line.new(extend=extend.right)` + `label.new()` at `barstate.islast` adds right-extending lines and labels past the current bar.
- `fill()` between `plot()` pairs creates filled liquidity zone bands.
- Info table (P/C ratio, ATM IV, DEX, Resilience, Max Pain, GEX Flip, timestamp) via `table.new()`.
- Button in nav: `Pine Script` → copies to clipboard. Repaste daily (or mid-session on 0DTE days Mon/Wed/Fri).
- Pine Script v6 syntax: `array.new<float>`, explicit type annotations, individual `array.set()` calls, no trailing dots on floats.

### Fixed — seedFetch.js Micro Tickers
- Changed all SYMBOLS from `NQ=F`/`ES=F`/`GC=F`/`CL=F` to `MNQ=F`/`MES=F`/`MGC=F`/`MCL=F`.
- Full-size and micro contracts trade at slightly different prices; using full-size for micro candles produced ~0.1–0.3% price discrepancy, compounding into incorrect options scaling ratios.

### Fixed — GEX Flip Accuracy
- Added ±25% spot strike filter to exclude deep ITM/OTM options from GEX scan.
- Changed to outward-from-spot scan (alternating above/below) instead of sequential scan — gives nearest actionable flip level rather than a deep OTM artifact.

### Added — Docs (docs.html)
- Full "QQQ Options Levels" section with table of all 8 chart lines, explanations of each metric, widget decoder, and usage guidance.

---

## [v7.0] — 2026-03-04 — All-Setups Scanner + MTF Confluence

### Added — All-Setups Scanner (`/scanner.html`)
- `public/scanner.html` — new page: live table of every active setup across all symbols × timeframes.
- `public/js/scanner.js` — fetches `/api/alerts?limit=100`; connects via WebSocket for instant push on `setup` / `data_refresh` / `outcome_update` events; new-row flash animation.
- `public/css/scanner.css` — scanner-specific styles: confidence bar, MTF pills, near-event badge, sortable headers, WS status dot.
- Columns: Symbol, TF, Setup Type, Direction, Confidence (bar + %), Entry / TP / SL, Regime, MTF confluence pills, Age, View↗ button.
- Filters: Min Confidence, Direction (All/Long/Short), Setup type, Symbol, Status (Open/All), MTF-only toggle.
- Summary bar: total count, MTF count, long/short split, last-update time.
- "View ↗" button writes `bt_jump` to sessionStorage and navigates to the dashboard chart (reuses the existing backtest jump mechanism).
- Scanner nav link added to all pages (index.html, commentary.html, performance.html, backtest.html).

### Added — Multi-Timeframe Confluence
- `server/index.js` `runScan()` — per-symbol, after collecting all setup candidates across all timeframes, annotates each setup where the **same direction** fires on ≥2 timeframes:
  - `setup.mtfConfluence = { tfs: ['5m','15m'], bonus: N }` added to the setup object.
  - Confidence boosted by **+10 per confirming TF** (max +20, capped at 100).
  - Rationale string appended: `· MTF 5m/15m`.
- MTF confluence is visible in the Scanner (TF pills) and in the Alert feed rationale on the dashboard.

### Changed
- `public/sw.js` — cache bumped to `futuresedge-v3`; `scanner.html`, `scanner.js`, `scanner.css` added to SHELL_ASSETS.

---

## [v6.0] — 2026-03-04 — Multi-Timeframe + Crypto Futures

### Added — 1h / 2h / 4h Timeframes (all instruments)
- `server/data/seedFetch.js` — fetches Yahoo Finance `60m` interval for all futures symbols; derives `2h` (2× 1h) and `4h` (4× 1h) and writes seed files.
- `server/data/snapshot.js` — `VALID_TIMEFRAMES` extended to include `'1h'`, `'2h'`, `'4h'`; on-the-fly derivation fallback if seed files are missing.
- `server/index.js` — `SCAN_TIMEFRAMES` updated to `['5m','15m','30m','1h','2h','4h']`.
- `public/index.html` — 1h / 2h / 4h timeframe buttons added.

### Added — BTC, ETH, XRP Crypto Perpetual Futures (Coinbase INTX)
- `server/data/coinbaseFetch.js` — new module; fetches OHLCV from `https://api.international.coinbase.com/api/v1/instruments/{BTC-PERP|ETH-PERP|XRP-PERP}/candles`; response field: `aggregations`; paginates in MAX_BARS=300 windows; derives `4h` from `1h`; graceful warn-and-continue on failures.
- `server/data/seedFetch.js` — calls `fetchAllCrypto()` at the end of every seed refresh.
- `server/data/snapshot.js` — `VALID_SYMBOLS` includes `'BTC'`, `'ETH'`, `'XRP'`; `CRYPTO_SYMBOLS` exported.
- `server/analysis/indicators.js` — `CRYPTO_SYMBOLS` guard: `volumeProfile`, `openingRange`, `sessionLevels` return `null` for crypto (24/7, no RTH session).
- `server/analysis/setups.js` — `CRYPTO_SYMBOLS` guard: PDH RTH filter removed for crypto; OR breakout skipped for crypto; `PDH_RR` entries added for BTC/ETH/XRP (2.0:1).
- `server/index.js` — `SCAN_SYMBOLS` extended to `['MNQ','MGC','MES','MCL','BTC','ETH','XRP']`; crypto symbols bypass economic calendar fetch.
- `public/index.html` — BTC / ETH / XRP symbol buttons; BTC/ETH/XRP contract inputs in filter panel.
- `public/js/alerts.js` — `TICK_SIZE`/`TICK_VALUE` for BTC/ETH/XRP; contract count wiring; `_saveLocal`/`_loadLocal` persistence.
- `public/js/chart.js` — `_computeCVD()` is now crypto-aware: futures reset at RTH 13:30 UTC; crypto resets at midnight UTC daily.
- `config/settings.json` — `btcContracts`, `ethContracts`, `xrpContracts` in risk block.

---

## [v5.0] — 2026-03-04 — Market Depth Upgrade

### Added — HVN/LVN (High and Low Volume Nodes)
- `server/analysis/volumeProfile.js` — new `_extractNodes()` helper: identifies up to 5 High Volume Nodes (buckets ≥ 1.5× mean volume, excluding POC) and up to 3 Low Volume Nodes (buckets ≤ 0.4× mean, within value area).
- `computeVolumeProfile()` return now includes `hvn: []` and `lvn: []` price arrays alongside existing `poc/vah/val`.
- `public/js/chart.js` — `_drawVolumeProfile()` extended: HVN lines drawn amber dotted, LVN lines lavender dotted; both toggled with the existing Volume Profile layer.

### Added — CVD (Cumulative Volume Delta) Sub-Chart
- `public/js/chart.js` — `_computeCVD(candles)`: estimates per-bar delta from OHLCV (`volume × (2×(close−low)/(high−low) − 1)`), resets at RTH open (13:30 UTC); accumulates into session CVD.
- Second TradingView Lightweight Charts instance in `#cvd-container`: green/red histogram (per-bar delta) + blue cumulative line. Time scale synced one-way from main chart scroll/zoom.
- `public/index.html` — `#cvd-container` div added inside `#chart-wrap`; CVD layer checkbox added.
- `public/css/dashboard.css` — `#chart-wrap` changed from `position:relative` to `display:flex; flex-direction:column`; `#chart-container` changed to `flex:1`; `#cvd-container` 120px height (90px mobile), hidden until layer is toggled on.
- Layer key: `cvd` — defaults on; toggling collapses/expands the sub-panel.

### Added — Options Levels (OI Walls, Max Pain, P/C Ratio, ATM IV)
- `server/data/options.js` — fetches Yahoo Finance nearest-expiry options chain for each futures ticker (NQ=F, ES=F, GC=F, CL=F). Computes: top-3 OI walls, max pain strike (standard intrinsic-value minimization), put/call ratio by OI, ATM implied volatility. 1-hour in-memory cache; returns `null` gracefully when data unavailable.
- `GET /api/options?symbol=` — returns `{ symbol, options: {...} | null }`.
- `public/js/chart.js` — `_drawOptionsLevels()`: OI walls rendered as deep-orange dashed lines (`OI1/2/3`, dimming by rank); max pain as magenta dotted line (`MaxPain`). New `ChartAPI.setOptionsLevels(data)` method.
- `public/js/alerts.js` — `_fetchOptionsData()` called on page load and on every `chartViewChange`; `_updateOptionsWidget()` updates topbar P/C ratio and IV% display.
- `public/index.html` — Options Levels layer checkbox; `#options-widget` topbar element (P/C + IV).
- `public/css/dashboard.css` — `.options-widget` and supporting classes.
- Layer key: `optionsLevels` — defaults on; gracefully hides when Yahoo has no options data.

---

## [v4.0] — 2026-03-04 — Trading Intelligence Upgrade

### Added — Historical Setup Archive
- `server/storage/log.js` — `appendToArchive()`, `updateArchiveOutcome()`, `loadArchive()` functions.
- `data/logs/setup_archive.json` — append-only archive; every setup snapshot is written on first detection, never evicted.
- `server/index.js` — `_cacheAlert()` now calls `appendToArchive()`; re-evaluations sync resolved outcomes back to archive via `updateArchiveOutcome()`.
- `GET /api/archive?symbol=&start=&end=&limit=` — query historical setups (newest-first, max 2000).
- `server/index.js` — `userOverride: true` alerts are excluded from open-outcome re-evaluation loop.

### Added — Manual Outcome Marking (Won/Lost buttons)
- `PATCH /api/alerts/:key` — set `outcome: 'won'|'lost'|'open'` on any alert; sets `userOverride: true` so server won't re-evaluate it.
- `public/js/alerts.js` — taken cards with `outcome: 'open'` now show ✓ Won / ✗ Lost buttons; clicking calls the new PATCH endpoint and refreshes the card.
- `public/css/dashboard.css` — `outcome-won` cards now have green background tint; `outcome-lost` cards have red tint. New `.outcome-header-badge` shows ✓ WON or ✗ LOST prominently in the card header.

### Added — Manual Trade Logging
- `POST /api/trades` — `alertKey` is now optional; manual trades get a synthetic key `MANUAL:symbol:timestamp`.
- `public/index.html` — `＋ Trade` button added to Alert Feed panel header; `#manual-trade-form` placeholder div added.
- `public/js/alerts.js` — `_openManualForm()` / `_renderManualTrades()`: manual form with symbol, direction, entry/SL/TP/exit/setup type/notes; renders in a separate "Manual Trades" section in the feed.
- `public/css/dashboard.css` — styles for manual trade form, `MANUAL` badge, `.mf-*` form elements.

### Added — OB/FVG Quality Scoring
- `server/analysis/iof.js` — `detectFVGs()` now accepts `atrCurrent`; both FVGs and OBs get `atrRatio` and `strength: 'strong'|'normal'|'weak'` fields.
  - FVG strong threshold: `atrRatio ≥ 0.8`; weak: `< 0.35`.
  - OB strong threshold: `atrRatio ≥ 1.2`; weak: `< 0.5`.
- `server/analysis/indicators.js` — passes `atrCurrent` to `detectFVGs()`.
- `server/index.js` — API filters updated: weak FVGs excluded; weak tested OBs excluded (mitigated already excluded).

### Updated — Chart Zone Rendering
- `public/js/chart.js` — OBs and FVGs now render with strength-based visual differentiation:
  - Strong OBs: solid, 80% opacity, 2px wide, `OB↑★` label.
  - Tested OBs: dashed, 40% opacity, 1px, `OB↑~` label (tilde = touched).
  - Strong FVGs: 75% opacity, 2px; normal FVGs: 45% opacity, 1px; `FVG↑★` vs `FVG↑`.

### Updated — Enhanced AI Commentary
- `server/ai/commentary.js` — `_buildPrompt()` now accepts optional `extrasMap` per `symbol:tf`:
  - Adds **Zone Context** block per setup: nearby open FVGs, untested/tested OBs (within 2×ATR), Volume Profile POC/VAH/VAL, Asian/London session H/L, historical WR/PF for this symbol.
  - Updated commentary instructions: Claude now specifically asked to reference FVG/OB prices, identify zone-based invalidation, and compare to historical performance.
  - `max_tokens` increased: single 400 → 700; batch 1200 → 2000.
- `server/index.js` — `_refreshCommentary()` builds `extrasMap` from fresh indicators for each alert's `symbol:tf`; single commentary route also builds and passes context.

---

## [v3.3] — 2026-03-04 — Filter Input Width Fix

### Updated — `public/css/dashboard.css`
- `.filter-input` width: 46px → 58px — Min Conf and Max Risk inputs no longer clip numbers with browser spin controls.
- `.filter-input.narrow` width: 32px → 44px — R:R Ratio and contract count inputs now display "2.0" and "5" without truncation.

---

## [v3.2] — 2026-03-04 — Dashboard Layout Redesign

### Updated — `public/index.html`
- **Alert Feed moved to dedicated left panel** (`<aside id="left-panel">`, 280px) — alert feed, WR bar, AutoTrader panel, and filter controls now live on the left side of the chart instead of the right.
- **Correlation Heatmap moved to top of right panel** — now always visible above the layer toggles instead of buried at the bottom below a scrollable list.
- Right panel (`#right-panel`) narrowed to 220px and now contains only Correlation Heatmap + Layers/Features.

### Updated — `public/css/dashboard.css`
- Added `#left-panel` styles (280px, `border-right`).
- `#left-panel #alert-section` given `flex: 1` so alert feed fills the panel.
- `#layers-section` given `flex: 1` + `overflow-y: auto` so layers scroll within the right panel.
- Mobile tab visibility updated: Alerts tab shows `#left-panel`; Layers tab shows `#right-panel`.

---

## [v3.1] — 2026-03-04 — Guide Fully Updated for v3.0

### Updated — `public/docs.html`
- New **Chart Layers** section: all 14 layer toggles explained in grouped cards (Trend Indicators, Structure & Levels, Order Flow/IOF, Session & Volume). Covers EMA 9/21/50, VWAP, PDH/PDL, Swing H/L, Auto/Manual Trendlines, OB Untested/Tested, FVG Open/Filled, Supply/Demand Zones, IOF Confluence Zones, Volume Profile, Opening Range, Session Levels, Correlation Heatmap.
- New **Features & Analysis Tools** section: all 10 feature flag toggles explained (Volume Profile, Opening Range, Performance Stats, Economic Calendar, Relative Strength, Session Levels, Alert Replay, Correlation Heatmap, Sound Alerts, Push Notifications). Includes Performance Page and Backtest/Replay Page usage guides.
- New **Alert Type 4 — Opening Range Breakout** section with rules, bullish/bearish trade parameters, callouts (wide OR risk, calendar awareness), highest-probability version example.
- New **OR Breakout scoring table** added to the Confidence Score section (base 35, break magnitude, regime, alignment, IOF, calendar penalty).
- Updated intro cards: all 4 instruments listed (was MNQ + MGC only); "Four alert types" (was "Three").
- Updated PDH R:R section: added MES (2:1) and MCL (1:1) instrument cards.
- Updated chart markers legend: added `OR` label for OR breakout alerts.
- Sidebar navigation updated with new sections and OR Breakout link.

---

## [v3.0] — 2026-03-04 — Full Feature Expansion (Three Tiers)

### Added — Server Analysis Modules
- `server/analysis/volumeProfile.js` — Session volume profile: POC, VAH, VAL (70% value area). Buckets = 5× tick size per instrument. Returns current + prior session values.
- `server/analysis/openingRange.js` — RTH Opening Range (09:30–10:00 ET = 13:30–14:00 UTC). Returns Hi/Lo/Mid + `formed` flag.
- `server/analysis/sessionLevels.js` — Asian session H/L (00:00–07:00 UTC) and London session H/L (07:00–13:30 UTC).
- `server/analysis/relativeStrength.js` — MNQ vs MES session-normalized ratio and rolling 20-period Pearson correlation. Signal: `mnq_leading` / `mes_leading` / `neutral`.
- `server/analysis/correlation.js` — 4×4 rolling pairwise correlation matrix for all instruments using log returns.
- `server/analysis/performanceStats.js` — Win rate, profit factor, avg R grouped by symbol, setup type, timeframe, UTC hour, direction.
- `server/data/calendar.js` — ForexFactory weekly calendar feed (`ff_calendar_thisweek.json`), 1-hour in-memory cache, symbol-mapped (MNQ/MES←US macro, MGC←USD/rates, MCL←EIA/petroleum).

### Added — New Setup Type
- `or_breakout` in `server/analysis/setups.js` — Opening Range breakout: fires only after OR window closes (10:00 ET), RTH-gated (10:00–16:30 ET), first-close-only. Base confidence 35, +break magnitude (max 20), +regime 15, +align 10, +IOF. SL = opposite OR bound, TP = risk × 2.

### Added — Calendar Gating
- `server/analysis/setups.js` — High-impact event within 15 minutes of a setup trigger for that symbol: confidence reduced by 20 pts (floor 0), `nearEvent: true` flag added.

### Added — New API Routes
- `POST /api/features` — Hot-toggle any feature flag; persists to `config/settings.json`, no restart needed.
- `GET /api/calendar?symbol=` — Upcoming high-impact economic events, optionally filtered by symbol.
- `GET /api/correlation` — Live 4×4 pairwise correlation matrix (uses 5m candles for all 4 symbols).
- `GET /api/relativestrength?base=MNQ&compare=MES` — RS ratio + correlation + signal.
- `GET /api/performance` — Full stats breakdown (overall, bySymbol, bySetupType, byTimeframe, byHour, byDirection).
- `GET /api/alerts` now accepts `?start=ISO&end=ISO` date-range filters for backtest use.
- `GET /api/settings` now returns `features` block in addition to `risk`.

### Added — Feature Flag Architecture
- `config/settings.json` — New `features` block (10 flags). All default `true` except `soundAlerts` and `pushNotifications` (default `false`).
- Scan engine passes `features` to `computeIndicators()` and fetches calendar events before each scan (cached 1h).
- Pattern: `if (settings.features?.featureName) { compute... }` — each feature is independently gated.

### Added — New Instruments
- **MES** (Micro E-mini S&P 500, ticker `ES=F`) and **MCL** (Micro Crude Oil, ticker `CL=F`) added to all scan symbols, seed fetch, autotrader, risk settings.

### Added — Chart Layers (frontend)
- Volume Profile: POC (white dashed), VAH (green dashed), VAL (red dashed), pPOC (dim dotted). Layer key: `volumeProfile`.
- Opening Range: OR Hi / OR Lo (orange solid), OR Mid (orange dashed). Layer key: `openingRange`.
- Session Levels: Asian Hi/Lo (amber dashed), London Hi/Lo (purple dashed). Layer key: `sessionLevels`.
- Correlation Heatmap: collapsible panel in right sidebar, 4×4 CSS grid, color-coded. Layer key: `correlationHeatmap`.
- All new layers wired into `_applyVis()` and saved in `localStorage`.

### Added — UI Components (frontend)
- **Feature toggle section** in Layers panel — server-driven, hot-toggle via `POST /api/features`.
- **Calendar event countdown badge** in topbar (⚠ CPI in 47m) — appears when a high-impact event is within 3h for active symbol.
- **Near Event badge** on alert cards where `setup.nearEvent === true`.
- **RS widget** in topbar — MNQ/MES ratio and signal (bull/bear/neutral), only shown for equity symbols.
- **Sound alerts** — Web Audio API two-tone oscillator; bullish = 440→550Hz, bearish = 550→440Hz. Off by default, toggled via feature panel.

### Added — New Pages
- `/performance.html` + `public/js/performance.js` + `public/css/performance.css` — Performance analytics: summary stat cards, CSS bar charts by symbol/setup/TF/direction, time-of-day heat map (RTH hours), sortable alert table.
- `/backtest.html` + `public/js/backtest.js` + `public/css/backtest.css` — Alert replay: date range + symbol + setup type + confidence filters, step-through navigation, cumulative P&L equity curve (CSS-only), "View on Chart" button.

### Updated — `public/sw.js`
- Cache version bumped to `futuresedge-v2`.
- Added `performance.html`, `backtest.html`, their CSS and JS files to `SHELL_ASSETS`.

### Updated — Tick Values
- `public/js/alerts.js` — Added MES ($5/point, $1.25/tick) and MCL ($100/point, $1.00/tick) to `TICK_SIZE` / `TICK_VALUE`. `_calcRisk()` now handles all 4 instruments.

---

## [v2.5] — 2026-02 — MES + MCL Instruments

### Added
- MES and MCL support across: `seedFetch.js`, `snapshot.js`, `setups.js` (PDH R:R), `confluence.js`, `autotrader.js`, `index.js` (SCAN_SYMBOLS), `settings.json` (risk contracts), `index.html` (symbol buttons).

---

## [v2.0] — 2026-02 — Multi-TF Confluence + Trade Journal

### Added
- Multi-timeframe zone stack scoring (MNQ-only, analysis-validated: 77.8% WR, PF 3.15)
- Trade journal (log trades, set actual entry/SL/TP/exit, notes)
- AutoTrader kill switch + paper simulator
- Alert + commentary persistence across server restarts
- Backtest findings in CLAUDE.md (liquidity sweep removed: 43% WR, PF 0.68)

---

## [v1.5] — 2026-02 — Trendline Detection + PDH Breakout

### Added
- Trendline detection (significance-ranked, ≥3 touches required)
- PDH/PDL breakout setup type
- Scan timeframes refined to 5m/15m/30m (1m/2m/3m removed — stale with 15-min delayed data)
- Delay-tolerant scoring for momentum setups

---

## [v1.0] — 2026-02 — Initial Build (Phases 1–6)

### Phases 1–6 summary
- **Phase 1:** Node.js scaffold, Yahoo Finance seed pipeline, TradingView Lightweight Charts v4
- **Phase 2:** EMA 9/21/50, VWAP, ATR, PDH/PDL, swing H/L, layer toggles
- **Phase 3:** Zone rejection + BOS/CHoCH setup detection, regime classification, WebSocket alert push
- **Phase 4:** Claude AI commentary (on-demand + batch, persisted)
- **Phase 5:** Alert persistence, multi-TF confluence scoring
- **Phase 6:** UI polish (session badge, WS status, exponential backoff, R:R feedback)
