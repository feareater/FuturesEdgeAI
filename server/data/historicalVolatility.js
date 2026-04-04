'use strict';
/**
 * historicalVolatility.js — Realized Volatility Index (VIX proxy)
 *
 * Computes 20-day rolling realized volatility from MNQ 1m daily close prices.
 * Uses the last bar's close price for each trading day, computes daily log returns,
 * then annualizes 20-day rolling std-dev to produce a percentage volatility value.
 *
 * Expected output ranges:
 *   10–20  calm / low volatility
 *   20–35  normal / stressed
 *   35–80  crisis (March 2020 peaked ~65–75)
 *
 * Usage:
 *   const { buildVolatilityIndex } = require('./historicalVolatility');
 *   const volMap = buildVolatilityIndex('/path/to/futures/MNQ/1m');
 *   // volMap: { "2019-05-06": 18.5, "2019-05-07": 17.2, ... }
 */

const fs   = require('fs');
const path = require('path');

/**
 * Build a realized volatility index from MNQ 1m daily files.
 *
 * @param {string} futuresDir  Path to data/historical/futures/MNQ/1m/
 * @returns {Object}           Map of { "YYYY-MM-DD": vol% }
 *                             Only dates with a full 20-bar window have values (first 20 days excluded).
 */
function buildVolatilityIndex(futuresDir) {
  if (!fs.existsSync(futuresDir)) return {};

  // Collect all daily JSON files, sorted ascending
  const files = fs.readdirSync(futuresDir)
    .filter(f => f.endsWith('.json') && /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  if (files.length < 21) return {};  // need at least 21 days for one vol value

  // Extract last-bar close for each date
  const dailyCloses = [];  // [{ date, close }]
  for (const fname of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(futuresDir, fname), 'utf8'));
      if (!Array.isArray(data) || data.length === 0) continue;
      const lastBar = data[data.length - 1];
      const close   = lastBar?.close ?? lastBar?.c;
      if (close == null || close <= 0) continue;
      const date = fname.replace('.json', '');
      dailyCloses.push({ date, close });
    } catch (_) {}
  }

  if (dailyCloses.length < 21) return {};

  // Compute daily log returns: ln(today / yesterday)
  const logReturns = [];
  for (let i = 1; i < dailyCloses.length; i++) {
    const r = Math.log(dailyCloses[i].close / dailyCloses[i - 1].close);
    logReturns.push({ date: dailyCloses[i].date, r });
  }

  // 20-day rolling realized volatility: stdDev(last 20 log returns) × sqrt(252) × 100
  const volMap = {};
  for (let i = 19; i < logReturns.length; i++) {
    const window = logReturns.slice(i - 19, i + 1);  // 20 values
    const mean   = window.reduce((s, x) => s + x.r, 0) / window.length;
    const variance = window.reduce((s, x) => s + (x.r - mean) ** 2, 0) / (window.length - 1);
    const vol    = Math.sqrt(variance) * Math.sqrt(252) * 100;
    volMap[logReturns[i].date] = +vol.toFixed(2);
  }

  return volMap;
}

module.exports = { buildVolatilityIndex };
