'use strict';
// Fetches options chain for HP/GEX/DEX/resilience computation.
// Primary source: Databento OPRA.PILLAR live TCP feed (features.liveOpra=true).
// Fallback:       CBOE delayed quotes API (free, 15-min delayed).
//
// When liveOpra is enabled and opraLive has accumulated OI data, getOptionsData()
// converts the live strike map into the same intermediate format as the CBOE response
// and passes it through the unchanged _computeMetrics() pipeline.  The return shape
// of getOptionsData() is identical in both cases — callers (marketContext.js, index.js)
// see no difference.
//
// Feature flag: config/settings.json → features.liveOpra (default false).
// Hot-toggle:   POST /api/features { "liveOpra": true|false } — no restart needed.

const BASE_URL     = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const YAHOO_BASE   = 'https://query2.finance.yahoo.com/v8/finance/chart';

// Lazy-require opraLive to avoid circular deps; resolved on first getOptionsData() call.
let _opraLive = null;
function _getOpraLive() {
  if (!_opraLive) _opraLive = require('./opraLive');
  return _opraLive;
}

// Read features from settings at call time so hot-toggles take effect without restart.
// We import the settings object (mutable reference) — the same pattern used elsewhere.
const settings = require('../../config/settings.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (CBOE data is 15-min delayed)
const DAILY_TTL_MS = 30 * 60 * 1000; // 30 min for daily OHLC cache

// ETF proxies for each futures symbol (MHG has no options proxy — copper has no liquid ETF)
const ETF_PROXY     = { MNQ: 'QQQ', MES: 'SPY', M2K: 'IWM', MYM: 'DIA', MGC: 'GLD', MCL: 'USO', SIL: 'SLV' };
// Corresponding micro futures tickers on Yahoo Finance — used to get the live
// futures price from the same source/time as the ETF price for accurate scaling.
const FUTURES_YAHOO = { MNQ: 'MNQ=F', MES: 'MES=F', M2K: 'M2K=F', MYM: 'MYM=F', MGC: 'MGC=F', MCL: 'MCL=F', SIL: 'SI=F' };

const _cache      = new Map(); // symbol → { data, timestamp }
const _dailyCache = new Map(); // etfTicker → { data, timestamp }

// ── Parse CBOE option ticker ─────────────────────────────────────────────────
// Format: {UNDERLYING}{YYMMDD}{C|P}{8-digit-strike-×-1000}
// e.g. QQQ260330C00500000 → expiry=2026-03-30, type=C, strike=500.000

function _parseOpt(ticker, underlying) {
  const body  = ticker.slice(underlying.length);               // e.g. 260330C00500000
  const yymmdd = body.slice(0, 6);
  const type   = body[6];                                       // 'C' or 'P'
  const raw    = body.slice(7);                                 // 8-digit strike×1000
  const strike = parseInt(raw, 10) / 1000;
  const expiry = `20${yymmdd.slice(0,2)}-${yymmdd.slice(2,4)}-${yymmdd.slice(4,6)}`;
  return { expiry, type, strike };
}

// ── Fetch raw CBOE options list ──────────────────────────────────────────────

async function _fetchCBOE(etfTicker) {
  const url = `${BASE_URL}/${etfTicker}.json`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[options] CBOE ${etfTicker}: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json?.data ?? null;
  } catch (err) {
    console.warn(`[options] CBOE ${etfTicker}: ${err.message}`);
    return null;
  }
}

// ── Fetch ETF daily OHLC for prev-day and current-day reference levels ───────

async function _fetchDailyLevels(etfTicker, futuresTicker) {
  const cacheKey = etfTicker;
  const cached = _dailyCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DAILY_TTL_MS) return cached.data;

  try {
    // Fetch ETF daily candles + live futures price in parallel — same source, same moment.
    // This gives an accurate ETF/futures ratio without relying on stale seed candle data.
    const [etfRes, futRes] = await Promise.all([
      fetch(`${YAHOO_BASE}/${etfTicker}?interval=1d&range=5d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
      }),
      futuresTicker ? fetch(`${YAHOO_BASE}/${futuresTicker}?interval=1d&range=2d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
      }) : Promise.resolve(null),
    ]);

    if (!etfRes.ok) { _dailyCache.set(cacheKey, { data: null, timestamp: Date.now() }); return null; }

    const etfJson  = await etfRes.json();
    const etfMeta  = etfJson?.chart?.result?.[0];
    const times    = etfMeta?.timestamp || [];
    const ohlc     = etfMeta?.indicators?.quote?.[0] || {};
    const opens    = ohlc.open  || [];
    const closes   = ohlc.close || [];

    if (times.length < 2) { _dailyCache.set(cacheKey, { data: null, timestamp: Date.now() }); return null; }

    // Live prices from Yahoo meta — both captured at the same moment
    const liveEtfPrice     = etfMeta?.meta?.regularMarketPrice ?? null;
    let   liveFuturesPrice = null;
    if (futRes?.ok) {
      const futJson      = await futRes.json();
      liveFuturesPrice   = futJson?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    }

    // Identify today's date in ET by comparing to the most recent timestamp
    // Yahoo daily candles timestamp to midnight UTC of that trading day.
    // Sort descending — last entry is the most recent complete OR in-progress day.
    const sortedIdxs = times.map((_t, i) => i).sort((a, b) => times[b] - times[a]);
    const latestIdx  = sortedIdxs[0];
    const prevIdx    = sortedIdxs[1] ?? -1;

    // curDayOpen: prefer Yahoo's intraday 1d chart (first bar of today) if the
    // daily open is null (in-progress candle). Fall back to liveEtfPrice / ratio
    // as a rough estimate — but we try to get today's actual open first.
    let curDayOpen = opens[latestIdx] ?? null;

    // If today's candle open is missing, try a 1d/5m fetch to get today's first bar
    if (curDayOpen == null && etfTicker) {
      try {
        const intradayRes = await fetch(`${YAHOO_BASE}/${etfTicker}?interval=5m&range=1d`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000),
        });
        if (intradayRes.ok) {
          const id = await intradayRes.json();
          const idOpens = id?.chart?.result?.[0]?.indicators?.quote?.[0]?.open || [];
          curDayOpen = idOpens.find(v => v != null) ?? null; // first non-null open of today
        }
      } catch (_) {}
    }

    const data = {
      prevDayOpen:       prevIdx >= 0 ? opens[prevIdx]  : null,
      prevDayClose:      prevIdx >= 0 ? closes[prevIdx] : null,
      curDayOpen,
      liveEtfPrice,      // current QQQ/SPY price from Yahoo
      liveFuturesPrice,  // current MNQ=F/MES=F price from Yahoo — same-source ratio
    };

    console.log(`[options] ${etfTicker} daily: prevO=${data.prevDayOpen?.toFixed(2)} prevC=${data.prevDayClose?.toFixed(2)} curO=${data.curDayOpen?.toFixed(2)} liveETF=${liveEtfPrice?.toFixed(2)} liveFut=${liveFuturesPrice?.toFixed(2)}`);
    _dailyCache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    console.warn(`[options] ${etfTicker} daily fetch: ${err.message}`);
    _dailyCache.set(cacheKey, { data: null, timestamp: Date.now() });
    return null;
  }
}

// ── Compute metrics from raw CBOE options ───────────────────────────────────

function _computeMetrics(raw, futuresPrice) {
  const spot       = raw.current_price;
  const opts       = raw.options || [];
  const underlying = raw.symbol;

  // Parse + filter:
  //   - Expiry: next 30 days (nearest-term OI is most actionable)
  //   - Strike: within ±25% of spot (exclude deep ITM/OTM — they skew GEX/max pain)
  const today    = new Date();
  const maxDate  = new Date(today.getTime() + 30 * 86400_000);
  const todayStr = today.toISOString().slice(0, 10);
  const maxStr   = maxDate.toISOString().slice(0, 10);
  const minStrike = spot * 0.75;
  const maxStrike = spot * 1.25;

  const parsed = [];
  for (const o of opts) {
    if (!o.option || o.open_interest == null) continue;
    const p = _parseOpt(o.option, underlying);
    if (p.expiry < todayStr || p.expiry > maxStr) continue;
    if (p.strike < minStrike || p.strike > maxStrike) continue;
    parsed.push({ ...p, oi: o.open_interest, iv: o.iv, gamma: o.gamma ?? 0, delta: o.delta ?? null });
  }

  if (parsed.length === 0) return null;

  // Build strike → { callOI, putOI, callIV, callGamma, putGamma, callDex, putDex } map
  const strikeMap = new Map();
  for (const o of parsed) {
    const e = strikeMap.get(o.strike) || { callOI: 0, putOI: 0, callIV: null, callGamma: 0, putGamma: 0, callDex: 0, putDex: 0 };
    if (o.type === 'C') {
      e.callOI    += o.oi;
      e.callGamma += o.gamma * o.oi;
      // DEX: dealers are short calls (sold to buyers), so their delta = -delta × OI
      // To hedge, they must hold +delta × OI units of underlying (buy futures)
      if (o.delta != null) e.callDex += o.delta * o.oi;
      if (e.callIV == null && o.iv != null) e.callIV = o.iv;
    } else {
      e.putOI    += o.oi;
      e.putGamma += o.gamma * o.oi;
      // Dealers are short puts, their delta = -delta × OI (delta is negative for puts)
      // To hedge: they hold delta × OI of underlying (sell futures for puts)
      if (o.delta != null) e.putDex += o.delta * o.oi;
    }
    strikeMap.set(o.strike, e);
  }

  const strikes = [...strikeMap.keys()].sort((a, b) => a - b);

  // OI Walls: top 3 strikes by combined OI
  const oiWalls = strikes
    .map(s => {
      const { callOI, putOI } = strikeMap.get(s);
      return { strike: s, totalOI: callOI + putOI };
    })
    .sort((a, b) => b.totalOI - a.totalOI)
    .slice(0, 3)
    .map(x => x.strike);

  // Max Pain: strike that minimizes total intrinsic value for all option buyers
  let maxPain = null, minPain = Infinity;
  for (const K of strikes) {
    let pain = 0;
    for (const S of strikes) {
      const { callOI, putOI } = strikeMap.get(S);
      pain += Math.max(0, S - K) * callOI;
      pain += Math.max(0, K - S) * putOI;
    }
    if (pain < minPain) { minPain = pain; maxPain = K; }
  }

  // P/C Ratio (by open interest)
  let totalCallOI = 0, totalPutOI = 0;
  for (const { callOI, putOI } of strikeMap.values()) {
    totalCallOI += callOI; totalPutOI += putOI;
  }
  const pcRatio = totalCallOI > 0 ? +(totalPutOI / totalCallOI).toFixed(3) : null;

  // ATM IV: call IV nearest to current spot
  let atmIV = null;
  let minDist = Infinity;
  for (const S of strikes) {
    const { callIV } = strikeMap.get(S);
    const dist = Math.abs(S - spot);
    if (dist < minDist && callIV != null) { minDist = dist; atmIV = +callIV.toFixed(4); }
  }

  // GEX (Gamma Exposure): per-strike net gamma (calls - puts), scaled by OI and spot.
  // Positive net GEX at a strike = calls dominate (dealers short calls → amplifying if broken)
  // Negative net GEX at a strike = puts dominate (dealers short puts → amplifying if broken)
  // Total GEX: positive = dealers net long gamma (stabilizing); negative = net short (trending)
  const CONTRACT_SIZE = 100;
  let cumGex = 0;
  const gexByStrike = [];
  for (const S of strikes) {
    const { callGamma, putGamma } = strikeMap.get(S);
    const gex = (callGamma - putGamma) * CONTRACT_SIZE * spot;
    cumGex += gex;
    gexByStrike.push({ strike: S, gex });
  }

  // Gamma flip: strike closest to spot where per-strike net GEX changes sign.
  // Scan outward from spot — this gives the actionable nearest flip level.
  let gexFlipStrike = null;
  const aboveSpot = gexByStrike.filter(g => g.strike >= spot).sort((a, b) => a.strike - b.strike);
  const belowSpot = gexByStrike.filter(g => g.strike <  spot).sort((a, b) => b.strike - a.strike);
  const scanOrder = [];
  for (let i = 0; i < Math.max(aboveSpot.length, belowSpot.length); i++) {
    if (i < aboveSpot.length) scanOrder.push(aboveSpot[i]);
    if (i < belowSpot.length) scanOrder.push(belowSpot[i]);
  }
  for (let i = 1; i < scanOrder.length; i++) {
    if ((scanOrder[i-1].gex >= 0 && scanOrder[i].gex < 0) ||
        (scanOrder[i-1].gex <= 0 && scanOrder[i].gex > 0)) {
      gexFlipStrike = scanOrder[i].strike;
      break;
    }
  }

  // Separate call and put walls (top OI strike per side)
  const topCallWall = strikes
    .map(s => ({ strike: s, oi: strikeMap.get(s).callOI }))
    .filter(x => x.strike > spot)
    .sort((a, b) => b.oi - a.oi)[0]?.strike ?? null;
  const topPutWall = strikes
    .map(s => ({ strike: s, oi: strikeMap.get(s).putOI }))
    .filter(x => x.strike < spot)
    .sort((a, b) => b.oi - a.oi)[0]?.strike ?? null;

  // ── DEX (Dealer Delta Exposure) ─────────────────────────────────────────────
  // Dealers are short the options they sold. To stay delta-neutral they hold an
  // offsetting position in the underlying (futures).
  //   Short call → dealer must BUY futures (+delta hedge) → bullish futures pressure
  //   Short put  → dealer must SELL futures (put delta is negative) → bearish pressure
  // Net DEX = sum of (callDelta × callOI) + (putDelta × putOI) across all strikes
  // Positive DEX: dealers net long futures as hedge → if they unwind (spot falls) they
  //   must sell, amplifying downside. Current posture is net buying support.
  // Negative DEX: dealers net short futures as hedge → if spot rises they must buy back,
  //   amplifying upside. Current posture is net selling pressure.
  let totalDex = 0;
  for (const { callDex, putDex } of strikeMap.values()) {
    totalDex += callDex + putDex; // putDex already negative (put delta < 0)
  }
  totalDex = Math.round(totalDex * CONTRACT_SIZE); // scale to contract units

  // DEX in futures price space (multiply by scaling ratio for NQ points interpretation)
  // Normalize to a −100 / +100 score for easy reading
  const allDexValues = [...strikeMap.values()].map(e => Math.abs((e.callDex + e.putDex) * CONTRACT_SIZE));
  const maxAbsDex    = allDexValues.reduce((s, v) => s + v, 0) || 1;
  const dexScore     = Math.round((totalDex / maxAbsDex) * 100); // −100 (max sell) to +100 (max buy)

  // DEX bias label
  const dexBias = dexScore > 20 ? 'bullish' : dexScore < -20 ? 'bearish' : 'neutral';

  // ── Resilience Score ─────────────────────────────────────────────────────────
  // Derived from GEX regime + DEX alignment. Measures how much the options market
  // is currently acting as a shock absorber (high resilience) vs amplifier (low resilience).
  //
  // Components:
  //   1. GEX sign: +50 if positive GEX (dealers long gamma = stabilizing), −50 if negative
  //   2. Distance from GEX flip: closer to flip = less certain regime = smaller contribution
  //   3. DEX alignment: DEX acting opposite to price direction = dealers absorbing = +bonus
  //
  // Result: 0–100 score. >60 = resilient (mean-reverting). <40 = fragile (trending/amplifying).
  const distFromFlip  = gexFlipStrike != null ? Math.abs(spot - gexFlipStrike) / spot : 0.05;
  const flipProximity = Math.min(distFromFlip / 0.05, 1); // 1 = far from flip, 0 = at flip
  const gexComponent  = cumGex > 0
    ? 50 + Math.round(flipProximity * 30)   // positive GEX: 50–80
    : 50 - Math.round(flipProximity * 30);  // negative GEX: 20–50
  // DEX alignment bonus: if dealers are net long (dexScore > 0) in a positive-GEX regime
  // or net short in a negative-GEX regime, the regime is self-reinforcing → less resilient
  const dexAligned = (cumGex > 0 && dexScore < 0) || (cumGex < 0 && dexScore > 0);
  const dexBonus    = dexAligned ? 15 : -10;
  const resilience  = Math.max(0, Math.min(100, gexComponent + dexBonus));

  const resilienceLabel = resilience >= 65 ? 'resilient'
                        : resilience >= 40 ? 'neutral'
                        : 'fragile';

  // ── Liquidity Zones ──────────────────────────────────────────────────────────
  // Clusters of adjacent strikes where combined OI is significantly elevated.
  // Adjacent strikes within 1 standard strike increment are grouped together.
  // Each cluster represents a zone where large open interest creates friction —
  // price slows, pins, or reacts sharply when breaking through.
  // bias: 'call' = overhead resistance liquidity, 'put' = below support liquidity,
  //       'balanced' = contested zone, likely pivot candidate
  const oiThreshold = (() => {
    const allOI = strikes.map(s => { const e = strikeMap.get(s); return e.callOI + e.putOI; });
    const sorted = [...allOI].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.70)] || 0; // top 30% by OI
  })();

  const liquidityZones = [];
  let clusterStrikes = [];
  for (let i = 0; i < strikes.length; i++) {
    const S = strikes[i];
    const { callOI, putOI } = strikeMap.get(S);
    if (callOI + putOI >= oiThreshold) {
      clusterStrikes.push(S);
    } else {
      if (clusterStrikes.length > 0) {
        const cOI = clusterStrikes.reduce((t, s) => t + strikeMap.get(s).callOI, 0);
        const pOI = clusterStrikes.reduce((t, s) => t + strikeMap.get(s).putOI, 0);
        const total = cOI + pOI;
        const balance = total > 0 ? Math.abs(cOI - pOI) / total : 1;
        liquidityZones.push({
          low:    clusterStrikes[0],
          high:   clusterStrikes[clusterStrikes.length - 1],
          center: clusterStrikes[Math.floor(clusterStrikes.length / 2)],
          totalOI: total,
          bias:   balance < 0.25 ? 'balanced' : cOI > pOI ? 'call' : 'put',
        });
        clusterStrikes = [];
      }
    }
    // Also flush at last strike
    if (i === strikes.length - 1 && clusterStrikes.length > 0) {
      const cOI = clusterStrikes.reduce((t, s) => t + strikeMap.get(s).callOI, 0);
      const pOI = clusterStrikes.reduce((t, s) => t + strikeMap.get(s).putOI, 0);
      const total = cOI + pOI;
      const balance = total > 0 ? Math.abs(cOI - pOI) / total : 1;
      liquidityZones.push({
        low:    clusterStrikes[0],
        high:   clusterStrikes[clusterStrikes.length - 1],
        center: clusterStrikes[Math.floor(clusterStrikes.length / 2)],
        totalOI: total,
        bias:   balance < 0.25 ? 'balanced' : cOI > pOI ? 'call' : 'put',
      });
    }
  }
  // Sort by OI descending, keep top 5 zones
  liquidityZones.sort((a, b) => b.totalOI - a.totalOI);
  const topLiquidityZones = liquidityZones.slice(0, 5);

  // ── Hedge Pressure Zones ─────────────────────────────────────────────────────
  // Strikes where dealer GEX is highest in absolute terms — where mechanical
  // hedging activity is most intense. Positive GEX at a strike = dealers buy dips
  // there (support pressure). Negative GEX = dealers sell rips there (resistance).
  // These are the levels where a price move triggers the MOST reactive hedging.
  const hedgePressureZones = gexByStrike
    .filter(g => Math.abs(g.gex) > 0)
    .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
    .slice(0, 5)
    .map(g => ({
      strike:    g.strike,
      gex:       Math.round(g.gex),
      pressure:  g.gex > 0 ? 'support' : 'resistance',  // dealers buy dips (support) or sell rips (resistance)
    }));

  // ── Pivot Candidates ─────────────────────────────────────────────────────────
  // Strikes where call OI ≈ put OI (balanced, within 25%) AND total OI is elevated.
  // These are contested levels with no dominant dealer direction — price can move
  // freely either way, making them natural turning points where neither side has
  // a clear mechanical edge. Also include max pain and the GEX flip.
  const medianOI = (() => {
    const sorted = strikes.map(s => { const e = strikeMap.get(s); return e.callOI + e.putOI; }).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 0;
  })();

  const pivotCandidates = strikes
    .map(s => {
      const { callOI, putOI } = strikeMap.get(s);
      const total   = callOI + putOI;
      const balance = total > 0 ? Math.abs(callOI - putOI) / total : 1;
      return { strike: s, balance, totalOI: total };
    })
    .filter(x => x.balance < 0.25 && x.totalOI >= medianOI) // balanced + significant OI
    .sort((a, b) => a.balance - b.balance)  // most balanced first
    .slice(0, 4);

  // ── Scale to futures price space ─────────────────────────────────────────────
  let scaledOiWalls = null, scaledMaxPain = null, scaledGexFlip = null;
  let scaledCallWall = null, scaledPutWall = null, scalingRatio = null;
  let scaledLiquidityZones = null, scaledHedgePressureZones = null, scaledPivotCandidates = null;
  if (futuresPrice != null && spot > 0) {
    scalingRatio    = futuresPrice / spot;
    scaledOiWalls   = oiWalls.map(s => Math.round(s * scalingRatio));
    scaledMaxPain   = maxPain        != null ? Math.round(maxPain        * scalingRatio) : null;
    scaledGexFlip   = gexFlipStrike  != null ? Math.round(gexFlipStrike  * scalingRatio) : null;
    scaledCallWall  = topCallWall    != null ? Math.round(topCallWall    * scalingRatio) : null;
    scaledPutWall   = topPutWall     != null ? Math.round(topPutWall     * scalingRatio) : null;
    scaledLiquidityZones = topLiquidityZones.map(z => ({
      ...z,
      low:    Math.round(z.low    * scalingRatio),
      high:   Math.round(z.high   * scalingRatio),
      center: Math.round(z.center * scalingRatio),
    }));
    scaledHedgePressureZones = hedgePressureZones.map(z => ({
      ...z, strike: Math.round(z.strike * scalingRatio),
    }));
    scaledPivotCandidates = pivotCandidates.map(z => ({
      ...z, strike: Math.round(z.strike * scalingRatio),
    }));
  }

  return {
    oiWalls, maxPain, pcRatio, atmIV,
    callWall: topCallWall, putWall: topPutWall,
    gexFlip: gexFlipStrike, totalGex: Math.round(cumGex),
    dex: totalDex, dexScore, dexBias,
    resilience, resilienceLabel,
    liquidityZones: topLiquidityZones,
    hedgePressureZones,
    pivotCandidates,
    etfPrice: spot,
    scaledOiWalls, scaledMaxPain, scaledGexFlip,
    scaledCallWall, scaledPutWall, scalingRatio,
    scaledLiquidityZones, scaledHedgePressureZones, scaledPivotCandidates,
  };
}

// ── Expiry-bucket HP computation ─────────────────────────────────────────────
// Splits the full options chain into DTE buckets and computes HP zones per bucket.
// Bucket 0 (0–14 DTE): daily/weekly — already covered by _computeMetrics
// Bucket 1 (15–60 DTE): monthly — standard monthly expiry territory
// Bucket 2 (61–120 DTE): quarterly — quarterly / near-term LEAPS
// Returns { weeklyMonthlyHP, quarterlyHP } or nulls for empty/insufficient buckets.

function _computeExpiryBucketHP(raw, scalingRatio) {
  const spot       = raw.current_price;
  const opts       = raw.options || [];
  const underlying = raw.symbol;
  if (!spot || spot <= 0) return { weeklyMonthlyHP: null, quarterlyHP: null };

  const today      = new Date();
  const todayStr   = today.toISOString().slice(0, 10);
  const maxDTE     = 120;
  const maxDate    = new Date(today.getTime() + maxDTE * 86400_000);
  const maxStr     = maxDate.toISOString().slice(0, 10);
  const minStrike  = spot * 0.75;
  const maxStrike  = spot * 1.25;
  const CONTRACT_SIZE = 100;

  // Parse all options within 120 DTE + strike range, compute DTE for each
  const allParsed = [];
  for (const o of opts) {
    if (!o.option || o.open_interest == null) continue;
    const p = _parseOpt(o.option, underlying);
    if (p.expiry < todayStr || p.expiry > maxStr) continue;
    if (p.strike < minStrike || p.strike > maxStrike) continue;
    const dte = Math.max(0, Math.round((new Date(p.expiry) - today) / 86400_000));
    allParsed.push({ ...p, oi: o.open_interest, gamma: o.gamma ?? 0, dte });
  }

  // Bucket definitions: [minDTE, maxDTE]
  const BUCKETS = [
    { name: 'daily',     min: 0,  max: 14 },   // bucket 0 — already in _computeMetrics, skip
    { name: 'monthly',   min: 15, max: 60 },    // bucket 1
    { name: 'quarterly', min: 61, max: 120 },   // bucket 2
  ];

  function _hpForBucket(contracts, topN) {
    // Build strike → { callGamma, putGamma } map
    const strikeMap = new Map();
    for (const c of contracts) {
      const e = strikeMap.get(c.strike) || { callGamma: 0, putGamma: 0, totalOI: 0 };
      if (c.type === 'C') { e.callGamma += c.gamma * c.oi; }
      else                { e.putGamma  += c.gamma * c.oi; }
      e.totalOI += c.oi;
      strikeMap.set(c.strike, e);
    }

    // Count strikes with OI > 0
    let strikesWithOI = 0;
    for (const e of strikeMap.values()) { if (e.totalOI > 0) strikesWithOI++; }
    if (strikesWithOI < 10) return null; // insufficient data

    // Compute GEX per strike
    const gexByStrike = [];
    let bucketTotalOI = 0;
    for (const [strike, e] of strikeMap) {
      const gex = (e.callGamma - e.putGamma) * CONTRACT_SIZE * spot;
      gexByStrike.push({ strike, gex });
      bucketTotalOI += e.totalOI;
    }

    // Top N by |GEX|
    const zones = gexByStrike
      .filter(g => Math.abs(g.gex) > 0)
      .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
      .slice(0, topN)
      .map(g => ({
        strike:   g.strike,
        gex:      Math.round(g.gex),
        pressure: g.gex > 0 ? 'support' : 'resistance',
        scaled:   scalingRatio != null ? Math.round(g.strike * scalingRatio) : null,
      }));

    if (zones.length === 0) return null;

    // DTE range actually present in this bucket
    const dtes = contracts.map(c => c.dte);
    return {
      zones,
      totalOI: bucketTotalOI,
      bucketDTE: { min: Math.min(...dtes), max: Math.max(...dtes) },
    };
  }

  // Bucket 1 — monthly (DTE 15–60), top 3 zones
  const monthlyContracts   = allParsed.filter(c => c.dte >= BUCKETS[1].min && c.dte <= BUCKETS[1].max);
  const weeklyMonthlyHP    = _hpForBucket(monthlyContracts, 3);

  // Bucket 2 — quarterly (DTE 61–120), top 3 zones
  const quarterlyContracts = allParsed.filter(c => c.dte >= BUCKETS[2].min && c.dte <= BUCKETS[2].max);
  const quarterlyHP        = _hpForBucket(quarterlyContracts, 3);

  return { weeklyMonthlyHP, quarterlyHP };
}

// ── Scale daily ETF levels to futures price space ────────────────────────────

function _scaleDailyLevels(daily, ratio) {
  if (!daily || ratio == null) return null;
  return {
    prevDayOpen:  daily.prevDayOpen  != null ? Math.round(daily.prevDayOpen  * ratio) : null,
    prevDayClose: daily.prevDayClose != null ? Math.round(daily.prevDayClose * ratio) : null,
    curDayOpen:   daily.curDayOpen   != null ? Math.round(daily.curDayOpen   * ratio) : null,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns options metrics for a symbol with 1-hour caching.
 *
 * Data source priority:
 *   1. Databento OPRA live TCP (features.liveOpra=true AND opraLive has OI data)
 *   2. CBOE delayed quotes API (fallback; always available)
 *
 * Returns scaled* fields (in futures price space) when futuresPrice is provided.
 * Return shape is identical regardless of which source is used.
 *
 * @param {string} symbol        'MNQ' | 'MES' | 'MGC' | 'MCL'
 * @param {number|null} futuresPrice  Current futures price for strike scaling (optional)
 */
async function getOptionsData(symbol, futuresPrice) {
  const etf      = ETF_PROXY[symbol];
  if (!etf) return null;

  // Helper: build the live ratio, preferring same-source Yahoo prices over the
  // passed futuresPrice (which comes from stale seed candles and may be minutes old).
  function _liveRatio(d, fp) {
    if (d?.daily?.liveFuturesPrice && d?.daily?.liveEtfPrice && d.daily.liveEtfPrice > 0) {
      return d.daily.liveFuturesPrice / d.daily.liveEtfPrice;
    }
    // Fallback: use futuresPrice from seed candles (caller-supplied)
    if (fp != null && d?.etfPrice > 0) return fp / d.etfPrice;
    return null;
  }

  // ── Check OPRA live source ────────────────────────────────────────────────
  // Use Databento OPRA data when:
  //   a) features.liveOpra is true (hot-toggle safe — settings is a mutable reference)
  //   b) opraLive has accumulated OI data for this ETF (hasData=true)
  //   c) OPRA data is only available for QQQ/SPY proxies (same as CBOE primary targets)
  const liveOpraEnabled = settings.features?.liveOpra === true;
  if (liveOpraEnabled) {
    try {
      const opraLive = _getOpraLive();
      const chain    = opraLive.getOpraRawChain(etf);
      if (chain?.hasData) {
        // Re-use existing daily levels fetch (Yahoo) for spot price and scaling ratio.
        // This ensures consistent daily levels (prevDayOpen/Close/curDayOpen) regardless
        // of which options source is active.
        const futYahoo = FUTURES_YAHOO[symbol] ?? null;
        const daily    = await _fetchDailyLevels(etf, futYahoo);

        const liveFut = daily?.liveFuturesPrice ?? null;
        const liveEtf = daily?.liveEtfPrice     ?? null;
        const bestFp  = (liveFut && liveEtf && liveEtf > 0) ? liveFut : futuresPrice;

        // Build CBOE-compatible raw structure from the OPRA strike map.
        // current_price must be the ETF spot (used by _computeMetrics for strike ±25%
        // filtering and as the base for GEX scaling).  We require the live ETF price
        // from Yahoo — if unavailable, fall through to CBOE which also fetches it.
        const fakeRaw = {
          current_price: liveEtf,
          symbol:  etf,
          options: chain.options,
        };

        // current_price is required; fall back to CBOE if we don't have it
        if (fakeRaw.current_price != null && fakeRaw.current_price > 0) {
          const metrics = _computeMetrics(fakeRaw, bestFp);
          if (metrics) {
            const result = {
              ...metrics,
              source:     etf,
              dataSource: 'opra-live',
              daily:      daily ?? null,
              lastFetchedAt: Date.now(),
            };
            // Cache with shorter TTL for live data (5 min) to pick up OI updates
            _cache.set(symbol, { data: result, timestamp: Date.now() - (CACHE_TTL_MS - 5 * 60 * 1000) });
            if (result.scalingRatio != null) {
              result.scaledDaily = _scaleDailyLevels(result.daily, result.scalingRatio);
            }
            // Expiry-bucket HP (monthly + quarterly)
            const bucketHP = _computeExpiryBucketHP(fakeRaw, result.scalingRatio);
            result.weeklyMonthlyHP = bucketHP.weeklyMonthlyHP;
            result.quarterlyHP     = bucketHP.quarterlyHP;

            const maxStr  = result.scaledMaxPain ?? result.maxPain;
            const flipStr = result.scaledGexFlip ?? result.gexFlip;
            const dl      = result.scaledDaily;
            const st      = opraLive.getOpraStatus();
            console.log(
              `[options] ${symbol} via OPRA live (${etf}): ` +
              `maxPain=${maxStr} gexFlip=${flipStr} pc=${result.pcRatio} atmIV=${result.atmIV} ` +
              `ratio=${result.scalingRatio?.toFixed(3) ?? '—'} ` +
              `pdO=${dl?.prevDayOpen} pdC=${dl?.prevDayClose} cdO=${dl?.curDayOpen} ` +
              `strikes=${st.strikeCount}` +
              ` mHP=${bucketHP.weeklyMonthlyHP?.zones?.length ?? 0} qHP=${bucketHP.quarterlyHP?.zones?.length ?? 0}`
            );
            return result;
          }
        }
        // If metrics computation failed (e.g. no near-term options), fall through to CBOE
        console.warn(`[options] ${symbol} OPRA chain has data but _computeMetrics failed — falling back to CBOE`);
      }
    } catch (err) {
      console.warn(`[options] ${symbol} OPRA live error: ${err.message} — falling back to CBOE`);
    }
  }

  // ── CBOE delayed quotes (existing path — unchanged) ───────────────────────

  const cached = _cache.get(symbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const d = cached.data;
    const ratio = _liveRatio(d, futuresPrice);
    if (d && ratio != null) {
      return {
        ...d,
        scalingRatio:   ratio,
        scaledOiWalls:  d.oiWalls.map(s => Math.round(s * ratio)),
        scaledMaxPain:  d.maxPain  != null ? Math.round(d.maxPain  * ratio) : null,
        scaledGexFlip:  d.gexFlip  != null ? Math.round(d.gexFlip  * ratio) : null,
        scaledCallWall: d.callWall != null ? Math.round(d.callWall * ratio) : null,
        scaledPutWall:  d.putWall  != null ? Math.round(d.putWall  * ratio) : null,
        scaledDaily:    _scaleDailyLevels(d.daily, ratio),
      };
    }
    return d;
  }

  const futYahoo = FUTURES_YAHOO[symbol] ?? null;
  const [raw, daily] = await Promise.all([_fetchCBOE(etf), _fetchDailyLevels(etf, futYahoo)]);
  if (!raw) {
    _cache.set(symbol, { data: null, timestamp: Date.now() });
    return null;
  }

  // Determine best ratio: live Yahoo prices (same-source, same-time) > passed futuresPrice
  const liveFut = daily?.liveFuturesPrice ?? null;
  const liveEtf = daily?.liveEtfPrice ?? null;
  const bestFp  = (liveFut && liveEtf && liveEtf > 0) ? liveFut : futuresPrice;

  const metrics = _computeMetrics(raw, bestFp);
  if (!metrics) { _cache.set(symbol, { data: null, timestamp: Date.now() }); return null; }

  const result = { ...metrics, source: etf, dataSource: 'cboe', daily: daily ?? null, lastFetchedAt: Date.now() };
  _cache.set(symbol, { data: result, timestamp: Date.now() });

  // Scale daily levels with the same ratio used for options strikes
  if (result.scalingRatio != null) {
    result.scaledDaily = _scaleDailyLevels(result.daily, result.scalingRatio);
  }

  // Expiry-bucket HP (monthly + quarterly)
  const bucketHP = _computeExpiryBucketHP(raw, result.scalingRatio);
  result.weeklyMonthlyHP = bucketHP.weeklyMonthlyHP;
  result.quarterlyHP     = bucketHP.quarterlyHP;

  if (result) {
    const maxStr  = result.scaledMaxPain ?? result.maxPain;
    const flipStr = result.scaledGexFlip ?? result.gexFlip;
    const dl      = result.scaledDaily;
    const src     = liveFut ? 'live Yahoo' : 'seed candle';
    console.log(`[options] ${symbol} via ${etf}: maxPain=${maxStr} gexFlip=${flipStr} pc=${result.pcRatio} atmIV=${result.atmIV} ratio=${result.scalingRatio?.toFixed(3) ?? '—'} (${src}) pdO=${dl?.prevDayOpen} pdC=${dl?.prevDayClose} cdO=${dl?.curDayOpen} mHP=${bucketHP.weeklyMonthlyHP?.zones?.length ?? 0} qHP=${bucketHP.quarterlyHP?.zones?.length ?? 0}`);
  } else {
    console.warn(`[options] ${symbol} via ${etf}: fetch OK but no near-term options found`);
  }

  return result;
}

module.exports = { getOptionsData };
