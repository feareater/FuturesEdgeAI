---
lesson: 3
title: "Liquidity Maps"
source: "20 Day Bootcamp / Day 3"
series: "20-Day Profitability Mindset Masterclass Bootcamp"
instructor: "Matt (Rocket Scooter)"
core_thesis: "By identifying market-maker options (not all options) in real-time and applying Black-Scholes math, you can predict where institutional delta-hedging volume will occur at each price. These predicted high-volume points become five pivot types with 80-90% ideal hold rates, the basis for all RocketScooter setups."
tags:
  - liquidity-maps
  - hedging
  - gamma-exposure
  - black-scholes
  - bull-zone
  - bear-zone
  - hedge-pressure
  - pivots
  - entry-mechanics
  - volume-prediction
  - opra
cross_refs:
  prerequisites:
    - "Lesson 1 (Blind Monkey — the bullish bias this lesson leans on)"
    - "Lesson 2 (Risk Interval, position sizing, Greater Market signal, 10pt/40pt stops)"
  followed_by: "Lesson 4 (Resilience — the confluence tiebreaker at pivots)"
  related_concepts:
    - "DD Band (Lesson 2; one of the strong pivots, derived from RI rather than hedging)"
    - "Redistribution Zone (white line, gap-fill predictor; covered in later lesson)"
    - "Volatility adjustment class (deferred; rule of thumb introduced here)"
    - "Catalyst class (deferred)"
    - "Monthly MAPs (referenced repeatedly as a Greater Market component; definition still deferred)"
---

# Lesson 3: Liquidity Maps

## Quick Reference

**Core thesis:** The majority of daily market activity is not speculative trading — it's algorithmic hedging flow. Market makers who sell options must delta-hedge in the underlying; this creates deterministic volume at mathematically-predictable prices. If you can identify *which* options belong to market makers (vs. retail/speculative), Black-Scholes lets you compute tomorrow's volume profile today.

**The five pivot types (all high-volume):**
1. **Bull Zone Bottom (BZB)** — where more MM-implied natural bulls than bears exist at lower edge
2. **Bear Zone Top (BRZT)** — where more MM-implied natural bears than bulls exist at upper edge (the "liquidity pocket" zone)
3. **Weekly Hedge Pressure (blue)** — max gamma on weekly options
4. **Monthly Hedge Pressure (orange)** — max gamma on monthly options
5. **Redistribution Zone (white)** — gap-fill predictor (details in later lesson)

**Critical asymmetry:** Only *bull zone bottom* and *bear zone top* are pivots. Bull zone *top* and bear zone *bottom* are **not pivots**. A bull zone extends upward until it hits a bear zone.

**The instructor's favorite trade — Liquidity Pocket:**
- Long at bear zone top when price is in the middle of the map
- "90 percenter" — 90% of days from middle don't close below bear zone top
- Rationale: middle of map = maximum liquidity; liquid markets don't crash; Blind Monkey is bullish

---

## Key Concepts (Defined Terms)

| Term | Definition |
|---|---|
| **Liquidity Map** | The daily-generated plan showing all pivot levels, zones, and predicted entry/exit points for a given contract. Populates ~15-30 seconds after the 9:30am equities open. |
| **Bull Zone** | A price range where more market-maker-implied natural bulls than bears exist (more calls than puts among dealer-hedged options). Displayed as dark gray shading. |
| **Bear Zone** | A price range where more market-maker-implied natural bears than bulls exist. Displayed as light gray shading. |
| **Bull Zone Bottom (BZB)** | The lower edge of a bull zone. A strong long pivot (~90% ideal hold). Also called "Bull Zone" informally. |
| **Bear Zone Top (BRZT)** | The upper edge of a bear zone. A strong long pivot (~90% ideal hold) when approached from above. This is where the "liquidity pocket" long originates. |
| **Hedge Pressure (HP)** | The price level of maximum net delta-hedging. Two versions: **Weekly HP (blue)** based on weekly options, **Monthly HP (orange/MHP)** based on monthly options. Both act as high-volume pivots. |
| **Gamma exposure** | Rate of change of delta relative to the underlying. Maximum gamma = maximum delta hedging = maximum volume. "When you hear 'gamma exposure,' think 'high-volume pivot.'" |
| **Delta hedging** | The process by which an options dealer buys/sells the underlying to offset options exposure. Black-Scholes computes how many shares are needed. This is the mechanical source of the predicted volume. |
| **Hedging loop** | A triangle formed by (1) trader, (2) stock market maker, (3) options market maker. Pressure rotates through all three as orders flow. Market makers make pennies by staying neutral; real P&L is between the traders and the underlying price action. |
| **OPRA** | Options Price Reporting Authority. Publishes all options open interest once per day. The raw data from which MM options are filtered. |
| **Liquidity Pocket** | The middle region of a liquidity map, between bull zone and bear zone. The most liquid part of the day because bulls and bears are in closest proximity to each other. Instructor's favorite trade setup: long at bear zone top when price is in the pocket. |
| **Resilience** | Confluence indicator based on the market-cap-weighted sum of underlying stocks relative to their own hedge pressures. If positive, more stocks are bullishly hedged than bearishly → supports index pivot holding bullish. Formal treatment in Lesson 4. |
| **Irrational market** | When a 90%/80% level breaks when it shouldn't. Signals something unusual is happening; correct response is to get out and wait for reclaim rather than trying to catch the falling knife. |
| **Whoosh fan** | Bootcamp meme for the gentle upward buoyancy at hedge pressure when approached from above in a bull-hedging environment. Appears on instructor's streams as a drawn fan graphic. |
| **1A / 1B notation** | Two legs of the same sequential trade. 1A is first entry; 1B is add-on at a different level. |
| **Catalyst** | (From Lesson 2) Event-driven move that breaks >1 RI without pause; generally aligns with the "irrational market" category of situation to avoid. |
| **Liquidity Map states (BLU, BSU, etc.)** | The 8 possible map configurations, named by three letters: (1) B=bull zone / BR=bear zone, (2) L=above WHP / S=below WHP, (3) U=blue above orange HP / D=inverted. Maps auto-switch as price breaks levels. |

---

## Statistical Claims (Testable)

### Ideal conditions (Greater Market all bullish + non-irrational)
| Setup | Hold rate |
|---|---|
| Open in bull zone → close in bull zone | **90%** |
| Open in bear zone → close in bear zone | **90%** |
| Monthly Hedge Pressure (orange) holds | **90%** |
| Weekly Hedge Pressure (blue) holds | **80%** |
| Liquidity Pocket: open in middle → don't break bear zone top | **90%** |

### Non-ideal conditions (2025 Trump tariff bear market backtest, published April 18)
| Scenario | Result |
|---|---|
| Open above blue → close above blue | **68-69%** (27% break, 4% break-and-reclaim) |
| Open above orange → close above orange | **73%** |
| Open below blue → break upside | **40%** (60% bounce) — explicitly flagged as too close to 50/50 to short |

### Map modifications
- 2 shorts removed after backtest showed 40/60 probabilities (too close to coin flip)
- Asymmetric risk: bull-side breakthroughs produce squeezes with large upside punishment

### Today's intraday example (lesson recording day)
- Liquidity Pocket failed 4 times in a row before winning (90-percenter setups can still streak-fail)
- Instructor maintained consistent size through the streak (3 contracts, then 5 on final) → ended the day green

---

## Principles & Rules

### On pivot asymmetry
- **Bull zone bottom and bear zone top are the ONLY pivots** from the zones
- Bull zone top and bear zone bottom do nothing — a zone extends indefinitely until it hits the opposite zone
- This is a counter-intuitive rule worth internalizing

### On entry direction convention
- **Bear-side approach (from above): tap and enter immediately** (for longs from bear zone top, MHP from above, etc.)
- **Bull-side break (from below): must retest before entering** — never chase a break into bullish territory
- **One exception:** Bear zone top is always entered at the edge, no matter what direction

### On market opens
- 9:30am equities open is a full reset
- Highest-volume moment of the day by design (MMs choose the most liquid level)
- Pre-market price action is irrelevant unless a catalyst is active
- 4:00pm close similarly high-volume

### On sequential entries (1A/1B)
- If 1A-1B distance < stop distance → hold through drawdown at normal size
- If 1A-1B distance > stop distance → take stop at 1A, re-enter at 1B as fresh trade
- If 1A-1B > stop distance BUT high volatility justifies holding → size down proportionally (4× distance = 1/4 position)
- Always pre-compute total risk assuming both legs fire; target aggregate R:R > 1:1

### On volatility-adjusted stops
- **Rule of thumb:** Largest 1-minute candle in the last hour ≈ expected oscillation range
- For S&P on a non-volatile day: largest 1-min might be 7-9 points → 10-point stop is appropriate
- On a volatile day: largest 1-min could be 50+ points → you need larger stops *or* smaller position
- Full volatility adjustment class deferred

### On the "irrational market" response
- If a 90%/80% level breaks against probability: don't try to catch the bounce
- Take the stop, get out of the way, wait for reclaim, re-enter then
- "Avoid, avoid, avoid, avoid" is the correct response when statistics aren't cooperating
- "Cut and run. Let it come back. Then jump back in."

### On the Liquidity Pocket (his bread-and-butter)
- Bear zone top long when price is in the middle of the map
- Must-trade setup: "every single time, no matter what, no matter what"
- Three supporting conditions: Blind Monkey (market bullish), stock ratio bullish, liquid markets don't crash
- Expect streak failures — attack consistently, let law of large numbers work

### On map state transitions
- When price breaks a key level within a map (e.g., breaks blue in a BLU), the algo switches to the corresponding next map (e.g., BSU)
- This is handled automatically — you just watch the chart relabel
- Legacy letter codes (BLU, BSU, etc.) are now largely irrelevant since the algorithm labels everything

---

## Tactical Takeaways (Actionable)

1. **Ignore pre-market entirely.** Watch 9:30 open as the anchor. First 15-30 seconds populate the full map; then begin reading.
2. **Default to long bias.** In any non-fully-bearish Greater Market (even 1/3 bullish), favor longs. Shorts require full confluence.
3. **Attack bear zone top longs consistently.** Even after 4 losses in a row, the 90% setup is still 90%. Keep same size; don't go desperate.
4. **Use 1A/1B sequencing.** Plan for multiple entries before the trade starts, with pre-computed aggregate risk.
5. **Check largest 1-min candle hourly** to calibrate stops for the current volatility regime.
6. **If a 90/80 level breaks unexpectedly, step out.** Don't add; don't average down; wait for reclaim.
7. **Never take the no-confluence short** when at blue WHP from below in a non-ideal market — 40% break rate is too close to 50/50, and breakthroughs squeeze hard.
8. **Bear-side: tap. Bull-side: wait for retest.** Simple rule, universal application (one exception: bear zone top).

---

## Connections to FuturesEdgeAI

This lesson contains the richest content yet for project integration, though most of it requires the MM-options-filtering step that is RocketScooter's proprietary secret sauce. That said, several elements are directly implementable:

- **Databento options pipeline is the right foundation.** Jeff already has a Databento historical options data pipeline (Phase 1f) in progress with Black-Scholes HP computation. This lesson confirms the direction — HP (hedge pressure) is the computation, and what makes RocketScooter unique is the MM-filtering step before the HP calc. The project could compute "naive" HP from all options as a starting point, then explore filtering heuristics.
- **OPRA data availability:** OPRA publishes daily open interest. Jeff's current Databento pipeline likely already has access to this. Worth confirming the specific SIP feed and whether it's the same data RocketScooter uses.
- **Market-maker options identification is the hard part.** RocketScooter claims 5 computers watching order flow in real-time, matching share purchases to option purchases to identify hedging loops. This is non-trivial to replicate. However:
  - Heuristic candidates: large-volume options trades that coincide with large share volume in the underlying within a short time window
  - Dealer identification via OCC data (if accessible)
  - Simpler proxy: use *all* options weighted by volume and assume retail speculation is proportionally small at the key strike/expiry combinations
- **Bull/Bear zone computation (naive version):** For each price range, compute net calls-minus-puts at-the-money or weighted by gamma. Positive → bull zone; negative → bear zone. Testable against historical data.
- **Hedge Pressure computation:** Maximum gamma exposure point. Standard GEX calculation, aggregate across monthly or weekly expiries.
- **Statistical validation pipeline:**
  - Run backtest: "open in bull zone → close in bull zone" rate across MES/MNQ historical data
  - Compare against 90% ideal / 68-73% bear-market non-ideal claims
  - If claims validate, these become high-confidence setups
  - If claims don't validate, explore whether MM-filtering changes the numbers
- **Sequential entry primitive (1A/1B):** Straightforward to encode. Each setup has `entry_1a_level`, `entry_1b_level`, `stop_level`. System computes aggregate risk. If `1A-1B > stop_distance`, suggest splitting.
- **Volatility-adjusted stop computation:** Trivial to implement — compute max(high-low) over last 60 1-minute bars, use as stop distance baseline. Could be a toggle on existing setups.
- **Pivot-break risk management:** "If a 90/80 level breaks unexpectedly, exit and wait for reclaim." Implementable as automated alert suppression: if a level classified as ≥80% breaks, mute new-trade signals until price returns above the broken level.
- **Resilience indicator (Lesson 4 will formalize):** Market-cap-weighted sum of stocks relative to their own HP. For futures on indices, this requires live tracking of underlying constituents. Within scope for NQ (NDX composition) and ES (SPX composition); less applicable to MGC/MCL.
- **The 8 liquidity maps as setup taxonomy:** Could be encoded as a setup-classification dimension. `{zone: bull|bear, whp_side: above|below, hp_orientation: up|down}` × ideal/non-ideal = 16 categories with known baseline probabilities. Aligns well with FuturesEdgeAI's existing setup categorization model.
- **Pre-market exclusion rule:** Already consistent with most trading systems but worth encoding explicitly: signals before 9:30 ET should not fire for equity-indexed futures unless flagged as catalyst-active.

### Potential setup families to derive from this lesson

Once the underlying hedge pressure / zone computation is in place, testable setups include:
1. **Bull Zone Bottom Long** (with Greater Market confluence)
2. **Bear Zone Top Long "Liquidity Pocket"** (the high-conviction version)
3. **MHP Bounce Long** (approach orange from above, tap)
4. **WHP Bounce Long** (approach blue from above, tap)
5. **MHP Break-and-Reclaim Long** (must retest from opposite side)
6. **WHP Break-and-Reclaim Long** (same)

---

## Open Questions / Things to Validate

- **The "Resilience zero line"** — what specifically is the threshold for the stock basket indicator being bullish vs. bearish? (Expected in Lesson 4.)
- **Black-Scholes parameter specifics** — do they use implied volatility surface, flat IV, forward-looking, historical? Likely covered in later technical class or proprietary.
- **Dealer-option identification algorithm** — RocketScooter claims 5 computers doing real-time hedging-loop detection. Unclear whether this will be further explained or remains proprietary. The naive approach (treat all OPRA options as equal-weighted for GEX) is a fallback.
- **The 90%/80% claims for MHP/WHP:** Do these hold on futures directly (ES/NQ options) or only on the underlying equity options (SPX/NDX/SPY/QQQ)? Worth testing separately.
- **Redistribution zone (white line)** — gap-fill predictor, deferred to later class.
- **Irrational market detection** — how is "irrational" algorithmically distinguished from "90% setup just failed this once"? Likely a volume-spike or speed-of-break heuristic.
- **Volatility-adjusted stop full formalization** — deferred class; "largest 1-min candle in last hour" is the preview rule.
- **MM-filtered options vs. all options comparison:** If Jeff implements naive (all-options) HP and RocketScooter achieves better stats via MM-filtering, the question is whether the additional accuracy is worth the engineering investment. Could be tested empirically once the naive version is running.
- **Whether the 8-map taxonomy is comprehensive enough** — the two shorts removed after 2025 backtest suggests the map set will continue to evolve. Any FuturesEdgeAI implementation should treat the setup list as mutable.

---

## Narrative Context / Meta

- Day 3; first lesson to go deep into *why* RocketScooter's approach works (Black-Scholes + hedging loops)
- The "Resilience" confluence indicator is flagged as next class (Lesson 4)
- Community member Ian cited again — he's becoming a recurring figure as the bootcamp's de facto backtest researcher
- Instructor admits the 40/60 short zones were initially in the maps and were removed after backtest evidence (good faith methodology)
- References "today on the stream" — indicates the bootcamp recordings are being done live in parallel with his actual trading, which provides a useful real-time validation layer
- The "Every Single Time" song reference ties to the Liquidity Pocket trade — becomes a cultural marker in the bootcamp community
