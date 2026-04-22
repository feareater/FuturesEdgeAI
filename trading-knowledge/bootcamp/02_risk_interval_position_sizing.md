---
lesson: 2
title: "Risk Interval — Why 20 Days Matters — Position Sizing"
source: "20 Day Bootcamp / Day 2"
series: "20-Day Profitability Mindset Masterclass Bootcamp"
instructor: "Matt (Rocket Scooter)"
core_thesis: "The market moves in calculable waves (Risk Intervals) derived from CME margin requirements. A simple position sizing equation built on this ensures you survive 20 consecutive losing days with half your account intact, mathematically defeating account blowup."
tags:
  - position-sizing
  - risk-interval
  - margin-requirements
  - structure
  - greater-market
  - prop-accounts
  - dd-band
  - cme-span
  - mathematics
cross_refs:
  prerequisites:
    - "Lesson 1 (Edge in Probabilities — establishes Blind Monkey, why long-bias matters)"
  followed_by: "Lesson 3 (Liquidity Maps / Monthly MAPs)"
  related_concepts:
    - "Greater Market (introduced Lesson 1, formalized here as 3 indicators)"
    - "DD Band (one of three RocketScooter strong pivots, derived from RI)"
    - "Liquidity Pockets (one-strike scalp setups, mentioned for Lesson on liquidity maps)"
    - "Catalysts (event-driven RI breaks)"
    - "Monthly Hedge Pressure (MHP) — formal definition deferred"
    - "Monthly MAPs — formal definition deferred"
---

# Lesson 2: Risk Interval — Why 20 Days Matters — Position Sizing

## Quick Reference

**Core thesis:** Markets oscillate within a *calculable distance* (the Risk Interval) derived from CME margin requirements. A position sizing equation built around this distance — `NetLiq / (1.1 × InitialMargin)` — ensures you can survive 20 consecutive losing days with ≥50% of your account intact. Position sizing is identified as the most important class in the bootcamp.

**Most important equation in the lesson:**
```
position_size = NetLiq / (1.1 × InitialMargin)
```

**Most important quote:**
> "You can always control how much money you're going to lose. The only way you ever blow up an account is if you chose to."

**The four-tier position scale (formalized):**
- **N (Normal)** — max position, taken with full confluence
- **M (Medium)** — half of N
- **S (Small)** — 1/10 of N
- **0 (Sit-out)** — no trade

For **longs**: lose confluence → step down a tier. For **shorts**: lose confluence → sit out (Blind Monkey rule from Lesson 1).

---

## Key Concepts (Defined Terms)

| Term | Definition |
|---|---|
| **Risk Interval (RI)** | The calculable distance the market tends to move in a single "wave" or step-change. Derived from CME SPAN margin requirements. Represents the gap between where institutional buyers and sellers are positioned. |
| **CME SPAN / SPAN2** | CME Group's risk model that sets margin requirements based on reported positions of all reportable entities. The instructor claims to have reverse-engineered this to compute RI for any contract. |
| **Initial Margin** | The minimum capital required by the exchange to open a futures position. As of recording: NQ = $33,400; ES ≈ $23,000. |
| **Maintenance Margin** | The minimum capital required to keep an open position. The 1.1 multiplier in the position sizing equation accounts for the initial/maintenance ratio. |
| **NetLiq** | Net liquidation value of the account — total cash + open position value. |
| **Catalyst event** | What happens when the market moves more than 1 RI on a single event without pausing — volume spikes, the tracking algorithm's feedback loop diverges, the "spring snaps" and the market can cascade. |
| **Autopilot / tracking algorithm** | Mental model for how futures track the underlying spot price (NDX, etc.). Like an aircraft autopilot correcting for crosswind. The "master algorithm" that conspiracy traders talk about, but mundane. |
| **DD Band** | RocketScooter indicator: futures close ± 1 RI plotted as a band. Statistical: 4% close above, 8% close below, 88% close inside. Acts as a high-volume pivot. |
| **Greater Market signal** | Composite bullish/bearish read from 3 indicators: (1) ratio > 0.5, (2) S&P above Monthly Hedge Pressure, (3) Monthly MAPs bullish. **Asymmetric:** any 1 bullish = bullish overall. |
| **Monthly Hedge Pressure (MHP)** | Indicator referenced repeatedly. Specific computation deferred to a later class. |
| **Monthly MAPs** | Liquidity / structure indicator at the monthly level. Specific computation deferred to a later class. |
| **Confluence** | Agreement between multiple indicators supporting a setup. Position size scales with confluence count. |
| **Catalyst day** | A day with major scheduled events (CPI, PPI, Fed) capable of producing 1-RI moves. The 5-catalyst-in-a-row scenario is the worst case the equation is designed to survive. |
| **Strike-distance stop** | Conventional non-volatile-environment stop: 10pt for ES, 40pt for NQ. Matches SPY/QQQ option strike spacing. |
| **Hard breach (props)** | Total drawdown that fails the prop account permanently. |
| **Soft breach (props)** | Daily drawdown that pauses or fails the day. |
| **Churn-and-burn (props)** | Strategy of accepting account blowups as a cost of doing business when expected payout vastly exceeds account cost. |

---

## Statistical Claims (Testable)

### Risk Interval (Dec 2025 / lesson recording date)
| Contract | Initial Margin (long) | Risk Interval | Strike-distance Stop |
|---|---|---|---|
| NQ (E-mini Nasdaq) | $33,400 | 230 pts | 40 pts |
| ES (E-mini S&P) | ~$23,000 | $61.50 | 10 pts |

*RI scales proportionally with margin requirement; recompute daily.*

### DD Band (close ± 1 RI)
| Outcome | Probability |
|---|---|
| Close inside the band | 88% |
| Close above upper band | 4% |
| Close below lower band | 8% |

### Position sizing equation outcomes
| Scenario | Account remaining |
|---|---|
| 20 consecutive single-strike-stop losses | ≥50% |
| 5 consecutive 1-RI catalyst losses | ≥50% (≈12.5% loss per trade) |
| 34 consecutive single-strike-stop losses (claimed from sheet) | ≥50% |

### Win-rate vs. R:R math
- 1:1 R:R + win rate > 50% → profitable
- 1:1 R:R + win rate < 50% → losing
- Instructor claims most trades are 1:1 to 1.5:1; high-probability setups (Liquidity Pockets) deliver the win rate edge

---

## Principles & Rules

### On structure
- Margin requirements are the single most important number in futures
- They define the *natural step distance* of the market
- The market oscillates in RI-sized waves; bigger moves come in multiples of RI with pauses between
- Moving > 1 RI without pause = the autopilot loses its tracking → catalyst cascade

### On the position sizing equation
- `NetLiq / (1.1 × InitialMargin)` defines max contracts (Normal)
- This is conservative; many retail traders trade 3-10× this size
- The equation is **self-governing**: as margin requirements change with volatility, position size scales appropriately
- Zeno's paradox protects you: half of half of half is never zero. You cannot blow up if you follow this rigidly.

### On stop conventions
- ES default stop = 10 pts (one SPY strike)
- NQ default stop = 40 pts (one QQQ strike)
- Markets move strike-to-strike on the options side, RI-to-RI on the futures side, in tandem
- These distances tell you you're "wrong" in non-volatile conditions

### On the Greater Market (asymmetric)
- Three indicators: ratio > 0.5, S&P > MHP, monthly MAPs bullish
- **Any 1 bullish = bullish overall** (Blind Monkey rule applied to regime)
- Requires *all three* bearish to call bearish
- "It takes a lot to convince me not to be a bull"

### On 1:1 risk-reward
- Common belief that 2:1 / 3:1 is required is wrong
- High win rate setups make 1:1 highly profitable
- "Made a career out of 1:1 base hits, 100%"
- Less time in the market = less exposure to randomness

### On prop accounts (separate playbook)
- Treat your prop budget as already spent the moment you allocate it
- Calculate trades-per-day allowance from `monthly_budget / account_cost × 20`
- Default rules of thumb: 3 days to hard breach, 2 trades/day to soft breach
- Most prop accounts on offer are over-allocated (they give you 10-15 NQ contracts because they want you to use them)
- True NQ prop position cap ≈ 2 contracts under proper sizing
- **Never copy-trade prop accounts** — split entries across accounts; provides martingale-like protection because prop opportunity cost is asymmetric ($10-100 cost for $80K payout potential)

### On personal sizing freedom
- The equation is the *conservative max*
- The "kick in the stomach" method is the *acceptable max from a personal-pain perspective*
- The instructor over-leverages himself ~3× the equation but does so consciously and accepts the risk
- "I'm never in a position where I'll ever lose an account in a single day in a single trade"

---

## Tactical Takeaways (Actionable)

1. **Calculate your RI** for whatever contract you trade: pull initial margin from CME → divide by margin lookup table → get RI. (Or use RocketScooter's daily 5:30pm refresh.)
2. **Compute your equation-based normal:** `floor(NetLiq / (1.1 × InitialMargin))`. This is your conservative N.
3. **Default stops:** 10pt ES, 40pt NQ. Don't deviate without reason.
4. **Use the four-tier scale** (N/M/S/0) tied to confluence count. Only N when full confluence; sit out shorts that lack full confluence.
5. **Run Greater Market check before any trade:** if any of 3 signals is bullish, bias long. Only call bearish on full 0/3.
6. **For props specifically:** budget-first sizing, never copy-trade across accounts, expect to blow up some on purpose, optimize for net positive across many small accounts.
7. **Daily P&L bracket:** establish a hard "stop trading" loss limit (~12.5% of account is the survivable max). The instructor uses ~$10K on his $100K account.
8. **For RI-based catalysts (CPI/PPI/Fed):** assume a 1-RI move is the floor, not the ceiling. Either size to survive the move with stop-out, or sit out around scheduled events.
9. **Don't fight the equation by adding more contracts because it "feels small"** — that's exactly the trap most retail traders fall into.

---

## Connections to FuturesEdgeAI

This lesson contains **the most directly implementable content yet** — RI is a closed-form computation from publicly available CME data, and could become a first-class object in the system.

- **Risk Interval as a system primitive:**
  - Add an `RI` calculator that consumes CME margin data daily (perhaps via SPAN endpoint) and emits per-contract RI for MES, MNQ, MGC, MCL.
  - Surface RI in the dashboard as a structural reference line, similar to VWAP or pivot bands.
  - The DD Band (close ± RI) is a directly chartable indicator with strong baseline statistics (88% inside) — candidate for a setup category.

- **DD Band setup family:**
  - "Long off lower DD Band reclaim" / "Short off upper DD Band rejection" are testable hypotheses.
  - Backtest claim: 88% close inside / 8% below / 4% above. If MES/MNQ data validates these, the band edges become high-conviction mean-reversion zones.
  - Combine with existing breadth/timeframe caches for confluence scoring.

- **RI-overshoot as a catalyst signal:**
  - Detect when price exceeds 1 RI from prior reference without pause → flag as catalyst regime.
  - This could be a *risk-off* signal for the live alerting system: when RI is exceeded without pause, suppress new trade entries until volume normalizes.

- **Position sizing engine:**
  - The equation `NetLiq / (1.1 × InitialMargin)` is trivial to implement as a pre-trade size recommendation.
  - Hooks: account size input → margin lookup → recommended N/M/S contracts.
  - Validation guardrail: refuse to send alerts whose implied position size exceeds the equation result by more than the user's chosen leverage multiplier.

- **Strike-distance stop convention as setup metadata:**
  - 10pt ES / 40pt NQ as defaults; could be hardcoded as the "non-volatile baseline stop" for those contracts.
  - For MGC and MCL, derive analogous strike spacings from GLD/USO option chains.

- **Greater Market regime filter:**
  - Three-component signal (ratio > 0.5, ES > MHP, monthly MAPs bullish).
  - Implementable once MHP and Monthly MAPs are defined in later lessons.
  - **Asymmetric scoring** is the key implementation detail: bullish if `count_bullish ≥ 1`, bearish only if `count_bullish == 0`. Don't accidentally implement majority voting.

- **R:R defaulting:**
  - System currently may target higher R:R; this lesson argues 1:1 with high win rate is preferable.
  - Could expose R:R as a per-setup configurable parameter; the OR breakout setup already showed promise restricted to early hours — that's a high-win-rate / 1:1 candidate.

- **Backtest engine integration:**
  - The "20 days of consecutive losses leaves ≥50% account" claim is directly testable: simulate 20 consecutive max-stop losses against the equation-derived position size and verify the math.
  - The 5-catalyst-loss claim (≥50% remaining) is similarly testable.

- **Prop account methodology** is largely orthogonal to the current FuturesEdgeAI scope (which appears focused on real-money trading), but the sizing calculator concept could be adapted for prop users as a mode toggle if Jeff ever extends to that audience.

---

## Open Questions / Things to Validate

- **CME SPAN margin data ingestion:** Confirm whether SPAN data is freely accessible programmatically, or if RocketScooter is using a scraping/manual approach. If accessible, RI becomes auto-computable in FuturesEdgeAI.
- **DD Band statistics (88/8/4):** Verify against MES and MNQ historical data. Does the claim hold cross-contract? Does it hold across regimes (high VIX vs low VIX)?
- **The 1.1 multiplier:** Why exactly 1.1? Initial-vs-maintenance ratio depends on the broker and changes over time. Worth checking whether 1.1 is a CME constant or a heuristic.
- **MHP and Monthly MAPs:** Both referenced as foundational but not yet defined. Track these — they're the missing pieces for implementing the Greater Market regime filter.
- **Strike-distance stops on MGC/MCL:** The 10pt ES / 40pt NQ rule maps to SPY/QQQ option strikes. What's the equivalent for gold and oil? GLD strikes are typically $1; USO strikes typically $0.50. Does that translate to MGC = ~$10/oz and MCL = ~$0.50/bbl? Worth deriving and testing.
- **"5 catalyst losses" claim:** What counts as a "catalyst loss"? If the trader is sized to 1-RI moves, the equation guarantees ≥50% remaining after 5 such losses. But a *bigger-than-1-RI* event would breach this. Catalyst-day sit-out rule is the safety net.
- **RI changing daily:** RocketScooter recomputes at 5:30pm. If FuturesEdgeAI adopts RI, define the snapshot timing. Stale RI values could mis-size trades after a margin change.
- **"Reverse-engineered SPAN" legitimacy:** The instructor claims to have reverse-engineered the SPAN model. Worth understanding whether his RI computation is documented anywhere or is proprietary. If proprietary and he's open about it, the actual formula may need to be derived independently.

---

## Narrative Context / Meta

- Day 2; explicitly flagged in Lesson 1 as "the most important class we teach."
- First lesson with substantive math and a directly-usable equation.
- Introduces the Discord materials: a CME Group link and two Google Sheets (the position sizing calculators — one for real accounts, one for props). Worth grabbing if accessible.
- The instructor uses his own NinjaTrader $100K account live as the worked example throughout.
- Establishes the broader pattern: each future lesson will introduce one structural element (RI, DD Band, Liquidity Pockets, MHP, Monthly MAPs) — all derived from market mechanics, all eventually composing into the full RocketScooter framework.
- Lesson 3 announced as "liquidity maps."
