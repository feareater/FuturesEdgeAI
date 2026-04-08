'use strict';
// Session Volume Profile — POC, VAH, VAL per RTH session.
// RTH session: 09:30–16:00 ET = 13:30–20:00 UTC.
// Bucket granularity = 5 × instrument tick size.

// Tick sizes — sourced from instruments.js (single source of truth)
const { INSTRUMENTS } = require('../data/instruments');
const TICK_SIZE = Object.fromEntries(
  Object.entries(INSTRUMENTS).map(([s, m]) => [s, m.tickSize])
);
const BUCKET_TICKS = 5; // buckets are 5 ticks wide

// RTH session UTC hours
const RTH_START_UTC = 13.5;  // 13:30 UTC = 09:30 ET
const RTH_END_UTC   = 20.0;  // 20:00 UTC = 16:00 ET

/**
 * Compute session volume profile for a symbol.
 * Returns POC, VAH, VAL for the current and prior RTH session.
 *
 * @param {Array}  candles  [{time, open, high, low, close, volume}]
 * @param {string} symbol   'MNQ' | 'MES' | 'MGC' | 'MCL'
 * @returns {{ poc, vah, val, prevPoc, prevVah, prevVal } | null}
 */
function computeVolumeProfile(candles, symbol) {
  if (!candles || candles.length < 10) return null;

  const tick       = TICK_SIZE[symbol] ?? 0.25;
  const bucketSize = tick * BUCKET_TICKS;

  // Group candles by RTH session date key (YYYY-MM-DD based on UTC date at session start)
  const sessions = new Map(); // dateKey → [{time, open, high, low, close, volume}]

  for (const c of candles) {
    const h = _utcHour(c.time);
    if (h < RTH_START_UTC || h >= RTH_END_UTC) continue;

    // Session key = UTC date at session start
    const d   = new Date(c.time * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(c);
  }

  const sessionKeys = [...sessions.keys()].sort();
  if (sessionKeys.length === 0) return null;

  const currentKey = sessionKeys[sessionKeys.length - 1];
  const prevKey    = sessionKeys.length >= 2 ? sessionKeys[sessionKeys.length - 2] : null;

  const current = _profileFromCandles(sessions.get(currentKey), bucketSize);
  const prev    = prevKey ? _profileFromCandles(sessions.get(prevKey), bucketSize) : null;

  return {
    poc:     current?.poc     ?? null,
    vah:     current?.vah     ?? null,
    val:     current?.val     ?? null,
    hvn:     current?.hvn     ?? [],
    lvn:     current?.lvn     ?? [],
    prevPoc: prev?.poc        ?? null,
    prevVah: prev?.vah        ?? null,
    prevVal: prev?.val        ?? null,
  };
}

// ---------------------------------------------------------------------------

/**
 * Build volume-at-price histogram from a set of candles, then derive
 * POC (highest-volume bucket), VAH, and VAL (70% value area bounds).
 */
function _profileFromCandles(candles, bucketSize) {
  if (!candles || candles.length === 0) return null;

  // Build histogram: price bucket → accumulated volume
  const hist = new Map();

  for (const c of candles) {
    // Distribute volume evenly across the candle's price range
    const low  = Math.floor(c.low  / bucketSize) * bucketSize;
    const high = Math.ceil(c.high  / bucketSize) * bucketSize;
    const vol  = c.volume > 0 ? c.volume : 1;

    const numBuckets = Math.max(1, Math.round((high - low) / bucketSize));
    const volPerBucket = vol / numBuckets;

    for (let price = low; price <= high + bucketSize * 0.1; price += bucketSize) {
      const bucket = Math.round(price / bucketSize) * bucketSize;
      hist.set(bucket, (hist.get(bucket) ?? 0) + volPerBucket);
    }
  }

  if (hist.size === 0) return null;

  // Sort buckets ascending
  const sorted = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  const totalVol = sorted.reduce((s, [, v]) => s + v, 0);

  // POC = bucket with most volume
  let poc = sorted[0][0];
  let pocVol = 0;
  for (const [price, vol] of sorted) {
    if (vol > pocVol) { pocVol = vol; poc = price; }
  }

  // Value Area: expand from POC outward until 70% of total volume is captured
  const TARGET = 0.70 * totalVol;
  const pocIdx = sorted.findIndex(([p]) => p === poc);

  let lo = pocIdx, hi = pocIdx;
  let accumulated = pocVol;

  while (accumulated < TARGET) {
    const loVol = lo > 0                  ? sorted[lo - 1][1] : 0;
    const hiVol = hi < sorted.length - 1 ? sorted[hi + 1][1] : 0;

    if (loVol === 0 && hiVol === 0) break;
    if (hiVol >= loVol) hi++;
    else lo--;
    accumulated += Math.max(loVol, hiVol === 0 ? loVol : hiVol);
    // Recalculate to avoid drift
    accumulated = sorted.slice(lo, hi + 1).reduce((s, [, v]) => s + v, 0);
  }

  const vah = sorted[hi][0];
  const val = sorted[lo][0];
  const { hvn, lvn } = _extractNodes(sorted, poc, vah, val);

  return { poc, vah, val, hvn, lvn };
}

/**
 * Identify High Volume Nodes (HVN) and Low Volume Nodes (LVN) from a sorted histogram.
 * HVN: up to 5 buckets with volume >= 1.5x mean, excluding POC.
 * LVN: up to 3 buckets with volume <= 0.4x mean, within the value area [val, vah].
 */
function _extractNodes(sorted, poc, vah, val) {
  if (!sorted || sorted.length === 0) return { hvn: [], lvn: [] };

  const meanVol = sorted.reduce((s, [, v]) => s + v, 0) / sorted.length;

  const hvn = sorted
    .filter(([p, v]) => p !== poc && v >= meanVol * 1.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([price]) => price);

  const lvn = sorted
    .filter(([p, v]) => p >= val && p <= vah && v <= meanVol * 0.4)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([price]) => price);

  return { hvn, lvn };
}

function _utcHour(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

module.exports = { computeVolumeProfile };
