'use strict';
// OHLCV seed fetcher — Yahoo Finance → data/seed/*.json
//
// Can be used two ways:
//   1. CLI:    node server/data/seedFetch.js   (one-shot refresh)
//   2. Module: const { fetchAll } = require('./seedFetch'); await fetchAll();
//              Called by server/index.js every 15 minutes in seed mode.
//              In live mode, replace the setInterval in index.js with a broker
//              WebSocket candle-close subscription — fetchAll() is not needed.

const fs   = require('fs');
const path = require('path');

const SEED_DIR = path.join(__dirname, '..', '..', 'data', 'seed');

// Yahoo Finance symbols for the contracts we care about.
// NQ=F and GC=F are the full-size contracts — price is identical to MNQ/MGC.
const SYMBOLS = {
  MNQ: 'NQ=F',
  MGC: 'GC=F',
};

// Yahoo Finance supports: 1m (max 7d), 2m (max 60d), 5m (max 60d), 15m (max 60d).
// 3m is not native — we derive it by aggregating 1m candles after the fetch.
const TIMEFRAMES = [
  { tf: '1m',  yf: '1m',  range: '5d'  },
  { tf: '2m',  yf: '2m',  range: '5d'  },
  { tf: '5m',  yf: '5m',  range: '30d' },
  { tf: '15m', yf: '15m', range: '30d' },
];

// ---------------------------------------------------------------------------
// Fetch + normalize
// ---------------------------------------------------------------------------

async function fetchYahoo(yfSymbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=${interval}&range=${range}`;
  console.log(`  GET ${url}`);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance returned HTTP ${res.status} for ${yfSymbol} ${interval}`);
  }

  return res.json();
}

function normalize(symbol, timeframe, raw) {
  const result = raw?.chart?.result?.[0];
  if (!result) throw new Error(`No chart result in Yahoo response for ${symbol} ${timeframe}`);

  const timestamps = result.timestamp ?? [];
  const { open, high, low, close, volume } = result.indicators.quote[0];

  const candles = timestamps
    .map((t, i) => ({
      time:   t,
      open:   open[i],
      high:   high[i],
      low:    low[i],
      close:  close[i],
      volume: volume[i] ?? 0,
    }))
    // Drop any candles with null OHLC (gaps in Yahoo data)
    .filter(c => c.open != null && c.high != null && c.low != null && c.close != null);

  return { symbol, timeframe, candles };
}

// Aggregate fine candles into a coarser timeframe (e.g. 1m → 3m)
function aggregate(symbol, sourceCandles, minutes) {
  const result = [];
  for (let i = 0; i < sourceCandles.length; i += minutes) {
    const slice = sourceCandles.slice(i, i + minutes);
    if (slice.length === 0) continue;
    result.push({
      time:   slice[0].time,
      open:   slice[0].open,
      high:   Math.max(...slice.map(c => c.high)),
      low:    Math.min(...slice.map(c => c.low)),
      close:  slice[slice.length - 1].close,
      volume: slice.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return { symbol, timeframe: '3m', candles: result };
}

// ---------------------------------------------------------------------------
// fetchAll — fetches all symbols × timeframes and writes to data/seed/
// ---------------------------------------------------------------------------

async function fetchAll() {
  fs.mkdirSync(SEED_DIR, { recursive: true });

  for (const [symbol, yfSymbol] of Object.entries(SYMBOLS)) {
    console.log(`[seedFetch] ── ${symbol} (${yfSymbol}) ──`);

    for (const { tf, yf, range } of TIMEFRAMES) {
      const raw        = await fetchYahoo(yfSymbol, yf, range);
      const normalized = normalize(symbol, tf, raw);
      const outPath    = path.join(SEED_DIR, `${symbol}_${tf}.json`);
      fs.writeFileSync(outPath, JSON.stringify(normalized, null, 2));
      console.log(`[seedFetch] ${symbol} ${tf}  ${normalized.candles.length} candles → ${outPath}`);

      // Be polite — Yahoo will rate-limit aggressive scrapers
      await new Promise(r => setTimeout(r, 600));
    }

    // Derive 3m by aggregating the 1m candles we just wrote
    const oneMPath   = path.join(SEED_DIR, `${symbol}_1m.json`);
    const oneM       = JSON.parse(fs.readFileSync(oneMPath, 'utf8'));
    const threeM     = aggregate(symbol, oneM.candles, 3);
    const threeMPath = path.join(SEED_DIR, `${symbol}_3m.json`);
    fs.writeFileSync(threeMPath, JSON.stringify(threeM, null, 2));
    console.log(`[seedFetch] ${symbol} 3m  ${threeM.candles.length} candles → ${threeMPath} (derived)`);
  }
}

// ---------------------------------------------------------------------------
// Module export + CLI entry point
// ---------------------------------------------------------------------------

module.exports = { fetchAll };

// CLI: "node server/data/seedFetch.js" still works as before
if (require.main === module) {
  fetchAll()
    .then(() => console.log('\nSeed fetch complete.'))
    .catch(err => {
      console.error('\nSeed fetch failed:', err.message);
      process.exit(1);
    });
}
