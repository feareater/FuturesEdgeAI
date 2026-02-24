# FuturesEdge AI — CLAUDE.md
> Project context for Claude Code. Read this at the start of every session.

---

## What This Project Is

FuturesEdge AI is a browser-based trading analysis dashboard for a single user (Jeff) — an active retail futures trader. It connects to live market data, detects high-probability trade setups in real time, and provides AI-generated commentary to support — not replace — manual trade decisions.

**It does NOT execute trades. Ever.**

---

## Instruments & Markets

- **MNQ** — Micro E-mini Nasdaq-100 Futures
- **MGC** — Micro Gold Futures
- Timeframes: 1m, 2m, 3m, 5m, 15m (all active simultaneously)

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
├── package.json
├── .env                       ← API keys — never commit this
├── .gitignore
├── server/
│   ├── index.js               ← Express server entry point
│   ├── auth/
│   │   └── tradovate.js       ← OAuth + session token management
│   ├── data/
│   │   ├── snapshot.js        ← OHLCV fetch + candle normalization (source-agnostic)
│   │   └── seedFetch.js       ← One-time script: fetches Yahoo Finance data → data/seed/
│   ├── analysis/
│   │   ├── indicators.js      ← EMA, VWAP, ATR, PDH/PDL, swings
│   │   ├── regime.js          ← Market regime classification
│   │   ├── trendlines.js      ← Significance-ranked trendline detection
│   │   ├── iof.js             ← FVG + Order Block detection
│   │   ├── setups.js          ← Setup detection (sweep, OB reject, BOS/CHoCH)
│   │   └── confluence.js      ← Multi-timeframe confluence scoring
│   ├── ai/
│   │   └── commentary.js      ← Claude API prompt builder + caller
│   └── storage/
│       └── log.js             ← JSON setup report writer
├── public/
│   ├── index.html             ← Dashboard entry point
│   ├── css/
│   │   └── dashboard.css
│   └── js/
│       ├── chart.js           ← TradingView Lightweight Charts renderer
│       ├── layers.js          ← Layer toggle control panel
│       └── alerts.js          ← Alert feed + commentary panel UI
├── data/
│   ├── seed/                  ← Generated OHLCV snapshots (run seedFetch.js to refresh)
│   │   ├── MNQ_1m.json  MNQ_2m.json  MNQ_3m.json  MNQ_5m.json  MNQ_15m.json
│   │   └── MGC_1m.json  MGC_2m.json  MGC_3m.json  MGC_5m.json  MGC_15m.json
│   └── logs/                  ← Setup report JSON files stored here
└── config/
    └── settings.json          ← User preferences + layer toggle states
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

| Type | Code | Role | Backtest (Feb 2026, 45 resolved) |
|---|---|---|---|
| Supply/Demand Zone Rejection | `zone_rejection` | Primary signal | 72.7% WR — dominant positive edge |
| PDH/PDL Breakout | `pdh_breakout` | Primary signal | 66.7% WR (regime-dependent) |
| BOS / CHoCH | `bos` / `choch` | Confidence qualifier only (+10–15 pts) | Not traded standalone |
| ~~Liquidity Sweep + Reversal~~ | ~~`liquidity_sweep_reversal`~~ | **Removed** | 43% WR, PF 0.68 — negative edge |

**Zone Rejection** — price enters a Supply/Demand zone, produces a significant wick, closes back outside with body in rejection direction. BOS/CHoCH within the scan window adds +10–15 confidence pts.

**PDH/PDL Breakout** — close beyond the prior-day high (bullish) or prior-day low (bearish) with momentum confirmation. RTH-gated (UTC 13:00–21:00).

### Signal Scoring — Backtest Findings (Feb 2026)

**Multi-TF Zone Stack (MNQ only)**
- MNQ + HTF IOF zone at same level: **77.8% WR, PF 3.15** — strong positive predictor
- MGC + HTF IOF zone: **37.5% WR, PF 0.39** — inverted predictor (contested level breaks rather than holds)
- Double-stack (5m AND 15m both confirming): **50% WR, PF 0.65** — worse than single-TF; overloaded levels tend to already be tested
- TF stack therefore: MNQ-only, capped at 1 confirming TF (+15 confidence pts max)
- Constants: `STACK_BONUS_PER_TF=15`, `STACK_MAX=15`, `PROX_ATR_MULT=0.5`

**Symbol-specific PDH R:R**
- MNQ → 2:1 (`PDH_RR = 2.0`)
- MGC → 1:1 (`PDH_RR = 1.0`)

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

---

## Coding Rules

- **JavaScript only** — no Python, no TypeScript (keep it simple for now)
- **No trade execution code** — ever, under any circumstances
- **All API keys via `.env`** — never hardcoded
- **Data layer is source-agnostic** — Tradovate and Ironbeam/CQG share the same normalized OHLCV interface so switching data sources is a config change only
- **Indicators computed in code** — AI never invents or estimates price levels
- **One file per concern** — keep modules focused and small
- **Console.log liberally during dev** — we want visibility into what the engine is doing

---

## Current Phase

**All 6 phases complete. Project is production-ready for seed-mode use.**

**Phase 6 delivered:**
- `public/index.html` — session badge (`RTH` / `Pre-market` / `After-hours`) + WebSocket status dot in topbar; R:R save feedback span
- `public/css/dashboard.css` — session badge styles (green/amber/dim), WS dot (green/red/amber), contextual empty-state and error placeholder styles
- `public/js/alerts.js` — session badge computed from UTC hour, updated every 60s; WebSocket reconnect with exponential backoff (1s → 2s → 4s … cap 30s) + jitter; alert fetch error shows "Retry" link; empty state provides context (minConf hint vs. initial scan); AI 503 rate-limit distinguished from generic error; R:R POST shows "Saved ✓" / "Error" for 2s
- `CLAUDE.md` — phase table, signal scoring findings, alert schema v2.0

**Next step when resuming:** integrate live Ironbeam/CQG WebSocket data feed (replace seed mode) per the data-source-agnostic interface in `server/data/snapshot.js`.
