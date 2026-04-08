# FuturesEdge AI — B6 Analysis Report
**Generated:** 2026-04-05 21:22:02 UTC
**B6 Config:** or_breakout only, hours 9-10 ET, min confidence 65
**Hypothesis:** Removing pdh_breakout and restricting to hours 9-10 improves WR, PF, and risk-adjusted returns vs A5 baseline

---

## 1. Executive Summary

The B6 hypothesis partially held. Win rate moved from 33.9% to 37.9% (+4.0pp) and profit factor changed from 1.584 to 1.949. The hour restriction reduced trade count to 5059 (54.5% of A5). Results suggest further refinement may be needed before forward testing.

B6 requires further validation before forward testing. A B7 config targeting higher win rate through confidence floor adjustment is recommended.

---

## 2. Head-to-Head: B6 vs A5

| Metric | A5 Baseline | B6 Result | Change | Verdict |
|--------|-------------|-----------|--------|---------|
| Total Trades | 9,286 | 5,059 | -4,227 | — |
| Trades/Day | 5.4 | 2.58 | -2.8 | — |
| Win Rate | 33.9% | 37.9% | +4.0pp | ✅ |
| Profit Factor | 1.584 | 1.949 | +0.365 | ✅ |
| Net P&L | $238,040 | $211,177 | $-26,863 | ❌ |
| Max Drawdown | $2,908 | $1,946 | $-962 | ✅ |
| Sharpe Ratio | 6.16 | 6.19 | +0.0 | ✅ |
| Avg Win | $113 | $145 | $32 | — |
| Avg Loss | $-63 | $-84 | $-21 | — |
| Avg R | $26 | $42 | $16 | — |

**WR prediction (42-48%):** 37.9% — ❌ Missed
**PF > 2.0:** 1.949 — ❌ Not reached
**Net P&L vs A5:** ⚠️ Lower by $26,864 — 54.5% fewer trades explains the gap
**MaxDD vs A5:** ✅ Improved by $962

---

## 3. The Trade Count Tradeoff

B6 focuses exclusively on the highest-quality setups — the first 2 hours of the RTH session:

| Removed | Count | Source |
|---------|-------|--------|
| pdh_breakout (all hours) | 2,606 | Negative P&L in A5 and both segmented periods |
| or_breakout hours 11+ | 1,621 | Estimated from A5 or_breakout trades minus B6 total |
| **Total removed** | **4,227** | |
| **B6 trades retained** | **5,059** | **54.5% of A5** |

**Quality vs quantity:** Each B6 trade has a WR of 37.9% vs 33.9% in A5 — a 12% per-trade quality lift. For live trading, fewer but higher-probability trades reduce decision fatigue, reduce commission drag, and make performance attribution cleaner. 5059 trades over 1961 trading days = ~2.58 trades/day — manageable for manual execution.

---

## 4. Hour of Day Validation

| Hour ET | A5 WR | B6 WR | A5 Trades | B6 Trades |
|---------|-------|-------|-----------|-----------|
| 9 | 43.4% | 46.4% | — | 1,878 |
| 10 | 33.9% | 32.9% | — | 3,181 |
| 11 | 25.4% | 0% | — | 0 |
| 12 | 20.8% | 0% | — | 0 |
| 13-23 | — | 0% | — | 0 |

**Exclusion check:** ✅ All hours 11+ correctly excluded (0 trades)
**Hour 9 segmented prediction (48%):** 46.4% — ✅ Near/above prediction
**Hour 10 segmented prediction (>33%):** 32.9% — ⚠️ Below expectation

---

## 5. Symbol Breakdown

| Symbol | A5 Trades | A5 Net | A5 WR | B6 Trades | B6 Net | B6 WR | WR Change |
|--------|-----------|--------|-------|-----------|--------|-------|-----------|
| MNQ | 2,436 | $94,000 | 33.5% | 1,251 | $84,695 | 39.5% | +6.0pp |
| MES | 2,530 | $46,000 | 33.5% | 1,285 | $40,875 | 40.7% | +7.2pp |
| MGC | 2,507 | $68,000 | 33.9% | 1,483 | $60,752 | 33.4% | -0.5pp |
| MCL | 1,813 | $28,000 | 34.8% | 1,040 | $24,855 | 38.8% | +4.0pp |

- WR improves for most symbols under the hour restriction
- Best performer: **MES** at 40.7% WR
- Weakest performer: **MGC** at 33.4% WR
- MNQ profit dominance: ✅ MNQ remains top contributor

---

## 6. Direction Analysis

| Direction | A5 WR | A5 Net | B6 WR | B6 Net |
|-----------|-------|--------|-------|--------|
| Bullish | 32.1% | $114,000 | 34.5% | $103,047 |
| Bearish | 36.2% | $123,000 | 42.5% | $108,130 |

- Bull/bear WR gap: A5 = 4.1pp, B6 = 8.0pp — gap has widened
- Direction-based confidence adjustment: Less urgent — gap is small

---

## 7. Confidence Bucket Analysis

| Bucket | A5 WR | A5 Trades | B6 WR | B6 Trades |
|--------|-------|-----------|-------|-----------|
| 65-70 | 32.2% | 2,024 | 36.7% | 1,178 |
| 70-80 | 32.5% | 3,369 | 35.9% | 1,888 |
| 80-90 | 34.6% | 2,145 | 36.5% | 1,113 |
| 90+ | 37.6% | 1,748 | 45.7% | 880 |

- Monotonic WR improvement with confidence: ✅ Holds
- Gap between 65-70 and 90+ buckets: 9.0pp (A5: 5.4pp)

**Confidence floor projections:**
| Floor | Trades | WR | Est. Net P&L |
|-------|--------|----|-------------|
| 65 (current) | 5,059 | 37.9% | $211,177 |
| 75 | 3,881 | 38.3% | $172,089 |
| 80 | 1,993 | 40.5% | $102,370 |

Raising the floor to **75** has limited WR impact with 23% fewer trades.
Raising to **80** shows modest improvement with 61% fewer trades.

---

## 8. VIX Regime in B6

| VIX Regime | A5 WR | A5 Trades | B6 WR | B6 Trades |
|------------|-------|-----------|-------|-----------|
| Low | 33.3% | 2,676 | 37.1% | 1,483 |
| Normal | 34.6% | 4,467 | 38.8% | 2,474 |
| Elevated | 33.5% | 1,452 | 37.9% | 749 |
| Crisis | 32.0% | 691 | 35.1% | 353 |

- Crisis VIX: ⚠️ Still weakest bucket at 35.1%
- Edge consistency across VIX regimes: ✅ Consistent (within 10pp)
- VIX-based gating: Marginally justified — crisis is weakest bucket

---

## 9. Risk Appetite in B6

| Risk Appetite | A5 WR | B6 WR |
|---------------|-------|-------|
| On | 32.9% | 36.3% |
| Neutral | 37.2% | 41.2% |
| Off | 33.6% | 40.1% |

- Neutral risk appetite outperformance: ✅ Holds in B6
- Gap (neutral vs on): 4.9pp (A5: 4.3pp)

---

## 10. Key Questions Answered

**Q1: Did removing pdh_breakout help or hurt?**
A5 pdh_breakout contributed **$-5,312** net P&L across 2,606 trades — it was already negative. B6 removes it entirely, freeing trade capital and avoiding the WR drag.
The WR of pdh_breakout (38.3% in A5) was high, but the R:R was inverted — many small wins erased by large losses. Removing it was correct.

**Q2: Did the hour restriction deliver the predicted WR improvement?**
Predicted 42-48%. Actual: 37.9%. ❌ Missed — re-examine hour filtering

**Q3: Is net P&L higher or lower than A5?**
Net P&L is $26,864 lower than A5. B6 has 4,227 fewer trades — at A5's avg R of $25.63/trade, this accounts for ~$108,338 in lost expectancy. The trade is justified if the per-trade quality is demonstrably higher.

**Q4: What is the risk-adjusted improvement?**
- Sharpe: A5 6.16 → B6 6.19 (✅ improved)
- MaxDD as % of net P&L: A5 1.2% → B6 0.9% (✅ improved)
- MaxDD absolute: A5 $2,908 → B6 $1,946 (✅ lower)

**Q5: Is B6 ready for forward testing?**
⚠️ **Not yet.** WR of 37.9% is below the 40% minimum comfort threshold for live trading.  A B7 config is recommended.

**Q6: Single highest-value remaining improvement before going live?**
The confidence distribution in B6 shows diminishing returns from raising the floor. The highest-value next step is **live forward testing** with the B6 config to gather real execution data.

---

## 11. Recommended B7 Config (if needed)

B7 should be run before forward testing:

```json
{
  "startDate": "2018-09-24",
  "endDate": "2026-04-01",
  "symbols": [
    "MNQ",
    "MES",
    "MGC",
    "MCL"
  ],
  "timeframes": [
    "5m"
  ],
  "setupTypes": [
    "or_breakout"
  ],
  "minConfidence": 75,
  "useHP": true,
  "startingBalance": 10000,
  "label": "B7: or_breakout, hours 9-10, minConf 75",
  "excludeHours": [
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23
  ],
  "spanMargin": {
    "MNQ": 1320,
    "MES": 660,
    "MGC": 1650,
    "MCL": 1200
  }
}
```

**Rationale:** B6 data shows 38.3% WR at conf≥75 with 3,881 trades. The WR lift (0.4pp) is worth the trade count reduction (23% fewer).

---

## 12. Forward Test Expectations

Based on B6 backtest results (37.9% WR, 1.949 PF):

| Expectation | Value | Notes |
|-------------|-------|-------|
| Expected live WR range | 32.9%–39.9% | Live typically trails backtest by 3-8pp |
| Trades/day (live) | ~2.58 | Concentrated in 9-10 ET window |
| Expected daily P&L range | Highly variable | Small sample per day — weekly view preferred |
| Expected DrawDown range | $1,557–$2,919 | Based on B6 MaxDD |
| "Strategy working" threshold | WR ≥ 32.9% over 50+ trades | Consistent with backtest |
| "Review" trigger | WR < 29.9% over 30+ trades | Statistically significant miss |
| Min trades for significance | 30 per symbol | Per setup type at minimum |

**Key caveat:** B6 has 2.6 trades/day × 5 days/week ≈ 77 trades per month. At n=30/symbol minimum, expect **4-6 weeks of live data** before the win rate estimate is stable.

---
*Report generated by runB6.js — FuturesEdge AI v13.2*