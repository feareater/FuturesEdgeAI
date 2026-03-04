'use strict';
// Fetches the nearest-expiry options chain from Yahoo Finance for each futures instrument.
// Computes OI walls, max pain, put/call ratio, and ATM IV.
// Caches results for 1 hour. Returns null gracefully when Yahoo has no data.

const YAHOO_TICKERS = { MNQ: 'NQ=F', MES: 'ES=F', MGC: 'GC=F', MCL: 'CL=F' };
const BASE_URL      = 'https://query2.finance.yahoo.com/v7/finance/options/';
const CACHE_TTL_MS  = 60 * 60 * 1000; // 1 hour

const _cache = new Map(); // symbol → { data, timestamp }

// ── Fetch ───────────────────────────────────────────────────────────────────

async function _fetchOptions(symbol) {
  const ticker = YAHOO_TICKERS[symbol];
  if (!ticker) return null;

  try {
    const res = await fetch(`${BASE_URL}${ticker}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[options] ${symbol}: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const chain = json?.optionChain?.result?.[0];
    if (!chain) return null;

    const calls = chain.options?.[0]?.calls || [];
    const puts  = chain.options?.[0]?.puts  || [];
    if (calls.length === 0 && puts.length === 0) return null;

    return {
      calls,
      puts,
      currentPrice: chain.quote?.regularMarketPrice ?? null,
    };
  } catch (err) {
    console.warn(`[options] ${symbol}: ${err.message}`);
    return null;
  }
}

// ── Compute ─────────────────────────────────────────────────────────────────

function _computeMetrics(calls, puts, currentPrice) {
  // Build a strike → { callOI, putOI, callIV } map
  const strikeMap = new Map();

  for (const c of calls) {
    if (c.strike == null) continue;
    const entry = strikeMap.get(c.strike) || { callOI: 0, putOI: 0, callIV: null };
    entry.callOI += c.openInterest || 0;
    if (entry.callIV == null && c.impliedVolatility != null) entry.callIV = c.impliedVolatility;
    strikeMap.set(c.strike, entry);
  }
  for (const p of puts) {
    if (p.strike == null) continue;
    const entry = strikeMap.get(p.strike) || { callOI: 0, putOI: 0, callIV: null };
    entry.putOI += p.openInterest || 0;
    strikeMap.set(p.strike, entry);
  }

  if (strikeMap.size === 0) return null;

  const strikes = [...strikeMap.keys()].sort((a, b) => a - b);

  // OI Walls: top 3 strikes by combined call + put OI
  const oiWalls = strikes
    .map(s => {
      const { callOI, putOI } = strikeMap.get(s);
      return { strike: s, totalOI: callOI + putOI };
    })
    .sort((a, b) => b.totalOI - a.totalOI)
    .slice(0, 3)
    .map(x => x.strike);

  // Max Pain: strike K that minimizes total intrinsic value for all option buyers
  // For each K: sum max(0, S-K)*callOI[S] + max(0, K-S)*putOI[S] across all S
  let maxPain = null;
  let minPain = Infinity;
  for (const K of strikes) {
    let pain = 0;
    for (const S of strikes) {
      const { callOI, putOI } = strikeMap.get(S);
      pain += Math.max(0, S - K) * callOI;
      pain += Math.max(0, K - S) * putOI;
    }
    if (pain < minPain) { minPain = pain; maxPain = K; }
  }

  // Put/Call Ratio (by open interest)
  let totalCallOI = 0, totalPutOI = 0;
  for (const { callOI, putOI } of strikeMap.values()) {
    totalCallOI += callOI;
    totalPutOI  += putOI;
  }
  const pcRatio = totalCallOI > 0 ? +(totalPutOI / totalCallOI).toFixed(3) : null;

  // ATM IV: call strike nearest to current price
  let atmIV = null;
  if (currentPrice != null) {
    let minDist = Infinity;
    for (const S of strikes) {
      const { callIV } = strikeMap.get(S);
      const dist = Math.abs(S - currentPrice);
      if (dist < minDist && callIV != null) {
        minDist = dist;
        atmIV = +callIV.toFixed(4);
      }
    }
  }

  return { oiWalls, maxPain, pcRatio, atmIV };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns options metrics for a symbol with 1-hour caching.
 * Returns null when Yahoo Finance has no options data for the ticker.
 *
 * @param {string} symbol  'MNQ' | 'MES' | 'MGC' | 'MCL'
 * @returns {Promise<{ oiWalls, maxPain, pcRatio, atmIV } | null>}
 */
async function getOptionsData(symbol) {
  const cached = _cache.get(symbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const raw = await _fetchOptions(symbol);
  if (!raw) {
    _cache.set(symbol, { data: null, timestamp: Date.now() });
    return null;
  }

  const data = _computeMetrics(raw.calls, raw.puts, raw.currentPrice);
  _cache.set(symbol, { data, timestamp: Date.now() });

  if (data) {
    console.log(`[options] ${symbol}: maxPain=${data.maxPain} pc=${data.pcRatio} atmIV=${data.atmIV}`);
  } else {
    console.warn(`[options] ${symbol}: chain fetched but metrics empty`);
  }

  return data;
}

module.exports = { getOptionsData };
