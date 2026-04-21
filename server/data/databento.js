'use strict';
// server/data/databento.js — Databento market data adapter
//
// Exports:
//   startLiveFeed(symbols, onCandle, onTick, onReconnect) — fires callbacks on bar close, tick, and reconnect
//   stopLiveFeed()                                 — close TCP connection and cancel reconnect
//   fetchHistoricalCandles(symbol, startIso, endIso) — returns sorted normalized candle array
//   getLiveFeedStatus()                            — returns connection/health state (used by B2 /api/datastatus)
//   fetchETFDailyCloses(ticker, startIso, endIso)  — returns { 'YYYY-MM-DD': close } for equity ETFs
//
// LIVE FEED — Databento TCP Live API (glbx-mdp3.lsg.databento.com:13000)
//   Authentication: CRAM challenge-response (SHA256("<challenge>|<apiKey>") hex + "-" + last5ofKey)
//   Protocol: line-delimited JSON; state machine: version → cram → auth_response → streaming
//   Subscription: stype_in=parent with {MNQ,MES,GC,MCL}.FUT parent symbols
//   Records: rtype=19 (instrument definition → build instrumentId→symbol map)
//            rtype=32 (ohlcv-1m bar → normalize and emit via onCandle callback)
//
// HISTORICAL FEED — Databento REST API (hist.databento.com)
//   Used by historicalPipeline.js and fetchETFDailyCloses. Unchanged from v12.0.
//
// Normalization contract (must match existing candle shape throughout the codebase):
//   { time: <Unix seconds>, open, high, low, close, volume }
//
// Databento wire format:
//   ts_event — nanoseconds since Unix epoch (or ISO 8601 string in JSON encoding)
//   open/high/low/close — fixed-point integers, divide by 1e9 to get price
//   volume — integer

const https    = require('https');
const net      = require('net');
const readline = require('readline');
const crypto   = require('crypto');

// ---------------------------------------------------------------------------
// Constants — historical REST
// ---------------------------------------------------------------------------

const HIST_HOST = 'hist.databento.com';
const DATASET   = 'GLBX.MDP3';
const SCHEMA    = 'ohlcv-1m';

// Symbol map: internal symbol → Databento continuous front-month notation
// (used by historical REST — stype_in='continuous')
const DATABENTO_SYMBOLS = {
  MNQ: 'MNQ.c.0',  // Micro E-mini Nasdaq-100, front month, calendar roll
  MES: 'MES.c.0',  // Micro E-mini S&P 500, front month, calendar roll
  MGC: 'GC.c.0',   // Micro Gold → uses GC (same price/oz, different lot size; verified 2026-04-03)
  MCL: 'MCL.c.0',  // Micro Crude Oil, front month, calendar roll
};

// ---------------------------------------------------------------------------
// Constants — TCP Live API
// ---------------------------------------------------------------------------

const LIVE_HOST    = 'glbx-mdp3.lsg.databento.com';
const LIVE_PORT    = 13000;

// Parent symbols for stype_in=parent subscription.
// GC.FUT is the parent for both GC and MGC — we receive definition records for all
// GC-family contracts and map those whose root is 'GC' to internal symbol 'MGC'.
const LIVE_SUBSCRIBE_SYMBOLS = 'MNQ.FUT,MES.FUT,GC.FUT,MCL.FUT,M2K.FUT,MYM.FUT,SI.FUT,HG.FUT';

// Map Databento root (extracted from raw_symbol, e.g. "MNQH6" → "MNQ") to internal symbol.
// GC contracts (full-size Gold) are mapped to MGC — same underlying price, different multiplier.
const ROOT_TO_INTERNAL = {
  MNQ: 'MNQ',
  MES: 'MES',
  GC:  'MGC',
  MCL: 'MCL',
  M2K: 'M2K',
  MYM: 'MYM',
  SI:  'SIL',
  HG:  'MHG',
};

// Regex to extract root from a raw_symbol like "MNQH6", "MESH6", "GCJ6", "MCLK6"
const RAW_SYMBOL_ROOT_RE = /^([A-Z]+)[A-Z]\d+$/;

// Reconnect config
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 300_000;  // 5 minutes

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
 * Returns null if the bar fails OHLC sanity checks.
 */
function _normalize(rec) {
  const tsEvent = rec.hd?.ts_event ?? rec.ts_event;
  const candle = {
    time:   _tsToSeconds(tsEvent),
    open:   _price(rec.open),
    high:   _price(rec.high),
    low:    _price(rec.low),
    close:  _price(rec.close),
    volume: Number(rec.volume ?? 0),
  };

  // OHLC sanity: high must be >= low, all prices positive
  if (candle.high < candle.low || candle.open <= 0 || candle.close <= 0) {
    console.warn(`[databento] Rejected bar — invalid OHLC: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close}`);
    return null;
  }

  return candle;
}

// Phase 0 emergency (v14.33): hard sanity floor — rejects any tick/bar whose
// price is more than ±25% from the last validated price. Independent of the
// per-symbol rolling-median filter, so it still catches bad ticks when the
// rolling median itself has been corrupted by prior bad ticks (the MCL
// $1.55 case from the 2026-04-21 audit). Belt-and-suspenders.
const HARD_FLOOR_LOW  = 0.75;
const HARD_FLOOR_HIGH = 1.25;

function _isHardFloorRejection(symbol, price) {
  const prev = _lastGoodPrice[symbol];
  if (!prev || prev <= 0) return false; // cold start / reconnect — skip, accept
  const ratio = price / prev;
  if (ratio < HARD_FLOOR_LOW || ratio > HARD_FLOOR_HIGH) {
    console.warn(
      `[SPIKE-FLOOR] rejected ${symbol} close=${price} prev=${prev} ratio=${ratio.toFixed(4)}`
    );
    return true;
  }
  return false;
}

/**
 * Check if a price is a spike relative to the rolling median for a symbol.
 * Uses a 10-tick rolling median as reference instead of a single prior price,
 * preventing staircase corruption where one bad tick shifts the baseline.
 * Returns true if the price should be REJECTED (i.e. it's a phantom spike).
 */
function _isSpikePrice(symbol, price) {
  // Phase 0 hard floor runs BEFORE the rolling-median filter (see above).
  if (_isHardFloorRejection(symbol, price)) return true;

  const median = _getRollingMedian(symbol);
  if (median === null) {
    // Buffer warming up — also check against last good price as fallback
    const prev = _lastGoodPrice[symbol];
    if (!prev) return false;  // no reference yet — accept
    const threshold = TICK_SPIKE_THRESHOLD[symbol] || DEFAULT_TICK_THRESHOLD;
    return Math.abs(price - prev) / prev > threshold;
  }
  const threshold = TICK_SPIKE_THRESHOLD[symbol] || DEFAULT_TICK_THRESHOLD;
  const deviation = Math.abs(price - median) / median;
  if (deviation > threshold) {
    console.warn(
      `[SPIKE-1S] ${symbol} rejected tick ${price} ` +
      `(median=${median.toFixed(4)}, dev=${(deviation * 100).toFixed(2)}%)`
    );
    return true; // is a spike, reject it
  }
  return false;
}

/**
 * Accept a price as the new "last known good" reference for a symbol.
 * Also updates the rolling price buffer for median computation.
 */
function _acceptPrice(symbol, price) {
  _lastGoodPrice[symbol] = price;
  _updatePriceBuffer(symbol, price);
}

// ---------------------------------------------------------------------------
// HTTP helper (historical REST)
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
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
          if (res.statusCode === 422) {
            reject(new Error(`HTTP 422 — data not yet processed at Databento. Check poll end-time offset. Body: ${body}`));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
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
// fetchETFDailyCloses — daily OHLCV for US equity ETFs
// ---------------------------------------------------------------------------

/**
 * Fetch daily OHLCV bars for a US equity ETF from Databento.
 *
 * Dataset: DBEQ.BASIC (Databento US Equities consolidated, daily bars)
 *   — Override via DATABENTO_EQUITY_DATASET env var if your subscription uses
 *     a different dataset (e.g. ARCX.PILLAR for NYSE Arca-listed ETFs).
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
// TCP Live Feed — state
// ---------------------------------------------------------------------------

let _socket         = null;   // net.Socket | null
let _rl             = null;   // readline.Interface | null
let _connected      = false;
let _stopped        = false;  // set by stopLiveFeed(); prevents reconnect
let _reconnectTimer = null;
let _reconnectDelay = RECONNECT_BASE_MS;

let _onCandleCb     = null;   // (symbol, candle) callback — fired on each completed 1m bar
let _onTickCb       = null;   // (symbol, price, time) callback — fired on each 1s bar close
let _onReconnectCb  = null;   // () callback — fired after successful reconnect (not initial connect)
let _liveSymbols    = [];     // internal symbol list passed to startLiveFeed
let _hasConnectedOnce = false; // distinguishes initial connect from reconnect

// instrument_id → internal symbol (rebuilt on every connection from rtype=19 definitions)
const _instrumentMap = new Map();

// Health tracking (same shape as old polling implementation)
let _lastBarTimes   = {};     // internal symbol → Unix seconds of last emitted bar
let _lastConnectMs  = null;   // Date.now() at last successful auth
let _lastTickLog    = {};     // internal symbol → Date.now() of last tick log line

// Spike filter: rolling median reference + per-symbol thresholds.
// A tick/bar whose price deviates more than the per-symbol threshold from the
// rolling median of the last 10 accepted prices is rejected. The rolling median
// prevents a single bad tick from shifting the reference baseline (unlike a
// single prior-price approach which allows staircase corruption).
const _lastGoodPrice = {};    // internal symbol → last accepted close price (legacy compat)

// Per-symbol spike thresholds for 1s ticks
const TICK_SPIKE_THRESHOLD = {
  // Equity index micro futures
  MNQ: 0.015,   // 1.5% — ~375 pts at 25000, generous for news events
  MES: 0.015,   // 1.5% — ~102 pts at 6800
  M2K: 0.015,   // 1.5% — ~39 pts at 2630
  MYM: 0.015,   // 1.5% — ~720 pts at 48000
  // Metals
  MGC: 0.012,   // 1.2% — ~57 pts at 4740
  SIL: 0.015,   // 1.5% — ~1.1 pts at 74
  MHG: 0.012,   // 1.2% — ~0.06 pts at 5.17 (copper is tight)
  // Energy
  MCL: 0.020,   // 2.0% — crude can move fast on inventory data
};
const DEFAULT_TICK_THRESHOLD = 0.015;

// Rolling price buffer per symbol — circular buffer of last 10 accepted tick prices
const _priceBuffer = {};
const PRICE_BUFFER_SIZE = 10;

function _updatePriceBuffer(symbol, price) {
  if (!_priceBuffer[symbol]) _priceBuffer[symbol] = [];
  _priceBuffer[symbol].push(price);
  if (_priceBuffer[symbol].length > PRICE_BUFFER_SIZE) {
    _priceBuffer[symbol].shift();
  }
}

function _getRollingMedian(symbol) {
  const buf = _priceBuffer[symbol];
  if (!buf || buf.length < 3) return null; // not enough data yet
  const sorted = [...buf].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ---------------------------------------------------------------------------
// CRAM authentication helper
// ---------------------------------------------------------------------------

/**
 * Compute the CRAM response for Databento TCP Live API.
 *   response = SHA256("<challenge>|<apiKey>").digest('hex') + "-" + apiKey.slice(-5)
 */
function _cramResponse(challenge, apiKey) {
  const hash = crypto
    .createHash('sha256')
    .update(`${challenge}|${apiKey}`)
    .digest('hex');
  return `${hash}-${apiKey.slice(-5)}`;
}

// ---------------------------------------------------------------------------
// Line handler — TCP state machine
// ---------------------------------------------------------------------------

// Connection phase: 'version' → 'cram' → 'auth' → 'data'
// PHASE 1 (version/cram/auth): plain text key=value lines — do NOT JSON.parse
// PHASE 2 (data): JSON objects, one per line — rtype=22 (sym map), rtype=33 (ohlcv-1m bar)
let _phase = 'version';

/**
 * Process one line received from the TCP Live API.
 *
 * Handshake (plain text):
 *   Line 1: "lsg_version=0.8.0"   → log, advance to 'cram'
 *   Line 2: "cram=<challenge>"    → extract challenge, send auth, advance to 'auth'
 *   Line 3: "success=1|..."       → send subscription + start_session, advance to 'data'
 *
 * Data stream (JSON):
 *   All subsequent lines are JSON — parse with JSON.parse()
 */
function _handleLine(rawLine, apiKey) {
  const line = rawLine.trim();
  if (!line) return;

  // ── PHASE 1: plain-text handshake ──────────────────────────────────────────

  if (_phase === 'version') {
    // Line 1: "lsg_version=0.8.0"
    console.log(`[databento:live] Version: ${line}`);
    _phase = 'cram';
    return;
  }

  if (_phase === 'cram') {
    // Line 2: "cram=<challenge_string>"
    if (!line.startsWith('cram=')) {
      console.error(`[databento:live] Expected CRAM challenge, got: ${line.slice(0, 80)}`);
      _socket?.destroy();
      return;
    }
    const challenge = line.slice(5);  // everything after "cram="
    const response  = _cramResponse(challenge, apiKey);
    const authLine  = `auth=${response}|dataset=${DATASET}|encoding=json|ts_out=1\n`;
    console.log(`[databento:live] CRAM challenge received — authenticating`);
    _socket.write(authLine);
    _phase = 'auth';
    return;
  }

  if (_phase === 'auth') {
    // Line 3: "success=1|..." or "success=0|error=..."
    if (line.includes('success=1')) {
      console.log('[databento:live] Authenticated successfully');
      _socket.write(`schema=ohlcv-1m|stype_in=parent|symbols=${LIVE_SUBSCRIBE_SYMBOLS}\n`);
      _socket.write(`schema=ohlcv-1s|stype_in=parent|symbols=${LIVE_SUBSCRIBE_SYMBOLS}\n`);
      _socket.write(`start_session=1\n`);
      _phase          = 'data';
      _connected      = true;
      _lastConnectMs  = Date.now();
      _reconnectDelay = RECONNECT_BASE_MS;
      console.log(`[databento:live] Subscribed and session started (ohlcv-1m + ohlcv-1s, ${LIVE_SUBSCRIBE_SYMBOLS})`);

      // Fire reconnect callback (not on initial connect — only after a disconnect/reconnect cycle)
      if (_hasConnectedOnce && _onReconnectCb) {
        console.log('[databento:live] Reconnected — firing onReconnect callback');
        try { _onReconnectCb(); } catch (err) {
          console.error(`[databento:live] onReconnect callback error: ${err.message}`);
        }
      }
      _hasConnectedOnce = true;
    } else {
      console.error(`[databento:live] Auth failed: ${line.slice(0, 120)}`);
      _socket?.destroy();
    }
    return;
  }

  // ── PHASE 2: JSON data stream ───────────────────────────────────────────────

  if (_phase === 'data') {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      console.warn(`[databento:live] Unparseable data line: ${line.slice(0, 120)}`);
      return;
    }
    _handleStreamRecord(rec);
    return;
  }
}

/**
 * Process a streaming data record.
 * rtype=19 → instrument definition (build instrumentMap)
 * rtype=32 → ohlcv-1m bar (emit candle)
 */
function _handleStreamRecord(rec) {
  const rtype = rec?.hd?.rtype ?? rec?.rtype;

  if (rtype === 22) {
    // Symbol mapping record — maps instrument_id to the subscribed parent symbol.
    // stype_in_symbol: "MNQ.FUT", "MES.FUT", "GC.FUT", "MCL.FUT"
    // stype_out_symbol: actual contract, e.g. "MNQM7", "MESH7", "GCM7", "MCLM7"
    const instrumentId    = rec.hd?.instrument_id;
    const stypeInSymbol   = rec.stype_in_symbol;  // e.g. "MNQ.FUT"

    if (!instrumentId || !stypeInSymbol) return;

    // Strip the ".FUT" suffix to get the root ("MNQ", "MES", "GC", "MCL")
    const root     = stypeInSymbol.replace('.FUT', '');
    const internal = ROOT_TO_INTERNAL[root];
    if (!internal) return;  // Not a symbol we track

    _instrumentMap.set(instrumentId, internal);
    console.log(`[databento:live] Mapped instrument_id=${instrumentId} (${stypeInSymbol} → ${rec.stype_out_symbol}) → ${internal}`);
    return;
  }

  if (rtype === 32) {
    // OHLCV-1s bar — use close price as a live price tick (same role as Coinbase WS for crypto)
    if (!_onTickCb) return;
    const instrumentId = rec.hd?.instrument_id ?? rec.instrument_id;
    const internal     = _instrumentMap.get(instrumentId);
    if (!internal) return;
    const price = _price(rec.close);
    const time  = _tsToSeconds(rec.hd?.ts_event ?? rec.ts_event);
    if (price > 0 && time > 0) {
      // Spike filter: reject tick if price deviates beyond per-symbol threshold from rolling median
      if (_isSpikePrice(internal, price)) {
        return;  // _isSpikePrice already logs [SPIKE-1S] details
      }
      _acceptPrice(internal, price);
      _onTickCb(internal, price, time);
      // Throttled log: once per minute per symbol to confirm ticks are flowing
      const now = Date.now();
      if (!_lastTickLog[internal] || now - _lastTickLog[internal] >= 60_000) {
        _lastTickLog[internal] = now;
        console.log(`[databento:live] tick ${internal} ${price.toFixed(2)}`);
      }
    }
    return;
  }

  if (rtype === 33) {
    // OHLCV-1m bar record
    const instrumentId = rec.hd?.instrument_id ?? rec.instrument_id;
    const internal     = _instrumentMap.get(instrumentId);

    if (!internal) {
      // May arrive before the definition record — silently ignore
      return;
    }

    const candle = _normalize(rec);
    if (!candle || candle.time <= 0) return;

    // Dedup: skip if we've already emitted this bar timestamp for this symbol
    const prev = _lastBarTimes[internal] ?? 0;
    if (candle.time <= prev) return;

    // Spike filter: reject entire 1m bar if close deviates beyond per-symbol threshold
    // from the rolling median. Uses same _isSpikePrice() as 1s ticks.
    if (_isSpikePrice(internal, candle.close)) {
      console.warn(
        `[databento:live] SPIKE REJECTED 1m bar ${internal} ` +
        `O=${candle.open.toFixed(2)} H=${candle.high.toFixed(2)} L=${candle.low.toFixed(2)} C=${candle.close.toFixed(2)}`
      );
      return;
    }

    // Wick clamping: limit extreme wicks to max(1.5× body, minWickFloor).
    // This catches bad 1s ticks that created extreme H/L on the forming bar
    // even when the bar's O/C (body) is valid.
    {
      const body = Math.abs(candle.close - candle.open);
      const threshold = TICK_SPIKE_THRESHOLD[internal] || DEFAULT_TICK_THRESHOLD;
      const minWickFloor = candle.close * threshold;
      const maxWickExtension = Math.max(body * 1.5, minWickFloor);
      const bodyHigh = Math.max(candle.open, candle.close);
      const bodyLow  = Math.min(candle.open, candle.close);

      if (candle.high > bodyHigh + maxWickExtension) {
        console.warn(
          `[SPIKE-1M-WICK] ${internal} clamped high ` +
          `${candle.high.toFixed(4)} → ${(bodyHigh + maxWickExtension).toFixed(4)} at ${candle.time}`
        );
        candle.high = bodyHigh + maxWickExtension;
      }
      if (candle.low < bodyLow - maxWickExtension) {
        console.warn(
          `[SPIKE-1M-WICK] ${internal} clamped low ` +
          `${candle.low.toFixed(4)} → ${(bodyLow - maxWickExtension).toFixed(4)} at ${candle.time}`
        );
        candle.low = bodyLow - maxWickExtension;
      }

      // Ensure OHLC consistency after clamping
      candle.high = Math.max(candle.high, candle.open, candle.close);
      candle.low  = Math.min(candle.low,  candle.open, candle.close);
    }

    _acceptPrice(internal, candle.close);
    _lastBarTimes[internal] = candle.time;

    console.log(
      `[databento:live] ▶ ${internal} t=${new Date(candle.time * 1000).toISOString()} ` +
      `O=${candle.open.toFixed(2)} H=${candle.high.toFixed(2)} ` +
      `L=${candle.low.toFixed(2)} C=${candle.close.toFixed(2)} V=${candle.volume}`
    );

    if (_onCandleCb) _onCandleCb(internal, candle);
    return;
  }

  // Heartbeat or other control record — ignore silently
}

// ---------------------------------------------------------------------------
// TCP connection management
// ---------------------------------------------------------------------------

function _connect(apiKey) {
  if (_stopped) return;

  _phase = 'version';
  _connected = false;
  _instrumentMap.clear();

  console.log(`[databento:live] Connecting to ${LIVE_HOST}:${LIVE_PORT}…`);

  _socket = net.createConnection(LIVE_PORT, LIVE_HOST);

  _socket.setKeepAlive(true, 30_000);
  _socket.setTimeout(120_000);  // 2-minute idle timeout

  _rl = readline.createInterface({ input: _socket, crlfDelay: Infinity });

  _rl.on('line', (line) => {
    try {
      _handleLine(line, apiKey);
    } catch (err) {
      console.error('[databento:live] Unhandled error in _handleLine:', err.message);
    }
  });

  _socket.on('connect', () => {
    console.log(`[databento:live] TCP connected to ${LIVE_HOST}:${LIVE_PORT}`);
  });

  _socket.on('timeout', () => {
    console.warn('[databento:live] Socket idle timeout — destroying');
    _socket.destroy();
  });

  _socket.on('error', (err) => {
    console.error(`[databento:live] Socket error: ${err.message}`);
    // 'close' will fire next — reconnect logic lives there
  });

  _socket.on('close', (hadError) => {
    _connected = false;
    _rl?.close();
    _rl = null;

    if (_stopped) {
      console.log('[databento:live] Connection closed (stopped — no reconnect)');
      return;
    }

    console.warn(`[databento:live] Connection closed${hadError ? ' (with error)' : ''} — reconnecting in ${_reconnectDelay / 1000}s`);
    _reconnectTimer = setTimeout(() => _connect(apiKey), _reconnectDelay);
    _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX_MS);
  });
}

// ---------------------------------------------------------------------------
// Public live feed API
// ---------------------------------------------------------------------------

/**
 * Start the TCP live feed for 1m candles and 1s price ticks.
 * Symbols param is accepted for API compatibility but ignored — the set of
 * subscribed symbols is hardcoded via LIVE_SUBSCRIBE_SYMBOLS.
 *
 * @param {string[]} symbols  Internal symbols (e.g. ['MNQ', 'MES', 'MGC', 'MCL']) — informational only
 * @param {Function} onCandle Callback for completed 1m bars: (symbol, { time, open, high, low, close, volume })
 * @param {Function} [onTick] Optional callback for 1s price ticks: (symbol, price, time)
 * @param {Function} [onReconnect] Optional callback fired after a successful reconnect (not initial connect)
 */
function startLiveFeed(symbols, onCandle, onTick, onReconnect) {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    console.warn('[databento] DATABENTO_API_KEY not set — live feed disabled');
    return;
  }

  _liveSymbols = Array.isArray(symbols) ? symbols : [];
  _onCandleCb  = onCandle;
  _onTickCb    = onTick ?? null;
  _onReconnectCb = onReconnect ?? null;
  _hasConnectedOnce = false;
  _stopped     = false;

  console.log(`[databento] Live feed starting (TCP) for ${_liveSymbols.join(', ') || 'default futures'}`);
  _connect(apiKey);
}

/**
 * Stop the live feed and cancel any pending reconnect.
 * After calling this, startLiveFeed() must be called again to resume.
 */
function stopLiveFeed() {
  _stopped = true;
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_socket) {
    _socket.destroy();
    _socket = null;
  }
  if (_rl) {
    _rl.close();
    _rl = null;
  }
  _connected = false;
  console.log('[databento] Live feed stopped');
}

// ---------------------------------------------------------------------------
// getLiveFeedStatus — consumed by B2 /api/datastatus route
// ---------------------------------------------------------------------------

/**
 * Returns the current live feed health state.
 * lagSeconds is computed from the most recent bar received across all symbols.
 */
function getLiveFeedStatus() {
  const nowMs = Date.now();

  // Most recent bar timestamp across all symbols
  const barTimestamps = Object.values(_lastBarTimes);
  const lastBarMs = barTimestamps.length > 0
    ? Math.max(...barTimestamps) * 1000
    : (_lastConnectMs ?? null);

  const lagMs   = lastBarMs ? (nowMs - lastBarMs) : null;
  const lagSecs = lagMs !== null ? Math.round(lagMs / 1000) : null;

  return {
    connected:    _connected,
    lagSeconds:   lagSecs,
    lastPollTime: _lastConnectMs ? new Date(_lastConnectMs).toISOString() : null,
    lastBarTimes: Object.fromEntries(
      Object.entries(_lastBarTimes).map(([sym, ts]) => [sym, new Date(ts * 1000).toISOString()])
    ),
    symbols: _liveSymbols,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { startLiveFeed, stopLiveFeed, getLiveFeedStatus, fetchHistoricalCandles, fetchETFDailyCloses, TICK_SPIKE_THRESHOLD };
