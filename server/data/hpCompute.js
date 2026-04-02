'use strict';
/**
 * hpCompute.js — Black-Scholes HP (Hedge Pressure) computation for historical backtest
 *
 * Inputs:  contracts array, underlying close price, date string
 * Outputs: full HP snapshot (same shape as server/data/options.js live output)
 *
 * This module is pure computation — no I/O, no side effects.
 * All monetary values in USD (ETF space). Caller scales to futures if desired.
 */

const RISK_FREE = 0.043; // 4.3% risk-free rate, reasonable for 2026

// ─── Normal Distribution ────────────────────────────────────────────────────

/**
 * Standard normal CDF via Horner-method rational approximation.
 * Max error: ~7.5e-8 (Abramowitz & Stegun 26.2.17)
 */
function normalCDF(x) {
  if (x < -8) return 0;
  if (x >  8) return 1;
  const neg = x < 0;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * z);
  const poly = t * (0.319381530
    + t * (-0.356563782
    + t * (1.781477937
    + t * (-1.821255978
    + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return neg ? 1 - cdf : cdf;
}

/** Standard normal PDF */
function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ─── Black-Scholes ───────────────────────────────────────────────────────────

/**
 * Compute d1, d2 for Black-Scholes.
 * Returns null if inputs are invalid (T<=0, sigma<=0, S<=0, K<=0).
 */
function bsD1D2(S, K, T, r, sigma) {
  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return null;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return { d1, d2 };
}

/** Black-Scholes delta: call = N(d1), put = N(d1) - 1 */
function bsDelta(S, K, T, r, sigma, type) {
  const dd = bsD1D2(S, K, T, r, sigma);
  if (!dd) return 0;
  const n1 = normalCDF(dd.d1);
  return type === 'C' ? n1 : n1 - 1;
}

/** Black-Scholes gamma: N'(d1) / (S × σ × √T) */
function bsGamma(S, K, T, r, sigma) {
  const dd = bsD1D2(S, K, T, r, sigma);
  if (!dd) return 0;
  return normalPDF(dd.d1) / (S * sigma * Math.sqrt(T));
}

// ─── IV Approximation ────────────────────────────────────────────────────────

/**
 * Estimate ATM implied volatility from realized volatility of the underlying.
 * dailyLogReturns: array of log(close[i]/close[i-1]) for recent N days.
 * DTE: days to expiration for the target option.
 */
function estimateATMIV(dailyLogReturns, dte) {
  if (!dailyLogReturns || dailyLogReturns.length < 5) return 0.20; // fallback 20%
  const n = dailyLogReturns.length;
  const mean = dailyLogReturns.reduce((a, b) => a + b, 0) / n;
  const variance = dailyLogReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const annualizedVol = Math.sqrt(variance * 252);
  // Term structure factor: slight vol premium for shorter-term options
  const termFactor = 1 + 0.1 * (dte / 30 - 1);
  return Math.max(0.05, Math.min(1.5, annualizedVol * termFactor));
}

// ─── Max Pain ────────────────────────────────────────────────────────────────

/**
 * Strike K that minimizes total intrinsic payout to all option buyers.
 * Formula: Σ(max(0, S-K) × callOI + max(0, K-S) × putOI) where S is the tested strike.
 */
function computeMaxPain(contracts) {
  const strikes = [...new Set(contracts.map(c => c.strike))].sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  let minPain = Infinity;
  let maxPainStrike = strikes[0];

  for (const testStrike of strikes) {
    let pain = 0;
    for (const c of contracts) {
      if (c.type === 'C') {
        pain += Math.max(0, testStrike - c.strike) * c.oi;
      } else {
        pain += Math.max(0, c.strike - testStrike) * c.oi;
      }
    }
    if (pain < minPain) {
      minPain = pain;
      maxPainStrike = testStrike;
    }
  }
  return maxPainStrike;
}

// ─── GEX Flip ────────────────────────────────────────────────────────────────

/**
 * Nearest strike to spot where per-strike net GEX changes sign.
 * Scans outward from spot alternating above/below.
 * contracts: array of { strike, gex } (per-strike net GEX already summed)
 */
function computeGexFlip(strikeGexMap, spot) {
  const strikes = Object.keys(strikeGexMap).map(Number).sort((a, b) => a - b);
  if (strikes.length < 2) return null;

  // Find strikes above and below spot
  const above = strikes.filter(s => s > spot).sort((a, b) => a - b);
  const below = strikes.filter(s => s <= spot).sort((a, b) => b - a);

  const spotStrikeGex = strikeGexMap[strikes.reduce((prev, curr) =>
    Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev)];

  // Scan outward
  let ai = 0, bi = 0;
  while (ai < above.length || bi < below.length) {
    if (ai < above.length) {
      const g = strikeGexMap[above[ai]];
      if (spotStrikeGex > 0 && g < 0) return above[ai];
      if (spotStrikeGex < 0 && g > 0) return above[ai];
      if (spotStrikeGex === 0 && g !== 0) return above[ai];
      ai++;
    }
    if (bi < below.length) {
      const g = strikeGexMap[below[bi]];
      if (spotStrikeGex > 0 && g < 0) return below[bi];
      if (spotStrikeGex < 0 && g > 0) return below[bi];
      if (spotStrikeGex === 0 && g !== 0) return below[bi];
      bi++;
    }
  }
  return null;
}

// ─── Resilience Score ────────────────────────────────────────────────────────

/**
 * Resilience score (0–100) matching options.js logic:
 *   GEX component: +50 (positive GEX) or -50 (negative GEX), adjusted ±30 by distance from flip
 *   DEX alignment bonus: +15 if DEX opposes GEX regime, -10 if aligned
 */
function computeResilienceScore(totalGex, totalDex, gexFlip, spot) {
  let score = 50;

  // GEX component
  const gexSign = totalGex >= 0 ? 1 : -1;
  score += gexSign * 50;

  // Distance from GEX flip as confidence modifier
  if (gexFlip != null && spot > 0) {
    const dist = Math.abs(spot - gexFlip) / spot;
    const confidence = Math.min(1, dist / 0.02); // 2% away = full confidence
    score += gexSign * 30 * confidence - gexSign * 30 * (1 - confidence);
  }

  // DEX alignment: if DEX and GEX point opposite → absorbing → bullish for resilience
  const dexSign = totalDex > 0 ? 1 : -1;
  if (dexSign !== gexSign) {
    score += 15; // opposing = absorbing shocks
  } else {
    score -= 10; // aligned = amplifying
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ─── Main HP Computation ─────────────────────────────────────────────────────

/**
 * computeHP — compute full HP snapshot for one date/underlying.
 *
 * @param {object} params
 * @param {string} params.date          'YYYY-MM-DD'
 * @param {string} params.underlying    'QQQ' | 'SPY'
 * @param {string} params.futuresProxy  'MNQ' | 'MES'
 * @param {number} params.etfClose      ETF closing price
 * @param {number} params.futuresClose  Futures closing price on same date
 * @param {Array}  params.contracts     [{ symbol, strike, expiry, type, oi }]
 * @param {Array}  params.dailyLogReturns  Recent 20-day log returns of ETF (for IV)
 *
 * @returns {object} HP snapshot — same field names as options.js live output
 */
function computeHP({ date, underlying, futuresProxy, etfClose, futuresClose, contracts, dailyLogReturns }) {
  const S = etfClose;
  const scalingRatio = (futuresClose && etfClose) ? futuresClose / etfClose : null;

  // Filter contracts to valid range: ±25% from spot, OI > 0, expiry within 45 days
  const dateObj = new Date(date + 'T00:00:00Z');
  const filtered = contracts.filter(c => {
    if (c.oi <= 0) return false;
    if (c.strike < S * 0.75 || c.strike > S * 1.25) return false;
    const expDate = new Date(c.expiry + 'T00:00:00Z');
    const dte = (expDate - dateObj) / 86400000;
    if (dte < 0 || dte > 45) return false;
    return true;
  });

  if (filtered.length === 0) {
    return _emptySnapshot(date, underlying, futuresProxy, etfClose, futuresClose, scalingRatio);
  }

  // Find ATM contracts (20-45 DTE, closest to spot) for IV estimation
  const atmCandidates = filtered.filter(c => {
    const expDate = new Date(c.expiry + 'T00:00:00Z');
    const dte = (expDate - dateObj) / 86400000;
    return dte >= 20 && dte <= 45 && c.type === 'C';
  });

  let atmDTE = 30;
  if (atmCandidates.length > 0) {
    const closest = atmCandidates.reduce((prev, curr) =>
      Math.abs(curr.strike - S) < Math.abs(prev.strike - S) ? curr : prev);
    const expDate = new Date(closest.expiry + 'T00:00:00Z');
    atmDTE = (expDate - dateObj) / 86400000;
  }

  const atmIV = estimateATMIV(dailyLogReturns, atmDTE);

  // Per-contract Greeks
  let totalGex = 0;
  let totalDex = 0;
  let totalCallOI = 0;
  let totalPutOI = 0;

  // Aggregate per-strike data
  const strikeData = {}; // strike → { callOI, putOI, netGex }

  for (const c of filtered) {
    const expDate = new Date(c.expiry + 'T00:00:00Z');
    const T = (expDate - dateObj) / (365 * 86400000); // years
    if (T <= 0) continue;

    const gamma = bsGamma(S, c.strike, T, RISK_FREE, atmIV);
    const delta = bsDelta(S, c.strike, T, RISK_FREE, atmIV, c.type);

    const contractSign = c.type === 'C' ? 1 : -1;
    const gex = contractSign * gamma * c.oi * 100 * S;
    const dex = delta * c.oi * 100;

    totalGex += gex;
    totalDex += dex;

    if (c.type === 'C') totalCallOI += c.oi;
    else totalPutOI += c.oi;

    if (!strikeData[c.strike]) strikeData[c.strike] = { callOI: 0, putOI: 0, netGex: 0 };
    if (c.type === 'C') strikeData[c.strike].callOI += c.oi;
    else strikeData[c.strike].putOI += c.oi;
    strikeData[c.strike].netGex += gex;
  }

  const strikes = Object.keys(strikeData).map(Number).sort((a, b) => a - b);

  // OI walls: top 3 strikes by combined OI
  const oiWalls = strikes
    .map(k => ({ strike: k, totalOI: strikeData[k].callOI + strikeData[k].putOI }))
    .sort((a, b) => b.totalOI - a.totalOI)
    .slice(0, 3)
    .map(x => x.strike)
    .sort((a, b) => a - b);

  // Max pain
  const maxPain = computeMaxPain(filtered);

  // Call wall: highest OI call strike above spot
  const callsAbove = strikes.filter(k => k > S);
  const callWall = callsAbove.length > 0
    ? callsAbove.reduce((best, k) =>
        strikeData[k].callOI > strikeData[best].callOI ? k : best, callsAbove[0])
    : null;

  // Put wall: highest OI put strike below spot
  const putsBelow = strikes.filter(k => k <= S);
  const putWall = putsBelow.length > 0
    ? putsBelow.reduce((best, k) =>
        strikeData[k].putOI > strikeData[best].putOI ? k : best, putsBelow[0])
    : null;

  // GEX flip
  const strikeGexMap = {};
  for (const k of strikes) strikeGexMap[k] = strikeData[k].netGex;
  const gexFlip = computeGexFlip(strikeGexMap, S);

  // DEX score
  const allDex = Object.values(strikeData).map(d => Math.abs(d.callOI - d.putOI) * 100);
  const maxAbsDex = allDex.length > 0 ? Math.max(...allDex) : 1;
  const dexScore = Math.round(Math.max(-100, Math.min(100, (totalDex / (maxAbsDex || 1)) * 100)));
  const dexBias = dexScore > 20 ? 'bullish' : dexScore < -20 ? 'bearish' : 'neutral';

  // PC ratio
  const pcRatio = totalCallOI > 0 ? +(totalPutOI / totalCallOI).toFixed(3) : null;

  // Resilience
  const resilienceScore = computeResilienceScore(totalGex, totalDex, gexFlip, S);
  const resilienceLabel = resilienceScore >= 65 ? 'resilient'
    : resilienceScore >= 40 ? 'neutral' : 'fragile';

  // Hedge pressure zones: top 5 strikes by |netGex|
  const hedgePressureZones = strikes
    .map(k => ({ strike: k, gex: strikeData[k].netGex, pressure: strikeData[k].netGex >= 0 ? 'support' : 'resistance' }))
    .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
    .slice(0, 5);

  // OI wall levels (ETF space)
  const oiWallPrices = oiWalls;

  // Scale to futures space
  const scale = (v) => (v == null || isNaN(v) || !scalingRatio) ? null : Math.round(v * scalingRatio * 4) / 4;

  const result = {
    date,
    underlying,
    futuresProxy,
    etfClose: S,
    futuresClose,
    scalingRatio: scalingRatio ? +scalingRatio.toFixed(4) : null,
    atmIV: +atmIV.toFixed(4),
    ivSource: 'realized_vol_proxy',
    totalGex: Math.round(totalGex),
    totalDex: Math.round(totalDex),
    dexScore,
    dexBias,
    pcRatio,
    resilienceScore,
    resilienceLabel,
    oiWalls: oiWallPrices,
    maxPain,
    callWall,
    putWall,
    gexFlip,
    hedgePressureZones,
    scaledOiWalls: scalingRatio ? oiWallPrices.map(scale) : null,
    scaledMaxPain: scale(maxPain),
    scaledCallWall: scale(callWall),
    scaledPutWall: scale(putWall),
    scaledGexFlip: scale(gexFlip),
    scaledHedgePressureZones: scalingRatio
      ? hedgePressureZones.map(z => ({ ...z, scaledStrike: scale(z.strike) }))
      : null,
    computedAt: new Date().toISOString(),
  };

  return result;
}

function _emptySnapshot(date, underlying, futuresProxy, etfClose, futuresClose, scalingRatio) {
  return {
    date, underlying, futuresProxy,
    etfClose, futuresClose,
    scalingRatio: scalingRatio ? +scalingRatio.toFixed(4) : null,
    atmIV: null, ivSource: 'no_contracts',
    totalGex: 0, totalDex: 0, dexScore: 0, dexBias: 'neutral',
    pcRatio: null, resilienceScore: 50, resilienceLabel: 'neutral',
    oiWalls: [], maxPain: null, callWall: null, putWall: null, gexFlip: null,
    hedgePressureZones: [],
    scaledOiWalls: null, scaledMaxPain: null, scaledCallWall: null,
    scaledPutWall: null, scaledGexFlip: null, scaledHedgePressureZones: null,
    computedAt: new Date().toISOString(),
  };
}

module.exports = { computeHP, estimateATMIV, normalCDF, bsDelta, bsGamma };
