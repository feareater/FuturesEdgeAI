'use strict';
// Phase 3A of data-layer remediation (v14.36).
//
// Fills the thin-historical window called out in the 2026-04-21 audit (Bug 5):
// every tradeable symbol has ~14 days of <500 bars/day since 2026-04-02. The
// hourly refresh only pulls a 95-min window so it can't close the gap between
// scheduled runs; live-feed gaps (reconnects, cold starts, overnight thin
// volume) leave holes that never get filled.
//
// Solution: for each of the 8 tradeable CME symbols, fetch 14 calendar days
// of 1m OHLCV from the Databento historical REST API, day-by-day, and merge
// into the existing `data/historical/futures/{SYMBOL}/1m/{YYYY-MM-DD}.json`
// files using Phase 2 dedup semantics. Then re-aggregate 5m/15m/30m.
//
// Writes bars with `time` field (Phase 1 compliance). Per-file `.bak` sidecars
// match Phase 2's rollback strategy. Skip-if-complete: any (symbol, date) file
// already holding ≥1300 bars (near-complete 23h CME session) is left alone.
//
// Today's date is always skipped — the live feed is actively appending to
// today's 1m file, and Databento's historical API has a ~15-min ingest lag.
//
// Flags:
//   --dry-run            Plan only; no network calls, no writes.
//   --symbol SYM         Restrict to one symbol.
//   --days N             Window in days (default 14).
//   --verbose            Log every file decision.
//   --force              Ignore the ≥1300-bar skip gate (re-backfill even complete days).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const { INSTRUMENTS } = require('../server/data/instruments');

const argv = process.argv.slice(2);
const DRY_RUN  = argv.includes('--dry-run');
const VERBOSE  = argv.includes('--verbose');
const FORCE    = argv.includes('--force');
const SYM_IDX  = argv.indexOf('--symbol');
const SYMBOL   = SYM_IDX >= 0 ? argv[SYM_IDX + 1] : null;
const DAYS_IDX = argv.indexOf('--days');
const DAYS     = DAYS_IDX >= 0 ? parseInt(argv[DAYS_IDX + 1], 10) : 14;

const TRADEABLE = ['MNQ', 'MES', 'M2K', 'MYM', 'MGC', 'SIL', 'MHG', 'MCL'];

const HIST_DIR    = path.resolve(__dirname, '..', 'data', 'historical');
const FUTURES_DIR = path.join(HIST_DIR, 'futures');
const AGG_DIR     = path.join(HIST_DIR, 'futures_agg');

const COMPLETE_BAR_THRESHOLD = 1300;

function log(...a)  { console.log(...a); }
function vlog(...a) { if (VERBOSE) console.log(...a); }
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
 * Same pattern as dailyRefresh.js fetchSymbol24h but windowed to a full day.
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
          // 422 = data not yet available (e.g. asking for today's full day too early).
          // Soft-fail: return empty rather than abort.
          return resolve([]);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Databento HTTP ${res.statusCode} for ${symbol} ${dateStr}: ${raw.slice(0, 200)}`));
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
          reject(new Error(`Databento parse error for ${symbol} ${dateStr}: ${err.message}`));
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
  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  return merged;
}

// ─── Aggregation (shared with historicalPipeline.js semantics) ────────────────

const TF_SEC = { '5m': 300, '15m': 900, '30m': 1800 };

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

function writeWithBackup(filePath, bars) {
  if (DRY_RUN) return;
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

// ─── Main per-symbol flow ─────────────────────────────────────────────────────

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

async function backfillSymbol(symbol, dates) {
  stats.symbolsAttempted++;
  const sstat = (stats.perSymbol[symbol] ||= { fetched: 0, skipped: 0, errored: 0, barsIn: 0, barsOut: 0 });

  const touchedDates = [];
  for (const date of dates) {
    stats.datesAttempted++;

    const probe = probeFile(symbol, date);
    if (probe.exists && !FORCE && probe.barCount >= COMPLETE_BAR_THRESHOLD) {
      vlog(`  [SKIP] ${symbol} ${date} (already has ${probe.barCount} bars)`);
      stats.datesSkipped++;
      sstat.skipped++;
      continue;
    }

    let newBars;
    try {
      if (DRY_RUN) {
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

    writeWithBackup(existingPath, merged);
    stats.filesWritten++;
    sstat.fetched++;
    touchedDates.push(date);

    // Throttle between requests to stay under Databento's rate limits
    await new Promise(r => setTimeout(r, 150));
  }

  return touchedDates;
}

async function reaggregateSymbolDates(symbol, dates) {
  for (const date of dates) {
    const src = readJSON(path.join(FUTURES_DIR, symbol, '1m', `${date}.json`));
    if (!Array.isArray(src) || src.length === 0) continue;
    for (const tf of Object.keys(TF_SEC)) {
      const tfBars = aggregateBars(src, TF_SEC[tf] / 60);
      const futPath = path.join(FUTURES_DIR, symbol, tf, `${date}.json`);
      const aggPath = path.join(AGG_DIR,     symbol, tf, `${date}.json`);
      writeWithBackup(futPath, tfBars);
      writeWithBackup(aggPath, tfBars);
      stats.filesAggregated += 2;
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════════════════════');
  log(' Historical backfill — 14d × 1m × 8 tradeable (Phase 3A)');
  log('═══════════════════════════════════════════════════════════');
  log(` DRY_RUN=${DRY_RUN}  SYMBOL=${SYMBOL || 'all'}  DAYS=${DAYS}  FORCE=${FORCE}  VERBOSE=${VERBOSE}`);

  if (!process.env.DATABENTO_API_KEY && !DRY_RUN) {
    warn('DATABENTO_API_KEY not set — aborting (pass --dry-run to plan-only)');
    process.exit(1);
  }

  const dates = listDates(DAYS);
  log(` Date window: ${dates[dates.length - 1]} → ${dates[0]} (${dates.length} days, today=${todayUTCDateStr()} excluded)`);
  log('');

  const symbols = SYMBOL ? [SYMBOL] : TRADEABLE;
  if (SYMBOL && !TRADEABLE.includes(SYMBOL)) {
    warn(`Symbol '${SYMBOL}' is not in the tradeable list: ${TRADEABLE.join(', ')}`);
    process.exit(1);
  }

  const t0 = Date.now();
  for (const sym of symbols) {
    log(`── ${sym} ─────────────────────────────────`);
    const touched = await backfillSymbol(sym, dates);

    if (!DRY_RUN && touched.length > 0) {
      log(`  Re-aggregating 5m/15m/30m for ${touched.length} dates...`);
      await reaggregateSymbolDates(sym, touched);
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

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
