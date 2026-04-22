---
lesson: 1
title: "Edge in Probabilities — The Blind Monkey"
source: "20 Day Bootcamp / Day 1"
series: "20-Day Profitability Mindset Masterclass Bootcamp"
instructor: "Matt (Rocket Scooter)"
core_thesis: "Markets are random short-term but drift upward long-term; edge comes from position sizing, entry efficiency, and market avoidance — not from predicting direction."
tags:
  - introduction
  - probabilities
  - position-sizing
  - market-randomness
  - long-vs-short
  - discipline
  - statistics
cross_refs:
  prerequisites: []
  followed_by: "Lesson 2 (Position Sizing — instructor flags as most important class)"
  related_concepts:
    - "Greater Market signals (ratio / monthly hedge pressure / monthly MAPs)"
    - "Volume pivots"
    - "Screen line"
    - "VIX / volatility asymmetry"
---

# Lesson 1: Edge in Probabilities — The Blind Monkey

## Quick Reference

**Core thesis:** Markets are 100% random on short/medium timeframes. The only reliable pattern is long-term upward drift. Edge therefore comes from *how* you trade (position sizing, entry location, knowing when NOT to trade), not from predicting direction.

**Three Bootcamp Tenets:**
1. **Trend identification** — use Greater Market signals; exploit non-random index↔components relationships
2. **Risk & position management** — the single most important trading decision
3. **Market avoidance** — "no trade is also a trade"

**Canonical quote:** *"Being wrong from the right place, you're always wrong small. Being right from the wrong place, you're always wrong big multiple times."*

---

## Key Concepts (Defined Terms)

| Term | Definition |
|---|---|
| **Blind Monkey** | Thought experiment: long-only strategy with random entry times, position size throttled to survive 20 consecutive losing days with ≥50% account intact. Mathematically "unbeatable" due to market's upward drift. |
| **Random Trading Challenge** | Instructor's real-money demonstration of the Blind Monkey principle: $100K NinjaTrader account, ChatGPT-selected entry times, held to full stop or full target. |
| **Entry efficiency** | Getting into a trade as close as possible to a pre-identified high-volume pivot with a tight stop. Wrong from the right place = small loss. |
| **Hedge Pressure (HP) pivot** | A high-volume pivot used as an anticipated zone for dips-to-long or pops-to-short. (Rocket Scooter tool.) |
| **Greater Market (bullish/bearish)** | Combined signal from three inputs: a ratio (orange line), Monthly Hedge Pressure, and Monthly MAPs. All three aligned = bullish regime. |
| **Screen line** | Referenced statistical level — 98% of days break it; 92% close above it. (Specific definition deferred to later class.) |
| **Dumb indicator** | Instructor's term for any signal generator that always fires (buy/sell/buy/sell) with no built-in "do not use now" logic. Claimed to converge to 50/50 over time. |
| **Liquid vs. illiquid market** | Liquid = high transaction frequency, tends to inflate ~2%/yr; illiquid = transactions dry up, prone to crashes when selling exceeds incoming buyers. |
| **Bullish stupidity** | Aping into a long at a top. Claimed to be "almost always rewarded" because bull-market volatility compresses. Inverse does NOT hold for shorts. |

---

## Statistical Claims (Testable)

These are the numerical claims made in the lesson. **Flag for validation against FuturesEdgeAI backtest data** — several are directly comparable to what your engine already produces.

### Daily candle color by regime
| Regime | Green day % | Source / horizon |
|---|---|---|
| Bull market, baseline | 50–60% | "count the candles yourself" |
| Bull market, all Greater Market signals bullish | ~70% | Claimed from their backtest |
| Bear market | ~50% (near 50/50) | Hand-counted example from 2021–2022 sell-off: 91 green vs. 106 red |

### Monthly candle statistics
| Metric | Value | Window |
|---|---|---|
| Green monthly candles | ~70% | Last 10 years |
| Green monthly candles | 63% | Since 1993 (~30 yrs) |
| Green months that give back >1/3 of monthly gain | 20% | Last 10 yrs |
| Green months that hold gains (give back ≤1/3) | 80% | Last 10 yrs |
| Red months that recover ≥1/3 of monthly loss | 60% | Last 10 yrs |

### Intraday level statistics
| Event | Probability |
|---|---|
| Day breaks the screen line | 98% |
| Day closes above the screen line | 92% |

### Random Trading Challenge results
- Win rate: **51%**
- Largest win: **$4,000** / Largest loss: **$4,000** (symmetric)
- Avg win: **$1,000** / Avg loss: **$1,000** (symmetric)
- Std dev wins: **$940** / losses: **$970** (symmetric)
- Runup: **$28,000** / Drawdown: **$28,000** (symmetric)
- Account: $105K → $98K during challenge → $116K within 1 week of resuming normal trading

### Calendar effects
- "Last week of the calendar month is usually a rally week" — even in worst crashes (2001, 2008)
- End-of-bull-month is rarely weak; end-of-bear-month is rarely weak either (bullish bias at month-end)

---

## Principles & Rules

### On discipline
- Discipline is the ability to repeat a process regardless of feelings
- Build it first with non-trading habits (make the bed, return grocery carts)
- Practice being wrong fast and okay with it

### On entry location
- Trade near pre-identified volume pivots with tight stops
- "Wrong from the right place = wrong small. Right from the wrong place = wrong big, multiple times."
- Out-of-sync chasing (long → stop → long → stop) is the failure mode to eliminate

### On the nature of markets
- Short/medium-term markets = 100% random (cites Jim Simons postulate)
- Only one pattern exists: long-term upward drift
- Drivers: inflation + population growth + 401k inflows
- Top ~500 companies compound; most individual stocks eventually go to zero

### On survival (law of large numbers)
- An 80–90% setup can still fail 10× in a row
- Must size positions so you survive long enough for mean reversion to the expected value
- LeBron analogy: the edge only plays out over enough iterations

### On longing vs. shorting (asymmetric)
- Liquid markets float upward (~2%/yr inflation baseline)
- Markets crash only when longs exit faster than buyers arrive (not when "there are no buyers")
- Bull market = narrowing V's (vol compresses)
- Bear market = widening V's (vol expands)
- Longing inefficiently → often rewarded (compressing vol helps)
- Shorting inefficiently → heavily punished (expanding vol hurts)
- Longing can be single-shot ("stab it and go")
- Shorting requires scaled entries around a pivot because the market overshoots
- **"There's no such thing as a 'maybe short' — it's a definitely short, or it's a sit-out"**

### On market avoidance
- Logical systems should include a "don't use me now" state
- Avoiding 50/50 conditions prevents emotional blowups
- "No trade is also a trade" — sitting out is an active position of zero

### On position sizing (teaser for Lesson 2)
- Losses must be consistent in size across trades
- Scale position down as account shrinks, up as it grows
- Standard categories: normal / medium / small / sit-out
- Emergency tip: if struggling, trade 1/10 normal size immediately

---

## Tactical Takeaways (Actionable)

1. **Pick one side and master it first** (long OR short), sit out the other entirely until the first is mastered.
2. **Trade 1/10th of normal size** if currently struggling or on tilt.
3. **Wait for setups** — the less you trade, the more you make (inverse relationship at small-position-count).
4. **Use calendar-month end bias** — end of month skews bullish even in crashes.
5. **Don't short red candles inefficiently** — volatility will chop you up before you're right.
6. **Don't fight apparent bear markets on the long side without position discipline** — the Random Trading Challenge proved you can survive even with random longs if sizing is perfect.

---

## Connections to FuturesEdgeAI

Observations and hypotheses worth considering for the project:

- **Greater Market signal analog:** The "ratio + monthly hedge pressure + monthly MAPs" concept parallels a regime filter. Current FuturesEdgeAI setups could be augmented with a regime-aware probability adjustment (i.e., a setup's historical win rate conditioned on whether the Greater Market is aligned).
- **Candle-color statistics as a sanity-check metric:** Your backtest harness could report green/red day ratios conditioned on regime, comparable to the 70% / 50% claims here. If the ratios diverge meaningfully from these claims for MES/MNQ/MGC/MCL, that's either a regime mismatch or a data issue worth investigating.
- **"Screen line" break/close statistics:** 98% break / 92% close seems like a specific level (possibly a VWAP or ORB level). Candidate to test once the specific definition is given in a later lesson.
- **Month-end bias:** The calendar-end rally claim is directly testable with the existing Databento historical bars — could be a new setup category ("last-week-of-month long bias").
- **Asymmetry of long/short execution:** If true, shorts should be scaled (multiple entries around a pivot) while longs can be single-entry. This is a structural difference that belongs in setup metadata, not just directional sign.
- **Position-size throttling ("Blind Monkey" rule):** The "survive 20 consecutive losses with ≥50% account" constraint is a clean risk-of-ruin test. Could be a hard-coded guardrail in the live alerting system — if projected daily loss at current size > constraint, flag reduce-size.
- **Drawdown symmetry check:** The symmetric stats from the Random Trading Challenge (win = loss, runup = drawdown) under random entry are a useful baseline. Running your own backtest with randomized entry times and observing whether your current position sizing produces similarly symmetric stats would validate sizing discipline independent of setup quality.

---

## Open Questions / Things to Validate

- **"Screen line" definition** — deferred to later class. Track until defined; confirm whether it's VWAP, pivot, or something proprietary.
- **Claim that Blind Monkey strategy "has never failed"** — needs direct backtest. Specifically: random-entry long-only futures, with position size throttled such that 20 consecutive max-losses = 50% account. Run across 30-year SPX monthly data and futures data.
- **70% monthly green claim** — verify against SPX and futures directly; 63% over 30 years is plausible but should be checked.
- **92% close above screen line claim** — very strong claim; if true and the level is definable, this is a high-value asymmetric setup.
- **Volatility asymmetry claim** — is "longing inefficiently is more forgiving than shorting inefficiently" empirically true in futures? Testable via controlled late-entry experiments in backtest.
- **Jim Simons attribution** — the "summation of random behavior of individual participants" framing is attributed to Simons but this is not a documented Simons quote. Treat as instructor's paraphrase, not verbatim.

---

## Narrative Context / Meta

- Day 1 of a 20-day bootcamp; foundational/motivational rather than technical.
- Heavy emphasis on mindset and statistical framing before any specific setups are taught.
- References community member "Ian" who independently backtested and produced a supporting PDF (30-year data).
- Uses "Mr. Miyagi / Cobra Kai" metaphor: early lessons are wax-on-wax-off — technique comes later.
- Lesson 2 (position sizing) explicitly flagged as "the most important class we teach."
