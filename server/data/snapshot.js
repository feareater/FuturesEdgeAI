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

const VALID_SYMBOLS    = ['MNQ', 'MGC'];
const VALID_TIMEFRAMES = ['1m', '2m', '3m', '5m', '15m'];

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
 * Returns candles for all five active timeframes for a symbol.
 * Shape: { '1m': [...], '2m': [...], '3m': [...], '5m': [...], '15m': [...] }
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
    throw new Error(
      `Seed file not found: ${filePath}\n` +
      `Run "node server/data/seedFetch.js" to populate seed data.`
    );
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return data.candles;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _validate(symbol, timeframe) {
  if (!VALID_SYMBOLS.includes(symbol))    throw new Error(`Unknown symbol: ${symbol}`);
  if (!VALID_TIMEFRAMES.includes(timeframe)) throw new Error(`Unknown timeframe: ${timeframe}`);
}

// ---------------------------------------------------------------------------

module.exports = { getCandles, getAllTimeframes, VALID_SYMBOLS, VALID_TIMEFRAMES };
