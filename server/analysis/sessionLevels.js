'use strict';
// Multi-session High/Low levels.
// Asian session:  00:00–07:00 UTC
// London session: 07:00–13:30 UTC
// RTH/NY session: 13:30–20:00 UTC (tracked as PDH/PDL in indicators.js)

const SESSIONS = {
  asian:  { start: 0.0,  end: 7.0  },
  london: { start: 7.0,  end: 13.5 },
};

/**
 * Compute prior Asian and London session high/low levels.
 *
 * @param {Array} candles  [{time, open, high, low, close, volume}]
 * @returns {{ asian, london, prevAsian } | null}
 *   Each sub-object: { high, low, mid }
 */
function computeSessionLevels(candles) {
  if (!candles || candles.length < 10) return null;

  // Build per-calendar-day buckets for each session
  const asianByDay  = new Map();
  const londonByDay = new Map();

  for (const c of candles) {
    const h   = _utcHour(c.time);
    const key = _dayKey(c.time);

    if (h >= SESSIONS.asian.start && h < SESSIONS.asian.end) {
      if (!asianByDay.has(key)) asianByDay.set(key, { high: -Infinity, low: Infinity });
      const e = asianByDay.get(key);
      e.high = Math.max(e.high, c.high);
      e.low  = Math.min(e.low,  c.low);
    }

    if (h >= SESSIONS.london.start && h < SESSIONS.london.end) {
      if (!londonByDay.has(key)) londonByDay.set(key, { high: -Infinity, low: Infinity });
      const e = londonByDay.get(key);
      e.high = Math.max(e.high, c.high);
      e.low  = Math.min(e.low,  c.low);
    }
  }

  const asianDays  = [...asianByDay.keys()].sort();
  const londonDays = [...londonByDay.keys()].sort();

  // Use the most recent completed session (second-to-last if available, else last)
  const pickRecent = (days, map) => {
    if (days.length === 0) return null;
    const key = days.length >= 2 ? days[days.length - 2] : days[days.length - 1];
    const d = map.get(key);
    return d && d.high > d.low ? { high: d.high, low: d.low, mid: (d.high + d.low) / 2 } : null;
  };

  const pickPrev = (days, map) => {
    if (days.length < 3) return null;
    const key = days[days.length - 3];
    const d = map.get(key);
    return d && d.high > d.low ? { high: d.high, low: d.low } : null;
  };

  const asian     = pickRecent(asianDays, asianByDay);
  const london    = pickRecent(londonDays, londonByDay);
  const prevAsian = pickPrev(asianDays, asianByDay);

  if (!asian && !london) return null;

  return { asian, london, prevAsian };
}

function _utcHour(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function _dayKey(unixSec) {
  const d = new Date(unixSec * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

module.exports = { computeSessionLevels };
