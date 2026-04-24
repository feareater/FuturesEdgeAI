'use strict';
// Historical 1m gap-filler (v14.36 → extended to 16 symbols in v14.40).
//
// Originally Phase 3A of the data-layer remediation (v14.36): fill the thin
// 14-day window for the 8 tradeable CME symbols (Bug 5). v14.40 closes Bug 8
// by extending the default symbol set to all 16 CME symbols (tradeable +
// reference). The script's Phase 2 dedup semantics, `.bak` sidecars, and
// per-day re-aggregation are unchanged; only the symbol list and the new
// `--tradeable-only` flag are new.
//
// For each (symbol, date) in the window, fetch 1m OHLCV from the Databento
// historical REST API, merge into the existing
// `data/historical/futures/{SYMBOL}/1m/{YYYY-MM-DD}.json` using Phase 2 dedup
// semantics, then re-aggregate 5m/15m/30m into both
// `data/historical/futures/{sym}/{tf}/` and
// `data/historical/futures_agg/{sym}/{tf}/`.
//
// Writes bars with `time` field (Phase 1 compliance). Per-file `.bak`
// sidecars match Phase 2's rollback strategy. Skip-if-complete: any
// (symbol, date) file already holding ≥1300 bars (near-complete 23h CME
// session) is left alone. Today's date is always skipped — the live feed is
// actively appending, and Databento's historical API has a ~15-min ingest
// lag.
//
// Flags:
//   --dry-run            Plan only; no network calls, no writes.
//   --symbol SYM         Restrict to one symbol (repeatable via flag position).
//   --days N             Window in days (default 14).
//   --verbose            Log every file decision.
//   --force              Ignore the ≥1300-bar skip gate (re-backfill even complete days).
//   --tradeable-only     Restrict to the original 8 tradeable symbols (pre-v14.40 default).
//
// v14.40 also exports `backfillSymbolWindow(symbol, lookbackMinutes, {force})`
// so `server/data/dataRefresh.js` can delegate lookbacks >1440 minutes to the
// same chunked per-day fetch logic without spawning a child process.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const { INSTRUMENTS, TRADEABLE_SYMBOLS, REFERENCE_SYMBOLS } = require('../server/data/instruments');

const TRADEABLE = TRADEABLE_SYMBOLS.slice();                                         // 8 symbols
const ALL_16    = TRADEABLE_SYMBOLS.concat(REFERENCE_SYMBOLS);                       // 16 symbols (v14.40)

const HIST_DIR    = path.resolve(__dirname, '..', 'data', 'historical');
const FUTURES_DIR = path.join(HIST_DIR, 'futures');
const AGG_DIR     = path.join(HIST_DIR, 'futures_agg');

const COMPLETE_BAR_THRESHOLD = 1300;
const TF_SEC = { '5m': 300, '15m': 900, '30m': 1800 };

// Whether this file is being executed directly (CLI) or imported as a module.
const IS_CLI = require.main === module;

// ─── CLI arg parsing (only when invoked as CLI) ───────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN         = argv.includes('--dry-run');
const VERBOSE         = argv.includes('--verbose');
const FORCE_CLI       = argv.includes('--force');
const TRADEABLE_ONLY  = argv.includes('--tradeable-only');
const SYM_IDX         = argv.indexOf('--symbol');
const SYMBOL          = SYM_IDX >= 0 ? argv[SYM_IDX + 1] : null;
const DAYS_IDX        = argv.indexOf('--days');
const DAYS            = DAYS_IDX >= 0 ? parseInt(argv[DAYS_IDX + 1], 10) : 14;

function log(...a)  { if (IS_CLI) console.log(...a); }
function vlog(...a) { if (IS_CLI && VERBOSE) console.log(...a); }
function warn(...a) { console.warn(...a); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayUTCDateStr() {
  return new Date().toISOString().slice(0, 10);
}

/** List the last N calendar dates (YYYY-MM-DD, UTC), newest first. Today excluded. */
function listDates(days) {
  const out = [];
  const now = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(now.getTime() - i * 86400 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

function writeJSON(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
}

/** Existing-file metadata. Returns {exists, barCount} or {exists:false}. */
function probeFile(symbol, date) {
  const fp = path.join(FUTURES_DIR, symbol, '1m', `${date}.json`);
  if (!fs.existsSync(fp)) return { exists: false };
  const arr = readJSON(fp);
  const count = Array.isArray(arr) ? arr.length : 0;
  return { exists: true, barCount: count };
}

// ─── Databento historical fetch ───────────────────────────────────────────────

/**
 * Fetch one UTC day of 1m bars for a symbol via Databento REST.
 * Returns sorted ascending array of `{time, open, high, low, close, volume}`.
 */
function fetchOneDay(symbol, dateStr) {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) return Promise.reject(new Error('DATABENTO_API_KEY not set'));

  const inst = INSTRUMENTS[symbol];
  if (!inst || !inst.dbRoot) return Promise.reject(new Error(`Unknown symbol: ${symbol}`));

  // Day boundary in UTC. Databento will clamp if `end` exceeds ingest watermark.
  const startIso = `${dateStr}T00:00:00Z`;
  const nextDate = new Date(Date.parse(startIso) + 86400 * 1000).toISOString().slice(0, 10);
  const endIso   = `${nextDate}T00:00:00Z`;

  return _fetchRange(inst, startIso, endIso);
}

/**
 * Fetch an explicit [startIso, endIso) range of 1m bars. Used when
 * `backfillSymbolWindow` needs a sub-day tail (e.g. 6-hour lookback on the
 * most recent day only).
 */
function fetchRange(symbol, startIso, endIso) {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) return Promise.reject(new Error('DATABENTO_API_KEY not set'));
  const inst = INSTRUMENTS[symbol];
  if (!inst || !inst.dbRoot) return Promise.reject(new Error(`Unknown symbol: ${symbol}`));
  return _fetchRange(inst, startIso, endIso);
}

function _fetchRange(inst, startIso, endIso) {
  const apiKey = process.env.DATABENTO_API_KEY;
  const body = new URLSearchParams({
    dataset:  'GLBX.MDP3',
    schema:   'ohlcv-1m',
    stype_in: 'parent',
    symbols:  `${inst.dbRoot}.FUT`,
    start:    startIso,
    end:      endIso,
    encoding: 'json',
  }).toString();

  const auth = Buffer.from(`${apiKey}:`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'hist.databento.com',
      path:     '/v0/timeseries.get_range',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Basic ${auth}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode === 422) {
          // 422 = data not yet available (asking for today's full day too early).
          // Soft-fail: return empty rather than abort.
          return resolve([]);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Databento HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }

        try {
          const bars = [];
          for (const line of raw.trim().split('\n').filter(Boolean)) {
            const rec = JSON.parse(line);
            const tsNano = BigInt(rec.hd?.ts_event || rec.ts_event || '0');
            const tsSec  = Number(tsNano / 1000000000n);
            if (tsSec === 0) continue;
            const open   = Number(rec.open)   / 1e9;
            const high   = Number(rec.high)   / 1e9;
            const low    = Number(rec.low)    / 1e9;
            const close  = Number(rec.close)  / 1e9;
            const volume = Number(rec.volume) || 0;
            if (open <= 0 || close <= 0) continue;
            const time = Math.floor(tsSec / 60) * 60;
            bars.push({ time, open, high, low, close, volume });
          }
          bars.sort((a, b) => a.time - b.time);
          resolve(bars);
        } catch (err) {
          reject(new Error(`Databento parse error: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('Request timed out')));
    req.write(body);
    req.end();
  });
}

// ─── Merge & dedup ────────────────────────────────────────────────────────────

/** Phase 2 dedup semantics: highest volume wins; ties broken by last occurrence. */
function mergeAndDedup(existingBars, newBars) {
  const byTime = new Map();
  for (const b of [...(existingBars || []), ...newBars]) {
    const t = b.time ?? b.ts;
    if (t == null) continue;
    const normalized = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: Number(b.volume ?? 0) };
    const prev = byTime.get(t);
    if (!prev || normalized.volume > prev.volume || normalized.volume === prev.volume) {
      byTime.set(t, normalized);
    }
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function aggregateBars(bars1m, minutes) {
  if (!bars1m || bars1m.length === 0) return [];
  const tfSec = minutes * 60;
  const result = [];
  const _t = (b) => (b.time ?? b.ts);
  let windowStart = Math.floor(_t(bars1m[0]) / tfSec) * tfSec;
  let bucket = [];
  for (const bar of bars1m) {
    const barWindow = Math.floor(_t(bar) / tfSec) * tfSec;
    if (barWindow !== windowStart) {
      if (bucket.length > 0) {
        result.push({
          time:   windowStart,
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
      time:   windowStart,
      open:   bucket[0].open,
      high:   Math.max(...bucket.map(b => b.high)),
      low:    Math.min(...bucket.map(b => b.low)),
      close:  bucket[bucket.length - 1].close,
      volume: bucket.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

// ─── Per-file write (with .bak sidecar) ───────────────────────────────────────

function writeWithBackup(filePath, bars, { dryRun = false } = {}) {
  if (dryRun) return;
  ensureDir(path.dirname(filePath));
  if (fs.existsSync(filePath)) {
    try { fs.renameSync(filePath, filePath + '.bak'); }
    catch (e) {
      warn(`  [BACKUP-ERROR] ${filePath}: ${e.message}`);
      return;
    }
  }
  writeJSON(filePath, bars);
}

// ─── CLI stats (module-scoped, only populated when IS_CLI) ───────────────────

const stats = {
  symbolsAttempted: 0,
  datesAttempted:   0,
  datesFetched:     0,
  datesSkipped:     0,
  datesErrored:     0,
  barsFetched:      0,
  barsMerged:       0,
  filesWritten:     0,
  filesAggregated:  0,
  perSymbol:        {},
};

async function backfillSymbolCli(symbol, dates, { force, dryRun }) {
  stats.symbolsAttempted++;
  const sstat = (stats.perSymbol[symbol] ||= { fetched: 0, skipped: 0, errored: 0, barsIn: 0, barsOut: 0 });

  const touchedDates = [];
  for (const date of dates) {
    stats.datesAttempted++;

    const probe = probeFile(symbol, date);
    if (probe.exists && !force && probe.barCount >= COMPLETE_BAR_THRESHOLD) {
      vlog(`  [SKIP] ${symbol} ${date} (already has ${probe.barCount} bars)`);
      stats.datesSkipped++;
      sstat.skipped++;
      continue;
    }

    let newBars;
    try {
      if (dryRun) {
        vlog(`  [DRY] ${symbol} ${date} — would fetch (existing=${probe.barCount || 0})`);
        stats.datesFetched++;
        sstat.fetched++;
        continue;
      }
      newBars = await fetchOneDay(symbol, date);
    } catch (err) {
      warn(`  [ERROR] ${symbol} ${date}: ${err.message}`);
      stats.datesErrored++;
      sstat.errored++;
      continue;
    }

    if (!newBars || newBars.length === 0) {
      vlog(`  [EMPTY] ${symbol} ${date} — Databento returned 0 bars (likely weekend/holiday or ingest lag)`);
      stats.datesSkipped++;
      sstat.skipped++;
      continue;
    }

    stats.barsFetched += newBars.length;
    sstat.barsIn     += newBars.length;

    const existingPath = path.join(FUTURES_DIR, symbol, '1m', `${date}.json`);
    const existing = probe.exists ? readJSON(existingPath) : null;
    const merged = mergeAndDedup(existing, newBars);

    stats.barsMerged += merged.length;
    sstat.barsOut   += merged.length;

    log(`  ${symbol} ${date}: fetched ${newBars.length}, merged to ${merged.length} (was ${probe.barCount || 0})`);

    writeWithBackup(existingPath, merged, { dryRun });
    stats.filesWritten++;
    sstat.fetched++;
    touchedDates.push(date);

    await new Promise(r => setTimeout(r, 150));
  }

  return touchedDates;
}

async function reaggregateSymbolDates(symbol, dates, { dryRun }) {
  for (const date of dates) {
    const src = readJSON(path.join(FUTURES_DIR, symbol, '1m', `${date}.json`));
    if (!Array.isArray(src) || src.length === 0) continue;
    for (const tf of Object.keys(TF_SEC)) {
      const tfBars = aggregateBars(src, TF_SEC[tf] / 60);
      const futPath = path.join(FUTURES_DIR, symbol, tf, `${date}.json`);
      const aggPath = path.join(AGG_DIR,     symbol, tf, `${date}.json`);
      writeWithBackup(futPath, tfBars, { dryRun });
      writeWithBackup(aggPath, tfBars, { dryRun });
      stats.filesAggregated += 2;
    }
  }
}

// ─── Exported helper (for dataRefresh.js) ─────────────────────────────────────

/**
 * Programmatic per-symbol backfill used by `dataRefresh.refreshSymbol()` for
 * lookbacks > 24 h. Fetches the last `lookbackMinutes` of 1m bars, chunked
 * per-day so any individual request stays well inside Databento's 10k-record
 * and rate-limit constraints. Returns a summary.
 *
 * @param {string} symbol              Internal CME symbol (TRADEABLE or REFERENCE).
 * @param {number} lookbackMinutes     How far back to pull (> 1440 triggers this code path).
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] Bypass the ≥1,300-bar skip-if-complete gate.
 * @returns {Promise<{symbol, datesRefreshed: string[], barsTotal: number, source: string}>}
 */
async function backfillSymbolWindow(symbol, lookbackMinutes, opts = {}) {
  const force = !!opts.force;
  const inst = INSTRUMENTS[symbol];
  if (!inst || !inst.dbRoot) {
    return { symbol, datesRefreshed: [], barsTotal: 0, source: 'skipped' };
  }

  const days = Math.ceil(lookbackMinutes / 1440);
  const dates = listDates(days);                        // newest-first, today excluded
  const datesReversed = dates.slice().reverse();        // oldest-first for readability in logs
  const datesRefreshed = [];
  let barsTotal = 0;

  for (const date of datesReversed) {
    const probe = probeFile(symbol, date);
    if (probe.exists && !force && probe.barCount >= COMPLETE_BAR_THRESHOLD) {
      continue;
    }
    let newBars;
    try {
      newBars = await fetchOneDay(symbol, date);
    } catch (err) {
      console.warn(`[REFRESH-BACKFILL] ${symbol} ${date}: ${err.message}`);
      continue;
    }
    if (!newBars || newBars.length === 0) continue;

    const existingPath = path.join(FUTURES_DIR, symbol, '1m', `${date}.json`);
    const existing = probe.exists ? readJSON(existingPath) : null;
    const merged = mergeAndDedup(existing, newBars);

    writeWithBackup(existingPath, merged, { dryRun: false });
    for (const tf of Object.keys(TF_SEC)) {
      const tfBars = aggregateBars(merged, TF_SEC[tf] / 60);
      if (tfBars.length > 0) {
        writeWithBackup(path.join(FUTURES_DIR, symbol, tf, `${date}.json`), tfBars, { dryRun: false });
        if (fs.existsSync(path.join(AGG_DIR, symbol))) {
          writeWithBackup(path.join(AGG_DIR, symbol, tf, `${date}.json`), tfBars, { dryRun: false });
        }
      }
    }
    datesRefreshed.push(date);
    barsTotal += merged.length;
    await new Promise(r => setTimeout(r, 150));
  }

  return { symbol, datesRefreshed, barsTotal, source: 'databento' };
}

// ─── CLI main ─────────────────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════════════════════');
  log(' Historical backfill — per-day 1m Databento REST pull');
  log('═══════════════════════════════════════════════════════════');
  const symbolPool = TRADEABLE_ONLY ? TRADEABLE : ALL_16;
  log(` DRY_RUN=${DRY_RUN}  SYMBOL=${SYMBOL || 'all'}  DAYS=${DAYS}  FORCE=${FORCE_CLI}  TRADEABLE_ONLY=${TRADEABLE_ONLY}  VERBOSE=${VERBOSE}`);
  log(` Pool: ${symbolPool.length} symbols (${symbolPool.join(', ')})`);

  if (!process.env.DATABENTO_API_KEY && !DRY_RUN) {
    warn('DATABENTO_API_KEY not set — aborting (pass --dry-run to plan-only)');
    process.exit(1);
  }

  const dates = listDates(DAYS);
  log(` Date window: ${dates[dates.length - 1]} → ${dates[0]} (${dates.length} days, today=${todayUTCDateStr()} excluded)`);
  log('');

  let symbols;
  if (SYMBOL) {
    if (!ALL_16.includes(SYMBOL)) {
      warn(`Symbol '${SYMBOL}' is not recognised. Known symbols: ${ALL_16.join(', ')}`);
      process.exit(1);
    }
    symbols = [SYMBOL];
  } else {
    symbols = symbolPool;
  }

  const t0 = Date.now();
  for (const sym of symbols) {
    log(`── ${sym} ─────────────────────────────────`);
    const touched = await backfillSymbolCli(sym, dates, { force: FORCE_CLI, dryRun: DRY_RUN });

    if (!DRY_RUN && touched.length > 0) {
      log(`  Re-aggregating 5m/15m/30m for ${touched.length} dates...`);
      await reaggregateSymbolDates(sym, touched, { dryRun: DRY_RUN });
    }
  }

  log('');
  log('═══════════════════════════════════════════════════════════');
  log(' Summary');
  log('═══════════════════════════════════════════════════════════');
  log(` Symbols attempted:    ${stats.symbolsAttempted}`);
  log(` Dates attempted:      ${stats.datesAttempted}`);
  log(` Dates fetched+written: ${stats.datesFetched}`);
  log(` Dates skipped:        ${stats.datesSkipped}`);
  log(` Dates errored:        ${stats.datesErrored}`);
  log(` Bars fetched:         ${stats.barsFetched.toLocaleString()}`);
  log(` Bars merged on disk:  ${stats.barsMerged.toLocaleString()}`);
  log(` 1m files written:     ${stats.filesWritten}`);
  log(` Aggregated files:     ${stats.filesAggregated}  (5m+15m+30m × 2 dirs)`);
  log('');
  log(` Per-symbol:`);
  for (const [sym, s] of Object.entries(stats.perSymbol).sort(([a],[b]) => a.localeCompare(b))) {
    log(`   ${sym.padEnd(6)} fetched=${String(s.fetched).padStart(3)}  skipped=${String(s.skipped).padStart(3)}  errored=${String(s.errored).padStart(3)}  barsIn=${String(s.barsIn).padStart(7)}  barsOut=${String(s.barsOut).padStart(7)}`);
  }
  log('');
  log(` Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (DRY_RUN) log(' (dry run — no network calls, no writes)');
  log('');
}

if (IS_CLI) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  backfillSymbolWindow,
  fetchOneDay,
  fetchRange,
  mergeAndDedup,
  aggregateBars,
};
