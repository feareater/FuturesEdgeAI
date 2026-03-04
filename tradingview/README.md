# FuturesEdge AI — TradingView Scripts

Three progressive Pine Script v5 indicators that mirror the FuturesEdge AI dashboard directly on your TradingView chart.

---

## Files

| File | What it does |
|---|---|
| `FuturesEdge_Phase1_Overlay.pine` | All chart overlays — EMA, VWAP, PDH/PDL, Swing H/L, Trendlines, IOF zones |
| `FuturesEdge_Phase2_Alerts.pine` | Phase 1 + setup detection (Zone Rejection, PDH/PDL Breakout, TL Break, BOS) + `alertcondition()` |
| `FuturesEdge_Phase3_AI.pine` | Phase 2 + JSON webhook payloads that feed the FuturesEdge AI commentary engine |

Start with Phase 1 to verify the overlays look right, then switch to Phase 2 or 3 when ready for alerts.

---

## Phase 1 — Installation

1. Open TradingView → Pine Script Editor (bottom panel)
2. Paste the contents of `FuturesEdge_Phase1_Overlay.pine`
3. Click **Add to chart**
4. Works on any timeframe — recommended: 5m, 15m, 30m for futures

### What you'll see

| Layer | Description |
|---|---|
| **EMA 9** (blue) | Fast trend |
| **EMA 21** (orange) | Mid trend |
| **EMA 50** (purple, thick) | Slow trend / institutional |
| **EMA 9/21 fill** | Green when bullish stack, red when bearish |
| **VWAP** (cyan) | Session reset VWAP; ±1σ and ±2σ bands |
| **PDH / PDL** (gray dashed) | Prior day high and low — labeled at day open |
| **Swing H/L** (triangles) | Confirmed pivot highs/lows with price labels |
| **Auto Trendlines** | Resistance (red dashed) connecting last 2 swing highs; Support (green dashed) connecting last 2 swing lows |
| **Bullish FVG** (green box) | 3-candle bullish fair value gap; dims when price enters |
| **Bearish FVG** (red box) | 3-candle bearish fair value gap; dims when price enters |
| **Bullish OB** (blue box) | Last bearish candle before bullish impulse; dims when mitigated |
| **Bearish OB** (red box) | Last bullish candle before bearish impulse; dims when mitigated |
| **Regime tint** | Subtle green/red background when EMA stack is fully aligned |
| **RTH highlight** | Subtle blue tint during regular trading hours (09:30–16:00 ET) |
| **Info table** | Top-right: regime, EMA values, VWAP position, ATR |

---

## Phase 2 — Alerts

Adds setup detection and TradingView native alerts.

### Setup wiring

After adding to chart, create alerts via **Alt+A** (or right-click chart → Add alert):

| Alert condition | Setup type |
|---|---|
| `FE · Bullish Zone Rejection` | Bullish wick rejection off OB or FVG |
| `FE · Bearish Zone Rejection` | Bearish wick rejection off OB or FVG |
| `FE · PDH Breakout` | Close above prior day high |
| `FE · PDL Breakout` | Close below prior day low |
| `FE · Bullish TL Break` | Close above resistance trendline |
| `FE · Bearish TL Break` | Close below support trendline |
| `FE · Break of Structure` | Close above/below last confirmed swing high/low |
| `FE · HIGH CONFIDENCE SETUP (≥80%)` | Any setup with confidence ≥ 80% |

### Confidence scoring

Each setup produces a 0–100 confidence score. The scoring mirrors the FuturesEdge server engine:

| Component | Points |
|---|---|
| Base score (by setup type) | 40–45 |
| EMA regime aligned | +15 |
| 15m EMA also aligned | +15 |
| OB (vs FVG) present | +5 |
| Wick quality ratio | +5 to +10 |
| VWAP position matches | +5 to +10 |
| **Cap** | **100** |

### Settings

Open indicator settings → **Alert Settings** group:

- **Min Confidence (%)** — Only signal setups above this threshold (default 65%)
- **Min wick ratio** — Minimum wick/total-range ratio for zone rejection (default 0.35)
- **Signal labels** — Toggle on-chart label annotations
- **Recent signals panel** — Bottom-right table showing last 5 signals

---

## Phase 3 — AI Commentary Webhook

Extends Phase 2 with structured JSON payloads that the FuturesEdge server can receive and pass to Claude for AI commentary.

### TradingView webhook setup

1. In TradingView, create an alert using one of the **`FE · Webhook: ...`** alert conditions
2. Under **Notifications**, enable **Webhook URL**
3. Set URL to: `http://<your-server-ip>:3000/api/tv-webhook`
4. The alert message is automatically set to the JSON payload — leave it as-is

### Server-side route (add to `server/index.js`)

The webhook endpoint needs to be added to the FuturesEdge server. Add this route:

```javascript
// POST /api/tv-webhook  — receive TradingView alert JSON → Claude commentary
app.post('/api/tv-webhook', express.json(), async (req, res) => {
  const body = req.body;
  // Expected fields: source, sym, tf, ts, setup, dir, conf, price, sl, tp,
  //                  atr, regime, htf15, vwap, vwapVal, ema9, ema21, ema50, pdh, pdl, sess

  if (!body.setup || !body.sym) {
    return res.status(400).json({ error: 'missing required fields' });
  }

  console.log('[tv-webhook] Received:', body.setup, body.dir, body.sym, body.tf, body.conf + '%');

  // Build a synthetic alert object compatible with the commentary system
  const alert = {
    symbol:    body.sym.replace(/\d+!?$/, '').replace('CME_MINI:', '').replace('COMEX:', ''),
    timeframe: body.tf + 'm',
    ts:        new Date().toISOString(),
    source:    'tradingview',
    regime: {
      type:      body.regime !== 'neutral' ? 'trend' : 'range',
      direction: body.regime,
      strength:  body.conf,
      alignment: body.htf15 === body.regime,
    },
    setup: {
      type:       body.setup,
      direction:  body.dir,
      time:       Math.floor(Date.now() / 1000),
      price:      parseFloat(body.price),
      entry:      parseFloat(body.price),
      sl:         parseFloat(body.sl),
      tp:         parseFloat(body.tp),
      confidence: parseInt(body.conf),
      rationale:  body.setup.replace(/_/g, ' ') + ' — TradingView signal',
    },
  };

  // Generate Claude commentary (reuse existing system)
  try {
    const { generateCommentary } = require('./ai/commentary');
    const commentary = await generateCommentary(alert);
    alert.setup.commentary = commentary;
  } catch (err) {
    console.warn('[tv-webhook] Commentary failed:', err.message);
  }

  // Broadcast to dashboard WebSocket
  broadcast({ type: 'tv_alert', ...alert });
  res.json({ ok: true, received: body.setup });
});
```

### Webhook payload format

Each alert fires a JSON POST body like this:

```json
{
  "source":   "tradingview",
  "sym":      "MNQ1!",
  "tf":       "5",
  "ts":       "2026-02-25T14:32:00Z",
  "setup":    "zone_rejection",
  "dir":      "bullish",
  "conf":     82,
  "price":    21405.25,
  "sl":       21388.50,
  "tp":       21438.00,
  "atr":      16.75,
  "regime":   "bullish",
  "htf15":    "bullish",
  "vwap":     "above",
  "vwapVal":  21390.00,
  "ema9":     21410.00,
  "ema21":    21395.00,
  "ema50":    21380.00,
  "pdh":      21450.00,
  "pdl":      21200.00,
  "sess":     "rth"
}
```

---

## Tips

- **Use Phase 2 or 3** as your single indicator — they include all Phase 1 overlays
- **Timeframe**: These scripts are designed for 5m, 15m, 30m. The 15m EMA alignment check always uses the 15m timeframe regardless of your chart's TF
- **Symbol format**: Works with any ticker including `CME_MINI:MNQ1!`, `COMEX:MGC1!`, crypto, equity — the engine auto-adapts
- **Too many boxes?** Reduce `OB extend (bars)` and `FVG extend (bars)` in settings
- **Alert spam**: Raise `Min Confidence (%)` to 75–80 to filter only high-quality setups
- **Regime background too bright**: In Display settings, disable `EMA Regime Background`

---

## Differences from the Node.js Engine

| Feature | TradingView script | FuturesEdge server |
|---|---|---|
| Trendline scoring | Connects last 2 swing points | Significance-ranked by reaction magnitude |
| Zone rejection | ATR-estimated SL/TP | Precise ATR-based calculation |
| Multi-TF scan | Chart TF + 15m only | 5m, 15m, 30m simultaneously |
| Data latency | Real-time | 15-min delayed (seed mode) |
| AI commentary | Via webhook to server | Direct on every alert |
| Paper trading | Not applicable | Built-in simulator |
