'use strict';
// Bias computation: setup readiness gate checks and directional bias scoring.
// Consumed by GET /api/bias endpoint. Pure computation — no side effects.

const { INSTRUMENTS } = require('../data/instruments');

/**
 * Evaluate whether current conditions would allow an OR breakout to fire
 * and pass all hard gates. Mirrors the exact gate logic from setups.js v14.11.
 *
 * @param {string} symbol
 * @param {Object} marketContext - from buildMarketContext()
 * @param {number} currentHour  - current ET hour (0–23)
 * @returns {Object} readiness object
 */
function computeSetupReadiness(symbol, marketContext, currentHour, mode = 'auto') {
  const gates = [];

  // --- DXY direction source (same priority as setups.js) ---
  // breadth.dollarRegime available in both live and backtest; dxy.direction is live-only fallback
  const rawDollarRegime = marketContext?.breadth?.dollarRegime;
  let dxyDirection;
  if (rawDollarRegime === 'rising' || rawDollarRegime === 'falling') {
    dxyDirection = rawDollarRegime;
  } else if (rawDollarRegime) {
    dxyDirection = 'flat';
  } else {
    dxyDirection = marketContext?.dxy?.direction ?? 'flat';
  }

  const dexBias       = marketContext?.options?.dexBias ?? null;
  const riskAppetite  = marketContext?.breadth?.riskAppetite ?? 'neutral';
  const equityBreadth = marketContext?.breadth?.equityBreadth ?? 2;
  const vixRegime     = marketContext?.vix?.regime ?? 'normal';

  // Gate 1 — DEX bias neutral (Filter 3)
  const g1Triggered = dexBias === 'neutral';
  const g1Status = g1Triggered ? (mode === 'manual' ? 'caution' : 'blocked') : 'pass';
  gates.push({
    id: 'dex-neutral',
    label: 'DEX Neutral',
    status: g1Status,
    detail: g1Triggered
      ? 'DEX neutral — options flow has no directional conviction'
      : `DEX bias: ${dexBias ?? 'n/a'} — directional flow confirmed`,
  });

  // Gate 2 — DXY rising + hour >= 11 (Filter 1)
  const g2Triggered = dxyDirection === 'rising' && currentHour >= 11;
  const g2Status = g2Triggered ? (mode === 'manual' ? 'caution' : 'blocked') : 'pass';
  gates.push({
    id: 'dxy-rising-late',
    label: 'DXY Rising Late Session',
    status: g2Status,
    detail: g2Triggered
      ? 'DXY rising after hour 11 — breakout momentum suppressed'
      : `DXY ${dxyDirection}, hour ${currentHour} — no late-session block`,
  });

  // Gate 3 — DXY rising score penalty (Filter 5)
  const g3Caution = dxyDirection === 'rising' && currentHour <= 10;
  gates.push({
    id: 'dxy-rising-penalty',
    label: 'DXY Rising (-8 pts)',
    status: g3Caution ? 'caution' : 'pass',
    detail: g3Caution
      ? 'DXY rising — 8pt confidence penalty applied'
      : `DXY ${dxyDirection} — no early-session penalty`,
  });

  // Gate 4 — Risk appetite off + equity breadth collapse
  const g4Caution = riskAppetite === 'off' && equityBreadth <= 1;
  gates.push({
    id: 'risk-off-breadth',
    label: 'Risk-Off + Breadth Collapse (-15 pts)',
    status: g4Caution ? 'caution' : 'pass',
    detail: g4Caution
      ? `Risk appetite off with ≤1 bullish index — structural headwind`
      : `Risk appetite: ${riskAppetite}, equity breadth: ${equityBreadth}`,
  });

  // Gate 5 — VIX crisis regime
  const g5Caution = vixRegime === 'crisis';
  gates.push({
    id: 'vix-crisis',
    label: 'Crisis VIX',
    status: g5Caution ? 'caution' : 'pass',
    detail: g5Caution
      ? 'VIX crisis regime — multiplier headwind on breakout setups'
      : `VIX regime: ${vixRegime}`,
  });

  // Gate 6 — High-impact calendar event nearby
  // marketContext doesn't carry calendar events directly; check the nearEvent flag
  // which is set by the scan engine. For the bias panel we check if calendarEvents
  // were passed through on the context (they may not be). This is a best-effort check.
  const hasNearEvent = marketContext?._calendarNearEvent === true;
  gates.push({
    id: 'calendar-event',
    label: 'High-Impact Event Near',
    status: hasNearEvent ? 'caution' : 'pass',
    detail: hasNearEvent
      ? 'High-impact economic event within 15 minutes'
      : 'No high-impact events nearby',
  });

  const blockedCount = gates.filter(g => g.status === 'blocked').length;
  const cautionCount = gates.filter(g => g.status === 'caution').length;
  const overallStatus = blockedCount > 0 ? 'blocked'
    : cautionCount > 0 ? 'caution'
    : 'ready';

  return {
    symbol,
    timestamp: new Date().toISOString(),
    overallStatus,
    gates,
    blockedCount,
    cautionCount,
  };
}

/**
 * Score the net directional weight of all current signals.
 *
 * @param {string} symbol
 * @param {Object} marketContext - from buildMarketContext()
 * @param {Object} indicators   - from computeIndicators() (15m TF)
 * @returns {Object} bias object
 */
function computeDirectionalBias(symbol, marketContext, indicators) {
  const signals = [];
  let totalScore = 0;

  // --- Helper ---
  function addSignal(label, value, contribution) {
    const dir = contribution > 0 ? 'bull' : contribution < 0 ? 'bear' : 'neutral';
    signals.push({ label, value, contribution, direction: dir });
    totalScore += contribution;
  }

  // 1. DEX bias
  const dexBias = marketContext?.options?.dexBias ?? 'neutral';
  const dexPts = dexBias === 'bullish' ? 3 : dexBias === 'bearish' ? -3 : 0;
  addSignal('DEX Bias', dexBias, dexPts);

  // 2. DXY direction (skip for MCL — dollar has inverse/no relationship with crude)
  const rawDollarRegime = marketContext?.breadth?.dollarRegime;
  let dxyDir;
  if (rawDollarRegime === 'rising' || rawDollarRegime === 'falling') {
    dxyDir = rawDollarRegime;
  } else if (rawDollarRegime) {
    dxyDir = 'flat';
  } else {
    dxyDir = marketContext?.dxy?.direction ?? 'flat';
  }
  let dxyPts = 0;
  if (symbol !== 'MCL') {
    dxyPts = dxyDir === 'falling' ? 2 : dxyDir === 'rising' ? -2 : 0;
  }
  addSignal('DXY Direction', dxyDir, dxyPts);

  // 3. Equity breadth (0–4)
  const eqBreadth = marketContext?.breadth?.equityBreadth ?? 2;
  const eqPts = eqBreadth === 4 ? 3 : eqBreadth === 3 ? 1 : eqBreadth === 1 ? -1 : eqBreadth === 0 ? -3 : 0;
  addSignal('Equity Breadth', `${eqBreadth}/4`, eqPts);

  // 4. Risk appetite
  const riskApp = marketContext?.breadth?.riskAppetite ?? 'neutral';
  const riskPts = riskApp === 'on' ? 2 : riskApp === 'off' ? -2 : 0;
  addSignal('Risk Appetite', riskApp, riskPts);

  // 5. Bond regime
  const bondRegime = marketContext?.breadth?.bondRegime ?? 'neutral';
  const bondPts = bondRegime === 'bearish' ? 1 : bondRegime === 'bullish' ? -1 : 0;
  addSignal('Bond Regime', bondRegime, bondPts);

  // 6. VIX regime + direction
  const vixRegime = marketContext?.vix?.regime ?? 'normal';
  const vixDir    = marketContext?.vix?.direction ?? 'flat';
  const vixRegPts = vixRegime === 'low' ? 1 : vixRegime === 'elevated' ? -1 : vixRegime === 'crisis' ? -2 : 0;
  const vixDirPts = vixDir === 'falling' ? 1 : vixDir === 'rising' ? -1 : 0;
  addSignal('VIX Regime', vixRegime, vixRegPts);
  addSignal('VIX Direction', vixDir, vixDirPts);

  // 7. Resilience
  const resLabel = marketContext?.options?.resilienceLabel ?? 'neutral';
  const resPts = resLabel === 'resilient' ? 1 : resLabel === 'fragile' ? -1 : 0;
  addSignal('Resilience', resLabel, resPts);

  // 8. Market regime (from indicators.regime if available)
  // Score based on regime direction as a signed value — bullish regime contributes
  // positively to bullish bias, bearish regime contributes negatively.
  // Also check regime.direction string with .includes() for robustness.
  const regime = indicators?.regime ?? null;
  let regimePts = 0;
  let regimeDir = 'neutral';
  if (regime && regime.direction) {
    const rd = regime.direction.toLowerCase();
    if (rd.includes('bullish'))      { regimeDir = 'bullish'; }
    else if (rd.includes('bearish')) { regimeDir = 'bearish'; }
  }
  if (regime && regime.type === 'trend') {
    if (regimeDir === 'bullish')      regimePts = 2;
    else if (regimeDir === 'bearish') regimePts = -2;
  } else if (regime && regime.type === 'range') {
    // Range regime is a weaker signal
    if (regimeDir === 'bullish')      regimePts = 1;
    else if (regimeDir === 'bearish') regimePts = -1;
  }
  const regimeLabel = regime ? `${regime.type}/${regimeDir}` : 'n/a';
  addSignal('Market Regime', regimeLabel, regimePts);

  // 9. Daily HP nearest — score based on HP level position RELATIVE to price
  // HP above price = resistance; HP below price = support
  // Support is bullish (+), resistance is bearish (-)
  const hasOptionsProxy = INSTRUMENTS[symbol]?.optionsProxy != null;
  const dailyHPLevel = marketContext?.hp?.nearestLevel ?? null;
  const currentPrice = marketContext?.hp?._currentPrice ?? null;
  let dailyHpPts = 0;
  let dailyHpLabel = hasOptionsProxy ? 'none' : 'N/A';
  let dailyHpDetail = null;
  if (!hasOptionsProxy) {
    // No options proxy for this symbol — show N/A instead of misleading neutral
    dailyHpPts = 0;
    dailyHpLabel = 'N/A (no options proxy)';
  } else if (dailyHPLevel && dailyHPLevel.price != null && currentPrice != null) {
    const hpPrice = dailyHPLevel.price;
    const distPts = Math.abs(hpPrice - currentPrice);
    if (hpPrice < currentPrice) {
      // HP below price → support → bullish contribution
      dailyHpPts = 1;
      dailyHpLabel = 'support';
    } else if (hpPrice > currentPrice) {
      // HP above price → resistance → bearish contribution
      dailyHpPts = -1;
      dailyHpLabel = 'resistance';
    }
    // else HP at price → neutral
    dailyHpDetail = { level: +hpPrice.toFixed(2), distance: +distPts.toFixed(2), type: dailyHPLevel.type };
  } else {
    // Fallback to pressureDirection if _currentPrice not available
    const pressureDir = marketContext?.hp?.pressureDirection ?? 'neutral';
    dailyHpPts = pressureDir === 'support' ? 1 : pressureDir === 'resistance' ? -1 : 0;
    dailyHpLabel = pressureDir;
  }
  const dailyHpSig = { label: 'Daily HP', value: dailyHpLabel, contribution: dailyHpPts, direction: dailyHpPts > 0 ? 'bull' : dailyHpPts < 0 ? 'bear' : 'neutral' };
  if (dailyHpDetail) dailyHpSig.detail = dailyHpDetail;
  signals.push(dailyHpSig);
  totalScore += dailyHpPts;

  // 10. Monthly HP nearest (heavier weight) — score based on HP level vs current price
  // NEVER use zone metadata (pressure field) — only compare price positions directly
  const monthlyNearest = marketContext?.hp?.monthlyNearest ?? null;
  let monthlyPts = 0;
  let monthlyHpLabel = hasOptionsProxy ? 'none' : 'N/A';
  let monthlyHpDetail = null;
  if (!hasOptionsProxy) {
    // No options proxy — show N/A
    monthlyPts = 0;
    monthlyHpLabel = 'N/A (no options proxy)';
  } else if (monthlyNearest && currentPrice != null) {
    // Extract HP price from available fields
    const mPrice = monthlyNearest.price ?? monthlyNearest.strike ?? monthlyNearest.scaled ?? null;
    if (mPrice != null) {
      const mDistPts = Math.abs(mPrice - currentPrice);
      if (mPrice < currentPrice) {
        // Monthly HP below price → support → bullish
        monthlyPts = 2;
        monthlyHpLabel = 'support';
      } else if (mPrice > currentPrice) {
        // Monthly HP above price → resistance → bearish
        monthlyPts = -2;
        monthlyHpLabel = 'resistance';
      }
      monthlyHpDetail = { level: +mPrice.toFixed(2), distance: +mDistPts.toFixed(2) };
    }
    // If no numeric price available, leave as 'none' / 0 — do NOT fall back to zone metadata
  }
  const monthlyHpSig = { label: 'Monthly HP', value: monthlyHpLabel, contribution: monthlyPts, direction: monthlyPts > 0 ? 'bull' : monthlyPts < 0 ? 'bear' : 'neutral' };
  if (monthlyHpDetail) monthlyHpSig.detail = monthlyHpDetail;
  signals.push(monthlyHpSig);
  totalScore += monthlyPts;

  // Sort signals by |contribution| descending
  signals.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  // Direction + strength labels
  let direction, strength;
  if (totalScore >= 6)       { direction = 'bullish';  strength = 'strong'; }
  else if (totalScore >= 3)  { direction = 'bullish';  strength = 'mild'; }
  else if (totalScore > -3)  { direction = 'neutral';  strength = 'flat'; }
  else if (totalScore > -6)  { direction = 'bearish';  strength = 'mild'; }
  else                       { direction = 'bearish';  strength = 'strong'; }

  return {
    symbol,
    timestamp: new Date().toISOString(),
    direction,
    strength,
    score: totalScore,
    scoreMax: 18,
    signals,
  };
}

module.exports = { computeSetupReadiness, computeDirectionalBias };
