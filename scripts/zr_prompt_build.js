'use strict';
/**
 * Build a condensed ZR-A analysis prompt with pre-computed stats tables.
 * Output: data/analysis/ZR_A_prompt.txt (overwrite the raw one)
 */
const fs   = require('fs');
const path = require('path');

const allData = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/analysis/ZR_A_all.json'), 'utf8'));
const trades = allData.trades;

// --- Helpers ---
function bucket(arr, keyFn) {
  const m = {};
  for (const t of arr) { const k = keyFn(t); (m[k] = m[k] || []).push(t); }
  return m;
}
function stats(arr) {
  const w = arr.filter(t => t.outcome === 'won');
  const l = arr.filter(t => t.outcome === 'lost');
  const wr = arr.length ? (w.length / arr.length * 100).toFixed(1) : '0';
  const grossWin = w.reduce((s, t) => s + (t.grossPnl || 0), 0);
  const grossLoss = Math.abs(l.reduce((s, t) => s + (t.grossPnl || 0), 0));
  const pf = grossLoss ? (grossWin / grossLoss).toFixed(2) : 'Inf';
  const avgWin = w.length ? (w.reduce((s, t) => s + (t.netPnl || 0), 0) / w.length).toFixed(2) : '0';
  const avgLoss = l.length ? (l.reduce((s, t) => s + (t.netPnl || 0), 0) / l.length).toFixed(2) : '0';
  const avgHoldW = w.length ? (w.reduce((s, t) => s + (t.holdBars || 0), 0) / w.length).toFixed(1) : '-';
  const avgHoldL = l.length ? (l.reduce((s, t) => s + (t.holdBars || 0), 0) / l.length).toFixed(1) : '-';
  const net = arr.reduce((s, t) => s + (t.netPnl || 0), 0).toFixed(2);
  return { n: arr.length, w: w.length, l: l.length, wr, pf, avgWin, avgLoss, avgHoldW, avgHoldL, net };
}
function table(header, rows) {
  const lines = [header, header.replace(/[^|]/g, '-')];
  for (const r of rows) lines.push(r);
  return lines.join('\n');
}

const winners = trades.filter(t => t.outcome === 'won');
const losers  = trades.filter(t => t.outcome === 'lost');
const overall = stats(trades);

// --- Confidence buckets ---
const confBuckets = bucket(trades, t => {
  const c = t.confidence;
  if (c < 60) return '50-59';
  if (c < 70) return '60-69';
  if (c < 80) return '70-79';
  if (c < 90) return '80-89';
  return '90+';
});
const confRows = [];
for (const b of ['50-59', '60-69', '70-79', '80-89', '90+']) {
  const s = stats(confBuckets[b] || []);
  confRows.push(`| ${b} | ${s.n} | ${s.wr}% | ${s.pf} | ${s.avgWin} | ${s.avgLoss} | ${s.net} |`);
}

// --- Hour of day ---
const hourBuckets = bucket(trades, t => t.hour ?? '-');
const hourRows = [];
for (let h = 4; h <= 20; h++) {
  const s = stats(hourBuckets[h] || []);
  if (s.n > 0) hourRows.push(`| ${h}:00 ET | ${s.n} | ${s.wr}% | ${s.pf} | ${s.net} |`);
}

// --- Direction ---
const dirBuckets = bucket(trades, t => t.direction);
const dirRows = Object.entries(dirBuckets).map(([d, arr]) => {
  const s = stats(arr);
  return `| ${d} | ${s.n} | ${s.wr}% | ${s.pf} | ${s.avgWin} | ${s.avgLoss} | ${s.net} |`;
});

// --- VIX regime ---
const vixBuckets = bucket(trades, t => t.vixRegime || 'unknown');
const vixRows = Object.entries(vixBuckets).map(([v, arr]) => {
  const s = stats(arr);
  return `| ${v} | ${s.n} | ${s.wr}% | ${s.pf} | ${s.net} |`;
});

// --- DXY direction ---
const dxyBuckets = bucket(trades, t => t.dxyDirection || 'unknown');
const dxyRows = Object.entries(dxyBuckets).map(([d, arr]) => {
  const s = stats(arr);
  return `| ${d} | ${s.n} | ${s.wr}% | ${s.pf} | ${s.net} |`;
});

// --- Equity breadth ---
const breadthBuckets = bucket(trades, t => t.equityBreadth ?? 'null');
const breadthRows = Object.entries(breadthBuckets).map(([b, arr]) => {
  const s = stats(arr);
  return `| ${b} | ${s.n} | ${s.wr}% | ${s.pf} | ${s.net} |`;
});

// --- Risk appetite ---
const raBuckets = bucket(trades, t => t.riskAppetite || 'unknown');
const raRows = Object.entries(raBuckets).map(([r, arr]) => {
  const s = stats(arr);
  return `| ${r} | ${s.n} | ${s.wr}% | ${s.pf} | ${s.net} |`;
});

// --- HP proximity ---
const hpBuckets = bucket(trades, t => t.hpProximity || 'none');
const hpRows = Object.entries(hpBuckets).map(([h, arr]) => {
  const s = stats(arr);
  return `| ${h} | ${s.n} | ${s.wr}% | ${s.pf} | ${s.net} |`;
});

// --- DD Band label ---
const ddBuckets = bucket(trades, t => t.ddBandLabel || 'unknown');
const ddRows = Object.entries(ddBuckets).map(([d, arr]) => {
  const s = stats(arr);
  return `| ${d} | ${s.n} | ${s.wr}% | ${s.pf} | ${s.net} |`;
});

// --- Timeframe ---
const tfBuckets = bucket(trades, t => t.timeframe);
const tfRows = Object.entries(tfBuckets).map(([tf, arr]) => {
  const s = stats(arr);
  return `| ${tf} | ${s.n} | ${s.wr}% | ${s.pf} | ${s.avgWin} | ${s.avgLoss} | ${s.net} |`;
});

// --- Hold time analysis ---
const avgHoldWin = winners.length ? (winners.reduce((s,t) => s + (t.holdBars||0), 0) / winners.length).toFixed(1) : '-';
const avgHoldLoss = losers.length ? (losers.reduce((s,t) => s + (t.holdBars||0), 0) / losers.length).toFixed(1) : '-';

// --- Sample winners (20) and losers (20) for pattern inspection ---
const sampleWinners = winners.slice(0, 20).map(t => ({
  direction: t.direction, tf: t.timeframe, conf: t.confidence, hour: t.hour,
  entry: t.entry, sl: t.sl, tp: t.tp, riskPts: t.riskPoints, netPnl: t.netPnl,
  holdBars: t.holdBars, vixRegime: t.vixRegime, dxyDir: t.dxyDirection,
  breadth: t.equityBreadth, riskApp: t.riskAppetite, hpProx: t.hpProximity,
  ddBand: t.ddBandLabel, ddScore: t.ddBandScore, dexBias: t.dexBias,
}));
const sampleLosers = losers.slice(0, 20).map(t => ({
  direction: t.direction, tf: t.timeframe, conf: t.confidence, hour: t.hour,
  entry: t.entry, sl: t.sl, tp: t.tp, riskPts: t.riskPoints, netPnl: t.netPnl,
  holdBars: t.holdBars, vixRegime: t.vixRegime, dxyDir: t.dxyDirection,
  breadth: t.equityBreadth, riskApp: t.riskAppetite, hpProx: t.hpProximity,
  ddBand: t.ddBandLabel, ddScore: t.ddBandScore, dexBias: t.dexBias,
}));

const prompt = `You are analyzing zone_rejection trades from a systematic futures trading backtest.

CONTEXT:
- Instrument: MNQ (Micro Nasdaq-100 Futures, $2/point)
- Timeframes: 15m, 30m
- Date range: 2024-01-01 to 2026-04-01 (24 months)
- Setup type: zone_rejection only (price enters supply/demand zone, produces rejection wick ≥45% of bar range, closes back outside)
- R:R ratio: 1:1 (TP = 1× risk distance from entry)
- SL placement: swing high/low + 0.30 × ATR (zone far edge)
- zone_rejection is currently DISABLED in production — R:R structurally inverted

OVERALL STATS:
- Total trades: ${overall.n}
- Winners: ${overall.w} | Losers: ${overall.l}
- Win Rate: ${overall.wr}%
- Profit Factor: ${overall.pf}
- Avg Win: $${overall.avgWin} | Avg Loss: $${overall.avgLoss}
- Avg Hold (winners): ${avgHoldWin} bars | Avg Hold (losers): ${avgHoldLoss} bars
- Net P&L: $${overall.net}

=== BREAKDOWN TABLES ===

CONFIDENCE BUCKETS:
| Bucket | n | WR | PF | AvgWin | AvgLoss | Net |
|--------|---|----|----|--------|---------|-----|
${confRows.join('\n')}

TIMEFRAME:
| TF | n | WR | PF | AvgWin | AvgLoss | Net |
|----|---|----|----|--------|---------|-----|
${tfRows.join('\n')}

DIRECTION:
| Dir | n | WR | PF | AvgWin | AvgLoss | Net |
|-----|---|----|----|--------|---------|-----|
${dirRows.join('\n')}

HOUR OF DAY (ET):
| Hour | n | WR | PF | Net |
|------|---|----|----|-----|
${hourRows.join('\n')}

VIX REGIME:
| Regime | n | WR | PF | Net |
|--------|---|----|----|-----|
${vixRows.join('\n')}

DXY DIRECTION:
| Dir | n | WR | PF | Net |
|-----|---|----|----|-----|
${dxyRows.join('\n')}

EQUITY BREADTH:
| Breadth | n | WR | PF | Net |
|---------|---|----|----|-----|
${breadthRows.join('\n')}

RISK APPETITE:
| State | n | WR | PF | Net |
|-------|---|----|----|-----|
${raRows.join('\n')}

HP PROXIMITY:
| Proximity | n | WR | PF | Net |
|-----------|---|----|----|-----|
${hpRows.join('\n')}

DD BAND LABEL:
| Label | n | WR | PF | Net |
|-------|---|----|----|-----|
${ddRows.join('\n')}

=== SAMPLE TRADES (20 winners, 20 losers) ===

WINNERS:
${JSON.stringify(sampleWinners, null, 2)}

LOSERS:
${JSON.stringify(sampleLosers, null, 2)}

=== ANALYSIS REQUESTED ===

1. **Winner characteristics**: What do the winning zone_rejection trades have in common? Which feature values appear disproportionately in winners vs losers?

2. **Confidence threshold**: Is there a confidence floor where zone_rejection becomes profitable (PF > 1.0)?

3. **Time-of-day pattern**: Which hours have the strongest edge? Are there hours that should be excluded?

4. **R-multiple and hold time**: Do winners resolve quickly (small hold bars) vs losers lingering? Does this suggest a time-stop would help?

5. **Structural diagnosis**: The core problem is AvgLoss > AvgWin despite 1:1 R:R target. This means SL is getting hit at worse-than-expected prices (slippage or gaps). Given the breakdown tables:
   - Is the core problem SL placement (too wide at zone far edge)?
   - Is it TP placement (should be lower than 1:1)?
   - Is it zone quality (shallow zones break more easily)?
   - Is it entry timing (entering too early in the rejection)?

6. **Actionable filter rules**: Propose specific conditional filters (n ≥ 10) that would improve WR to ≥ 45% AND PF ≥ 1.2. Format:
   "[condition] → [WR]% WR (n=[count], PF=[value])"

7. **Recommendation**: Which single change would you test FIRST — ATR-relative zone depth filter, max retest count, tighter SL (zone midpoint), or reduced TP (1:1 with no partial)?
`;

fs.writeFileSync(path.resolve(__dirname, '../data/analysis/ZR_A_prompt.txt'), prompt);
console.log(`Prompt written: ${prompt.length} chars, ~${Math.ceil(prompt.length / 4)} tokens`);
