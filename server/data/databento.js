'use strict';
// server/data/databento.js — Databento market data adapter
//
// Exports:
//   startLiveFeed(symbols, onCandle)               — fires onCandle(symbol, candle) on each 1m bar close
//   fetchHistoricalCandles(symbol, startIso, endIso) — returns sorted normalized candle array
//   getLiveFeedStatus()                            — returns connection/health state (used by B2 /api/datastatus)
//
// IMPLEMENTATION NOTE: Databento has no official Node.js client library. The planned
// @databento/client npm package does not exist. This adapter calls the Databento
// REST API (hist.databento.com) directly using Node.js built-in https module.
//
// Live feed is implemented as an aligned polling loop (every 65s, triggered just
// after each 1-minute bar close). For ohlcv-1m data this introduces zero additional
// latency — bars only close once per minute regardless of connection type.
// Exponential backoff is applied on API errors, matching the coinbaseWS.js pattern.
//
// Normalization contract (must match existing candle shape throughout the codebase):
//   { time: <Unix seconds>, open, high, low, close, volume }
//
// Databento wire format:
//   ts_event — nanoseconds since Unix epoch (or ISO 8601 string in JSON encoding)
//   open/high/low/close — fixed-point integers, divide by 1e9 to get price
//   volume — integer

const https = require('https');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIST_HOST = 'hist.databento.com';
const DATASET   = 'GLBX.MDP3';
const SCHEMA    = 'ohlcv-1m';

// Symbol map: internal symbol → Databento continuous front-month notation
// stype_in must be 'continuous' when using these symbols
//
// NOTE on MGC: Databento's GLBX.MDP3 dataset may not include MGC (Micro Gold, 10 oz) depending
// on your subscription. GC (full-size Gold, 100 oz) has the same underlying price (USD/troy oz)
// and is used as a proxy. OHLCV prices are identical; only the contract multiplier differs,
// which is handled separately by the scan engine (not the data layer).
const DATABENTO_SYMBOLS = {
  MNQ: 'MNQ.c.0',  // Micro E-mini Nasdaq-100, front month, calendar roll
  MES: 'MES.c.0',  // Micro E-mini S&P 500, front month, calendar roll
  MGC: 'GC.c.0',   // Micro Gold → uses GC (same price/oz, different lot size; verified 2026-04-03)
  MCL: 'MCL.c.0',  // Micro Crude Oil, front month, calendar roll
};

// Reverse map: Databento symbol → internal symbol (for parsing responses)
const REVERSE_SYMBOLS = Object.fromEntries(
  Object.entries(DATABENTO_SYMBOLS).map(([k, v]) => [v, k])
);

// Polling config
const POLL_INTERVAL_MS = 65_000;   // 65s — fires 5s after expected bar close
const BACKOFF_BASE_MS  = 10_000;
const BACKOFF_MAX_MS   = 300_000;  // 5 minutes

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Convert Databento ts_event to Unix seconds.
 * Handles both ISO 8601 string ("2024-01-15T14:30:00.000000000Z")
 * and nanosecond integer string ("1705329000000000000").
 */
function _tsToSeconds(ts) {
  const s = String(ts);
  if (s.includes('T')) {
    // ISO 8601 — Date.parse gives milliseconds, convert to seconds
    return Math.floor(Date.parse(s) / 1000);
  }
  // Nanosecond integer as string — string-based divide by 1e9 to avoid float precision loss
  // (nanosecond timestamps exceed Number.MAX_SAFE_INTEGER)
  if (s.length <= 9) return 0;
  return parseInt(s.slice(0, s.length - 9), 10);
}

/**
 * Convert Databento fixed-point price to float.
 * Values are integers × 1e9. For futures (e.g. MNQ ~20000), max value is
 * ~2e13 which is well within Number.MAX_SAFE_INTEGER (9e15), so Number() is safe.
 */
function _price(val) {
  return Number(val) / 1_000_000_000;
}

/**
 * Normalize a raw Databento JSON record to the codebase candle shape.
 *
 * Actual wire format (confirmed from live API, 2026-04-03):
 *   rec.hd.ts_event — nanosecond string, e.g. "1775136600000000000"
 *   rec.open/high/low/close — fixed-point strings, e.g. "23763250000000" (divide by 1e9)
 *   rec.volume — integer string, e.g. "13835"
 *   rec.hd.rtype — 33 for ohlcv-1m on GLBX.MDP3
 */
function _normalize(rec) {
  // ts_event is nested under rec.hd
  const tsEvent = rec.hd?.ts_event ?? rec.ts_event;
  return {
    time:   _tsToSeconds(tsEvent),
    open:   _price(rec.open),
    high:   _price(rec.high),
    low:    _price(rec.low),
    close:  _price(rec.close),
    volume: Number(rec.volume ?? 0),
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * GET request to Databento historical REST API.
 * Returns response body as string.
 * Authenticates via HTTP Basic Auth: API key as username, empty password.
 */
function _dbGet(path, apiKey) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const options = {
      hostname: HIST_HOST,
      path,
      method:   'GET',
      headers:  { 'Authorization': `Basic ${auth}` },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 401) {
        reject(new Error('Authentication failed — check DATABENTO_API_KEY'));
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        // Attempt to read error body for diagnostics
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 200);
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        });
        return;
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error('Request timed out after 30s'));
    });
    req.end();
  });
}

/**
 * Parse Databento JSON response.
 * Handles both JSON array ("[ {...}, ... ]") and NDJSON (one JSON object per line).
 */
function _parseBody(body) {
  const trimmed = body.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch (e) {
      console.warn('[databento] Failed to parse as JSON array:', e.message);
    }
  }

  // NDJSON — one record per line
  return trimmed
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
}

// ---------------------------------------------------------------------------
// fetchHistoricalCandles
// ---------------------------------------------------------------------------

/**
 * Fetch historical 1m candles from Databento REST API.
 *
 * @param {string} symbol   Internal symbol: 'MNQ', 'MES', 'MGC', 'MCL'
 * @param {string} startIso ISO 8601 start datetime, e.g. '2026-01-01T00:00:00Z'
 * @param {string} endIso   ISO 8601 end datetime
 * @returns {Promise<Array>} Sorted ascending array of { time, open, high, low, close, volume }
 */
async function fetchHistoricalCandles(symbol, startIso, endIso) {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    console.warn('[databento] DATABENTO_API_KEY not set — fetchHistoricalCandles returning []');
    return [];
  }

  const dbSym = DATABENTO_SYMBOLS[symbol];
  if (!dbSym) {
    console.warn(`[databento] No symbol mapping for '${symbol}' — supported: ${Object.keys(DATABENTO_SYMBOLS).join(', ')}`);
    return [];
  }

  const params = new URLSearchParams({
    dataset:  DATASET,
    schema:   SCHEMA,
    symbols:  dbSym,
    stype_in: 'continuous',
    start:    startIso,
    end:      endIso,
    encoding: 'json',
    limit:    '10000',
  });

  const path = `/v0/timeseries.get_range?${params.toString()}`;
  console.log(`[databento] fetchHistoricalCandles ${symbol} (${dbSym}) ${startIso} → ${endIso}`);

  try {
    const body    = await _dbGet(path, apiKey);
    const records = _parseBody(body);

    if (!Array.isArray(records) || records.length === 0) {
      console.warn(`[databento] fetchHistoricalCandles(${symbol}): empty response`);
      return [];
    }

    const candles = records
      .filter(r => r && (r.hd?.ts_event ?? r.ts_event) != null && r.open != null)
      .map(_normalize)
      .filter(c => c.time > 0)
      .sort((a, b) => a.time - b.time);

    console.log(`[databento] fetchHistoricalCandles(${symbol}): ${candles.length} candles returned`);
    return candles;

  } catch (err) {
    console.warn(`[databento] fetchHistoricalCandles(${symbol}) error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// startLiveFeed — aligned polling loop
// ---------------------------------------------------------------------------

// State visible to getLiveFeedStatus()
let _connected   = false;
let _lastPollMs  = null;                  // Date.now() at last successful poll
let _lastBarTime = {};                    // symbol → Unix seconds of last emitted bar
let _pollTimer   = null;
let _symbols     = [];
let _onCandle    = null;

let _failCount    = 0;
let _backoffDelay = BACKOFF_BASE_MS;

/**
 * Start the live 1m candle feed for the given symbols.
 * Calls onCandle(symbol, candle) for each new completed bar.
 * First poll is aligned to 5s after the next round-minute boundary.
 *
 * @param {string[]} symbols  Internal symbols: ['MNQ', 'MES', 'MGC', 'MCL']
 * @param {Function} onCandle Callback: (symbol, { time, open, high, low, close, volume })
 */
function startLiveFeed(symbols, onCandle) {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    console.warn('[databento] DATABENTO_API_KEY not set — live feed disabled');
    return;
  }

  _symbols  = symbols.filter(s => DATABENTO_SYMBOLS[s]);
  _onCandle = onCandle;

  const unsupported = symbols.filter(s => !DATABENTO_SYMBOLS[s]);
  if (unsupported.length > 0) {
    console.warn(`[databento] startLiveFeed: ignoring unsupported symbols: ${unsupported.join(', ')}`);
  }
  if (_symbols.length === 0) {
    console.warn('[databento] startLiveFeed: no valid symbols — live feed not started');
    return;
  }

  console.log(`[databento] Live feed starting for ${_symbols.join(', ')}`);
  console.log(`[databento] Using Databento symbols: ${_symbols.map(s => DATABENTO_SYMBOLS[s]).join(', ')}`);
  console.log(`[databento] Poll interval: ${POLL_INTERVAL_MS / 1000}s, aligned to bar close`);

  // Schedule first poll 5s after the next round-minute boundary
  const now         = Date.now();
  const nextMinMs   = Math.ceil(now / 60_000) * 60_000;
  const initialWait = (nextMinMs - now) + 5_000;

  console.log(`[databento] First poll in ${Math.round(initialWait / 1000)}s (at ${new Date(nextMinMs + 5000).toISOString()})`);
  _pollTimer = setTimeout(() => _doPoll(), initialWait);
}

async function _doPoll() {
  if (!_symbols || _symbols.length === 0) return;

  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    console.warn('[databento] DATABENTO_API_KEY removed — stopping live feed');
    return;
  }

  const nowIso = new Date().toISOString();
  let   anyError = false;

  console.log(`[databento] Poll at ${nowIso}`);

  for (const symbol of _symbols) {
    const dbSym = DATABENTO_SYMBOLS[symbol];
    if (!dbSym) continue;

    // Request window: from 1s past last emitted bar, or 10 minutes ago on first poll
    const lastSecs = _lastBarTime[symbol] ?? (Math.floor(Date.now() / 1000) - 600);
    const startIso = new Date((lastSecs + 1) * 1000).toISOString();

    const params = new URLSearchParams({
      dataset:  DATASET,
      schema:   SCHEMA,
      symbols:  dbSym,
      stype_in: 'continuous',
      start:    startIso,
      end:      nowIso,
      encoding: 'json',
      limit:    '20',   // expect 1–2 bars per poll; 20 handles any catchup on reconnect
    });

    try {
      const body    = await _dbGet(`/v0/timeseries.get_range?${params.toString()}`, apiKey);
      const records = _parseBody(body);
      const candles = records
        .filter(r => r && (r.hd?.ts_event ?? r.ts_event) != null && r.open != null)
        .map(_normalize)
        .filter(c => c.time > 0)
        .sort((a, b) => a.time - b.time);

      let newBars = 0;
      for (const candle of candles) {
        const prev = _lastBarTime[symbol] ?? 0;
        if (candle.time > prev) {
          _lastBarTime[symbol] = candle.time;
          _onCandle(symbol, candle);
          newBars++;
          console.log(
            `[databento] ▶ ${symbol} bar t=${new Date(candle.time * 1000).toISOString()} ` +
            `O=${candle.open.toFixed(2)} H=${candle.high.toFixed(2)} ` +
            `L=${candle.low.toFixed(2)} C=${candle.close.toFixed(2)} V=${candle.volume}`
          );
        }
      }
      if (newBars === 0) {
        console.log(`[databento] ${symbol}: no new bars this poll`);
      }

    } catch (err) {
      console.error(`[databento] Poll error for ${symbol}: ${err.message}`);
      anyError = true;
    }
  }

  _lastPollMs = Date.now();

  if (anyError) {
    _connected = false;
    _failCount++;
    _backoffDelay = Math.min(_backoffDelay * 2, BACKOFF_MAX_MS);
    console.warn(`[databento] Poll failed (${_failCount} consecutive error(s)) — retrying in ${_backoffDelay / 1000}s`);
    _pollTimer = setTimeout(() => _doPoll(), _backoffDelay);
  } else {
    _connected    = true;
    _failCount    = 0;
    _backoffDelay = BACKOFF_BASE_MS;
    _pollTimer    = setTimeout(() => _doPoll(), POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// getLiveFeedStatus — consumed by B2 /api/datastatus route
// ---------------------------------------------------------------------------

/**
 * Returns the current live feed health state.
 */
function getLiveFeedStatus() {
  const nowMs    = Date.now();
  const lagMs    = _lastPollMs ? (nowMs - _lastPollMs) : null;
  const lagSecs  = lagMs !== null ? Math.round(lagMs / 1000) : null;

  return {
    connected:    _connected,
    lagSeconds:   lagSecs,
    lastPollTime: _lastPollMs ? new Date(_lastPollMs).toISOString() : null,
    lastBarTimes: Object.fromEntries(
      Object.entries(_lastBarTime).map(([sym, ts]) => [sym, new Date(ts * 1000).toISOString()])
    ),
    symbols: _symbols,
  };
}

// ---------------------------------------------------------------------------
// fetchETFDailyCloses — daily OHLCV for US equity ETFs
// ---------------------------------------------------------------------------

/**
 * Fetch daily OHLCV bars for a US equity ETF from Databento.
 *
 * Dataset: DBEQ.BASIC (Databento US Equities consolidated, daily bars)
 *   — Override via DATABENTO_EQUITY_DATASET env var if your subscription uses
 *     a different dataset (e.g. ARCX.PILLAR for NYSE Arca-listed ETFs).
 *
 * Symbols: raw equity ticker, e.g. 'QQQ', 'SPY', 'GLD'.
 *   stype_in = 'raw_symbol' for US equity tickers on equity datasets.
 *
 * Prices: same Databento fixed-point convention as futures (÷ 1e9).
 *
 * @param {string} ticker    Equity ticker, e.g. 'QQQ'
 * @param {string} startIso  ISO 8601 start, e.g. '2013-01-01T00:00:00Z'
 * @param {string} endIso    ISO 8601 end,   e.g. '2026-04-02T00:00:00Z'
 * @returns {Promise<Object>} { 'YYYY-MM-DD': closePrice, ... } — UTC date from ts_event
 */
async function fetchETFDailyCloses(ticker, startIso, endIso) {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    console.warn('[databento] DATABENTO_API_KEY not set — fetchETFDailyCloses returning {}');
    return {};
  }

  const dataset = process.env.DATABENTO_EQUITY_DATASET || 'DBEQ.BASIC';

  const params = new URLSearchParams({
    dataset,
    schema:   'ohlcv-1d',
    symbols:  ticker,
    stype_in: 'raw_symbol',
    start:    startIso,
    end:      endIso,
    encoding: 'json',
  });

  const path = `/v0/timeseries.get_range?${params.toString()}`;
  console.log(`[databento] fetchETFDailyCloses ${ticker} (${dataset}) ${startIso} → ${endIso}`);

  try {
    const body    = await _dbGet(path, apiKey);
    const records = _parseBody(body);

    if (!Array.isArray(records) || records.length === 0) {
      console.warn(`[databento] fetchETFDailyCloses(${ticker}): empty response`);
      return {};
    }

    const closes = {};
    for (const r of records) {
      if (!r || r.close == null) continue;
      const tsEvent = r.hd?.ts_event ?? r.ts_event;
      if (!tsEvent) continue;

      // Convert ts_event to UTC date string 'YYYY-MM-DD'
      // Daily bars: ts_event is the bar open timestamp (e.g. midnight or 9:30 AM UTC)
      const tsMs   = typeof tsEvent === 'string' && tsEvent.includes('T')
        ? Date.parse(tsEvent)
        : Number(BigInt(String(tsEvent)) / 1_000_000n);
      const date   = new Date(tsMs).toISOString().substring(0, 10);
      const close  = _price(r.close);
      if (close > 0) closes[date] = +close.toFixed(4);
    }

    console.log(`[databento] fetchETFDailyCloses(${ticker}): ${Object.keys(closes).length} daily closes`);
    return closes;

  } catch (err) {
    console.warn(`[databento] fetchETFDailyCloses(${ticker}) error: ${err.message}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { startLiveFeed, fetchHistoricalCandles, getLiveFeedStatus, fetchETFDailyCloses };
