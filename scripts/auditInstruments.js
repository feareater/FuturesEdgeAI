'use strict';
// Run with: node scripts/auditInstruments.js
// Checks candle store health for all 8 tradeable futures

const path = require('path');

// Bootstrap: ensure getCandles can find seed files
process.chdir(path.join(__dirname, '..'));

const { getCandles } = require('../server/data/snapshot');
const { INSTRUMENTS } = require('../server/data/instruments');

const SYMBOLS = ['MNQ', 'MES', 'M2K', 'MYM', 'MGC', 'MCL', 'MHG', 'SIL'];
const TF = '5m';

// Expected price ranges for sanity check (calibrated to April 2026 market conditions)
const EXPECTED_RANGE = {
  MNQ: [15000, 30000],
  MES: [4000, 8000],
  M2K: [1500, 3000],
  MYM: [30000, 55000],
  MGC: [1500, 6000],
  MCL: [40, 150],
  MHG: [2, 8],
  SIL: [20, 150],   // silver (SI=F) — volatile in 2026 commodities rally
};

function audit(symbol) {
  let candles;
  try {
    candles = getCandles(symbol, TF);
  } catch (err) {
    return { symbol, error: err.message, status: 'FAIL' };
  }

  if (!candles || candles.length === 0) {
    return { symbol, barCount: 0, error: 'No candles returned', status: 'FAIL' };
  }

  const barCount = candles.length;
  const firstBar = candles[0];
  const lastBar = candles[candles.length - 1];
  const firstTs = new Date(firstBar.time * 1000).toISOString();
  const lastTs = new Date(lastBar.time * 1000).toISOString();

  // Price stats
  let minClose = Infinity, maxClose = -Infinity;
  let badBars = 0;
  let spikes = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const cl = c.close;

    if (cl == null || isNaN(cl) || cl <= 0) {
      badBars++;
      continue;
    }

    if (cl < minClose) minClose = cl;
    if (cl > maxClose) maxClose = cl;

    if (i > 0) {
      const prev = candles[i - 1].close;
      if (prev > 0 && Math.abs(cl - prev) / prev > 0.20) {
        spikes++;
      }
    }
  }

  // Stale check: last bar within 2 hours
  const nowSec = Math.floor(Date.now() / 1000);
  const staleSec = nowSec - lastBar.time;
  const isStale = staleSec > 7200; // 2 hours

  // Expected range check
  const [lo, hi] = EXPECTED_RANGE[symbol] || [0, Infinity];
  const priceInRange = minClose >= lo * 0.5 && maxClose <= hi * 2;

  // Status
  let status = 'PASS';
  const warnings = [];
  if (badBars > 0) { warnings.push(`${badBars} bad bars`); status = 'WARN'; }
  if (spikes > 0) { warnings.push(`${spikes} spike bars (>20%)`); status = 'WARN'; }
  if (minClose < lo * 0.5) { warnings.push(`minClose ${minClose.toFixed(4)} way below expected ${lo}`); status = 'FAIL'; }
  if (!priceInRange) { warnings.push('Price outside expected range'); status = 'FAIL'; }
  if (barCount < 50) { warnings.push(`Only ${barCount} bars`); status = 'WARN'; }
  if (isStale) { warnings.push(`Stale: last bar ${(staleSec / 3600).toFixed(1)}h ago`); }

  return {
    symbol,
    barCount,
    firstTs,
    lastTs,
    minClose: minClose === Infinity ? null : minClose,
    maxClose: maxClose === -Infinity ? null : maxClose,
    badBars,
    spikes,
    isStale,
    staleSec,
    pointValue: INSTRUMENTS[symbol]?.pointValue,
    status,
    warnings,
  };
}

// Run audit
console.log('=== FuturesEdge AI — Instrument Data Audit ===');
console.log(`Timeframe: ${TF}`);
console.log(`Time: ${new Date().toISOString()}\n`);

const results = SYMBOLS.map(audit);

// Print detailed results
for (const r of results) {
  console.log(`--- ${r.symbol} ---`);
  if (r.error) {
    console.log(`  ERROR: ${r.error}`);
    console.log(`  Status: ${r.status}\n`);
    continue;
  }
  console.log(`  Bars: ${r.barCount}`);
  console.log(`  First: ${r.firstTs}`);
  console.log(`  Last:  ${r.lastTs}`);
  console.log(`  Min close: ${r.minClose?.toFixed(4) ?? 'N/A'}`);
  console.log(`  Max close: ${r.maxClose?.toFixed(4) ?? 'N/A'}`);
  console.log(`  Bad bars (close<=0/null/NaN): ${r.badBars}`);
  console.log(`  Spike bars (>20% move): ${r.spikes}`);
  console.log(`  Stale: ${r.isStale ? `YES (${(r.staleSec / 3600).toFixed(1)}h)` : 'No'}`);
  console.log(`  pointValue: ${r.pointValue}`);
  if (r.warnings.length) console.log(`  Warnings: ${r.warnings.join('; ')}`);
  console.log(`  Status: ${r.status}\n`);
}

// Summary table
console.log('=== SUMMARY ===');
console.log('Symbol | Bars   | Min Close   | Max Close   | Bad | Spikes | Status');
console.log('-------|--------|-------------|-------------|-----|--------|-------');
for (const r of results) {
  const bars = r.barCount != null ? String(r.barCount).padEnd(6) : 'ERR   ';
  const min = r.minClose != null ? r.minClose.toFixed(2).padEnd(11) : 'N/A        ';
  const max = r.maxClose != null ? r.maxClose.toFixed(2).padEnd(11) : 'N/A        ';
  const bad = String(r.badBars ?? '-').padEnd(3);
  const spk = String(r.spikes ?? '-').padEnd(6);
  console.log(`${r.symbol.padEnd(6)} | ${bars} | ${min} | ${max} | ${bad} | ${spk} | ${r.status}`);
}

const failCount = results.filter(r => r.status === 'FAIL').length;
const warnCount = results.filter(r => r.status === 'WARN').length;
console.log(`\nResult: ${results.length - failCount - warnCount} PASS, ${warnCount} WARN, ${failCount} FAIL`);
