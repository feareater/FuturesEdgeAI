'use strict';
// Opening Range — first 30 minutes of RTH (09:30–10:00 ET = 13:30–14:00 UTC).
// Returns { high, low, mid, orTime, formed } for the most recent RTH session.

const OR_START_UTC = 13.5;   // 09:30 ET
const OR_END_UTC   = 14.0;   // 10:00 ET
const RTH_END_UTC  = 20.0;   // 16:00 ET

/**
 * Compute today's Opening Range from candle data.
 *
 * @param {Array} candles  [{time, open, high, low, close, volume}]
 * @returns {{ high, low, mid, orTime, formed } | null}
 */
function computeOpeningRange(candles) {
  if (!candles || candles.length < 2) return null;

  // Find the most recent RTH session start (13:30 UTC)
  // Group candles into sessions by UTC date
  const sessions = new Map();

  for (const c of candles) {
    const h = _utcHour(c.time);
    if (h < OR_START_UTC || h >= RTH_END_UTC) continue;
    const d   = new Date(c.time * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(c);
  }

  if (sessions.size === 0) return null;

  const latestKey      = [...sessions.keys()].sort().pop();
  const sessionCandles = sessions.get(latestKey);

  // OR candles: 13:30–14:00 UTC (exclusive of 14:00)
  const orCandles = sessionCandles.filter(c => {
    const h = _utcHour(c.time);
    return h >= OR_START_UTC && h < OR_END_UTC;
  });

  if (orCandles.length === 0) return null;

  const orHigh = Math.max(...orCandles.map(c => c.high));
  const orLow  = Math.min(...orCandles.map(c => c.low));
  const orTime = orCandles[0].time;

  // OR is "formed" once a candle closes after 14:00 UTC
  const postOrCandles = sessionCandles.filter(c => _utcHour(c.time) >= OR_END_UTC);
  const formed = postOrCandles.length > 0;

  return {
    high:   orHigh,
    low:    orLow,
    mid:    (orHigh + orLow) / 2,
    orTime,
    formed,
  };
}

function _utcHour(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

module.exports = { computeOpeningRange };
