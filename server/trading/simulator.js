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

const { POINT_VALUE, INSTRUMENTS } = require('../data/instruments');
const { appendForwardTrade, loadForwardTrades } = require('../storage/log');

// ---------------------------------------------------------------------------
// In-memory position store (session-scoped; not persisted)
// ---------------------------------------------------------------------------

const positions = [];   // all virtual positions: open + closed
let   _nextId   = 1;

// ---------------------------------------------------------------------------
// Forward-test dedup state (rebuilt from disk on startup)
// ---------------------------------------------------------------------------

// symbol -> alertKey string (the currently tracked open forward-test alert)
const _openPositions = new Map();

// symbol -> Set of 'YYYY-MM-DD:direction' strings (or_breakout session dedup)
const _orBreakoutSessionKeys = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _pnl(pos, closePrice) {
  const dpp       = POINT_VALUE[pos.symbol] ?? 1;
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
// ET date helper (DST-aware)
// ---------------------------------------------------------------------------

function toETDate(isoString) {
  const dt = new Date(isoString);
  // EDT = UTC-4 (Mar second Sun to Nov first Sun), EST = UTC-5 otherwise
  const month = dt.getUTCMonth() + 1;
  const offsetHours = (month >= 3 && month <= 11) ? 4 : 5;
  const et = new Date(dt.getTime() - offsetHours * 3600000);
  return et.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Rebuild forward-test dedup state from disk (survives restarts)
// ---------------------------------------------------------------------------

function _rebuildState() {
  try {
    const trades = loadForwardTrades();
    // Rebuild open positions: trades with no exitTime
    for (const t of trades) {
      if (!t.exitTime && t.symbol) {
        _openPositions.set(t.symbol, t.alertKey);
        console.log(`[SIMULATOR] Rebuilt open position: ${t.symbol} (${t.alertKey})`);
      }
    }
    // Rebuild or_breakout session keys for today's ET date
    const todayET = toETDate(new Date().toISOString());
    for (const t of trades) {
      if (t.setupType === 'or_breakout' && t.entryTime) {
        const tradeET = toETDate(t.entryTime);
        if (tradeET === todayET) {
          const seen = _orBreakoutSessionKeys.get(t.symbol) || new Set();
          seen.add(`${tradeET}:${t.direction}`);
          _orBreakoutSessionKeys.set(t.symbol, seen);
        }
      }
    }
    if (_orBreakoutSessionKeys.size > 0) {
      console.log(`[SIMULATOR] Rebuilt or_breakout session keys for ${todayET}: ${[..._orBreakoutSessionKeys.keys()].join(', ')}`);
    }
  } catch (e) {
    // File may not exist yet on first run — that's fine
  }
}

_rebuildState();

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
 * Check if a Unix-seconds timestamp falls at or after 16:45 ET.
 * Used for force-closing open positions at end of RTH session.
 */
function _isPastSessionClose(unixSec) {
  const d = new Date(unixSec * 1000);
  // Convert to ET (America/New_York)
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMinutes = et.getHours() * 60 + et.getMinutes();
  return etMinutes >= 16 * 60 + 45; // 16:45 ET
}

/**
 * Build a forward-test trade record from a resolved alert and persist it.
 *
 * Breadth fields (equityBreadth / riskAppetite / bondRegime) live on
 * setup.scoreBreakdown.context.breadthDetail (populated by setups.js
 * applyMarketContext).
 *
 * dxyDirection fallback chain (v14.41 — aligned with setups.js Phase 2 gate
 * at lines 1319-1321 for consistency between the live stamp and live gating):
 *   marketContext.dxy?.direction  (primary — real DXY 5m candles for
 *                                   DXY_APPLICABLE: MNQ/MES/M2K/MYM/MGC/MCL;
 *                                   hardcoded 'flat' for other symbols)
 *   → breadth.dollarRegime         (fallback — inferred from M6E EUR/USD micro)
 *   → null                         (no source available)
 *
 * v14.32 used the reverse order (breadth first). Audit v14.41 found that
 * reference-symbol seed gaps (M6E has no seed file) cause live breadth to
 * default to dollarRegime='flat' during the warm-up window after server start,
 * which then shadowed the real DXY signal in the stamp. DXY has a seed file
 * so ctx.dxyDirection is reliable. Switching primary to dxy.direction also
 * matches the authoritative setups.js gate order.
 *
 * Honest missingness — we never coerce to 'flat'/'neutral' to hide nulls.
 *
 * TODO(P2-deriveMarketSnapshot): the same fallback chain is duplicated in
 * bias.js:21-29 (uses breadth→dxy) and setups.js:1319-1321 (uses dxy→breadth).
 * Consolidate into a shared deriveMarketSnapshot(mktCtx) helper.
 */
function _persistForwardTrade(alert, outcome, exitPrice, exitTime) {
  const s = alert.setup || {};
  const ctx = s.scoreBreakdown?.context || {};
  const bd = ctx.breadthDetail || {};
  const dir = s.direction === 'bullish' ? 1 : -1;
  const pv = POINT_VALUE[alert.symbol] || 1;
  const feePerRT = INSTRUMENTS[alert.symbol]?.feePerRT ?? 4;
  const grossPnl = parseFloat(((exitPrice - s.entry) * dir * pv).toFixed(2));
  const netPnl   = parseFloat((grossPnl - feePerRT).toFixed(2));

  const exitReason = outcome === 'won' ? 'tp' : outcome === 'lost' ? 'sl' : 'timeout';

  // v14.41 fallback chain (dxy.direction primary, breadth.dollarRegime fallback)
  const primaryDxy = ctx.dxyDirection;
  const fallbackDxy = bd.dollarRegime;
  let dxyDirection;
  if (primaryDxy === 'rising' || primaryDxy === 'falling') {
    dxyDirection = primaryDxy;
  } else if (fallbackDxy === 'rising' || fallbackDxy === 'falling') {
    dxyDirection = fallbackDxy;
  } else if (primaryDxy === 'flat' || fallbackDxy === 'flat') {
    dxyDirection = 'flat';
  } else {
    dxyDirection = null;
  }

  const trade = {
    alertKey:       `${alert.symbol}:${alert.timeframe}:${s.type}:${s.time}`,
    symbol:         alert.symbol,
    setupType:      s.type,
    direction:      s.direction,
    timeframe:      alert.timeframe,
    confidence:     s.confidence,
    entryPrice:     s.entry,
    sl:             s.sl,
    tp:             s.tp,
    exitPrice,
    exitReason,
    entryTime:      new Date(s.time * 1000).toISOString(),
    exitTime:       new Date(exitTime * 1000).toISOString(),
    grossPnl,
    netPnl,
    outcome,
    // ML context fields
    vixRegime:      ctx.vixRegime      ?? null,
    vixLevel:       ctx.vixLevel       ?? null,
    dxyDirection,
    equityBreadth:  bd.equityBreadth   ?? null,
    riskAppetite:   bd.riskAppetite    ?? null,
    bondRegime:     bd.bondRegime      ?? null,
    ddBandLabel:    s.ddBandLabel      ?? null,
    hpNearest:      ctx.hpNearest      ?? null,
    resilienceLabel: ctx.resilienceLabel ?? null,
    dexBias:        ctx.dexBias        ?? null,
    mtfConfluence:  s.mtfConfluence    ?? null,
  };

  appendForwardTrade(trade);
  return trade;
}

/**
 * Check all open alerts in the alert cache against a live 1m candle.
 * Resolves any that hit their SL or TP and persists the outcome immediately.
 * Also force-closes any open alerts at 16:45 ET (session timeout).
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

  // ── Gate: claim one active position per symbol ──────────────────────────
  // If no position is currently tracked for this symbol, try to claim the
  // first eligible open alert.  All other alerts for the same symbol are
  // resolved in the alert cache (outcome updated) but NOT persisted as
  // forward trades — only the claimed alert produces a trade record.
  if (!_openPositions.has(symbol) && openAlerts.length > 0) {
    for (const candidate of openAlerts) {
      const s = candidate.setup || {};
      if (s.entry == null || s.sl == null || s.tp == null || !s.direction) continue;

      const candidateKey = `${candidate.symbol}:${candidate.timeframe}:${s.type}:${s.time}`;

      // Gate 2: or_breakout session dedup
      if (s.type === 'or_breakout') {
        const etDate = toETDate(new Date(s.time * 1000).toISOString());
        const sessionKey = `${etDate}:${s.direction}`;
        const seen = _orBreakoutSessionKeys.get(symbol) || new Set();
        if (seen.has(sessionKey)) {
          console.log(`[SIMULATOR] Skip ${symbol} or_breakout ${s.direction} — already fired this session (${etDate})`);
          continue;   // try next candidate (different setup type may be eligible)
        }
        seen.add(sessionKey);
        _orBreakoutSessionKeys.set(symbol, seen);
      }

      _openPositions.set(symbol, candidateKey);
      console.log(
        `[SIMULATOR] New trade opened: ${symbol} ${s.type} ${s.direction}` +
        ` ${candidate.timeframe} conf=${s.confidence}`
      );
      break;  // claimed — stop looking
    }
  }

  const trackedKey = _openPositions.get(symbol);

  const isTimeout = _isPastSessionClose(candle1m.time);

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

    // Force-close at 16:45 ET if still open
    if (!outcome && isTimeout) {
      outcome   = 'timeout';
      exitPrice = candle1m.close;
    }

    if (outcome) {
      // Always update the alert cache outcome (keeps alert state consistent)
      updateAlertOutcome(key, outcome, exitPrice, candle1m.time);

      // Only persist the forward trade for the ONE tracked position per symbol
      if (key === trackedKey) {
        _persistForwardTrade(alert, outcome, exitPrice, candle1m.time);
        _openPositions.delete(symbol);
        console.log(
          `[SIMULATOR] Trade closed: ${symbol} ${outcome}` +
          ` exitReason=${outcome === 'won' ? 'tp' : outcome === 'lost' ? 'sl' : 'timeout'}` +
          ` (entry ${entry}, SL ${sl}, TP ${tp})`
        );
      } else {
        console.log(
          `[SIMULATOR] Skip ${symbol} — position already open` +
          ` (tracked=${trackedKey}, skipped=${key})`
        );
      }

      resolved.push({ key, outcome, exitPrice, outcomeTime: candle1m.time });
    }
  }

  return resolved;
}

/**
 * Return the count of currently open (unresolved) forward-test alerts.
 */
function getOpenForwardTestCount() {
  const { loadAlertCache } = require('../storage/log');
  try {
    const alerts = loadAlertCache();
    return alerts.filter(a =>
      (a.setup?.outcome === 'open' || a.setup?.outcome == null) &&
      !a.setup?.userOverride &&
      a.setup?.entry != null && a.setup?.sl != null && a.setup?.tp != null
    ).length;
  } catch (_) {
    return 0;
  }
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
  getOpenForwardTestCount,
};
