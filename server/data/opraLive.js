'use strict';
// server/data/opraLive.js — Databento OPRA.PILLAR live TCP feed
//
// Connects to the Databento OPRA live gateway, subscribes to the 'statistics'
// schema for QQQ and SPY options, and accumulates per-strike open interest.
//
// Exports:
//   startOpraFeed()          — connect and begin receiving statistics updates
//   stopOpraFeed()           — close connection, cancel reconnect
//   getOpraRawChain(etf)     — returns { options: [...], hasData: bool } in CBOE-compatible format
//   getOpraStatus()          — { connected, lastUpdateTime, strikeCount, totalStrikes }
//   checkOpraSchemas()       — one-shot REST call to log available OPRA schemas (Phase A)
//
// Return shape of getOpraRawChain() options array is identical to the CBOE raw options
// array consumed by _computeMetrics() in options.js.  options.js passes this array (plus
// the live ETF spot price it already fetches) to _computeMetrics() unchanged.
//
// Graceful degradation: if the TCP connection fails or OPRA subscription is refused,
// options.js silently falls back to CBOE.  This module never throws.

const net     = require('net');
const readline = require('readline');
const crypto  = require('crypto');
const https   = require('https');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Databento OPRA live gateway.
// Override with DATABENTO_OPRA_HOST env var if Databento changes the endpoint.
const OPRA_LIVE_HOST = process.env.DATABENTO_OPRA_HOST || 'opra-pillar.lsg.databento.com';
const OPRA_LIVE_PORT = parseInt(process.env.DATABENTO_OPRA_PORT || '13000', 10);
const OPRA_DATASET   = 'OPRA.PILLAR';

// ETF underlyings to subscribe to.  GLD/USO deferred — add here when subscription allows.
const OPRA_UNDERLYINGS = ['QQQ', 'SPY'];

// Options chain window: next 30 calendar days, ±30% of spot.
// We use a wide strike window here (spot is unknown at subscription time; filtering
// by spot proximity happens in options.js _computeMetrics which already does ±25%).
const EXPIRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Reconnect back-off
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 300_000; // 5 min

// StatType values in Databento DBN spec
const STAT_TYPE_OPEN_INTEREST = 7;  // per-contract open interest

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Per-ETF strike maps: etfSymbol → Map<strike, StrikeEntry>
// StrikeEntry = { callOI, putOI, callDelta, putDelta, callGamma, putGamma, expiry }
const _strikeData = new Map();
for (const sym of OPRA_UNDERLYINGS) _strikeData.set(sym, new Map());

// instrument_id → { underlying, expiry, type, strike }  (from symbol mapping records)
const _instrumentMap = new Map();

let _socket          = null;
let _rl              = null;
let _connected       = false;
let _stopped         = false;
let _reconnectTimer  = null;
let _reconnectDelay  = RECONNECT_BASE_MS;
let _phase           = 'version';
let _lastUpdateTime  = null;   // Date.now() of last OI record processed
let _lastConnectMs   = null;
let _totalRecords    = 0;      // total stats records processed since connect

// ---------------------------------------------------------------------------
// CRAM auth helper (identical to databento.js)
// ---------------------------------------------------------------------------

function _cramResponse(challenge, apiKey) {
  const hash = crypto
    .createHash('sha256')
    .update(`${challenge}|${apiKey}`)
    .digest('hex');
  return `${hash}-${apiKey.slice(-5)}`;
}

// ---------------------------------------------------------------------------
// Parse OCC option symbol (e.g. "QQQ250417C00500000")
//   underlying = 'QQQ' | 'SPY'
//   expiry     = 'YYYY-MM-DD'
//   type       = 'C' | 'P'
//   strike     = decimal (e.g. 500.000)
// ---------------------------------------------------------------------------

function _parseOcc(symbol) {
  if (!symbol) return null;
  // Strip all whitespace — Databento OPRA uses padded format: "QQQ   261218P00239780"
  const sym = symbol.replace(/\s+/g, '');
  for (const und of OPRA_UNDERLYINGS) {
    if (!sym.startsWith(und)) continue;
    const body = sym.slice(und.length);
    if (body.length < 15) continue;           // YYMMDD + C/P + 8 digits = 15 chars minimum
    const yymmdd = body.slice(0, 6);
    const type   = body[6];
    const raw    = body.slice(7);
    if (type !== 'C' && type !== 'P') continue;
    const strike = parseInt(raw, 10) / 1000;
    const expiry = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
    if (isNaN(strike) || strike <= 0) continue;
    return { underlying: und, expiry, type, strike };
  }
  return null;
}

// Reconstruct OCC symbol from components (used in getOpraRawChain)
function _toOcc(underlying, expiry, type, strike) {
  const yymmdd    = expiry.replace(/-/g, '').slice(2);           // 'YYYYMMDD' → 'YYMMDD'
  const strikePad = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${underlying}${yymmdd}${type}${strikePad}`;
}

// ---------------------------------------------------------------------------
// Process a single streaming record
// ---------------------------------------------------------------------------

function _processRecord(rec) {
  const rtype = rec?.hd?.rtype ?? rec?.rtype;

  // ── rtype=21: Error record ────────────────────────────────────────────────
  if (rtype === 21) {
    if (rec.err) console.warn(`[opra:live] Server error: ${rec.err}`);
    return;
  }

  // ── rtype=23: System message (subscription confirmation, etc.) ────────────
  if (rtype === 23) {
    if (rec.msg) console.log(`[opra:live] Server: ${rec.msg}`);
    return;
  }

  // ── rtype=22: Symbol mapping — maps instrument_id → OCC symbol ────────────
  if (rtype === 22) {
    const id      = rec.hd?.instrument_id ?? rec.instrument_id;
    const rawSym  = rec.raw_symbol || rec.stype_out_symbol || rec.stype_in_symbol;
    if (!id || !rawSym) return;
    const parsed = _parseOcc(String(rawSym));
    if (parsed) {
      _instrumentMap.set(id, parsed);
    }
    return;
  }

  // ── Statistics records — rtype=24 (DBN StatMsg) ───────────────────────────
  // Accept any record that carries open interest information.
  // Some OPRA feed implementations embed OI directly in the record body;
  // others use stat_type=7 with a stat_val / quantity field.
  //
  // We are intentionally tolerant: check multiple field names so the handler
  // works regardless of minor encoding differences between Databento API versions.

  let oi = null;

  if (rtype === 24) {
    const statType = rec.stat_type ?? rec.statType;
    // Accept stat_type=7 (OpenInterest) or absent stat_type with open_interest present
    if (statType != null && statType !== STAT_TYPE_OPEN_INTEREST) return;
    oi = rec.open_interest ?? rec.quantity ?? rec.stat_val ?? null;
  } else if (rec.open_interest != null) {
    // Fallback: any record with an open_interest field directly
    oi = rec.open_interest;
  }

  if (oi == null || oi < 0) return;

  // Resolve contract info: instrument_id map first, then raw_symbol on record
  let parsed = null;
  const id = rec.hd?.instrument_id ?? rec.instrument_id;
  if (id != null && _instrumentMap.has(id)) {
    parsed = _instrumentMap.get(id);
  } else {
    const rawSym = rec.raw_symbol;
    if (rawSym) parsed = _parseOcc(String(rawSym));
  }

  if (!parsed) return;

  const { underlying, expiry, type, strike } = parsed;
  if (!OPRA_UNDERLYINGS.includes(underlying)) return;

  // Expiry filter: skip expired and beyond 30-day window
  const now     = Date.now();
  const expMs   = Date.parse(expiry);
  if (isNaN(expMs) || expMs < now || expMs > now + EXPIRY_WINDOW_MS) return;

  // Greeks — may or may not be present depending on schema subscription
  const delta = rec.delta ?? null;
  const gamma = rec.gamma ?? null;
  const iv    = rec.volatility ?? rec.implied_volatility ?? null;

  const strikeMap = _strikeData.get(underlying);
  const entry = strikeMap.get(strike) || {
    callOI: 0, putOI: 0,
    callDelta: null, putDelta: null,
    callGamma: 0, putGamma: 0,
    callIV: null,
    expiry,
  };

  if (type === 'C') {
    entry.callOI    = Number(oi);
    if (delta != null) entry.callDelta = delta;
    if (gamma != null) entry.callGamma = gamma;
    if (iv    != null && entry.callIV == null) entry.callIV = iv;
  } else {
    entry.putOI    = Number(oi);
    if (delta != null) entry.putDelta = delta;
    if (gamma != null) entry.putGamma = gamma;
  }
  entry.expiry = expiry;

  strikeMap.set(strike, entry);
  _lastUpdateTime = now;
  _totalRecords++;
}

// ---------------------------------------------------------------------------
// TCP state machine
// ---------------------------------------------------------------------------

function _handleLine(line, apiKey) {
  if (!line) return;

  if (_phase === 'version') {
    console.log(`[opra:live] Version: ${line}`);
    _phase = 'cram';
    return;
  }

  if (_phase === 'cram') {
    if (!line.startsWith('cram=')) {
      console.error(`[opra:live] Expected CRAM challenge, got: ${line.slice(0, 80)}`);
      _socket?.destroy();
      return;
    }
    const challenge = line.slice(5);
    const response  = _cramResponse(challenge, apiKey);
    const authLine  = `auth=${response}|dataset=${OPRA_DATASET}|encoding=json|ts_out=1\n`;
    console.log('[opra:live] CRAM challenge received — authenticating');
    _socket.write(authLine);
    _phase = 'auth';
    return;
  }

  if (_phase === 'auth') {
    if (line.includes('success=1')) {
      console.log('[opra:live] Authenticated successfully');
      // Subscribe to statistics schema for QQQ + SPY using underlying stype
      const syms = OPRA_UNDERLYINGS.map(s => `${s}.OPT`).join(',');
      _socket.write(`schema=statistics|stype_in=parent|symbols=${syms}\n`);
      _socket.write(`start_session=1\n`);
      _phase         = 'data';
      _connected     = true;
      _lastConnectMs = Date.now();
      _reconnectDelay = RECONNECT_BASE_MS;
      console.log(`[opra:live] Subscribed to statistics for ${syms}`);
    } else {
      console.error(`[opra:live] Auth failed: ${line.slice(0, 120)}`);
      _socket?.destroy();
    }
    return;
  }

  if (_phase === 'data') {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Non-JSON heartbeat or control line — ignore
      return;
    }
    _processRecord(rec);
  }
}

// ---------------------------------------------------------------------------
// TCP connection management (mirrors databento.js pattern)
// ---------------------------------------------------------------------------

function _connect(apiKey) {
  if (_stopped) return;

  _phase = 'version';
  _connected = false;
  _instrumentMap.clear();
  _totalRecords = 0;

  console.log(`[opra:live] Connecting to ${OPRA_LIVE_HOST}:${OPRA_LIVE_PORT}…`);

  _socket = net.createConnection(OPRA_LIVE_PORT, OPRA_LIVE_HOST);
  _socket.setKeepAlive(true, 30_000);
  _socket.setTimeout(120_000); // 2-min idle timeout

  _rl = readline.createInterface({ input: _socket, crlfDelay: Infinity });

  _rl.on('line', (line) => {
    try {
      _handleLine(line, apiKey);
    } catch (err) {
      console.error('[opra:live] Unhandled error in _handleLine:', err.message);
    }
  });

  _socket.on('connect', () => {
    console.log(`[opra:live] TCP connected to ${OPRA_LIVE_HOST}:${OPRA_LIVE_PORT}`);
  });

  _socket.on('timeout', () => {
    console.warn('[opra:live] Socket idle timeout — destroying');
    _socket.destroy();
  });

  _socket.on('error', (err) => {
    console.error(`[opra:live] Socket error: ${err.message}`);
  });

  _socket.on('close', (hadError) => {
    _connected = false;
    _rl?.close();
    _rl = null;

    if (_stopped) {
      console.log('[opra:live] Connection closed (stopped)');
      return;
    }

    console.warn(
      `[opra:live] Connection closed${hadError ? ' (error)' : ''} phase=${_phase} ` +
      `totalRecs=${_totalRecords} — reconnecting in ${_reconnectDelay / 1000}s`
    );
    _reconnectTimer = setTimeout(() => _connect(apiKey), _reconnectDelay);
    _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX_MS);
  });
}

// ---------------------------------------------------------------------------
// Phase A helper — REST metadata query to log available OPRA schemas
// ---------------------------------------------------------------------------

/**
 * One-shot HTTP call to Databento metadata API.
 * Logs the available schemas for OPRA.PILLAR so we know what we can subscribe to.
 * Non-fatal: logs a warning on failure but never throws.
 */
async function checkOpraSchemas() {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    console.log('[opra] Schema check skipped — DATABENTO_API_KEY not set');
    return;
  }

  return new Promise((resolve) => {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const path = `/v0/metadata.list_schemas?dataset=${OPRA_DATASET}`;
    const req  = https.request(
      {
        hostname: 'hist.databento.com',
        path,
        method:   'GET',
        headers:  { 'Authorization': `Basic ${auth}` },
      },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const body    = Buffer.concat(chunks).toString('utf8');
            const schemas = JSON.parse(body);
            if (Array.isArray(schemas)) {
              console.log(`[opra] Available schemas for ${OPRA_DATASET}: ${schemas.join(', ')}`);
            } else {
              console.log(`[opra] Schema list response: ${body.slice(0, 200)}`);
            }
          } catch (e) {
            console.warn(`[opra] Schema list parse error: ${e.message}`);
          }
          resolve();
        });
      }
    );
    req.on('error', (err) => {
      console.warn(`[opra] Schema check failed: ${err.message}`);
      resolve();
    });
    req.setTimeout(8_000, () => {
      req.destroy(new Error('timeout'));
      resolve();
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the OPRA live feed.
 * Connects to OPRA.PILLAR TCP gateway and streams statistics for QQQ/SPY options.
 * No-op if DATABENTO_API_KEY is not set.
 */
function startOpraFeed() {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    console.warn('[opra:live] DATABENTO_API_KEY not set — OPRA live feed disabled');
    return;
  }
  _stopped = false;
  console.log('[opra:live] Starting OPRA live feed…');
  _connect(apiKey);
}

/**
 * Stop the OPRA live feed and cancel any pending reconnect.
 */
function stopOpraFeed() {
  _stopped = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_socket) { _socket.destroy(); _socket = null; }
  if (_rl)     { _rl.close();      _rl     = null; }
  _connected = false;
  console.log('[opra:live] Stopped');
}

/**
 * Returns the accumulated options chain for an ETF in CBOE-compatible format.
 *
 * @param {string} etfSymbol  'QQQ' | 'SPY'
 * @returns {{ options: Array, hasData: boolean } | null}
 *
 * Each entry in `options` has the same shape as a CBOE raw options record:
 *   { option: string, open_interest: number, iv: number|null, gamma: number, delta: number|null }
 *
 * `option` is the OCC option symbol (e.g. "QQQ260330C00500000").
 *
 * Returns null if etfSymbol is not subscribed, hasData=false if no records yet.
 */
function getOpraRawChain(etfSymbol) {
  const strikeMap = _strikeData.get(etfSymbol);
  if (!strikeMap) return null;                     // not a subscribed underlying

  const hasData = strikeMap.size > 0 && _lastUpdateTime != null;

  if (!hasData) return { options: [], hasData: false };

  const options = [];
  for (const [strike, entry] of strikeMap) {
    const { callOI, putOI, callDelta, putDelta, callGamma, putGamma, callIV, expiry } = entry;
    if (callOI > 0) {
      options.push({
        option:         _toOcc(etfSymbol, expiry, 'C', strike),
        open_interest:  callOI,
        iv:             callIV ?? null,
        gamma:          callGamma ?? 0,
        delta:          callDelta ?? null,
      });
    }
    if (putOI > 0) {
      options.push({
        option:         _toOcc(etfSymbol, expiry, 'P', strike),
        open_interest:  putOI,
        iv:             null,
        gamma:          putGamma ?? 0,
        delta:          putDelta ?? null,
      });
    }
  }

  return { options, hasData: options.length > 0 };
}

/**
 * Returns current OPRA feed health state.
 * @returns {{ connected: boolean, lastUpdateTime: number|null, strikeCount: number, totalRecords: number }}
 */
function getOpraStatus() {
  let strikeCount = 0;
  for (const m of _strikeData.values()) strikeCount += m.size;
  return {
    connected:      _connected,
    lastUpdateTime: _lastUpdateTime,
    strikeCount,
    totalRecords:   _totalRecords,
  };
}

module.exports = {
  startOpraFeed,
  stopOpraFeed,
  getOpraRawChain,
  getOpraStatus,
  checkOpraSchemas,
};
