'use strict';

require('dotenv').config();

const http    = require('http');
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { authenticate }      = require('./auth/tradovate');
const { getCandles, writeLiveCandle, LIVE_FUTURES } = require('./data/snapshot');
const gapFill                       = require('./data/gapFill');
const { writeLiveCandleToDisk, getLiveBarStats } = require('./data/liveArchive');
const { getLiveFeedStatus, startLiveFeed } = require('./data/databento');
const { validateBar, getValidatorStats } = require('./data/barValidator');
const { computeIndicators, computeDDBands } = require('./analysis/indicators');
const { classifyRegime, computeAlignment } = require('./analysis/regime');
const { detectSetups }      = require('./analysis/setups');
const { detectTrendlines }  = require('./analysis/trendlines');
const { generateCommentary, generateSingle } = require('./ai/commentary');
const { checkTFZoneStack }  = require('./analysis/confluence');
const { saveAlertCache, loadAlertCache, saveCommentaryCache, loadCommentaryCache,
        saveTradeLog, loadTradeLog,
        loadArchive, appendToArchive, updateArchiveOutcome,
        loadForwardTrades } = require('./storage/log');
const { fetchAll }              = require('./data/seedFetch');
const { fetchAllCrypto }        = require('./data/coinbaseFetch');
const coinbaseWS                = require('./data/coinbaseWS');
const { getForexRate, getOptionsFlow, getGammaData } = require('./data/polygonFetch');
const autotrader                = require('./trading/autotrader');
const simulator                 = require('./trading/simulator');
const { checkLiveOutcomes, getOpenForwardTestCount } = require('./trading/simulator');
const { computeRelativeStrength } = require('./analysis/relativeStrength');
const { computeCorrelationMatrix } = require('./analysis/correlation');
const { computePerformanceStats, computeOptimizeStats } = require('./analysis/performanceStats');
const { predict }                  = require('./analysis/predictor');
const { getCalendarEvents } = require('./data/calendar');
const { getOptionsData }    = require('./data/options');
const opraLive              = require('./data/opraLive');
const { buildMarketContext } = require('./analysis/marketContext');
const { computeSetupReadiness, computeDirectionalBias } = require('./analysis/bias');
const { isDuplicate, applyStaleness, pruneExpired } = require('./analysis/alertDedup');
const pushManager = require('./push/pushManager');
const settings              = require('../config/settings.json');
const fs                    = require('fs');

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
// ATR cache: keyed 'symbol:tf' → atrCurrent; updated during runScan for dedup proximity
const _lastAtr      = new Map();
// Per-symbol caches for bias panel — updated during runScan
const _lastMarketContext = new Map(); // symbol → marketContext object
const _lastIndicators    = new Map(); // symbol → indicators (15m) object
const _lastCalendarNear  = new Map(); // symbol → boolean (near high-impact event)

const MAX_ALERTS = 100;

// ── Commentary rate-limit map (per-symbol, for auto-commentary on fresh alerts) ──
const _lastCommentaryTs = new Map(); // symbol → Date.now() of last commentary call
const COMMENTARY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per symbol

// ── Commentary cache ──────────────────────────────────────────────────────────
// Holds the last successful AI commentary run.
// { generated: ISO string, items: [{ symbol, timeframe, setupTime, commentary, alert }] }
let commentaryCache = { generated: null, items: [] };

// ── Trade log ─────────────────────────────────────────────────────────────────
let tradeLog = []; // persisted to data/logs/trades.json

// ── Fee log ───────────────────────────────────────────────────────────────────
const FEES_PATH = path.join(__dirname, '..', 'data', 'logs', 'fees.json');
function _loadFees() {
  try { return JSON.parse(fs.readFileSync(FEES_PATH, 'utf8')); } catch (_) { return []; }
}
function _saveFees(data) { fs.writeFileSync(FEES_PATH, JSON.stringify(data, null, 2)); }

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

  // Zone-level dedup: suppress if a matching open alert already exists at the same level
  if (!isReEval) {
    const atr = _lastAtr.get(`${alert.symbol}:${alert.timeframe}`) || 0;
    if (isDuplicate(alert, alertCache, atr)) return false;
  }

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

    // Push notification — fires on high-confidence fresh alerts (feature-flag gated)
    const s = alert.setup;
    const shouldPush = (
      settings.features?.pushNotifications === true &&
      (s.confidence || 0) >= 80 &&
      (s.staleness === 'fresh' || !s.staleness) &&
      (s.ddBandLabel == null || s.ddBandLabel === 'room_to_run')
    );
    if (shouldPush) {
      const dir = s.direction === 'bullish' ? '\u25b2' : '\u25bc';
      pushManager.sendPushNotification({
        title: `${alert.symbol} ${(s.type || '').replace(/_/g, ' ')}`,
        body:  `${dir} ${s.confidence}% conf \u2014 ${s.entry ?? s.price}`,
        icon:  '/icons/icon-192.png',
        data:  { symbol: alert.symbol, ts: s.time },
      }).catch(err => console.error('[Push] sendPushNotification error:', err.message));
    }
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

// GET /api/candles?symbol=MNQ&timeframe=5m&refresh=true
app.get('/api/candles', async (req, res) => {
  const { symbol = 'MNQ', timeframe = '5m', refresh } = req.query;
  try {
    // When refresh=true, run gap fill for this symbol/TF before returning
    if (refresh === 'true') {
      try {
        await gapFill.fillCandleGaps(symbol, timeframe);
      } catch (err) {
        console.warn(`[api] /candles refresh gap fill failed: ${err.message}`);
      }
    }
    const candles = getCandles(symbol, timeframe);
    console.log(`[api] /candles  symbol=${symbol}  tf=${timeframe}  count=${candles.length}${refresh === 'true' ? '  (refreshed)' : ''}`);
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

// GET /api/settings — returns the risk section of settings.json for the frontend
app.get('/api/settings', (_req, res) => {
  res.json({ risk: settings.risk || {} });
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

// POST /api/features — hot-toggle a feature flag without restart
// Body: { "featureName": true|false }
app.post('/api/features', (req, res) => {
  const updates = req.body || {};
  if (!settings.features) settings.features = {};
  for (const [key, val] of Object.entries(updates)) {
    settings.features[key] = Boolean(val);
  }
  try {
    fs.writeFileSync('./config/settings.json', JSON.stringify(settings, null, 2));
    res.json({ ok: true, features: settings.features });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Push notification API ─────────────────────────────────────────────────────

// GET /api/push/vapid-public-key — returns VAPID public key for browser subscription
app.get('/api/push/vapid-public-key', (_req, res) => {
  const key = pushManager.getVapidPublicKey();
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

// POST /api/push/subscribe — save a new PushSubscription (feature-flag gated)
app.post('/api/push/subscribe', (req, res) => {
  if (!settings.features?.pushNotifications) {
    return res.status(403).json({ error: 'Push notifications not enabled' });
  }
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'subscription.endpoint required' });
  }
  pushManager.saveSubscription(subscription);
  res.json({ ok: true });
});

// DELETE /api/push/subscribe — remove a PushSubscription by endpoint
app.delete('/api/push/subscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  pushManager.removeSubscription(endpoint);
  res.json({ ok: true });
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
        ddBands:       ind.ddBands || null,
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

// GET /api/trade-chart/:tradeId — candle slice + buy/sell markers for a trade
app.get('/api/trade-chart/:tradeId', (req, res) => {
  try {
    const trade = tradeLog.find(t => t.id === req.params.tradeId);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });

    // Resolve timestamp from entry/exit — CSV imports use 'time', manual fills use 'at'
    const ts = e => e.time || e.at || trade.takenAt || null;

    // Normalise entries/exits — fall back to top-level fields
    const entries = (trade.entries && trade.entries.length)
      ? trade.entries
      : trade.actualEntry ? [{ qty: trade.contracts || 1, price: trade.actualEntry, time: trade.takenAt }] : [];
    const exits = (trade.exits && trade.exits.length)
      ? trade.exits
      : trade.actualExit ? [{ qty: trade.contracts || 1, price: trade.actualExit, time: trade.takenAt, pnl: trade.pnl }] : [];

    if (!entries.length) return res.status(400).json({ error: 'No entry data on this trade' });

    const firstTs = ts(entries[0]);
    const lastTs  = exits.length ? ts(exits[exits.length - 1]) : null;
    if (!firstTs) return res.status(400).json({ error: 'Trade has no timestamp' });

    const firstMs    = new Date(firstTs).getTime();
    const lastMs     = lastTs ? new Date(lastTs).getTime() : firstMs + 5 * 60 * 1000;
    const durationMs = Math.max(0, lastMs - firstMs);

    // Use requested TF (default 1m); validate against allowed set
    const ALLOWED_TFS = new Set(['1m','5m','15m','30m','1h']);
    let chartTf = ALLOWED_TFS.has(req.query.tf) ? req.query.tf : '1m';

    let candles;
    try {
      candles = getCandles(trade.symbol, chartTf);
    } catch (_e1) {
      try { candles = getCandles(trade.symbol, '5m'); chartTf = '5m'; }
      catch (_e2) { return res.status(400).json({ error: `No candle data for ${trade.symbol}` }); }
    }

    const TF_SEC = { '1m': 60, '2m': 120, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400 };
    const candleSec = TF_SEC[chartTf] || 300;
    const windowSec = 15 * 60; // 15 minutes before/after

    const startSec = Math.floor(firstMs / 1000) - windowSec;
    const endSec   = Math.ceil(lastMs  / 1000)  + windowSec;
    const slice    = candles.filter(c => c.time >= startSec && c.time <= endSec);

    if (!slice.length) {
      const tradeDate = new Date(firstMs).toISOString().slice(0, 10);
      const seedStart = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
      const seedEnd   = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);
      return res.status(400).json({
        error: `No ${chartTf} candles for ${trade.symbol} on ${tradeDate}. Seed covers ${seedStart} → ${seedEnd}. Run seedFetch.js to refresh.`,
      });
    }

    const isBull = (trade.direction || 'bullish') === 'bullish';
    const markers = [];

    for (const e of entries) {
      const t = ts(e);
      if (!t) continue;
      const snapped = Math.floor(new Date(t).getTime() / 1000 / candleSec) * candleSec;
      markers.push({
        time:     snapped,
        position: isBull ? 'belowBar' : 'aboveBar',
        shape:    isBull ? 'arrowUp'  : 'arrowDown',
        color:    '#4caf50',
        text:     `B ${e.qty}@${Number(e.price).toFixed(2)}`,
      });
    }
    for (const x of exits) {
      const t = ts(x);
      if (!t) continue;
      const snapped = Math.floor(new Date(t).getTime() / 1000 / candleSec) * candleSec;
      markers.push({
        time:     snapped,
        position: isBull ? 'aboveBar' : 'belowBar',
        shape:    isBull ? 'arrowDown' : 'arrowUp',
        color:    (x.pnl ?? 0) >= 0 ? '#4caf50' : '#ef4444',
        text:     `S ${x.qty}@${Number(x.price).toFixed(2)}`,
      });
    }

    // LW Charts requires markers sorted by time with no duplicate (time, position) pairs
    markers.sort((a, b) => a.time - b.time);

    console.log(`[trade-chart] ${trade.symbol} ${chartTf} id=${trade.id} candles=${slice.length} markers=${markers.length}`);
    res.json({ tradeId: trade.id, symbol: trade.symbol, timeframe: chartTf,
               direction: trade.direction, outcome: trade.outcome, pnl: trade.pnl,
               candles: slice, markers });
  } catch (err) {
    console.error('[trade-chart] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts — combined list of prop firm accounts + real account brokers for trade linking
app.get('/api/accounts', (_req, res) => {
  const pf = JSON.parse(fs.readFileSync(PF_PATH, 'utf8') || '{}');
  const ra = _loadRA();
  const pfAccounts = (pf.accounts || []).filter(a => {
    if (a.phase === 'funded') return !a.fundedFailed; // funded accounts: show if not failed
    return a.status === 'active';                      // challenge accounts: show if active
  }).map(a => ({
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

// Point values for P&L auto-calc — sourced from instruments.js
const { POINT_VALUE: FILL_POINT_VALUE, INSTRUMENTS: _INSTRUMENTS, loadSettingsOverrides } = require('./data/instruments');

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

// ─── Fee routes ───────────────────────────────────────────────────────────────

// GET /api/fees — return fee records with optional filters
app.get('/api/fees', (req, res) => {
  let fees = _loadFees();
  const { accountId, symbol, dateFrom, dateTo } = req.query;
  if (accountId) fees = fees.filter(f => f.accountId === accountId);
  if (symbol)    fees = fees.filter(f => f.symbol === symbol);
  if (dateFrom)  fees = fees.filter(f => f.date >= dateFrom);
  if (dateTo)    fees = fees.filter(f => f.date <= dateTo);
  res.json({ fees });
});

// POST /api/fees/import-csv — parse TradeDay fees CSV and store
app.post('/api/fees/import-csv', (req, res) => {
  try {
    const { csv, accountId, accountLabel, accountType } = req.body;
    if (!csv) return res.status(400).json({ error: 'csv required' });

    const rows = _parseTdFeesCsv(csv);
    const existing = _loadFees();
    const existingTxIds = new Set(existing.flatMap(f => f.txIds || []));

    let created = 0, duplicates = 0;
    const grouped = _groupFeeRows(rows);

    for (const rec of grouped) {
      if (rec.txIds.some(id => existingTxIds.has(id))) { duplicates++; continue; }
      if (accountId) { rec.accountId = accountId; rec.accountLabel = accountLabel; rec.accountType = accountType; }
      existing.push(rec);
      created++;
    }

    if (created > 0) _saveFees(existing);
    res.json({ created, duplicates, total: grouped.length });
  } catch (err) {
    console.error('[fees/import-csv]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/fees/all — clear all fee records (for re-import)
app.delete('/api/fees/all', (req, res) => {
  _saveFees([]);
  res.json({ ok: true });
});

// Parse TradeDay fees CSV (Account,Transaction ID,Timestamp,Date,Delta,Amount,Cash Change Type,Currency,Contract)
function _parseTdFeesCsv(csvText) {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  const rawHeaders = _parseCsvLine(lines[0]);
  const headers = rawHeaders.map(h => h.trim());
  const FEE_TYPES = new Set(['Exchange Fee', 'Clearing Fee', 'Nfa Fee', 'Commission']);
  return lines.slice(1).map(line => {
    if (!line.trim()) return null;
    const fields = _parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (fields[i] || '').trim());
    return obj;
  }).filter(r => r && FEE_TYPES.has(r['Cash Change Type']));
}

// Group fee rows by (Timestamp, Contract) → one round-turn fee record per group
const CONTRACT_SYMBOL = { MNQH6:'MNQ', MGCJ6:'MGC', MESH6:'MES', MCLJ6:'MCL', MCLM6:'MCL', MNQM6:'MNQ', MGCM6:'MGC' };
function _getSymbol(contract) {
  if (CONTRACT_SYMBOL[contract]) return CONTRACT_SYMBOL[contract];
  // Fallback: first 3 chars if it starts with MNQ/MGC/MES/MCL
  for (const sym of ['MNQ','MGC','MES','MCL','BTC','ETH','XRP']) {
    if (contract.startsWith(sym)) return sym;
  }
  return contract;
}

function _groupFeeRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row['Timestamp']}|${row['Contract']}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const records = [];
  for (const [, grp] of groups) {
    const first = grp[0];
    const contract = first['Contract'];
    const symbol = _getSymbol(contract);
    const rec = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      date: first['Date'],
      symbol,
      contract,
      timestamp: first['Timestamp'],
      sourceAccount: first['Account'],
      exchange: 0, clearing: 0, nfa: 0, commission: 0, total: 0,
      txIds: grp.map(r => r['Transaction ID']),
    };
    for (const row of grp) {
      const delta = -parseFloat((row['Delta'] || '0').replace(/,/g, '')) || 0; // fees are negative deltas
      const type = row['Cash Change Type'];
      if (type === 'Exchange Fee') rec.exchange += delta;
      else if (type === 'Clearing Fee') rec.clearing += delta;
      else if (type === 'Nfa Fee') rec.nfa += delta;
      else if (type === 'Commission') rec.commission += delta;
    }
    rec.exchange    = +rec.exchange.toFixed(4);
    rec.clearing    = +rec.clearing.toFixed(4);
    rec.nfa         = +rec.nfa.toFixed(4);
    rec.commission  = +rec.commission.toFixed(4);
    rec.total       = +(rec.exchange + rec.clearing + rec.nfa + rec.commission).toFixed(4);
    records.push(rec);
  }
  return records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ─── CSV Import helpers ───────────────────────────────────────────────────────

function _parseCsvLine(line) {
  const fields = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { fields.push(current); current = ''; }
    else { current += ch; }
  }
  fields.push(current);
  return fields;
}

function _parseTptCsv(csvText) {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  const headers = _parseCsvLine(lines[0]).map(h => h.trim());
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const fields = _parseCsvLine(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (fields[i] || '').trim(); });
      return obj;
    })
    .filter(r => r['Status'] && r['Status'].trim() === 'Filled');
}

function _finalizeCsvTrade(trade) {
  const pv  = FILL_POINT_VALUE[trade.symbol] || 1;
  const dir = trade.direction === 'bullish' ? 1 : -1;
  const totalQty     = trade.entries.reduce((s, e) => s + e.qty, 0);
  const blendedEntry = trade.entries.reduce((s, e) => s + e.qty * e.price, 0) / totalQty;
  let totalPnl = 0;
  const exits = trade.exits.map(x => {
    const pnl = +(dir * (x.price - blendedEntry) * x.qty * pv).toFixed(2);
    totalPnl += pnl;
    return { ...x, pnl };
  });
  const totalExited       = exits.reduce((s, x) => s + x.qty, 0);
  const remainingContracts = Math.max(0, totalQty - totalExited);
  const isOpen            = trade.openPosition || remainingContracts > 0;
  const outcome           = isOpen ? '' : (totalPnl >= 0 ? 'won' : 'lost');
  return { ...trade, exits, actualEntry: +blendedEntry.toFixed(4), contracts: totalQty, remainingContracts, pnl: +totalPnl.toFixed(2), outcome, dca: trade.entries.length > 1 };
}

function _pairOrders(rows) {
  const KNOWN = new Set(['MNQ', 'MGC', 'MES', 'MCL', 'BTC', 'ETH', 'XRP']);
  rows.sort((a, b) => new Date(a['Fill Time']) - new Date(b['Fill Time']));
  const bySymbol = {};
  for (const row of rows) {
    const sym = row['Product'];
    if (!sym || !KNOWN.has(sym)) continue;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(row);
  }
  const trades = [];
  for (const [symbol, orders] of Object.entries(bySymbol)) {
    let position = 0, currentTrade = null;
    for (const order of orders) {
      const side  = order['B/S'];
      const qty   = parseFloat(order['filledQty']);
      const price = parseFloat(order['avgPrice']);
      const fillTime = new Date(order['Fill Time']);
      if (!qty || !price || isNaN(qty) || isNaN(price)) continue;
      const sign = side === 'Buy' ? 1 : -1;
      const prevPosition = position;

      if (prevPosition === 0) {
        currentTrade = { symbol, direction: sign > 0 ? 'bullish' : 'bearish',
          entries: [{ qty, price, time: fillTime.toISOString() }], exits: [],
          openTime: fillTime, importedOrderIds: [order['orderId']] };
        position = sign * qty;
      } else if (Math.sign(sign) === Math.sign(prevPosition)) {
        currentTrade.entries.push({ qty, price, time: fillTime.toISOString() });
        currentTrade.importedOrderIds.push(order['orderId']);
        position += sign * qty;
      } else {
        const closeQty = Math.min(qty, Math.abs(prevPosition));
        currentTrade.exits.push({ qty: closeQty, price, time: fillTime.toISOString() });
        currentTrade.importedOrderIds.push(order['orderId']);
        position += sign * qty;
        // Handle position flip — excess opens a new trade
        const excess = qty - closeQty;
        if (Math.abs(position) > 0.001 && Math.sign(position) !== Math.sign(prevPosition)) {
          trades.push(_finalizeCsvTrade(currentTrade));
          currentTrade = { symbol, direction: sign > 0 ? 'bullish' : 'bearish',
            entries: [{ qty: excess, price, time: fillTime.toISOString() }], exits: [],
            openTime: fillTime, importedOrderIds: [order['orderId']] };
        }
      }
      if (Math.abs(position) < 0.001) {
        if (currentTrade) { trades.push(_finalizeCsvTrade(currentTrade)); currentTrade = null; }
        position = 0;
      }
    }
    if (currentTrade && Math.abs(position) > 0.001) {
      currentTrade.openPosition = true;
      trades.push(_finalizeCsvTrade(currentTrade));
    }
  }
  return trades;
}

// POST /api/trades/import-csv — parse and import a TPT/Tradovate orders CSV
app.post('/api/trades/import-csv', (req, res) => {
  try {
    const { csv, accountId, accountLabel, accountType, dryRun } = req.body;
    if (!csv) return res.status(400).json({ error: 'csv required' });
    const rows = _parseTptCsv(csv);
    if (rows.length === 0) return res.status(400).json({ error: 'No filled orders found in CSV' });
    const pairedTrades = _pairOrders(rows);

    const existingOrderIds = new Set();
    for (const t of tradeLog) {
      for (const id of (t.importedOrderIds || [])) existingOrderIds.add(id);
    }
    const newTrades = [], dupeIds = new Set();
    for (const t of pairedTrades) {
      if (t.importedOrderIds.some(id => existingOrderIds.has(id))) { dupeIds.add(t.importedOrderIds[0]); }
      else { newTrades.push(t); }
    }

    if (dryRun) {
      return res.json({ total: pairedTrades.length, new: newTrades.length, duplicates: dupeIds.size, trades: newTrades });
    }

    const now = Date.now();
    for (let i = 0; i < newTrades.length; i++) {
      const t = newTrades[i];
      const record = {
        id:          (now + i).toString(36) + Math.random().toString(36).slice(2, 6),
        alertKey:    `IMPORT:${t.symbol}:${now + i}`,
        symbol:      t.symbol,
        timeframe:   '5m',
        setupType:   'imported',
        direction:   t.direction,
        mode:        'take',
        takenAt:     t.openTime.toISOString(),
        actualEntry: t.actualEntry,
        actualSL:    null, actualTP: null,
        actualExit:  t.exits.length > 0 ? t.exits[t.exits.length - 1].price : null,
        contracts:   t.contracts,
        dca:         t.dca,
        sentiment:   t.direction,
        outcome:     t.outcome,
        pnl:         t.pnl,
        entries:     t.entries,
        exits:       t.exits,
        remainingContracts: t.remainingContracts,
        importedOrderIds:   t.importedOrderIds,
        source:      'csv_import',
        notes:       '',
        accountId:   accountId   || null,
        accountLabel: accountLabel || null,
        accountType: accountType || null,
      };
      tradeLog.push(record);
    }
    if (newTrades.length > 0) saveTradeLog(tradeLog);
    res.json({ created: newTrades.length, duplicates: dupeIds.size, total: pairedTrades.length });
  } catch (err) {
    console.error('[import-csv]', err);
    res.status(500).json({ error: err.message });
  }
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

// GET /api/pine-script?symbol=MNQ
// Returns a ready-to-paste Pine Script with current QQQ options levels baked in.
// Paste directly into TradingView Pine Editor → Add to chart.
app.get('/api/pine-script', async (req, res) => {
  try {
    const { symbol = 'MNQ' } = req.query;
    const options = await getOptionsData(symbol, null);
    if (!options) return res.status(503).send('// Options data unavailable — try again shortly\n');

    // Compute DD Band levels for this symbol (baked into Pine Script as constants)
    let ddBandsForPine = null;
    try {
      const pineCandles = getCandles(symbol, '15m');
      ddBandsForPine = computeDDBands(pineCandles, symbol, settings.spanMargin || {});
    } catch (_) {}

    const d  = options;
    const dl = d.scaledDaily || {};
    const lz = d.scaledLiquidityZones     || [];
    const hp = d.scaledHedgePressureZones || [];
    const pv = d.scaledPivotCandidates    || [];
    const PROXY_MAP   = { MNQ: 'QQQ', MES: 'SPY', MGC: 'GLD', MCL: 'USO', SIL: 'SLV' };
    const proxyTicker = PROXY_MAP[symbol] || 'QQQ';

    const n  = v => v != null ? String(Math.round(v)) : 'na';
    const nf = v => v != null ? v.toFixed(2) : 'na';
    const f  = v => v != null ? v.toFixed(4) : 'na';
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const db = ddBandsForPine;

    // Zone bias → Pine color/label (baked at generation time)
    const LZ_COLOR = { call: 'color.blue', put: 'color.teal', balanced: 'color.yellow' };
    const LZ_LABEL = { call: 'call', put: 'put', balanced: 'bal' };
    const HP_COLOR = p => p === 'support' ? 'color.green' : 'color.red';

    // Build individual float var declarations for zones (no arrays needed)
    let lzVarDecls = '';
    for (let i = 0; i < 5; i++) {
      const z = lz[i];
      lzVarDecls += z
        ? `float lz${i}_lo = ${n(z.low)}  // ${z.bias}\nfloat lz${i}_hi = ${n(z.high)}\n`
        : `float lz${i}_lo = na\nfloat lz${i}_hi = na\n`;
    }
    let hpVarDecls = '';
    for (let i = 0; i < 3; i++) {
      const z = hp[i];
      hpVarDecls += `float hp${i} = ${z ? n(z.strike) : 'na'}  // ${z ? z.pressure : 'n/a'}\n`;
    }
    let pvVarDecls = '';
    for (let i = 0; i < 3; i++) {
      pvVarDecls += `float pv${i} = ${pv[i] ? n(pv[i].strike) : 'na'}\n`;
    }

    // plot() + fill() lines for liquidity zones (historical bars)
    let lzPlotLines = '';
    for (let i = 0; i < 5; i++) {
      const z  = lz[i];
      const c  = LZ_COLOR[z?.bias] || 'color.yellow';
      const lb = LZ_LABEL[z?.bias] || '';
      lzPlotLines +=
        `p_lz${i}_lo = plot(show_lz and not na(lz${i}_lo) and lz${i}_lo != 0 ? lz${i}_lo : na, "LZ${i+1}${lb?' '+lb:''} lo", color=color.new(${c}, 70), linewidth=1)\n` +
        `p_lz${i}_hi = plot(show_lz and not na(lz${i}_hi) and lz${i}_hi != 0 ? lz${i}_hi : na, "LZ${i+1}${lb?' '+lb:''} hi", color=color.new(${c}, 70), linewidth=1)\n` +
        `fill(p_lz${i}_lo, p_lz${i}_hi, color=color.new(${c}, 88), title="LZ${i+1} zone")\n`;
    }

    // plot() lines for hedge pressure (color baked by direction)
    let hpPlotLines = '';
    for (let i = 0; i < 3; i++) {
      const z = hp[i];
      const c = HP_COLOR(z?.pressure);
      const a = 20 + i * 15;
      hpPlotLines += `plot(show_hp and not na(hp${i}) and hp${i} != 0 ? hp${i} : na, "HP${i+1}${z?' '+z.pressure:''}", color=color.new(${c}, ${a}), linewidth=${i===0?2:1}, style=plot.style_linebr)\n`;
    }

    // plot() lines for pivot candidates
    let pvPlotLines = '';
    for (let i = 0; i < 3; i++) {
      pvPlotLines += `plot(show_pv and not na(pv${i}) and pv${i} != 0 ? pv${i} : na, "Pivot ${i+1}", color=color.new(color.orange, ${35+i*15}), linewidth=1, style=plot.style_linebr)\n`;
    }

    // barstate.islast: extend lines right + add labels
    // Uses line.all/label.all/box.all wipe at start of every islast run — definitively prevents accumulation
    const fixedExtLines = [
      // [varName, show_flag, linecolor, linewidth, linestyle, label, textcolor, size]
      [`oi1`,       `show_oi`,      `color.new(color.orange, 20)`,  2, `line.style_dashed`,  `"OI Wall 1 " + str.tostring(oi1, "#")`,       `color.orange`,  `size.small`],
      [`oi2`,       `show_oi`,      `color.new(color.orange, 45)`,  1, `line.style_dashed`,  `"OI Wall 2 " + str.tostring(oi2, "#")`,       `color.orange`,  `size.tiny`],
      [`oi3`,       `show_oi`,      `color.new(color.orange, 60)`,  1, `line.style_dashed`,  `"OI Wall 3 " + str.tostring(oi3, "#")`,       `color.new(color.orange, 20)`, `size.tiny`],
      [`max_pain`,  `show_maxpain`, `color.new(color.fuchsia, 20)`, 1, `line.style_dotted`,  `"Max Pain " + str.tostring(max_pain, "#")`,   `color.fuchsia`, `size.small`],
      [`gex_flip`,  `show_gexflip`, `color.new(color.aqua, 15)`,    2, `line.style_dashed`,  `"GEX Flip " + str.tostring(gex_flip, "#")`,   `color.aqua`,    `size.small`],
      [`call_wall`, `show_walls`,   `color.new(color.teal, 30)`,    1, `line.style_dotted`,  `"Call Wall " + str.tostring(call_wall, "#")`, `color.teal`,    `size.small`],
      [`put_wall`,  `show_walls`,   `color.new(color.red, 30)`,     1, `line.style_dotted`,  `"Put Wall " + str.tostring(put_wall, "#")`,   `color.red`,     `size.small`],
      [`qqq_pdo`,   `show_daily`,   `color.new(color.purple, 25)`,  1, `line.style_dotted`,  `"${proxyTicker} PDO " + str.tostring(qqq_pdo, "#")`,     `color.purple`,  `size.tiny`],
      [`qqq_pdc`,   `show_daily`,   `color.new(color.yellow, 20)`,  1, `line.style_dotted`,  `"${proxyTicker} PDC " + str.tostring(qqq_pdc, "#")`,     `color.yellow`,  `size.tiny`],
      [`qqq_do`,    `show_daily`,   `color.new(color.silver, 30)`,  1, `line.style_dotted`,  `"${proxyTicker} DO " + str.tostring(qqq_do, "#")`,       `color.silver`,  `size.tiny`],
    ];

    // label.style_label_left: pin on left side of box, box extends right — standard right-edge label
    // Semi-opaque dark background (70% transparency = 30% visible) makes text readable on any chart theme

    let extFixed = fixedExtLines.map(([v, flag, lc, lw, ls, lbl, tc, sz]) =>
      `    if ${flag} and ${v} != 0 and not na(${v})\n` +
      `        line.new(bar_index, ${v}, bar_index + 1, ${v}, extend=extend.right, color=${lc}, width=${lw}, style=${ls})\n` +
      `        label.new(bar_index + 2, ${v}, ${lbl}, style=label.style_label_left, color=color.new(color.black, 70), textcolor=${tc}, size=${sz || 'size.small'})`
    ).join('\n');

    let extLz = '';
    for (let i = 0; i < 5; i++) {
      const z = lz[i]; if (!z) continue;
      const c  = LZ_COLOR[z.bias] || 'color.yellow';
      const lb = `LZ ${LZ_LABEL[z.bias] || ''}`;
      const mid = Math.round((z.low + z.high) / 2);
      extLz +=
        `    if show_lz and not na(lz${i}_lo) and lz${i}_lo != 0\n` +
        `        box.new(bar_index, lz${i}_hi, bar_index + 1, lz${i}_lo, extend=extend.right, bgcolor=color.new(${c}, 88), border_color=color.new(${c}, 55), border_width=1)\n` +
        `        label.new(bar_index + 2, (lz${i}_lo + lz${i}_hi) / 2, "${lb} ${mid}", style=label.style_label_left, color=color.new(color.black, 70), textcolor=${c}, size=size.small)\n`;
    }

    let extHp = '';
    for (let i = 0; i < 3; i++) {
      const z = hp[i]; if (!z) continue;
      const c  = HP_COLOR(z.pressure);
      const a  = 20 + i * 15;
      const lw = i === 0 ? 2 : 1;
      const hpTag = z.pressure === 'support' ? 'HP Sup' : 'HP Res';
      extHp +=
        `    if show_hp and not na(hp${i}) and hp${i} != 0\n` +
        `        line.new(bar_index, hp${i}, bar_index + 1, hp${i}, extend=extend.right, color=color.new(${c}, ${a}), width=${lw}, style=line.style_dashed)\n` +
        `        label.new(bar_index + 2, hp${i}, "${hpTag} " + str.tostring(hp${i}, "#"), style=label.style_label_left, color=color.new(color.black, 70), textcolor=${c}, size=size.small)\n`;
    }

    let extPv = '';
    for (let i = 0; i < 3; i++) {
      const z = pv[i]; if (!z) continue;
      const a = 35 + i * 15;
      extPv +=
        `    if show_pv and not na(pv${i}) and pv${i} != 0\n` +
        `        line.new(bar_index, pv${i}, bar_index + 1, pv${i}, extend=extend.right, color=color.new(color.orange, ${a}), width=1, style=line.style_dotted)\n` +
        `        label.new(bar_index + 2, pv${i}, "Pivot " + str.tostring(pv${i}, "#"), style=label.style_label_left, color=color.new(color.black, 70), textcolor=color.orange, size=size.small)\n`;
    }

    const pine = `//@version=6
// ──────────────────────────────────────────────────────────────────────────────
// FuturesEdge AI — ${proxyTicker} Options Levels
// Generated: ${ts}
// Symbol:    ${symbol}  |  Source: ${proxyTicker} (via CBOE delayed quotes)
// Paste into TradingView Pine Editor on ${symbol === 'MNQ' ? 'NQ1! or MNQ1!' : symbol === 'MES' ? 'ES1! or MES1!' : symbol}
// Refresh: re-run /api/pine-script on your FuturesEdge server and repaste.
// Levels are drawn as plot() series — they integrate with the chart price scale.
// ──────────────────────────────────────────────────────────────────────────────
indicator("FuturesEdge ${proxyTicker} Levels", overlay=true)

// ── Groups ─────────────────────────────────────────────────────────────────────
var g1 = "Options Levels"
var g2 = "Liquidity Zones"
var g3 = "Hedge Pressure"
var g4 = "Pivot Candidates"
var g5 = "${proxyTicker} Daily Levels"
var g6 = "Info Table"
var g7 = "DD Band / CME SPAN"

show_oi      = input.bool(true,  "OI Walls",         group=g1)
show_maxpain = input.bool(true,  "Max Pain",          group=g1)
show_gexflip = input.bool(true,  "GEX Flip",          group=g1)
show_walls   = input.bool(true,  "Call / Put Walls",  group=g1)
show_lz      = input.bool(true,  "Liquidity Zones",   group=g2)
show_hp      = input.bool(true,  "Hedge Pressure",    group=g3)
show_pv      = input.bool(true,  "Pivot Candidates",  group=g4)
show_daily   = input.bool(true,  "${proxyTicker} Daily Levels",  group=g5)
show_table   = input.bool(true,  "Show Info Table",   group=g6)
show_dd      = input.bool(true,  "DD Band / SPAN",    group=g7)
tbl_pos      = input.string("top_right", "Table position", options=["top_right","top_left","bottom_right","bottom_left"], group=g6)

// ── Baked-in levels (regenerate via /api/pine-script) ─────────────────────────
float oi1       = ${n(d.scaledOiWalls?.[0])}
float oi2       = ${n(d.scaledOiWalls?.[1])}
float oi3       = ${n(d.scaledOiWalls?.[2])}
float max_pain  = ${n(d.scaledMaxPain)}
float gex_flip  = ${n(d.scaledGexFlip)}
float call_wall = ${n(d.scaledCallWall)}
float put_wall  = ${n(d.scaledPutWall)}
float qqq_pdo   = ${n(dl.prevDayOpen)}
float qqq_pdc   = ${n(dl.prevDayClose)}
float qqq_do    = ${n(dl.curDayOpen)}

// === DD Band / CME SPAN levels (regenerate daily via /api/pine-script) ===
float dd_prior_close = ${db ? nf(db.priorClose) : 'na'}
float dd_upper       = ${db ? nf(db.ddBandUpper) : 'na'}
float dd_lower       = ${db ? nf(db.ddBandLower) : 'na'}
float span_upper     = ${db ? nf(db.spanUpper) : 'na'}
float span_lower     = ${db ? nf(db.spanLower) : 'na'}

// Metrics
float  pc_ratio   = ${f(d.pcRatio)}
float  atm_iv_pct = ${d.atmIV != null ? (d.atmIV * 100).toFixed(2) : '0.00'}
int    dex_score  = ${d.dexScore ?? 0}
string dex_bias   = "${d.dexBias ?? 'neutral'}"
int    resilience = ${d.resilience ?? 50}
string res_label  = "${d.resilienceLabel ?? 'neutral'}"

// Zone levels (individual vars — no arrays)
${lzVarDecls}
${hpVarDecls}
${pvVarDecls}
// ── Plots — integrated with chart price scale & data window ────────────────────
// OI Walls
plot(show_oi and oi1 != 0 ? oi1 : na, "OI Wall 1", color=color.new(color.orange, 20), linewidth=2, style=plot.style_linebr)
plot(show_oi and oi2 != 0 ? oi2 : na, "OI Wall 2", color=color.new(color.orange, 45), linewidth=1, style=plot.style_linebr)
plot(show_oi and oi3 != 0 ? oi3 : na, "OI Wall 3", color=color.new(color.orange, 60), linewidth=1, style=plot.style_linebr)

// Key options levels
plot(show_maxpain and max_pain != 0 ? max_pain : na, "Max Pain",  color=color.new(color.fuchsia, 20), linewidth=1, style=plot.style_linebr)
plot(show_gexflip and gex_flip != 0 ? gex_flip : na, "GEX Flip", color=color.new(color.aqua,    15), linewidth=2, style=plot.style_linebr)
plot(show_walls and call_wall != 0 ? call_wall : na, "Call Wall", color=color.new(color.teal,    30), linewidth=1, style=plot.style_linebr)
plot(show_walls and put_wall  != 0 ? put_wall  : na, "Put Wall",  color=color.new(color.red,     30), linewidth=1, style=plot.style_linebr)

// ${proxyTicker} daily reference levels
plot(show_daily and qqq_pdo != 0 ? qqq_pdo : na, "${proxyTicker} Prev Day Open",  color=color.new(color.purple, 25), linewidth=1, style=plot.style_linebr)
plot(show_daily and qqq_pdc != 0 ? qqq_pdc : na, "${proxyTicker} Prev Day Close", color=color.new(color.yellow, 20), linewidth=1, style=plot.style_linebr)
plot(show_daily and qqq_do  != 0 ? qqq_do  : na, "${proxyTicker} Day Open",       color=color.new(color.silver, 30), linewidth=1, style=plot.style_linebr)

// DD Band / CME SPAN levels
plot(show_dd and dd_upper != 0 and not na(dd_upper)         ? dd_upper       : na, "DD Band Upper", color=color.new(color.orange, 15), linewidth=1, style=plot.style_line)
plot(show_dd and dd_lower != 0 and not na(dd_lower)         ? dd_lower       : na, "DD Band Lower", color=color.new(color.orange, 15), linewidth=1, style=plot.style_line)
plot(show_dd and span_upper != 0 and not na(span_upper)     ? span_upper     : na, "SPAN Upper",    color=color.new(color.orange, 55), linewidth=1, style=plot.style_stepline_diamond)
plot(show_dd and span_lower != 0 and not na(span_lower)     ? span_lower     : na, "SPAN Lower",    color=color.new(color.orange, 55), linewidth=1, style=plot.style_stepline_diamond)
plot(show_dd and dd_prior_close != 0 and not na(dd_prior_close) ? dd_prior_close : na, "DD Prior Close", color=color.new(color.gray, 60), linewidth=1, style=plot.style_circles)

// Liquidity zones — filled horizontal bands (plot + fill)
${lzPlotLines}
// Hedge pressure lines
${hpPlotLines}
// Pivot candidates
${pvPlotLines}
// ── Extend lines right + labels (last bar only) ────────────────────────────────
// Wipe all dynamic objects first — prevents accumulation across ticks and bar transitions
if barstate.islast
    for _l in line.all
        line.delete(_l)
    for _lb in label.all
        label.delete(_lb)
    for _bx in box.all
        box.delete(_bx)
${extFixed}
${extLz}
${extHp}
${extPv}
// ── Info Table ─────────────────────────────────────────────────────────────────
if barstate.islast and show_table
    tpos = tbl_pos == "top_right"    ? position.top_right    :
           tbl_pos == "top_left"     ? position.top_left     :
           tbl_pos == "bottom_right" ? position.bottom_right : position.bottom_left
    var tbl = table.new(tpos, 2, 8, bgcolor=color.new(color.black, 70), border_color=color.new(color.gray, 60), border_width=1, frame_color=color.new(color.gray, 50), frame_width=1)
    hdr     = color.new(color.gray, 50)
    def_txt = color.new(color.white, 10)

    table.cell(tbl, 0, 0, "FuturesEdge ${proxyTicker}", bgcolor=color.new(color.blue, 60), text_color=color.white, text_size=size.small, tooltip="Generated ${ts}")
    table.cell(tbl, 1, 0, "${symbol}", bgcolor=color.new(color.blue, 60), text_color=color.white, text_size=size.small)

    table.cell(tbl, 0, 1, "P/C Ratio", bgcolor=hdr, text_color=def_txt, text_size=size.tiny)
    pc_col = pc_ratio > 1.3 ? color.red : pc_ratio < 0.7 ? color.green : def_txt
    table.cell(tbl, 1, 1, str.tostring(pc_ratio, "#.##") + (pc_ratio > 1.3 ? " ↑Bear" : pc_ratio < 0.7 ? " ↓Bull" : " Neut"), bgcolor=hdr, text_color=pc_col, text_size=size.tiny)

    table.cell(tbl, 0, 2, "ATM IV", bgcolor=hdr, text_color=def_txt, text_size=size.tiny)
    table.cell(tbl, 1, 2, str.tostring(atm_iv_pct, "#.#") + "%", bgcolor=hdr, text_color=def_txt, text_size=size.tiny)

    table.cell(tbl, 0, 3, "DEX", bgcolor=hdr, text_color=def_txt, text_size=size.tiny)
    dex_col = dex_bias == "bullish" ? color.green : dex_bias == "bearish" ? color.red : def_txt
    table.cell(tbl, 1, 3, (dex_score >= 0 ? "+" : "") + str.tostring(dex_score) + " " + dex_bias, bgcolor=hdr, text_color=dex_col, text_size=size.tiny)

    table.cell(tbl, 0, 4, "Resilience", bgcolor=hdr, text_color=def_txt, text_size=size.tiny)
    res_col = resilience >= 65 ? color.green : resilience < 40 ? color.red : color.orange
    table.cell(tbl, 1, 4, str.tostring(resilience) + " " + res_label, bgcolor=hdr, text_color=res_col, text_size=size.tiny)

    table.cell(tbl, 0, 5, "Max Pain", bgcolor=hdr, text_color=def_txt, text_size=size.tiny)
    table.cell(tbl, 1, 5, str.tostring(max_pain, "#"), bgcolor=hdr, text_color=color.fuchsia, text_size=size.tiny)

    table.cell(tbl, 0, 6, "γ Flip", bgcolor=hdr, text_color=def_txt, text_size=size.tiny)
    table.cell(tbl, 1, 6, str.tostring(gex_flip, "#"), bgcolor=hdr, text_color=color.aqua, text_size=size.tiny)

    table.cell(tbl, 0, 7, "Updated", bgcolor=hdr, text_color=color.new(color.gray, 30), text_size=size.tiny)
    table.cell(tbl, 1, 7, "${ts}", bgcolor=hdr, text_color=color.new(color.gray, 30), text_size=size.tiny)
`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="futuresedge_qqq_${symbol.toLowerCase()}_${new Date().toISOString().slice(0,10)}.pine"`);
    res.send(pine);
  } catch (err) {
    console.error('[api] /pine-script error:', err.message);
    res.status(500).send(`// Error generating Pine Script: ${err.message}\n`);
  }
});

// GET /api/options?symbol=MNQ&futuresPrice=21000
// Options chain metrics (OI walls, max pain, P/C ratio, ATM IV).
// MNQ/MES use QQQ/SPY as proxy (better Yahoo Finance options data than NQ=F/ES=F).
// When futuresPrice is provided, returns scaled* fields in futures price space.
app.get('/api/options', async (req, res) => {
  try {
    const { symbol = 'MNQ', futuresPrice } = req.query;
    const fp = futuresPrice ? parseFloat(futuresPrice) : null;
    const options = await getOptionsData(symbol, fp);
    res.json({ symbol, options });
  } catch (err) {
    console.error('[api] /options error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// GET /api/ddbands?symbol=MNQ — current DD Band / SPAN levels for a symbol
app.get('/api/ddbands', (req, res) => {
  const symbol = req.query.symbol || 'MNQ';
  try {
    const candles  = getCandles(symbol, '15m');
    const ddBands  = computeDDBands(candles, symbol, settings.spanMargin || {});
    if (ddBands && candles && candles.length > 0) {
      ddBands.currentPrice = candles[candles.length - 1].close;
    }
    res.json({ symbol, ddBands });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bias?symbol=MNQ — setup readiness + directional bias
const _biasCache   = new Map(); // symbol → { ts, data }
const BIAS_CACHE_TTL = 30 * 1000; // 30 seconds

app.get('/api/bias', (req, res) => {
  const symbol = req.query.symbol || 'MNQ';
  const mode   = req.query.mode === 'manual' ? 'manual' : 'auto';
  const cacheKey = `${symbol}:${mode}`;
  try {
    // Return cached if fresh
    const cached = _biasCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < BIAS_CACHE_TTL) {
      return res.json(cached.data);
    }

    const mktCtx = _lastMarketContext.get(symbol);
    if (!mktCtx) {
      return res.json({ readiness: null, bias: null, status: 'initializing' });
    }

    // Current ET hour
    const etHourStr = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false
    });
    const currentHour = parseInt(etHourStr, 10);

    // Attach calendar near-event flag to context for bias computation
    const ctxWithCal = Object.assign({}, mktCtx, {
      _calendarNearEvent: _lastCalendarNear.get(symbol) || false,
    });

    const readiness = computeSetupReadiness(symbol, ctxWithCal, currentHour, mode);
    const indicators = _lastIndicators.get(symbol) || null;
    const regime = indicators ? require('./analysis/regime').classifyRegime(indicators) : null;
    const indWithRegime = indicators ? Object.assign({}, indicators, { regime }) : null;
    const bias = computeDirectionalBias(symbol, ctxWithCal, indWithRegime);

    const data = { readiness, bias };
    _biasCache.set(cacheKey, { ts: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('[api] /bias error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/datastatus — live feed health (source, lag, WS connected, last bar times, OPRA)
app.get('/api/datastatus', (_req, res) => {
  const liveMode     = settings.features?.liveData  === true;
  const opraEnabled  = settings.features?.liveOpra  === true;
  const opraSt       = opraLive.getOpraStatus();

  const opraStatus = {
    enabled:        opraEnabled,
    connected:      opraSt.connected,
    lastUpdateTime: opraSt.lastUpdateTime,
    strikeCount:    opraSt.strikeCount,
    totalRecords:   opraSt.totalRecords,
  };

  if (!liveMode) {
    return res.json({
      source:      'seed',
      wsConnected: false,
      lagSeconds:  null,
      lastBarTime: null,
      symbols:     [],
      opra:        opraStatus,
    });
  }
  const st = getLiveFeedStatus();
  res.json({
    source:      'live',
    wsConnected: st.connected,
    lagSeconds:  st.lagSeconds,
    lastBarTime: st.lastPollTime,
    lastBarTimes: st.lastBarTimes,
    symbols:     st.symbols,
    opra:        opraStatus,
  });
});

// GET /api/barvalidator/stats — per-symbol bar validation statistics
app.get('/api/barvalidator/stats', (_req, res) => {
  res.json(getValidatorStats());
});

// GET /api/livestats — bar counts, date range, and disk usage for persisted live bars
app.get('/api/livestats', async (_req, res) => {
  try {
    // Only report futures symbols (crypto uses Coinbase, not Databento disk archive)
    const futuresSymbols = SCAN_SYMBOLS.filter(s =>
      !['BTC', 'ETH', 'XRP', 'XLM'].includes(s)
    );
    const stats = await getLiveBarStats(futuresSymbols);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Forward-test API ─────────────────────────────────────────────────────────

// GET /api/forwardtest/summary — aggregate stats from forward-test trades
app.get('/api/forwardtest/summary', (_req, res) => {
  const trades = loadForwardTrades();
  if (!trades.length) {
    return res.json({ totalTrades: 0, message: 'No forward-test trades yet' });
  }

  const won     = trades.filter(t => t.outcome === 'won');
  const lost    = trades.filter(t => t.outcome === 'lost');
  const timeout = trades.filter(t => t.outcome === 'timeout');

  const totalWins  = won.reduce((s, t) => s + (t.netPnl || 0), 0);
  const totalLoss  = lost.reduce((s, t) => s + Math.abs(t.netPnl || 0), 0);
  const timeoutPnl = timeout.reduce((s, t) => s + (t.netPnl || 0), 0);
  const netPnl     = parseFloat((totalWins - totalLoss + timeoutPnl).toFixed(2));

  const winRate      = parseFloat((won.length / trades.length).toFixed(3));
  const profitFactor = totalLoss > 0 ? parseFloat((totalWins / totalLoss).toFixed(2)) : won.length > 0 ? Infinity : 0;
  const avgWin       = won.length  > 0 ? parseFloat((totalWins / won.length).toFixed(2))               : 0;
  const avgLoss      = lost.length > 0 ? parseFloat((totalLoss / lost.length).toFixed(2))              : 0;

  // By symbol
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, won: 0, netPnl: 0 };
    bySymbol[t.symbol].trades++;
    if (t.outcome === 'won') bySymbol[t.symbol].won++;
    bySymbol[t.symbol].netPnl += (t.netPnl || 0);
  }
  for (const sym of Object.keys(bySymbol)) {
    const b = bySymbol[sym];
    b.wr     = b.trades > 0 ? parseFloat((b.won / b.trades).toFixed(3)) : 0;
    b.netPnl = parseFloat(b.netPnl.toFixed(2));
  }

  // By hour (ET entry hour)
  const byHour = {};
  for (const t of trades) {
    const h = t.entryTime ? new Date(t.entryTime).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }) : '?';
    if (!byHour[h]) byHour[h] = { trades: 0, won: 0, netPnl: 0 };
    byHour[h].trades++;
    if (t.outcome === 'won') byHour[h].won++;
    byHour[h].netPnl = parseFloat((byHour[h].netPnl + (t.netPnl || 0)).toFixed(2));
  }

  res.json({
    totalTrades:    trades.length,
    openPositions:  getOpenForwardTestCount(),
    won:            won.length,
    lost:           lost.length,
    timeout:        timeout.length,
    winRate,
    profitFactor,
    netPnl,
    avgWin,
    avgLoss,
    bySymbol,
    byHour,
    recentTrades:   [...trades].reverse().slice(0, 10),
  });
});

// GET /api/forwardtest/trades — full forward-test trade log with optional filters
app.get('/api/forwardtest/trades', (req, res) => {
  let trades = loadForwardTrades();
  if (req.query.symbol)  trades = trades.filter(t => t.symbol === req.query.symbol.toUpperCase());
  if (req.query.outcome) trades = trades.filter(t => t.outcome === req.query.outcome);
  trades = [...trades].reverse(); // newest first
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json({ trades: trades.slice(0, limit) });
});

// GET /api/forwardtest/open — current open positions tracked by simulator
app.get('/api/forwardtest/open', (_req, res) => {
  try {
    const { loadAlertCache } = require('./storage/log');
    const alerts = loadAlertCache();
    const open = alerts
      .filter(a => (a.setup?.outcome === 'open' || a.setup?.outcome == null) && a.setup?.entry)
      .map(a => ({
        alertKey:    a.alertKey || `${a.symbol}-${a.setup?.type}-${a.ts}`,
        symbol:      a.symbol,
        setupType:   a.setup?.type,
        direction:   a.setup?.direction,
        confidence:  a.setup?.confidence,
        entryPrice:  a.setup?.entry,
        sl:          a.setup?.sl,
        tp:          a.setup?.tp,
        entryTime:   a.ts,
        currentPnl:  null,
      }));
    res.json({ positions: open });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forwardtest/export — save AI analysis prompt to data/analysis/
app.post('/api/forwardtest/export', (req, res) => {
  const { prompt, filename } = req.body || {};
  if (!prompt || !filename) return res.status(400).json({ error: 'prompt and filename required' });

  const dir = path.join(__dirname, '..', 'data', 'analysis');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const filePath = path.join(dir, safeName);
  try {
    fs.writeFileSync(filePath, prompt, 'utf8');
    res.json({ saved: true, path: `data/analysis/${safeName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/span — update SPAN margin values without editing JSON manually
// Body: { MNQ: 1400, MES: 700 } — only the keys provided are updated
app.post('/api/settings/span', (req, res) => {
  const updates = req.body || {};
  settings.spanMargin = { ...(settings.spanMargin || {}), ...updates };
  try {
    fs.writeFileSync('./config/settings.json', JSON.stringify(settings, null, 2));
    res.json({ ok: true, spanMargin: settings.spanMargin });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Instrument settings routes ──────────────────────────────────────────────

// GET /api/instruments — returns all instrument metadata (merged with settings.json overrides)
app.get('/api/instruments', (_req, res) => {
  // Merge instruments.js defaults with any settings.json overrides
  const result = {};
  for (const [sym, meta] of Object.entries(_INSTRUMENTS)) {
    result[sym] = {
      tickSize: meta.tickSize,
      tickValue: meta.tickValue,
      pointValue: meta.pointValue,
      feePerRT: meta.feePerRT ?? null,
      category: meta.category,
      dbRoot: meta.dbRoot,
      optionsProxy: meta.optionsProxy ?? null,
      tradeable: meta.tradeable,
    };
  }
  res.json(result);
});

// POST /api/instruments/:symbol — update tick/point/fee values for a single symbol
// Body: { tickSize, tickValue, pointValue, feePerRT }
app.post('/api/instruments/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!_INSTRUMENTS[symbol]) {
    return res.status(404).json({ error: `Unknown symbol: ${symbol}` });
  }

  const { tickSize, tickValue, pointValue, feePerRT } = req.body;
  const updates = {};
  for (const [key, val] of [['tickSize', tickSize], ['tickValue', tickValue], ['pointValue', pointValue], ['feePerRT', feePerRT]]) {
    if (val === undefined) continue;
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: `${key} must be a positive number` });
    }
    updates[key] = n;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  // Update settings.json
  if (!settings.instruments) settings.instruments = {};
  settings.instruments[symbol] = { ...(settings.instruments[symbol] || {}), ...updates };
  try {
    fs.writeFileSync('./config/settings.json', JSON.stringify(settings, null, 2));
    // Reload overrides so INSTRUMENTS reflects the change immediately
    loadSettingsOverrides();
    res.json({ ok: true, symbol, ...settings.instruments[symbol] });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// GET /api/correlation — rolling correlation matrix (tradeable + macro reference symbols)
app.get('/api/correlation', (req, res) => {
  try {
    const allCandles = {};
    for (const sym of [...SCAN_SYMBOLS, 'DXY', 'VIX']) {
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

// GET /api/performance/optimize — richer breakdown for the Optimize tab
// Uses setup_archive.json if non-empty, otherwise falls back to alertCache.
// Cached in-memory for 5 minutes.
let _optCache = null, _optCacheTs = 0;
const OPT_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/performance/optimize', (_req, res) => {
  try {
    if (_optCache && (Date.now() - _optCacheTs) < OPT_CACHE_TTL) {
      return res.json(_optCache);
    }
    let alerts = alertCache;
    try {
      const archived = loadArchive();
      if (Array.isArray(archived) && archived.length > 0) alerts = archived;
    } catch {}
    _optCache   = computeOptimizeStats(alerts);
    _optCacheTs = Date.now();
    res.json(_optCache);
  } catch (err) {
    console.error('[api] /performance/optimize error:', err.message);
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

// POST /api/propfirms/account/:id/advance-phase — snapshot current phase, reset for next
app.post('/api/propfirms/account/:id/advance-phase', (req, res) => {
  const data = _loadPF();
  const acc  = data.accounts.find(a => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: 'Not found' });

  const { phaseName, outcome, notes, newAccountSize, newMaxDrawdown, newDdType } = req.body;
  if (!acc.phaseHistory) acc.phaseHistory = [];

  const totalPnl = (acc.dailyProgress || []).reduce((s, d) => s + (+d.pnl || 0), 0);
  const snapshot = {
    id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    phaseName:    phaseName || `Phase ${acc.phaseHistory.length + 1}`,
    startDate:    acc.phaseStartDate || acc.date || '',
    endDate:      new Date().toISOString().slice(0, 10),
    accountSize:  acc.accountSize,
    maxDrawdown:  acc.maxDrawdown,
    ddType:       acc.ddType || 'static',
    dailyProgress: (acc.dailyProgress || []).slice(),
    finalValue:   acc.currentValue || acc.accountSize,
    totalPnl,
    outcome:      outcome || 'passed',
    notes:        notes || '',
  };
  acc.phaseHistory.push(snapshot);

  // Reset for new phase
  acc.dailyProgress   = [];
  acc.phaseStartDate  = new Date().toISOString().slice(0, 10);
  if (newAccountSize)               acc.accountSize  = +newAccountSize;
  if (newMaxDrawdown !== undefined && newMaxDrawdown !== '') acc.maxDrawdown = +newMaxDrawdown;
  if (newDdType)                    acc.ddType       = newDdType;
  acc.currentValue = acc.accountSize;

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

// ─── LOCAL LLM (OLLAMA) API ──────────────────────────────────────────────────

const { checkOllamaHealth, buildBacktestSystemPrompt, streamOllamaResponse } = require('./ai/ollamaClient');

// GET /api/ai/ollama/status
app.get('/api/ai/ollama/status', async (_req, res) => {
  try {
    const health = await checkOllamaHealth();
    res.json({
      available: health.available,
      models: health.models,
      currentModel: process.env.OLLAMA_MODEL || 'qwen2.5:32b',
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      ...(health.error ? { error: health.error } : {}),
    });
  } catch (e) {
    res.json({ available: false, models: [], error: e.message });
  }
});

// POST /api/backtest/analyze — SSE streaming backtest chat via local LLM
app.post('/api/backtest/analyze', async (req, res) => {
  const { jobId, model, message, history } = req.body || {};

  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const resultsPath = require('path').join(__dirname, '../data/backtest/results', `${jobId}.json`);
  if (!require('fs').existsSync(resultsPath)) {
    return res.status(404).json({ error: `Job ${jobId} not found` });
  }

  const health = await checkOllamaHealth();
  if (!health.available) {
    return res.status(503).json({
      error: 'Ollama is not running. In WSL2 terminal run: sudo systemctl restart ollama',
    });
  }

  let jobResults;
  try {
    jobResults = JSON.parse(require('fs').readFileSync(resultsPath, 'utf8'));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load job results: ' + e.message });
  }

  const tradeCount = (jobResults.trades || []).length;
  const selectedModel = model || process.env.OLLAMA_MODEL || 'qwen2.5:32b';
  console.log(`[ollama-analyze] jobId=${jobId} trades=${tradeCount} model=${selectedModel} msg="${(message || '').substring(0, 80)}"`);

  const systemPrompt = buildBacktestSystemPrompt(jobResults);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  req.on('close', () => {
    console.log('[analyze] client disconnected, request will complete or be garbage collected');
  });

  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  await streamOllamaResponse(
    selectedModel,
    systemPrompt,
    history || [],
    message || '',
    (token) => send({ type: 'token', content: token }),
    ()      => { send({ type: 'done' }); res.end(); },
    (err)   => { send({ type: 'error', message: err }); res.end(); },
  );
});

// ─── BACKTEST API ────────────────────────────────────────────────────────────

const { Worker } = require('worker_threads');

const {
  getJob, getJobResults, listJobs, deleteJob,
  getReplayData, getFullRunReplayData, getAvailableDateRange,
} = require('./backtest/engine');

// In-progress worker jobs (running state — completed jobs live on disk)
const MAX_CONCURRENT_JOBS = 4;
const workerJobs = new Map(); // jobId → { jobId, status, config, startedAt, completedAt, progress, stats, error }

// GET /api/backtest/available — date ranges per symbol
app.get('/api/backtest/available', (_req, res) => {
  try { res.json(getAvailableDateRange()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/backtest/run — start backtest in worker thread, returns jobId immediately
app.post('/api/backtest/run', (req, res) => {
  const config = req.body;
  if (!config || !config.startDate || !config.endDate) {
    return res.status(400).json({ error: 'config.startDate and endDate required' });
  }

  // Reject if at concurrency limit
  const runningCount = [...workerJobs.values()].filter(j => j.status === 'running').length;
  if (runningCount >= MAX_CONCURRENT_JOBS) {
    return res.status(429).json({ error: `Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached — try again shortly` });
  }

  // Fall back to server settings.spanMargin if client didn't send one
  if (!config.spanMargin) config.spanMargin = settings.spanMargin || {};

  const jobId = crypto.randomBytes(6).toString('hex');
  workerJobs.set(jobId, {
    jobId,
    status:      'running',
    config,
    startedAt:   new Date().toISOString(),
    completedAt: null,
    progress:    { phase: 'starting', pct: 0, message: 'Starting...' },
    stats:       null,
    error:       null,
  });

  res.json({ jobId, status: 'running' }); // Return immediately — worker runs in background

  const worker = new Worker(path.join(__dirname, 'backtest', 'worker.js'), {
    workerData: { jobId, config },
    resourceLimits: { maxOldGenerationSizeMb: 4096 },  // Allow 4GB heap for large backtests
  });

  // 2-hour safety net — mark job failed if worker never completes
  const workerTimeout = setTimeout(() => {
    const job = workerJobs.get(jobId);
    if (job && job.status === 'running') {
      job.status = 'error';
      job.error  = 'Worker timed out after 2h — no completion received';
      console.error(`[Worker] Job ${jobId} timed out after 2h`);
    }
  }, 2 * 60 * 60 * 1000);

  worker.on('message', (msg) => {
    const job = workerJobs.get(jobId);
    if (!job) return;
    if (msg.type === 'progress') {
      job.progress = { phase: msg.phase, pct: msg.pct ?? 0, message: msg.message ?? '' };
    } else if (msg.type === 'complete') {
      clearTimeout(workerTimeout);
      job.status      = 'completed';
      job.completedAt = new Date().toISOString();
      job.progress    = { phase: 'done', pct: 100, message: 'Complete' };
      job.stats       = msg.stats;
    } else if (msg.type === 'error') {
      clearTimeout(workerTimeout);
      job.status = 'error';
      job.error  = msg.message;
    }
  });

  worker.on('error', (err) => {
    clearTimeout(workerTimeout);
    const job = workerJobs.get(jobId);
    if (job && job.status === 'running') { job.status = 'error'; job.error = err.message; }
    console.error(`[Worker] Job ${jobId} error: ${err.message}`);
  });

  worker.on('exit', (code) => {
    clearTimeout(workerTimeout);
    const job = workerJobs.get(jobId);
    if (code !== 0) {
      if (job && job.status === 'running') { job.status = 'error'; job.error = `Worker exited with code ${code}`; }
      console.error(`[Worker] Job ${jobId} exited with code ${code}`);
    } else if (job && job.status === 'running') {
      // Worker exited cleanly (code 0) without ever posting 'complete' — treat as error
      job.status = 'error';
      job.error  = 'Worker exited without completing (code 0)';
      console.error(`[Worker] Job ${jobId} exited with code 0 without completing`);
    }
  });
});

// GET /api/backtest/status/:jobId
app.get('/api/backtest/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  // Worker jobs (running or recently finished) take precedence
  if (workerJobs.has(jobId)) {
    const job = workerJobs.get(jobId);
    return res.json({ jobId, status: job.status, progress: job.progress, error: job.error });
  }
  // Fall back to disk-based lookup (engine.js getJob)
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ jobId, status: job.status, progress: job.progress ?? 0, error: job.error });
});

// GET /api/backtest/results/:jobId
app.get('/api/backtest/results/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  // If worker job is still running, results aren't ready yet
  const workerJob = workerJobs.get(jobId);
  if (workerJob && workerJob.status === 'running') {
    return res.status(404).json({ error: 'Results not yet available' });
  }
  const results = getJobResults(jobId);
  if (!results) return res.status(404).json({ error: 'Results not found' });
  res.json(results);
});

// GET /api/backtest/jobs
app.get('/api/backtest/jobs', (_req, res) => {
  try {
    const diskJobs = listJobs();
    const diskJobIds = new Set(diskJobs.map(j => j.jobId));
    // Include running worker jobs that haven't been written to disk yet
    const liveJobs = [...workerJobs.values()]
      .filter(j => j.status === 'running' || !diskJobIds.has(j.jobId))
      .map(j => ({ jobId: j.jobId, status: j.status, config: j.config,
        startedAt: j.startedAt, completedAt: j.completedAt, stats: j.stats }));
    res.json([...liveJobs, ...diskJobs]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/backtest/jobs/:jobId
app.delete('/api/backtest/jobs/:jobId', (req, res) => {
  deleteJob(req.params.jobId);
  res.json({ ok: true });
});

// GET /api/backtest/replay/:jobId/full?symbol=MNQ  — all days for the run
app.get('/api/backtest/replay/:jobId/full', (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const data = getFullRunReplayData(req.params.jobId, symbol);
  if (!data) return res.status(404).json({ error: 'No data found' });
  res.json(data);
});

// GET /api/backtest/replay/:jobId?symbol=MNQ&date=2026-01-15
app.get('/api/backtest/replay/:jobId', (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) return res.status(400).json({ error: 'symbol and date required' });
  const data = getReplayData(req.params.jobId, symbol, date);
  if (!data) return res.status(404).json({ error: 'No replay data found' });
  res.json(data);
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

const SCAN_SYMBOLS    = ['MNQ', 'MGC', 'MES', 'MCL', 'BTC', 'ETH', 'XRP', 'XLM', 'SIL', 'M2K', 'MYM', 'MHG'];
// 1m/2m/3m removed: with 15-min delayed data they are stale by the time they display.
// 5m removed: ~3 candles stale with delayed seed data — not actionable.
// 15m/30m/1h/2h/4h give actionable signals even accounting for the data lag.
const SCAN_TIMEFRAMES = ['15m', '30m', '1h', '2h', '4h'];

/**
 * Run a scan. Returns the count of NEW alerts added to the cache.
 *
 * @param {Object} [opts]
 * @param {string[]} [opts.targetSymbols]   Limit scan to these symbols (default: all SCAN_SYMBOLS)
 * @param {string[]} [opts.targetTimeframes] Limit scan to these timeframes (default: SCAN_TIMEFRAMES)
 */
async function runScan({ targetSymbols = null, targetTimeframes = null } = {}) {
  const scanSymbols    = targetSymbols    || SCAN_SYMBOLS;
  const scanTimeframes = targetTimeframes || SCAN_TIMEFRAMES;
  console.log('[scan] Starting…' + (targetSymbols ? ` [${scanSymbols.join(',')} × ${scanTimeframes.join(',')}]` : ''));
  let newCount = 0;
  const _autotraderPromises = [];

  // Compute correlation matrix once per scan (used by all symbols for scoring)
  // Always use the full symbol set for accuracy even in targeted scans.
  let corrMatrix = null;
  try {
    const corrCandles = {};
    for (const sym of [...SCAN_SYMBOLS, 'DXY', 'VIX']) {
      try { corrCandles[sym] = getCandles(sym, '5m'); } catch { corrCandles[sym] = []; }
    }
    corrMatrix = computeCorrelationMatrix(corrCandles);
  } catch (err) {
    console.warn('[scan] correlation matrix failed:', err.message);
  }

  // Fetch calendar events once per scan (cached in calendar.js for 1h)
  // Economic calendar is always-on — no feature flag needed.
  let calendarCache = {};
  for (const sym of scanSymbols) {
    // Crypto symbols have no relevant ForexFactory calendar events
    if (['BTC', 'ETH', 'XRP', 'XLM'].includes(sym)) { calendarCache[sym] = []; continue; }
    try { calendarCache[sym] = await getCalendarEvents(sym); } catch { calendarCache[sym] = []; }
  }

  // Cache calendar near-event status for bias panel
  const nowSec = Math.floor(Date.now() / 1000);
  for (const sym of scanSymbols) {
    const events = calendarCache[sym] || [];
    const near = events.some(e => e.symbols?.includes(sym) && Math.abs(e.time - nowSec) <= 15 * 60);
    _lastCalendarNear.set(sym, near);
  }

  for (const symbol of scanSymbols) {
    // Pre-compute 5m and 15m regimes for the alignment flag
    const regime5m  = _regimeFor(symbol, '5m');
    const regime15m = _regimeFor(symbol, '15m');
    const alignment = computeAlignment(regime15m, regime5m);
    const calendarEvents = calendarCache[symbol] || [];

    // Build market context once per symbol (options + VIX + DXY)
    // Uses 15m indicators as proxy for current price/ATR
    let marketContext = null;
    try {
      const ind15m = (() => {
        try {
          const c = getCandles(symbol, '15m');
          return computeIndicators(c, { swingLookback: settings.swingLookback,
            impulseThreshold: settings.impulseThreshold, symbol });
        } catch { return null; }
      })();
      const optData = await getOptionsData(symbol);
      marketContext = await buildMarketContext(symbol, ind15m, optData, getCandles, corrMatrix);
      console.log(
        `[marketContext] ${symbol}` +
        ` hp=${marketContext.hp.nearestLevel?.type ?? 'none'}` +
        ` vix=${marketContext.vix.regime}` +
        ` dxy=${marketContext.dxy.direction}`
      );
      // Cache for bias panel
      _lastMarketContext.set(symbol, marketContext);
      if (ind15m) _lastIndicators.set(symbol, ind15m);
    } catch (err) {
      console.warn(`[marketContext] ${symbol} failed: ${err.message}`);
      marketContext = null;
    }

    // ── Collect all setup candidates for this symbol across all TFs ──────────
    const candidates = []; // { tf, setup, regime }

    for (const tf of scanTimeframes) {
      try {
        const candles    = getCandles(symbol, tf);
        const ind        = computeIndicators(candles, {
          swingLookback:    settings.swingLookback,
          impulseThreshold: settings.impulseThreshold,
          symbol,
          spanMargin:       settings.spanMargin || {},
        });
        // Cache ATR for zone-level dedup proximity checks in _cacheAlert
        if (ind.atrCurrent) _lastAtr.set(`${symbol}:${tf}`, ind.atrCurrent);
        const regime     = { ...classifyRegime(ind), alignment };
        const trendlines = detectTrendlines(candles, ind.atrCurrent);
        const setups     = detectSetups(candles, ind, regime, {
          rrRatio: settings.risk.rrRatio || 1.0, symbol, trendlines, calendarEvents,
          correlationMatrix: corrMatrix, marketContext,
          ddBands: ind.ddBands,
        });

        for (const setup of setups) {
          // Multi-TF zone stack: check if the setup's key level has a confirming
          // IOF zone on a higher timeframe. MNQ/MES: +15 pts. MGC/MCL: −15 pts (inverted).
          const stack = checkTFZoneStack(setup, symbol, tf, getCandles, computeIndicators, settings);
          if (stack.bonus > 0) {
            setup.confidence     = Math.min(100, setup.confidence + stack.bonus);
            setup.tfStack        = stack;
            setup.scoreBreakdown = { ...setup.scoreBreakdown, tfStack: stack.bonus };
            setup.rationale     += ` · ${stack.tfs.join('/')} stack`;
          } else if (stack.bonus < 0 && stack.inverted) {
            setup.confidence     = Math.max(0, setup.confidence + stack.bonus);
            setup.tfStack        = stack;
            setup.scoreBreakdown = { ...setup.scoreBreakdown, tfStack: stack.bonus };
            setup.rationale     += ` · HTF contested`;
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
      const slDistance  = Math.abs((setup.entry ?? setup.price) - setup.sl);
      const pointVal    = FILL_POINT_VALUE[symbol] || 1;
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
        // Collect autotrader results to summarize per scan cycle (avoid per-alert log spam)
        _autotraderPromises.push(
          autotrader.onNewAlert(alert, settings, saveTradeLog, tradeLog)
            .then(result => ({ _result: result, _alert: alert }))
            .catch(err => { console.error('[autotrader] Error:', err.message); return null; })
        );

        // ── Auto-commentary on fresh, high-confidence alerts ─────────────
        // Guards: conf >= 75, fresh staleness, 30-min per-symbol cooldown,
        // no high-impact calendar event within 15 minutes.
        if (setup.confidence >= 75 &&
            (setup.staleness === 'fresh' || !setup.staleness)) {
          const lastTs = _lastCommentaryTs.get(symbol) || 0;
          const cooldownOk = (Date.now() - lastTs) >= COMMENTARY_COOLDOWN_MS;

          // Check if a high-impact calendar event is within 15 minutes
          const calEvts = calendarEvents || [];
          const nowMs   = Date.now();
          const nearCalendar = calEvts.some(evt => {
            if (!evt.impact || evt.impact !== 'high') return false;
            const evtMs = new Date(evt.date || evt.time).getTime();
            return Math.abs(evtMs - nowMs) < 15 * 60 * 1000;
          });

          if (cooldownOk && !nearCalendar) {
            _lastCommentaryTs.set(symbol, Date.now());
            // Fire-and-forget — don't block the scan loop
            generateSingle(alert, getCandles).then(commentary => {
              if (commentary) {
                saveAlertCache(alertCache);
                broadcast({ type: 'commentary_update', symbol, timeframe: tf });
                console.log(`[ai] Auto-commentary generated for ${symbol} ${tf} ${setup.type}`);
              }
            }).catch(err => {
              console.error(`[ai] Auto-commentary error ${symbol}: ${err.message}`);
            });
          }
        }
      }
    }
  }

  // Resolve autotrader results and log a single summary per scan cycle
  if (_autotraderPromises.length > 0) {
    const results = await Promise.all(_autotraderPromises);
    let placed = 0, skipped = 0;
    const skipReasons = {};
    for (const r of results) {
      if (!r) continue;
      const { _result: result, _alert: al } = r;
      if (result.placed) {
        placed++;
        console.log(`[autotrader] Order placed: orderId=${result.orderId} — ${al.symbol} ${al.setup.direction}`);
        broadcast({ type: 'order', ...result });
      } else {
        skipped++;
        skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
      }
    }
    if (placed > 0 || skipped > 0) {
      const reasonStr = Object.entries(skipReasons).map(([k, v]) => `${v} ${k}`).join(', ');
      console.log(`[autotrader] Scan complete — ${placed} trades executed` +
        (skipped > 0 ? ` (${skipped} skipped: ${reasonStr})` : ''));
    }
  }

  // Apply staleness decay and prune expired open alerts once per scan cycle
  applyStaleness(alertCache);
  const pruned = pruneExpired(alertCache);
  if (pruned.length !== alertCache.length) {
    // pruneExpired returns a filtered array — splice alertCache in place
    alertCache.splice(0, alertCache.length, ...pruned);
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
// Databento live feed handlers
// ---------------------------------------------------------------------------

/**
 * Called by the Databento live feed for every new 1m bar.
 * Stores the bar, broadcasts a live_candle event for the chart, and fires a
 * targeted scan whenever a higher-TF window (5m / 15m / 30m) completes.
 */
const _lastValidatedBar = {};  // symbol → last validated bar (for continuity check)

async function _onLiveCandle(symbol, candle) {
  // Validate the bar before it enters any pipeline
  const validated = validateBar(symbol, candle, _lastValidatedBar[symbol] || null);
  if (!validated) return; // Bar rejected — skip entirely
  _lastValidatedBar[symbol] = validated;

  // Store 1m bar; get list of completed higher-TF aggregates
  const completed = writeLiveCandle(symbol, validated);

  // Persist the raw 1m bar to disk for future backtests (fire-and-forget)
  writeLiveCandleToDisk(symbol, validated);

  // Broadcast the validated 1m bar so the chart can extend in real time
  broadcast({ type: 'live_candle', symbol, timeframe: '1m', candle: validated });

  // For each completed higher-TF window, broadcast and trigger a targeted scan
  for (const { tf, candle: aggCandle } of completed) {
    broadcast({ type: 'live_candle', symbol, timeframe: tf, candle: aggCandle });
    try {
      await runScan({ targetSymbols: [symbol], targetTimeframes: [tf] });
    } catch (err) {
      console.error(`[live] Scan error ${symbol} ${tf}: ${err.message}`);
    }
  }

  // Check open alert outcomes against this live 1m bar
  try {
    const resolved = await checkLiveOutcomes(symbol, validated);
    if (resolved.length > 0) {
      // Sync in-memory alertCache with the resolved outcomes
      for (const r of resolved) {
        const [sym, tf, type, timeStr] = r.key.split(':');
        const cached = alertCache.find(a =>
          a.symbol === sym && a.timeframe === tf &&
          a.setup?.type === type && String(a.setup?.time) === timeStr
        );
        if (cached) {
          cached.setup.outcome     = r.outcome;
          cached.setup.exitPrice   = r.exitPrice;
          cached.setup.outcomeTime = r.outcomeTime;
          cached.setup.resolvedAt  = Date.now();
        }
      }
      broadcast({ type: 'outcome_update', resolved: resolved.map(r => r.key) });
    }
  } catch (err) {
    console.error(`[live] checkLiveOutcomes error ${symbol}: ${err.message}`);
  }
}

/**
 * Start the Databento live feed for all 8 CME futures symbols.
 * Called at startup when features.liveData === true.
 */
function _startDatabento() {
  const liveSymbols = ['MNQ', 'MES', 'MGC', 'MCL', 'SIL', 'M2K', 'MYM', 'MHG'];
  startLiveFeed(
    liveSymbols,
    (symbol, candle) => {
      _onLiveCandle(symbol, candle).catch(err =>
        console.error(`[live] onCandle error ${symbol}: ${err.message}`)
      );
    },
    (symbol, price, time) => {
      broadcast({ type: 'live_price', symbol, price, time });
    },
    () => {
      // Reconnect callback: immediately fill 1m gaps for all live symbols
      console.log('[live] Feed reconnected — triggering immediate 1m gap fill');
      gapFill.triggerImmediateGapFill(liveSymbols, '1m').catch(err =>
        console.error('[live] Reconnect gap fill failed:', err.message)
      );
    }
  );
  console.log('[startup] Databento live feed started for', liveSymbols.join(', '));

  // Log per-symbol data source status
  const LIVE_SET = new Set(liveSymbols);
  for (const sym of SCAN_SYMBOLS) {
    if (LIVE_SET.has(sym)) {
      console.log(`[startup]   ${sym}: LIVE FEED`);
    } else {
      console.log(`[startup]   ${sym}: SEED DATA (no live feed)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-refresh (seed mode) — fetches fresh Yahoo Finance data every 15 min,
// evicts open-outcome alerts so they get re-evaluated against new candles,
// then re-runs the scan and broadcasts data_refresh to connected clients.
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
  // Collect last candle time per symbol so clients can show accurate data-age
  const lastCandleTime = {};
  for (const sym of ['MNQ', 'MGC', 'MES', 'MCL', 'BTC', 'ETH', 'XRP']) {
    try {
      const c = getCandles(sym, '5m');
      if (c && c.length) lastCandleTime[sym] = c[c.length - 1].time;
    } catch (_) {}
  }
  broadcast({ type: 'data_refresh', ts: lastRefreshTs, newAlerts: newCount, nextRefresh: nextRefreshTs, lastCandleTime });
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

  server.listen(PORT, async () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);

    // Load persisted push subscriptions
    pushManager.loadSubscriptions();

    if (DATA_SOURCE === 'seed') {
      // Log seed data file ages — warn if any 5m file is older than 7 days
      const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
      const nowMs    = Date.now();
      let   seedStale = false;
      for (const sym of SCAN_SYMBOLS) {
        const seedFile = path.join(SEED_DIR, `${sym}_5m.json`);
        try {
          const stat    = fs.statSync(seedFile);
          const ageDays = (nowMs - stat.mtimeMs) / (1000 * 60 * 60 * 24);
          const ageStr  = ageDays < 1 ? `${Math.round(ageDays * 24)}h` : `${ageDays.toFixed(1)}d`;
          console.log(`[startup] Seed data: ${sym} 5m last updated ${ageStr} ago`);
          if (ageDays > 7) seedStale = true;
        } catch (_) {
          console.warn(`[startup] Seed data: ${sym} 5m not found`);
          seedStale = true;
        }
      }
      if (seedStale) {
        console.warn('[startup] WARNING: Seed data is stale — run node server/data/seedFetch.js');
      }

      // Check for symbols with neither seed candles nor live feed
      const liveEnabled = settings.features?.liveData === true;
      for (const sym of SCAN_SYMBOLS) {
        const hasSeed = fs.existsSync(path.join(SEED_DIR, `${sym}_5m.json`));
        const hasLive = liveEnabled && ['MNQ','MES','MGC','MCL','SIL','M2K','MYM','MHG'].includes(sym);
        if (!hasSeed && !hasLive) {
          console.warn(`[startup] WARNING: ${sym} has NO seed data and NO live feed — chart will be empty`);
        }
      }

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

      // Gap fill: backfill missing candle bars from historical files before live feed starts.
      // AWAITED so data is fully loaded before the live feed connects.
      const gapFillTFs = ['1m', '5m', '15m', '30m'];
      try {
        await gapFill.runGapFillAll(SCAN_SYMBOLS, gapFillTFs);
        console.log('[startup] Gap fill from historical files complete');
      } catch (err) {
        console.error('[startup] Gap fill failed (non-fatal):', err.message);
      }

      // Yahoo Finance 60-day backfill: bridges the gap between historical pipeline end
      // (~last Databento download) and the current time. Uses 1m intraday data.
      try {
        await gapFill.runBackfillAll();
        console.log('[startup] Yahoo Finance 60-day backfill complete');
      } catch (err) {
        console.error('[startup] Yahoo backfill failed (non-fatal):', err.message);
      }

      // Start gap fill scheduler (periodic maintenance after initial fill)
      gapFill.startGapFillScheduler(SCAN_SYMBOLS, gapFillTFs);

      // Start Databento live feed if liveData feature is enabled.
      // Futures symbols (MNQ/MES/MGC/MCL) will be served from liveCandles in real time;
      // crypto/SIL still use seed data refreshed by the interval above.
      if (settings.features?.liveData === true) {
        _startDatabento();
      } else {
        console.log('[startup] Databento live feed disabled (features.liveData=false) — seed mode');
      }

      // Databento API key readiness check
      if (process.env.DATABENTO_API_KEY) {
        console.log('[startup] Databento API key: configured \u2713 (enable with POST /api/features {liveData:true})');
      } else {
        console.log('[startup] Databento API key: NOT SET — add to .env to enable live feed');
      }

      // OPRA live feed — check available schemas then start if feature enabled
      opraLive.checkOpraSchemas().then(() => {
        if (settings.features?.liveOpra === true) {
          opraLive.startOpraFeed();
          console.log('[startup] OPRA live feed started (features.liveOpra=true)');
        } else {
          console.log('[startup] OPRA live feed disabled (features.liveOpra=false) — using CBOE delayed quotes');
        }
      }).catch(() => {
        // checkOpraSchemas is non-fatal; still start the feed if flag is set
        if (settings.features?.liveOpra === true) opraLive.startOpraFeed();
      });

    // Real-time crypto prices — Coinbase Exchange WebSocket (free, no auth)
    coinbaseWS.start();
    coinbaseWS.on('price', ({ symbol, price, time }) => {
      broadcast({ type: 'live_price', symbol, price, time });
    });
    console.log('[startup] Coinbase WebSocket starting for BTC/ETH/XRP live prices');
    }

    // Data source summary — printed once after all init so it's easy to spot in logs
    const liveMode = settings.features?.liveData === true;
    console.log('\u2501'.repeat(60));
    console.log('[startup] DATA SOURCE SUMMARY');
    console.log(`[startup] Market data:    ${liveMode ? 'LIVE (Databento 1m feed)' : 'SEED (Yahoo Finance snapshots)'}`);
    const opraLiveMode = settings.features?.liveOpra === true;
    console.log(`[startup] Options data:   ${opraLiveMode ? 'LIVE (Databento OPRA TCP + Yahoo Finance)' : 'LIVE (CBOE delayed + Yahoo Finance)'}`);
    console.log('[startup] Crypto prices:  LIVE (Coinbase WebSocket)');
    console.log('[startup] VIX proxy:      HISTORICAL (data/seed/VIX_5m.json)');
    console.log('[startup] DXY proxy:      HISTORICAL (data/seed/DXY_5m.json)');
    console.log('[startup] Calendar:       LIVE (ForexFactory)');
    console.log('[startup] Backtest data:  HISTORICAL (Databento pipeline)');
    console.log(`[startup] Live feed:      ${liveMode ? 'ENABLED (Databento)' : 'DISABLED (set features.liveData=true)'}`);
    console.log('\u2501'.repeat(60));
  });
}

start().catch(err => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});

module.exports = { app, server, wss, broadcast };
