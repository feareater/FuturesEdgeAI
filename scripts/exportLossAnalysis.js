'use strict';
/**
 * exportLossAnalysis.js — AI Roadmap Phase 2: Loss Analysis Export
 *
 * Finds the A5 full-period backtest job (most trades, includes or_breakout),
 * extracts the worst 500 losing trades, builds summary statistics, and writes
 * three files to data/exports/ ready for Claude analysis.
 *
 * Usage: node scripts/exportLossAnalysis.js
 */

const fs   = require('fs');
const path = require('path');

const RESULTS_DIR = path.resolve(__dirname, '../data/backtest/results');
const EXPORTS_DIR = path.resolve(__dirname, '../data/exports');

// ─── helpers ─────────────────────────────────────────────────────────────────

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** Normalize a field value: null → 'unknown', 'none' → 'none' (kept as-is) */
function norm(v) {
  if (v == null) return 'unknown';
  return String(v);
}

/** Bucket equityBreadth into three groups */
function breadthBucket(v) {
  if (v == null) return 'unknown';
  if (v <= 1) return '0-1 (risk-off)';
  if (v === 2) return '2 (mixed)';
  return '3-4 (risk-on)';
}

// ─── Build per-dimension summary ─────────────────────────────────────────────

/**
 * For each dimension (field), group trades by field value and compute:
 * { [value]: { count, avgLoss, totalLoss, pctOfLosers } }
 */
function summarizeByField(trades, fieldFn, label) {
  const groups = {};
  for (const t of trades) {
    const key = fieldFn(t);
    if (!groups[key]) groups[key] = { count: 0, totalLoss: 0 };
    groups[key].count++;
    groups[key].totalLoss += t.netPnl;
  }
  const total = trades.length;
  const result = {};
  for (const [k, g] of Object.entries(groups)) {
    result[k] = {
      count: g.count,
      avgLoss: round2(g.totalLoss / g.count),
      totalLoss: round2(g.totalLoss),
      pctOfLosers: round2(g.count / total * 100),
    };
  }
  return result;
}

// ─── Feature combination pairs ────────────────────────────────────────────────

const PAIR_FIELDS = [
  ['symbol',         t => t.symbol],
  ['setupType',      t => t.setupType],
  ['direction',      t => t.direction],
  ['hour',           t => String(t.hour)],
  ['vixRegime',      t => norm(t.vixRegime)],
  ['dxyDirection',   t => norm(t.dxyDirection)],
  ['riskAppetite',   t => norm(t.riskAppetite)],
  ['bondRegime',     t => norm(t.bondRegime)],
  ['copperRegime',   t => norm(t.copperRegime)],
  ['dollarRegime',   t => norm(t.dollarRegime)],
  ['resilienceLabel',t => norm(t.resilienceLabel)],
  ['dexBias',        t => norm(t.dexBias)],
  ['equityBreadth',  t => breadthBucket(t.equityBreadth)],
];

function buildPairStats(trades) {
  const pairs = {};

  for (let i = 0; i < PAIR_FIELDS.length; i++) {
    for (let j = i + 1; j < PAIR_FIELDS.length; j++) {
      const [nameA, fnA] = PAIR_FIELDS[i];
      const [nameB, fnB] = PAIR_FIELDS[j];

      for (const t of trades) {
        const key = `${nameA}=${fnA(t)} + ${nameB}=${fnB(t)}`;
        if (!pairs[key]) pairs[key] = { count: 0, totalLoss: 0 };
        pairs[key].count++;
        pairs[key].totalLoss += t.netPnl;
      }
    }
  }

  const total = trades.length;
  const result = [];
  for (const [combo, g] of Object.entries(pairs)) {
    if (g.count < 20) continue; // skip small samples
    result.push({
      combination: combo,
      count: g.count,
      avgLoss: round2(g.totalLoss / g.count),
      totalLoss: round2(g.totalLoss),
      pctOfLosers: round2(g.count / total * 100),
    });
  }

  // Sort by count descending for top-20
  const byCount = [...result].sort((a, b) => b.count - a.count).slice(0, 20);
  // Sort by total loss ascending (most negative = worst) for worst-10
  const byImpact = [...result].sort((a, b) => a.totalLoss - b.totalLoss).slice(0, 10);

  return { top20ByCount: byCount, worst10ByImpact: byImpact };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  // 1. Load all result files
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'));
  console.log(`[export] Scanning ${files.length} result files...`);

  let bestJob = null;
  let bestCount = 0;

  for (const f of files) {
    const data = readJSON(path.join(RESULTS_DIR, f));
    if (!data) continue;
    const trades = data.trades || data.alerts || [];
    const setupTypes = data.config?.setupTypes || [];
    const hasOrBreakout = setupTypes.includes('or_breakout');
    if (!hasOrBreakout) continue;
    if (trades.length > bestCount) {
      bestCount = trades.length;
      bestJob = data;
      bestJob._file = f;
    }
  }

  if (!bestJob) {
    console.error('[export] No qualifying job found (or_breakout + most trades)');
    process.exit(1);
  }

  const jobId    = bestJob.jobId;
  const jobLabel = bestJob.config?.label || '(no label)';
  const trades   = bestJob.trades || bestJob.alerts || [];

  console.log(`[export] Selected job: ${jobId}`);
  console.log(`[export] Label: ${jobLabel}`);
  console.log(`[export] Total trades: ${trades.length}`);

  // 2. Extract losers
  const allLosers = trades
    .filter(t => t.outcome === 'lost')
    .sort((a, b) => a.netPnl - b.netPnl); // ascending = worst first

  console.log(`[export] Total losers: ${allLosers.length}`);

  // 3. Take worst 500
  const exported = allLosers.slice(0, 500);
  console.log(`[export] Exporting worst ${exported.length} losers`);

  // 4. Build slim trade records (only fields needed for analysis)
  const slimTrades = exported.map(t => ({
    symbol:            t.symbol,
    setupType:         t.setupType,
    timeframe:         t.timeframe,
    direction:         t.direction,
    hour:              t.hour ?? null,
    confidence:        t.confidence,
    netPnl:            round2(t.netPnl),
    vixRegime:         norm(t.vixRegime),
    dxyDirection:      norm(t.dxyDirection),
    hpProximity:       norm(t.hpProximity),
    resilienceLabel:   norm(t.resilienceLabel),
    dexBias:           norm(t.dexBias),
    equityBreadth:     t.equityBreadth ?? null,
    bondRegime:        norm(t.bondRegime),
    copperRegime:      norm(t.copperRegime),
    dollarRegime:      norm(t.dollarRegime),
    riskAppetite:      norm(t.riskAppetite),
    riskAppetiteScore: t.riskAppetiteScore ?? null,
    ddBandLabel:       norm(t.ddBandLabel),
    date:              t.date,
  }));

  // 5. Build summary stats from the 500 worst
  const setupTypesPresent = [...new Set(exported.map(t => t.setupType))];

  const summary = {
    exportDate:      new Date().toISOString(),
    jobId,
    jobLabel,
    totalTrades:     trades.length,
    totalLosers:     allLosers.length,
    exportedCount:   exported.length,
    totalLossAmount: round2(exported.reduce((s, t) => s + t.netPnl, 0)),
    avgLoss:         round2(avg(exported.map(t => t.netPnl))),
    worstLoss:       round2(exported[0].netPnl),
    setupTypesPresent,

    bySymbol:         summarizeByField(exported, t => t.symbol,         'symbol'),
    bySetupType:      summarizeByField(exported, t => t.setupType,      'setupType'),
    byDirection:      summarizeByField(exported, t => t.direction,      'direction'),
    byHour:           summarizeByField(exported, t => String(t.hour),   'hour'),
    byVixRegime:      summarizeByField(exported, t => norm(t.vixRegime),'vixRegime'),
    byDxyDirection:   summarizeByField(exported, t => norm(t.dxyDirection),'dxyDirection'),
    byHpProximity:    summarizeByField(exported, t => norm(t.hpProximity),'hpProximity'),
    byResilienceLabel:summarizeByField(exported, t => norm(t.resilienceLabel),'resilienceLabel'),
    byDexBias:        summarizeByField(exported, t => norm(t.dexBias),  'dexBias'),
    byRiskAppetite:   summarizeByField(exported, t => norm(t.riskAppetite),'riskAppetite'),
    byBondRegime:     summarizeByField(exported, t => norm(t.bondRegime),'bondRegime'),
    byCopperRegime:   summarizeByField(exported, t => norm(t.copperRegime),'copperRegime'),
    byEquityBreadth:  summarizeByField(exported, t => breadthBucket(t.equityBreadth),'equityBreadth'),
    byDollarRegime:   summarizeByField(exported, t => norm(t.dollarRegime),'dollarRegime'),
    byDdBandLabel:    summarizeByField(exported, t => norm(t.ddBandLabel),'ddBandLabel'),
    ...buildPairStats(exported),
  };

  // 6. Build FILE 1: trade records
  const file1 = {
    exportDate:    summary.exportDate,
    jobId,
    jobLabel,
    totalTrades:   trades.length,
    totalLosers:   allLosers.length,
    exportedCount: exported.length,
    trades:        slimTrades,
  };

  // 7. Build FILE 2: summary
  const file2 = summary;

  // 8. Build FILE 3: Claude prompt
  const setupTypeDesc = setupTypesPresent.length === 1
    ? `always ${setupTypesPresent[0]} in this dataset`
    : `one of: ${setupTypesPresent.join(', ')}`;

  const hpNote = summary.byHpProximity?.none?.count === exported.length
    ? '\nNote: hpProximity is "none" for all records — HP options level data was unavailable for most of the backtest period. Ignore this field.'
    : '';

  const prompt = `You are analyzing the ${exported.length} worst losing trades from a systematic futures trading backtest covering ${bestJob.config?.startDate} to ${bestJob.config?.endDate}. The system trades or_breakout and pdh_breakout setups on MNQ, MES, MGC, MCL futures using a three-layer confidence scoring system (price action + options market structure + macro context).

Each trade record contains:
- symbol: futures instrument (MNQ/MES/MGC/MCL)
- setupType: ${setupTypeDesc}
- timeframe: always 5m
- direction: bullish or bearish
- hour: ET hour of entry (9 or 10)
- confidence: score at entry (65–100)
- netPnl: dollar P&L after fees (all negative — these are losers)
- vixRegime: low / normal / elevated / crisis
- dxyDirection: rising / falling / flat
- hpProximity: at_level / near_level / other / none (distance to nearest options HP level)
- resilienceLabel: resilient / neutral / fragile / unknown (options market structure quality)
- dexBias: bullish / bearish / neutral / unknown (dealer delta exposure direction)
- equityBreadth: 0–4 (how many of MNQ/MES/M2K/MYM are in bullish regime)
- bondRegime: bullish / bearish / neutral (bonds rallying = risk-off signal)
- copperRegime: bullish / bearish / neutral (copper as global growth proxy)
- dollarRegime: rising / falling / flat (DXY direction)
- riskAppetite: on / neutral / off (composite of equity+bond+copper+dollar)
- riskAppetiteScore: −20 to +20 (numeric composite; negative = risk-off)
- ddBandLabel: room_to_run / approaching_dd / neutral / outside_dd_upper / outside_dd_lower / beyond_dd / at_span_extreme (CME margin band proximity)
${hpNote}
The pre-computed summary statistics are provided below.

Analyze these losing trades and identify:
1. Which single features most strongly predict a losing trade? (n ≥ 30)
2. Which combinations of 2–3 features together predict disproportionate losses or high loss concentration?
3. Are there specific hour × regime combinations that are consistently bad?
4. Which conditions, if used as a filter to SKIP trades, would reduce total loss the most while sacrificing the fewest winning trades?
5. Write specific avoidance rules in this format:
   "[condition] → SKIP — [N] losers in this dataset, est. [X]% of total loss in this export"
6. What is the single highest-impact rule change that could be implemented immediately?

Only report findings where n ≥ 20. Be specific with numbers. Reference the summary statistics provided — do not recalculate from raw records.

---

SUMMARY STATISTICS (paste loss_analysis_summary.json content here):

${JSON.stringify(file2, null, 2)}

---

TRADE RECORDS — worst ${exported.length} losers by net P&L (paste loss_analysis_trades.json content here):

${JSON.stringify(slimTrades, null, 2)}
`;

  // 9. Write files
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const tradesPath  = path.join(EXPORTS_DIR, 'loss_analysis_trades.json');
  const summaryPath = path.join(EXPORTS_DIR, 'loss_analysis_summary.json');
  const promptPath  = path.join(EXPORTS_DIR, 'claude_analysis_prompt.txt');

  writeJSON(tradesPath,  file1);
  writeJSON(summaryPath, file2);
  fs.writeFileSync(promptPath, prompt, 'utf8');

  console.log(`\n[export] Files written:`);
  console.log(`  ${tradesPath}`);
  console.log(`  ${summaryPath}`);
  console.log(`  ${promptPath}`);

  // 10. Console summary
  console.log('\n─── SUMMARY ────────────────────────────────');
  console.log(`Job:          ${jobLabel} (${jobId})`);
  console.log(`Total trades: ${trades.length}`);
  console.log(`Total losers: ${allLosers.length} (${round2(allLosers.length/trades.length*100)}%)`);
  console.log(`Exported:     ${exported.length} worst losers`);
  console.log(`Total loss (exported 500): $${round2(exported.reduce((s,t)=>s+t.netPnl,0))}`);
  console.log(`Avg loss:     $${round2(avg(exported.map(t=>t.netPnl)))}`);
  console.log(`Worst single: $${exported[0].netPnl} (${exported[0].symbol} ${exported[0].date} ${exported[0].setupType})`);

  console.log('\nTop 3 worst feature combos by count (n ≥ 20):');
  const top3 = summary.top20ByCount.slice(0, 3);
  top3.forEach((c, i) =>
    console.log(`  ${i+1}. ${c.combination} — ${c.count} trades, avg $${c.avgLoss}, total $${c.totalLoss}`)
  );

  console.log('\nTop 3 worst feature combos by total P&L impact:');
  summary.worst10ByImpact.slice(0, 3).forEach((c, i) =>
    console.log(`  ${i+1}. ${c.combination} — total $${c.totalLoss} (${c.count} trades, avg $${c.avgLoss})`)
  );

  console.log('\n────────────────────────────────────────────');
  console.log('Next: paste claude_analysis_prompt.txt into claude.ai for Phase 2 loss analysis.');
}

main();
