'use strict';
/**
 * historicalPipeline.js — FuturesEdge AI Historical Data Pipeline
 *
 * Phases:
 *   1a. Inventory zip files and write manifest.json
 *   1b. Extract raw files (GLBX → raw/GLBX/, OPRA → raw/OPRA/{underlying}/)
 *   1c. Process futures OHLCV → daily JSON files (all 16 symbols)
 *   1d. Fetch ETF daily closes — QQQ/SPY/GLD/USO/IWM/SLV (Yahoo Finance)
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

/** Sleep for ms milliseconds */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ─── PHASE 1b: EXTRACT RAW FILES ─────────────────────────────────────────────

async function phase1b() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1b — EXTRACT RAW FILES');
  log('══════════════════════════════════════════════════════');

  let extracted = 0;

  // Extract GLBX zips → raw/GLBX/
  const glbxZips = findGLBXZips();
  log(`\n── Extracting ${glbxZips.length} GLBX zip(s) → raw/GLBX/ ──`);
  for (const zipInfo of glbxZips) {
    const destDir = path.join(RAW_DIR, 'GLBX');
    ensureDir(destDir);
    log(`\n[EXTRACT] ${zipInfo.name}`);
    await streamZip(zipInfo.path, async (entry) => {
      if (entry.path.includes('ohlcv-1s')) { log(`  SKIP (1s data): ${entry.path}`); return; }
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

  log(`\n[1b COMPLETE] ${elapsed(t0)} — ${extracted} files extracted`);
}

// ─── PHASE 1c: PROCESS FUTURES OHLCV ─────────────────────────────────────────

async function phase1c() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1c — PROCESS FUTURES OHLCV');
  log('══════════════════════════════════════════════════════');

  const glbxDir = path.join(RAW_DIR, 'GLBX');
  const glbxFiles = fs.existsSync(glbxDir)
    ? fs.readdirSync(glbxDir).filter(f => f.includes('ohlcv-1m') && f.endsWith('.csv.zst'))
    : [];

  if (glbxFiles.length === 0) {
    warn('No GLBX 1m CSV.ZST files in raw/GLBX — run phase 1b first');
    return;
  }
  log(`Found ${glbxFiles.length} GLBX 1m file(s)`);

  const targetSymbols = SYMBOL_FILTER ? [SYMBOL_FILTER] : ALL_SYMBOLS;

  // Pre-compute which dates already exist for each symbol (for skip-if-exists + memory savings)
  const existingDates = {};
  for (const sym of targetSymbols) {
    existingDates[sym] = new Set();
    if (!RECOMPUTE) {
      const dir1m = path.join(FUT_DIR, sym, '1m');
      if (fs.existsSync(dir1m)) {
        for (const f of fs.readdirSync(dir1m)) {
          if (f.endsWith('.json')) existingDates[sym].add(f.replace('.json', ''));
        }
      }
    }
    const n = existingDates[sym].size;
    if (n > 0) log(`  ${sym}: ${n} dates already processed — will skip`);
  }

  // Accumulate bars per symbol per trading date
  // sym → date → contractKey → [bar, ...]
  const symbolDateBars   = {};
  const symbolDateVolume = {};
  for (const sym of targetSymbols) {
    symbolDateBars[sym]   = {};
    symbolDateVolume[sym] = {};
  }

  let totalBarsRead = 0;
  let unrecognised  = 0;

  for (const fname of glbxFiles) {
    const fpath = path.join(glbxDir, fname);
    log(`\n[READ] ${fname} (${(fs.statSync(fpath).size / 1e6).toFixed(1)} MB compressed)`);
    const t1 = Date.now();

    const compressed = fs.readFileSync(fpath);
    log('  Decompressing...');
    const buf  = await decompress(compressed);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    log(`  Parsing ${(lines.length - 1).toLocaleString()} rows...`);

    if (lines.length < 2) { warn('Empty file'); continue; }

    const headers  = lines[0].split(',');
    const idxTs    = headers.indexOf('ts_event');   // or 0 as fallback
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
      const internal  = csvSymbolToInternal(rawSymbol);
      if (!internal) { unrecognised++; continue; }
      if (!targetSymbols.includes(internal)) continue;

      const tsEvent = parts[tsCol];
      const tradingDate = isoToTradingDate(tsEvent);
      if (!tradingDate) continue;

      // Skip if already processed (saves memory, enables resumability)
      if (!RECOMPUTE && existingDates[internal].has(tradingDate)) continue;
      // Skip dates before --from-date
      if (FROM_DATE && tradingDate < FROM_DATE) continue;

      const open   = parseFloat(parts[openCol]);
      const high   = parseFloat(parts[highCol]);
      const low    = parseFloat(parts[lowCol]);
      const close  = parseFloat(parts[closeCol]);
      const volume = parseInt(parts[volCol]) || 0;

      if (isNaN(open) || isNaN(close)) continue;

      // Track volume per contract for front-month selection (no-op for continuous format)
      const contractKey = rawSymbol;
      if (!symbolDateVolume[internal][tradingDate]) symbolDateVolume[internal][tradingDate] = {};
      symbolDateVolume[internal][tradingDate][contractKey] =
        (symbolDateVolume[internal][tradingDate][contractKey] || 0) + volume;

      if (!symbolDateBars[internal][tradingDate]) symbolDateBars[internal][tradingDate] = {};
      if (!symbolDateBars[internal][tradingDate][contractKey]) symbolDateBars[internal][tradingDate][contractKey] = [];
      symbolDateBars[internal][tradingDate][contractKey].push({
        ts: isoToUnixSec(tsEvent), open, high, low, close, volume,
      });
      totalBarsRead++;
    }

    log(`  Done in ${elapsed(t1)}`);
  }

  log(`\nTotal bars read: ${totalBarsRead.toLocaleString()}  (${unrecognised} unrecognised symbols ignored)`);
  if (unrecognised > 100_000) {
    warn(`High unrecognised count — check DATABENTO_ROOT_TO_INTERNAL mapping in instruments.js`);
  }

  // Write daily files per symbol
  let filesWritten = 0;
  let validationErrors = 0;
  const symbolSummary = {};

  for (const sym of targetSymbols) {
    const symDates = Object.keys(symbolDateBars[sym]).sort();
    if (symDates.length === 0) {
      warn(`No NEW data for ${sym} (all dates may already be processed)`);
      continue;
    }
    log(`\n[WRITE] ${sym}: ${symDates.length} new trading days to write`);
    let totalBars1m = 0;
    const written = [];
    let errors = 0;
    const batchStart = Date.now();

    for (let di = 0; di < symDates.length; di++) {
      const date = symDates[di];

      // Progress every 100 dates
      if (di > 0 && di % 100 === 0) {
        const pct  = ((di / symDates.length) * 100).toFixed(0);
        const etaStr = eta(di, symDates.length, Date.now() - batchStart);
        log(`  [${sym}] ${di}/${symDates.length} (${pct}%) — ETA ${etaStr}`);
      }

      try {
        // Select front-month contract (highest cumulative volume)
        const volMap = symbolDateVolume[sym][date];
        const frontMonth = Object.keys(volMap).reduce((best, c) => volMap[c] > volMap[best] ? c : best);
        const bars = (symbolDateBars[sym][date][frontMonth] || []).sort((a, b) => a.ts - b.ts);
        if (bars.length === 0) continue;

        // Lookahead validation
        for (const bar of bars) {
          const barDate = isoToTradingDate(new Date(bar.ts * 1000).toISOString());
          if (barDate !== date) {
            errLog(`Lookahead: ${sym} bar ${new Date(bar.ts * 1000).toISOString()} assigned to ${date}`);
            validationErrors++;
          }
        }

        // Write 1m
        const dir1m  = path.join(FUT_DIR, sym, '1m');
        const file1m = path.join(dir1m, `${date}.json`);
        writeJSON(file1m, bars);
        filesWritten++;
        totalBars1m += bars.length;
        written.push(date);

        // Derive 5m, 15m, 30m
        for (const [minutes, tfLabel] of [[5,'5m'],[15,'15m'],[30,'30m']]) {
          const agg = aggregateBars(bars, minutes);
          writeJSON(path.join(FUT_DIR, sym, tfLabel, `${date}.json`), agg);
          filesWritten++;
        }
      } catch (e2) {
        errLog(`Phase 1c: ${sym} ${date}: ${e2.message}`);
        errors++;
      }
    }

    // Update manifest
    const existingManifest = readJSON(path.join(FUT_DIR, sym, 'manifest.json')) || {};
    const allDates = [];
    const dir1m = path.join(FUT_DIR, sym, '1m');
    if (fs.existsSync(dir1m)) {
      for (const f of fs.readdirSync(dir1m)) {
        if (f.endsWith('.json')) allDates.push(f.replace('.json', ''));
      }
    }
    allDates.sort();
    const updatedManifest = {
      symbol:      sym,
      firstDate:   allDates[0] || null,
      lastDate:    allDates[allDates.length - 1] || null,
      tradingDays: allDates.length,
      totalBars1m: (existingManifest.totalBars1m || 0) + totalBars1m,
      processedAt: new Date().toISOString(),
    };
    writeJSON(path.join(FUT_DIR, sym, 'manifest.json'), updatedManifest);
    log(`  ${sym}: wrote ${written.length} dates, ${totalBars1m.toLocaleString()} new 1m bars, ${errors} errors`);
    symbolSummary[sym] = updatedManifest;
  }

  if (validationErrors > 0) {
    warn(`${validationErrors} lookahead validation errors — see errors.log`);
  } else {
    log('\n[VALIDATION] No lookahead errors detected');
  }

  log(`\n[1c COMPLETE] ${elapsed(t0)} — ${filesWritten} files written`);
  return symbolSummary;
}

// ─── PHASE 1d: FETCH ETF DAILY CLOSES ────────────────────────────────────────

async function phase1d() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1d — FETCH ETF DAILY CLOSES (Yahoo Finance)');
  log('══════════════════════════════════════════════════════');

  const allTickers = ['QQQ', 'SPY', 'GLD', 'USO', 'IWM', 'SLV'];
  const closesPath = path.join(DATA, 'etf_closes.json');

  // Load existing incremental file
  const allCloses = readJSON(closesPath) || {};
  for (const t of allTickers) {
    if (!allCloses[t]) allCloses[t] = {};
  }

  for (const ticker of allTickers) {
    log(`\n[FETCH] ${ticker}`);
    if (DRY_RUN) { log(`  [DRY] would fetch ${ticker} from Yahoo Finance`); continue; }

    let fetched = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Use range=max to get full history; Yahoo Finance supports this for all these ETFs
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=max`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();

        const result = json?.chart?.result?.[0];
        if (!result) throw new Error('No chart result');

        const ts       = result.timestamp;
        const q        = result.indicators?.quote?.[0];
        const adjclose = result.indicators?.adjclose?.[0]?.adjclose;

        let added = 0;
        for (let i = 0; i < ts.length; i++) {
          const date  = new Date(ts[i] * 1000).toISOString().substring(0, 10);
          const close = adjclose?.[i] ?? q?.close?.[i];
          if (close && !isNaN(close) && close > 0) {
            allCloses[ticker][date] = +close.toFixed(4);
            added++;
          }
        }

        writeJSON(closesPath, allCloses);
        log(`  Saved ${added} daily closes (${Object.keys(allCloses[ticker]).length} total) → etf_closes.json`);
        fetched = true;
        break;

      } catch (e2) {
        warn(`  Attempt ${attempt}/3 failed: ${e2.message}`);
        if (attempt < 3) { await sleep(2000); }
        else {
          errLog(`Phase 1d: failed to fetch ${ticker} after 3 attempts: ${e2.message}`);
          warn(`  Using existing ${Object.keys(allCloses[ticker]).length} dates for ${ticker}`);
        }
      }
    }
    if (!fetched) {
      log(`  Keeping existing ${Object.keys(allCloses[ticker]).length} dates for ${ticker}`);
    }
  }

  log(`\n[1d COMPLETE] ${elapsed(t0)}`);
  return allCloses;
}

// ─── PHASE 1e: PROCESS OPRA OPTIONS DATA ─────────────────────────────────────

async function phase1e() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1e — PROCESS OPRA OPTIONS DATA');
  log('══════════════════════════════════════════════════════');

  const opraRawBase = path.join(RAW_DIR, 'OPRA');
  if (!fs.existsSync(opraRawBase)) {
    warn('raw/OPRA not found — run phase 1b first');
    return;
  }

  const targetEtfs = OPRA_UNDERLYINGS.map(o => o.etf);

  // ── STEP 1: Build global contract definitions (from all OPRA dirs) ────────
  log('\n[STEP 1] Building contract definitions...');
  const t1 = Date.now();
  const contractDefs = {};
  const defsOutPath  = path.join(OPT_DIR, 'contract_definitions.json');

  if (fs.existsSync(defsOutPath) && !RECOMPUTE) {
    log(`  SKIP (exists): contract_definitions.json — loading...`);
    Object.assign(contractDefs, readJSON(defsOutPath));
    log(`  Loaded ${Object.keys(contractDefs).length} contract definitions`);
  } else {
    let totalDefs = 0;
    for (const etf of targetEtfs) {
      const dir = path.join(opraRawBase, etf);
      if (!fs.existsSync(dir)) { warn(`raw/OPRA/${etf} not found — skipping`); continue; }
      const defFiles = fs.readdirSync(dir).filter(f => f.includes('.definition.') && f.endsWith('.csv.zst'));
      log(`  ${etf}: ${defFiles.length} definition file(s)`);

      for (const fname of defFiles.sort()) {
        try {
          const buf  = await decompress(fs.readFileSync(path.join(dir, fname)));
          const text = buf.toString('utf8');
          const lines = text.split('\n');
          if (lines.length < 2) continue;

          const headers   = lines[0].split(',').map(h => h.trim());
          const idxId     = headers.indexOf('instrument_id');
          const idxClass  = headers.indexOf('instrument_class');
          const idxExpiry = headers.indexOf('expiration');
          const idxUndly  = headers.indexOf('underlying');
          const idxStrike = headers.indexOf('strike_price');
          const idxSymbol = headers.indexOf('symbol');

          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(',');
            const id     = parts[idxId];
            const cls    = parts[idxClass];
            const expiry = (parts[idxExpiry] || '').substring(0, 10);
            const undly  = parts[idxUndly];
            const strike = parseFloat(parts[idxStrike]);
            const sym    = (parts[idxSymbol] || '').trim();

            if (!id || !cls || !expiry || !undly || isNaN(strike)) continue;
            if (!targetEtfs.includes(undly)) continue;

            contractDefs[id] = { strike, expiry, type: cls, underlying: undly, symbol: sym };
            totalDefs++;
          }
        } catch (e2) {
          errLog(`Phase 1e def: ${etf}/${fname}: ${e2.message}`);
        }
        process.stdout.write(`\r  Processed ${fname} — ${totalDefs} defs`);
      }
    }
    log(`\n  Total: ${Object.keys(contractDefs).length} definitions`);
    writeJSON(defsOutPath, contractDefs);
    log(`  Saved contract_definitions.json`);
  }
  log(`[Step 1 done] ${elapsed(t1)}`);

  // ── STEP 2: Parse statistics files per underlying ─────────────────────────
  log('\n[STEP 2] Parsing statistics files...');

  // Load ETF closes for ±25% filter
  const allCloses = readJSON(path.join(DATA, 'etf_closes.json')) || {};
  const lastKnownClose = Object.fromEntries(targetEtfs.map(e => [e, null]));

  let totalFilesProcessed = 0;

  for (const etf of targetEtfs) {
    const dir = path.join(opraRawBase, etf);
    if (!fs.existsSync(dir)) { warn(`raw/OPRA/${etf} not found — skipping`); continue; }

    const statFiles = fs.readdirSync(dir)
      .filter(f => f.includes('.statistics.') && f.endsWith('.csv.zst'))
      .sort();

    log(`\n  [${etf}] ${statFiles.length} statistics files`);
    let processed = 0;

    for (const fname of statFiles) {
      const dateMatch = fname.match(/(\d{8})/);
      if (!dateMatch) continue;
      const rawDate = dateMatch[1];
      const date = `${rawDate.substring(0,4)}-${rawDate.substring(4,6)}-${rawDate.substring(6,8)}`;

      if (FROM_DATE && date < FROM_DATE) continue;

      const outPath = path.join(OPT_DIR, etf, 'raw', `${date}.json`);
      if (!RECOMPUTE && fs.existsSync(outPath)) {
        const c = allCloses[etf]?.[date];
        if (c) lastKnownClose[etf] = c;
        continue;
      }
      if (DRY_RUN) { log(`  [DRY] would process ${fname}`); continue; }

      try {
        const buf  = await decompress(fs.readFileSync(path.join(dir, fname)));
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        if (lines.length < 2) continue;

        const headers   = lines[0].split(',').map(h => h.trim());
        const idxId     = headers.indexOf('instrument_id');
        const idxStat   = headers.indexOf('stat_type');
        const idxQty    = headers.indexOf('quantity');

        const c = allCloses[etf]?.[date];
        if (c) lastKnownClose[etf] = c;
        const S = lastKnownClose[etf];

        const oiMap = {};
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const parts = line.split(',');
          if (parseInt(parts[idxStat]) !== 9) continue; // OI only
          const id  = parts[idxId];
          const qty = parseInt(parts[idxQty]);
          if (!id || isNaN(qty) || qty <= 0 || qty === 2147483647) continue;
          if (!oiMap[id] || qty > oiMap[id]) oiMap[id] = qty;
        }

        const contracts = [];
        for (const [id, oi] of Object.entries(oiMap)) {
          const def = contractDefs[id];
          if (!def || def.underlying !== etf) continue;
          if (S) {
            if (def.strike < S * 0.75 || def.strike > S * 1.25) continue;
          }
          const dte = S ? (new Date(def.expiry + 'T00:00:00Z') - new Date(date + 'T00:00:00Z')) / 86400000 : 30;
          if (dte < 0 || dte > 45) continue;
          contracts.push({ symbol: def.symbol, strike: def.strike, expiry: def.expiry, type: def.type, oi });
        }

        if (contracts.length > 0) {
          const outDir = path.join(OPT_DIR, etf, 'raw');
          ensureDir(outDir);
          writeJSON(outPath, { date, underlying: etf, contracts });
        }

        processed++;
        totalFilesProcessed++;
        process.stdout.write(`\r    ${etf} ${date} — ${contracts.length} contracts`);

      } catch (e2) {
        errLog(`Phase 1e stats: ${etf}/${fname}: ${e2.message}`);
      }
    }
    log(`\n  [${etf}] Done — ${processed} files processed`);
  }

  log(`\n[1e COMPLETE] ${elapsed(t0)} — ${totalFilesProcessed} statistics files processed`);
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

    const rawDir  = path.join(OPT_DIR, etf, 'raw');
    const compDir = path.join(OPT_DIR, etf, 'computed');
    ensureDir(compDir);

    if (!fs.existsSync(rawDir)) {
      warn(`No raw OPRA data for ${etf} — skipping`);
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
    const etfCloseMap  = allCloses[etf] || {};
    const etfDates     = Object.keys(etfCloseMap).sort();
    const etfPrices    = etfDates.map(d => etfCloseMap[d]);

    const rawFiles = fs.readdirSync(rawDir).filter(f => f.endsWith('.json')).sort();
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

        // ETF close — try exact date, then last known
        let etfClose = etfCloseMap[date];
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
    const symManifest = readJSON(path.join(FUT_DIR, sym, 'manifest.json'));

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
  console.log(`DRY_RUN=${DRY_RUN}  RECOMPUTE=${RECOMPUTE}  SYMBOL_FILTER=${SYMBOL_FILTER || 'all'}`);
  console.log(`PHASE=${SINGLE_PHASE || 'all'}  FROM_DATE=${FROM_DATE || 'none'}  RECOMPUTE_FROM=${RECOMPUTE_FROM || 'none'}`);

  ensureDir(DATA);
  ensureDir(RAW_DIR);
  ensureDir(FUT_DIR);
  ensureDir(OPT_DIR);

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
