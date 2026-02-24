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
const { saveAlertCache, loadAlertCache, saveCommentaryCache, loadCommentaryCache } = require('./storage/log');
const settings              = require('../config/settings.json');

const PORT        = process.env.PORT        || 3000;
const DATA_SOURCE = process.env.DATA_SOURCE || 'seed';

// ---------------------------------------------------------------------------
// Alert cache — in-memory; survives until server restart
// ---------------------------------------------------------------------------

const alertCache = [];            // newest-first ordered alert objects
const alertSeenKeys = new Set();  // dedup: symbol:tf:type:time

const MAX_ALERTS = 100;

// ── Commentary cache ──────────────────────────────────────────────────────────
// Holds the last successful AI commentary run.
// { generated: ISO string, items: [{ symbol, timeframe, setupTime, commentary, alert }] }
let commentaryCache = { generated: null, items: [] };

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
}

function _cacheAlert(alert) {
  const key = `${alert.symbol}:${alert.timeframe}:${alert.setup.type}:${alert.setup.time}`;
  if (alertSeenKeys.has(key)) return false;
  alertSeenKeys.add(key);
  alertCache.unshift(alert);
  if (alertCache.length > MAX_ALERTS) alertCache.pop();
  return true; // was new
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', dataSource: DATA_SOURCE, ts: new Date().toISOString() });
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
    });
    const trendlines = detectTrendlines(candles, indicators.atrCurrent);

    // Filter IOF to active zones only (keeps payload small)
    const fvgs        = (indicators.fvgs || []).filter(f => f.status === 'open').slice(-6);
    const orderBlocks = (indicators.orderBlocks || []).filter(o => o.status !== 'mitigated').slice(-4);

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
  const { rrRatio } = req.body;
  let needRescan = false;

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

// GET /api/alerts?limit=20&minConfidence=0
// minConfidence is applied BEFORE the one-trade filter so WR stats are accurate.
app.get('/api/alerts', (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit) || 50, MAX_ALERTS);
  const minConf = parseInt(req.query.minConfidence) || 0;

  const qualifying = minConf > 0
    ? alertCache.filter(a => a.setup.confidence >= minConf)
    : alertCache;

  const filtered = _applyTradeFilter(qualifying);
  // Sort: unsuppressed first, then by confidence desc
  filtered.sort((a, b) => {
    if (a.suppressed !== b.suppressed) return a.suppressed ? 1 : -1;
    return b.setup.confidence - a.setup.confidence;
  });
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
    const commentary = await generateSingle(alert, getCandles);
    if (!commentary) return res.status(503).json({ error: 'could not generate commentary' });
    // generateSingle attaches commentary to alert.commentary — persist the update
    saveAlertCache(alertCache);
    res.json({ commentary });
  } catch (err) {
    console.error('[api] /commentary/single error:', err.message);
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

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
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
// Scan engine — detects setups across all symbol / timeframe combinations.
// In live mode this would be called on every candle close event.
// In seed mode it runs once at startup and is re-runnable via GET /api/scan.
// ---------------------------------------------------------------------------

const SCAN_SYMBOLS    = ['MNQ', 'MGC'];
const SCAN_TIMEFRAMES = ['1m', '2m', '3m', '5m', '15m'];

/**
 * Run a full scan. Returns the count of NEW alerts added to the cache.
 */
async function runScan() {
  console.log('[scan] Starting…');
  let newCount = 0;

  for (const symbol of SCAN_SYMBOLS) {
    // Pre-compute 5m and 15m regimes for the alignment flag
    const regime5m  = _regimeFor(symbol, '5m');
    const regime15m = _regimeFor(symbol, '15m');
    const alignment = computeAlignment(regime15m, regime5m);

    for (const tf of SCAN_TIMEFRAMES) {
      try {
        const candles = getCandles(symbol, tf);
        const ind     = computeIndicators(candles, {
          swingLookback:    settings.swingLookback,
          impulseThreshold: settings.impulseThreshold,
        });
        const regime  = { ...classifyRegime(ind), alignment };
        const setups  = detectSetups(candles, ind, regime, { rrRatio: settings.risk.rrRatio || 1.0, symbol });

        for (const setup of setups) {
          // Multi-TF zone stack: check if the setup's key level has a confirming
          // IOF zone on a higher timeframe. Adds up to +20 confidence + badge.
          const stack = checkTFZoneStack(setup, symbol, tf, getCandles, computeIndicators, settings);
          if (stack.bonus > 0) {
            setup.confidence    = Math.min(100, setup.confidence + stack.bonus);
            setup.tfStack       = stack;
            setup.scoreBreakdown = { ...setup.scoreBreakdown, tfStack: stack.bonus };
            setup.rationale    += ` · ${stack.tfs.join('/')} stack`;
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
          }
        }
      } catch (err) {
        console.error(`[scan] ${symbol} ${tf} error: ${err.message}`);
      }
    }
  }

  console.log(`[scan] Done — ${newCount} new alerts  (${alertCache.length} cached total)`);

  // Persist alert cache immediately after scan
  saveAlertCache(alertCache);

  // ── Generate AI commentary for the top N unsuppressed alerts ─────────────
  // Run async after scan completes so the scan response isn't blocked.
  _refreshCommentary().catch(err => console.error('[ai] Commentary error:', err.message));

  return newCount;
}

/**
 * Pick the top COMMENTARY_TOP_N unsuppressed alerts by confidence,
 * call Claude, update the cache, and broadcast to connected clients.
 */
async function _refreshCommentary() {
  // Apply trade filter to get suppressed flags, then take top N unsuppressed
  const filtered = _applyTradeFilter(alertCache);
  const top = filtered
    .filter(a => !a.suppressed)
    .sort((a, b) => b.setup.confidence - a.setup.confidence)
    .slice(0, COMMENTARY_TOP_N);

  if (top.length === 0) return;

  const items = await generateCommentary(top, getCandles, settings);
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
    });
    return classifyRegime(ind);
  } catch {
    return null;
  }
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
    }
  });
}

start().catch(err => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});

module.exports = { app, server, wss, broadcast };
