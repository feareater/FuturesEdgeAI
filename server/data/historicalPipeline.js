'use strict';
/**
 * historicalPipeline.js — FuturesEdge AI Historical Data Pipeline
 *
 * Phases:
 *   1a. Inventory zip files and write manifest.json
 *   1b. Extract raw files (GLBX → raw/GLBX/, OPRA → raw/OPRA/{underlying}/)
 *   1c. Process futures OHLCV → daily JSON files (all 16 symbols)
 *   1d. No-op stub — ETF closes derived from OPRA statistics in Phase 1e
 *   1e. Process OPRA options data for all 6 underlyings
 *   1f. Compute HP levels (Black-Scholes) for all 6 OPRA underlyings
 *
 * Usage:
 *   node server/data/historicalPipeline.js [flags]
 *
 *   --phase 1a|1b|1c|1d|1e|1f  Run only this phase (run all if omitted)
 *   --inventory-only            Alias for --phase 1a
 *   --futures-only              Alias for --phase 1b + 1c
 *   --options-only              Alias for --phase 1d + 1e + 1f
 *   --clean-raw                 Delete flat raw/GLBX/ files and old derived futures data,
 *                               then proceed with the requested phase(s). Run before
 *                               re-extracting with 1b after the per-symbol layout change.
 *   --force                     Phase 1c: reprocess all dates, bypass skip-if-exists
 *   --recompute                 Force recomputation of HP levels
 *   --recompute-from YYYY-MM-DD Recompute HP from this date forward
 *   --symbol MNQ                Process only this futures symbol (phase 1c)
 *   --from-date YYYY-MM-DD      Skip processing dates before this date
 *   --verify                    Check output coverage and write verification.json
 *   --dry-run                   Log actions without writing files
 */

require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const unzipper = require('unzipper');
const { decompress } = require('@mongodb-js/zstd');
const { computeHP } = require('./hpCompute');
const {
  ALL_SYMBOLS,
  DATABENTO_ROOT_TO_INTERNAL,
  OPRA_UNDERLYINGS,
} = require('./instruments');

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT         = path.resolve(__dirname, '../../');
const DATA         = path.join(ROOT, 'data', 'historical');
const RAW_DIR      = path.join(DATA, 'raw');
const FUT_DIR      = path.join(DATA, 'futures');
const OPT_DIR      = path.join(DATA, 'options');
const HIST_DATA    = path.join(ROOT, 'Historical_data');
const CME_ZIP_DIR  = path.join(HIST_DATA, 'CME');      // GLBX zip files
const OPRA_ZIP_DIR = path.join(HIST_DATA, 'OPRA');     // per-underlying OPRA zips
const ERRORS_LOG   = path.join(DATA, 'errors.log');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const HAS    = (flag) => args.includes(flag);
const ARG    = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const DRY_RUN        = HAS('--dry-run')        || process.env.DRY_RUN === 'true';
const RECOMPUTE      = HAS('--recompute');
const FORCE          = HAS('--force');         // Phase 1c: bypass skip-if-exists for OHLCV files
const CLEAN_RAW      = HAS('--clean-raw');     // Delete flat raw/GLBX/ + derived data before run
const SYMBOL_FILTER  = ARG('--symbol')?.toUpperCase() || null;
const FROM_DATE      = ARG('--from-date') || null;
const RECOMPUTE_FROM = ARG('--recompute-from') || null;
const VERIFY_ONLY    = HAS('--verify');

// Phase selector — --phase 1c overrides legacy flags
const PHASE_ARG      = ARG('--phase');
const INVENTORY_ONLY = HAS('--inventory-only') || PHASE_ARG === '1a';
const FUTURES_ONLY   = HAS('--futures-only')   || PHASE_ARG === '1b' || PHASE_ARG === '1c';
const OPTIONS_ONLY   = HAS('--options-only')   || ['1d','1e','1f'].includes(PHASE_ARG);
const SINGLE_PHASE   = PHASE_ARG; // e.g. '1c' → run ONLY that phase

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(msg); }
function warn(msg) { console.warn('[WARN]', msg); }
function err(msg)  { console.error('[ERR]', msg); }

function errLog(msg) {
  console.error('[ERR]', msg);
  if (!DRY_RUN) {
    try {
      fs.mkdirSync(path.dirname(ERRORS_LOG), { recursive: true });
      fs.appendFileSync(ERRORS_LOG, `${new Date().toISOString()} ${msg}\n`);
    } catch (_) {}
  }
}

function ensureDir(dir) {
  if (!DRY_RUN) fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(filePath, data) {
  if (DRY_RUN) { log(`[DRY] would write ${filePath}`); return; }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

/**
 * Stream a zip file entry by entry. Calls onEntry(entry) for each entry.
 * entry.path = entry name; await entry.buffer() = full entry contents as Buffer.
 * Uses unzipper to avoid loading the whole archive into memory (supports >2 GiB).
 */
async function streamZip(zipPath, onEntry) {
  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    await onEntry(entry);
  }
}

/**
 * Read a single named entry from a zip without loading the whole archive.
 * Returns Buffer or null.
 */
async function readZipEntry(zipPath, entryName) {
  const directory = await unzipper.Open.file(zipPath);
  const entry = directory.files.find(f => f.path === entryName);
  if (!entry) return null;
  return entry.buffer();
}

function elapsed(start) {
  return ((Date.now() - start) / 1000).toFixed(1) + 's';
}

// Estimate time remaining
function eta(done, total, elapsedMs) {
  if (done === 0) return '?';
  const msPerItem = elapsedMs / done;
  const remaining = Math.round((total - done) * msPerItem / 1000);
  if (remaining < 60)  return `${remaining}s`;
  if (remaining < 3600) return `${Math.round(remaining / 60)}m`;
  return `${(remaining / 3600).toFixed(1)}h`;
}


// ─── Zip discovery ───────────────────────────────────────────────────────────

/** Find all GLBX zip files in Historical_data/CME/ */
function findGLBXZips() {
  if (!fs.existsSync(CME_ZIP_DIR)) {
    warn(`CME zip directory not found: ${CME_ZIP_DIR}`);
    return [];
  }
  return fs.readdirSync(CME_ZIP_DIR)
    .filter(f => f.startsWith('GLBX') && f.endsWith('.zip'))
    .map(f => ({ name: f, path: path.join(CME_ZIP_DIR, f), size: fs.statSync(path.join(CME_ZIP_DIR, f)).size }));
}

/** Find all OPRA zip files for a specific underlying in Historical_data/OPRA/{underlying}/ */
function findOPRAZips(underlying) {
  const dir = path.join(OPRA_ZIP_DIR, underlying);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('OPRA') && f.endsWith('.zip'))
    .map(f => ({ name: f, path: path.join(dir, f), underlying, size: fs.statSync(path.join(dir, f)).size }));
}

/** Find all OPRA zips across all underlyings */
function findAllOPRAZips() {
  const result = [];
  for (const { etf } of OPRA_UNDERLYINGS) {
    result.push(...findOPRAZips(etf));
  }
  return result;
}

/**
 * Find potential ohlcv-1d ETF close zips in Historical_data/OPRA/{underlying}/.
 * These are any zips that do NOT start with 'OPRA' (e.g. DBEQ-* downloads).
 * Phase 1b verifies schema = 'ohlcv-1d' via metadata.json before extracting.
 */
function findETFCloseZips(underlying) {
  const dir = path.join(OPRA_ZIP_DIR, underlying);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.zip') && !f.startsWith('OPRA'))
    .map(f => ({ name: f, path: path.join(dir, f), underlying, size: fs.statSync(path.join(dir, f)).size }));
}

/** Find all potential ohlcv-1d zips across all ETFs */
function findAllETFCloseZips() {
  const result = [];
  for (const { etf } of OPRA_UNDERLYINGS) {
    result.push(...findETFCloseZips(etf));
  }
  return result;
}


// ─── Date helpers ────────────────────────────────────────────────────────────

/**
 * Convert ISO timestamp to US/Eastern trading date 'YYYY-MM-DD'
 * CME convention: bars at or after 18:00 ET belong to the next calendar day.
 */
function isoToTradingDate(isoStr) {
  const ms = Date.parse(isoStr);
  if (isNaN(ms)) return null;

  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const dstStart = nthSundayOfMonth(year, 2, 2);   // March, 2nd Sunday
  const dstEnd   = nthSundayOfMonth(year, 10, 1);  // November, 1st Sunday
  const isDST    = ms >= dstStart && ms < dstEnd;
  const offsetHours = isDST ? 4 : 5;

  const etMs   = ms - offsetHours * 3600000;
  const etDate = new Date(etMs);
  const etHour = etDate.getUTCHours();

  if (etHour >= 18) {
    const nextDay = new Date(etMs + 86400000);
    return nextDay.toISOString().substring(0, 10);
  }
  return etDate.toISOString().substring(0, 10);
}

/** Returns Unix ms of the nth Sunday of given month (0-indexed) */
function nthSundayOfMonth(year, month, n) {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    if (d.getUTCDay() === 0) {
      count++;
      if (count === n) return d.getTime() + 2 * 3600000;
    }
  }
  return Infinity;
}

function isoToUnixSec(isoStr) { return Math.floor(Date.parse(isoStr) / 1000); }

// ─── Symbol detection ────────────────────────────────────────────────────────

/**
 * Extract internal symbol from a Databento CSV symbol field.
 * Handles both continuous format (MNQ.c.0, GC.c.0) and
 * individual contract format (MNQM6, GCM6, M2KH5).
 * Returns null if not a recognised symbol.
 */
function csvSymbolToInternal(rawSymbol) {
  if (!rawSymbol) return null;
  // Skip spreads
  if (rawSymbol.includes('-')) return null;

  let dbRoot = null;

  // Continuous format: ROOT.c.N  e.g. MNQ.c.0, GC.c.0, M2K.c.0
  const contMatch = rawSymbol.match(/^([A-Z][A-Z0-9]{1,4})\.c\.\d+$/);
  if (contMatch) {
    dbRoot = contMatch[1];
  } else {
    // Individual contract format: ROOT + month letter + year digit(s)
    // Handles: MNQM6, GCM6, M2KH5, ZTH5, UBH5, MBTH5
    const indivMatch = rawSymbol.match(/^([A-Z][A-Z0-9]{1,4})[FGHJKMNQUVXZ]\d+$/);
    if (indivMatch) dbRoot = indivMatch[1];
  }

  if (!dbRoot) return null;
  return DATABENTO_ROOT_TO_INTERNAL[dbRoot] || null;
}

// ─── Aggregation helper ───────────────────────────────────────────────────────

/** Aggregate 1m bars into N-minute bars */
function aggregateBars(bars1m, minutes) {
  if (bars1m.length === 0) return [];
  const result = [];
  const tfSec = minutes * 60;
  // Use window-aligned aggregation (same logic as snapshot.js live mode)
  let windowStart = Math.floor(bars1m[0].ts / tfSec) * tfSec;
  let bucket = [];

  for (const bar of bars1m) {
    const barWindow = Math.floor(bar.ts / tfSec) * tfSec;
    if (barWindow !== windowStart) {
      if (bucket.length > 0) {
        result.push({
          ts:     windowStart,
          open:   bucket[0].open,
          high:   Math.max(...bucket.map(b => b.high)),
          low:    Math.min(...bucket.map(b => b.low)),
          close:  bucket[bucket.length - 1].close,
          volume: bucket.reduce((s, b) => s + b.volume, 0),
        });
      }
      windowStart = barWindow;
      bucket = [];
    }
    bucket.push(bar);
  }
  if (bucket.length > 0) {
    result.push({
      ts:     windowStart,
      open:   bucket[0].open,
      high:   Math.max(...bucket.map(b => b.high)),
      low:    Math.min(...bucket.map(b => b.low)),
      close:  bucket[bucket.length - 1].close,
      volume: bucket.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

// ─── PHASE 1a: INVENTORY ─────────────────────────────────────────────────────

async function phase1a() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1a — ZIP INVENTORY');
  log('══════════════════════════════════════════════════════');

  const glbxZips = findGLBXZips();
  const opraZips = findAllOPRAZips();
  log(`Found ${glbxZips.length} GLBX zip(s) and ${opraZips.length} OPRA zip(s)`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    cme: {},
    opra: {},
  };

  // ── Inventory GLBX zips ──────────────────────────────────────────────────
  log('\n── CME (GLBX) ──');
  for (const zipInfo of glbxZips) {
    log(`\n[ZIP] ${zipInfo.name} (${(zipInfo.size / 1e6).toFixed(1)} MB)`);

    // Read metadata.json from zip (streaming — safe for >2 GiB files)
    let symbols = [], dateRange = null, schema = null;
    try {
      const metaBuf = await readZipEntry(zipInfo.path, 'metadata.json');
      if (metaBuf) {
        const meta = JSON.parse(metaBuf.toString('utf8'));
        schema  = meta.query?.schema;
        symbols = meta.query?.symbols || [];
        const startNs = meta.query?.start;
        const endNs   = meta.query?.end;
        if (startNs && endNs) {
          dateRange = {
            start: new Date(Number(BigInt(startNs) / 1_000_000n)).toISOString().substring(0, 10),
            end:   new Date(Number(BigInt(endNs)   / 1_000_000n)).toISOString().substring(0, 10),
          };
        }
        log(`  Schema: ${schema}  Symbols: ${symbols.join(', ')}`);
        if (dateRange) log(`  Date range: ${dateRange.start} → ${dateRange.end}`);
      }
    } catch (e2) { warn(`metadata.json parse error: ${e2.message}`); }

    // Inspect first CSV.ZST to confirm column layout + actual tickers in data
    let sampleTickers = [];
    let sampledCsv = false;
    try {
      await streamZip(zipInfo.path, async (entry) => {
        if (sampledCsv || !entry.path.endsWith('.csv.zst')) return;
        sampledCsv = true;
        const buf  = await entry.buffer();
        const text = (await decompress(buf)).toString('utf8');
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length > 1) {
          const headers = lines[0].split(',');
          const symIdx  = headers.indexOf('symbol');
          log(`  Columns (${headers.length}): ${headers.join(', ')}`);
          if (symIdx >= 0) {
            const seen = new Set();
            for (let i = 1; i < Math.min(101, lines.length); i++) {
              const parts = lines[i].split(',');
              seen.add(parts[symIdx]);
            }
            sampleTickers = [...seen];
            log(`  Sample tickers (first 100 rows): ${sampleTickers.join(', ')}`);
          }
        }
      });
    } catch (e2) { warn(`Could not inspect CSV: ${e2.message}`); }

    // Accumulate per dbRoot
    for (const sym of symbols) {
      const dbRoot = sym.replace(/\.c\.\d+$/, '');
      const internal = DATABENTO_ROOT_TO_INTERNAL[dbRoot] || dbRoot;
      if (!manifest.cme[internal]) {
        manifest.cme[internal] = { databento: sym, zipCount: 0, dateRange: null, sampleTickers: [] };
      }
      manifest.cme[internal].zipCount++;
      if (dateRange) manifest.cme[internal].dateRange = dateRange;
      if (sampleTickers.length) manifest.cme[internal].sampleTickers = sampleTickers;
    }
  }

  // ── Inventory OPRA zips ──────────────────────────────────────────────────
  log('\n── OPRA ──');
  for (const zipInfo of opraZips) {
    log(`\n[ZIP] ${zipInfo.name} (underlying: ${zipInfo.underlying}, ${(zipInfo.size / 1e6).toFixed(1)} MB)`);

    let dateRange = null;
    try {
      const metaBuf = await readZipEntry(zipInfo.path, 'metadata.json');
      if (metaBuf) {
        const meta = JSON.parse(metaBuf.toString('utf8'));
        const startNs = meta.query?.start;
        const endNs   = meta.query?.end;
        if (startNs && endNs) {
          dateRange = {
            start: new Date(Number(BigInt(startNs) / 1_000_000n)).toISOString().substring(0, 10),
            end:   new Date(Number(BigInt(endNs)   / 1_000_000n)).toISOString().substring(0, 10),
          };
          log(`  Date range: ${dateRange.start} → ${dateRange.end}`);
        }
      }
    } catch (_) {}

    const etf = zipInfo.underlying;
    if (!manifest.opra[etf]) manifest.opra[etf] = { zipCount: 0, dateRange: null };
    manifest.opra[etf].zipCount++;
    if (dateRange) manifest.opra[etf].dateRange = dateRange;
  }

  const outPath = path.join(DATA, 'manifest.json');
  writeJSON(outPath, manifest);
  log(`\n[SAVE] manifest.json — ${Object.keys(manifest.cme).length} CME symbols, ${Object.keys(manifest.opra).length} OPRA underlyings`);
  log(`\n[1a COMPLETE] ${elapsed(t0)}`);
  return manifest;
}

// ─── CLEAN RAW ───────────────────────────────────────────────────────────────

/**
 * Remove flat raw/GLBX/ files (old mixed-symbol layout) and all per-symbol
 * derived futures directories so phase 1b + 1c can start from a clean slate.
 * Only called when --clean-raw flag is passed.
 */
function cleanRaw() {
  log('\n══════════════════════════════════════════════════════');
  log(' CLEAN RAW — Removing old raw and derived data');
  log('══════════════════════════════════════════════════════');

  // Remove entire raw/GLBX/ tree (flat files + any stale per-symbol subdirs)
  const glbxDir = path.join(RAW_DIR, 'GLBX');
  if (fs.existsSync(glbxDir)) {
    if (DRY_RUN) {
      log(`[DRY] would remove tree: ${glbxDir}`);
    } else {
      fs.rmSync(glbxDir, { recursive: true, force: true });
      log(`Removed: ${glbxDir}`);
    }
  } else {
    log(`Already absent: ${glbxDir}`);
  }

  // Remove old derived futures files for target symbols
  const targetSymbols = SYMBOL_FILTER ? [SYMBOL_FILTER] : ALL_SYMBOLS;
  for (const sym of targetSymbols) {
    const symDir = path.join(FUT_DIR, sym);
    if (fs.existsSync(symDir)) {
      if (DRY_RUN) {
        log(`[DRY] would remove derived: ${symDir}`);
      } else {
        fs.rmSync(symDir, { recursive: true, force: true });
        log(`Removed derived: ${symDir}`);
      }
    }
  }

  log('[CLEAN COMPLETE]');
}

// ─── GLBX SYMBOL DETECTION ───────────────────────────────────────────────────

/**
 * Read the metadata.json inside a GLBX zip file and return the internal symbol
 * name (e.g. 'MNQ', 'MGC').  Returns null if the symbol cannot be determined.
 *
 * Databento metadata.json structure:
 *   { "query": { "symbols": ["MNQ.FUT"], ... } }
 *
 * The parent symbol format is always 'ROOT.FUT'. Strip '.FUT' to get the root,
 * which matches the internal symbol name directly for all 16 CME instruments.
 */
async function getGlbxSymbolFromZip(zipPath) {
  try {
    const metaBuf = await readZipEntry(zipPath, 'metadata.json');
    if (!metaBuf) return null;
    const meta = JSON.parse(metaBuf.toString('utf8'));
    const syms = meta.query?.symbols;
    if (!syms || syms.length === 0) return null;
    // 'MNQ.FUT' → 'MNQ',  'MGC.FUT' → 'MGC',  'GC.FUT' → 'MGC' (via map)
    const raw = syms[0].replace(/\.FUT$/i, '').replace(/\.c\.\d+$/i, '');
    // Direct match first, then fall back to DATABENTO_ROOT_TO_INTERNAL
    if (ALL_SYMBOLS.includes(raw)) return raw;
    return DATABENTO_ROOT_TO_INTERNAL[raw] || null;
  } catch (_) {
    return null;
  }
}

// ─── PHASE 1b: EXTRACT RAW FILES ─────────────────────────────────────────────

async function phase1b() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1b — EXTRACT RAW FILES');
  log('══════════════════════════════════════════════════════');

  let extracted = 0;
  let skipped   = 0;

  // Extract GLBX zips → raw/GLBX/{SYMBOL}/ (one subdirectory per symbol)
  // Each zip contains data for exactly one symbol.  Read metadata.json inside
  // the zip to determine which symbol it is, then extract into that subdirectory.
  // This prevents the filename-collision problem that occurred with the old flat layout.
  const glbxZips = findGLBXZips();
  log(`\n── Extracting ${glbxZips.length} GLBX zip(s) → raw/GLBX/{SYMBOL}/ ──`);
  for (const zipInfo of glbxZips) {
    log(`\n[EXTRACT] ${zipInfo.name}`);

    // Determine symbol from metadata.json inside the zip
    const symbol = await getGlbxSymbolFromZip(zipInfo.path);
    if (!symbol) {
      warn(`  Could not determine symbol for ${zipInfo.name} — skipping`);
      continue;
    }
    log(`  Symbol: ${symbol}`);

    const destDir = path.join(RAW_DIR, 'GLBX', symbol);
    ensureDir(destDir);

    let zipExtracted = 0;
    let zipSkipped   = 0;
    await streamZip(zipInfo.path, async (entry) => {
      if (entry.path.includes('ohlcv-1s')) { return; }  // skip 1s data silently
      if (entry.type === 'Directory') return;
      const dest = path.join(destDir, entry.path);
      if (fs.existsSync(dest)) { zipSkipped++; return; }
      if (DRY_RUN) { log(`  [DRY] would extract: ${entry.path}`); return; }
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, await entry.buffer());
      zipExtracted++;
      extracted++;
    });
    log(`  Extracted ${zipExtracted} file(s), skipped ${zipSkipped} existing`);
    skipped += zipSkipped;
  }

  // Extract OPRA zips → raw/OPRA/{underlying}/
  const opraZips = findAllOPRAZips();
  log(`\n── Extracting ${opraZips.length} OPRA zip(s) → raw/OPRA/{underlying}/ ──`);
  for (const zipInfo of opraZips) {
    const destDir = path.join(RAW_DIR, 'OPRA', zipInfo.underlying);
    ensureDir(destDir);
    log(`\n[EXTRACT] ${zipInfo.name} → raw/OPRA/${zipInfo.underlying}/`);
    await streamZip(zipInfo.path, async (entry) => {
      if (entry.type === 'Directory') return;
      const dest = path.join(destDir, entry.path);
      if (fs.existsSync(dest)) { log(`  SKIP (exists): ${entry.path}`); return; }
      if (DRY_RUN) { log(`  [DRY] would extract: ${entry.path}`); return; }
      log(`  Extracting: ${entry.path}`);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, await entry.buffer());
      extracted++;
    });
  }

  // Loop 3: OPRA ohlcv-1d zips (options daily OHLCV, dataset=OPRA.PILLAR)
  // These are non-OPRA-prefixed zips in the OPRA folders.
  // Only extract if dataset=OPRA.PILLAR AND schema=ohlcv-1d.
  // Warn and skip anything from XNYS.PILLAR or other datasets — those belong in ETF_closes/.
  const etfCloseZips = findAllETFCloseZips();
  log(`\n── Checking ${etfCloseZips.length} potential OPRA ohlcv-1d zip(s) → raw/OPRA/{underlying}/ohlcv-1d/ ──`);
  for (const zipInfo of etfCloseZips) {
    let meta = null;
    try {
      const metaBuf = await readZipEntry(zipInfo.path, 'metadata.json');
      if (metaBuf) meta = JSON.parse(metaBuf.toString('utf8'));
    } catch (_) {}
    const schema  = meta?.query?.schema;
    const dataset = meta?.query?.dataset;
    if (schema !== 'ohlcv-1d') {
      warn(`  ${zipInfo.name}: schema='${schema}' — expected 'ohlcv-1d', skipping`);
      continue;
    }
    if (dataset !== 'OPRA.PILLAR') {
      warn(`  ${zipInfo.name}: dataset='${dataset}' — expected OPRA.PILLAR for OPRA ohlcv-1d. Wrong folder? ETF equity closes belong in Historical_data/ETF_closes/, not OPRA/. Skipping.`);
      continue;
    }
    const destDir = path.join(RAW_DIR, 'OPRA', zipInfo.underlying, 'ohlcv-1d');
    ensureDir(destDir);
    log(`\n[EXTRACT] ${zipInfo.name} (OPRA ohlcv-1d) → raw/OPRA/${zipInfo.underlying}/ohlcv-1d/`);
    let zipExtracted = 0;
    let zipSkipped   = 0;
    await streamZip(zipInfo.path, async (entry) => {
      if (entry.type === 'Directory') return;
      const dest = path.join(destDir, entry.path);
      if (fs.existsSync(dest)) { zipSkipped++; return; }
      if (DRY_RUN) { log(`  [DRY] would extract: ${entry.path}`); return; }
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, await entry.buffer());
      zipExtracted++;
      extracted++;
    });
    skipped += zipSkipped;
    log(`  Extracted ${zipExtracted} file(s), skipped ${zipSkipped} existing`);
  }

  // Loop 4: XNYS.PILLAR ohlcv-1d ETF equity close zips → raw/ETF_closes/{ticker}/
  // Jeff places one zip per ETF (QQQ, SPY, GLD, SLV, USO, IWM) in Historical_data/ETF_closes/.
  // Verify dataset=XNYS.PILLAR and schema=ohlcv-1d. Ticker derived from symbols[0] (strip .EQ suffix).
  const ETF_CLOSE_ZIP_DIR = path.join(HIST_DATA, 'ETF_closes');
  const ETF_CLOSE_RAW_DIR = path.join(RAW_DIR, 'ETF_closes');
  if (!fs.existsSync(ETF_CLOSE_ZIP_DIR)) {
    log(`\n── ETF closes zip dir not found (${ETF_CLOSE_ZIP_DIR}) — skipping loop 4 ──`);
  } else {
    const etfZips = fs.readdirSync(ETF_CLOSE_ZIP_DIR)
      .filter(f => f.endsWith('.zip'))
      .map(f => ({ name: f, path: path.join(ETF_CLOSE_ZIP_DIR, f) }));
    log(`\n── Checking ${etfZips.length} zip(s) in ETF_closes/ → raw/ETF_closes/{ticker}/ ──`);
    for (const zipInfo of etfZips) {
      let meta = null;
      try {
        const metaBuf = await readZipEntry(zipInfo.path, 'metadata.json');
        if (metaBuf) meta = JSON.parse(metaBuf.toString('utf8'));
      } catch (_) {}
      const schema  = meta?.query?.schema;
      const dataset = meta?.query?.dataset;
      const symbols = meta?.query?.symbols;
      if (dataset !== 'XNYS.PILLAR') {
        warn(`  ${zipInfo.name}: dataset='${dataset}' — expected XNYS.PILLAR, skipping`);
        continue;
      }
      if (schema !== 'ohlcv-1d') {
        warn(`  ${zipInfo.name}: schema='${schema}' — expected 'ohlcv-1d', skipping`);
        continue;
      }
      if (!symbols || symbols.length === 0) {
        warn(`  ${zipInfo.name}: no symbols in metadata.json, skipping`);
        continue;
      }
      // Derive ticker: strip .EQ or other suffixes (e.g. "QQQ.EQ" → "QQQ", "QQQ" → "QQQ")
      const ticker = symbols[0].replace(/\.[A-Z]+$/, '');
      const destDir = path.join(ETF_CLOSE_RAW_DIR, ticker);
      ensureDir(destDir);
      log(`\n[EXTRACT] ${zipInfo.name} (${ticker} equity ohlcv-1d) → raw/ETF_closes/${ticker}/`);
      let zipExtracted = 0;
      let zipSkipped   = 0;
      await streamZip(zipInfo.path, async (entry) => {
        if (entry.type === 'Directory') return;
        const dest = path.join(destDir, entry.path);
        if (fs.existsSync(dest)) { zipSkipped++; return; }
        if (DRY_RUN) { log(`  [DRY] would extract: ${entry.path}`); return; }
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, await entry.buffer());
        zipExtracted++;
        extracted++;
      });
      skipped += zipSkipped;
      log(`  Ticker: ${ticker} — extracted ${zipExtracted} file(s), skipped ${zipSkipped} existing`);
    }
  }

  log(`\n[1b COMPLETE] ${elapsed(t0)} — ${extracted} files extracted, ${skipped} already existed`);
}

// ─── PHASE 1c: PROCESS FUTURES OHLCV ─────────────────────────────────────────

async function phase1c() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1c — PROCESS FUTURES OHLCV');
  log('══════════════════════════════════════════════════════');

  // Phase 1b now extracts each symbol into its own subdirectory:
  //   raw/GLBX/{SYMBOL}/glbx-mdp3-YYYYMMDD.ohlcv-1m.csv.zst
  // Phase 1c processes one symbol at a time from its own subdirectory.

  const glbxBaseDir    = path.join(RAW_DIR, 'GLBX');
  const targetSymbols  = SYMBOL_FILTER ? [SYMBOL_FILTER] : ALL_SYMBOLS;

  // Discover which symbols have a raw subdirectory with files
  const symQueue = [];
  for (const sym of targetSymbols) {
    const symDir = path.join(glbxBaseDir, sym);
    if (!fs.existsSync(symDir) || !fs.statSync(symDir).isDirectory()) {
      warn(`  ${sym}: no raw directory at raw/GLBX/${sym}/ — run phase 1b first`);
      continue;
    }
    const rawFiles = fs.readdirSync(symDir)
      .filter(f => f.includes('ohlcv-1m') && f.endsWith('.csv.zst'))
      .sort();
    if (rawFiles.length === 0) {
      warn(`  ${sym}: raw directory exists but no ohlcv-1m files — skipping`);
      continue;
    }
    symQueue.push({ sym, symDir, rawFiles });
    log(`  ${sym}: ${rawFiles.length} raw file(s) found`);
  }

  if (symQueue.length === 0) {
    warn('No symbol raw directories found — run phase 1b first');
    return;
  }

  let totalFilesWritten    = 0;
  let totalValidationErrors = 0;
  const symbolSummary      = {};

  // ── Process each symbol independently ────────────────────────────────────
  for (const { sym, symDir, rawFiles } of symQueue) {
    log(`\n══ [${sym}] ${rawFiles.length} raw file(s) ══`);
    const symStart = Date.now();

    // Pre-compute which dates already exist for this symbol
    const existingDates = new Set();
    if (!RECOMPUTE && !FORCE) {
      const dir1m = path.join(FUT_DIR, sym, '1m');
      if (fs.existsSync(dir1m)) {
        for (const f of fs.readdirSync(dir1m)) {
          if (f.endsWith('.json')) existingDates.add(f.replace('.json', ''));
        }
      }
    }
    if (existingDates.size > 0) {
      log(`  ${existingDates.size} dates already processed — will skip (use --force to override)`);
    }

    // date → contractKey → [bar, ...]
    const dateBars   = {};
    const dateVolume = {};
    let barsRead    = 0;
    let unrecognised = 0;

    // ── Read all raw files for this symbol ─────────────────────────────────
    for (let fi = 0; fi < rawFiles.length; fi++) {
      const fname = rawFiles[fi];
      const fpath = path.join(symDir, fname);

      // Progress log every 500 files
      if (fi > 0 && fi % 500 === 0) {
        const pct    = ((fi / rawFiles.length) * 100).toFixed(0);
        const etaStr = eta(fi, rawFiles.length, Date.now() - symStart);
        log(`  [${sym}] reading ${fi}/${rawFiles.length} (${pct}%) — ETA ${etaStr}`);
      }

      const compressed = fs.readFileSync(fpath);
      const buf        = await decompress(compressed);
      const text       = buf.toString('utf8');
      const lines      = text.split('\n');
      if (lines.length < 2) continue;

      const headers  = lines[0].split(',');
      const idxTs    = headers.indexOf('ts_event');
      const idxOpen  = headers.indexOf('open');
      const idxHigh  = headers.indexOf('high');
      const idxLow   = headers.indexOf('low');
      const idxClose = headers.indexOf('close');
      const idxVol   = headers.indexOf('volume');
      const idxSym   = headers.indexOf('symbol');

      // Fallback to positional if named cols not found (older schema)
      const tsCol    = idxTs    >= 0 ? idxTs    : 0;
      const openCol  = idxOpen  >= 0 ? idxOpen  : 4;
      const highCol  = idxHigh  >= 0 ? idxHigh  : 5;
      const lowCol   = idxLow   >= 0 ? idxLow   : 6;
      const closeCol = idxClose >= 0 ? idxClose : 7;
      const volCol   = idxVol   >= 0 ? idxVol   : 8;
      const symCol   = idxSym   >= 0 ? idxSym   : 9;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(',');
        if (parts.length <= symCol) continue;

        const rawSymbol = parts[symCol];
        // csvSymbolToInternal handles individual contracts (MNQM9) and spreads
        const internal = csvSymbolToInternal(rawSymbol);
        if (!internal) { unrecognised++; continue; }
        // Sanity check: file should only contain bars for this symbol
        if (internal !== sym) continue;

        const tsEvent     = parts[tsCol];
        const tradingDate = isoToTradingDate(tsEvent);
        if (!tradingDate) continue;

        // Skip if already processed (resumability)
        if (!RECOMPUTE && !FORCE && existingDates.has(tradingDate)) continue;
        // Skip dates before --from-date
        if (FROM_DATE && tradingDate < FROM_DATE) continue;

        const open   = parseFloat(parts[openCol]);
        const high   = parseFloat(parts[highCol]);
        const low    = parseFloat(parts[lowCol]);
        const close  = parseFloat(parts[closeCol]);
        const volume = parseInt(parts[volCol]) || 0;
        if (isNaN(open) || isNaN(close)) continue;

        // Track volume per contract for front-month selection
        const contractKey = rawSymbol;
        if (!dateVolume[tradingDate]) dateVolume[tradingDate] = {};
        dateVolume[tradingDate][contractKey] =
          (dateVolume[tradingDate][contractKey] || 0) + volume;

        if (!dateBars[tradingDate]) dateBars[tradingDate] = {};
        if (!dateBars[tradingDate][contractKey]) dateBars[tradingDate][contractKey] = [];
        dateBars[tradingDate][contractKey].push({
          ts: isoToUnixSec(tsEvent), open, high, low, close, volume,
        });
        barsRead++;
      }
    }

    log(`  Read ${barsRead.toLocaleString()} bars (${unrecognised} spread/unrecognised skipped) in ${elapsed(symStart)}`);

    // ── Write derived files ────────────────────────────────────────────────
    const symDates = Object.keys(dateBars).sort();
    if (symDates.length === 0) {
      warn(`  No new data for ${sym} — all dates already processed or no raw data`);
      continue;
    }
    log(`  Writing ${symDates.length} trading day(s)...`);

    let filesWritten    = 0;
    let totalBars1m     = 0;
    const written       = [];
    let errors          = 0;
    let validationErrors = 0;
    const writeStart    = Date.now();

    for (let di = 0; di < symDates.length; di++) {
      const date = symDates[di];

      // Progress every 200 dates
      if (di > 0 && di % 200 === 0) {
        const pct    = ((di / symDates.length) * 100).toFixed(0);
        const etaStr = eta(di, symDates.length, Date.now() - writeStart);
        log(`  [${sym}] writing ${di}/${symDates.length} (${pct}%) — ETA ${etaStr}`);
      }

      try {
        // Select front-month contract (highest cumulative volume for this date)
        const volMap     = dateVolume[date];
        const frontMonth = Object.keys(volMap).reduce((best, c) => volMap[c] > volMap[best] ? c : best);
        const bars       = (dateBars[date][frontMonth] || []).sort((a, b) => a.ts - b.ts);
        if (bars.length === 0) continue;

        // Lookahead validation: every bar's trading date must match the date key
        for (const bar of bars) {
          const barDate = isoToTradingDate(new Date(bar.ts * 1000).toISOString());
          if (barDate !== date) {
            errLog(`Lookahead: ${sym} bar ${new Date(bar.ts * 1000).toISOString()} assigned to ${date}`);
            validationErrors++;
          }
        }

        // Write 1m
        writeJSON(path.join(FUT_DIR, sym, '1m', `${date}.json`), bars);
        filesWritten++;
        totalBars1m += bars.length;
        written.push(date);

        // Derive 5m, 15m, 30m
        for (const [minutes, tfLabel] of [[5,'5m'],[15,'15m'],[30,'30m']]) {
          writeJSON(path.join(FUT_DIR, sym, tfLabel, `${date}.json`), aggregateBars(bars, minutes));
          filesWritten++;
        }
      } catch (e2) {
        errLog(`Phase 1c: ${sym} ${date}: ${e2.message}`);
        errors++;
      }
    }

    totalFilesWritten     += filesWritten;
    totalValidationErrors += validationErrors;

    // Update per-symbol manifest
    const allDates = [];
    const dir1m = path.join(FUT_DIR, sym, '1m');
    if (fs.existsSync(dir1m)) {
      for (const f of fs.readdirSync(dir1m)) {
        if (f.endsWith('.json')) allDates.push(f.replace('.json', ''));
      }
    }
    allDates.sort();
    const manifest = {
      symbol:      sym,
      firstDate:   allDates[0] || null,
      lastDate:    allDates[allDates.length - 1] || null,
      tradingDays: allDates.length,
      totalBars1m,
      processedAt: new Date().toISOString(),
    };
    writeJSON(path.join(FUT_DIR, sym, 'manifest.json'), manifest);

    if (validationErrors > 0) warn(`  ${validationErrors} lookahead errors — see errors.log`);
    log(`  ${sym}: wrote ${written.length} dates, ${totalBars1m.toLocaleString()} 1m bars, ${errors} errors — ${elapsed(symStart)}`);
    symbolSummary[sym] = manifest;
  }

  if (totalValidationErrors > 0) {
    warn(`${totalValidationErrors} total lookahead validation errors — see errors.log`);
  } else {
    log('\n[VALIDATION] No lookahead errors detected');
  }

  log(`\n[1c COMPLETE] ${elapsed(t0)} — ${totalFilesWritten} files written across ${symQueue.length} symbol(s)`);
  return symbolSummary;
}

// ─── PHASE 1d: PARSE ETF DAILY CLOSES FROM LOCAL FILES ───────────────────────

/**
 * Convert a Databento ts_event value to a YYYY-MM-DD string.
 * Handles both pretty_ts=true ISO strings and raw nanosecond integers.
 */
function tsEventToDate(tsVal) {
  if (!tsVal) return null;
  // pretty_ts=true: "2013-04-01T04:00:00.000000000Z"
  if (tsVal.includes('T')) return tsVal.substring(0, 10);
  // Raw nanoseconds integer string
  try {
    const ns = BigInt(tsVal);
    const ms = Number(ns / 1_000_000n);
    return new Date(ms).toISOString().substring(0, 10);
  } catch (_) { return null; }
}

/**
 * Extract a YYYY-MM-DD date from a Databento filename.
 * Pattern: dbeq-basic-20130401.ohlcv-1d.csv.zst → "2013-04-01"
 */
function dateFromFilename(fname) {
  const m = fname.match(/(\d{8})/);
  if (!m) return null;
  const d = m[1];
  return `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
}

// Expected ETF close price ranges for sanity checking (wide bounds covering 2018–2026+)
const ETF_EXPECTED_RANGES = {
  QQQ: [50,  700],
  SPY: [100, 750],
  GLD: [100, 500],
  SLV: [10,  100],
  USO: [5,   200],
  IWM: [70,  300],
};

async function phase1d() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1d — PARSE ETF DAILY CLOSES (XNYS.PILLAR ohlcv-1d)');
  log('══════════════════════════════════════════════════════');
  log('Reads extracted files from raw/ETF_closes/{ticker}/ written by Phase 1b loop 4.');
  log('Run phase 1b first if this directory is missing.');

  const ETF_CLOSE_RAW_DIR = path.join(RAW_DIR, 'ETF_closes');
  const allTickers = OPRA_UNDERLYINGS.map(o => o.etf); // QQQ, SPY, GLD, SLV, USO, IWM
  const closesPath = path.join(DATA, 'etf_closes.json');
  const allCloses  = {};

  if (DRY_RUN) {
    for (const etf of allTickers) {
      const etfDir = path.join(ETF_CLOSE_RAW_DIR, etf);
      const exists = fs.existsSync(etfDir);
      const count  = exists ? fs.readdirSync(etfDir).filter(f => f.endsWith('.csv.zst')).length : 0;
      log(`[DRY] ${etf}: would parse ${count} file(s) from ${etfDir}`);
    }
    log('[1d COMPLETE — dry run]');
    return;
  }

  for (const etf of allTickers) {
    const etfDir = path.join(ETF_CLOSE_RAW_DIR, etf);
    if (!fs.existsSync(etfDir)) {
      warn(`${etf}: raw/ETF_closes/${etf}/ not found — run phase 1b first (place XNYS.PILLAR ohlcv-1d zips in Historical_data/ETF_closes/)`);
      allCloses[etf] = {};
      continue;
    }

    const files = fs.readdirSync(etfDir)
      .filter(f => f.endsWith('.csv.zst'))
      .sort();

    if (files.length === 0) {
      warn(`${etf}: no .csv.zst files in raw/ETF_closes/${etf}/`);
      allCloses[etf] = {};
      continue;
    }

    log(`\n[${etf}] Parsing ${files.length} ohlcv-1d file(s)...`);
    const closes  = {};
    let processed = 0;
    let errors    = 0;

    // Close field format auto-detected per value:
    //   pretty_px=true  → decimal string "476.890000000" → parseFloat ~477
    //   pretty_px=false → fixed-point integer string    → parseFloat ~4.77e11 → divide by 1e9
    // ETF prices are always < 10000; any parsed value > 100000 is raw fixed-point.

    for (const fname of files) {
      try {
        const buf  = fs.readFileSync(path.join(etfDir, fname));
        const text = (await decompress(buf)).toString('utf8');
        const lines = text.split('\n').filter(l => l.trim());

        if (lines.length < 2) {
          errLog(`Phase 1d: ${etf}/${fname}: no data rows`);
          errors++;
          continue;
        }

        const headers  = lines[0].split(',');
        const closeIdx = headers.indexOf('close');
        const tsIdx    = headers.indexOf('ts_event');

        if (closeIdx < 0) {
          errLog(`Phase 1d: ${etf}/${fname}: no 'close' column (headers: ${headers.join(',')})`);
          errors++;
          continue;
        }

        for (let i = 1; i < lines.length; i++) {
          const parts    = lines[i].split(',');
          const rawClose = parts[closeIdx];
          if (!rawClose) continue;

          let close = parseFloat(rawClose);
          if (close > 100000) close = close / 1e9;

          const date = dateFromFilename(fname)
            || (tsIdx >= 0 ? tsEventToDate(parts[tsIdx]) : null);

          if (date && close > 0) {
            closes[date] = close;
          }
        }

        processed++;
        if (processed % 200 === 0) {
          log(`  ${etf}: processed ${processed}/${files.length} files...`);
        }
      } catch (e) {
        errLog(`Phase 1d: ${etf}/${fname}: ${e.message}`);
        errors++;
      }
    }

    allCloses[etf] = closes;
    const sortedDates = Object.keys(closes).sort();
    log(`  ${etf}: ${sortedDates.length} dates (${errors} errors)`);

    // Spot-check: 3 sample dates for visual sanity check
    const spots = [
      sortedDates[0],
      sortedDates[Math.floor(sortedDates.length / 2)],
      sortedDates[sortedDates.length - 1],
    ].filter(Boolean);
    const [minExp, maxExp] = ETF_EXPECTED_RANGES[etf] || [0, Infinity];
    for (const d of spots) {
      const price = closes[d];
      const flag  = (price < minExp || price > maxExp)
        ? ` ⚠ UNEXPECTED (expected $${minExp}–$${maxExp})`
        : '';
      log(`  ${etf} sample: ${d} → $${price.toFixed(2)}${flag}`);
    }

    // Warn if any sampled price is outside expected range
    const outOfRange = sortedDates.filter(d => closes[d] < minExp || closes[d] > maxExp);
    if (outOfRange.length > 0) {
      warn(`  ${etf}: ${outOfRange.length} date(s) outside expected $${minExp}–$${maxExp} range — check source data`);
    }
  }

  // Always overwrite — full rebuild from local files
  writeJSON(closesPath, allCloses);
  const totalDates = Object.values(allCloses).reduce((s, d) => s + Object.keys(d).length, 0);
  log(`\n  Written etf_closes.json — ${totalDates} total date entries across ${Object.keys(allCloses).length} ETFs`);
  log(`\n[1d COMPLETE] ${elapsed(t0)}`);
  return allCloses;
}

// ─── PHASE 1e: OPRA HELPERS ──────────────────────────────────────────────────

/**
 * stat_type integer code for open interest in OPRA.PILLAR statistics records.
 * Confirmed via diagnostic (2026-04-01 QQQ): stat_type=9 maps to OI in quantity field.
 */
const OI_STAT_TYPE = 9;

/**
 * Parse one OPRA definition file (.definition.csv.zst already decompressed to text).
 *
 * Diagnostic confirmed (2026-04-01 QQQ):
 *   - strike_price is already in dollars: "580.000000000" = $580. Plain parseFloat().
 *   - Only instrument_class C and P exist — no underlying (stock) instrument entries.
 *   - underlying field matches the ETF ticker (e.g. "QQQ").
 *
 * Returns:
 *   optionMap — Map<instrument_id → { strike, expiry, type }>
 *               Only C/P entries for the target ETF with valid strike/expiry.
 */
function parseDefinitionText(text, etf) {
  const lines     = text.split('\n');
  const optionMap = new Map();

  if (lines.length < 2) return optionMap;

  const headers   = lines[0].split(',').map(h => h.trim());
  const idxId     = headers.indexOf('instrument_id');
  const idxClass  = headers.indexOf('instrument_class');
  const idxExpiry = headers.indexOf('expiration');
  const idxUndly  = headers.indexOf('underlying');
  const idxStrike = headers.indexOf('strike_price');

  if (idxId < 0 || idxClass < 0) {
    warn(`  parseDefinitionText: missing instrument_id or instrument_class column`);
    return optionMap;
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    const id    = parts[idxId];
    const cls   = idxClass  >= 0 ? (parts[idxClass]  || '').trim() : '';
    const undly = idxUndly  >= 0 ? (parts[idxUndly]  || '').trim() : '';

    if (!id) continue;
    if (cls !== 'C' && cls !== 'P') continue;
    if (undly !== etf) continue;
    if (idxExpiry < 0 || idxStrike < 0) continue;

    const expiry = (parts[idxExpiry] || '').substring(0, 10);
    if (!expiry) continue;

    // Strike is already in dollar terms (e.g. "580.000000000" = $580). No scaling needed.
    const strike = parseFloat(parts[idxStrike]);
    if (isNaN(strike) || strike <= 0) continue;

    optionMap.set(id, { strike, expiry, type: cls });
  }

  return optionMap;
}

/**
 * Parse one OPRA statistics file (.statistics.csv.zst already decompressed to text).
 *
 * Returns:
 *   oiMap — Map<instrument_id → openInterest>
 *
 * Note: OPRA statistics files contain only per-contract option rows.
 * There is no underlying spot price — use etf_closes.json (Phase 1d) instead.
 */
function parseStatisticsText(text) {
  const lines = text.split('\n');
  const oiMap = new Map();

  if (lines.length < 2) return { oiMap };

  const headers = lines[0].split(',').map(h => h.trim());
  const idxId   = headers.indexOf('instrument_id');
  const idxStat = headers.indexOf('stat_type');
  const idxQty  = headers.indexOf('quantity');

  if (idxId < 0 || idxStat < 0) return { oiMap };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts    = line.split(',');
    const statType = parseInt(parts[idxStat]);

    if (isNaN(statType)) continue;
    if (statType !== OI_STAT_TYPE) continue;

    const id  = parts[idxId];
    const qty = parseInt(parts[idxQty]);
    // Filter sentinel value 2147483647 (INT32_MAX = "no data")
    if (!id || isNaN(qty) || qty <= 0 || qty === 2147483647) continue;
    // Keep highest value seen for this contract (some dates have duplicates)
    const prev = oiMap.get(id);
    if (prev === undefined || qty > prev) oiMap.set(id, qty);
  }

  return { oiMap };
}

/**
 * Join OI map onto option definition map, apply filters, return contract array.
 *
 * Filters applied (matching hpCompute.js expectations):
 *   - openInterest > 0
 *   - strike within ±25% of underlyingPrice (skipped if underlyingPrice null)
 *   - expiry within 45 days of the file date
 */
function buildContractList(optionMap, oiMap, underlyingPrice, date) {
  const dateObj     = new Date(date + 'T00:00:00Z');
  const maxDteDays  = 45;
  const contracts   = [];

  // Filter stage counters (used by diagnostic)
  let countTotal = 0, countOiPos = 0, countDte = 0, countStrike = 0;

  for (const [id, def] of optionMap) {
    const oi = oiMap.get(id);
    if (oi === undefined) continue;
    countTotal++;

    if (oi <= 0) continue;
    countOiPos++;

    const expDate = new Date(def.expiry + 'T00:00:00Z');
    const dte     = (expDate - dateObj) / 86400000;
    if (dte < 0 || dte > maxDteDays) continue;
    countDte++;

    if (underlyingPrice != null) {
      if (def.strike < underlyingPrice * 0.75 || def.strike > underlyingPrice * 1.25) continue;
    }
    countStrike++;

    contracts.push({
      strike:        def.strike,
      expiry:        def.expiry,
      type:          def.type,
      openInterest:  oi,
      delta:         null,
      gamma:         null,
      iv:            null,
    });
  }

  return { contracts, counts: { total: countTotal, oiPos: countOiPos, dte: countDte, strike: countStrike } };
}

// ─── PHASE 1e: DIAGNOSTIC (single date, verbose) ──────────────────────────────

async function phase1e_diagnostic() {
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1e DIAGNOSTIC — Inspecting QQQ (single date)');
  log('══════════════════════════════════════════════════════');
  log('This validates field names, join logic, and strike price scale.');
  log('Review output, then run without --diagnostic to process all dates.\n');

  const opraRawBase = path.join(RAW_DIR, 'OPRA');
  // Use --symbol to override which ETF to diagnose (default QQQ)
  const diagEtf = (SYMBOL_FILTER && OPRA_UNDERLYINGS.some(o => o.etf === SYMBOL_FILTER))
    ? SYMBOL_FILTER : 'QQQ';
  const dir = path.join(opraRawBase, diagEtf);

  if (!fs.existsSync(dir)) {
    warn(`raw/OPRA/${diagEtf} not found — run phase 1b first`);
    return;
  }

  // Find the most recent statistics file
  const statFiles = fs.readdirSync(dir)
    .filter(f => f.includes('.statistics.') && f.endsWith('.csv.zst'))
    .sort();

  if (statFiles.length === 0) {
    warn(`No statistics files for ${diagEtf} in ${dir}`);
    return;
  }

  const fname     = statFiles[statFiles.length - 1]; // most recent
  const dateMatch = fname.match(/(\d{8})/);
  if (!dateMatch) { warn(`Cannot parse date from ${fname}`); return; }
  const rawDate = dateMatch[1];
  const date    = `${rawDate.substring(0,4)}-${rawDate.substring(4,6)}-${rawDate.substring(6,8)}`;

  log(`[ETF] ${diagEtf}  [Date] ${date}  [File] ${fname}`);

  // ── 1. Definition file ────────────────────────────────────────────────────
  const defFname = fname.replace('.statistics.', '.definition.');
  const defPath  = path.join(dir, defFname);
  if (!fs.existsSync(defPath)) {
    warn(`Definition file not found: ${defFname}`);
    return;
  }

  log('\n── DEFINITION FILE ─────────────────────────────────────────');
  log(`File: ${defFname}`);

  const defBuf  = await decompress(fs.readFileSync(defPath));
  const defText = defBuf.toString('utf8');
  const defLines = defText.split('\n').filter(l => l.trim());

  log(`\nColumn headers (${defLines[0].split(',').length} cols):`);
  log(`  ${defLines[0]}`);
  log('\nFirst 3 data rows (raw, unprocessed):');
  for (let i = 1; i <= Math.min(3, defLines.length - 1); i++) {
    log(`  Row ${i}: ${defLines[i]}`);
  }

  // Parse the definition headers and show field → value for first data row
  if (defLines.length >= 2) {
    const hdr  = defLines[0].split(',').map(h => h.trim());
    const vals = defLines[1].split(',');
    log('\nField → value (row 1):');
    const KEY_FIELDS = ['instrument_id','instrument_class','underlying','raw_symbol','strike_price','expiration'];
    for (const f of KEY_FIELDS) {
      const idx = hdr.indexOf(f);
      const raw = idx >= 0 ? (vals[idx] || '(missing)') : '(column absent)';
      const extra = (f === 'strike_price' && idx >= 0 && vals[idx])
        ? `  → ÷1e9 = ${(parseFloat(vals[idx]) / 1e9).toFixed(4)}`
        : '';
      log(`  ${f.padEnd(20)}: ${raw.trim()}${extra}`);
    }

    // Count distinct instrument_class values
    const classCounts = {};
    for (let i = 1; i < defLines.length; i++) {
      const cls = defLines[i].split(',')[hdr.indexOf('instrument_class')]?.trim();
      if (cls) classCounts[cls] = (classCounts[cls] || 0) + 1;
    }
    log(`\nDistinct instrument_class values:`);
    for (const [cls, cnt] of Object.entries(classCounts).sort((a,b) => b[1]-a[1])) {
      log(`  ${cls.padEnd(6)} → ${cnt.toLocaleString()} rows`);
    }
  }

  // Parse def file into option map
  const optionMap = parseDefinitionText(defText, diagEtf);
  log(`\nParsed: ${optionMap.size} option contracts (C/P)`);
  log('Note: OPRA definition files contain only C/P rows — no underlying spot price.');
  log('Underlying price comes from etf_closes.json (populated by Phase 1d).');

  // ── 2. Statistics file ────────────────────────────────────────────────────
  log('\n── STATISTICS FILE ─────────────────────────────────────────');
  log(`File: ${fname}`);

  const statBuf  = await decompress(fs.readFileSync(path.join(dir, fname)));
  const statText = statBuf.toString('utf8');
  const statLines = statText.split('\n').filter(l => l.trim());

  log(`\nColumn headers (${statLines[0]?.split(',').length || 0} cols):`);
  log(`  ${statLines[0]}`);
  log('\nFirst 10 data rows (raw, unprocessed):');
  for (let i = 1; i <= Math.min(10, statLines.length - 1); i++) {
    log(`  Row ${i}: ${statLines[i]}`);
  }

  // Parse stats and gather stat_type breakdown
  const statHdr      = statLines[0].split(',').map(h => h.trim());
  const idxStatType  = statHdr.indexOf('stat_type');
  const idxQtyD      = statHdr.indexOf('quantity');
  const idxPriceD    = statHdr.indexOf('price');

  log('\nDistinct stat_type values (count | qty_range | price_range):');
  const stBreakdown = {};
  for (let i = 1; i < statLines.length; i++) {
    const parts = statLines[i].split(',');
    const st    = parseInt(parts[idxStatType]);
    if (isNaN(st)) continue;
    if (!stBreakdown[st]) stBreakdown[st] = { count: 0, qtyMin: Infinity, qtyMax: -Infinity, priceMin: Infinity, priceMax: -Infinity };
    stBreakdown[st].count++;
    if (idxQtyD >= 0 && parts[idxQtyD]) {
      const q = parseFloat(parts[idxQtyD]);
      if (!isNaN(q)) { stBreakdown[st].qtyMin = Math.min(stBreakdown[st].qtyMin, q); stBreakdown[st].qtyMax = Math.max(stBreakdown[st].qtyMax, q); }
    }
    if (idxPriceD >= 0 && parts[idxPriceD]) {
      const p = parseFloat(parts[idxPriceD]);
      if (!isNaN(p) && p > 0) { stBreakdown[st].priceMin = Math.min(stBreakdown[st].priceMin, p); stBreakdown[st].priceMax = Math.max(stBreakdown[st].priceMax, p); }
    }
  }
  for (const [st, info] of Object.entries(stBreakdown).sort((a,b) => Number(a[0])-Number(b[0]))) {
    const qRange = info.qtyMin === Infinity ? 'none'
      : `${info.qtyMin.toLocaleString()}–${info.qtyMax.toLocaleString()}`;
    const pRange = info.priceMin === Infinity ? 'none'
      : `${info.priceMin.toExponential(2)}–${info.priceMax.toExponential(2)}  (÷1e9: ${(info.priceMin/1e9).toFixed(2)}–${(info.priceMax/1e9).toFixed(2)})`;
    log(`  stat_type=${String(st).padEnd(4)}  n=${String(info.count).padEnd(8)}  qty: ${qRange.padEnd(24)}  price: ${pRange}`);
  }

  // ── 3. Parse and join ─────────────────────────────────────────────────────
  const { oiMap } = parseStatisticsText(statText);
  log(`\nOI map: ${oiMap.size} contracts with OI > 0`);

  // Load underlying price from etf_closes.json (written by Phase 1d)
  const etfClosesForDiag = readJSON(path.join(DATA, 'etf_closes.json')) || {};
  const underlyingPrice  = etfClosesForDiag[diagEtf]?.[date] ?? null;
  log(`Underlying price (etf_closes.json): ${underlyingPrice != null ? underlyingPrice : '(not found — run phase 1d first)'}`);

  // ── 4. Filter counts ──────────────────────────────────────────────────────
  const { contracts, counts } = buildContractList(optionMap, oiMap, underlyingPrice, date);
  log('\nFilter stages:');
  log(`  Total option contracts with OI entry  : ${counts.total.toLocaleString()}`);
  log(`  After OI > 0                          : ${counts.oiPos.toLocaleString()}`);
  log(`  After DTE ≤ 45                        : ${counts.dte.toLocaleString()}`);
  log(`  After strike ±25%                     : ${counts.strike.toLocaleString()}`);
  log(`\n  Output contracts                      : ${contracts.length}`);

  if (contracts.length > 0) {
    log('\nSample output contracts (first 3):');
    for (const c of contracts.slice(0, 3)) {
      log(`  ${JSON.stringify(c)}`);
    }
  }

  log('\n══════════════════════════════════════════════════════');
  log(' DIAGNOSTIC COMPLETE');
  log(' Review the output above, then run:');
  log('   node server/data/historicalPipeline.js --phase 1e');
  log(' (optionally with --symbol QQQ to process one ETF first)');
  log('══════════════════════════════════════════════════════\n');
}

// ─── PHASE 1e: PROCESS OPRA OPTIONS DATA ─────────────────────────────────────

async function phase1e() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1e — PROCESS OPRA OPTIONS DATA');
  log('══════════════════════════════════════════════════════');

  // --diagnostic: run verbose single-date inspection, then exit
  if (HAS('--diagnostic')) {
    await phase1e_diagnostic();
    return;
  }

  const opraRawBase = path.join(RAW_DIR, 'OPRA');
  if (!fs.existsSync(opraRawBase)) {
    warn('raw/OPRA not found — run phase 1b first');
    return;
  }

  const allEtfs = OPRA_UNDERLYINGS.map(o => o.etf);

  // --symbol flag: limit to one ETF (e.g. --symbol QQQ)
  const targetEtfs = (SYMBOL_FILTER && allEtfs.includes(SYMBOL_FILTER))
    ? [SYMBOL_FILTER]
    : allEtfs;

  // Load etf_closes.json written by Phase 1d — used for underlyingPrice lookup
  const etfCloses      = readJSON(path.join(DATA, 'etf_closes.json')) || {};
  for (const etf of allEtfs) {
    if (!etfCloses[etf]) etfCloses[etf] = {};
  }

  // Fallback: last known underlying price per ETF (for dates missing from etf_closes.json)
  const lastKnownPrice = Object.fromEntries(allEtfs.map(e => [e, null]));
  // Seed from existing etf_closes.json if present
  for (const etf of allEtfs) {
    const dates = Object.keys(etfCloses[etf]).sort();
    if (dates.length > 0) lastKnownPrice[etf] = etfCloses[etf][dates[dates.length - 1]];
  }

  let totalFilesProcessed = 0;

  for (const etf of targetEtfs) {
    const dir = path.join(opraRawBase, etf);
    if (!fs.existsSync(dir)) { warn(`raw/OPRA/${etf} not found — skipping`); continue; }

    const statFiles = fs.readdirSync(dir)
      .filter(f => f.includes('.statistics.') && f.endsWith('.csv.zst'))
      .sort(); // chronological order

    log(`\n  [${etf}] ${statFiles.length} statistics files`);
    let processed = 0, skipped = 0;

    for (const fname of statFiles) {
      const dateMatch = fname.match(/(\d{8})/);
      if (!dateMatch) continue;
      const rawDate = dateMatch[1];
      const date    = `${rawDate.substring(0,4)}-${rawDate.substring(4,6)}-${rawDate.substring(6,8)}`;

      if (FROM_DATE && date < FROM_DATE) continue;

      const outPath = path.join(OPT_DIR, etf, `${date}.json`);

      // Skip-if-exists (resumable). Still accumulate underlying price from existing file.
      if (!RECOMPUTE && !FORCE && fs.existsSync(outPath)) {
        const existing = readJSON(outPath);
        if (existing?.underlyingPrice) {
          etfCloses[etf][date]  = existing.underlyingPrice;
          lastKnownPrice[etf]   = existing.underlyingPrice;
        }
        skipped++;
        continue;
      }

      if (DRY_RUN) { log(`  [DRY] would process ${fname}`); processed++; continue; }

      // Find matching definition file for this date
      const defFname = fname.replace('.statistics.', '.definition.');
      const defPath  = path.join(dir, defFname);
      if (!fs.existsSync(defPath)) {
        errLog(`Phase 1e: no definition file for ${etf} ${date} (expected ${defFname})`);
        continue;
      }

      try {
        // Step 1 — Read definition file → option map
        const defBuf    = await decompress(fs.readFileSync(defPath));
        const optionMap = parseDefinitionText(defBuf.toString('utf8'), etf);

        if (optionMap.size === 0) {
          errLog(`Phase 1e: ${etf} ${date}: definition file produced 0 option contracts`);
          continue;
        }

        // Step 2 — Read statistics file → OI map
        const statBuf   = await decompress(fs.readFileSync(path.join(dir, fname)));
        const { oiMap } = parseStatisticsText(statBuf.toString('utf8'));

        // Resolve underlying price: etf_closes.json (Phase 1d) → last known → log error
        let underlyingPrice = etfCloses[etf]?.[date] ?? null;
        if (underlyingPrice == null) {
          underlyingPrice = lastKnownPrice[etf];
          if (underlyingPrice == null) {
            errLog(`Phase 1e: ${etf} ${date}: underlyingPrice unavailable (not in etf_closes.json, no fallback — run phase 1d first)`);
          }
        }

        // Update rolling last-known price
        if (underlyingPrice != null) {
          lastKnownPrice[etf] = underlyingPrice;
        }

        // Step 3 — Join and filter
        const { contracts } = buildContractList(optionMap, oiMap, underlyingPrice, date);

        // Progress log every 200 dates
        processed++;
        if (processed % 200 === 0) {
          const pct    = ((processed / statFiles.length) * 100).toFixed(0);
          const etaStr = eta(processed, statFiles.length, Date.now() - t0);
          log(`  [${etf}] ${processed}/${statFiles.length} (${pct}%) — ETA ${etaStr}`);
        } else {
          process.stdout.write(`\r  [${etf}] ${date} — defs:${optionMap.size} oi:${oiMap.size} out:${contracts.length} price:${underlyingPrice?.toFixed(2) ?? 'null'}    `);
        }

        // Step 4 — Write output
        ensureDir(path.dirname(outPath));
        writeJSON(outPath, {
          date,
          underlying:     etf,
          underlyingPrice: underlyingPrice ?? null,
          contracts,
        });

        totalFilesProcessed++;

      } catch (e2) {
        errLog(`Phase 1e: ${etf}/${fname}: ${e2.message}`);
      }
    }

    log(`\n  [${etf}] Done — ${processed} processed, ${skipped} skipped (already existed)`);
  }

  log(`\n[1e COMPLETE] ${elapsed(t0)} — ${totalFilesProcessed} files written`);
}

// ─── PHASE 1f: COMPUTE HP LEVELS ─────────────────────────────────────────────

async function phase1f() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1f — COMPUTE HP LEVELS (Black-Scholes)');
  log('══════════════════════════════════════════════════════');

  // Load unified ETF closes
  const allCloses = readJSON(path.join(DATA, 'etf_closes.json')) || {};

  for (const { etf, futuresProxy } of OPRA_UNDERLYINGS) {
    log(`\n[${etf} → ${futuresProxy}]`);

    // Phase 1e now writes to OPT_DIR/etf/{date}.json (no 'raw/' subdirectory)
    const rawDir  = path.join(OPT_DIR, etf);
    const compDir = path.join(OPT_DIR, etf, 'computed');
    ensureDir(compDir);

    if (!fs.existsSync(rawDir)) {
      warn(`No OPRA data for ${etf} — skipping`);
      continue;
    }

    // Load futures daily closes from 1m data
    const futDates = {};
    const fut1mDir = path.join(FUT_DIR, futuresProxy, '1m');
    if (fs.existsSync(fut1mDir)) {
      log(`  Loading futures closes for ${futuresProxy}...`);
      for (const f of fs.readdirSync(fut1mDir).filter(f => f.endsWith('.json'))) {
        const date = f.replace('.json', '');
        const bars  = readJSON(path.join(fut1mDir, f)) || [];
        const rthBars = bars.filter(b => new Date(b.ts * 1000).getUTCHours() < 20);
        if (rthBars.length > 0) futDates[date] = rthBars[rthBars.length - 1].close;
      }
      log(`  Loaded ${Object.keys(futDates).length} futures close prices`);
    } else {
      warn(`  No 1m data for ${futuresProxy} — scaling ratios will be null`);
    }

    // Build sorted ETF close array for rolling log returns
    // Primary source: etf_closes.json (written by Phase 1e as side effect)
    const etfCloseMap  = allCloses[etf] || {};
    const etfDates     = Object.keys(etfCloseMap).sort();
    const etfPrices    = etfDates.map(d => etfCloseMap[d]);

    // Only read YYYY-MM-DD.json files (exclude 'computed/' dir and manifest files)
    const rawFiles = fs.readdirSync(rawDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    let computed = 0, skipped = 0, errored = 0;
    let sumIV = 0;
    const batchStart = Date.now();

    for (let fi = 0; fi < rawFiles.length; fi++) {
      const date = rawFiles[fi].replace('.json', '');

      if (FROM_DATE && date < FROM_DATE) { skipped++; continue; }

      const outPath = path.join(compDir, `${date}.json`);

      // Skip if already computed (unless --recompute or --recompute-from)
      const shouldRecompute = RECOMPUTE || (RECOMPUTE_FROM && date >= RECOMPUTE_FROM);
      if (!shouldRecompute && fs.existsSync(outPath)) {
        const existing = readJSON(outPath);
        if (existing?.computedAt) { skipped++; continue; }
      }
      if (DRY_RUN) { log(`  [DRY] would compute ${etf} ${date}`); computed++; continue; }

      // Progress every 100 dates
      if (fi > 0 && fi % 100 === 0) {
        const pct = ((fi / rawFiles.length) * 100).toFixed(0);
        const etaStr = eta(fi, rawFiles.length, Date.now() - batchStart);
        log(`  [${etf}] ${fi}/${rawFiles.length} (${pct}%) — ETA ${etaStr}`);
      }

      try {
        const rawData = readJSON(path.join(rawDir, rawFiles[fi]));
        if (!rawData?.contracts?.length) { skipped++; continue; }

        // ETF close — prefer underlyingPrice from the Phase 1e output file,
        // fall back to etf_closes.json (same values, but already loaded),
        // then last-known from a prior date
        let etfClose = rawData.underlyingPrice || etfCloseMap[date];
        if (!etfClose) {
          const prevDates = etfDates.filter(d => d < date);
          if (prevDates.length > 0) etfClose = etfCloseMap[prevDates[prevDates.length - 1]];
        }
        if (!etfClose) {
          errLog(`Phase 1f: no ETF close for ${etf} ${date} — skipping`);
          errored++;
          continue;
        }

        const futuresClose = futDates[date] || null;

        // 20-day rolling log returns for IV estimation
        const idx = etfDates.indexOf(date);
        const dailyLogReturns = [];
        if (idx > 0) {
          const start = Math.max(0, idx - 20);
          for (let i = start + 1; i <= idx; i++) {
            const prev = etfPrices[i - 1];
            const cur  = etfPrices[i];
            if (prev && cur && prev > 0) dailyLogReturns.push(Math.log(cur / prev));
          }
        }

        // rawData.contracts uses 'openInterest' field (new Phase 1e schema).
        // hpCompute.js accepts both 'openInterest' and legacy 'oi' via (c.openInterest ?? c.oi).
        const snapshot = computeHP({
          date, underlying: etf, futuresProxy, etfClose, futuresClose,
          contracts: rawData.contracts, dailyLogReturns,
        });

        writeJSON(outPath, snapshot);
        sumIV += snapshot.atmIV || 0;
        computed++;
        process.stdout.write(
          `\r  ${etf} ${date} — IV: ${((snapshot.atmIV || 0) * 100).toFixed(1)}%  GEX: ${(snapshot.totalGex / 1e9).toFixed(2)}B  DEX: ${snapshot.dexBias}`
        );

      } catch (e2) {
        errLog(`Phase 1f: ${etf} ${date}: ${e2.message}`);
        errored++;
      }
    }
    log(`\n  ${etf}: computed=${computed} skipped=${skipped} errors=${errored}`);

    // Write manifest
    const allComp = fs.readdirSync(compDir).filter(f => f.endsWith('.json') && f !== 'manifest.json').sort();
    writeJSON(path.join(compDir, 'manifest.json'), {
      underlying:    etf,
      futuresProxy,
      firstDate:     allComp[0]?.replace('.json','') || null,
      lastDate:      allComp[allComp.length-1]?.replace('.json','') || null,
      datesComputed: allComp.length,
      avgAtmIV:      computed > 0 ? +(sumIV / computed).toFixed(4) : null,
      processedAt:   new Date().toISOString(),
    });
    log(`  Manifest: ${allComp.length} computed dates`);
  }

  log(`\n[1f COMPLETE] ${elapsed(t0)}`);
}

// ─── VERIFY ──────────────────────────────────────────────────────────────────

async function runVerify() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' VERIFY — Checking output coverage');
  log('══════════════════════════════════════════════════════');

  const manifest = readJSON(path.join(DATA, 'manifest.json'));
  const report   = { generatedAt: new Date().toISOString(), symbols: {}, opra: {} };

  const targetSymbols = SYMBOL_FILTER ? [SYMBOL_FILTER] : ALL_SYMBOLS;

  for (const sym of targetSymbols) {
    const dir1m = path.join(FUT_DIR, sym, '1m');
    if (!fs.existsSync(dir1m)) {
      report.symbols[sym] = { status: 'missing', dates: 0 };
      warn(`  ${sym}: NO DATA`);
      continue;
    }

    const dates = fs.readdirSync(dir1m).filter(f => f.endsWith('.json')).map(f => f.replace('.json','')).sort();
    const expectedRange = manifest?.cme?.[sym]?.dateRange;

    report.symbols[sym] = {
      status: dates.length > 0 ? 'ok' : 'empty',
      dates: dates.length,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
      expectedRange,
    };
    log(`  ${sym}: ${dates.length} dates  [${dates[0]} → ${dates[dates.length-1]}]${expectedRange ? '  expected: ' + expectedRange.start + ' → ' + expectedRange.end : ''}`);
  }

  // Check OPRA computed files
  for (const { etf } of OPRA_UNDERLYINGS) {
    const compDir = path.join(OPT_DIR, etf, 'computed');
    if (!fs.existsSync(compDir)) {
      report.opra[etf] = { status: 'missing', dates: 0 };
      continue;
    }
    const dates = fs.readdirSync(compDir).filter(f => f.endsWith('.json') && f !== 'manifest.json');
    report.opra[etf] = { status: dates.length > 0 ? 'ok' : 'empty', dates: dates.length };
    log(`  OPRA ${etf}: ${dates.length} HP computed dates`);
  }

  writeJSON(path.join(DATA, 'verification.json'), report);
  log(`\n[VERIFY COMPLETE] ${elapsed(t0)} — verification.json written`);
  return report;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const T0 = Date.now();
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   FuturesEdge AI — Historical Data Pipeline v2       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`DRY_RUN=${DRY_RUN}  RECOMPUTE=${RECOMPUTE}  FORCE=${FORCE}  CLEAN_RAW=${CLEAN_RAW}  SYMBOL_FILTER=${SYMBOL_FILTER || 'all'}`);
  console.log(`PHASE=${SINGLE_PHASE || 'all'}  FROM_DATE=${FROM_DATE || 'none'}  RECOMPUTE_FROM=${RECOMPUTE_FROM || 'none'}`);

  ensureDir(DATA);
  ensureDir(RAW_DIR);
  ensureDir(FUT_DIR);
  ensureDir(OPT_DIR);

  // --clean-raw: wipe flat raw/GLBX/ files and old derived data before proceeding
  if (CLEAN_RAW) cleanRaw();

  try {
    if (VERIFY_ONLY) {
      await runVerify();
      return;
    }

    if (SINGLE_PHASE === '1a' || INVENTORY_ONLY) {
      await phase1a();
    } else if (SINGLE_PHASE === '1b') {
      await phase1b();
    } else if (SINGLE_PHASE === '1c') {
      await phase1c();
    } else if (SINGLE_PHASE === '1d') {
      await phase1d();
    } else if (SINGLE_PHASE === '1e') {
      await phase1e();
    } else if (SINGLE_PHASE === '1f') {
      await phase1f();
    } else if (FUTURES_ONLY) {
      await phase1b();
      await phase1c();
    } else if (OPTIONS_ONLY) {
      await phase1d();
      await phase1e();
      await phase1f();
    } else {
      // Full pipeline
      await phase1a();
      await phase1b();
      await phase1c();
      await phase1d();
      await phase1e();
      await phase1f();
    }
  } catch (e) {
    err(`Pipeline failed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }

  const totalSec = ((Date.now() - T0) / 1000).toFixed(0);
  log('\n────────────────────────────────────────────────────────');
  log(` PIPELINE COMPLETE — ${totalSec}s total`);
  log('────────────────────────────────────────────────────────');
}

main();
