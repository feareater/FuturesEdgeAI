'use strict';
// OHLCV fetch + candle normalization — source-agnostic interface.
//
// All other modules call getCandles() / getAllTimeframes() only.
// The data source beneath is determined by DATA_SOURCE (default: 'seed').
//
//   seed      → reads from data/seed/*.json  (run seedFetch.js first)
//   ironbeam  → Ironbeam REST + WebSocket (Phase 3+)
//   databento → Databento HTTP API        (Phase 3+)

const fs   = require('fs');
const path = require('path');

const DATA_SOURCE  = process.env.DATA_SOURCE ?? 'seed';
const SEED_DIR     = path.join(__dirname, '..', '..', 'data', 'seed');

const VALID_SYMBOLS    = ['MNQ', 'MGC', 'MES', 'MCL', 'BTC', 'ETH', 'XRP', 'XLM', 'SIL', 'DXY', 'VIX', 'QQQ', 'SPY'];
const VALID_TIMEFRAMES = ['1m', '2m', '3m', '5m', '15m', '30m', '1h', '2h', '4h'];
const CRYPTO_SYMBOLS   = new Set(['BTC', 'ETH', 'XRP', 'XLM']);
// Macro/reference symbols — context-only data sources. Must never trigger setup detection,
// volume profile, opening range, or session level computation.
const MACRO_SYMBOLS    = new Set(['DXY', 'VIX', 'QQQ', 'SPY', 'GLD', 'USO', 'SLV']);

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

module.exports = { getCandles, getAllTimeframes, VALID_SYMBOLS, VALID_TIMEFRAMES, CRYPTO_SYMBOLS, MACRO_SYMBOLS };
