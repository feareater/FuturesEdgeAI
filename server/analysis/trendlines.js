'use strict';
// Significance-ranked trendline detection.
//
// Support line  (green): anchored at the lowest low in the window.
//   Slope = the steepest upward angle such that no candle low falls below the line.
//   This produces the tightest valid uptrend line that "just touches" the most
//   constraining swing lows without being pierced by any wick.
//
// Resistance line (red): anchored at the highest high in the window.
//   Slope = the least-steep downward angle such that no candle high rises above the line.
//   This produces the tightest valid downtrend line.
//
// Both lines are projected forward to the last candle in the window.

const WINDOW = 300; // recent candles to analyse (time-agnostic, works across all TFs)

/**
 * @param {Array}  candles     Full normalised candle array
 * @param {number} atrCurrent  Current ATR(14) — used for touch-tolerance
 * @returns {{ support: TrendlineResult|null, resistance: TrendlineResult|null }}
 *
 * TrendlineResult: { startTime, startPrice, endTime, endPrice, touches, direction }
 */
function detectTrendlines(candles, atrCurrent) {
  if (!candles || candles.length < 10) return { support: null, resistance: null };

  const recent = candles.slice(-WINDOW);
  const tol    = (atrCurrent || 0) * 0.25; // touch ≈ within 25% of ATR

  return {
    support:    _support(recent, tol),
    resistance: _resistance(recent, tol),
  };
}

// ---------------------------------------------------------------------------
// Support (uptrend) line
// ---------------------------------------------------------------------------

function _support(candles, tol) {
  // 1. Anchor = absolute lowest low in the window
  let ai = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].low < candles[ai].low) ai = i;
  }

  // Anchor must not be in the final 15% of the window (need candles for slope)
  if (ai >= Math.floor(candles.length * 0.85)) return null;

  const anchor = candles[ai];

  // 2. Find the minimum slope-to-j across all subsequent candles.
  //    slope_to_j = (low[j] - anchor.low) / (time[j] - anchor.time)
  //    Since anchor is the global low, slope_to_j >= 0.
  //    min(slope_to_j) = the steepest valid uptrend that never crosses any wick low.
  let slope = Infinity;
  for (let j = ai + 1; j < candles.length; j++) {
    const dt = candles[j].time - anchor.time;
    if (dt <= 0) continue;
    const s = (candles[j].low - anchor.low) / dt;
    if (s < slope) slope = s;
  }

  if (!isFinite(slope) || slope <= 0) return null; // flat / downward — not a valid uptrend

  // 3. Project line to the last candle
  const last     = candles[candles.length - 1];
  const endPrice = anchor.low + slope * (last.time - anchor.time);

  // 4. Count candles whose low is within touch tolerance of the line
  let touches = 0;
  for (let j = ai; j < candles.length; j++) {
    const lineVal = anchor.low + slope * (candles[j].time - anchor.time);
    if (Math.abs(candles[j].low - lineVal) <= tol) touches++;
  }

  console.log(`[trendlines] support  anchor=${anchor.low.toFixed(2)}  slope=${slope.toFixed(6)}  end=${endPrice.toFixed(2)}  touches=${touches}`);

  return {
    startTime:  anchor.time,
    startPrice: anchor.low,
    endTime:    last.time,
    endPrice,
    touches,
    direction: 'up',
  };
}

// ---------------------------------------------------------------------------
// Resistance (downtrend) line
// ---------------------------------------------------------------------------

function _resistance(candles, tol) {
  // 1. Anchor = absolute highest high in the window
  let ai = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].high > candles[ai].high) ai = i;
  }

  // Anchor must not be in the final 15% of the window
  if (ai >= Math.floor(candles.length * 0.85)) return null;

  const anchor = candles[ai];

  // 2. Find the maximum slope-to-j across all subsequent candles.
  //    slope_to_j = (high[j] - anchor.high) / (time[j] - anchor.time)
  //    Since anchor is the global high, slope_to_j <= 0.
  //    max(slope_to_j) = the least-negative slope = tightest valid downtrend.
  let slope = -Infinity;
  for (let j = ai + 1; j < candles.length; j++) {
    const dt = candles[j].time - anchor.time;
    if (dt <= 0) continue;
    const s = (candles[j].high - anchor.high) / dt;
    if (s > slope) slope = s;
  }

  if (!isFinite(slope) || slope >= 0) return null; // flat / upward — not a valid downtrend

  // 3. Project line to the last candle
  const last     = candles[candles.length - 1];
  const endPrice = anchor.high + slope * (last.time - anchor.time);

  // 4. Count candles whose high is within touch tolerance of the line
  let touches = 0;
  for (let j = ai; j < candles.length; j++) {
    const lineVal = anchor.high + slope * (candles[j].time - anchor.time);
    if (Math.abs(candles[j].high - lineVal) <= tol) touches++;
  }

  console.log(`[trendlines] resist   anchor=${anchor.high.toFixed(2)}  slope=${slope.toFixed(6)}  end=${endPrice.toFixed(2)}  touches=${touches}`);

  return {
    startTime:  anchor.time,
    startPrice: anchor.high,
    endTime:    last.time,
    endPrice,
    touches,
    direction: 'down',
  };
}

module.exports = { detectTrendlines };
