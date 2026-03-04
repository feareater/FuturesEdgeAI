'use strict';
// Performance analytics — WR, profit factor, avg R by symbol/setup/TF/hour.
// Pure function: alert array → stats object. No I/O.

/**
 * Compute performance stats from the alert cache.
 *
 * @param {Array} alerts  Alert objects from alertCache
 * @returns {Object}  Stats by overall / symbol / setupType / timeframe / hour
 */
function computePerformanceStats(alerts) {
  const resolved = alerts.filter(a =>
    a.setup?.outcome === 'won' || a.setup?.outcome === 'lost'
  );

  return {
    overall:     _stats(resolved),
    bySymbol:    _groupBy(resolved, a => a.symbol),
    bySetupType: _groupBy(resolved, a => a.setup.type),
    byTimeframe: _groupBy(resolved, a => a.timeframe),
    byHour:      _groupBy(resolved, a => {
      const d = new Date(a.setup.time * 1000);
      return String(d.getUTCHours());
    }),
    byDirection: _groupBy(resolved, a => a.setup.direction),
    totalAlerts: alerts.length,
    resolvedCount: resolved.length,
    openCount:   alerts.filter(a => a.setup?.outcome === 'open').length,
  };
}

// ---------------------------------------------------------------------------

function _stats(alerts) {
  const won  = alerts.filter(a => a.setup.outcome === 'won');
  const lost = alerts.filter(a => a.setup.outcome === 'lost');
  const total = won.length + lost.length;

  if (total === 0) return { winRate: null, profitFactor: null, avgR: null, won: 0, lost: 0, total: 0 };

  const winRate = won.length / total;

  // R = realized risk multiple
  // Won trade: TP distance / risk = rrRatio (as set up)
  // Lost trade: -1R
  // We don't have actual realized R, but we know entry/sl/tp
  const wonR  = won.map( a => _calcR(a, true)).filter(r => r != null);
  const lostR = lost.map(a => _calcR(a, false)).filter(r => r != null);

  const totalWonR  = wonR.reduce((s, r) => s + r, 0);
  const totalLostR = lostR.reduce((s, r) => s + r, 0);

  const profitFactor = totalLostR > 0 ? totalWonR / totalLostR : null;
  const avgR = (wonR.length + lostR.length) > 0
    ? (totalWonR - totalLostR) / (wonR.length + lostR.length)
    : null;

  return {
    winRate:      Math.round(winRate * 1000) / 10,   // percent, 1 decimal
    profitFactor: profitFactor != null ? Math.round(profitFactor * 100) / 100 : null,
    avgR:         avgR != null ? Math.round(avgR * 100) / 100 : null,
    won:          won.length,
    lost:         lost.length,
    total,
  };
}

function _calcR(alert, isWon) {
  const { entry, sl, tp } = alert.setup;
  if (entry == null || sl == null || tp == null) return null;
  const risk = Math.abs(entry - sl);
  if (risk === 0) return null;
  if (isWon) return Math.abs(tp - entry) / risk;
  return 1.0; // lost trades lose exactly 1R (SL hit)
}

function _groupBy(alerts, keyFn) {
  const groups = {};
  for (const alert of alerts) {
    const key = keyFn(alert);
    if (!groups[key]) groups[key] = [];
    groups[key].push(alert);
  }
  const result = {};
  for (const [key, group] of Object.entries(groups)) {
    result[key] = _stats(group);
  }
  return result;
}

module.exports = { computePerformanceStats };
