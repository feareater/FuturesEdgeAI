# FuturesEdge AI — CLAUDE.md
> Project context for Claude Code. Read this, ROADMAP.md, and CONTEXT_SUPPLEMENT.md at the start of every session.

---

## What This Project Is

FuturesEdge AI is a browser-based trading analysis dashboard for a single user (Jeff) — an active retail futures trader. It connects to live market data, detects high-probability trade setups in real time, and provides AI-generated commentary to support — not replace — manual trade decisions.

**It executes paper/demo trades only — via Tradovate Demo API (`demo.tradovateapi.com`). It must NEVER place orders against a live/production brokerage endpoint.**

---

## Instruments & Markets

### Tradeable (setup scanning active)
- **MNQ** — Micro E-mini Nasdaq-100 Futures
- **MES** — Micro E-mini S&P 500 Futures
- **M2K** — Micro Russell 2000 Futures
- **MYM** — Micro Dow Jones Futures
- **MGC** — Micro Gold Futures
- **MCL** — Micro Crude Oil Futures
- **MHG** — Micro Copper Futures
- **SIL** — Micro Silver Futures
- **BTC, ETH, XRP, XLM** — Crypto perpetuals (Coinbase INTX)

### Reference (charts + breadth only, no setup scanning)
- **M6E, M6B** — Micro EUR/USD, Micro GBP/USD (FX)
- **MBT** — Micro Bitcoin CME (btcRegime breadth)
- **ZT, ZF, ZN, ZB, UB** — Treasury bonds (bond breadth)

- `SCAN_SYMBOLS` = `['MNQ','MGC','MES','MCL','BTC','ETH','XRP','XLM','SIL','M2K','MYM','MHG']`
- Active scan timeframes: **5m, 15m, 30m** (seed mode: 15m/30m/1h/2h/4h; live mode: 5m/15m/30m triggered on bar close)
- Chart display timeframes: **1m/5m/15m/30m/1h/2h/4h** — 1m seed data exists for MNQ/MES/MGC/MCL/SIL; crypto 1m requires live feed

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Backend framework | Express.js |
| Market data (Phase 1) | Yahoo Finance seed data — `data/seed/*.json` (run `node server/data/seedFetch.js` to refresh) |
| Market data (Phase O) | Databento REST API — `server/data/databento.js` (live 1m feed for MNQ/MES/MGC/MCL; hot-toggle via `features.liveData`) |
| Market data (Phase 3+) | Ironbeam REST + WebSocket (Optimusfutures account — needs API access enabled) |
| Charting | TradingView Lightweight Charts |
| Technical indicators | `technicalindicators` npm library |
| AI commentary | Anthropic Claude API (claude-sonnet-4-6) |
| AI analysis (batch) | Claude API (claude-sonnet-4-6) — batch analysis + alert commentary |
| Frontend | HTML / CSS / Vanilla JS |
| Local comms | `ws` WebSocket library |
| Storage | JSON flat files (local) |

---

## Project Structure

```
FuturesEdgeAI/
├── CLAUDE.md                  ← You are here
├── CHANGELOG.md               ← Version history of all changes
├── package.json
├── .env                       ← API keys — never commit this
├── .gitignore
├── server/
│   ├── index.js               ← Express server entry point; all API routes; scan engine
│   ├── auth/
│   │   └── tradovate.js       ← OAuth + session token management
│   ├── data/
│   │   ├── instruments.js     ← Single source of truth: all 16 CME symbols + 6 OPRA underlyings (pointValue, dbRoot, optionsProxy, etc.)
│   │   ├── snapshot.js        ← OHLCV fetch + candle normalization (source-agnostic); _sanitizeCandles has 3-pass filter (null/zero, close spikes via CLOSE_SPIKE_THRESHOLD, wick spikes); purgeAllInvalidBars rebuilds higher TFs from clean 1m
│   │   ├── seedFetch.js       ← Yahoo Finance seed data fetch (MNQ/MGC/MES/MCL/SIL/M2K/MYM)
│   │   ├── dailyRefresh.js    ← Hourly data refresh: Databento→Yahoo fallback, 60-min interval, all 16 CME symbols, HP recompute
│   │   ├── dataQuality.js    ← Data quality detection: spike/gap/stale/broker-mismatch detection, per-symbol status (ok/warning/bad), auto-refresh trigger, Yahoo cross-validation
│   │   ├── gapFill.js         ← Automatic candle gap detection + backfill (startup + 15min scheduler)
│   │   ├── historicalPipeline.js ← Databento historical data pipeline (phases 1a–1f)
│   │   └── calendar.js        ← ForexFactory economic calendar (1h cache)
│   ├── analysis/
│   │   ├── indicators.js      ← EMA, VWAP, ATR, PDH/PDL, swings, VP, OR, sessions
│   │   ├── regime.js          ← Market regime classification
│   │   ├── trendlines.js      ← Significance-ranked trendline detection
│   │   ├── iof.js             ← FVG + Order Block detection
│   │   ├── setups.js          ← zone_rejection, pdh_breakout, trendline_break, or_breakout
│   │   ├── confluence.js      ← Multi-TF zone stack scoring
│   │   ├── alertDedup.js      ← isDuplicate (15-min/±0.25×ATR), applyStaleness, pruneExpired
│   │   ├── marketBreadth.js   ← 16-instrument cross-market regime scoring (breadth + risk appetite)
│   │   ├── volumeProfile.js   ← Session POC/VAH/VAL (70% value area)
│   │   ├── openingRange.js    ← RTH Opening Range (09:30–10:00 ET)
│   │   ├── sessionLevels.js   ← Asian + London session H/L
│   │   ├── relativeStrength.js← MNQ vs MES normalized ratio + Pearson correlation
│   │   ├── correlation.js     ← 4×4 pairwise rolling correlation matrix
│   │   ├── performanceStats.js← WR/PF/avgR by symbol, setup, TF, hour, direction
│   │   └── bias.js            ← computeSetupReadiness(symbol, mktCtx, hour, mode) + computeDirectionalBias (dashboard bias panel)
│   ├── ai/
│   │   └── commentary.js      ← Claude API prompt builder + caller
│   ├── trading/
│   │   ├── autotrader.js      ← Kill-switch state machine for paper trading
│   │   └── simulator.js       ← Virtual position tracker; checkLiveOutcomes() for forward-test; one-trade-per-symbol gate + or_breakout session dedup
│   ├── push/
│   │   └── pushManager.js     ← VAPID push manager; subscriptions in data/push/subscriptions.json
│   └── storage/
│       └── log.js             ← Alert, commentary, and trade log persistence; updateAlertOutcome()
├── public/
│   ├── index.html             ← Main dashboard
│   ├── commentary.html        ← AI analysis page
│   ├── performance.html       ← Performance analytics (WR stats, ToD heat map)
│   ├── backtest.html          ← Alert replay / step-through backtester
│   ├── docs.html              ← Setup guide
│   ├── css/
│   │   ├── dashboard.css      ← Main dashboard styles
│   │   ├── performance.css    ← Performance page styles
│   │   └── backtest.css       ← Backtest page styles
│   ├── js/
│   │   ├── chart.js           ← TradingView chart renderer + all indicator overlays; loadData() clears all series before fetching, AbortController cancels in-flight, gap retry timer cancelled on symbol switch
│   │   ├── chartManager.js    ← Multi-symbol grid mode (7 charts); mode toggle; single/grid switching
│   │   ├── layers.js          ← Layer toggles + feature toggle panel
│   │   ├── alerts.js          ← Alert feed, WS, RS widget, calendar badge, sound alerts, Active Setups panel (live P&L via live_price ticks)
│   │   ├── performance.js     ← Performance analytics renderer
│   │   └── backtest.js        ← Alert replay logic + P&L tracker
│   ├── manifest.json          ← PWA manifest
│   └── sw.js                  ← Service worker (cache-first shell, network-only /api/)
├── data/
│   ├── seed/                  ← OHLCV snapshots (MNQ/MGC/MES/MCL × 5m/15m/30m)
│   ├── logs/                  ← alerts.json, commentary.json, trades.json
│   └── analysis/              ← Claude API analysis outputs ({timestamp}_{type}.json/.txt) — gitignored
└── config/
    └── settings.json          ← risk block + features block (10 hot-toggleable flags)
```

---

## Environment Variables

All secrets live in `.env` — never hardcode them, never commit them.

```
TRADOVATE_USERNAME=
TRADOVATE_PASSWORD=
TRADOVATE_APP_ID=
TRADOVATE_APP_SECRET=
TRADOVATE_API_URL=https://demo.tradovateapi.com/v1
TRADOVATE_WS_URL=wss://md.tradovateapi.com/v1/websocket
ANTHROPIC_API_KEY=
PORT=3000
```

---

## Analysis Engine — What It Computes

### Indicators (computed per timeframe on every candle close)
- **EMA 9, 21, 50** — trend direction + dynamic S/R
- **VWAP** — session reset at RTH open (09:30 ET)
- **ATR(14)** — volatility context + stop sizing
- **Prior Day High / Low** — key institutional reference levels
- **Swing Highs / Lows** — configurable lookback (default: 10 candles)

### Market Regime (per timeframe)
- **Type:** `trend` or `range`
- **Direction:** `bullish`, `bearish`, or `neutral` (based on EMA stack alignment)
- **Strength:** 0–100 score (EMA spread + ATR + swing consistency)
- **Alignment:** boolean — 15m and 5m direction agreement

### Trendlines
- Significance-ranked (not just most recent) — scored by magnitude of reaction
- Resistance line: two highest-scoring swing highs connected
- Support line: two highest-scoring swing lows connected
- Dynamically redrawn on every new confirmed swing point
- Manual override supported — persists in `config/settings.json`

### Institutional Order Flow (IOF)
**Fair Value Gaps (FVG)**
- Bullish: candle 3 low > candle 1 high (3-candle sequence)
- Bearish: inverse
- Status: `open` or `filled`

**Order Blocks (OB)**
- Last opposing candle before strong impulsive move
- Valid only if body-to-total-range ratio ≤ 50%
- Impulse threshold: 1.5x ATR(14) — configurable
- Status: `untested`, `tested`, or `mitigated`

**Confluence flag:** When an open FVG and untested OB overlap or are within proximity threshold → flagged as high-confluence IOF zone

### Setup Detection (active types — backtest-validated)

| Type | Code | Role | Notes |
|---|---|---|---|
| Supply/Demand Zone Rejection | `zone_rejection` | Primary signal | 72.7% WR — regime-gated (see below) |
| PDH/PDL Breakout | `pdh_breakout` | Primary signal | 66.7% WR, delay-tolerant momentum trade |
| Trendline Break | `trendline_break` | Primary signal | New — ≥3 touches required |
| BOS / CHoCH | `bos` / `choch` | Confidence qualifier only (+15 pts) | Not traded standalone; CHoCH also unlocks counter-trend zones |
| ~~Liquidity Sweep + Reversal~~ | ~~`liquidity_sweep_reversal`~~ | **Removed** | 43% WR, PF 0.68 — negative edge |

**Zone Rejection** — price enters a Supply/Demand zone, produces a significant wick, closes back outside with body in rejection direction. BOS/CHoCH within the scan window adds +15 confidence pts. **Regime gate applied**: counter-trend zone rejections are suppressed unless a CHoCH confirmed a trend shift in that direction.

**PDH/PDL Breakout** — close beyond the prior-day high (bullish) or prior-day low (bearish) with momentum confirmation. RTH-gated (UTC 13:00–21:00). Delay-tolerant: breakout momentum persists well past the 15-min data lag.

**Trendline Break** — candle closes on the opposite side of the established support (bearish break) or resistance (bullish break) trendline for the first time. Only fires if the trendline has ≥3 confirmed touches. Scored on break decisiveness, touch count, regime alignment, and IOF confluence. Highly delay-tolerant — trend momentum from a clean trendline break lasts 15+ minutes.

**Scan timeframes: 5m, 15m, 30m only.** 1m/2m/3m removed — with 15-min delayed data, fast-TF alerts are stale by the time they appear. 5m/15m/30m give actionable signals accounting for the lag.

**Minimum confidence: 65%** — default filter in the UI. Alerts below 65% are predominantly counter-trend noise or marginal wicks with no confluence.

### Signal Scoring — Backtest Findings (Feb 2026)

**Multi-TF Zone Stack (MNQ only)**
- MNQ + HTF IOF zone at same level: **77.8% WR, PF 3.15** — strong positive predictor
- MGC + HTF IOF zone: **37.5% WR, PF 0.39** — inverted predictor (contested level breaks rather than holds)
- Double-stack (5m AND 15m both confirming): **50% WR, PF 0.65** — worse than single-TF; overloaded levels tend to already be tested
- TF stack therefore: MNQ-only, capped at 1 confirming TF (+15 confidence pts max)
- Constants: `STACK_BONUS_PER_TF=15`, `STACK_MAX=15`, `PROX_ATR_MULT=0.5`

**Symbol-specific PDH R:R**
- MNQ → 2:1 (`PDH_RR = 2.0`)
- MES → 2:1 (`PDH_RR = 2.0`)
- MGC → 1:1 (`PDH_RR = 1.0`)
- MCL → 1.5:1 (`PDH_RR = 1.5`)

**Phase 2 Loss-Analysis Gates — `applyMarketContext()` in `setups.js` (Apr 2026)**

Two additive confidence penalties derived from worst-500-loser analysis of the A5 full-period backtest. Applied after all multipliers and breadth scoring, before final score clamp. Tracked in `setup.scoreBreakdown.context.lossGatePts`.

| Gate | Condition | Penalty | Basis |
|------|-----------|---------|-------|
| Rising DXY OR breakout | `setup.type === 'or_breakout'` AND DXY direction = `'rising'` | −20 pts | ~49% of worst 500 A5 losses; strengthening dollar drains breakout momentum across all symbols |
| Risk-off breadth collapse | `riskAppetite === 'off'` AND `equityBreadth ≤ 1` | −15 pts | Structural headwind when ≤1 of 4 equity indices bullish and risk appetite off |

Gates are **additive** — both can fire simultaneously for a maximum −35 pts penalty. A base score of 65 with both gates active → final score ≤ 30 (hard skip at 65% threshold).

DXY direction source: `marketContext.breadth?.dollarRegime` (available in both live and backtest), falling back to `marketContext.dxy?.direction` (live HP feed only). The backtest engine's `mktCtx.dxy.direction` is always `'flat'` for historical dates — the breadth fallback ensures gates fire correctly in backtests.

---

## Alert Object Schema (v2.0)

Alerts are persisted to `data/logs/alerts.json`. Each alert object has this shape:

```json
{
  "symbol": "MNQ",
  "timeframe": "5m",
  "ts": "2026-02-22T14:32:00.000Z",
  "regime": {
    "type": "trend",
    "direction": "bullish",
    "strength": 78,
    "alignment": true
  },
  "setup": {
    "type": "zone_rejection",
    "direction": "bullish",
    "time": 1708609920,
    "price": 21405.25,
    "entry": 21405.25,
    "sl": 21388.50,
    "tp": 21439.00,
    "riskPoints": 16.75,
    "outcome": "won",
    "outcomeTime": 1708612800,
    "confidence": 82,
    "scoreBreakdown": { "base": 40, "depth": 5, "body": 5, "wick": 10, "regime": 10, "align": 7, "iof": 5, "tfStack": 15 },
    "rationale": "Zone rejection at demand — bullish wick, trend aligned · 15m stack",
    "zoneLevel": 21390.00,
    "tfStack": { "stackCount": 1, "bonus": 15, "tfs": ["15m"] },
    "commentary": "This bullish zone rejection at 21390...",
    "staleness": "fresh",         // 'fresh' | 'aging' (30min, ×0.85) | 'stale' (60min, ×0.70)
    "decayedConfidence": 82       // display-only; setup.confidence is immutable
  }
}
```

`setup.time` is Unix seconds. `commentary` is present once AI has generated it (persisted to avoid re-calling the API).

---

## Dashboard — Active Setups Panel (v14.25.1)

The right panel has an "Active Setups" section (above Scan Predictions) showing all open alerts across all symbols with live P&L:

- Filters `allAlerts` for `outcome === 'open'` with valid entry/SL/TP, not older than 8 hours
- Each card: symbol, direction, setup type, confidence, TF, age, live price, unrealized P&L, progress bar (0–100% toward TP)
- **Live updates every second** via `live_price` WS events — `_updateActiveSetupPrices()` patches DOM text only (no re-render)
- Full re-render on alert fetch cycles (new setup, data refresh, `outcome_update`, `sim_fill`)
- P&L calculation: `(currentPrice - entry) × POINT_VALUE[symbol] × contracts` (bullish); reversed for bearish
- Click a card → switches chart to that symbol + highlights the setup
- `_livePrices` map (in `alerts.js`) tracks latest price per symbol from 1s ticks

## Dashboard — Layer Toggles

The chart has individual toggles for every layer. States persist in `config/settings.json`.

Toggleable layers: EMA 9, EMA 21, EMA 50, VWAP, Auto Trendlines, Manual Trendlines, Order Blocks (untested), Order Blocks (tested), FVG (open), FVG (filled), Supply/Demand Zones, Prior Day High/Low, Swing H/L markers, IOF Confluence Zones.

Default view (Reset to Default): all layers ON.

---

## AI Commentary Layer

- Model: `claude-sonnet-4-6`
- Triggered on every setup event
- Prompt includes: instrument, price, timeframe, setup type, key levels, regime, session, last 5 candles
- Response: 3–5 sentences — what the setup is, quality, caveats, confirmation/invalidation area
- Rate limiter: prevents repeat calls on same level within configurable window
- Target latency: ≤ 3 seconds from setup trigger to commentary displayed

---

## Build Phases

| Phase | Focus | Status |
|---|---|---|
| 1 | Node.js scaffold, seed data pipeline, basic chart | ✅ Complete |
| 2 | Indicators & overlays — EMA, VWAP, ATR, PDH/PDL, Swing H/L, layer toggles | ✅ Complete |
| 3 | Setup detection algorithms, regime classification, alert feed, WebSocket push | ✅ Complete |
| 4 | Claude AI commentary integration (on-demand + batch, persisted) | ✅ Complete |
| 5 | Alert + commentary persistence, multi-TF confluence scoring (MNQ-only, analysis-driven) | ✅ Complete |
| 6 | UI polish, error handling, session badge, WebSocket backoff, CLAUDE.md refinement | ✅ Complete |
| 7 | MES + MCL instruments, OR breakout setup, feature flag architecture | ✅ Complete |
| 8 | Volume Profile, Opening Range, Session Levels, Relative Strength, Correlation Matrix | ✅ Complete |
| 9 | Economic Calendar (ForexFactory feed + gating), calendar badge, near-event alerts | ✅ Complete |
| 10 | Performance analytics page, Alert Replay/Backtest page, sound alerts, RS widget | ✅ Complete |
| N (v11.0) | DD Band / CME SPAN margin levels — confidence modifier, chart layer, topbar widget, backtest analysis | ✅ Complete |
| O (v12.0) | Databento live data feed — REST adapter, live gate in snapshot.js, 1m→5m/15m/30m aggregation, event-driven scan | ✅ Complete (B1–B4) |
| P (v12.1) | Historical pipeline v2 — instruments.js, 16 symbols, per-symbol zip extraction (Phase 1b), per-symbol directory scan (Phase 1c), --clean-raw/--force flags, DATABENTO_ROOT_TO_INTERNAL fixes for MGC/SIL/MHG | ✅ Complete (A2) |
| Q (v12.2) | OPRA pipeline correctness — fetchETFDailyCloses (Databento ohlcv-1d via DBEQ.BASIC), Phase 1d ETF close fetch, Phase 1e strike/OI parsing fix (plain parseFloat, OI-only stats, underlyingPrice from etf_closes.json), hpCompute.js openInterest compat | ✅ Complete |
| R (v12.3) | ETF close pipeline from XNYS.PILLAR ohlcv-1d zips — Phase 1b loop 4 (ETF_closes/ extraction), Phase 1d rewrite (local file parser, no API), Phase 1e remove lastKnownPrice fallback (skip dates with no ETF close), Phase 1f HP computation complete (~1736 dates/ETF, 2018–2026, written to options/{etf}/computed/) | ✅ Complete |
| S (v12.5) | Backtest dedup fix — zone_rejection key uses zone-level bucket (0.25 ATR), 60-min per-direction cooldown shared across all TFs (cross-TF lastZoneRejTs at symbol scope); A5 full-period baseline run | ✅ Complete |
| T (v12.6) | A5 isolation runs — or_breakout@65 (Net +$262K, PF 1.86, 5m-only, MNQ leads), zone_rejection@80 (still net -$204K, R:R unfixable by conf filter). Combined analysis: or_breakout+pdh_breakout is recommended config | ✅ Complete |
| U (v12.7) | DX/VIX pipeline — Phase 1b loop 5 (DX extraction), Phase 1d DX parsing (dxy.json, 2251 dates, 89–114 range), historicalVolatility.js + Phase 1g (vix.json, 1767 dates, March 2020=80.5%), engine VIX/DXY enrichment + zone_rejection disabled default + OR breakout 5m-only guard. Final A5: Net +$233K, PF 1.69 | ✅ Complete |
| V (v12.8) | Market breadth scoring — marketBreadth.js (16 CME instruments), breadth additive scoring in applyMarketContext (±15 pts cap), trade record breadth fields, Optimize tab Market Breadth + Inter-market sub-tabs | ✅ Complete |
| W (v12.9) | A5 Final with breadth active — dollarRegime spot-check (no inversion bug), full-period A5 re-run: Net +$238K, WR 33.9%, PF 1.584, 9,286 trades. Breadth marginal positive (+$4,500 vs baseline, MaxDD 9% lower). zone_rejection remains disabled. | ✅ Complete |
| X (v13.0) | B5 forward-test harness — checkLiveOutcomes in simulator.js, alertDedup.js, pushManager.js (VAPID web-push), alert feed AGING/STALE badges | ✅ Complete |
| Y (v13.1) | AI analysis tab — backtest2.html 6th tab (AI Analysis), POST /api/backtest/analyze SSE endpoint. Originally Ollama; migrated to Claude API (claude-sonnet-4-6) in v14.4 | ✅ Complete |
| Z (v13.2) | Backtest performance: worker threads (non-blocking POST /api/backtest/run, MAX_CONCURRENT_JOBS=4), breadth cache (breadth_cache.json, ~4× speedup on repeat runs), TF pre-aggregation (futures_agg/ directory, skip-if-exists) | ✅ Complete |
| AA (v13.3) | Multi-symbol chart grid + 1m timeframe — chartManager.js (7 simultaneous mini charts, mode toggle, per-symbol TF, live prices), 1m TF button added to UI, graceful no-data overlay for missing seed files | ✅ Complete |
| AB (v13.4) | Databento TCP live feed — CRAM auth, ohlcv-1s ticks (1s chart updates via `_liveTickBar`), ohlcv-1m bars, seed+live merge in `getCandles()`, `live_candle` WS handler, `updateLiveCandle()` in chart.js | ✅ Complete |
| AC (v14.3) | Bar validation layer (barValidator.js) + all 8 CME symbols on live feed (MNQ/MES/MGC/MCL/SIL/M2K/MYM/MHG) | ✅ Complete |
| v14.27.1 (diagnostic) | Bias panel ↔ macro context reconciliation — field sources documented, live capture, prioritized fix list (P0: macro readiness → conviction; P1: fragile resilience sign; gate/signal UI semantics). See [data/analysis/2026-04-20_bias_macro_reconciliation.md](data/analysis/2026-04-20_bias_macro_reconciliation.md) | ✅ Complete (diagnostic only; fixes pending) |
| v14.28 | Conviction sees macro readiness + bias panel UI clarity — P0 (`_computeConviction()` hard-gates STAND ASIDE on `readiness.overallStatus==='blocked'` with blocking-gate sublabel; `caution` demotes one tier), P1 gate rows render `g.detail` (live state) with static label as tooltip, P1 signal icons become ✓ aligned / ➖ neutral / ✗ against with a legend row. Client JS + CSS only, no server restart. Remaining: P1 resilience sign, P2 forward-test stamping, P2 `deriveMarketSnapshot` helper. | ✅ Complete |

---

## Alert Object Schema — DD Band additions (v11.0)

`setup.ddBandLabel` — one of:
- `room_to_run` (+8), `approaching_dd` (+4), `neutral` (0)
- `outside_dd_upper` / `outside_dd_lower` (−7)
- `beyond_dd_upper` / `beyond_dd_lower` (−12)
- `at_span_extreme` (−20)
- `pdh_beyond_dd` (−12, PDH breakout special case)

`setup.scoreBreakdown.ddBand` — confidence point adjustment (−20 to +8)

## SPAN Margins (`config/settings.json → spanMargin`)

```json
{ "MNQ": 1320, "MES": 660, "MGC": 1650, "MCL": 1200, "cryptoVolAnnualized": 0.30 }
```

Update at runtime via `POST /api/settings/span` or the SPAN Margins panel in the dashboard sidebar.

## DD Band Feature Flag

`features.ddBands` (default: true) — hot-toggle via `POST /api/features { "ddBands": false }`.

## New API Routes (v11.0)

| Route | Purpose |
|---|---|
| `GET /api/ddbands?symbol=MNQ` | Current DD/SPAN levels + currentPrice for topbar widget |
| `GET /api/bias?symbol=MNQ&mode=auto` | Macro context gates + directional bias score (30s cache, mode: auto/manual) |
| `POST /api/settings/span` | Update SPAN margin values (body: `{ MNQ: 1400, ... }`) |
| `POST /api/backtest/analyze` | SSE streaming backtest analysis via Claude API |
| `POST /api/refresh/symbol/:symbol` | Trigger 24h data refresh for a single CME symbol (async, returns immediately) |
| `POST /api/refresh/all` | Trigger full 24h refresh for all 8 CME symbols + options HP (409 if already running) |
| `GET /api/refresh/status` | Status of last daily refresh run (`{ lastRun, status, results }`) |
| `GET /api/forward-test/export` | Export resolved alerts as flat analysis-ready JSON (query: start, end, setup, symbol, minConfidence) |
| `GET /api/data-quality` | Full data quality status map for all symbols/TFs (ok/warning/bad + issues) |
| `GET /api/data-quality/:symbol` | Data quality status for one symbol (all TFs) |
| `POST /api/data-quality/check/:symbol` | Manually trigger full data quality check (gap + stale + Yahoo cross-validate) |

---

## Databento Live Feed (v13.4 — TCP, updated 2026-04-06)

### Files
- `server/data/databento.js` — TCP Live API adapter (CRAM auth), ohlcv-1s ticks + ohlcv-1m bars, historical REST functions
- `server/data/snapshot.js` — live gate, seed+live merge in `getCandles()`, `writeLiveCandle()`, 1m→5m/15m/30m aggregation

### TCP connection
- Host: `glbx-mdp3.lsg.databento.com:13000` (Node.js `net` module, raw TCP)
- Auth: CRAM — `SHA256("<challenge>|<apiKey>").hex + "-" + apiKey.slice(-5)`
- Handshake: plain-text `key=value` lines (NOT JSON): `lsg_version=…`, `cram=…`, `success=1|…`
- Subscriptions (sent after auth): `schema=ohlcv-1s` + `schema=ohlcv-1m`, both `stype_in=parent`
- Record types: `rtype=22` (symbol mapping), `rtype=32` (ohlcv-1s tick), `rtype=33` (ohlcv-1m bar)
- Reconnect: exponential backoff 5s→5min

### Symbol map (parent subscription)
| Internal | Subscribe as | Notes |
|---|---|---|
| MNQ | `MNQ.FUT` | Micro E-mini Nasdaq-100 |
| MES | `MES.FUT` | Micro E-mini S&P 500 |
| MGC | `GC.FUT` | GC proxy — same price/oz, rtype=22 maps GC root → MGC |
| MCL | `MCL.FUT` | Micro Crude Oil |
| SIL | `SI.FUT` | SI proxy — same price/oz, rtype=22 maps SI root → SIL |
| M2K | `M2K.FUT` | Micro Russell 2000 |
| MYM | `MYM.FUT` | Micro Dow Jones |
| MHG | `HG.FUT` | HG proxy — rtype=22 maps HG root → MHG |

### How it works
1. `startLiveFeed(symbols, onCandle, onTick)` — connects TCP, authenticates, subscribes
2. **ohlcv-1s** (rtype=32): spike-filtered via `_isSpikePrice()` (per-symbol threshold from rolling 10-tick median: MNQ/MES/M2K/MYM 1.5%, MGC/MHG 1.2%, SIL 1.5%, MCL 2.0%) → `onTick(symbol, price, time)` → `broadcast({ type: 'live_price' })` → `ChartAPI.updateLivePrice()` builds in-progress forming candle (also spike-filtered client-side with matching thresholds), updates chart every second
3. **ohlcv-1m** (rtype=33): spike-filtered (close rejected if beyond per-symbol threshold from rolling median; wicks clamped to max(1.5× body, minWickFloor)) → `onCandle(symbol, candle)` → `validateBar()` (5-rule sanity check: null/zero guard, open continuity, OHLC consistency, ATR spike clamp with per-symbol bounds, volume guard) → `writeLiveCandle()` stores bar + aggregates 5m/15m/30m → `_onLiveCandle()` broadcasts `live_candle` + fires targeted scan
4. `getCandles()` merges seed history + live bars (returns **defensive copies**, not shared references) — chart always shows full history
5. Completed bars: `ChartAPI.updateLiveCandle()` replaces forming candle, resets `_liveTickBar`

### Feature flag
`features.liveData` (default: **false**) — set to `true` to activate live feed at next server startup.
Hot-toggle: `POST /api/features { "liveData": true }` (requires restart to start TCP connection).

### Environment variable
`DATABENTO_API_KEY` — in `.env`. Live feed silently disabled if not set.

### Historical data
Raw Databento zip downloads live in `Historical_data/` (gitignored, never committed).
Processed candle files go in `data/historical/` (also gitignored).
Historical REST functions (`fetchHistoricalCandles`, `fetchETFDailyCloses`) still use `hist.databento.com` with `stype_in=continuous`.

### API route
| Route | Purpose |
|---|---|
| `GET /api/datastatus` | Live feed health: source, lag seconds, last bar times per symbol |

---

## Git Workflow

Repository: `https://github.com/feareater/FuturesEdgeAI`
Default branch: `main` (always working, pushable)

**Feature branch model:**
```
main                    ← stable, always working
feature/<short-name>    ← active development
```

**Starting new work:**
```bash
git checkout main
git pull origin main
git checkout -b feature/ironbeam-live-data
```

**Finishing work:**
```bash
git checkout main
git merge feature/ironbeam-live-data
git push origin main
git branch -d feature/ironbeam-live-data
```

- Commit at logical checkpoints (not just at the end)
- Keep commits focused — one concern per commit
- Push `main` to GitHub after every completed feature
- Never commit `.env`, `server.log`, or `data/seed/*.json`

---

## Coding Rules

- **JavaScript only** — no Python, no TypeScript (keep it simple for now)
- **Demo/paper order execution only** — all order placement goes through `TRADOVATE_API_URL` which must always point to `demo.tradovateapi.com`. Never hardcode a live endpoint. See `server/trading/orders.js` and `server/trading/autotrader.js`.
- **All API keys via `.env`** — never hardcoded
- **Data layer is source-agnostic** — Tradovate and Ironbeam/CQG share the same normalized OHLCV interface so switching data sources is a config change only
- **Indicators computed in code** — AI never invents or estimates price levels
- **One file per concern** — keep modules focused and small
- **Console.log liberally during dev** — we want visibility into what the engine is doing

---

## Current Phase

**All 10 phases complete. Project is production-ready for seed-mode use.**

### Feature Flags (`config/settings.json` → `features` block)

All toggleable at runtime via `POST /api/features { "featureName": true|false }` — no restart needed.

| Flag | Default | What it controls |
|---|---|---|
| `volumeProfile` | true | POC/VAH/VAL price lines on chart |
| `openingRange` | true | OR Hi/Lo/Mid lines on chart + `or_breakout` setup detection |
| `sessionLevels` | true | Asian/London session H/L lines on chart |
| `economicCalendar` | true | ForexFactory feed, topbar badge, -20 confidence gating |
| `relativeStrength` | true | MNQ vs MES RS widget in topbar |
| `correlationHeatmap` | true | 4×4 correlation panel in sidebar |
| `performanceStats` | true | `/performance.html` stats rendering |
| `alertReplay` | true | `/backtest.html` date-range replay |
| `soundAlerts` | **false** | Web Audio API two-tone on new alert |
| `pushNotifications` | **false** | Browser Push API — default off; enable via `POST /api/features { "pushNotifications": true }` |

### New API Routes (v3.0)

| Route | Purpose |
|---|---|
| `POST /api/features` | Hot-toggle feature flags (persisted) |
| `GET /api/calendar?symbol=` | Upcoming high-impact events from ForexFactory |
| `GET /api/correlation` | 4×4 pairwise rolling correlation matrix |
| `GET /api/relativestrength` | MNQ/MES ratio, correlation, signal |
| `GET /api/performance` | WR/PF/avgR by symbol, setup type, TF, hour, direction |
| `GET /api/alerts?start=ISO&end=ISO` | Date-range filtered alerts (for backtest) |
| `GET /api/settings` | Now returns `risk` + `features` |
| `GET /api/push/vapid-public-key` | Returns VAPID public key for browser push subscription |
| `POST /api/push/subscribe` | Save a PushSubscription object (feature-flag gated) |
| `DELETE /api/push/subscribe` | Remove a subscription by endpoint URL |

### Active Setup Types

| Type | Code | Notes |
|---|---|---|
| Zone Rejection | `zone_rejection` | Primary — regime-gated |
| PDH/PDL Breakout | `pdh_breakout` | RTH-gated (13:00–21:00 UTC) |
| Trendline Break | `trendline_break` | ≥3 touches required |
| OR Breakout | `or_breakout` | After 14:00 UTC, RTH only, first-close |

## Backtest System (v13.2) — Key Facts

### Default Backtest Window
Standard backtest window going forward: last 12–24 months (approx 2024-01-01 to present). Full-period runs (2018–present) are available but not the default — current market conditions are best reflected in recent data. B-series runs from B8 onward use the 24-month window.

### Engine (`server/backtest/engine.js`)
- Primary mode: `runBacktestMTF(config, onProgress?)` — bar-by-bar replay using pre-derived TF files
- **Current-bar filter**: `if (setup.time !== detectTs) continue` — only fires setups triggered by the bar that just closed. Prevents stale entry prices from historical candles.
- **OR breakout dedup**: keyed `${symbol}-${date}-or_breakout-${direction}` — fires once per session per direction only.
- **maxDrawdown**: computed from trade-by-trade running sequence, not daily equity aggregates.
- `excludeHours` config param: array of ET hours (0–23) to skip at entry time.
- `TF_SECONDS` map: `{ '1m':60, '5m':300, '15m':900, '30m':1800, ... }`
- Force-close at 16:45 ET via `_forceCloseTs()` — iterates all bars, no early break.
- 1-trade-at-a-time per symbol enforced via `lastExitTs[symbol]`.
- **Breadth cache** (v13.2): `_precomputeBreadth()` checks `data/historical/breadth_cache.json` first; only computes missing dates; saves back to cache. First run cold, subsequent runs fast (O(dates) lookup).
- **TF pre-agg** (v13.2): `loadDailyBars()` checks `data/historical/futures_agg/{sym}/{tf}/{date}.json` before `futures/{sym}/{tf}/{date}.json`. Optional optimization — falls back gracefully.

### Worker execution (v13.2)
- `server/backtest/worker.js` — Worker thread entry point; runs `runBacktestMTF`, writes results to disk, sends `{ type: 'progress'|'complete'|'error' }` messages
- `server/index.js` `workerJobs` Map — tracks in-progress worker jobs (status, progress object, stats)
- `MAX_CONCURRENT_JOBS = 4` — POST /api/backtest/run returns HTTP 429 if exceeded
- `GET /api/backtest/status/:jobId` — returns `{ progress: { phase, pct, message } }` while running

### Precompute scripts
- `node scripts/precomputeBreadth.js [--force]` — populate `breadth_cache.json`; resumable; saves every 100 dates. Cache already populated: 4082 dates (2010–2026).
- `node scripts/precomputeTimeframes.js [--symbol SYM] [--force]` — aggregate 1m→5m/15m/30m into `futures_agg/`. Already run for all 16 symbols (134K files, clock-aligned windows).

### Diagnostic scripts
- `node scripts/auditInstruments.js` — candle store health check for all 8 tradeable futures. Reports bar count, price range, bad bars, spikes, staleness. PASS/WARN/FAIL per symbol.
- `node scripts/databentoDiag.js` — standalone Databento connection & data health check. Tests API auth (GLBX.MDP3 + OPRA.PILLAR schemas), queries server live feed status + OPRA subscribed symbols, fetches last 90min of 1m bars for all 16 CME symbols, prints grouped summary table (tradeable + reference). No server required.

### Backtest UI (`public/backtest2.html`, `backtest2.js`, `backtest2.css`)
- Config: date range, symbols, timeframes, setup types, min confidence, starting balance, HP toggle, max hold, fee/RT, contracts, trading hours filter
- **Trading Hours filter**: hourly checkboxes (ET) with session presets (All / RTH Only / None); saved to localStorage
- Summary tab: stat cards, equity curve, drawdown chart, daily P&L bars
- Trades tab: sortable/filterable table, CSV export
- Replay tab: 1m animated chart, full-run mode (`/api/backtest/replay/:jobId/full`)
- **Compare tab**: up to 6 runs side by side; overlaid equity curves (x = trade#); full breakdown table (config, overall stats, by setup type, by TF, by symbol, by direction, by confidence bucket); best value highlighted green; CSV export
- **Optimize tab** (v10.3): client-side analysis of loaded job's trades — no new API calls
  - Confidence sub-tab: threshold table (60–90%), optimal floor, PF/WR/avgR per floor, MTF impact
  - Regime sub-tab: direction split, HP proximity; regime/calendar fields not in trade records (v10.x)
  - Time of Day sub-tab: ET hour heatmap (9–18) per setup type using `trade.hour`
  - Notifications sub-tab: static tier design reference + dedup logic + staleness decay
  - State: `_bt2ActiveSubtab`, `_bt2OptSetupType`, `_bt2OptSymbol` (localStorage-persisted)
- **Progress bar**: `pollJob()` reads `status.progress.pct` + `.message`; `showProgress(show, label, pct)` drives `#bt2-progress-fill` width

### Backtest API Routes
- `POST /api/backtest/run` — spawns Worker, returns `{ jobId }` immediately (non-blocking, ~50ms)
- `GET /api/backtest/status/:jobId` — checks workerJobs first (progress object), falls back to disk
- `GET /api/backtest/jobs` — merges live workerJobs + disk jobs
- `GET /api/backtest/results/:jobId` — full results (trades + equity); 404 while running
- `DELETE /api/backtest/jobs/:jobId`
- `GET /api/backtest/replay/:jobId?symbol=X&date=YYYY-MM-DD`
- `GET /api/backtest/replay/:jobId/full?symbol=X` — all bars + alerts for full-run replay
- `GET /api/backtest/available` — available date ranges per symbol

## EdgeLog (port 3004)

Deferred until paper trading is stable and producing consistent results. MVP scope to be defined at that point. Audience: futures day traders and prop firm traders. Estimated pricing: $20–35/month.

---

**Next step when resuming:** integrate live Ironbeam/CQG WebSocket data feed (replace seed mode) per the data-source-agnostic interface in `server/data/snapshot.js`.
