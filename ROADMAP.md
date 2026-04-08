# FuturesEdge AI — Master Roadmap

> Single source of truth for project status and planned work.
> Read alongside CLAUDE.md and AI_ROADMAP.md.
> Updated after every completed phase or significant decision.

**Current version:** v14.10
**Last updated:** 2026-04-07

---

## Project Status Summary

FuturesEdge AI is a browser-based futures trading analysis dashboard that detects high-probability trade setups (or_breakout, pdh_breakout) in real time across 12 instruments (8 CME futures + 4 crypto perpetuals). The system consumes live 1-second and 1-minute market data from Databento via TCP, computes indicators and confidence scores deterministically, and presents alerts with full score breakdowns. A comprehensive backtest engine with 8 years of historical data (2018–2026) validates all configuration changes before they reach production. B8 backtest passed (WR 41.8%, PF 2.229) on 2026-04-06 — paper trading is now ACTIVE on MNQ, MES, MCL. AI analysis uses Claude API (claude-sonnet-4-6) for batch trade analysis; alert commentary is active with rate limiting.

---

## Completed

### Infrastructure & Data Pipeline
- Node.js/Express server with WebSocket push, PWA service worker, TradingView Lightweight Charts frontend
- Yahoo Finance seed data pipeline (MNQ/MES/MGC/MCL/SIL)
- Coinbase INTX REST + WebSocket for crypto perpetuals (BTC/ETH/XRP/XLM)
- Databento historical pipeline: 16 CME symbols, 13-year scale (2018–2026), streaming zip extraction, per-symbol directory layout
- Databento TCP live feed: CRAM auth, ohlcv-1s ticks + ohlcv-1m bars, spike filtering (>2% rejection), bar validation (5-rule sanity check), defensive copies in getCandles()
- All 8 CME symbols on live feed: MNQ, MES, MGC, MCL, SIL, M2K, MYM, MHG
- Correct tick/point values and per-symbol fee schedule for all 8 CME symbols; instruments.js as single source of truth; /api/instruments GET+POST; settings UI in backtest2.html (v14.8)
- OPRA pipeline: ETF daily closes (XNYS.PILLAR), strike/OI parsing, HP computation (~1736 dates/ETF)
- Databento OPRA live TCP feed for real-time HP/GEX/DEX/resilience (dual-source with CBOE fallback)
- DX futures pipeline (dxy.json, 2251 dates) + realized volatility proxy (vix.json, 1767 dates)
- Market breadth system: 16-instrument cross-market regime scoring (equityBreadth, bondRegime, copperRegime, dollarRegime, riskAppetite)
- Breadth cache (4082 dates pre-computed) + TF pre-aggregation (134K files, all 16 symbols)

### Analysis Engine
- Indicators: EMA 9/21/50, VWAP, ATR(14), PDH/PDL, swing H/L, volume profile, opening range, session levels
- Market regime classification (trend/range, direction, strength, alignment)
- Significance-ranked trendlines (magnitude-scored, >=3 touches for trendline_break)
- Institutional Order Flow: FVG + Order Block detection, confluence flagging
- CBOE options integration: OI walls, max pain, GEX/DEX, resilience scoring, liquidity/hedge/pivot zones
- DD Band / CME SPAN margin system: 5 confidence levels (-20 to +8 pts), chart layer, topbar widget
- Correlation heatmap (11 instruments), relative strength (MNQ/MES ratio + Pearson)
- Multi-TF confluence scoring (MNQ-only, capped at +15 pts)
- CVD (Cumulative Volume Delta): estimated from OHLCV candles client-side, resets at RTH open (futures) or midnight UTC (crypto), displayed as histogram + cumulative line in sub-chart panel below main chart
- HVN/LVN classification: volume node tagging on VP histogram — HVN (≥1.5× mean vol) as magnetic levels, LVN (≤0.4× mean, within value area) as thin zones; rendered as dotted lines under VP layer toggle

### Setup Detection & Confidence Scoring
- Active setups: `or_breakout` (5m only), `pdh_breakout` (RTH-gated)
- Disabled: `zone_rejection` (R:R structurally inverted), `liquidity_sweep_reversal` (negative edge)
- Confidence scoring: base score + regime + alignment + IOF + TF stack + breadth (±15 cap) + DD band (-20 to +8) + loss gates (-35 max)
- Phase 2 loss-analysis gates: Rising DXY + OR breakout (-20 pts), Risk-off + breadth collapse (-15 pts)
- Symbol-specific PDH R:R ratios (MNQ 2:1, MES 2:1, MGC 1:1, MCL 1.5:1)
- Alert dedup: 15-min cooldown + ±0.25x ATR proximity, staleness decay (fresh/aging/stale)

### Backtest Engine
- Bar-by-bar replay engine (`runBacktestMTF`), no lookahead, current-bar filter
- Worker thread execution (MAX_CONCURRENT_JOBS=4), non-blocking
- Trade records include: VIX regime, DXY direction, HP proximity, resilience, DEX bias, DD band, breadth fields
- UI: 6 tabs (Summary / Trades / Replay / Compare / Optimize / AI Analysis)
- Compare tab: up to 6 runs side-by-side with overlaid equity curves
- Optimize tab: Confidence / Regime / Time of Day / DD Band / Notifications sub-tabs
- Trading hours filter with ET hourly checkboxes and session presets

### A5 Baseline Results (full-period 2018–2026)
- v12.7: 9,679 trades, WR 37.3%, PF 1.69, Net +$233,540, MaxDD $3,208
- v12.9 (breadth active): 9,286 trades, WR 33.9%, PF 1.584, Net +$238,040, MaxDD $2,908
- **v14.10 corrected** (correct fees + pointValues): 7,401 trades, WR 34.2%, PF 1.689, Net +$640,904, MaxDD $13,533
- or_breakout: Net +$638K, PF ~1.69 — primary edge carrier
- pdh_breakout: Net +$3K — marginal, not harmful
- MNQ leads ($363K), followed by MGC ($164K), MES ($68K), MCL ($46K)

> All backtest results prior to v14.8 used incorrect fee formula and wrong pointValues for SIL/MHG. Results cleared and re-run on 2026-04-07. Analytical conclusions (WR/PF based) remain valid. Dollar figures updated.

### Forward-Test Infrastructure
- B5 harness: checkLiveOutcomes in simulator.js, alertDedup.js, pushManager.js (VAPID web-push)
- Alert feed AGING/STALE badges, service worker push handler

### Dashboard & UI
- Futures/Crypto mode toggle with separate correlation heatmaps
- Multi-symbol chart grid (7 simultaneous mini charts, per-symbol TF, live prices)
- 1m/5m/15m/30m/1h/2h/4h chart timeframes
- Stats page: 4-tab redesign (Overview / Trade Log / Prop Firms / Real Account)
- Pine Script v6 export with baked-in QQQ options levels + DD Band lines
- Layer toggle panel (14 individual overlays)
- Dedicated forward-test page (forwardtest.html): 4 tabs (Summary/Trade Log/Breakdown/AI Export), global filter bar, auto-refresh (v14.9)
- AI export prompt generator for both forward-test and backtest analysis (v14.9)
- Runtime feature toggles: `config/settings.json` features block + `POST /api/features` hot-reload — volumeProfile, openingRange, sessionLevels, correlationHeatmap, relativeStrength, performanceStats, economicCalendar, alertReplay toggleable without server restart

### AI Integration
- `server/ai/commentary.js`: Claude API prompt builder + caller (dormant, ready to re-enable)
- AI Analysis tab in backtest2.html: streaming chat via `POST /api/backtest/analyze` (Claude API)
- Analysis output policy: all sessions write to `data/analysis/{timestamp}_{type}.json` + `.txt`

---

## Active Tracks

### Track 1 — Backtesting (B-series)

**Status:** B8 complete — PASS. Paper trading activated 2026-04-06.

**B7 finding:** No configuration meets WR >= 40% for the 4-symbol portfolio (MNQ+MES+MGC+MCL). MGC or_breakout is a structural drag at ~33% WR regardless of confidence floor.

**B8 results (corrected 2026-04-07):** PASS — WR 41.8% (>= 40%), PF 2.229 (>= 1.5)
- Job ID: 6420090ea27e (corrected from 8be3f8661f10)
- 876 trades, Gross P&L $155,970, Max DD $4,967, Sharpe 5.69
- MNQ: 278 trades, WR 39.9%, P&L $121,148
- MES: 277 trades, WR 43.0%, P&L $18,823
- MCL: 321 trades, WR 42.4%, P&L $16,000
- Hour 9: WR 52.2%, Hour 10: WR 34.6%
- Config: or_breakout, 5m, conf >= 70, hours 9–10 ET, MNQ=5/MES=2/MCL=2 contracts
- Full results: `data/analysis/B8_corrected_6420090ea27e_results.json`

**B8b — MGC isolation:**
- Symbol: MGC only
- Setup: pdh_breakout, conf >= 85
- Window: 24 months
- Pass criteria: WR >= 42% AND PF >= 1.4
- Purpose: determine if MGC has an edge on a different setup type or higher threshold

**Default window:** All B-series runs from B8 onward use the 24-month window (2024-01-01 to present). Full-period runs (2018–present) remain available for reference but current market conditions are best reflected in recent data.

### Track 2 — Zone Rejection Rescue (ZR-series)

**Goal:** Determine if `zone_rejection` can be made profitable with structural changes. Currently disabled — R:R structurally inverted (AvgWin $16 vs AvgLoss $24 at all confidence levels).

| Run | Test | Code Change Required |
|-----|------|---------------------|
| **ZR-A** | Claude API analysis of all zone_rejection **winners** from A5 — what feature combinations (regime, breadth, HP proximity, DD band, time of day) appear disproportionately in winning zone rejections? | None — analysis only |
| **ZR-B** | ATR-relative zone depth filter: minimum zone depth >= 0.5x ATR at detection time. Hypothesis: shallow zones break easily; deeper zones have stronger institutional interest. | `setups.js` — add zone depth check in `_scoreZoneRejection()` |
| **ZR-C** | Maximum retest count filter: zone invalidated after 2 retests. Hypothesis: repeatedly tested zones lose edge — third rejection is less reliable than first. | `setups.js` — track retest count per zone, skip if >= 2 |
| **ZR-D** | Tighter SL: zone midpoint rather than far edge. Hypothesis: current SL at far edge creates outsized losses; midpoint SL reduces avg loss while maintaining WR. | `setups.js` — change SL calculation for zone_rejection |
| **ZR-E** | Alternative TP structure: 1:1 with 50% partial, vs current 2:1 full. Hypothesis: zone rejections produce smaller moves — 1:1 target with partial improves WR enough for positive PF. | `engine.js` — add partial exit logic for zone_rejection |

**Configuration for all ZR runs:**
- 24-month window (2024-01-01 to present)
- `or_breakout` disabled, `zone_rejection` only
- Each run isolates a single variable change vs baseline
- Output: ZR analysis documents in `data/analysis/`
- Pass criteria per variant: WR >= 45% AND PF >= 1.2

Decision (2026-04-06): ZR-F is the approved production candidate. 
No additional filters to be stacked until ZR-F is validated by 
60+ forward-test trades. ZR-D reviewed for R:R improvement only — 
ZR-D2/D3 composites explicitly deferred.
### Track 3 — Dashboard Bug Fixes

**Priority:** Fix before paper trading goes live. These bugs affect live dashboard usability.

| Bug | Description | Severity | Status |
|-----|-------------|----------|--------|
| MES aggregation | Aggregated candle values show unrealistic prices for MES | High — incorrect chart data | **Fixed v14.5** — partial bar was not replaced by completed bar on window close |
| Dollar values stale | Dollar/currency values remain stale after symbol switch on dashboard | Medium — confusing display | **Fixed v14.5** — setup overlay + predictions cleared on symbol switch |
| Symbol load failures | Some symbols fail to load chart data intermittently | Medium — user-facing error | **Fixed v14.5** — graceful "Waiting for data" overlay + startup warnings |
| TF selector centering | Timeframe selector buttons not properly centered in UI | Low — cosmetic | **Fixed v14.5** — justify-content:center on all screen sizes |

### Track 4 — Indicator Weight Calibration (IA-series)

**Goal:** Audit whether confidence score weights and gating thresholds are correctly sized relative to their actual predictive power.

| Run | Focus | Key Question |
|-----|-------|-------------|
| **IA1** | HP level proximity | Does `at_level` vs `near_level` meaningfully split WR? Are multipliers correctly sized? |
| **IA2** | DD Band | `approaching_dd` showed worst avg loss (-$213 in A5). Is +4 pts sufficient? Should `at_span_extreme` (-20) be a hard skip? |
| **IA3** | Full weight calibration | DEX bias, resilience label, breadth ±15pt cap, VIX regime multipliers. Compare WR/PF per bucket. |

**Configuration:** All IA runs use the 24-month window and current active config (or_breakout + pdh_breakout).
**Output:** Each run produces a Claude API analysis document in `data/analysis/`. IA3 produces `calibration_recommendations.txt`.

---

## B8 Passed — Paper Trading ACTIVE (2026-04-06)

### Paper Trading Status

Paper trading activated on **MNQ, MES, MCL** as of v14.6 (2026-04-06). MGC excluded pending B8b results.

1. ~~**Activate B5 forward-test harness**~~ — `checkLiveOutcomes()` fires on every live 1m bar for all 8 CME symbols ✅
2. ~~**Re-enable alert commentary**~~ — `generateSingle()` auto-fires after each cached alert with rate limiting ✅
3. ~~**Add `mtfConfluence` to trade records**~~ — already present on `setup.mtfConfluence` (set in scan engine MTF confluence block) ✅
4. ~~**Verify all forward-test trade fields**~~ — all ML Phase 3 fields confirmed present ✅:
5. ~~**Forward-test visibility**~~ — paper trading monitor panel on dashboard + `/api/forwardtest/summary` + `/api/forwardtest/trades` routes ✅ (v14.7)
   - ~~**Dedicated forward-test page**~~ — `forwardtest.html` with 4 tabs (Summary/Trade Log/Breakdown/AI Export), global filter bar, auto-refresh ✅ (v14.9)
   - ~~**AI export prompt generator**~~ — structured prompt builder for both forward-test and backtest, copy/download/save to `data/analysis/` ✅ (v14.9)
   - `vixRegime`, `vixLevel`, `dxyDirection`, `hpNearest` (proximity), `resilienceLabel`, `dexBias`, `ddBandLabel`, `equityBreadth`, `bondRegime`, `riskAppetite` — via `setup.scoreBreakdown.context`
   - `mtfConfluence` — via `setup.mtfConfluence`
5. **Symbols:** MNQ, MES, MCL only (MGC excluded pending B8b results)
6. **Collect 500+ completed trades** before advancing to ML phases (n >= 30 per setup type per symbol) — **in progress**

### Alert Commentary (Claude API) — ACTIVE

`server/ai/commentary.js` re-enabled with enhanced prompt including:

- VIX regime + level
- DXY direction
- Equity breadth (X/4 indices bullish)
- Bond regime
- Risk appetite

**Rate limits (active):**
- Confidence >= 75% only
- `setup.staleness === 'fresh'`
- Not within 15 minutes of a high-impact calendar event
- Maximum 1 commentary call per symbol per 30 minutes (in-memory `_lastCommentaryTs` map)

---

## Gated On Paper Trading Stability

### EdgeLog (port 3004)

Trade journaling SaaS product. Deferred until paper trading is stable and producing consistent results. MVP scope to be defined at that point.

- **Audience:** Futures day traders and prop firm traders
- **Estimated pricing:** $20–35/month
- **Core feature:** AI-powered setup tagging and trade review
- **Port:** 3004 (reserved)

---

## Long Term (gated on 500+ forward-test trades)

### AI/ML Phase 3 — Decision Tree (mlScoring.js)

- New file: `server/analysis/mlScoring.js` — decision tree / random forest on trade features
- Confidence nudge: ±15% band (0.85–1.15 multiplier) — AI nudges, engine decides
- npm package: `ml-random-forest` (pure JS, no GPU)
- Integration: after `applyMarketContext()` in `setups.js`
- Retraining: monthly on most recent 6 months of forward-test trades
- API: `POST /api/ml/retrain`
- Prerequisite: 500+ completed forward-test trades with outcomes

### AI/ML Phase 4 — Pattern Discovery

- Export top 200 winning trades by R-multiple → Claude API analysis of shared conditions
- Sequence similarity on 1m bars preceding winning entries (k-means / DTW clustering)
- Feature importance via gradient boosting (SHAP values → candidate new indicators)
- Prerequisite: 1,000+ forward-test trades

See AI_ROADMAP.md for full Phase 3/4 technical specifications.

---

## AI Analysis Policy (updated 2026-04-06)

**Engine:** Claude API (`claude-sonnet-4-6`) for all batch analysis. Ollama has been removed from the analysis workflow.

**Output requirement:** Every Claude API analysis session must produce a saved output document:
- `data/analysis/{timestamp}_{analysisType}.json` — machine-readable results
- `data/analysis/{timestamp}_{analysisType}.txt` — human-readable summary

Output files are gitignored but must always be produced. This ensures analysis findings can be passed back to Claude in future sessions for continuity and auditability.

**Existing infrastructure:**
- `POST /api/backtest/analyze` — SSE streaming endpoint for AI Analysis tab
- `server/ai/commentary.js` — alert commentary (dormant, ready to re-enable)
- `ANTHROPIC_API_KEY` — already in `.env`

**Cost:** Approximately $0.05–0.10 per analysis run at claude-sonnet-4-6 rates.

---

## Key Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-06 | Ollama removed from analysis workflow | Claude API is faster, more capable, and eliminates WSL2/GPU dependency. Cost is negligible (~$0.10/run). |
| 2026-04-06 | 24-month window as new default for all B-series runs | Current market conditions (post-2024) better reflect live trading environment. Full-period (2018–present) available for reference. |
| 2026-04-06 | Zone rejection rescue track (ZR-series) created | zone_rejection is structurally broken at all confidence levels but may be salvageable with SL/TP/filter changes. Worth investigating systematically before permanently abandoning. |
| 2026-04-04 | zone_rejection disabled | R:R structurally inverted: AvgWin $16 vs AvgLoss $24 at conf>=80. Zones attract repeated retests; average loss on failed rejections exceeds average win. Not fixable by confidence filter alone. |
| 2026-04-04 | MGC or_breakout identified as structural drag | ~33% WR regardless of confidence floor. Investigating separately (B8b) with higher threshold or different setup type. |
| 2026-03 | liquidity_sweep_reversal removed | 43% WR, PF 0.68 — negative edge. No path to profitability identified. |
| 2026-03 | Phase 2 loss-analysis gates implemented | Worst-500-loser analysis of A5 revealed rising DXY + OR breakout (~49% of worst losses) and risk-off breadth collapse as strong loss predictors. Implemented as -20 and -15 pt confidence penalties. |
| 2026-02 | Breadth scoring: marginal positive | A5 v12.9 vs v12.7: +$4,500 net (+1.9%), MaxDD 9% lower. Modest but retained — low-cost improvement with no downside. |
| 2026-02 | OR breakout: 5m only | 15m/30m produce <1% of OR breakout signals. Restricting to 5m reduces noise with no meaningful signal loss. |
| 2026-01 | Neural networks rejected | Decision trees preferred for interpretability. Marginal accuracy gain not worth losing ability to understand and trust model decisions. |
| 2025-12 | Ironbeam live data deferred | Optimusfutures account needs API access enabled. Databento TCP feed now serves as primary live data source. Ironbeam remains as future alternative. |
| 2025-11 | VIX from CBOE rejected | No reliable free historical source. Replaced with realized volatility proxy from MNQ 1m bars (adequate for regime classification). |

---

## Pass/Fail Criteria Reference

| Run | Symbols | Config | Window | Pass Condition |
|-----|---------|--------|--------|----------------|
| B8 | MNQ, MES, MCL | or_breakout, conf >= 70, 9–10 ET | 24 months | WR >= 40% AND PF >= 1.5 |
| B8b | MGC | pdh_breakout, conf >= 85 | 24 months | WR >= 42% AND PF >= 1.4 |
| ZR-B | MNQ | zone_rejection, zone depth >= 0.5x ATR | 24 months | WR >= 45% AND PF >= 1.2 |
| ZR-C | MNQ | zone_rejection, max 2 retests | 24 months | WR >= 45% AND PF >= 1.2 |
| ZR-D | MNQ | zone_rejection, SL at zone midpoint | 24 months | WR >= 45% AND PF >= 1.2 |
| ZR-E | MNQ | zone_rejection, 1:1 TP + 50% partial | 24 months | WR >= 45% AND PF >= 1.2 |
| Paper trading | MNQ, MES, MCL | or_breakout, conf >= 70, 9–10 ET | Live | 500+ trades, sustained WR >= 40% |

---

*Created: 2026-04-06*
*See AI_ROADMAP.md for detailed AI/ML phase specifications.*
*See CLAUDE.md for technical implementation details.*
*See CONTEXT_SUPPLEMENT.md for extended context (options, breadth, historical pipeline).*
