# FuturesEdge AI — AI/ML Enhancement Roadmap

> **Status: Deferred — B5 complete. Now collecting 30 days of live forward-test data. Phase 1 Claude batch analysis can begin once 500+ completed forward-test trades are available.**
> This document is the single source of truth for all planned AI/ML work.
> Read CLAUDE.md, CONTEXT_SUPPLEMENT.md, and DATABENTO_PROJECT.md before starting any session on this track.

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
- [ ] `mtfConfluence` on trade records — currently applied upstream, not recorded per trade
- [x] B5 forward-test harness collecting live trade outcomes ✅ (v13.0)
- [ ] Minimum 500 completed forward-test trades (n ≥ 30 per setup type per symbol)

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

**When:** After Phase 1, before building any model.

**What to do:**

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

- **Local LLM (Ollama, LM Studio)** — rejected for real-time use; models capable of financial reasoning are too slow on CPU (30–60s/response). Revisit only if Claude API costs become prohibitive at scale.
- **Neural networks** — rejected in favor of decision trees for interpretability. The marginal accuracy gain is not worth losing the ability to understand and trust the model's decisions.
- **Signal generation from AI** — explicitly out of scope. Setup detection stays deterministic. AI is analysis and nudging only.
- **VIX from CBOE** — no reliable free historical source found. Replaced with realized volatility proxy computed from MNQ 1m bars (Phase 1g). Adequate for regime classification.
- **DXY from Nasdaq TotalView-ITCH** — rejected; requires reconstructing daily OHLCV from millions of order events. Using DX futures from ICE Futures US via Databento instead (Phase 1b loop 5, dxy.json).

---

*Created: 2026-04-04*
*Status: B5 complete (v13.0). Collecting live forward-test data.*
*Revisit after: 500 completed forward-test trades (n ≥ 30 per setup type per symbol).*
*Next action: Collect 30+ days of live forward-test data. Then run AI_ROADMAP Phase 1 Claude batch analysis on trade records.*