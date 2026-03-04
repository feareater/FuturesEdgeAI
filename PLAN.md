# FuturesEdge AI — Plans

Active and completed implementation plans. Newest first.

---

## [v3.0] COMPLETED — Full Feature Expansion (Three Tiers)

**Status:** ✅ Complete as of 2026-03-04 · Guide updated 2026-03-04

### Context
All 6 original phases complete. System scans MNQ, MGC, MES, MCL across 5m/15m/30m, detects three setup types (zone_rejection, pdh_breakout, trendline_break), scores confidence, generates AI commentary, and persists everything. This plan added three tiers of enhancements — all modular, individually toggleable at runtime without restarting the server.

---

### Modularity Architecture

**Single source of truth:** `config/settings.json` `features` block

```json
{
  "features": {
    "volumeProfile":      true,
    "openingRange":       true,
    "performanceStats":   true,
    "economicCalendar":   true,
    "relativeStrength":   true,
    "sessionLevels":      true,
    "alertReplay":        true,
    "correlationHeatmap": true,
    "soundAlerts":        false,
    "pushNotifications":  false
  }
}
```

**Feature toggle API:** `POST /api/features` with body `{ "openingRange": false }` — persists to settings.json, hot-reloads in-memory, no restart needed.

**Server gating pattern:**
```javascript
if (settings.features?.openingRange) {
  result.openingRange = computeOpeningRange(candles, symbol);
}
```

**Client gating pattern:**
```javascript
if (cfg.features?.openingRange && d.openingRange) {
  _drawOpeningRange(d.openingRange);
}
```

---

### Files Created

| File | Purpose |
|---|---|
| `server/analysis/volumeProfile.js` | Session volume profile — POC, VAH, VAL (70% value area) |
| `server/analysis/openingRange.js` | OR high/low/midpoint + formed flag |
| `server/analysis/sessionLevels.js` | Asian (00:00–07:00 UTC) + London (07:00–13:30 UTC) H/L |
| `server/analysis/relativeStrength.js` | MNQ vs MES normalized ratio + 20-period correlation |
| `server/analysis/correlation.js` | 4×4 pairwise rolling correlation matrix |
| `server/analysis/performanceStats.js` | WR/PF/avgR by symbol × setup × TF × hour |
| `server/data/calendar.js` | ForexFactory calendar feed fetch + 1h in-memory cache |
| `public/performance.html` | Performance analytics page |
| `public/js/performance.js` | Stats rendering + ToD heat map |
| `public/css/performance.css` | Performance page styles |
| `public/backtest.html` | Alert replay / timeline backtester page |
| `public/js/backtest.js` | Replay logic, step-through, hypothetical P&L equity curve |
| `public/css/backtest.css` | Backtest page styles |

### Files Modified

| File | Changes |
|---|---|
| `server/analysis/indicators.js` | Feature-gated calls to VP, OR, session levels, RS, correlation |
| `server/analysis/setups.js` | Added `or_breakout` type; calendar event gating (−20 conf, `nearEvent` flag) |
| `server/index.js` | Routes: `/api/features`, `/api/calendar`, `/api/correlation`, `/api/relativestrength`, `/api/performance`; `/api/alerts` date filters; scan engine wired to feature flags |
| `config/settings.json` | Added `features` block; added MES/MCL to risk contracts |
| `public/index.html` | New layer rows (VP, OR, sessionLevels, corrHeatmap); RS widget in topbar; calendar badge; correlation panel; nav links to Stats/Replay |
| `public/js/chart.js` | Draw functions for VP lines, OR lines, session lines; `_applyVis()` extended; OR alert marker |
| `public/js/layers.js` | New DEFAULTS + feature toggle panel with `POST /api/features` calls |
| `public/js/alerts.js` | MES/MCL tick values; calendar badge; RS widget; correlation heatmap; sound alerts; nearEvent badge; `or_breakout` label |
| `public/css/dashboard.css` | Styles for RS widget, feature section, calendar badge, correlation grid, near-event badge |
| `public/sw.js` | Cache bumped to `futuresedge-v2`; new pages added to SHELL_ASSETS |
| `public/docs.html` | Guide updated: OR Breakout section (Alert Type 4), Chart Layers section, Features section, MES/MCL R:R, 4-instrument intro |

---

### Tier 1 — Volume Profile / POC ✅

`server/analysis/volumeProfile.js` — Per-session (RTH 13:30–20:00 UTC) volume-at-price histogram.

- Bucket granularity = 5× tick size (MNQ/MES: 1.25, MGC: 0.50, MCL: 0.05)
- Returns: `{ poc, vah, val, prevPoc, prevVah, prevVal }`
- Chart: POC (white dashed), VAH (green dashed), VAL (red dashed), pPOC (dim dotted)
- Layer key: `volumeProfile`

---

### Tier 1 — Opening Range + OR Breakout Setup ✅

`server/analysis/openingRange.js` — RTH open candles 09:30–10:00 ET (13:30–14:00 UTC).

- Returns: `{ high, low, mid, orTime, formed }`
- **Setup type `or_breakout`:** fires only after OR window closes, RTH-gated (10:00–15:30 ET), first-close-only
- Confidence: base 35, +15 regime align, +up to 20 break magnitude (vs ATR), +IOF bonus
- SL = opposite OR bound, TP = risk × 2
- Chart: OR Hi/Lo (orange solid), OR Mid (orange dashed). Layer key: `openingRange`

---

### Tier 1 — Performance Analytics ✅

`server/analysis/performanceStats.js` + `/api/performance` + `/performance.html`

- Stats: overall WR/PF/avgR; breakdowns by symbol, setup type, timeframe, UTC hour, direction
- Page: summary stat cards, CSS bar charts, ToD heat map (RTH hours), sortable alert table

---

### Tier 2 — Economic Calendar ✅

`server/data/calendar.js` + `/api/calendar`

- Feed: `https://nfs.faireconomy.media/ff_calendar_thisweek.json`, 1h cache, graceful fallback
- Symbol mapping: MNQ/MES ← US macro; MGC ← USD/rates; MCL ← EIA/petroleum
- Setup gating: high-impact event within 15 min → −20 confidence (floor 0), `nearEvent: true`
- UI: topbar badge "⚠ CPI in 47m" when event within 3h; amber card badge when `nearEvent`

---

### Tier 2 — Relative Strength (MNQ vs MES) ✅

`server/analysis/relativeStrength.js` + `/api/relativestrength`

- Session-normalized ratio + rolling 20-period Pearson correlation
- Signals: `mnq_leading` (ratio > 1.02), `mes_leading` (ratio < 0.98), `neutral`
- UI: topbar widget visible only for MNQ/MES, color-coded ratio + correlation

---

### Tier 2 — Session Levels (Asian + London) ✅

`server/analysis/sessionLevels.js`

- Asian: 00:00–07:00 UTC; London: 07:00–13:30 UTC
- Returns: `{ asian: {high,low,mid}, london: {high,low,mid}, prevAsian: {high,low} }`
- Chart: amber dashed (Asian), purple dashed (London). Layer key: `sessionLevels`

---

### Tier 2 — Correlation Heatmap ✅

`server/analysis/correlation.js` + `/api/correlation`

- 4×4 rolling pairwise log-return Pearson correlation (5m candles)
- UI: CSS grid in right sidebar; red (−1) → gray (0) → green (+1)
- Layer key: `correlationHeatmap`. Refreshes on `data_refresh` WS event

---

### Tier 3 — Alert Replay / Backtester ✅

`public/backtest.html` + `public/js/backtest.js`

- Filters: date range, symbol, setup type, confidence, contract size
- Step-through mode: Prev/Next buttons + "View on Chart" via sessionStorage
- Equity curve: CSS-only cumulative P&L bars
- Point values: MNQ $2, MES $5, MGC $10, MCL $100

---

### Creative Additions ✅

- **Sound alerts:** Web Audio API two-tone oscillator (bullish 440→550Hz, bearish 550→440Hz). Off by default.
- **Push notifications:** `pushNotifications` feature flag in settings; not wired (off by default, placeholder for future).
- **Calendar countdown:** topbar badge, updates every 60s.

---

## [v4.0] COMPLETED — Trading Intelligence Upgrade

**Status:** ✅ Complete as of 2026-03-04

### Context
System scans 4 instruments (MNQ, MGC, MES, MCL) with full feature set from v3.0. Six concrete improvements targeting usability as a real day-trading tool: permanent setup archive, manual outcome marking, manual trade logging, OB/FVG quality scoring, enhanced AI commentary with zone context, and chart visual differentiation by zone strength.

---

### Feature 1: Historical Setup Archive ✅

**Problem:** `alertCache` holds max 100 items; setups evicted and lost from performance analysis.

**Solution:** Append-only `data/logs/setup_archive.json` — every setup snapshot written on first detection, never evicted. Re-evaluations sync resolved outcomes back via `updateArchiveOutcome()`.

**Files:**
- `server/storage/log.js` — `loadArchive()`, `appendToArchive()` (dedup by key), `updateArchiveOutcome()`
- `server/index.js` — `_cacheAlert()` calls `appendToArchive()` on new alerts; re-eval loop calls `updateArchiveOutcome()` when outcome changes from open
- `GET /api/archive?symbol=&start=&end=&limit=` — query historical setups, newest-first, max 2000

---

### Feature 2: Manual Outcome Marking (Won/Lost buttons) ✅

**Problem:** User knows immediately when a trade won or lost, but the UI had no way to record it.

**Solution:** `PATCH /api/alerts/:key` endpoint; sets `userOverride: true` so server re-evaluation never overwrites. Alert cards show ✓ Won / ✗ Lost action buttons for taken+open alerts; card gets green/red background tint after marking.

**Files:**
- `server/index.js` — `PATCH /api/alerts/:key`; re-eval loop skips `userOverride: true` entries
- `public/js/alerts.js` — `_setOutcome()`, Won/Lost buttons in `_buildCard()`, outcome header badge
- `public/css/dashboard.css` — `.outcome-won` green tint, `.outcome-lost` red tint, `.outcome-header-badge`

---

### Feature 3: Manual Trade Logging ✅

**Problem:** No way to log trades taken outside of AI-detected setups.

**Solution:** `alertKey` made optional in `POST /api/trades`; manual trades get synthetic key `MANUAL:symbol:timestamp`. Inline form accessible via "＋ Trade" button in alert panel header. Manual trades appear in a separate "Manual Trades" section with a `MANUAL` badge.

**Files:**
- `server/index.js` — `POST /api/trades` updated; `isManual`, `direction`, `manualSetupType` fields
- `public/index.html` — `#log-trade-btn`, `#manual-trade-form`
- `public/js/alerts.js` — `_openManualForm()`, `_renderManualTrades()`
- `public/css/dashboard.css` — form styles, `.manual-badge`

---

### Feature 4: OB/FVG Quality Scoring ✅

**Problem:** No way to distinguish strong institutional zones from noise; tested OBs were hidden entirely; weak zones cluttered the chart.

**Solution:** ATR-ratio scoring assigns `strength: 'strong'|'normal'|'weak'` to each zone. Weak FVGs and weak+tested OBs filtered server-side. Tested (but held) OBs shown with distinct dashed/dim visual.

**Thresholds:**
- FVG: strong `atrRatio >= 0.8`, normal `>= 0.35`, weak `< 0.35`
- OB: strong `atrRatio >= 1.2`, normal `>= 0.5`, weak `< 0.5`

**Files:**
- `server/analysis/iof.js` — `detectFVGs(candles, atrCurrent)` + OB detection both gain `atrRatio` and `strength`
- `server/analysis/indicators.js` — passes `atrCurrent` to `detectFVGs()`
- `server/index.js` — filters: weak FVGs excluded; weak+tested OBs excluded
- `public/js/chart.js` — strength-based opacity, line width, labels (`OB↑★`, `OB↑~`, `FVG↑★`)

---

### Feature 5: Enhanced AI Commentary ✅

**Problem:** Claude only received 5 candles + regime; missed active FVG/OB zones near entry, session levels, VP, historical WR — producing generic commentary.

**Solution:** `extrasMap` (keyed by `symbol:tf`) passed to all commentary functions. `_zoneContext()` helper formats nearby zones into a readable block. Claude specifically asked to reference FVG/OB prices and zone-based invalidation.

**Token budgets:** single 400 → 700; batch 1200 → 2000.

**Files:**
- `server/ai/commentary.js` — `_zoneContext()`, `_buildPrompt(alerts, getCandles, extrasMap)`, `generateCommentary(extrasMap)`, `generateSingle(extrasMap)`
- `server/index.js` — `_refreshCommentary()` builds and passes `extrasMap`; single commentary route also passes context

---

### Files Created

| File | Purpose |
|---|---|
| `data/logs/setup_archive.json` | Append-only archive — every setup snapshot ever fired |

### Files Modified

| File | Changes |
|---|---|
| `server/analysis/iof.js` | `atrRatio` + `strength` on FVGs and OBs |
| `server/analysis/indicators.js` | Pass `atrCurrent` to `detectFVGs()` |
| `server/storage/log.js` | Archive read/write functions |
| `server/ai/commentary.js` | Zone context, extrasMap, larger token budget |
| `server/index.js` | Archive wiring, PATCH + GET /api/archive, manual trades, OB/FVG filters, extrasMap build |
| `public/js/chart.js` | Strength-based zone rendering |
| `public/js/alerts.js` | Won/Lost buttons, outcome badge, manual form + trades |
| `public/css/dashboard.css` | Outcome card tints, outcome badge, log-trade btn, manual form |
| `public/index.html` | Log-trade button, manual-trade-form div |
| `CHANGELOG.md` | v3.3 + v4.0 entries |

---

## Future Plans

_Next plan goes here._

---
