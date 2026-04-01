'use strict';
// Fetches OHLCV candles from Coinbase International Exchange for crypto perps.
// Public REST endpoint — no API key required for market data.
//
// Instruments: BTC-PERP, ETH-PERP, XRP-PERP
// Base URL: https://api.international.coinbase.com/api/v1/instruments/{instrument}/candles
//
// Can be used two ways:
//   1. CLI:    node server/data/coinbaseFetch.js
//   2. Module: const { fetchAllCrypto } = require('./coinbaseFetch'); await fetchAllCrypto();

const fs   = require('fs');
const path = require('path');

const SEED_DIR      = path.join(__dirname, '..', '..', 'data', 'seed');
const COINBASE_BASE = 'https://api.international.coinbase.com/api/v1/instruments';
const MAX_BARS      = 300; // Coinbase max candles per request

const CRYPTO_INSTRUMENTS = {
  BTC: 'BTC-PERP',
  ETH: 'ETH-PERP',
  XRP: 'XRP-PERP',
  XLM: 'XLM-PERP',
};

// Granularities natively supported by Coinbase INTX + number of bars per day
const GRANULARITIES = [
  { tf: '5m',  cb: 'FIVE_MINUTE',    secsPerBar: 300,   days: 30 },
  { tf: '15m', cb: 'FIFTEEN_MINUTE', secsPerBar: 900,   days: 30 },
  { tf: '30m', cb: 'THIRTY_MINUTE',  secsPerBar: 1800,  days: 60 },
  { tf: '1h',  cb: 'ONE_HOUR',       secsPerBar: 3600,  days: 60 },
  { tf: '2h',  cb: 'TWO_HOUR',       secsPerBar: 7200,  days: 60 },
];
// 4h is not natively supported — derived by aggregating 4× 1h candles

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function _fetchPage(instrument, granularity, startMs, endMs) {
  const startISO = new Date(startMs).toISOString();
  const endISO   = new Date(endMs).toISOString();
  const url = `${COINBASE_BASE}/${instrument}/candles?granularity=${granularity}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;
  console.log(`  GET ${url}`);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Coinbase returned HTTP ${res.status} for ${instrument} ${granularity}`);
  }

  const json = await res.json();
  // Coinbase INTX returns { aggregations: [...] } (not 'candles')
  return json.aggregations || json.candles || [];
}

/**
 * Fetch all candles for a given instrument + granularity over `days` of history.
 * Paginates automatically when the range would exceed MAX_BARS per request.
 *
 * @returns {Array} Normalized candles sorted ascending: [{time,open,high,low,close,volume}]
 */
async function _fetchCoinbase(instrument, granularity, secsPerBar, days) {
  const nowMs   = Date.now();
  const startMs = nowMs - days * 24 * 60 * 60 * 1000;

  // Number of bars in the requested range
  const totalBars = Math.ceil((nowMs - startMs) / 1000 / secsPerBar);

  let allRaw = [];

  if (totalBars <= MAX_BARS) {
    allRaw = await _fetchPage(instrument, granularity, startMs, nowMs);
  } else {
    // Split into windows of MAX_BARS bars each (working backwards from now)
    const windowMs = MAX_BARS * secsPerBar * 1000;
    let windowEnd  = nowMs;

    while (windowEnd > startMs) {
      const windowStart = Math.max(startMs, windowEnd - windowMs);
      const page = await _fetchPage(instrument, granularity, windowStart, windowEnd);
      allRaw = allRaw.concat(page);
      windowEnd = windowStart;
      // Polite delay between paginated requests
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Normalize: Coinbase returns { start, open, high, low, close, volume }
  // `start` is an ISO 8601 string
  const candles = allRaw
    .map(c => ({
      time:   Math.floor(new Date(c.start).getTime() / 1000),
      open:   +c.open,
      high:   +c.high,
      low:    +c.low,
      close:  +c.close,
      volume: +c.volume,
    }))
    .filter(c => !isNaN(c.open) && !isNaN(c.high) && !isNaN(c.low) && !isNaN(c.close));

  // Deduplicate by time, then sort ascending
  const seen = new Map();
  for (const c of candles) seen.set(c.time, c);
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Aggregation (same logic as seedFetch.js aggregate())
// ---------------------------------------------------------------------------

function _aggregate(symbol, tf, sourceCandles, n) {
  const result = [];
  for (let i = 0; i < sourceCandles.length; i += n) {
    const slice = sourceCandles.slice(i, i + n);
    if (!slice.length) continue;
    result.push({
      time:   slice[0].time,
      open:   slice[0].open,
      high:   Math.max(...slice.map(c => c.high)),
      low:    Math.min(...slice.map(c => c.low)),
      close:  slice[slice.length - 1].close,
      volume: slice.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return { symbol, timeframe: tf, candles: result };
}

// ---------------------------------------------------------------------------
// fetchAllCrypto — fetches all symbols × timeframes and writes to data/seed/
// ---------------------------------------------------------------------------

async function fetchAllCrypto() {
  fs.mkdirSync(SEED_DIR, { recursive: true });

  for (const [symbol, instrument] of Object.entries(CRYPTO_INSTRUMENTS)) {
    console.log(`[coinbaseFetch] ── ${symbol} (${instrument}) ──`);

    for (const { tf, cb, secsPerBar, days } of GRANULARITIES) {
      try {
        const candles = await _fetchCoinbase(instrument, cb, secsPerBar, days);
        const outPath = path.join(SEED_DIR, `${symbol}_${tf}.json`);
        fs.writeFileSync(outPath, JSON.stringify({ symbol, timeframe: tf, candles }, null, 2));
        console.log(`[coinbaseFetch] ${symbol} ${tf}  ${candles.length} candles → ${outPath}`);
      } catch (err) {
        console.warn(`[coinbaseFetch] ${symbol} ${tf}: ${err.message} — skipping`);
      }
      // Polite delay between requests
      await new Promise(r => setTimeout(r, 500));
    }

    // Derive 4h by aggregating 1h (4 bars → 1 bar)
    const oneHPath = path.join(SEED_DIR, `${symbol}_1h.json`);
    if (fs.existsSync(oneHPath)) {
      const oneH  = JSON.parse(fs.readFileSync(oneHPath, 'utf8'));
      const fourH = _aggregate(symbol, '4h', oneH.candles, 4);
      const fourHPath = path.join(SEED_DIR, `${symbol}_4h.json`);
      fs.writeFileSync(fourHPath, JSON.stringify(fourH, null, 2));
      console.log(`[coinbaseFetch] ${symbol} 4h  ${fourH.candles.length} candles → ${fourHPath} (derived from 1h)`);
    } else {
      console.warn(`[coinbaseFetch] ${symbol}: 1h file missing — cannot derive 4h`);
    }
  }
}

// ---------------------------------------------------------------------------
// Module export + CLI entry point
// ---------------------------------------------------------------------------

module.exports = { fetchAllCrypto };

if (require.main === module) {
  fetchAllCrypto()
    .then(() => console.log('\nCoinbase fetch complete.'))
    .catch(err => {
      console.error('\nCoinbase fetch failed:', err.message);
      process.exit(1);
    });
}
