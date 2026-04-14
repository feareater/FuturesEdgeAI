'use strict';

const fs   = require('fs');
const path = require('path');

// ── DST-aware ET helpers (mirrors setups.js) ────────────────────────────────

function _nthSunday(year, month, n) {
  const d = new Date(Date.UTC(year, month, 1));
  const dayOfWeek = d.getUTCDay();
  const firstSunday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const day = firstSunday + (n - 1) * 7;
  return Date.UTC(year, month, day) / 1000;
}

function _isDST(tsSeconds) {
  const d = new Date(tsSeconds * 1000);
  const y = d.getUTCFullYear();
  const dstStart = _nthSunday(y, 2, 2) + 7 * 3600;
  const dstEnd   = _nthSunday(y, 10, 1) + 6 * 3600;
  return tsSeconds >= dstStart && tsSeconds < dstEnd;
}

function _etFromISO(isoString) {
  const ms = new Date(isoString).getTime();
  const tsSec = ms / 1000;
  const offset = _isDST(tsSec) ? 4 : 5;
  const etMs = ms - offset * 3600000;
  const d = new Date(etMs);
  return {
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    hour: d.getUTCHours(),
  };
}

// ── Map one forward_trades.json record to export format ─────────────────────

function _mapTrade(t) {
  if (!t.outcome || t.outcome === 'open') return null;
  if (t.entryPrice == null || t.exitPrice == null) return null;
  if (t.netPnl == null) return null;
  if (!t.entryTime) return null;

  const et = _etFromISO(t.entryTime);

  return {
    date:            et.date,
    time:            et.time,
    hour:            et.hour,
    symbol:          t.symbol || 'UNKNOWN',
    setup:           t.setupType || 'unknown',
    tf:              t.timeframe || 'unknown',
    direction:       t.direction || 'unknown',
    confidence:      t.confidence ?? 0,
    entry:           t.entryPrice,
    exit:            t.exitPrice,
    sl:              t.sl ?? null,
    tp:              t.tp ?? null,
    outcome:         t.outcome,
    exitReason:      t.exitReason || null,
    netPnl:          parseFloat(t.netPnl.toFixed(2)),
    grossPnl:        t.grossPnl != null ? parseFloat(t.grossPnl.toFixed(2)) : null,
    entryTime:       t.entryTime,
    exitTime:        t.exitTime || null,
    vixRegime:       t.vixRegime ?? null,
    vixLevel:        t.vixLevel ?? null,
    dxyDirection:    t.dxyDirection ?? null,
    equityBreadth:   t.equityBreadth ?? null,
    riskAppetite:    t.riskAppetite ?? null,
    bondRegime:      t.bondRegime ?? null,
    ddBandLabel:     t.ddBandLabel ?? null,
    hpNearest:       t.hpNearest ?? null,
    resilienceLabel: t.resilienceLabel ?? null,
    dexBias:         t.dexBias ?? null,
    mtfConfluence:   t.mtfConfluence ?? null,
  };
}

// ── Summary stats computation ───────────────────────────────────────────────

function _breakdownBucket(trades) {
  const won  = trades.filter(t => t.outcome === 'won');
  const lost = trades.filter(t => t.outcome === 'lost');
  const totalWins = won.reduce((s, t) => s + (t.netPnl || 0), 0);
  const totalLoss = lost.reduce((s, t) => s + Math.abs(t.netPnl || 0), 0);
  return {
    n:            trades.length,
    winRate:      trades.length > 0 ? parseFloat((won.length / trades.length).toFixed(3)) : 0,
    profitFactor: totalLoss > 0 ? parseFloat((totalWins / totalLoss).toFixed(2)) : (won.length > 0 ? 999.99 : 0),
    netPnl:       parseFloat(trades.reduce((s, t) => s + (t.netPnl || 0), 0).toFixed(2)),
  };
}

function _computeSummary(trades) {
  const won  = trades.filter(t => t.outcome === 'won');
  const lost = trades.filter(t => t.outcome === 'lost');
  const totalWins = won.reduce((s, t) => s + (t.netPnl || 0), 0);
  const totalLoss = lost.reduce((s, t) => s + Math.abs(t.netPnl || 0), 0);

  // Group-by helpers
  const byKey = (key) => {
    const groups = {};
    for (const t of trades) {
      const k = String(t[key] ?? 'unknown');
      if (!groups[k]) groups[k] = [];
      groups[k].push(t);
    }
    const result = {};
    for (const [k, arr] of Object.entries(groups)) result[k] = _breakdownBucket(arr);
    return result;
  };

  // Confidence buckets: <60, 60-69, 70-79, 80-89, 90+
  const confBuckets = { '<60': [], '60-69': [], '70-79': [], '80-89': [], '90+': [] };
  for (const t of trades) {
    const c = t.confidence;
    if (c < 60)      confBuckets['<60'].push(t);
    else if (c < 70) confBuckets['60-69'].push(t);
    else if (c < 80) confBuckets['70-79'].push(t);
    else if (c < 90) confBuckets['80-89'].push(t);
    else             confBuckets['90+'].push(t);
  }
  const byConfidence = {};
  for (const [k, arr] of Object.entries(confBuckets)) {
    if (arr.length > 0) byConfidence[k] = _breakdownBucket(arr);
  }

  return {
    totalTrades:   trades.length,
    winRate:       trades.length > 0 ? parseFloat((won.length / trades.length).toFixed(3)) : 0,
    profitFactor:  totalLoss > 0 ? parseFloat((totalWins / totalLoss).toFixed(2)) : (won.length > 0 ? 999.99 : 0),
    netPnl:        parseFloat((totalWins - totalLoss + trades.filter(t => t.outcome === 'timeout').reduce((s, t) => s + (t.netPnl || 0), 0)).toFixed(2)),
    avgWin:        won.length > 0  ? parseFloat((totalWins / won.length).toFixed(2))  : 0,
    avgLoss:       lost.length > 0 ? parseFloat((-totalLoss / lost.length).toFixed(2)) : 0,
    bySymbol:      byKey('symbol'),
    bySetup:       byKey('setup'),
    byHour:        byKey('hour'),
    byConfidence,
  };
}

// ── Main export function ────────────────────────────────────────────────────

function exportForwardTest(rawTrades, query = {}) {
  const now = new Date();

  // Parse filters
  const startDate = query.start || new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const endDate   = query.end   || now.toISOString().slice(0, 10);
  const setupFilter = query.setup  || null;
  const symbolFilter = query.symbol ? query.symbol.toUpperCase() : null;
  const minConfidence = parseInt(query.minConfidence, 10) || 0;

  const filters = {
    start: startDate,
    end:   endDate,
    setup: setupFilter,
    symbol: symbolFilter,
    minConfidence,
  };

  // Map and filter
  const trades = [];
  for (const raw of rawTrades) {
    const t = _mapTrade(raw);
    if (!t) continue;

    // Date range filter
    if (t.date < startDate || t.date > endDate) continue;
    // Setup filter
    if (setupFilter && t.setup !== setupFilter) continue;
    // Symbol filter
    if (symbolFilter && t.symbol !== symbolFilter) continue;
    // Confidence filter
    if (t.confidence < minConfidence) continue;

    trades.push(t);
  }

  const summary = _computeSummary(trades);

  const result = {
    exportDate: now.toISOString(),
    filters,
    totalTrades: trades.length,
    trades,
    summary,
  };

  // Write to disk
  const dir = path.join(__dirname, '..', '..', 'data', 'analysis');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `forward_test_${Date.now()}.json`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));

  console.log(`[FORWARD-TEST-EXPORT] Exported ${trades.length} trades from forward_trades.json (${startDate} to ${endDate})`);

  return { result, filePath: `data/analysis/${filename}` };
}

module.exports = { exportForwardTest };
