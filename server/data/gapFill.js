'use strict';
// server/data/gapFill.js — Automatic candle gap detection and backfill
//
// Ensures the in-memory candle store has continuous bars with no gaps
// for all active CME futures symbols. Crypto symbols are skipped.
//
// Two modes of operation:
//   1. One-time fill at startup (after seed data loads, before live feed starts)
//   2. Periodic scheduler every GAP_FILL_INTERVAL_MS (catches feed interruption gaps)
//
// Data sources (in priority order):
//   1. Historical 1m files on disk: data/historical/futures/{SYMBOL}/1m/{DATE}.json
//   2. Yahoo Finance fallback (same pattern as seedFetch.js)

const fs   = require('fs');
const path = require('path');
const { getCandles, injectBars, aggregateBarsToTF, sanitizeCandles, LIVE_FUTURES } = require('./snapshot');
const { TICK_SPIKE_THRESHOLD } = require('./databento');

const SEED_DIR = path.join(__dirname, '..', '..', 'data', 'seed');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Per-timeframe gap fill intervals — 1m gaps are immediately visible on the chart,
// so check frequently. Higher TFs can afford slower intervals.
const GAP_FILL_INTERVAL_1M_MS  = 2 * 60 * 1000;   // 2 minutes — 1m gaps are 15 missing bars in 15 min
const GAP_FILL_INTERVAL_5M_MS  = 5 * 60 * 1000;   // 5 minutes
const GAP_FILL_INTERVAL_HTF_MS = 15 * 60 * 1000;   // 15 minutes for 15m/30m

const HISTORICAL_DIR = path.join(__dirname, '..', '..', 'data', 'historical', 'futures');

// TF seconds lookup
const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800 };

// Yahoo Finance symbol map (CME futures only)
// For gap fill fallback (5d range), micro tickers are fine.
const YAHOO_SYMBOLS = {
  MNQ: 'MNQ=F',
  MGC: 'MGC=F',
  MES: 'MES=F',
  MCL: 'MCL=F',
  SIL: 'SI=F',
  M2K: 'M2K=F',
  MYM: 'MYM=F',
  MHG: 'HG=F',
};

// For 60-day backfill, use full-size tickers where micros have thin Yahoo data
const YAHOO_BACKFILL_SYMBOLS = {
  MNQ: 'MNQ=F',
  MES: 'MES=F',
  MGC: 'GC=F',    // full-size Gold — same price, better Yahoo coverage
  MCL: 'CL=F',    // full-size Crude
  SIL: 'SI=F',    // full-size Silver
  M2K: 'RTY=F',   // full-size Russell 2000
  MYM: 'MYM=F',
  MHG: 'HG=F',    // full-size Copper
};

// Crypto symbols — skip gap fill entirely
const CRYPTO = new Set(['BTC', 'ETH', 'XRP', 'XLM']);

// ---------------------------------------------------------------------------
// Yahoo bar sanitization — spike filter before storage
// ---------------------------------------------------------------------------

/**
 * Sanitize Yahoo Finance bars before storing. Removes null/zero bars and
 * bars with close-to-close deviation exceeding 3× the per-symbol tick threshold.
 * Uses 3× (not 1×) because Yahoo 5m/1m historical bars represent real multi-minute
 * price ranges with naturally larger close-to-close moves than individual 1s ticks.
 *
 * @param {string} symbol   Internal symbol
 * @param {Array}  bars     Raw Yahoo bars
 * @returns {Array} Sanitized bar array
 */
function _sanitizeYahooBars(symbol, bars) {
  if (!bars || bars.length === 0) return bars;

  const threshold = (TICK_SPIKE_THRESHOLD[symbol] || 0.02) * 2;  // 2× tick threshold (tightened from 3× in v14.25)
  const sanitized = [];
  let prevClose = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // Basic null/zero guard
    if (!bar.close || bar.close <= 0 || isNaN(bar.close)) {
      console.warn(`[BACKFILL-SANITIZE] ${symbol} skipping null/zero bar at ${bar.time}`);
      continue;
    }
    if (!bar.open || bar.open <= 0 || isNaN(bar.open)) {
      console.warn(`[BACKFILL-SANITIZE] ${symbol} skipping null/zero open at ${bar.time}`);
      continue;
    }
    // Spike check vs prior close
    if (prevClose !== null) {
      const deviation = Math.abs(bar.close - prevClose) / prevClose;
      if (deviation > threshold) {
        console.warn(
          `[BACKFILL-SANITIZE] ${symbol} skipping spike bar at ${bar.time}: ` +
          `close=${bar.close} prev=${prevClose} dev=${(deviation * 100).toFixed(1)}%`
        );
        continue;
      }
    }
    // Range sanity check: discard bar if high-low range > 10× recent median range
    // Uses 10× (not 5×) because 1m bars during high-volatility events (e.g. tariff
    // announcements, FOMC) legitimately have 5-8× normal range.
    const barRange = bar.high - bar.low;
    if (barRange > 0 && sanitized.length >= 3) {
      const recentRanges = [];
      for (let j = Math.max(0, sanitized.length - 10); j < sanitized.length; j++) {
        const r = sanitized[j].high - sanitized[j].low;
        if (r > 0) recentRanges.push(r);
      }
      if (recentRanges.length >= 3) {
        recentRanges.sort((a, b) => a - b);
        const medianRange = recentRanges[Math.floor(recentRanges.length / 2)];
        if (medianRange > 0 && barRange > medianRange * 10) {
          console.warn(
            `[BACKFILL-SANITIZE] ${symbol} skipping wide-range bar at ${bar.time}: ` +
            `range=${barRange.toFixed(2)} median=${medianRange.toFixed(2)} (${(barRange / medianRange).toFixed(1)}×)`
          );
          continue;
        }
      }
    }
    sanitized.push(bar);
    prevClose = bar.close;
  }

  console.log(`[BACKFILL-SANITIZE] ${symbol}: ${bars.length} raw → ${sanitized.length} clean bars`);
  return sanitized;
}

let _schedulerTimers = [];  // array of interval timers (one per TF group)

// ---------------------------------------------------------------------------
// Historical file reader
// ---------------------------------------------------------------------------

/**
 * Read 1m bars from historical files for a date range.
 * Files are at data/historical/futures/{SYMBOL}/1m/{YYYY-MM-DD}.json
 * Each file is a JSON array of { ts, open, high, low, close, volume }.
 *
 * @param {string} symbol  Internal symbol, e.g. 'MNQ'
 * @param {number} fromTs  Start Unix timestamp (seconds)
 * @param {number} toTs    End Unix timestamp (seconds)
 * @returns {Array} Normalized candle array with { time, open, high, low, close, volume }
 */
function _readHistoricalBars(symbol, fromTs, toTs) {
  const dir = path.join(HISTORICAL_DIR, symbol, '1m');
  if (!fs.existsSync(dir)) return [];

  // Determine date range to scan
  const startDate = new Date(fromTs * 1000);
  const endDate   = new Date(toTs * 1000);
  const bars      = [];

  // Iterate each day from startDate to endDate
  const d = new Date(startDate);
  d.setUTCHours(0, 0, 0, 0);

  while (d <= endDate) {
    const dateStr = d.toISOString().substring(0, 10);
    const filePath = path.join(dir, `${dateStr}.json`);

    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const bar of raw) {
          // Normalize timestamp: align to nearest minute boundary
          const rawTime = bar.ts ?? bar.time;
          const time = Math.floor(rawTime / 60) * 60;
          if (time >= fromTs && time <= toTs) {
            bars.push({
              time,
              open:   bar.open,
              high:   bar.high,
              low:    bar.low,
              close:  bar.close,
              volume: bar.volume ?? 0,
            });
          }
        }
      } catch (err) {
        console.warn(`[gapfill] Failed to read ${filePath}: ${err.message}`);
      }
    }

    d.setUTCDate(d.getUTCDate() + 1);
  }

  // Sanitize historical bars before returning — removes spikes and extreme wicks
  // that may exist in raw Databento/Yahoo historical files
  return sanitizeCandles(symbol, bars.sort((a, b) => a.time - b.time));
}

// ---------------------------------------------------------------------------
// Seed file writer — bootstrap symbols with no seed data from historical files
// ---------------------------------------------------------------------------

/**
 * Write candle data as a seed-format JSON file so getCandles() picks it up
 * via _fromSeed(). Same format as seedFetch.js output.
 */
function _writeSeedFile(symbol, tf, bars) {
  fs.mkdirSync(SEED_DIR, { recursive: true });
  const outPath = path.join(SEED_DIR, `${symbol}_${tf}.json`);
  const data = { symbol, timeframe: tf, candles: bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })) };
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`[gapfill] Wrote seed file: ${symbol}_${tf}.json (${bars.length} bars)`);
}

// ---------------------------------------------------------------------------
// Yahoo Finance fallback
// ---------------------------------------------------------------------------

/**
 * Fetch recent bars from Yahoo Finance for a symbol.
 * Returns normalized 1m candle array.
 */
async function _fetchYahooFallback(symbol) {
  const yfSymbol = YAHOO_SYMBOLS[symbol];
  if (!yfSymbol) return [];

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfSymbol}?interval=1m&range=5d`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      console.warn(`[gapfill] Yahoo Finance returned HTTP ${res.status} for ${yfSymbol}`);
      return [];
    }

    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp ?? [];
    const { open, high, low, close, volume } = result.indicators.quote[0];

    return timestamps
      .map((t, i) => ({
        time:   t,
        open:   open[i],
        high:   high[i],
        low:    low[i],
        close:  close[i],
        volume: volume[i] ?? 0,
      }))
      .filter(c => c.open != null && c.high != null && c.low != null && c.close != null);
  } catch (err) {
    console.warn(`[gapfill] Yahoo Finance fetch failed for ${symbol}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core gap fill logic
// ---------------------------------------------------------------------------

/**
 * Detect and fill gaps in the candle store for a single symbol/timeframe.
 *
 * @param {string} symbol  Internal symbol, e.g. 'MNQ'
 * @param {string} tf      Timeframe, e.g. '1m', '5m', '15m', '30m'
 * @returns {Promise<number>} Number of bars backfilled
 */
async function fillCandleGaps(symbol, tf) {
  // Skip crypto — no historical files, different data source
  if (CRYPTO.has(symbol)) return 0;

  const tfSec = TF_SECONDS[tf];
  if (!tfSec) return 0;

  const candles = getCandles(symbol, tf);
  const nowTs   = Math.floor(Date.now() / 1000);
  const beforeCount = candles ? candles.length : 0;

  // Bootstrap from historical files: either no candles at all, or low coverage
  // that indicates a prior bad seed (e.g., SIL had wrong Yahoo ticker).
  // Threshold: if 5m bar count < 4000, historical 1m files likely have better coverage.
  const MIN_5M_COVERAGE = 4000;
  const needsBootstrap = !candles || candles.length === 0;
  const needsRebootstrap = tf === '1m' && candles && candles.length > 0 && (() => {
    const candles5m = getCandles(symbol, '5m');
    return candles5m && candles5m.length < MIN_5M_COVERAGE;
  })();

  if (needsBootstrap || needsRebootstrap) {
    // No candles or low coverage — try to bootstrap from historical files on disk.
    // Writes seed-format files so getCandles() picks them up via _fromSeed()
    // without hitting the MAX_LIVE_BARS cap in injectBars().
    if (tf === '1m') {
      const sixtyDaysAgo = nowTs - (60 * 24 * 3600);
      const histBars = _readHistoricalBars(symbol, sixtyDaysAgo, nowTs);
      if (histBars.length > 0) {
        // Only re-bootstrap if historical data is actually better than what we have
        if (needsRebootstrap) {
          const hist5mApprox = Math.floor(histBars.length / 5);
          const current5m = getCandles(symbol, '5m')?.length ?? 0;
          if (hist5mApprox <= current5m) {
            // Historical data isn't better — skip re-bootstrap
            console.log(`[gapfill] ${symbol}: historical ~${hist5mApprox} 5m bars ≤ current ${current5m} — skipping re-bootstrap`);
          } else {
            console.log(`[gapfill] ${symbol}: low coverage detected (${current5m} 5m bars < ${MIN_5M_COVERAGE}), re-bootstrapping from historical (${histBars.length.toLocaleString()} 1m bars → ~${hist5mApprox} 5m)`);
            _writeSeedFile(symbol, '1m', histBars);
            for (const { tf: htf, seconds } of [{ tf: '5m', seconds: 300 }, { tf: '15m', seconds: 900 }, { tf: '30m', seconds: 1800 }]) {
              const aggBars = aggregateBarsToTF(histBars, seconds);
              if (aggBars.length > 0) _writeSeedFile(symbol, htf, aggBars);
            }
            return histBars.length;
          }
        } else {
          _writeSeedFile(symbol, '1m', histBars);
          // Also generate higher-TF seed files from 1m data
          for (const { tf: htf, seconds } of [{ tf: '5m', seconds: 300 }, { tf: '15m', seconds: 900 }, { tf: '30m', seconds: 1800 }]) {
            const aggBars = aggregateBarsToTF(histBars, seconds);
            if (aggBars.length > 0) _writeSeedFile(symbol, htf, aggBars);
          }
          console.log(`[gapfill] ${symbol} 1m: bootstrapped ${histBars.length.toLocaleString()} bars as seed files (${new Date(histBars[0].time * 1000).toISOString().slice(0, 10)} → ${new Date(histBars[histBars.length - 1].time * 1000).toISOString().slice(0, 10)})`);
          return histBars.length;
        }
      }
    }
    if (needsBootstrap) {
      console.log(`[gapfill] ${symbol} ${tf}: no candles in store and no historical files — skipping`);
      return 0;
    }
  }

  // Find the last bar timestamp
  const lastBarTs = candles[candles.length - 1].time;
  const gapSeconds = nowTs - lastBarTs;

  // Also check for internal gaps (gaps between consecutive bars)
  const internalGaps = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta > tfSec * 2) {
      internalGaps.push({ from: candles[i - 1].time, to: candles[i].time });
    }
  }

  // No gap if the last bar is within 2x the timeframe AND no internal gaps
  if (gapSeconds <= tfSec * 2 && internalGaps.length === 0) {
    return 0;
  }

  console.log(`[gapfill-debug] fillCandleGaps ${symbol} ${tf}: found gap (tail: ${Math.round(gapSeconds / 60)}min, internal: ${internalGaps.length}), store has ${beforeCount} bars`);

  // Strategy: always backfill at 1m level, then aggregate into higher TFs.
  // This ensures consistent window-aligned aggregation.
  let totalInjected = 0;

  if (tf === '1m') {
    // Direct 1m fill
    totalInjected = await _fill1mGap(symbol, lastBarTs, nowTs, internalGaps);
  } else {
    // For higher TFs: first ensure 1m is filled, then re-aggregate
    const candles1m = getCandles(symbol, '1m');
    const last1mTs  = candles1m.length > 0 ? candles1m[candles1m.length - 1].time : lastBarTs;

    // Try to fill 1m gap if it exists (may already be filled from the 1m pass)
    await _fill1mGap(symbol, last1mTs, nowTs, []);

    // Re-aggregate all available 1m bars into this TF, regardless of whether
    // new 1m bars were just added (they may have been filled in a prior pass)
    const updated1m = getCandles(symbol, '1m');
    if (updated1m.length > 0) {
      const aggBars = aggregateBarsToTF(updated1m, tfSec);
      totalInjected = injectBars(symbol, tf, aggBars);
    }
  }

  // Verification: confirm bars actually reached getCandles()
  const afterBars = getCandles(symbol, tf);
  const afterCount = afterBars.length;
  if (totalInjected > 0) {
    if (afterCount > beforeCount) {
      console.log(`[gapfill] ${symbol} ${tf}: store grew from ${beforeCount} to ${afterCount} bars (+${totalInjected} injected)`);
    } else {
      // Count may be unchanged if injected bars overlap with seed data range (seed+live merge deduplicates).
      // This is normal at startup when seed data is fresh; the bars are in liveCandles for when seed ages out.
      console.log(`[gapfill] ${symbol} ${tf}: ${totalInjected} bars injected into live store (getCandles count: ${afterCount}, may overlap with seed data)`);
    }
  }

  return totalInjected;
}

/**
 * Fill 1m gaps from historical files, falling back to Yahoo Finance.
 */
async function _fill1mGap(symbol, fromTs, toTs, internalGaps) {
  let bars = [];

  // 1. Try historical files first
  bars = _readHistoricalBars(symbol, fromTs + 60, toTs);

  // Also fill internal gaps
  for (const gap of internalGaps) {
    const gapBars = _readHistoricalBars(symbol, gap.from + 60, gap.to - 60);
    bars.push(...gapBars);
  }

  // 2. If historical files didn't cover the gap, try Yahoo Finance
  if (bars.length === 0) {
    console.log(`[gapfill] ${symbol} 1m: no historical files — trying Yahoo Finance fallback`);
    const rawYahooBars = await _fetchYahooFallback(symbol);
    // Sanitize Yahoo bars before storage — spike filter at 3× tick threshold
    const yahooBars = _sanitizeYahooBars(symbol, rawYahooBars);
    // Filter to only the gap period
    bars = yahooBars.filter(b => b.time > fromTs && b.time <= toTs);
  }

  if (bars.length === 0) return 0;

  console.log(`[gapfill-debug] _fill1mGap ${symbol}: injecting ${bars.length} bars (range ${new Date(bars[0].time * 1000).toISOString()} → ${new Date(bars[bars.length - 1].time * 1000).toISOString()})`);

  // Inject 1m bars
  const injected = injectBars(symbol, '1m', bars);
  console.log(`[gapfill-debug] injectBars ${symbol} 1m: ${injected} new bars added to store`);
  return injected;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Run gap fill for all symbols and timeframes.
 * Runs sequentially per symbol with 500ms delay between Yahoo fetches.
 *
 * @param {string[]} symbols    Array of internal symbols
 * @param {string[]} timeframes Array of timeframe strings
 */
async function runGapFillAll(symbols, timeframes) {
  console.log(`[gapfill] Starting gap fill for ${symbols.length} symbols × ${timeframes.length} TFs`);
  const startMs = Date.now();
  let totalFilled = 0;

  for (const symbol of symbols) {
    if (CRYPTO.has(symbol)) continue;
    if (!LIVE_FUTURES.has(symbol)) continue;

    for (const tf of timeframes) {
      try {
        const filled = await fillCandleGaps(symbol, tf);
        totalFilled += filled;
      } catch (err) {
        console.error(`[gapfill] Error filling ${symbol} ${tf}: ${err.message}`);
      }
    }

    // Brief pause between symbols to avoid hammering Yahoo Finance
    await new Promise(r => setTimeout(r, 500));
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[gapfill] Complete: ${totalFilled} total bars backfilled in ${elapsed}s`);
  return totalFilled;
}

/**
 * Start the periodic gap fill scheduler with per-TF intervals.
 * 1m: every 2 min, 5m: every 5 min, 15m/30m: every 15 min.
 *
 * @param {string[]} symbols    Array of internal symbols
 * @param {string[]} timeframes Array of timeframe strings
 */
function startGapFillScheduler(symbols, timeframes) {
  stopGapFillScheduler();  // clear any existing timers

  // Group timeframes by interval
  const tfGroups = [
    { tfs: timeframes.filter(t => t === '1m'),                   interval: GAP_FILL_INTERVAL_1M_MS },
    { tfs: timeframes.filter(t => t === '5m'),                   interval: GAP_FILL_INTERVAL_5M_MS },
    { tfs: timeframes.filter(t => t !== '1m' && t !== '5m'),     interval: GAP_FILL_INTERVAL_HTF_MS },
  ];

  for (const { tfs, interval } of tfGroups) {
    if (tfs.length === 0) continue;
    const timer = setInterval(() => {
      runGapFillAll(symbols, tfs).catch(err => {
        console.error(`[gapfill] Scheduler error (${tfs.join(',')}): ${err.message}`);
      });
    }, interval);
    _schedulerTimers.push(timer);
    console.log(`[gapfill] Scheduler: ${tfs.join(',')} every ${interval / 60000} min`);
  }
}

/**
 * Stop all gap fill scheduler timers.
 */
function stopGapFillScheduler() {
  for (const t of _schedulerTimers) clearInterval(t);
  _schedulerTimers = [];
}

/**
 * Trigger immediate gap fill for all symbols on a specific timeframe.
 * Used by the reconnect handler to fill gaps as soon as the feed is back.
 *
 * @param {string[]} symbols  Array of internal symbols
 * @param {string} tf         Timeframe to fill (e.g. '1m')
 */
async function triggerImmediateGapFill(symbols, tf) {
  console.log(`[gapfill] Immediate gap fill triggered for ${symbols.length} symbols × ${tf}`);
  return runGapFillAll(symbols, [tf]);
}

// ---------------------------------------------------------------------------
// Yahoo Finance 60-day intraday backfill — bridges pipeline gap on startup
// ---------------------------------------------------------------------------

/**
 * Fetch up to 60 days of 1m intraday data from Yahoo Finance and inject bars
 * that fall in the gap between the newest bar in the candle store and the
 * oldest live feed bar. Runs once at startup before the live feed connects.
 *
 * @param {string} symbol      Internal symbol, e.g. 'MNQ'
 * @param {string} yahooTicker Yahoo Finance ticker, e.g. 'MNQ=F'
 * @returns {Promise<number>}  Number of bars injected
 */
async function backfillFromYahoo(symbol, yahooTicker) {
  // Yahoo Finance limits: 1m max 7d, 5m max 60d.
  // Strategy: fetch 5m/60d for broad coverage, then 1m/7d for recent detail.
  // Each is injected into the appropriate TF stores.

  let totalInjected = 0;

  // --- Pass 1: 5m bars for 60-day coverage (primary gap bridge) ---
  const candles5m = getCandles(symbol, '5m');
  const store5mEnd = (candles5m && candles5m.length > 0) ? candles5m[candles5m.length - 1].time : 0;

  if (store5mEnd === 0) {
    console.log(`[backfill] ${symbol}: no existing 5m candles — skipping`);
    return 0;
  }

  try {
    const url5m = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=5m&range=60d`;
    const res = await fetch(url5m, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.warn(`[backfill] ${symbol}: Yahoo Finance 5m returned HTTP ${res.status}`);
    } else {
      const data   = await res.json();
      const result = data?.chart?.result?.[0];
      if (result) {
        const timestamps = result.timestamp ?? [];
        const { open, high, low, close, volume } = result.indicators.quote[0];
        const rawBars5m = timestamps
          .map((t, i) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i] ?? 0 }))
          .filter(c => c.open != null && c.high != null && c.low != null && c.close != null);

        // Sanitize Yahoo bars before storage — spike filter at 3× tick threshold
        const bars5m = _sanitizeYahooBars(symbol, rawBars5m);

        const gapBars5m = bars5m.filter(b => b.time > store5mEnd);
        if (gapBars5m.length > 0) {
          const injected5m = injectBars(symbol, '5m', gapBars5m);
          totalInjected += injected5m;

          // Aggregate into 15m/30m
          for (const { tf, seconds } of [{ tf: '15m', seconds: 900 }, { tf: '30m', seconds: 1800 }]) {
            const aggBars = aggregateBarsToTF(gapBars5m, seconds);
            if (aggBars.length > 0) injectBars(symbol, tf, aggBars);
          }

          const gapStart = new Date(store5mEnd * 1000).toISOString().slice(0, 10);
          const gapEnd   = new Date(gapBars5m[gapBars5m.length - 1].time * 1000).toISOString().slice(0, 10);
          console.log(`[backfill] ${symbol}: 5m gap ${gapStart} → ${gapEnd}, injected ${injected5m.toLocaleString()} bars`);
        } else {
          console.log(`[backfill] ${symbol}: 5m — no gap`);
        }
      }
    }
  } catch (err) {
    console.warn(`[backfill] ${symbol}: Yahoo Finance 5m fetch failed: ${err.message}`);
  }

  // Brief pause between Yahoo requests
  await new Promise(r => setTimeout(r, 300));

  // --- Pass 2: 1m bars for 7-day coverage (recent detail) ---
  const candles1m = getCandles(symbol, '1m');
  const store1mEnd = (candles1m && candles1m.length > 0) ? candles1m[candles1m.length - 1].time : 0;

  if (store1mEnd > 0) {
    try {
      const url1m = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1m&range=7d`;
      const res = await fetch(url1m, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) {
        console.warn(`[backfill] ${symbol}: Yahoo Finance 1m returned HTTP ${res.status}`);
      } else {
        const data   = await res.json();
        const result = data?.chart?.result?.[0];
        if (result) {
          const timestamps = result.timestamp ?? [];
          const { open, high, low, close, volume } = result.indicators.quote[0];
          const rawBars1m = timestamps
            .map((t, i) => ({ time: t, open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i] ?? 0 }))
            .filter(c => c.open != null && c.high != null && c.low != null && c.close != null);

          // Sanitize Yahoo bars before storage — spike filter at 3× tick threshold
          const bars1m = _sanitizeYahooBars(symbol, rawBars1m);

          const gapBars1m = bars1m.filter(b => b.time > store1mEnd);
          if (gapBars1m.length > 0) {
            const injected1m = injectBars(symbol, '1m', gapBars1m);
            totalInjected += injected1m;
            console.log(`[backfill] ${symbol}: 1m injected ${injected1m.toLocaleString()} bars (7d detail)`);
          }
        }
      }
    } catch (err) {
      console.warn(`[backfill] ${symbol}: Yahoo Finance 1m fetch failed: ${err.message}`);
    }
  }

  return totalInjected;
}

/**
 * Run Yahoo Finance 60-day backfill for all tradeable futures symbols in parallel.
 * Call after seed + historical data are loaded, before the live feed starts.
 *
 * @returns {Promise<number>} Total bars injected across all symbols
 */
async function runBackfillAll() {
  console.log('[backfill] Starting Yahoo Finance 60-day intraday backfill for all tradeable symbols...');
  const startMs = Date.now();

  const results = await Promise.all(
    Object.entries(YAHOO_BACKFILL_SYMBOLS).map(async ([symbol, yahooTicker]) => {
      try {
        return await backfillFromYahoo(symbol, yahooTicker);
      } catch (err) {
        console.error(`[backfill] ${symbol}: error — ${err.message}`);
        return 0;
      }
    })
  );

  const total = results.reduce((sum, n) => sum + n, 0);
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[backfill] Complete: ${total.toLocaleString()} total bars injected in ${elapsed}s`);
  return total;
}

module.exports = { fillCandleGaps, runGapFillAll, startGapFillScheduler, stopGapFillScheduler, triggerImmediateGapFill, backfillFromYahoo, runBackfillAll };
