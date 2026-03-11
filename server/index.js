'use strict';

require('dotenv').config();

const http    = require('http');
const path    = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { authenticate }      = require('./auth/tradovate');
const { getCandles }        = require('./data/snapshot');
const { computeIndicators } = require('./analysis/indicators');
const { classifyRegime, computeAlignment } = require('./analysis/regime');
const { detectSetups }      = require('./analysis/setups');
const { detectTrendlines }  = require('./analysis/trendlines');
const { generateCommentary, generateSingle } = require('./ai/commentary');
const { checkTFZoneStack }  = require('./analysis/confluence');
const { saveAlertCache, loadAlertCache, saveCommentaryCache, loadCommentaryCache,
        saveTradeLog, loadTradeLog,
        loadArchive, appendToArchive, updateArchiveOutcome } = require('./storage/log');
const { fetchAll }              = require('./data/seedFetch');
const { fetchAllCrypto }        = require('./data/coinbaseFetch');
const coinbaseWS                = require('./data/coinbaseWS');
const { getForexRate, getOptionsFlow, getGammaData } = require('./data/polygonFetch');
const autotrader                = require('./trading/autotrader');
const simulator                 = require('./trading/simulator');
const { computeRelativeStrength } = require('./analysis/relativeStrength');
const { computeCorrelationMatrix } = require('./analysis/correlation');
const { computePerformanceStats }  = require('./analysis/performanceStats');
const { predict }                  = require('./analysis/predictor');
const { getCalendarEvents, getNextEvent, isNearEvent } = require('./data/calendar');
const { getOptionsData }                               = require('./data/options');
const settings              = require('../config/settings.json');
const fs                    = require('fs');
const SETTINGS_PATH         = require('path').join(__dirname, '..', 'config', 'settings.json');

const PORT        = process.env.PORT        || 3000;
const DATA_SOURCE = process.env.DATA_SOURCE || 'seed';

// Auto-refresh interval for seed mode (15 minutes).
// Live-mode integration point: replace the setInterval in start() with a broker
// WebSocket candle-close subscription, then call _autoRefresh({ fetchData: false }).
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;  // 2-minute refresh — seed data is 15-min delayed
let   refreshIntervalMs   = REFRESH_INTERVAL_MS; // mutable — changed via POST /api/settings
let   lastRefreshTs       = null; // ISO string, exposed via /api/health
let   nextRefreshTs       = null; // ISO string, set when schedule is established
let   _refreshIntervalId  = null; // setInterval handle for rescheduling

// ---------------------------------------------------------------------------
// Alert cache — in-memory; survives until server restart
// ---------------------------------------------------------------------------

const alertCache    = [];           // newest-first ordered alert objects
const alertSeenKeys = new Set();   // dedup: symbol:tf:type:time
const reEvalKeys    = new Set();   // open-outcome keys being re-evaluated (not "new")

const MAX_ALERTS = 100;

// ── Commentary cache ──────────────────────────────────────────────────────────
// Holds the last successful AI commentary run.
// { generated: ISO string, items: [{ symbol, timeframe, setupTime, commentary, alert }] }
let commentaryCache = { generated: null, items: [] };

// ── Trade log ─────────────────────────────────────────────────────────────────
let tradeLog = []; // persisted to data/logs/trades.json

const COMMENTARY_TOP_N = 5; // number of setups sent to Claude per run

// ── Persistence helpers ───────────────────────────────────────────────────────

/**
 * Load persisted alert and commentary caches from disk at startup.
 * Alerts already in the dedup set will be skipped by subsequent scans.
 */
function _loadPersistedData() {
  const savedAlerts = loadAlertCache();
  if (savedAlerts.length) {
    for (const alert of savedAlerts) {
      const key = `${alert.symbol}:${alert.timeframe}:${alert.setup.type}:${alert.setup.time}`;
      alertSeenKeys.add(key);
      alertCache.push(alert);
    }
    // Trim to MAX_ALERTS in case the file grew beyond the cap
    if (alertCache.length > MAX_ALERTS) alertCache.splice(MAX_ALERTS);
    console.log(`[storage] Loaded ${alertCache.length} alerts from disk`);
  }

  const savedCommentary = loadCommentaryCache();
  if (savedCommentary.generated) {
    commentaryCache = savedCommentary;
    console.log(`[storage] Loaded commentary cache (${commentaryCache.items.length} items, generated ${commentaryCache.generated})`);
  }

  const savedTrades = loadTradeLog();
  if (savedTrades.length) {
    tradeLog = savedTrades;
    console.log(`[storage] Loaded ${tradeLog.length} trade(s) from disk`);
  }
}

function _cacheAlert(alert) {
  const key      = `${alert.symbol}:${alert.timeframe}:${alert.setup.type}:${alert.setup.time}`;
  const isReEval = reEvalKeys.delete(key); // consume: true if this was an open-outcome re-eval
  if (alertSeenKeys.has(key)) return false;
  alertSeenKeys.add(key);
  alertCache.unshift(alert);
  if (alertCache.length > MAX_ALERTS) alertCache.pop();
  if (isReEval) {
    // Re-evaluation: outcome may have changed from 'open' → sync archive if resolved
    if (alert.setup.outcome !== 'open') {
      updateArchiveOutcome(key, alert.setup.outcome, alert.setup.outcomeTime);
    }
  } else {
    // First appearance: snapshot to archive
    appendToArchive(alert);
  }
  return !isReEval; // not "new" if re-evaluating an open outcome — avoids false-positive toasts
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', dataSource: DATA_SOURCE, ts: new Date().toISOString(),
             lastRefresh: lastRefreshTs, nextRefresh: nextRefreshTs,
             refreshIntervalMins: Math.round(refreshIntervalMs / 60000) });
});

// GET /api/candles?symbol=MNQ&timeframe=5m
app.get('/api/candles', (req, res) => {
  const { symbol = 'MNQ', timeframe = '5m' } = req.query;
  try {
    const candles = getCandles(symbol, timeframe);
    console.log(`[api] /candles  symbol=${symbol}  tf=${timeframe}  count=${candles.length}`);
    res.json({ symbol, timeframe, candles });
  } catch (err) {
    console.error(`[api] /candles error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/indicators?symbol=MNQ&timeframe=5m
app.get('/api/indicators', (req, res) => {
  const { symbol = 'MNQ', timeframe = '5m' } = req.query;
  try {
    const candles    = getCandles(symbol, timeframe);
    const indicators = computeIndicators(candles, {
      swingLookback:    settings.swingLookback,
      impulseThreshold: settings.impulseThreshold,
      symbol,
      features:         settings.features || {},
    });
    const trendlines = detectTrendlines(candles, indicators.atrCurrent);

    // Filter IOF to active zones only (keeps payload small)
    // FVGs: open + not weak noise (atrRatio >= 0.35)
    const fvgs = (indicators.fvgs || [])
      .filter(f => f.status === 'open' && f.strength !== 'weak')
      .slice(-6);
    // OBs: untested or tested; exclude mitigated and weak-tested (likely noise)
    const orderBlocks = (indicators.orderBlocks || [])
      .filter(o => o.status !== 'mitigated' && !(o.strength === 'weak' && o.status === 'tested'))
      .slice(-4);

    console.log(`[api] /indicators  symbol=${symbol}  tf=${timeframe}  fvgs=${fvgs.length}  obs=${orderBlocks.length}  trendlines=${trendlines.support?'S':'–'}${trendlines.resistance?'R':'–'}`);
    res.json({ symbol, timeframe, ...indicators, fvgs, orderBlocks, trendlines });
  } catch (err) {
    console.error(`[api] /indicators error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/trendlines?symbol=MNQ — trendlines for 1m, 5m, 15m (multi-TF overlay)
app.get('/api/trendlines', (req, res) => {
  const { symbol = 'MNQ' } = req.query;
  const TRENDLINE_TFS = ['1m', '5m', '15m'];
  try {
    const result = {};
    for (const tf of TRENDLINE_TFS) {
      const candles = getCandles(symbol, tf);
      const ind     = computeIndicators(candles, { swingLookback: settings.swingLookback });
      result[tf]    = detectTrendlines(candles, ind.atrCurrent);
    }
    console.log(`[api] /trendlines  symbol=${symbol}  1m:${result['1m']?.support?'S':'–'}${result['1m']?.resistance?'R':'–'}  5m:${result['5m']?.support?'S':'–'}${result['5m']?.resistance?'R':'–'}  15m:${result['15m']?.support?'S':'–'}${result['15m']?.resistance?'R':'–'}`);
    res.json({ symbol, trendlines: result });
  } catch (err) {
    console.error(`[api] /trendlines error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/settings — returns the risk + features sections of settings.json for the frontend
app.get('/api/settings', (_req, res) => {
  res.json({ risk: settings.risk || {}, features: settings.features || {} });
});

// POST /api/settings — update in-memory risk params and re-scan.
// Changing rrRatio invalidates all cached outcomes, so we clear + rescan.
app.post('/api/settings', async (req, res) => {
  const { rrRatio, refreshIntervalMins } = req.body;
  let needRescan = false;

  if (refreshIntervalMins !== undefined) {
    const mins = parseInt(refreshIntervalMins);
    if (!isNaN(mins) && mins >= 1 && mins <= 60) {
      refreshIntervalMs = mins * 60 * 1000;
      _scheduleRefresh(); // always reschedule with the new interval
      console.log(`[settings] Refresh interval updated to ${mins} min`);
    }
  }

  if (rrRatio !== undefined) {
    const parsed = parseFloat(rrRatio);
    if (!isNaN(parsed) && parsed >= 1.0) {
      settings.risk.rrRatio = parsed;
      needRescan = true;
    }
  }

  if (needRescan) {
    // Clear cache — TP/outcome depend on rrRatio
    alertCache.length = 0;
    alertSeenKeys.clear();
    try {
      const newCount = await runScan();
      return res.json({ status: 'ok', newAlerts: newCount, totalCached: alertCache.length, risk: settings.risk });
    } catch (err) {
      console.error('[api] /settings POST error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  res.json({ status: 'ok', risk: settings.risk });
});

// GET /api/alerts?limit=20&minConfidence=0&symbol=MNQ&timeframe=5m&start=ISO&end=ISO
// symbol + timeframe filters applied first, then confidence, then trade filter.
app.get('/api/alerts', (req, res) => {
  const limit     = Math.min(parseInt(req.query.limit) || 50, MAX_ALERTS);
  const minConf   = parseInt(req.query.minConfidence) || 0;
  const { symbol, timeframe, start, end } = req.query;

  let qualifying = alertCache;
  if (symbol)    qualifying = qualifying.filter(a => a.symbol    === symbol);
  if (timeframe) qualifying = qualifying.filter(a => a.timeframe === timeframe);
  if (minConf > 0) qualifying = qualifying.filter(a => a.setup.confidence >= minConf);

  // Date range filter for replay/backtest usage
  if (start) {
    const startTs = new Date(start).getTime() / 1000;
    qualifying = qualifying.filter(a => a.setup.time >= startTs);
  }
  if (end) {
    const endTs = new Date(end).getTime() / 1000;
    qualifying = qualifying.filter(a => a.setup.time <= endTs);
  }

  const filtered = _applyTradeFilter(qualifying);
  // Sort: unsuppressed first, then by newest candle time
  filtered.sort((a, b) => {
    if (a.suppressed !== b.suppressed) return a.suppressed ? 1 : -1;
    return b.setup.time - a.setup.time;
  });

  // For open alerts, compute priceProgress: how far current price has moved
  // from entry toward TP (0–1 = in play, >1 = past TP, negative = SL breached).
  // Client uses this to remove setups that are too far along or have crossed SL.
  for (const alert of filtered) {
    if (alert.setup.outcome !== 'open' && alert.setup.outcome != null) continue;
    const { entry, tp, sl, direction } = alert.setup;
    if (entry == null || tp == null || sl == null) continue;
    try {
      const candles = getCandles(alert.symbol, alert.timeframe);
      const lastClose = candles[candles.length - 1]?.close;
      if (lastClose == null) continue;
      // SL already breached — mark as invalid regardless of progress toward TP
      const slBreached = direction === 'bullish' ? lastClose <= sl : lastClose >= sl;
      if (slBreached) { alert.priceProgress = -1; continue; }
      const totalRange = Math.abs(tp - entry);
      if (totalRange === 0) continue;
      const traveled = direction === 'bullish'
        ? (lastClose - entry) / totalRange
        : (entry - lastClose) / totalRange;
      alert.priceProgress = Math.round(traveled * 100) / 100;
    } catch (_) {}
  }

  res.json({ alerts: filtered.slice(0, limit) });
});

// GET /api/commentary — returns the last AI-generated setup commentary
app.get('/api/commentary', (_req, res) => {
  res.json(commentaryCache);
});

// POST /api/commentary/single — on-demand AI commentary for any one alert
// Body: { key: "MNQ:5m:zone_rejection:1708700000" }
app.post('/api/commentary/single', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });

  const parts = key.split(':');
  if (parts.length < 4) return res.status(400).json({ error: 'invalid key format' });
  const [symbol, timeframe, type, timeStr] = parts;
  const time = parseInt(timeStr, 10);

  const alert = alertCache.find(a =>
    a.symbol    === symbol    &&
    a.timeframe === timeframe &&
    a.setup.type === type     &&
    a.setup.time === time
  );
  if (!alert) return res.status(404).json({ error: 'alert not found in cache' });

  try {
    // Build indicators context for richer single-setup commentary
    let extrasMap = {};
    try {
      const ind = computeIndicators(getCandles(symbol, timeframe), {
        swingLookback:    settings.swingLookback,
        impulseThreshold: settings.impulseThreshold,
        symbol,
        features:         settings.features || {},
      });
      const perfStats = computePerformanceStats(alertCache);
      extrasMap[`${symbol}:${timeframe}`] = {
        fvgs:          (ind.fvgs        || []).filter(f => f.status === 'open'),
        orderBlocks:   (ind.orderBlocks || []).filter(o => o.status !== 'mitigated'),
        sessionLevels: ind.sessionLevels  || null,
        volumeProfile: ind.volumeProfile  || null,
        atrCurrent:    ind.atrCurrent     || 0,
        perfStats:     perfStats.bySymbol?.[symbol] || {},
      };
    } catch (_) {}

    const commentary = await generateSingle(alert, getCandles, extrasMap);
    if (!commentary) return res.status(503).json({ error: 'could not generate commentary' });
    // generateSingle attaches commentary to alert.commentary — persist the update
    saveAlertCache(alertCache);
    res.json({ commentary });
  } catch (err) {
    console.error('[api] /commentary/single error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/commentary/refresh — manually trigger AI commentary for top unanalyzed alerts.
// Skips any alert that already has commentary to avoid redundant API calls.
app.post('/api/commentary/refresh', async (_req, res) => {
  try {
    await _refreshCommentary();
    const analyzed = alertCache.filter(a => a.commentary).length;
    res.json({ status: 'ok', generated: commentaryCache.generated, count: commentaryCache.items.length, totalAnalyzed: analyzed });
    console.log(`[ai] Manual commentary refresh complete — ${commentaryCache.items.length} new, ${analyzed} total with commentary`);
  } catch (err) {
    console.error('[api] /commentary/refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export — download all alerts + trades as a JSON file
app.get('/api/export', (_req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="futuresedge-${date}.json"`);
  res.json({
    exported:  new Date().toISOString(),
    alerts:    alertCache,
    trades:    tradeLog,
  });
});

// GET /api/trades — return all saved trade log entries
app.get('/api/trades', (_req, res) => {
  res.json({ trades: tradeLog });
});

// POST /api/trades — create or update a trade entry (alertKey optional for manual trades)
app.post('/api/trades', (req, res) => {
  const { alertKey, symbol, timeframe, setupType,
          actualEntry, actualSL, actualTP, actualExit, notes,
          direction, manualSetupType, isManual, mode,
          contracts, dca, sentiment, outcome, pnl, confidence, rationale,
          accountId, accountLabel, accountType } = req.body;
  if (mode !== 'monitor' && (actualEntry == null || actualSL == null || actualTP == null)) {
    return res.status(400).json({ error: 'actualEntry, actualSL, actualTP required' });
  }
  const key = alertKey || `MANUAL:${symbol || 'UNK'}:${Date.now()}`;
  const existing = tradeLog.find(t => t.alertKey === key);
  const trade = {
    id:          existing?.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    alertKey:    key,
    symbol,      timeframe, setupType,
    direction:   direction || existing?.direction || 'bullish',
    mode:        mode || 'take',
    takenAt:     existing?.takenAt || new Date().toISOString(),
    actualEntry: actualEntry != null ? Number(actualEntry) : null,
    actualSL:    actualSL   != null ? Number(actualSL)    : null,
    actualTP:    actualTP   != null ? Number(actualTP)    : null,
    actualExit:  actualExit != null && actualExit !== '' ? Number(actualExit) : null,
    contracts:   contracts  != null ? Number(contracts)   : (existing?.contracts ?? null),
    dca:         dca        != null ? Boolean(dca)        : (existing?.dca ?? false),
    sentiment:   sentiment  || existing?.sentiment || 'neutral',
    outcome:     outcome    || existing?.outcome   || null,
    pnl:         pnl        != null ? Number(pnl)         : (existing?.pnl ?? null),
    confidence:  confidence != null ? Number(confidence)  : (existing?.confidence ?? null),
    rationale:    rationale    || existing?.rationale    || '',
    notes:        notes        != null ? notes             : (existing?.notes ?? ''),
    accountId:    accountId    || existing?.accountId    || null,
    accountLabel: accountLabel || existing?.accountLabel || null,
    accountType:  accountType  || existing?.accountType  || null,
  };
  if (isManual || !alertKey) {
    trade.isManual        = true;
    trade.manualSetupType = manualSetupType || setupType || '';
  }
  const idx = tradeLog.findIndex(t => t.alertKey === key);
  if (idx >= 0) tradeLog[idx] = trade;
  else tradeLog.push(trade);
  saveTradeLog(tradeLog);
  console.log(`[trade] ${idx >= 0 ? 'Updated' : 'Saved'} trade for ${key}`);
  res.json({ trade });
});

// PATCH /api/trades/:id — update specific fields on an existing trade
app.patch('/api/trades/:id', (req, res) => {
  const idx = tradeLog.findIndex(t => t.id === req.params.id || t.alertKey === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Trade not found' });
  const allowed = ['actualEntry','actualSL','actualTP','actualExit','contracts','dca','sentiment','outcome','pnl','notes','rationale','accountId','accountLabel','accountType'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  tradeLog[idx] = { ...tradeLog[idx], ...updates };
  saveTradeLog(tradeLog);
  res.json({ trade: tradeLog[idx] });
});

// DELETE /api/trades/:id — remove a trade entry
app.delete('/api/trades/:id', (req, res) => {
  const idx = tradeLog.findIndex(t => t.id === req.params.id || t.alertKey === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Trade not found' });
  const [removed] = tradeLog.splice(idx, 1);
  saveTradeLog(tradeLog);
  res.json({ removed: removed.id });
});

// GET /api/accounts — combined list of prop firm accounts + real account brokers for trade linking
app.get('/api/accounts', (_req, res) => {
  const pf = JSON.parse(fs.readFileSync(PF_PATH, 'utf8') || '{}');
  const ra = _loadRA();
  const pfAccounts = (pf.accounts || []).map(a => ({
    id:    `pf:${a.id}`,
    rawId: a.id,
    label: `${a.firm}${a.notes ? ' — ' + a.notes : ''}`,
    firm:  a.firm,
    type:  'propfirm',
    phase: a.phase || 'challenge',
    status: a.status,
  }));
  const raBrokers = [...new Set((ra.trades || []).map(t => t.broker || 'Optimus Futures'))]
    .map(b => ({ id: `ra:${b}`, label: `Real Account — ${b}`, firm: b, type: 'realaccount' }));
  res.json({ accounts: [...pfAccounts, ...raBrokers] });
});

// Point values for P&L auto-calc
const FILL_POINT_VALUE = { MNQ: 2, MGC: 10, MES: 5, MCL: 100, BTC: 1, ETH: 0.01, XRP: 0.0001 };

function _recomputeTrade(t) {
  const entries = t.entries || [];
  const exits   = t.exits   || [];
  if (entries.length > 0) {
    const totalQty  = entries.reduce((s, e) => s + e.qty, 0);
    const weighted  = entries.reduce((s, e) => s + e.qty * e.price, 0);
    t.actualEntry = totalQty > 0 ? +(weighted / totalQty).toFixed(4) : t.actualEntry;
    t.contracts   = totalQty;
  }
  if (exits.length > 0) {
    const totalExited = exits.reduce((s, e) => s + e.qty, 0);
    const totalEntries = (t.entries || []).reduce((s, e) => s + e.qty, 0);
    t.remainingContracts = Math.max(0, totalEntries - totalExited);
    t.pnl = +exits.reduce((s, e) => s + (e.pnl || 0), 0).toFixed(2);
    if (t.remainingContracts === 0) {
      t.outcome = t.pnl >= 0 ? 'won' : 'lost';
    }
  }
  return t;
}

// POST /api/trades/:id/entry — append a DCA entry fill
app.post('/api/trades/:id/entry', (req, res) => {
  const idx = tradeLog.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Trade not found' });
  const { qty, price } = req.body;
  if (!qty || !price) return res.status(400).json({ error: 'qty and price required' });
  if (!tradeLog[idx].entries) tradeLog[idx].entries = [];
  tradeLog[idx].entries.push({ qty: Number(qty), price: Number(price), at: new Date().toISOString() });
  tradeLog[idx].dca = tradeLog[idx].entries.length > 1;
  _recomputeTrade(tradeLog[idx]);
  saveTradeLog(tradeLog);
  res.json({ trade: tradeLog[idx] });
});

// DELETE /api/trades/:id/entry/:idx — remove a DCA entry by index
app.delete('/api/trades/:id/entry/:eidx', (req, res) => {
  const idx = tradeLog.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Trade not found' });
  const eidx = parseInt(req.params.eidx);
  if (!tradeLog[idx].entries || !tradeLog[idx].entries[eidx]) return res.status(404).json({ error: 'Entry not found' });
  tradeLog[idx].entries.splice(eidx, 1);
  tradeLog[idx].dca = (tradeLog[idx].entries.length > 1);
  _recomputeTrade(tradeLog[idx]);
  saveTradeLog(tradeLog);
  res.json({ trade: tradeLog[idx] });
});

// POST /api/trades/:id/exit — append a tiered exit
app.post('/api/trades/:id/exit', (req, res) => {
  const idx = tradeLog.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Trade not found' });
  const { qty, price, pnl } = req.body;
  if (!qty || !price) return res.status(400).json({ error: 'qty and price required' });
  const t      = tradeLog[idx];
  const pv     = FILL_POINT_VALUE[t.symbol] || 1;
  const avgE   = t.actualEntry || 0;
  const dir    = t.direction || 'bullish';
  const autoPnl = pnl != null ? Number(pnl)
    : +(((dir === 'bullish' ? Number(price) - avgE : avgE - Number(price)) * Number(qty) * pv).toFixed(2));
  if (!t.exits) t.exits = [];
  t.exits.push({ qty: Number(qty), price: Number(price), pnl: autoPnl, at: new Date().toISOString() });
  _recomputeTrade(t);
  saveTradeLog(tradeLog);
  res.json({ trade: t });
});

// DELETE /api/trades/:id/exit/:xidx — remove an exit by index
app.delete('/api/trades/:id/exit/:xidx', (req, res) => {
  const idx = tradeLog.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Trade not found' });
  const xidx = parseInt(req.params.xidx);
  if (!tradeLog[idx].exits || !tradeLog[idx].exits[xidx]) return res.status(404).json({ error: 'Exit not found' });
  tradeLog[idx].exits.splice(xidx, 1);
  _recomputeTrade(tradeLog[idx]);
  saveTradeLog(tradeLog);
  res.json({ trade: tradeLog[idx] });
});

// PATCH /api/alerts/:key — manually set outcome (won/lost/open) for a taken alert
app.patch('/api/alerts/:key', (req, res) => {
  const { key }    = req.params;
  const { outcome, exitPrice } = req.body;
  if (!['won', 'lost', 'open'].includes(outcome)) {
    return res.status(400).json({ error: 'outcome must be won, lost, or open' });
  }
  const alert = alertCache.find(
    a => `${a.symbol}:${a.timeframe}:${a.setup.type}:${a.setup.time}` === key
  );
  if (!alert) {
    return res.status(404).json({ error: 'Alert not found in cache' });
  }
  alert.setup.outcome     = outcome;
  alert.setup.userOverride = true;
  alert.setup.outcomeTime  = exitPrice != null ? Math.floor(Date.now() / 1000) : alert.setup.outcomeTime;
  saveAlertCache(alertCache);
  updateArchiveOutcome(key, outcome, alert.setup.outcomeTime, true);
  broadcast({ type: 'outcome_update', key, outcome });
  console.log(`[alert] Manual outcome set: ${key} → ${outcome}`);
  res.json({ ok: true, key, outcome });
});

// GET /api/archive — query historical setup archive (all setups ever fired)
app.get('/api/archive', (req, res) => {
  try {
    let archive = loadArchive();
    const { symbol, start, end, limit } = req.query;
    if (symbol) archive = archive.filter(a => a.symbol === symbol.toUpperCase());
    if (start)  archive = archive.filter(a => new Date(a.ts) >= new Date(start));
    if (end)    archive = archive.filter(a => new Date(a.ts) <= new Date(end));
    const lim = Math.min(Number(limit) || 500, 2000);
    // Return newest-first slice
    archive = archive.slice().reverse().slice(0, lim);
    res.json({ count: archive.length, alerts: archive });
  } catch (err) {
    console.error('[api] /archive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/refresh — trigger an immediate data refresh and reset the interval timer
app.post('/api/refresh', async (_req, res) => {
  try {
    await _autoRefresh();
    _scheduleRefresh(); // always reset countdown from now
    res.json({ status: 'ok', ts: lastRefreshTs, nextRefresh: nextRefreshTs });
  } catch (err) {
    console.error('[api] /refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scan  — manually trigger a full re-scan (useful for seed mode refresh)
app.get('/api/scan', async (_req, res) => {
  try {
    const newCount = await runScan();
    res.json({ status: 'ok', newAlerts: newCount, totalCached: alertCache.length });
  } catch (err) {
    console.error('[api] /scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/features — hot-toggle individual feature flags (no restart needed)
// body: { "openingRange": false } or any subset of features
app.post('/api/features', (req, res) => {
  if (!settings.features) settings.features = {};
  const updates = req.body;
  const changed = [];
  for (const [key, val] of Object.entries(updates)) {
    if (typeof val === 'boolean') {
      settings.features[key] = val;
      changed.push(key);
    }
  }
  if (changed.length) {
    // Persist to disk
    try {
      const current = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      current.features = settings.features;
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(current, null, 2), 'utf8');
      console.log(`[features] Updated: ${changed.join(', ')}`);
    } catch (e) {
      console.error('[features] Failed to persist:', e.message);
    }
  }
  res.json({ features: settings.features });
});

// GET /api/calendar?symbol=MNQ — upcoming high-impact economic events
app.get('/api/calendar', async (req, res) => {
  try {
    const { symbol } = req.query;
    const events = await getCalendarEvents(symbol || null);
    res.json({ events });
  } catch (err) {
    console.error('[api] /calendar error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/options?symbol=MNQ — options chain metrics (OI walls, max pain, P/C ratio, ATM IV)
app.get('/api/options', async (req, res) => {
  try {
    const { symbol = 'MNQ' } = req.query;
    const options = await getOptionsData(symbol);
    res.json({ symbol, options });
  } catch (err) {
    console.error('[api] /options error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// GET /api/forex?pair=GBPUSD — Polygon.io forex rate (free tier, 15-min delayed)
app.get('/api/forex', async (req, res) => {
  try {
    const { pair = 'GBPUSD' } = req.query;
    const data = await getForexRate(pair.toUpperCase());
    res.json({ pair, data });
  } catch (err) {
    console.error('[api] /forex error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/options/flow?symbol=MNQ — Polygon.io options chain via ETF proxy (QQQ/SPY)
// Returns raw ETF strikes + futures-scaled strikes (when futuresPrice provided)
app.get('/api/options/flow', async (req, res) => {
  try {
    const { symbol = 'MNQ', futuresPrice } = req.query;
    const fp = futuresPrice ? parseFloat(futuresPrice) : null;
    const data = await getOptionsFlow(symbol.toUpperCase(), fp);
    res.json({ symbol, data });
  } catch (err) {
    console.error('[api] /options/flow error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gamma?symbol=MNQ&futuresPrice=21000
// Returns gamma flip level, call/put walls, max pain, 0DTE flag — scaled to futures price space.
app.get('/api/gamma', async (req, res) => {
  try {
    const { symbol = 'MNQ', futuresPrice } = req.query;
    const fp = futuresPrice ? parseFloat(futuresPrice) : null;
    const data = await getGammaData(symbol.toUpperCase(), fp);
    res.json({ symbol, data });
  } catch (err) {
    console.error('[api] /gamma error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/correlation — 4×4 rolling correlation matrix for all symbols
app.get('/api/correlation', (req, res) => {
  try {
    const allCandles = {};
    for (const sym of SCAN_SYMBOLS) {
      try { allCandles[sym] = getCandles(sym, '5m'); } catch { allCandles[sym] = []; }
    }
    const result = computeCorrelationMatrix(allCandles);
    res.json(result);
  } catch (err) {
    console.error('[api] /correlation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/relativestrength?base=MNQ&compare=MES
app.get('/api/relativestrength', (req, res) => {
  try {
    const { base = 'MNQ', compare = 'MES' } = req.query;
    const baseCandles    = getCandles(base, '5m');
    const compareCandles = getCandles(compare, '5m');
    const result = computeRelativeStrength(baseCandles, compareCandles);
    res.json({ base, compare, ...result });
  } catch (err) {
    console.error('[api] /relativestrength error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/predict?symbol=MNQ&timeframe=5m
// Returns a Long/Short/Neutral prediction for the most recent confirmed candle,
// scored from all available indicator and regime data.
app.get('/api/predict', async (req, res) => {
  try {
    const { symbol = 'MNQ', timeframe = '5m' } = req.query;
    const candles  = getCandles(symbol, timeframe);
    if (!candles || candles.length < 20) {
      return res.status(404).json({ error: 'Insufficient candle data' });
    }
    const ind      = computeIndicators(candles, {
      symbol, features: settings.features,
      swingLookback: settings.swingLookback || 10,
      impulseThreshold: settings.impulseThreshold || 1.5,
    });
    const regime   = classifyRegime(ind);
    const tlResult = detectTrendlines(candles, ind.atrCurrent);
    // predictor expects a flat array of trendline objects with {type, anchor, slope, anchorTime}
    const tls = [
      tlResult.support    ? { ...tlResult.support,    type: 'support',    anchor: tlResult.support.startPrice,    anchorTime: tlResult.support.startTime,    slope: (tlResult.support.endPrice - tlResult.support.startPrice) / ((tlResult.support.endTime - tlResult.support.startTime) || 1) } : null,
      tlResult.resistance ? { ...tlResult.resistance, type: 'resistance', anchor: tlResult.resistance.startPrice, anchorTime: tlResult.resistance.startTime, slope: (tlResult.resistance.endPrice - tlResult.resistance.startPrice) / ((tlResult.resistance.endTime - tlResult.resistance.startTime) || 1) } : null,
    ].filter(Boolean);

    // Open setups from alert cache for this symbol+timeframe (any TF for context)
    const openSetups = alertCache.filter(a =>
      a.symbol === symbol && a.setup?.outcome === 'open'
    );

    const result = predict(candles, ind, regime, tls, openSetups);
    if (!result) return res.status(500).json({ error: 'Prediction failed' });

    console.log(`[predict] ${symbol} ${timeframe}: ${result.direction} conf=${result.confidence} score=${result.score}`);
    res.json({ symbol, timeframe, ...result });
  } catch (err) {
    console.error('[api] /predict error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/performance — win-rate / profit factor stats from alert cache
app.get('/api/performance', (_req, res) => {
  try {
    const stats = computePerformanceStats(alertCache);
    res.json(stats);
  } catch (err) {
    console.error('[api] /performance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// AutoTrader routes
// ---------------------------------------------------------------------------

// GET /api/autotrader/status — kill switch state + live position snapshot
app.get('/api/autotrader/status', async (_req, res) => {
  try {
    const status = await autotrader.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/autotrader/toggle — enable or disable auto-order execution
// body: { enabled: true | false }
app.post('/api/autotrader/toggle', (req, res) => {
  const { enabled } = req.body;
  if (enabled === true || enabled === false) {
    enabled ? autotrader.enable() : autotrader.disable();
  } else {
    // No body → flip current state
    autotrader.isEnabled() ? autotrader.disable() : autotrader.enable();
  }
  const nowEnabled = autotrader.isEnabled();
  console.log(`[autotrader] Kill switch → ${nowEnabled ? 'LIVE' : 'PAUSED'}`);
  res.json({ enabled: nowEnabled, status: nowEnabled ? 'live' : 'paused' });
});

// POST /api/autotrader/settings — update the execution confidence floor
// body: { minConfidence: 75 }
app.post('/api/autotrader/settings', (req, res) => {
  const { minConfidence } = req.body;
  if (minConfidence != null) autotrader.setMinConfidence(minConfidence);
  res.json({ minConfidence: autotrader.state.minConfidence });
});

// GET /api/simulator/positions — all virtual positions (open + closed), newest first
app.get('/api/simulator/positions', (_req, res) => {
  res.json({ positions: simulator.getAllPositions(), summary: simulator.getSummary() });
});

// POST /api/simulator/reset — clear all virtual positions (for testing)
app.post('/api/simulator/reset', (_req, res) => {
  simulator.reset();
  console.log('[sim] Positions reset via API');
  res.json({ status: 'ok', message: 'All simulator positions cleared' });
});

// ---------------------------------------------------------------------------
// Prop Firm Tracker — persistent JSON store
// ---------------------------------------------------------------------------

const PF_PATH = path.join(__dirname, '..', 'data', 'logs', 'propfirms.json');

function _loadPF() {
  try {
    if (fs.existsSync(PF_PATH)) return JSON.parse(fs.readFileSync(PF_PATH, 'utf8'));
  } catch (_) {}
  return { accounts: [], expenses: [], payouts: [] };
}
function _savePF(data) {
  fs.writeFileSync(PF_PATH, JSON.stringify(data, null, 2));
}
// Recompute currentValue = accountSize + sum(daily P&L) - sum(linked payout gross withdrawals)
// grossAmount = full amount withdrawn from account (firm takes a cut); falls back to amount if not set
function _recomputeCV(acc, allPayouts) {
  const pnlSum    = (acc.dailyProgress || []).reduce((s, d) => s + (+d.pnl || 0), 0);
  const payoutSum = (allPayouts || []).filter(p => p.accountId === acc.id)
    .reduce((s, p) => s + (+p.grossAmount || +p.amount || 0), 0);
  acc.currentValue = (+acc.accountSize || 0) + pnlSum - payoutSum;
}

// GET /api/propfirms — full dataset
app.get('/api/propfirms', (_req, res) => {
  res.json(_loadPF());
});

// POST /api/propfirms/account — add or update a prop account entry
app.post('/api/propfirms/account', (req, res) => {
  const data = _loadPF();
  const { id, firm, date, accountSize, cost, status, subStatus, blowReason, notes, maxDrawdown, currentValue, ddType, phase, fundedFailed } = req.body;
  if (id) {
    const idx = data.accounts.findIndex(a => a.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const existing = data.accounts[idx];
    const updated = { ...existing, firm, date, accountSize: +accountSize || 0, cost: +cost || 0,
      status, subStatus, blowReason, notes, maxDrawdown: +maxDrawdown || 0,
      ddType: ddType || 'static', phase: phase || 'challenge', fundedFailed: !!fundedFailed };
    // If daily entries exist, auto-compute currentValue (P&L minus linked payouts)
    if ((existing.dailyProgress || []).length > 0) {
      _recomputeCV(updated, data.payouts);
    } else {
      updated.currentValue = +currentValue || 0;
    }
    data.accounts[idx] = updated;
  } else {
    data.accounts.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      firm, date, accountSize: +accountSize || 0, cost: +cost || 0, status, subStatus, blowReason, notes,
      maxDrawdown: +maxDrawdown || 0, currentValue: +currentValue || 0, ddType: ddType || 'static',
      phase: phase || 'challenge', fundedFailed: !!fundedFailed,
      dailyProgress: [], createdAt: new Date().toISOString() });
  }
  _savePF(data);
  res.json({ ok: true });
});

// POST /api/propfirms/account/:id/day — add or update a daily progress entry
app.post('/api/propfirms/account/:id/day', (req, res) => {
  const data = _loadPF();
  const acc = data.accounts.find(a => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'Not found' });
  if (!acc.dailyProgress) acc.dailyProgress = [];
  const { dayId, date, pnl, maxValue, notes } = req.body;
  if (dayId) {
    const idx = acc.dailyProgress.findIndex(d => d.id === dayId);
    if (idx !== -1) acc.dailyProgress[idx] = { ...acc.dailyProgress[idx], date, pnl: +pnl || 0,
      maxValue: maxValue ? +maxValue : undefined, notes };
  } else {
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      date, pnl: +pnl || 0, notes };
    if (maxValue) entry.maxValue = +maxValue;
    acc.dailyProgress.push(entry);
  }
  // Auto-recompute currentValue: P&L minus linked payouts
  _recomputeCV(acc, data.payouts);
  _savePF(data);
  res.json({ ok: true });
});

// DELETE /api/propfirms/account/:id/day/:dayId
app.delete('/api/propfirms/account/:id/day/:dayId', (req, res) => {
  const data = _loadPF();
  const acc = data.accounts.find(a => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'Not found' });
  acc.dailyProgress = (acc.dailyProgress || []).filter(d => d.id !== req.params.dayId);
  _recomputeCV(acc, data.payouts);
  _savePF(data);
  res.json({ ok: true });
});

// DELETE /api/propfirms/account/:id
app.delete('/api/propfirms/account/:id', (req, res) => {
  const data = _loadPF();
  data.accounts = data.accounts.filter(a => a.id !== req.params.id);
  _savePF(data);
  res.json({ ok: true });
});

// POST /api/propfirms/expense — add or update an expense
app.post('/api/propfirms/expense', (req, res) => {
  const data = _loadPF();
  const { id, item, date, amount, notes } = req.body;
  if (id) {
    const idx = data.expenses.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    data.expenses[idx] = { ...data.expenses[idx], item, date, amount: +amount || 0, notes };
  } else {
    data.expenses.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      item, date, amount: +amount || 0, notes, createdAt: new Date().toISOString() });
  }
  _savePF(data);
  res.json({ ok: true });
});

// DELETE /api/propfirms/expense/:id
app.delete('/api/propfirms/expense/:id', (req, res) => {
  const data = _loadPF();
  data.expenses = data.expenses.filter(e => e.id !== req.params.id);
  _savePF(data);
  res.json({ ok: true });
});

// POST /api/propfirms/payout — add or update a payout (accountId optional — links to funded account)
app.post('/api/propfirms/payout', (req, res) => {
  const data = _loadPF();
  const { id, firm, date, amount, grossAmount, notes, accountId } = req.body;
  let affectedAccountId = accountId;
  if (id) {
    const idx = data.payouts.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    affectedAccountId = affectedAccountId || data.payouts[idx].accountId;
    data.payouts[idx] = { ...data.payouts[idx], firm, date, amount: +amount || 0, notes,
      ...(grossAmount ? { grossAmount: +grossAmount } : { grossAmount: undefined }),
      ...(accountId ? { accountId } : {}) };
  } else {
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      firm, date, amount: +amount || 0, notes, createdAt: new Date().toISOString() };
    if (grossAmount) entry.grossAmount = +grossAmount;
    if (accountId) entry.accountId = accountId;
    data.payouts.push(entry);
  }
  // If linked to an account, recompute its currentValue
  if (affectedAccountId) {
    const acc = data.accounts.find(a => a.id === affectedAccountId);
    if (acc) _recomputeCV(acc, data.payouts);
  }
  _savePF(data);
  res.json({ ok: true });
});

// DELETE /api/propfirms/payout/:id
app.delete('/api/propfirms/payout/:id', (req, res) => {
  const data = _loadPF();
  const payout = data.payouts.find(p => p.id === req.params.id);
  const linkedAccountId = payout?.accountId;
  data.payouts = data.payouts.filter(p => p.id !== req.params.id);
  // Recompute linked account's currentValue after payout removal
  if (linkedAccountId) {
    const acc = data.accounts.find(a => a.id === linkedAccountId);
    if (acc) _recomputeCV(acc, data.payouts);
  }
  _savePF(data);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Real Account Tracker — persistent JSON store
// ---------------------------------------------------------------------------

const RA_PATH = path.join(__dirname, '..', 'data', 'logs', 'realaccount.json');

function _loadRA() {
  try {
    if (fs.existsSync(RA_PATH)) {
      const data = JSON.parse(fs.readFileSync(RA_PATH, 'utf8'));
      // Migrate: assign default broker to any record that predates multi-broker support
      let dirty = false;
      (data.trades   || []).forEach(t => { if (!t.broker) { t.broker = 'Optimus Futures'; dirty = true; } });
      (data.deposits || []).forEach(d => { if (!d.broker) { d.broker = 'Optimus Futures'; dirty = true; } });
      if (dirty) fs.writeFileSync(RA_PATH, JSON.stringify(data, null, 2));
      return data;
    }
  } catch (_) {}
  return { trades: [], deposits: [] };
}
function _saveRA(data) {
  fs.writeFileSync(RA_PATH, JSON.stringify(data, null, 2));
}

// GET /api/realaccount — full dataset
app.get('/api/realaccount', (_req, res) => {
  res.json(_loadRA());
});

// POST /api/realaccount/trade — add or update a trade
app.post('/api/realaccount/trade', (req, res) => {
  const data = _loadRA();
  const { id, broker, date, symbol, buy, sell, pnl, fees, coq, cashOut, notes } = req.body;
  const feeObj = {
    commission:  +fees?.commission  || 0,
    clearingFee: +fees?.clearingFee || 0,
    exchangeFee: +fees?.exchangeFee || 0,
    nfaFee:      +fees?.nfaFee      || 0,
    platformFee: +fees?.platformFee || 0,
    total:       +fees?.total       || 0,
    perContract: {
      commission:  +fees?.perContract?.commission  || 0,
      clearingFee: +fees?.perContract?.clearingFee || 0,
      exchangeFee: +fees?.perContract?.exchangeFee || 0,
      nfaFee:      +fees?.perContract?.nfaFee      || 0,
      platformFee: +fees?.perContract?.platformFee || 0,
    },
  };
  const coqObj = { platform: +coq?.platform || 0, marketData: +coq?.marketData || 0 };
  if (id) {
    const idx = data.trades.findIndex(t => t.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    data.trades[idx] = { ...data.trades[idx], broker: broker || 'Optimus Futures', date, symbol,
      buy: +buy || 0, sell: +sell || 0, pnl: +pnl || 0,
      fees: feeObj, coq: coqObj, cashOut: +cashOut || 0, notes };
  } else {
    data.trades.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      broker: broker || 'Optimus Futures', date, symbol,
      buy: +buy || 0, sell: +sell || 0, pnl: +pnl || 0,
      fees: feeObj, coq: coqObj, cashOut: +cashOut || 0, notes,
      createdAt: new Date().toISOString(),
    });
  }
  _saveRA(data);
  res.json({ ok: true });
});

// DELETE /api/realaccount/trade/:id
app.delete('/api/realaccount/trade/:id', (req, res) => {
  const data = _loadRA();
  data.trades = data.trades.filter(t => t.id !== req.params.id);
  _saveRA(data);
  res.json({ ok: true });
});

// POST /api/realaccount/deposit — add or update a deposit/withdrawal record
app.post('/api/realaccount/deposit', (req, res) => {
  const data = _loadRA();
  const { id, broker, date, amount, type, notes } = req.body;
  if (id) {
    const idx = data.deposits.findIndex(d => d.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    data.deposits[idx] = { ...data.deposits[idx], broker: broker || 'Optimus Futures', date, amount: +amount || 0, type, notes };
  } else {
    data.deposits.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      broker: broker || 'Optimus Futures', date, amount: +amount || 0, type: type || 'deposit', notes,
      createdAt: new Date().toISOString(),
    });
  }
  _saveRA(data);
  res.json({ ok: true });
});

// DELETE /api/realaccount/deposit/:id
app.delete('/api/realaccount/deposit/:id', (req, res) => {
  const data = _loadRA();
  data.deposits = data.deposits.filter(d => d.id !== req.params.id);
  _saveRA(data);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// GET /api/realaccount/daily-pnl — today's net P&L from realaccount.json
app.get('/api/realaccount/daily-pnl', (_req, res) => {
  const data = _loadRA();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const todayTrades = (data.trades || []).filter(t => t.date === today);
  const netPnl = todayTrades.reduce((sum, t) => sum + (+t.pnl || 0), 0);
  const totalFees = todayTrades.reduce((sum, t) => sum + (+t.fees?.total || 0), 0);
  res.json({ date: today, trades: todayTrades.length, grossPnl: netPnl, fees: totalFees, netPnl: netPnl - totalFees });
});

// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[ws] Client connected');
  ws.on('close', () => console.log('[ws] Client disconnected'));
  ws.on('error', (err) => console.error('[ws] Error:', err.message));
});

// Broadcast a JSON payload to all connected browser clients.
// Called by later modules (data, analysis, ai) when they have something to push.
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// One-trade-at-a-time filter (per symbol).
// Processes a copy of the cache chronologically and marks any alert that fires
// while a prior trade for the same symbol is still open as suppressed:true.
// Does NOT mutate the cache — returns new objects.
// ---------------------------------------------------------------------------

function _applyTradeFilter(alerts) {
  // Work chronologically; tag copies so the cache is never mutated
  const chrono = alerts
    .map(a => ({ ...a, setup: { ...a.setup } }))        // shallow-copy each alert
    .sort((a, b) => a.setup.time - b.setup.time);       // oldest first

  const activeUntil = {}; // symbol → outcomeTime (Unix ts) | Infinity (still open)

  for (const alert of chrono) {
    const sym  = alert.symbol;
    const lock = activeUntil[sym];

    if (lock !== undefined && alert.setup.time < lock) {
      // A prior trade for this symbol is still running — suppress
      alert.suppressed = true;
    } else {
      // Prior trade resolved (or none existed) — this alert is actionable
      delete activeUntil[sym];

      if (alert.setup.outcome === 'open') {
        activeUntil[sym] = Infinity;
      } else if (alert.setup.outcomeTime) {
        activeUntil[sym] = alert.setup.outcomeTime;
      }
      // outcome won/lost with outcomeTime clears the lock after that time
    }
  }

  return chrono;
}

// ---------------------------------------------------------------------------
// 0DTE helper — QQQ options expire Mon/Wed/Fri; SPY every trading day.
// On these days, gamma pinning distorts OR breakouts and zone rejections
// for equity index futures (MNQ/MES). Apply -10 confidence penalty.
// ---------------------------------------------------------------------------

function _isZeroDTE() {
  const dow = new Date().getDay(); // 0=Sun … 6=Sat
  return [1, 3, 5].includes(dow); // Mon, Wed, Fri — QQQ 0DTE days
}

// ---------------------------------------------------------------------------
// Scan engine — detects setups across all symbol / timeframe combinations.
// In live mode this would be called on every candle close event.
// In seed mode it runs once at startup and is re-runnable via GET /api/scan.
// ---------------------------------------------------------------------------

const SCAN_SYMBOLS    = ['MNQ', 'MGC', 'MES', 'MCL', 'BTC', 'ETH', 'XRP'];
// 1m/2m/3m removed: with 15-min delayed data they are stale by the time they display.
// 5m removed: ~3 candles stale with delayed seed data — not actionable.
// 15m/30m/1h/2h/4h give actionable signals even accounting for the data lag.
const SCAN_TIMEFRAMES = ['15m', '30m', '1h', '2h', '4h'];

/**
 * Run a full scan. Returns the count of NEW alerts added to the cache.
 */
async function runScan() {
  console.log('[scan] Starting…');
  let newCount = 0;

  // Fetch calendar events once per scan (cached in calendar.js for 1h)
  let calendarCache = {};
  if (settings.features?.economicCalendar) {
    for (const sym of SCAN_SYMBOLS) {
      // Crypto symbols have no relevant ForexFactory calendar events
      if (['BTC', 'ETH', 'XRP'].includes(sym)) { calendarCache[sym] = []; continue; }
      try { calendarCache[sym] = await getCalendarEvents(sym); } catch { calendarCache[sym] = []; }
    }
  }

  for (const symbol of SCAN_SYMBOLS) {
    // Pre-compute 5m and 15m regimes for the alignment flag
    const regime5m  = _regimeFor(symbol, '5m');
    const regime15m = _regimeFor(symbol, '15m');
    const alignment = computeAlignment(regime15m, regime5m);
    const calendarEvents = calendarCache[symbol] || [];

    // ── Collect all setup candidates for this symbol across all TFs ──────────
    const candidates = []; // { tf, setup, regime }

    for (const tf of SCAN_TIMEFRAMES) {
      try {
        const candles    = getCandles(symbol, tf);
        const ind        = computeIndicators(candles, {
          swingLookback:    settings.swingLookback,
          impulseThreshold: settings.impulseThreshold,
          symbol,
          features:         settings.features || {},
        });
        const regime     = { ...classifyRegime(ind), alignment };
        const trendlines = detectTrendlines(candles, ind.atrCurrent);
        const setups     = detectSetups(candles, ind, regime, {
          rrRatio: settings.risk.rrRatio || 1.0, symbol, trendlines, calendarEvents,
        });

        for (const setup of setups) {
          // Multi-TF zone stack: check if the setup's key level has a confirming
          // IOF zone on a higher timeframe. Adds up to +20 confidence + badge.
          const stack = checkTFZoneStack(setup, symbol, tf, getCandles, computeIndicators, settings);
          if (stack.bonus > 0) {
            setup.confidence     = Math.min(100, setup.confidence + stack.bonus);
            setup.tfStack        = stack;
            setup.scoreBreakdown = { ...setup.scoreBreakdown, tfStack: stack.bonus };
            setup.rationale     += ` · ${stack.tfs.join('/')} stack`;
          }
          // 0DTE gate: Mon/Wed/Fri gamma pinning distorts OR breakouts and zone
          // rejections for equity index futures — reduce confidence by 10 pts.
          if (_isZeroDTE() && ['MNQ', 'MES'].includes(symbol) &&
              (setup.type === 'or_breakout' || setup.type === 'zone_rejection')) {
            setup.confidence = Math.max(0, setup.confidence - 10);
            setup.rationale += ' · 0DTE';
            setup.scoreBreakdown = { ...setup.scoreBreakdown, zeroDTE: -10 };
          }

          candidates.push({ tf, setup, regime });
        }
      } catch (err) {
        console.error(`[scan] ${symbol} ${tf} error: ${err.message}`);
      }
    }

    // ── MTF confluence: boost confidence when same direction fires on ≥2 TFs ─
    for (const cand of candidates) {
      const confirming = candidates.filter(
        o => o !== cand && o.setup.direction === cand.setup.direction && o.tf !== cand.tf
      );
      if (confirming.length > 0) {
        const tfs   = [...new Set(confirming.map(o => o.tf))];
        const bonus = Math.min(20, 10 * tfs.length);
        cand.setup.confidence    = Math.min(100, cand.setup.confidence + bonus);
        cand.setup.mtfConfluence = { tfs, bonus };
        cand.setup.rationale    += ` · MTF ${tfs.join('/')}`;
      }
    }

    // ── Cache and broadcast ───────────────────────────────────────────────────
    for (const { tf, setup, regime } of candidates) {
      // Dedup: skip if an open alert for the same symbol+tf+type+direction already exists.
      // This prevents the same ongoing condition (e.g. OR breakout) from generating a new
      // alert on every scan cycle.
      const alreadyOpen = alertCache.some(a =>
        a.symbol === symbol &&
        a.timeframe === tf &&
        a.setup.type === setup.type &&
        a.setup.direction === setup.direction &&
        (a.setup.outcome === 'open' || a.setup.outcome == null)
      );
      if (alreadyOpen) continue;

      // Calculate suggested contracts based on risk limit
      const POINT_VALUE = { MNQ: 2, MGC: 10, MES: 5, MCL: 100, BTC: 1, ETH: 0.01, XRP: 0.0001 };
      const slDistance  = Math.abs((setup.entry ?? setup.price) - setup.sl);
      const pointVal    = POINT_VALUE[symbol] || 1;
      if (slDistance > 0 && pointVal > 0) {
        const maxRisk = settings.risk.maxRiskDollars || 200;
        setup.suggestedContracts = Math.max(1, Math.floor(maxRisk / (slDistance * pointVal)));
      }

      const alert = {
        symbol,
        timeframe: tf,
        regime,
        setup,
        ts: new Date().toISOString(),
      };
      if (_cacheAlert(alert)) {
        broadcast({ type: 'setup', ...alert });
        newCount++;
        // Auto-order trigger — non-blocking; passes saveTradeLog + tradeLog refs
        autotrader.onNewAlert(alert, settings, saveTradeLog, tradeLog)
          .then(result => {
            if (result.placed) {
              console.log(`[autotrader] Order placed: orderId=${result.orderId} — ${alert.symbol} ${alert.setup.direction}`);
              broadcast({ type: 'order', ...result });
            } else {
              console.log(`[autotrader] Skipped ${alert.symbol} ${alert.setup.type}: ${result.reason}`);
            }
          })
          .catch(err => console.error('[autotrader] Error:', err.message));
      }
    }
  }

  console.log(`[scan] Done — ${newCount} new alerts  (${alertCache.length} cached total)`);

  // Persist alert cache immediately after scan
  saveAlertCache(alertCache);

  return newCount;
}

/**
 * Generate AI commentary for the top COMMENTARY_TOP_N unsuppressed alerts
 * that don't already have commentary. Skips already-analyzed alerts to avoid
 * unnecessary API calls. Called only when the user explicitly clicks "AI Analysis".
 */
async function _refreshCommentary() {
  // Apply trade filter to get suppressed flags, then take top N unsuppressed
  // that haven't been analyzed yet — skip anything with existing commentary.
  const filtered = _applyTradeFilter(alertCache);
  const top = filtered
    .filter(a => !a.suppressed && !a.commentary)
    .sort((a, b) => b.setup.confidence - a.setup.confidence)
    .slice(0, COMMENTARY_TOP_N);

  if (top.length === 0) return;

  // Build indicators context map (keyed "symbol:tf") to enrich AI prompts
  const perfStats = computePerformanceStats(alertCache);
  const extrasMap = {};
  const needed = [...new Set(top.map(a => `${a.symbol}:${a.timeframe}`))];
  for (const key of needed) {
    const [sym, tf] = key.split(':');
    try {
      const ind = computeIndicators(getCandles(sym, tf), {
        swingLookback:    settings.swingLookback,
        impulseThreshold: settings.impulseThreshold,
        symbol:           sym,
        features:         settings.features || {},
      });
      const symPerfKey  = `${sym}`;
      const setupStats  = perfStats.bySymbol?.[symPerfKey] || {};
      extrasMap[key] = {
        fvgs:          (ind.fvgs        || []).filter(f => f.status === 'open'),
        orderBlocks:   (ind.orderBlocks || []).filter(o => o.status !== 'mitigated'),
        sessionLevels: ind.sessionLevels  || null,
        volumeProfile: ind.volumeProfile  || null,
        atrCurrent:    ind.atrCurrent     || 0,
        perfStats:     setupStats,
      };
    } catch (_) {}
  }

  const items = await generateCommentary(top, getCandles, settings, extrasMap);
  if (!items) return; // null = rate-limited; keep existing cache

  // Attach commentary text to each alert object so it persists and can be
  // served instantly on future requests without re-calling the API.
  items.forEach(item => {
    if (item.alert && item.commentary) {
      item.alert.commentary = item.commentary;
    }
  });

  commentaryCache = { generated: new Date().toISOString(), items };
  broadcast({ type: 'commentary', generated: commentaryCache.generated, count: items.length });
  console.log(`[ai] Commentary cached (${items.length} items) and broadcast`);

  // Persist both caches so they survive a restart
  saveAlertCache(alertCache);
  saveCommentaryCache(commentaryCache);
}

/** Safely compute regime for one symbol + timeframe. Returns null on error. */
function _regimeFor(symbol, tf) {
  try {
    const candles = getCandles(symbol, tf);
    const ind     = computeIndicators(candles, {
      swingLookback:    settings.swingLookback,
      impulseThreshold: settings.impulseThreshold,
      symbol,
      features:         settings.features || {},
    });
    return classifyRegime(ind);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto-refresh (seed mode) — fetches fresh Yahoo Finance data every 15 min,
// evicts open-outcome alerts so they get re-evaluated against new candles,
// then re-runs the scan and broadcasts data_refresh to connected clients.
//
// Live-mode seam: replace the setInterval below with a broker WebSocket
// candle-close handler and call _autoRefresh({ fetchData: false }) — the
// broker already wrote fresh candles; skip the Yahoo fetch step.
// ---------------------------------------------------------------------------

async function _autoRefresh({ fetchData = true } = {}) {
  console.log('[refresh] Starting data refresh…');

  if (fetchData) {
    try {
      await fetchAll();
    } catch (err) {
      console.error('[refresh] Yahoo fetch failed:', err.message, '— using existing data');
      // Non-fatal: continue with existing seed files; scan still re-evaluates open setups
    }
    try {
      await fetchAllCrypto();
    } catch (err) {
      console.error('[refresh] Coinbase fetch failed:', err.message, '— using existing crypto data');
    }
  }

  // Evict open-outcome alerts so they get re-detected with potentially updated outcomes.
  // Historical resolved setups (won/lost) stay in alertSeenKeys — they won't re-fire.
  // userOverride: true = user manually set outcome; never re-evaluate these.
  const openKeys = new Set(
    alertCache
      .filter(a => a.setup.outcome === 'open' && !a.setup.userOverride)
      .map(a => `${a.symbol}:${a.timeframe}:${a.setup.type}:${a.setup.time}`)
  );
  // Track which keys are re-evaluations so _cacheAlert won't count them as new alerts.
  for (const k of openKeys) reEvalKeys.add(k);
  for (const k of openKeys) alertSeenKeys.delete(k);
  for (let i = alertCache.length - 1; i >= 0; i--) {
    if (alertCache[i].setup.outcome === 'open' && !alertCache[i].setup.userOverride) alertCache.splice(i, 1);
  }
  if (openKeys.size > 0) {
    console.log(`[refresh] Evicted ${openKeys.size} open-outcome alert(s) for re-evaluation`);
  }

  // Check simulator positions against the freshly loaded candles.
  // Use 5m candles (finest available) for the best fill resolution.
  for (const sym of SCAN_SYMBOLS) {
    try {
      const candles5m = getCandles(sym, '5m');
      const filled    = simulator.checkFills(sym, candles5m);
      for (const pos of filled) {
        // Update the matching trade log entry with the close details
        const idx = tradeLog.findIndex(t => t.simOrderId === pos.id);
        if (idx >= 0) {
          tradeLog[idx].actualExit = pos.closePrice;
          tradeLog[idx].notes     += ` → ${pos.status} @ ${pos.closePrice}  P&L: ${pos.pnl >= 0 ? '+' : ''}$${pos.pnl}`;
          saveTradeLog(tradeLog);
        }
        // Broadcast the fill event so the UI can react immediately
        broadcast({
          type:       'sim_fill',
          orderId:    pos.id,
          symbol:     pos.symbol,
          direction:  pos.direction,
          status:     pos.status,
          closePrice: pos.closePrice,
          pnl:        pos.pnl,
          alertKey:   pos.alertKey,
        });
        console.log(`[sim] Broadcasted fill: ${pos.symbol} ${pos.status}  P&L $${pos.pnl}`);
      }
    } catch (err) {
      console.error(`[sim] checkFills ${sym} error: ${err.message}`);
    }
  }

  const newCount = await runScan();
  lastRefreshTs  = new Date().toISOString();
  nextRefreshTs  = new Date(Date.now() + refreshIntervalMs).toISOString();
  broadcast({ type: 'data_refresh', ts: lastRefreshTs, newAlerts: newCount, nextRefresh: nextRefreshTs });
  console.log(`[refresh] Done — ${newCount} new alerts, data as of ${lastRefreshTs}`);
}

/**
 * (Re-)start the recurring auto-refresh interval using the current refreshIntervalMs.
 * Cancels any existing interval first. Called at startup and when the interval changes.
 */
function _scheduleRefresh() {
  if (_refreshIntervalId) clearInterval(_refreshIntervalId);
  nextRefreshTs = new Date(Date.now() + refreshIntervalMs).toISOString();
  _refreshIntervalId = setInterval(
    () => _autoRefresh().catch(err => console.error('[refresh] Error:', err.message)),
    refreshIntervalMs
  );
  console.log(`[refresh] Interval set to ${refreshIntervalMs / 60000} min, next: ${nextRefreshTs}`);
  broadcast({ type: 'refresh_schedule', nextRefresh: nextRefreshTs, intervalMins: Math.round(refreshIntervalMs / 60000) });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  console.log(`[startup] Data source: ${DATA_SOURCE}`);

  if (DATA_SOURCE === 'seed') {
    // No broker credentials needed — candles come from data/seed/*.json
    console.log('[startup] Seed mode — skipping broker auth');
  } else {
    // Live mode — require Tradovate credentials before opening the port
    const required = [
      'TRADOVATE_USERNAME',
      'TRADOVATE_PASSWORD',
      'TRADOVATE_APP_ID',
      'TRADOVATE_APP_SECRET',
      'TRADOVATE_API_URL',
    ];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
      console.error('[startup] Missing required env vars:', missing.join(', '));
      console.error('[startup] Fill in .env and restart.');
      process.exit(1);
    }
    await authenticate();
  }

  server.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
    if (DATA_SOURCE === 'seed') {
      // Restore persisted alerts + commentary before scanning so the feed is
      // instantly populated and existing commentary doesn't need regeneration.
      _loadPersistedData();
      setTimeout(() => runScan().catch(err => console.error('[scan] Error:', err.message)), 500);

      // Schedule 15-minute auto-refresh. First refresh fires at T+15min (initial
      // scan already ran above). Subsequent refreshes follow at the same interval.
      // ── Live-mode integration point ─────────────────────────────────────────
      // When switching to a live broker feed, remove this block and subscribe to
      // the broker's WebSocket candle-close events, calling:
      //   _autoRefresh({ fetchData: false })
      // The scan engine, alert cache, and broadcast logic remain unchanged.
      // ────────────────────────────────────────────────────────────────────────
      nextRefreshTs = new Date(Date.now() + refreshIntervalMs).toISOString();
      setTimeout(() => {
        _autoRefresh().catch(err => console.error('[refresh] Error:', err.message));
        _scheduleRefresh(); // start the recurring interval from this point
      }, refreshIntervalMs);
      console.log(`[startup] Auto-refresh scheduled every ${refreshIntervalMs / 60000} min`);

    // Real-time crypto prices — Coinbase Exchange WebSocket (free, no auth)
    coinbaseWS.start();
    coinbaseWS.on('price', ({ symbol, price, time }) => {
      broadcast({ type: 'live_price', symbol, price, time });
    });
    console.log('[startup] Coinbase WebSocket starting for BTC/ETH/XRP live prices');
    }
  });
}

start().catch(err => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});

module.exports = { app, server, wss, broadcast };
