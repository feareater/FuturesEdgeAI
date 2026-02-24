'use strict';
// TF Zone Stack Analysis
// Bypass the top-10 cap, run all zone_rejection setups through TF stack detection,
// and compare win rates: stacked vs not stacked.

const { getCandles }        = require('./server/data/snapshot');
const { computeIndicators } = require('./server/analysis/indicators');
const { classifyRegime, computeAlignment } = require('./server/analysis/regime');
const { checkTFZoneStack }  = require('./server/analysis/confluence');
const settings              = require('./config/settings.json');

// Patch detectSetups to remove the top-10 cap so we see all signals
const setupsMod = require('./server/analysis/setups');
const origModule = require.cache[require.resolve('./server/analysis/setups')];
const origExports = origModule.exports.detectSetups.toString();

// Monkey-patch: replace the slice with a full return
const fs   = require('fs');
const path = require('path');
const srcPath = path.join(__dirname, 'server/analysis/setups.js');
let src = fs.readFileSync(srcPath, 'utf8');
const patched = src
  .replace(
    "require('./iof')",
    "require('./server/analysis/iof')"
  )
  .replace(
    'const top = [...pdhSetups, ...zoneSetups.slice(0, remaining)];',
    'const top = [...pdhSetups, ...zoneSetups];'
  );
const tmpPath = path.join(__dirname, 'setups_analysis_tmp.js');
fs.writeFileSync(tmpPath, patched);

// Re-require patched version
delete require.cache[require.resolve('./server/analysis/setups')];
const { detectSetups } = require('./setups_analysis_tmp');

const SCAN_SYMBOLS    = ['MNQ', 'MGC'];
const SCAN_TIMEFRAMES = ['1m', '2m', '3m', '5m', '15m'];
const TICK_SIZE  = { MNQ: 0.25, MGC: 0.10 };
const TICK_VALUE = { MNQ: 0.50, MGC: 1.00 };
const CONTRACTS  = { MNQ: 5,    MGC: 3    };

function dollarPnl(sym, pts) {
  const ticks = pts / TICK_SIZE[sym];
  return ticks * TICK_VALUE[sym] * CONTRACTS[sym];
}

const all = [];

for (const symbol of SCAN_SYMBOLS) {
  const regime5m  = (() => { try { const c = getCandles(symbol,'5m'); return classifyRegime(computeIndicators(c,{swingLookback:settings.swingLookback,impulseThreshold:settings.impulseThreshold})); } catch{return null;} })();
  const regime15m = (() => { try { const c = getCandles(symbol,'15m'); return classifyRegime(computeIndicators(c,{swingLookback:settings.swingLookback,impulseThreshold:settings.impulseThreshold})); } catch{return null;} })();
  const alignment = computeAlignment(regime15m, regime5m);

  for (const tf of SCAN_TIMEFRAMES) {
    try {
      const candles = getCandles(symbol, tf);
      const ind     = computeIndicators(candles, { swingLookback: settings.swingLookback, impulseThreshold: settings.impulseThreshold });
      const regime  = { ...classifyRegime(ind), alignment };
      const setups  = detectSetups(candles, ind, regime, { rrRatio: settings.risk.rrRatio || 1.0, symbol });

      for (const setup of setups) {
        if (setup.outcome === 'open') continue; // only resolved setups

        const stack = checkTFZoneStack(setup, symbol, tf, getCandles, computeIndicators, settings);
        const risk  = setup.riskPoints || 0;
        const pnl   = setup.outcome === 'won'
          ? dollarPnl(symbol, risk * (settings.risk.rrRatio || 1.0))
          : -dollarPnl(symbol, risk);

        all.push({
          symbol, tf, type: setup.type,
          confidence: setup.confidence,
          outcome: setup.outcome,
          isBQ:  !!(setup.scoreBreakdown?.bos > 0),
          isTFS: stack.bonus > 0,
          stackTfs: stack.tfs,
          pnl,
        });
      }
    } catch (err) {
      process.stderr.write(`[warn] ${symbol} ${tf}: ${err.message}\n`);
    }
  }
}

fs.unlinkSync(tmpPath);

function stats(label, rows) {
  const won   = rows.filter(r => r.outcome === 'won').length;
  const lost  = rows.filter(r => r.outcome === 'lost').length;
  const total = won + lost;
  const wr    = total > 0 ? ((won/total)*100).toFixed(1) : '—';
  const gross = rows.reduce((s,r) => s + r.pnl, 0);
  const gWin  = rows.filter(r=>r.outcome==='won').reduce((s,r)=>s+r.pnl,0);
  const gLoss = rows.filter(r=>r.outcome==='lost').reduce((s,r)=>s+Math.abs(r.pnl),0);
  const pf    = gLoss > 0 ? (gWin/gLoss).toFixed(2) : '∞';
  const avgConf = rows.length ? (rows.reduce((s,r)=>s+r.confidence,0)/rows.length).toFixed(0) : '—';
  console.log(`${label.padEnd(40)} n=${String(total).padStart(3)}  WR=${String(wr).padStart(5)}%  PF=${String(pf).padStart(5)}  P&L=$${gross.toFixed(0).padStart(7)}  avgConf=${avgConf}`);
}

const zones = all.filter(r => r.type === 'zone_rejection');
const pdh   = all.filter(r => r.type === 'pdh_breakout');

console.log('\n══════════════════════════════════════════════════════════════════════════════');
console.log(' TF ZONE STACK ANALYSIS — all resolved setups, bypass top-10 cap');
console.log('══════════════════════════════════════════════════════════════════════════════\n');

console.log('── ZONE REJECTION ───────────────────────────────────────────────────────────');
stats('All zones (resolved)',              zones);
stats('  No TF stack (base)',              zones.filter(r=>!r.isTFS));
stats('  TF stacked (5m or 15m confirm)', zones.filter(r=>r.isTFS));
stats('  TF stacked + BOS qualified',     zones.filter(r=>r.isTFS && r.isBQ));
stats('  TF stacked, no BOS qual',        zones.filter(r=>r.isTFS && !r.isBQ));
stats('  BOS qualified, no TF stack',     zones.filter(r=>!r.isTFS && r.isBQ));

console.log('\n── BY TF STACK TIER ─────────────────────────────────────────────────────────');
const tfs5only  = zones.filter(r=>r.isTFS && r.stackTfs.length===1 && r.stackTfs[0]==='5m');
const tfs15only = zones.filter(r=>r.isTFS && r.stackTfs.length===1 && r.stackTfs[0]==='15m');
const tfsBoth   = zones.filter(r=>r.isTFS && r.stackTfs.length===2);
stats('  5m confirm only',   tfs5only);
stats('  15m confirm only',  tfs15only);
stats('  Both 5m+15m stack', tfsBoth);

console.log('\n── PDH BREAKOUT ─────────────────────────────────────────────────────────────');
stats('All PDH (resolved)',      pdh);
stats('  PDH with TF stack',    pdh.filter(r=>r.isTFS));
stats('  PDH no TF stack',      pdh.filter(r=>!r.isTFS));

console.log('\n── ALL SETUPS COMBINED ──────────────────────────────────────────────────────');
stats('All resolved (combined)',     all);
stats('  With TF stack',             all.filter(r=>r.isTFS));
stats('  Without TF stack',          all.filter(r=>!r.isTFS));

console.log('\n── CONFIDENCE BUCKETS (zones only) ─────────────────────────────────────────');
for (const lo of [50,60,70,80,90]) {
  stats(`  Zones conf≥${lo}`,              zones.filter(r=>r.confidence>=lo));
  stats(`    + TF stack conf≥${lo}`,       zones.filter(r=>r.confidence>=lo && r.isTFS));
}

console.log('\n── SYMBOL BREAKDOWN ─────────────────────────────────────────────────────────');
for (const sym of ['MNQ','MGC']) {
  stats(`  ${sym} all zones`,           zones.filter(r=>r.symbol===sym));
  stats(`  ${sym} zones + TF stack`,    zones.filter(r=>r.symbol===sym && r.isTFS));
}
console.log('');
