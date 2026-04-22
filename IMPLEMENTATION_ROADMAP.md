# FuturesEdgeAI Implementation Roadmap

*Derived from the 19-lesson Blind Monkey Bootcamp. This file consolidates every "Connections to FuturesEdgeAI" section across all lessons into a single ranked backlog.*

---

## How This Is Organized

Features are grouped by **module** (which layer of the app they belong to), then ranked within each module by **priority tier**:

- **P0** = Foundational. Build first. Either high-impact-low-effort (quick wins) or blocking dependencies for later features.
- **P1** = Core framework. These are the features that make FuturesEdgeAI distinct from existing trading tools.
- **P2** = Behavioral/educational. Helps users apply the framework correctly.
- **P3** = Nice-to-have. Build when core is stable.

**Impact** and **Effort** are estimates (S/M/L) to help sequence within a tier.

---

## Module 1: Greater Market Regime Dashboard

The 5-indicator system is the app's central nervous system. Everything else routes through it.

### P0 — Build First

**BBB Calculator (automated)** — *Lesson 16*
- Impact: L | Effort: S | Dependencies: VIX futures data feed
- Monthly 30-second math that determines the entire month's trading regime
- Capture VIX futures close at 5pm ET Tuesday before 3rd Wednesday expiration
- Capture next contract open at 6pm ET same Tuesday
- BBB = midpoint of the two
- Store as monthly constant, display prominently
- Instructor calls this "the most important class for a reason"

**VIX vs BBB Status Monitor** — *Lesson 16*
- Impact: L | Effort: S | Dependencies: BBB Calculator
- Real-time color-coded status: green (< BBB), yellow (near), red (> BBB)
- Days since last crossing
- Trajectory prediction

**VVIX Threshold Monitor** — *Lessons 15, 16*
- Impact: M | Effort: S | Dependencies: VVIX data feed
- Real-time VVIX tracking with threshold alerts (80, 90, 100, 110)
- Historical distribution overlay
- Overnight proxy via VIX tick-chart V-sizes when real VVIX unavailable

**Regime Classification (Golden / Mixed / Garbage)** — *Lesson 16*
- Impact: L | Effort: S | Dependencies: BBB + VVIX + existing 3 indicators
- Single banner: STRUCTURED MARKET ✓ or ANTI-STRUCTURE ⚠
- Combines all 5 indicators into single regime label
- Flagship feature — probably the app's most prominent UI element

### P1 — Core Value

**DD Ratio Calculator + Dashboard** — *Lesson 8*
- Impact: L | Effort: M | Dependencies: market-cap-weighted stock position data
- Ratio = MC(bull-zone stocks) / MC(all zoned stocks)
- Track intraday, historical trend, threshold crossings at 0.5

**MHP Monitor (actual + dynamic)** — *Lessons 7, 10*
- Impact: L | Effort: L | Dependencies: Black-Scholes + OPRA options data
- Compute and display Monthly Hedge Pressure level
- Dynamic MHP for overnight estimation (L10)
- Historical hold rates surfaced (90% ideal / 73% any)

**Monthly Maps Viewer** — *Lesson 5*
- Impact: M | Effort: M | Dependencies: 3-month forward options data
- A+/A/B+/B- rated pivots
- Liquidity Pockets visualization

### P2 — Context Layer

**VIX as Inside-Information Detector** — *Lesson 16*
- Impact: M | Effort: M
- Alert on VIX rising in otherwise calm regimes ("something is coming")
- Cross-reference economic calendar
- Suggest sit-out until event clears

**Historical Regime Analyzer** — *Lesson 16*
- Impact: S | Effort: M
- Classify past months as Candy / Golden / Mixed / Garbage
- Show user's performance by regime
- "November 2022 replayer" for training

---

## Module 2: Execution Engine

Actual trade management. The difference between knowing what to do and doing it right.

### P0 — Build First

**Position Sizing Engine (regime-aware)** — *Lessons 2, 14, 16*
- Impact: L | Effort: M | Dependencies: Regime Classification
- In Golden regime: single entry at pivot, normal size
- In VIX > BBB regime: 3-entry spread (1 above pivot, 1 at, 1 near stop)
- Stop recomputed from average entry, not pivot
- Scales N/M/S based on confluence
- Integrates with L2's `NetLiq / (1.1 × IM)` formula

**Cost Basis Management Tracker** — *Lesson 16*
- Impact: M | Effort: S | Dependencies: Position Sizing Engine
- For multi-entry positions: track average, distance to pivot, stop
- Visual: entries on chart, avg cost basis line, stop line
- Warning if cost basis > pivot

### P1 — Core Value

**Liquidity Map Viewer** — *Lesson 3*
- Impact: L | Effort: L | Dependencies: options hedging calculation engine
- THE central chart of the framework
- Bull zones, bear zones, liquidity pockets
- MHP/WHP overlays
- LM letter notation (BLU, BSU, BLD, BSD, etc.)

**Interrupt Exit System** — *Lesson 13*
- Impact: L | Effort: M
- Identify next interrupts after entry (gap fill, MHP, DD band, R/Y lines)
- Confluence-based partial exit suggestions (8/10 at DD band baseline, 3/4 if favorable)
- Short-trade asymmetry: hard exit vs staged

**EST (Every Single Time) Setup Detector** — *Lesson 14*
- Impact: L | Effort: M
- Identify the 4 EST setups in real-time: MHP, DD Band, BZB, BRZT-from-below
- Alert with setup type + ideal hold rate + suggested size
- Integration: always take, size varies by confluence

**Opening Trade Protocol Implementer** — *Lessons 9, 11, 12, 15*
- Impact: L | Effort: M | Dependencies: Resilience, Regime, Irrational Rules
- Decision tree: bull market + res > 0 → enter 1A immediately; bearish → no trade; etc.
- 2-minute window adjustment logic
- Override triggers when pre-market estimate doesn't match reality

**Resilience Calculator** — *Lesson 4*
- Impact: M | Effort: S | Dependencies: opening price + prior close data
- Market-cap-weighted implied move
- MOO/MOC deadlines (9:28/3:50/3:55pm ET)
- Scalp-short exception detection

### P2 — Advanced Execution

**Trade Time Recommender by Regime** — *Lesson 16*
- Impact: M | Effort: S
- Golden: 30-60 min holds OK
- Mixed: 10-30 min
- Garbage: 5-10 min
- Nudge when user exceeds recommended duration

**Digging Pattern Calculator** — *Lesson 13*
- Impact: S | Effort: S
- For 1A + N at 1B entries: show breakeven fraction = 1/(1+N)
- Displays required bounce distance to reach breakeven

---

## Module 3: Market Avoidance Layer

The "knowing when not to trade" superpower. Traditional technical analysis can't do this.

### P0 — Build First

**Irrational Rules Detector** — *Lessons 11, 12*
- Impact: L | Effort: M | Dependencies: multiple data feeds
- Detects the 4 formal rules in real-time:
  1. DD Band break (> 1 strike beyond band) → small/strong pivots only
  2. MHP break (> 1 strike through MHP) → small/strong pivots only
  3. Index Catalyst (price crosses Cat Line) → AUTO SIT-OUT
  4. VIX RI break (> 1 RI from Globex session low) → AUTO SIT-OUT
- Plus circuit breaker approach (within 5% of -7%) → AUTO SIT-OUT
- Red-Yellow-Green light system per rule

**Structure vs Anti-Structure Visualizer** — *Lesson 17*
- Impact: L | Effort: S | Dependencies: Irrational Rules + Regime
- Single banner: STRUCTURED MARKET ✓ or ANTI-STRUCTURE ⚠
- Combines: L11 irrational rules + L14 tracking breakdown + L16 Garbage Setup
- Prominent UI element; probably top-of-page

### P1 — Core Value

**Circuit Breaker Proximity Alert** — *Lesson 12*
- Impact: M | Effort: S
- Display current % from nearest breaker (-7%, -13%, -20%)
- 5% pre-breaker warning
- Auto sit-out trigger

**Tracking Breakdown Detector** — *Lesson 14*
- Impact: M | Effort: M
- NVIDIA + VIX flat combination check
- December 2025 pattern recognition
- Sector concentration warning

### P2 — Behavioral Support

**Skip-The-Month Alert** — *Lesson 16*
- Impact: M | Effort: S | Dependencies: Regime Classification
- When VIX > BBB + VVIX > 100 for sustained period
- Suggest reducing activity / skipping the month if struggling
- Particularly for new or previously losing traders

---

## Module 4: Pre-Market Preparation

The 30-60 min before open window.

### P1 — Core Value

**Pre-Market Estimator (5-indicator)** — *Lesson 15*
- Impact: L | Effort: M | Dependencies: overnight data feeds
- DD Ratio (stable from prior close)
- Dynamic MHP (calculated 5:30pm ET prior day)
- Monthly Maps (stable)
- VIX vs BBB (direct from VIX futures)
- VVIX (proxy from VIX tick activity overnight)

**Economic Calendar Integration** — *Lesson 15*
- Impact: M | Effort: S
- investing.com or equivalent API
- Flag 3-star events in today's session
- Suggest sit-out window around events

**Earnings Calendar Integration** — *Lesson 15*
- Impact: M | Effort: S
- Zacks or equivalent API
- Flag major single-stock earnings (MAG7 especially)
- Cross-reference with sector rotation

**Sector Rotation Viewer** — *Lesson 15*
- Impact: M | Effort: M
- XLK, XLC, XLF, XLE ETFs with Liquidity Maps
- Pre-market strength/weakness by sector
- Leading indicator for index direction

**Override Trigger Detection** — *Lesson 15*
- Impact: M | Effort: S
- When pre-market estimate diverges drastically from open
- Discard pre-market plan, wait for 9:30 actual data

---

## Module 5: Account & Budget Management (TFP Module)

Entirely new module derived from L18-L19. Complements the trading tools.

### P0 — Build First

**TFP Calculator (the budgeting formula)** — *Lesson 18*
- Impact: L | Effort: S | Dependencies: user budget input
- Formula: `Budget → Accounts → Days → Loss/day → Trades → Loss/trade → Position`
- Example: $2000/mo → 8 accts @ $250 → 3 days each → $1000/day → 2 trades → $500/trade → 1 ES mini
- Direct L18 implementation. Trivial math, enormous value.
- Instructor-flagged as highest-impact behavioral change

**Account-Type-Specific Position Calculator** — *Lesson 19*
- Impact: L | Effort: M | Dependencies: TFP Calculator
- Static: strict first-trade budgeting, forces micros
- Trailing: base-hits-only enforcement, target = 1 strike max
- EOD: normal sizing with consistency math
- Auto-selects NQ vs ES based on account tightness (L19: ES better for tight accounts)

**Apex Squeeze Warning** — *Lesson 19*
- Impact: L | Effort: S | Dependencies: Position Calculator
- Block trade entry when position size > calculated max for account type
- Alert: "Firm offers 2 E-minis but your $625 DD requires 2 micros"
- Educational overlay explaining why

### P1 — Core Value

**Firm Comparison Dashboard** — *Lesson 18*
- Impact: M | Effort: M
- Vetted firms side-by-side: FundedNext, MyFundedFutures, ETF, Tradeify, Apex, TakeProfit
- Columns: rules (triumvirate), drawdown type, TIM, profit split, all-in cost
- Drawdown-to-cost ratio computed and color-coded (>12 extreme value)

**Budget Tracker + Self-Imposed DLL Enforcer** — *Lessons 18, 19*
- Impact: L | Effort: M
- Monthly budget input
- Tracks account purchases, daily loss progression
- Alert at 50%, 75%, 100% of self-imposed daily limit
- Override requires confirmation (prevents desperation trading)

**Drawdown Type Recommender** — *Lesson 18*
- Impact: M | Effort: S
- Questionnaire (skill level, budget, risk tolerance)
- Recommends: trailing (cheap practice), EOD (balance), static (easy pass)
- Cross-reference with current sales

**Post-Payout Day-1 Alert** — *Lesson 19*
- Impact: L | Effort: S
- Detect payout event
- Flag: "Fresh Day 1 — wait for A+ setup"
- Prevent classic "pass eval, blow up funded" pattern
- Same logic applies post-eval-to-funded transition

**Earn-Your-Static Tracker** — *Lesson 19*
- Impact: M | Effort: S
- For trailing: progress toward initial buffer
- For EOD: accumulated buffer tracking
- For static: always static (no tracking needed)
- Visual countdown to "free trading mode"

### P2 — Strategic Planning

**Sale Alert System** — *Lesson 18*
- Impact: M | Effort: M
- Monitor firm websites for 80-90% off sales
- Alert with recommended plan given user's budget
- Buy-window countdown

**Tax Drag Calculator** — *Lessons 18, 19*
- Impact: M | Effort: S
- SIM-funded net (37% tax)
- Live 90/10 split net
- Live 50/50 split net
- Own account net (60/40 rule, ~20% effective)
- Breakeven analysis: when does real account beat TFP?

**Live Account Negotiation Checklist** — *Lesson 19*
- Impact: M | Effort: S
- Template questions when user qualifies for live
- "Ask for: no DLL, bigger contracts, better split"
- "Worst case: they say no. Best case: you get Matt's deal."

**Drawdown-to-Cost Comparator** — *Lesson 18*
- Impact: S | Effort: S
- Paste firm URLs or select from vetted list
- Rank by MLL ÷ all-in-cost ratio
- Flag >12 as extreme value

**Coin Flip Visualizer** — *Lesson 18*
- Impact: S | Effort: S
- Educational tool
- Pass probability by day (1/2^n)
- Personal adjustment based on user's historical win rate

### P3 — Advanced

**Self-Funding Pipeline Visualizer** — *Lesson 19*
- Impact: M | Effort: M
- Stage 1: Paying in (net negative)
- Stage 2: Break-even (props self-fund)
- Stage 3: Live account seeded
- Stage 4: Own account seeded (end state)
- Current user position indicator

**Exit Readiness Score** — *Lesson 19*
- Impact: M | Effort: M
- When is user ready to leave props?
- Consistent profitability (3-6 months)
- Prop payouts > lifestyle needs
- Live account seeded
- Alert: "You can start winding down props"

**5% Bankroll Enforcer** — *Lesson 19*
- Impact: M | Effort: S
- User inputs total capital
- System calculates max trading account size (5%)
- Blocks deposits exceeding 5%
- Tracks "lives remaining"

**Double-and-Halve Automation** — *Lesson 19*
- Impact: M | Effort: M
- Tracks account balance
- When balance = 2× starting → auto-suggest withdrawal
- Updates starting balance after withdrawal
- Savings growth tracker

**Static Account Protector** — *Lessons 16, 18, 19*
- Impact: L | Effort: S
- L16: don't trade statics above BBB
- L18: statics are expensive
- L19: first trade is best trade
- Combined: block static trades in anti-structure regimes; require confirmation

**Consistency Hack Tracker** — *Lesson 19*
- Impact: M | Effort: M
- For Tradeify/similar firms with consistency rules
- Track if user has built buffer in cycle 1 (Matt's $200K technique)
- Show buffer size vs risk level
- Enable "safe mode" trading in cycles 2+

---

## Module 6: Behavioral & Psychological Support

Extends the framework's mental-health arc (L11, L13, L14, L17, L18).

### P1 — Core Value

**Three Failure Mode Detector** — *Lesson 17*
- Impact: L | Effort: M | Dependencies: trade history
- Track user behavior patterns:
  - "You're shorting 60% — fighting trend"
  - "Position sizes are 1.5× your budget — betting too big"
  - "You made 12 trades today in garbage regime — overtrading"
- Gentle nudges, not lectures

**Wrong-From-Right-Place Classifier** — *Lesson 17*
- Impact: M | Effort: M
- Log every entry
- Classify: at-pivot (right place) vs chasing (wrong place)
- Track: "Last week, 8/10 entries were at pivots"
- Correlate with P&L

**Weekend Psychological Check-In** — *Lesson 17*
- Impact: M | Effort: S
- Monday morning: "How do you feel? Still recovering from Friday?"
- If yes: reduce suggested sizing for the day
- If pattern over weeks: reassess budget (was too big)

### P2 — Educational

**Three Tenets Navigator** — *Lesson 17*
- Impact: S | Effort: S
- New-user walkthrough by tenet
- Trend identification → directional tools
- Position sizing → size calculators
- Market avoidance → irrational rules
- Map bootcamp learnings to features

**Efficiency Stack Dashboard** — *Lesson 17*
- Impact: M | Effort: M
- Show user's performance on 4 multipliers:
  - Entry efficiency score
  - Exit efficiency score
  - Position sizing accuracy
  - Market avoidance discipline
- Overall profitability as product of all four

**Critical Thinking Prompts** — *Lesson 17*
- Impact: S | Effort: S
- When user considers 3rd-party indicator integration
- Prompt: "Is it based on price prediction or volume prediction?"
- Discourage price-prediction tools

---

## Suggested Build Order (First 90 Days)

**Weeks 1-2 — Regime Foundation**
- BBB Calculator
- VIX vs BBB Status Monitor
- VVIX Monitor
- Regime Classification

**Weeks 3-4 — TFP Basics**
- TFP Calculator (budgeting formula)
- Account-Type-Specific Position Calculator
- Apex Squeeze Warning

**Weeks 5-6 — Market Avoidance**
- Irrational Rules Detector
- Structure vs Anti-Structure Visualizer

**Weeks 7-8 — Core Execution**
- Position Sizing Engine (regime-aware)
- Cost Basis Management Tracker
- Opening Trade Protocol Implementer

**Weeks 9-10 — Pre-Market**
- Pre-Market Estimator
- Economic + Earnings Calendar integration
- Override Trigger Detection

**Weeks 11-12 — Behavioral Layer**
- Three Failure Mode Detector
- Post-Payout Day-1 Alert
- Budget Tracker + DLL Enforcer

After 90 days, the app has a functional spine: users can estimate pre-market, enter the Greater Market regime, get appropriate position sizing, respect irrational rules, manage prop firm accounts, and get feedback on behavioral failure modes. Everything after 90 days is enhancement of that spine.

---

## Notes on Scope and Prioritization

**The bootcamp flags two features as most impactful:**
- BBB Calculator (L16): "the most important class for a reason"
- TFP Calculator (L18): "one decision that changes your game overnight"

Both are **tiny engineering projects with outsized behavioral impact**. Build them first.

**Liquidity Map is the highest technical complexity item** in the P1 pool. It requires a full options-hedging calculation engine, OPRA data feed, and sophisticated visualization. Budget it generously; it's genuinely hard.

**The Account Management module (Module 5) is mostly new territory.** The original FuturesEdgeAI scope was trading tools. L18-L19 adds budgeting, tax tracking, and a self-funding pipeline. Consider whether this is a separate product or an integrated feature set.

**Behavioral features (Module 6) are the hardest to validate.** Users won't know if they need them until they've been losing money. Consider making them surface contextually (e.g., three-failure-mode detection activates after 30 days of history) rather than prominently.

**Firm-specific data (Module 5) will age fastest.** Build the data model to be easily updated. Consider making the firm list community-editable or pulled from a maintained source.

---

## Cross-Cutting Concerns

**Data feeds required:**
- VIX futures (CBOE)
- VIX + VVIX (CBOE)
- OPRA options (for MHP / Liquidity Maps)
- SPX / NQ / ES / MGC / MCL futures
- CFTC COT reports (weekly)
- Economic calendar (investing.com or equivalent)
- Earnings calendar (Zacks or equivalent)
- Sector ETFs (XLK, XLC, XLF, XLE)
- UVXY / VXX (alternative VIX trading)

**User profile additions:**
- Budget (monthly)
- Partner name + tuition commitment timeline
- Vetted firm preferences
- Account type history
- Historical win rate
- 5% bankroll total capital
- Tax bracket (for tax drag calcs)

**Integration with existing FuturesEdgeAI:**
- Databento feed → data layer for regime dashboard
- Backtest engine → validate Open Questions from lesson files
- Alert engine → route regime changes, irrational rule triggers, budget breaches
- AI Analysis tab → can surface framework-grounded insights using bootcamp knowledge base

---

## Framework Completeness Check

At 100% feature completion, FuturesEdgeAI would provide:

- **Real-time regime assessment** (5-indicator Greater Market)
- **Directional signal** (which way to trade)
- **Execution style signal** (how to trade in current regime)
- **Pre-market preparation** (build plan before open)
- **Market avoidance enforcement** (sit out when appropriate)
- **Position sizing** (N/M/S based on confluence + regime + budget)
- **Exit targeting** (interrupt detection + confluence matrix)
- **Trade time guidance** (by regime)
- **TFP budget management** (account count, days, loss/day, position)
- **Account-type execution** (static, trailing, EOD specific)
- **Behavioral feedback** (failure mode detection, weekend check-in)
- **Self-funding pipeline** (prop → live → own account)
- **Tax awareness** (1099 vs 60/40 rule drag)
- **Exit readiness** (when to graduate from props)

The bootcamp's ultimate test: does the app help a trader follow the three tenets (trend, sizing, avoidance), avoid the three failure modes (shorting too much, betting too big, overtrading), and eventually not need the app?

If yes, FuturesEdgeAI succeeded.
