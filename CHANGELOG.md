# FuturesEdge AI — Changelog

All notable changes to this project are documented here, newest first.

---

## [v14.4] — 2026-04-06 — ROADMAP.md + documentation updates

### Added: ROADMAP.md — Master project roadmap
- Single source of truth for project status and planned work
- Sections: Project Status Summary, Completed (grouped by theme), Active Tracks (B-series / ZR-series / Dashboard Bugs / IA-series), Gated milestones (paper trading, EdgeLog), Long-term AI/ML phases, AI Analysis Policy, Key Decisions Log, Pass/Fail Criteria Reference
- CLAUDE.md updated to reference ROADMAP.md at session start

---

## [v14.4a] — 2026-04-06 — Documentation updates: Claude API migration, analysis tracks, backtest defaults

### Modified: AI_ROADMAP.md
- **AI analysis engine**: Replaced all Ollama references with Claude API (claude-sonnet-4-6). Ollama removed from analysis workflow. `POST /api/backtest/analyze` and backtest2.html AI Analysis tab now use Claude API exclusively.
- **Output document requirement**: New key principle — every Claude API analysis session must produce saved output in `data/analysis/{timestamp}_{type}.json` + `.txt`.
- **Zone Rejection Rescue Track (ZR-series)**: New section documenting ZR-A through ZR-E sub-runs to determine if zone_rejection can be made profitable with structural changes (ATR zone depth filter, max retest count, tighter SL, alternative TP).
- **Indicator Weight Calibration (IA-series)**: New section documenting IA1 (HP proximity audit), IA2 (DD Band audit), IA3 (full weight calibration) runs.
- **Paper trading status**: Updated to "B8 pending" — paper trading activates if B8 passes WR >= 40% + PF >= 1.5 on MNQ+MES+MCL (24-month window). Added B8 checklist item to prerequisites.
- **Decisions Deferred**: Local LLM (Ollama) entry updated to "REMOVED — replaced by Claude API."

### Modified: CLAUDE.md
- **Tech stack**: AI analysis row updated from "Ollama (WSL2 Ubuntu)" to "Claude API (claude-sonnet-4-6) — batch analysis + alert commentary"
- **API routes**: Removed `GET /api/ai/ollama/status`; updated `/api/backtest/analyze` description
- **Build phases**: Phase Y description updated to reflect Ollama → Claude API migration
- **Project structure**: Added `data/analysis/` directory for Claude API analysis outputs
- **Backtest system**: Added "Default Backtest Window" note (12–24 months, B8+ uses 24-month)
- **EdgeLog**: Added deferred status section (port 3004, $20–35/month, awaiting paper trading stability)

### Modified: CONTEXT_SUPPLEMENT.md
- **A5 findings**: Added default backtest window note (12–24 months from 2024-01-01)
- **EdgeLog**: Added deferred status section with pricing and audience details

### No code changes — documentation only.

---

## [v14.3] — 2026-04-06 — Bar validation layer + all 8 CME symbols on live feed

### Added: server/data/barValidator.js — 1m bar validation / sanity check
- `validateBar(symbol, bar, previousBar)` — 5-rule validation pipeline:
  1. **Zero/null/NaN guard** — rejects bar entirely if any OHLC field is 0, null, or NaN
  2. **Price continuity** — if open deviates >3% from previous bar's close, clamps open and flags
  3. **Intra-bar consistency** — enforces high >= max(O,C), low <= min(O,C); reconstructs if violated
  4. **Range spike filter** — rolling 20-bar ATR per symbol; range > 5×ATR clamped to open ± 1.5×ATR
  5. **Volume guard** — negative volume clamped to 0; volume > 1M logged as suspect
- `getValidatorStats()` — per-symbol counters: total, flagged, rejected
- Wired into `_onLiveCandle()` in server/index.js — runs BEFORE chart broadcast, disk write, and aggregator
- Defensive re-validation in `liveArchive.js writeLiveCandleToDisk()` — rejected bars skip disk write

### Added: GET /api/barvalidator/stats
- Returns `{ bySymbol: { MNQ: { total, flagged, rejected }, ... } }` for monitoring

### Modified: server/data/databento.js — All 8 CME symbols on live feed
- `LIVE_SUBSCRIBE_SYMBOLS` expanded: added `SI.FUT` (Silver) and `HG.FUT` (Copper)
- `ROOT_TO_INTERNAL` map: added `SI → SIL`, `HG → MHG`
- Full subscription list: MNQ, MES, GC(→MGC), MCL, M2K, MYM, SI(→SIL), HG(→MHG)

### Modified: server/data/snapshot.js — LIVE_FUTURES expanded
- Added SIL and MHG to `LIVE_FUTURES` set — enables live bar storage + seed/live merge for all 8 symbols

### Modified: server/index.js — _startDatabento expanded
- `liveSymbols` array updated to all 8 CME symbols: MNQ, MES, MGC, MCL, SIL, M2K, MYM, MHG
- `_lastValidatedBar` per-symbol state for continuity checks across bars

---

## [v14.2] — 2026-04-06 — Fix phantom price spikes in live chart candles

### Root cause
Live chart candles built from Databento 1-second tick data showed incorrect
high/low values — phantom spikes/wicks jumping to prices that never traded
(e.g., a candle high of 24,660 when surrounding price was ~24,400). Three
independent issues combined to produce the bug:

1. **No outlier filtering** — a single bad tick from the Databento feed
   (price deviating >2% from market) was accepted unconditionally and
   propagated into 1m bars, aggregated 5m/15m/30m bars, and the chart.
2. **Shared mutable references** — `getCandles()` returned direct references
   to the live candle store arrays. When `writeLiveCandle()` mutated bars
   (especially partial higher-TF bars) while a scan or chart read was
   in-progress, the reader saw inconsistent OHLC values (phantom spikes).
3. **No client-side price validation** — the chart's `updateLivePrice()`
   accepted any tick value and immediately applied it to the forming bar
   via `Math.max`/`Math.min`, amplifying any server-side spike that
   slipped through.

### Modified: server/data/databento.js — Spike filter (server-side)
- Added `_lastGoodPrice` per-symbol tracker and `SPIKE_MAX_PCT = 0.02` (2%)
- `_isSpikePrice(symbol, price)` — returns true if price deviates >2% from
  the last accepted price for that symbol
- **ohlcv-1s tick handler (rtype=32)**: rejects tick and logs warning if
  spike detected; only calls `_onTickCb` after spike check passes
- **ohlcv-1m bar handler (rtype=33)**: rejects entire bar if close is a spike;
  clamps high/low to O/C range if they individually spike while close is valid;
  ensures OHLC consistency after clamping (`high >= max(O,C)`, `low <= min(O,C)`)
- `_normalize()` now validates OHLC sanity (high >= low, prices > 0) and
  returns null on failure

### Modified: server/data/snapshot.js — Defensive copies
- `getCandles()` in live mode now returns cloned candle objects
  (`live.map(c => ({ ...c }))`) instead of shared references to the
  `liveCandles` Map — callers (scans, chart) can no longer see mid-mutation state
- `writeLiveCandle()` completed bar return: `{ ...agg }` clone in the
  `completed` array so broadcast recipients hold immutable snapshots
- Partial (in-progress) higher-TF bar updates use `{ ...partial }` to avoid
  mutating objects that may be referenced by earlier `getCandles()` callers

### Modified: public/js/chart.js — Client-side spike filter
- `updateLivePrice()` now rejects ticks that deviate >2% from the current
  reference price (`_liveTickBar.close` or `lastCandle.close`) before
  updating the forming bar — second safety net after server-side filter

---

## [v14.1] — 2026-04-06 — Phase 2 loss analysis gates: DXY + risk-off breadth penalties

### Modified: server/analysis/setups.js — `applyMarketContext()`

Two additive confidence penalties added after all existing multipliers/breadth scoring.
Derived from worst-500-loser analysis of A5 full-period backtest (AI Roadmap Phase 2).

**Gate 1 — Rising DXY + OR breakout: −20 pts**
- Condition: `setup.type === 'or_breakout'` AND DXY direction = `'rising'`
- Basis: `or_breakout + dxyDirection=rising` accounted for ~49% of the worst 500 losses in A5
  (−$44,958 of −$91,787 total). A strengthening dollar consistently reduces breakout momentum
  across all 4 symbols (MNQ/MES/MGC/MCL) and both directions.
- DXY source: `marketContext.breadth?.dollarRegime` (primary, works in both live + backtest),
  falling back to `marketContext.dxy?.direction` (live mode with active DXY feed)

**Gate 2 — Risk-off + equity breadth collapse: −15 pts**
- Condition: `riskAppetite === 'off'` AND `equityBreadth ≤ 1` (at most 1 of 4 equity indices bullish)
- Basis: Structural risk-off headwind — breakout setups face poor follow-through when
  macro conditions are universally bearish (low breadth + suppressed risk appetite)

**Combined effect**
- Gates are additive; both can fire simultaneously: max −35 pts total
- A base score of 65 with both gates → final score ≤ 30 → hard skip at 65% threshold
- Tracked in `setup.scoreBreakdown.context.lossGatePts` for transparency and backtest analysis
- No UI changes — penalty is visible in the alert scoreBreakdown context field

### Modified: server/backtest/engine.js — DXY direction injection
- Both `runBacktestMTF` and `runBacktestSymbolMTF` now inject `computeDxyDirection(dxyData, date)`
  into `mktCtx.dxy.direction` after constructing the per-bar market context. Previously the
  backtest always passed `direction: 'flat'` (from `_minimalContext()`) so Gate 1 would never
  fire in backtests. Now `mktCtx.dxy.direction` matches the `dxyDirection` field on trade records.

### Modified: CLAUDE.md
- Added "Phase 2 Loss-Analysis Gates" subsection to Signal Scoring section documenting
  both gates, their conditions, penalties, and DXY source fallback behavior

---

## [v14.0] — 2026-04-06 — Databento OPRA live feed for HP computation

### Goal
Replace the CBOE delayed options chain (15-min lag) with a real-time Databento
OPRA.PILLAR live TCP feed for HP/GEX/DEX/resilience calculation.  The CBOE path
is preserved as a zero-risk fallback.

### New: server/data/opraLive.js
- `startOpraFeed()` — connects to `opra-pillar.lsg.databento.com:13000` using the
  same CRAM auth protocol as the GLBX futures feed (separate TCP connection)
- Subscribes to `schema=statistics|stype_in=underlying|symbols=QQQ,SPY`
- Handles rtype=22 (symbol map) to build instrument_id → OCC contract lookup
- Handles rtype=24 (StatMsg, stat_type=7 open interest) + direct `open_interest` field
- Accumulates per-strike OI in `Map<etfSymbol, Map<strike, StrikeEntry>>` with
  call/put OI, delta, gamma, IV per entry
- `getOpraRawChain(etf)` — returns `{ options: [...], hasData: bool }` in CBOE-compatible
  format (OCC option ticker + open_interest + gamma + delta) for drop-in use by options.js
- `getOpraStatus()` — `{ connected, lastUpdateTime, strikeCount, totalRecords }`
- `checkOpraSchemas()` — one-shot REST call to `GET /v0/metadata.list_schemas?dataset=OPRA.PILLAR`
  at startup; logs available schemas (Phase A compliance check)
- Reconnects with exponential back-off (5s → 5min) on disconnect
- Override gateway with `DATABENTO_OPRA_HOST` env var

### server/data/options.js
- Added dual-source logic at top of `getOptionsData()`:
  - If `features.liveOpra=true` AND `opraLive.getOpraRawChain(etf).hasData`:
    - Builds a CBOE-compatible `{ current_price, symbol, options }` structure
      from the live OPRA strike map
    - Passes through existing `_computeMetrics()` unchanged
    - Returns result with `dataSource: 'opra-live'`
    - Cache TTL reduced to 5 min for live data (vs 1 hr for CBOE)
  - Falls through to CBOE on any failure (connection down, no data yet, metrics fail)
- CBOE path now sets `dataSource: 'cboe'` on result for client-side source display
- Existing CBOE flow, `_computeMetrics()`, all return fields — fully unchanged

### config/settings.json
- Added `"liveOpra": false` to features block (default off)
- Hot-toggle: `POST /api/features { "liveOpra": true }` — no restart needed

### server/index.js
- `require('./data/opraLive')` imported alongside existing options import
- Startup: `opraLive.checkOpraSchemas()` called first (logs available OPRA schemas),
  then `opraLive.startOpraFeed()` if `features.liveOpra=true`
- Startup summary line updated: shows OPRA live vs CBOE delayed based on flag
- `GET /api/datastatus` now includes `opra: { enabled, connected, lastUpdateTime, strikeCount, totalRecords }`

### public/js/alerts.js
- `_updateOptionsWidget()` source label: shows `"QQQ (OPRA Live)"` when
  `data.dataSource === 'opra-live'`, `"QQQ"` otherwise
- `dataSource` field propagated through `scaledLevels` object

### Activation
1. `POST /api/features { "liveOpra": true }` (hot-toggle, no restart)
2. Or set `"liveOpra": true` in `config/settings.json` before starting
3. Verify: `[opra:live]` log lines appear; `/api/datastatus` shows `opra.connected=true`
4. Verify: options widget shows "QQQ (OPRA Live)" source label

### Constraints preserved
- CBOE path remains fully functional as fallback
- `getOptionsData()` return shape unchanged — marketContext.js/setups.js untouched
- No new npm dependencies — uses Node.js built-in `net`, `crypto`, `https`, `readline`

---

## [v13.9] — 2026-04-06 — Live bar persistence to disk (Phase AC-2)

### Goal
Every completed 1m bar received from the Databento TCP live feed is now written to disk
in the same format as the historical pipeline. Future backtests automatically cover
accumulated live data without re-purchasing or re-downloading historical data.

### New: server/data/liveArchive.js
- `writeLiveCandleToDisk(symbol, candle1m)` — async, fire-and-forget disk writer
  - Derives UTC date (YYYY-MM-DD) from `candle.time`
  - Target: `data/historical/futures/{SYMBOL}/1m/{YYYY-MM-DD}.json`
  - Format: same as historical pipeline — flat JSON array of `{ ts, open, high, low, close, volume }`
    (live candle `time` field mapped to `ts` for engine compatibility)
  - Creates directory with `fs.mkdir({ recursive: true })` if it doesn't exist
  - Deduplicates by timestamp — skips bar if last entry in file has same `ts`
  - Errors caught and logged; never throws, never blocks the scan engine
- `getLiveBarStats(symbols)` — counts bars per symbol, finds oldest/newest date, estimates disk MB
  (used by `/api/livestats`)

### server/index.js
- Added `require('./data/liveArchive')` — imports `writeLiveCandleToDisk` + `getLiveBarStats`
- `_onLiveCandle()` — calls `writeLiveCandleToDisk(symbol, candle)` immediately after
  `writeLiveCandle()` (in-memory store). Only the raw 1m bar is persisted; derived 5m/15m/30m
  bars are not written (the historical pipeline pre-aggregation script handles those when needed).
- New route: `GET /api/livestats` — returns `{ liveBarCount: { MNQ: N, ... }, oldestBar, newestBar, diskMB }`
  Futures symbols only (crypto uses Coinbase, not disk archive).

### New: scripts/pruneOldLiveBars.js
- Removes `data/historical/futures/{sym}/1m/*.json` files older than N days
- Default retention: 90 days; configurable via `--days N`
- `--dry-run` flag — lists files that would be removed without deleting
- Prints summary: files removed/retained, disk space recovered
- Run manually or monthly via Task Scheduler to prevent unbounded disk growth

---

## [v13.8] — 2026-04-06 — 11 new instruments (Phase AC)

### Guiding principle
**Tradeable** instruments (M2K, MYM, MHG) get full setup detection, alert scoring, and scanner presence.
**Reference** instruments (M6B, M6E, MBT, UB, ZB, ZF, ZN, ZT) get charts and breadth data only — no setup scanning.

### instruments.js
- Added `tradeable: true/false` flag to every instrument
- **MHG promoted**: `databento` changed to `MHG.c.0`, `dbRoot` → `MHG`, `continuousRoot: 'HG'` added; corrected `pointValue` 1250→250, `tickValue` 0.625→0.125
- **MBT corrected**: `pointValue` 5→0.10, `tickValue` 25.00→0.50; `category` → `crypto_cme`
- **M6B corrected**: `pointValue` 6250→62500, `tickValue` 0.625→6.25
- **ZF corrected**: `tickSize` 0.015625→0.0078125 (1/128), `tickValue` 15.625→7.8125
- **MYM**: `optionsProxy` → `'DIA'`
- Added `TRADEABLE_SYMBOLS` and `REFERENCE_SYMBOLS` convenience exports
- Added `DIA → MYM` to `OPRA_UNDERLYINGS`

### server/data/databento.js
- Added `M2K.FUT` and `MYM.FUT` to `LIVE_SUBSCRIBE_SYMBOLS`
- Added `M2K` and `MYM` to `ROOT_TO_INTERNAL` map

### server/index.js
- `SCAN_SYMBOLS` expanded: added `M2K`, `MYM`, `MHG`

### server/data/snapshot.js
- `VALID_SYMBOLS` expanded to include all new instruments: M2K, MYM, MHG, M6E, M6B, MBT, ZT, ZF, ZN, ZB, UB
- `MACRO_SYMBOLS` expanded to include all reference instruments (M6E, M6B, MBT, ZT, ZF, ZN, ZB, UB) — prevents VP/OR/session computation for these
- `LIVE_FUTURES` expanded: added M2K, MYM

### server/analysis/setups.js
- `PDH_RR` map: added `M2K: 2.0`, `MYM: 2.0`, `MHG: 1.5`

### public/index.html (dashboard)
- Index group: added M2K, MYM buttons
- Commodities group: added MHG button
- New FX group (Futures mode): M6E, M6B buttons
- Crypto mode: added MBT button
- New Bonds group (Reference section): ZT, ZF, ZN, ZB, UB buttons

### public/js/chartManager.js
- Grid expanded to 3 rows, 11 charts total:
  - Row 1 "Equity Futures" (4 cols): MNQ / MES / M2K / MYM
  - Row 2 "Commodities & FX" (4 cols): MGC / MCL / MHG / M6E
  - Row 3 "Crypto" (3 cols): BTC / ETH / XRP
- Row labels added between sections
- `PRICE_DEC` map updated for M2K (2), MYM (0), MHG (4), M6E (4)

### public/css/dashboard.css
- Added `.chart-grid-commodities` (4-col grid) and `.chart-grid-label` (row header) styles

### public/js/alerts.js
- `TICK_SIZE` / `TICK_VALUE` maps: added M2K, MYM, MHG, SIL
- `cfg` defaults: added `m2kContracts`, `mymContracts`, `mhgContracts`, `silContracts`
- DOM refs: added `m2kInput`, `mymInput`
- `_calcRisk()`: handles M2K, MYM, MHG, SIL
- Filter panel: M2K and MYM contract count inputs
- `_saveLocal` / `_loadLocal`: persist m2k/mym contract counts

### public/scanner.html
- Symbol filter bar: added M2K, MYM, MHG, SIL buttons; reordered (equity → commodity → crypto)

### marketBreadth.js (no code changes needed)
- `EQUITY_SYMBOLS` already includes M2K, MYM ✓
- `COPPER_SYMBOL` already `'MHG'` ✓
- `DOLLAR_SYMBOL` already `'M6E'` ✓
- `BTC_SYMBOL` already `'MBT'` ✓
- `FIXED_INCOME_SYMS` already includes ZT/ZF/ZN/ZB/UB ✓

---

## [v13.7] — 2026-04-06 — AI Roadmap Phase 2: loss analysis export script

### New: scripts/exportLossAnalysis.js
- Scans all `data/backtest/results/*.json`, finds the job with the most trades that includes
  `or_breakout` (A5 full-period baseline: f3ae236b7509, 9,286 trades, 3,543 losers, 38.15% loss rate)
- Extracts all losing trades, sorts by `netPnl` ascending, takes worst 500
- Writes three files to `data/exports/`:
  - `loss_analysis_trades.json` — 500 slim trade records (symbol, setupType, direction, hour,
    confidence, netPnl, all macro/market-context fields)
  - `loss_analysis_summary.json` — aggregated stats by 14 dimensions (symbol, setupType,
    direction, hour, vixRegime, dxyDirection, hpProximity, resilienceLabel, dexBias,
    riskAppetite, bondRegime, copperRegime, equityBreadth bucket, dollarRegime, ddBandLabel)
    plus top-20 feature-pair combinations by count (n ≥ 20) and worst-10 by total P&L impact
  - `claude_analysis_prompt.txt` — complete self-contained prompt ready to paste into claude.ai,
    includes field descriptions, analysis questions, and embedded summary + trade data (~288KB)

### Phase 2 data snapshot (worst 500 losers from A5)
- Total loss in export: −$91,787
- Avg loss per trade: −$183.57
- Worst single trade: −$736 (MGC 2026-02-02 or_breakout)
- Setup mix: 1,998 or_breakout / 1,545 pdh_breakout losers total; worst 500 tilt or_breakout
- Note: `hpProximity = "none"` for all records — HP options data was unavailable for most of
  the backtest period (pre-2023); field is present but not analytically useful in this export

### Next step
Paste `data/exports/claude_analysis_prompt.txt` into claude.ai for Phase 2 loss analysis.
Implement avoidance rules only after reviewing Claude's findings — do not pre-optimize.

---

## [v13.6] — 2026-04-05 — B7 confidence floor optimization + backtest worker stability fixes

### B7 Backtest Results — OR Breakout Confidence Floor Study

**Context:** B6 (minConf 65%, or_breakout, 5m, 9–10 ET, MNQ+MES+MGC+MCL, full period) achieved
37.89% WR / PF 1.949 / Net +$211,177 — below the 40% WR go/no-go threshold. B7 tests whether
a higher confidence floor or broader hour window can lift WR to ≥40%.

**Results:**

| Job | Config | Trades | WR | PF | Net P&L | MaxDD |
|-----|--------|--------|----|----|---------|-------|
| B6 baseline | conf65, 9–10 ET | 5,059 | 37.89% | 1.949 | +$211,177 | $1,946 |
| B7-A | conf70, 9–10 ET | 4,520 | 38.19% | 2.048 | +$199,354 | $1,968 |
| B7-B | conf75, 9–10 ET | 3,843 | 38.49% | 2.092 | +$174,381 | $1,696 |
| B7-C | conf70, allRTH (9–16) | 6,416 | 32.54% | 1.867 | +$248,527 | $3,288 |

**Per-symbol breakdown (B7-A, conf70, 9–10 ET):**

| Symbol | Trades | WR | Net P&L |
|--------|--------|----|---------|
| MNQ | 1,093 | 40.16% | +$80,913 |
| MES | 1,117 | 40.47% | +$36,453 |
| MCL | 944 | 39.72% | +$25,002 |
| MGC | 1,366 | **33.67%** | +$56,986 |

**Go/no-go verdict: NO-GO for all B7 configurations.**

- WR ≥ 40%: ❌ Best was 38.49% (B7-B). PF ≥ 1.5: ✓. Net positive: ✓. Count ≥ 500: ✓.
- Raising confidence 65% → 75% yielded only +0.6pp WR at the cost of −24% fewer trades.
- Extending hours (allRTH) made WR significantly worse: −5.65pp vs 9–10 ET, MaxDD +69%.

**Root cause identified:** MGC is a structural drag. Its or_breakout WR is 33–34% across all
confidence floors (28.8% in allRTH) — the filter does not fix it. MNQ+MES+MCL at conf70 9–10 ET
achieve 40.14% WR combined (1,266 wins / 3,154 trades), which meets the threshold.

**Next step → B8:** Test `or_breakout` with MGC excluded. Config: MNQ+MES+MCL, 5m, 9–10 ET,
minConf 70%, full period. MGC gold futures may require a different setup type or much higher
confidence floor (85%+) — to be studied in a separate B8-MGC sub-run.

---

### Backtest worker stability fixes

**Problem observed during B7:** Full-period 4-symbol parallel backtest jobs appeared stuck at
"15% — Processing 4 symbols in parallel..." for 15+ minutes with no progress updates, causing
false assumption of a hang. Root causes: (1) no progress heartbeat during the 15%→100% stretch,
(2) three concurrent full-period jobs with 12 symbol worker threads competing for synchronous I/O
(24,000+ file reads), and (3) several defensive code gaps.

**Fixes:**

#### Modified: server/backtest/worker.js
- Added `process.on('unhandledRejection', ...)` at top — forwards any uncaught rejection to parent
  thread as `{ type: 'error' }` and exits, preventing silent indefinite hang
- Added `else if (msg.type === 'error')` branch in `w.on('message', ...)` parallel handler — when
  a symbol worker posts an error message (vs crashing), it is now counted as done, the active Set
  is cleaned up, progress is sent, and `resolve()` fires correctly. Previously this message was
  silently ignored (only the `w.on('exit')` guard handled it)

#### Modified: server/backtest/symbolWorker.js
- Added `process.on('unhandledRejection', ...)` — forwards reason to parent, exits with code 1

#### Modified: server/index.js
- Added 2-hour `workerTimeout` per job — marks job as `error` if no `complete` or `error` message
  received within 2h; timeout is cleared on `complete`, `error`, or `exit`
- Fixed `worker.on('exit', code)` — now handles code 0 as well as non-zero: if the outer
  worker.js thread exits cleanly (code 0) without posting `complete`, the job is marked as
  `error: 'Worker exited without completing (code 0)'` instead of staying `running` forever

#### Modified: server/backtest/engine.js (`runBacktestSymbolMTF`)
- Added simulation heartbeat logging: `[BT-SYM] {sym}/{tf}: starting simulation (N days)` at
  loop start, then progress every 25% of days with trade count. Allows distinguishing between
  "preloading", "simulating", and "truly hung" from server logs.

**Performance note:** Full-period jobs (MGC = 3,986 days, MNQ/MES = 1,787 days, MCL = 1,220 days)
take 10–20 min each when run alone. Running 3 simultaneously (12 symbol workers) causes 3–4×
slowdown from I/O contention. Submit large jobs sequentially or one at a time.

---

## [v13.5] — 2026-04-05 — Backtest engine performance: async I/O + per-symbol worker parallelism

### Modified: server/backtest/engine.js

**Task 1 + 2 — Async `_precomputeBreadthAsync()`**
- Replaced sync `_loadDailyClosesForSymbol` with `_loadDailyClosesForSymbolAsync`: chunked `Promise.all` reads (75 files/chunk) replacing sequential `readFileSync` — parallelizes all 16 symbol file reads simultaneously
- Replaced sync `_precomputeBreadth` with `async _precomputeBreadthAsync`: loads all 16 symbols' daily closes in parallel via `Promise.all(ALL_SYMBOLS.map(...))`
- Fast path preserved: if all target dates are in `breadth_cache.json`, returns immediately with zero file I/O (common case after first run)
- Log output now distinguishes cache hits vs computed count and total elapsed ms: `Breadth: N cache hits, M to compute (Xms total)`
- `runBacktestMTF` updated to `await _precomputeBreadthAsync()`

**Task 3 — Per-symbol worker parallelism**
- Added `async runBacktestSymbolMTF(symbol, config)`: standalone single-symbol backtest runner, functionally equivalent to the per-symbol block in `runBacktestMTF` — same dedup logic, same 1-trade-at-a-time enforcement, same trade record schema
- `runBacktestSymbolMTF` uses scalar `lastExitTs = 0` (per-symbol, no cross-symbol state)
- Exported `runBacktestSymbolMTF` and `computeStats` from `module.exports`

**Task 4 — Pre-load date files into memory**
- Added `_preloadSymbolBars(symbol, days, timeframes)`: loads all `futures_agg/{sym}/{tf}/{date}.json` + `futures/{sym}/1m/{date}.json` files into a `{ [tf]: { [date]: bars[] } }` map before the simulation loop
- Both `runBacktestMTF` and `runBacktestSymbolMTF` now call `_preloadSymbolBars` once per symbol, then reference in-memory maps (`preloaded[tf][date]`) throughout the inner loop — eliminates all per-bar-iteration disk I/O
- Pre-load timing logged per symbol: `[BT-MTF/SYM] {sym}: bars pre-loaded in Xms`

### New: server/backtest/symbolWorker.js
- Worker thread entry point for per-symbol parallel execution
- Receives `{ symbol, config }` via `workerData`, calls `runBacktestSymbolMTF`, posts `{ type: 'complete', symbol, trades, equityMap, totalBarsProcessed }` back to parent
- Error path posts `{ type: 'error', symbol, message }` with full stack trace to stderr

### Modified: server/backtest/worker.js
- **Parallel mode (default)**: when `config.parallelSymbols !== false` and `symbols.length > 1`, spawns one `symbolWorker.js` per symbol with concurrency cap `Math.min(symbols.length, 4)`
- Progress messages flow correctly: `15%` on start, then `15 + (completed/total)*82 %` per symbol completion
- Merges symbol results: combines `trades[]`, sums `equityMap` by date, recomputes equity curve and stats via `computeStats()`
- `meta.parallelSymbols: true` flag in results for diagnostics
- **Sequential fallback**: `parallelSymbols: false` in config → original `runBacktestMTF` path unchanged
- Exit guard on child workers: if a worker exits without sending `complete`, counts as done and logs error rather than hanging

### Performance results (verified identical outputs)
- Smoke test: MNQ + MES, Q1 2025, `or_breakout` only, 9–10 ET — **130 trades, 43.1% WR, PF 2.173, $6,510 Net** — identical in both modes
- Parallel: **26s** vs Sequential: **44s** — ~1.7× speedup for 2 symbols; 4-symbol jobs expected ~3–4× speedup
- Breadth cache fast path: warm-cache precompute now logs `N cache hits, 0 computed (Xms)` — effectively instant

---

## [v13.4] — 2026-04-06 — Databento TCP live feed + real-time chart

### Rewrite: server/data/databento.js — live feed now uses Databento TCP Live API
- Replaced REST polling loop (`_doPoll`, `POLL_INTERVAL_MS=65s`, `END_OFFSET_SECS=600`) with persistent TCP connection to `glbx-mdp3.lsg.databento.com:13000`
- Authentication: CRAM challenge-response — `SHA256("<challenge>|<apiKey>")` hex + `-` + last 5 chars of API key
- State machine: plain-text handshake phases `version → cram → auth → data`; only the `data` phase uses JSON.parse
- Subscription: `stype_in=parent` with `MNQ.FUT,MES.FUT,GC.FUT,MCL.FUT`; encoding=json, ts_out=1
- Added second subscription `schema=ohlcv-1s` on the same connection — 1s bars used as live price ticks
- `rtype=22` (symbol mapping) → `stype_in_symbol` field (e.g. `"MNQ.FUT"`) strip `.FUT` → ROOT_TO_INTERNAL lookup → instrument_id map
- `rtype=32` (ohlcv-1s) → extract close price → `_onTickCb(symbol, price, time)` → broadcast `live_price` to clients (same path as Coinbase WS for crypto)
- `rtype=33` (ohlcv-1m) → normalize and emit via `_onCandleCb(symbol, candle)` → `_onLiveCandle()` → scan engine
- `ROOT_TO_INTERNAL` map: `{ MNQ:'MNQ', MES:'MES', GC:'MGC', MCL:'MCL' }` — GC.FUT maps to MGC (same price/oz)
- Reconnect: exponential backoff (5s base, 5min cap) on any connection close or error; `_stopped` flag prevents reconnect after `stopLiveFeed()`
- Added `stopLiveFeed()` export — destroys socket, cancels reconnect timer
- `startLiveFeed(symbols, onCandle, onTick)` — added optional `onTick` for 1s price ticks
- Throttled tick log: first tick per symbol per minute logged as `[databento:live] tick SYM price`
- `getLiveFeedStatus()` unchanged shape: `{ connected, lagSeconds, lastPollTime, lastBarTimes, symbols }`
- All historical functions (`fetchHistoricalCandles`, `fetchETFDailyCloses`, `_dbGet`, `_parseBody`, `_normalize`) unchanged — historical pipeline unaffected

### Confirmed wire format (live API, 2026-04-06)
- Handshake: plain-text `key=value` lines (NOT JSON) — `lsg_version=0.8.0`, `cram=<challenge>`, `success=1|...`
- Symbol mapping record: `rtype=22`, field `stype_in_symbol` = `"MNQ.FUT"` (strip `.FUT` → ROOT_TO_INTERNAL), `stype_out_symbol` = actual contract e.g. `"MNQM7"`
- OHLCV-1s bar record: `rtype=32`; OHLCV-1m bar record: `rtype=33`
- All 4 symbols confirmed flowing: MNQ/MES/MGC/MCL bars at 01:53 UTC 2026-04-06, ticks confirmed

### Fix: server/data/snapshot.js — seed + live merge
- `getCandles()` in live mode previously returned only live bars once any bar arrived, losing all seed history
- Now merges: seed bars with `time < firstLiveBar.time` prepended to live bars, trimmed to `MAX_LIVE_BARS`
- Seed data provides historical backdrop; live bars extend it seamlessly — chart shows full history from day one of live mode

### Modified: server/index.js — `_startDatabento()`
- Passes `onTick` callback to `startLiveFeed()` — broadcasts `{ type: 'live_price', symbol, price, time }` on every 1s bar close
- Futures `live_price` events now flow to all connected clients on the same WS path as Coinbase crypto ticks

### Modified: public/js/chart.js — real-time in-progress bar
- Added `_liveTickBar` state variable — tracks the forming candle for the current TF window
- `updateLivePrice(symbol, price, time)` rewritten: aligns tick to current TF window (`floor(time/tfSecs)*tfSecs`), builds/extends `_liveTickBar` with correct O/H/L/C, calls `candleSeries.update()` — chart moves second-by-second
- `updateLiveCandle(symbol, timeframe, candle)` — new method; replaces `_liveTickBar` with completed bar when `live_candle` WS message arrives; resets `_liveTickBar = null`
- `_liveTickBar` reset to `null` on each `loadData()` call

### Modified: public/js/alerts.js — `live_candle` handler
- Added `live_candle` WS message handler → calls `ChartAPI.updateLiveCandle(symbol, timeframe, candle)`
- `live_price` comment updated: now covers both Coinbase crypto and Databento futures ticks

---

## [v13.3] — 2026-04-05 — Multi-symbol chart grid + 1m timeframe

### New: public/js/chartManager.js
- Manages grid vs single chart mode via `localStorage 'fe_chart_mode'`
- **Grid mode**: 7 simultaneous TradingView mini charts — MNQ/MES/MGC/MCL (4-column) + BTC/ETH/XRP (3-column)
- Each grid cell: symbol label, live price display (green/red up/down), candlesticks, EMA9/EMA21/VWAP overlays
- Per-cell TF selector: 1m / 5m / 15m / 30m (selections persisted to localStorage per symbol)
- Click any grid cell → switches to single mode and loads that symbol
- Live price updates from Coinbase WebSocket (`livePriceTick` DOM event from alerts.js)
- Data refresh on `dataRefresh` DOM event (Databento candle close or periodic seed refresh)
- Mode toggle button (`Grid` / `Single`) in the timeframe row of the topbar
- Parallel data loading via `Promise.all` — all 7 charts load simultaneously
- Graceful no-data handling: "1m requires live feed" message for symbols without 1m seed data

### Modified: public/index.html
- Added `1m` as first option in the timeframe selector
- Added chart mode toggle button (`#chart-mode-toggle`) in the TF row, right-aligned
- Added `#chart-no-data` overlay div inside `#chart-wrap` (shown on 1m seed-mode errors)
- Added `#chart-grid-container` div in `#main` (sibling to `#chart-wrap`)
- Added `<script src="/js/chartManager.js">` load after alerts.js

### Modified: public/js/chart.js
- `loadData()`: clears `#chart-no-data` overlay on each load attempt
- `loadData()`: on `/api/candles` 400 error with `tf=1m`, shows "1m data requires live feed" message instead of throwing — no console error for expected missing seed files
- Added `chartLoadSymbol` DOM event listener — allows chartManager.js to switch the single chart to any symbol/TF without simulating button clicks

### Modified: public/js/alerts.js
- `live_price` WS handler: dispatches `livePriceTick` CustomEvent (detail: `{ symbol, price }`) for grid mode price cells
- `data_refresh` WS handler: dispatches `dataRefresh` CustomEvent for grid chart refresh

### Modified: public/css/dashboard.css
- `.chart-mode-toggle` — topbar toggle button, right-aligned in TF row; `.grid-active` state fills accent color
- `#chart-no-data` — centered overlay inside `#chart-wrap`, semi-opaque dark bg, shows on 1m seed-mode errors
- `#chart-grid-container` — flex column, scrollable, 8px padding/gap
- `.chart-grid-futures` — 4-column CSS grid
- `.chart-grid-crypto` — 3-column CSS grid
- `.chart-grid-cell` — 280px height, dark background, hover border highlight, flex column
- `.chart-grid-cell-header` — symbol label + price display + expand icon
- `.chart-grid-tf-selector` + `.chart-grid-tf-btn` — per-cell TF buttons (1m/5m/15m/30m)
- `.chart-grid-chart-area` — fills remaining cell height
- `.chart-grid-loading` — absolute overlay spinner/message per cell
- Responsive: 2-column layout on ≤1200px (futures), 2-column across both rows on ≤768px

### 1m timeframe — seed data availability
- MNQ, MES, MGC, MCL, SIL: 1m seed files exist → 1m works in seed mode
- BTC, ETH, XRP, XLM: no 1m seed files → shows "1m data requires live feed" message
- In live mode (Databento): 1m futures bars are written by `writeLiveCandle()` and available via `/api/candles`

---

## [v13.2] — 2026-04-05 — Backtest performance: worker threads + breadth cache + TF pre-aggregation

### Fixes (added post-release)

- **Fix: GET /api/candles now correctly serves seed data when live data unavailable**
  - Root cause: `features.liveData = true` in settings.json, but Databento polling was failing with 422 errors, leaving the live candle store empty. `getCandles()` returned `liveCandles.get(...) ?? []` — an empty array — instead of falling back to seed files.
  - Fix in `server/data/snapshot.js`: when live mode is active but the in-memory store for `symbol:timeframe` is empty, log a warning and fall through to seed data. Seed files always serve as the base layer; live data only overrides when actually populated.

- **Fix: Databento poll end time offset — subtract 10 min buffer to stay within available data range and eliminate 422 errors**
  - Root cause: `_doPoll()` set `end=now`. Databento's historical REST API has a ~5–10 minute processing lag — requesting bars from the last few minutes returns 422 "Unprocessable Entity".
  - Fix in `server/data/databento.js`: `END_OFFSET_SECS = 600` (10 minutes). Poll window end is now `now - 10m`, keeping all requests within Databento's available data range.
  - Also added specific 422 error message so the root cause is immediately visible in logs.
  - `getLiveFeedStatus()` lag calculation now uses most recent bar timestamp (not last poll time) for accurate data-currency reporting.

- **Note: Databento Live WebSocket API does not yet exist**
  - Investigated switching from REST polling to Databento's Live WebSocket API. Found that Databento's WebSocket API is on their public roadmap but not yet released (as of 2026-04-05). Their live feed uses a binary TCP protocol (DBN format, port 13000) for which no Node.js client exists. The existing REST polling approach is the correct implementation for current Databento subscriptions.

### Fixes and improvements (live feed diagnostics)
- **Fix:** `commentary.json` corruption handling — `loadCommentaryCache()` now logs `[log] commentary.json corrupted — resetting cache`, writes a clean empty file, and returns the default object instead of only logging the raw parse error.
- **Fix:** Autotrader skip logging consolidated to one summary line per scan cycle: `[autotrader] Scan complete — N trades executed (M skipped: K disabled)`. Eliminates per-alert `[autotrader] Skipped …` spam when kill switch is off.
- **Improvement:** Startup data source summary block — printed after all init, showing market data / options / crypto / VIX / DXY / calendar / backtest / live feed status at a glance.
- **Improvement:** Seed data staleness warning at startup — logs age of each SCAN_SYMBOL 5m file; warns if any file is older than 7 days.
- **Improvement:** VIX/DXY lookup date logged per symbol per scan cycle (`[marketContext] VIX lookup date: …` / `[marketContext] DXY lookup date: …`) so data currency is easy to verify.
- **Improvement:** CoinbaseWS tick summary — logs combined BTC/ETH/XRP prices once per minute when receiving live data.

### B6 Backtest Results (2026-04-05)
- Config: or_breakout only, hours 9-10 ET, minConf 65, full period 2018-09-24 → 2026-04-01, 5m only
- Results: 5,059 trades, WR 37.89%, PF 1.949, Net $211,177, MaxDD $1,946, Sharpe 6.19
- vs A5: WR +4.0pp, PF +0.365, Net P&L -$26,864 (45.5% fewer trades), MaxDD -$962
- Verdict: ⚠️ B7 recommended — WR 37.9% below 40% threshold; confidence floor test (minConf 75) is next step

### Phase A — Worker Threads (non-blocking job execution)
`runBacktestMTF` was synchronous despite being declared `async` — it blocked the Express event loop for 10–20 min per job, preventing any other requests from being served during a backtest run.

**New file: server/backtest/worker.js**
- Runs `runBacktestMTF` in a dedicated `worker_threads` Worker
- Writes results to disk directly (`data/backtest/results/{jobId}.json`) — avoids large IPC serialization
- Sends compact `{ type: 'progress', phase, pct, message }` messages during execution
- Sends `{ type: 'complete', stats }` on success; `{ type: 'error', message }` on failure

**Modified: server/backtest/engine.js**
- `runBacktestMTF(config, onProgress = null)` — optional progress callback parameter
- `onProgress` fired at: breadth start (5%), breadth done (15%), after each symbol-TF unit (15→97%), done (100%)

**Modified: server/index.js**
- Added `const { Worker } = require('worker_threads')` and `const crypto = require('crypto')`
- `workerJobs` Map — tracks in-progress and recently completed worker jobs
- `MAX_CONCURRENT_JOBS = 4` — returns HTTP 429 if exceeded
- `POST /api/backtest/run` — spawns Worker, returns `{ jobId }` immediately (non-blocking)
- `GET /api/backtest/status/:jobId` — checks `workerJobs` first (for running jobs), falls back to disk
- `GET /api/backtest/jobs` — merges live worker jobs + disk jobs, de-duplicates by jobId
- `GET /api/backtest/results/:jobId` — returns 404 while job is running, reads disk when complete
- Removed `launchBacktest` from engine import (replaced by Worker-based launch)

**Modified: public/js/backtest2.js**
- `pollJob()` — extracts `pct` and `message` from `status.progress` object
- `showProgress(show, label, pct)` — new `pct` param drives `#bt2-progress-fill` width

### Phase B — Breadth Cache
`_precomputeBreadth()` was reading ~46,470 files (16 symbols × ~2,900 dates) on every backtest run — the single largest startup cost (60–90s).

**Modified: server/backtest/engine.js — `_precomputeBreadth()`**
- Checks `data/historical/breadth_cache.json` on startup
- Only computes dates missing from the cache
- Saves newly computed dates back to cache file (graceful write failure — just warns)
- Cache hit path: O(dates) lookup, no file I/O

**New file: scripts/precomputeBreadth.js**
- Standalone script to pre-populate full breadth cache
- Resumable: re-running skips already-cached dates
- Saves progress every 100 dates (crash-safe)
- `--force` flag to recompute all dates
- Usage: `node scripts/precomputeBreadth.js`

### Phase C — TF Pre-aggregation
`loadDailyBars()` was reading pre-derived 5m/15m/30m files from `data/historical/futures/{sym}/{tf}/` — these already exist from the Databento pipeline. Phase C adds an alternate path for custom pre-aggregated files.

**Modified: server/backtest/engine.js — `loadDailyBars()`**
- Checks `data/historical/futures_agg/{symbol}/{tf}/{date}.json` first (for non-1m TFs)
- Falls back to existing `data/historical/futures/{symbol}/{tf}/{date}.json`
- Results are identical — purely a read-path optimization

**New file: scripts/precomputeTimeframes.js**
- Aggregates 1m → 5m/15m/30m using clock-aligned windows (`:00/:05/…`)
- OHLCV rules: open=first, high=max, low=min, close=last, volume=sum, ts=window open
- Skip-if-exists by default; `--force` to overwrite
- `--symbol MNQ` flag to process one symbol only
- Usage: `node scripts/precomputeTimeframes.js [--symbol SYM] [--force]`

---

## [v13.1] — 2026-04-04 — Local LLM backtest analysis chat (AI Roadmap Phase 1)

**Fix:** Replaced raw trade dump with pre-computed feature combination summaries in Ollama system prompt — fits within 32B context window and gives more accurate analysis. Added Rule 1 instructing model to use pre-computed stats rather than recalculating from raw records.
**Fix:** Removed hard timeout from Ollama streaming — replaced with user-controlled Cancel button; streams run until complete or explicitly cancelled. AbortError treated as clean completion so partial responses are preserved in the UI.
**Fix:** `_checkOllamaStatus()` moved to tab-click only — was blocking job list population on page load. `_initAiTab()` now uses null guards on every element access so a missing/cached AI tab HTML never throws and never aborts the DOMContentLoaded handler. AI tab button click listener moved from `bindEvents()` into `_initAiTab()` (single ownership).

### New file: server/ai/ollamaClient.js
- `checkOllamaHealth()` — 5s health check against Ollama `/api/tags`; returns `{ available, models, error? }`
- `buildBacktestSystemPrompt(jobResults)` — serializes full trade records + stats breakdown into a structured system prompt with instrument definitions, context field explanations, and strict analysis rules (n≥30, conditional rule format)
- `streamOllamaResponse()` — NDJSON streaming from Ollama `/api/chat` endpoint; 120s timeout; full conversation history support for multi-turn follow-up questions

### New API routes (server/index.js)
- `GET /api/ai/ollama/status` — Ollama health check + available models list + currentModel + baseUrl
- `POST /api/backtest/analyze` — SSE streaming endpoint; loads job results from disk, builds full context prompt, streams Ollama response token by token

### Updated: public/backtest2.html
- New 6th tab: 🤖 AI Analysis (tab `data-tab="ai"`, panel `#bt2-tab-ai`)

### Updated: public/js/backtest2.js
- New AI state vars: `_bt2AiHistory`, `_bt2AiStreaming`, `_bt2AiJobId`, `_bt2AiCurrentAssistantEl`, `_bt2AiOllamaOnline`
- `_initAiTab()` — wires all AI tab event listeners; called from DOMContentLoaded
- `_checkOllamaStatus()` — fetches `/api/ai/ollama/status`, updates badge + model selector
- `_updateModelHint()` — speed hint based on selected model name
- `_refreshAiContext()` — reads `_currentResults` to update context bar; clears conversation on job change
- `_sendAiMessage()` — SSE fetch + streaming reader; token-by-token update of assistant bubble
- `_appendMessage()`, `_appendThinking()`, `_unlockAiInput()`, `_clearAiConversation()`, `_scrollAiToBottom()` — chat UI helpers
- `loadResults()` hook — calls `_refreshAiContext()` when AI tab is active and a new job loads
- Model selector dropdown: day use `qwen2.5:32b` / overnight `llama3.3:70b`
- Starter question chips aligned with AI_ROADMAP.md Phase 1 analysis questions
- Graceful degradation when Ollama not running (red badge + disabled input)
- Context bar shows loaded job label and trade count; auto-clears conversation when job changes

### Updated: public/css/backtest2.css
- AI Analysis tab styles: `.ai-header`, `.ai-status-row`, `.ai-status-badge`, `.ai-status-dot`, `.ai-model-selector`, `.ai-context-bar`, `.ai-chat-area`, `.ai-starters`, `.ai-chips`, `.ai-chip`, `.ai-message`, `.ai-message-user`, `.ai-message-assistant`, `.ai-error`, thinking pulse animation, streaming cursor, `.ai-input-area`, `.btn-primary`

### Updated: .env
- `OLLAMA_BASE_URL=http://localhost:11434`
- `OLLAMA_MODEL=qwen2.5:32b`

### Ollama infrastructure
- Running in WSL2 Ubuntu as systemd service
- Models stored on D:\ollamaModels (8TB HDD), accessible at `localhost:11434` via mirrored networking
- Models: `llama3.1:8b` (pulled), `qwen2.5:32b` and `llama3.3:70b:q3_k_m` (downloading)

---

## [v13.0] — 2026-04-04 — B5: Forward-test harness, alert dedup, browser push notifications

### Piece 1: Real-time outcome tracking
- `checkLiveOutcomes(symbol, candle1m)` in `server/trading/simulator.js` — checks all open alerts for the given symbol against each incoming 1m bar
- SL checked before TP on the same bar (conservative: spike/gap resolves as SL)
- Alerts missing entry/SL/TP fields are skipped silently
- `updateAlertOutcome(alertKey, outcome, exitPrice, outcomeTime)` added to `server/storage/log.js` — persists resolution to `alerts.json` immediately
- Wired into `_onLiveCandle()` in `server/index.js` after each `runScan` call
- In-memory `alertCache` synced with resolved outcome fields immediately after file write
- WebSocket broadcast on resolution: `{ type: 'outcome_update', resolved: [key, ...] }`

### Piece 2: Alert deduplication + staleness decay
- New module `server/analysis/alertDedup.js`
  - `isDuplicate()`: suppresses repeat signals at the same zone — same symbol/type/direction, within 15-min cooldown, within ±0.25×ATR zone proximity
  - `applyStaleness()`: tags open alerts `fresh` / `aging` (30 min, ×0.85) / `stale` (60 min, ×0.70); `decayedConfidence` is display-only — `confidence` is immutable
  - `pruneExpired()`: drops open alerts older than 4 hours from the in-memory cache
- `_lastAtr` map in `index.js` caches ATR per `symbol:tf` during `runScan` for proximity checks
- `isDuplicate` wired into `_cacheAlert()` — zone-level dedup runs on every new alert (not re-evals)
- `applyStaleness` + `pruneExpired` called at the end of every `runScan` cycle
- Alert feed UI: AGING badge (amber) and STALE badge (red) on applicable alert cards; `decayedConfidence` shown in place of `confidence` when aging/stale
- Alert schema additions: `staleness` (`fresh`|`aging`|`stale`), `decayedConfidence` (display-only)

### Piece 3: Browser Push API notifications
- `web-push` npm package installed; VAPID keys generated and stored in `.env`
- New module `server/push/pushManager.js` — subscription store (memory + `data/push/subscriptions.json`), `sendPushNotification()`, graceful degrade if VAPID keys absent
- Push subscriptions loaded from disk at server startup
- Push trigger in `_cacheAlert()`: fires when `confidence ≥ 80` AND `staleness === 'fresh'` AND `ddBandLabel` is absent or `room_to_run`; gated on `features.pushNotifications`
- New API routes: `GET /api/push/vapid-public-key`, `POST /api/push/subscribe`, `DELETE /api/push/subscribe`
- Push Notifications collapsible section added to right panel in `public/index.html` (hidden when feature disabled)
- Push subscription UI logic appended to `public/js/alerts.js` — checks support, fetches VAPID key, manages subscribe/unsubscribe lifecycle
- `public/sw.js`: `push` event handler shows OS notification; `notificationclick` focuses or opens dashboard; cache bumped to `futuresedge-v36`

---

## [v12.9] — 2026-04-04 — A5 Final Backtest with Breadth Scoring

### dollarRegime verification (Step 2)
- **No inversion bug found.** The `dollarRegime` mapping in `marketBreadth.js` was already correctly inverted at v12.8: `m6eRegime === 'bearish' → 'rising'`, `'bullish' → 'falling'`, `'neutral' → 'flat'`.
- Spot-check results for 2022:
  - 2022-01-03: M6E close 1.13870, m6eRegime=`bullish` → dollarRegime=`falling`. Correct: EUR/USD was near its local 21-day high on Jan 3 (dollar surge began late January).
  - 2022-06-15: M6E close 1.04860, m6eRegime=`neutral` → dollarRegime=`flat`. Reflects consolidation in the 21-day window.
  - 2022-09-28: M6E close 0.96510, m6eRegime=`neutral` → dollarRegime=`flat`. Near-trough consolidation; 20-bar position signal conflicts with SMA signal → neutral.
- The 21-day lookback classifier measures LOCAL regime, not annual trend. No code change needed.

### A5 Final Backtest — breadth+VIX+DXY active (job f3ae236b7509)

**Config:** 2018-09-24 → 2026-04-01, MNQ/MES/MGC/MCL, 5m/15m/30m, or_breakout+pdh_breakout, minConf=65%, HP enabled, $10,000 starting balance

**OVERALL:**
| Metric | Value |
|--------|-------|
| Total trades | 9,286 |
| Win rate | 33.9% |
| Profit factor | 1.584 |
| Gross/Net P&L | +$238,040 |
| Max drawdown | $2,908 |
| AvgWin | $113 |
| AvgLoss | -$63 |
| AvgR | $25.63 |
| Sharpe | 6.160 |

**BY SETUP TYPE:**
- or_breakout: 6,680 trades, WR 32.1%, net +$243,351
- pdh_breakout: 2,606 trades, WR 38.3%, net -$5,312

**BY SYMBOL:**
- MNQ: 2,436 trades, WR 33.5%, net +$94,392
- MGC: 2,507 trades, WR 33.9%, net +$68,837
- MES: 2,530 trades, WR 33.5%, net +$46,667
- MCL: 1,813 trades, WR 34.8%, net +$28,143

**BY TIMEFRAME:** All 9,286 trades on 5m (OR breakout 5m-only guard + pdh fires primarily on 5m)

**BY CONFIDENCE BUCKET:**
- 65–70%: 2,024 trades, WR 32.2%, net +$44,619
- 70–80%: 3,369 trades, WR 32.5%, net +$78,530
- 80–90%: 2,145 trades, WR 34.6%, net +$55,658
- 90%+: 1,748 trades, WR 37.6%, net +$59,233

**BY VIX REGIME:**
- crisis: 691 trades, WR 32.0%, net +$25,450
- elevated: 1,452 trades, WR 33.5%, net +$42,623
- low: 2,676 trades, WR 33.3%, net +$52,770
- normal: 4,467 trades, WR 34.6%, net +$117,197

**BY DXY DIRECTION:**
- falling: 3,796 trades, WR 34.1%, net +$99,989
- flat: 1,437 trades, WR 34.2%, net +$36,747
- rising: 4,053 trades, WR 33.5%, net +$101,303

**BY RISK APPETITE (Phase V):**
- on: 5,995 trades, WR 32.9%, net +$128,514
- neutral: 1,936 trades, WR 37.2%, net +$60,446 ← best WR
- off: 1,355 trades, WR 33.6%, net +$49,080

**BY BOND REGIME (Phase V):**
- bullish (bonds rallying = risk-off): 6,383 trades, WR 34.0%, net +$154,829
- neutral: 2,112 trades, WR 34.1%, net +$58,539
- bearish (yields rising = risk-on): 791 trades, WR 32.4%, net +$24,672

**BY EQUITY BREADTH BUCKET (Phase V):**
- 0–1 indices bullish: 2,811 trades, WR 36.2%, net +$104,282 ← best WR
- 2 indices bullish: 823 trades, WR 34.0%, net +$15,890
- 3–4 indices bullish: 5,652 trades, WR 32.7%, net +$117,867

**COMPARISON TO v12.7 BASELINE (+$233,540):**
| Metric | v12.7 | v12.9 (breadth) | Delta |
|--------|-------|-----------------|-------|
| Net P&L | +$233,540 | +$238,040 | +$4,500 (+1.9%) |
| Trades | 9,679 | 9,286 | -393 |
| WR | 37.3% | 33.9% | -3.4pp |
| PF | 1.689 | 1.584 | -0.105 |
| MaxDD | $3,208 | $2,908 | -$300 (9% lower) |

**Key findings:**
- Breadth scoring produced a **marginal net positive**: +$4,500 more P&L with 9% lower max drawdown.
- WR and PF declined because breadth scoring changed the trade mix (added lower-WR trades that passed the new threshold, removed some higher-WR ones that fell below it).
- **Strongest breadth edge**: `riskAppetite=neutral` → WR 37.2% (best across all breadth buckets).
- **Weakest**: `equityBreadth=2` (mixed signal bucket) → WR 34.0%, net only +$15.9K despite 823 trades.
- `equityBreadth=0–1` produces the highest WR (36.2%) — counter-intuitive but consistent with commodity/energy setups performing well in risk-off environments.
- VIX and DXY edges unchanged: edge holds across all regimes; DXY still provides no meaningful filter signal.

---

## [v12.8] — 2026-04-04 — Market breadth scoring from 16 CME instruments (Phase V)

### New file: `server/analysis/marketBreadth.js`
- **`classifyInstrumentRegime(closes)`** — classifies a single instrument from daily close array using two independent signals: 20-bar price position (close vs 20-bar high × 0.95 / low × 1.05) and 10-bar SMA direction (0.05% threshold). Both agree → that direction; one neutral → follow the other; disagree → neutral.
- **`computeMarketBreadth(getCandles, currentSymbol)`** — live mode; calls getCandles for all 16 symbols on '30m' TF, skips unavailable symbols gracefully.
- **`computeMarketBreadthHistorical(dailyClosesBySym, sortedDates, date)`** — historical mode; uses pre-loaded daily closes with strict no-lookahead (prior 21 trading days).
- **Breadth fields computed**: `equityBreadth` / `equityBreadthBearish` (0–4 count of MNQ/MES/M2K/MYM); `bondRegime` (ZN primary, ZB confirmation); `yieldCurve` (steepening/flattening/flat via ZT vs ZN); `copperRegime` (MHG); `dollarRegime` (falling/rising/flat via M6E inverse); `metalsBreadth` / `metalsBreadthBearish` (MGC/SIL/MHG); `fixedIncomeBreadth` (bearish bonds ZT/ZF/ZN/ZB/UB); `btcRegime` (MBT); `riskAppetiteScore` (−20 to +20); `riskAppetite` (on/off/neutral).
- **Risk appetite formula**: equity ×3 + bond ±2 + copper ±3 + dollar ±1 + bitcoin ±1; labels: on ≥5, off ≤−5, neutral.

### Updated: `server/analysis/marketContext.js`
- Imports `computeMarketBreadth` from marketBreadth.js
- `buildMarketContext()` calls `computeMarketBreadth(getCandles, symbol)` after HP/VIX/DXY context; adds `breadth` field to returned context object
- Wrapped in try/catch — breadth failure never breaks context build

### Updated: `server/analysis/setups.js`
- **`detectSetups()`**: stamps `setup.symbol = symbol` on all returned setups (required so `applyMarketContext` can classify the instrument category)
- **`applyMarketContext()`**: converted all `marketContext.hp.xxx` / `.options.xxx` / `.vix.xxx` / `.dxy.xxx` accesses to optional chaining so function works when context only has `breadth` and not HP data
- **Breadth additive scoring** (additive pts, not multipliers, cap ±15):
  - Equity setups: equity breadth ±5/6 pts, bond regime ±3/4 pts, copper regime ±4 pts, risk appetite ±3/5 pts
  - Commodity setups: copper regime ±4 pts, dollar regime ±3 pts, risk appetite ±3/5 pts
  - MGC/SIL/MHG: metals breadth ±4 pts
- `contextBreakdown` gains `breadth` (pts after cap) and `breadthDetail` (equityBreadth, bondRegime, copperRegime, riskAppetite)

### Updated: `server/backtest/engine.js`
- Imports `computeMarketBreadthHistorical` and `ALL_SYMBOLS` from instruments.js
- **`_loadDailyClosesForSymbol(sym)`**: reads last bar of each daily 1m file → `{ date: close }` map
- **`_precomputeBreadth(startDate, endDate)`**: loads daily closes for all 16 symbols once, computes `{ date → breadthObject }` for every trading date in range; logged with timing
- **`_minimalContext()`**: neutral context stub (multiplier=1.0, all bonuses=0) used when HP data unavailable but breadth exists
- **`runBacktestMTF()`**: calls `_precomputeBreadth` once before main loop; injects `breadth` into `mktCtx` on every bar; passes `symbol` in detectSetups opts
- **Trade record additions**: `equityBreadth`, `bondRegime`, `copperRegime`, `dollarRegime`, `riskAppetite`, `riskAppetiteScore`
- **`computeStats()`**: added `byRiskAppetite`, `byBondRegime`, `byCopperRegime`, `byEquityBreadth` breakdowns

### Updated: `public/backtest2.html` + `public/js/backtest2.js`
- **Market Breadth sub-tab** (Optimize tab): four breakdown tables — by riskAppetite (on/neutral/off), by bondRegime (bullish/bearish/neutral), by copperRegime, by equityBreadth bucket (0–1/2/3–4). Min 10 trades per row.
- **Inter-market sub-tab** (Optimize tab): equityBreadth (0/1/2/3/4) × riskAppetite (on/neutral/off) WR heatmap. Green ≥60%, amber 45–59%, red <45%, gray n<5.

### New file: `AI_ROADMAP.md`
- Documents the full AI/ML enhancement roadmap: Phase 1 (Claude batch analysis of trade records), Phase 2 (loss analysis), Phase 3 (decision tree `mlScoring.js`), Phase 4 (pattern discovery)
- Alert commentary re-enable plan (already built in `commentary.js`, currently dormant)
- Prerequisites checklist — Phase V breadth fields complete; B5 + 500 forward-test trades remaining
- Key principles: AI nudges (±15%), interpretability over accuracy, n≥30 minimum, loss analysis first
- Deferred decisions documented: local LLM, neural nets, AI signal generation

---

## [v12.7] — 2026-04-04 — DX/VIX pipeline + backtest engine enrichment (Phase U)

### Pipeline: DX extraction + parsing (Phase 1b loop 5 + Phase 1d DX block)
- **Phase 1b loop 5** (`historicalPipeline.js`): scans `Historical_data/DX/` for zip files; reads `metadata.json` to confirm `schema=ohlcv-1d`; extracts `.csv.zst` files to `data/historical/raw/DX/`; skip-if-exists per file. Result: 2,251 DX files extracted (IFUS.IMPACT, 2018-12-24 → 2026-04-03).
- **Phase 1d DX block** (`historicalPipeline.js`): reads `raw/DX/`, picks highest-volume non-spread DX contract per date (filters rows where `symbol` contains `-` and `close < 50`), auto-detects fixed-point vs decimal. Writes `data/historical/dxy.json`. Result: 2,251 dates, 0 errors, 0 out-of-range. Spot-checks: 2020-03-20=103.2, 2022-09-28=112.6 (USD peak), 2020-07-31=93.4. Range: 89.4–114.1.

### New file: `server/data/historicalVolatility.js`
- Exports `buildVolatilityIndex(futuresDir)`: reads MNQ 1m daily JSON files, extracts last-bar close, computes daily log returns, returns 20-day rolling realized volatility × `sqrt(252)` × 100 as `{ "YYYY-MM-DD": pct }`. Requires 21+ trading days before producing first value.

### Pipeline: Phase 1g (realized volatility VIX proxy)
- New `--phase 1g` in `historicalPipeline.js`: calls `buildVolatilityIndex()`, logs 5 spot-checks including March 2020 and late 2022, warns on values outside 5–100, writes `data/historical/vix.json`. Result: 1,767 dates (2019-06-03 → 2026-04-02). Crisis validation: March 2020 peak = **80.5%** ✓, Oct 2022 = **26.6%** ✓.

### Backtest engine enrichment (`server/backtest/engine.js`)
- Loads `data/historical/vix.json` and `data/historical/dxy.json` at job startup (gracefully optional — defaults to neutral if files absent)
- New helper `computeDxyDirection(dxyData, date)`: compares today's DXY close to 5-day rolling average; returns `rising` / `falling` / `flat` (flat if fewer than 3 prior dates)
- Added to every trade record: `vixRegime` (low/normal/elevated/crisis), `vixLevel` (numeric), `dxyDirection` (rising/falling/flat), `dxyClose` (numeric)
- Added to `computeStats`: `byVixRegime` and `byDxyDirection` breakdowns
- **zone_rejection disabled by default**: default `setupTypes` no longer includes `zone_rejection` — R:R structurally inverted at all confidence levels per A5 findings (AvgWin $16 vs AvgLoss $24 at conf≥80). UI still allows manual re-enable for research.
- **OR breakout 5m-only guard**: if `setup.type === 'or_breakout' && tf !== '5m'` → skip. A5 showed only 1/7,577 OR breakout trades came from 15m/30m.

### A5 Final validation: or_breakout + pdh_breakout, VIX+DXY active
- **9,679 trades** (5.4/day), WR 37.3%, PF **1.689**, Gross +$272,256, **Net +$233,540**, MaxDD $3,208
- vs or_breakout isolation (+$262K net): +$233K with pdh added — pdh still drags (-$14.6K net) but OR breakout slightly improved to $248K
- By VIX regime (net): crisis +$30K, elevated +$47K, low +$46K, **normal +$110K** — edge holds across all regimes, strongest in normal vol
- By DXY direction (net): falling +$97K, flat +$33K, rising +$103K — edge holds in both USD directions (no meaningful filter signal)

---

## [v12.6] — 2026-04-04 — A5 isolation backtest runs: or_breakout + zone_rejection@80

### Backtest jobs (config-only, no code changes)

**Job 1 — or_breakout isolation (conf≥65, full period)**
- 7,577 trades (4.2/day), WR 32.7%, PF 1.86, Gross +$292,773, **Net +$262,465**, MaxDD $2,859
- AvgWin $146.84, AvgLoss -$87.60, AvgR $38.64
- OR breakout fires on **5m only** (7,576/7,577 trades): 15m/30m almost never trigger OR breakout
- By symbol (net): MNQ +$115,051 > MGC +$65,200 > MES +$56,781 > MCL +$25,433
- By confidence (net): all buckets profitable; 90%+ bucket has WR 45.6% vs 30% at 65-70%
- **Confirmed real edge**: large avg winner ($147) vs avg loser ($88) = 1.68 R:R; low WR is expected for breakout strategy

**Job 2 — zone_rejection isolation (conf≥80, full period)**
- 24,118 trades (13.5/day), WR 48.2%, PF 0.643, Gross -$107,338, **Net -$203,810**, MaxDD $108,000
- AvgWin $16.38, AvgLoss -$24.28, AvgR -$4.45
- Still fires on **5m only** (24,117/24,118 trades)
- WR remains ~48% at conf≥80 — raising the floor did NOT fix the WR problem; the avg loser is too large vs avg winner
- All symbols uniformly negative gross — no symbol is salvageable within zone_rejection

### Combined strategy calculation (from on-file jobs, no new run)
Combined = or_breakout@65 + zone_rejection@80 + pdh_breakout@65
- or_breakout@65: net +$231,465 (6,868 trades)
- zone_rejection@80: net -$203,810 (24,118 trades)
- pdh_breakout@65: net -$14,742 (2,497 trades)
- **Combined net: +$12,912 over 7.5 years** — barely profitable; zone_rejection still destroys the or_breakout edge

### Key findings
1. **or_breakout is a viable standalone strategy**: +$262K net over 7.5 years, PF 1.86, MaxDD only $2.9K, 4.2 trades/day
2. **zone_rejection is not salvageable at current R:R structure**: at conf≥80 the WR is still 48% but avg loser exceeds avg winner ($24 vs $16) — raising confidence doesn't fix the R:R mismatch
3. **15m/30m timeframes produce almost zero or_breakout signals**: 5m is entirely responsible for OR breakout edge; 15m/30m can be disabled for this setup
4. **MNQ drives majority of or_breakout P&L** (+$115K of $262K net); MGC/MES contribute meaningfully; MCL is lowest contributor

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
