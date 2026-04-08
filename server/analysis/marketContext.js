'use strict';
// Builds market context for a symbol — HP levels, VIX regime, DXY alignment,
// and 16-instrument market breadth scoring.
// Consumed by applyMarketContext() in setups.js to apply multipliers and
// additive bonuses on top of the existing BaseScore from setup detection.
// Pure context builder: all side effects (fetching) are handled via injected getCandles.

const { computeMarketBreadth } = require('./marketBreadth');

// Symbols where DXY alignment is applicable
const DXY_APPLICABLE = new Set(['MNQ', 'MES', 'MGC', 'MCL']);
// Correlation threshold — equity index DXY alignment only applied if |corr| exceeds this
const DXY_CORR_THRESHOLD = 0.5;

/**
 * Build market context object for use in setup scoring.
 *
 * @param {string}   symbol      Instrument symbol, e.g. 'MNQ'
 * @param {Object}   indicators  Result of computeIndicators() for this symbol — used for atrCurrent + ema9
 * @param {Object}   options     Result of getOptionsData(symbol) — may be null
 * @param {Function} getCandles  (symbol, tf) → candle array — injected from index.js
 * @param {Object}   corrMatrix  Result of computeCorrelationMatrix() — may be null
 * @returns {Object} Market context — hp, options, vix, dxy sub-objects
 */
async function buildMarketContext(symbol, indicators, options, getCandles, corrMatrix) {
  const atr          = indicators?.atrCurrent ?? null;
  const ema9         = indicators?.ema9 ?? [];
  const currentPrice = ema9.length ? ema9[ema9.length - 1].value : null;

  // Fetch VIX and DXY candles in parallel — failures return empty arrays
  const [vixCandles, dxyCandles] = await Promise.all([
    _safeGetCandles(getCandles, 'VIX', '5m'),
    _safeGetCandles(getCandles, 'DXY', '5m'),
  ]);

  const vixCtx = _buildVixContext(vixCandles, options);
  const dxyCtx = _buildDxyContext(symbol, dxyCandles, corrMatrix);
  const hpCtx  = _buildHpContext(options, currentPrice, atr);
  const optCtx = _buildOptionsContext(options, vixCtx);

  // Market breadth from 16 CME instruments — supplementary, never required
  let breadth = null;
  try {
    breadth = await computeMarketBreadth(getCandles, symbol);
  } catch (_) {
    // Breadth unavailable — continue without it
  }

  return { hp: hpCtx, options: optCtx, vix: vixCtx, dxy: dxyCtx, breadth };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _safeGetCandles(getCandles, symbol, tf) {
  try {
    const c = getCandles(symbol, tf);
    return Array.isArray(c) && c.length ? c : [];
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HP (Hedge Pressure) context
// ---------------------------------------------------------------------------

function _buildHpContext(options, currentPrice, atr) {
  const safe = {
    nearestLevel: null,
    pressureDirection: 'neutral',
    inCorridor: false,
    corridorBounds: null,
    corridorMultiplierReversal: 1.08,
    corridorMultiplierBreakout: 0.88,
    freshnessDecayPts: 0,
    multiplier: 1.0,
  };

  if (!options || currentPrice == null || atr == null || atr === 0) return safe;

  // Collect all scaled HP levels into a flat list
  const levels = [];
  for (const z of (options.scaledHedgePressureZones ?? [])) {
    levels.push({
      type:     z.pressure === 'support' ? 'HP Sup' : 'HP Res',
      price:    z.strike,
      pressure: z.pressure,
    });
  }
  if (options.scaledGexFlip  != null) levels.push({ type: 'GEX Flip',  price: options.scaledGexFlip,  pressure: 'neutral'    });
  if (options.scaledMaxPain  != null) levels.push({ type: 'Max Pain',  price: options.scaledMaxPain,  pressure: 'neutral'    });
  if (options.scaledCallWall != null) levels.push({ type: 'Call Wall', price: options.scaledCallWall, pressure: 'resistance' });
  if (options.scaledPutWall  != null) levels.push({ type: 'Put Wall',  price: options.scaledPutWall,  pressure: 'support'    });

  if (!levels.length) return safe;

  // Nearest level
  let nearest = null, minDist = Infinity;
  for (const l of levels) {
    const d = Math.abs(l.price - currentPrice);
    if (d < minDist) { minDist = d; nearest = l; }
  }
  const distance_atr    = minDist / atr;
  const nearestLevel    = { type: nearest.type, price: nearest.price, distance_atr: +distance_atr.toFixed(2) };
  const pressureDirection = nearest.price < currentPrice ? 'support'
    : nearest.price > currentPrice ? 'resistance'
    : 'neutral';

  // Corridor: price bracketed by two HP levels ≤2.0 ATR apart
  let inCorridor = false, corridorBounds = null;
  const below = levels.filter(l => l.price <= currentPrice).sort((a, b) => b.price - a.price);
  const above = levels.filter(l => l.price >  currentPrice).sort((a, b) => a.price - b.price);
  if (below.length && above.length) {
    const gap       = above[0].price - below[0].price;
    const width_atr = gap / atr;
    if (width_atr <= 2.0) {
      inCorridor    = true;
      corridorBounds = { low: below[0].price, high: above[0].price, width_atr: +width_atr.toFixed(2) };
    }
  }

  // Distance-based multiplier (neutral; alignment with setup direction resolved in applyMarketContext)
  let multiplier;
  if (distance_atr <= 0.3)       multiplier = 1.05;  // at level — adjusted for alignment in applyMarketContext
  else if (distance_atr <= 0.75) multiplier = 1.10;  // near level
  else                           multiplier = 1.0;   // no nearby level

  const dailyHPNearby = distance_atr <= 0.75;

  // ── Monthly HP proximity ──────────────────────────────────────────────────
  // If weeklyMonthlyHP zones exist, find the nearest monthly HP level and
  // apply an additional multiplier boost when it converges with daily HP.
  let monthlyNearest        = null;
  let monthlyMultiplierDelta = 0;

  const monthlyZones = options.weeklyMonthlyHP?.zones;
  if (Array.isArray(monthlyZones) && monthlyZones.length > 0 && atr > 0) {
    // Use scaled prices if available, else raw strikes
    let mNearest = null, mMinDist = Infinity;
    for (const z of monthlyZones) {
      const price = z.scaled ?? z.strike;
      if (price == null) continue;
      const d = Math.abs(price - currentPrice);
      if (d < mMinDist) { mMinDist = d; mNearest = z; }
    }

    if (mNearest) {
      const mPrice    = mNearest.scaled ?? mNearest.strike;
      const mDistATR  = mMinDist / atr;
      monthlyNearest  = { type: mNearest.pressure, price: mPrice, pressure: mNearest.pressure };

      if (mDistATR <= 0.75) {
        if (dailyHPNearby) {
          // Both daily and monthly HP converge — boost +0.05
          monthlyMultiplierDelta = 0.05;
        } else {
          // Only monthly HP nearby — apply standalone monthly multiplier
          // (lower than daily because monthly OI is more distant in time)
          if (mDistATR <= 0.3)       multiplier = 1.15;  // at monthly level
          else                       multiplier = 1.05;  // near monthly level
        }
      }
    }
  }

  // Apply monthly delta (capped by 0.80–1.30 final clamp)
  multiplier = Math.max(0.80, Math.min(1.30, multiplier + monthlyMultiplierDelta));

  return {
    nearestLevel,
    pressureDirection,
    inCorridor,
    corridorBounds,
    corridorMultiplierReversal: 1.08,
    corridorMultiplierBreakout: 0.88,
    freshnessDecayPts: _freshnessDecay(options.lastFetchedAt),
    multiplier,
    monthlyNearest,
    monthlyMultiplierDelta,
  };
}

/**
 * Freshness decay on options data age.
 * 0DTE days (Mon/Wed/Fri) halve the decay — gamma pinning makes older data less stale.
 */
function _freshnessDecay(lastFetchedAt) {
  if (!lastFetchedAt) return 0;
  const ageMin = (Date.now() - lastFetchedAt) / 60000;
  let decay;
  if      (ageMin < 30)  decay = 0;
  else if (ageMin < 90)  decay = -5;
  else if (ageMin < 180) decay = -10;
  else                   decay = -15;
  const day    = new Date().getDay();
  const is0DTE = (day === 1 || day === 3 || day === 5); // Mon/Wed/Fri
  return is0DTE ? Math.round(decay / 2) : decay;
}

// ---------------------------------------------------------------------------
// Options context (DEX + Resilience labels)
// ---------------------------------------------------------------------------

function _buildOptionsContext(options, vixCtx) {
  if (!options) {
    return { dexScore: 0, dexBias: 'neutral', resilienceLabel: 'neutral' };
  }
  const rl = options.resilienceLabel ?? 'neutral';
  return {
    dexScore:       options.dexScore  ?? 0,
    dexBias:        options.dexBias   ?? 'neutral',
    resilienceLabel: rl,
    // stressFlag exposed here for convenience; authoritative copy lives in vix context
    stressFlag: vixCtx.stressFlag,
  };
}

// ---------------------------------------------------------------------------
// VIX context
// ---------------------------------------------------------------------------

function _buildVixContext(vixCandles, options) {
  if (!vixCandles || vixCandles.length < 4) {
    return { level: null, regime: 'unavailable', direction: 'flat', stressFlag: false };
  }

  const recent    = vixCandles.slice(-5);
  const last      = recent[recent.length - 1];
  const level     = last.close;
  const prev      = (recent[recent.length - 4] ?? recent[0]).close;
  const pctChange = prev > 0 ? (level - prev) / prev : 0;

  const regime    = level > 35 ? 'crisis'
    : level > 25 ? 'elevated'
    : level > 15 ? 'normal'
    : 'low';

  const direction = pctChange > 0.02 ? 'rising'
    : pctChange < -0.02 ? 'falling'
    : 'flat';

  const rl        = options?.resilienceLabel ?? 'neutral';
  const stressFlag = (regime === 'elevated' || regime === 'crisis') && rl === 'fragile';

  const lookupDate = last.time ? new Date(last.time * 1000).toISOString().slice(0, 10) : 'unknown';
  console.log(`[marketContext] VIX lookup date: ${lookupDate} regime=${regime} level=${level.toFixed(2)}`);

  return { level: +level.toFixed(2), regime, direction, stressFlag };
}

// ---------------------------------------------------------------------------
// DXY context
// ---------------------------------------------------------------------------

function _buildDxyContext(symbol, dxyCandles, corrMatrix) {
  const applicable = DXY_APPLICABLE.has(symbol);

  if (!applicable) {
    return { direction: 'flat', correlationWithSymbol: null, applicable: false,
             alignmentBonusLong: 0, alignmentBonusShort: 0 };
  }

  // DXY direction — 0.2% threshold (DXY is a slow-moving index)
  let direction = 'flat';
  if (dxyCandles && dxyCandles.length >= 4) {
    const recent    = dxyCandles.slice(-5);
    const lastBar   = recent[recent.length - 1];
    const lastClose = lastBar.close;
    const prev      = (recent[recent.length - 4] ?? recent[0]).close;
    const pctChange = prev > 0 ? (lastClose - prev) / prev : 0;
    direction = pctChange > 0.002 ? 'rising'
      : pctChange < -0.002 ? 'falling'
      : 'flat';
    const lookupDate = lastBar.time ? new Date(lastBar.time * 1000).toISOString().slice(0, 10) : 'unknown';
    console.log(`[marketContext] DXY lookup date: ${lookupDate} direction=${direction} close=${lastClose.toFixed(2)}`);
  }

  // Correlation from the rolling matrix (MNQ vs DXY, etc.)
  const correlationWithSymbol = corrMatrix?.matrix?.[symbol]?.['DXY'] ?? null;

  // Instrument-specific alignment bonuses
  let alignmentBonusLong = 0, alignmentBonusShort = 0;

  if (symbol === 'MGC') {
    // Gold has the strongest inverse DXY relationship — always apply
    if (direction === 'rising')  { alignmentBonusLong = -8; alignmentBonusShort = +8; }
    if (direction === 'falling') { alignmentBonusLong = +8; alignmentBonusShort = -8; }
  } else if (symbol === 'MCL') {
    // Crude oil: moderate inverse, low weight
    if (direction === 'rising')  { alignmentBonusLong = -3; alignmentBonusShort = +3; }
    if (direction === 'falling') { alignmentBonusLong = +3; alignmentBonusShort = -3; }
  } else if (symbol === 'MNQ' || symbol === 'MES') {
    // Equity index: variable correlation — only apply if above threshold
    const corrAbs = correlationWithSymbol != null ? Math.abs(correlationWithSymbol) : 0;
    if (corrAbs > DXY_CORR_THRESHOLD) {
      if (direction === 'rising')  { alignmentBonusLong = -6; alignmentBonusShort = +6; }
      if (direction === 'falling') { alignmentBonusLong = +6; alignmentBonusShort = -6; }
    }
  }

  return { direction, correlationWithSymbol, applicable, alignmentBonusLong, alignmentBonusShort };
}

// ---------------------------------------------------------------------------

module.exports = { buildMarketContext };
