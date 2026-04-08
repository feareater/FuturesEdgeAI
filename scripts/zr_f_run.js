'use strict';
/**
 * ZR-F: Run zone_rejection backtest gated to hours 4–8 ET only.
 * Also computes ZR-F2 (post-filter: breadth 2–3 only).
 *
 * Usage: node scripts/zr_f_run.js
 * Output: data/analysis/ZR_F_results.json, ZR_F_summary.txt,
 *         ZR_F2_results.json, ZR_F2_summary.txt
 */

const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
const { runBacktestMTF } = require('../server/backtest/engine');

const OUT_DIR = path.resolve(__dirname, '../data/analysis');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Hours to EXCLUDE — everything except 4, 5, 6, 7, 8
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
  for (const t of trades) { const k = keyFn(t); (m[k] = m[k] || []).push(t); }
  const out = {};
  for (const [k, arr] of Object.entries(m)) out[k] = computeStats(arr);
  return out;
}

function writeSummary(label, trades, stats, filePath, extraNote) {
  const lines = [
    `${label}`,
    '='.repeat(label.length),
    `Date: 2026-04-06`,
    `Config: MNQ, 15m+30m, zone_rejection only, 2024-01-01 to 2026-04-01`,
    extraNote || '',
    '',
    `OVERALL:`,
    `  Trades: ${stats.total} (Won: ${stats.won}, Lost: ${stats.lost}, Timeout: ${stats.timeout})`,
    `  Win Rate: ${stats.wr}%`,
    `  Profit Factor: ${stats.pf}`,
    `  Net P&L: $${stats.net}`,
    `  Avg Win: $${stats.avgWin}  |  Avg Loss: $${stats.avgLoss}`,
    `  Avg Hold (win): ${stats.avgHoldWin} bars  |  Avg Hold (loss): ${stats.avgHoldLoss} bars`,
    `  Gross Win: $${stats.grossWin}  |  Gross Loss: $${stats.grossLoss}`,
    '',
    `PASS CRITERIA CHECK:`,
    `  WR ≥ 45%: ${parseFloat(stats.wr) >= 45 ? 'PASS' : 'FAIL'} (${stats.wr}%)`,
    `  PF ≥ 1.2: ${parseFloat(stats.pf) >= 1.2 ? 'PASS' : 'FAIL'} (${stats.pf})`,
    `  AvgWin ≥ |AvgLoss|: ${parseFloat(stats.avgWin) >= Math.abs(parseFloat(stats.avgLoss)) ? 'PASS' : 'FAIL'} ($${stats.avgWin} vs $${stats.avgLoss})`,
    `  Net > 0: ${parseFloat(stats.net) > 0 ? 'PASS' : 'FAIL'} ($${stats.net})`,
    '',
    'BY DIRECTION:',
    JSON.stringify(byBucket(trades, t => t.direction), null, 2),
    '',
    'BY TIMEFRAME:',
    JSON.stringify(byBucket(trades, t => t.timeframe), null, 2),
    '',
    'BY HOUR (ET):',
    JSON.stringify(byBucket(trades, t => t.hour), null, 2),
    '',
    'BY VIX REGIME:',
    JSON.stringify(byBucket(trades, t => t.vixRegime || 'unknown'), null, 2),
    '',
    'BY DXY DIRECTION:',
    JSON.stringify(byBucket(trades, t => t.dxyDirection || 'unknown'), null, 2),
    '',
    'BY EQUITY BREADTH:',
    JSON.stringify(byBucket(trades, t => t.equityBreadth ?? 'null'), null, 2),
    '',
    'BY RISK APPETITE:',
    JSON.stringify(byBucket(trades, t => t.riskAppetite || 'unknown'), null, 2),
    '',
    'BY DD BAND LABEL:',
    JSON.stringify(byBucket(trades, t => t.ddBandLabel || 'unknown'), null, 2),
    '',
    'BY CONFIDENCE BUCKET:',
    JSON.stringify(byBucket(trades, t => {
      const c = t.confidence;
      if (c < 60) return '50-59';
      if (c < 70) return '60-69';
      if (c < 80) return '70-79';
      if (c < 90) return '80-89';
      return '90+';
    }), null, 2),
  ];
  fs.writeFileSync(filePath, lines.join('\n'));
}

(async () => {
  const jobId = crypto.randomBytes(6).toString('hex');
  console.log(`[ZR-F] Job ${jobId}: Running zone_rejection, hours 4-8 ET only`);

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
  };

  const results = await runBacktestMTF(config, (p) => {
    if (p.pct % 20 === 0) console.log(`  [progress] ${p.phase} ${p.pct}% — ${p.message || ''}`);
  });

  const trades = results.trades || [];
  const stats = computeStats(trades);
  console.log(`[ZR-F] Complete: ${stats.total} trades, WR ${stats.wr}%, PF ${stats.pf}, Net $${stats.net}`);
  console.log(`[ZR-F] AvgWin: $${stats.avgWin}, AvgLoss: $${stats.avgLoss}`);

  // Save ZR-F results
  const fResultPath = path.join(OUT_DIR, `ZR_F_${jobId}_results.json`);
  const fSummaryPath = path.join(OUT_DIR, `ZR_F_${jobId}_summary.txt`);
  fs.writeFileSync(fResultPath, JSON.stringify({ config, trades, stats }, null, 2));
  writeSummary('ZR-F: Hours 4-8 ET Gate', trades, stats, fSummaryPath,
    'excludeHours: all except [4,5,6,7,8], minConfidence: 50');
  console.log(`[ZR-F] Saved: ${path.basename(fResultPath)}, ${path.basename(fSummaryPath)}`);

  // ZR-F2: post-filter for breadth 2-3
  const f2Trades = trades.filter(t => t.equityBreadth === 2 || t.equityBreadth === 3);
  const f2Stats = computeStats(f2Trades);
  console.log(`\n[ZR-F2] Post-filter (breadth 2-3): ${f2Stats.total} trades, WR ${f2Stats.wr}%, PF ${f2Stats.pf}, Net $${f2Stats.net}`);
  console.log(`[ZR-F2] AvgWin: $${f2Stats.avgWin}, AvgLoss: $${f2Stats.avgLoss}`);

  const f2ResultPath = path.join(OUT_DIR, `ZR_F2_${jobId}_results.json`);
  const f2SummaryPath = path.join(OUT_DIR, `ZR_F2_${jobId}_summary.txt`);
  fs.writeFileSync(f2ResultPath, JSON.stringify({ config: { ...config, breadthFilter: [2, 3] }, trades: f2Trades, stats: f2Stats }, null, 2));
  writeSummary('ZR-F2: Hours 4-8 ET + Breadth 2-3', f2Trades, f2Stats, f2SummaryPath,
    'excludeHours: all except [4,5,6,7,8], breadth post-filter: equityBreadth ∈ {2, 3}');
  console.log(`[ZR-F2] Saved: ${path.basename(f2ResultPath)}, ${path.basename(f2SummaryPath)}`);

  // Final verdict
  console.log('\n--- VERDICT ---');
  const fPass = parseFloat(stats.wr) >= 45 && parseFloat(stats.pf) >= 1.2;
  const f2Pass = parseFloat(f2Stats.wr) >= 50 && parseFloat(f2Stats.pf) >= 1.3;
  console.log(`ZR-F:  ${fPass ? 'PASS ✓' : 'FAIL ✗'}  (WR ${stats.wr}%, PF ${stats.pf})`);
  console.log(`ZR-F2: ${f2Pass ? 'PASS ✓' : 'FAIL ✗'}  (WR ${f2Stats.wr}%, PF ${f2Stats.pf}, n=${f2Stats.total})`);
})();
