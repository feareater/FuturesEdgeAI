# CLAUDE.md — Bootcamp Knowledge Base

This folder contains the structured reference material derived from Jeff's 19-lesson "Blind Monkey" trading bootcamp (the same material available in the Claude.ai FuturesEdgeAI Project). Use this file to orient when working with bootcamp content.

## What This Is

The bootcamp is a complete systematic trading framework built by an instructor who goes by "Rocket Scooter." It's the conceptual foundation for FuturesEdgeAI. Every major feature in the app is designed to operationalize a specific tool or principle from these lessons.

The framework's core paradigm: **price is random, volume is predictable via options positioning.** Liquidity Maps, Monthly Hedge Pressure, and related tools all derive from this insight.

## File Structure

```
bootcamp/
├── CLAUDE.md                          ← you are here
├── PLAIN_ENGLISH_SUMMARY.md           ← non-trader overview of the whole bootcamp
├── _glossary.md                       ← ~220 defined terms + 40+ appendices (numerical refs, rule tables)
├── _open_questions.md                 ← 160 testable hypotheses across the framework
├── 01_edge_in_probabilities_blind_monkey.md
├── 02_risk_interval_position_sizing.md
├── 03_liquidity_maps.md
├── 04_resilience.md
├── 05_monthly_maps.md
├── 06_bull_bear_setups_cot.md
├── 07_monthly_hedge_pressure.md
├── 08_dd_ratio_dd_bands.md
├── 09_speed_preparedness_execution.md
├── 10_dynamic_mhp_overnight_levels.md
├── 11_irrational_rules.md
├── 12_illiquidity_pivots_futures_mechanics.md
├── 13_exit_targets.md
├── 14_every_single_time.md
├── 15_pre_market_techniques.md
├── 16_vix_masterclass_bbb_vvix.md
├── 17_blind_monkey_saga_final.md       ← bootcamp capstone (three tenets, three failure modes)
├── 18_trader_funding_programs_budgeting.md
└── 19_tfp_mastery_and_exit_strategy.md ← final lesson (account-type execution + exit strategy)
```

## Lesson File Format

Every numbered lesson file follows the same template:

- **YAML frontmatter** — `title`, `series`, `core_thesis`, `tags`, `cross_refs`
- **Quick Reference** — compact rules for the lesson
- **Key Concepts** — defined terms (table format)
- **Statistical Claims (Testable)** — numerical assertions that can be validated with backtesting
- **Principles & Rules** — grouped `### On X` sections with bullet points
- **Tactical Takeaways** — numbered action list
- **Connections to FuturesEdgeAI** — implementation opportunities, ranked by priority
- **Open Questions** — things to validate empirically
- **Narrative Context / Meta** — bootcamp arc position, cross-lesson observations

The `_glossary.md` and `_open_questions.md` are cross-lesson aggregations.

## How to Use This Knowledge Base

**When coding FuturesEdgeAI features:**
- Start from the relevant lesson's "Connections to FuturesEdgeAI" section — it lists specific features with priority rankings
- Check the lesson's "Statistical Claims" for testable thresholds and numerical values
- Cross-reference the `_glossary.md` appendices for the canonical numerical reference table

**When answering trading-framework questions:**
- Use `_glossary.md` for term lookup (alphabetical + appendices)
- Use individual lesson files for deeper context on a specific concept
- Use `PLAIN_ENGLISH_SUMMARY.md` for accessible overviews

**When debugging trading logic:**
- Each lesson's "Principles & Rules" section documents the instructor's explicit rules
- Cross-lesson refinements tracked in `_open_questions.md` under "Cross-lesson refinements from Lesson N"

**When planning roadmap or prioritization:**
- Highest-priority features are flagged in each lesson's Connections section
- L16 (BBB calculator) and L18 (TFP calculator) are instructor-flagged as most impactful

## Key Framework Architecture (Memorize This)

The 5-indicator Greater Market Framework (finalized in L15-L16):

| # | Indicator | Tells you | Horizon | Source |
|---|---|---|---|---|
| 1 | DD Ratio | WHICH direction | Today | L8 |
| 2 | MHP (Monthly Hedge Pressure) | WHICH direction | Month | L3, L7 |
| 3 | Monthly Maps | WHICH direction | 3 months | L5 |
| 4 | VIX vs BBB | HOW to trade | Month | L16 |
| 5 | VVIX | HOW to trade | Volatility of volatility | L15, L16 |

First 3 = direction. Last 2 = execution style.

The Three Tenets (L1, finalized L17):
1. Trend Identification
2. Position Sizing / Risk Management
3. Market Avoidance Strategies

The Three Failure Modes (L17):
1. Shorting too much
2. Betting too big
3. Overtrading

## Canonical Numerical Reference

Critical values that appear throughout the codebase:

- **NQ strike stop**: 40 pts (= $800 per mini)
- **ES strike stop**: 10 pts (= $500 per mini)
- **NQ Risk Interval**: 230 pts (CME SPAN)
- **ES Risk Interval**: $61.50 (CME SPAN)
- **MHP hold rate (ideal / any)**: 90% / 73%
- **DD Band thresholds**: close-within 88%, top 92/96%, bottom 8%
- **Zone bounce rates**: 90% ideal, 70% any
- **DD Ratio bull threshold**: > 0.5
- **VVIX bands**: <80 ideal, 80-90 good, 90-100 caution, >100 danger, >110 crisis
- **Trade time by regime**: Golden 30-60 min, Mixed 10-30 min, Garbage 5-10 min
- **Bull market green days**: ~70%
- **Position sizing formula**: `NetLiq / (1.1 × IM)` (real) or `budget/accounts/days/trades/(stop × $/pt)` (TFP)

Full numerical table in `_glossary.md` Appendix.

## The Three Drawdown Types (L18-L19)

Every TFP account maps to one of:

- **Static** — fixed drawdown. Easiest. Most expensive. First trade = best trade.
- **End-of-Day (EOD)** — static intraday, stair-steps at close. Moderate cost. Matt's preferred.
- **Trailing** — moves with your high. Hardest. Cheapest. Base hits only, never home runs.

Each requires completely different execution strategy. Use L19 for execution rules.

## Important Conventions

- Lesson references use format "L3" or "Lesson 3" — both are valid
- Cross-references in frontmatter use the lesson number only
- Numerical values should match the `_glossary.md` appendix (single source of truth)
- When adding to the knowledge base, follow the existing lesson template exactly — consistency matters for Claude-based retrieval

## What the Bootcamp's Final Message Is

Despite 16 lessons of technical framework, the bootcamp's ultimate point is philosophical:

> "You have 100% control over how much you're willing to lose. The market can never take that away from you." (L17)

> "Your ultimate goal to trade props is to not need them." (L19)

Props are practice/bankroll, not lifestyle. The framework is scaffolding — the mature end state is using the framework's loss-control discipline to trade your own account under 60/40 tax rules. FuturesEdgeAI is designed to support this full arc: from "learning the framework" to "graduating from props."

## Out-of-Scope Reminders

This knowledge base is **framework-level**, not strategy-level. It does not contain:
- Specific backtest results (those live in FuturesEdgeAI's backtest output directory)
- Live data feed integration details (those live in the main codebase)
- Personal account balances or P&L (those are private)
- Firm-specific sale schedules or affiliate codes (those change frequently)

Firm-specific details (FundedNext, Tradeify, Apex, etc.) mentioned in L18-L19 were current as of late 2025 and will go stale. Always verify current rules on firm websites before coding them into the app.
