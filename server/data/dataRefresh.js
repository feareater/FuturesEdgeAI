'use strict';
/**
 * dataRefresh.js — Refresh scheduler (v14.40, renamed from dailyRefresh.js in v14.26).
 *
 * Replaces the single hourly schedule with two:
 *   - QUICK (every 15 min, clock-aligned to :00/:15/:30/:45)
 *       Lookback: 95 min (90 + 5 buffer). Catches fresh gaps between bars while
 *       the live feed is running.
 *   - DAILY (once at 17:30 ET each weekday)
 *       Lookback: 24 h. Runs during the CME 17:00-18:00 ET maintenance window
 *       so the live feed isn't competing, Databento has had ~30 min to settle
 *       ingest of the just-closed session, and bars are rewritten before the
 *       18:00 ET re-open.
 *
 * Both schedules pull all 16 CME symbols. A manual refresh via
 * POST /api/refresh/{symbol,all} can request any lookback window from 1 minute
 * up to 30 days (43 200 minutes); lookbacks > 24 h delegate to the per-day
 * backfill helper in scripts/backfillHistoricalWindow.js.
 *
 * The module emits refresh_start / refresh_progress / refresh_complete events
 * (via Node's EventEmitter) so server/index.js can broadcast them over
 * WebSocket to the dashboard for a live topbar banner.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const { INSTRUMENTS, ALL_SYMBOLS, OPRA_UNDERLYINGS } = require('./instruments');
const { purgeAllInvalidBars, aggregateBarsToTF }     = require('./snapshot');
const { backfillSymbolWindow }                       = require('../../scripts/backfillHistoricalWindow');

// ── Constants ──────────────────────────────────────────────────────────────────

const HIST_DIR    = path.resolve(__dirname, '../../data/historical');
const FUTURES_DIR = path.join(HIST_DIR, 'futures');
const AGG_DIR     = path.join(HIST_DIR, 'futures_agg');

const TF_MAP = {
  '5m':  300,
  '15m': 900,
  '30m': 1800,
  '1h':  3600,
  '2h':  7200,
  '4h':  14400,
};

const QUICK_INTERVAL_MS = 15 * 60 * 1000;   // 15 min
const QUICK_LOOKBACK_MIN = 95;               // 90-min bars + 5-min buffer
const DAILY_LOOKBACK_MIN = 24 * 60;          // 24 h
const DAILY_POLL_MS      = 5 * 60 * 1000;    // 5-min poll to check ET time
const DAILY_ET_HOUR      = 17;               // 17:30 ET
const DAILY_ET_MIN_START = 25;               // fire any minute in 17:25-17:35
const DAILY_ET_MIN_END   = 35;

// All 16 CME symbols with a dbRoot — tradeable + reference (FX, bonds, crypto CME)
const CME_REFRESH_SYMBOLS = ALL_SYMBOLS.filter(s => {
  const inst = INSTRUMENTS[s];
  return inst && inst.dbRoot;
});

// Yahoo Finance tickers for fallback (short-window path only)
const YAHOO_TICKERS = {
  MNQ: 'NQ=F',  MES: 'ES=F',  MGC: 'GC=F',  MCL: 'CL=F',
  SIL: 'SI=F',  M2K: 'RTY=F', MYM: 'YM=F',  MHG: 'HG=F',
};

// ── Event emitter (consumed by server/index.js for WS broadcasts) ─────────────

const events = new EventEmitter();

// ── Module state ───────────────────────────────────────────────────────────────

/**
 * Shape of a completed run — what /api/refresh/status returns under `lastRun`.
 * @typedef {object} LastRun
 * @property {'all'|'symbol'} scope
 * @property {string|null} symbol
 * @property {string} completedAt       ISO timestamp
 * @property {number} durationMs
 * @property {number} lookbackMinutes
 * @property {Object<string,{status:'done'|'error',barsWritten:number,error?:string}>} results
 */

/** @type {null | {scope:string, symbol:string|null, lookbackMinutes:number, startedAt:string, currentIndex:number, totalSymbols:number}} */
let _inFlight = null;
/** @type {null | LastRun} */
let _lastRun = null;
/** @type {Object<string,{completedAt:string, lookbackMinutes:number, status:string, barsWritten:number}>} */
let _lastRefreshPerSymbol = {};

const _runningSymbols = new Set();      // prevent double-runs per symbol

let _quickTimer    = null;
let _quickInterval = null;
let _dailyInterval = null;
let _lastDailyRunDate = null;           // YYYY-MM-DD in ET; guards the 17:25-17:35 window

// ── Helpers ────────────────────────────────────────────────────────────────────

function _tsToETDate(unixSec) {
  // Approximate ET (UTC-5 standard) just for grouping bars into date files.
  // DST drift of ±1 h at session boundaries is absorbed by the historical
  // pipeline's date-indexed files; downstream readers key on bar timestamps
  // directly, so a ±1 h shift in the file name is cosmetic.
  const d = new Date((unixSec - 5 * 3600) * 1000);
  return d.toISOString().slice(0, 10);
}

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _writeDateFile(dir, dateStr, bars) {
  _ensureDir(dir);
  fs.writeFileSync(path.join(dir, `${dateStr}.json`), JSON.stringify(bars, null, 0), 'utf8');
}

function _aggregateBarsToTF(bars1m, tf) {
  const tfSec = TF_MAP[tf];
  if (!tfSec || !bars1m || bars1m.length === 0) return [];
  return aggregateBarsToTF(bars1m, tfSec);
}

/** Return today's date in ET (YYYY-MM-DD) using Intl so DST handles automatically. */
function _etTodayStr() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year:  'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Return current ET clock parts { year, month, day, hour, minute } via Intl. */
function _etNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    date:   `${parts.year}-${parts.month}-${parts.day}`,
    hour:   parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
  };
}

// ── Databento short-window fetch (lookback ≤ 24 h) ───────────────────────────

async function fetchSymbolWindow(symbol, lookbackMinutes) {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) throw new Error('DATABENTO_API_KEY not set');

  const inst = INSTRUMENTS[symbol];
  if (!inst || !inst.dbRoot) throw new Error(`Unknown symbol: ${symbol}`);

  // Clamp end to 15 minutes ago — Databento historical API rejects end > available data.
  const now = new Date(Date.now() - 15 * 60 * 1000);
  const start = new Date(now.getTime() - lookbackMinutes * 60 * 1000);

  const params = new URLSearchParams({
    dataset:  'GLBX.MDP3',
    schema:   'ohlcv-1m',
    stype_in: 'parent',
    symbols:  `${inst.dbRoot}.FUT`,
    start:    start.toISOString(),
    end:      now.toISOString(),
    encoding: 'json',
  });

  return new Promise((resolve, reject) => {
    const body = params.toString();
    const auth = Buffer.from(`${apiKey}:`).toString('base64');

    const req = https.request({
      hostname: 'hist.databento.com',
      path: '/v0/timeseries.get_range',
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Basic ${auth}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Databento HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const dateMap = new Map();
          const lines = data.trim().split('\n').filter(l => l.length > 0);

          for (const line of lines) {
            const rec = JSON.parse(line);
            const tsNano = BigInt(rec.hd?.ts_event || rec.ts_event || '0');
            const tsSec  = Number(tsNano / 1000000000n);
            if (tsSec === 0) continue;
            const open   = Number(rec.open)  / 1e9;
            const high   = Number(rec.high)  / 1e9;
            const low    = Number(rec.low)   / 1e9;
            const close  = Number(rec.close) / 1e9;
            const volume = Number(rec.volume) || 0;
            if (close <= 0 || open <= 0) continue;

            const time = Math.floor(tsSec / 60) * 60;
            const dateStr = _tsToETDate(time);

            if (!dateMap.has(dateStr)) dateMap.set(dateStr, []);
            dateMap.get(dateStr).push({ time, open, high, low, close, volume });
          }

          for (const [, bars] of dateMap) bars.sort((a, b) => a.time - b.time);
          resolve(dateMap);
        } catch (err) {
          reject(new Error(`Databento parse error: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Yahoo fallback (short-window only) ────────────────────────────────────────

async function fetchSymbolYahoo(symbol, lookbackMinutes) {
  const yfTicker = YAHOO_TICKERS[symbol];
  if (!yfTicker) throw new Error(`No Yahoo ticker for ${symbol}`);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfTicker)}?interval=1m&range=7d`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json?.chart?.result?.[0];
          if (!result) return reject(new Error('No Yahoo data returned'));
          const timestamps = result.timestamp || [];
          const quote = result.indicators?.quote?.[0] || {};
          const { open: o, high: h, low: l, close: c, volume: v } = quote;
          if (!timestamps.length || !c) return reject(new Error('Empty Yahoo response'));

          const cutoff = Math.floor(Date.now() / 1000) - lookbackMinutes * 60;
          const dateMap = new Map();

          for (let i = 0; i < timestamps.length; i++) {
            const time = Math.floor(timestamps[i] / 60) * 60;
            if (time < cutoff) continue;
            const close = c[i], open_ = o[i], high_ = h[i], low_ = l[i], vol = v[i];
            if (!close || close <= 0 || !open_ || open_ <= 0) continue;
            const dateStr = _tsToETDate(time);
            if (!dateMap.has(dateStr)) dateMap.set(dateStr, []);
            dateMap.get(dateStr).push({
              time, open: open_, high: high_ || open_, low: low_ || open_,
              close, volume: vol || 0,
            });
          }

          for (const [, bars] of dateMap) bars.sort((a, b) => a.time - b.time);
          for (const [dateStr, bars] of dateMap) dateMap.set(dateStr, _sanitizeYahoo(symbol, bars));
          resolve(dateMap);
        } catch (err) {
          reject(new Error(`Yahoo parse error: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

function _sanitizeYahoo(symbol, bars) {
  if (!bars || bars.length === 0) return bars;
  const threshold = 0.06; // 6% max close-to-close deviation
  const out = [];
  let prevClose = null;
  for (const bar of bars) {
    if (!bar.close || bar.close <= 0 || !bar.open || bar.open <= 0) continue;
    if (prevClose !== null) {
      const dev = Math.abs(bar.close - prevClose) / prevClose;
      if (dev > threshold) continue;
    }
    out.push(bar);
    prevClose = bar.close;
  }
  return out;
}

// ── Per-symbol refresh ────────────────────────────────────────────────────────

/**
 * Refresh one CME symbol.
 *
 * Back-compat contract: called from server/data/dataQuality.js
 * (triggerAutoRefresh) with just a symbol — the default lookback (95 min)
 * preserves the pre-v14.40 behaviour.
 *
 * @param {string} symbol
 * @param {number} [lookbackMinutes=95]  1…43200 minutes
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]   Bypass the ≥1,300-bar skip-if-complete
 *                                       gate in the per-day backfill path
 *                                       (only meaningful when lookback > 1440).
 * @returns {Promise<{symbol, datesRefreshed: string[], barsTotal: number, source: string, error?: string}>}
 */
async function refreshSymbol(symbol, lookbackMinutes = QUICK_LOOKBACK_MIN, opts = {}) {
  const inst = INSTRUMENTS[symbol];
  if (!inst || !inst.dbRoot) {
    return { symbol, datesRefreshed: [], barsTotal: 0, source: 'skipped' };
  }
  if (_runningSymbols.has(symbol)) {
    console.warn(`[REFRESH] ${symbol}: already running, skipping duplicate request`);
    return { symbol, datesRefreshed: [], barsTotal: 0, source: 'skipped' };
  }

  _runningSymbols.add(symbol);
  try {
    // > 24 h — delegate to the per-day backfill helper
    if (lookbackMinutes > 24 * 60) {
      const r = await backfillSymbolWindow(symbol, lookbackMinutes, { force: !!opts.force });
      purgeAllInvalidBars();  // rebuild in-memory candle store
      return r;
    }

    // ≤ 24 h — single Databento REST request (with Yahoo fallback)
    let dateMap = null;
    let source  = 'failed';
    try {
      dateMap = await fetchSymbolWindow(symbol, lookbackMinutes);
      source = 'databento';
    } catch (dbErr) {
      console.warn(`[REFRESH] ${symbol}: Databento failed (${dbErr.message}), trying Yahoo fallback`);
      if (!YAHOO_TICKERS[symbol]) {
        return { symbol, datesRefreshed: [], barsTotal: 0, source: 'failed', error: dbErr.message };
      }
      try {
        dateMap = await fetchSymbolYahoo(symbol, lookbackMinutes);
        source = 'yahoo';
      } catch (yfErr) {
        return { symbol, datesRefreshed: [], barsTotal: 0, source: 'failed', error: yfErr.message };
      }
    }

    if (!dateMap || dateMap.size === 0) {
      return { symbol, datesRefreshed: [], barsTotal: 0, source };
    }

    let totalBars = 0;
    const datesRefreshed = [];
    for (const [dateStr, bars1m] of dateMap) {
      if (bars1m.length === 0) continue;
      totalBars += bars1m.length;
      datesRefreshed.push(dateStr);

      _writeDateFile(path.join(FUTURES_DIR, symbol, '1m'), dateStr, bars1m);
      for (const tf of ['5m', '15m', '30m']) {
        const aggBars = _aggregateBarsToTF(bars1m, tf);
        if (aggBars.length === 0) continue;
        _writeDateFile(path.join(FUTURES_DIR, symbol, tf), dateStr, aggBars);
        if (fs.existsSync(path.join(AGG_DIR, symbol))) {
          _writeDateFile(path.join(AGG_DIR, symbol, tf), dateStr, aggBars);
        }
      }
    }

    try { purgeAllInvalidBars(symbol); }
    catch (err) { console.warn(`[REFRESH] ${symbol}: purge warning: ${err.message}`); }

    return { symbol, datesRefreshed, barsTotal: totalBars, source };
  } finally {
    _runningSymbols.delete(symbol);
  }
}

// ── Options HP refresh ────────────────────────────────────────────────────────

async function refreshOptions() {
  try {
    const { computeHP } = require('./hpCompute');
    const etfClosesPath = path.join(HIST_DIR, 'etf_closes.json');
    if (!fs.existsSync(etfClosesPath)) return 'skipped';

    const etfCloses = JSON.parse(fs.readFileSync(etfClosesPath, 'utf8'));
    const allDates = Object.keys(etfCloses.QQQ || {}).sort();
    const recentDates = allDates.slice(-2);
    if (recentDates.length === 0) return 'skipped';

    let recomputed = 0;
    for (const { etf, futuresProxy } of OPRA_UNDERLYINGS) {
      const opraDir = path.join(HIST_DIR, 'options', etf, 'parsed');
      const computedDir = path.join(HIST_DIR, 'options', etf, 'computed');
      if (!fs.existsSync(opraDir)) continue;
      _ensureDir(computedDir);

      for (const dateStr of recentDates) {
        const parsedFile = path.join(opraDir, `${dateStr}.json`);
        if (!fs.existsSync(parsedFile)) continue;

        const etfClose = etfCloses[etf]?.[dateStr];
        if (!etfClose) continue;

        const futuresFile = path.join(FUTURES_DIR, futuresProxy, '1m', `${dateStr}.json`);
        let futuresClose = null;
        if (fs.existsSync(futuresFile)) {
          const fBars = JSON.parse(fs.readFileSync(futuresFile, 'utf8'));
          if (fBars.length > 0) futuresClose = fBars[fBars.length - 1].close;
        }

        try {
          const contracts = JSON.parse(fs.readFileSync(parsedFile, 'utf8'));
          const hp = computeHP({
            date: dateStr, underlying: etf, futuresProxy, etfClose, futuresClose,
            contracts, dailyLogReturns: [],
          });
          if (hp) {
            fs.writeFileSync(path.join(computedDir, `${dateStr}.json`), JSON.stringify(hp, null, 0), 'utf8');
            recomputed++;
          }
        } catch (err) {
          console.warn(`[REFRESH-HP] ${etf}/${dateStr}: ${err.message}`);
        }
      }
    }
    return 'ok';
  } catch (err) {
    console.error(`[REFRESH-HP] Options refresh failed: ${err.message}`);
    return 'failed';
  }
}

// ── Full refresh ──────────────────────────────────────────────────────────────

/**
 * Refresh all 16 CME symbols (with per-symbol progress events).
 *
 * @param {number} [lookbackMinutes=95]
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]
 * @param {string}  [opts.logPrefix='[REFRESH]']
 * @returns {Promise<LastRun>}
 */
async function refreshAll(lookbackMinutes = QUICK_LOOKBACK_MIN, opts = {}) {
  const logPrefix = opts.logPrefix || '[REFRESH]';
  const force     = !!opts.force;
  const startedAt = new Date().toISOString();
  const t0        = Date.now();

  _inFlight = {
    scope: 'all',
    symbol: null,
    lookbackMinutes,
    startedAt,
    currentIndex: 0,
    totalSymbols: CME_REFRESH_SYMBOLS.length,
  };

  events.emit('refresh_start', {
    scope: 'all',
    symbol: null,
    lookbackMinutes,
    startedAt,
    totalSymbols: CME_REFRESH_SYMBOLS.length,
  });

  console.log(`${logPrefix} full refresh start — ${CME_REFRESH_SYMBOLS.length} symbols × ${lookbackMinutes} min`);

  const results = {};
  let completed = 0;

  // Wrap each refreshSymbol so we can emit per-symbol progress as each resolves.
  const promises = CME_REFRESH_SYMBOLS.map(sym => {
    events.emit('refresh_progress', {
      symbol: sym,
      status: 'running',
      currentIndex: completed,
      totalSymbols: CME_REFRESH_SYMBOLS.length,
    });
    return refreshSymbol(sym, lookbackMinutes, { force })
      .then(r => {
        completed++;
        _inFlight && (_inFlight.currentIndex = completed);
        const status = r.source === 'failed' || r.error ? 'error' : 'done';
        results[sym] = { status, barsWritten: r.barsTotal || 0, error: r.error };
        _lastRefreshPerSymbol[sym] = {
          completedAt: new Date().toISOString(),
          lookbackMinutes,
          status,
          barsWritten: r.barsTotal || 0,
        };
        events.emit('refresh_progress', {
          symbol: sym,
          status,
          error: r.error,
          currentIndex: completed,
          totalSymbols: CME_REFRESH_SYMBOLS.length,
        });
        return r;
      })
      .catch(err => {
        completed++;
        _inFlight && (_inFlight.currentIndex = completed);
        results[sym] = { status: 'error', barsWritten: 0, error: err.message };
        _lastRefreshPerSymbol[sym] = {
          completedAt: new Date().toISOString(),
          lookbackMinutes,
          status: 'error',
          barsWritten: 0,
        };
        events.emit('refresh_progress', {
          symbol: sym,
          status: 'error',
          error: err.message,
          currentIndex: completed,
          totalSymbols: CME_REFRESH_SYMBOLS.length,
        });
        return { symbol: sym, datesRefreshed: [], barsTotal: 0, source: 'error', error: err.message };
      });
  });

  await Promise.allSettled(promises);

  // v14.42 Stage 3 — daily OPRA HP snapshot.
  // Runs AFTER symbol refresh (so the 1m futures files driving futuresClose
  // and the volatility input are fresh) and BEFORE refreshOptions() (so
  // refreshOptions sees the snapshot we just wrote when it recomputes the
  // last 2 dates). Snapshot only writes when OPRA has live OI data;
  // otherwise it logs the skip reason and is a no-op — refreshOptions still
  // does its historical recompute pass independently.
  try {
    const { snapshotDailyHP } = require('./opraSnapshot');
    await snapshotDailyHP();
  } catch (err) {
    console.warn(`${logPrefix} OPRA snapshot failed: ${err.message}`);
  }

  // Options HP piggy-backs on every full refresh (cheap — recomputes last 2 dates only).
  try { await refreshOptions(); }
  catch (err) { console.warn(`${logPrefix} options HP recompute failed: ${err.message}`); }

  // Final in-memory purge/rebuild
  try { purgeAllInvalidBars(); }
  catch (err) { console.warn(`${logPrefix} post-refresh purge warning: ${err.message}`); }

  const durationMs  = Date.now() - t0;
  const completedAt = new Date().toISOString();
  _lastRun = {
    scope: 'all',
    symbol: null,
    completedAt,
    durationMs,
    lookbackMinutes,
    results,
  };
  _inFlight = null;

  const totalBars = Object.values(results).reduce((s, r) => s + (r.barsWritten || 0), 0);
  console.log(`${logPrefix} full refresh complete — ${totalBars} bars across ${Object.keys(results).length} symbols in ${(durationMs / 1000).toFixed(1)}s`);

  events.emit('refresh_complete', {
    scope: 'all',
    symbol: null,
    durationMs,
    lookbackMinutes,
    results,
    completedAt,
  });

  return _lastRun;
}

/**
 * Refresh a single symbol, broadcasting the same three events as `refreshAll`
 * so the dashboard's global refresh banner works identically for single-symbol
 * manual refreshes.
 */
async function refreshOne(symbol, lookbackMinutes = QUICK_LOOKBACK_MIN, opts = {}) {
  const logPrefix = opts.logPrefix || '[REFRESH]';
  const force     = !!opts.force;
  const startedAt = new Date().toISOString();
  const t0        = Date.now();

  _inFlight = {
    scope: 'symbol',
    symbol,
    lookbackMinutes,
    startedAt,
    currentIndex: 0,
    totalSymbols: 1,
  };

  events.emit('refresh_start', {
    scope: 'symbol',
    symbol,
    lookbackMinutes,
    startedAt,
    totalSymbols: 1,
  });
  events.emit('refresh_progress', {
    symbol, status: 'running', currentIndex: 0, totalSymbols: 1,
  });
  console.log(`${logPrefix} single-symbol refresh start — ${symbol} × ${lookbackMinutes} min`);

  const results = {};
  let r;
  try {
    r = await refreshSymbol(symbol, lookbackMinutes, { force });
  } catch (err) {
    r = { symbol, datesRefreshed: [], barsTotal: 0, source: 'error', error: err.message };
  }
  const status = r.source === 'failed' || r.source === 'error' || r.error ? 'error' : 'done';
  results[symbol] = { status, barsWritten: r.barsTotal || 0, error: r.error };
  _lastRefreshPerSymbol[symbol] = {
    completedAt: new Date().toISOString(),
    lookbackMinutes,
    status,
    barsWritten: r.barsTotal || 0,
  };

  events.emit('refresh_progress', {
    symbol, status, error: r.error, currentIndex: 1, totalSymbols: 1,
  });

  const durationMs  = Date.now() - t0;
  const completedAt = new Date().toISOString();
  _lastRun = {
    scope: 'symbol',
    symbol,
    completedAt,
    durationMs,
    lookbackMinutes,
    results,
  };
  _inFlight = null;

  console.log(`${logPrefix} single-symbol refresh complete — ${symbol}: ${r.barsTotal || 0} bars in ${(durationMs / 1000).toFixed(1)}s (${status})`);

  events.emit('refresh_complete', {
    scope: 'symbol',
    symbol,
    durationMs,
    lookbackMinutes,
    results,
    completedAt,
  });

  return _lastRun;
}

// ── Schedulers ────────────────────────────────────────────────────────────────

/**
 * Quick refresh — every 15 minutes, clock-aligned to :00 / :15 / :30 / :45.
 * 95-min lookback, all 16 symbols. Skips if another refresh is still in flight.
 */
function scheduleQuickRefresh() {
  if (_quickTimer)    clearTimeout(_quickTimer);
  if (_quickInterval) clearInterval(_quickInterval);

  const now = Date.now();
  const nextTrigger = Math.ceil(now / QUICK_INTERVAL_MS) * QUICK_INTERVAL_MS;
  const delay = Math.max(1000, nextTrigger - now);

  console.log(`[QUICK-REFRESH-SCHED] first run in ${(delay / 1000).toFixed(0)}s (next clock-aligned :00/:15/:30/:45); then every ${QUICK_INTERVAL_MS / 60000} min, ${CME_REFRESH_SYMBOLS.length} symbols`);

  _quickTimer = setTimeout(() => {
    _tickQuick();
    _quickInterval = setInterval(_tickQuick, QUICK_INTERVAL_MS);
  }, delay);
}

function _tickQuick() {
  if (_inFlight) {
    console.log(`[QUICK-REFRESH] Skipping — previous still in flight (${_inFlight.scope}, ${_inFlight.symbol || 'all'})`);
    return;
  }
  console.log('[QUICK-REFRESH] triggered');
  refreshAll(QUICK_LOOKBACK_MIN, { logPrefix: '[QUICK-REFRESH]' })
    .catch(err => console.error('[QUICK-REFRESH] error:', err.message));
}

/**
 * Daily refresh — once per day at 17:30 ET.
 * Implementation: a 5-min setInterval polls ET time; if it lands in 17:25-17:35
 * and today's date hasn't already fired, we run.
 *
 * Rationale: 17:00-18:00 ET is the CME maintenance window. Running at 17:30
 * means the live feed isn't competing, Databento has had ~30 min to settle
 * ingest of the just-closed session, and bars are rewritten before the
 * 18:00 ET re-open.
 */
function scheduleDailyRefresh() {
  if (_dailyInterval) clearInterval(_dailyInterval);
  console.log(`[DAILY-REFRESH-SCHED] polling every 5 min for the 17:25-17:35 ET window (lookback ${DAILY_LOOKBACK_MIN} min, ${CME_REFRESH_SYMBOLS.length} symbols)`);
  _dailyInterval = setInterval(_tickDaily, DAILY_POLL_MS);
}

function _tickDaily() {
  const { date, hour, minute } = _etNow();
  if (hour !== DAILY_ET_HOUR) return;
  if (minute < DAILY_ET_MIN_START || minute > DAILY_ET_MIN_END) return;
  if (_lastDailyRunDate === date) return;         // already fired today
  if (_inFlight) {
    console.log('[DAILY-REFRESH] Skipping — previous still in flight');
    return;
  }
  _lastDailyRunDate = date;
  console.log(`[DAILY-REFRESH] triggered at ${date} ${hour}:${String(minute).padStart(2, '0')} ET`);
  refreshAll(DAILY_LOOKBACK_MIN, { logPrefix: '[DAILY-REFRESH]' })
    .catch(err => console.error('[DAILY-REFRESH] error:', err.message));
}

// ── Status ────────────────────────────────────────────────────────────────────

function getRefreshStatus() {
  return {
    inFlight: _inFlight ? { ..._inFlight } : null,
    lastRun:  _lastRun ? { ..._lastRun } : null,
    lastRefreshPerSymbol: { ..._lastRefreshPerSymbol },
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  events,
  refreshSymbol,           // low-level (no events, used by dataQuality auto-refresh)
  refreshOne,              // manual single-symbol refresh with events
  refreshAll,              // full refresh with events
  refreshOptions,
  scheduleQuickRefresh,
  scheduleDailyRefresh,
  getRefreshStatus,
  CME_REFRESH_SYMBOLS,
  QUICK_INTERVAL_MS,
  QUICK_LOOKBACK_MIN,
  DAILY_LOOKBACK_MIN,
};
