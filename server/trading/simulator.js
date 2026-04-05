'use strict';

/**
 * server/trading/simulator.js
 * Built-in paper trading simulator — no broker required.
 *
 * Stores virtual positions in memory. On every data refresh, checkFills()
 * scans fresh candles to see if SL or TP was hit, then records realized P&L.
 *
 * Dollar-per-point specs (per exchange):
 *   MNQ: $2.00 / point / contract  (tick=$0.50, size=0.25)
 *   MGC: $10.00 / point / contract (tick=$1.00, size=0.10)
 */

const DOLLAR_PER_POINT = { MNQ: 2.0, MGC: 10.0 };

// ---------------------------------------------------------------------------
// In-memory position store (session-scoped; not persisted)
// ---------------------------------------------------------------------------

const positions = [];   // all virtual positions: open + closed
let   _nextId   = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _pnl(pos, closePrice) {
  const dpp       = DOLLAR_PER_POINT[pos.symbol] ?? 1;
  const direction = pos.direction === 'bullish' ? 1 : -1;
  return parseFloat(((closePrice - pos.entryPrice) * direction * pos.qty * dpp).toFixed(2));
}

function _close(pos, closePrice, reason) {
  pos.status     = reason;          // 'hit_tp' | 'hit_sl'
  pos.closedAt   = new Date().toISOString();
  pos.closePrice = closePrice;
  pos.pnl        = _pnl(pos, closePrice);
  console.log(
    `[sim] ${pos.symbol} ${pos.direction} ×${pos.qty} → ${reason} @ ${closePrice}` +
    `  P&L: ${pos.pnl >= 0 ? '+' : ''}$${pos.pnl}`
  );
  return pos;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a virtual paper trade.
 * Returns an order-like object: { orderId, timestamp }.
 */
function placeOrder({ symbol, direction, qty, entryPrice, sl, tp, alertKey, setupTime }) {
  const id = _nextId++;
  const pos = {
    id,
    alertKey,
    symbol,
    direction,
    qty,
    entryPrice,
    sl,
    tp,
    setupTime: setupTime ?? 0,   // Unix seconds — only check candles after this time
    openedAt:  new Date().toISOString(),
    status:    'open',
    closedAt:  null,
    closePrice: null,
    pnl:        null,
  };
  positions.push(pos);
  console.log(
    `[sim] Virtual order #${id} — ${direction} ${qty}x ${symbol}` +
    ` @ ${entryPrice}  SL=${sl}  TP=${tp}`
  );
  return { orderId: id, timestamp: pos.openedAt };
}

/**
 * Check all open positions for `symbol` against the provided candles.
 * Only candles with time > pos.setupTime are tested (avoids filling on the
 * setup candle itself).
 *
 * Returns an array of positions that were just closed (for the caller to
 * update the trade log and broadcast).
 */
function checkFills(symbol, candles) {
  const open    = positions.filter(p => p.symbol === symbol && p.status === 'open');
  const filled  = [];

  for (const pos of open) {
    const relevant = candles.filter(c => c.time > pos.setupTime);
    for (const candle of relevant) {
      if (pos.direction === 'bullish') {
        if (candle.low <= pos.sl) {
          filled.push(_close(pos, pos.sl, 'hit_sl'));
          break;
        }
        if (candle.high >= pos.tp) {
          filled.push(_close(pos, pos.tp, 'hit_tp'));
          break;
        }
      } else {
        // bearish
        if (candle.high >= pos.sl) {
          filled.push(_close(pos, pos.sl, 'hit_sl'));
          break;
        }
        if (candle.low <= pos.tp) {
          filled.push(_close(pos, pos.tp, 'hit_tp'));
          break;
        }
      }
    }
  }

  return filled;
}

/**
 * Return open positions in a shape compatible with the autotrader status UI.
 * Each entry has: { symbol, netPos, avgPrice, pnl }
 */
function getOpenPositions() {
  return positions
    .filter(p => p.status === 'open')
    .map(p => ({
      symbol:   p.symbol,
      netPos:   p.direction === 'bullish' ? p.qty : -p.qty,
      avgPrice: p.entryPrice,
      pnl:      null,   // unrealized P&L not tracked between refreshes
    }));
}

/**
 * Return a summary of all simulated trades.
 */
function getSummary() {
  const closed    = positions.filter(p => p.status !== 'open');
  const won       = closed.filter(p => p.status === 'hit_tp').length;
  const lost      = closed.filter(p => p.status === 'hit_sl').length;
  const openCount = positions.filter(p => p.status === 'open').length;
  const totalPnl  = parseFloat(closed.reduce((sum, p) => sum + (p.pnl ?? 0), 0).toFixed(2));
  const wr        = closed.length > 0 ? Math.round((won / closed.length) * 100) : null;

  return {
    trades:   closed.length,
    won,
    lost,
    open:     openCount,
    totalPnl,
    winRate:  wr,
  };
}

/** Return all positions (open + closed), newest first. */
function getAllPositions() {
  return [...positions].reverse();
}

/** Reset all positions (useful for testing). */
function reset() {
  positions.length = 0;
  _nextId = 1;
  console.log('[sim] Positions reset');
}

// ---------------------------------------------------------------------------
// Forward-test outcome tracking
// ---------------------------------------------------------------------------

/**
 * Check all open alerts in the alert cache against a live 1m candle.
 * Resolves any that hit their SL or TP and persists the outcome immediately.
 *
 * SL is checked before TP — if both levels are hit on the same bar
 * (gap/spike), the SL wins (conservative, correct for live tracking).
 *
 * @param {string} symbol    - e.g. 'MNQ'
 * @param {Object} candle1m  - { time, open, high, low, close, volume }
 * @returns {string[]} Array of resolved alert keys (symbol:tf:type:time)
 */
async function checkLiveOutcomes(symbol, candle1m) {
  const { loadAlertCache, updateAlertOutcome } = require('../storage/log');
  const resolved = [];

  let alerts;
  try {
    alerts = loadAlertCache();
  } catch (err) {
    console.error('[Simulator] checkLiveOutcomes: could not load alert cache:', err.message);
    return resolved;
  }

  const openAlerts = alerts.filter(a =>
    a.symbol === symbol &&
    (a.setup?.outcome === 'open' || a.setup?.outcome == null) &&
    !a.setup?.userOverride
  );

  for (const alert of openAlerts) {
    const { entry, sl, tp, direction } = alert.setup || {};

    // Skip malformed alerts that are missing required price fields
    if (entry == null || sl == null || tp == null || !direction) continue;

    const key = `${alert.symbol}:${alert.timeframe}:${alert.setup.type}:${alert.setup.time}`;
    let outcome   = null;
    let exitPrice = null;

    if (direction === 'bullish') {
      if (candle1m.low <= sl) {
        outcome   = 'lost';
        exitPrice = sl;
      } else if (candle1m.high >= tp) {
        outcome   = 'won';
        exitPrice = tp;
      }
    } else {
      // bearish
      if (candle1m.high >= sl) {
        outcome   = 'lost';
        exitPrice = sl;
      } else if (candle1m.low <= tp) {
        outcome   = 'won';
        exitPrice = tp;
      }
    }

    if (outcome) {
      updateAlertOutcome(key, outcome, exitPrice, candle1m.time);
      resolved.push({ key, outcome, exitPrice, outcomeTime: candle1m.time });
      console.log(
        `[Simulator] ${symbol} alert resolved: ${outcome} at ${exitPrice}` +
        ` (entry ${entry}, SL ${sl}, TP ${tp})`
      );
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------

module.exports = {
  placeOrder,
  checkFills,
  getOpenPositions,
  getSummary,
  getAllPositions,
  reset,
  checkLiveOutcomes,
};
