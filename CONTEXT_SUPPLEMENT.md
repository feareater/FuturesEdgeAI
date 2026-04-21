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
| R | v12.3 | ETF close pipeline from XNYS.PILLAR ohlcv-1d zips — Phase 1b loop 4, Phase 1d local parser, Phase 1e remove lastKnownPrice fallback, Phase 1f HP complete (~1736/ETF) |
| S | v12.5 | Backtest dedup fix — zone_rejection zone-level bucket key (0.25 ATR), 60-min per-direction cooldown cross-TF shared at symbol scope; A5 full-period run |
| T | v12.6 | A5 isolation runs — or_breakout@65: Net +$262K, PF 1.86, 5m-only, MNQ leads; zone_rejection@80: Net -$204K, raising conf doesn't fix R:R mismatch; recommended config: or_breakout+pdh_breakout |
| U | v12.7 | DX/VIX pipeline — Phase 1b loop 5 (DX zips → raw/DX/), Phase 1d DX block (dxy.json 2251 dates), historicalVolatility.js + Phase 1g (vix.json 1767 dates, March 2020=80.5%), engine enrichment (vixRegime/vixLevel/dxyDirection/dxyClose on trades, byVixRegime/byDxyDirection stats), zone_rejection disabled default, OR breakout 5m-only guard. Final A5: Net +$233K PF 1.69 |
| V | v12.8 | Market breadth scoring — marketBreadth.js (16 CME instruments, classifyInstrumentRegime, riskAppetite composite), breadth in applyMarketContext (±15 pts cap), trade record breadth fields, Optimize tab Market Breadth + Inter-market sub-tabs |
| AD | v14.17 | Automatic chart gap fill — gapFill.js (startup + 15min scheduler), historical 1m file backfill, Yahoo Finance fallback, client-side gap detection + auto-refetch, manual refresh button |

---

## Gap Fill System (v14.17)

### How it works
- At server startup (after seed data loads, before live feed starts), `runGapFillAll()` scans all CME futures symbols for gaps in the candle store
- Gaps are detected when the last bar timestamp is > 2x the timeframe interval behind current time
- Backfill sources (in priority order): (1) historical 1m files at `data/historical/futures/{SYMBOL}/1m/{DATE}.json`, (2) Yahoo Finance fallback
- After 1m bars are injected, higher TFs (5m/15m/30m) are re-aggregated using window-aligned logic
- Per-TF scheduler intervals: 1m every 2 min, 5m every 5 min, 15m/30m every 15 min (v14.18)

### Symbols covered
- All `LIVE_FUTURES`: MNQ, MES, MGC, MCL, SIL, M2K, MYM, MHG
- Crypto symbols (BTC, ETH, XRP, XLM) are **skipped** — no historical files, different data source

### Graceful degradation
- Historical files missing → falls back to Yahoo Finance
- Yahoo Finance unreachable → logs warning, continues
- All errors caught and logged — never crashes server or blocks scan engine

### Client-side
- `_detectChartGaps()` in chart.js checks candle array after every load
- Auto-refetches with backoff: 2s → 5s → 15s (3 retries max, then shows "Gap in data")
- Manual refresh button (⟳) in TF row resets retry counter for fresh attempts
- Reconnect gap fill: Databento feed reconnect triggers immediate 1m fill for all symbols

---

## Active Setups Panel (v14.25.1)

### What it shows
- All open alerts (`outcome === 'open'`) across ALL symbols — not filtered to active symbol
- Each card: symbol, direction, setup type, confidence, TF, age, live price, unrealized dollar P&L, progress bar toward TP
- Cards sorted by confidence descending; stale setups (>8h old) excluded

### Live P&L updates
- `_livePrices` map in `alerts.js` receives every `live_price` WS event (1s ticks from Databento for 8 CME futures, Coinbase for crypto)
- `_updateActiveSetupPrices(symbol, price)` runs on each tick — patches only text/style on existing DOM nodes, no full re-render
- P&L formula: `(price - entry) × POINT_VALUE[symbol] × contracts` (bullish); `(entry - price) × ...` (bearish)
- Contracts per symbol from `cfg` settings (same as `_calcRisk`)

### Interaction
- Click card → switches chart to that symbol + highlights the setup via `ChartAPI.highlightSetup()`
- Cards auto-removed when `outcome_update` WS event fires (SL/TP/timeout hit)

---

## Hourly Refresh System (v14.26)

### How it works
- Every 60 minutes (via `setInterval`), `refreshAll()` pulls the last 95 minutes (90 min + 5 min buffer) of 1m OHLCV data for all 16 CME symbols
- Primary source: Databento REST API (`POST hist.databento.com/v0/timeseries.get_range`, ohlcv-1m schema, GLBX.MDP3 dataset, `stype_in=parent`)
- Fallback: Yahoo Finance 7-day 1m bars (filtered to last 95 min) — triggers automatically if Databento fails; symbols without Yahoo ticker (bonds, FX, crypto CME) are skipped with warning
- For each date returned, 1m bars are written to `data/historical/futures/{SYMBOL}/1m/{YYYY-MM-DD}.json` (replaces existing file)
- Higher TFs (5m/15m/30m) are re-aggregated from the refreshed 1m data and written to both `futures/{SYMBOL}/{tf}/` and `futures_agg/{SYMBOL}/{tf}/`
- After all symbols refresh, `purgeAllInvalidBars()` sanitizes in-memory candle store and rebuilds higher-TF bars
- Options HP is recomputed for the last 2 trading dates across all 7 OPRA ETF proxies using existing `computeHP()` from `hpCompute.js`
- If a refresh is still running when the next interval fires, the cycle is skipped with a log

### Symbols covered
- All 16 CME symbols from `instruments.js` with a `dbRoot`: MNQ, MES, M2K, MYM, MGC, SIL, MHG, MCL (tradeable) + M6E, M6B, MBT, ZT, ZF, ZN, ZB, UB (reference)

### OPRA baseline subscription
- After OPRA TCP connects and authenticates, QQQ, SPY, USO, GLD, IWM, SLV are always subscribed
- These are the ETF proxies for all tradeable futures, ensuring HP/GEX/DEX/resilience scores stay current
- `/api/datastatus` returns `opra.subscribedSymbols` array

### Manual trigger
- Dashboard: "↻ Data" button in the TF row opens dropdown with per-symbol and full-refresh options
- API: `POST /api/refresh/symbol/:symbol` (single), `POST /api/refresh/all` (all), `GET /api/refresh/status`
- Duplicate prevention: per-symbol `_runningSymbols` Set + 409 response if full refresh already running

### Why this exists
- Live Databento WebSocket feed accumulates data quality issues: bad ticks that slip through spike filtering, gaps from reconnects, partial bars at session boundaries
- The hourly refresh replaces those dirty bars with clean historical data from Databento's REST API (which is post-processed and validated)
- Yahoo fallback ensures bars are refreshed even when Databento API key has exhausted its quota

### Tightened spike thresholds (v14.25)
- `CLOSE_SPIKE_THRESHOLD` in snapshot.js: MNQ/MES/M2K/MYM/MHG = 5%, MGC/MCL/SIL = 8%, DEFAULT = 6%
- `_sanitizeYahooBars()` in gapFill.js: spike threshold lowered from 3× to 2× tick threshold; added 10× median range sanity check

---

## Instruments

### Tradeable (full setup scanning + alerts)
| Symbol | Description | Options Proxy |
|--------|-------------|---------------|
| MNQ | Micro E-mini Nasdaq-100 | QQQ |
| MES | Micro E-mini S&P 500 | SPY |
| M2K | Micro Russell 2000 | IWM |
| MYM | Micro Dow Jones | DIA |
| MGC | Micro Gold (GC proxy) | GLD |
| MCL | Micro Crude Oil | USO |
| MHG | Micro Copper (MHG.c.0) | — |
| SIL | Micro Silver (SI proxy) | SLV |

### Reference (charts + breadth only, no setup scanning)
| Symbol | Description | Breadth role |
|--------|-------------|-------------|
| M6E | Micro EUR/USD | dollarRegime |
| M6B | Micro GBP/USD | FX context |
| MBT | Micro Bitcoin CME | btcRegime |
| ZT | 2yr T-Note | fixedIncomeBreadth |
| ZF | 5yr T-Note | fixedIncomeBreadth |
| ZN | 10yr T-Note | bondRegime (primary) |
| ZB | 30yr T-Bond | bondRegime (confirm) |
| UB | Ultra T-Bond | fixedIncomeBreadth |

- **Crypto perpetuals**: BTC, ETH, XRP, XLM via Coinbase INTX (coinbaseFetch.js + coinbaseWS.js)
- `SCAN_SYMBOLS` in server/index.js: `['MNQ','MGC','MES','MCL','BTC','ETH','XRP','XLM','SIL','M2K','MYM','MHG']`

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
    options.js          ← Options chain: OI walls, max pain, GEX, DEX, resilience (OPRA live or CBOE)
    opraLive.js         ← Databento OPRA.PILLAR TCP feed; per-strike OI accumulator
    barValidator.js     ← validateBar() 5-rule sanity check; rolling ATR spike filter (4× ATR, per-symbol floor/ceiling bounds); ATR_BOUNDS_1M: MNQ[5,150] MES[0.5,20] M2K[0.2,8] MYM[5,250] MGC[0.5,30] SIL[0.05,2] MHG[0.002,0.08] MCL[0.05,2]; getValidatorStats()
    coinbaseFetch.js    ← Coinbase INTX BTC/ETH/XRP perpetual candles (REST)
    coinbaseWS.js       ← Coinbase INTX WebSocket live price feed
  analysis/
    indicators.js       ← computeIndicators(candles, opts) — opts has {symbol, features}
    setups.js           ← detectSetups(candles, ind, regime, opts) — opts has {calendarEvents}
    alertDedup.js       ← isDuplicate (15-min cooldown + ±0.25×ATR proximity), applyStaleness, pruneExpired
    bias.js             ← computeSetupReadiness(symbol, mktCtx, hour, mode='auto'), computeDirectionalBias(symbol, mktCtx, ind)
  push/
    pushManager.js      ← VAPID push manager; subscriptions in data/push/subscriptions.json
public/
  scanner.html          ← Live all-symbols/all-setups scanner (Phase I / v7)
  performance.html      ← Performance analytics (WR/PF/avgR)
  backtest.html         ← Alert replay / step-through
  docs.html             ← Setup guide + QQQ options level definitions
config/
  settings.json         ← risk block + features block (hot-toggle)
scripts/
  databentoDiag.js      ← Standalone Databento connection & data health check (no server required)
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

## Data Quality Detection System (v14.30)

### What's detected (4 categories)
1. **Price spikes / unrealistic wicks** — surfaced from `barValidator.js` (null/zero/NaN, open-gap, ATR spike clamp) and `_sanitizeCandles()` in snapshot.js (isolated spikes, extreme wicks)
2. **Gaps / missing bars** — intra-session gap > 2× TF interval during CME Globex market hours
3. **Stale / frozen bars** — no new bar in > 2× TF interval during market hours (stale > 5 min → bad)
4. **OHLC broker-mismatch** — Yahoo Finance 1m cross-check: 0.3% threshold for equity (MNQ/MES/M2K/MYM), 0.5% for commodities (MGC/MCL/SIL/MHG); flagged only if ≥3 consecutive bars diverge

### Status tiers and transition rules
- **ok** — no issues in last 15 min, suspiciousBarCount === 0
- **warning** — 1 issue in last 15 min OR suspiciousBarCount between 1 and 2
- **bad** — 2+ issues in last 15 min OR suspiciousBarCount >= 3 OR stale > 5 min during market hours OR broker mismatch confirmed

### Auto-refresh flow
- When status transitions from non-bad → bad: `dataQuality.triggerAutoRefresh(symbol)` calls `dailyRefresh.refreshSymbol(symbol)` directly (in-process, not HTTP)
- **5-min debounce**: skip if last auto-refresh < 5 minutes ago
- **30-min backoff**: after refresh completes, if status is still bad, set backoff window — no retry for 30 minutes
- After successful refresh: re-evaluates status; logs whether status recovered or backoff was set

### UI surface
- **Single chart badge**: 12px colored dot in top-right corner of `#chart-wrap` (green=ok, yellow=warning, red=bad with pulsing animation)
- **Grid mode badge**: 8px inline dot in each mini-chart cell header
- **Tooltip (hover)**: shows last 5 issues with type + timestamp
- **Popover (click)**: shows issue count + "Refresh Now" button that calls `POST /api/refresh/symbol/:symbol`
- State updates in real-time via `data_quality_update` WS events; initial load from `GET /api/data-quality`

### Yahoo cross-validation scope
- Runs every 5 minutes during RTH (13:30–21:00 UTC Mon–Fri) for all 8 tradeable CME futures
- **Skipped symbols**: bonds (ZT/ZF/ZN/ZB/UB), FX (M6E/M6B), CME Bitcoin (MBT), crypto (BTC/ETH/XRP/XLM)
- Uses Yahoo Finance v8 chart API with 1m interval, compares last 15 bars' closes

### Market hours
- CME Globex: Sun 18:00 ET → Fri 17:00 ET; daily 17:00–18:00 ET maintenance break
- Stale/gap detection skipped during maintenance window and weekends
- Gap detection: gaps spanning the maintenance window are excluded (expected behavior)

### API routes
| Route | Purpose |
|---|---|
| GET /api/data-quality | Full status map for all symbols/TFs |
| GET /api/data-quality/:symbol | Status for one symbol (all TFs) |
| POST /api/data-quality/check/:symbol | Manual full check (gap + stale + Yahoo) |

### Files
- `server/data/dataQuality.js` — core module: state management, detection functions, scheduler, auto-refresh
- `server/data/barValidator.js` — emits `recordSuspiciousBar()` on reject/clamp events
- `server/data/snapshot.js` — emits `recordSuspiciousBar()` in `_sanitizeCandles()` + `checkGap()` in `writeLiveCandle()`
- `public/js/chart.js` — `_renderDQBadge()`, `ChartAPI.setDataQualityBadge()`
- `public/js/chartManager.js` — grid mode badge rendering via `dataQualityInit`/`dataQualityUpdate` events
- `public/js/alerts.js` — WS handler for `data_quality_update`, initial fetch, event dispatch
- `public/css/dashboard.css` — badge/tooltip/popover styles

---

## Options Data — server/data/options.js

### Data Source (v14.0 — dual-source)

**Priority 1: Databento OPRA live TCP** (`features.liveOpra=true`)
- `server/data/opraLive.js` — connects to `opra-pillar.lsg.databento.com:13000`
- Same CRAM auth as the GLBX futures feed (separate connection)
- Subscribes to `statistics` schema for QQQ + SPY underlyings
- Accumulates per-strike OI in memory; updates on each statistics record
- Returns OCC-format options array → passes through `_computeMetrics()` unchanged
- No additional npm dependencies — built-in `net`/`crypto`/`readline`
- Hot-toggle: `POST /api/features { "liveOpra": true|false }`

**Priority 2: CBOE Delayed Quotes API** (fallback, always available)
- `https://cdn.cboe.com/api/global/delayed_quotes/options/QQQ.json`
- Free, no auth, 15-min delayed
- Used when liveOpra=false OR OPRA feed has no data yet (startup lag)

**`dataSource` field** on `getOptionsData()` result: `'opra-live'` or `'cboe'`

### Caching
- CBOE chain: 1-hour cache (`CACHE_TTL_MS = 3_600_000`)
- OPRA live: 5-minute effective cache (re-fetches daily Yahoo levels; OI in memory)
- Daily OHLC: 30-minute cache (`DAILY_TTL_MS = 1_800_000`)

### Scaling: ETF → Futures Price Space
The ETF (QQQ at ~$470) and futures (MNQ at ~$19,700) trade at different price levels.
Ratio computed from RTH opening bar of futures candle store vs ETF daily open from Yahoo.
Accurate as of session open. Falls back to Yahoo live price pre-market.

Per-symbol session opens: equity (MNQ/MES/M2K/MYM) 09:30 ET, gold (MGC) 08:20 ET,
crude (MCL) 09:00 ET, silver (SIL) 08:25 ET. `scalingRatioSource` = `'rth_open'` or `'yahoo_live'`.

**Critical**: Do NOT use stale seed candle prices for the futures side — the ratio will be wrong (~37×).

```javascript
// 7 symbols with options proxy coverage (MHG has no liquid ETF proxy)
const ETF_PROXY     = { MNQ: 'QQQ', MES: 'SPY', M2K: 'IWM', MYM: 'DIA', MGC: 'GLD', MCL: 'USO', SIL: 'SLV' };
const FUTURES_YAHOO = { MNQ: 'MNQ=F', MES: 'MES=F', M2K: 'M2K=F', MYM: 'MYM=F', MGC: 'MGC=F', MCL: 'MCL=F', SIL: 'SI=F' };
```

### Per-Symbol Spike Thresholds (candle sanitization in `snapshot.js`)

```javascript
const SPIKE_THRESHOLD = {
  MNQ: 0.08, MES: 0.08, M2K: 0.08, MYM: 0.08,  // 8% for equity index
  MGC: 0.08, SIL: 0.08, MHG: 0.10,               // 8-10% for metals
  MCL: 0.15,                                       // 15% for crude (volatile, overnight gaps)
};
```

Only isolated spikes (single-bar deviation that reverts in the next bar) are removed. Sustained multi-bar moves are preserved as real market events.

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

  // Expiry-bucket HP (v14.13) — null if bucket has <10 strikes with OI
  weeklyMonthlyHP: {                                                   // DTE 15–60
    zones: [{ strike, gex, pressure, scaled }, ...],                   // top 3
    totalOI: number,
    bucketDTE: { min, max },
  },
  quarterlyHP: {                                                       // DTE 61–120
    zones: [{ strike, gex, pressure, scaled }, ...],                   // top 3
    totalOI: number,
    bucketDTE: { min, max },
  },
}
```

### Market Context HP Sub-Object (v14.13)

`buildMarketContext()` in `server/analysis/marketContext.js` returns `marketContext.hp` with:

```javascript
{
  nearestLevel: { type, price, distance_atr },   // nearest daily HP/GEX/MaxPain/Wall level
  pressureDirection: 'support' | 'resistance' | 'neutral',
  inCorridor: boolean,                             // bracketed by 2 levels ≤2.0 ATR apart
  corridorBounds: { low, high, width_atr } | null,
  corridorMultiplierReversal: 1.08,
  corridorMultiplierBreakout: 0.88,
  freshnessDecayPts: number,                       // 0 to −15 based on options data age
  multiplier: number,                              // 0.80–1.30 (includes monthly boost)
  monthlyNearest: { type, price, pressure } | null, // nearest monthly HP zone (v14.13)
  monthlyMultiplierDelta: number,                   // +0.05 when daily+monthly converge (v14.13)
}
```

HP multiplier tiers:
- Daily HP at level (≤0.3 ATR): 1.05 base
- Daily HP near (0.3–0.75 ATR): 1.10 base
- Monthly HP only at level: 1.15 / near: 1.05
- Daily + monthly converge: base + 0.05 bonus
- Final clamp: 0.80–1.30

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

## Dashboard Bias Panel (v14.15)

Full-width collapsible panel between topbar and chart, showing:
1. **Setup Readiness** — 6 OR breakout gate checks (DEX neutral, DXY rising late, DXY rising penalty, risk-off breadth, VIX crisis, calendar event). Status: READY / CAUTION / BLOCKED.
2. **Directional Bias** — 11 scored signals producing net direction (bullish/neutral/bearish) with strength (strong/mild/flat). Score range: -18 to +18.

API: `GET /api/bias?symbol=MNQ` — 30s cache. Returns `{ readiness, bias }`.
Diagnostic: `GET /api/bias/debug?symbol=MNQ` — [server/index.js:1562-1641](server/index.js#L1562-L1641) — dumps raw marketContext inputs + readiness + bias on a single live scan cycle. Uncached, no side effects.
Updates on: page load, symbol switch, WS setup/data_refresh messages.
Collapse state persisted in localStorage (`biasPanelOpen`).

### v14.31 — bias-panel resilience signal is regime-aware

[server/analysis/bias.js:186-213](server/analysis/bias.js#L186-L213) — resilience signal contribution now depends on `indicators.regime.type` + `.direction` per the v9.0 multiplier table in [setups.js:1209-1212](server/analysis/setups.js#L1209-L1212). Trend context: fragile with regime direction (+1 bullish / −1 bearish), resilient against. Range context: resilient with prevailing direction, fragile against. Missing/neutral regime → 0. Display-only change; setups.js resilience multiplier path untouched, so B9 paper-trading edge (or_breakout 5m conf≥70) is unaffected. Spec: [data/analysis/2026-04-20_bias_macro_reconciliation.md](data/analysis/2026-04-20_bias_macro_reconciliation.md) §5.

### v14.28 — bias panel UI clarity + macro-readiness-aware conviction

Implements P0 and the two P1 UI-clarity items from the v14.27.1 diagnostic ([data/analysis/2026-04-20_bias_macro_reconciliation.md](data/analysis/2026-04-20_bias_macro_reconciliation.md) §8). Client JS + CSS only.

- **P0** — `_computeConviction()` at [public/js/alerts.js:3448](public/js/alerts.js#L3448) now signature `(setupScore, macroScore, readinessStatus, blockedGateIds)`. `readinessStatus==='blocked'` hard-gates to `STAND ASIDE — Macro BLOCKED — <gate ids>`. `readinessStatus==='caution'` demotes the computed tier by one step (HIGH CONVICTION → GOOD SETUP → MODERATE SETUP → MARGINAL → STAND ASIDE) with a `macro CAUTION (demoted from X)` sublabel tag. `fetchAndRenderBias()` caches `window._lastReadinessStatus` + `window._lastBlockedGateIds` so `_renderConviction()` can thread them in.
- **P1 gates** — gate rows render `g.detail` (live state string) as primary text, with the static gate name + id as the hover tooltip. Prevents users reading the gate name as a present-state claim. Falls back to `g.label` if `g.detail` is empty.
- **P1 signals** — ✓/➖/✗ icons indicate *alignment with overall `b.direction`*: ✓ when `sign(contribution)` matches, ✗ when opposed, ➖ on 0 contribution or neutral overall direction. Legend row ("✓ aligned  ➖ neutral  ✗ against") rendered once at the top of the signal list.

### v14.27.1 diagnostic — known bias panel issues (now partially resolved by v14.28)

See [data/analysis/2026-04-20_bias_macro_reconciliation.md](data/analysis/2026-04-20_bias_macro_reconciliation.md) for full field-source tables and live capture.

- **Macro readiness status does not reach `_computeConviction()`** ([alerts.js:3437](public/js/alerts.js#L3437)) — a BLOCKED macro can still produce "MODERATE SETUP" when bias and setup align directionally. v14.21 fixed directional conflict only; macro-gate verdict is not wired in. **P0 fix.**
- **Gate rows render static `g.label`** (gate name) not `g.detail` (current-state string). Users read "DXY Rising Late Session" as a claim about present state when it is actually the gate's fixed label. **P1 UI fix** in [alerts.js:3246-3258](public/js/alerts.js#L3246-L3258).
- **Signal ✓/✗** means "contribution ≠ 0" vs "0 contribution" — not "agrees/disagrees with bias direction" ([alerts.js:3344-3352](public/js/alerts.js#L3344-L3352)). **P1 clarification.**
- **Fragile resilience scored as always-bearish** ([bias.js:187-189](server/analysis/bias.js#L187-L189)) — inconsistent with [setups.js:1209-1212](server/analysis/setups.js#L1209-L1212) where fragile is a breakout amplifier (1.15×). Should be setup-context-aware. **P1 fix — ✅ Done v14.31** — bias.js:186-213 now reads `indicators.regime.type`: trend (breakout) context → fragile contributes with regime direction, resilient against; range (reversal) context → resilient with direction, fragile against; missing/neutral → 0. setups.js multiplier path untouched.
- **Field-source alignment between gates and signals is correct** — both read the same marketContext sub-objects. But this is held together by convention; consolidate into a shared `deriveMarketSnapshot(mktCtx)` helper. **P2.**
- **Forward-test trade records** showing `dxyDirection='flat'` always and null `equityBreadth`/`riskAppetite` is a separate bug in the scan-engine / simulator write path, not in the bias read path (confirmed by live debug capture). **P2 investigation.**

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
  M2K: 'RTY=F',  // Micro Russell 2000 (RTY is full-size ticker on Yahoo)
  MYM: 'MYM=F',  // Micro Dow Jones
};
```
Using NQ=F for MNQ data produces a ~0.1–0.3% price discrepancy which compounds into
incorrect options scaling ratios.

### Dashboard symbol selector (v14.20)
Reference-only instruments (ZT, ZF, ZN, ZB, UB, M6E, M6B, MBT) removed from the dashboard
symbol selector. They remain in the system for breadth computation and live feed — only their
clickable buttons were removed since they have no chart display logic.

### Startup data loading sequence (v14.20)
1. Seed data loads (seedFetch.js initial load)
2. Gap fill from historical files — **awaited** (loads 1m pipeline files, writes seed files for symbols without seed data)
3. Yahoo Finance 60-day backfill — **awaited** (5m/60d + 1m/7d, bridges pipeline gap)
4. Gap fill scheduler starts (periodic 1m/5m/15m/30m maintenance)
5. Databento live feed starts (if enabled)
6. Scan engine starts

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

## Market Breadth System — Phase V (v12.8)

### File: `server/analysis/marketBreadth.js`
16-instrument cross-market regime scoring. Called once per scan cycle (live) and pre-computed once per trading date (backtest).

**16 CME symbols used:**
- Equity indices: MNQ, MES, M2K, MYM
- Metals: MGC, SIL, MHG (copper)
- Energy: MCL
- FX: M6E (EUR/USD — inverse USD proxy), M6B
- Fixed income: ZT, ZF, ZN, ZB, UB
- Crypto futures: MBT

**Regime classifier** (`classifyInstrumentRegime(closes)`): 20-bar price position (vs 20-bar high × 0.95 / low × 1.05) combined with 10-bar SMA direction (0.05% threshold). Both agree → direction; one neutral → follow the other; disagree → neutral.

**Risk appetite composite score formula** (−20 to +20):
```
score += equityBreadth  × 3   // +0 to +12
score -= equityBearish  × 3   // −12 to 0
if bondRegime == 'bearish': score += 2  // yields rising = mild risk-on
if bondRegime == 'bullish': score -= 2  // flight to safety = risk-off
if copperRegime == 'bullish': score += 3
if copperRegime == 'bearish': score -= 3
if dollarRegime == 'falling': score += 1  // weak USD = commodity/equity tailwind
if dollarRegime == 'rising':  score -= 1
if btcRegime == 'bullish':    score += 1
if btcRegime == 'bearish':    score -= 1
riskAppetite = score >= 5 ? 'on' : score <= -5 ? 'off' : 'neutral'
```

**Dollar direction**: M6E (EUR/USD micro) bullish → USD falling; M6E bearish → USD rising.
**Bond direction**: ZN bullish = bond prices up = yields down = flight to safety (risk-off). ZN bearish = yields rising = mild risk-on.
**Yield curve**: steepening when ZN more bearish than ZT (10yr yield rising faster than 2yr); flattening when ZT more bearish.
**Fixed income breadth**: count of bearish bonds (selling = yields rising).

**Breadth additive scoring in applyMarketContext (cap ±15 pts):**

| Category | Condition | Points |
|---|---|---|
| Equity setups — breadth alignment | ≥3 bullish indices confirm direction | +6 |
| Equity setups — breadth against | ≤1 bullish index, going bullish | −5 |
| Equity setups — bond tailwind | Bond regime confirms direction | ±3/4 |
| Equity + commodity — copper | Copper confirms direction | ±4 |
| Commodity — dollar | Dollar falling = commodity tailwind | ±3 |
| MGC/SIL/MHG — metals breadth | ≥2 of 3 metals bullish | ±4 |
| All symbols — risk appetite | on/off vs setup direction | ±3/5 |

**Backtest integration:**
- `_precomputeBreadth(startDate, endDate)`: loads daily closes for all 16 symbols once at job start, computes per-date breadth using prior 21 trading days (no lookahead).
- Trade fields: `equityBreadth`, `bondRegime`, `copperRegime`, `dollarRegime`, `riskAppetite`, `riskAppetiteScore`
- Stats breakdowns: `byRiskAppetite`, `byBondRegime`, `byCopperRegime`, `byEquityBreadth`

---

## Backtest System (v10.x / v11.0) — Phase L/M/N

### Engine (`server/backtest/engine.js`)
- `runBacktestMTF()` — bar-by-bar replay, no lookahead, current-bar filter, OR dedup per session/direction
- Trade object fields: `symbol`, `date`, `timeframe`, `setupType`, `direction`, `entryTs`, `entry`, `sl`, `tp`, `confidence`, `outcome`, `exitTs`, `exitPrice`, `netPnl`, `grossPnl`, `hour` (ET), `hpProximity`, `resilienceLabel`, `dexBias`, `ddBandLabel`, `ddBandScore`, `vixRegime`, `vixLevel`, `dxyDirection`, `dxyClose`
- **Breadth fields** (v12.8+): `equityBreadth` (0–4), `bondRegime` (bullish/bearish/neutral), `copperRegime`, `dollarRegime` (rising/falling/flat), `riskAppetite` (on/off/neutral), `riskAppetiteScore` (−20 to +20)
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

## A5 Backtest Findings — Active Setup Configuration

**Validated configuration (as of 2026-04-04):**
- Active setups: `or_breakout`, `pdh_breakout` only
- `zone_rejection` disabled — R:R structurally inverted at all confidence levels (AvgWin $16 vs AvgLoss $24 at conf≥80). Not salvageable by confidence filter.
- OR breakout: 5m only — 15m/30m produce <1% of OR breakout signals
- Min confidence: 65%

**Default backtest window going forward:** Last 12–24 months (approx 2024-01-01 to present). Full-period runs (2018–present) are available but not the default — current market conditions are best reflected in recent data. B-series runs from B8 onward use the 24-month window.

**Final A5 results v12.7 (or_breakout + pdh_breakout, VIX+DXY active, 2018-09-24 → 2026-04-01):**
- 9,679 trades (5.4/day), WR 37.3%, PF 1.69, Net +$233,540, MaxDD $3,208
- or_breakout alone: Net +$248K, PF 1.86, AvgWin $147, AvgLoss $88
- pdh_breakout alone: Net -$14.6K (marginal, not harmful)
- VIX regime: edge holds across all regimes (strongest in normal: +$110K net)
- DXY direction: no meaningful filter signal (rising +$103K, falling +$97K)

**A5 re-run v12.9 (breadth+VIX+DXY active, same config):**
- 9,286 trades, WR 33.9%, PF 1.584, Net +$238,040, MaxDD $2,908
- vs v12.7: +$4,500 net (+1.9%), MaxDD 9% lower, WR -3.4pp, PF -0.105
- or_breakout: 6,680 trades, WR 32.1%, net +$243,351
- pdh_breakout: 2,606 trades, WR 38.3%, net -$5,312
- riskAppetite=neutral → best WR (37.2%); riskAppetite=on → most trades (5,995)
- equityBreadth=0–1 → best WR (36.2%); equityBreadth=3–4 → most net (+$117,867)
- bondRegime=bullish → WR 34.0%, net +$154,829 (largest segment)
- dollarRegime inversion confirmed correct in v12.8 (no bug found)
- Breadth precomputation note: reads all 1m daily files for 16 symbols (~46,470 files, ~4-5GB). Full A5 run takes ~1 hour due to synchronous I/O in _precomputeBreadth.

**A5 corrected v14.10 (correct fees + pointValues from v14.8):**
- 7,401 trades, WR 34.2%, PF 1.689, Net +$640,904, MaxDD $13,533
- or_breakout: 4,756 trades, WR 31.7%, Net +$638,046
- pdh_breakout: 2,645 trades, WR 38.6%, Net +$2,858
- MNQ: $362,932 | MGC: $163,533 | MES: $68,243 | MCL: $46,197
- Dollar figures differ significantly from pre-v14.8 runs due to corrected per-symbol fees ($1.62–$2.12/RT vs flat $4) and corrected SIL/MHG pointValues. WR/PF conclusions unchanged.

**By symbol (or_breakout net, pre-v14.8 reference):**
- MNQ: +$115K (44% of total)
- MGC: +$65K
- MES: +$57K
- MCL: +$25K

**Key structural finding:**
zone_rejection R:R is inverted because Supply/Demand zones in the backtest attract price repeatedly — the zone gets tested, rejected, retested, and eventually broken. Each rejection fires a signal but the average loss on failed rejections exceeds the average win on successful ones. The setup needs fundamental redesign (tighter SL, zone quality filter, or different TP structure) before it can be re-enabled.

---

## Phase 2 Loss-Analysis Filters (v14.11)

Implemented in `server/analysis/setups.js`. Derived from A5 corrected (7,401 trades) and B8 corrected (876 trades) analysis.

### Hard gates (setup skipped entirely)
| Filter | Location | Condition | Evidence |
|--------|----------|-----------|----------|
| 1 | `_orBreakout` loop | DXY rising + ET hour >= 11 | WR 20.7%, PF 0.965 (n=174) |
| 2 | `_pdhBreakout` top | symbol is MNQ/MES/MCL | Combined PF 0.954, net -$1,451 |
| 3 | `_orBreakout` top | dexBias === 'neutral' | PF 1.164 (n=286) |
| 4 | `_pdhBreakout` loop | MGC + (hour 9 or hour >= 11 ET) | Hour 9 PF 0.983, hour 11+ PF 0.700 |

### Score penalty
| Filter | Location | Condition | Penalty |
|--------|----------|-----------|---------|
| 5 | `_orConf` | DXY rising + ET hour <= 10 | score -= 8 |

### Deferred
- Filter 6: IA3 TODO comment. Conf 90-100 = PF 1.349 (weakest), 70-75 = PF 2.770 (strongest). Needs calibration investigation.

### B9 validation (job 9392cd8f9a9f)
- 729 trades, WR 42.7%, PF 2.265, Net $145,178, MaxDD $5,157, Sharpe 6.106
- Delta vs B8: -147 trades (-16.8%), WR +0.9pp, PF +0.036, Sharpe +0.41
- Filters active in B9: 1, 3, 5 (DXY and DEX gates on or_breakout). Filters 2, 4 had no effect (B9 uses or_breakout only on MNQ/MES/MCL).

### Technical notes
- DST-aware `_etHour()` added for accurate ET hour computation in filter gates
- `marketContext` passed to detection functions via existing `extras` parameter
- DXY direction source: `mktCtx.dxy.direction` → `mktCtx.breadth.dollarRegime` fallback → `'flat'`

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
  manifest.json                    ← zip inventory (Phase 1a)
  errors.log                       ← per-date errors (non-fatal)
  etf_closes.json                  ← unified ETF close prices (Phase 1d)
  raw/GLBX/{SYMBOL}/               ← per-symbol extracted .csv.zst files (Phase 1b)
  raw/OPRA/{etf}/                  ← extracted OPRA .csv.zst files (Phase 1b)
  raw/ETF_closes/{etf}/            ← extracted XNYS.PILLAR ohlcv-1d files (Phase 1b)
  futures/{SYMBOL}/                ← per-date OHLCV JSON files (Phase 1c)
  options/{etf}/                   ← per-date option chain files (Phase 1e)
  options/{etf}/computed/          ← per-date HP snapshot files (Phase 1f)  ← NOTE: inside options/{etf}/, not a top-level computed/ dir
```

**Note on HP computed path:** HP snapshots are written to `options/{etf}/computed/{date}.json` (inside the options directory, not a separate top-level `computed/`). The backtest engine reads from `path.join(DATA_DIR, 'options', proxy, 'computed', date + '.json')` — same path.

### Streaming zip extraction
`unzipper` replaces `adm-zip` — supports >2 GiB archives (QQQ OPRA zip is 3.3 GB). `adm-zip` uses `fs.readFileSync` on the whole archive which hits Node's 2 GiB buffer limit.

---

## Known Limitations

- CBOE data is 15-min delayed (free tier) — options levels are approximate intraday
- Pine Script levels are static until regenerated and repasted — not live-updating
- Crypto (BTC/ETH/XRP) options data not available — options panel only shown for MNQ/MES
- Alert dedup uses in-memory ATR at alert creation time — if server restarts, the 15-min cooldown window resets (in-memory only; alerts.json history is preserved)
- `decayedConfidence` is display-only — `setup.confidence` is immutable after alert creation
- Backtest trade objects do not include regime/nearEvent/mtfConfluence fields (v10.x)

---

## EdgeLog (port 3004)

Deferred until paper trading is stable and producing consistent results. MVP scope to be defined at that point. Audience: futures day traders and prop firm traders. Estimated pricing: $20–35/month.

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
