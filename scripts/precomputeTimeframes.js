'use strict';
/**
 * precomputeTimeframes.js — Pre-aggregate 1m → 5m/15m/30m OHLCV files
 *
 * Reads 1m source files from data/historical/futures/{SYMBOL}/1m/{date}.json
 * and writes clock-aligned aggregated bars to:
 *   data/historical/futures_agg/{SYMBOL}/{tf}/{date}.json
 *
 * Clock-aligned windows: 5m starts at :00/:05/…, 15m at :00/:15/…, 30m at :00/:30
 *
 * Usage:
 *   node scripts/precomputeTimeframes.js               # all symbols, skip existing
 *   node scripts/precomputeTimeframes.js --symbol MNQ  # one symbol only
 *   node scripts/precomputeTimeframes.js --force        # overwrite existing files
 */

const fs   = require('fs');
const path = require('path');

const { POINT_VALUE } = require('../server/data/instruments');

const DATA_DIR    = path.resolve(__dirname, '../data/historical');
const AGG_DIR     = path.join(DATA_DIR, 'futures_agg');
const TIMEFRAMES  = ['5m', '15m', '30m'];
const TF_SECONDS  = { '5m': 300, '15m': 900, '30m': 1800 };

// Parse CLI args
const argSymbol = (() => {
  const i = process.argv.indexOf('--symbol');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const FORCE = process.argv.includes('--force');

// All symbols with 1m data (use POINT_VALUE keys as canonical list)
const ALL_SYMBOLS = Object.keys(POINT_VALUE);

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Aggregate 1m bars into a larger timeframe using clock-aligned windows.
 * open  = first bar's open
 * high  = max high across all bars in window
 * low   = min low across all bars in window
 * close = last bar's close
 * volume = sum of all bar volumes
 * ts/time = first bar's ts (window open time)
 */
function aggregateBars(bars1m, tfSeconds) {
  if (!bars1m || bars1m.length === 0) return [];
  const out = [];
  let bucket = null;

  for (const bar of bars1m) {
    const ts = bar.ts ?? bar.time;
    if (ts == null) continue;

    // Align to window boundary
    const windowTs = Math.floor(ts / tfSeconds) * tfSeconds;

    if (!bucket || bucket.ts !== windowTs) {
      // Save previous bucket
      if (bucket) out.push(bucket);
      bucket = {
        ts:     windowTs,
        time:   windowTs,
        open:   bar.open  ?? bar.o,
        high:   bar.high  ?? bar.h,
        low:    bar.low   ?? bar.l,
        close:  bar.close ?? bar.c,
        volume: bar.volume ?? bar.v ?? 0,
      };
    } else {
      // Extend current bucket
      const h = bar.high  ?? bar.h;
      const l = bar.low   ?? bar.l;
      if (h != null && h > bucket.high) bucket.high = h;
      if (l != null && l < bucket.low)  bucket.low  = l;
      bucket.close  = bar.close ?? bar.c ?? bucket.close;
      bucket.volume += bar.volume ?? bar.v ?? 0;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

// ─── Process one symbol ───────────────────────────────────────────────────────

function processSymbol(sym) {
  const srcDir = path.join(DATA_DIR, 'futures', sym, '1m');
  if (!fs.existsSync(srcDir)) {
    console.log(`  [${sym}] No 1m data — skipping`);
    return { skipped: 0, written: 0 };
  }

  const dates = fs.readdirSync(srcDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();

  let written = 0;
  let skipped = 0;

  for (const date of dates) {
    for (const tf of TIMEFRAMES) {
      const outDir  = path.join(AGG_DIR, sym, tf);
      const outPath = path.join(outDir, `${date}.json`);

      if (!FORCE && fs.existsSync(outPath)) {
        skipped++;
        continue;
      }

      // Load 1m bars for this date
      let bars1m;
      try {
        bars1m = JSON.parse(fs.readFileSync(path.join(srcDir, `${date}.json`), 'utf8'));
      } catch { continue; }

      if (!bars1m || bars1m.length === 0) continue;

      const agg = aggregateBars(bars1m, TF_SECONDS[tf]);
      if (agg.length === 0) continue;

      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(agg));
      written++;
    }
  }

  return { dates: dates.length, written, skipped };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const symbols = argSymbol ? [argSymbol] : ALL_SYMBOLS;
  console.log(`[agg] Processing ${symbols.length} symbol(s): ${symbols.join(', ')}`);
  console.log(`[agg] Timeframes: ${TIMEFRAMES.join(', ')}  |  Force: ${FORCE}`);
  console.log(`[agg] Output: ${AGG_DIR}`);
  console.log('');

  const t0 = Date.now();
  let totalWritten = 0;
  let totalSkipped = 0;

  for (const sym of symbols) {
    process.stdout.write(`  ${sym}…`);
    const result = processSymbol(sym);
    totalWritten += result.written;
    totalSkipped += result.skipped;
    console.log(` ${result.dates ?? 0} dates → ${result.written} written, ${result.skipped} skipped`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log(`[agg] Done: ${totalWritten} files written, ${totalSkipped} skipped in ${elapsed}s`);
}

main();
