# Bias Panel ↔ Macro Context Reconciliation — Diagnostic

**Date:** 2026-04-20
**Version tag:** v14.27.1 (diagnostic — no code changed)
**Scope:** Reconcile apparent contradictions between the Market Context (macro gates) and Directional Bias panels on the live dashboard. Identify the exact marketContext fields each half reads, document a live capture, and assemble a prioritized fix list. **Diagnosis only — no logic was modified in this session.**

Related files:
- [server/analysis/bias.js](../../server/analysis/bias.js)
- [server/index.js](../../server/index.js) — `/api/bias`, `/api/bias/debug`
- [public/js/alerts.js](../../public/js/alerts.js) — `_computeConviction()` at line 3437
- [server/analysis/setups.js](../../server/analysis/setups.js) — resilience multiplier at lines 1209-1212

---

## 1. Field sources — Directional Bias (11 signals)

Location: `computeDirectionalBias()` in [server/analysis/bias.js](../../server/analysis/bias.js#L131-L305).

| # | Signal | Primary field read | Fallback (in order) | Value → pts |
|---|---|---|---|---|
| 1 | DEX Bias ([bias.js:143](../../server/analysis/bias.js#L143)) | `mktCtx.options.dexBias` | `'neutral'` | bullish +3 / bearish −3 / neutral 0 |
| 2 | DXY Direction ([bias.js:148-161](../../server/analysis/bias.js#L148-L161)) | `mktCtx.breadth.dollarRegime` (priority) | `mktCtx.dxy.direction` → `'flat'` | falling +2 / rising −2 / flat 0. **MCL: forced 0** |
| 3 | Equity Breadth ([bias.js:164-166](../../server/analysis/bias.js#L164-L166)) | `mktCtx.breadth.equityBreadth` | `2` | 4→+3, 3→+1, 2→0, 1→−1, 0→−3 |
| 4 | Risk Appetite ([bias.js:169-171](../../server/analysis/bias.js#L169-L171)) | `mktCtx.breadth.riskAppetite` | `'neutral'` | on +2 / off −2 / neutral 0 |
| 5 | Bond Regime ([bias.js:174-176](../../server/analysis/bias.js#L174-L176)) | `mktCtx.breadth.bondRegime` | `'neutral'` | bearish +1 (yields ↑) / bullish −1 (flight) / neutral 0 |
| 6 | VIX Regime ([bias.js:179-183](../../server/analysis/bias.js#L179-L183)) | `mktCtx.vix.regime` | `'normal'` | low +1 / normal 0 / elevated −1 / crisis −2 |
| 7 | VIX Direction ([bias.js:180-184](../../server/analysis/bias.js#L180-L184)) | `mktCtx.vix.direction` | `'flat'` | falling +1 / rising −1 / flat 0 |
| 8 | Resilience ([bias.js:187-189](../../server/analysis/bias.js#L187-L189)) | `mktCtx.options.resilienceLabel` | `'neutral'` | resilient +1 / neutral 0 / fragile −1 |
| 9 | Market Regime ([bias.js:197-212](../../server/analysis/bias.js#L197-L212)) | `indicators.regime.type` + `.direction` | `null` → `'n/a'`, 0 pts | trend+bull +2, trend+bear −2, range+bull +1, range+bear −1 |
| 10 | Daily HP ([bias.js:217-250](../../server/analysis/bias.js#L217-L250)) | `mktCtx.hp.nearestLevel.price` compared to `mktCtx.hp._currentPrice` | `mktCtx.hp.pressureDirection` | HP<price → support +1 / HP>price → resistance −1 / no optionsProxy → 0 'N/A' |
| 11 | Monthly HP ([bias.js:254-283](../../server/analysis/bias.js#L254-L283)) | `mktCtx.hp.monthlyNearest.{price\|strike\|scaled}` vs `hp._currentPrice` | none (returns 0 'none') | HP<price → support +2 / HP>price → resistance −2 |

---

## 2. Field sources — Macro Gates (6 gates)

Location: `computeSetupReadiness()` in [server/analysis/bias.js:16-121](../../server/analysis/bias.js#L16-L121).

| # | Gate | Primary field read | Fallback | Trigger condition | Effect in AUTO mode |
|---|---|---|---|---|---|
| 1 | DEX Neutral ([bias.js:31,36-46](../../server/analysis/bias.js#L31)) | `mktCtx.options.dexBias` | `null` | `=== 'neutral'` | **blocked** |
| 2 | DXY Rising Late Session ([bias.js:21-29,48-58](../../server/analysis/bias.js#L21-L58)) | `mktCtx.breadth.dollarRegime` → `mktCtx.dxy.direction` → `'flat'`; `currentHour` | same | `dxyDir === 'rising'` AND `hour >= 11` | **blocked** |
| 3 | DXY Rising Penalty ([bias.js:61-69](../../server/analysis/bias.js#L61-L69)) | same as gate 2 | same | `dxyDir === 'rising'` AND `hour <= 10` | caution |
| 4 | Risk-Off + Breadth Collapse ([bias.js:32-33,72-80](../../server/analysis/bias.js#L72-L80)) | `mktCtx.breadth.riskAppetite`, `mktCtx.breadth.equityBreadth` | `'neutral'`, `2` | `=== 'off'` AND `<= 1` | caution |
| 5 | Crisis VIX ([bias.js:34,83-91](../../server/analysis/bias.js#L83-L91)) | `mktCtx.vix.regime` | `'normal'` | `=== 'crisis'` | caution |
| 6 | High-Impact Event Near ([bias.js:97-105](../../server/analysis/bias.js#L97-L105)) | `mktCtx._calendarNearEvent` (injected at route layer — [server/index.js:1541-1544](../../server/index.js#L1541-L1544)) | `false` | `=== true` | caution |

---

## 3. Same-concept, same-field — no field-source divergence found

When this investigation was framed, the working hypothesis was that the two modules read the same concept from different marketContext sub-objects. **They do not.** Both `computeSetupReadiness()` and `computeDirectionalBias()` live in the same file and pull from the same nested paths, with identical fallback priority for DXY direction (`breadth.dollarRegime` → `dxy.direction` → `'flat'`).

| Underlying concept | Macro gate field | Directional bias field | Divergence? |
|---|---|---|---|
| DXY direction | `breadth.dollarRegime` → `dxy.direction` | same, same fallback order | No — identical |
| DEX bias | `options.dexBias` | `options.dexBias` | No |
| VIX regime | `vix.regime` | `vix.regime` (+ `vix.direction` for signal 7) | No |
| Risk appetite | `breadth.riskAppetite` | `breadth.riskAppetite` | No |
| Equity breadth | `breadth.equityBreadth` | `breadth.equityBreadth` | No |
| Calendar event | `_calendarNearEvent` | (not read by bias) | n/a |

**The contradiction the user perceived is not a field-source bug.** It is a combination of four separate issues (detailed in §6):

1. **UI gate labels are static gate-name strings** (e.g. "DXY Rising Late Session", "Crisis VIX"). They remain on-screen whether the gate passes or blocks; a user scanning the list reads the label as a state claim. The real state is encoded in the icon (✓/⚠/✗) and the tooltip `g.detail` string — neither of which is visible at a glance.
2. **Signal-row ✓/✗ is "contributes / does not contribute"**, NOT "agrees / disagrees". [alerts.js:3344-3352](../../public/js/alerts.js#L3344-L3352) checks `s.contribution !== 0`. A `DXY Direction: flat` signal with 0 pts gets ✗ — this is the intended "neutral" display, not a disagreement with the macro panel.
3. **Resilience is scored as always-bearish for `fragile`** (bias.js:188), which is inconsistent with [setups.js:1209-1212](../../server/analysis/setups.js#L1209-L1212) where `fragile` is setup-context-dependent (amplifier, favorable for breakout multipliers: 1.15×).
4. **`_computeConviction()` does not receive macro readiness status** — so a BLOCKED overall state does not force "STAND ASIDE".

---

## 4. Live debug capture

Captured: **2026-04-20T23:38:13.598Z**, ET hour **19**, symbol **MNQ**, mode **auto**.
Endpoint: `GET /api/bias/debug?symbol=MNQ` (already exists — [server/index.js:1562-1641](../../server/index.js#L1562-L1641)).

### Raw inputs (`mktCtx` state used by both modules)

```json
{
  "hp": {
    "nearestLevel": { "type": "Call Wall", "price": 26753, "distance_atr": 1.32 },
    "pressureDirection": "support",
    "currentPrice": 26791.635428431673,
    "monthlyNearest": null
  },
  "regime": { "type": "trend", "direction": "bullish", "strength": 62 },
  "breadth": {
    "equityBreadth": 4,
    "equityBreadthBearish": 0,
    "riskAppetite": "on",
    "riskAppetiteScore": 15,
    "bondRegime": "neutral",
    "dollarRegime": "flat",
    "copperRegime": "bullish",
    "breadthStale": false
  },
  "options": { "dexBias": "neutral", "resilienceLabel": "fragile" },
  "vix": { "level": 18.87, "regime": "normal", "direction": "flat", "stressFlag": false },
  "dxy": { "direction": "flat", "correlationWithSymbol": -0.34, "applicable": true }
}
```

### `readiness` output

```json
{
  "overallStatus": "blocked",
  "blockedCount": 1,
  "cautionCount": 0,
  "gates": [
    { "id": "dex-neutral",          "status": "blocked", "detail": "DEX neutral — options flow has no directional conviction" },
    { "id": "dxy-rising-late",      "status": "pass",    "detail": "DXY flat, hour 19 — no late-session block" },
    { "id": "dxy-rising-penalty",   "status": "pass",    "detail": "DXY flat — no early-session penalty" },
    { "id": "risk-off-breadth",     "status": "pass",    "detail": "Risk appetite: on, equity breadth: 4" },
    { "id": "vix-crisis",           "status": "pass",    "detail": "VIX regime: normal" },
    { "id": "calendar-event",       "status": "pass",    "detail": "No high-impact events nearby" }
  ]
}
```

### `bias` output (score +7/18, bullish strong)

```json
[
  { "label": "Equity Breadth",  "value": "4/4",           "contribution":  3, "direction": "bull" },
  { "label": "Risk Appetite",   "value": "on",            "contribution":  2, "direction": "bull" },
  { "label": "Market Regime",   "value": "trend/bullish", "contribution":  2, "direction": "bull" },
  { "label": "Resilience",      "value": "fragile",       "contribution": -1, "direction": "bear" },
  { "label": "Daily HP",        "value": "support",       "contribution":  1, "direction": "bull" },
  { "label": "DEX Bias",        "value": "neutral",       "contribution":  0, "direction": "neutral" },
  { "label": "DXY Direction",   "value": "flat",          "contribution":  0, "direction": "neutral" },
  { "label": "Bond Regime",     "value": "neutral",       "contribution":  0, "direction": "neutral" },
  { "label": "VIX Regime",      "value": "normal",        "contribution":  0, "direction": "neutral" },
  { "label": "VIX Direction",   "value": "flat",          "contribution":  0, "direction": "neutral" },
  { "label": "Monthly HP",      "value": "none",          "contribution":  0, "direction": "neutral" }
]
```

### What this tells us about the original screenshot

The screenshot the user captured "this afternoon" shows macro status **BLOCKED** alongside a bias of **+7 BULLISH**. With this live pull:

- Only **one** macro gate is actually blocking: `dex-neutral` (`dexBias === 'neutral'`). The other five gates are all passing.
- The user's written reading — "DXY Rising" and "Crisis VIX" presented as contradictory to the bias panel's "flat / normal" — was a misreading of static gate labels. The gate row for "DXY Rising Late Session" was actually showing a pass icon (DXY is flat, hour 19). Same for "Crisis VIX" (VIX regime normal at 18.87).
- The bias panel's ✗ next to `DXY Direction: flat` and `VIX Regime: normal` means **"0 contribution"**, not "disagrees with macro panel".
- The bias panel's ✓ next to `Resilience: fragile` is wrong regardless — `fragile` contributes −1 (bear). The ✓ means "contribution ≠ 0"; it does not mean "contributes in the bullish direction that the overall bias indicates." This is a UI ambiguity, not a score bug.

So the actual dashboard-level bug is smaller than it first looked: one genuine blocking gate (DEX neutral) + a +7 bullish bias → `_computeConviction()` returns **MODERATE SETUP** because DEX-neutral never reaches the conviction function as a blocking signal.

---

## 5. Resilience signal — `fragile` scoring vs. setups.js multiplier

### In `computeDirectionalBias()` — [bias.js:187-189](../../server/analysis/bias.js#L187-L189)

```javascript
const resLabel = marketContext?.options?.resilienceLabel ?? 'neutral';
const resPts = resLabel === 'resilient' ? 1 : resLabel === 'fragile' ? -1 : 0;
addSignal('Resilience', resLabel, resPts);
```

- `resilient` → **+1** (bullish contribution, regardless of setup context or regime)
- `fragile`   → **−1** (bearish contribution, regardless of setup context or regime)
- `neutral`   → 0

### In `applyMarketContext()` / confidence scoring — [server/analysis/setups.js:1208-1212](../../server/analysis/setups.js#L1208-L1212)

```javascript
const rl = marketContext.options?.resilienceLabel ?? 'neutral';
let resilienceMult = 1.0;
if      (rl === 'resilient') resilienceMult = isReversal ? 1.15 : 0.90;
else if (rl === 'fragile')   resilienceMult = isReversal ? 0.90 : 1.15;
```

| Label | Reversal setup | Breakout setup | Meaning |
|---|---|---|---|
| resilient | 1.15× | 0.90× | dealers dampen moves → reversals hold, breakouts fade |
| fragile   | 0.90× | **1.15×** | dealers amplify moves → breakouts extend, reversals fail |
| neutral   | 1.00× | 1.00× | no edge |

### Cross-check with bootcamp Lesson 4 (Resilience)

Lesson 4's "resilience" is a *different concept* — equity-basket implied-move tiebreaker, scale −100..+100, directional and confluence-based. The codebase's `resilienceLabel` is the **options-market resilience** (GEX + DEX dampening score, 0..100 → `fragile`/`neutral`/`resilient` — CONTEXT_SUPPLEMENT.md §Options Data, Resilience Score 0–100). These two resiliences share a name but are not the same tiebreaker. Implementation-wise, the codebase's version is an **amplification indicator**, not a directional one.

### Conclusion on sign consistency

The directional-bias sign for `fragile` (always −1) is **inconsistent with the v9.0 reversal/breakout multiplier table**, which treats `fragile` as a *directional amplifier* that helps breakouts (+15%) and hurts mean-reversions (−10%). In a current live state where:

- `regime.type === 'trend'`, `regime.direction === 'bullish'`
- `resilienceLabel === 'fragile'`

the correct reading is "dealers are amplifying the bullish trend-continuation/breakout" — i.e., `fragile` should contribute **with** the trend, not against it. The present static `fragile → −1` rule is the opposite sign.

This was the user's "suspicious" instinct on the screenshot.

**Status: P1 implemented in v14.31** ([server/analysis/bias.js:186-213](../../server/analysis/bias.js#L186-L213); see CHANGELOG.md v14.31 entry and `git log --grep=v14.31` for the commit hash) — regime-aware contribution: trend context → fragile with regime direction, resilient against; range context → resilient with direction, fragile against; missing/neutral regime → 0. 11-case synthetic harness passes. setups.js multiplier path untouched (display-only, no trade-gating impact).

---

## 6. Does `_computeConviction()` see macro readiness status?

### The function signature — [public/js/alerts.js:3437](../../public/js/alerts.js#L3437)

```javascript
function _computeConviction(setupScore, macroScore) {
  // setupScore: negative = short signal, positive = long signal (range roughly -100 to +100)
  // macroScore: negative = bearish macro, positive = bullish macro (range -18 to +18)
  ...
}
```

**`macroScore` is the signed directional-bias score** (`b.score` from `computeDirectionalBias()`, range −18 to +18), **not** `readiness.overallStatus`.

### Inputs available at the call site — [alerts.js:3498-3516](../../public/js/alerts.js#L3498-L3516)

```javascript
function _renderConviction() {
  ...
  const setupData  = window._lastSetupData;
  const macroScore = window._lastMacroScore;  // bias.score, not readiness status
  ...
  const result = _computeConviction(setupScore, macroScore);
}
```

Neither `readiness.overallStatus` nor `readiness.blockedCount` is threaded into the conviction computation. The `readiness` object is fetched by `fetchAndRenderBias()` and rendered separately into the macro panel, but its verdict is never reconciled with the conviction matrix.

**Effect:** in the live capture above, `readiness.overallStatus === 'blocked'` (DEX neutral gate blocks) AND `bias.score === +7` → `_computeConviction(0, 7)` routes to the `(agree || sameSign) && setupMag >= 20 && macroMag >= 3` branch (only if `setupMag >= 20`; else default). With `setupMag < 20`, the default `STAND ASIDE — Insufficient signal clarity` fires correctly *by accident of missing setup data*. But with any meaningful `setupScore`, the function happily returns `MODERATE SETUP` / `GOOD SETUP` / `HIGH CONVICTION` while the macro is BLOCKED.

### Where macro readiness would need to be threaded

- Capture `window._lastReadinessStatus` at the same place `window._lastMacroScore` is set (search for `_lastMacroScore` assignments in alerts.js — already plumbed through `fetchAndRenderBias()`).
- Pass it as a third argument to `_computeConviction(setupScore, macroScore, readinessStatus)`.
- Add a new first branch: `if (readinessStatus === 'blocked') return { label: 'STAND ASIDE', sublabel: 'Macro gates blocked — do not trade', color: 'conviction-red' };`
- Optionally: `if (readinessStatus === 'caution')` → demote by one tier (e.g. HIGH CONVICTION → GOOD SETUP, GOOD SETUP → MODERATE).

The v14.21 fix only resolved direct directional conflict between setup and bias. Macro-gate BLOCKED was not wired into it.

---

## 7. Forward-test record bug (separate but flagged)

Jeff's prior note: *"dxyDirection has been returning 'flat' for all forward-test trades; equityBreadth and riskAppetite have been null at trade resolution."*

This live capture confirms the bias module *sees* populated `breadth.equityBreadth: 4`, `breadth.riskAppetite: 'on'`, `breadth.dollarRegime: 'flat'`. So the null/flat problem in forward-test records is **not in the bias-module read path**. It is either in:

- `simulator.js` `checkLiveOutcomes()` when it stamps market-context fields onto the resolved trade (possibly reading from a stale or differently-scoped context object)
- The scan-engine write side (`server/index.js` around the `_lastMarketContext.set()` path) when a trade record is composed

This is a distinct investigation from the bias-panel reconciliation work; it should be picked up after items P0–P2 below.

---

## 8. Prioritized fix list (not implemented this session)

### P0 — Macro BLOCKED must force STAND ASIDE

Thread `readiness.overallStatus` through to `_computeConviction()`. Hard-gate label = STAND ASIDE when `blocked`; soft-demote by one tier when `caution`. Scope: `alerts.js` only (`fetchAndRenderBias()`, `_renderConviction()`, `_computeConviction()` signature). ~20 LOC. This is the direct fix for the screenshot regression: BLOCKED macro + bullish bias ≠ MODERATE SETUP.

### P1 — Resilience sign should be setup-context-aware

Replace the static `fragile → −1` / `resilient → +1` rule with a context-aware calculation that mirrors `setups.js:1209-1212`:

- In a **trend/breakout** regime context, `fragile` contributes **with** the trend direction (+1 if bullish regime, −1 if bearish), `resilient` against it.
- In a **range/reversal** context, invert.

Alternative: split into two separate bias signals — "Resilience (Amplification)" and "Resilience (Direction)" — so the user sees both facets. Scope: `bias.js:186-189` only, using `indicators.regime.type` already in scope.

### P1 — Bias-panel gate UI: show state, not gate name

Gate rows currently render the static `g.label` ("DXY Rising Late Session"). Swap to `g.detail` as primary text — or prefix the label with the current value ("DXY flat · hour 19") so a glance conveys state. Keep the static label for passing gates as a secondary tooltip. Scope: `alerts.js:3246-3258`. No backend change.

### P1 — Signal-row ✓/✗ semantics clarification

Users read ✗ as "disagrees with bias direction" but the code sets it whenever `contribution === 0`. Options:

- Change icons: ✓ (aligned with overall bias direction), ➖ (neutral/0 pts), ✗ (against overall bias direction). Requires passing `b.direction` into the signal renderer.
- Or keep current icons and add a legend row at the top of the signal list.

Scope: `alerts.js:3336-3353`. Low risk.

### P2 — Investigate forward-test record stamping

Separate from the bias panel. Trace where `equityBreadth`, `riskAppetite`, `dxyDirection` are written onto resolved trade records in `simulator.js` / alert creation path. Confirm they read from the same `buildMarketContext()` output the bias module uses, and that they snapshot at the correct moment (scan-cycle time, not trade-close time, if that is causing the staleness).

### P2 — Consolidate marketContext sub-object reads

The current field-source alignment between gates and signals is correct only by convention — both hand-written blocks reference the same paths. Introduce a single `deriveMarketSnapshot(mktCtx)` helper that returns `{ dxyDir, dexBias, riskAppetite, equityBreadth, vixRegime, vixDir, resilienceLabel, bondRegime, copperRegime }` with the agreed fallback precedence, and have both `computeSetupReadiness()` and `computeDirectionalBias()` call it. Prevents future drift. Scope: `bias.js` top-of-file, ~20 LOC helper.

### P3 — Conviction row should show WHY

When STAND ASIDE fires because of macro BLOCKED (P0), include the specific blocking gate IDs in `sublabel` (e.g. "Macro BLOCKED — DEX neutral"). Makes the override legible instead of mysterious.

---

## Appendix — lesson references

- **Lesson 4 (Resilience):** equity-basket implied-move tiebreaker. Different from the codebase's options-GEX `resilienceLabel`. Name collision causes confusion when reasoning about sign.
- **Lesson 16 (VIX/BBB/VVIX):** VIX regime matters for *how* to trade (execution style / sizing), not just for a single "crisis" binary gate. The current gate 5 (`crisis` → caution) is coarse; the bootcamp framework uses a 5-tier VVIX scale and a VIX vs BBB comparison that the dashboard doesn't yet surface.
