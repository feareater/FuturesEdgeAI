# FuturesEdgeAI Implementation Roadmap — Bootcamp Integration

*Revised 2026-04-19 under the Hybrid Plan. Supersedes the original greenfield-framed roadmap.*

---

## What This Roadmap Is

This file specifies how to integrate the 19-lesson Blind Monkey bootcamp framework **into the existing v14.30 FuturesEdgeAI codebase**. FuturesEdgeAI is production-ready with paper trading active on MNQ/MES/MCL since 2026-04-06 (B9 PASS: WR 42.7%, PF 2.265). The bootcamp framework is **additive**, not a rebuild.

The core principle: **do not disturb the validated B9 edge.** Bootcamp features layer on top of existing architecture as new modules, new data feeds, and new overlays. The `or_breakout` + `pdh_breakout` setup engine stays untouched until empirical evidence says otherwise.

## The Hybrid Plan (Three Tracks)

**Track 1 — Immediate Bolt-Ons (Weeks 1-8).** New modules that don't touch the existing trading engine. Additive UI, additive data feeds, additive overlays.

**Track 2 — Medium-Term Research (Weeks 9-24).** Experimental setups and features that may or may not ship. Validated against the existing backtest engine and paper trading before integration.

**Track 3 — Long-Term / Deferred Indefinitely.** Architectural changes (Liquidity Map as primary chart, replacing validated setups). Not scheduled. Revisit only if paper trading underperforms or a specific research finding justifies the work.

---

## Already Built (Skip These)

The following bootcamp concepts already exist in FuturesEdgeAI under different names. Do not rebuild. When bootcamp content references these, map them to the existing implementation:

| Bootcamp concept | Existing implementation | File / feature |
|---|---|---|
| DD Band (L8) | Confidence modifier (-20 to +8), chart layer, topbar widget | `server/analysis/setups.js` score breakdown; `public/js/layers.js` |
| Hedge Pressure / MHP (L7) | Computed per ETF, ~1736 snapshots | `server/data/hpCompute.js`; `data/historical/options/{etf}/computed/` |
| GEX / DEX / Resilience (L4, L7) | Computed and on trade records | `server/data/options.js`; trade record fields `dexBias`, `resilienceLabel` |
| Market breadth (L15, L16) | 16-instrument scoring, ±15 pt cap | `server/analysis/marketBreadth.js`; fields `equityBreadth`, `bondRegime`, `copperRegime`, `dollarRegime`, `riskAppetite` |
| Claude commentary (L1 concept) | Active with rate limiting | `server/ai/commentary.js` — conf ≥ 75, fresh, 30-min cooldown |
| VIX regime (L16) | MNQ realized-vol proxy | `server/data/historicalVolatility.js`; field `vixRegime`, `vixLevel` |
| DXY direction (L11, L16) | Via DX futures | `data/historical/dxy.json`; field `dxyDirection` |
| Risk appetite composite (L15) | Computed field | `marketBreadth.js` — `riskAppetite`, `riskAppetiteScore` |
| Session levels, OR, PDH/PDL (L3, L14) | Full detection + alerts | `server/analysis/sessionLevels.js`, `openingRange.js`, `indicators.js` |
| Alert dedup + staleness (L9, L14) | 15-min cooldown + ±0.25×ATR, fresh/aging/stale | `server/analysis/alertDedup.js` |
| Active setups live P&L (L13) | Live-tick P&L panel (v14.25.1) | `public/js/alerts.js` — Active Setups panel |
| Economic calendar (L15) | ForexFactory integration, -20 conf gating | `server/data/calendar.js` |
| Multi-TF confluence (L15) | MNQ-only, ±15 cap | `server/analysis/confluence.js` |
| Anti-structure detection (L17) | Data quality detection (v14.30) | `server/data/dataQuality.js` — spike/gap/stale/mismatch |
| Position sizing basics (L2) | NetLiq-based formula | `server/trading/*` + `config/settings.json` risk block |
| Backtest infrastructure | 13-year data, Compare + Optimize tabs | `server/backtest/engine.js`, `public/backtest2.html` |

**Implication:** when implementing Track 1 features, reuse these systems rather than paralleling them. The regime banner reads from existing breadth + existing VIX proxy + new BBB/VVIX feeds.

---

## Track 1: Immediate Bolt-Ons (Weeks 1-8)

Features that don't touch the existing trading engine. All are gated behind feature flags for A/B measurement against current paper trading.

### 1A. BBB + VVIX Data Feeds (Week 1)

**What:** Add VIX futures data and VVIX data to Databento pipeline.

**Why:** BBB calculation (L16) requires VIX futures close/open on specific days each month. VVIX is a separate product Databento offers. Neither exists in current feeds (current VIX is realized-vol proxy from MNQ).

**Files to add:**
- `server/data/vixFutures.js` — Databento VX futures ingestion (monthly contracts)
- `server/data/vvix.js` — VVIX historical + live feed

**Databento symbols needed:**
- `VX.c.0` (VIX front-month continuous)
- `VX.c.1` (VIX second-month, for BBB calc)
- VVIX (check Databento availability — may require alternate source)

**Data storage:**
- `data/historical/vix_futures/{YYYY-MM-DD}.json`
- `data/historical/vvix.json`

**API routes:**
- `GET /api/vix-futures/current`
- `GET /api/vvix/current`

**Effort:** M. Mostly integration work similar to existing DX pipeline (L: v12.7 Phase 1b loop 5).

### 1B. BBB Calculator (Week 1-2)

**What:** Monthly Bull Bear Breakpoint computation. Captures VIX futures close at 5pm ET Tuesday before 3rd Wednesday, next contract open at 6pm ET same Tuesday, computes midpoint, stores as monthly constant.

**Files to add:**
- `server/analysis/bbb.js` — BBB calculator + scheduler
- Data written to `data/historical/bbb.json` (monthly values)

**Logic:**
```javascript
// Runs monthly on the Tuesday before 3rd Wednesday
// At 5:00pm ET: capture VX front-month close
// At 6:00pm ET: capture VX next-month open
// BBB = (close + open) / 2
// Store with effective date range (3rd Wed to next 3rd Wed)
```

**UI surface:** BBB value + "VIX vs BBB" status in topbar widget.

**API routes:**
- `GET /api/bbb/current` — returns current month's BBB
- `GET /api/bbb/history` — returns last 12 months

**Effort:** S. Pure calculation on top of Track 1A data.

### 1C. Greater Market Regime Banner (Week 2-3)

**What:** Combined 5-indicator dashboard element showing Golden / Mixed / Garbage classification per L15-L16.

**Inputs:**
1. DD Ratio equivalent — derive from existing `equityBreadth` + zone proximity
2. MHP status — derive from existing HP fields
3. Monthly Maps — compute from existing options data at 3-month horizon (new: extends current HP to 3m)
4. VIX vs BBB — from Track 1A + 1B
5. VVIX — from Track 1A

**Classification logic:**
- **Golden:** All 5 indicators bullish, VIX < BBB, VVIX < 100
- **Garbage:** VIX > BBB AND VVIX > 100 — suggest skip-month
- **Mixed:** Everything else

**Files to add:**
- `server/analysis/regimeBanner.js` — classifier
- Updates to `public/js/alerts.js` — render banner at top of dashboard
- Updates to `public/css/dashboard.css` — banner styling

**API routes:**
- `GET /api/regime/banner` — full 5-indicator breakdown + classification

**Trade record additions:**
- `regimeClassification` — `'golden' | 'mixed' | 'garbage'`
- `bbb`, `vvix` fields

**Effort:** M. Composition layer on existing data + Track 1A/1B.

### 1D. Irrational Rules Overlay (Week 3-5)

**What:** The 4 formal sit-out rules from L11-L12 as veto conditions on alerts.

**Rules to implement:**

1. **DD Band break** — price > 1 strike beyond DD band limits → veto alerts, `veto_reason: 'dd_band_break'`
2. **MHP break** — price > 1 strike through MHP → veto alerts, `veto_reason: 'mhp_break'`
3. **Index Catalyst** — price crosses calculated Cat Line → AUTO SIT-OUT banner, veto ALL alerts
4. **VIX RI break** — VIX moves > 1 Risk Interval from Globex session low → AUTO SIT-OUT banner
5. **Circuit Breaker Proximity** — within 5% of -7% circuit breaker → AUTO SIT-OUT banner

**Files to add:**
- `server/analysis/irrationalRules.js` — rule evaluator
- Integration into `server/index.js` alert broadcast pipeline (veto before WS push)

**Feature flag:** `features.irrationalRulesOverlay` (default off initially for A/B measurement)

**Trade record additions:**
- `vetoedBy` — if rule fired but we overrode for research, track it
- `rulesActive` — array of active rules at alert time

**UI surface:**
- Dashboard banner when AUTO SIT-OUT rules fire: "MARKET IS IRRATIONAL — SITTING OUT"
- Per-alert red X badge if vetoed

**Effort:** M. Requires Cat Line math (new) and VIX RI calculation (extends existing VIX proxy).

**Measurement plan:** Run in shadow mode for 30 days. Compare paper-trade WR with vs without vetoes. If veto rules improve WR by ≥1pp without losing >10% of trades, enable by default.

### 1E. TFP / Account Management Module (Week 5-7)

**What:** Entirely new module for Trader Funding Program budgeting and account-type-specific execution per L18-L19.

**Sub-features:**

1. **TFP Budgeting Calculator** — budget → accounts → days → loss/day → trades → position size formula
2. **Firm Comparison Dashboard** — FundedNext, MyFundedFutures, ETF, Tradeify, Apex, TakeProfit side-by-side (vetted list from L18)
3. **Account-Type Position Calculator** — static / trailing / EOD specific sizing (L19)
4. **Apex Squeeze Warning** — block position sizes exceeding calculated max for drawdown type
5. **Earn-Your-Static Tracker** — progress toward static conversion
6. **Tax Drag Calculator** — SIM-funded (37%) vs Live (60/40) vs Own Account retention
7. **Self-Funding Pipeline Visualizer** — stages from "paying in" to "own account funded"

**Files to add:**
- `server/analysis/tfpCalculator.js` — sizing and budgeting logic
- `server/analysis/firmCatalog.js` — firm data (manual-updated; firms change frequently)
- `public/tfp.html` — new page for TFP module
- `public/js/tfp.js` — frontend logic
- `public/css/tfp.css` — styling
- `data/tfp/user-accounts.json` — user's active prop firm accounts
- `data/tfp/budgets.json` — monthly budget tracking

**API routes:**
- `GET /api/tfp/firms` — vetted firm catalog
- `POST /api/tfp/calculate-position` — position size for given account
- `GET /api/tfp/accounts` — user's active accounts
- `POST /api/tfp/accounts` — add account
- `GET /api/tfp/pipeline` — self-funding status

**Integration points:**
- Navigation: add "TFP" link to main nav alongside Backtest, Performance, Commentary
- Position calculator overlay appears when user is about to size a trade (warns if exceeds account max)

**Effort:** L. Entirely new module. Mostly isolated from existing trading engine. Can ship independently.

**Priority rationale:** L18/L19 flag TFP Calculator as single highest-impact behavioral change. And this module doesn't risk existing paper trading at all.

### 1F. Enhanced Claude Commentary (Week 7-8)

**What:** Extend `server/ai/commentary.js` to include bootcamp-framework context in Claude prompts.

**New context added to prompts:**
- Current BBB vs VIX (from 1B)
- Current VVIX
- Regime classification (from 1C): Golden/Mixed/Garbage
- Trade time by regime recommendation (Golden: 30-60 min, Mixed: 10-30 min, Garbage: 5-10 min)
- Any active Irrational Rules (from 1D)
- Cross-reference to applicable lessons for deeper explanation

**Files modified:**
- `server/ai/commentary.js` — prompt builder enhancement
- No new files

**Effort:** S. Prompt engineering only. No architectural change.

**Measurement:** Compare commentary quality before/after via manual review of 20 alerts. Commentary already has rate limiting in place.

---

## Track 2: Medium-Term Research (Weeks 9-24)

Experimental features that may or may not graduate to production. Each runs through the existing backtest and paper-trade validation loop before integration.

### 2A. MHP-Bounce as New Setup Type (Weeks 9-14)

**Goal:** Test whether bootcamp-style MHP bounces outperform `pdh_breakout` as the secondary setup.

**Hypothesis:** MHP has a 90% ideal / 73% any hold rate per L7. If this holds in backtest data, it's a more reliable setup than the currently-marginal `pdh_breakout` (Net +$3K on 8-year data).

**Implementation plan:**

1. Add `mhp_bounce` as new detection function in `server/analysis/setups.js`
2. Detection criteria:
   - Price reaches MHP level (±0.25 × ATR)
   - Confluence required: DD Ratio bullish OR neutral, HP within proximity
   - Direction: long only (bootcamp rule)
   - Entry: first bar close reversing off MHP
3. Run M-series backtests (M1 = baseline, M2 = with regime gating, M3 = with BBB gating, etc.)
4. Pass criteria: WR ≥ 50% AND PF ≥ 1.5 on 24-month window (tighter than B8b because setup is theoretically higher quality)

**Files to add:**
- Setup detection in `server/analysis/setups.js`
- Scoring logic in same file (use existing confidence framework)
- New test configs in `data/analysis/M_test_configs.json`

**Decision point (end of Week 14):**
- If PASS: add as production setup, consider replacing `pdh_breakout` if superior
- If FAIL: document findings, leave `pdh_breakout` as-is

**Effort:** M. Adds new setup in existing framework; doesn't touch engine internals.

### 2B. Bootcamp-Style Zone Rejection (Weeks 11-16)

**Context:** Your ZR track has `zone_rejection` failing. The bootcamp's version of zone rejection is more specific: entries only at Bull Zone Bottom or Bear Zone Top with HP confluence, not generic zone retests. Might be the missing variable.

**Hypothesis:** The R:R inversion on ZR is because the current implementation treats all zones equally. Bootcamp-defined BZB/BRZT (with specific HP proximity + direction constraints) may have higher structural edge.

**Implementation plan:**

1. Define BZB/BRZT precisely in code (from L3, L14):
   - BZB: bottom of bull zone + HP within ±1 strike + bullish greater market
   - BRZT: top of bear zone + HP within ±1 strike + bearish greater market
2. Add as ZR-G variant to existing ZR rescue track
3. Pass criteria: same as current ZR track (WR ≥ 45% AND PF ≥ 1.2 AND AvgWin ≥ AvgLoss)

**Files modified:**
- `server/analysis/setups.js` — refine `_zoneRejection()` with BZB/BRZT logic
- Feature flag to run bootcamp-style ZR alongside current ZR-F (which is the approved production candidate)

**Decision point:** If ZR-G passes, consolidate ZR-F + ZR-G into production. If fails, confirm ZR track closure.

**Effort:** M. Touches existing disabled setup, not the validated production setups.

### 2C. Bootcamp Framework A/B Measurement (Weeks 15-24)

**Goal:** Empirically measure whether bootcamp overlays (regime banner + irrational rules + enhanced commentary) improve paper trading results.

**Method:** Continue paper trading with feature flags on for bootcamp Track 1 features. Compare cohorts:
- **Cohort A:** alerts fired without bootcamp vetoes (historical baseline v14.x)
- **Cohort B:** alerts fired with all Track 1 overlays active

**Metrics:**
- WR delta by regime (Golden / Mixed / Garbage)
- WR delta when Irrational Rules vetoed alerts (did we avoid bad trades?)
- Commentary quality self-assessment (manual review)

**Decision points (end of Week 24):**
- If Irrational Rules improve WR by ≥1pp: make them default-on
- If Golden/Mixed/Garbage classification correlates with setup performance: use as confidence modifier (up to ±10 pts)
- If no bootcamp overlay shows measurable benefit: document findings, reconsider integration approach

**Effort:** M. Data collection + analysis, not new code.

### 2D. Account-Type-Aware Paper Trading Simulator (Weeks 18-22)

**What:** Extend the forward-test simulator to simulate trading within prop firm constraints (drawdown type, DLL, consistency rules) rather than unbounded paper trading.

**Why:** Current paper trading assumes unlimited capital and no firm rules. Real prop firm trading is materially different — Apex Squeeze patterns, consistency rule violations, drawdown trailing all affect real outcomes.

**Implementation plan:**
1. User selects a "simulated firm + account type" in dashboard
2. Forward test simulator enforces that firm's rules
3. Separate `forward_trades_tfp.json` log per simulated account
4. Compare actual P&L vs "would have blown up by day X" for each account

**Files to add:**
- `server/trading/tfpSimulator.js` — extends existing simulator with firm rules
- UI additions in `forwardtest.html`

**Effort:** L. Extends existing simulator meaningfully.

**Value:** Lets Jeff use FuturesEdgeAI to validate whether his edge would survive real prop firm constraints before paying for accounts.

---

## Track 3: Long-Term / Deferred Indefinitely

These changes have strategic implications but aren't scheduled. Revisit only if a specific trigger fires.

### 3A. Liquidity Map as Primary Chart Visualization

**What:** Replace or supplement the current TradingView Lightweight Charts primary visualization with a Liquidity Map view showing Bull Zones, Bear Zones, MHP, DD Band, and liquidity pockets as the central interface.

**Why deferred:** Large UX redesign. Unclear ROI given existing chart with layer toggles already surfaces most of this data. Would require significant frontend work.

**Trigger to revisit:** If user research (with external bootcamp-community users if FuturesEdgeAI ever ships beyond Jeff) shows LM is the expected primary interface.

### 3B. Replacing `or_breakout` with Bootcamp Entries

**What:** Substitute the validated B9 `or_breakout` setup with bootcamp-style entries (MHP bounce, BZB/BRZT) as primary setups.

**Why deferred:** B9 forward-tested edge is real money on the table. The bootcamp entries are theoretical until Track 2A/2B proves them in backtest + forward test.

**Trigger to revisit:** Track 2A shows MHP-bounce with substantially superior stats AND paper trading validates it with 500+ trades at WR ≥ 50% / PF ≥ 1.8.

### 3C. Dedicated Mobile App

**What:** Native iOS/Android app vs current PWA approach.

**Why deferred:** Current PWA serves the single-user (Jeff) use case adequately. Native app is only justified if FuturesEdgeAI ships to an audience.

### 3D. Signal Generation from Claude (AI-generated setups)

**What:** Claude API decides when to alert, not just commentate.

**Why deferred:** Explicitly out of scope per AI_ROADMAP.md ("AI nudges, the engine decides"). Core architectural principle.

---

## Integration with Existing Active Tracks

FuturesEdgeAI has several active tracks in ROADMAP.md and AI_ROADMAP.md. The bootcamp work slots alongside them:

| Existing track | Bootcamp interaction |
|---|---|
| **B-series backtesting** | No interference. Bootcamp Track 2A (MHP-bounce) adds M-series as sibling. |
| **ZR rescue (Zone Rejection)** | Track 2B extends ZR with bootcamp-style zone definitions as ZR-G variant. |
| **IA-series (Indicator Calibration)** | No direct overlap. Could add IA4 after bootcamp Track 2C measurement: "Does regime classification improve weight calibration?" |
| **Paper Trading Collection (500+ trades)** | Track 2C runs in parallel — collect with and without bootcamp overlays. |
| **AI/ML Phase 3 (decision tree)** | Bootcamp regime fields (bbb, vvix, regimeClassification) added to trade records will feed Phase 3 features. |
| **EdgeLog SaaS (deferred)** | Bootcamp TFP module (Track 1E) is a natural predecessor. Could be the core of EdgeLog's paid tier. |

**No existing track is invalidated by the bootcamp integration.** The bootcamp provides new features (Track 1), new research hypotheses (Track 2), and enriched context for existing work (commentary, trade records, ML features).

---

## 90-Day Build Order (Weeks 1-12)

| Week | Focus | Deliverable | Risk to existing paper trading |
|---|---|---|---|
| 1 | VIX futures + VVIX data feeds (1A) | New Databento feeds integrated | None (additive) |
| 2 | BBB calculator (1B) | Monthly BBB computation live | None |
| 2-3 | Regime banner (1C) | Golden/Mixed/Garbage UI element | None (display only) |
| 3-5 | Irrational Rules overlay (1D) | 4-rule veto system, feature-flagged OFF initially | None (shadow mode) |
| 5-7 | TFP module (1E) | New `/tfp.html` page, budgeting calc, firm catalog | None (isolated module) |
| 7-8 | Enhanced Claude commentary (1F) | Bootcamp context in prompts | None (commentary only) |
| 9-12 | Track 2 research begins | M-series backtest planning, ZR-G spec, A/B metrics collection | None (research) |

**After Week 12 checkpoint:**
- All Track 1 features live and stable
- Track 2A (MHP-bounce) backtests running
- Track 2C measurement data accumulating
- Paper trading still on validated B9 config, unchanged
- Decision point: enable Irrational Rules by default if Track 2C data supports it

---

## Success Metrics

How to know if the bootcamp integration is working:

**Quantitative (measured against paper trading data):**
- Irrational Rules veto improves WR by ≥1pp without losing >10% of trades
- Regime classification correlates with setup performance at r ≥ 0.3
- Commentary relevance score ≥ 8/10 in manual review (20 alerts sampled)
- Track 2A MHP-bounce hits pass criteria (WR ≥ 50%, PF ≥ 1.5)
- TFP module prevents ≥1 "would have blown up" moment per simulated quarter

**Qualitative:**
- BBB/regime banner provides information you act on weekly
- TFP module becomes your reference for any prop firm decision
- Enhanced commentary explains alerts in framework terms you can verify
- Paper trading session review time decreased (framework context reduces interpretation work)

**Anti-goals (things we don't want):**
- Over-filtering alerts to the point where opportunity cost exceeds WR gain
- Framework overlays becoming noise rather than signal
- Paper trading performance degrading due to bootcamp integration
- Rebuilding already-solved problems (DD Band, HP, breadth) under bootcamp names

---

## Cross-Cutting Concerns

### New data feeds required

| Feed | Source | Status | Effort |
|---|---|---|---|
| VIX futures (VX.c.0, VX.c.1) | Databento GLBX.MDP3 | New | Small (existing pattern) |
| VVIX | Databento (check product) or alternative | New | Small-Medium |
| Cat Line math | Computed from existing index data | Derivable | Small |

### User profile additions

| Field | For | Where |
|---|---|---|
| Monthly TFP budget | TFP module | `data/tfp/budgets.json` |
| Active prop firm accounts | TFP module | `data/tfp/user-accounts.json` |
| Tax bracket / filing status | Tax drag calculator | Settings UI |
| Risk tolerance preference | Account-type recommender | Settings UI |

### Feature flags to add

All new bootcamp features gated behind flags for A/B testing:

```json
{
  "features": {
    "bbbRegime": false,
    "irrationalRulesOverlay": false,
    "tfpModule": true,
    "enhancedCommentary": false,
    "regimeBanner": false
  }
}
```

Default OFF for measurement features (bbbRegime, irrationalRulesOverlay, enhancedCommentary, regimeBanner) until Track 2C data validates them. Default ON for TFP module (it's a new standalone module with no impact on trading logic).

### Database/schema changes

New fields on trade records (for ML Phase 3 + future analysis):
- `bbb` (number) — BBB value at trade entry
- `vvix` (number) — VVIX at trade entry
- `regimeClassification` ('golden' | 'mixed' | 'garbage')
- `activeIrrationalRules` (string[]) — which rules were firing at entry
- `vetoedBy` (string | null) — if veto would have blocked but was overridden

Existing fields preserved. Schema additive.

### Integration with ROADMAP.md / AI_ROADMAP.md

After implementing:
- Update `ROADMAP.md` to reference bootcamp track alongside B/ZR/IA series
- Update `AI_ROADMAP.md` to include `bbb`, `vvix`, `regimeClassification` in Phase 3 feature list
- Update `CLAUDE.md` instrument table if VIX futures / VVIX symbols added to instruments.js

### Relationship to EdgeLog

The TFP module (Track 1E) is architecturally the skeleton of EdgeLog's premium features. When EdgeLog becomes active (post paper-trading stability):
- TFP budgeting → EdgeLog user onboarding
- Firm catalog → EdgeLog firm selection flow
- Account-type position calculator → EdgeLog trade validation
- Self-funding pipeline → EdgeLog progress tracking

Build the TFP module in FuturesEdgeAI first (single-user validation). Port to EdgeLog architecture when EdgeLog launches.

---

## Framework Completeness Criteria

At 100% Track 1 completion, FuturesEdgeAI will have:

- **Existing validated edge preserved** — B9 paper trading unchanged
- **Regime awareness added** — 5-indicator Greater Market banner with BBB/VVIX
- **Sit-out discipline enforced** — 4 Irrational Rules with auto-veto
- **Framework-grounded commentary** — Claude prompts include bootcamp context
- **Prop firm operational layer** — TFP budgeting, account-type sizing, Apex squeeze warnings
- **Self-funding pipeline visibility** — tax drag, exit readiness scoring

At 100% Track 2 completion (if experiments succeed):
- MHP-bounce as production setup (if Track 2A passes)
- Bootcamp-style zone rejection (if Track 2B passes)
- Empirically-validated bootcamp overlays with measured WR impact
- Account-type-aware paper trading simulator

Track 3 remains deferred unless explicit trigger fires.

---

## Rollback Plan

Every Track 1 feature ships with a kill switch:

1. **Feature flag OFF** — disables the feature without code change
2. **Fallback to existing behavior** — if bootcamp feature breaks, alert pipeline continues normally
3. **Shadow mode** — Irrational Rules run in measurement mode without vetoing for first 30 days
4. **Trade record fields nullable** — new fields don't break existing analysis if not computed

If any Track 1 feature causes paper trading degradation:
1. Disable feature flag immediately
2. Investigate via Track 2C data
3. Either fix or remove

Paper trading has real money implications (eventually, when Ironbeam live replaces paper). The engine of `or_breakout` + confidence scoring + B9 config is the load-bearing element. Bootcamp integration is an augmentation, not a replacement.

---

## Revision History

- **2026-04-19 (hybrid plan)** — Revised from original greenfield-framed roadmap after reading actual FuturesEdgeAI v14.30 project docs (CLAUDE.md, ROADMAP.md, AI_ROADMAP.md, CONTEXT_SUPPLEMENT.md, DATABENTO_PROJECT.md, CHANGELOG.md). Original version assumed app was early-stage; this version acknowledges it's production-ready and frames bootcamp work as additive.
- **2026-04-19 (greenfield, superseded)** — Initial greenfield roadmap generated from bootcamp lesson files alone. Assumed FuturesEdgeAI was early-stage. **Superseded by this version.**

---

*Next action when resuming: start Track 1A (VIX futures + VVIX data feeds) in a fresh conversation with CLAUDE.md + this roadmap as context.*
