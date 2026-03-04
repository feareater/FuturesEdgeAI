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

module.exports = {
  placeOrder,
  checkFills,
  getOpenPositions,
  getSummary,
  getAllPositions,
  reset,
};
