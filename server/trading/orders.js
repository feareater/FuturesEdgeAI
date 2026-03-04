'use strict';

/**
 * server/trading/orders.js
 * Tradovate Demo REST API wrapper — account lookup, contract resolution,
 * open-position check, and bracket-order placement.
 *
 * All calls target TRADOVATE_API_URL (must be the demo endpoint).
 * Uses ensureAuthenticated() so tokens are always valid before a request.
 */

const { ensureAuthenticated } = require('../auth/tradovate');

const API_URL = process.env.TRADOVATE_API_URL; // https://demo.tradovateapi.com/v1

// ---------------------------------------------------------------------------
// Internal caches (reset on process restart)
// ---------------------------------------------------------------------------

let _account = null;                     // { id, name }
const _contractCache = new Map();        // baseSymbol → { name, expiresAt }
const CONTRACT_CACHE_MS = 4 * 60 * 60 * 1000; // 4 hours

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function _authedFetch(path, opts = {}) {
  const token = await ensureAuthenticated();
  const res   = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tradovate ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// A. Account resolution
// ---------------------------------------------------------------------------

/**
 * Return the first demo account (cached for process lifetime).
 * Throws if no account is found.
 */
async function getAccount() {
  if (_account) return _account;

  const accounts = await _authedFetch('/account/list');
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('[orders] No Tradovate accounts found');
  }

  // Pick the first active account (demo env only has demo accounts)
  const acc = accounts[0];
  _account  = { id: acc.id, name: acc.name };
  console.log(`[orders] Using account: ${_account.name} (id=${_account.id})`);
  return _account;
}

// ---------------------------------------------------------------------------
// B. Contract resolution — find the front-month contract name
// ---------------------------------------------------------------------------

/**
 * Resolve a base symbol (e.g. "MNQ") to the current front-month contract
 * name (e.g. "MNQH6"). Result cached for CONTRACT_CACHE_MS.
 *
 * Uses /contract/find which, for continuous symbols, returns the active
 * front-month contract definition.
 */
async function resolveContract(baseSymbol) {
  const cached = _contractCache.get(baseSymbol);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  // suggestContracts returns an array of matching contracts — take the first
  const data = await _authedFetch(
    `/contract/suggest?t=${encodeURIComponent(baseSymbol)}&l=1`
  );

  // Response is an array of contract objects
  const contracts = Array.isArray(data) ? data : (data.contract || []);
  if (!contracts.length) {
    throw new Error(`[orders] No contract found for symbol: ${baseSymbol}`);
  }

  const name = contracts[0].name;
  _contractCache.set(baseSymbol, { name, expiresAt: Date.now() + CONTRACT_CACHE_MS });
  console.log(`[orders] Resolved ${baseSymbol} → ${name}`);
  return name;
}

// Force-clear the contract cache (call after a monthly rollover if needed)
function clearContractCache() {
  _contractCache.clear();
}

// ---------------------------------------------------------------------------
// C. Open position check
// ---------------------------------------------------------------------------

/**
 * Return all open positions for the cached account.
 * A "position" is open when netPos !== 0.
 */
async function getOpenPositions() {
  const account   = await getAccount();
  const positions = await _authedFetch('/position/list');

  if (!Array.isArray(positions)) return [];

  return positions
    .filter(p => p.accountId === account.id && p.netPos !== 0)
    .map(p => ({
      symbol:   p.contractId?.name ?? String(p.contractId),
      netPos:   p.netPos,
      avgPrice: p.netPrice ?? null,
    }));
}

// ---------------------------------------------------------------------------
// D. Place bracket order (market entry + SL stop + TP limit)
// ---------------------------------------------------------------------------

/**
 * Place a market order with two OCO bracket legs:
 *   bracket1 — Stop loss
 *   bracket2 — Take profit (limit)
 *
 * @param {object} params
 * @param {string} params.contractName  Resolved front-month contract, e.g. "MNQH6"
 * @param {string} params.direction     'bullish' | 'bearish'
 * @param {number} params.qty           Number of contracts
 * @param {number} params.sl            Stop-loss price
 * @param {number} params.tp            Take-profit price
 * @returns {{ orderId: number, timestamp: string }}
 */
async function placeOrder({ contractName, direction, qty, sl, tp }) {
  const account   = await getAccount();
  const isBull    = direction === 'bullish';
  const entryAct  = isBull ? 'Buy'  : 'Sell';
  const exitAct   = isBull ? 'Sell' : 'Buy';

  const body = {
    accountSpec:  process.env.TRADOVATE_USERNAME,
    accountId:    account.id,
    action:       entryAct,
    symbol:       contractName,
    orderQty:     qty,
    orderType:    'Market',
    isAutomated:  true,
    // Bracket 1 — Stop loss
    bracket1: {
      action:    exitAct,
      orderType: 'Stop',
      stopPrice: sl,
      orderQty:  qty,
    },
    // Bracket 2 — Take profit
    bracket2: {
      action:    exitAct,
      orderType: 'Limit',
      price:     tp,
      orderQty:  qty,
    },
  };

  console.log(`[orders] Placing ${entryAct} ${qty}x ${contractName} · SL=${sl} TP=${tp}`);

  const result = await _authedFetch('/order/placeOrder', {
    method: 'POST',
    body:   JSON.stringify(body),
  });

  // Tradovate returns { orderId, ... } on success or { errorText } on failure
  if (result.errorText) {
    throw new Error(`[orders] placeOrder rejected: ${result.errorText}`);
  }

  const orderId = result.orderId ?? result.id;
  console.log(`[orders] Order accepted — orderId=${orderId}`);

  return {
    orderId:   orderId,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------

module.exports = {
  getAccount,
  resolveContract,
  clearContractCache,
  getOpenPositions,
  placeOrder,
};
