'use strict';
/**
 * extendBreadthCache.js — v14.41 Phase 2C.
 *
 * Adds breadth entries to data/historical/breadth_cache.json for any trading
 * dates in the last 24 months that are missing from the cache. Does NOT
 * recompute existing entries (the Phase 1 audit found a 57% spot-check
 * divergence vs current 1m data; rebuilding the entire cache would shift
 * every existing backtest result, which is out of scope for this audit).
 *
 * Writes a .bak sidecar of breadth_cache.json before modifying.
 *
 * Uses the same computeMarketBreadthHistorical() function the backtest engine
 * uses in _precomputeBreadthAsync, so the newly-computed entries are
 * consistent with the backtest path.
 *
 * Usage:
 *   node scripts/extendBreadthCache.js           # apply
 *   node scripts/extendBreadthCache.js --dry-run
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(ROOT, 'data', 'historical', 'breadth_cache.json');
const FUTURES_DIR = path.join(ROOT, 'data', 'historical', 'futures');

const { ALL_SYMBOLS } = require('../server/data/instruments');
const { computeMarketBreadthHistorical } = require('../server/analysis/marketBreadth');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

function listDateFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''));
}

async function loadDailyClosesForSymbol(sym) {
  const dir = path.join(FUTURES_DIR, sym, '1m');
  if (!fs.existsSync(dir)) return {};
  const dates = listDateFiles(dir);
  const closes = {};
  for (const date of dates) {
    try {
      const bars = JSON.parse(fs.readFileSync(path.join(dir, date + '.json'), 'utf8'));
      if (!Array.isArray(bars) || bars.length === 0) continue;
      const last = bars[bars.length - 1];
      const c = last.close ?? last.c ?? 0;
      if (c > 0) closes[date] = c;
    } catch {}
  }
  return closes;
}

async function main() {
  console.log('[Phase-2C] Loading current breadth cache…');
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  console.log(`[Phase-2C] Cache has ${Object.keys(cache).length} entries, last date ${Object.keys(cache).sort().at(-1)}`);

  // Collect all source dates
  const allSrcDates = new Set();
  for (const sym of ALL_SYMBOLS) {
    const dir = path.join(FUTURES_DIR, sym, '1m');
    if (!fs.existsSync(dir)) continue;
    for (const d of listDateFiles(dir)) allSrcDates.add(d);
  }
  const sortedAllDates = [...allSrcDates].sort();

  // Missing dates in last 24 months
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 730 * 86400 * 1000).toISOString().slice(0, 10);
  const targetDates = sortedAllDates.filter(d => d >= cutoff && d <= today);
  const missing = targetDates.filter(d => !(d in cache));
  console.log(`[Phase-2C] Target dates in last 24mo: ${targetDates.length}, missing from cache: ${missing.length}`);
  if (missing.length > 0) console.log(`[Phase-2C] Missing dates: ${missing.join(', ')}`);

  if (missing.length === 0) {
    console.log('[Phase-2C] No missing dates — cache is complete for the target window. No changes.');
    return;
  }

  // Load daily closes
  console.log('[Phase-2C] Loading daily closes for all 16 symbols…');
  const dailyClosesBySym = {};
  for (const sym of ALL_SYMBOLS) {
    dailyClosesBySym[sym] = await loadDailyClosesForSymbol(sym);
  }

  // Compute breadth for missing dates
  const computed = {};
  for (const d of missing) {
    computed[d] = computeMarketBreadthHistorical(dailyClosesBySym, sortedAllDates, d);
  }
  console.log('[Phase-2C] Computed new entries:');
  for (const [d, b] of Object.entries(computed)) {
    if (!b) { console.log(`  ${d}: NULL (insufficient warmup or data)`); continue; }
    console.log(`  ${d}: eq=${b.equityBreadth} bond=${b.bondRegime} dollar=${b.dollarRegime} copper=${b.copperRegime} risk=${b.riskAppetite}/${b.riskAppetiteScore}`);
  }

  if (DRY_RUN) { console.log('[Phase-2C] DRY-RUN — no writes.'); return; }

  // Backup + write
  const bakPath = CACHE_PATH + '.bak';
  if (!fs.existsSync(bakPath)) fs.copyFileSync(CACHE_PATH, bakPath);
  console.log(`[Phase-2C] Backup saved: ${bakPath}`);

  Object.assign(cache, computed);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  console.log(`[Phase-2C] Wrote updated cache (+${Object.keys(computed).length} entries)`);
  console.log(`[Phase-2C] New cache count: ${Object.keys(cache).length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
