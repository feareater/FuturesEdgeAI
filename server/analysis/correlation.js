'use strict';
// 4×4 pairwise rolling Pearson correlation matrix across all instruments.
// Uses 5m candle log-returns, 20-period rolling window.

const SYMBOLS      = ['MNQ', 'MES', 'MCL', 'MGC', 'SIL', 'DXY', 'VIX', 'BTC', 'ETH', 'XRP', 'XLM'];
const CORR_PERIOD  = 20;

/**
 * Compute pairwise rolling Pearson correlation matrix.
 *
 * @param {Object} candlesBySymbol  { MNQ: [...], MGC: [...], MES: [...], MCL: [...] }
 * @returns {{ matrix: Object, updatedAt: string } | null}
 */
function computeCorrelationMatrix(candlesBySymbol) {
  // Build aligned timestamp set across all symbols
  const timeSets = SYMBOLS.map(s => new Set((candlesBySymbol[s] || []).map(c => c.time)));
  const common   = [...timeSets[0]].filter(t => timeSets.every(ts => ts.has(t))).sort();

  if (common.length < CORR_PERIOD + 1) return null;

  // Compute log-return series for each symbol on common timestamps
  const returns = {};
  for (const sym of SYMBOLS) {
    const priceMap = new Map((candlesBySymbol[sym] || []).map(c => [c.time, c.close]));
    const prices   = common.map(t => priceMap.get(t) ?? 0);
    returns[sym]   = _logReturns(prices);
  }

  // Build 4×4 correlation matrix (most recent CORR_PERIOD bars)
  const matrix = {};
  for (const a of SYMBOLS) {
    matrix[a] = {};
    for (const b of SYMBOLS) {
      if (a === b) {
        matrix[a][b] = 1.0;
        continue;
      }
      const xa = returns[a].slice(-CORR_PERIOD);
      const xb = returns[b].slice(-CORR_PERIOD);
      matrix[a][b] = Math.round(_pearson(xa, xb) * 100) / 100;
    }
  }

  return { matrix, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------

function _logReturns(prices) {
  const ret = [];
  for (let i = 1; i < prices.length; i++) {
    ret.push(prices[i - 1] > 0 ? Math.log(prices[i] / prices[i - 1]) : 0);
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

module.exports = { computeCorrelationMatrix };
