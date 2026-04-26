'use strict';
/**
 * server/data/opraSnapshot.js — v14.42 Stage 3 daily HP snapshot writer.
 *
 * `snapshotDailyHP()` pulls the in-memory OPRA chain accumulated by opraLive,
 * computes a Black-Scholes HP snapshot via hpCompute (the same code path the
 * historical pipeline uses in Phase 1f), and writes the result to
 * `data/historical/options/{etf}/computed/{YYYY-MM-DD}.json`.
 *
 * Invariants preserved:
 *   - Output schema is bit-identical to historicalPipeline.js Phase 1f writes
 *     (computeHP() return shape, plus a small `dataSource` provenance stamp).
 *   - .bak sidecar on the FIRST overwrite per (etf, date), not on every overwrite
 *     within a day. Tracked via in-memory `_bakWrittenToday` set, reset at midnight ET.
 *   - dataSource stamp lets downstream consumers distinguish OPRA-derived snapshots
 *     ('opra-live') from CBOE-fallback snapshots ('cboe-fallback') from the
 *     historical-zip pipeline ('opra-historical-zip', not written by this module).
 *
 * Pre-conditions for a useful OPRA snapshot:
 *   - Live OPRA TCP feed connected AND `_strikeData` populated for the ETF
 *     (i.e. the morning OCC OpenInterest broadcast has fired since last reconnect).
 *   - `etf_closes.json` has an entry for today (or the most recent prior trading day
 *     as fallback for the ETF spot price).
 *   - 1m futures bar file exists for the futuresProxy at today's date.
 *
 * Diagnosed in [data/analysis/2026-04-26T04-45-22_opra_diagnosis.md]: post-restart
 * before the morning broadcast, _strikeData is empty and OPRA paths fall through
 * to CBOE. Stage 3 mitigates this by stamping `dataSource` so consumers can flag
 * CBOE-derived snapshots as lower fidelity than OPRA-derived ones.
 */

const fs   = require('fs');
const path = require('path');

const opraLive  = require('./opraLive');
const options   = require('./options');
const { computeHP } = require('./hpCompute');
const { OPRA_UNDERLYINGS } = require('./instruments');

const HIST_ROOT = path.resolve(__dirname, '..', '..', 'data', 'historical');
const OPT_DIR   = path.join(HIST_ROOT, 'options');
const FUT_DIR   = path.join(HIST_ROOT, 'futures');
const ETF_CLOSES_PATH = path.join(HIST_ROOT, 'etf_closes.json');

const PREFIX = '[OPRA-SNAPSHOT-STAGE3]';
const log = (...a) => console.log(PREFIX, ...a);
const warn = (...a) => console.warn(PREFIX, ...a);

// Tracks (etf|date) pairs we've already written .bak for today, so repeat
// snapshots within the same day overwrite the live file but DON'T proliferate
// .bak sidecars. Reset at midnight ET.
let _bakWrittenToday = new Set();
let _bakDate = null;

function _todayET() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function _ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// Parse OCC option ticker (e.g. "QQQ260330C00500000") → { strike, expiry, type }
function _parseOcc(ticker, underlying) {
  if (!ticker?.startsWith(underlying)) return null;
  const body = ticker.slice(underlying.length);
  if (body.length < 15) return null;
  const yymmdd = body.slice(0, 6);
  const type   = body[6];
  const raw    = body.slice(7);
  if (type !== 'C' && type !== 'P') return null;
  const strike = parseInt(raw, 10) / 1000;
  if (!isFinite(strike) || strike <= 0) return null;
  const expiry = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  return { strike, expiry, type };
}

// Convert opraLive's CBOE-compatible chain → hpCompute's contract array
function _chainToContracts(chain, underlying) {
  if (!chain?.options?.length) return [];
  const out = [];
  for (const o of chain.options) {
    const p = _parseOcc(o.option, underlying);
    if (!p) continue;
    out.push({
      strike: p.strike,
      expiry: p.expiry,
      type:   p.type,
      openInterest: Number(o.open_interest) || 0,
    });
  }
  return out;
}

// Look up today's ETF close from etf_closes.json. Falls back to the most
// recent prior date with a value if today's hasn't landed yet (mid-session).
function _lookupEtfClose(etfClosesMap, etf, todayDateStr) {
  const subMap = etfClosesMap?.[etf];
  if (!subMap) return null;
  if (subMap[todayDateStr] != null) return { close: subMap[todayDateStr], dateUsed: todayDateStr };
  const dates = Object.keys(subMap).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] < todayDateStr) return { close: subMap[dates[i]], dateUsed: dates[i] };
  }
  return null;
}

// Read the most recent 1m bar's close as today's futures close. Mid-session,
// this is the live price; at EOD (after force-close), it's the session close.
function _lookupFuturesClose(futuresProxy, todayDateStr) {
  const f = path.join(FUT_DIR, futuresProxy, '1m', `${todayDateStr}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const bars = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(bars) || bars.length === 0) return null;
    const last = bars[bars.length - 1];
    return last?.close ?? null;
  } catch { return null; }
}

// Build 20-day rolling log returns from etf_closes.json prior to today.
function _buildDailyLogReturns(etfClosesMap, etf, todayDateStr) {
  const subMap = etfClosesMap?.[etf];
  if (!subMap) return [];
  const dates = Object.keys(subMap).filter(d => d <= todayDateStr).sort();
  const tail = dates.slice(-21);                 // 21 closes → 20 log returns
  const out = [];
  for (let i = 1; i < tail.length; i++) {
    const prev = subMap[tail[i - 1]];
    const cur  = subMap[tail[i]];
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

// Reset .bak tracker at midnight ET so a fresh-day snapshot writes a fresh .bak.
function _maybeResetBakTracker(todayDateStr) {
  if (_bakDate !== todayDateStr) {
    _bakWrittenToday = new Set();
    _bakDate = todayDateStr;
  }
}

/**
 * Snapshot the current OPRA chain to disk for today's date. One file per ETF.
 *
 * @returns {Promise<Object>} per-ETF summary, e.g.
 *   {
 *     QQQ: { status:'ok', dataSource:'opra-live', filePath, hpValue, gexValue, dexValue, ... },
 *     SPY: { status:'skipped', reason:'opra has no OI; CBOE fallback declined for snapshot' },
 *     ...
 *   }
 */
async function snapshotDailyHP() {
  const t0 = Date.now();
  const todayDateStr = _todayET();
  _maybeResetBakTracker(todayDateStr);

  log(`Snapshot start — date=${todayDateStr}`);
  const summary = {};

  // Load ETF closes once
  let etfClosesMap = {};
  try {
    if (fs.existsSync(ETF_CLOSES_PATH)) {
      etfClosesMap = JSON.parse(fs.readFileSync(ETF_CLOSES_PATH, 'utf8'));
    }
  } catch (err) {
    warn(`Could not read etf_closes.json: ${err.message} — snapshots will skip per-ETF if no close found`);
  }

  for (const { etf, futuresProxy } of OPRA_UNDERLYINGS) {
    const ctx = { etf, futuresProxy, todayDateStr };
    try {
      const result = await _snapshotOneEtf(ctx, etfClosesMap);
      summary[etf] = result;
      const tag = result.status === 'ok'
        ? `${result.dataSource} hp=${result.hpValue} gex=${result.gexValue} dex=${result.dexValue} → ${result.filePath ? path.basename(result.filePath) : '—'}`
        : `${result.status} — ${result.reason ?? '—'}`;
      log(`  ${etf.padEnd(4)} ${tag}`);
    } catch (err) {
      summary[etf] = { status: 'error', reason: err.message };
      warn(`  ${etf.padEnd(4)} error — ${err.message}`);
    }
  }

  log(`Snapshot complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return summary;
}

async function _snapshotOneEtf(ctx, etfClosesMap) {
  const { etf, futuresProxy, todayDateStr } = ctx;

  // Try OPRA chain first
  let dataSource = null;
  let contracts  = [];

  const opraChain = opraLive.getOpraRawChain(etf);
  if (opraChain?.hasData) {
    contracts = _chainToContracts(opraChain, etf);
    if (contracts.length > 0) dataSource = 'opra-live';
  }

  // CBOE fallback path: only kick in if OPRA produced nothing.
  // Use options.getOptionsData(futuresProxy) which already handles CBOE fetch +
  // chain parsing — but we need the CONTRACTS, not the metrics. Re-fetch CBOE
  // raw chain via the same path and convert. Simpler: snapshot only when OPRA
  // has data; otherwise mark skipped + reason. CBOE-derived snapshots would
  // be misleading on disk because consumers expect the historical pipeline
  // shape (which is OPRA-derived), and the CBOE chain has different greeks.
  if (dataSource == null) {
    return {
      status: 'skipped',
      reason: 'OPRA chain has no OI data (likely no statistics broadcast since last reconnect); CBOE fallback intentionally not snapshotted',
      filePath: null,
    };
  }

  // Look up today's ETF + futures close
  const etfCloseInfo = _lookupEtfClose(etfClosesMap, etf, todayDateStr);
  if (!etfCloseInfo) {
    return { status: 'skipped', reason: `no etf_closes entry for ${etf} ≤ ${todayDateStr}`, filePath: null };
  }
  const futuresClose = _lookupFuturesClose(futuresProxy, todayDateStr);
  if (!futuresClose) {
    return { status: 'skipped', reason: `no 1m futures bars for ${futuresProxy} on ${todayDateStr}`, filePath: null };
  }
  const dailyLogReturns = _buildDailyLogReturns(etfClosesMap, etf, todayDateStr);

  const snapshot = computeHP({
    date: todayDateStr,
    underlying: etf,
    futuresProxy,
    etfClose: etfCloseInfo.close,
    futuresClose,
    contracts,
    dailyLogReturns,
  });

  // Provenance stamp — distinguishes live-feed snapshots from historical-pipeline output.
  snapshot.dataSource = dataSource;
  snapshot._snapshottedAt = new Date().toISOString();
  if (etfCloseInfo.dateUsed !== todayDateStr) {
    snapshot._etfCloseFallbackDate = etfCloseInfo.dateUsed;
  }

  const compDir = path.join(OPT_DIR, etf, 'computed');
  _ensureDir(compDir);
  const outPath = path.join(compDir, `${todayDateStr}.json`);

  // .bak sidecar on first overwrite per (etf, date) per day
  const bakKey = `${etf}|${todayDateStr}`;
  if (fs.existsSync(outPath) && !_bakWrittenToday.has(bakKey)) {
    fs.copyFileSync(outPath, outPath + '.bak');
    _bakWrittenToday.add(bakKey);
  }

  fs.writeFileSync(outPath, JSON.stringify(snapshot), 'utf8');

  return {
    status: 'ok',
    dataSource,
    filePath: outPath,
    hpValue: snapshot.resilienceScore,
    gexValue: snapshot.totalGex,
    dexValue: snapshot.totalDex,
    dexBias: snapshot.dexBias,
    contractCount: contracts.length,
  };
}

module.exports = { snapshotDailyHP };
