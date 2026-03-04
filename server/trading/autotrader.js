'use strict';

/**
 * server/trading/autotrader.js
 * Kill-switch state machine for automated paper trading via the built-in simulator.
 *
 * State is session-scoped (in-memory only) — the kill switch is ALWAYS
 * off when the server starts. It must be explicitly enabled via the UI
 * or POST /api/autotrader/toggle.
 *
 * Safety gates enforced before every order:
 *   1. Kill switch must be enabled
 *   2. Alert must not be suppressed
 *   3. Alert confidence >= minConfidence (separate, higher bar)
 *   4. No open simulator position already exists for that symbol
 *   5. Both sl and tp must be present on the alert setup
 */

const simulator = require('./simulator');

// ---------------------------------------------------------------------------
// Session state — never persisted
// ---------------------------------------------------------------------------

const state = {
  enabled:       false,   // Kill switch — OFF by default, always
  minConfidence: 75,      // Execution confidence floor (higher than display filter)
  lastOrder:     null,    // Last successfully placed order metadata
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function enable()    { state.enabled = true; }
function disable()   { state.enabled = false; }
function isEnabled() { return state.enabled; }

function setMinConfidence(val) {
  const n = parseInt(val);
  if (!isNaN(n) && n >= 50 && n <= 99) state.minConfidence = n;
}

/**
 * Return current autotrader status + live simulated position snapshot.
 * Synchronous — no broker calls needed.
 */
function getStatus() {
  return {
    enabled:       state.enabled,
    minConfidence: state.minConfidence,
    lastOrder:     state.lastOrder,
    authError:     null,              // always null for the simulator
    positions:     simulator.getOpenPositions(),
    summary:       simulator.getSummary(),
  };
}

/**
 * Called by the scan engine whenever a genuinely new alert is cached.
 * Applies all safety gates, then opens a virtual position if everything passes.
 *
 * @param {object} alert    Alert object from the cache (see Alert schema in CLAUDE.md)
 * @param {object} settings settings.json (needs settings.risk for contract qty)
 * @param {function} saveTradeLog  Injected to avoid circular require
 * @param {Array}  tradeLog        Live tradeLog array reference
 * @returns {{ placed: boolean, reason?: string, orderId?: number }}
 */
async function onNewAlert(alert, settings, saveTradeLog, tradeLog) {
  // ── Gate 1: Kill switch ──────────────────────────────────────────────────
  if (!state.enabled) return { placed: false, reason: 'disabled' };

  // ── Gate 2: Suppressed by trade filter ──────────────────────────────────
  if (alert.suppressed) return { placed: false, reason: 'suppressed' };

  // ── Gate 3: Confidence floor ─────────────────────────────────────────────
  if ((alert.setup.confidence ?? 0) < state.minConfidence) {
    return { placed: false, reason: `low-conf (${alert.setup.confidence} < ${state.minConfidence})` };
  }

  // ── Gate 4: SL + TP required ─────────────────────────────────────────────
  const { sl, tp, direction } = alert.setup;
  if (sl == null || tp == null) {
    return { placed: false, reason: 'missing-sl-tp' };
  }

  // ── Gate 5: No existing open position for this symbol ───────────────────
  const openPositions = simulator.getOpenPositions();
  const alreadyOpen   = openPositions.some(p => p.symbol === alert.symbol);
  if (alreadyOpen) {
    return { placed: false, reason: 'position-exists' };
  }

  // ── Determine entry price and quantity ───────────────────────────────────
  const entryPrice = alert.setup.entry ?? alert.setup.price;
  if (entryPrice == null) return { placed: false, reason: 'missing-entry-price' };

  const risk = settings?.risk || {};
  const qty  = alert.symbol === 'MNQ' ? (risk.mnqContracts ?? 1)
             : alert.symbol === 'MGC' ? (risk.mgcContracts ?? 1)
             : alert.symbol === 'MES' ? (risk.mesContracts ?? 1)
             : alert.symbol === 'MCL' ? (risk.mclContracts ?? 1)
             : 1;

  // ── Open the virtual position ────────────────────────────────────────────
  const alertKey = `${alert.symbol}:${alert.timeframe}:${alert.setup.type}:${alert.setup.time}`;
  const result   = simulator.placeOrder({
    symbol:     alert.symbol,
    direction,
    qty,
    entryPrice,
    sl,
    tp,
    alertKey,
    setupTime:  alert.setup.time,   // Unix seconds — fill only on subsequent candles
  });

  // ── Record the order in state and trade log ──────────────────────────────
  state.lastOrder = {
    alertKey,
    orderId:   result.orderId,
    symbol:    alert.symbol,
    direction,
    qty,
    entryPrice,
    sl,
    tp,
    ts:        result.timestamp,
  };

  // Mirror to the trade log so the "Taken Trades" section picks it up
  if (typeof saveTradeLog === 'function' && Array.isArray(tradeLog)) {
    const trade = {
      id:          Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      alertKey,
      symbol:      alert.symbol,
      timeframe:   alert.timeframe,
      setupType:   alert.setup.type,
      takenAt:     result.timestamp,
      actualEntry: entryPrice,
      actualSL:    sl,
      actualTP:    tp,
      actualExit:  null,
      notes:       `Auto-sim · orderId=${result.orderId}`,
      simOrderId:  result.orderId,
    };
    const idx = tradeLog.findIndex(t => t.alertKey === alertKey);
    if (idx >= 0) tradeLog[idx] = trade;
    else tradeLog.push(trade);
    saveTradeLog(tradeLog);
  }

  return {
    placed:    true,
    orderId:   result.orderId,
    alertKey,
    symbol:    alert.symbol,
    direction,
    qty,
    entryPrice,
    sl,
    tp,
  };
}

// ---------------------------------------------------------------------------

module.exports = {
  enable,
  disable,
  isEnabled,
  setMinConfidence,
  getStatus,
  onNewAlert,
  state,
};
