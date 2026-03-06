'use strict';
// Polygon.io data fetcher — Forex rates + Options flow
//
// Free-tier endpoints used (Polygon Starter plan):
//   Forex prev-close : GET /v2/aggs/ticker/C:{pair}/prev  (previous day OHLC)
//   Forex daily aggs : GET /v2/aggs/ticker/C:{pair}/range/1/day/{from}/{to}
//
// NOT available on free tier (403):
//   Forex snapshot, Options chain snapshot — require paid plan
//
// Options flow and strike scaling are disabled until a paid Polygon plan is active.

const POLY_BASE = 'https://api.polygon.io';
const TTL_MS    = 60 * 60 * 1000; // 1-hour cache (prev-close data doesn't change within a day)
const _cache    = new Map();

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
  // Options snapshot endpoint requires a paid Polygon plan (returns 403 on free tier).
  // Return null until a paid plan is active.
  return null;

  /* eslint-disable no-unreachable */
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

module.exports = { getForexRate, getOptionsFlow, OPTIONS_PROXY };
