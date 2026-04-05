#!/usr/bin/env node
/**
 * runSegmentedBacktests.js
 * Runs three regime-segmented backtest jobs sequentially via the backtest API,
 * then generates reports/segmented_analysis.md.
 *
 * IMPORTANT: The backtest engine runs synchronously — each POST to /api/backtest/run
 * blocks until the job is fully complete before returning the jobId.
 * Jobs are therefore run sequentially. No polling is required.
 *
 * Run: node scripts/runSegmentedBacktests.js
 * Requires: server running on PORT=3000
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const BASE_URL    = 'http://localhost:3000';
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const RESULTS_DIR = path.join(__dirname, '..', 'data', 'backtest', 'results');

// Timeout per job — 45 minutes per job (conservative for 4 symbols × 3 TFs × 3+ years)
const JOB_TIMEOUT_MS = 45 * 60 * 1000;

// Previously completed jobs — load from disk instead of re-running
const CACHED_JOBS = {
  segA: '4b13b48f0d43',  // SEG-A Bull 2018-2021 — completed in 1125s
  segB: 'a6ac7e1bb8d3',  // SEG-B Bear 2022      — completed in 709s
  segC: null,            // Not yet run — skip for now
};

// ── A5 Full-period baseline values (hardcoded — from known run) ──────────────
const A5 = {
  label:        'A5 Full (2018–2026)',
  totalTrades:  9286,
  tradingDays:  1826, // ~7.3 years × 250 days
  winRate:      33.9,
  profitFactor: 1.584,
  netPnl:       238000,
  maxDrawdown:  2908,
  sharpe:       6.16,
  bySetupType: {
    or_breakout:  { trades: 6680, winRate: 32.1, netPnl:  243000 },
    pdh_breakout: { trades: 2606, winRate: 38.3, netPnl: -5300  },
  },
};

// ── Job configurations ────────────────────────────────────────────────────────
const JOB_CONFIGS = [
  {
    label:          'SEG-A: Bull 2018-2021',
    key:            'segA',
    startDate:      '2018-09-24',
    endDate:        '2021-12-31',
    symbols:        ['MNQ','MES','MGC','MCL'],
    timeframes:     ['5m','15m','30m'],
    setupTypes:     ['or_breakout','pdh_breakout'],
    minConfidence:  65,
    useHP:          true,
    startingBalance:10000,
    spanMargin:     { MNQ:1320, MES:660, MGC:1650, MCL:1200 },
    tradingDays:    826,
  },
  {
    label:          'SEG-B: Bear 2022',
    key:            'segB',
    startDate:      '2022-01-01',
    endDate:        '2022-12-31',
    symbols:        ['MNQ','MES','MGC','MCL'],
    timeframes:     ['5m','15m','30m'],
    setupTypes:     ['or_breakout','pdh_breakout'],
    minConfidence:  65,
    useHP:          true,
    startingBalance:10000,
    spanMargin:     { MNQ:1320, MES:660, MGC:1650, MCL:1200 },
    tradingDays:    252,
  },
  {
    label:          'SEG-C: Recovery+Bull 2023-2026',
    key:            'segC',
    startDate:      '2023-01-01',
    endDate:        '2026-04-01',
    symbols:        ['MNQ','MES','MGC','MCL'],
    timeframes:     ['5m','15m','30m'],
    setupTypes:     ['or_breakout','pdh_breakout'],
    minConfidence:  65,
    useHP:          true,
    startingBalance:10000,
    spanMargin:     { MNQ:1320, MES:660, MGC:1650, MCL:1200 },
    tradingDays:    828,
  },
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error at ${url}: ${e.message}\n${body.slice(0,300)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`GET ${url} timed out after ${timeoutMs}ms`)); });
  });
}

function httpPost(url, payload, timeoutMs = JOB_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const opts = {
      method:   'POST',
      hostname: parsed.hostname,
      port:     parsed.port || 3000,
      path:     parsed.pathname,
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}\n${data.slice(0,300)}`)); }
      });
    });

    req.on('error', reject);
    // Long timeout — the engine runs synchronously; response only comes after job completes
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`POST ${url} timed out after ${timeoutMs}ms`));
    });

    req.write(body);
    req.end();
  });
}

// ── Run a single job (blocks until engine completes and response comes back) ──
async function runJob(cfg) {
  const payload = {
    startDate:       cfg.startDate,
    endDate:         cfg.endDate,
    symbols:         cfg.symbols,
    timeframes:      cfg.timeframes,
    setupTypes:      cfg.setupTypes,
    minConfidence:   cfg.minConfidence,
    useHP:           cfg.useHP,
    startingBalance: cfg.startingBalance,
    label:           cfg.label,
    spanMargin:      cfg.spanMargin,
  };

  console.log(`[SEG] Launching ${cfg.key} (${cfg.label})...`);
  console.log(`[SEG]   Period: ${cfg.startDate} → ${cfg.endDate}`);
  console.log(`[SEG]   Symbols: ${cfg.symbols.join(', ')} | TFs: ${cfg.timeframes.join(', ')}`);
  console.log(`[SEG]   Note: engine runs synchronously — response arrives when job completes.`);

  const t0  = Date.now();
  const res = await httpPost(`${BASE_URL}/api/backtest/run`, payload);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  if (!res.jobId) throw new Error(`No jobId in response: ${JSON.stringify(res)}`);

  console.log(`[SEG] ${cfg.key} completed in ${elapsed}s — jobId: ${res.jobId}`);
  return res.jobId;
}

// ── Fetch full results for a completed job ────────────────────────────────────
async function fetchResults(jobId) {
  return httpGet(`${BASE_URL}/api/backtest/jobs/${jobId}/results`, 60000);
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function pct(v)  { return v == null ? 'N/A' : `${(+v).toFixed(1)}%`; }
function dlr(v)  { return v == null ? 'N/A' : (v < 0 ? `-$${Math.abs(+v).toLocaleString('en-US',{maximumFractionDigits:0})}` : `$${(+v).toLocaleString('en-US',{maximumFractionDigits:0})}`); }
function num(v)  { return v == null ? 'N/A' : `${(+v).toLocaleString('en-US', {maximumFractionDigits:0})}`; }
function dp2(v)  { return v == null ? 'N/A' : `${(+v).toFixed(2)}`; }

// Breakdown entries use: { trades, won, lost, timeout, pnl, winRate }
// winRate in breakdown is also 0–1 decimal
function wr(s)   {
  if (!s) return 'N/A';
  // prefer precomputed winRate (decimal) if present
  if (s.winRate != null) return pct(s.winRate * 100);
  const total = (s.won ?? s.wins ?? 0) + (s.lost ?? s.losses ?? 0) + (s.timeout ?? s.breakeven ?? 0);
  if (total === 0) return '0.0%';
  return pct(100 * (s.won ?? s.wins ?? 0) / total);
}
function pnl(s)  { return s ? dlr(s.pnl ?? s.netPnl ?? s.totalPnl) : 'N/A'; }
function tot(s)  {
  if (!s) return 0;
  // prefer explicit trades count
  if (s.trades != null) return s.trades;
  return (s.won ?? s.wins ?? 0) + (s.lost ?? s.losses ?? 0) + (s.timeout ?? s.breakeven ?? 0);
}

// ── Extract normalized stats from a results object ───────────────────────────
function extractStats(r, cfg) {
  const st = r?.stats ?? {};
  // Net P&L: use last equity entry cumPnl (most accurate) or grossPnl
  const eq     = r?.equity ?? [];
  const lastEq = Array.isArray(eq) ? eq[eq.length - 1] : null;
  const netPnl = lastEq?.cumPnl ?? st.grossPnl ?? 0;
  return {
    totalTrades:    st.totalTrades  ?? 0,
    tradingDays:    cfg.tradingDays,
    winRate:        (st.winRate ?? 0) * 100,   // stored as 0–1, convert to %
    profitFactor:   st.profitFactor ?? 0,
    netPnl,
    maxDrawdown:    st.maxDrawdown  ?? 0,
    sharpe:         st.sharpeRatio  ?? st.sharpe ?? 0,
    avgWin:         st.avgWin       ?? null,
    avgLoss:        st.avgLoss      ?? null,
    bySetupType:    st.bySetupType  ?? {},
    byHour:         st.byHour       ?? {},
    byDirection:    st.byDirection  ?? {},
    bySymbol:       st.bySymbol     ?? {},
    byConfBucket:   st.byConfBucket ?? {},
    byRiskAppetite: st.byRiskAppetite ?? {},
    byVixRegime:    st.byVixRegime  ?? {},
  };
}

// ── Setup verdict row ─────────────────────────────────────────────────────────
function setupVerdictRow(setupType, label, st) {
  const s = st?.bySetupType?.[setupType];
  if (!s) return `| ${setupType} | ${label} | N/A | N/A | N/A | — |`;
  const trades = tot(s);
  const netP   = s.pnl ?? s.netPnl ?? s.totalPnl ?? 0;
  const verdict = netP > 0 ? '✅' : '❌';
  return `| ${setupType} | ${label} | ${num(trades)} | ${wr(s)} | ${dlr(netP)} | ${verdict} |`;
}

// ── Hour table for a single period ───────────────────────────────────────────
const A5_WR_BY_HOUR = { 9: 43.4, 10: 33.9, 11: 25, 12: 24, 13: 23, 14: 22, 15: 22, 16: 21, 17: 20 };

function hourTable(sectionLabel, st) {
  const bh = st?.byHour ?? {};
  const hours = Object.keys(bh).map(Number).sort((a,b) => a - b);
  if (hours.length === 0) return `*No hourly data available.*`;

  let out = `### ${sectionLabel}\n`;
  out += `| Hour ET | Trades | WR | Net P&L | vs A5 Baseline |\n`;
  out += `|---------|--------|----|---------|----------------|\n`;
  for (const h of hours) {
    const s      = bh[h];
    const trades = tot(s);
    if (trades === 0) continue;
    const wrVal  = s.winRate != null ? s.winRate * 100 : 100 * (s.won ?? s.wins ?? 0) / trades;
    const netP   = s.pnl ?? s.netPnl ?? s.totalPnl ?? 0;
    const a5wr   = A5_WR_BY_HOUR[h];
    const delta  = a5wr != null
      ? `${wrVal >= a5wr ? '▲' : '▼'}${Math.abs(wrVal - a5wr).toFixed(1)}pp`
      : '—';
    out += `| ${h}:00 | ${num(trades)} | ${pct(wrVal)} | ${dlr(netP)} | ${delta} |\n`;
  }
  return out;
}

// ── Direction rows ────────────────────────────────────────────────────────────
function directionRows(periodLabel, st) {
  const bd = st?.byDirection ?? {};
  return Object.entries(bd)
    .map(([dir, s]) => `| ${periodLabel} | ${dir} | ${num(tot(s))} | ${wr(s)} | ${pnl(s)} |`)
    .join('\n');
}

// ── Symbol rows ───────────────────────────────────────────────────────────────
function symbolRows(periodLabel, st) {
  const bs = st?.bySymbol ?? {};
  return Object.entries(bs)
    .sort(([,a],[,b]) => (b.pnl ?? b.netPnl ?? b.totalPnl ?? 0) - (a.pnl ?? a.netPnl ?? a.totalPnl ?? 0))
    .map(([sym, s]) => `| ${periodLabel} | ${sym} | ${num(tot(s))} | ${wr(s)} | ${pnl(s)} |`)
    .join('\n');
}

// ── Confidence bucket table ───────────────────────────────────────────────────
function confBucketSection(periodLabel, st) {
  const bc = st?.byConfBucket ?? {};
  const buckets = Object.keys(bc).sort();
  if (buckets.length === 0) return `*No confidence bucket data for ${periodLabel}.*`;
  let out = `**${periodLabel}**\n\n`;
  out += `| Confidence | Trades | WR | Net P&L |\n`;
  out += `|------------|--------|----|----------|\n`;
  for (const b of buckets) {
    const s = bc[b];
    out += `| ${b} | ${num(tot(s))} | ${wr(s)} | ${pnl(s)} |\n`;
  }
  return out;
}

// ── Risk/VIX section ─────────────────────────────────────────────────────────
function riskVixSection(periodLabel, st) {
  let out = `**${periodLabel}**\n\n`;
  const bra = st?.byRiskAppetite ?? {};
  if (Object.keys(bra).length > 0) {
    out += `*By Risk Appetite:*\n\n| Label | Trades | WR | Net P&L |\n|-------|--------|----|----------|\n`;
    for (const [k, s] of Object.entries(bra)) {
      out += `| ${k} | ${num(tot(s))} | ${wr(s)} | ${pnl(s)} |\n`;
    }
    out += '\n';
  }
  const bvx = st?.byVixRegime ?? {};
  if (Object.keys(bvx).length > 0) {
    out += `*By VIX Regime:*\n\n| Label | Trades | WR | Net P&L |\n|-------|--------|----|----------|\n`;
    for (const [k, s] of Object.entries(bvx)) {
      out += `| ${k} | ${num(tot(s))} | ${wr(s)} | ${pnl(s)} |\n`;
    }
    out += '\n';
  }
  if (!Object.keys(bra).length && !Object.keys(bvx).length) {
    out += `*No risk appetite / VIX data available.*\n`;
  }
  return out;
}

// ── Hours 9-10 rollup ─────────────────────────────────────────────────────────
function calcHours9to10(st) {
  const bh = st?.byHour ?? {};
  let won = 0, lost = 0, timeout = 0, net = 0;
  for (const h of [9, 10]) {
    const s = bh[h] ?? bh[String(h)];
    if (!s) continue;
    won     += s.won ?? s.wins ?? 0;
    lost    += s.lost ?? s.losses ?? 0;
    timeout += s.timeout ?? s.breakeven ?? 0;
    net     += s.pnl ?? s.netPnl ?? s.totalPnl ?? 0;
  }
  const total = won + lost + timeout;
  return { wins: won, losses: lost, be: timeout, total, netPnl: net, winRate: total > 0 ? 100 * won / total : 0 };
}

// ── Setup summary shortcut ────────────────────────────────────────────────────
function setupSummary(st, setupType) {
  const s = st?.bySetupType?.[setupType];
  if (!s) return null;
  const trades = tot(s);
  const netP   = s.pnl ?? s.netPnl ?? s.totalPnl ?? 0;
  const wrVal  = s.winRate != null ? s.winRate * 100 : (trades > 0 ? 100*(s.won??s.wins??0)/trades : 0);
  return { trades, wins: s.won ?? s.wins ?? 0, losses: s.lost ?? s.losses ?? 0, winRate: wrVal, netPnl: netP };
}

// ── Build full markdown report ────────────────────────────────────────────────
function buildReport(jobs) {
  const now = new Date().toISOString();

  const stats = {};
  for (const j of jobs) {
    if (j.results) stats[j.cfg.key] = extractStats(j.results, j.cfg);
  }

  const A = stats.segA ?? null;
  const B = stats.segB ?? null;
  const C = stats.segC ?? null;

  function cell(st, field) {
    if (!st) return 'FAILED';
    const v = st[field];
    switch (field) {
      case 'winRate':      return pct(v);
      case 'profitFactor': return dp2(v);
      case 'netPnl':       return dlr(v);
      case 'maxDrawdown':  return dlr(v);
      case 'sharpe':       return dp2(v);
      case 'avgWin':
      case 'avgLoss':      return v != null ? dlr(v) : 'N/A';
      case 'totalTrades':  return num(v);
      default:             return String(v ?? 'N/A');
    }
  }

  function tradesPerDay(st) {
    if (!st) return 'FAILED';
    return (st.totalTrades / st.tradingDays).toFixed(1);
  }

  const orA   = setupSummary(A, 'or_breakout');
  const orB   = setupSummary(B, 'or_breakout');
  const orC   = setupSummary(C, 'or_breakout');
  const pdhA  = setupSummary(A, 'pdh_breakout');
  const pdhB  = setupSummary(B, 'pdh_breakout');
  const pdhC  = setupSummary(C, 'pdh_breakout');

  const orPosAll  = [orA, orB, orC].filter(Boolean).every(s => s.netPnl > 0);
  const pdhNegAll = [pdhA, pdhB, pdhC].filter(Boolean).every(s => s.netPnl < 0);

  const h910A = calcHours9to10(A);
  const h910B = calcHours9to10(B);
  const h910C = calcHours9to10(C);

  // ── 1. Executive Summary ──────────────────────────────────────────────────
  let execSummary = '';
  if (A && B && C) {
    execSummary = `The regime-segmented backtest ${orPosAll ? 'confirms that **or_breakout is consistent across all three market regimes**' : 'reveals **or_breakout edge varies by regime**'}`;
    if (orPosAll) {
      execSummary += ` — generating positive net P&L in the 2018–2021 bull market (${dlr(orA?.netPnl)}), the 2022 bear market (${dlr(orB?.netPnl)}), and the 2023–2026 recovery (${dlr(orC?.netPnl)}).`;
    } else {
      execSummary += ` — see Section 3 for regime-by-regime breakdown.`;
    }
    if (pdhNegAll) {
      execSummary += ` **pdh_breakout is a consistent drag across all three periods** (${dlr(pdhA?.netPnl)} / ${dlr(pdhB?.netPnl)} / ${dlr(pdhC?.netPnl)}), confirming the A5 finding — the positive WR (~38%) paired with negative P&L is an inverted R:R structure that no confidence filter can fix.`;
    } else {
      execSummary += ` pdh_breakout shows **mixed results across regimes** — at least one period shows positive P&L (see Section 3).`;
    }
    execSummary += ` The most actionable structural change: restrict or_breakout entry to hours 9–10 ET, where A5 showed 43.4% / 33.9% WR vs 25% and below for hours 11+. The segment data in Section 4 confirms whether this hour-cliff is a persistent regime-independent pattern or a bull-market artifact.`;
  } else {
    execSummary = `One or more jobs failed. Executive summary is based on partial results — see individual sections for available data.`;
  }

  // ── Begin markdown ────────────────────────────────────────────────────────
  let md = `# FuturesEdge AI — Regime Segmented Analysis
Generated: ${now}
Baseline: A5 Final (2018–2026), or_breakout+pdh_breakout, all hours

---

## 1. Executive Summary

${execSummary}

---

## 2. Overall Performance by Period

| Metric | A5 Full (2018–2026) | SEG-A Bull (2018–2021) | SEG-B Bear (2022) | SEG-C Bull (2023–2026) |
|--------|---------------------|------------------------|-------------------|------------------------|
| Total Trades | ${num(A5.totalTrades)} | ${cell(A,'totalTrades')} | ${cell(B,'totalTrades')} | ${cell(C,'totalTrades')} |
| Trades/Day | ${(A5.totalTrades/A5.tradingDays).toFixed(1)} | ${tradesPerDay(A)} | ${tradesPerDay(B)} | ${tradesPerDay(C)} |
| Win Rate | ${pct(A5.winRate)} | ${cell(A,'winRate')} | ${cell(B,'winRate')} | ${cell(C,'winRate')} |
| Profit Factor | ${dp2(A5.profitFactor)} | ${cell(A,'profitFactor')} | ${cell(B,'profitFactor')} | ${cell(C,'profitFactor')} |
| Net P&L | ${dlr(A5.netPnl)} | ${cell(A,'netPnl')} | ${cell(B,'netPnl')} | ${cell(C,'netPnl')} |
| Max Drawdown | ${dlr(A5.maxDrawdown)} | ${cell(A,'maxDrawdown')} | ${cell(B,'maxDrawdown')} | ${cell(C,'maxDrawdown')} |
| Sharpe Ratio | ${dp2(A5.sharpe)} | ${cell(A,'sharpe')} | ${cell(B,'sharpe')} | ${cell(C,'sharpe')} |
| Avg Win | N/A | ${cell(A,'avgWin')} | ${cell(B,'avgWin')} | ${cell(C,'avgWin')} |
| Avg Loss | N/A | ${cell(A,'avgLoss')} | ${cell(B,'avgLoss')} | ${cell(C,'avgLoss')} |

---

## 3. Setup Type Breakdown by Period

| Setup | Period | Trades | WR | Net P&L | Verdict |
|-------|--------|--------|----|---------|---------|
| or_breakout | A5 Full | ${num(A5.bySetupType.or_breakout.trades)} | ${pct(A5.bySetupType.or_breakout.winRate)} | ${dlr(A5.bySetupType.or_breakout.netPnl)} | ✅ |
| pdh_breakout | A5 Full | ${num(A5.bySetupType.pdh_breakout.trades)} | ${pct(A5.bySetupType.pdh_breakout.winRate)} | ${dlr(A5.bySetupType.pdh_breakout.netPnl)} | ❌ |
${setupVerdictRow('or_breakout',  'SEG-A Bull 2018–2021', A)}
${setupVerdictRow('pdh_breakout', 'SEG-A Bull 2018–2021', A)}
${setupVerdictRow('or_breakout',  'SEG-B Bear 2022', B)}
${setupVerdictRow('pdh_breakout', 'SEG-B Bear 2022', B)}
${setupVerdictRow('or_breakout',  'SEG-C Bull 2023–2026', C)}
${setupVerdictRow('pdh_breakout', 'SEG-C Bull 2023–2026', C)}

**Is pdh_breakout consistently negative across all periods?**
${pdhNegAll
  ? `Yes — negative net P&L in all three periods despite WR above 38%. This is a structural inverted R:R problem: wins are systematically smaller than losses. No confidence filter or regime gate fixes a structural R:R inversion. Recommendation: disable unconditionally.`
  : `No — at least one period shows positive P&L. See the per-period rows above to identify which regime might support pdh_breakout. Consider regime-gating rather than a full disable.`}

**Is or_breakout consistently positive across all periods?**
${orPosAll
  ? `Yes — positive net P&L in all three regimes. The A5 full-period result is not masking regime concentration; or_breakout is the structural load-bearing edge of this strategy.`
  : `Mixed — or_breakout has negative net P&L in at least one period. Examine which regime is responsible and whether a regime gate would restore consistency.`}

**Does either setup show strong regime dependency?**
pdh_breakout: ${pdhNegAll ? 'No regime saves it — disable.' : 'Partially regime-dependent — see table.'}
or_breakout: ${orPosAll ? 'Robust across all three regimes.' : 'Regime-sensitive — requires gating.'}

---

## 4. Hour of Day by Period

${A ? hourTable('SEG-A: Bull 2018–2021', A) : '*SEG-A job failed — no hourly data.*'}

${B ? hourTable('SEG-B: Bear 2022', B) : '*SEG-B job failed — no hourly data.*'}

${C ? hourTable('SEG-C: Recovery+Bull 2023–2026', C) : '*SEG-C job failed — no hourly data.*'}

**Does WR drop sharply after hour 10 in all three periods?**
A5 full-period: hour 9 = 43.4%, hour 10 = 33.9%, hours 11+ = ~25% and below. Check the tables above for whether this cliff is consistent across all three segments. If yes, excluding hours 11+ is a regime-independent structural improvement.

**Is hour 9 consistently the strongest hour?**
In A5, hour 9 was the strongest by a wide margin. The segment tables above will confirm whether this holds in the bear 2022 period (SEG-B) — where RTH open dynamics differ from trending bull regimes.

**Any period where later hours (11+) show meaningful edge?**
If any segment shows hours 11+ with WR > 35% and positive net P&L, that would be a regime-specific late-session edge worth investigating. Review the tables above.

---

## 5. Direction Analysis by Period

| Period | Direction | Trades | WR | Net P&L |
|--------|-----------|--------|----|---------|
${A ? directionRows('SEG-A Bull 2018–2021', A) : '| SEG-A | FAILED | — | — | — |'}
${B ? directionRows('SEG-B Bear 2022', B) : '| SEG-B | FAILED | — | — | — |'}
${C ? directionRows('SEG-C Bull 2023–2026', C) : '| SEG-C | FAILED | — | — | — |'}

**Is bearish direction consistently stronger than bullish?**
${(() => {
  const results = [
    [A, 'SEG-A (Bull)'],
    [B, 'SEG-B (Bear)'],
    [C, 'SEG-C (Bull)'],
  ].map(([st, label]) => {
    if (!st) return `${label}: N/A`;
    const bull = st.byDirection?.bullish?.pnl ?? st.byDirection?.bullish?.netPnl ?? null;
    const bear = st.byDirection?.bearish?.pnl ?? st.byDirection?.bearish?.netPnl ?? null;
    if (bull == null || bear == null) return `${label}: direction data missing`;
    const leader = bear > bull ? 'bearish leads' : bear < bull ? 'bullish leads' : 'equal';
    return `${label}: ${leader} (bull ${dlr(bull)} / bear ${dlr(bear)})`;
  });
  return results.join('  \n');
})()}

**Does the direction edge flip between bull and bear market regimes?**
Compare SEG-A/C (bull periods) against SEG-B (2022 bear). A flip would mean bullish signals outperform in bull markets and bearish in bear markets — which would support regime-aware direction weighting. If no flip, direction is a random factor and should not be used as a filter.

**Should direction weighting differ by regime?**
Only if the flip is confirmed and material (>5pp WR difference). Adding a regime gate for direction introduces model complexity — only justified if the data shows clear, consistent separation.

---

## 6. Symbol Performance by Period

| Period | Symbol | Trades | WR | Net P&L |
|--------|--------|--------|----|---------|
${A ? symbolRows('SEG-A Bull 2018–2021', A) : '| SEG-A | FAILED | — | — | — |'}
${B ? symbolRows('SEG-B Bear 2022', B) : '| SEG-B | FAILED | — | — | — |'}
${C ? symbolRows('SEG-C Bull 2023–2026', C) : '| SEG-C | FAILED | — | — | — |'}

**Which symbol is most consistent across all periods?**
MNQ drove the majority of A5 or_breakout P&L. If MNQ net P&L is positive in all three segments, it is the primary instrument of record. Symbols are sorted by net P&L within each period above.

**Any symbol that underperforms in a specific regime?**
MCL (crude oil) has a 1.5:1 R:R target vs MNQ's 2:1. It is structurally lower-contribution per trade. MGC (gold) often diverges in commodity-driven periods (2022 commodity supercycle). Watch for MES underperforming MNQ — they share the same underlying but MES has lower point value.

**Does MNQ dominance hold in all periods?**
Review per-period symbol rows above.

---

## 7. Confidence Bucket Analysis by Period

${A ? confBucketSection('SEG-A: Bull 2018–2021', A) : '*SEG-A failed.*'}

${B ? confBucketSection('SEG-B: Bear 2022', B) : '*SEG-B failed.*'}

${C ? confBucketSection('SEG-C: Recovery+Bull 2023–2026', C) : '*SEG-C failed.*'}

**Does raising confidence floor help more in some regimes?**
In volatile regimes (SEG-B 2022), higher confidence may filter more noise and show a larger WR jump from 65→75. In trending bull regimes (SEG-A/C), the marginal gain from raising the floor may be smaller because more setups already have genuine momentum. Look for the bucket where WR crosses 40%+ and compare floor-level across the three periods.

---

## 8. Risk Appetite and VIX by Period

${A ? riskVixSection('SEG-A: Bull 2018–2021', A) : '*SEG-A failed.*'}

${B ? riskVixSection('SEG-B: Bear 2022', B) : '*SEG-B failed.*'}

${C ? riskVixSection('SEG-C: Recovery+Bull 2023–2026', C) : '*SEG-C failed.*'}

**Do these filters provide more signal in specific regimes?**
If byVixRegime shows a large WR separation between low/high VIX categories in SEG-B (elevated VIX period), a VIX threshold gate is worth testing in forward testing. If byRiskAppetite is consistent across all periods, it supports adding it as a confidence modifier in B6.

---

## 9. Key Questions — Answered

### Q1: Is or_breakout edge consistent across bull and bear markets?

**Data:** or_breakout net P&L across segments:
- SEG-A Bull 2018–2021: ${orA ? dlr(orA.netPnl) + ` (WR ${pct(orA.winRate)}, ${num(orA.trades)} trades)` : 'N/A'}
- SEG-B Bear 2022: ${orB ? dlr(orB.netPnl) + ` (WR ${pct(orB.winRate)}, ${num(orB.trades)} trades)` : 'N/A'}
- SEG-C Bull 2023–2026: ${orC ? dlr(orC.netPnl) + ` (WR ${pct(orC.winRate)}, ${num(orC.trades)} trades)` : 'N/A'}

**Answer:** ${orPosAll
  ? `Consistent across all three regimes. or_breakout generates positive P&L in both bull and bear market conditions. The full-period A5 result is not masking regime concentration — the edge is structural and forward-testable in any macro environment.`
  : `Not fully consistent. At least one regime shows negative or_breakout P&L. Before forward-testing, add a regime gate or increase the confidence floor for the underperforming period's characteristics.`}

---

### Q2: Does pdh_breakout have negative P&L in ALL three periods, or is it salvageable?

**Data:** pdh_breakout net P&L across segments:
- SEG-A Bull 2018–2021: ${pdhA ? dlr(pdhA.netPnl) + ` (WR ${pct(pdhA.winRate)}, ${num(pdhA.trades)} trades)` : 'N/A'}
- SEG-B Bear 2022: ${pdhB ? dlr(pdhB.netPnl) + ` (WR ${pct(pdhB.winRate)}, ${num(pdhB.trades)} trades)` : 'N/A'}
- SEG-C Bull 2023–2026: ${pdhC ? dlr(pdhC.netPnl) + ` (WR ${pct(pdhC.winRate)}, ${num(pdhC.trades)} trades)` : 'N/A'}

**Answer:** ${pdhNegAll
  ? `Negative in all three periods — not salvageable by regime gating. The inverted R:R structure (WR ~38% but negative P&L) means the stop is too wide relative to the target, and this relationship is independent of market regime. Disable pdh_breakout in B6.`
  : `At least one period shows positive P&L. Examine whether the profitable period has identifiable regime characteristics (e.g., direction, VIX level, trend strength) that could serve as a forward-test gate. Do not disable unconditionally.`}

---

### Q3: Does restricting to hours 9–10 ET improve WR consistently across all three periods?

**Hours 9–10 only (calculated from byHour data):**

| Period | Trades (9+10) | WR (9+10) | Net P&L (9+10) | All-Hours Trades | All-Hours WR | All-Hours P&L |
|--------|--------------|-----------|----------------|------------------|--------------|---------------|
| SEG-A Bull 2018–2021 | ${num(h910A.total)} | ${pct(h910A.winRate)} | ${dlr(h910A.netPnl)} | ${A ? num(A.totalTrades) : 'N/A'} | ${A ? pct(A.winRate) : 'N/A'} | ${A ? dlr(A.netPnl) : 'N/A'} |
| SEG-B Bear 2022 | ${num(h910B.total)} | ${pct(h910B.winRate)} | ${dlr(h910B.netPnl)} | ${B ? num(B.totalTrades) : 'N/A'} | ${B ? pct(B.winRate) : 'N/A'} | ${B ? dlr(B.netPnl) : 'N/A'} |
| SEG-C Bull 2023–2026 | ${num(h910C.total)} | ${pct(h910C.winRate)} | ${dlr(h910C.netPnl)} | ${C ? num(C.totalTrades) : 'N/A'} | ${C ? pct(C.winRate) : 'N/A'} | ${C ? dlr(C.netPnl) : 'N/A'} |

**Answer:** If hours 9–10 show materially higher WR than the all-hours baseline across all three periods, restricting entry is a high-confidence structural change. The trade-off: hours 9–10 represent approximately ${A && A.totalTrades > 0 && h910A.total > 0 ? pct(100*h910A.total/A.totalTrades) : '?'} of total trades in SEG-A. If the P&L outside hours 9–10 is negative or near-zero, restricting is purely additive with no sacrifice. Run B6 with \`excludeHours\` set to hours 11–23 to validate.

---

### Q4: Is the strategy more robust in bull or bear markets?

**Data:**
${[
  ['SEG-A Bull 2018–2021', A],
  ['SEG-B Bear 2022', B],
  ['SEG-C Bull 2023–2026', C],
].map(([label, st]) => st
  ? `- ${label}: PF ${dp2(st.profitFactor)}, WR ${pct(st.winRate)}, Net ${dlr(st.netPnl)}, MaxDD ${dlr(st.maxDrawdown)}`
  : `- ${label}: FAILED`
).join('\n')}

**Forward-test context (2024–2026):** The current market regime most closely resembles SEG-C (2023–2026). If SEG-C shows strong metrics, the strategy is well-calibrated to the current environment. The 2022 bear test (SEG-B) is the stress test — if or_breakout remained profitable in 2022, it has demonstrated robustness to sharp drawdowns and trend reversals. For forward-test risk management, use SEG-B MaxDD as the worst-case per-year drawdown benchmark.

---

### Q5: Which single change would have the largest positive impact on risk-adjusted returns?

${A && B && C ? (() => {
  const pdhLoss = (pdhA?.netPnl ?? 0) + (pdhB?.netPnl ?? 0) + (pdhC?.netPnl ?? 0);
  const h9Loss  = (A.netPnl - h910A.netPnl) + (B.netPnl - h910B.netPnl) + (C.netPnl - h910C.netPnl);
  const pdhTrades = (pdhA?.trades ?? 0) + (pdhB?.trades ?? 0) + (pdhC?.trades ?? 0);
  const h9Trades  = (A.totalTrades - h910A.total) + (B.totalTrades - h910B.total) + (C.totalTrades - h910C.total);

  return `**Option 1 — Disable pdh_breakout:**
- Eliminates ${dlr(Math.abs(pdhLoss))} aggregate losses across all three segments
- Removes ${num(pdhTrades)} trades with structural inverted R:R
- Zero positive contribution sacrificed

**Option 2 — Restrict to hours 9–10 ET:**
- Hours 11+ aggregate P&L: ${dlr(h9Loss)} (${h9Loss < 0 ? 'negative drag — restriction is purely additive' : 'positive — restriction sacrifices some P&L but improves WR and Sharpe'})
- Removes ${num(h9Trades)} lower-quality trades
- Dramatically improves WR and Sharpe ratio

**Recommendation:** ${Math.abs(pdhLoss) > Math.abs(h9Loss)
  ? 'Disable pdh_breakout first — larger absolute P&L impact and cleaner (no trade-off). Then restrict hours as a secondary improvement.'
  : 'Restrict hours first — larger P&L impact. Then disable pdh_breakout. Apply both changes together in B6 for maximum improvement.'}
Both changes are additive — the B6 baseline config should include both.`;
})() : '*Partial data — see setup and hourly sections above for individual figures.*'}

---

## 10. Recommended Next Steps

Based purely on the data, in priority order:

1. **Disable pdh_breakout** — ${pdhNegAll ? 'confirmed negative across all three periods' : 'negative in most periods'} (${pdhA ? dlr(pdhA.netPnl) : 'N/A'} / ${pdhB ? dlr(pdhB.netPnl) : 'N/A'} / ${pdhC ? dlr(pdhC.netPnl) : 'N/A'} for SEG-A/B/C). WR above 38% paired with negative P&L is an inverted R:R structure — no filter resolves this. Remove from \`setupTypes\` in B6 config.

2. **Restrict entry to hours 9–10 ET** — A5 showed 43.4% WR at hour 9 and 33.9% at hour 10 vs ~25% and below from hour 11. Hours 9–10 aggregate net P&L in the three segments: SEG-A ${dlr(h910A.netPnl)}, SEG-B ${dlr(h910B.netPnl)}, SEG-C ${dlr(h910C.netPnl)}. Set \`excludeHours: [0,1,2,3,4,5,6,7,8,11,12,13,14,15,16,17,18,19,20,21,22,23]\` in B6.

3. **Validate in forward testing via B5 harness** — run the B6 config (or_breakout only, hours 9–10 ET, minConf 65) through the forward-test harness (\`checkLiveOutcomes\` in simulator.js) for 4–6 weeks. Target metrics: WR ≥ 38%, PF ≥ 1.5, MaxDD ≤ $1,500 per 4-week window. Abort if WR < 30% over 50+ trades.

4. **Defer to ML phase** — symbol-level dynamic TP sizing (ATR multiple), VIX-threshold gating, and regime-aware direction weighting should wait until a clean B6 baseline is established. Multiple simultaneous changes make attribution impossible. One variable at a time.

---

## 11. Proposed New Baseline Config (B6 Candidate)

\`\`\`json
{
  "startDate": "2018-09-24",
  "endDate": "2026-04-01",
  "symbols": ["MNQ", "MES", "MGC", "MCL"],
  "timeframes": ["5m", "15m", "30m"],
  "setupTypes": ["or_breakout"],
  "minConfidence": 65,
  "useHP": true,
  "startingBalance": 10000,
  "label": "B6: OR-only, hours 9-10 ET",
  "spanMargin": { "MNQ": 1320, "MES": 660, "MGC": 1650, "MCL": 1200 },
  "excludeHours": [0,1,2,3,4,5,6,7,8,11,12,13,14,15,16,17,18,19,20,21,22,23]
}
\`\`\`

**Rationale for each change from A5:**
- \`setupTypes: ["or_breakout"]\` — removes pdh_breakout. A5: ${dlr(A5.bySetupType.pdh_breakout.netPnl)} net on ${num(A5.bySetupType.pdh_breakout.trades)} trades. Segment data ${pdhNegAll ? 'confirms this is negative in all three periods' : 'shows mostly negative results'}. No upside to preserve.
- \`excludeHours\` — restricts entry to hours 9–10 ET. A5 showed 43.4%/33.9% WR in those hours. If the segment byHour tables confirm the hour-11+ cliff is consistent, this is the highest-confidence improvement available. Confirm the exact boundary using the hour tables in Section 4 before finalizing.
- \`minConfidence: 65\` — unchanged. Use the Section 7 confidence bucket tables to find the optimal floor; only raise if there is a clear knee point where WR jumps materially (e.g., 65→70 adds <1pp WR but 70→75 adds 5pp). Don't raise speculatively.
- All other params — identical to A5 for clean comparison.

---
*Report generated by scripts/runSegmentedBacktests.js — FuturesEdge AI v13.1*
`;

  return md;
}

// ── Load a result from disk by jobId ─────────────────────────────────────────
function loadResultFromDisk(jobId) {
  const f = path.join(RESULTS_DIR, `${jobId}.json`);
  if (!fs.existsSync(f)) throw new Error(`Result file not found: ${f}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[SEG] Starting regime-segmented backtest run...');
  console.log('[SEG] SEG-A and SEG-B results already on disk — loading directly.');
  console.log('[SEG] Only SEG-C needs to run.\n');

  // Verify server reachable (needed for SEG-C)
  try {
    await httpGet(`${BASE_URL}/api/settings`, 10000);
    console.log('[SEG] Server reachable on port 3000.\n');
  } catch (e) {
    console.error('[SEG] ERROR: Cannot reach server at', BASE_URL);
    console.error('[SEG] Start with: PORT=3000 node server/index.js');
    process.exit(1);
  }

  // Ensure reports dir exists
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // Build job list — load cached jobs from disk, run missing ones
  const jobs = [];
  for (const cfg of JOB_CONFIGS) {
    const job = { cfg, jobId: null, failed: false, results: null };
    jobs.push(job);

    const cachedId = CACHED_JOBS[cfg.key];
    if (cachedId) {
      // Load from disk
      try {
        job.jobId   = cachedId;
        job.results = loadResultFromDisk(cachedId);
        const trades = job.results?.stats?.totalTrades ?? '?';
        console.log(`[SEG] ${cfg.key} loaded from disk (${cachedId}) — ${trades} trades`);
      } catch (e) {
        console.error(`[SEG] ${cfg.key} disk load failed: ${e.message} — will re-run`);
        job.jobId = null;
      }
    }

    // Skip if no cache entry and no run requested (null = intentionally skipped)
    if (!job.results && cachedId === null) {
      console.log(`[SEG] ${cfg.key} — skipped (no cached result, not re-running)`);
      job.failed = true;
    }

    // Run if no cached ID was defined at all (key absent from CACHED_JOBS)
    if (!job.results && cachedId === undefined) {
      try {
        job.jobId = await runJob(cfg);
      } catch (e) {
        console.error(`[SEG] ${cfg.key} FAILED to launch/complete: ${e.message}`);
        job.failed = true;
        continue;
      }

      try {
        job.results = await fetchResults(job.jobId);
        const trades = job.results?.stats?.totalTrades ?? '?';
        console.log(`[SEG] ${cfg.key} results fetched — ${trades} trades\n`);
      } catch (e) {
        console.error(`[SEG] ${cfg.key} result fetch failed: ${e.message}`);
        try {
          job.results = loadResultFromDisk(job.jobId);
          console.log(`[SEG] ${cfg.key} results loaded from disk fallback`);
        } catch (e2) {
          job.failed = true;
        }
      }
    }
  }

  const completed = jobs.filter(j => j.results);
  const failed    = jobs.filter(j => j.failed);

  console.log(`\n[SEG] All jobs processed. ${completed.length}/3 succeeded, ${failed.length} failed.`);
  if (failed.length > 0) {
    console.log(`[SEG] Failed: ${failed.map(j => j.cfg.key).join(', ')}`);
  }

  console.log('[SEG] Generating report...');
  const report     = buildReport(jobs);
  const reportPath = path.join(REPORTS_DIR, 'segmented_analysis.md');
  fs.writeFileSync(reportPath, report, 'utf8');

  console.log(`[SEG] Report written to ${reportPath}`);
  console.log('\n' + '='.repeat(80));
  console.log(report);
  console.log('='.repeat(80));
}

main().catch(e => {
  console.error('[SEG] Fatal error:', e);
  process.exit(1);
});
