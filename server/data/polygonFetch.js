'use strict';
// Polygon.io data fetcher — Forex rates + Options flow + Gamma levels
//
// Forex prev-close : GET /v2/aggs/ticker/C:{pair}/prev  (free tier)
// Options chain    : GET /v3/snapshot/options/{ticker}  (requires Stocks Starter plan+)
// Gamma flip       : computed from greeks × OI across full chain (requires Options plan)
//
// All options calls degrade gracefully to null if the plan doesn't support them.

const POLY_BASE    = 'https://api.polygon.io';
const TTL_MS       = 60 * 60 * 1000;       // 1-hour cache for forex + options OI
const GAMMA_TTL_MS = 30 * 60 * 1000;       // 30-min cache for gamma (moves slowly)
const _cache       = new Map();

// Proxy ETF for each futures symbol (reserved for when options data is available)
const OPTIONS_PROXY = { MNQ: 'QQQ', MES: 'SPY', MGC: 'GLD', MCL: 'USO' };

// ── Internals ──────────────────────────────────────────────────────────────

function _apiKey() {
  return process.env.POLYGON_API_KEY || '';
}

function _cached(key) {
  const c = _cache.get(key);
  return c && (Date.now() - c.ts) < TTL_MS ? c.data : null;
}

function _store(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

async function _get(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${POLY_BASE}${path}${sep}apiKey=${_apiKey()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Polygon HTTP ${res.status} — ${path}`);
  return res.json();
}

// Fetch a full URL directly (used for Polygon pagination next_url)
async function _getUrl(fullUrl) {
  const sep = fullUrl.includes('?') ? '&' : '?';
  const url = `${fullUrl}${sep}apiKey=${_apiKey()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Polygon HTTP ${res.status}`);
  return res.json();
}

// Paginate through all options contracts for a ticker+expiry window
async function _fetchAllOptions(ticker, fromDate, toDate) {
  const results = [];
  let path = `/v3/snapshot/options/${ticker}?limit=250&order=asc&sort=strike_price&expiration_date.gte=${fromDate}&expiration_date.lte=${toDate}`;
  let page = 0;
  while (path && page < 12) { // max 3000 contracts
    const data = await _get(path);
    if (data?.results?.length) results.push(...data.results);
    path = data?.next_url ? data.next_url.replace(POLY_BASE, '').replace(/[?&]apiKey=[^&]*/g, '') : null;
    page++;
    if (!data?.next_url) break;
  }
  return results;
}

// ── Forex ──────────────────────────────────────────────────────────────────

/**
 * Returns current forex data for `pair` (e.g. 'GBPUSD').
 * Cached for 1 hour (free-tier delay means refreshing more often wastes calls).
 *
 * @returns {Promise<{ pair, price, change, open, high, low } | null>}
 */
async function getForexRate(pair = 'GBPUSD') {
  const key = `forex:${pair}`;
  const hit = _cached(key);
  if (hit !== null) return hit;   // may be null (failed) — still cached

  try {
    // Free tier: use prev-close daily agg (live snapshot is paid-tier only)
    const json = await _get(`/v2/aggs/ticker/C:${pair}/prev`);
    const bar = json?.results?.[0];
    if (!bar) return _store(key, null);

    // Fetch a short history window to compute day-over-day change
    const from = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const to   = new Date().toISOString().slice(0, 10);
    const hist = await _get(`/v2/aggs/ticker/C:${pair}/range/1/day/${from}/${to}`);
    const bars = hist?.results ?? [];
    const prevClose = bars.length >= 2 ? bars[bars.length - 2].c : null;
    const change = (prevClose && bar.c) ? +((bar.c - prevClose) / prevClose * 100).toFixed(3) : null;

    const data = {
      pair,
      price:     bar.c   ?? null,
      open:      bar.o   ?? null,
      high:      bar.h   ?? null,
      low:       bar.l   ?? null,
      prevClose,
      change,
      label:     'prev-day', // free-tier: previous trading day close
    };
    console.log(`[polygon] forex ${pair}: ${data.price} (${data.change?.toFixed(2)}%) [prev-day]`);
    return _store(key, data);
  } catch (err) {
    console.warn(`[polygon] forex ${pair}: ${err.message}`);
    return _store(key, null);
  }
}

// ── Options ────────────────────────────────────────────────────────────────

/**
 * Fetches top-OI options for the proxy ETF and computes flow metrics.
 * `futuresPrice` is the current price of the futures instrument — used to
 * scale ETF strike prices onto the futures price axis.
 *
 * @param {string} symbol         'MNQ' | 'MES' | 'MGC' | 'MCL'
 * @param {number} [futuresPrice] Current futures price for strike scaling
 * @returns {Promise<{ oiWalls, maxPain, pcRatio, atmIV, proxy, proxyPrice, scaled } | null>}
 */
async function getOptionsFlow(symbol, futuresPrice = null) {
  const proxy = OPTIONS_PROXY[symbol];
  if (!proxy || !_apiKey()) return null;

  const key = `options:${symbol}`;
  const hit = _cached(key);
  if (hit !== null) return hit;

  try {
    // Fetch top calls and puts by open interest (two requests — free tier allows)
    const [callJson, putJson] = await Promise.all([
      _get(`/v3/snapshot/options/${proxy}?limit=250&order=desc&sort=open_interest&contract_type=call`),
      _get(`/v3/snapshot/options/${proxy}?limit=250&order=desc&sort=open_interest&contract_type=put`),
    ]);

    const calls = callJson?.results ?? [];
    const puts  = putJson?.results  ?? [];

    if (calls.length === 0 && puts.length === 0) {
      console.warn(`[polygon] ${symbol}(${proxy}): empty options chain`);
      return _store(key, null);
    }

    // Extract ETF underlying price from first result
    const proxyPrice = calls[0]?.underlying_asset?.price
                    ?? puts[0]?.underlying_asset?.price
                    ?? null;

    const metrics = _computeMetrics(calls, puts, proxyPrice);
    if (!metrics) return _store(key, null);

    // Scale: futures-equivalent strike = etfStrike × (futuresPrice / proxyPrice)
    const scaleFactor = (futuresPrice && proxyPrice) ? (futuresPrice / proxyPrice) : null;
    const scaled = scaleFactor
      ? {
          oiWalls: metrics.oiWalls.map(w => ({ ...w, futuresStrike: +(w.strike * scaleFactor).toFixed(2) })),
          maxPain: metrics.maxPain != null ? +(metrics.maxPain * scaleFactor).toFixed(2) : null,
        }
      : null;

    const data = { ...metrics, proxy, proxyPrice, scaled };
    console.log(`[polygon] ${symbol}(${proxy}): maxPain=${metrics.maxPain} pc=${metrics.pcRatio} atmIV=${metrics.atmIV} proxyPrice=${proxyPrice}`);
    return _store(key, data);
  } catch (err) {
    console.warn(`[polygon] options ${symbol}: ${err.message}`);
    return _store(key, null);
  }
}

function _computeMetrics(calls, puts, currentPrice) {
  const map = new Map(); // strike → { callOI, putOI, iv }

  for (const c of calls) {
    const s = c.details?.strike_price;
    if (s == null) continue;
    const e = map.get(s) || { callOI: 0, putOI: 0, iv: null };
    e.callOI += c.open_interest || 0;
    if (e.iv == null && c.implied_volatility != null) e.iv = c.implied_volatility;
    map.set(s, e);
  }
  for (const p of puts) {
    const s = p.details?.strike_price;
    if (s == null) continue;
    const e = map.get(s) || { callOI: 0, putOI: 0, iv: null };
    e.putOI += p.open_interest || 0;
    map.set(s, e);
  }

  if (map.size === 0) return null;

  const strikes = [...map.keys()].sort((a, b) => a - b);

  // Top-5 OI walls (combined call + put OI)
  const oiWalls = strikes
    .map(s => ({ strike: s, callOI: map.get(s).callOI, putOI: map.get(s).putOI, totalOI: map.get(s).callOI + map.get(s).putOI }))
    .sort((a, b) => b.totalOI - a.totalOI)
    .slice(0, 5);

  // Max pain
  let maxPain = null, minPain = Infinity;
  for (const K of strikes) {
    let pain = 0;
    for (const S of strikes) {
      const { callOI, putOI } = map.get(S);
      pain += Math.max(0, S - K) * callOI + Math.max(0, K - S) * putOI;
    }
    if (pain < minPain) { minPain = pain; maxPain = K; }
  }

  // P/C ratio
  let totalCall = 0, totalPut = 0;
  for (const { callOI, putOI } of map.values()) { totalCall += callOI; totalPut += putOI; }
  const pcRatio = totalCall > 0 ? +(totalPut / totalCall).toFixed(3) : null;

  // ATM IV
  let atmIV = null;
  if (currentPrice != null) {
    let minD = Infinity;
    for (const S of strikes) {
      const { iv } = map.get(S);
      const d = Math.abs(S - currentPrice);
      if (d < minD && iv != null) { minD = d; atmIV = +iv.toFixed(4); }
    }
  }

  return { oiWalls, maxPain, pcRatio, atmIV };
}

// ── Gamma Levels ────────────────────────────────────────────────────────────

/**
 * Fetches full options chain with greeks and computes:
 *   - Gamma flip level (price where dealer net gamma = 0)
 *   - Call wall (highest-OI call strike above spot)
 *   - Put wall  (highest-OI put  strike below spot)
 *   - Max pain  (across all near-term expirations)
 *   - isZeroDTE (Mon/Wed/Fri for QQQ, Fri only for SPY/GLD/USO)
 *
 * Requires Polygon Options plan for greeks; degrades gracefully without them
 * (gamma flip will be null, other levels still computed from OI).
 *
 * @param {string} symbol         'MNQ' | 'MES' | 'MGC' | 'MCL'
 * @param {number} [futuresPrice] Current futures price for strike scaling
 * @returns {Promise<object|null>}
 */
async function getGammaData(symbol, futuresPrice = null) {
  const proxy = OPTIONS_PROXY[symbol];
  if (!proxy || !_apiKey()) return null;

  const key = `gamma:${symbol}`;
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.ts) < GAMMA_TTL_MS) return hit.data;

  try {
    const today  = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    const contracts = await _fetchAllOptions(proxy, today, cutoff);
    if (contracts.length === 0) {
      console.warn(`[polygon] gamma ${symbol}(${proxy}): no contracts returned`);
      return _store(key, null); // _store uses TTL_MS but that's fine here
    }

    const proxyPrice = contracts[0]?.underlying_asset?.price ?? null;

    // Build per-strike map
    const strikeMap = new Map();
    for (const c of contracts) {
      const strike = c.details?.strike_price;
      const type   = c.details?.contract_type; // 'call' | 'put'
      const oi     = c.open_interest ?? 0;
      const gamma  = c.greeks?.gamma  ?? 0;
      if (strike == null || !type) continue;
      if (!strikeMap.has(strike)) strikeMap.set(strike, { callGamma: 0, putGamma: 0, callOI: 0, putOI: 0 });
      const e = strikeMap.get(strike);
      if (type === 'call') { e.callGamma += gamma * oi * 100; e.callOI += oi; }
      else                 { e.putGamma  += gamma * oi * 100; e.putOI  += oi; }
    }

    const strikes = [...strikeMap.keys()].sort((a, b) => a - b);

    // ── Gamma flip ──────────────────────────────────────────────────────────
    // Net gamma at each strike (dealer perspective: long calls, long puts from selling)
    // Positive = dealers net long gamma at that level (stabilizing/mean-reverting)
    // Negative = dealers net short gamma (amplifying/trending)
    // Flip = strike where running total (low→high) crosses from negative to positive
    let flipLevel = null;
    const hasGreeks = contracts.some(c => c.greeks?.gamma != null);
    if (hasGreeks) {
      let cumGamma = 0;
      for (const s of strikes) {
        const { callGamma, putGamma } = strikeMap.get(s);
        cumGamma += callGamma - putGamma;
        if (cumGamma >= 0 && flipLevel == null) flipLevel = s;
      }
      // If always negative (rare), use the strike with least-negative net gamma
      if (flipLevel == null) {
        let bestNet = -Infinity;
        for (const s of strikes) {
          const { callGamma, putGamma } = strikeMap.get(s);
          const net = callGamma - putGamma;
          if (net > bestNet) { bestNet = net; flipLevel = s; }
        }
      }
    }

    // ── Call wall / Put wall ────────────────────────────────────────────────
    const above = strikes.filter(s => proxyPrice == null || s >= proxyPrice);
    const below = strikes.filter(s => proxyPrice == null || s <  proxyPrice);
    const callWall = above.sort((a, b) => strikeMap.get(b).callOI - strikeMap.get(a).callOI)[0] ?? null;
    const putWall  = below.sort((a, b) => strikeMap.get(b).putOI  - strikeMap.get(a).putOI )[0] ?? null;

    // ── Max pain ────────────────────────────────────────────────────────────
    let maxPain = null, minPain = Infinity;
    for (const K of strikes) {
      let pain = 0;
      for (const S of strikes) {
        const { callOI, putOI } = strikeMap.get(S);
        pain += Math.max(0, S - K) * callOI + Math.max(0, K - S) * putOI;
      }
      if (pain < minPain) { minPain = pain; maxPain = K; }
    }

    // ── 0DTE flag ───────────────────────────────────────────────────────────
    const dow = new Date().getDay(); // 0=Sun … 6=Sat
    const isZeroDTE = proxy === 'QQQ' ? [1, 3, 5].includes(dow)  // QQQ: Mon/Wed/Fri
                    : proxy === 'SPY' ? [1, 2, 3, 4, 5].includes(dow) // SPY: every trading day
                    : dow === 5; // others: Fridays only

    // ── Scale to futures price space ────────────────────────────────────────
    const sf = (futuresPrice && proxyPrice) ? futuresPrice / proxyPrice : null;

    const data = {
      proxy, proxyPrice, hasGreeks, isZeroDTE,
      flipLevel,
      callWall,
      putWall,
      maxPain,
      scaled: sf ? {
        flipLevel: flipLevel != null ? +(flipLevel * sf).toFixed(2) : null,
        callWall:  callWall  != null ? +(callWall  * sf).toFixed(2) : null,
        putWall:   putWall   != null ? +(putWall   * sf).toFixed(2) : null,
        maxPain:   maxPain   != null ? +(maxPain   * sf).toFixed(2) : null,
      } : null,
    };

    console.log(`[polygon] gamma ${symbol}(${proxy}): flip=${flipLevel} callWall=${callWall} putWall=${putWall} maxPain=${maxPain} 0DTE=${isZeroDTE} greeks=${hasGreeks}`);
    _cache.set(key, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.warn(`[polygon] gamma ${symbol}: ${err.message}`);
    _cache.set(key, { data: null, ts: Date.now() });
    return null;
  }
}

module.exports = { getForexRate, getOptionsFlow, getGammaData, OPTIONS_PROXY };
