'use strict';
/**
 * historicalPipeline.js — FuturesEdge AI Historical Data Pipeline
 *
 * Phases:
 *   1a. Inventory zip files
 *   1b. Extract raw files
 *   1c. Process futures OHLCV → daily JSON files
 *   1d. Fetch ETF daily closes (Yahoo Finance)
 *   1e. Process OPRA options data
 *   1f. Compute HP levels (Black-Scholes)
 *
 * Usage:
 *   node server/data/historicalPipeline.js [flags]
 *   --inventory-only   run 1a only
 *   --futures-only     run 1c only
 *   --options-only     run 1d–1f only
 *   --recompute        force recomputation of HP levels
 *   --symbol MNQ       process only this symbol
 *   --dry-run          log actions without writing files
 */

require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');
const AdmZip = require('adm-zip');
const { decompress } = require('@mongodb-js/zstd');
const { computeHP, estimateATMIV } = require('./hpCompute');

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT    = path.resolve(__dirname, '../../');
const DATA    = path.join(ROOT, 'data', 'historical');
const RAW_DIR = path.join(DATA, 'raw');
const FUT_DIR = path.join(DATA, 'futures');
const OPT_DIR = path.join(DATA, 'options');
const BT_DIR  = path.join(ROOT, 'data', 'backtest');

const ZIP_DIR = ROOT; // zips are in project root

const FUTURES_SYMBOLS = ['MNQ', 'MES', 'MGC', 'MCL'];
const ETF_PROXY = { MNQ: 'QQQ', MES: 'SPY', MGC: 'GLD', MCL: 'USO' };
const FUTURES_PROXY_MAP = { QQQ: 'MNQ', SPY: 'MES' }; // for HP computation (only QQQ/SPY have OPRA)

// Parse CLI args
const args = process.argv.slice(2);
const HAS  = (flag) => args.includes(flag);
const ARG  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const DRY_RUN        = HAS('--dry-run')        || process.env.DRY_RUN === 'true';
const INVENTORY_ONLY = HAS('--inventory-only');
const FUTURES_ONLY   = HAS('--futures-only');
const OPTIONS_ONLY   = HAS('--options-only');
const RECOMPUTE      = HAS('--recompute');
const SYMBOL_FILTER  = ARG('--symbol')?.toUpperCase() || null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(msg); }
function warn(msg) { console.warn('[WARN]', msg); }
function err(msg)  { console.error('[ERR]', msg); }

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
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function elapsed(start) {
  return ((Date.now() - start) / 1000).toFixed(1) + 's';
}

/** Find all zip files in project root matching GLBX* or OPRA* */
function findZips() {
  const entries = fs.readdirSync(ZIP_DIR);
  return entries
    .filter(f => (f.startsWith('GLBX') || f.startsWith('OPRA')) && f.endsWith('.zip'))
    .map(f => ({ name: f, path: path.join(ZIP_DIR, f), size: fs.statSync(path.join(ZIP_DIR, f)).size }));
}

/** Extract a single entry from a zip as Buffer */
function zipEntryBuffer(zipPath, entryName) {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry(entryName);
  if (!entry) throw new Error(`Entry not found: ${entryName} in ${path.basename(zipPath)}`);
  return entry.getData();
}

/** Decompress a .zst Buffer to string */
async function decompressZst(buf) {
  const out = await decompress(buf);
  return out.toString('utf8');
}

/**
 * Parse CSV text into array of objects using first line as header.
 * Returns { headers, rows }
 */
function parseCSV(text) {
  const lines = text.split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = parts[j] ?? '';
    }
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Convert ISO timestamp to US/Eastern date string 'YYYY-MM-DD'
 * applying CME convention: bars at or after 18:00 ET belong to the next calendar day.
 */
function isoToTradingDate(isoStr) {
  const ms = Date.parse(isoStr);
  if (isNaN(ms)) return null;

  // Determine ET offset: EST = UTC-5, EDT = UTC-4
  // DST 2026: starts March 8 02:00 ET, ends Nov 1 02:00 ET
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  // DST start: second Sunday of March
  const dstStart = nthSundayOfMonth(year, 2, 2); // March = month 2 (0-indexed)
  // DST end: first Sunday of November
  const dstEnd = nthSundayOfMonth(year, 10, 1);   // November = month 10
  const isDST = ms >= dstStart && ms < dstEnd;
  const offsetHours = isDST ? 4 : 5;

  const etMs = ms - offsetHours * 3600000;
  const etDate = new Date(etMs);
  const etHour = etDate.getUTCHours();

  // CME convention: >= 18:00 ET → next calendar day
  if (etHour >= 18) {
    const nextDay = new Date(etMs + 86400000);
    return nextDay.toISOString().substring(0, 10);
  }
  return etDate.toISOString().substring(0, 10);
}

/** Returns Unix ms of the nth occurrence of dayOfWeek (0=Sun) in given month */
function nthSundayOfMonth(year, month, n) {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    if (d.getUTCDay() === 0) { // Sunday
      count++;
      if (count === n) return d.getTime() + 2 * 3600000; // 02:00 UTC = ~midnight ET when DST starts
    }
  }
  return Infinity;
}

/** ts ISO string → Unix seconds */
function isoToUnixSec(isoStr) {
  return Math.floor(Date.parse(isoStr) / 1000);
}

// ─── PHASE 1a: INVENTORY ─────────────────────────────────────────────────────

async function phase1a() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1a — ZIP INVENTORY');
  log('══════════════════════════════════════════════════════');

  const zips = findZips();
  log(`Found ${zips.length} zip files`);

  const inventory = { generatedAt: new Date().toISOString(), zips: [] };

  for (const zipInfo of zips) {
    log(`\n[ZIP] ${zipInfo.name} (${(zipInfo.size / 1e6).toFixed(1)} MB)`);
    const zip = new AdmZip(zipInfo.path);
    const entries = zip.getEntries();

    const zipRecord = {
      filename: zipInfo.name,
      sizeMB: +(zipInfo.size / 1e6).toFixed(1),
      entries: [],
      dataType: null,
      schema: null,
      dateRange: null,
      symbols: [],
      totalRecords: null,
    };

    // Read metadata.json
    const metaEntry = entries.find(e => e.entryName === 'metadata.json');
    if (metaEntry) {
      const meta = JSON.parse(metaEntry.getData().toString('utf8'));
      zipRecord.dataType = meta.query?.dataset;
      zipRecord.schema   = meta.query?.schema;
      zipRecord.symbols  = meta.query?.symbols || [];
      const startNs = meta.query?.start;
      const endNs   = meta.query?.end;
      if (startNs && endNs) {
        zipRecord.dateRange = {
          start: new Date(Number(BigInt(startNs) / 1_000_000n)).toISOString().substring(0, 10),
          end:   new Date(Number(BigInt(endNs)   / 1_000_000n)).toISOString().substring(0, 10),
        };
      }
    }

    for (const e of entries) {
      const entryRec = { name: e.entryName, sizeCompressed: e.header.compressedSize, sizeUncompressed: e.header.size };
      zipRecord.entries.push(entryRec);
      log(`  ${e.entryName}  (${(e.header.compressedSize / 1e6).toFixed(2)} MB compressed)`);
    }

    // For CSV.ZST entries: decompress first one to inspect headers + date range
    const csvEntries = entries.filter(e => e.entryName.endsWith('.csv.zst'));
    if (csvEntries.length > 0) {
      log(`  Sampling CSV structure from: ${csvEntries[0].entryName}`);
      try {
        const buf = csvEntries[0].getData();
        const decompressed = await decompress(buf);
        const text = decompressed.toString('utf8');
        const lines = text.split('\n').filter(l => l.trim());

        if (lines.length > 0) {
          zipRecord.csvColumns = lines[0].split(',');
          log(`  Columns (${zipRecord.csvColumns.length}): ${zipRecord.csvColumns.join(', ')}`);
        }

        if (lines.length > 1) {
          const firstRow = lines[1].split(',');
          const lastRow  = lines[lines.length - 1].split(',');
          const tsCol = 0; // ts_event is always first
          zipRecord.sampleFirstRow  = lines[1];
          zipRecord.sampleLastRow   = lines[lines.length - 1];
          zipRecord.sampleFirstDate = (firstRow[tsCol] || '').substring(0, 10);
          zipRecord.sampleLastDate  = (lastRow[tsCol]  || '').substring(0, 10);
          log(`  First row date: ${zipRecord.sampleFirstDate}`);
          log(`  Last  row date: ${zipRecord.sampleLastDate}`);
          log(`  Record count (this file): ${lines.length - 1}`);

          // If single CSV: this is the total
          if (csvEntries.length === 1) {
            zipRecord.totalRecords = lines.length - 1;
          }
        }

        // If multiple CSV files (OPRA daily split): sample first + last
        if (csvEntries.length > 1) {
          log(`  ${csvEntries.length} daily CSVs — sampling last file for end date`);
          const lastEntry = csvEntries[csvEntries.length - 1];
          const lastBuf = lastEntry.getData();
          const lastDecomp = await decompress(lastBuf);
          const lastText = lastDecomp.toString('utf8');
          const lastLines = lastText.split('\n').filter(l => l.trim());
          if (lastLines.length > 1) {
            const lr = lastLines[lastLines.length - 1].split(',');
            zipRecord.sampleLastDate = (lr[0] || '').substring(0, 10);
          }
          zipRecord.totalRecords = `~${csvEntries.length} files`;
        }
      } catch (e2) {
        warn(`Could not inspect CSV: ${e2.message}`);
      }
    }

    inventory.zips.push(zipRecord);
  }

  const outPath = path.join(DATA, 'import_inventory.json');
  log(`\n[SAVE] import_inventory.json`);
  writeJSON(outPath, inventory);

  log(`\n[1a COMPLETE] ${elapsed(t0)}`);
  return inventory;
}

// ─── PHASE 1b: EXTRACT RAW FILES ─────────────────────────────────────────────

async function phase1b() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1b — EXTRACT RAW FILES');
  log('══════════════════════════════════════════════════════');

  const zips = findZips();
  let extracted = 0;

  for (const zipInfo of zips) {
    const isGLBX = zipInfo.name.startsWith('GLBX');
    const isOPRA = zipInfo.name.startsWith('OPRA');
    const destDir = isGLBX ? path.join(RAW_DIR, 'GLBX') : path.join(RAW_DIR, 'OPRA');
    ensureDir(destDir);

    log(`\n[EXTRACT] ${zipInfo.name} → raw/${isGLBX ? 'GLBX' : 'OPRA'}/`);
    const zip = new AdmZip(zipInfo.path);
    const entries = zip.getEntries();

    for (const entry of entries) {
      // Skip 1-second OHLCV data — too large, not needed for backtest
      if (entry.entryName.includes('ohlcv-1s')) {
        log(`  SKIP (1s data not needed): ${entry.entryName}`);
        continue;
      }
      const dest = path.join(destDir, entry.entryName);
      if (fs.existsSync(dest)) {
        log(`  SKIP (exists): ${entry.entryName}`);
        continue;
      }
      if (DRY_RUN) {
        log(`  [DRY] would extract: ${entry.entryName}`);
        continue;
      }
      log(`  Extracting: ${entry.entryName} (${(entry.header.compressedSize / 1e6).toFixed(2)} MB)`);
      fs.writeFileSync(dest, entry.getData());
      extracted++;
    }
  }

  log(`\n[1b COMPLETE] ${elapsed(t0)} — ${extracted} files extracted`);
}

// ─── PHASE 1c: PROCESS FUTURES OHLCV ─────────────────────────────────────────

async function phase1c() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1c — PROCESS FUTURES OHLCV');
  log('══════════════════════════════════════════════════════');

  // Find GLBX 1m CSV.ZST files (skip 1s — too large, not needed for backtest)
  const glbxDir = path.join(RAW_DIR, 'GLBX');
  const glbxFiles = fs.existsSync(glbxDir)
    ? fs.readdirSync(glbxDir).filter(f => f.includes('ohlcv-1m') && f.endsWith('.csv.zst'))
    : [];

  if (glbxFiles.length === 0) {
    warn('No GLBX 1m CSV files found in raw/GLBX — run phase 1b first or check zip extraction');
    return;
  }

  log(`Found ${glbxFiles.length} GLBX 1m file(s)`);

  // Symbols to process
  const targetSymbols = SYMBOL_FILTER ? [SYMBOL_FILTER] : FUTURES_SYMBOLS;

  // Accumulate bars per symbol per trading date
  // sym → date → [bar, ...]
  const symbolDateBars = {};
  for (const sym of targetSymbols) symbolDateBars[sym] = {};

  // Volume tracker: sym → date → contract → totalVolume (for front-month selection)
  const symbolDateVolume = {};
  for (const sym of targetSymbols) symbolDateVolume[sym] = {};

  let totalBarsRead = 0;

  for (const fname of glbxFiles) {
    const fpath = path.join(glbxDir, fname);
    log(`\n[READ] ${fname} (${(fs.statSync(fpath).size / 1e6).toFixed(1)} MB compressed)`);
    const t1 = Date.now();

    const compressed = fs.readFileSync(fpath);
    log(`  Decompressing...`);
    const buf = await decompress(compressed);
    log(`  Decompressed: ${(buf.length / 1e6).toFixed(1)} MB`);

    const text = buf.toString('utf8');
    const lines = text.split('\n');
    log(`  Parsing ${(lines.length - 1).toLocaleString()} rows...`);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(',');
      // ts_event, rtype, publisher_id, instrument_id, open, high, low, close, volume, symbol
      if (parts.length < 10) continue;

      const rawSymbol = parts[9];
      // Skip spreads (contain '-')
      if (rawSymbol.includes('-')) continue;

      // Extract root symbol (strip contract month code: e.g. MNQM6 → MNQ, MCLK6 → MCL)
      // Pattern: 3-4 uppercase letters + month letter + year digit(s)
      const rootMatch = rawSymbol.match(/^([A-Z]{2,4})[FGHJKMNQUVXZ]\d+$/);
      if (!rootMatch) continue;
      const root = rootMatch[1];

      if (!targetSymbols.includes(root)) continue;

      const tsEvent  = parts[0];
      const open     = parseFloat(parts[4]);
      const high     = parseFloat(parts[5]);
      const low      = parseFloat(parts[6]);
      const close    = parseFloat(parts[7]);
      const volume   = parseInt(parts[8]) || 0;

      if (isNaN(open) || isNaN(close)) continue;

      const tradingDate = isoToTradingDate(tsEvent);
      if (!tradingDate) continue;

      // Track volume per contract for front-month selection
      if (!symbolDateVolume[root][tradingDate]) symbolDateVolume[root][tradingDate] = {};
      symbolDateVolume[root][tradingDate][rawSymbol] =
        (symbolDateVolume[root][tradingDate][rawSymbol] || 0) + volume;

      // Store bar with contract info
      if (!symbolDateBars[root][tradingDate]) symbolDateBars[root][tradingDate] = {};
      if (!symbolDateBars[root][tradingDate][rawSymbol]) symbolDateBars[root][tradingDate][rawSymbol] = [];
      symbolDateBars[root][tradingDate][rawSymbol].push({
        ts: isoToUnixSec(tsEvent),
        open, high, low, close, volume
      });
      totalBarsRead++;
    }
    log(`  Done in ${elapsed(t1)}`);
  }

  log(`\nTotal bars read: ${totalBarsRead.toLocaleString()}`);

  // Write daily files per symbol, using front-month selection
  let filesWritten = 0;
  let validationErrors = 0;

  for (const sym of targetSymbols) {
    const symDates = Object.keys(symbolDateBars[sym]).sort();
    if (symDates.length === 0) {
      warn(`No data for ${sym}`);
      continue;
    }

    log(`\n[WRITE] ${sym}: ${symDates.length} trading days`);
    let totalBars1m = 0;
    const manifestDates = [];

    for (const date of symDates) {
      // Select front-month contract: highest cumulative volume
      const volMap = symbolDateVolume[sym][date];
      const frontMonth = Object.keys(volMap).reduce((best, c) => volMap[c] > volMap[best] ? c : best);
      const bars = (symbolDateBars[sym][date][frontMonth] || []).sort((a, b) => a.ts - b.ts);

      if (bars.length === 0) continue;

      // VALIDATION: confirm all bars belong to this trading date
      let hasError = false;
      for (const bar of bars) {
        const barDate = isoToTradingDate(new Date(bar.ts * 1000).toISOString());
        if (barDate !== date) {
          warn(`Lookahead check: bar ${new Date(bar.ts * 1000).toISOString()} assigned to ${date} but re-computes to ${barDate}`);
          hasError = true;
          validationErrors++;
        }
      }

      // Write 1m file
      const dir1m = path.join(FUT_DIR, sym, '1m');
      ensureDir(dir1m);
      const file1m = path.join(dir1m, `${date}.json`);
      writeJSON(file1m, bars);
      filesWritten++;
      totalBars1m += bars.length;
      manifestDates.push(date);

      // Derive 5m bars
      const bars5m = aggregateBars(bars, 5);
      const dir5m = path.join(FUT_DIR, sym, '5m');
      ensureDir(dir5m);
      writeJSON(path.join(dir5m, `${date}.json`), bars5m);
      filesWritten++;

      // Derive 15m bars
      const bars15m = aggregateBars(bars, 15);
      const dir15m = path.join(FUT_DIR, sym, '15m');
      ensureDir(dir15m);
      writeJSON(path.join(dir15m, `${date}.json`), bars15m);
      filesWritten++;
    }

    // Write manifest
    const manifest = {
      symbol: sym,
      firstDate: manifestDates[0] || null,
      lastDate: manifestDates[manifestDates.length - 1] || null,
      tradingDays: manifestDates.length,
      totalBars1m,
      processedAt: new Date().toISOString(),
    };
    writeJSON(path.join(FUT_DIR, sym, 'manifest.json'), manifest);
    log(`  ${sym}: ${manifestDates.length} days, ${totalBars1m.toLocaleString()} 1m bars`);
  }

  if (validationErrors > 0) {
    warn(`${validationErrors} lookahead validation errors — check bar date assignments`);
  } else {
    log('\n[VALIDATION] No lookahead errors detected');
  }

  log(`\n[1c COMPLETE] ${elapsed(t0)} — ${filesWritten} files written`);
}

/** Aggregate 1m bars into N-minute bars */
function aggregateBars(bars1m, minutes) {
  if (bars1m.length === 0) return [];
  const result = [];
  for (let i = 0; i < bars1m.length; i += minutes) {
    const slice = bars1m.slice(i, i + minutes);
    if (slice.length === 0) continue;
    result.push({
      ts: slice[0].ts,
      open:   slice[0].open,
      high:   Math.max(...slice.map(b => b.high)),
      low:    Math.min(...slice.map(b => b.low)),
      close:  slice[slice.length - 1].close,
      volume: slice.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

// ─── PHASE 1d: FETCH ETF DAILY CLOSES ────────────────────────────────────────

async function phase1d() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1d — FETCH ETF DAILY CLOSES (Yahoo Finance)');
  log('══════════════════════════════════════════════════════');

  const tickers = ['QQQ', 'SPY'];
  for (const ticker of tickers) {
    log(`\n[FETCH] ${ticker}`);
    const outDir = path.join(OPT_DIR, ticker);
    ensureDir(outDir);
    const outFile = path.join(outDir, `${ticker}_daily.json`);

    if (fs.existsSync(outFile) && !RECOMPUTE) {
      log(`  SKIP (exists): ${outFile}`);
      continue;
    }
    if (DRY_RUN) {
      log(`  [DRY] would fetch ${ticker} daily from Yahoo Finance`);
      continue;
    }

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();

      const result = json?.chart?.result?.[0];
      if (!result) throw new Error('No chart result');

      const ts    = result.timestamp;
      const q     = result.indicators?.quote?.[0];
      const adjclose = result.indicators?.adjclose?.[0]?.adjclose;

      const daily = {};
      for (let i = 0; i < ts.length; i++) {
        const date = new Date(ts[i] * 1000).toISOString().substring(0, 10);
        daily[date] = {
          open:   q.open[i],
          high:   q.high[i],
          low:    q.low[i],
          close:  q.close[i],
          adjClose: adjclose?.[i] ?? q.close[i],
          volume: q.volume[i],
        };
      }

      writeJSON(outFile, daily);
      log(`  Saved ${Object.keys(daily).length} days → ${outFile}`);
    } catch (e2) {
      warn(`Failed to fetch ${ticker}: ${e2.message} — HP computation will use fallback close`);
    }
  }

  log(`\n[1d COMPLETE] ${elapsed(t0)}`);
}

// ─── PHASE 1e: PROCESS OPRA OPTIONS DATA ─────────────────────────────────────

async function phase1e() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1e — PROCESS OPRA OPTIONS DATA');
  log('══════════════════════════════════════════════════════');

  const opraDir = path.join(RAW_DIR, 'OPRA');
  if (!fs.existsSync(opraDir)) {
    warn('raw/OPRA not found — run phase 1b first');
    return;
  }

  const opraFiles = fs.readdirSync(opraDir).filter(f => f.endsWith('.csv.zst'));
  const defFiles  = opraFiles.filter(f => f.includes('.definition.'));
  const statFiles = opraFiles.filter(f => f.includes('.statistics.'));

  log(`Definition files: ${defFiles.length}  Statistics files: ${statFiles.length}`);

  // STEP 1: Build contract definitions (instrument_id → { strike, expiry, type, underlying })
  // We build a per-date map then merge (definitions are emitted daily)
  log('\n[STEP 1] Building contract definitions...');
  const t1 = Date.now();

  // Use a merged map across all definition files
  const contractDefs = {}; // instrument_id → { strike, expiry, type, underlying, symbol }
  const defsOutPath = path.join(OPT_DIR, 'contract_definitions.json');

  if (fs.existsSync(defsOutPath) && !RECOMPUTE) {
    log(`  SKIP (exists): contract_definitions.json — loading...`);
    const existing = readJSON(defsOutPath);
    Object.assign(contractDefs, existing);
    log(`  Loaded ${Object.keys(contractDefs).length} contract definitions`);
  } else {
    // Process all definition files and merge
    // Column map (from inspection): instrument_id=4, instrument_class=7, expiration=10, underlying=46, strike_price=48
    for (const fname of defFiles.sort()) {
      const fpath = path.join(opraDir, fname);
      const buf = await decompress(fs.readFileSync(fpath));
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      if (lines.length < 2) continue;

      const headers = lines[0].split(',').map(h => h.trim());
      const idxId       = headers.indexOf('instrument_id');
      const idxClass    = headers.indexOf('instrument_class');
      const idxExpiry   = headers.indexOf('expiration');
      const idxUnderly  = headers.indexOf('underlying');
      const idxStrike   = headers.indexOf('strike_price');
      const idxSymbol   = headers.indexOf('symbol');

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(',');
        const id       = parts[idxId];
        const cls      = parts[idxClass];
        const expiry   = (parts[idxExpiry] || '').substring(0, 10); // YYYY-MM-DD
        const underly  = parts[idxUnderly];
        const strike   = parseFloat(parts[idxStrike]);
        const symbol   = parts[idxSymbol] || parts[1] || '';

        if (!id || !cls || !expiry || !underly || isNaN(strike)) continue;
        if (underly !== 'QQQ' && underly !== 'SPY') continue;

        contractDefs[id] = { strike, expiry, type: cls, underlying: underly, symbol: symbol.trim() };
      }
      process.stdout.write(`\r  Processed ${fname} — ${Object.keys(contractDefs).length} defs`);
    }
    log(`\n  Total: ${Object.keys(contractDefs).length} definitions`);
    writeJSON(defsOutPath, contractDefs);
    log(`  Saved contract_definitions.json`);
  }
  log(`[Step 1 done] ${elapsed(t1)}`);

  // STEP 2: Parse statistics files (OI per contract per day)
  log('\n[STEP 2] Parsing statistics files...');

  // Load ETF daily closes for ±25% filter
  const etfCloses = {};
  for (const etf of ['QQQ', 'SPY']) {
    const f = path.join(OPT_DIR, etf, `${etf}_daily.json`);
    etfCloses[etf] = fs.existsSync(f) ? readJSON(f) : {};
  }

  // Track last known close for fallback
  const lastKnownClose = { QQQ: null, SPY: null };

  let filesProcessed = 0;
  for (const fname of statFiles.sort()) {
    // Extract date from filename: opra-pillar-20260102.statistics.csv.zst → 2026-01-02
    const dateMatch = fname.match(/(\d{8})/);
    if (!dateMatch) continue;
    const rawDate = dateMatch[1];
    const date = `${rawDate.substring(0, 4)}-${rawDate.substring(4, 6)}-${rawDate.substring(6, 8)}`;

    // Check if output already exists for both underlyings
    const qqqOut = path.join(OPT_DIR, 'QQQ', 'raw', `${date}.json`);
    const spyOut = path.join(OPT_DIR, 'SPY', 'raw', `${date}.json`);
    if (!RECOMPUTE && fs.existsSync(qqqOut) && fs.existsSync(spyOut)) {
      // Update last known close from daily data
      for (const etf of ['QQQ', 'SPY']) {
        const c = etfCloses[etf]?.[date]?.close;
        if (c) lastKnownClose[etf] = c;
      }
      continue;
    }
    if (DRY_RUN) {
      log(`  [DRY] would process ${fname}`);
      continue;
    }

    process.stdout.write(`\r  Processing ${fname}...`);

    const fpath = path.join(opraDir, fname);
    const buf = await decompress(fs.readFileSync(fpath));
    const text = buf.toString('utf8');
    const lines = text.split('\n');

    if (lines.length < 2) continue;

    const headers = lines[0].split(',').map(h => h.trim());
    const idxId       = headers.indexOf('instrument_id');
    const idxStatType = headers.indexOf('stat_type');
    const idxQty      = headers.indexOf('quantity');
    // symbol is last column
    const idxSymbol   = headers.indexOf('symbol');

    // Accumulate OI per contract: instrument_id → maxOI seen (multiple publishers)
    const oiMap = {}; // instrument_id → { qty, publishers: Set }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(',');
      const statType = parseInt(parts[idxStatType]);
      if (statType !== 9) continue; // only Open Interest (stat_type=9)

      const id  = parts[idxId];
      const qty = parseInt(parts[idxQty]);
      if (!id || isNaN(qty) || qty <= 0 || qty === 2147483647) continue;

      // Use max OI across publishers (conservative — some exchanges report partial OI)
      if (!oiMap[id] || qty > oiMap[id]) oiMap[id] = qty;
    }

    // Get ETF closes for this date
    for (const etf of ['QQQ', 'SPY']) {
      const c = etfCloses[etf]?.[date]?.close;
      if (c) lastKnownClose[etf] = c;
    }

    // Build per-underlying output
    const byUnderlying = { QQQ: [], SPY: [] };

    for (const [id, oi] of Object.entries(oiMap)) {
      const def = contractDefs[id];
      if (!def) continue;
      if (def.underlying !== 'QQQ' && def.underlying !== 'SPY') continue;

      const S = lastKnownClose[def.underlying];
      if (!S) continue;

      // Filter: ±25% from spot
      if (def.strike < S * 0.75 || def.strike > S * 1.25) continue;

      // Filter: expiry within 45 days
      const expDate = new Date(def.expiry + 'T00:00:00Z');
      const curDate = new Date(date + 'T00:00:00Z');
      const dte = (expDate - curDate) / 86400000;
      if (dte < 0 || dte > 45) continue;

      byUnderlying[def.underlying].push({
        symbol: def.symbol,
        strike: def.strike,
        expiry: def.expiry,
        type:   def.type,
        oi,
      });
    }

    // Write output files
    for (const etf of ['QQQ', 'SPY']) {
      if (byUnderlying[etf].length === 0) continue;
      const outDir = path.join(OPT_DIR, etf, 'raw');
      ensureDir(outDir);
      const outPath = path.join(outDir, `${date}.json`);
      writeJSON(outPath, {
        date,
        underlying: etf,
        contracts: byUnderlying[etf],
      });
    }

    filesProcessed++;
  }

  log(`\n[1e COMPLETE] ${elapsed(t0)} — ${filesProcessed} statistics files processed`);
}

// ─── PHASE 1f: COMPUTE HP LEVELS ─────────────────────────────────────────────

async function phase1f() {
  const t0 = Date.now();
  log('\n══════════════════════════════════════════════════════');
  log(' PHASE 1f — COMPUTE HP LEVELS (Black-Scholes)');
  log('══════════════════════════════════════════════════════');

  const underlyings = ['QQQ', 'SPY'];

  for (const etf of underlyings) {
    const futProxy = FUTURES_PROXY_MAP[etf]; // QQQ→MNQ, SPY→MES
    log(`\n[${etf} → ${futProxy}]`);

    const rawDir  = path.join(OPT_DIR, etf, 'raw');
    const compDir = path.join(OPT_DIR, etf, 'computed');
    ensureDir(compDir);

    if (!fs.existsSync(rawDir)) {
      warn(`No raw OPRA data for ${etf} — skipping`);
      continue;
    }

    // Load ETF daily closes
    const etfDailyPath = path.join(OPT_DIR, etf, `${etf}_daily.json`);
    const etfDaily = fs.existsSync(etfDailyPath) ? readJSON(etfDailyPath) : {};

    // Load futures daily closes from 1m data (last bar close before 16:00 ET)
    const futDates = {};
    const futManifest = readJSON(path.join(FUT_DIR, futProxy, 'manifest.json'));
    if (futManifest) {
      log(`  Loading futures closes for ${futProxy}...`);
      const fut1mDir = path.join(FUT_DIR, futProxy, '1m');
      if (fs.existsSync(fut1mDir)) {
        for (const f of fs.readdirSync(fut1mDir).filter(f => f.endsWith('.json'))) {
          const date = f.replace('.json', '');
          const bars = readJSON(path.join(fut1mDir, f)) || [];
          // Last bar before 20:00 UTC (16:00 ET during EST, 15:00 ET during EDT — use 20:00 UTC to catch RTH close)
          const rthBars = bars.filter(b => {
            const h = new Date(b.ts * 1000).getUTCHours();
            return h < 20;
          });
          if (rthBars.length > 0) {
            futDates[date] = rthBars[rthBars.length - 1].close;
          }
        }
      }
      log(`  Loaded ${Object.keys(futDates).length} futures close prices`);
    }

    // Build rolling 20-day log returns for IV estimation
    // dates sorted → for each date, need previous 20 ETF closes
    const etfDates = Object.keys(etfDaily).sort();
    const etfClosePrices = etfDates.map(d => etfDaily[d]?.close);

    const rawFiles = fs.readdirSync(rawDir).filter(f => f.endsWith('.json')).sort();
    let computed = 0, skipped = 0, errored = 0;

    const manifestDates = [];
    let sumIV = 0;

    for (const fname of rawFiles) {
      const date = fname.replace('.json', '');
      const outPath = path.join(compDir, `${date}.json`);

      // Skip if already computed and not forcing
      if (!RECOMPUTE && fs.existsSync(outPath)) {
        const existing = readJSON(outPath);
        if (existing?.computedAt) { skipped++; continue; }
      }
      if (DRY_RUN) {
        log(`  [DRY] would compute ${etf} ${date}`);
        computed++;
        continue;
      }

      try {
        const rawData = readJSON(path.join(rawDir, fname));
        if (!rawData?.contracts?.length) { skipped++; continue; }

        // Get ETF close for this date (fallback to previous)
        let etfClose = etfDaily[date]?.close;
        if (!etfClose) {
          // Fallback: last known close before this date
          const prevDates = etfDates.filter(d => d < date);
          if (prevDates.length > 0) etfClose = etfDaily[prevDates[prevDates.length - 1]]?.close;
        }
        if (!etfClose) { warn(`No ETF close for ${etf} ${date} — skipping`); errored++; continue; }

        // Get futures close for scaling ratio
        const futuresClose = futDates[date] || null;

        // Build 20-day log returns ending at this date
        const idx = etfDates.indexOf(date);
        const lookback = 20;
        const dailyLogReturns = [];
        if (idx > 0) {
          const start = Math.max(0, idx - lookback);
          for (let i = start + 1; i <= idx; i++) {
            const prev = etfClosePrices[i - 1];
            const cur  = etfClosePrices[i];
            if (prev && cur && prev > 0) dailyLogReturns.push(Math.log(cur / prev));
          }
        }

        const snapshot = computeHP({
          date,
          underlying: etf,
          futuresProxy: futProxy,
          etfClose,
          futuresClose,
          contracts: rawData.contracts,
          dailyLogReturns,
        });

        writeJSON(outPath, snapshot);
        manifestDates.push(date);
        sumIV += snapshot.atmIV || 0;
        computed++;
        process.stdout.write(`\r  ${etf} ${date} — IV: ${((snapshot.atmIV || 0) * 100).toFixed(1)}%  GEX: ${(snapshot.totalGex / 1e9).toFixed(2)}B  DEX: ${snapshot.dexBias}`);

      } catch (e2) {
        warn(`\nError computing ${etf} ${date}: ${e2.message}`);
        errored++;
      }
    }

    log(`\n  ${etf}: computed=${computed} skipped=${skipped} errors=${errored}`);

    // Write computed manifest
    const allComputed = fs.readdirSync(compDir).filter(f => f.endsWith('.json') && f !== 'manifest.json').sort();
    const manifest = {
      underlying: etf,
      futuresProxy: futProxy,
      firstDate:      allComputed[0]?.replace('.json', '') || null,
      lastDate:       allComputed[allComputed.length - 1]?.replace('.json', '') || null,
      datesComputed:  allComputed.length,
      datesSkipped:   skipped,
      avgAtmIV:       computed > 0 ? +(sumIV / computed).toFixed(4) : null,
      processedAt:    new Date().toISOString(),
    };
    writeJSON(path.join(compDir, 'manifest.json'), manifest);
    log(`  Manifest: ${allComputed.length} computed dates, avgIV=${((manifest.avgAtmIV || 0) * 100).toFixed(1)}%`);
  }

  log(`\n[1f COMPLETE] ${elapsed(t0)}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const T0 = Date.now();

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   FuturesEdge AI — Historical Data Pipeline          ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`DRY_RUN=${DRY_RUN}  RECOMPUTE=${RECOMPUTE}  SYMBOL_FILTER=${SYMBOL_FILTER || 'all'}`);

  try {
    if (INVENTORY_ONLY) {
      await phase1a();
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
