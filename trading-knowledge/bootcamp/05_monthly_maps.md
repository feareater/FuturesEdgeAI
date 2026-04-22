---
lesson: 5
title: "Monthly Maps"
source: "20 Day Bootcamp / Day 5"
series: "20-Day Profitability Mindset Masterclass Bootcamp"
instructor: "Matt (Rocket Scooter)"
core_thesis: "Monthly Maps stretch the Liquidity Map analysis across time, showing each future trading day's bull/bear zone structure on its own day. The three-month forward view provides the long-term Greater Market signal and enables swing trade planning, options strike selection, volatility forecasting, and large-scale reversal calls."
tags:
  - monthly-maps
  - greater-market
  - swing-trading
  - options-strategy
  - hedging
  - reversal-calls
  - volatility-forecast
  - liquidity-pocket
  - illiquidity-pocket
  - a-b-pivot-rating
  - blind-monkey-hedging
  - subsequent-pivot-analysis
cross_refs:
  prerequisites:
    - "Lesson 1 (Blind Monkey long-bias — the hedging strategy depends entirely on this)"
    - "Lesson 2 (Greater Market signal, Risk Interval parallels liquidity pocket width)"
    - "Lesson 3 (Liquidity Maps — Monthly Maps are the 'slinky stretch' of these)"
    - "Lesson 4 (Resilience — extended here with subsequent-pivot comparison)"
  followed_by: "Lesson 6 (COT / Commitment of Traders — explicitly foreshadowed)"
  related_concepts:
    - "DD Ratio (first Greater Market signal; dedicated class pending)"
    - "A/B pivot rating system (formalized here, applies across all pivots)"
    - "Options Greeks (theta, delta — referenced without formal definition)"
---

# Lesson 5: Monthly Maps

## Quick Reference

**Core thesis:** Monthly Maps are the 3-month forward-looking version of Liquidity Maps. While Liquidity Maps compress all options data onto today's chart, Monthly Maps "stretch the slinky" so each future day shows its *own* day's options structure. Result: you can see bull zone, bear zone, and volatility projections out for weeks, allowing for swing planning, options strike selection, and reversal calls.

**Role in the trading stack:**
- **DD Ratio** = stocks' sentiment TODAY (intraday bias)
- **MHP** = index structure over the MONTH (medium-term bias)
- **Monthly Maps** = options landscape over 3 MONTHS (long-term bias)

Together these are the three Greater Market signals. Blind Monkey voting rule: any 1 of 3 bullish = bullish overall.

**Most important practical quote:**
> "Never show up early to a bear party. Always be one day late."

**The hedging strategy (entire lesson's deepest practical content):**
Only buy puts on days where (1) price breaks from bull zone into bear zone on Monthly Maps AND (2) the next trading day fails to reclaim bull territory. Buy 5 minutes before close at strike = bear zone top at your target expiration. Continue long-only day trading underneath.

---

## Key Concepts (Defined Terms)

| Term | Definition |
|---|---|
| **Monthly Maps** | Three-month forward-looking options landscape. Each day plotted with its own day's bull/bear zones, liquidity pocket, and volatility. Third Greater Market signal. |
| **The "slinky" analogy** | Liquidity Maps = all options compressed to today's view. Monthly Maps = stretched out so each future day shows its own independent structure. |
| **A/B pivot rating** | Formal tier system. A+ = 90% hold (ideal + confluence); A = 80%; B+ = 70-80%; B- = 60-70%. |
| **Liquidity Pocket (LP)** | Price region BETWEEN bull zone top and bear zone bottom. Most-liquid zone. Traders lose to house; dealers happy to oscillate here. Normal market structure. |
| **Illiquidity Pocket (IP)** | Price region BETWEEN bear zone top and bull zone bottom when zones are INVERTED (bear above bull). Most-illiquid zone. Traders win against house; market lubricates AWAY from middle. Faster price movement. |
| **Active bull** | Someone currently longing the market (adding long exposure). |
| **Active bear** | Someone currently shorting the market (adding short exposure). |
| **"Not bull" state** | Longs exiting but not necessarily new shorts entering. Most crashes come from this, NOT from new bear activity. |
| **Bull zone bottom slope** | Over time: down = accumulation; up = liquidation. |
| **Bear zone top slope** | Over time: down = short covering (bullish); up = new shorts piling on (bearish). |
| **Volatility pocket width** | The distance between bull zone and bear zone on a given day. Wider = more expected volatility that day. Functions as "implied move" for earnings. |
| **Subsequent pivot resilience comparison** | New application of Lesson 4's Resilience: compare readings at multiple touches of the same pivot. Declining magnitude = capped upside; rising magnitude = running room. |
| **Reversal confirmation candle** | The candle AFTER a breach into opposite territory that fails to reclaim. NOT the extreme candle itself. This is what signals the regime change. |
| **Hedging with puts** | The instructor's singular options-use pattern: long futures/stocks underneath; puts above bear zone top for insurance. Only activated on confirmed monthly-map bear breach. |

---

## Statistical Claims (Testable)

### A/B pivot rating tiers

| Grade | Hold rate |
|---|---|
| A+ | 90% (ideal conditions + full confluence) |
| A | 80% |
| B+ | 70-80% |
| B- | 60-70% |

### Monthly-map update cadence
- Updates: daily at 9:30am ET (same time as Liquidity Maps)
- Resolution for equities: daily Mon-Fri for first 2 weeks, then Fridays-only for next 4 weeks
- Total horizon shown: ~4 weeks typical on platform, though instructor notes they may expand

### Volatility ↔ liquidity pocket width
- Wider pocket = higher implied volatility (mathematical relationship: liquidity ∝ 1/volatility)
- For earnings-day liquidity pockets: width ≈ expected earnings-day move
- Claim: "better than traditional IV-based expected move because forward-looking position data, not backward-looking price data"

### Reversal call validation (examples from instructor's Twitter, verifiable)
| Date | Call | Outcome |
|---|---|---|
| 2021 post-COVID | S&P 3800 → "double to 6000 in 3-4 years" | ✓ Hit 6000+ by Dec 2025 |
| Early 2022 | Bear market onset called on first monthly-map bull-to-bear breach | ✓ Correct top |
| 2022 bear-market rally (June) | 2-month rally called from first bear-to-bull reclaim | ✓ Ran June to August |
| 2022 year-end | Recession end called on bull-zone reclaim | ✓ No further bear |
| April 2025 | $50K in SPY calls bought on Trump-tariff bull-zone reclaim | ✓ Realized $50K profit (peak would have been $1.6M, or 32×) |

---

## Principles & Rules

### On Monthly Maps interpretation (the 4-checkpoint read)
1. **Zone location** — is current price in bull zone or bear zone over the window?
2. **Bull zone bottom slope** — accumulation (down-sloping) vs. liquidation (up-sloping)
3. **Bear zone top slope** — covering (down-sloping) vs. accumulation (up-sloping)
4. **Liquidity pocket width** — widening = volatility rising; narrowing = compressing

### On reading slope direction
- **Down-sloping bull zone bottom** is BULLISH (bulls adding at lower prices over time)
- **Down-sloping bear zone top** is BULLISH (bears covering / exiting over time)
- Both down-sloping simultaneously = strongest possible bull setup
- Both up-sloping simultaneously = strongest possible bear setup

### On liquidity pocket vs. illiquidity pocket
- **LP (normal):** bull zone above bear zone — price between them is most-liquid (dealer paradise)
- **IP (inverted):** bear zone above bull zone — price between them is most-illiquid (dealer wants OUT)
- LP tends to retain price; IP tends to ejection moves away from the center

### On the hedging strategy (put-buying triggers)
Only buy puts when ALL conditions met:
1. A single trading day closes in bear zone after being in bull zone (monthly map breach)
2. The NEXT day does not close back in bull zone
3. Buy at 5 minutes before close on that next day (minimize theta)
4. Strike = bear zone top at your target expiration
5. Continue long-only day trading underneath for the duration of the put holding period

### On "never show up early to a bear party"
- Do NOT go bearish on the first red candle or the first bear-zone touch
- Wait for the confirmation candle (next day failing to reclaim bull territory)
- "Bull party is already the loser party; don't show up to a bear party early"
- You are not Michael Burry; you cannot afford years of theta burn
- Most of the time you're "being early" you're just being wrong

### On blind-monkey-consistent options usage
- Never short the market with calls (inconsistent with long-only bias)
- Only hedge longs with puts, never hedge shorts with calls
- In bull markets: puts as occasional insurance (only on confirmed breaches)
- In bear markets: also mostly long-with-puts, not short-with-calls
- Bear markets are ~50% green days anyway (Lesson 1 statistic) → shorts aren't a reliable positive-expectancy play

### On A/B rating + volatility
- In high-volatility regimes, SKIP B-rated setups
- Wait for A or A+ only
- Missing a possible small B-rated bounce is acceptable cost of avoiding sharp volatility losses
- Volatility warning comes from widening pocket on monthly maps

### On data change cadence
- Monthly maps change daily but not dramatically
- Trillions of dollars of position data shifts slowly
- Daily intraday movement is a tiny fraction of total positioning
- This stability is what makes it a reliable slow-changing regime indicator

### On subsequent pivot resilience comparison
- First touch of a pivot: note the resilience reading and bounce peak
- Second touch of the same pivot: if resilience is weaker, cap profit target at the first bounce peak
- Second touch with stronger resilience: can add conviction / take runner
- Acts as "market cap divergence" signal — the index is less supported than before

---

## Tactical Takeaways (Actionable)

1. **Check monthly maps every morning at 9:30** — adds 3-month bias to the daily trade plan
2. **When reading monthly maps, walk the 4-point checklist** (zone, bull-slope, bear-slope, pocket-width)
3. **Use A/B ratings to decide when to skip pivots** — B setups are sit-outs in high-vol environments
4. **On earnings days, size strangles/straddles to the liquidity pocket width** — better forecast than standard IV-based expected move
5. **The only time to buy puts:** day AFTER a bear-zone breach that doesn't reclaim bull territory, at bear-zone-top strike for your target expiry
6. **For swing trades, let monthly maps tell you WHERE the next week's dips will land** — pre-plan entries at future bull-zone bottoms
7. **Compare resilience at subsequent pivot touches** — declining = cap targets; rising = add conviction
8. **Never go bearish on the extreme candle** — wait for the next-day confirmation
9. **Never short the market with calls** — stays consistent with Blind Monkey long-bias
10. **In IP (illiquidity pocket) conditions, expect faster movement** — the structure itself drives the speed

---

## Connections to FuturesEdgeAI

This lesson bridges from pure intraday setups (Lessons 1-4) into **swing/multi-day logic** and introduces systematic hedging — which expands the scope of what FuturesEdgeAI could do considerably.

### Direct implementation opportunities

- **Monthly Map generation for MES/MNQ:**
  - Compute daily forward-projected HP/zones for the next ~4 weeks using options expiration chain
  - Requires options data at per-expiration resolution (Databento likely supports this)
  - Key computation: for each future date N, apply Black-Scholes math to the options expiring on that date → generate that day's HP/bull zone/bear zone
  - This is fundamentally the same math as Liquidity Maps, applied at different time slices

- **A/B pivot rating classifier:**
  - Add a `rating` field to each detected setup: {A+, A, B+, B-}
  - Rating assigned based on confluence count + regime state + ideal-conditions match
  - UI: show rating alongside each alert for quick triage
  - Allow user to filter alerts by minimum rating (e.g., "only A and A+ during high volatility")

- **Volatility forecast from pocket width:**
  - For each day N in monthly maps, compute pocket_width(N) = |bull_zone_top(N) - bear_zone_bottom(N)|
  - Flag days where pocket_width exceeds recent average → high-volatility day warning
  - Useful for pre-sizing: reduce position size on high-volatility days
  - Useful for setup filtering: skip B-rated pivots when pocket_width is expanding

- **Earnings expected move:**
  - For individual stocks (if scope expands beyond futures), earnings-day pocket_width = expected move
  - Could power an earnings straddle/strangle suggestion tool

- **Subsequent pivot resilience tracking:**
  - When price touches the same pivot multiple times in a session, log resilience at each touch
  - If declining: raise an alert — "cap profit target at previous high"
  - If rising: raise an alert — "conviction increasing, consider runner"
  - This is a straightforward enhancement to any existing resilience indicator

- **Hedge-put recommender:**
  - Detect the two-day sequence: (day N = bull→bear breach) AND (day N+1 = did not reclaim bull)
  - On day N+1 at ~3:55pm, issue an alert: "BUY PUTS — strike = bear zone top at target expiration"
  - Only fires on confirmed sequences, not on single-day signals
  - Consistent with instructor's "never show up early to a bear party"

- **Reversal confirmation detector:**
  - For both bull-to-bear and bear-to-bull transitions
  - Triggers: breach candle followed by confirmation candle
  - Useful for swing trade alerts (not intraday)

### Architecture considerations

- **Monthly Maps are daily data, not intraday.** Different cadence than the main alerting system. Could be a once-per-day cron job (refresh at ~9:30am ET after Opera publishes open interest).
- **The A/B rating system gives a natural configuration axis for alert filtering** — much cleaner than the current binary "alert / no-alert" distinction if one exists.
- **The hedging logic operates at a different timescale** — the project could expose two modes: "intraday trading signals" (Lessons 1-4 material) and "swing/hedging recommendations" (Lesson 5 material).

### Integration with existing Databento pipeline

Jeff's Phase 1f pipeline already computes HP from options. Monthly Maps extend this:
- Current: HP for today based on all future options compressed
- Extended: HP for each future day based only on options expiring on/near that day
- Incremental additional complexity, same data source

---

## Open Questions / Things to Validate

- **"B- = 60-70%" / "B+ = 70-80%":** these are the instructor's stated ranges, but are they backtested or approximate? Worth empirically measuring across actual setup cases.
- **Exact formula for monthly-map bull/bear zones per future date:** presumably the same Black-Scholes + MM-options-filtering used for Liquidity Maps, but with options filtered to expirations on/near date N. Worth confirming.
- **How does RocketScooter handle non-standard expirations?** SPX has daily expirations; NDX has daily expirations since 2022; MES has weekly+monthly+quarterly. Are all expirations used, or only standard monthly?
- **The "3-month" horizon — is this platform-configurable or fixed?** Instructor says "monthly maps" show 3 months but platform shows ~4 weeks.
- **Does subsequent-pivot-resilience comparison work equally well at all pivots, or just half-gap?** Lesson generalizes to any pivot, but examples are limited to half-gap and MHP.
- **Illiquidity pocket (IP) frequency:** how often does the inverted structure occur? If rare, probably not worth special-casing in FuturesEdgeAI initially.
- **Hedging strategy ROI:** the instructor claims his April 2025 example hit 1:1 ($50K profit on $50K puts), and generally most puts expire worthless. What's the true expected value of this strategy over many instances? Worth backtesting.
- **DD Ratio** — the first Greater Market signal — still hasn't been explained in depth. Foreshadowed for an upcoming lesson.

---

## Narrative Context / Meta

- Day 5; completes the "greater market" trio (DD, MHP, Monthly Maps) that defines the overall bias framework
- The lesson spends substantial time on Resilience extension (subsequent-pivot comparison) that wasn't in Lesson 4's video — flagged as addendum material
- The Twitter-post examples are real and verifiable, strengthening the "this actually works" case
- The instructor offers explicit framing of his options trading methodology for the first time — a meaningful extension of scope beyond pure day trading
- Reference to "the trade I'm not allowed to talk about" (April 2025 calls) suggests some regulatory-adjacent reason he can't discuss details — probably related to posting trade results publicly
- Announces next lesson will be **Commitment of Traders (COT)** — the first foray into traditional institutional positioning data
- The "never show up early to a bear party" maxim is likely to become a recurring reference point in future lessons
- Overall tone shift: Lessons 1-4 were "here's how to day trade"; Lesson 5 starts to look like "here's how to be a full-strategy investor using these tools"
