'use strict';
/**
 * dataQuality.js — Data quality detection layer (v14.30).
 *
 * Detects four classes of bad data in near-real-time:
 *   1. Price spikes / unrealistic wicks (surfaced from barValidator + _sanitizeCandles)
 *   2. Gaps / missing bars (intra-session gap > 2× TF interval)
 *   3. Stale / frozen bars (no new bar in > 2× TF interval during market hours)
 *   4. OHLC broker-mismatch (cross-check against Yahoo Finance secondary source)
 *
 * Surfaces status per symbol per TF (ok / warning / bad).
 * Auto-triggers refresh when status goes to 'bad'.
 * Broadcasts WS events on status transitions via onStatusChange callback.
 */

const https = require('https');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIVE_FUTURES = ['MNQ', 'MES', 'MGC', 'MCL', 'SIL', 'M2K', 'MYM', 'MHG'];
const SCAN_TFS = ['1m', '5m', '15m', '30m'];
const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800 };

// Symbols to skip Yahoo cross-validation for (bonds, FX, CME Bitcoin, crypto)
const SKIP_YAHOO_SYMBOLS = new Set([
  'ZT', 'ZF', 'ZN', 'ZB', 'UB',          // bonds
  'M6E', 'M6B',                            // FX
  'MBT',                                   // CME Bitcoin
  'BTC', 'ETH', 'XRP', 'XLM',             // crypto (different feed)
]);

// Yahoo Finance ticker mapping for CME symbols
const YAHOO_TICKER = {
  MNQ: 'NQ=F', MES: 'ES=F', M2K: 'RTY=F', MYM: 'YM=F',
  MGC: 'GC=F', MCL: 'CL=F', SIL: 'SI=F', MHG: 'HG=F',
};

// Cross-validation close divergence thresholds
const YAHOO_THRESHOLD = {
  MNQ: 0.003, MES: 0.003, M2K: 0.003, MYM: 0.003,   // 0.3% for equity
  MGC: 0.005, MCL: 0.005, SIL: 0.005, MHG: 0.005,    // 0.5% for commodities
};

// Status thresholds
const ISSUE_WINDOW_MS = 15 * 60 * 1000;       // 15 minutes
const STALE_BAD_THRESHOLD_MS = 5 * 60 * 1000; // 5 min stale → bad during market hours
const AUTO_REFRESH_DEBOUNCE_MS = 5 * 60 * 1000;  // 5-min debounce
const AUTO_REFRESH_BACKOFF_MS = 30 * 60 * 1000;  // 30-min backoff after ineffective refresh

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Per-symbol per-TF quality state
// Key: `${symbol}:${tf}`, Value: state object
const _state = new Map();

// Status change subscribers
const _statusChangeCallbacks = [];

// Reference to the refresh function (set by index.js via setRefreshFn)
let _refreshFn = null;

// Reference to getCandles (set by init to avoid circular require)
let _getCandlesFn = null;

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function _getState(symbol, tf) {
  const key = `${symbol}:${tf}`;
  if (!_state.has(key)) {
    _state.set(key, {
      symbol,
      tf,
      status: 'ok',
      issues: [],
      suspiciousBarCount: 0,
      lastCheck: null,
      lastAutoRefresh: null,
      autoRefreshBackoffUntil: null,
    });
  }
  return _state.get(key);
}

function _addIssue(symbol, tf, issue) {
  const state = _getState(symbol, tf);
  state.issues.push(issue);
  // Keep last 50 issues max
  if (state.issues.length > 50) state.issues.splice(0, state.issues.length - 50);
  _evaluateStatus(symbol, tf);
}

// ---------------------------------------------------------------------------
// Status evaluation
// ---------------------------------------------------------------------------

function _evaluateStatus(symbol, tf) {
  const state = _getState(symbol, tf);
  const now = Date.now();
  const cutoff = now - ISSUE_WINDOW_MS;

  // Count recent issues (within 15 min)
  const recentIssues = state.issues.filter(i => i.detectedAt.getTime() > cutoff);

  // Check stale: any stale issue in the recent window that's > 5 min
  const staleIssue = recentIssues.find(
    i => i.type === 'stale' && i.details?.staleDurationMs > STALE_BAD_THRESHOLD_MS
  );

  // Check broker mismatch
  const brokerMismatch = recentIssues.find(i => i.type === 'broker_mismatch');

  let newStatus;
  if (recentIssues.length >= 2 || state.suspiciousBarCount >= 3 || staleIssue || brokerMismatch) {
    newStatus = 'bad';
  } else if (recentIssues.length === 1 || (state.suspiciousBarCount >= 1 && state.suspiciousBarCount <= 2)) {
    newStatus = 'warning';
  } else {
    newStatus = 'ok';
  }

  state.lastCheck = new Date();

  if (newStatus !== state.status) {
    const oldStatus = state.status;
    state.status = newStatus;
    console.log(`[DQ] Status: ${symbol} ${tf} ${oldStatus} → ${newStatus}`);
    _notifyStatusChange(symbol, tf, oldStatus, newStatus, recentIssues);
  }
}

function _notifyStatusChange(symbol, tf, oldStatus, newStatus, issues) {
  for (const cb of _statusChangeCallbacks) {
    try {
      cb(symbol, tf, oldStatus, newStatus, issues);
    } catch (err) {
      console.error('[DQ] Status change callback error:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: record suspicious bar
// ---------------------------------------------------------------------------

/**
 * Called by snapshot.js/barValidator.js when clamping/rejecting occurs.
 * @param {string} symbol
 * @param {string} tf
 * @param {{ type: string, ts: number, details: Object }} info
 */
// Track recently seen suspicious bar timestamps to avoid duplicate counting
// from _sanitizeCandles being called multiple times on the same data
const _seenSuspiciousBars = new Map(); // `${symbol}:${tf}:${ts}` → Date.now()

function recordSuspiciousBar(symbol, tf, { type, ts, details }) {
  if (!LIVE_FUTURES.includes(symbol)) return;

  // Deduplicate: don't count the same bar timestamp twice within 60 seconds
  const dedupKey = `${symbol}:${tf}:${ts}`;
  const lastSeen = _seenSuspiciousBars.get(dedupKey);
  if (lastSeen && (Date.now() - lastSeen) < 60_000) return;
  _seenSuspiciousBars.set(dedupKey, Date.now());
  // Clean up old dedup entries (keep map small)
  if (_seenSuspiciousBars.size > 500) {
    const cutoff = Date.now() - 120_000;
    for (const [k, v] of _seenSuspiciousBars) {
      if (v < cutoff) _seenSuspiciousBars.delete(k);
    }
  }

  const state = _getState(symbol, tf);
  state.suspiciousBarCount++;

  // Decay suspicious bar count every 5 minutes
  setTimeout(() => {
    if (state.suspiciousBarCount > 0) state.suspiciousBarCount--;
    _evaluateStatus(symbol, tf);
  }, 5 * 60 * 1000);

  const issue = {
    type,
    detectedAt: new Date(),
    details: { ts, ...details },
  };
  _addIssue(symbol, tf, issue);

  // Log based on type
  if (type === 'spike') {
    const orig = details?.original;
    const clamped = details?.clamped;
    if (orig != null && clamped != null) {
      console.log(`[DQ] Spike detected: ${symbol} ${tf} @ ${new Date(ts * 1000).toISOString()} clamped ${orig}→${clamped}`);
    } else {
      console.log(`[DQ] Spike detected: ${symbol} ${tf} @ ${new Date(ts * 1000).toISOString()} rule=${details?.rule || 'unknown'}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check: stale bars
// ---------------------------------------------------------------------------

/**
 * Check if a symbol/TF has stale data (no new bar within 2× TF interval during market hours).
 * @param {string} symbol
 * @param {string} tf
 * @param {number} lastBarTime  Unix timestamp (seconds) of the most recent bar
 * @returns {{ type: string, detectedAt: Date, details: Object }|null}
 */
function checkStale(symbol, tf, lastBarTime) {
  if (!lastBarTime || !_isMarketHours()) return null;

  const tfSec = TF_SECONDS[tf] || 60;
  const now = Math.floor(Date.now() / 1000);
  const gap = now - lastBarTime;
  const threshold = tfSec * 2;

  if (gap > threshold) {
    const staleDurationMs = gap * 1000;
    const issue = {
      type: 'stale',
      detectedAt: new Date(),
      details: {
        lastBarTime,
        staleDurationMs,
        gapSeconds: gap,
        threshold,
      },
    };
    console.log(`[DQ] Stale: ${symbol} ${tf} last bar ${Math.round(gap / 60)} min ago`);
    return issue;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check: gaps
// ---------------------------------------------------------------------------

/**
 * Check for gaps in the last 10 bars (intra-session gap > 2× TF interval).
 * @param {string} symbol
 * @param {string} tf
 * @param {Array} bars  Recent bars array (sorted ascending)
 * @returns {{ type: string, detectedAt: Date, details: Object }|null}
 */
function checkGap(symbol, tf, bars) {
  if (!bars || bars.length < 2 || !_isMarketHours()) return null;

  const tfSec = TF_SECONDS[tf] || 60;
  const threshold = tfSec * 2;
  const recentBars = bars.slice(-10);

  for (let i = 1; i < recentBars.length; i++) {
    const gap = recentBars[i].time - recentBars[i - 1].time;
    if (gap > threshold) {
      // Check if gap spans the maintenance window (17:00-18:00 ET) — if so, skip
      if (_gapSpansMaintenanceWindow(recentBars[i - 1].time, recentBars[i].time)) continue;

      const start = new Date(recentBars[i - 1].time * 1000).toISOString().slice(11, 16);
      const end = new Date(recentBars[i].time * 1000).toISOString().slice(11, 16);
      console.log(`[DQ] Gap detected: ${symbol} ${tf} missing bars ${start}–${end}`);
      return {
        type: 'gap',
        detectedAt: new Date(),
        details: {
          gapStart: recentBars[i - 1].time,
          gapEnd: recentBars[i].time,
          gapSeconds: gap,
          threshold,
        },
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check: Yahoo cross-validation
// ---------------------------------------------------------------------------

/**
 * Cross-check last 15 1m bars against Yahoo Finance for a symbol.
 * Only runs during RTH (13:30–21:00 UTC Mon–Fri).
 * @param {string} symbol
 * @returns {Promise<{ type: string, detectedAt: Date, details: Object }|null>}
 */
async function crossValidateYahoo(symbol) {
  if (SKIP_YAHOO_SYMBOLS.has(symbol)) return null;
  if (!_isRTH()) return null;

  const ticker = YAHOO_TICKER[symbol];
  if (!ticker) return null;

  try {
    const yahooBars = await _fetchYahoo1m(ticker, 15);
    if (!yahooBars || yahooBars.length < 3) return null;

    // Get our stored bars
    if (!_getCandlesFn) return null;
    let ourBars;
    try { ourBars = _getCandlesFn(symbol, '1m'); } catch { return null; }
    if (!ourBars || ourBars.length < 3) return null;

    // Compare closes: build a time-keyed map of our bars
    const ourMap = new Map();
    for (const bar of ourBars.slice(-30)) {
      ourMap.set(bar.time, bar.close);
    }

    const threshold = YAHOO_THRESHOLD[symbol] || 0.005;
    let consecutiveDiverge = 0;
    let maxDiverge = 0;
    const divergentBars = [];

    for (const yBar of yahooBars) {
      const ourClose = ourMap.get(yBar.time);
      if (ourClose == null) continue;

      const divergence = Math.abs(ourClose - yBar.close) / yBar.close;
      if (divergence > threshold) {
        consecutiveDiverge++;
        maxDiverge = Math.max(maxDiverge, divergence);
        divergentBars.push({ time: yBar.time, ours: ourClose, yahoo: yBar.close, pct: divergence });
      } else {
        consecutiveDiverge = 0;
      }

      // Flag only if >= 3 consecutive bars differ
      if (consecutiveDiverge >= 3) {
        console.log(`[DQ] Broker mismatch: ${symbol} 1m ${divergentBars.length} bars diverge from Yahoo by > ${(threshold * 100).toFixed(1)}%`);
        return {
          type: 'broker_mismatch',
          detectedAt: new Date(),
          details: {
            divergentBars: divergentBars.slice(-5),
            maxDivergence: maxDiverge,
            threshold,
          },
        };
      }
    }

    return null;
  } catch (err) {
    console.warn(`[DQ] Yahoo cross-validation failed for ${symbol}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status getters
// ---------------------------------------------------------------------------

function getStatus(symbol, tf) {
  if (tf) {
    return _getState(symbol, tf);
  }
  // Return all TFs for this symbol
  const result = {};
  for (const t of SCAN_TFS) {
    const key = `${symbol}:${t}`;
    if (_state.has(key)) {
      result[t] = _state.get(key);
    }
  }
  return result;
}

function getAllStatus() {
  const result = {};
  for (const sym of LIVE_FUTURES) {
    result[sym] = {};
    for (const tf of SCAN_TFS) {
      const key = `${sym}:${tf}`;
      if (_state.has(key)) {
        const s = _state.get(key);
        result[sym][tf] = {
          status: s.status,
          issues: s.issues.slice(-5),  // last 5 issues only for API response
          suspiciousBarCount: s.suspiciousBarCount,
          lastCheck: s.lastCheck,
          lastAutoRefresh: s.lastAutoRefresh,
        };
      } else {
        result[sym][tf] = { status: 'ok', issues: [], suspiciousBarCount: 0, lastCheck: null, lastAutoRefresh: null };
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Auto-refresh trigger
// ---------------------------------------------------------------------------

/**
 * Trigger a data refresh for a symbol when status goes to 'bad'.
 * Debounce: skip if last auto-refresh < 5 min ago or within backoff window.
 * After refresh, re-evaluate status; if still bad, set 30-min backoff.
 * @param {string} symbol
 */
async function triggerAutoRefresh(symbol) {
  if (!_refreshFn) {
    console.warn('[DQ] Auto-refresh not wired — no refresh function set');
    return;
  }

  // Check debounce across all TFs for this symbol
  const now = Date.now();
  for (const tf of SCAN_TFS) {
    const state = _getState(symbol, tf);
    if (state.lastAutoRefresh && (now - state.lastAutoRefresh.getTime()) < AUTO_REFRESH_DEBOUNCE_MS) {
      console.log(`[DQ] Auto-refresh skipped: ${symbol} (debounce, last refresh ${Math.round((now - state.lastAutoRefresh.getTime()) / 1000)}s ago)`);
      return;
    }
    if (state.autoRefreshBackoffUntil && now < state.autoRefreshBackoffUntil.getTime()) {
      console.log(`[DQ] Auto-refresh skipped: ${symbol} (backoff until ${state.autoRefreshBackoffUntil.toISOString()})`);
      return;
    }
  }

  console.log(`[DQ] Auto-refresh triggered: ${symbol} (reason: status bad)`);

  // Mark refresh time on all TFs
  const refreshTime = new Date();
  for (const tf of SCAN_TFS) {
    _getState(symbol, tf).lastAutoRefresh = refreshTime;
  }

  try {
    await _refreshFn(symbol);

    // Re-evaluate after refresh — check if status is still bad
    let stillBad = false;
    for (const tf of SCAN_TFS) {
      const state = _getState(symbol, tf);
      _evaluateStatus(symbol, tf);
      if (state.status === 'bad') stillBad = true;
    }

    if (stillBad) {
      console.log(`[DQ] Auto-refresh ineffective: ${symbol} still bad, 30-min backoff set`);
      const backoffUntil = new Date(Date.now() + AUTO_REFRESH_BACKOFF_MS);
      for (const tf of SCAN_TFS) {
        _getState(symbol, tf).autoRefreshBackoffUntil = backoffUntil;
      }
    } else {
      console.log(`[DQ] Auto-refresh complete: ${symbol} status bad → ok`);
    }
  } catch (err) {
    console.error(`[DQ] Auto-refresh failed for ${symbol}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let _staleInterval = null;
let _gapInterval = null;
let _yahooInterval = null;

function startScheduler() {
  console.log('[DQ] Scheduler started');

  // Initialize state for all symbols/TFs
  for (const sym of LIVE_FUTURES) {
    for (const tf of SCAN_TFS) {
      _getState(sym, tf);
    }
  }

  // Stale check: every 60s
  _staleInterval = setInterval(() => {
    if (!_isMarketHours()) return;
    if (!_getCandlesFn) return;

    for (const sym of LIVE_FUTURES) {
      for (const tf of SCAN_TFS) {
        try {
          const bars = _getCandlesFn(sym, tf);
          if (!bars || bars.length === 0) continue;
          const lastBar = bars[bars.length - 1];
          const issue = checkStale(sym, tf, lastBar.time);
          if (issue) _addIssue(sym, tf, issue);
        } catch {}
      }
    }
  }, 60_000);

  // Gap check: every 60s
  _gapInterval = setInterval(() => {
    if (!_isMarketHours()) return;
    if (!_getCandlesFn) return;

    for (const sym of LIVE_FUTURES) {
      for (const tf of SCAN_TFS) {
        try {
          const bars = _getCandlesFn(sym, tf);
          if (!bars || bars.length < 2) continue;
          const issue = checkGap(sym, tf, bars);
          if (issue) _addIssue(sym, tf, issue);
        } catch {}
      }
    }
  }, 60_000);

  // Yahoo cross-validation: every 5 min during RTH only
  _yahooInterval = setInterval(async () => {
    if (!_isRTH()) return;

    for (const sym of LIVE_FUTURES) {
      if (SKIP_YAHOO_SYMBOLS.has(sym)) continue;
      try {
        const issue = await crossValidateYahoo(sym);
        if (issue) _addIssue(sym, '1m', issue);
      } catch {}
    }
  }, 5 * 60 * 1000);
}

function stopScheduler() {
  if (_staleInterval) { clearInterval(_staleInterval); _staleInterval = null; }
  if (_gapInterval) { clearInterval(_gapInterval); _gapInterval = null; }
  if (_yahooInterval) { clearInterval(_yahooInterval); _yahooInterval = null; }
}

// ---------------------------------------------------------------------------
// Subscriber
// ---------------------------------------------------------------------------

function onStatusChange(callback) {
  _statusChangeCallbacks.push(callback);
}

// ---------------------------------------------------------------------------
// Wiring helpers (called from index.js to avoid circular requires)
// ---------------------------------------------------------------------------

function setRefreshFn(fn) {
  _refreshFn = fn;
}

function setGetCandlesFn(fn) {
  _getCandlesFn = fn;
}

// ---------------------------------------------------------------------------
// Market hours helpers
// ---------------------------------------------------------------------------

/**
 * CME Globex hours: Sun 18:00 ET → Fri 17:00 ET, with daily 17:00–18:00 ET break.
 * Returns true if current time is within trading hours.
 */
function _isMarketHours() {
  const now = new Date();
  const et = _toET(now);
  const day = et.getDay();  // 0=Sun, 6=Sat
  const hour = et.getHours();
  const min = et.getMinutes();
  const timeInMin = hour * 60 + min;

  // Saturday: closed all day
  if (day === 6) return false;

  // Sunday: open only from 18:00 ET onward
  if (day === 0) return hour >= 18;

  // Friday: open until 17:00 ET
  if (day === 5) return hour < 17;

  // Mon–Thu: 17:00–18:00 ET daily maintenance break
  if (timeInMin >= 17 * 60 && timeInMin < 18 * 60) return false;

  return true;
}

/**
 * RTH = Regular Trading Hours, 09:30–16:00 ET Mon–Fri.
 * For Yahoo cross-validation we use a wider window: 13:30–21:00 UTC (≈ 09:30–17:00 ET).
 */
function _isRTH() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const utcTime = utcHour * 60 + utcMin;
  const day = now.getUTCDay();

  // Mon–Fri only
  if (day === 0 || day === 6) return false;

  // 13:30–21:00 UTC
  return utcTime >= 13 * 60 + 30 && utcTime < 21 * 60;
}

/**
 * Check if a gap between two timestamps spans the daily maintenance window (17:00–18:00 ET).
 */
function _gapSpansMaintenanceWindow(startTs, endTs) {
  const startET = _toET(new Date(startTs * 1000));
  const endET = _toET(new Date(endTs * 1000));

  const startMin = startET.getHours() * 60 + startET.getMinutes();
  const endMin = endET.getHours() * 60 + endET.getMinutes();

  // If the gap crosses the 17:00–18:00 ET window
  const maintStart = 17 * 60;
  const maintEnd = 18 * 60;

  // Simple check: start is before 17:00 and end is after 18:00 (or within the window)
  if (startMin <= maintStart && endMin >= maintStart) return true;
  // Both within the maintenance window
  if (startMin >= maintStart && startMin < maintEnd) return true;

  return false;
}

/**
 * Convert a Date to Eastern Time (DST-aware).
 */
function _toET(date) {
  // Use Intl to get ET offset
  const etStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(etStr);
}

// ---------------------------------------------------------------------------
// Yahoo Finance helper
// ---------------------------------------------------------------------------

function _fetchYahoo1m(ticker, count) {
  return new Promise((resolve, reject) => {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - 3600; // last 1 hour
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&period1=${period1}&period2=${period2}`;

    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json?.chart?.result?.[0];
          if (!result) return resolve(null);

          const timestamps = result.timestamp || [];
          const quotes = result.indicators?.quote?.[0] || {};
          const closes = quotes.close || [];

          const bars = [];
          for (let i = 0; i < timestamps.length && bars.length < count; i++) {
            if (closes[i] != null && isFinite(closes[i])) {
              bars.push({
                time: timestamps[i],
                close: closes[i],
              });
            }
          }
          resolve(bars.slice(-count));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  recordSuspiciousBar,
  checkStale,
  checkGap,
  crossValidateYahoo,
  getStatus,
  getAllStatus,
  triggerAutoRefresh,
  startScheduler,
  stopScheduler,
  onStatusChange,
  setRefreshFn,
  setGetCandlesFn,
};
