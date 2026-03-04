'use strict';
// Relative Strength — MNQ vs MES session-normalized performance ratio.
// Also computes 20-period rolling Pearson correlation.
//
// ratio > 1.02: MNQ leading (risk-on, speculative bid)
// ratio < 0.98: MES leading (rotation to defensives, caution on MNQ longs)
// correlation < 0.70: divergence → intermarket stress

const CORR_PERIOD  = 20;
const RTH_START_UTC = 13.5;  // 09:30 ET
const RTH_END_UTC   = 20.0;  // 16:00 ET

/**
 * Compute relative strength of MNQ vs MES.
 *
 * @param {Array} mnqCandles  5m candles for MNQ
 * @param {Array} mesCandles  5m candles for MES
 * @returns {{ ratio, correlation, signal } | null}
 */
function computeRelativeStrength(mnqCandles, mesCandles) {
  if (!mnqCandles?.length || !mesCandles?.length) return null;

  // Align candles by timestamp
  const mesMap = new Map(mesCandles.map(c => [c.time, c]));
  const aligned = mnqCandles
    .filter(c => mesMap.has(c.time))
    .map(c => ({ time: c.time, mnq: c.close, mes: mesMap.get(c.time).close }));

  if (aligned.length < CORR_PERIOD + 1) return null;

  // Find today's RTH session start for normalization base
  const sessionStart = _findSessionStart(aligned);
  let ratio = 1.0;

  if (sessionStart) {
    const base = aligned.find(a => a.time >= sessionStart);
    if (base && base.mnq > 0 && base.mes > 0) {
      const last   = aligned[aligned.length - 1];
      const mnqRet = (last.mnq - base.mnq) / base.mnq;
      const mesRet = (last.mes - base.mes) / base.mes;
      // Normalized ratio: how much MNQ returned relative to MES
      ratio = 1 + (mnqRet - mesRet);
    }
  }

  // Rolling 20-period Pearson correlation on log returns
  const mnqReturns = _logReturns(aligned.map(a => a.mnq));
  const mesReturns = _logReturns(aligned.map(a => a.mes));
  const correlation = _pearson(
    mnqReturns.slice(-CORR_PERIOD),
    mesReturns.slice(-CORR_PERIOD)
  );

  const signal = ratio > 1.02 ? 'mnq_leading'
               : ratio < 0.98 ? 'mes_leading'
               : 'neutral';

  return {
    ratio:       Math.round(ratio * 10000) / 10000,
    correlation: Math.round(correlation * 100) / 100,
    signal,
  };
}

// ---------------------------------------------------------------------------

function _findSessionStart(aligned) {
  if (!aligned.length) return null;
  // Most recent candle's UTC date
  const last = new Date(aligned[aligned.length - 1].time * 1000);
  // 13:30 UTC on that calendar date
  return Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate(), 13, 30, 0) / 1000;
}

function _logReturns(prices) {
  const ret = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) ret.push(Math.log(prices[i] / prices[i - 1]));
    else ret.push(0);
  }
  return ret;
}

function _pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n === 0) return 0;
  const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

module.exports = { computeRelativeStrength };
