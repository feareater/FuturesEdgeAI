'use strict';
// Computes all technical indicators from a normalized candle array.
// Pure function: candles in → indicator data out. No I/O.

const { EMA, ATR } = require('technicalindicators');
const { detectFVGs, detectOrderBlocks }    = require('./iof');
const { computeVolumeProfile }             = require('./volumeProfile');
const { computeOpeningRange }              = require('./openingRange');
const { computeSessionLevels }             = require('./sessionLevels');
const { MACRO_SYMBOLS } = require('../data/snapshot');

const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'XRP']);

// EST = UTC-5. Simplified — not DST-aware (acceptable for Phase 2 seed data).
const ET_OFFSET_MS = 5 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Compute all indicators for a candle array.
 *
 * @param {Array}  candles            [{time,open,high,low,close,volume}]
 * @param {Object} opts
 * @param {number} opts.swingLookback Bars on each side required to confirm a swing (default 10)
 * @returns {Object}  Indicator payload — see shape below
 */
function computeIndicators(candles, opts = {}) {
  const { swingLookback = 10, impulseThreshold = 1.5, symbol = null, features = {}, spanMargin = null } = opts;

  if (!candles || candles.length === 0) {
    return {
      ema9: [], ema21: [], ema50: [],
      vwap: [],
      atrCurrent: null,
      pdh: null, pdl: null,
      swingHighs: [], swingLows: [],
      fvgs: [], orderBlocks: [],
    };
  }

  const isCrypto = CRYPTO_SYMBOLS.has(symbol);
  const isMacro  = MACRO_SYMBOLS.has(symbol);

  const ema9   = _ema(candles, 9);
  const ema21  = _ema(candles, 21);
  const ema50  = _ema(candles, 50);
  const vwap   = _vwap(candles, isCrypto);
  const { current: atrCurrent } = _atr(candles, 14);
  const { pdh, pdl }            = _pdhl(candles, isCrypto);
  const { highs: swingHighs, lows: swingLows } = _swings(candles, swingLookback);
  const fvgs        = detectFVGs(candles, atrCurrent);
  const orderBlocks = detectOrderBlocks(candles, atrCurrent, impulseThreshold);

  // Crypto and macro/reference symbols skip session-specific indicators
  const volumeProfile  = !isCrypto && !isMacro && symbol ? computeVolumeProfile(candles, symbol) : null;
  const openingRange   = !isCrypto && !isMacro           ? computeOpeningRange(candles)           : null;
  const sessionLevels  = !isCrypto && !isMacro           ? computeSessionLevels(candles)          : null;

  console.log(
    `[indicators] ema9:${ema9.length} ema21:${ema21.length} ema50:${ema50.length}` +
    ` vwap:${vwap.length} atr:${atrCurrent?.toFixed(2)}` +
    ` pdh:${pdh} pdl:${pdl}` +
    ` swingH:${swingHighs.length} swingL:${swingLows.length}` +
    ` fvgs:${fvgs.length}(open:${fvgs.filter(f=>f.status==='open').length})` +
    ` obs:${orderBlocks.length}(untested:${orderBlocks.filter(o=>o.status==='untested').length})` +
    (volumeProfile ? ` poc:${volumeProfile.poc}` : '') +
    (openingRange  ? ` or:${openingRange.formed ? 'formed' : 'forming'}` : '') +
    (sessionLevels ? ` asian:${sessionLevels.asian?.high?.toFixed(2)}` : '')
  );

  const ddBands = computeDDBands(candles, symbol, spanMargin);

  return {
    ema9, ema21, ema50, vwap, atrCurrent, pdh, pdl,
    swingHighs, swingLows, fvgs, orderBlocks,
    volumeProfile, openingRange, sessionLevels,
    ddBands,
  };
}

// ---------------------------------------------------------------------------
// DD Bands / CME SPAN margin levels
// Computes 5 price levels anchored to the prior session close:
//   ddBandUpper = priorClose + riskInterval
//   ddBandLower = priorClose - riskInterval
//   spanUpper   = priorClose + 2 × riskInterval
//   spanLower   = priorClose - 2 × riskInterval
// For futures: riskInterval = CME initial margin / pointValue
// For crypto:  riskInterval = priorClose × (annualizedVol / sqrt(252))
// ---------------------------------------------------------------------------

const { INSTRUMENTS } = require('../data/instruments');
const _DD_POINT_VALUE = Object.fromEntries(
  Object.entries(INSTRUMENTS).map(([s, m]) => [s, m.pointValue])
);
const _DD_CRYPTO      = new Set(['BTC', 'ETH', 'XRP', 'XLM']);

function computeDDBands(candles, symbol, spanMargin) {
  if (!candles || candles.length < 2) return null;

  // Find prior session close: last candle whose calendar date < today's date
  const lastTs   = candles[candles.length - 1].time;
  const todayStr = new Date(lastTs * 1000).toISOString().slice(0, 10);

  let priorClose = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = new Date(candles[i].time * 1000).toISOString().slice(0, 10);
    if (d < todayStr) {
      priorClose = candles[i].close;
      break;
    }
  }
  if (!priorClose) return null;

  let riskInterval;
  if (_DD_CRYPTO.has(symbol)) {
    const vol = spanMargin?.cryptoVolAnnualized ?? 0.30;
    riskInterval = priorClose * (vol / Math.sqrt(252));
  } else {
    const margin = spanMargin?.[symbol];
    const pv     = _DD_POINT_VALUE[symbol];
    if (!margin || !pv) return null;
    riskInterval = margin / pv;
  }

  return {
    priorClose,
    riskInterval: +riskInterval.toFixed(4),
    ddBandUpper:  +(priorClose + riskInterval).toFixed(4),
    ddBandLower:  +(priorClose - riskInterval).toFixed(4),
    spanUpper:    +(priorClose + riskInterval * 2).toFixed(4),
    spanLower:    +(priorClose - riskInterval * 2).toFixed(4),
  };
}

module.exports = { computeIndicators, computeDDBands };

// ---------------------------------------------------------------------------
// EMA
// ---------------------------------------------------------------------------

function _ema(candles, period) {
  if (candles.length < period) return [];
  const closes = candles.map(c => c.close);
  const values = EMA.calculate({ period, values: closes });
  const offset = candles.length - values.length;
  return values.map((value, i) => ({ time: candles[offset + i].time, value }));
}

// ---------------------------------------------------------------------------
// ATR (14)
// ---------------------------------------------------------------------------

function _atr(candles, period) {
  if (candles.length <= period) return { series: [], current: null };
  const values = ATR.calculate({
    period,
    high:  candles.map(c => c.high),
    low:   candles.map(c => c.low),
    close: candles.map(c => c.close),
  });
  const offset = candles.length - values.length;
  return {
    series:  values.map((value, i) => ({ time: candles[offset + i].time, value })),
    current: values[values.length - 1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// VWAP — resets at each RTH open (09:30 ET).
// Zero-volume bars use weight=1 so the result degrades gracefully to a
// typical-price mean when volume data is absent (common with Yahoo Finance).
// ---------------------------------------------------------------------------

function _vwap(candles, isCrypto = false) {
  const result   = [];
  let cumTPV     = 0;      // cumulative typical-price × volume
  let cumVol     = 0;      // cumulative volume
  let sessionDay = null;

  for (const c of candles) {
    let dayKey, shouldReset;
    if (isCrypto) {
      // Crypto: reset at each UTC midnight — no RTH concept
      const d  = new Date(c.time * 1000);
      dayKey   = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      shouldReset = dayKey !== sessionDay;
    } else {
      // Futures: reset at the first candle on or after 09:30 ET each calendar day
      const d      = new Date(c.time * 1000 - ET_OFFSET_MS);
      dayKey       = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      const etHour = d.getUTCHours() + d.getUTCMinutes() / 60;
      shouldReset  = dayKey !== sessionDay && etHour >= 9.5;
    }

    if (shouldReset) {
      cumTPV     = 0;
      cumVol     = 0;
      sessionDay = dayKey;
    }

    // For futures, skip candles before the RTH session starts
    if (!isCrypto && sessionDay === null) continue;

    const tp  = (c.high + c.low + c.close) / 3;
    const vol = c.volume > 0 ? c.volume : 1;
    cumTPV   += tp * vol;
    cumVol   += vol;
    result.push({ time: c.time, value: cumTPV / cumVol });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prior Day High / Low
// Groups candles by ET calendar date, returns the most recent completed day's H/L.
// ---------------------------------------------------------------------------

function _pdhl(candles, isCrypto = false) {
  const dayMap = new Map();
  const offset = isCrypto ? 0 : ET_OFFSET_MS;  // crypto uses UTC midnight; futures use ET

  for (const c of candles) {
    const d   = new Date(c.time * 1000 - offset);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (!dayMap.has(key)) dayMap.set(key, { high: -Infinity, low: Infinity });
    const entry = dayMap.get(key);
    entry.high  = Math.max(entry.high, c.high);
    entry.low   = Math.min(entry.low,  c.low);
  }

  const days = [...dayMap.keys()].sort();
  if (days.length < 2) return { pdh: null, pdl: null };

  // Second-to-last day = the most recent fully completed session
  const { high: pdh, low: pdl } = dayMap.get(days[days.length - 2]);
  return { pdh, pdl };
}

// ---------------------------------------------------------------------------
// Swing Highs / Lows
// A confirmed swing high at index i: c[i].high is strictly greater than every
// candle within ±lookback. Same logic inverted for swing lows.
// ---------------------------------------------------------------------------

function _swings(candles, lookback) {
  const highs = [];
  const lows  = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c       = candles[i];
    let isHigh    = true;
    let isLow     = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low  <= c.low)  isLow  = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push({ time: c.time, value: c.high });
    if (isLow)  lows.push({  time: c.time, value: c.low  });
  }

  return { highs, lows };
}
