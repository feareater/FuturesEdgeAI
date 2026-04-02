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

// ─── Optimize stats ───────────────────────────────────────────────────────────

const SETUP_TYPES    = ['zone_rejection', 'pdh_breakout', 'trendline_break', 'or_breakout'];
const THRESHOLD_FLOORS = [60, 65, 70, 75, 80, 85, 90];

/**
 * Richer breakdown for the Optimize tab.
 * Returns bySetupAndThreshold, byRegime, byAlignment, byCalendar, byMtf, byHour,
 * plus rawAlerts (minimal fields) for client-side per-symbol re-computation.
 */
function computeOptimizeStats(alerts) {
  const completed = alerts.filter(a =>
    a.setup?.outcome === 'won' || a.setup?.outcome === 'lost'
  );

  const bySetupAndThreshold = {};
  const byRegime      = {};
  const byAlignment   = {};
  const byCalendar    = {};
  const byMtf         = {};
  const byHour        = {};

  for (const setupType of SETUP_TYPES) {
    const forSetup = completed.filter(a => a.setup?.type === setupType);

    // ── Threshold floors ────────────────────────────────────────────────────
    const thresholds = THRESHOLD_FLOORS.map(floor => {
      const filt = forSetup.filter(a => (a.setup.confidence || 0) >= floor);
      if (!filt.length) return { floor, n: 0, wr: 0, pf: 0, avgR: 0 };
      const s = _stats(filt);
      return { floor, n: filt.length, wr: s.winRate ?? 0, pf: s.profitFactor ?? 0, avgR: s.avgR ?? 0 };
    });

    let optimalFloor = null, bestPf = -1;
    for (const t of thresholds) {
      if (t.n >= 10 && t.pf > bestPf) { bestPf = t.pf; optimalFloor = t.floor; }
    }

    bySetupAndThreshold[setupType] = {
      thresholds,
      optimalFloor,
      sampleWarning: forSetup.length < 30,
    };

    // ── Regime groups ───────────────────────────────────────────────────────
    const regGroups = { 'trend + aligned': [], 'trend + misaligned': [], 'range': [] };
    for (const a of forSetup) {
      const r = a.regime || {};
      if      (r.type === 'trend' && r.alignment === true)  regGroups['trend + aligned'].push(a);
      else if (r.type === 'trend' && r.alignment === false) regGroups['trend + misaligned'].push(a);
      else if (r.type === 'range')                          regGroups['range'].push(a);
    }
    byRegime[setupType] = Object.entries(regGroups).map(([label, g]) => ({
      label, n: g.length, wr: g.length ? (_stats(g).winRate ?? 0) : 0,
    }));

    // ── Alignment ───────────────────────────────────────────────────────────
    const aligned    = forSetup.filter(a => a.regime?.alignment === true);
    const misaligned = forSetup.filter(a => a.regime?.alignment !== true);
    byAlignment[setupType] = [
      { label: 'aligned',    n: aligned.length,    wr: aligned.length    ? (_stats(aligned).winRate    ?? 0) : 0 },
      { label: 'misaligned', n: misaligned.length, wr: misaligned.length ? (_stats(misaligned).winRate ?? 0) : 0 },
    ];

    // ── Calendar gate ───────────────────────────────────────────────────────
    const nearEvent = forSetup.filter(a =>  a.setup?.nearEvent === true);
    const notNear   = forSetup.filter(a => !a.setup?.nearEvent);
    byCalendar[setupType] = [
      { label: 'nearEvent: false', n: notNear.length,   wr: notNear.length   ? (_stats(notNear).winRate   ?? 0) : 0 },
      { label: 'nearEvent: true',  n: nearEvent.length, wr: nearEvent.length ? (_stats(nearEvent).winRate ?? 0) : 0 },
    ];

    // ── MTF confluence ──────────────────────────────────────────────────────
    const mtfBuckets = {};
    for (const a of forSetup) {
      const mtf = a.setup?.mtfConfluence;
      const lbl = (!mtf || !mtf.tfs || !mtf.tfs.length)
        ? 'no MTF'
        : 'MTF ' + mtf.tfs.join('+');
      if (!mtfBuckets[lbl]) mtfBuckets[lbl] = [];
      mtfBuckets[lbl].push(a);
    }
    const mtfResult = [];
    const mtfOther  = [];
    for (const [lbl, g] of Object.entries(mtfBuckets)) {
      if (lbl !== 'no MTF' && g.length < 5) { mtfOther.push(...g); }
      else {
        const s = _stats(g);
        mtfResult.push({ label: lbl, n: g.length, wr: s.winRate ?? 0, pf: s.profitFactor ?? 0 });
      }
    }
    if (mtfOther.length) {
      const s = _stats(mtfOther);
      mtfResult.push({ label: 'MTF (other)', n: mtfOther.length, wr: s.winRate ?? 0, pf: s.profitFactor ?? 0 });
    }
    byMtf[setupType] = mtfResult;

    // ── Hour (UTC) ──────────────────────────────────────────────────────────
    const hourBuckets = {};
    for (const a of forSetup) {
      if (!a.setup?.time) continue;
      const h = new Date(a.setup.time * 1000).getUTCHours();
      if (!hourBuckets[h]) hourBuckets[h] = [];
      hourBuckets[h].push(a);
    }
    byHour[setupType] = Object.entries(hourBuckets)
      .filter(([, g]) => g.length >= 3)
      .map(([h, g]) => ({ hour: +h, n: g.length, wr: _stats(g).winRate ?? 0 }))
      .sort((a, b) => a.hour - b.hour);
  }

  // Minimal raw alerts for client-side per-symbol re-computation
  const rawAlerts = completed.map(a => ({
    symbol: a.symbol,
    regime: a.regime ? { type: a.regime.type, alignment: a.regime.alignment } : null,
    setup: {
      type:           a.setup.type,
      confidence:     a.setup.confidence,
      outcome:        a.setup.outcome,
      entry:          a.setup.entry,
      sl:             a.setup.sl,
      tp:             a.setup.tp,
      time:           a.setup.time,
      nearEvent:      a.setup.nearEvent  ?? false,
      mtfConfluence:  a.setup.mtfConfluence ?? null,
    },
  }));

  return { bySetupAndThreshold, byRegime, byAlignment, byCalendar, byMtf, byHour, rawAlerts };
}

module.exports = { computePerformanceStats, computeOptimizeStats };
