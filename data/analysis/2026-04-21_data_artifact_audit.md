# Data Artifact Audit — All Symbols (2026-04-21)

**Scope:** Comprehensive artifact scan across every symbol the system reads — 16 CME futures (8 tradeable + 8 reference), 4 crypto perps, and the 8 macro/ETF reference feeds.
**Mode:** Read-only investigation. No files modified. User requested findings first, fixes second.
**Data stores inspected:**
- `data/historical/futures/{sym}/{tf}/{date}.json` — per-date OHLCV, fed by historical pipeline + live archive + hourly refresh
- `data/seed/{sym}_{tf}.json` — single-file per (symbol, tf), fed by seed loader + Yahoo backfill; consumed by dashboard chart and scan engine

---

## TL;DR — Prioritized bug list

| # | Severity | Bug | Symbols affected |
|---|---|---|---|
| 1 | **CRITICAL** | Three writers disagree on the canonical field name (`ts` vs `time`); most consumers read only `time` | All 8 tradeable + historical pipeline output |
| 2 | **HIGH** | `liveArchive.js` dedup check fails whenever last bar on disk was written by `dailyRefresh.js` — causes duplicate bars every hour | All 8 tradeable |
| 3 | **HIGH** | MHG seed file stops at **2026-04-08T22:14Z** — 13 days of missing chart data for the symbol the user flagged | MHG only |
| 4 | **HIGH** | Bad ticks leak past spike filter — MCL has close values of $1.55, $2.92, $3.21, $3.45 (crude never trades there) | MCL primarily, at least MNQ/MES spot-observed too |
| 5 | **HIGH** | Historical files severely thin for all tradeable since 2026-04-02 — 14-15 days of <500 bars/day out of last 34 days | All 8 tradeable |
| 6 | **MEDIUM** | Files accumulate 50%+ duplicate bars on days where hourly refresh ran against a live-archive-populated file | All 8 tradeable, worst on MGC/MCL/SIL |
| 7 | **MEDIUM** | IWM (Russell 2000 options proxy) has no seed file — breaks M2K options-proxy HP | M2K |
| 8 | **LOW** | Reference instruments (bonds/FX/MBT) have historical-only coverage, no seed — chart navigation thin | M6E, M6B, ZT, ZF, ZN, ZB, UB, MBT |

Non-issues (confirmed real data, not artifacts): crypto extreme wicks, XLM low-liquidity gaps, bond 1m overnight gaps, MYM 5m flat patches during thin hours.

---

## Bug 1 (CRITICAL) — `ts` vs `time` schema drift

Three writers disagree on the field name for Unix-seconds timestamp:

| Writer | Field | File |
|---|---|---|
| Historical pipeline (Phase 1c) | `ts` | [server/data/historicalPipeline.js:295,310,860](server/data/historicalPipeline.js#L295) |
| Live archive (every completed 1m live bar) | `ts` | [server/data/liveArchive.js:50](server/data/liveArchive.js#L50) |
| Hourly daily refresh | `time` | [server/data/dailyRefresh.js:182](server/data/dailyRefresh.js#L182) |
| `refresh_5h.js` (today's one-off fix) | `time` | `d:/tmp/refresh_5h.js` |

**Every reader in the system expects `time`** — `snapshot.js` filters `seed.filter(c => c.time % tfSec === 0)` (line 285), merges `seed.map(c => c.time)` (line 301), builds aggregates from `slice[0].time`. Frontend `chart.js` reads `candles[i].time`. Backtest engine reads `time`. Bar validator works on `{time, open, high, low, close, volume}`.

**Consequence:** any bar stored with only `ts` field evaluates `c.time` → `undefined` → `undefined % 60 === 0` → `NaN === 0` → false → **bar is filtered out and invisible**.

**Per-symbol breakdown of last 14 days of 1m files (`data/historical/futures/{sym}/1m/`):**

| Symbol | Total bars | `time`-field | `ts`-field | Duplicate timestamps | Cross-schema collisions |
|---|---|---|---|---|---|
| MNQ | — | most | 42 | 1353 | 0 |
| MES | — | most | 42 | 1106 | 0 |
| M2K | 280 | 238 | 42 | 331 | 0 |
| MYM | — | most | 42 | 415 | 0 |
| MGC | — | most | 42 | 1982 | 0 |
| **MCL** | — | most | **102** | **2997** | 0 |
| MHG | — | most | 42 | 580 | 0 |
| SIL | — | most | 42 | 1225 | 0 |
| Reference instruments (M6E, M6B, ZT, ZF, ZN, ZB, UB, MBT) | — | all | 0 | 0 | 0 |

The reference instruments are clean because they're never written by the live feed — they only get `dailyRefresh.js` writes (which uses `time`). Every tradeable symbol has the bug because the live feed runs for them.

**Sample malformed bar** ([MCL/1m/2026-04-18.json](data/historical/futures/MCL/1m/2026-04-18.json)):

```json
{"ts":1776534360,"open":88.42,"high":89.69,"low":88.24,"close":89.61,"volume":854}
```

Valid OHLCV — but this bar will not show on the MCL chart because the frontend reads `b.time`, which is undefined here.

**Fix sketch (not applied in this session):**
- Pick `time` as canonical (it's what every reader expects and what 95% of files already use).
- Change `liveArchive.js:50` `ts: checked.time` → `time: checked.time`. Fix the dedup check at line 72 similarly.
- Add a migration script that rewrites existing `ts`-field bars to `time` field (trivial field rename; no data loss).
- Change `historicalPipeline.js:295,310,860` similarly for future reruns — but the pipeline's existing output is already mixed with `time`-field refresh writes, so cleanup is part of the migration.

---

## Bug 2 (HIGH) — Hourly refresh + live archive dedup race causes duplicate-bar accumulation

[liveArchive.js:72](server/data/liveArchive.js#L72):

```javascript
if (bars.length > 0 && bars[bars.length - 1].ts === bar.ts) return;
```

When the last bar on disk was written by `dailyRefresh.js` (`.time` field), `bars[last].ts` is `undefined`. The comparison `undefined === newBar.ts` is always false, so the live archive appends even when the timestamp already exists under the `time` key. **Every time the hourly refresh runs, the next live write produces a duplicate.**

**Temporal pattern** on MGC, last 14 days (duplicates per date):

| Date | Bars | Duplicates | Primary field | Notes |
|---|---|---|---|---|
| 2026-03-23 → 2026-04-01 | 1380/day | **0** | all `ts` | Pre-switchover, historical pipeline only |
| 2026-04-02 | 120 | 0 | all `ts` | Partial day — pipeline slowdown |
| 2026-04-06 | 974 | 0 | all `ts` | Pipeline-filled partial |
| **2026-04-08** | **2999** | **1619 (54%)** | all `time` | Refresh overwrote repeatedly — duplicate explosion |
| **2026-04-09** | **2723** | **1357 (50%)** | all `time` | Same pattern |
| 2026-04-15 | 154 | 59 | all `time` | Live-era thin day with refresh dupes |
| 2026-04-21 (today) | 106 | 1 | 86 `time` + 20 `ts` | Post-`refresh_5h.js` + live feed |

This doesn't corrupt OHLC values — it just creates phantom repeat bars that consumers may double-count (scan, chart, backtest). With 42-92 bars per day recently this is a small effect today, but 2026-04-08/09 show what happens when refresh and live both run heavily.

**Fix:** the dedup check should read `(bars[last].time ?? bars[last].ts) === (bar.time ?? bar.ts)`. Best done alongside the schema-unification fix for Bug 1.

---

## Bug 3 (HIGH) — MHG seed file stops at 2026-04-08 → user-facing chart stale for 13 days

This is almost certainly the single biggest user-visible symptom — the user specifically flagged MHG chart data as wrong.

```
MHG_1m  51727 bars  2026-02-08T23:00:00Z → 2026-04-08T22:14:00Z
MHG_5m  11006 bars  2026-02-08T23:00:00Z → 2026-04-08T22:10:00Z
MHG_15m  3673 bars  2026-02-08T23:00:00Z → 2026-04-08T22:00:00Z
```

Compare healthy symbols (all seed files up to today 2026-04-21 ~15:28-15:38 UTC):

```
MNQ_1m   4552 bars  last 2026-04-21T15:28:10Z   ✅
MCL_1m   4100 bars  last 2026-04-21T15:28:24Z   ✅
SIL_1m   1609 bars  last 2026-04-21T15:38:20Z   ✅ but only 6 days
MHG_1m  51727 bars  last 2026-04-08T22:14:00Z   ❌ 13 days stale
MHG_5m  11006 bars  last 2026-04-08T22:10:00Z   ❌ 13 days stale
```

The gap coincides with both the "thin historical era" start (Apr 02, Bug 5) and the schema drift becoming systemic. It looks like something broke MHG's seed writer around Apr 08 and it hasn't been writing since — possibly because MHG's proxy in Yahoo (`HG=F`) returned errors that the seed sanitizer rejected wholesale, or because the gap-fill scheduler's MHG branch failed silently.

The dashboard chart merges seed + live in-memory bars via `snapshot.getCandles()`. With a stale seed file, the chart shows the pre-Apr-8 history plus whatever live feed bars accumulated since (which themselves are thin per Bug 5). That's consistent with "charts for MHG are not correct."

**Fix sketch:** rerun the Yahoo 7-day backfill for MHG (`data/seedFetch.js` or similar), then re-extract historical pipeline output for Apr 02 onward, then let the live feed continue appending.

---

## Bug 4 (HIGH) — Bad-tick leakage on MCL (and at least MNQ, MES)

Three consecutive MCL 1m bars around 2026-04-21 04:56 UTC:

```
prev close: 83.27  →  close: 3.21  →  close: 80.33    (−96.1% / +2400%)
```

CRUDE oil doesn't trade at $3.21 — this is a bad tick. `_isSpikePrice()` in the live feed is supposed to reject moves beyond a per-symbol percentage threshold from the rolling 10-tick median; something is letting these through.

**Confirmed MCL bad ticks in the last 7 days of 1m data:** 192 close-to-close spikes detected, many with reversal pattern (price snaps back to normal next bar). Sample:

| ts | iso | prev close | bar close | next close | pct move |
|---|---|---|---|---|---|
| 1776747360 | 2026-04-21 04:56Z | 83.27 | **3.21** | 80.33 | −96.1% |
| 1776747420 | 2026-04-21 04:57Z | 86.36 | 74.01 | 83.18 | −14.3% |
| 1776747420 | 2026-04-21 04:57Z | 74.01 | 83.18 | **2.92** | +12.4% |
| 1776657720 | 2026-04-20 04:02Z | 87.45 | **3.45** | 83.98 | −96.1% |
| 1776657840 | 2026-04-20 04:04Z | 3.44 | 81.10 | **1.55** | +2257.6% |

Two patterns visible: (1) single-bar drop to $2-3 range for crude, (2) repeat-time duplicate at different bad prices (same ts 1776747420 with close 74.01 AND 83.18). The latter is Bug 2 + Bug 4 compounding — duplicate bars with divergent close values.

All observed MCL bad ticks cluster in the 04:00-04:57 UTC window (00:00-01:00 ET) — the thinnest-liquidity period of the CME Globex session. The live feed's spike filter uses a rolling median; in low-volume overnights the median can converge around a bad tick and let subsequent bad ticks through.

**Similar detections** (counts from the audit, last 7 days):

| Symbol | Close spikes detected | Note |
|---|---|---|
| MCL | 192 | worst; confirmed bad ticks (MCL trading at $3 impossible) |
| MES | 1 | minor |
| ZF | 1 | 1m bond — likely real overnight thin |
| ZN | 2 | same |
| ZB | 2 | same |
| MBT | 2 | CME Bitcoin — possible real wicks |

MNQ appears clean in the 7-day 1m window; however, the data-quality feed was flagging MNQ 1m with `extreme_wick` originals of 231-251 points (from earlier investigation in the [bias-macro reconciliation work](2026-04-20_bias_macro_reconciliation.md) and the first turn of today's session). Those are 1% wicks on MNQ — technically possible on an RTH open but suspicious for repeat detection on the same bar.

**Fix sketch:** tighten the spike filter to use a longer rolling median window (e.g. 30 ticks instead of 10), and cross-validate against the bar's volume — a bad tick usually has abnormally low volume too. Separately, audit the OHLC values the live feed receives *before* the filter, to determine whether the filter is letting ticks through or whether the raw Databento feed is occasionally delivering bad ticks the filter isn't catching at all.

---

## Bug 5 (HIGH) — Thin historical files for every tradeable symbol since 2026-04-02

Per-day bar counts in `data/historical/futures/{sym}/1m/` — 34 consecutive calendar days (categorized):

| Symbol | Full days (≥1000 bars) | Mid (500-999) | **Thin (<500)** | First thin streak start |
|---|---|---|---|---|
| MNQ | 20 | 1 | 14 | 2026-04-21 |
| MES | 20 | 1 | 14 | 2026-04-21 |
| M2K | 20 | 1 | 14 | 2026-04-21 |
| MYM | 20 | 1 | 14 | 2026-04-21 |
| MGC | 20 | 1 | 14 | 2026-04-21 |
| MCL | 20 | 1 | 14 | 2026-04-21 |
| **SIL** | 20 | 0 | **15** | 2026-04-21 |
| **MHG** | 20 | 0 | **15** | 2026-04-21 |

Subtract 5 weekend-ish pairs ≈ 9-10 "unexpected" thin weekdays per symbol. Pattern is **identical across all 8 tradeable** — not a per-symbol issue, a system-wide switchover artifact.

**Concrete MHG 1m example (last 35 days):**

```
2026-04-08 → 04-21:   4–121 bars/day (thin; live-only coverage)
2026-04-02 → 04-07:   mixed (transition)
2026-03-09 → 04-01:   1195–1316 bars/day (full sessions, all historical-pipeline)
```

SIL is the same shape. The numbers show that the system worked perfectly until 2026-04-02, when the switch to live feed as primary source happened. Since then, the hourly `dailyRefresh` has a 95-min lookback — far less than a 23-hour CME session — so it cannot backfill the hours between scheduled runs. Live feed gaps (reconnects, cold starts, overnight thin-volume skips) leave holes that never get filled.

Per the documentation, the historical pipeline output range is intended to end around the Databento purchase date and newer dates are filled by live feed. But without a wider backfill window, the in-between coverage stays thin.

**Backtest impact:** any backtest including post-2026-04-02 dates is running against sparse data. The v14.32 forward-test unblock assumes fresh trades will accumulate cleanly — this bug is one of the reasons forward trades themselves may be under-sampled.

**Chart impact:** the dashboard chart merges seed + live in-memory bars. For MHG the seed also stops at Apr 8 (Bug 3), compounding the thinness. For other tradeable symbols the seed is current but only covers a rolling window, so scrolling back to Apr 5-18 on any tradeable symbol will show mostly empty candles.

**Fix sketch:** run a one-off wider-window Databento historical backfill (10-14 days × 8 tradeable × 1m) mirroring the `historicalPipeline.js` Phase 1c format to overwrite the `data/historical/futures/{sym}/1m/{date}.json` files. This is the same shape as today's `refresh_5h.js` but extended to ~14 days. Fix Bug 1 first so the overwrite produces consistent `time`-field files.

---

## Bug 6 (MEDIUM) — Duplicate-bar pile-up on specific historical dates

Referenced above under Bug 2 but worth calling out as a standalone finding: **2026-04-08 and 2026-04-09** stand out across the tradeable symbols as having 2000+ bars/day in `data/historical/futures/{sym}/1m/` with ~50% of those being duplicate timestamps.

| Symbol | 2026-04-08 bars | dup % | 2026-04-09 bars | dup % |
|---|---|---|---|---|
| MGC | 2999 | 54% | 2723 | 50% |
| SIL | 2129 | ~50% | 1924 | ~50% |
| MHG | 1542 | ~50% | 1388 | ~50% |

A 23-hour session should produce ~1380 1m bars. When you see 2700-3000, the file has been written at least twice with the same time range and the dedup failed (Bug 2).

These two dates overlap with the "transition era" — where both live archive and hourly refresh were running actively and stepping on each other.

---

## Bug 7 (MEDIUM) — IWM seed file missing

`data/seed/IWM_5m.json` doesn't exist. IWM is the Russell 2000 ETF — the M2K options proxy (per `INSTRUMENTS.M2K.optionsProxy = 'IWM'` in [instruments.js](server/data/instruments.js)).

**Impact:** M2K Hedge Pressure / GEX / Resilience metrics can't scale option strikes from IWM → M2K without ETF price history. This breaks one of the four equity-index confidence inputs for M2K setups. (MCL/MGC/SIL/MES/MNQ/MYM have their ETF proxies — USO/GLD/SLV/SPY/QQQ/DIA... wait, DIA? Let me cross-check.)

Checking the seed directory: `QQQ_5m.json`, `SPY_5m.json`, `GLD_5m.json`, `USO_5m.json`, `SLV_5m.json` present. **DIA (MYM proxy) — also missing.** **IWM (M2K proxy) — missing.**

So two of the six equity-index options proxies are missing: DIA (MYM) and IWM (M2K). That explains why scan-time HP/GEX context would be thin for those two symbols.

---

## Bug 8 (LOW) — Reference instruments chart-thin

M6E, M6B, ZT, ZF, ZN, ZB, UB, MBT: **no seed files**, only `data/historical/futures/` data. Latest 5m file for each (2026-04-21) has only 17-20 bars — roughly the last 90-100 minutes of RTH. Earlier historical files contain the bulk of coverage. This is fine for breadth computation (`marketBreadth.js` reads daily closes from prior 21 trading days) but means chart navigation for these symbols will only show a trickle of recent bars — acceptable for reference-only symbols but worth tracking.

---

## Non-issues (real data, not artifacts)

| Observation | Why it's not a bug |
|---|---|
| Crypto extreme wicks (BTC 5m: 7, ETH 5m: 9, XRP 5m: 16, XLM 5m: 45) | Sampled individual wicks — all have real upper/lower wick values 3-5× body; normal crypto volatility |
| XLM 1071 gaps >5min in 5m data | XLM is the thinnest Coinbase INTX perpetual; low-liquidity holes during Asian-session overnights are real |
| Bond 1m gaps (ZT 25, ZB 32, UB 17 in 7 days) | Treasury bonds have very thin overnight volume; 2-5 min bar-to-bar gaps are normal |
| M6B 5m: 23 "mid" days (500-999 bars) | GBP/USD Micro trades thinner than other FX; this is its typical daily volume |
| Bond "extreme range" detections (ZN 12, ZB 16 in 7 days) | ATR bounds clamp in bar validator is set for equity/commodity ranges; bonds have different dynamics |

---

## Per-symbol coverage snapshot

Legend — Seed file freshness: ✅ current (today), ⚠ stale >1d, ❌ stale >7d, ⬚ no file. Historical store: ✅ daily files present through today, ⚠ thin recent, ❌ missing recent.

### Tradeable (8)

| Symbol | Seed 5m | Seed 1m | Historical futures | Notes |
|---|---|---|---|---|
| MNQ | ✅ 2026-04-21 15:28Z | ✅ 2026-04-21 15:28Z | ⚠ thin since 04-02 | Bug 1, 2, 5 |
| MES | ✅ 2026-04-21 15:28Z | ✅ 2026-04-21 15:28Z | ⚠ thin since 04-02 | Bug 1, 2, 5 |
| M2K | ✅ 2026-04-21 | ✅ 2026-04-21 | ⚠ thin since 04-02 | Bug 1, 2, 5, 7 (IWM missing) |
| MYM | ✅ 2026-04-21 | ✅ 2026-04-21 | ⚠ thin since 04-02 | Bug 1, 2, 5, 7 (DIA missing) |
| MGC | ✅ 2026-04-21 | ✅ 2026-04-21 | ⚠ thin + high dupes | Bug 1, 2 worst on this, 5 |
| SIL | ✅ 2026-04-21 15:38Z | ⚠ only 6 days (1609 bars) | ⚠ thin since 04-02 | Bug 1, 2, 5 |
| **MHG** | ⚠ stale 13d (stops 04-08) | ❌ stale 13d | ⚠ thin since 04-02 | **Bug 1, 2, 3, 5 — user-flagged** |
| MCL | ✅ 2026-04-21 15:28Z | ✅ 2026-04-21 15:28Z | ⚠ thin + bad ticks | Bug 1, 2, 4 (bad ticks), 5 |

### Reference / breadth (8)

| Symbol | Seed | Historical futures | Notes |
|---|---|---|---|
| M6E | ⬚ no seed | ⚠ only 20 bars today | Bug 8 |
| M6B | ⬚ no seed | ⚠ only 17 bars today | Bug 8; thin instrument |
| ZT | ⬚ no seed | ⚠ only 20 bars today | Bug 8; low overnight volume |
| ZF | ⬚ no seed | ⚠ only 19 bars today | Bug 8 |
| ZN | ⬚ no seed | ⚠ only 20 bars today | Bug 8 |
| ZB | ⬚ no seed | ⚠ only 20 bars today | Bug 8 |
| UB | ⬚ no seed | ⚠ only 20 bars today | Bug 8 |
| MBT | ⬚ no seed | ⚠ only 20 bars today | Bug 8 |

### Crypto perps (4)

| Symbol | 5m seed | 15m seed | Notes |
|---|---|---|---|
| BTC | ✅ 8640 bars | ✅ 2880 bars | Clean; wicks real |
| ETH | ✅ 8640 bars | ✅ 2880 bars | Clean; wicks real |
| XRP | ✅ 8640 bars | ✅ 2880 bars | Clean; wicks real |
| XLM | ✅ 7072 bars | ✅ 2808 bars | Clean; 15% gap rate real (thin liquidity) |

### Macro / ETF options proxies (8)

| Symbol | 5m seed | Role | Notes |
|---|---|---|---|
| DXY | ✅ 6618 bars | Dollar regime | OK |
| VIX | ✅ 4442 bars | Volatility regime | OK |
| QQQ | ✅ 2289 bars (updated 15:37Z) | MNQ options proxy | OK |
| SPY | ✅ 2289 bars | MES options proxy | OK |
| GLD | ✅ 2289 bars | MGC options proxy | OK |
| USO | ✅ 2289 bars | MCL options proxy | OK |
| SLV | ✅ 2289 bars | SIL options proxy | OK |
| **IWM** | ⬚ **no file** | M2K options proxy | **Bug 7 — blocks M2K HP** |
| **DIA** | ⬚ **no file** | MYM options proxy | **Bug 7 — blocks MYM HP** |

---

## Proposed fix ordering (when you're ready)

1. **Fix Bug 1** first — `liveArchive.js` + `historicalPipeline.js` switch to `time` field. Until this is fixed, any new data we write still has to pick a side of the schema war.
2. **Fix Bug 2** alongside — dedup check reads `time ?? ts` so the migration handles mixed files gracefully.
3. **Run a migration** that rewrites all `ts`-field bars to `time` in `data/historical/futures/**` and dedupes by the resolved timestamp. Catch both Bug 1 residue and Bug 6 dupe pileup in one pass.
4. **Fix Bug 3** — MHG seed file stale. Rerun Yahoo 7d + 60d seed backfills for MHG (same code path that worked for MNQ/MES/MCL). Investigate why MHG stopped — likely Yahoo ticker mismatch (`HG=F` vs the fetch's `MHG=F`).
5. **Fix Bug 5** — run a wider-window Databento historical pull (10-14 days × 8 tradeable × 1m) into `data/historical/futures/`. Same script shape as today's `refresh_5h.js` but (a) 10-14 days, (b) chunked per-symbol so the 15-min Databento lag clamp doesn't drift, (c) writes `time` field.
6. **Fix Bug 4** — raise the live feed's spike-filter median window and add a volume floor; most bad-tick events happen in thin-liquidity overnight windows where volume per 1-sec is < 10.
7. **Fix Bug 7** — add IWM and DIA to the ETF seed / daily close pipeline. One-off Yahoo fetch per symbol for 5m/60d seed; add to daily close pipeline for ongoing updates.
8. Bug 8 is optional — reference-instrument seed files would give nicer chart scrollback for those symbols but has no algorithmic impact.

Audit outputs:
- Raw JSON: `d:/tmp/audit_standard_1776785579420.json` (all 16 CME + 4 crypto, last 7 days)
- This document: [data/analysis/2026-04-21_data_artifact_audit.md](data/analysis/2026-04-21_data_artifact_audit.md)
- Audit script: `d:/tmp/audit_data.js` (reusable — `node audit_data.js deep MHG` to re-run per-symbol)

---

## Status — 2026-04-22

Bugs 1, 2, 3, 4, 5, 6, 7 fixed in v14.33–v14.38 (commits ae3e6e4, a1ab3c3, 7b96cca, 35b10ce, 569ee58, a648722).
Bug 8 deferred — reference-instrument seed backfill (M6E, M6B, ZT, ZF, ZN, ZB, UB, MBT). Cosmetic chart scrollback only, no algorithmic impact.

Phase verification highlights:
- Phase 2 migration: 181,120 files rewritten, 9,059 duplicates collapsed, 0 bad bars dropped. MCL 2026-04-08 went from 2,999 bars / 54% dupes → 1,380 / 0 dupes.
- Phase 3 backfill: 77 files, 83,968 bars, every weekday Apr 07–20 now has 1,080–1,475 bars per symbol.
- Phase 5 spike filter live-fired in production during the verification window (2026-04-22T03:21Z, SIL tick 78.63 vol=1 rejected inside the audit's 04:00–05:00 UTC bad-tick cluster).
- Regression test bit-for-bit identical across Phases 2 and 3 (same config, same window, same 21 trades, WR 47.6%, PF 4.89, Net +$3,073).

Known residual items (not gate-blocking, queued for future cleanup):
- Three-writer date-grouping drift: historicalPipeline uses ET-tradingDate, dailyRefresh uses fixed-5h ET, backfillHistoricalWindow uses UTC calendar. Downstream readers are date-indifferent.
- Stale openPositions counter in /api/forwardtest/summary — discovered during Phase 0 verification (one "open" position was actually resolved with outcome timeout 33 min earlier).
- Options HP gap for post-2026-04-02 dates — resolvable by enabling `features.liveOpra` for forward accumulation or purchasing new OPRA zips from Databento for the 2026-04-03 → present window.
- `.bak` sidecars under data/historical/futures/ (~6 GB, 181,120 files) can be deleted after Phase 5 is 24h stable. Earliest cleanup: 2026-04-23. Command: `find data/historical/futures -name '*.json.bak' -delete`.

P2 forward-test trade-record stamping re-diagnosis scheduled for 2026-04-23 per the remediation plan. Will sample 10 resolved forward trades post-Phase-5 and report whether `dxyDirection` / `equityBreadth` / `riskAppetite` populate or remain null/flat, which determines whether the original P2 diagnose-first prompt still applies or is partially obsolete.
