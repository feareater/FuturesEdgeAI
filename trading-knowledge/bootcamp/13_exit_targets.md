---
lesson: 13
title: "Exit Targets"
source: "20 Day Bootcamp / Day 13"
series: "20-Day Profitability Mindset Masterclass Bootcamp"
instructor: "Matt (Rocket Scooter)"
core_thesis: "Every entry demands a planned exit. The unifying concept is the 'interrupt' — any level that produces volume. At every interrupt, trim some portion of the position; the amount scales inversely with your confidence in continuation. The 'more than half' rule at retraces exploits the up-half/down-half rebalancing mechanism — trimming >50% at the midpoint locks in profit regardless of direction. Short trades require hard-exit discipline (markets fall like elevators, rise like escalators). Yellow lines are exited fully because their coin-flip odds combine with asymmetric loss magnitude (don't pick up pennies in front of a steamroller). VIX rising = trim even without price interrupts because the liquidity glass is thinning underneath. The lesson ends with an unexpected philosophical wrap-up: find your layup, not the dunk — master one setup rather than the full toolkit."
tags:
  - exit-targets
  - interrupts
  - more-than-half-rule
  - digging-pattern
  - gap-fills
  - zone-boundaries
  - short-trade-asymmetry
  - escalator-elevator
  - pennies-steamroller
  - vix-as-interrupt
  - squid-game-glass-metaphor
  - find-your-layup
  - trade-checklist
  - rr-discipline
cross_refs:
  prerequisites:
    - "Lesson 2 (Position sizing)"
    - "Lesson 3 (Liquidity Maps — setup handout with tip-of-arrow exits)"
    - "Lesson 7 (Cost basis management, 1A/1B)"
    - "Lesson 8 (DD Band, reclaim vs. retest)"
    - "Lesson 9 (Pivot hierarchy, invalidation)"
    - "Lesson 11 (Irrational rules)"
    - "Lesson 12 (Red/Yellow lines, anchor points)"
  followed_by: "Lesson 14 — Trade Plan Mastery (referenced in L12); VIX / Triple B class (still pending)"
  related_concepts:
    - "Triple B on VIX (still pending)"
    - "VIX liquidity map (preview covered here)"
    - "Volatility-adjusted stop formula (still pending)"
---

# Lesson 13: Exit Targets

## Quick Reference

**Core thesis:** Every interrupt demands a trim. The amount depends on probability against you.

**The exit hierarchy:**

| Interrupt | Hold rate | Exit amount |
|---|---|---|
| DD Band (opposing) | 88/96/92% | Exit 8-9 of 10 |
| MHP / dynamic MHP | 90% ideal | Exit 8 of 10 with favorable confluence |
| Bull/Bear Zone boundary (opposing) | 90% ideal | Exit 8 of 10 |
| Gap fill | Unquantified; 50/50 assumed | Exit more than half |
| WHP (opposing) | 80% ideal | Exit 6-7 of 10 |
| Red line / Yellow line | No stats; 50/50 | **Exit fully** |
| VIX pivoting up | No price level | Trim 50%+ as regime warning |
| Half-gap | Variable | Trim per resilience |

**Most important operational rules:**

> "More than half at every interrupt. The market moves up-half, down-half. Half-trim = break even; more than half = locked profit."

> "Long trades = escalator up. Short trades = elevator down. Short hard at first interrupt."

> "Don't pick up pennies in front of a steamroller." (Yellow lines specifically)

> "Find your layup, not the dunk. Master one setup, not the full toolkit."

**Trade checklist structure:**
1. Should I trade? (rational/irrational check)
2. Long or short? (Greater Market + confluence)
3. Entry location(s) — 1A + 1B planning
4. Exit location(s) — THIS LESSON
5. Add location — dig pattern
6. Stop location
7. R:R math
8. Volatility adjustment
9. Final sanity check

---

## Key Concepts (Defined Terms)

| Term | Definition |
|---|---|
| **Interrupt** | Any level that predictably produces volume. Includes all pivots (MHP, zones, DD Band, red/yellow lines, gap fills) plus the new concept of VIX rising. |
| **More-than-half rule** | Must trim MORE than half of position at a retrace/interrupt. Half-trim breaks even at rebalancing midpoint; more-than-half locks in profit regardless of direction. |
| **Digging pattern** | 1 + N entry structure where second entry is larger. Example: 1 contract + 3 more = 4 total, breakeven = 1/5 of the way up from 1B. |
| **Gap fill** | When price returns ONE time to a previous close level. Overshoot, wick, partial body all count. "Forget candlestick nonsense." |
| **Opposing wall** | Zone boundary on the far side of the current trade (e.g., BRZT when long from BZB). Exit target at 10%-break-odds. |
| **Escalator-elevator rule** | Markets rise slowly (grind up), fall fast (crash). Long trades allow staged exits; short trades demand hard exits at first interrupt. |
| **Pennies-in-front-of-steamroller** | Trading through yellow lines / coin-flip pivots where occasional gains are small but occasional losses are catastrophic. Don't do it. |
| **Squid Game glass metaphor** | Low VIX = 4 one-inch panes stacked = 4-inch solid floor. High VIX = 4 panes spread apart = thin layers that break through. Same selling force, different outcomes. |
| **VIX as interrupt** | When VIX pivots higher during your long, trim — even with no price interrupt present. The liquidity floor is thinning. |
| **R:R discipline** | Reward distance ÷ risk distance. Don't take R:R < 1:1 unless extreme confluence. If 5pts from yellow line with 10pt stop = skip or scalp-size. |
| **Layup vs. dunk** | Trading philosophy: master ONE setup deeply (layup) rather than attempting the full toolkit (dunk). |
| **Retest principle** | After breaking into new zone/territory, wait for retest back to boundary before entering. Low probability, small position. |
| **Stacked probability** | P(break pivot 1) × P(break pivot 2) = much lower than either alone. Justifies digging. (10% × 10% = 1%) |

---

## Statistical Claims (Testable)

### Exit target confluence mapping

| Setup | Standard exit % (of 10 position) | With favorable confluence | Against-confluence |
|---|---|---|---|
| MHP / DD Band / Zone boundary | 8 | 2-3 | 10 (all) |
| WHP | 6-7 | 1-2 | 10 (all) |
| Red/Yellow line | 10 (all) | N/A | 10 (all) |
| Half-gap | Variable | Trim small | Trim most |

### Stacked probability at sequential pivots
- P(break pivot 1 @ 90%) = 10%
- P(break pivot 2 @ 90% | pivot 1 broken) ≈ 10%
- P(both break) = ~1%
- Justifies heavier second-entry sizing (the dig)

### Short trade asymmetry
- Long trade = exit at 1A pivot, scale out at each subsequent
- Short trade = exit 80-100% at FIRST interrupt, small-or-none runners
- Rationale: markets fall 3x faster than they rise; squeeze risk asymmetric

### Second-short sizing rule
- First short: 10 contracts (baseline)
- Second short after break + retest: 1-2 contracts max
- Extreme confluence exception: up to 5
- NEVER double/triple the second entry (newbie trap)

### Yellow line behavior (observational, 2-year window)
- Instructor shows multiple examples: "yes, yes, yes, no, no, yes, no"
- Qualitatively coin flip (50/50)
- Magnitude-asymmetric losses when wrong
- Net EV negative due to magnitude asymmetry

### Gap fill persistence
- Months to years common
- Instructor example: May 2024 gap filled 6+ months later (Dec 2024)
- Persists until first touch of close level
- One touch = filled forever

---

## Principles & Rules

### On interrupts
- Any level that produces volume = interrupt
- You MUST trim some amount at every interrupt
- Amount scales inversely with confidence in continuation

### On the more-than-half rule
- Markets rebalance via up-half/down-half cycles
- Buy imbalance pushes up; dealers sell back; price finds sellers halfway
- Half-trim at retrace = break even
- More-than-half-trim = locked profit
- Mechanical, not arbitrary

### On digging
- 1A + 1B (larger) = cost-basis advantage
- 1 + 3 = breakeven at 1/5 up from 1B
- Reason it's not "adding to a loser": stacked probability math
- Only dig if structure is valid (L9 invalidation framework)

### On gap fills
- Draw line at previous close
- Gap filled on ONE touch (any form)
- Forget candlestick TA rules about partial fills
- Persists indefinitely until touched
- Exit target value at gap fill = trim 50%+

### On opposing walls
- Zones have ~10% breakout rate
- Crossing opposing wall = low probability
- Exit most at wall
- If holding runner through, treat post-break as SEPARATE trade

### On DD Band exits
- 88% inside (upper 96% / lower 92%)
- Exit 8-9 of 10 contracts at band
- Runner only if confluent
- Post-break: low-probability territory, SMALL re-entry

### On MHP/HP exits
- 90%/73% MHP hold
- With favorable confluence: exit 8 of 10 (close most)
- With unfavorable confluence: exit ALL
- On reclaim-break-reclaim sequence: scale back in small

### On red/yellow line exits
- No published stats → 50/50 assumption
- Exit fully at them
- Don't chase through (coin flip + volatility)
- No digging on red line breaks
- Yellow line exit = hard rule; no debate

### On VIX rising as interrupt (new)
- Volatility regime change = selling-force amplification
- Glass-panes-spread metaphor
- Even with no price pivot → trim when VIX pivots up
- When VIX is decaying: hold runners, allow larger positions

### On short-trade discipline
- "Escalator up, elevator down"
- Shorts are lower-probability in bull regimes
- Close most/all at first interrupt
- Don't scale out slowly
- Second short = SMALLER, not bigger
- If first short missed: don't chase second leg (newbie trap)

### On the one-contract thought experiment
- If you can only trade 1 contract:
  - Wait for A+ setups only (90%+)
  - Bull markets only
  - Strong pivots only (MHP, BZB, BRZT, DD Band)
  - No shorts
  - Avoid VIX > Triple B
- Futures advantage: subdivide to micros/nanos for staged positioning
- Instructor personal: "I wouldn't trade with one contract"

### On the R:R discipline
- Always compute reward ÷ risk before entry
- < 1:1 = skip or scalp-size
- Example: 5pts from yellow line with 10pt stop = 0.5:1 → skip

### On pennies in front of a steamroller
- Small gains + rare catastrophic losses = negative EV
- Applies to:
  - Yellow line trades
  - Option premium selling
  - Any coin-flip with magnitude asymmetry
- Keith (instructor's friend, annuities/fixed-income trader): origin

### On finding your layup (philosophy)
- Master ONE setup rather than full toolkit
- Community examples:
  - Some only trade liquidity pockets
  - Others only trade DD Band
  - Others only trade MHP
- Not everyone can trade everything
- Know when to retreat to specialty
- Build confidence in layup → branch slowly → retreat when branches fail

### On mental health (continuing from L11)
- Reddit anecdote: 150 evals, 10 funded, suicidal
- "Not your destiny"
- Highest failure rate of any profession
- Look in mirror: "I can't do X, and that's okay"
- Treat trading like college (4 years minimum)
- Know quickly when something's not working

### On quick-no, slow-yes
- 5-7 trades enough to know a setup DOESN'T work for you
- 20-30+ trades needed to confirm something DOES work
- Dating analogy
- Don't force yes decisions

---

## Tactical Takeaways (Actionable)

1. **Every interrupt = mandatory trim.** No exceptions.
2. **Trim MORE than half at retraces** — not exactly half.
3. **Dig pattern: 1 + 3 or 2 + 5** — second entry always larger than first.
4. **Close ALL at yellow lines** — no debate, no partial.
5. **Close MOST at DD Band** — 8-9 of 10, hold runner only with confluence.
6. **Short-trade exits are hard-and-fast** — 80%+ at first interrupt.
7. **Second short after break: SMALLER** (1-2 max, not more).
8. **VIX rising = trim longs** even without price interrupt.
9. **Gap fills are one-touch events** — ignore traditional TA "partial fill" concepts.
10. **Skip trades with R:R < 1:1** unless extreme confluence.
11. **Master ONE setup first** — find your layup before attempting dunks.
12. **If it's not working in 5-7 trades, it's probably not for you.**

---

## Connections to FuturesEdgeAI

Lesson 13 formalizes the exit-side of trade logic. This pairs with entries to complete the full-trade-plan engine.

### Direct implementation opportunities

- **Exit alert engine:**
  - For each active position, compute distance to ALL nearby interrupts
  - List: gap fills, zone boundaries, DD Band, MHP, dynamic MHP, WHP, red/yellow lines, VIX pivots
  - Priority rank by distance
  - Show suggested exit % based on confluence (inverse of entry sizing engine)

- **More-than-half trimmer:**
  - On 1B retrace-to-midpoint detection → alert "trim > 50%"
  - Pre-calculate: "Close 3 of 4 to lock $X profit"
  - Show break-even math inline

- **Digging pattern builder:**
  - User selects 1A location + 1B location
  - Auto-calc breakeven fraction = 1 / (1 + N)
  - Suggest optimal N based on stacked probability
  - Example output: "1 at 6050 + 3 at 6010 → breakeven at 6015"

- **Gap fill tracker:**
  - Daily close-to-next-open gaps automatically drawn
  - Persistent until touched (single touch = filled)
  - Maintain history dating back months/years
  - Overlay on chart as faint lines
  - Alert when price approaches unfilled gap

- **Short-trade auto-aggressor:**
  - Detect short position + first interrupt approach
  - Suggest: "Exit 80%+ at this level (short-trade discipline)"
  - If user holds through: warn about squeeze risk
  - Post-break: auto-reduce suggested second-short size to 1-2 max

- **VIX overlay:**
  - Track VIX pivot state (rising / falling / flat)
  - When user has open long + VIX pivots up → trim alert
  - Squid Game glass visualization (optional educational)

- **R:R computer:**
  - Before every entry: compute reward_pts / risk_pts
  - If < 1:1 → warning
  - Require confluence justification override OR size reduction

- **Yellow line hard-exit enforcer:**
  - Detect long position + yellow line approach
  - Pre-calculate exit
  - On touch: confirm "full exit at yellow line"
  - Disable "hold runner" option (against policy)

- **Layup specialization tracker:**
  - Track which setups each user trades most
  - Identify their "layup" setup
  - Compare win rate: layup vs. exploration setups
  - Recommend: "Focus on [X] — your win rate is significantly higher"
  - Optional: warn on entry to low-win-rate (exploration) setup during losing streaks

### Architecture implications

- **Exit engine is the mirror of entry engine.** Same confluence inputs, same position sizing principles, inverted application.
- **Gap-fill database** adds persistent-pivot layer (like red/yellow lines).
- **VIX integration** is foundational for many exit rules; needs live VIX data stream.
- **Trade checklist wizard** — 9 steps, guided flow for every entry decision.

### Historical pattern recognition
- Gap-fill persistence analysis: backtest how long gaps typically last
- Digging pattern EV: measure actual P&L of 1+3 vs 1+1 vs single entry
- Short-vs-long asymmetry: measure time-in-trade for each

---

## Open Questions / Things to Validate

- **Gap fill EV:** frequency distribution of gap fills — how often does a newly formed gap get filled within N days?
- **More-than-half rule mechanical justification:** up-half/down-half pattern — is this universally true or regime-dependent?
- **Short-trade exit optimality:** is "exit 80%+ at first interrupt" actually optimal vs. staged exits in bear markets?
- **Yellow line loss magnitude distribution:** quantify the asymmetry that justifies full-exit rule.
- **VIX-pivot-as-interrupt threshold:** how much VIX movement triggers the trim rule? No specific number given.
- **Layup identification algorithm:** can we identify each user's best setup from historical trade data?
- **1A/1B EV at various N values:** is 1+3 optimal, or does 1+4, 1+5, 2+3 outperform?
- **Stacked probability assumption validity:** is 90% × 90% = 1% literally true, or are pivots correlated?
- **Triple B on VIX — STILL pending** (Q47)
- **Volatility-adjusted stop — STILL pending** (Q56)

---

## Narrative Context / Meta

- Day 13; the Exit Target class explicitly previewed at the end of L12
- Surprising: instructor calls this "the last lesson" at line 164 despite L12 previewing L14 (Trade Plan Mastery)
- Interpretation: L13 is the last CONCEPTUAL lesson of the core arc; L14+ may be synthesis/Q&A/live demonstrations
- Triple B on VIX + VIX class still outstanding promises (instructor alludes to pending class multiple times)
- Instructor delivers unexpectedly personal philosophical wrap-up at the end
- **"Find your layup, not the dunk"** — a new meta-principle not taught before
- Reinforces mental-health framing from L11: "Look in the mirror. Say you can't do this if you can't."
- Reddit anecdote (suicidal trader) shows instructor's genuine concern
- Keith's steamroller quote is instructor's most concise risk-management aphorism
- "Quick no, slow yes" dating analogy applied to trading paths
- The framework is now functionally complete:
  - Entries: L3 (Liquidity Maps), L7 (1A/1B)
  - Confluences: L4 (Resilience), L6 (COT), L8 (DD Ratio)
  - Stops: L2 (RI), L10 (OI variance)
  - Exits: L13 (THIS) ← mirrors entries
  - Invalidation: L9 (pivot hierarchy), L11 (irrational rules)
  - Futures mechanics: L12 (circuit breakers, IOP)
- **Only major remaining topic: VIX / Triple B class**
- Expected future content: L14 (Trade Plan Mastery — synthesis), L15+ possibly VIX class, possibly Q&A
- "First 4 lessons = 90%" still holds; L5-L13 added depth and breadth without contradicting the core
