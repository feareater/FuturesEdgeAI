'use strict';
// Market regime classification: type (trend/range), direction, strength 0-100, alignment.
// Pure function: indicators in → regime out. No I/O.

/**
 * Classify market regime for a single timeframe.
 *
 * @param {Object} indicators  Output from computeIndicators()
 * @returns {{ type: string, direction: string, strength: number }}
 */
function classifyRegime(indicators) {
  const { ema9, ema21, ema50, atrCurrent, swingHighs, swingLows } = indicators;

  if (!ema9.length || !ema21.length || !ema50.length) {
    return { type: 'range', direction: 'neutral', strength: 0 };
  }

  const e9  = ema9[ema9.length - 1].value;
  const e21 = ema21[ema21.length - 1].value;
  const e50 = ema50[ema50.length - 1].value;

  // Direction from EMA stack alignment
  let direction;
  if      (e9 > e21 && e21 > e50) direction = 'bullish';
  else if (e9 < e21 && e21 < e50) direction = 'bearish';
  else                              direction = 'neutral';

  const type = direction !== 'neutral' ? 'trend' : 'range';

  const strength = _computeStrength({ e9, e21, e50, atrCurrent, swingHighs, swingLows, direction });

  console.log(`[regime]  type=${type}  dir=${direction}  strength=${strength}`);
  return { type, direction, strength };
}

/**
 * Compute alignment: do the 15m and 5m regimes agree on direction?
 *
 * @param {{ direction: string }|null} regime15m
 * @param {{ direction: string }|null} regime5m
 * @returns {boolean}
 */
function computeAlignment(regime15m, regime5m) {
  if (!regime15m || !regime5m)                                          return false;
  if (regime15m.direction === 'neutral' || regime5m.direction === 'neutral') return false;
  return regime15m.direction === regime5m.direction;
}

// ---------------------------------------------------------------------------
// Strength scoring (0–100)
// ---------------------------------------------------------------------------

function _computeStrength({ e9, e21, e50, atrCurrent, swingHighs, swingLows, direction }) {
  if (!atrCurrent || atrCurrent === 0) return 0;

  // Component 1 (0–40): EMA spread relative to ATR
  // A wide EMA stack indicates a well-established trend.
  const spread      = Math.abs(e9 - e50);
  const spreadScore = Math.min(40, (spread / atrCurrent) * 20);

  // Component 2 (0–20): ATR as % of mid-price
  // High ATR% = volatile, directional movement (common in trending markets).
  // Scaled so ~0.25% → 10 pts — tuned for MNQ / MGC tick sizes.
  const midPrice = (e9 + e50) / 2;
  const atrPct   = midPrice > 0 ? (atrCurrent / midPrice) * 100 : 0;
  const atrScore = Math.min(20, atrPct * 40);

  // Component 3 (0–40): swing consistency with declared direction
  const swingScore = _swingConsistency(swingHighs, swingLows, direction);

  const raw = spreadScore + atrScore + swingScore;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

function _swingConsistency(swingHighs, swingLows, direction) {
  const N = 4; // examine last N swings of each type
  const recentHighs = swingHighs.slice(-N).map(s => s.value);
  const recentLows  = swingLows.slice(-N).map(s => s.value);

  if (recentHighs.length < 2 && recentLows.length < 2) return 10; // default mid

  let higherHighs = 0, lowerHighs = 0;
  let higherLows  = 0, lowerLows  = 0;

  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i] > recentHighs[i - 1]) higherHighs++;
    else                                       lowerHighs++;
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i] > recentLows[i - 1]) higherLows++;
    else                                     lowerLows++;
  }

  const total = Math.max(1, (recentHighs.length - 1) + (recentLows.length - 1));

  if (direction === 'bullish') {
    // Higher highs + higher lows = consistent uptrend
    return Math.round(((higherHighs + higherLows) / total) * 40);
  }
  if (direction === 'bearish') {
    // Lower highs + lower lows = consistent downtrend
    return Math.round(((lowerHighs + lowerLows) / total) * 40);
  }
  return 10; // neutral — partial score
}

module.exports = { classifyRegime, computeAlignment };
