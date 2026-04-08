'use strict';
/**
 * ZR-D: Zone rejection with midpoint SL on ZR-F base config (hours 4–8 ET).
 * Three variants: D1 (both dirs), D2 (bullish only), D3 (VIX low/normal only).
 *
 * Usage: node scripts/zr_d_run.js
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { runBacktestMTF } = require('../server/backtest/engine');

const OUT_DIR = path.resolve(__dirname, '../data/analysis');
fs.mkdirSync(OUT_DIR, { recursive: true });

const EXCLUDE = [0,1,2,3,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];

function computeStats(trades) {
  const w = trades.filter(t => t.outcome === 'won');
  const l = trades.filter(t => t.outcome === 'lost');
  const to = trades.filter(t => t.outcome === 'timeout');
  const grossWin  = w.reduce((s, t) => s + Math.max(0, t.grossPnl || 0), 0);
  const grossLoss = Math.abs(l.reduce((s, t) => s + Math.min(0, t.grossPnl || 0), 0));
  const net = trades.reduce((s, t) => s + (t.netPnl || 0), 0);
  const wr = trades.length ? (w.length / trades.length * 100) : 0;
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const avgWin  = w.length ? w.reduce((s, t) => s + (t.netPnl || 0), 0) / w.length : 0;
  const avgLoss = l.length ? l.reduce((s, t) => s + (t.netPnl || 0), 0) / l.length : 0;
  const avgHoldW = w.length ? w.reduce((s, t) => s + (t.holdBars || 0), 0) / w.length : 0;
  const avgHoldL = l.length ? l.reduce((s, t) => s + (t.holdBars || 0), 0) / l.length : 0;
  return { total: trades.length, won: w.length, lost: l.length, timeout: to.length,
           wr: wr.toFixed(1), pf: pf.toFixed(3), net: net.toFixed(2),
           avgWin: avgWin.toFixed(2), avgLoss: avgLoss.toFixed(2),
           avgHoldWin: avgHoldW.toFixed(1), avgHoldLoss: avgHoldL.toFixed(1),
           grossWin: grossWin.toFixed(2), grossLoss: grossLoss.toFixed(2) };
}

function byBucket(trades, keyFn) {
  const m = {};
  for (const t of trades) { const k = String(keyFn(t)); (m[k] = m[k] || []).push(t); }
  const out = {};
  for (const [k, arr] of Object.entries(m)) out[k] = computeStats(arr);
  return out;
}

function passCheck(stats, wrTarget, pfTarget) {
  const wr = parseFloat(stats.wr);
  const pf = parseFloat(stats.pf);
  const avgWin = parseFloat(stats.avgWin);
  const avgLoss = Math.abs(parseFloat(stats.avgLoss));
  const net = parseFloat(stats.net);
  return {
    wrPass:    wr >= wrTarget,
    pfPass:    pf >= pfTarget,
    rrPass:    avgWin >= avgLoss,
    netPass:   net > 0,
    allPass:   wr >= wrTarget && pf >= pfTarget && avgWin >= avgLoss && net > 0,
  };
}

function writeSummary(label, trades, stats, filePath, configNote, checks) {
  const breakdowns = [
    ['BY DIRECTION',       byBucket(trades, t => t.direction)],
    ['BY HOUR (ET)',        byBucket(trades, t => t.hour)],
    ['BY VIX REGIME',      byBucket(trades, t => t.vixRegime || 'unknown')],
    ['BY TIMEFRAME',       byBucket(trades, t => t.timeframe)],
    ['BY DXY DIRECTION',   byBucket(trades, t => t.dxyDirection || 'unknown')],
    ['BY EQUITY BREADTH',  byBucket(trades, t => t.equityBreadth ?? 'null')],
    ['BY RISK APPETITE',   byBucket(trades, t => t.riskAppetite || 'unknown')],
    ['BY DD BAND LABEL',   byBucket(trades, t => t.ddBandLabel || 'unknown')],
    ['BY CONFIDENCE BUCKET', byBucket(trades, t => {
      const c = t.confidence;
      if (c < 60) return '50-59'; if (c < 70) return '60-69';
      if (c < 80) return '70-79'; if (c < 90) return '80-89'; return '90+';
    })],
  ];

  const lines = [
    label,
    '='.repeat(label.length),
    `Date: 2026-04-06`,
    `Config: ${configNote}`,
    '',
    'OVERALL:',
    `  Trades: ${stats.total} (Won: ${stats.won}, Lost: ${stats.lost}, Timeout: ${stats.timeout})`,
    `  Win Rate: ${stats.wr}%`,
    `  Profit Factor: ${stats.pf}`,
    `  Net P&L: $${stats.net}`,
    `  Avg Win: $${stats.avgWin}  |  Avg Loss: $${stats.avgLoss}`,
    `  Avg Hold (win): ${stats.avgHoldWin} bars  |  Avg Hold (loss): ${stats.avgHoldLoss} bars`,
    `  Gross Win: $${stats.grossWin}  |  Gross Loss: $${stats.grossLoss}`,
    '',
    'PASS CRITERIA CHECK:',
    `  WR ≥ 45%:           ${checks.wrPass ? 'PASS' : 'FAIL'} (${stats.wr}%)`,
    `  PF ≥ 1.2:           ${checks.pfPass ? 'PASS' : 'FAIL'} (${stats.pf})`,
    `  AvgWin ≥ |AvgLoss|: ${checks.rrPass ? 'PASS' : 'FAIL'} ($${stats.avgWin} vs $${stats.avgLoss})`,
    `  Net > 0:            ${checks.netPass ? 'PASS' : 'FAIL'} ($${stats.net})`,
    `  OVERALL:            ${checks.allPass ? '*** ALL PASS ***' : 'INCOMPLETE'}`,
    '',
    'KEY OBSERVATION:',
    `  R:R fixed? ${checks.rrPass ? 'YES — midpoint SL resolved the R:R inversion' : 'NO — AvgLoss still exceeds AvgWin'}`,
    '',
  ];

  for (const [heading, data] of breakdowns) {
    lines.push(heading + ':');
    lines.push(JSON.stringify(data, null, 2));
    lines.push('');
  }

  fs.writeFileSync(filePath, lines.join('\n'));
}

(async () => {
  const jobId = crypto.randomBytes(6).toString('hex');

  // ─── ZR-D1: Both directions, midpoint SL, hours 4–8 ET ───────────────────
  console.log(`[ZR-D1] Job ${jobId}: zone_rejection + slMidpoint, hours 4-8 ET`);
  const config = {
    symbols:       ['MNQ'],
    timeframes:    ['15m', '30m'],
    startDate:     '2024-01-01',
    endDate:       '2026-04-01',
    minConfidence: 50,
    setupTypes:    ['zone_rejection'],
    contracts:     { MNQ: 1 },
    useHP:         true,
    feePerRT:      4,
    spanMargin:    { MNQ: 1320 },
    excludeHours:  EXCLUDE,
    slMidpoint:    true,
  };

  const results = await runBacktestMTF(config, (p) => {
    if (p.pct % 25 === 0) console.log(`  [progress] ${p.phase} ${p.pct}%`);
  });

  const d1Trades = results.trades || [];
  const d1Stats = computeStats(d1Trades);
  const d1Checks = passCheck(d1Stats, 45, 1.2);
  console.log(`[ZR-D1] ${d1Stats.total} trades, WR ${d1Stats.wr}%, PF ${d1Stats.pf}, Net $${d1Stats.net}`);
  console.log(`[ZR-D1] AvgWin: $${d1Stats.avgWin}, AvgLoss: $${d1Stats.avgLoss}`);
  console.log(`[ZR-D1] R:R fixed? ${d1Checks.rrPass ? 'YES' : 'NO'}`);

  fs.writeFileSync(path.join(OUT_DIR, `ZR_D1_${jobId}_results.json`),
    JSON.stringify({ config, trades: d1Trades, stats: d1Stats }, null, 2));
  writeSummary('ZR-D1: Midpoint SL + Hours 4-8 ET (both directions)', d1Trades, d1Stats,
    path.join(OUT_DIR, `ZR_D1_${jobId}_summary.txt`),
    'MNQ, 15m+30m, zone_rejection, conf≥50, slMidpoint=true, hours 4-8 ET', d1Checks);

  // ─── ZR-D2: Bullish only (post-filter) ───────────────────────────────────
  const d2Trades = d1Trades.filter(t => t.direction === 'bullish');
  const d2Stats = computeStats(d2Trades);
  const d2Checks = passCheck(d2Stats, 45, 1.2);
  console.log(`\n[ZR-D2] Bullish only: ${d2Stats.total} trades, WR ${d2Stats.wr}%, PF ${d2Stats.pf}, Net $${d2Stats.net}`);
  console.log(`[ZR-D2] AvgWin: $${d2Stats.avgWin}, AvgLoss: $${d2Stats.avgLoss}`);

  fs.writeFileSync(path.join(OUT_DIR, `ZR_D2_${jobId}_results.json`),
    JSON.stringify({ config: { ...config, directionFilter: 'bullish' }, trades: d2Trades, stats: d2Stats }, null, 2));
  writeSummary('ZR-D2: Midpoint SL + Hours 4-8 ET (bullish only)', d2Trades, d2Stats,
    path.join(OUT_DIR, `ZR_D2_${jobId}_summary.txt`),
    'MNQ, 15m+30m, zone_rejection, conf≥50, slMidpoint=true, hours 4-8 ET, bullish only (post-filter)', d2Checks);

  // ─── ZR-D3: VIX guard — skip elevated/crisis (post-filter) ───────────────
  const d3Trades = d1Trades.filter(t => t.vixRegime !== 'elevated' && t.vixRegime !== 'crisis');
  const d3Stats = computeStats(d3Trades);
  const d3Checks = passCheck(d3Stats, 45, 1.2);
  console.log(`\n[ZR-D3] VIX low/normal: ${d3Stats.total} trades, WR ${d3Stats.wr}%, PF ${d3Stats.pf}, Net $${d3Stats.net}`);
  console.log(`[ZR-D3] AvgWin: $${d3Stats.avgWin}, AvgLoss: $${d3Stats.avgLoss}`);

  fs.writeFileSync(path.join(OUT_DIR, `ZR_D3_${jobId}_results.json`),
    JSON.stringify({ config: { ...config, vixFilter: ['low', 'normal'] }, trades: d3Trades, stats: d3Stats }, null, 2));
  writeSummary('ZR-D3: Midpoint SL + Hours 4-8 ET (VIX low/normal only)', d3Trades, d3Stats,
    path.join(OUT_DIR, `ZR_D3_${jobId}_summary.txt`),
    'MNQ, 15m+30m, zone_rejection, conf≥50, slMidpoint=true, hours 4-8 ET, VIX low/normal only (post-filter)', d3Checks);

  // ─── Final comparison ─────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log('ZR-D VARIANT COMPARISON (vs ZR-F baseline: WR 57.4%, PF 1.253, AvgWin $45.74, AvgLoss -$57.50)');
  console.log('═══════════════════════════════════════════════');
  for (const [name, s, c] of [['D1 (both)', d1Stats, d1Checks], ['D2 (bull)', d2Stats, d2Checks], ['D3 (vix)', d3Stats, d3Checks]]) {
    const verdict = c.allPass ? 'ALL PASS ✓' : (c.wrPass && c.pfPass ? 'WR+PF PASS, R:R FAIL' : 'FAIL');
    console.log(`  ${name}: n=${s.total} WR=${s.wr}% PF=${s.pf} AvgW=$${s.avgWin} AvgL=$${s.avgLoss} Net=$${s.net} → ${verdict}`);
  }
})();
