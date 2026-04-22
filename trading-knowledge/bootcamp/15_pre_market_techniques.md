---
lesson: 15
title: "Pre-Market Techniques"
source: "20 Day Bootcamp / Day 15"
series: "20-Day Profitability Mindset Masterclass Bootcamp"
instructor: "Matt (Rocket Scooter)"
core_thesis: "Prepare before market open so your 2-minute decision window is spent MODIFYING a pre-built plan rather than BUILDING one from scratch. The Greater Market framework is now 5 indicators (3 original + 2 from VIX class): DD Ratio, MHP, Monthly Maps, VIX vs Triple B, VVIX. Each can be estimated overnight using proxies: Dynamic MHP for MHP, V-sizes on VIX tick chart for VVIX, direct observation for VIX futures. VVIX thresholds: >100 danger, 90-100 in-check, <90 calm. Pre-market browser tabs: investing.com economic calendar, Zacks earnings calendar, sector ETFs (XLK/XLC), weekly COT. On flat days, resilience barcodes near zero — default to greater market bias for coin-flip direction. Core mantra: 'Modify your plan, don't build it on the fly.'"
tags:
  - pre-market-techniques
  - greater-market-5-indicators
  - vvix
  - vvix-thresholds
  - vix-vs-bbb
  - pre-market-estimation
  - dynamic-mhp-as-proxy
  - monthly-maps-stability
  - overnight-indicators
  - pre-market-setup
  - investing-com-calendar
  - zacks-earnings-calendar
  - sector-etfs
  - flat-day-protocol
  - gap-day-protocol
  - modify-dont-build
  - blind-monkey-flat-day
cross_refs:
  prerequisites:
    - "Lesson 3 (Liquidity Maps)"
    - "Lesson 4 (Resilience)"
    - "Lesson 5 (Monthly Maps)"
    - "Lesson 7 (MHP cycle dynamics)"
    - "Lesson 8 (DD Ratio)"
    - "Lesson 10 (Dynamic MHP)"
    - "Lesson 14 (EST, Blind Monkey unified with EST)"
  followed_by: "VIX class re-record (still pending); possibly more synthesis lessons"
  related_concepts:
    - "Triple B on VIX (STILL PENDING as dedicated class)"
    - "Volatility-adjusted stop formula (STILL PENDING)"
    - "VIX class was referenced as already-taught per line 3; may appear as L16+"
---

# Lesson 15: Pre-Market Techniques

## Quick Reference

**Core thesis:** Estimate Greater Market BEFORE open. Modify your plan, don't build it on the fly.

**The 5 Greater Market indicators (3 original + 2 from VIX class):**
1. DD Ratio (today, intraday)
2. MHP (monthly, via Dynamic MHP overnight)
3. Monthly Maps (3 months forward)
4. VIX vs Triple B (volatility regime)
5. VVIX (volatility of volatility)

**VVIX thresholds:**
| Range | Label | Market behavior |
|---|---|---|
| > 100 | DANGER | VIX spikes rapidly; thin support |
| 90-100 | In check | VIX controlled but responsive |
| < 90 | Calm | VIX barely moves; thick support |

**Pre-market availability:**
| Indicator | Overnight source |
|---|---|
| VIX vs BBB | DIRECT (VIX futures) |
| VVIX | PROXY (V-sizes on VIX tick chart) |
| DD Ratio | ESTIMATE (stable unless drastic) |
| MHP | PROXY (Dynamic MHP from OPRA) |
| Monthly Maps | ESTIMATE (stable unless drastic break) |

**Core operational quote:**
> "Prepare as much as you can and just modify your plan rather than build your plan on the fly. The nerves are high, the market's open, you're panicking."

---

## Key Concepts (Defined Terms)

| Term | Definition |
|---|---|
| **Pre-market estimation** | Method to guess all 5 Greater Market indicators BEFORE 9:30 open using overnight-available proxies. Enables MODIFY-not-BUILD execution. |
| **Triple B (on VIX)** | VIX contango midpoint level. Below = underpriced volatility / crash sensitivity. Above = priced-in volatility / slow response. (Full class pending re-record per instructor.) |
| **VVIX** | Volatility of the VIX itself. Based on VIX options. Higher = VIX has potential to spike faster. Not tradable overnight (SPX options don't trade off-hours). |
| **VVIX thresholds** | >100 danger, 90-100 in-check, <90 calm. Distinct market behaviors per range. |
| **VVIX proxy** | Watch V-amplitudes on VIX tick chart. Bigger V's = VVIX rising. Workaround for overnight estimation. |
| **Dynamic MHP as proxy** | Overnight estimation of MHP using OI data from OPRA (Lesson 10). Best available pre-open MHP signal. |
| **Modify-don't-build** | Core execution philosophy. Plan built before open; 9:30 data arrival triggers verification and adjustment, not analysis from scratch. |
| **Pre-market setup** | 2×2 chart grid (S&P LM, NASDAQ LM, VX tick, VVIX) + side monitors (NQ/ES tick, DOM) + browser tabs (calendar, earnings, sectors, COT). |
| **investing.com Economic Calendar** | Free service. Filter by country. 3-star/2-star/1-star importance. Previous/Forecast/Actual columns. Click event for full educational content. |
| **Zacks Earnings Calendar** | Free service. Sortable by market cap. Before-market-open / after-market-close classification. Find MAG7 fast. |
| **Sector ETFs** | XLK (tech), XLC (communications), etc. Real-time sector rotation clues. Can apply Liquidity Map to ETFs themselves. |
| **Flat day protocol** | On low-range days, resilience barcodes near zero. Default to greater market bias for coin-flip direction. Small size, tight stop. |
| **Gap day protocol** | On 30+pt gap days, resilience becomes usable. Tight stop at open, wait for gap fill retest. |
| **Override triggers** | Conditions under which pre-market estimate is discarded. Overnight MHP crash, significant gap down, close below yesterday's MHP, VIX/VVIX threshold cross. |
| **The 2-minute window** | Time after open to MODIFY (not build) plan. Verify estimates against actual data. |

---

## Statistical Claims (Testable)

### Overnight indicator stability
- DD Ratio drift: minimal unless drastic move (73 → ~73)
- Drastic intraday deterioration (e.g., 90 → 55): estimate ~50 next morning
- Monthly Maps: stable unless severe break into adjacent zone
- MHP: stable in bull market; interactive in bear/end-of-month

### VVIX movement
- Typical overnight move: <10 points
- "Takes almost a whole day worth of movement to move VIX into danger zone"
- Once >100, takes extended period to come back below

### MHP cycle dynamics
- First 2 weeks of monthly cycle: MHP stays far from price in bull markets
- Last week before 3rd Friday expiration: MHP curves toward price
- Bull market: MHP consistently below price for ~3 weeks
- Bear market: MHP interacts with price daily (flip-flopping)

### Flat day frequency
- ~70% of days are green (instructor's estimate)
- Flat days common in post-earnings windows
- Resilience not reliable on flat days
- Greater Market bias defaults

### Gap day dynamics
- 30-50pt S&P gap = significant
- Resilience becomes leading indicator on gap days
- Gap fills typical target within first hour
- Half-gap confluence useful

---

## Principles & Rules

### On the 5-indicator Greater Market framework
- DD Ratio, MHP, Monthly Maps, VIX vs BBB, VVIX
- All 5 must align for full-size EST trades
- 3-of-5 alignment: medium-size
- Only 1-2 aligned: skip or very small

### On VVIX thresholds (new specifics)
- > 100: danger; trim positions; expect VIX spikes
- 90-100: in-check; normal sizing
- < 90: calm; confidence to hold runners; add aggressively on pullbacks

### On VVIX proxy estimation
- Watch VIX tick chart V-amplitudes
- Constant V sizes = VVIX stable
- V's getting bigger = VVIX rising
- Unless overnight V's drastically larger: assume unchanged
- Works because VVIX calculates from VIX movement

### On VIX futures direct observation
- VIX IS futures-tradable (has own futures contract)
- Observable overnight directly
- Check VX ticker for current VIX
- No proxy needed

### On DD Ratio estimation
- Stable unless drastic intraday move
- Rule of thumb: within 5-10 points of closing value overnight
- Major crash through levels → estimate -15-20 points lower
- NASDAQ-specific moves don't always affect S&P DD Ratio

### On MHP estimation
- Use Dynamic MHP (L10) as primary overnight proxy
- Bull market: expect stable MHP, far from price
- Last week of monthly cycle: expect MHP curving toward price
- Override: if overnight Dynamic MHP crosses price, reassess everything

### On Monthly Maps estimation
- Very stable overnight
- Only drastic sell-off (close below bull territory, enter bear zone) justifies rebuild
- Check if any key levels broken overnight
- Default: yesterday's structure holds

### On override triggers
Discard pre-market estimate and wait for 9:30 data if:
- Overnight MHP crash (Dynamic MHP now above price where was below)
- Significant gap down (>20pt S&P)
- Close overnight below yesterday's MHP
- VIX crosses BBB overnight
- VVIX proxy shows V's dramatically larger

### On the modify-don't-build principle
- Plan built 30-60 min before open
- 9:30: data arrives
- 9:30-9:31: verify estimates
- 9:31: execute if aligned, modify if slightly off, discard if drastically off
- Reduces emotional decision-making
- Captures best entries

### On pre-market setup (chart layout)
Main monitor 2×2:
- Top-left: S&P Liquidity Map
- Top-right: NASDAQ Liquidity Map
- Bottom-left: VX tick chart (25-tick)
- Bottom-right: VVIX chart

Secondary monitor:
- NQ tick chart
- ES tick chart
- DOM
- Flexible rotation to individual stocks

### On browser tabs (pre-market routine)

**investing.com Economic Calendar (FREE):**
- Profile-saved US-only filter
- 3-star always-relevant: CPI, PCE, GDP, Employment/NFP, FOMC
- 3-star sometimes-relevant: PMI, ADP, Retail Sales (regime-dependent)
- Click event → full educational content
- Previous / Forecast / Actual

**Zacks Earnings Calendar (FREE):**
- Sort by market cap
- MAG7 prioritized
- BMO / AMC classification
- 100+ companies per day = peak earnings season

**Sector ETFs (ThinkOrSwim watchlist):**
- XLK (tech), XLC (communications), XLF (financials), XLE (energy), etc.
- Real-time sector rotation clues
- Apply Liquidity Map to ETFs themselves
- "XLK is BLD today" = tech holding

**COT (weekly check, not daily):**
- Bull/Bear Bias Ratio
- Dealer positioning (liquid markets don't crash rule)
- Confirm directional bias

### On flat day protocol
- Resilience barcodes near zero
- Can't use resilience as leading indicator
- Default to greater market bias
- All bullish GM + flat → small long at open
- Blind Monkey mode
- 70% of days green → bull bias default
- Small size, tight stop

### On gap day protocol
- Large gap (30-50pt S&P) = significant
- Resilience becomes usable
- Tight stop at open
- Wait for gap fill retest before adding
- Half-gap = confluence target
- Bigger position justified if resilience > 0

### On prep-time benefit
Without prep:
- 9:30 panic analysis
- Miss best entry by 2 min

With prep:
- 9:31 execute per plan
- Capture best entry

### On economic data interpretation
- 3-star Fed-watched data always moves market
- 3-star survey data (PMI, ADP) regime-dependent
- "As years go by, you'll become an expert at the economy without ever having to pick up a textbook"
- Surface-level knowledge sufficient for trading

### On earnings season navigation
- NVIDIA single-stock event = 2% S&P move potential
- MAG7 earnings = position pre-adjust
- Don't take large positions day of major earnings
- "Aware you're gambling on a potential 2% move"

### On the preparation hierarchy quote
> "My guess is better than your guess because I'm more prepared. Your guess will be better than other people because you're more than prepared."

---

## Tactical Takeaways (Actionable)

1. **Estimate all 5 Greater Market indicators pre-market**
2. **Use Dynamic MHP as proxy for MHP overnight** (OPRA overnight data)
3. **Use V-sizes on VIX tick chart as proxy for VVIX**
4. **Check VIX vs BBB directly** (VIX futures trade overnight)
5. **Assume DD Ratio and Monthly Maps stable** unless drastic move
6. **Build plan 30-60 min before open**, not AT open
7. **investing.com, Zacks, sector ETFs, COT = weekly tab rotation**
8. **On flat days, default to greater market bias** (small coin flip with edge)
9. **On gap days, resilience becomes usable** (tight stop, wait for fill)
10. **Override estimate if MHP crashes overnight** or VIX crosses BBB
11. **Modify plan in 2-min window, don't rebuild**
12. **Arrive 30-60 min before open** — preparation = edge

---

## Connections to FuturesEdgeAI

Lesson 15 is an operational-workflow lesson. Several concrete features could be implemented.

### Direct implementation opportunities

- **5-indicator Greater Market dashboard:**
  - Current state of each indicator (DD Ratio, MHP, Monthly Maps, VIX vs BBB, VVIX)
  - Pre-market estimated state (using Dynamic MHP, VVIX proxy, stability rules)
  - Side-by-side comparison of live vs estimated
  - Confidence score (0-5 aligned indicators)

- **Pre-market plan builder:**
  - User selects overnight position/direction
  - System fetches all estimated indicators
  - Auto-generates plan: "Long at open small, add at bull zone 1B, stop at MHP"
  - User verifies at 9:30, modifies if needed
  - One-click execution on alignment

- **VVIX proxy calculator:**
  - Monitor VIX tick chart V-amplitudes
  - Alert if V's growing (VVIX rising even if VVIX unavailable)
  - Display: "VVIX proxy: stable" / "VVIX proxy: rising — consider trimming"

- **Override trigger alerter:**
  - Watch for: overnight MHP crash, significant gap, VIX cross BBB, VVIX cross 100
  - Alert user: "Pre-market plan invalidated by [trigger]. Wait for morning data."

- **Economic calendar integration:**
  - investing.com or similar API
  - Filter to US 3-star
  - Color-code Fed-always-matters vs. regime-dependent
  - Pre-trade warning: "CPI in 30 minutes. Caution."

- **Earnings calendar integration:**
  - Zacks or similar API
  - Highlight MAG7 / top tech / NVDA days
  - Warn: "NVDA earnings tonight. Position size reduction recommended."

- **Sector ETF Liquidity Maps:**
  - Apply Rocket-Scooter-style LM to XLK, XLC, XLF, etc.
  - Real-time sector rotation display
  - "Tech BLD / Energy BSD" quick view

- **Flat day vs. gap day classifier:**
  - Pre-open price movement detection
  - < 10pt S&P / < 40pt NQ = flat day mode
  - > 30pt S&P = gap day mode
  - Adjust default settings (resilience use, sizing)

- **Prep-time tracker:**
  - Badge: "Arrived 45 min early — maximum preparation"
  - Correlate prep time to trade performance
  - Encourage earlier arrival for better results

- **Pre-market checklist:**
  - 5 Greater Market indicators (estimate)
  - VIX vs BBB
  - VVIX threshold
  - Economic calendar scan
  - Earnings calendar scan
  - Sector rotation check
  - COT (weekly)
  - Override triggers check
  - Plan built

### Architecture implications

- **Greater Market state is now 5-indicator, not 3-indicator.** Schema update for user profiles and alerts.
- **VVIX threshold bands need distinct alert behavior** at 100, 90, 80 crossings.
- **Dynamic MHP must persist overnight** as the primary MHP proxy.
- **Overnight data pipeline** needs: VIX futures, VIX tick chart, OPRA OI, sector ETF prices.
- **Pre-market UX mode** differs from intraday UX — simpler, estimation-focused.

### Scope note

- This lesson's features mostly AUGMENT existing Rocket-Scooter workflow
- Largest new feature: VVIX proxy calculator (not directly available elsewhere)
- Medium features: pre-market plan builder, override trigger alerter
- Small features: economic calendar integration, earnings calendar integration

---

## Open Questions / Things to Validate

- **Triple B on VIX** — STILL PENDING as dedicated class. Referenced here but not taught in detail.
- **VIX class re-record** — referenced at line 9; final bootcamp version may differ
- **VVIX threshold 90 specificity:** is 90 or 85 the better "calm" boundary?
- **Dynamic MHP drift** from actual MHP — quantify overnight accuracy
- **DD Ratio overnight stability** — empirically measure drift distribution
- **Monthly Maps break frequency** — how often do overnight moves invalidate the estimate?
- **Flat day 70% green claim** — backtest bull-market flat days
- **Gap day resilience reliability** — measure R:R of gap-fill trades by regime
- **MHP end-of-month curve** — mathematical model?
- **Sector ETF leading indicator** — do XLK moves lead NASDAQ?

---

## Narrative Context / Meta

- Day 15; the Pre-Market Techniques class
- **Critical revelation at line 3:** "As you learned in the VIX class" — implies VIX class EXISTS and was taught BEFORE L15
- **Critical revelation at line 9:** "I need to re-record that class, by the way. So y'all will see a different video when you watch this" — instructor will re-record VIX class; final bootcamp has a different version
- This suggests the VIX class may appear LATER in the lesson sequence (as L16+) or was in an earlier position that got reshuffled
- L15 is purely pre-market operational; no new trading primitives
- Most valuable content: VVIX thresholds (>100 / 90-100 / <90) and VVIX proxy method
- New operational detail: flat day vs. gap day protocols (explicit rules now)
- Pre-market browser tab setup (investing.com, Zacks, sector ETFs, COT) is recommended workflow
- The 2-minute open window is reserved for verification, not analysis
- "Modify your plan, don't build it on the fly" = L15's core mantra
- Reinforces L14's preparation-as-discipline theme
- Extends L11's irrational-rules checklist to pre-market
- Validates L9's "done longing = done trading" speed framework
- **Pending lessons remaining (L16-L20):** strongest candidates are:
  - VIX / Triple B class (re-record; Q47)
  - Volatility-adjusted stop formula (Q56)
  - Possibly live trading sessions or Q&A
  - Possibly advanced topics (gamma squeeze, specific sector plays)
- The bootcamp is now in its operational/synthesis phase
- L15 completes the preparation layer of the framework
- Core execution loop is: pre-market estimate → 9:30 verify → modify if needed → execute → exit at interrupts → continue EST
