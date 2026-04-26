'use strict';
/**
 * scripts/extractOpraZips.js — focused OPRA-only extraction (v14.42 Stage 2B).
 *
 * Mirrors the OPRA loop of historicalPipeline.js Phase 1b:
 *   - Walks Historical_data/OPRA/{etf}/OPRA-*.zip
 *   - Extracts every entry to data/historical/raw/OPRA/{etf}/
 *   - Skip-if-exists per file (silent — counts only, no per-file SKIP log)
 *
 * Why standalone (not just `--phase 1b`):
 *   - Phase 1b also walks GLBX / ETF_closes / DX zip dirs. For v14.42 we only
 *     need OPRA; the other loops are no-op skips but spend time touching disk.
 *   - Phase 1b's OPRA loop logs every SKIP — 39k lines for the existing 2013-2026
 *     archive. This script logs only NEW extracts + per-zip summary.
 *
 * Safety guard: rejects any file inside a zip whose name does NOT contain
 * `.statistics.csv.zst` or `.definition.csv.zst` (or is metadata.json /
 * condition.json / manifest.json). Per Jeff's v14.42 staging instruction,
 * only those schemas are allowed under raw/OPRA/{etf}/. If the new zips ever
 * bundle extra schemas inside (ohlcv-1s, trades, TCBBO), this script logs
 * them and writes nothing — a defensive net beyond Phase 1b's no-filter loop.
 *
 * Usage:
 *   node scripts/extractOpraZips.js [--etf QQQ] [--dry-run]
 */

const fs       = require('fs');
const path     = require('path');
const unzipper = require('unzipper');

const args = process.argv.slice(2);
const HAS  = (flag) => args.includes(flag);
const ARG  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const DRY_RUN  = HAS('--dry-run');
const ETF_ONLY = ARG('--etf')?.toUpperCase() || null;

const HIST_DATA   = path.resolve(__dirname, '..', 'Historical_data');
const OPRA_ZIP_DIR = path.join(HIST_DATA, 'OPRA');
const HIST_ROOT   = path.resolve(__dirname, '..', 'data', 'historical');
const RAW_OPRA    = path.join(HIST_ROOT, 'raw', 'OPRA');

const ETFS = ['QQQ', 'SPY', 'IWM', 'GLD', 'USO', 'SLV'];   // DIA omitted — no zips

const PREFIX = '[HP-BACKFILL-STAGE2]';
const log = (...a) => console.log(PREFIX, ...a);
const warn = (...a) => console.warn(PREFIX, ...a);

const ALLOWED_PATTERNS = [
  /\.statistics\.csv\.zst$/,
  /\.definition\.csv\.zst$/,
];
const ALLOWED_META = ['metadata.json', 'condition.json', 'manifest.json', 'symbology.json'];

function _ensureDir(d) { if (!DRY_RUN && !fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function _isAllowed(entryPath) {
  if (ALLOWED_META.includes(entryPath)) return true;
  for (const re of ALLOWED_PATTERNS) if (re.test(entryPath)) return true;
  return false;
}

async function extractZip(zipPath, destDir) {
  const summary = { zip: path.basename(zipPath), total: 0, extracted: 0, skipped: 0, rejected: 0, rejectedSamples: [] };
  const directory = await unzipper.Open.file(zipPath);

  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    summary.total++;

    if (!_isAllowed(entry.path)) {
      summary.rejected++;
      if (summary.rejectedSamples.length < 3) summary.rejectedSamples.push(entry.path);
      continue;
    }

    const dest = path.join(destDir, entry.path);
    if (fs.existsSync(dest)) { summary.skipped++; continue; }

    if (DRY_RUN) { summary.extracted++; continue; }

    _ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, await entry.buffer());
    summary.extracted++;
  }

  return summary;
}

(async () => {
  const t0 = Date.now();
  const targets = ETF_ONLY ? [ETF_ONLY] : ETFS;
  log(`Target ETFs: ${targets.join(', ')}${DRY_RUN ? '  (DRY RUN)' : ''}`);
  log(`Source dir:  ${OPRA_ZIP_DIR}`);
  log(`Dest base:   ${RAW_OPRA}`);
  log('');

  const grand = { zips: 0, extracted: 0, skipped: 0, rejected: 0 };

  for (const etf of targets) {
    const zipDir = path.join(OPRA_ZIP_DIR, etf);
    if (!fs.existsSync(zipDir)) { warn(`${etf}: no zip dir at ${zipDir} — skipping`); continue; }

    const zips = fs.readdirSync(zipDir)
      .filter(f => f.startsWith('OPRA') && f.endsWith('.zip'))
      .sort();

    if (zips.length === 0) { warn(`${etf}: no OPRA-*.zip files in ${zipDir}`); continue; }

    const destDir = path.join(RAW_OPRA, etf);
    _ensureDir(destDir);
    log(`── ${etf} — ${zips.length} zip(s) → raw/OPRA/${etf}/ ──`);

    for (const z of zips) {
      const t1 = Date.now();
      const sizeMB = (fs.statSync(path.join(zipDir, z)).size / 1024 / 1024).toFixed(1);
      const s = await extractZip(path.join(zipDir, z), destDir);
      const dt = ((Date.now() - t1) / 1000).toFixed(1);
      log(`  ${z} (${sizeMB} MB)  total=${s.total}  extracted=${s.extracted}  skipped=${s.skipped}  rejected=${s.rejected}  ${dt}s`);
      if (s.rejected > 0) {
        warn(`    rejected entries (${s.rejected}) — sample: ${s.rejectedSamples.join(', ')}`);
      }
      grand.zips++;
      grand.extracted += s.extracted;
      grand.skipped   += s.skipped;
      grand.rejected  += s.rejected;
    }
    log('');
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  log('═══════════════════════════════════════════════════════════════════');
  log(`COMPLETE — ${grand.zips} zips processed in ${dt}s`);
  log(`           ${grand.extracted} new files extracted, ${grand.skipped} skipped (already present), ${grand.rejected} rejected (non-statistics/definition)`);
  log('═══════════════════════════════════════════════════════════════════');
})().catch(err => { console.error(`${PREFIX} FATAL:`, err); process.exit(1); });
