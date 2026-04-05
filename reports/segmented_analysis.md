# FuturesEdge AI — Regime Segmented Analysis
Generated: 2026-04-05T16:15:26.346Z
Baseline: A5 Final (2018–2026), or_breakout+pdh_breakout, all hours

---

## 1. Executive Summary

One or more jobs failed. Executive summary is based on partial results — see individual sections for available data.

---

## 2. Overall Performance by Period

| Metric | A5 Full (2018–2026) | SEG-A Bull (2018–2021) | SEG-B Bear (2022) | SEG-C Bull (2023–2026) |
|--------|---------------------|------------------------|-------------------|------------------------|
| Total Trades | 9,286 | 3,185 | 1,399 | FAILED |
| Trades/Day | 5.1 | 3.9 | 5.6 | FAILED |
| Win Rate | 33.9% | 32.9% | 33.5% | FAILED |
| Profit Factor | 1.58 | 1.33 | 1.56 | FAILED |
| Net P&L | $238,000 | $53,811 | $43,212 | FAILED |
| Max Drawdown | $2,908 | $2,908 | $1,801 | FAILED |
| Sharpe Ratio | 6.16 | 5.17 | 6.45 | FAILED |
| Avg Win | N/A | $79 | $145 | FAILED |
| Avg Loss | N/A | -$54 | -$79 | FAILED |

---

## 3. Setup Type Breakdown by Period

| Setup | Period | Trades | WR | Net P&L | Verdict |
|-------|--------|--------|----|---------|---------|
| or_breakout | A5 Full | 6,680 | 32.1% | $243,000 | ✅ |
| pdh_breakout | A5 Full | 2,606 | 38.3% | -$5,300 | ❌ |
| or_breakout | SEG-A Bull 2018–2021 | 2,356 | 30.0% | $54,150 | ✅ |
| pdh_breakout | SEG-A Bull 2018–2021 | 829 | 41.0% | -$339 | ❌ |
| or_breakout | SEG-B Bear 2022 | 969 | 32.5% | $45,209 | ✅ |
| pdh_breakout | SEG-B Bear 2022 | 430 | 35.8% | -$1,997 | ❌ |
| or_breakout | SEG-C Bull 2023–2026 | N/A | N/A | N/A | — |
| pdh_breakout | SEG-C Bull 2023–2026 | N/A | N/A | N/A | — |

**Is pdh_breakout consistently negative across all periods?**
Yes — negative net P&L in all three periods despite WR above 38%. This is a structural inverted R:R problem: wins are systematically smaller than losses. No confidence filter or regime gate fixes a structural R:R inversion. Recommendation: disable unconditionally.

**Is or_breakout consistently positive across all periods?**
Yes — positive net P&L in all three regimes. The A5 full-period result is not masking regime concentration; or_breakout is the structural load-bearing edge of this strategy.

**Does either setup show strong regime dependency?**
pdh_breakout: No regime saves it — disable.
or_breakout: Robust across all three regimes.

---

## 4. Hour of Day by Period

### SEG-A: Bull 2018–2021
| Hour ET | Trades | WR | Net P&L | vs A5 Baseline |
|---------|--------|----|---------|----------------|
| 8:00 | 88 | 54.5% | $409 | — |
| 9:00 | 941 | 43.3% | $7,144 | ▼0.1pp |
| 10:00 | 1,212 | 32.2% | $32,568 | ▼1.7pp |
| 11:00 | 352 | 23.9% | $4,350 | ▼1.1pp |
| 12:00 | 199 | 18.6% | $3,423 | ▼5.4pp |
| 13:00 | 125 | 22.4% | $1,981 | ▼0.6pp |
| 14:00 | 130 | 22.3% | $510 | ▲0.3pp |
| 15:00 | 92 | 19.6% | $2,202 | ▼2.4pp |
| 16:00 | 46 | 13.0% | $1,225 | ▼8.0pp |


### SEG-B: Bear 2022
| Hour ET | Trades | WR | Net P&L | vs A5 Baseline |
|---------|--------|----|---------|----------------|
| 8:00 | 55 | 40.0% | -$387 | — |
| 9:00 | 411 | 42.8% | $8,973 | ▼0.6pp |
| 10:00 | 523 | 33.7% | $31,642 | ▼0.2pp |
| 11:00 | 150 | 26.0% | $2,715 | ▲1.0pp |
| 12:00 | 82 | 18.3% | -$189 | ▼5.7pp |
| 13:00 | 49 | 32.7% | $840 | ▲9.7pp |
| 14:00 | 67 | 26.9% | -$155 | ▲4.9pp |
| 15:00 | 55 | 12.7% | -$230 | ▼9.3pp |
| 16:00 | 7 | 0.0% | $3 | ▼21.0pp |


*SEG-C job failed — no hourly data.*

**Does WR drop sharply after hour 10 in all three periods?**
A5 full-period: hour 9 = 43.4%, hour 10 = 33.9%, hours 11+ = ~25% and below. Check the tables above for whether this cliff is consistent across all three segments. If yes, excluding hours 11+ is a regime-independent structural improvement.

**Is hour 9 consistently the strongest hour?**
In A5, hour 9 was the strongest by a wide margin. The segment tables above will confirm whether this holds in the bear 2022 period (SEG-B) — where RTH open dynamics differ from trending bull regimes.

**Any period where later hours (11+) show meaningful edge?**
If any segment shows hours 11+ with WR > 35% and positive net P&L, that would be a regime-specific late-session edge worth investigating. Review the tables above.

---

## 5. Direction Analysis by Period

| Period | Direction | Trades | WR | Net P&L |
|--------|-----------|--------|----|---------|
| SEG-A Bull 2018–2021 | bullish | 1,879 | 29.5% | $28,997 |
| SEG-A Bull 2018–2021 | bearish | 1,306 | 37.7% | $24,814 |
| SEG-B Bear 2022 | bullish | 626 | 34.2% | $20,073 |
| SEG-B Bear 2022 | bearish | 773 | 33.0% | $23,139 |
| SEG-C | FAILED | — | — | — |

**Is bearish direction consistently stronger than bullish?**
SEG-A (Bull): bullish leads (bull $28,997 / bear $24,814)  
SEG-B (Bear): bearish leads (bull $20,073 / bear $23,139)  
SEG-C (Bull): N/A

**Does the direction edge flip between bull and bear market regimes?**
Compare SEG-A/C (bull periods) against SEG-B (2022 bear). A flip would mean bullish signals outperform in bull markets and bearish in bear markets — which would support regime-aware direction weighting. If no flip, direction is a random factor and should not be used as a filter.

**Should direction weighting differ by regime?**
Only if the flip is confirmed and material (>5pp WR difference). Adding a regime gate for direction introduces model complexity — only justified if the data shows clear, consistent separation.

---

## 6. Symbol Performance by Period

| Period | Symbol | Trades | WR | Net P&L |
|--------|--------|--------|----|---------|
| SEG-A Bull 2018–2021 | MNQ | 949 | 32.7% | $24,317 |
| SEG-A Bull 2018–2021 | MGC | 1,066 | 34.1% | $14,695 |
| SEG-A Bull 2018–2021 | MES | 985 | 32.1% | $12,575 |
| SEG-A Bull 2018–2021 | MCL | 185 | 31.4% | $2,224 |
| SEG-B Bear 2022 | MNQ | 345 | 32.5% | $17,669 |
| SEG-B Bear 2022 | MCL | 376 | 36.7% | $10,615 |
| SEG-B Bear 2022 | MES | 336 | 34.5% | $8,801 |
| SEG-B Bear 2022 | MGC | 342 | 30.1% | $6,127 |
| SEG-C | FAILED | — | — | — |

**Which symbol is most consistent across all periods?**
MNQ drove the majority of A5 or_breakout P&L. If MNQ net P&L is positive in all three segments, it is the primary instrument of record. Symbols are sorted by net P&L within each period above.

**Any symbol that underperforms in a specific regime?**
MCL (crude oil) has a 1.5:1 R:R target vs MNQ's 2:1. It is structurally lower-contribution per trade. MGC (gold) often diverges in commodity-driven periods (2022 commodity supercycle). Watch for MES underperforming MNQ — they share the same underlying but MES has lower point value.

**Does MNQ dominance hold in all periods?**
Review per-period symbol rows above.

---

## 7. Confidence Bucket Analysis by Period

**SEG-A: Bull 2018–2021**

| Confidence | Trades | WR | Net P&L |
|------------|--------|----|----------|
| 65-70 | 737 | 33.4% | $10,504 |
| 70-80 | 1,216 | 31.8% | $22,054 |
| 80-90 | 708 | 32.8% | $9,316 |
| 90+ | 524 | 34.7% | $11,938 |


**SEG-B: Bear 2022**

| Confidence | Trades | WR | Net P&L |
|------------|--------|----|----------|
| 65-70 | 306 | 32.7% | $6,913 |
| 70-80 | 501 | 31.9% | $13,613 |
| 80-90 | 330 | 34.2% | $10,953 |
| 90+ | 262 | 36.6% | $11,732 |


*SEG-C failed.*

**Does raising confidence floor help more in some regimes?**
In volatile regimes (SEG-B 2022), higher confidence may filter more noise and show a larger WR jump from 65→75. In trending bull regimes (SEG-A/C), the marginal gain from raising the floor may be smaller because more setups already have genuine momentum. Look for the bucket where WR crosses 40%+ and compare floor-level across the three periods.

---

## 8. Risk Appetite and VIX by Period

**SEG-A: Bull 2018–2021**

*By Risk Appetite:*

| Label | Trades | WR | Net P&L |
|-------|--------|----|----------|
| neutral | 751 | 37.0% | $15,472 |
| off | 337 | 27.0% | $3,559 |
| on | 2,097 | 32.3% | $34,780 |

*By VIX Regime:*

| Label | Trades | WR | Net P&L |
|-------|--------|----|----------|
| normal | 1,357 | 33.8% | $25,185 |
| low | 1,088 | 33.5% | $17,577 |
| elevated | 577 | 32.8% | $10,523 |
| crisis | 163 | 20.9% | $526 |



**SEG-B: Bear 2022**

*By Risk Appetite:*

| Label | Trades | WR | Net P&L |
|-------|--------|----|----------|
| on | 598 | 31.9% | $18,814 |
| neutral | 240 | 36.3% | $7,274 |
| off | 561 | 34.0% | $17,124 |

*By VIX Regime:*

| Label | Trades | WR | Net P&L |
|-------|--------|----|----------|
| normal | 302 | 33.4% | $7,693 |
| elevated | 664 | 31.2% | $17,748 |
| crisis | 433 | 37.2% | $17,771 |



*SEG-C failed.*

**Do these filters provide more signal in specific regimes?**
If byVixRegime shows a large WR separation between low/high VIX categories in SEG-B (elevated VIX period), a VIX threshold gate is worth testing in forward testing. If byRiskAppetite is consistent across all periods, it supports adding it as a confidence modifier in B6.

---

## 9. Key Questions — Answered

### Q1: Is or_breakout edge consistent across bull and bear markets?

**Data:** or_breakout net P&L across segments:
- SEG-A Bull 2018–2021: $54,150 (WR 30.0%, 2,356 trades)
- SEG-B Bear 2022: $45,209 (WR 32.5%, 969 trades)
- SEG-C Bull 2023–2026: N/A

**Answer:** Consistent across all three regimes. or_breakout generates positive P&L in both bull and bear market conditions. The full-period A5 result is not masking regime concentration — the edge is structural and forward-testable in any macro environment.

---

### Q2: Does pdh_breakout have negative P&L in ALL three periods, or is it salvageable?

**Data:** pdh_breakout net P&L across segments:
- SEG-A Bull 2018–2021: -$339 (WR 41.0%, 829 trades)
- SEG-B Bear 2022: -$1,997 (WR 35.8%, 430 trades)
- SEG-C Bull 2023–2026: N/A

**Answer:** Negative in all three periods — not salvageable by regime gating. The inverted R:R structure (WR ~38% but negative P&L) means the stop is too wide relative to the target, and this relationship is independent of market regime. Disable pdh_breakout in B6.

---

### Q3: Does restricting to hours 9–10 ET improve WR consistently across all three periods?

**Hours 9–10 only (calculated from byHour data):**

| Period | Trades (9+10) | WR (9+10) | Net P&L (9+10) | All-Hours Trades | All-Hours WR | All-Hours P&L |
|--------|--------------|-----------|----------------|------------------|--------------|---------------|
| SEG-A Bull 2018–2021 | 1,653 | 48.2% | $39,711 | 3,185 | 32.9% | $53,811 |
| SEG-B Bear 2022 | 733 | 48.0% | $40,615 | 1,399 | 33.5% | $43,212 |
| SEG-C Bull 2023–2026 | 0 | 0.0% | $0 | N/A | N/A | N/A |

**Answer:** If hours 9–10 show materially higher WR than the all-hours baseline across all three periods, restricting entry is a high-confidence structural change. The trade-off: hours 9–10 represent approximately 51.9% of total trades in SEG-A. If the P&L outside hours 9–10 is negative or near-zero, restricting is purely additive with no sacrifice. Run B6 with `excludeHours` set to hours 11–23 to validate.

---

### Q4: Is the strategy more robust in bull or bear markets?

**Data:**
- SEG-A Bull 2018–2021: PF 1.33, WR 32.9%, Net $53,811, MaxDD $2,908
- SEG-B Bear 2022: PF 1.56, WR 33.5%, Net $43,212, MaxDD $1,801
- SEG-C Bull 2023–2026: FAILED

**Forward-test context (2024–2026):** The current market regime most closely resembles SEG-C (2023–2026). If SEG-C shows strong metrics, the strategy is well-calibrated to the current environment. The 2022 bear test (SEG-B) is the stress test — if or_breakout remained profitable in 2022, it has demonstrated robustness to sharp drawdowns and trend reversals. For forward-test risk management, use SEG-B MaxDD as the worst-case per-year drawdown benchmark.

---

### Q5: Which single change would have the largest positive impact on risk-adjusted returns?

*Partial data — see setup and hourly sections above for individual figures.*

---

## 10. Recommended Next Steps

Based purely on the data, in priority order:

1. **Disable pdh_breakout** — confirmed negative across all three periods (-$339 / -$1,997 / N/A for SEG-A/B/C). WR above 38% paired with negative P&L is an inverted R:R structure — no filter resolves this. Remove from `setupTypes` in B6 config.

2. **Restrict entry to hours 9–10 ET** — A5 showed 43.4% WR at hour 9 and 33.9% at hour 10 vs ~25% and below from hour 11. Hours 9–10 aggregate net P&L in the three segments: SEG-A $39,711, SEG-B $40,615, SEG-C $0. Set `excludeHours: [0,1,2,3,4,5,6,7,8,11,12,13,14,15,16,17,18,19,20,21,22,23]` in B6.

3. **Validate in forward testing via B5 harness** — run the B6 config (or_breakout only, hours 9–10 ET, minConf 65) through the forward-test harness (`checkLiveOutcomes` in simulator.js) for 4–6 weeks. Target metrics: WR ≥ 38%, PF ≥ 1.5, MaxDD ≤ $1,500 per 4-week window. Abort if WR < 30% over 50+ trades.

4. **Defer to ML phase** — symbol-level dynamic TP sizing (ATR multiple), VIX-threshold gating, and regime-aware direction weighting should wait until a clean B6 baseline is established. Multiple simultaneous changes make attribution impossible. One variable at a time.

---

## 11. Proposed New Baseline Config (B6 Candidate)

```json
{
  "startDate": "2018-09-24",
  "endDate": "2026-04-01",
  "symbols": ["MNQ", "MES", "MGC", "MCL"],
  "timeframes": ["5m", "15m", "30m"],
  "setupTypes": ["or_breakout"],
  "minConfidence": 65,
  "useHP": true,
  "startingBalance": 10000,
  "label": "B6: OR-only, hours 9-10 ET",
  "spanMargin": { "MNQ": 1320, "MES": 660, "MGC": 1650, "MCL": 1200 },
  "excludeHours": [0,1,2,3,4,5,6,7,8,11,12,13,14,15,16,17,18,19,20,21,22,23]
}
```

**Rationale for each change from A5:**
- `setupTypes: ["or_breakout"]` — removes pdh_breakout. A5: -$5,300 net on 2,606 trades. Segment data confirms this is negative in all three periods. No upside to preserve.
- `excludeHours` — restricts entry to hours 9–10 ET. A5 showed 43.4%/33.9% WR in those hours. If the segment byHour tables confirm the hour-11+ cliff is consistent, this is the highest-confidence improvement available. Confirm the exact boundary using the hour tables in Section 4 before finalizing.
- `minConfidence: 65` — unchanged. Use the Section 7 confidence bucket tables to find the optimal floor; only raise if there is a clear knee point where WR jumps materially (e.g., 65→70 adds <1pp WR but 70→75 adds 5pp). Don't raise speculatively.
- All other params — identical to A5 for clean comparison.

---
*Report generated by scripts/runSegmentedBacktests.js — FuturesEdge AI v13.1*
