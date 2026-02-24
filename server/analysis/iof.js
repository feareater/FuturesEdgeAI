'use strict';
// Institutional Order Flow: Fair Value Gap (FVG) + Order Block (OB) detection.
// Pure function: candles in → IOF arrays out. No I/O.

// ---------------------------------------------------------------------------
// Fair Value Gaps
// ---------------------------------------------------------------------------

/**
 * Detect Fair Value Gaps across a candle array.
 *
 * Bullish FVG: candle[i-2].high < candle[i].low  (gap above C0, below C2)
 * Bearish FVG: candle[i-2].low  > candle[i].high (gap below C0, above C2)
 *
 * The gap's "anchor time" is the middle candle (the impulse bar).
 *
 * @param {Array} candles
 * @returns {Array} [{type, top, bottom, time, status}]
 */
function detectFVGs(candles) {
  const fvgs = [];

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i - 2]; // pre-impulse candle
    const c1 = candles[i - 1]; // impulse candle (gap reference)
    const c2 = candles[i];     // post-impulse candle

    // Bullish FVG: gap between c0 high and c2 low — price skipped this zone upward
    if (c2.low > c0.high) {
      const bottom = c0.high;
      const top    = c2.low;
      const status = _fvgStatus(candles, i, bottom, top, 'bullish');
      fvgs.push({ type: 'bullish', top, bottom, time: c1.time, status });
    }

    // Bearish FVG: gap between c0 low and c2 high — price skipped this zone downward
    if (c2.high < c0.low) {
      const top    = c0.low;
      const bottom = c2.high;
      const status = _fvgStatus(candles, i, bottom, top, 'bearish');
      fvgs.push({ type: 'bearish', top, bottom, time: c1.time, status });
    }
  }

  return fvgs;
}

/**
 * Check whether a FVG has been filled by subsequent price action.
 * Bullish FVG is filled when any later candle's low dips into [bottom, top].
 * Bearish FVG is filled when any later candle's high reaches into [bottom, top].
 */
function _fvgStatus(candles, fromIdx, bottom, top, type) {
  for (let i = fromIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    if (type === 'bullish' && c.low  <= top)    return 'filled';
    if (type === 'bearish' && c.high >= bottom) return 'filled';
  }
  return 'open';
}

// ---------------------------------------------------------------------------
// Order Blocks
// ---------------------------------------------------------------------------

/**
 * Detect Order Blocks across a candle array.
 *
 * Bullish OB: last bearish candle immediately before an upward impulse ≥ threshold × ATR.
 * Bearish OB: last bullish candle immediately before a downward impulse ≥ threshold × ATR.
 * OB candle must have body ≤ 50% of its total range (wicks present → hesitation).
 *
 * @param {Array}  candles
 * @param {number} atrCurrent
 * @param {number} impulseThreshold  — e.g. 1.5 (multiplier on ATR)
 * @returns {Array} [{type, top, bottom, time, status}]
 */
function detectOrderBlocks(candles, atrCurrent, impulseThreshold = 1.5) {
  const obs  = [];
  if (!atrCurrent || atrCurrent === 0) return obs;

  const minImpulse = atrCurrent * impulseThreshold;
  const seen       = new Set();

  for (let i = 1; i < candles.length - 1; i++) {
    const ob      = candles[i];     // candidate OB candle
    const impulse = candles[i + 1]; // candle that follows — the impulsive move

    // The impulse candle must be strong enough
    const impulseBody = Math.abs(impulse.close - impulse.open);
    if (impulseBody < minImpulse) continue;

    // The OB candle's body must be ≤ 50% of its range (wicks present)
    const totalRange = ob.high - ob.low;
    if (totalRange === 0) continue;
    const bodyRatio = Math.abs(ob.close - ob.open) / totalRange;
    if (bodyRatio > 0.5) continue;

    const key = `${ob.time}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Bullish OB: bearish candle followed by strong bullish impulse
    if (ob.close < ob.open && impulse.close > impulse.open) {
      const status = _obStatus(candles, i, ob.low, ob.high, 'bullish');
      obs.push({ type: 'bullish', top: ob.high, bottom: ob.low, time: ob.time, status });
    }

    // Bearish OB: bullish candle followed by strong bearish impulse
    if (ob.close > ob.open && impulse.close < impulse.open) {
      const status = _obStatus(candles, i, ob.low, ob.high, 'bearish');
      obs.push({ type: 'bearish', top: ob.high, bottom: ob.low, time: ob.time, status });
    }
  }

  return obs;
}

/**
 * Determine OB test status.
 * untested  — price has not returned to the OB zone since formation
 * tested    — price entered the zone but OB candle's opposite edge held
 * mitigated — price closed through the OB (it has been absorbed)
 */
function _obStatus(candles, fromIdx, bottom, top, type) {
  let tested = false;
  for (let i = fromIdx + 2; i < candles.length; i++) { // +2 skips the impulse candle
    const c = candles[i];
    const inZone = c.low <= top && c.high >= bottom;
    if (!inZone) continue;
    tested = true;
    if (type === 'bullish' && c.close < bottom) return 'mitigated';
    if (type === 'bearish' && c.close > top)    return 'mitigated';
  }
  return tested ? 'tested' : 'untested';
}

// ---------------------------------------------------------------------------
// Proximity helper (used by setups.js for confidence scoring)
// ---------------------------------------------------------------------------

/**
 * Returns an IOF confluence bonus score (0–20) for a setup's entry price.
 *
 * A bullish setup is rewarded when entry is near an open bullish FVG or an
 * untested/tested bullish OB. A bearish setup matches bearish IOF levels.
 * Tolerance = 0.5 × ATR.
 *
 * @param {number} entryPrice
 * @param {string} direction  'bullish' | 'bearish'
 * @param {Array}  fvgs
 * @param {Array}  orderBlocks
 * @param {number} atrCurrent
 * @returns {number} 0, 10, or 20
 */
function iofConfluenceScore(entryPrice, direction, fvgs, orderBlocks, atrCurrent) {
  const tol = atrCurrent * 0.5;
  let score = 0;

  // Check open FVGs matching direction
  for (const fvg of fvgs) {
    if (fvg.status !== 'open')    continue;
    if (fvg.type  !== direction)  continue;
    if (entryPrice >= fvg.bottom - tol && entryPrice <= fvg.top + tol) {
      score += 10;
      break;
    }
  }

  // Check untested / tested OBs matching direction
  for (const ob of orderBlocks) {
    if (ob.status === 'mitigated') continue;
    if (ob.type   !== direction)   continue;
    if (entryPrice >= ob.bottom - tol && entryPrice <= ob.top + tol) {
      score += 10;
      break;
    }
  }

  return Math.min(score, 20);
}

module.exports = { detectFVGs, detectOrderBlocks, iofConfluenceScore };
