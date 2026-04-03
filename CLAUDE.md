# FuturesEdge AI — CLAUDE.md
> Project context for Claude Code. Read this at the start of every session.

---

## What This Project Is

FuturesEdge AI is a browser-based trading analysis dashboard for a single user (Jeff) — an active retail futures trader. It connects to live market data, detects high-probability trade setups in real time, and provides AI-generated commentary to support — not replace — manual trade decisions.

**It executes paper/demo trades only — via Tradovate Demo API (`demo.tradovateapi.com`). It must NEVER place orders against a live/production brokerage endpoint.**

---

## Instruments & Markets

- **MNQ** — Micro E-mini Nasdaq-100 Futures
- **MGC** — Micro Gold Futures
- **MES** — Micro E-mini S&P 500 Futures
- **MCL** — Micro Crude Oil Futures
- Active scan timeframes: **5m, 15m, 30m** (1m/2m/3m removed — stale with 15-min delayed seed data)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Backend framework | Express.js |
| Market data (Phase 1) | Yahoo Finance seed data — `data/seed/*.json` (run `node server/data/seedFetch.js` to refresh) |
| Market data (Phase 3+) | Ironbeam REST + WebSocket (Optimusfutures account — needs API access enabled) |
| Charting | TradingView Lightweight Charts |
| Technical indicators | `technicalindicators` npm library |
| AI commentary | Anthropic Claude API (claude-sonnet-4-6) |
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
│   │   ├── snapshot.js        ← OHLCV fetch + candle normalization (source-agnostic)
│   │   ├── seedFetch.js       ← Yahoo Finance seed data fetch (MNQ/MGC/MES/MCL)
│   │   └── calendar.js        ← ForexFactory economic calendar (1h cache)
│   ├── analysis/
│   │   ├── indicators.js      ← EMA, VWAP, ATR, PDH/PDL, swings, VP, OR, sessions
│   │   ├── regime.js          ← Market regime classification
│   │   ├── trendlines.js      ← Significance-ranked trendline detection
│   │   ├── iof.js             ← FVG + Order Block detection
│   │   ├── setups.js          ← zone_rejection, pdh_breakout, trendline_break, or_breakout
│   │   ├── confluence.js      ← Multi-TF zone stack scoring
│   │   ├── volumeProfile.js   ← Session POC/VAH/VAL (70% value area)
│   │   ├── openingRange.js    ← RTH Opening Range (09:30–10:00 ET)
│   │   ├── sessionLevels.js   ← Asian + London session H/L
│   │   ├── relativeStrength.js← MNQ vs MES normalized ratio + Pearson correlation
│   │   ├── correlation.js     ← 4×4 pairwise rolling correlation matrix
│   │   └── performanceStats.js← WR/PF/avgR by symbol, setup, TF, hour, direction
│   ├── ai/
│   │   └── commentary.js      ← Claude API prompt builder + caller
│   ├── trading/
│   │   ├── autotrader.js      ← Kill-switch state machine for paper trading
│   │   └── simulator.js       ← Virtual position tracker (SL/TP fill simulation)
│   └── storage/
│       └── log.js             ← Alert, commentary, and trade log persistence
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
│   │   ├── chart.js           ← TradingView chart renderer + all indicator overlays
│   │   ├── layers.js          ← Layer toggles + feature toggle panel
│   │   ├── alerts.js          ← Alert feed, WS, RS widget, calendar badge, sound alerts
│   │   ├── performance.js     ← Performance analytics renderer
│   │   └── backtest.js        ← Alert replay logic + P&L tracker
│   ├── manifest.json          ← PWA manifest
│   └── sw.js                  ← Service worker (cache-first shell, network-only /api/)
├── data/
│   ├── seed/                  ← OHLCV snapshots (MNQ/MGC/MES/MCL × 5m/15m/30m)
│   └── logs/                  ← alerts.json, commentary.json, trades.json
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
    "commentary": "This bullish zone rejection at 21390..."
  }
}
```

`setup.time` is Unix seconds. `commentary` is present once AI has generated it (persisted to avoid re-calling the API).

---

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
| `POST /api/settings/span` | Update SPAN margin values (body: `{ MNQ: 1400, ... }`) |

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
| `pushNotifications` | **false** | Reserved — not yet implemented |

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

### Active Setup Types

| Type | Code | Notes |
|---|---|---|
| Zone Rejection | `zone_rejection` | Primary — regime-gated |
| PDH/PDL Breakout | `pdh_breakout` | RTH-gated (13:00–21:00 UTC) |
| Trendline Break | `trendline_break` | ≥3 touches required |
| OR Breakout | `or_breakout` | After 14:00 UTC, RTH only, first-close |

## Backtest System (v10.x) — Key Facts

### Engine (`server/backtest/engine.js`)
- Primary mode: `runBacktestMTF()` — bar-by-bar replay using pre-derived TF files
- **Current-bar filter**: `if (setup.time !== detectTs) continue` — only fires setups triggered by the bar that just closed. Prevents stale entry prices from historical candles.
- **OR breakout dedup**: keyed `${symbol}-${date}-or_breakout-${direction}` — fires once per session per direction only.
- **maxDrawdown**: computed from trade-by-trade running sequence, not daily equity aggregates.
- `excludeHours` config param: array of ET hours (0–23) to skip at entry time.
- `TF_SECONDS` map: `{ '1m':60, '5m':300, '15m':900, '30m':1800, ... }`
- Force-close at 16:45 ET via `_forceCloseTs()` — iterates all bars, no early break.
- 1-trade-at-a-time per symbol enforced via `lastExitTs[symbol]`.

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

### Backtest API Routes
- `POST /api/backtest/run` — launch async job
- `GET /api/backtest/status/:jobId`
- `GET /api/backtest/jobs` — list all jobs (includes `stats` for each)
- `GET /api/backtest/jobs/:jobId/results` — full results (trades + equity)
- `DELETE /api/backtest/jobs/:jobId`
- `GET /api/backtest/replay/:jobId?symbol=X&date=YYYY-MM-DD`
- `GET /api/backtest/replay/:jobId/full?symbol=X` — all bars + alerts for full-run replay
- `GET /api/backtest/available` — available date ranges per symbol

**Next step when resuming:** integrate live Ironbeam/CQG WebSocket data feed (replace seed mode) per the data-source-agnostic interface in `server/data/snapshot.js`.
