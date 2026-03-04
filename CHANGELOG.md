# FuturesEdge AI — Changelog

All notable changes to this project are documented here, newest first.

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
