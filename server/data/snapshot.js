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

const VALID_SYMBOLS    = ['MNQ', 'MGC', 'MES', 'MCL', 'BTC', 'ETH', 'XRP', 'XLM', 'SIL', 'DXY', 'VIX', 'QQQ', 'SPY'];
const VALID_TIMEFRAMES = ['1m', '2m', '3m', '5m', '15m', '30m', '1h', '2h', '4h'];
const CRYPTO_SYMBOLS   = new Set(['BTC', 'ETH', 'XRP', 'XLM']);
// Macro/reference symbols — context-only data sources. Must never trigger setup detection,
// volume profile, opening range, or session level computation.
const MACRO_SYMBOLS    = new Set(['DXY', 'VIX', 'QQQ', 'SPY', 'GLD', 'USO', 'SLV']);
// Futures symbols supported by the Databento live feed
const LIVE_FUTURES     = new Set(['MNQ', 'MES', 'MGC', 'MCL']);

// ---------------------------------------------------------------------------
// Live in-memory candle store (populated by writeLiveCandle from databento.js)
// Key: `${symbol}:${tf}`, Value: candle[] sorted ascending
// In B2: only 1m bars are stored. B3 adds aggregated 5m/15m/30m.
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

  // Live gate: futures symbols use the in-memory live store when liveData is enabled
  if (_isLiveMode() && LIVE_FUTURES.has(symbol)) {
    return liveCandles.get(`${symbol}:${timeframe}`) ?? [];
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _validate(symbol, timeframe) {
  if (!VALID_SYMBOLS.includes(symbol))    throw new Error(`Unknown symbol: ${symbol}`);
  if (!VALID_TIMEFRAMES.includes(timeframe)) throw new Error(`Unknown timeframe: ${timeframe}`);
}

// ---------------------------------------------------------------------------
// Live candle writer — called by databento.js on each 1m bar close
// ---------------------------------------------------------------------------

/**
 * Store an incoming live 1m bar.
 * B3 will extend this to also emit aggregated 5m/15m/30m bars when windows close.
 *
 * @param {string} symbol  Internal symbol, e.g. 'MNQ'
 * @param {Object} candle  Normalized { time, open, high, low, close, volume }
 * @returns {Array}  List of completed higher-TF bar objects { tf, candle } — always [] in B2
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

  // B3 will add aggregation here and return completed higher-TF bars
  return [];
}

// ---------------------------------------------------------------------------

module.exports = { getCandles, getAllTimeframes, writeLiveCandle, VALID_SYMBOLS, VALID_TIMEFRAMES, CRYPTO_SYMBOLS, MACRO_SYMBOLS };
