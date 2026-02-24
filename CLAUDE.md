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

### Setup Detection (three types)
1. **Liquidity Sweep + Reversal** — price sweeps swing H/L then closes back inside range with opposing body
2. **Supply/Demand Zone Rejection** — price enters zone, produces long wick + close outside zone
3. **Break of Structure / Change of Character (BOS/CHoCH)** — close beyond most recent significant swing H/L

---

## Setup Report JSON Schema (v1.0)

Every triggered setup writes this structure to `data/logs/`:

```json
{
  "symbol": "MNQ",
  "timestamp": "2026-02-22T14:32:00Z",
  "session": "RTH",
  "timeframes": {
    "15m_bias": "bullish",
    "5m_structure": "higher_lows",
    "1m_trigger_ready": true
  },
  "regime": {
    "type": "trend",
    "direction": "bullish",
    "strength": 78,
    "alignment": true
  },
  "key_levels": [
    {"name": "Prior Day High", "price": 18245.25},
    {"name": "VWAP", "price": 18210.75},
    {"name": "5m Swing Low", "price": 18192.50}
  ],
  "setups": [
    {
      "type": "liquidity_sweep_reversal",
      "entry_zone": [18205, 18212],
      "trigger": "1m bullish engulfing",
      "invalidation": 18192.50,
      "confidence": 72,
      "rationale": "Trend alignment with VWAP support"
    }
  ],
  "chart_observations": [
    "Clear ascending channel",
    "Demand zone visible near VWAP"
  ],
  "risk_notes": [
    "ATR expanding — expect volatility",
    "Near prior day high resistance"
  ]
}
```

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
| 4 | Claude AI commentary integration | ✅ Complete |
| 5 | Alert persistence, commentary persistence, multi-TF confluence scoring | ✅ Complete |
| 6 | UI polish, error handling, session awareness, CLAUDE.md refinement | 🔲 Not started |

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

**Phase 3 — Setup Detection & Alert Feed**
Goal: Classify market regime per timeframe; detect the three setup types (liquidity sweep, OB rejection, BOS/CHoCH); push alerts to the browser via WebSocket; populate the alert feed panel.

**Phase 2 completed:**
- `server/analysis/indicators.js` — EMA 9/21/50, VWAP (RTH session reset), ATR(14), Prior Day H/L, Swing H/L (configurable lookback); pure function, no I/O
- `server/index.js` — `GET /api/indicators?symbol=&timeframe=` computes and serves all indicator data
- `public/js/chart.js` — parallel candle + indicator fetch; EMA/VWAP line series; PDH/PDL price lines; swing H/L arrow markers; `window.ChartAPI.setLayerVisible()` for toggle integration
- `public/js/layers.js` — checkbox toggles wired to ChartAPI; state persists in localStorage
- `public/index.html` + `public/css/dashboard.css` — right panel split into Layers + Alert Feed sections

**Next action:** Build `server/analysis/regime.js` (trend/range, direction, strength), then `server/analysis/setups.js` (three setup types), then wire results to WebSocket broadcast and populate `public/js/alerts.js`.
