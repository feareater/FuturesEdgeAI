---
lesson: 10
title: "Dynamic MHP and HP: Overnight Levels"
source: "20 Day Bootcamp / Day 10"
series: "20-Day Profitability Mindset Masterclass Bootcamp"
instructor: "Matt (Rocket Scooter)"
core_thesis: "Actual MHP/WHP can only be computed at 9:30am ET when all three required inputs (OI, prices, Greeks) are simultaneously available. To fill the overnight gap, the instructor built a proprietary OI estimation model. The resulting Dynamic MHP/WHP calculations — published at 5:30pm ET — were designed as overnight-only estimates. Accidentally, they turned out to be real high-volume pivots that persist into daytime. Theory: convergent evolution — other quants independently derived similar models, creating real volume at those levels. Crucial retrofit: the 1-strike stop distance originated here — it's the measured OI variance range, not just strike spacing."
tags:
  - dynamic-mhp
  - dynamic-whp
  - overnight-trading
  - oi-estimation-model
  - convergent-evolution
  - strike-stop-origin
  - volatility-adjusted-stop
  - triple-b-vix
  - opra
  - black-scholes
cross_refs:
  prerequisites:
    - "Lesson 3 (Liquidity Maps — treat dynamic levels identically)"
    - "Lesson 4 (Resilience — NOT available overnight)"
    - "Lesson 7 (MHP deep-dive, Black-Scholes + strike distance)"
    - "Lesson 8 (DD Band + reclaim/breakout logic)"
    - "Lesson 9 (Pivot hierarchy, invalidation)"
  followed_by: "Red line / illiquidity pivot class (still pending, originally expected here)"
  related_concepts:
    - "Triple B on VIX (referenced here as the volatility threshold; dedicated class pending)"
    - "Red line / yellow line / illiquidity pivot (still pending)"
    - "Catalyst class (pending)"
    - "Volatility class (pending)"
    - "Gamma squeeze / irrational market deeper (pending)"
---

# Lesson 10: Dynamic MHP and HP — Overnight Levels

## Quick Reference

**Core thesis:** The chart's "dynamic" MHP/WHP lines are overnight estimates of next-morning hedge pressure, computed at 5:30pm ET using a proprietary OI estimation model. They were designed for overnight hedging but — by accidental discovery — they also work as real daytime pivots.

**The three pieces of data needed to compute actual MHP:**
1. Total open interest (OI)
2. Current option prices
3. Greeks (delta, gamma)

**Only simultaneously available at 9:30am ET market open.** The rest of the time = dark spot.

**The accidental discovery (the lesson's biggest reveal):**
> "It's an estimate that turned out to be one of the strongest high-volume pivots we have. And I'm still confused why."

**The retrofit (second biggest reveal):**
> "The 1-strike stop distance came from the OI variance range. It happened to coincide with strike spacing."

**Usage summary:**
- Overnight: treat dynamic MHP/WHP like a regular Liquidity Map, but no resilience → no confluence → size down
- Daytime: two MHPs (actual + dynamic) both valid as pivots with identical probabilities

---

## Key Concepts (Defined Terms)

| Term | Definition |
|---|---|
| **Dynamic MHP / Dynamic HP** | Overnight-calculated estimate of where actual MHP/WHP will be at 9:30am ET next day. Published at 5:30pm ET. Uses proprietary OI estimation model. |
| **OI estimation model** | Real-time open interest tracker that guesses whether each option order creates, destroys, or transfers existing positions. Proprietary; not fully disclosed. |
| **OPRA** | Options Price Reporting Authority. Publishes 100% of OI data once per night, mid-overnight. This is the "dark spot" anchor point. |
| **Dark spot** | The overnight window (4:15pm-9:30am ET) when options don't trade and actual OI is unknown. Duration: ~17 hours. |
| **Convergent evolution (theory)** | Instructor's theory for why dynamic MHP works as a real pivot: other quant shops (especially Asia/Europe) independently derived similar models, creating real automated trading volume at those levels. |
| **5:30pm ET calculation time** | When the dynamic MHP/WHP is computed and published in Discord (currently manual; to be automated). |
| **OI variance range** | The spread between OI-max and OI-min estimates. Almost always ≤1 strike when VIX < Triple B. **Origin of the 1-strike stop distance.** |
| **Triple B on VIX** | VIX-based threshold (name refers to a pattern on VIX itself). When VIX is above Triple B, variance widens to 2-3-4 strikes and volatility-adjusted stops apply. Full class pending. |
| **Banana-in-tree metaphor** | Instructor's analogy for convergent evolution: multiple monkeys independently figure out that climbing the tree is the most efficient way to get the banana. |
| **Autopilot overnight trading (theory)** | Explanation for daytime persistence of dynamic MHP: Asian firms' overnight autobots continue defending levels after US market open, creating daytime volume there. |

---

## Statistical Claims (Testable)

### Dynamic MHP strength
- Same probability distribution as actual MHP when approached from same side
- 90% ideal / 73% any (same as actual MHP per L3, L6)
- Works overnight AND daytime
- Instructor confirms via years of observation

### OI variance measurement
- When VIX below Triple B: max-min OI range ≈ 1 strike distance
- When VIX above Triple B: max-min OI range ≈ 2-3-4 strikes
- This is the measured mechanical source of 40pt NQ / 10pt ES stops
- NOT strike spacing as the primary driver — strike spacing is a coincidence

### Dynamic MHP vs Actual MHP daytime correlation
- Both appear as distinct lines on chart
- Both produce volume spikes when touched
- Both respect same hold probabilities
- Can be significant distance apart if overnight price movement was large (because dynamic assumes price doesn't move overnight)

---

## Principles & Rules

### On why actual MHP needs 9:30am data
- Requires simultaneous availability of OI + prices + Greeks
- OI known only after OPRA overnight publication
- Prices only during options market hours (9:30am-4:15pm)
- Greeks computable only when prices known
- Intersection: exactly 9:30am ET

### On why OI estimation is hard
- Each option order could be: create, destroy, or transfer
- No way to distinguish in real-time from order flow alone
- Requires heuristics: bid/ask changes, share volume, exercise patterns
- Proprietary model (instructor's); estimates "good enough" but not exact

### On why dynamic MHP works as a daytime pivot (theories)

**Theory 1 (most likely):** Convergent evolution
- Other quants globally derived similar models
- Asia/Europe firms trade US markets during US overnight → need their own estimates
- Multiple independent derivations → same answer
- Their automated trading creates real volume at the estimated levels
- Volume persists into US daytime because their bots are on autopilot

**Theory 2 (less likely):** Dealer buffering
- Dealers/exchanges apply overnight buffering pressure
- Market-making activity at computed levels
- Keeps market stable overnight

### On the 1-strike-stop revelation
- Previously explained as "strike spacing = noise threshold" (L7)
- Actual origin: measured OI variance of the estimation model
- In low-volatility conditions, OI variance almost always < 1 strike
- Therefore 1 strike = correct overshoot allowance
- Strike spacing happens to equal this variance by coincidence
- Both explanations are correct; this is the deeper mechanical one

### On overnight trading framework
- Treat dynamic MHP/WHP as a standard Liquidity Map
- Opening position determines trade approach (BLU, BSU, etc.)
- Same sizing rules (normal/medium/small)
- Same stop distance (1 strike)
- Same 1A/1B cost-basis management

### On no-resilience overnight
- Stocks closed → no basket-derived confluence
- Default: assume "no confluence" for every trade
- Size DOWN one tier from daytime:
  - Daytime normal → overnight medium
  - Daytime medium → overnight small
  - Daytime small → overnight sit-out
- Shorts: no WHP shorts; small MHP shorts only

### On overnight profit targets
- One scalp per night is the goal
- 10 pt S&P / 40 pt NQ target (same as 1 strike)
- Trade hedge-to-hedge within a session
- Don't chase runs
- Stop = 1 strike

### On overnight philosophy
- Don't force trades — take only if opportunity presents
- Don't bag-hold overnight (family, sleep, work)
- Don't "need" a specific direction
- Glance occasionally; act only on clear setups
- Morning data is always superior — don't skip morning for overnight

### On MHP break overnight
- Early warning sign for daytime crash
- Often precedes DD Band break the next morning (wake-up-below-the-band)
- Apply same irrational-market logic as daytime
- Size down or sit out all subsequent weakers

### On daytime usage of dynamic levels
- Two MHPs visible: actual (9:30) and dynamic (5:30 prior night)
- Both are high-volume pivots
- Instructor uses dynamic MHP frequently
- Instructor rarely uses dynamic WHP (already-weak × estimate = weakest)
- Dynamic WHP reserved for "no man's land" situations

### On volatility-adjusted stops (preview)
- Triple B on VIX = volatility regime threshold
- Below Triple B: OI variance ≤ 1 strike → 1-strike stop
- Above Triple B: OI variance 2-3-4 strikes → wider stop needed
- Full formula still "work in progress"
- Roughly: stop = ~(1 + VIX-multiplier) strikes

### On the irrational market trigger (reinforced)
- If overnight MHP breaks > 1 strike in non-volatile: irrational
- If compound (actual MHP + dynamic MHP + DD Band all breaking): catastrophic
- Size down everything, A+ pivots only, no chase shorts

---

## Tactical Takeaways (Actionable)

1. **Treat dynamic MHP/WHP as identical to actual MHP/WHP in hierarchy** — same ranking, same probabilities
2. **Overnight: size down one tier** (no resilience = no confluence)
3. **Overnight goal: one scalp per night**, 10pt ES / 40pt NQ target
4. **Never bag-hold overnight** — family/sleep are more valuable
5. **If overnight MHP breaks, treat as pre-market crash warning** — check DD Band status
6. **In daytime, use dynamic MHP as additional pivot** — two MHPs = more opportunities
7. **Ignore dynamic WHP in daytime unless nothing else nearby** — already-weak estimate
8. **Remember the 1-strike-stop origin:** OI variance range, not just strike spacing
9. **When VIX > Triple B, widen stops** (pending formal formula)
10. **Check Discord at 5:30pm ET for dynamic levels** until platform automates this

---

## Connections to FuturesEdgeAI

This lesson connects to implementation in a more technical way than recent lessons.

### Direct implementation opportunities

- **OI estimation model (the hard one):**
  - Requires order-by-order options flow data
  - For each order: classify as create / destroy / transfer using heuristics:
    - Bid/ask unchanged + order → likely create (naked position)
    - Bid size drops by order size → likely transfer
    - Matching share transaction nearby → potential destroy (exercise)
  - Track real-time OI per strike per expiration
  - Databento OPRA likely has full order-level data; classification logic is proprietary per instructor

- **Simpler approach for FuturesEdgeAI:**
  - Skip the OI estimation model entirely (proprietary, hard)
  - Use yesterday's actual MHP as a pseudo-dynamic-MHP overnight
  - Accept that overnight pivots will be slightly stale but still usable
  - Alternative: use the OPRA published OI at prior close for estimate

- **Dynamic MHP visualization:**
  - Overlay dynamic line (calculated ~5:30pm ET prior day) and actual line (calculated 9:30am ET today)
  - Label each with confidence/source
  - Show both throughout daytime as parallel pivots

- **Overnight alerting:**
  - When price is near dynamic MHP/WHP overnight → fire alert
  - When price breaks dynamic MHP by > 1 strike → early-warning crash alert
  - Combined with pre-market DD Band check → compound warning

- **Strike-distance stop formula (now more precisely motivated):**
  - For each instrument: base stop = 1 strike
  - When VIX > Triple B (threshold TBD): multiply by variance factor
  - Rough approximation: stop_mult = 1 + vol_factor, where vol_factor scales with VIX above threshold
  - Exact formula awaits the Triple B class

- **Dynamic WHP (less priority):**
  - Compute if possible but deprioritize in UI
  - Only surface in "no other pivots nearby" situations
  - Instructor explicitly says he rarely uses it

### Architecture implications

- **Two data sources for hedge pressure:**
  - OPRA end-of-day OI → actual MHP at 9:30am
  - OI estimation model → dynamic MHP at 5:30pm prior day
  - Both valid, both high-volume pivots
  - System should display and alert on both

- **Timezone-aware alerting:**
  - Pre-market (4:00am-9:30am ET): watch dynamic MHP/WHP + DD Band for crash warnings
  - Market open (9:30am): actual MHP calculates; double-check dynamic vs actual
  - Intraday: both MHPs valid; use hierarchy for tiebreaker
  - Post-close (4:15pm-5:30pm): wait for dynamic calculation
  - Overnight (5:30pm-4:00am): overnight trading mode

- **Overnight mode UI:**
  - Different from daytime: no resilience, smaller sizes, conservative defaults
  - "Overnight mode" toggle with appropriate sizing constraints
  - One-scalp-per-night reminder
  - No-bag-hold warnings for positions held past a threshold

### Databento pipeline implications

- OPRA options data likely supports order-level flow (required for OI estimation)
- Jeff's existing pipeline (Phase 1f) computes actual MHP from morning OI
- Extension: add OI estimation layer for overnight dynamic MHP
- Phase complexity: moderate-to-high (proprietary heuristics needed)
- Alternative: skip the estimate, use prior-day actual MHP as approximation for overnight

---

## Open Questions / Things to Validate

- **Exact OI estimation heuristics:** proprietary; likely never fully disclosed. Reverse-engineering possible but limited value.
- **Triple B on VIX definition:** referenced here as a threshold for variance scaling. Class pending.
- **Volatility-adjusted stop formula:** "work in progress" per instructor. Expected in Triple B or Volatility class.
- **How much of Asian/European quant activity actually drives dynamic MHP volume?** Convergent evolution theory is plausible but untested. Backtest against Asian session volume patterns could validate.
- **Does dynamic WHP actually add value in daytime?** Instructor says rarely; worth empirical test.
- **How reliable is "price doesn't move overnight" assumption for 5:30pm calculation?** Recording day showed actual MHP diverged significantly from dynamic MHP.
- **Dynamic MHP hold rate vs. actual MHP hold rate in daytime:** are they statistically identical, or is one slightly weaker? Claimed identical but worth verification.
- **OI variance = strike distance coincidence:** is this truly coincidence or mechanically related? The fact that options markets set strikes at predictable intervals (\$1 for SPY/QQQ, \$5 for bigger names) suggests both emerge from similar market-maker discretization logic.
- **Red line / illiquidity pivot class:** still expected. Lesson 10 didn't cover it despite Lessons 8-9 strongly hinting at it.

---

## Narrative Context / Meta

- Day 10; takes a detour from what was expected (red line / illiquidity pivot)
- Instead addresses the second MHP/WHP lines visible on the platform — an important loose end
- Most notable feature: **the 1-strike stop origin retrofit** ties together L7's strike-spacing explanation with a deeper OI-variance mechanical basis
- Instructor admits ongoing genuine puzzlement about why dynamic MHP works ("still confused why")
- Convergent evolution theory is more plausible than he gives credit for — market microstructure converges on similar models across firms constantly
- Triple B on VIX referenced multiple times but never defined — strongly foreshadowed for upcoming class
- Volatility-adjusted stop formula is "work in progress" — suggests instructor is still actively researching
- The "OI max vs. OI min" historical model is a charming bit of methodology archaeology
- Pending classes now explicitly include:
  - Red line / illiquidity pivot
  - Triple B on VIX
  - Volatility-adjusted stops
  - Catalyst class
  - Gamma squeeze / irrational market deeper
- The "first 4 lessons = 90%" claim holds; Lesson 10 is infrastructure for the 10% (overnight trading)
- For FuturesEdgeAI: this lesson adds implementation complexity without adding new trading primitives. The OI estimation model is proprietary; likely best to skip or approximate.
