'use strict';
/**
 * precomputeBreadth.js — Pre-populate breadth_cache.json
 *
 * Reads all available 1m data dates across all 16 CME symbols,
 * computes market breadth for each date (using prior 21 trading days — no lookahead),
 * and writes results to data/historical/breadth_cache.json.
 *
 * Resumable: already-cached dates are skipped. Run again after adding new data.
 *
 * Usage:
 *   node scripts/precomputeBreadth.js
 *   node scripts/precomputeBreadth.js --force   (recompute all dates)
 */

const fs   = require('fs');
const path = require('path');

const { ALL_SYMBOLS }                    = require('../server/data/instruments');
const { computeMarketBreadthHistorical } = require('../server/analysis/marketBreadth');

const DATA_DIR         = path.resolve(__dirname, '../data/historical');
const CACHE_PATH       = path.join(DATA_DIR, 'breadth_cache.json');
const FORCE_RECOMPUTE  = process.argv.includes('--force');

// ─── Load daily closes for one symbol ────────────────────────────────────────

function loadDailyClosesForSymbol(sym) {
  const dir = path.join(DATA_DIR, 'futures', sym, '1m');
  if (!fs.existsSync(dir)) return {};
  const closes = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const date = f.replace('.json', '');
    try {
      const bars = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (bars.length > 0) {
        const last = bars[bars.length - 1];
        const close = last.close ?? last.c ?? 0;
        if (close > 0) closes[date] = close;
      }
    } catch { /* skip corrupted files */ }
  }
  return closes;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('[breadth] Loading existing cache…');
  const cache = (!FORCE_RECOMPUTE && fs.existsSync(CACHE_PATH))
    ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
    : {};
  console.log(`[breadth] Cache has ${Object.keys(cache).length} dates`);

  console.log('[breadth] Collecting all available trading dates…');
  const allDatesSet = new Set();
  for (const sym of ALL_SYMBOLS) {
    const dir = path.join(DATA_DIR, 'futures', sym, '1m');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      allDatesSet.add(f.replace('.json', ''));
    }
  }
  const sortedDates = [...allDatesSet].sort();
  console.log(`[breadth] Found ${sortedDates.length} total trading dates`);

  const missingDates = sortedDates.filter(d => !(d in cache));
  if (missingDates.length === 0) {
    console.log('[breadth] All dates already cached — nothing to do. Use --force to recompute.');
    return;
  }
  console.log(`[breadth] Computing ${missingDates.length} missing dates…`);

  console.log('[breadth] Loading daily closes for all 16 symbols…');
  const t0 = Date.now();
  const dailyClosesBySym = {};
  for (const sym of ALL_SYMBOLS) {
    process.stdout.write(`  ${sym}…`);
    dailyClosesBySym[sym] = loadDailyClosesForSymbol(sym);
    console.log(` ${Object.keys(dailyClosesBySym[sym]).length} dates`);
  }
  console.log(`[breadth] Closes loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('[breadth] Computing breadth per date…');
  const t1 = Date.now();
  let computed = 0;
  let nullCount = 0;
  const SAVE_EVERY = 100; // persist cache every N dates

  for (const date of missingDates) {
    cache[date] = computeMarketBreadthHistorical(dailyClosesBySym, sortedDates, date);
    if (!cache[date]) nullCount++;
    computed++;

    if (computed % SAVE_EVERY === 0) {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
      const pct = ((computed / missingDates.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
      console.log(`  [${pct}%] ${computed}/${missingDates.length} dates computed (${elapsed}s)`);
    }
  }

  // Final save
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  const totalSec = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`[breadth] Done: ${computed} dates computed (${nullCount} null/warmup), ${totalSec}s`);
  console.log(`[breadth] Cache: ${Object.keys(cache).length} total dates → ${CACHE_PATH}`);
}

main();
