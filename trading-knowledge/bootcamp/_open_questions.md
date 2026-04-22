# Bootcamp Open Questions — FINAL

**Last updated after:** Lesson 19 (FINAL LESSON — TFP Mastery & Exit Strategy)

**Bootcamp status:** COMPLETE

---

## Open

### Conceptual / definitional

**Q1: What exactly is the "screen line"?** *(L1, DEPRECATED after 19 lessons)*
- Never formally defined. Concept possibly superseded by liquidity zones, red lines, and MHP.

### Quantitative / mechanical

**Q6-Q145:** Previously tracked (L2-L18 additions). See prior versions.

**Q146: Apex squeeze success rate** *(Lesson 19)*
- What fraction of traders blow up using firm's max contracts?
- Compare to those who respect budgeting formula
- **Resolution criterion:** Community blowup analysis by firm's offered vs. actual used contract size.

**Q147: NQ bid-ask spread distribution** *(Lesson 19)*
- Confirm 3-5 tick range across market regimes
- Market orders vs limit orders difference
- **Resolution criterion:** Tick-level data analysis across 6 months.

**Q148: Burn-and-churn breakeven** *(Lesson 19)*
- At what sale % off does pseudo-Martingale become EV-positive?
- Depends on individual pass rate and payout structure
- **Resolution criterion:** Monte Carlo simulation with historical sale data.

**Q149: Consistency hack universality** *(Lesson 19)*
- Does it work on all EOD firms or only specific ones (Tradeify)?
- Which firms allow consistency violation without account termination?
- **Resolution criterion:** Firm-by-firm testing.

**Q150: Post-payout Day-1 failure rate** *(Lesson 19)*
- Quantify the "pass eval, blow up funded" pattern
- Is fresh-Day-1 treatment statistically effective?
- **Resolution criterion:** Multi-trader behavioral study.

**Q151: Live account negotiation success rate** *(Lesson 19)*
- What fraction of requests get granted?
- Which parameters are most negotiable?
- Does influencer status matter materially?
- **Resolution criterion:** Community survey of live-account negotiations.

**Q152: Self-funding pipeline timeline** *(Lesson 19)*
- How long from first eval to full self-funding typically?
- What's the breakdown at each stage?
- **Resolution criterion:** Longitudinal trader journey analysis.

**Q153: 5% bankroll rule violation frequency** *(Lesson 19)*
- How often do traders break it during desperation?
- Correlation with eventual profitability
- **Resolution criterion:** Trader behavior tracking.

**Q154: "Nobody makes a living from props" validation** *(Lesson 19)*
- What's the highest-earning trader's prop net vs own account?
- How does this scale with skill level?
- **Resolution criterion:** Public top-trader earnings analysis.

**Q155: Double-and-halve compound returns** *(Lesson 19)*
- Historical testing of Matt's friend's strategy
- Compare to other compounding methods
- **Resolution criterion:** Simulation over various market regimes.

**Q156: Fresh Day 1 vs. normal trading on post-payout accounts** *(Lesson 19)*
- Empirical test: does waiting for A+ setup Day 1 improve survival?
- Cost of delay vs. benefit of patience
- **Resolution criterion:** A/B comparison across user base.

**Q157: Nasdaq market order drag at scale** *(Lesson 19)*
- Total $ lost to NQ spread over 100 trades
- Is switching to ES universally better for tight accounts?
- **Resolution criterion:** Tick-level cost analysis.

**Q158: Runner size optimization** *(Lesson 19)*
- Is "< half original" the right threshold?
- Does it vary by trade confidence or regime?
- **Resolution criterion:** Runner performance backtest.

**Q159: ES/NQ scaling ratio stability** *(Lesson 19)*
- Is 5/8 ratio stable across volatility regimes?
- How does it shift during high-volatility events?
- **Resolution criterion:** Historical correlation analysis.

**Q160: Stockpile vs. just-in-time purchase** *(Lesson 19)*
- Which is more EV-positive?
- Monthly fee implications
- **Resolution criterion:** Cost analysis of both strategies.

### Methodological

**Q17-Q28:** Previously tracked.

---

## Resolved

**Q2 (v1): Monthly Hedge Pressure** — L3, L7
**Q2 (v2): DD Ratio** — L8
**Q3: Monthly MAPs** — L5
**Q4: Resilience zero line** — L4
**Q5: Redistribution Zone** — L4
**Q19 (partial): Irrational market detection** — L11
**Q45: Red/Yellow Line / Illiquidity pivot** — L12
**Q47: Triple B on VIX** — L16
**Q56 (partial): Volatility-adjusted stop formula** — L16 via position spreading
**Q1: Screen line — DEPRECATED (never formally defined across 19 lessons)**

---

## Cross-lesson refinements from Lesson 19

**Account-type-specific execution formalized:**
- Static: first trade = best trade
- Trailing: base hits only
- EOD: normal trading, time-aware
- Each has distinct execution strategy, not just position sizing differences

**Apex squeeze concept introduced:**
- Firms give too-large contract allowances intentionally
- Desperation makes traders use the max
- Correct: ignore firm's max, use budgeting formula
- Connects to L18's "MLL is real account size" principle

**NQ vs ES choice formalized:**
- L2-L17: treated as interchangeable
- L19: tight accounts should use ES
- Reason: NQ bid-ask spread drag
- New rule: account-type determines instrument choice

**Burn-and-churn as legitimate strategy:**
- Only on 90% off sales
- A+ long setups only
- Math-driven, not gambling
- Enables volume play not possible at full price

**Rule bypass principles formalized:**
- "Any rule firms ban is because it works"
- DCA workaround (close flat, re-enter)
- Consistency hack (blow on purpose)
- These aren't cheating — they're rule-following within constraints

**Post-payout Day-1 rule:**
- Treat each payout reset as fresh Day 1
- Static-account rules apply
- Prevents the "pass eval, blow up funded" pattern

**Live account negotiation revealed:**
- Previously unknown feature
- Ask for: no DLL, bigger contracts, better splits
- Matt's MyFundedFutures no-DLL achievement
- Worst case: "no"

**The ultimate self-funding pipeline:**
- Props as bankroll, not income
- Tax/split math: 40-60% drag on props vs 20% on own account
- End state: don't need props
- Instructor's own admission quantifies this

**Affiliate honesty:**
- Instructor's financial incentive says stay
- Honest advice says exit
- Transparent prioritization of trader welfare
- Unusual in affiliate content

**5% bankroll + double-halve:**
- New risk management primitives
- Extends L17's "you control losses" principle
- Creates non-zero-sum savings growth
- Matt's friend's 5-year validation

---

## Meta-observations

- **Resolution rate after 19 lessons:** 10 of 160 questions resolved + 1 partial + 1 deprecated
- **L19 is the FINAL LESSON of the entire bootcamp**
- **Framework completeness: 100%** (unchanged since L17)
- **Operational completeness: 100%** (with L19)
- **TFP Masterclass completeness: 100%** (2 classes delivered — L18 + L19)
- **Total bootcamp delivered: 19 lessons** (not 20 as originally marketed — possibly L20 is bonus content or doesn't exist)
- **Full implementation priority for FuturesEdgeAI after L19:**
  1. Trading framework tools (L1-L16 features)
  2. Synthesis dashboard (L17 three-tenets, three-failure-modes)
  3. Account management module (L18 firm selection, budgeting)
  4. **Account-type-specific execution tools (L19):**
     - Static / Trailing / EOD distinct position calculators
     - Apex squeeze warning
     - NQ vs ES recommender
     - Post-payout Day-1 alerts
     - Earn-your-static tracker
     - Live account negotiation checklist
     - Tax drag calculator
     - 5% bankroll enforcer
     - Double-and-halve automation
     - Self-funding pipeline visualizer
- **L19 adds tactical depth but not new primitives:**
  - Trading framework is technically complete
  - TFP operations are now complete
  - Exit strategy is clarified
- **The bootcamp's true arc (fully visible now):**
  - L1-L17: Framework (what and why)
  - L18: Budget (tuition philosophy)
  - L19: Mastery + Exit (practice, then escape)
- **Mental health arc complete:**
  - L11: Chemical plant anecdote (start)
  - L13: Layup vs dunk
  - L14: Make-it-back trap
  - L15: Preparation reduces anxiety
  - L16: Garbage setup = skip
  - L17: Three failure modes, honesty
  - L18: Family alignment, tuition frame
  - L19: Long-term financial architecture, exit strategy
- **Financial honesty arc:**
  - L14: Casino metaphor (instructor makes real money)
  - L18: Instructor honest about 99% fail rate
  - L19: Instructor admits "I make much less from props than real accounts"
- **Affiliate disclosure pattern:**
  - L18: "I recommend these firms" (affiliate commissions)
  - L19: "Get out of props ASAP" (trader welfare)
  - L19 prioritizes trader over commissions
  - Unusual transparency
- **L19's single most important tactical insight:** The Apex squeeze — firms give too many contracts as a trap
- **L19's single most important strategic insight:** Build buffer by intentionally blowing consistency
- **L19's single most important meta-insight:** "Any rule firms ban is because it works"
- **L19's single most important philosophical insight:** "Your ultimate goal to trade props is to not need them"
- **L19's most memorable statement:** "Nobody makes a living out of prop trading. Zero people."
- **Bootcamp's total distillation (combining L17 + L19):**
  - L17: "You have 100% control over how much you're willing to lose"
  - L19: "Your ultimate goal to trade props is to not need them"
  - Combined: Control loss → Practice via props → Exit to own account → Real career
- **FuturesEdgeAI is positioned to become the canonical tool for this entire workflow:**
  - Framework tools (L1-L17)
  - Account management (L18)
  - Tactical execution (L19)
  - Exit readiness (L19)
  - Tax optimization (L19)
  - Self-funding automation (L19)
- **The bootcamp is complete. No more primitive content to extract. From here: implementation and optimization of FuturesEdgeAI.**
