# FuturesEdge AI — AI/ML Enhancement Roadmap

> **Status: B9 PASSED (WR 42.7%, PF 2.265). Phase 2 loss-analysis filters complete (v14.11). Paper trading ACTIVE on MNQ/MES/MCL as of 2026-04-06. Alert commentary re-enabled with rate limiting. Collecting forward-test trades — Phase 1 Claude batch analysis begins after 500+ completed trades.**
> This document is the single source of truth for all planned AI/ML work.
> Read CLAUDE.md, CONTEXT_SUPPLEMENT.md, and DATABENTO_PROJECT.md before starting any session on this track.

## Blocking issue — forward-test record integrity (v14.27.1 diagnostic, still open after v14.28)

Before Phase 1 batch analysis can produce reliable rules, the market-context fields stamped onto resolved forward-test trade records must be trusted. The v14.27.1 diagnostic found (and confirmed against a live `/api/bias/debug` capture on 2026-04-20) that the read path in `bias.js` reads populated values correctly, while forward-test records have been showing `dxyDirection='flat'` across all trades and null `equityBreadth`/`riskAppetite` at resolution time. The bug is therefore in the **write side** (scan engine alert composition or `simulator.js` `checkLiveOutcomes()`), not in `buildMarketContext()` or `bias.js`.

**Status after v14.28 (2026-04-20):** v14.28 landed the P0 + two P1 UI/logic fixes (macro readiness now gates conviction, gate rows show live state, signal icons show alignment). The P2 forward-test stamping investigation was **explicitly out of scope** for v14.28 — it is a separate write-path bug and must land on its own so any change to record shape is observable in isolation.

Action before Phase 1 ML: complete the P2 item in [data/analysis/2026-04-20_bias_macro_reconciliation.md](data/analysis/2026-04-20_bias_macro_reconciliation.md) §8 — trace where forward-test records snapshot the market context and ensure the fields land populated. Without this, the Claude batch analysis in Phase 1 will train on a degenerate feature space (`dxyDirection = 'flat'` has zero variance → no signal).

---

## Overview

The goal is not to replace the deterministic setup detection engine with AI — that engine is correct and should stay algorithmic. The goal is to use AI/ML to answer one question:

**"Given the features present at the time of a trade entry, which combinations of features predict a winning trade?"**

This is a supervised classification problem with labeled training data already available from the backtest engine. No new data collection is needed — the trade records from A5 contain everything required.

AI is used in two distinct ways in this project:

1. **Pattern analysis** — batch analysis of historical trade records to find which feature combinations predict winners. Runs offline, informs configuration changes to `setups.js` and `marketContext.js`.
2. **Alert commentary** — real-time Claude API call on each setup alert explaining why the signal fired, what to watch for, and where it invalidates. Already built in `server/ai/commentary.js`, currently dormant. Re-enable after B5.

Signal generation remains entirely deterministic. AI never decides whether to take a trade.

---

## Current State of AI in the Project

### What exists
- `server/ai/commentary.js` — Claude API prompt builder + caller. Generates 3–5 sentence commentary per alert. Model: `claude-sonnet-4-6`. Currently dormant (not called from scan engine).
- `ANTHROPIC_API_KEY` — already in `.env`
- Alert schema has `setup.commentary` field — persisted to avoid re-calling the API on the same alert

### What was removed and why
Alert commentary was deprioritized during the data pipeline and backtesting work (Phases P–V). It was not broken — it was deferred. Re-enabling it requires one line change in `server/index.js` to call `generateCommentary()` after a setup fires.

### What has never been built
- ML scoring (`mlScoring.js`) — decision tree / random forest on trade features
- Batch trade analysis — Claude API analysis of full trade record set
- Pattern discovery — unsupervised clustering of price action sequences

---

## Prerequisites Checklist

Before any ML work is useful:

- [x] A5 complete with VIX proxy and DXY data in confidence scoring ✅ (v12.7)
- [x] `vixRegime`, `vixLevel` on trade records ✅ (v12.7)
- [x] `dxyDirection`, `dxyClose` on trade records ✅ (v12.7)
- [x] `hpProximity`, `resilienceLabel`, `dexBias`, `ddBandLabel` on trade records ✅
- [x] `equityBreadth`, `bondRegime`, `copperRegime`, `dollarRegime`, `riskAppetite`, `riskAppetiteScore` on trade records ✅ (v12.9 A5 breadth run complete)
- [x] `mtfConfluence` on trade records — present on `setup.mtfConfluence` ✅ (v14.6)
- [x] B5 forward-test harness collecting live trade outcomes ✅ (v13.0)
- [x] B8 backtest passes pass criteria (WR ≥ 40% + PF ≥ 1.5 on MNQ+MES+MCL, 24-month window) ✅ (v14.6 — WR 41.8%, PF 2.229)
- [ ] Minimum 500 completed forward-test trades (n ≥ 30 per setup type per symbol) — collecting

---

## Phase 1 — Exploratory Analysis via Claude API

**When:** Immediately after Phase V (marketBreadth.js) is complete and a new full-period A5 run includes `equityBreadth`, `bondRegime`, `copperRegime` on trade records.

**What to do:**

Export the full trade record set from the A5 baseline job as JSON. Send it to Claude via the API with a structured analysis prompt. This costs approximately $0.05–0.10 per run at claude-sonnet-4-6 rates.

**Prompt structure:**
You are analyzing futures trading backtest results for a systematic trading system.
Each trade record contains: symbol, setupType, timeframe, direction, confidence,
outcome (won/lost/timeout), hour (ET), vixRegime, dxyDirection, hpProximity,
resilienceLabel, dexBias, ddBandLabel, equityBreadth, bondRegime, copperRegime,
riskAppetite, netPnl, grossPnl.
Analyze these [N] trades and identify:

Which single features most strongly predict a winning trade?
Which combinations of 2–3 features together predict WR > 65%?
Which combinations predict WR < 40% (trades to avoid)?
Are there time-of-day patterns that interact with setup type?
Does VIX regime interact with HP proximity in a meaningful way?
Does equityBreadth or bondRegime improve WR prediction for equity setups?
What confidence threshold per setup type maximizes profit factor?

Return findings as specific conditional rules with sample sizes and win rates.
Only report rules where n >= 30. Format each rule as:
"[condition] → [WR]% WR (n=[count], PF=[value])"

**IMPLEMENTATION STATUS:** Complete (v13.1, updated v14.4). Built as streaming chat interface in `backtest2.html` (6th tab, AI Analysis). Uses Claude API (`claude-sonnet-4-6`) for all batch analysis via the existing `POST /api/backtest/analyze` endpoint. Ollama has been removed from the analysis workflow.

**Expected output:** Conditional rules like:
- `or_breakout + riskAppetite=on + first 90min RTH → 61% WR (n=312, PF=2.1)`
- `pdh_breakout + bondRegime=bullish + MNQ → 58% WR (n=87, PF=1.7)`
- `or_breakout + equityBreadth<=1 → 24% WR (n=44, PF=0.6)` ← avoid

These rules directly inform:
- Confidence score adjustments in `setups.js`
- Gating conditions in `marketContext.js`
- New filters in the backtest UI Optimize tab

**Implementation:** No new code needed for Phase 1. Just export the trade JSON and make the API call. Can be done in a standalone script or directly in this Claude chat.

---

## Phase 2 — Loss Analysis (do this before Phase 3)

**Status: COMPLETE (v14.11).** 5 filter rules implemented in `setups.js`. B9 validated: 729 trades, WR 42.7%, PF 2.265 (up from B8: 876 trades, WR 41.8%, PF 2.229). Filters removed 147 negative-EV trades, improving WR +0.9pp and PF +0.036.

**Filters implemented (v14.11):**
| Filter | Type | Condition | Evidence |
|--------|------|-----------|----------|
| 1 | Hard gate | OR breakout + DXY rising + hour >= 11 ET | WR 20.7%, PF 0.965 (n=174) |
| 2 | Hard gate | PDH breakout on MNQ/MES/MCL | PF 0.954, net -$1,451 (8yr) |
| 3 | Hard gate | OR breakout + DEX bias neutral | PF 1.164 (n=286) |
| 4 | Hard gate | MGC PDH at hours 9 and 11+ ET | Hour 9 PF 0.983, hour 11+ PF 0.700 |
| 5 | Score -8 | OR breakout + DXY rising + hour <= 10 ET | PF 1.733 vs baseline 2.064 |
| 6 | Comment | IA3 TODO: conf 90-100 underperforming | B8 PF 1.349 vs 70-75 PF 2.770 |

**B9 result:** Job 9392cd8f9a9f, `data/analysis/B9_9392cd8f9a9f_results.json`

**Original Phase 2 prompt (retained for reference):**

Export the 500 worst losing trades by `netPnl` from the A5 full-period job. Feed to Claude and ask:
Here are the 500 worst losing trades from a systematic futures trading backtest.
For each trade I have: symbol, setupType, direction, hour, vixRegime, dxyDirection,
hpProximity, bondRegime, equityBreadth, riskAppetite, confidence, entry, sl, tp, netPnl.
What do these losing trades have in common? Look for:

Feature combinations that appear repeatedly in losers but not winners
Time-of-day patterns in losses
Market context conditions (VIX, bond regime, equity breadth) that precede losses
Any obvious "should have been skipped" conditions that a simple rule could catch

Return specific avoidance rules where n >= 20.

**Why loss analysis first:** The fastest path to improved win rate is eliminating the worst trades, not finding new good ones. A simple avoidance rule ("don't take or_breakout when equityBreadth <= 1 AND riskAppetite=off") can meaningfully improve results with zero model complexity.

---

## Phase 3 — Decision Tree / Random Forest

**When:** After Phase 1 and Phase 2 identify candidate features worth formalizing. Only build this if analysis shows clear conditional patterns with n ≥ 30 and WR differences ≥ 15pp.

**Why decision trees over neural networks:**
- Interpretable — produces human-readable rules that can be manually reviewed and trusted
- Fast to train — 10,000+ records trains in under a second in Node.js
- No black box — you can see exactly why a trade is scored higher or lower
- Rules can be directly translated into confidence score adjustments

**New file: `server/analysis/mlScoring.js`**
```javascript
// Trains on historical trade records, produces a scoring function
// that adjusts confidence based on feature combinations

const features = [
  'vixRegime',        // low/normal/elevated/crisis
  'dxyDirection',     // rising/falling/flat
  'hpProximity',      // at_level/near_level/other
  'resilienceLabel',  // resilient/neutral/fragile
  'dexBias',          // bullish/bearish/neutral
  'ddBandLabel',      // room_to_run/approaching_dd/etc
  'equityBreadth',    // 0–4
  'bondRegime',       // bullish/bearish/neutral
  'copperRegime',     // bullish/bearish/neutral
  'riskAppetite',     // on/neutral/off
  'hour',             // ET hour 0–23
  'timeframe',        // 5m/15m/30m
  'direction',        // bullish/bearish
  'symbol'            // MNQ/MES/MGC/MCL
];

// Output: probability of win for a given feature combination
// Used as a multiplier on base confidence score
```

**npm package:** `ml-random-forest` — pure JavaScript, no native dependencies, runs in Node.js without GPU.

**Training data source:** `data/backtest/results/{jobId}.json` trades array from the most recent full-period A5 job.

**Integration point in `setups.js`:** After `applyMarketContext()`:
```javascript
if (mlScoring.isReady()) {
  const mlScore = mlScoring.predict(featureVector); // returns 0.0–1.0 win probability
  const mlMultiplier = 0.85 + (mlScore * 0.30);    // maps to 0.85–1.15 range
  finalConfidence = Math.min(100, baseConfidence * mlMultiplier);
  setup.scoreBreakdown.ml = Math.round((mlMultiplier - 1.0) * 100); // e.g. +8 or -12
}
```

The multiplier is deliberately narrow (0.85–1.15) so the ML layer nudges scores rather than overriding the deterministic engine. It never turns a bad setup into a good one or a good one into a no-trade.

**Retraining cadence:** Retrain monthly using the most recent 6 months of forward-test trades from B5. Backtest data trains the initial model; live data keeps it current. Never retrain on backtest data alone after live trading starts.

**New API route:** `POST /api/ml/retrain` — triggers retraining from the most recent B5 trade records. Returns model accuracy metrics. Scheduled monthly or triggered manually.

---

## Phase 4 — Pattern Discovery (long term)

**When:** After B5 has collected 6+ months of live trades with outcomes. Requires minimum 1,000 forward-test trades.

**What this is:** Unsupervised discovery of price action patterns that precede winning trades but are not currently detected by the setup engine.

**Option A — Sequence similarity on 1m bar sequences**

For each winning trade, extract the 20 bars preceding entry as a feature vector (OHLCV ratios, not raw prices). Cluster similar sequences using k-means or DBSCAN. If a cluster consistently precedes winners at WR ≥ 65%, that cluster is a candidate new setup type.

Requires: Dynamic Time Warping (DTW) for sequence distance, or simpler normalized OHLCV feature extraction. Library: `ml-kmeans` (npm, pure JS).

**Option B — Feature importance from gradient boosting**

Train on a richer feature set including raw price action features: wick ratio, body ratio, volume relative to 20-bar average, distance from VWAP, distance from session high/low, bar count since last swing. SHAP values reveal which features the model relies on most — those become candidates for new indicator computation in `indicators.js`.

**Option C — Claude analysis of winning trade clusters (recommended first)**

Export the 200 best winning trades by R-multiple. Feed to Claude and ask what price action conditions they share. Human-interpretable output, no model complexity, findings directly actionable. This is the highest-value first step in pattern discovery.

---

## Alert Commentary — Re-enable Plan

`server/ai/commentary.js` is complete and working. To re-enable:

1. In `server/index.js`, uncomment the `generateCommentary()` call after a setup fires
2. Verify `ANTHROPIC_API_KEY` is set in `.env`
3. Rate limiter is already built — prevents repeat calls on the same level within a configurable window

**Enhanced commentary** (add when re-enabling): Update `_buildPrompt()` in `commentary.js` to include the new context fields:
```javascript
// Add to prompt context:
- VIX regime: ${marketContext.vixRegime} (level: ${marketContext.vixLevel?.toFixed(1)})
- DXY direction: ${marketContext.dxyDirection}
- Equity breadth: ${breadth.equityBreadth}/4 indices bullish
- Bond regime: ${breadth.bondRegime}
- Risk appetite: ${breadth.riskAppetite}
```

This gives Claude enough context to write genuinely useful commentary rather than generic setup descriptions.

**Trigger criteria for commentary** (to control API costs):
- Confidence ≥ 75% only
- `setup.staleness === 'fresh'` (once B5 dedup is implemented)
- Not within 15 minutes of a high-impact calendar event
- Maximum 1 commentary call per symbol per 30 minutes

---

## Key Principles

- **AI nudges, the engine decides.** The deterministic setup detection stays authoritative. ML adjusts confidence scores within a narrow band (±15%) — it never generates signals independently.
- **Interpretability over accuracy.** A decision tree that produces readable rules is more valuable than a neural network with 2% better accuracy. You need to understand and trust every adjustment.
- **Minimum sample size is 30.** Any pattern with n < 30 is noise. Claude analysis and decision tree rules both get filtered by this threshold before being acted on.
- **Retrain on forward-test data, not backtest data.** Once live trading starts, retrain monthly on real outcomes. Backtest data trains the initial model only.
- **Loss analysis first.** Before looking for new winning patterns, understand why the current losers lost. The fastest path to improved WR is eliminating the worst trades.
- **Commentary is additive, not critical path.** Re-enable it when B5 is stable. Missing commentary doesn't affect signal quality.
- **Every Claude API analysis session must produce a saved output document.** Analysis runs write to `data/analysis/{timestamp}_{analysisType}.json` (machine-readable) and `data/analysis/{timestamp}_{analysisType}.txt` (human-readable summary). Output files are gitignored. This ensures analysis findings can be passed back to Claude in future sessions.

---

## Zone Rejection Rescue Track (ZR-series)

**Goal:** Determine if `zone_rejection` can be made profitable with structural changes. Currently disabled (R:R structurally inverted — AvgWin $60 vs AvgLoss $75 at 1:1 R:R, PF 0.72).

**ZR-A baseline (2026-04-06):** 838 trades, MNQ 15m+30m, 2024-01-01 → 2026-04-01, conf ≥ 50. WR 45.6%, PF 0.72, Net -$8,478. AvgWin $59.90, AvgLoss -$75.45. WR is near-viable but PF far below target.

**ZR-A Claude analysis key findings:** (1) Hours 4–8 ET have the strongest edge — institutional flow before RTH creates cleaner rejections. (2) Equity breadth 2–3 is the sweet spot — balanced markets support mean-reversion. (3) Confidence floor has no edge — the scoring system wasn't designed for zone rejection features.

| Run | Description | Status | Code change? |
|-----|-------------|--------|--------------|
| **ZR-A** | Baseline extraction + Claude API analysis of all zone_rejection trades — winner characteristics, confidence buckets, time-of-day, hold time, structural diagnosis. | **✅ Complete** — `data/analysis/ZR_A_all.json`, `ZR_A_winners.json`, `ZR_A_prompt.txt` | No |
| **ZR-F** | Hours 4–8 ET gate only. Tests strongest ZR-A finding: pre-RTH/early overlap window. | **✅ PASS** — 216 trades, **WR 57.4%, PF 1.253**, Net +$382. `data/analysis/ZR_F_14f8e4f26337_*` | No |
| **ZR-F2** | Hours 4–8 ET + breadth 2–3 composite. Post-filter on ZR-F results. | **✅ PASS** — 53 trades, **WR 66.0%, PF 1.387**, Net +$215. `data/analysis/ZR_F2_14f8e4f26337_*` | No |
| **ZR-D1** | Midpoint SL + hours 4–8 ET (both dirs). Tests if halving risk distance fixes R:R. | **✅ FAIL** — 217 trades, WR 52.1%, PF 1.079, Net -$656. Tighter TP missed more winners than tighter SL saved losers. | Yes — `opts.slMidpoint` flag in `setups.js` + `engine.js` |
| **ZR-D2** | Midpoint SL + bullish only (post-filter on D1). | **✅ FAIL** — 114 trades, WR 50.9%, PF 0.871, Net -$653. | Post-filter |
| **ZR-D3** | Midpoint SL + VIX low/normal (post-filter on D1). | **✅ FAIL** — 197 trades, WR 52.3%, PF 1.151, Net -$442. Best D variant but still below 1.2. | Post-filter |
| **ZR-B** | ATR-relative zone depth filter: skip if zone-forming candle range < 0.5× ATR14. | **✅ FAIL** — 209 trades, WR 57.4%, PF 1.108, Net +$530. Filter too loose (3.2% removed, PF worse). `data/analysis/ZR_B_d509596b95ca_*` | Yes — candle lookup map + 2 lines per direction in `_zoneRejection()` |
| **ZR-C** | Max retest count filter: invalidate zone after 2 retests. | Next | Yes — ~10 lines per direction + helper function |
| **ZR-E** | Clean baseline at conf ≥ 65. Deprioritized — Finding 3 shows no confidence edge. | Deprioritized | No — config only |

**ZR-D finding:** Midpoint SL is counterproductive. The wide SL is a feature, not a bug — it gives price room to breathe during the rejection. The R:R inversion is compensated by high WR when properly time-gated. **ZR-F (original SL + hours 4–8 ET) remains the best configuration.**

**Pass criteria:** WR ≥ 45% AND PF ≥ 1.2 AND AvgWin ≥ AvgLoss. Both required for re-enable consideration.

**Configuration for all ZR runs:**
- 24-month window: 2024-01-01 to 2026-04-01
- `zone_rejection` only, MNQ, 15m + 30m
- Each run isolates a single variable change vs the ZR-A baseline
- Output: `data/analysis/ZR_*.json` and `data/analysis/ZR_track_plan.txt`
- Test configs: `data/analysis/ZR_test_configs.json`

**Execution order (revised 2026-04-07, post ZR-B):** ZR-F ✅ → ZR-F2 ✅ → ZR-D ✅ (FAIL) → ZR-B ✅ (FAIL — zone depth filter too loose, PF worse) → ZR-C (retest count, next). ZR-E skipped. **Recommendation:** ZR-F remains the best configuration. ZR-B zone depth filter at 0.5× ATR14 was ineffective (only 3.2% filtered, net negative). ZR-C is still queued — independent of ZR-B.

---

## Indicator Weight Calibration (IA-series)

**Goal:** Audit whether confidence score weights and gating thresholds are correctly sized relative to their actual predictive power in backtest data.

| Run | Description |
|-----|-------------|
| **IA1** | **HP level proximity audit** — Does `at_level` vs `near_level` meaningfully split WR? Are the current multipliers correctly sized? Compare WR/PF for at_level, near_level, and no-HP-proximity trades across or_breakout and pdh_breakout. |
| **IA2** | **DD Band audit** — `approaching_dd` showed worst avg loss (-$213 in A5); is the current +4 pts penalty sufficient? Are `beyond_dd_upper`/`beyond_dd_lower` levels gated hard enough at -12 pts? Should `at_span_extreme` (-20) be a hard skip instead of a penalty? |
| **IA3** | **Full weight calibration** — DEX bias (bullish/bearish/neutral WR split), resilience label (resilient/neutral/fragile WR split), breadth ±15pt cap (is 15 the right cap?), VIX regime multipliers. Compare WR/PF per bucket for each indicator. Output: `calibration_recommendations.txt` |

**Configuration:** All IA runs use the 24-month window and the current active setup configuration (or_breakout + pdh_breakout).

---

## Files This Will Touch

| File | Phase | Change |
|------|-------|--------|
| `server/ai/commentary.js` | Re-enable | Uncomment call in index.js; update prompt with new context fields |
| `server/analysis/mlScoring.js` | Phase 3 | New — decision tree training and prediction |
| `server/analysis/setups.js` | Phase 3 | Add ML multiplier after `applyMarketContext()` |
| `server/backtest/engine.js` | Phase 3 | Add `mtfConfluence` to trade record; retrain trigger |
| `server/index.js` | Phase 3 | Load trained model at startup; `POST /api/ml/retrain` route |
| `public/backtest2.html` | Phase 3 | ML feature importance visualization in Optimize tab |
| `DATABENTO_PROJECT.md` | Phase 3 | New track D — ML scoring |

---

## Decisions Deferred

These were discussed and intentionally deferred:

- **Local LLM (Ollama)** — REMOVED. Replaced by Claude API (`claude-sonnet-4-6`) for all analysis tasks. The `POST /api/backtest/analyze` SSE endpoint and `backtest2.html` AI Analysis tab now use Claude API exclusively.
- **Neural networks** — rejected in favor of decision trees for interpretability. The marginal accuracy gain is not worth losing the ability to understand and trust the model's decisions.
- **Signal generation from AI** — explicitly out of scope. Setup detection stays deterministic. AI is analysis and nudging only.
- **VIX from CBOE** — no reliable free historical source found. Replaced with realized volatility proxy computed from MNQ 1m bars (Phase 1g). Adequate for regime classification.
- **DXY from Nasdaq TotalView-ITCH** — rejected; requires reconstructing daily OHLCV from millions of order events. Using DX futures from ICE Futures US via Databento instead (Phase 1b loop 5, dxy.json).

---

*Created: 2026-04-04*
*Status: B9 PASSED (WR 42.7%, PF 2.265, 729 trades). Phase 2 loss-analysis filters active (v14.11). Paper trading ACTIVE on MNQ/MES/MCL since 2026-04-06.*
*Alert commentary re-enabled with rate limiting (conf >= 75, fresh, 30-min cooldown, no near calendar).*
*All ML Phase 3 trade record fields confirmed: vixRegime, vixLevel, dxyDirection, resilienceLabel, dexBias, ddBandLabel, equityBreadth, bondRegime, riskAppetite, mtfConfluence.*
*MGC: investigate separately via B8b — may require higher threshold (85%+) or different setup type.*
*AI_ROADMAP Phase 1 batch analysis: begins after 500+ completed forward-test trades accumulate.*