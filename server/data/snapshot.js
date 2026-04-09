'use strict';
// OHLCV fetch + candle normalization — source-agnostic interface.
//
// All other modules call getCandles() / getAllTimeframes() only.
// The data source beneath is determined by DATA_SOURCE (default: 'seed').
//
//   seed      → reads from data/seed/*.json  (run seedFetch.js first)
//   ironbeam  → Ironbeam REST + WebSocket (Phase 3+)
//   databento → Databento HTTP API        (Phase 3+)
//
// Live mode (features.liveData: true):
//   writeLiveCandle(symbol, candle) — called by databento.js on each 1m bar close
//   getCandles() returns from in-memory liveCandles store for futures symbols
//   Hot-toggle: POST /api/features { "liveData": true } — no restart needed

const fs   = require('fs');
const path = require('path');

const DATA_SOURCE  = process.env.DATA_SOURCE ?? 'seed';
const SEED_DIR     = path.join(__dirname, '..', '..', 'data', 'seed');
const SETTINGS_FILE = path.join(__dirname, '..', '..', 'config', 'settings.json');

const VALID_SYMBOLS    = [
  // Tradeable futures
  'MNQ', 'MGC', 'MES', 'MCL', 'SIL', 'M2K', 'MYM', 'MHG',
  // Crypto perpetuals (Coinbase INTX)
  'BTC', 'ETH', 'XRP', 'XLM',
  // Reference — charts + breadth, no setup scanning
  'M6E', 'M6B', 'MBT', 'ZT', 'ZF', 'ZN', 'ZB', 'UB',
  // Macro context
  'DXY', 'VIX', 'QQQ', 'SPY',
];
const VALID_TIMEFRAMES = ['1m', '2m', '3m', '5m', '15m', '30m', '1h', '2h', '4h'];
const CRYPTO_SYMBOLS   = new Set(['BTC', 'ETH', 'XRP', 'XLM']);
// Macro/reference symbols — context-only data sources. Must never trigger setup detection,
// volume profile, opening range, or session level computation.
const MACRO_SYMBOLS    = new Set([
  'DXY', 'VIX', 'QQQ', 'SPY', 'GLD', 'USO', 'SLV',
  // Reference instruments — breadth/chart only
  'M6E', 'M6B', 'MBT', 'ZT', 'ZF', 'ZN', 'ZB', 'UB',
]);
// Futures symbols supported by the Databento live feed
const LIVE_FUTURES     = new Set(['MNQ', 'MES', 'MGC', 'MCL', 'M2K', 'MYM', 'SIL', 'MHG']);

// ---------------------------------------------------------------------------
// Live in-memory candle store (populated by writeLiveCandle from databento.js)
// Key: `${symbol}:${tf}`, Value: candle[] sorted ascending
// 1m bars stored directly; 5m/15m/30m aggregated on each writeLiveCandle call.
// ---------------------------------------------------------------------------

const liveCandles    = new Map();   // live bar store
const MAX_LIVE_BARS  = 500;         // ~8 hours of 1m bars per symbol

// Settings cache — re-read every 5s so POST /api/features hot-toggle works
let _settingsCache   = null;
let _settingsCacheTs = 0;

function _isLiveMode() {
  const now = Date.now();
  if (now - _settingsCacheTs > 5_000) {
    try {
      _settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {}
    _settingsCacheTs = now;
  }
  return _settingsCache?.features?.liveData === true;
}

// ---------------------------------------------------------------------------
// Public interface — these signatures stay constant regardless of data source
// ---------------------------------------------------------------------------

/**
 * Returns the normalized candle array for one symbol + timeframe.
 *
 * Candle shape: { time, open, high, low, close, volume }
 *   time — Unix timestamp in seconds (TradingView Lightweight Charts format)
 */
function getCandles(symbol, timeframe) {
  _validate(symbol, timeframe);

  // Live gate: futures symbols merge seed history with live bars when liveData is enabled.
  // Seed data provides the historical backdrop; live bars extend it with bars newer than
  // the last seed candle. This ensures the chart always shows full history even when only
  // a handful of live bars have arrived since server start.
  if (_isLiveMode() && LIVE_FUTURES.has(symbol)) {
    const live = liveCandles.get(`${symbol}:${timeframe}`);
    let seed;
    try { seed = _fromSeed(symbol, timeframe); } catch { seed = []; }

    // Strip non-aligned Yahoo partial bar (last bar often has odd timestamp like :01:22)
    const tfSec = _TF_SECONDS[timeframe] ?? 60;
    seed = seed.filter(c => c.time % tfSec === 0);

    if (!live || live.length === 0) {
      // No live bars yet — return seed only (startup / reconnect gap)
      if (seed.length === 0) console.log(`[snapshot] Live store empty for ${symbol}:${timeframe} — falling back to seed data`);
      return seed;
    }

    // DEFENSIVE COPY: return cloned candle objects so callers (scans, chart)
    // never hold mutable references into the live store.
    if (seed.length === 0) return live.map(c => ({ ...c }));

    // Full merge: live bars take priority where they exist; seed bars fill in
    // everywhere else (including gaps in the live feed). This replaces the old
    // "seed before firstLiveTime, live after" strategy which discarded seed bars
    // that fell within live feed gaps.
    const liveTimes = new Set(live.map(c => c.time));
    const seedFill  = seed.filter(c => !liveTimes.has(c.time));
    const merged    = [...seedFill, ...live.map(c => ({ ...c }))].sort((a, b) => a.time - b.time);

    return merged;
  }

  switch (DATA_SOURCE) {
    case 'seed':      return _fromSeed(symbol, timeframe);
    case 'ironbeam':  throw new Error('Ironbeam source not yet implemented');
    case 'databento': throw new Error('Databento source not yet implemented');
    default:          throw new Error(`Unknown DATA_SOURCE: ${DATA_SOURCE}`);
  }
}

/**
 * Returns candles for all active timeframes for a symbol.
 * Shape: { '1m': [...], '2m': [...], '3m': [...], '5m': [...], '15m': [...], '30m': [...] }
 */
function getAllTimeframes(symbol) {
  if (!VALID_SYMBOLS.includes(symbol)) throw new Error(`Unknown symbol: ${symbol}`);
  return Object.fromEntries(
    VALID_TIMEFRAMES.map(tf => [tf, getCandles(symbol, tf)])
  );
}

// ---------------------------------------------------------------------------
// Seed source
// ---------------------------------------------------------------------------

function _fromSeed(symbol, timeframe) {
  const filePath = path.join(SEED_DIR, `${symbol}_${timeframe}.json`);

  if (!fs.existsSync(filePath)) {
    // Derived timeframes: compute on-the-fly from finer-grained seed data
    if (timeframe === '3m') {
      const oneM = _fromSeed(symbol, '1m');
      return _aggregateCandles(oneM, 3);
    }
    if (timeframe === '30m') {
      const fiveM = _fromSeed(symbol, '5m');
      return _aggregateCandles(fiveM, 6);
    }
    if (timeframe === '2h') {
      const oneH = _fromSeed(symbol, '1h');
      return _aggregateCandles(oneH, 2);
    }
    if (timeframe === '4h') {
      const oneH = _fromSeed(symbol, '1h');
      return _aggregateCandles(oneH, 4);
    }
    throw new Error(
      `Seed file not found: ${filePath}\n` +
      `Run "node server/data/seedFetch.js" to populate seed data.`
    );
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return data.candles;
}

// Aggregate n consecutive candles into one bar (used for derived timeframes)
function _aggregateCandles(candles, n) {
  const result = [];
  for (let i = 0; i < candles.length; i += n) {
    const slice = candles.slice(i, i + n);
    if (!slice.length) continue;
    result.push({
      time:   slice[0].time,
      open:   slice[0].open,
      high:   Math.max(...slice.map(c => c.high)),
      low:    Math.min(...slice.map(c => c.low)),
      close:  slice[slice.length - 1].close,
      volume: slice.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return result;
}

// Aggregate an array of 1m bars into a single higher-TF candle aligned to tfSeconds window.
// Returns the aggregated candle if all bars share the same window, otherwise null.
function _mergeWindow(bars, tfSeconds) {
  if (!bars.length) return null;
  const windowStart = Math.floor(bars[0].time / tfSeconds) * tfSeconds;
  return {
    time:   windowStart,
    open:   bars[0].open,
    high:   Math.max(...bars.map(c => c.high)),
    low:    Math.min(...bars.map(c => c.low)),
    close:  bars[bars.length - 1].close,
    volume: bars.reduce((sum, c) => sum + c.volume, 0),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _validate(symbol, timeframe) {
  if (!VALID_SYMBOLS.includes(symbol))    throw new Error(`Unknown symbol: ${symbol}`);
  if (!VALID_TIMEFRAMES.includes(timeframe)) throw new Error(`Unknown timeframe: ${timeframe}`);
}

// TF seconds lookup — used for timestamp alignment filtering
const _TF_SECONDS = { '1m': 60, '2m': 120, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400 };

// Higher-TF aggregation config for live mode
const LIVE_AGG_TFS = [
  { tf: '5m',  seconds: 300  },
  { tf: '15m', seconds: 900  },
  { tf: '30m', seconds: 1800 },
];

// ---------------------------------------------------------------------------
// Live candle writer — called by databento.js on each 1m bar close
// ---------------------------------------------------------------------------

/**
 * Store an incoming live 1m bar and emit completed higher-TF bars.
 *
 * @param {string} symbol  Internal symbol, e.g. 'MNQ'
 * @param {Object} candle  Normalized { time, open, high, low, close, volume }
 * @returns {Array}  List of { tf, candle } objects for each completed higher-TF window
 */
function writeLiveCandle(symbol, candle) {
  if (!LIVE_FUTURES.has(symbol)) return [];

  // Store 1m bar
  const key1m = `${symbol}:1m`;
  const bars = liveCandles.get(key1m) ?? [];

  // Avoid duplicate (same timestamp already stored)
  if (bars.length > 0 && bars[bars.length - 1].time === candle.time) return [];

  bars.push(candle);

  // Trim to max window size (drop oldest bars)
  if (bars.length > MAX_LIVE_BARS) bars.splice(0, bars.length - MAX_LIVE_BARS);

  liveCandles.set(key1m, bars);

  // Aggregate into higher TFs — emit a bar when its window just closed
  const completed = [];
  for (const { tf, seconds } of LIVE_AGG_TFS) {
    const keyTf = `${symbol}:${tf}`;
    const prevBars = liveCandles.get(keyTf) ?? [];

    // Determine the window this new 1m bar belongs to
    const windowStart = Math.floor(candle.time / seconds) * seconds;

    // Collect all 1m bars in this window
    const windowBars = bars.filter(b => Math.floor(b.time / seconds) * seconds === windowStart);

    // Window is complete when the next bar would fall in the next window.
    // The candle that just arrived (candle.time) is the last 1m of the window
    // if the NEXT minute (candle.time + 60) falls in a different window.
    const nextMinuteWindow = Math.floor((candle.time + 60) / seconds) * seconds;
    const windowClosed = nextMinuteWindow !== windowStart;

    if (windowClosed && windowBars.length > 0) {
      const agg = _mergeWindow(windowBars, seconds);

      // If a partial bar exists for this window, REPLACE it with the completed bar.
      // Previously the alreadyStored check skipped the completed bar entirely,
      // causing the last 1m bar of every window to be excluded from the aggregate.
      if (prevBars.length > 0 && prevBars[prevBars.length - 1].time === agg.time) {
        prevBars[prevBars.length - 1] = { ...agg };
      } else {
        prevBars.push({ ...agg });
        if (prevBars.length > MAX_LIVE_BARS) prevBars.splice(0, prevBars.length - MAX_LIVE_BARS);
      }
      liveCandles.set(keyTf, prevBars);
      // Return a CLONE so broadcast recipients don't hold mutable references
      completed.push({ tf, candle: { ...agg } });
    } else if (!windowClosed && windowBars.length > 0) {
      // Update the in-progress bar (replace last if same window, otherwise push)
      const partial = _mergeWindow(windowBars, seconds);
      if (prevBars.length > 0 && prevBars[prevBars.length - 1].time === partial.time) {
        // Replace with a NEW object — never mutate an object that may be referenced externally
        prevBars[prevBars.length - 1] = { ...partial };
      } else {
        prevBars.push({ ...partial });
        if (prevBars.length > MAX_LIVE_BARS) prevBars.splice(0, prevBars.length - MAX_LIVE_BARS);
      }
      liveCandles.set(keyTf, prevBars);
    }
  }

  return completed;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bar injection — used by gapFill.js to backfill missing bars into the store
// ---------------------------------------------------------------------------

/**
 * Inject an array of candle bars into the live candle store for a given symbol/TF.
 * Merges with existing bars, deduplicates by timestamp, and trims to MAX_LIVE_BARS.
 *
 * @param {string} symbol  Internal symbol, e.g. 'MNQ'
 * @param {string} tf      Timeframe, e.g. '1m', '5m'
 * @param {Array}  bars    Array of { time, open, high, low, close, volume }
 * @returns {number} Number of new bars actually inserted
 */
function injectBars(symbol, tf, bars) {
  if (!bars || bars.length === 0) return 0;

  const key = `${symbol}:${tf}`;
  const existing = liveCandles.get(key) ?? [];
  const existingTimes = new Set(existing.map(b => b.time));
  const toAdd = bars.filter(b => !existingTimes.has(b.time));
  if (toAdd.length === 0) return 0;

  const merged = [...existing, ...toAdd].sort((a, b) => a.time - b.time);
  if (merged.length > MAX_LIVE_BARS) merged.splice(0, merged.length - MAX_LIVE_BARS);
  liveCandles.set(key, merged);
  return toAdd.length;
}

/**
 * Aggregate an array of 1m bars into higher-TF bars using window-aligned logic.
 * Returns the aggregated bar array for the given TF seconds.
 */
function aggregateBarsToTF(bars1m, tfSeconds) {
  if (!bars1m || bars1m.length === 0) return [];

  // Group bars by window
  const windows = new Map();
  for (const bar of bars1m) {
    const windowStart = Math.floor(bar.time / tfSeconds) * tfSeconds;
    if (!windows.has(windowStart)) windows.set(windowStart, []);
    windows.get(windowStart).push(bar);
  }

  // Merge each window into a single bar
  const result = [];
  for (const [windowStart, windowBars] of windows) {
    result.push({
      time:   windowStart,
      open:   windowBars[0].open,
      high:   Math.max(...windowBars.map(c => c.high)),
      low:    Math.min(...windowBars.map(c => c.low)),
      close:  windowBars[windowBars.length - 1].close,
      volume: windowBars.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return result.sort((a, b) => a.time - b.time);
}

module.exports = {
  getCandles, getAllTimeframes, writeLiveCandle, injectBars, aggregateBarsToTF,
  VALID_SYMBOLS, VALID_TIMEFRAMES, CRYPTO_SYMBOLS, MACRO_SYMBOLS, LIVE_FUTURES,
};
