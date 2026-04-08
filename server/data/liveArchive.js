'use strict';
// Live bar persistence — writes each completed 1m bar from the Databento TCP
// feed to disk in the same format as the historical pipeline output.
//
// Target path: data/historical/futures/{SYMBOL}/1m/{YYYY-MM-DD}.json
// Format:      flat JSON array of { ts, open, high, low, close, volume }
//              where ts is Unix seconds (UTC) — matches existing historical files
//
// This is APPEND-ONLY. Each day's file grows bar by bar during the session.
// Errors are caught and logged; a disk write failure never crashes the live feed.

const fs   = require('fs').promises;
const path = require('path');
const { validateBar } = require('./barValidator');

const HIST_DIR = path.join(__dirname, '..', '..', 'data', 'historical', 'futures');

const _lastDiskBar = {};  // symbol → last bar written (for defensive re-validation)

/**
 * Return UTC date string (YYYY-MM-DD) for a Unix-seconds timestamp.
 */
function _dateStr(unixSecs) {
  return new Date(unixSecs * 1000).toISOString().slice(0, 10);
}

/**
 * Persist a completed 1m live bar to disk.
 *
 * @param {string} symbol    Internal symbol, e.g. 'MNQ'
 * @param {Object} candle    Normalized { time, open, high, low, close, volume }
 *                           where time is Unix seconds (UTC)
 */
async function writeLiveCandleToDisk(symbol, candle) {
  // Defensive re-validation — primary validation happens in _onLiveCandle
  const checked = validateBar(symbol, candle, _lastDiskBar[symbol] || null);
  if (!checked) {
    console.warn(`[liveArchive] SKIPPED disk write ${symbol} t=${candle.time} — bar rejected by validator`);
    return;
  }
  _lastDiskBar[symbol] = checked;

  try {
    const date    = _dateStr(checked.time);
    const dir     = path.join(HIST_DIR, symbol, '1m');
    const filePath = path.join(dir, `${date}.json`);

    // Convert to historical format: ts (not time)
    const bar = {
      ts:     checked.time,
      open:   checked.open,
      high:   checked.high,
      low:    checked.low,
      close:  checked.close,
      volume: checked.volume,
    };

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Read existing file if present
    let bars = [];
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      bars = JSON.parse(raw);
      if (!Array.isArray(bars)) bars = [];
    } catch {
      // File doesn't exist yet — start fresh
    }

    // Skip duplicate (same timestamp already persisted)
    if (bars.length > 0 && bars[bars.length - 1].ts === bar.ts) return;

    bars.push(bar);
    await fs.writeFile(filePath, JSON.stringify(bars), 'utf8');
  } catch (err) {
    console.error(`[liveArchive] write error ${symbol} t=${checked.time}: ${err.message}`);
  }
}

/**
 * Scan data/historical/futures/ and return per-symbol bar counts, oldest/newest dates,
 * and estimated disk usage for the /api/livestats route.
 *
 * @param {string[]} symbols  List of symbols to check (e.g. SCAN_SYMBOLS filtered to futures)
 * @returns {Promise<Object>}
 */
async function getLiveBarStats(symbols) {
  const liveBarCount = {};
  let oldestDate = null;
  let newestDate = null;
  let totalBytes = 0;

  await Promise.all(symbols.map(async (sym) => {
    const dir = path.join(HIST_DIR, sym, '1m');
    try {
      const files = (await fs.readdir(dir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
      if (files.length === 0) { liveBarCount[sym] = 0; return; }

      files.sort();
      const symOldest = files[0].replace('.json', '');
      const symNewest = files[files.length - 1].replace('.json', '');

      if (!oldestDate || symOldest < oldestDate) oldestDate = symOldest;
      if (!newestDate || symNewest > newestDate) newestDate = symNewest;

      // Count total bars across all files for this symbol
      let count = 0;
      for (const f of files) {
        try {
          const raw  = await fs.readFile(path.join(dir, f), 'utf8');
          const stat = await fs.stat(path.join(dir, f));
          totalBytes += stat.size;
          const arr  = JSON.parse(raw);
          count += Array.isArray(arr) ? arr.length : 0;
        } catch { /* skip unreadable file */ }
      }
      liveBarCount[sym] = count;
    } catch {
      liveBarCount[sym] = 0;
    }
  }));

  return {
    liveBarCount,
    oldestBar: oldestDate,
    newestBar: newestDate,
    diskMB:    Math.round(totalBytes / 1024 / 1024 * 100) / 100,
  };
}

module.exports = { writeLiveCandleToDisk, getLiveBarStats };
