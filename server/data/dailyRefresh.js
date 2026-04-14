'use strict';
/**
 * dailyRefresh.js — Hourly data refresh system (v14.26).
 *
 * Pulls the last 95 minutes of 1m OHLCV data for all 16 CME symbols from
 * Databento (with Yahoo Finance fallback), replaces existing date files in the
 * historical store, re-aggregates higher TFs, purges in-memory candle store,
 * and optionally recomputes HP for OPRA-tracked ETFs.
 *
 * Runs every 60 minutes via setInterval (was: nightly at 05:00 UTC).
 * Manual trigger via POST /api/refresh/symbol/:symbol or POST /api/refresh/all.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const { INSTRUMENTS, ALL_SYMBOLS, TRADEABLE_SYMBOLS, OPRA_UNDERLYINGS } = require('./instruments');
const { purgeAllInvalidBars, aggregateBarsToTF } = require('./snapshot');

// ── Constants ──────────────────────────────────────────────────────────────────

const HIST_DIR     = path.resolve(__dirname, '../../data/historical');
const FUTURES_DIR  = path.join(HIST_DIR, 'futures');
const AGG_DIR      = path.join(HIST_DIR, 'futures_agg');

const TF_MAP = {
  '5m':  300,
  '15m': 900,
  '30m': 1800,
  '1h':  3600,
  '2h':  7200,
  '4h':  14400,
};

// All 16 CME symbols with a dbRoot — tradeable + reference (FX, bonds, crypto CME)
const CME_REFRESH_SYMBOLS = ALL_SYMBOLS.filter(s => {
  const inst = INSTRUMENTS[s];
  return inst && inst.dbRoot;
});

// Yahoo Finance tickers for fallback
const YAHOO_TICKERS = {
  MNQ: 'NQ=F',  MES: 'ES=F',  MGC: 'GC=F',  MCL: 'CL=F',
  SIL: 'SI=F',  M2K: 'RTY=F', MYM: 'YM=F',  MHG: 'HG=F',
};

// ── Module state ───────────────────────────────────────────────────────────────

let _refreshStatus = {
  lastRun: null,
  status: 'idle',       // 'idle' | 'running' | 'done' | 'error'
  results: [],
  error: null,
};

let _runningSymbols = new Set();  // prevent double-runs per symbol
let _nightlyTimer   = null;
let _nightlyInterval = null;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Convert Unix seconds to ET date string (YYYY-MM-DD).
 * ET = UTC - 5 (standard) or UTC - 4 (daylight).
 * We use a simple approach: subtract 5 hours for ET approximation.
 */
function _tsToETDate(unixSec) {
  const d = new Date((unixSec - 5 * 3600) * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Ensure a directory exists (recursive).
 */
function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write bars to a date file as JSON array.
 */
function _writeDateFile(dir, dateStr, bars) {
  _ensureDir(dir);
  const filePath = path.join(dir, `${dateStr}.json`);
  fs.writeFileSync(filePath, JSON.stringify(bars, null, 0), 'utf8');
}

/**
 * Aggregate 1m bars to a given timeframe using window-aligned logic.
 * Same algorithm as snapshot.js aggregateBarsToTF but local to avoid
 * importing the full snapshot module in a circular way.
 */
function _aggregateBarsToTF(bars1m, tf) {
  const tfSec = TF_MAP[tf];
  if (!tfSec || !bars1m || bars1m.length === 0) return [];
  return aggregateBarsToTF(bars1m, tfSec);
}

// ── Databento fetch ────────────────────────────────────────────────────────────

/**
 * Fetch the last 24–48 hours of 1m OHLCV data for a single CME symbol
 * from the Databento REST API.
 *
 * @param {string} symbol  Internal symbol (e.g. 'MNQ')
 * @param {Date}   [date]  Optional reference date (defaults to now)
 * @returns {Promise<Map<string, Array>>} dateStr → array of OHLCV bars
 */
async function fetchSymbol24h(symbol, date) {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) throw new Error('DATABENTO_API_KEY not set');

  const inst = INSTRUMENTS[symbol];
  if (!inst || !inst.dbRoot) throw new Error(`Unknown symbol: ${symbol}`);

  // Clamp end to 15 minutes ago — Databento historical API rejects end > available data
  const now = date ? new Date(date) : new Date(Date.now() - 15 * 60 * 1000);
  const lookbackMs = 95 * 60 * 1000; // 90 min of bars + 5 min buffer
  const start = new Date(now.getTime() - lookbackMs);

  const params = new URLSearchParams({
    dataset:  'GLBX.MDP3',
    schema:   'ohlcv-1m',
    stype_in: 'parent',
    symbols:  `${inst.dbRoot}.FUT`,
    start:    start.toISOString(),
    end:      now.toISOString(),
    encoding: 'json',
  });

  console.log(`[HOURLY-REFRESH-DB] ${symbol}: fetching 95min of 1m bars from Databento`);

  return new Promise((resolve, reject) => {
    const body = params.toString();
    const auth = Buffer.from(`${apiKey}:`).toString('base64');

    const req = https.request({
      hostname: 'hist.databento.com',
      path: '/v0/timeseries.get_range',
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Basic ${auth}`,
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
            // ts_event is nanoseconds — convert to seconds
            const tsNano = BigInt(rec.hd?.ts_event || rec.ts_event || '0');
            const tsSec  = Number(tsNano / 1000000000n);
            if (tsSec === 0) continue;

            // Prices are fixed-point integers — divide by 1e9
            const open   = Number(rec.open)  / 1e9;
            const high   = Number(rec.high)  / 1e9;
            const low    = Number(rec.low)   / 1e9;
            const close  = Number(rec.close) / 1e9;
            const volume = Number(rec.volume) || 0;

            if (close <= 0 || open <= 0) continue;

            // Align to minute boundary
            const time = Math.floor(tsSec / 60) * 60;

            // Group by ET date
            const dateStr = _tsToETDate(time);

            if (!dateMap.has(dateStr)) dateMap.set(dateStr, []);
            dateMap.get(dateStr).push({ time, open, high, low, close, volume });
          }

          // Sort each date's bars by time
          for (const [, bars] of dateMap) {
            bars.sort((a, b) => a.time - b.time);
          }

          console.log(`[HOURLY-REFRESH-DB] ${symbol}: received ${lines.length} bars across ${dateMap.size} dates`);
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

// ── Yahoo Finance fallback ─────────────────────────────────────────────────────

/**
 * Yahoo Finance fallback — fetch 1m bars for the last 7 days, filter to last 48h.
 *
 * @param {string} symbol  Internal symbol
 * @returns {Promise<Map<string, Array>>} dateStr → array of OHLCV bars
 */
async function fetchSymbol24hYahoo(symbol) {
  const yfTicker = YAHOO_TICKERS[symbol];
  if (!yfTicker) throw new Error(`No Yahoo ticker for ${symbol}`);

  console.log(`[HOURLY-REFRESH-YF] ${symbol}: fetching 7d of 1m bars from Yahoo Finance (${yfTicker})`);

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

          const cutoff95m = Math.floor(Date.now() / 1000) - 95 * 60;
          const dateMap = new Map();

          for (let i = 0; i < timestamps.length; i++) {
            const time = Math.floor(timestamps[i] / 60) * 60;
            if (time < cutoff95m) continue;

            const close = c[i], open_ = o[i], high_ = h[i], low_ = l[i], vol = v[i];
            if (!close || close <= 0 || !open_ || open_ <= 0) continue;

            const dateStr = _tsToETDate(time);
            if (!dateMap.has(dateStr)) dateMap.set(dateStr, []);
            dateMap.get(dateStr).push({
              time, open: open_, high: high_ || open_, low: low_ || open_,
              close, volume: vol || 0,
            });
          }

          // Sort each date's bars
          for (const [, bars] of dateMap) {
            bars.sort((a, b) => a.time - b.time);
          }

          // Basic sanitization — remove spikes
          for (const [dateStr, bars] of dateMap) {
            dateMap.set(dateStr, _sanitizeYahoo(symbol, bars));
          }

          console.log(`[HOURLY-REFRESH-YF] ${symbol}: received bars across ${dateMap.size} dates`);
          resolve(dateMap);
        } catch (err) {
          reject(new Error(`Yahoo parse error: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Basic Yahoo bar sanitization — filter null/zero + close-to-close spikes.
 */
function _sanitizeYahoo(symbol, bars) {
  if (!bars || bars.length === 0) return bars;
  const threshold = 0.06; // 6% max close-to-close deviation
  const sanitized = [];
  let prevClose = null;

  for (const bar of bars) {
    if (!bar.close || bar.close <= 0 || !bar.open || bar.open <= 0) continue;
    if (prevClose !== null) {
      const dev = Math.abs(bar.close - prevClose) / prevClose;
      if (dev > threshold) {
        console.warn(`[HOURLY-REFRESH-YF] ${symbol} skipping spike bar at ${bar.time}: close=${bar.close} prev=${prevClose}`);
        continue;
      }
    }
    sanitized.push(bar);
    prevClose = bar.close;
  }
  return sanitized;
}

// ── Per-symbol refresh ─────────────────────────────────────────────────────────

/**
 * Full refresh pipeline for one CME futures symbol.
 *
 * 1. Fetch 48h of 1m bars from Databento (Yahoo fallback)
 * 2. Write 1m date files to historical store
 * 3. Aggregate and write 5m/15m/30m/1h/2h/4h date files
 * 4. Update futures_agg pre-aggregated files if directory exists
 * 5. Purge in-memory candle store
 *
 * @param {string} symbol  Internal symbol (e.g. 'MNQ')
 * @returns {Promise<Object>} { symbol, datesRefreshed, barsTotal, source }
 */
async function refreshSymbol(symbol) {
  const inst = INSTRUMENTS[symbol];
  if (!inst || !inst.dbRoot) {
    console.warn(`[HOURLY-REFRESH] ${symbol}: not a CME futures symbol, skipping`);
    return { symbol, datesRefreshed: [], barsTotal: 0, source: 'skipped' };
  }

  if (_runningSymbols.has(symbol)) {
    console.warn(`[HOURLY-REFRESH] ${symbol}: already running, skipping duplicate request`);
    return { symbol, datesRefreshed: [], barsTotal: 0, source: 'skipped' };
  }

  _runningSymbols.add(symbol);

  let dateMap = null;
  let source = 'failed';

  try {
    // Try Databento first
    try {
      dateMap = await fetchSymbol24h(symbol);
      source = 'databento';
    } catch (dbErr) {
      console.warn(`[HOURLY-REFRESH] ${symbol}: Databento failed (${dbErr.message}), trying Yahoo fallback`);
      if (!YAHOO_TICKERS[symbol]) {
        console.warn(`[HOURLY-REFRESH] ${symbol}: no Yahoo ticker available (bonds/FX/crypto CME) — skipping`);
        return { symbol, datesRefreshed: [], barsTotal: 0, source: 'failed' };
      }
      try {
        dateMap = await fetchSymbol24hYahoo(symbol);
        source = 'yahoo';
      } catch (yfErr) {
        console.error(`[HOURLY-REFRESH] ${symbol}: Yahoo fallback also failed: ${yfErr.message}`);
        return { symbol, datesRefreshed: [], barsTotal: 0, source: 'failed' };
      }
    }

    if (!dateMap || dateMap.size === 0) {
      console.warn(`[HOURLY-REFRESH] ${symbol}: no bars returned from ${source}`);
      return { symbol, datesRefreshed: [], barsTotal: 0, source };
    }

    let totalBars = 0;
    const datesRefreshed = [];
    // Use dbRoot for the directory name (e.g. MGC → GC in Databento, but MNQ → MNQ)
    // However, historical files use the INTERNAL symbol name, not dbRoot
    const symDir = symbol;

    for (const [dateStr, bars1m] of dateMap) {
      if (bars1m.length === 0) continue;
      totalBars += bars1m.length;
      datesRefreshed.push(dateStr);

      // Write 1m bars
      _writeDateFile(path.join(FUTURES_DIR, symDir, '1m'), dateStr, bars1m);

      // Aggregate and write each higher TF
      for (const tf of Object.keys(TF_MAP)) {
        const aggBars = _aggregateBarsToTF(bars1m, tf);
        if (aggBars.length > 0) {
          // Main historical directory (only 5m/15m/30m exist there currently)
          if (['5m', '15m', '30m'].includes(tf)) {
            _writeDateFile(path.join(FUTURES_DIR, symDir, tf), dateStr, aggBars);
          }

          // futures_agg directory (5m/15m/30m only)
          if (['5m', '15m', '30m'].includes(tf)) {
            const aggSymDir = path.join(AGG_DIR, symDir, tf);
            if (fs.existsSync(path.join(AGG_DIR, symDir))) {
              _writeDateFile(aggSymDir, dateStr, aggBars);
            }
          }
        }
      }
    }

    // Purge in-memory candle store for this symbol
    try {
      purgeAllInvalidBars(symbol);
    } catch (err) {
      // purgeAllInvalidBars operates on all symbols — non-fatal if it errors
      console.warn(`[HOURLY-REFRESH] ${symbol}: purge warning: ${err.message}`);
    }

    console.log(`[HOURLY-REFRESH] ${symbol}: ${totalBars} bars for ${datesRefreshed.length} dates written (source: ${source})`);
    return { symbol, datesRefreshed, barsTotal: totalBars, source };

  } finally {
    _runningSymbols.delete(symbol);
  }
}

// ── Options HP refresh ─────────────────────────────────────────────────────────

/**
 * Refresh OPRA options data and recompute HP for all ETF proxies.
 * Re-runs hpCompute for the last 2 dates using already-stored OPRA files.
 */
async function refreshOptions() {
  console.log('[HOURLY-REFRESH-HP] Starting options HP recompute');

  try {
    const { computeHP } = require('./hpCompute');
    const etfClosesPath = path.join(HIST_DIR, 'etf_closes.json');

    if (!fs.existsSync(etfClosesPath)) {
      console.warn('[HOURLY-REFRESH-HP] etf_closes.json not found, skipping HP recompute');
      return 'skipped';
    }

    const etfCloses = JSON.parse(fs.readFileSync(etfClosesPath, 'utf8'));

    // Get the last 2 trading dates from etf_closes
    const allDates = Object.keys(etfCloses.QQQ || {}).sort();
    const recentDates = allDates.slice(-2);
    if (recentDates.length === 0) {
      console.warn('[HOURLY-REFRESH-HP] No recent ETF close dates found');
      return 'skipped';
    }

    let recomputed = 0;

    for (const { etf, futuresProxy } of OPRA_UNDERLYINGS) {
      const opraDir = path.join(HIST_DIR, 'options', etf, 'parsed');
      const computedDir = path.join(HIST_DIR, 'options', etf, 'computed');

      if (!fs.existsSync(opraDir)) {
        console.log(`[HOURLY-REFRESH-HP] ${etf}: no parsed OPRA data, skipping`);
        continue;
      }

      _ensureDir(computedDir);

      for (const dateStr of recentDates) {
        const parsedFile = path.join(opraDir, `${dateStr}.json`);
        if (!fs.existsSync(parsedFile)) continue;

        const etfClose = etfCloses[etf]?.[dateStr];
        if (!etfClose) continue;

        // Read futures close for the date
        const futuresFile = path.join(FUTURES_DIR, futuresProxy, '1m', `${dateStr}.json`);
        let futuresClose = null;
        if (fs.existsSync(futuresFile)) {
          const fBars = JSON.parse(fs.readFileSync(futuresFile, 'utf8'));
          if (fBars.length > 0) futuresClose = fBars[fBars.length - 1].close;
        }

        try {
          const contracts = JSON.parse(fs.readFileSync(parsedFile, 'utf8'));
          const hp = computeHP({
            date: dateStr,
            underlying: etf,
            futuresProxy,
            etfClose,
            futuresClose,
            contracts,
            dailyLogReturns: [],  // optional, non-critical for refresh
          });

          if (hp) {
            fs.writeFileSync(
              path.join(computedDir, `${dateStr}.json`),
              JSON.stringify(hp, null, 0),
              'utf8'
            );
            recomputed++;
          }
        } catch (err) {
          console.warn(`[HOURLY-REFRESH-HP] ${etf}/${dateStr}: HP compute failed: ${err.message}`);
        }
      }
    }

    console.log(`[HOURLY-REFRESH-HP] Recomputed HP for ${recomputed} date/ETF combinations`);
    return 'ok';

  } catch (err) {
    console.error(`[HOURLY-REFRESH-HP] Options refresh failed: ${err.message}`);
    return 'failed';
  }
}

// ── Full refresh ───────────────────────────────────────────────────────────────

/**
 * Refresh all CME futures symbols concurrently, then refresh options HP.
 *
 * @returns {Promise<Object>} { started, finished, results, optionsStatus }
 */
async function refreshAll() {
  const started = new Date().toISOString();
  console.log(`[HOURLY-REFRESH] Starting full refresh for ${CME_REFRESH_SYMBOLS.length} symbols`);

  _refreshStatus = { lastRun: started, status: 'running', results: [], error: null };

  try {
    // Refresh all CME symbols concurrently
    const results = await Promise.allSettled(
      CME_REFRESH_SYMBOLS.map(sym => refreshSymbol(sym))
    );

    const symbolResults = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { symbol: CME_REFRESH_SYMBOLS[i], datesRefreshed: [], barsTotal: 0, source: 'error', error: r.reason?.message };
    });

    // Refresh options HP
    const optionsStatus = await refreshOptions();

    // Purge all in-memory bars after all symbols refreshed
    try {
      purgeAllInvalidBars();
      console.log('[HOURLY-REFRESH] In-memory candle store purged and rebuilt');
    } catch (err) {
      console.warn(`[HOURLY-REFRESH] Post-refresh purge warning: ${err.message}`);
    }

    const finished = new Date().toISOString();
    const summary = { started, finished, results: symbolResults, optionsStatus };

    _refreshStatus = { lastRun: finished, status: 'done', results: symbolResults, error: null };

    const totalBars = symbolResults.reduce((sum, r) => sum + (r.barsTotal || 0), 0);
    const totalDates = symbolResults.reduce((sum, r) => sum + (r.datesRefreshed?.length || 0), 0);
    console.log(`[HOURLY-REFRESH] Full refresh complete: ${totalBars} bars across ${totalDates} dates, options: ${optionsStatus}`);

    return summary;

  } catch (err) {
    _refreshStatus = { lastRun: started, status: 'error', results: [], error: err.message };
    console.error(`[HOURLY-REFRESH] Full refresh failed: ${err.message}`);
    throw err;
  }
}

// ── Hourly scheduler ──────────────────────────────────────────────────────────

/**
 * Schedule the hourly refresh — runs every 60 minutes.
 * Called once at server startup.
 */
function scheduleHourlyRefresh() {
  // Clear any existing timers
  if (_nightlyTimer)    clearTimeout(_nightlyTimer);
  if (_nightlyInterval) clearInterval(_nightlyInterval);

  const HOUR_MS = 60 * 60 * 1000;

  console.log(`[HOURLY-REFRESH-SCHED] Hourly refresh scheduled (every 60 minutes, ${CME_REFRESH_SYMBOLS.length} symbols)`);

  // First run after 60 minutes, then every 60 minutes
  _nightlyInterval = setInterval(() => {
    // Skip if a refresh is already in progress
    if (_refreshStatus.status === 'running') {
      console.log('[HOURLY-REFRESH] Skipping — previous refresh still running');
      return;
    }
    console.log('[HOURLY-REFRESH-SCHED] Hourly refresh triggered');
    refreshAll().catch(err => {
      console.error('[HOURLY-REFRESH-SCHED] Hourly refresh error:', err.message);
    });
  }, HOUR_MS);
}

/**
 * Get the status of the last refresh run.
 */
function getRefreshStatus() {
  return { ..._refreshStatus };
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  fetchSymbol24h,
  fetchSymbol24hYahoo,
  refreshSymbol,
  refreshOptions,
  refreshAll,
  scheduleHourlyRefresh,
  getRefreshStatus,
  CME_REFRESH_SYMBOLS,
};
