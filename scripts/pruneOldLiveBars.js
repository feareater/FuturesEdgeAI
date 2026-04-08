#!/usr/bin/env node
'use strict';
// Maintenance script — remove live bar files older than N days.
//
// Usage:
//   node scripts/pruneOldLiveBars.js           # default: 90 days
//   node scripts/pruneOldLiveBars.js --days 60
//   node scripts/pruneOldLiveBars.js --dry-run  # list files that would be removed
//
// Run manually or schedule monthly (e.g. via cron or Windows Task Scheduler)
// to prevent unbounded disk growth from the Databento live feed persistence.

const fs   = require('fs');
const path = require('path');

const HIST_DIR = path.join(__dirname, '..', 'data', 'historical', 'futures');

// Parse CLI args
const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const daysIdx = args.indexOf('--days');
const days    = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 90;

if (isNaN(days) || days < 1) {
  console.error('--days must be a positive integer');
  process.exit(1);
}

const cutoffDate = new Date();
cutoffDate.setDate(cutoffDate.getDate() - days);
const cutoffStr = cutoffDate.toISOString().slice(0, 10); // YYYY-MM-DD

console.log(`Pruning live bar files older than ${days} days (cutoff: ${cutoffStr})`);
if (dryRun) console.log('DRY RUN — no files will be deleted\n');

let filesRemoved  = 0;
let bytesRemoved  = 0;
let filesSkipped  = 0;

try {
  const symbols = fs.readdirSync(HIST_DIR).filter(s => {
    try { return fs.statSync(path.join(HIST_DIR, s)).isDirectory(); } catch { return false; }
  });

  for (const sym of symbols) {
    const dir1m = path.join(HIST_DIR, sym, '1m');
    if (!fs.existsSync(dir1m)) continue;

    const files = fs.readdirSync(dir1m)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();

    for (const f of files) {
      const dateStr = f.replace('.json', '');
      if (dateStr >= cutoffStr) { filesSkipped++; continue; }

      const filePath = path.join(dir1m, f);
      try {
        const size = fs.statSync(filePath).size;
        if (!dryRun) {
          fs.unlinkSync(filePath);
        }
        console.log(`  ${dryRun ? '[would remove]' : 'removed'} ${sym}/1m/${f} (${(size / 1024).toFixed(1)} KB)`);
        filesRemoved++;
        bytesRemoved += size;
      } catch (err) {
        console.error(`  error removing ${sym}/1m/${f}: ${err.message}`);
      }
    }
  }
} catch (err) {
  console.error(`Failed to scan ${HIST_DIR}: ${err.message}`);
  process.exit(1);
}

const mbRemoved = (bytesRemoved / 1024 / 1024).toFixed(2);
console.log(`\nSummary:`);
console.log(`  Files ${dryRun ? 'that would be removed' : 'removed'}: ${filesRemoved}`);
console.log(`  Files retained (within ${days} days):                   ${filesSkipped}`);
console.log(`  Disk space ${dryRun ? 'that would be recovered' : 'recovered'}:  ${mbRemoved} MB`);
