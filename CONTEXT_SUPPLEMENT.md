# FuturesEdge AI — Extended Context (Phases F–M + Options/Pine Script)

> This document supplements CLAUDE.md with everything added after Phase 10.
> Read CLAUDE.md first, then this document.

---

## Build Phases F–N (post-Phase 10)

| Phase | Version | Focus |
|---|---|---|
| F | v4 | Archive, manual outcomes, manual trade log, OB/FVG quality scoring |
| G | v5 | HVN/LVN (High/Low Volume Nodes), CVD (Cumulative Volume Delta), Options levels |
| H | v6 | 1h/2h/4h timeframes, BTC/ETH/XRP crypto perpetuals via Coinbase INTX |
| I | v7 | scanner.html (live all-setups view), MTF confluence scoring in runScan() |
| J | v8 | CBOE options integration, DEX/Resilience/Liquidity/Hedge/Pivot zones, Pine Script export, SIL |
| K | v8.x | Stats page 4-tab redesign, dashboard Futures/Crypto mode split, nav cleanup |
| L | v10.0 | Historical backtesting system — Databento data pipeline, HP computation, backtest engine, backtest2.html |
| M | v10.1–10.3 | Backtest bias fixes, trading hours filter, Compare tab, Optimize tab |
| N | v11.0 | DD Band / CME SPAN margin levels — confidence modifier, chart layer, topbar widget, backtest analysis |
| O | v12.0 | Databento live data feed — REST adapter, live gate, 1m→5m/15m/30m aggregation, event-driven scan (B1–B4) |
| P | v12.1 | Historical pipeline v2 — instruments.js single source of truth, 16 CME symbols, 13yr scale, streaming zip (A2) |
| Q | v12.2 | OPRA pipeline correctness — fetchETFDailyCloses (Databento ohlcv-1d), Phase 1d rewrite, Phase 1e strike/OI parsing fix, hpCompute.js openInterest compat |

---

## Instruments

- **Futures**: MNQ (NQ=F), MGC (GC=F), MES (ES=F), MCL (CL=F)
- **Crypto perpetuals**: BTC, ETH, XRP via Coinbase INTX (coinbaseFetch.js + coinbaseWS.js)
- **Options proxies**: QQQ → MNQ, SPY → MES, GLD → MGC, USO → MCL

---

## Server Startup

```bash
PORT=3000 node server/index.js
```

VS Code shell sets PORT=54112 — always override explicitly.

---

## File Structure Additions (beyond CLAUDE.md)

```
server/
  data/
    options.js          ← CBOE options chain: OI walls, max pain, GEX, DEX, resilience
    coinbaseFetch.js    ← Coinbase INTX BTC/ETH/XRP perpetual candles (REST)
    coinbaseWS.js       ← Coinbase INTX WebSocket live price feed
  analysis/
    indicators.js       ← computeIndicators(candles, opts) — opts has {symbol, features}
    setups.js           ← detectSetups(candles, ind, regime, opts) — opts has {calendarEvents}
public/
  scanner.html          ← Live all-symbols/all-setups scanner (Phase I / v7)
  performance.html      ← Performance analytics (WR/PF/avgR)
  backtest.html         ← Alert replay / step-through
  docs.html             ← Setup guide + QQQ options level definitions
config/
  settings.json         ← risk block + features block (hot-toggle)
```

---

## New API Routes (Phases F–I)

| Route | Purpose |
|---|---|
| GET /api/options?symbol=MNQ&futuresPrice= | Options chain metrics — OI walls, max pain, GEX, DEX, resilience, liquidity zones |
| GET /api/pine-script?symbol=MNQ | Generates complete Pine Script v6 with all levels baked in |
| GET /api/calendar?symbol= | ForexFactory events (1h cache) |
| GET /api/correlation | Pairwise rolling correlation matrix |
| GET /api/relativestrength?base=MNQ&compare=MES | Normalized ratio + Pearson correlation |
| GET /api/performance | WR/PF/avgR stats from alertCache |
| GET /api/alerts?start=ISO&end=ISO | Date range filter for backtest |
| GET/POST /api/settings | Includes features block |
| POST /api/features | Hot-toggle feature flags (no restart needed) |

---

## Options Data — server/data/options.js

### Data Source
**CBOE Delayed Quotes API** — `https://cdn.cboe.com/api/global/delayed_quotes/options/QQQ.json`
- Free, no auth, no API key required
- Returns full options chain with delta/gamma/iv/OI per contract
- Yahoo Finance v7 options was abandoned (requires crumb auth — returns 401)

### Caching
- CBOE chain: 1-hour cache (`CACHE_TTL_MS = 3_600_000`)
- Daily OHLC: 30-minute cache (`DAILY_TTL_MS = 1_800_000`)

### Scaling: ETF → Futures Price Space
The ETF (QQQ at ~$470) and futures (MNQ at ~$19,700) trade at different price levels.
All option strikes are scaled using: `ratio = liveMNQ=F price / liveQQQ price` (~41.9×).

**Critical**: Both prices are fetched simultaneously from Yahoo Finance in `_fetchDailyLevels()`.
Do NOT use stale seed candle prices for the futures side — the ratio will be wrong (~37×).

```javascript
const ETF_PROXY     = { MNQ: 'QQQ', MES: 'SPY', MGC: 'GLD', MCL: 'USO' };
const FUTURES_YAHOO = { MNQ: 'MNQ=F', MES: 'MES=F', MGC: 'MGC=F', MCL: 'MCL=F' };
```

### Computed Metrics

**OI Walls** — Top 3 strikes by combined call+put open interest. Represent levels where large
options positions create price friction. Plotted as orange dashed lines.

**Max Pain** — Strike K that minimizes total intrinsic payout to all option buyers.
Formula: `Σ(max(0, S-K) × callOI + max(0, K-S) × putOI)` across all strikes.
Stable after overnight OI update. Plotted as fuchsia dotted line.

**GEX (Gamma Exposure)** — `(callGamma - putGamma) × OI × 100 × spot` per strike.
- Positive total GEX: dealers net long gamma → market is self-stabilizing (mean-reverting)
- Negative total GEX: dealers net short gamma → market is self-amplifying (trending)

**GEX Flip** — Nearest strike to spot where per-strike net GEX changes sign.
Scanned outward from spot (not sequentially). Strikes filtered to ±25% of spot to exclude
deep ITM/OTM which distort the calculation. Plotted as aqua dashed line.

**Call/Put Walls** — Highest-OI call strike above spot (call wall) and put strike below spot
(put wall). Represent the most likely near-term range boundaries.

**DEX (Dealer Delta Exposure)** — Sum of `(callDelta × callOI) + (putDelta × putOI) × 100`.
Dealers are short options they sold → must hold an offsetting futures position to hedge.
- Positive DEX: dealers net long futures (bullish bias, buying support)
- Negative DEX: dealers net short futures (bearish bias, selling pressure)
- Normalized to −100/+100 score; bias label: bullish (>20), bearish (<−20), neutral

**Resilience Score** (0–100) — Measures how much the options market acts as shock absorber vs amplifier.
- GEX component: +50 (positive GEX) or −50 (negative GEX), adjusted by distance from flip (±30)
- DEX alignment bonus: +15 if DEX opposes GEX regime (absorbing), −10 if aligned (amplifying)
- Labels: resilient (≥65), neutral (40–64), fragile (<40)

**Liquidity Zones** — Clusters of adjacent strikes where combined OI ≥ 70th percentile.
Each zone has: `{ low, high, center, totalOI, bias }` where bias = call/put/balanced.
- call bias: overhead resistance (calls dominate)
- put bias: below support (puts dominate)
- balanced: contested pivot zone

**Hedge Pressure Zones** — Top 5 strikes by |GEX|. Where mechanical hedging is most intense.
- Positive GEX strike: dealer buying support on dips
- Negative GEX strike: dealer selling resistance on rips

**Pivot Candidates** — Strikes where |callOI - putOI| / totalOI < 25% AND totalOI ≥ median.
No dominant dealer direction → natural turning points.

### Daily Reference Levels (QQQ-scaled to futures)
Fetched from Yahoo Finance `v8/finance/chart` daily endpoint:
- `prevDayOpen` — prior session open
- `prevDayClose` — prior session close
- `curDayOpen` — today's open (with intraday 5m fallback if daily candle is in-progress)

All three are then scaled by the live ratio to futures price space.

### Return Shape (getOptionsData)
```javascript
{
  // ETF-space values
  oiWalls: [strike, strike, strike],
  maxPain, callWall, putWall, gexFlip, totalGex,
  dex, dexScore, dexBias,
  resilience, resilienceLabel,
  liquidityZones: [{ low, high, center, totalOI, bias }, ...],   // top 5
  hedgePressureZones: [{ strike, gex, pressure }, ...],           // top 5
  pivotCandidates: [{ strike, balance, totalOI }, ...],           // top 4
  pcRatio, atmIV, etfPrice,
  source: 'QQQ',
  daily: { prevDayOpen, prevDayClose, curDayOpen, liveEtfPrice, liveFuturesPrice },

  // Futures-space scaled values (present when live prices available)
  scalingRatio,
  scaledOiWalls, scaledMaxPain, scaledGexFlip, scaledCallWall, scaledPutWall,
  scaledLiquidityZones, scaledHedgePressureZones, scaledPivotCandidates,
  scaledDaily: { prevDayOpen, prevDayClose, curDayOpen },
}
```

---

## Crypto — server/data/coinbaseFetch.js + coinbaseWS.js

- **Symbols**: BTC, ETH, XRP
- **Exchange**: Coinbase INTX (perpetuals) — product IDs: `BTC-PERP-INTX`, `ETH-PERP-INTX`, `XRP-PERP-INTX`
- `coinbaseFetch.js` — REST: fetches historical candles for seeding
- `coinbaseWS.js` — WebSocket: live price feed, feeds into snapshot candle store
- These symbols share the same `getCandles(symbol, tf)` interface as futures

---

## Features Block — config/settings.json

All features default to `true` except `soundAlerts` and `pushNotifications` (false).
Hot-toggle via `POST /api/features { "featureName": true|false }` — no restart needed.

```json
{
  "features": {
    "volumeProfile": true,
    "openingRange": true,
    "sessionLevels": true,
    "economicCalendar": true,
    "relativeStrength": true,
    "correlationHeatmap": true,
    "performanceStats": true,
    "alertReplay": true,
    "ddBands": true,
    "soundAlerts": false,
    "pushNotifications": false
  }
}
```

---

## Alert Schema Notes

- `setup.direction` values: `"bullish"` / `"bearish"` (NOT "long"/"short")
- `regime.direction` values: `"bullish"` / `"bearish"` / `"neutral"`
- `GET /api/alerts` returns `{ alerts: [...] }` — not a raw array
- `setup.mtfConfluence` shape: `{ tfs: ['5m','15m'], bonus: N }` (added in v7)

---

## Dashboard Options Widget (index.html)

The options widget in the top bar shows:
```
[Source] P/C: 1.02 | IV: 32.1% | MaxPain: 19850 | DEX: +72 bullish | Resilience: 68 resilient
```

Widget element IDs: `opt-source`, `opt-pc`, `opt-iv`, `opt-maxpain`, `opt-dex`, `opt-resilience`

**Pine Script button** in nav: `<button id="pine-copy-btn" onclick="window._copyPineScript()">Pine Script</button>`
Fetches `/api/pine-script`, copies generated Pine Script v6 to clipboard.

---

## Pine Script Generation — GET /api/pine-script?symbol=MNQ

Generates a complete TradingView Pine Script v6 with all options levels baked in as constants.
Since Pine Script cannot make HTTP requests, values are embedded at generation time.

**Why baked constants**: TradingView Pine has no external HTTP access. Levels are computed
server-side and embedded as `float oi1 = 24887` etc. Refresh by regenerating and repasting.
Typical cadence: once before market open. On 0DTE days (Mon/Wed/Fri for QQQ), refresh mid-session.

**Rendering approach** (important — was changed to fix "overlay image" problem):
- `plot()` — draws lines across historical bars, integrates with price scale and data window
- `line.new(extend=extend.right)` at `barstate.islast` — extends each level into future (right of last bar)
- `label.new(bar_index + 2, ...)` at `barstate.islast` — places labels just right of current bar
- `fill()` between two `plot()` calls — creates filled liquidity zone bands
- Info table uses `table.new()` — correct for tabular data

**v6 syntax requirements** (do not revert these):
- `//@version=6`
- `array.new<float>(N, na)` — NOT `array.new_float`
- `array.new<string>(N, "")` — NOT `array.new_string`
- Individual `array.set(arr, i, val)` on separate lines — NOT comma-separated `:=` assignments
- Explicit type annotations: `float oi1 = ...`, `int dex_score = ...`, `string dex_bias = ...`
- No trailing dots on float literals: `23500` not `23500.`

---

## Scanner — public/scanner.html

Added in Phase I (v7). Shows all setup alerts across all symbols and timeframes in real time.
`runScan()` in server/index.js powers this — includes MTF confluence scoring.

---

## Correlation Heatmap

`GET /api/correlation` returns 20-bar rolling Pearson correlation on 5m log-returns.
Instruments: MNQ, MES, MCL, MGC, SIL, DXY, VIX, BTC, ETH, XRP, XLM.

**How to use it**:
- Strong positive correlation (>0.7): instruments moving together — confirms macro move
- Negative correlation: risk-off/risk-on divergence — check if MNQ and DXY inverting (typical)
- BTC diverging from MNQ: crypto-specific move, not macro signal — filter out
- All instruments in lockstep: macro event-driven, setups less reliable

---

## seedFetch.js Symbols

Updated to use micro contract tickers (not full-size NQ=F, ES=F etc.):
```javascript
const SYMBOLS = {
  MNQ: 'MNQ=F',  // NOT NQ=F — MNQ and NQ trade at slightly different prices
  MGC: 'MGC=F',
  MES: 'MES=F',
  MCL: 'MCL=F',
  SIL: 'SIL',
};
```
Using NQ=F for MNQ data produces a ~0.1–0.3% price discrepancy which compounds into
incorrect options scaling ratios.

---

## DD Band / SPAN Margin System — Phase N (v11.0)

### Core Concept
- `riskInterval = CME initial margin ÷ point value` — defines expected daily range
- 5 levels: `priorClose`, `ddBandUpper` (+1×), `ddBandLower` (−1×), `spanUpper` (+2×), `spanLower` (−2×)
- Crypto: `riskInterval = priorClose × (cryptoVolAnnualized / √252)` (default vol=0.30)

### SPAN Margins (`config/settings.json → spanMargin`)
```json
{ "MNQ": 1320, "MES": 660, "MGC": 1650, "MCL": 1200, "cryptoVolAnnualized": 0.30 }
```
Update via `POST /api/settings/span` or the SPAN Margins panel in the dashboard sidebar.

### Confidence Modifier (`scoreDDBandProximity` in setups.js)
| Label | Score | Meaning |
|---|---|---|
| `room_to_run` | +8 | Entry well inside DD band — good room to target |
| `approaching_dd` | +4 | Near DD band but not at it |
| `neutral` | 0 | Ambiguous position |
| `outside_dd_upper` / `outside_dd_lower` | −7 | Price already outside DD band (directional) |
| `beyond_dd_upper` / `beyond_dd_lower` | −12 | Price significantly extended, close to SPAN |
| `at_span_extreme` | −20 | Price at or beyond SPAN level — extreme extension |
| `pdh_beyond_dd` | −12 | PDH breakout special case: prior high itself beyond DD band |

- `setup.ddBandLabel` and `setup.scoreBreakdown.ddBand` on every scored setup
- Point values used: MNQ=2, MES=5, MGC=10, MCL=100 (USD per point)

### Chart Layer
- `ChartAPI.setDDBands(dd)` — 5 price lines: DD upper/lower (solid orange 0.85 opacity), SPAN upper/lower (dashed orange 0.45), prior close (dotted gray 0.40)
- Layer toggle: `ddBands` key (default on)

### API Routes
- `GET /api/ddbands?symbol=MNQ` — returns `{ ddBands: { priorClose, riskInterval, ddBandUpper, ddBandLower, spanUpper, spanLower, currentPrice } }`
- `POST /api/settings/span` — updates SPAN margins and persists to settings.json

### Backtest (engine.js)
- `computeDDBands(visibleBars, symbol, spanMargin)` called per bar — historically accurate, no lookahead
- Trade fields added: `ddBandLabel`, `ddBandScore`

### Backtest UI (backtest2.html/js)
- DD Band sub-tab in Optimize: breakdown table by label (WR, PF, Net P&L), min 10 labelled trades
- DD Band stat card in Summary: best/worst label WR, only when ≥10 labelled trades

---

## Backtest System (v10.x / v11.0) — Phase L/M/N

### Engine (`server/backtest/engine.js`)
- `runBacktestMTF()` — bar-by-bar replay, no lookahead, current-bar filter, OR dedup per session/direction
- Trade object fields: `symbol`, `date`, `timeframe`, `setupType`, `direction`, `entryTs`, `entry`, `sl`, `tp`, `confidence`, `outcome`, `exitTs`, `exitPrice`, `netPnl`, `grossPnl`, `hour` (ET), `hpProximity`, `resilienceLabel`, `dexBias`, `ddBandLabel`, `ddBandScore`
- **No** `regime`, `nearEvent`, `mtfConfluence`, or `rMultiple` on trade objects (applied upstream)
- `excludeHours` config: array of ET hours (0–23) to skip at entry
- `spanMargin` config: object keyed by symbol — defaults to settings.json value if not provided

### Backtest UI (`public/backtest2.html`, `backtest2.js`, `backtest2.css`)
- 5 tabs: Summary / Trades / Replay / Compare / **Optimize**
- **Run labels**: stored in localStorage `bt2_job_labels`; `_getJobLabel(jobId, config)` resolves override → config.label → auto-name (`symbols · MM-DD → MM-DD`). Pre-run label input + post-run inline rename (✏ button).
- **Config restore**: `_populateConfigFromJob(cfg)` restores all fields (including hours checkboxes) when loading a previous job.
- **Compare tab**: fixed equity curve URL (`/api/backtest/results/:id`); selectors show run label; fixed dark-on-dark styling.
- **Optimize tab** — client-side analysis of `_currentResults.trades`, no API call
  - Confidence sub-tab: threshold floors 60–90%, optimal floor (best PF where n≥10), MTF impact
  - Regime sub-tab: direction + HP proximity; regime/calendar not on trade records
  - Time of Day: ET hour heatmap (9–18) per setup type, uses `trade.hour`
  - DD Band sub-tab: WR/PF/P&L by ddBandLabel; requires ≥10 labelled trades
  - Notifications: static tier/dedup/staleness design reference
  - State vars: `_bt2ActiveSubtab`, `_bt2OptSetupType`, `_bt2OptSymbol`

### `/api/performance/optimize` (separate from backtest)
- Computes threshold/regime/MTF/hour stats from alertCache (live alerts, not backtest trades)
- 5-minute cache; exports `computeOptimizeStats` from `server/analysis/performanceStats.js`

---

## Historical Pipeline — Phase P (v12.1)

### instruments.js — `server/data/instruments.js`
Single source of truth for all instrument metadata. Imported by `historicalPipeline.js`, `hpCompute.js`, and `server/backtest/engine.js`.

**16 CME symbols**: MNQ, MES, M2K, MYM (equity index); MGC, SIL, MHG (metal); MCL (energy); M6E, M6B (FX); ZT, ZF, ZN, ZB, UB (fixed income); MBT (crypto futures)

**Key exports:**
```javascript
INSTRUMENTS          // Full metadata map keyed by internal symbol
ALL_SYMBOLS          // ['MNQ','MES',...] — all 16
OPRA_UNDERLYINGS     // [{ etf:'QQQ', futuresProxy:'MNQ' }, ...]
POINT_VALUE          // { MNQ:2, MES:5, MGC:10, MCL:100, ... }
HP_PROXY             // { MNQ:'QQQ', MES:'SPY', MGC:'GLD', MCL:'USO', SIL:'SLV', M2K:'IWM', ... }
ETF_TO_FUTURES       // { QQQ:'MNQ', SPY:'MES', ... }
FUTURES_TO_ETF       // { MNQ:'QQQ', MES:'SPY', ... }
DATABENTO_ROOT_TO_INTERNAL // { GC:'MGC', SI:'SIL', HG:'MHG', MNQ:'MNQ', ... }
```

**Proxy instruments** (Databento dbRoot ≠ internal symbol):
- `MGC` → Databento continuous `GC.c.0`; individual contracts use `MGC` prefix (`MGCJ6`)
- `SIL` → Databento continuous `SI.c.0`; individual contracts use `SIL` prefix (`SILH9`)
- `MHG` → Databento continuous `HG.c.0`; individual contracts use `MHG` prefix (`MHGN2`)
- `DATABENTO_ROOT_TO_INTERNAL` contains both the continuous roots (`GC→MGC`, `SI→SIL`, `HG→MHG`) and explicit individual-contract overrides (`MGC→MGC`, `SIL→SIL`, `MHG→MHG`)

**Downloaded zip format:** Each GLBX zip covers one symbol, uses `stype_in=parent`, so CSV rows contain individual contract tickers (`MNQM9`, `MGCJ6`). `metadata.json` inside each zip has `query.symbols: ["MNQ.FUT"]`.

### historicalPipeline.js — Phases and CLI

```bash
node server/data/historicalPipeline.js --phase 1a   # Inventory zips → manifest.json
node server/data/historicalPipeline.js --phase 1b   # Extract zips → raw/GLBX/{SYMBOL}/ and raw/OPRA/{etf}/
node server/data/historicalPipeline.js --phase 1c   # Parse CSVs → per-symbol candle files
node server/data/historicalPipeline.js --phase 1d   # Fetch ETF closes (QQQ/SPY/GLD/SLV/USO/IWM) from Yahoo
node server/data/historicalPipeline.js --phase 1e   # Parse OPRA chains → per-date contract files
node server/data/historicalPipeline.js --phase 1f   # Compute HP snapshots (Black-Scholes)
```

Additional flags: `--symbol MNQ` (1c only), `--from-date YYYY-MM-DD`, `--recompute`, `--force`, `--clean-raw`, `--dry-run`, `--verify`

- `--force` — Phase 1c: reprocess all dates, bypass skip-if-exists on derived files
- `--clean-raw` — Delete `raw/GLBX/` tree and all derived `futures/{sym}/` directories before running. Use before first extraction with the per-symbol layout, or to reset completely.

**Resumability:** Each phase is fully resumable — skip-if-exists at write time; Phase 1c pre-computes `existingDates` Set per symbol.

**Phase 1b — per-symbol extraction:** Each GLBX zip is identified via its `metadata.json` (`query.symbols[0]` → strip `.FUT`) and extracted into `raw/GLBX/{SYMBOL}/`. This prevents the filename-collision bug where a flat layout caused all non-first-alphabetical symbols to be silently overwritten.

**Phase 1c — per-symbol scan:** Iterates `raw/GLBX/{SYMBOL}/` for each target symbol; processes one symbol at a time. Bars whose `csvSymbolToInternal()` result doesn't match the directory symbol are discarded (sanity check).

**Output structure:**
```
data/historical/
  manifest.json              ← zip inventory (Phase 1a)
  errors.log                 ← per-date errors (non-fatal)
  etf_closes.json            ← unified ETF close prices (Phase 1d)
  raw/GLBX/{SYMBOL}/         ← per-symbol extracted .csv.zst files (Phase 1b)
  raw/OPRA/{etf}/            ← extracted OPRA .csv.zst files (Phase 1b)
  futures/{SYMBOL}/          ← per-date OHLCV JSON files (Phase 1c)
  options/{etf}/             ← per-date option chain files (Phase 1e)
  computed/{etf}/            ← per-date HP snapshot files (Phase 1f)
```

### Streaming zip extraction
`unzipper` replaces `adm-zip` — supports >2 GiB archives (QQQ OPRA zip is 3.3 GB). `adm-zip` uses `fs.readFileSync` on the whole archive which hits Node's 2 GiB buffer limit.

---

## Known Limitations

- CBOE data is 15-min delayed (free tier) — options levels are approximate intraday
- Pine Script levels are static until regenerated and repasted — not live-updating
- Crypto (BTC/ETH/XRP) options data not available — options panel only shown for MNQ/MES
- `pushNotifications` feature flag exists but is not yet implemented
- Backtest trade objects do not include regime/nearEvent/mtfConfluence fields (v10.x)

---

## Port Assignments

| Port | Project |
|---|---|
| 3000 | FuturesEdgeAI |
| 3001 | BudgetApp |
| 3002 | JobEdge |
| 3003 | WeddingPlanner |
| 3004 | EdgeLog |
| 3005 | PropFirmTools |
