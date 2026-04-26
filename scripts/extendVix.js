'use strict';
/**
 * extendVix.js — v14.41 Phase 2D.
 *
 * Extends data/historical/vix.json forward using the realized-volatility
 * computation from historicalVolatility.js. VIX proxy = 20-day rolling
 * annualized stddev of MNQ 1m daily-last-bar log returns.
 *
 * Only adds dates strictly greater than the current cache's last date.
 * Writes .bak sidecar.
 *
 * DXY gap is NOT filled by this script — DXY values come from Databento DX
 * futures zips which end 2026-04-03. Filling requires purchasing new zips,
 * out of scope for this audit.
 *
 * Usage:
 *   node scripts/extendVix.js
 *   node scripts/extendVix.js --dry-run
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VIX_PATH = path.join(ROOT, 'data', 'historical', 'vix.json');
const MNQ_1M_DIR = path.join(ROOT, 'data', 'historical', 'futures', 'MNQ', '1m');

const { buildVolatilityIndex } = require('../server/data/historicalVolatility');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

function main() {
  const vix = JSON.parse(fs.readFileSync(VIX_PATH, 'utf8'));
  const dates = Object.keys(vix).sort();
  const lastDate = dates[dates.length - 1];
  console.log(`[Phase-2D] VIX cache: ${dates.length} entries, last date ${lastDate}`);

  console.log('[Phase-2D] Computing realized volatility from MNQ 1m daily closes…');
  const volMap = buildVolatilityIndex(MNQ_1M_DIR);
  const volDates = Object.keys(volMap).sort();
  console.log(`[Phase-2D] Computed ${volDates.length} realized-vol values, range ${volDates[0]} → ${volDates.at(-1)}`);

  // New dates strictly after the cache's last date
  const newDates = volDates.filter(d => d > lastDate);
  console.log(`[Phase-2D] New dates to add: ${newDates.length}`);
  if (newDates.length === 0) { console.log('[Phase-2D] VIX already up-to-date.'); return; }

  const newEntries = {};
  for (const d of newDates) newEntries[d] = volMap[d];

  console.log('[Phase-2D] Samples (first 5):');
  for (const d of newDates.slice(0, 5)) console.log(`  ${d}: ${volMap[d]}`);
  if (newDates.length > 5) {
    console.log('  …');
    console.log(`  ${newDates.at(-1)}: ${volMap[newDates.at(-1)]}`);
  }

  // Sanity: realized vol should be in 5–200 range
  const outOfRange = newDates.filter(d => volMap[d] < 5 || volMap[d] > 200);
  if (outOfRange.length > 0) {
    console.warn(`[Phase-2D] Warning: ${outOfRange.length} values out of expected range 5–200: ${outOfRange.slice(0, 5).join(', ')}`);
  }

  if (DRY_RUN) { console.log('[Phase-2D] DRY-RUN — no writes.'); return; }

  // Backup + write
  const bakPath = VIX_PATH + '.bak';
  if (!fs.existsSync(bakPath)) fs.copyFileSync(VIX_PATH, bakPath);
  console.log(`[Phase-2D] Backup saved: ${bakPath}`);

  Object.assign(vix, newEntries);
  fs.writeFileSync(VIX_PATH, JSON.stringify(vix, null, 2));
  console.log(`[Phase-2D] Wrote VIX cache (+${newDates.length} entries)`);
  console.log(`[Phase-2D] New cache count: ${Object.keys(vix).length}, last date: ${Object.keys(vix).sort().at(-1)}`);
}

main();
