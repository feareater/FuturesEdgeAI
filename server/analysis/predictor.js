'use strict';
// Directional prediction engine.
// Scores the most recent candle using all available indicator data and
// returns a Long / Short / Neutral call with a predicted price target and
// risk level.  This is a *signal aggregation* model — it weights the same
// evidence the human trader reads from the chart.
//
// Scoring bands:
//   score ≥ +20  → Long   (bullish)
//   score ≤ −20  → Short  (bearish)
//   otherwise    → Neutral
//
// Confidence = min(95, abs(score) × 1.3), clamped to [10, 95].
// Predicted move = ATR × multiplier(confidence).

/**
 * @param {Array}  candles    Full OHLCV array (sorted ascending)
 * @param {Object} ind        Output of computeIndicators()
 * @param {Object} regime     Output of classifyRegime()
 * @param {Array}  trendlines Output of detectTrendlines() (may be [])
 * @param {Array}  openSetups Alerts from alertCache for this symbol+tf with outcome=open
 * @returns {Object} prediction result
 */
function predict(candles, ind, regime, trendlines = [], openSetups = []) {
  if (!candles || candles.length < 20) return null;

  const c      = candles[candles.length - 1];   // current (last confirmed) candle
  const prev3  = candles.slice(-4, -1);         // 3 candles before current
  const atr    = ind.atrCurrent;
  if (!atr || atr === 0) return null;

  const e9  = ind.ema9[ind.ema9.length - 1]?.value   ?? null;
  const e21 = ind.ema21[ind.ema21.length - 1]?.value ?? null;
  const e50 = ind.ema50[ind.ema50.length - 1]?.value ?? null;
  const vw  = ind.vwap[ind.vwap.length - 1]?.value   ?? null;

  let score = 0;
  const factors = [];

  // ── EMA Stack ────────────────────────────────────────────────────────────
  if (e9 !== null && e21 !== null && e50 !== null) {
    if (e9 > e21 && e21 > e50) {
      score += 25;
      factors.push({ label: 'EMA full bull stack', pts: +25 });
    } else if (e9 < e21 && e21 < e50) {
      score -= 25;
      factors.push({ label: 'EMA full bear stack', pts: -25 });
    } else if (e9 > e21) {
      score += 10;
      factors.push({ label: 'EMA partial bull (9>21)', pts: +10 });
    } else if (e9 < e21) {
      score -= 10;
      factors.push({ label: 'EMA partial bear (9<21)', pts: -10 });
    }
    // Price relative to EMA9 (momentum)
    if (c.close > e9) { score += 5; factors.push({ label: 'Price above EMA9', pts: +5 }); }
    else              { score -= 5; factors.push({ label: 'Price below EMA9', pts: -5 }); }
  }

  // ── Price vs VWAP ────────────────────────────────────────────────────────
  if (vw !== null) {
    const vwapDist = (c.close - vw) / atr;
    if (vwapDist > 1.5) {
      score -= 5; factors.push({ label: 'Stretched above VWAP', pts: -5 });
    } else if (vwapDist > 0) {
      score += 10; factors.push({ label: 'Price above VWAP', pts: +10 });
    } else if (vwapDist < -1.5) {
      score += 5; factors.push({ label: 'Stretched below VWAP', pts: +5 });
    } else {
      score -= 10; factors.push({ label: 'Price below VWAP', pts: -10 });
    }
  }

  // ── Market Regime ────────────────────────────────────────────────────────
  if (regime) {
    const { type, direction, strength = 50 } = regime;
    const regimePts = Math.round((strength / 100) * 20);
    if (type === 'trend' && direction === 'bullish') {
      score += regimePts; factors.push({ label: `Trend regime bullish (str ${strength})`, pts: +regimePts });
    } else if (type === 'trend' && direction === 'bearish') {
      score -= regimePts; factors.push({ label: `Trend regime bearish (str ${strength})`, pts: -regimePts });
    }
    // Regime alignment bonus (15m + 5m agree)
    if (regime.alignment === true && direction !== 'neutral') {
      const alignPts = direction === 'bullish' ? +8 : -8;
      score += alignPts; factors.push({ label: 'TF regime aligned', pts: alignPts });
    }
  }

  // ── Recent Candle Momentum ───────────────────────────────────────────────
  let momentumPts = 0;
  for (const pc of prev3) {
    if (pc.close > pc.open)  momentumPts += 5;
    else                     momentumPts -= 5;
  }
  // Current candle body direction
  if (c.close > c.open) momentumPts += 5;
  else                  momentumPts -= 5;

  if (momentumPts !== 0) {
    score += momentumPts;
    factors.push({ label: `Recent candle momentum`, pts: momentumPts });
  }

  // ── PDH / PDL ─────────────────────────────────────────────────────────────
  if (ind.pdh && ind.pdl) {
    const nearThresh = atr * 0.5;
    if (c.close > ind.pdh) {
      score += 10; factors.push({ label: 'Above Prior Day High', pts: +10 });
    } else if (c.close < ind.pdl) {
      score -= 10; factors.push({ label: 'Below Prior Day Low', pts: -10 });
    } else if (ind.pdh - c.close < nearThresh) {
      score -= 5; factors.push({ label: 'Near PDH resistance', pts: -5 });
    } else if (c.close - ind.pdl < nearThresh) {
      score += 5; factors.push({ label: 'Near PDL support', pts: +5 });
    }
  }

  // ── Volume Profile POC ───────────────────────────────────────────────────
  if (ind.volumeProfile?.poc) {
    const pocDist = c.close - ind.volumeProfile.poc;
    if (pocDist > atr * 0.5) {
      score += 5; factors.push({ label: 'Above POC (value area)', pts: +5 });
    } else if (pocDist < -atr * 0.5) {
      score -= 5; factors.push({ label: 'Below POC (value area)', pts: -5 });
    }
  }

  // ── Trendlines ───────────────────────────────────────────────────────────
  if (trendlines && trendlines.length > 0) {
    const lastTime = c.time;
    for (const tl of trendlines) {
      if (!tl.anchor || !tl.slope) continue;
      const tlPrice = tl.anchor + tl.slope * (lastTime - (tl.anchorTime ?? lastTime));
      const dist = c.close - tlPrice;
      if (tl.type === 'support' && Math.abs(dist) < atr * 0.3 && dist >= 0) {
        score += 8; factors.push({ label: 'At support trendline', pts: +8 });
      } else if (tl.type === 'resistance' && Math.abs(dist) < atr * 0.3 && dist <= 0) {
        score -= 8; factors.push({ label: 'At resistance trendline', pts: -8 });
      } else if (tl.type === 'support' && dist < 0 && Math.abs(dist) < atr * 0.5) {
        score -= 5; factors.push({ label: 'Broke below support TL', pts: -5 }); break;
      } else if (tl.type === 'resistance' && dist > 0 && Math.abs(dist) < atr * 0.5) {
        score += 5; factors.push({ label: 'Broke above resistance TL', pts: +5 }); break;
      }
    }
  }

  // ── Open Setups (from alert cache) ───────────────────────────────────────
  const bullSetups = openSetups.filter(a => a.setup.direction === 'bullish' && a.setup.confidence >= 65);
  const bearSetups = openSetups.filter(a => a.setup.direction === 'bearish' && a.setup.confidence >= 65);
  const setupBull  = Math.min(bullSetups.length * 8, 24);
  const setupBear  = Math.min(bearSetups.length * 8, 24);
  if (setupBull > 0) { score += setupBull; factors.push({ label: `${bullSetups.length} open bull setup(s)`, pts: +setupBull }); }
  if (setupBear > 0) { score -= setupBear; factors.push({ label: `${bearSetups.length} open bear setup(s)`, pts: -setupBear }); }

  // ── FVG Zones ─────────────────────────────────────────────────────────────
  if (ind.fvgs) {
    let inBullFVG = false, inBearFVG = false;
    for (const fvg of ind.fvgs) {
      if (fvg.status !== 'open') continue;
      if (fvg.type === 'bullish' && c.close >= fvg.low && c.close <= fvg.high) { inBullFVG = true; break; }
      if (fvg.type === 'bearish' && c.close >= fvg.low && c.close <= fvg.high) { inBearFVG = true; break; }
    }
    if (inBullFVG) { score += 7; factors.push({ label: 'Inside bullish FVG', pts: +7 }); }
    if (inBearFVG) { score -= 7; factors.push({ label: 'Inside bearish FVG', pts: -7 }); }
  }

  // ── Order Blocks ─────────────────────────────────────────────────────────
  if (ind.orderBlocks) {
    for (const ob of ind.orderBlocks) {
      if (ob.status !== 'untested') continue;
      const inZone = c.close >= ob.low && c.close <= ob.high;
      const nearZone = !inZone && Math.abs(c.close - ((ob.high + ob.low) / 2)) < atr * 0.6;
      if ((inZone || nearZone) && ob.type === 'bullish') {
        score += 8; factors.push({ label: 'Near/in demand OB', pts: +8 }); break;
      }
      if ((inZone || nearZone) && ob.type === 'bearish') {
        score -= 8; factors.push({ label: 'Near/in supply OB', pts: -8 }); break;
      }
    }
  }

  // ── Derive direction + confidence ────────────────────────────────────────
  const direction  = score >= 20 ? 'bullish' : score <= -20 ? 'bearish' : 'neutral';
  const confidence = Math.min(95, Math.max(10, Math.round(Math.abs(score) * 1.3)));

  // ── Predicted price move ─────────────────────────────────────────────────
  // ATR-based: scale multiplier with confidence
  const atrMult    = confidence >= 75 ? 1.5 : confidence >= 55 ? 1.0 : 0.6;
  const movePoints = +(atr * atrMult).toFixed(2);

  const targetUp   = +(c.close + movePoints).toFixed(4);
  const targetDown = +(c.close - movePoints).toFixed(4);

  // For the predicted direction, TP is in direction, risk is opposite (half the move)
  const predictedTP = direction === 'bullish' ? targetUp
                    : direction === 'bearish' ? targetDown
                    : null;
  const predictedSL = direction === 'bullish' ? +(c.close - movePoints * 0.5).toFixed(4)
                    : direction === 'bearish' ? +(c.close + movePoints * 0.5).toFixed(4)
                    : null;

  // Sort factors by abs(pts) desc, limit to top 6 for display
  factors.sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
  const topFactors = factors.slice(0, 6);

  return {
    direction,
    confidence,
    score,
    price:       c.close,
    candleTime:  c.time,
    atr,
    movePoints,
    predictedTP,
    predictedSL,
    targetUp,
    targetDown,
    factors:     topFactors,
  };
}

module.exports = { predict };
