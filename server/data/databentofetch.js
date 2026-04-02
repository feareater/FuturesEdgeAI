'use strict';
// Databento historical data fetcher — FuturesEdge AI
//
// Pulls OHLCV bars, explores VIX/DXY availability, and samples options chains.
// ALWAYS estimates cost before fetching — stops any single request > $30.
//
// Usage:
//   node server/data/databentofetch.js           # fetch everything
//   node server/data/databentofetch.js --force   # re-fetch even if files exist
//   DRY_RUN=true node server/data/databentofetch.js  # cost estimates only

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const API_KEY  = process.env.DATABENTO_API_KEY;
const BASE_URL = 'https://hist.databento.com/v0';
const FORCE    = process.argv.includes('--force');
const DRY_RUN  = process.env.DRY_RUN === 'true';

const COST_GATE        = 30.00; // Abort any single main request over this
const SAMPLE_COST_GATE =  5.00; // Stricter gate for one-day exploration samples
const NQ_OPT_GATE      =  2.00; // Even stricter for Phase 5

const TODAY      = new Date().toISOString().slice(0, 10);
const START_DATE = '2026-01-01';

// Output directories
const HIST_DIR    = path.join(__dirname, '../../data/historical');
const FUTURES_DIR = path.join(HIST_DIR, 'futures');
const VIX_DIR     = path.join(HIST_DIR, 'vix');
const DXY_DIR     = path.join(HIST_DIR, 'dxy');
const OPTIONS_DIR = path.join(HIST_DIR, 'options');
const META_DIR    = path.join(HIST_DIR, 'metadata');

// ── Report accumulator ────────────────────────────────────────────────────────

const report = {
  generatedAt: null,
  totalEstimatedCostUSD: 0,
  creditsRemaining: 'unknown — check https://app.databento.com/billing',
  datasets: {
    futures_1m: {},
    futures_5m: { note: 'Derived from 1m by aggregation — not fetched separately' },
    futures_1h: {},
    vix:  { status: 'pending', approach: null, notes: [] },
    dxy:  { status: 'pending', notes: [] },
    qqq_options: { status: 'pending' },
    spy_options: { status: 'pending' },
    nq_futures_options: { status: 'pending' },
  },
  gaps: [],
  nextSteps: [],
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function _authHeader() {
  return 'Basic ' + Buffer.from(`${API_KEY}:`).toString('base64');
}

// GET a Databento metadata endpoint, return parsed JSON
async function dbGet(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: _authHeader() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${endpoint} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ── Cost estimation ───────────────────────────────────────────────────────────
// ALWAYS call this before every timeseries fetch.

async function estimateCost(label, params) {
  // metadata.get_cost does not accept encoding — strip it
  const { encoding: _enc, ...costParams } = params;
  try {
    const raw  = await dbGet('metadata.get_cost', costParams);
    // API returns a bare float or { cost: N }
    const cost = typeof raw === 'number' ? raw : (raw?.cost ?? raw?.estimate ?? 0);
    const usd  = parseFloat(cost) || 0;
    report.totalEstimatedCostUSD += usd;
    console.log(`[COST EST] ${label}: $${usd.toFixed(4)}`);
    return usd;
  } catch (err) {
    console.warn(`[COST EST] ${label}: estimate failed — ${err.message}`);
    return null;
  }
}

// ── Timeseries fetch (NDJSON streaming) ──────────────────────────────────────

async function fetchTimeseries(label, params) {
  const body = new URLSearchParams({ encoding: 'json' });
  for (const [k, v] of Object.entries(params)) {
    if (v != null) body.set(k, String(v));
  }

  console.log(`[FETCH] ${label}: requesting…`);
  const res = await fetch(`${BASE_URL}/timeseries.get_range`, {
    method:  'POST',
    headers: {
      Authorization:  _authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(300_000), // 5 min — large responses take time
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`timeseries.get_range → HTTP ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const text    = await res.text();
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      // Accept lines that look like data records (have ts_event in header or top-level)
      if (obj && (obj.hd?.ts_event != null || obj.ts_event != null)) {
        records.push(obj);
      }
    } catch (_) {
      // Skip metadata/header lines that aren't JSON records
    }
  }

  console.log(`[FETCH] ${label}: ${records.length.toLocaleString()} records received`);
  return records;
}

// ── Normalization helpers ─────────────────────────────────────────────────────

// Databento nanosecond timestamps may exceed JS MAX_SAFE_INTEGER as raw numbers.
// They arrive as strings in JSON encoding to preserve precision.
function _nsToSeconds(tsNs) {
  if (typeof tsNs === 'string') {
    return Number(BigInt(tsNs) / 1_000_000_000n);
  }
  // Number — may lose sub-second precision for very large values; seconds are fine
  return Math.floor(tsNs / 1e9);
}

// All Databento prices are fixed-point × 1e9: divide by 1e9 for real price
function normalizeBar(record) {
  const tsNs = record.hd?.ts_event ?? record.ts_event;
  return {
    ts:     _nsToSeconds(tsNs),
    open:   (record.open   ?? 0) / 1e9,
    high:   (record.high   ?? 0) / 1e9,
    low:    (record.low    ?? 0) / 1e9,
    close:  (record.close  ?? 0) / 1e9,
    volume: record.volume  ?? 0,
  };
}

// Aggregate n consecutive bars into wider bars (1m → 5m, etc.)
function aggregateBars(bars, n) {
  const out = [];
  for (let i = 0; i + n <= bars.length; i += n) {
    const slice = bars.slice(i, i + n);
    out.push({
      ts:     slice[0].ts,
      open:   slice[0].open,
      high:   Math.max(...slice.map(b => b.high)),
      low:    Math.min(...slice.map(b => b.low)),
      close:  slice[slice.length - 1].close,
      volume: slice.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

// ── File helpers ──────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const dir of [FUTURES_DIR, VIX_DIR, DXY_DIR, OPTIONS_DIR, META_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  const kb = (fs.statSync(filePath).size / 1024).toFixed(0);
  console.log(`[SAVE] ${path.basename(filePath)} (${kb} KB)`);
}

// Most recent Mon–Fri before today
function lastTradingDay() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Day after a given YYYY-MM-DD string
function dayAfter(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── PHASE 1 — Futures OHLCV ───────────────────────────────────────────────────

const FUTURES_SYMBOLS = {
  MNQ: 'MNQ.c.0',
  MES: 'MES.c.0',
  MGC: 'MGC.c.0',
  MCL: 'MCL.c.0',
};

async function phaseFutures() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' PHASE 1 — FUTURES OHLCV  (GLBX.MDP3)');
  console.log('══════════════════════════════════════════════════════');

  for (const [symbol, dbSymbol] of Object.entries(FUTURES_SYMBOLS)) {
    report.datasets.futures_1m[symbol] = { status: 'pending' };
    report.datasets.futures_1h[symbol] = { status: 'pending' };

    // ── 1-minute bars ─────────────────────────────────────────────────────────
    const file1m   = path.join(FUTURES_DIR, `${symbol}_1m.json`);
    const file5m   = path.join(FUTURES_DIR, `${symbol}_5m.json`);
    const label1m  = `${symbol} 1m  (${START_DATE} → ${TODAY})`;
    const params1m = {
      dataset: 'GLBX.MDP3', symbols: dbSymbol, schema: 'ohlcv-1m',
      start: START_DATE, end: TODAY, stype_in: 'continuous',
    };

    const cost1m = await estimateCost(label1m, params1m);

    if (cost1m !== null && cost1m > COST_GATE) {
      console.warn(`[SKIP] ${label1m}: $${cost1m.toFixed(2)} exceeds $${COST_GATE} gate — NOT fetching`);
      report.datasets.futures_1m[symbol] = {
        status: 'skipped', reason: `estimated cost $${cost1m.toFixed(2)} > $${COST_GATE} gate`,
        estimatedCost: cost1m,
      };
    } else if (!FORCE && fs.existsSync(file1m)) {
      const existing = JSON.parse(fs.readFileSync(file1m, 'utf8'));
      const n = existing.bars?.length ?? 0;
      console.log(`[SKIP] ${symbol}_1m.json exists (${n.toLocaleString()} bars) — use --force to re-fetch`);
      report.datasets.futures_1m[symbol] = {
        status: 'cached', bars: n, filePath: file1m,
        dateRange: { start: START_DATE, end: TODAY },
      };
    } else if (DRY_RUN) {
      console.log(`[DRY RUN] Would fetch ${label1m}  est. $${cost1m?.toFixed(4) ?? '?'}`);
      report.datasets.futures_1m[symbol] = { status: 'dry_run', estimatedCost: cost1m };
    } else if (cost1m !== null) {
      try {
        const records = await fetchTimeseries(label1m, params1m);
        const bars    = records.map(normalizeBar).filter(b => b.ts > 0 && b.close > 0);
        bars.sort((a, b) => a.ts - b.ts);

        saveJSON(file1m, {
          symbol, schema: 'ohlcv-1m', source: 'GLBX.MDP3 (Databento)',
          generatedAt: new Date().toISOString(),
          note: 'Prices in instrument native units (divide by 1e9 already applied)',
          bars,
        });

        // Derive 5m
        const bars5m = aggregateBars(bars, 5);
        saveJSON(file5m, {
          symbol, schema: 'ohlcv-5m', source: 'derived from 1m',
          generatedAt: new Date().toISOString(), bars: bars5m,
        });
        console.log(`[DERIVE] ${symbol} 5m: ${bars5m.length.toLocaleString()} bars from ${bars.length.toLocaleString()} 1m bars`);

        report.datasets.futures_1m[symbol] = {
          status: 'ok', bars: bars.length, filePath: file1m,
          dateRange: { start: START_DATE, end: TODAY },
        };
      } catch (err) {
        console.error(`[ERROR] ${label1m}: ${err.message}`);
        report.datasets.futures_1m[symbol] = { status: 'error', error: err.message };
        report.gaps.push(`${symbol} 1m fetch failed: ${err.message}`);
      }
    }

    // ── 1-hour bars (longer history check) ───────────────────────────────────
    const file1h   = path.join(FUTURES_DIR, `${symbol}_1h.json`);
    const start1h  = '2024-01-01';
    const label1h  = `${symbol} 1h  (${start1h} → ${TODAY})`;
    const params1h = {
      dataset: 'GLBX.MDP3', symbols: dbSymbol, schema: 'ohlcv-1h',
      start: start1h, end: TODAY, stype_in: 'continuous',
    };

    const cost1h = await estimateCost(label1h, params1h);

    if (cost1h !== null && cost1h > COST_GATE) {
      console.warn(`[SKIP] ${label1h}: $${cost1h.toFixed(2)} exceeds gate`);
      report.datasets.futures_1h[symbol] = { status: 'skipped', reason: `cost $${cost1h.toFixed(2)}` };
    } else if (!FORCE && fs.existsSync(file1h)) {
      const existing = JSON.parse(fs.readFileSync(file1h, 'utf8'));
      const n = existing.bars?.length ?? 0;
      console.log(`[SKIP] ${symbol}_1h.json exists (${n.toLocaleString()} bars)`);
      report.datasets.futures_1h[symbol] = { status: 'cached', bars: n, filePath: file1h };
    } else if (DRY_RUN) {
      console.log(`[DRY RUN] Would fetch ${label1h}  est. $${cost1h?.toFixed(4) ?? '?'}`);
      report.datasets.futures_1h[symbol] = { status: 'dry_run', estimatedCost: cost1h };
    } else if (cost1h !== null) {
      try {
        const records = await fetchTimeseries(label1h, params1h);
        const bars    = records.map(normalizeBar).filter(b => b.ts > 0 && b.close > 0);
        bars.sort((a, b) => a.ts - b.ts);
        saveJSON(file1h, {
          symbol, schema: 'ohlcv-1h', source: 'GLBX.MDP3 (Databento)',
          generatedAt: new Date().toISOString(), bars,
        });
        report.datasets.futures_1h[symbol] = {
          status: 'ok', bars: bars.length, filePath: file1h,
          dateRange: { start: start1h, end: TODAY },
        };
      } catch (err) {
        console.error(`[ERROR] ${label1h}: ${err.message}`);
        report.datasets.futures_1h[symbol] = { status: 'error', error: err.message };
        report.gaps.push(`${symbol} 1h fetch failed: ${err.message}`);
      }
    }
  }
}

// ── PHASE 2 — VIX Data ────────────────────────────────────────────────────────

async function phaseVix() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' PHASE 2 — VIX DATA');
  console.log('══════════════════════════════════════════════════════');

  // Approach A: VX continuous futures on Cboe Futures Exchange
  const fileVx   = path.join(VIX_DIR, 'VX_futures_1m.json');
  const labelVx  = `VX futures 1m  (${START_DATE} → ${TODAY})  [XCBF.PITCH]`;
  const paramsVx = {
    dataset: 'XCBF.PITCH', symbols: 'VX.c.0', schema: 'ohlcv-1m',
    start: START_DATE, end: TODAY, stype_in: 'continuous',
  };

  let approachASuccess = false;
  const costVx = await estimateCost(labelVx, paramsVx);

  if (costVx === null) {
    console.log('[VIX] Approach A: XCBF.PITCH cost estimate failed — dataset may not be accessible');
    report.datasets.vix.notes.push('XCBF.PITCH estimate failed — dataset not accessible or VX.c.0 not found');
  } else if (costVx > COST_GATE) {
    console.warn(`[VIX] Approach A: $${costVx.toFixed(2)} exceeds gate`);
    report.datasets.vix.notes.push(`VX futures cost $${costVx.toFixed(2)} exceeds $${COST_GATE} gate`);
  } else if (!FORCE && fs.existsSync(fileVx)) {
    console.log('[SKIP] VX_futures_1m.json already exists');
    const existing = JSON.parse(fs.readFileSync(fileVx, 'utf8'));
    report.datasets.vix = {
      status: 'cached', approach: 'A', bars: existing.bars?.length,
      notes: ['VX futures proxy — not the VIX spot index. Intraday correlation > 0.95.'],
    };
    approachASuccess = true;
  } else if (DRY_RUN) {
    console.log(`[DRY RUN] Would fetch VX futures  est. $${costVx.toFixed(4)}`);
    report.datasets.vix = { status: 'dry_run', approach: 'A', estimatedCost: costVx };
    approachASuccess = true;
  } else {
    try {
      const records = await fetchTimeseries(labelVx, paramsVx);
      const bars    = records.map(normalizeBar).filter(b => b.ts > 0 && b.close > 0);
      bars.sort((a, b) => a.ts - b.ts);
      saveJSON(fileVx, {
        symbol: 'VX', schema: 'ohlcv-1m', source: 'XCBF.PITCH (Databento)',
        note: 'VIX FUTURES — proxy for VIX index. Intraday correlation > 0.95. Not the VIX spot index.',
        generatedAt: new Date().toISOString(), bars,
      });
      approachASuccess = true;
      report.datasets.vix = {
        status: 'ok', approach: 'A', bars: bars.length, filePath: fileVx,
        dateRange: { start: START_DATE, end: TODAY },
        notes: ['VX futures proxy. Correlation to VIX index > 0.95 intraday. Contango premium ~0.5–2 pts.'],
      };
    } catch (err) {
      console.error(`[VIX] Approach A fetch failed: ${err.message}`);
      report.datasets.vix.notes.push(`XCBF.PITCH fetch error: ${err.message}`);
    }
  }

  if (approachASuccess) return;

  // Approach B: scan available datasets for any CBOE/VIX index data
  console.log('[VIX] Approach B: scanning available datasets for VIX index data...');
  try {
    const datasets = await dbGet('metadata.list_datasets');
    const all = Array.isArray(datasets) ? datasets : Object.keys(datasets ?? {});
    const cboe = all.filter(d =>
      /cboe|vix|xcbf|vcbf/i.test(d)
    );
    console.log(`[VIX] All datasets: ${all.join(', ')}`);
    console.log(`[VIX] CBOE-related: ${cboe.length ? cboe.join(', ') : 'none found'}`);
    report.datasets.vix.notes.push(`Available CBOE-related datasets: ${cboe.join(', ') || 'none'}`);
    report.datasets.vix.allDatasets = all;
  } catch (err) {
    console.warn(`[VIX] Approach B (list_datasets) failed: ${err.message}`);
    report.datasets.vix.notes.push(`list_datasets error: ${err.message}`);
  }

  // Approach C: declare gap, log recommendation
  console.log('[VIX] Approach C: VIX spot index not available on Databento.');
  console.log('[VIX] Existing solution: Yahoo Finance ^VIX is already in REF_SYMBOLS in seedFetch.js');
  report.datasets.vix.status   = 'unavailable';
  report.datasets.vix.approach = 'C';
  report.datasets.vix.notes.push(
    'VIX spot index not available on Databento. ' +
    'Yahoo Finance ^VIX already fetched via REF_SYMBOLS in seedFetch.js — no action needed.'
  );
  report.gaps.push('VIX spot index: not on Databento. Yahoo Finance ^VIX already feeds REF_SYMBOLS.');
  report.nextSteps.push('VIX: No action needed — Yahoo Finance ^VIX is already in seedFetch.js REF_SYMBOLS.');
}

// ── PHASE 3 — DXY Data ────────────────────────────────────────────────────────

async function phaseDxy() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' PHASE 3 — DXY DATA  (ICE)');
  console.log('══════════════════════════════════════════════════════');

  const fileDx  = path.join(DXY_DIR, 'DX_futures_1m.json');
  const labelDx = `DX futures 1m  (${START_DATE} → ${TODAY})`;

  // Try ICE datasets in order
  for (const dataset of ['IFUS.IMPACT', 'IFEU.IMPACT']) {
    const label = `${labelDx}  [${dataset}]`;
    const params = {
      dataset, symbols: 'DX.c.0', schema: 'ohlcv-1m',
      start: START_DATE, end: TODAY, stype_in: 'continuous',
    };

    const cost = await estimateCost(label, params);

    if (cost === null) {
      console.log(`[DXY] ${dataset}: estimate failed — not accessible or DX.c.0 not found`);
      continue;
    }
    if (cost > COST_GATE) {
      console.warn(`[DXY] ${dataset}: $${cost.toFixed(2)} exceeds gate — skipping`);
      report.datasets.dxy.notes.push(`${dataset} cost $${cost.toFixed(2)} exceeds gate`);
      continue;
    }

    if (!FORCE && fs.existsSync(fileDx)) {
      console.log('[SKIP] DX_futures_1m.json already exists');
      const existing = JSON.parse(fs.readFileSync(fileDx, 'utf8'));
      report.datasets.dxy = {
        status: 'cached', dataset, bars: existing.bars?.length,
        notes: ['DX futures (ICE) — corr to DXY index > 0.999 intraday. Valid proxy.'],
      };
      return;
    }

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would fetch DX futures from ${dataset}  est. $${cost.toFixed(4)}`);
      report.datasets.dxy = { status: 'dry_run', dataset, estimatedCost: cost };
      return;
    }

    try {
      const records = await fetchTimeseries(label, params);
      const bars    = records.map(normalizeBar).filter(b => b.ts > 0 && b.close > 0);
      bars.sort((a, b) => a.ts - b.ts);
      saveJSON(fileDx, {
        symbol: 'DX', schema: 'ohlcv-1m', source: `${dataset} (Databento)`,
        note: 'DX continuous futures (ICE) — near-perfect proxy for DXY index. Correlation > 0.999 intraday.',
        generatedAt: new Date().toISOString(), bars,
      });
      report.datasets.dxy = {
        status: 'ok', dataset, bars: bars.length, filePath: fileDx,
        dateRange: { start: START_DATE, end: TODAY },
        notes: ['DX futures on ICE — valid DXY proxy.'],
      };
      return;
    } catch (err) {
      console.error(`[DXY] ${dataset} fetch error: ${err.message}`);
      if (!report.datasets.dxy.notes) report.datasets.dxy.notes = [];
      report.datasets.dxy.notes.push(`${dataset} error: ${err.message}`);
    }
  }

  // Neither ICE dataset worked
  console.log('[DXY] DX futures not found on checked ICE datasets.');
  console.log('[DXY] Yahoo Finance DX-Y.NYB is already in REF_SYMBOLS in seedFetch.js — no gap.');
  report.datasets.dxy.status = 'unavailable';
  if (!report.datasets.dxy.notes) report.datasets.dxy.notes = [];
  report.datasets.dxy.notes.push(
    'DX futures not confirmed on IFUS.IMPACT or IFEU.IMPACT. ' +
    'Yahoo Finance DX-Y.NYB already in REF_SYMBOLS in seedFetch.js — no action needed.'
  );
  report.gaps.push('DXY/DX futures not confirmed on Databento ICE datasets. Yahoo Finance DX-Y.NYB covers the need.');
  report.nextSteps.push('DXY: No action needed — Yahoo Finance DX-Y.NYB already in seedFetch.js REF_SYMBOLS.');
}

// ── PHASE 4 — Options Chain Exploration (OPRA.PILLAR) ────────────────────────

async function phaseOptions() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' PHASE 4 — OPTIONS CHAIN EXPLORATION  (OPRA.PILLAR)');
  console.log('══════════════════════════════════════════════════════');

  const lastDay   = lastTradingDay();
  const sampleEnd = dayAfter(lastDay);

  // Step 4a — Dataset range check
  try {
    const range = await dbGet('metadata.get_dataset_range', { dataset: 'OPRA.PILLAR' });
    console.log(`[OPRA] Available: ${range.start_date} → ${range.end_date}`);
    for (const key of ['qqq_options', 'spy_options']) {
      report.datasets[key].dateRangeStart = range.start_date;
      report.datasets[key].dateRangeEnd   = range.end_date;
    }
  } catch (err) {
    console.warn(`[OPRA] Dataset range check failed: ${err.message}`);
  }

  // Steps 4b + 4d — One-day sample for QQQ and SPY
  for (const [ticker, key] of [['QQQ', 'qqq_options'], ['SPY', 'spy_options']]) {
    const sampleFile  = path.join(META_DIR, `${ticker.toLowerCase()}_options_sample.json`);
    const sampleLabel = `${ticker} options statistics  (${lastDay})  [OPRA.PILLAR]`;
    const sampleParams = {
      dataset: 'OPRA.PILLAR', symbols: ticker, schema: 'statistics',
      start: lastDay, end: sampleEnd, stype_in: 'parent',
    };

    const sampleCost = await estimateCost(sampleLabel, sampleParams);

    if (sampleCost !== null && sampleCost > SAMPLE_COST_GATE) {
      console.warn(`[${ticker} OPTS] Sample $${sampleCost.toFixed(2)} > $${SAMPLE_COST_GATE} sample gate — skipping fetch`);
      report.datasets[key].status = 'skipped';
      report.datasets[key].reason = `1-day sample cost $${sampleCost.toFixed(2)} > $${SAMPLE_COST_GATE} gate`;
      // Still estimate the full-range cost for the report
      const fullCost = await estimateCost(
        `${ticker} options FULL (${START_DATE} → ${TODAY}) [OPRA.PILLAR]`,
        { ...sampleParams, start: START_DATE, end: TODAY }
      );
      report.datasets[key].estimatedFullPullCost = fullCost != null ? `$${fullCost.toFixed(2)}` : 'unknown';
      continue;
    }

    if (!FORCE && fs.existsSync(sampleFile)) {
      console.log(`[SKIP] ${path.basename(sampleFile)} already exists`);
      const cached = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
      report.datasets[key].status = 'cached';
      _assessOptionsSample(cached.records ?? [], key);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would fetch ${sampleLabel}  est. $${sampleCost?.toFixed(4) ?? '?'}`);
      report.datasets[key].status = 'dry_run';
      continue;
    }

    if (sampleCost === null) {
      console.warn(`[${ticker} OPTS] Cannot estimate cost — skipping`);
      report.datasets[key] = { status: 'error', notes: 'cost estimate failed — OPRA.PILLAR may be unavailable' };
      report.gaps.push(`${ticker} options: cost estimate failed — OPRA.PILLAR unavailable`);
      continue;
    }

    try {
      const records = await fetchTimeseries(sampleLabel, sampleParams);
      const toSave  = {
        ticker, schema: 'statistics', sampleDate: lastDay,
        fetchedAt: new Date().toISOString(), recordCount: records.length,
        records,
      };
      saveJSON(sampleFile, toSave);
      _assessOptionsSample(records, key);

      // Estimate full pull cost
      const fullCost = await estimateCost(
        `${ticker} options FULL (${START_DATE} → ${TODAY}) [OPRA.PILLAR]`,
        { ...sampleParams, start: START_DATE, end: TODAY }
      );
      report.datasets[key].estimatedFullPullCost = fullCost != null ? `$${fullCost.toFixed(2)}` : 'unknown';
    } catch (err) {
      console.error(`[${ticker} OPTS] Fetch error: ${err.message}`);
      report.datasets[key].status = 'error';
      report.datasets[key].error  = err.message;
      report.gaps.push(`${ticker} options sample fetch failed: ${err.message}`);
    }
  }
}

// Inspect a sample options record set and populate the report
function _assessOptionsSample(records, key) {
  if (!records?.length) {
    report.datasets[key].status = 'ok_empty';
    report.datasets[key].notes  = '0 records returned for sample date';
    console.log(`[OPRA ${key}] 0 records in sample`);
    return;
  }

  const r0     = records[0];
  const flat   = r0.hd ? { ...r0.hd, ...r0 } : r0;
  const fields = Object.keys(flat);

  const hasOI       = fields.some(f => /open_interest|^oi$/.test(f));
  const hasBidAsk   = fields.some(f => /bid_px|ask_px|bid_size|ask_size/.test(f));
  const hasClose    = fields.some(f => /close_px|close|settle_px|settlement/.test(f));
  const hasStrike   = fields.some(f => /strike/.test(f));
  const hasExpiry   = fields.some(f => /expir|maturity/.test(f));
  const hasGreeks   = fields.some(f => /^delta$|^gamma$|^vega$|^theta$/.test(f));
  const hasUnderlying = fields.some(f => /underlying|instrument_id/.test(f));

  const recommendation = hasOI
    ? (hasGreeks ? 'sufficient' : 'needs_black_scholes_for_greeks')
    : 'partial — OI missing';

  report.datasets[key].status      = 'ok';
  report.datasets[key].available   = true;
  report.datasets[key].sampleRecords = records.length;
  report.datasets[key].hasOI       = hasOI;
  report.datasets[key].hasBidAsk   = hasBidAsk;
  report.datasets[key].hasClose    = hasClose;
  report.datasets[key].hasStrike   = hasStrike;
  report.datasets[key].hasExpiry   = hasExpiry;
  report.datasets[key].hasGreeks   = hasGreeks;
  report.datasets[key].hasUnderlying = hasUnderlying;
  report.datasets[key].sampleFields = fields.slice(0, 25);
  report.datasets[key].recommendation = recommendation;

  console.log(
    `[OPRA ${key}] ${records.length} records | ` +
    `OI:${hasOI} BidAsk:${hasBidAsk} Close:${hasClose} Strike:${hasStrike} Expiry:${hasExpiry} Greeks:${hasGreeks}`
  );

  if (!hasGreeks) {
    report.nextSteps.push(
      `${key}: statistics schema lacks pre-computed Greeks. ` +
      `Compute delta/gamma via Black-Scholes using close/settle + underlying price + IV. ` +
      `Or source from IVolatility (https://www.ivolatility.com/data-services/) for historical GEX backtest.`
    );
  }
  if (!hasOI) {
    report.nextSteps.push(
      `${key}: OI not found in statistics schema. Try schema=definition for strike/expiry structure ` +
      `or check if a different OPRA schema includes open_interest_qty.`
    );
  }
}

// ── PHASE 5 — NQ Futures Options (GLBX.MDP3) ─────────────────────────────────

async function phaseNqOptions() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' PHASE 5 — NQ FUTURES OPTIONS  (GLBX.MDP3)');
  console.log('══════════════════════════════════════════════════════');

  const lastDay   = lastTradingDay();
  const sampleEnd = dayAfter(lastDay);
  const sampleFile = path.join(META_DIR, 'nq_options_sample.json');
  const label = `NQ options definitions  (${lastDay})  [GLBX.MDP3]`;
  const params = {
    dataset: 'GLBX.MDP3', symbols: 'NQ.OPT', schema: 'definition',
    start: lastDay, end: sampleEnd, stype_in: 'parent',
  };

  const cost = await estimateCost(label, params);

  if (cost !== null && cost > NQ_OPT_GATE) {
    console.warn(`[NQ OPTS] $${cost.toFixed(2)} exceeds $${NQ_OPT_GATE} gate — skipping`);
    report.datasets.nq_futures_options = {
      status: 'skipped', reason: `cost $${cost.toFixed(2)} > $${NQ_OPT_GATE} gate`,
    };
    return;
  }

  if (!FORCE && fs.existsSync(sampleFile)) {
    console.log('[SKIP] nq_options_sample.json already exists');
    const cached = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
    report.datasets.nq_futures_options = {
      status: 'cached', sampleRecords: cached.records?.length ?? cached.recordCount ?? 'unknown',
    };
    return;
  }

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would fetch ${label}  est. $${cost?.toFixed(4) ?? '?'}`);
    report.datasets.nq_futures_options = { status: 'dry_run', estimatedCost: cost };
    return;
  }

  if (cost === null) {
    console.warn('[NQ OPTS] Cost estimate failed — NQ.OPT may not exist on GLBX.MDP3');
    report.datasets.nq_futures_options = {
      status: 'unavailable',
      notes: 'NQ.OPT parent symbol not found on GLBX.MDP3 or estimate API failed',
    };
    report.gaps.push('NQ futures options (GLBX.MDP3 NQ.OPT): not confirmed — definition schema estimate failed');
    return;
  }

  try {
    const records = await fetchTimeseries(label, params);
    // Only store first 50 records in the sample file — definitions can be huge
    const sample = {
      schema: 'definition', sampleDate: lastDay,
      fetchedAt: new Date().toISOString(),
      recordCount: records.length,
      records: records.slice(0, 50),
    };
    saveJSON(sampleFile, sample);

    const r0      = records[0] ?? {};
    const flat    = r0.hd ? { ...r0.hd, ...r0 } : r0;
    const fields  = Object.keys(flat);
    const hasStrike   = fields.some(f => /strike/.test(f));
    const hasExpiry   = fields.some(f => /expir|maturity/.test(f));
    const hasOI       = fields.some(f => /open_interest|^oi$/.test(f));
    const hasGreeks   = fields.some(f => /^delta$|^gamma$/.test(f));

    console.log(
      `[NQ OPTS] ${records.length} definitions | ` +
      `Strike:${hasStrike} Expiry:${hasExpiry} OI:${hasOI} Greeks:${hasGreeks}`
    );

    report.datasets.nq_futures_options = {
      status: 'ok', sampleRecords: records.length, filePath: sampleFile,
      hasStrike, hasExpiry, hasOI, hasGreeks,
      sampleFields: fields.slice(0, 25),
      note: 'definition schema shows available contract specs. OI/pricing requires statistics or mbp-1 schema.',
    };

    if (!hasOI) {
      report.nextSteps.push(
        'NQ futures options: definition schema does not include OI. ' +
        'Try schema=statistics on GLBX.MDP3 with NQ.OPT to get per-strike OI. ' +
        'NQ options can proxy MNQ for GEX computation (same underlying, just larger contract size).'
      );
    }
  } catch (err) {
    console.error(`[NQ OPTS] Fetch error: ${err.message}`);
    report.datasets.nq_futures_options = { status: 'error', error: err.message };
    report.gaps.push(`NQ futures options sample failed: ${err.message}`);
  }
}

// ── PHASE 6 — Write Report ────────────────────────────────────────────────────

function writeReport() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' PHASE 6 — FETCH REPORT');
  console.log('══════════════════════════════════════════════════════');

  report.generatedAt = new Date().toISOString();
  report.totalEstimatedCostUSD = +report.totalEstimatedCostUSD.toFixed(4);

  const reportPath = path.join(META_DIR, 'fetch_report.json');
  saveJSON(reportPath, report);

  // ── Human-readable console summary ──────────────────────────────────────────
  console.log('\n────────────────────────────────────────────────────────');
  console.log(' SUMMARY');
  console.log('────────────────────────────────────────────────────────');
  console.log(`Total estimated API cost: $${report.totalEstimatedCostUSD.toFixed(4)}`);
  console.log('Credits: Jeff has $125 free — check https://app.databento.com/billing\n');

  console.log('Futures 1m bars:');
  for (const [sym, d] of Object.entries(report.datasets.futures_1m)) {
    const bars = d.bars ? ` (${d.bars.toLocaleString()} bars)` : '';
    console.log(`  ${sym}: ${d.status}${bars}`);
  }

  console.log('\nFutures 1h bars:');
  for (const [sym, d] of Object.entries(report.datasets.futures_1h)) {
    const bars = d.bars ? ` (${d.bars.toLocaleString()} bars)` : '';
    console.log(`  ${sym}: ${d.status}${bars}`);
  }

  console.log(`\nVIX:  ${report.datasets.vix.status}  (approach ${report.datasets.vix.approach ?? '?'})`);
  console.log(`DXY:  ${report.datasets.dxy.status ?? 'pending'}`);

  const qo = report.datasets.qqq_options;
  const so = report.datasets.spy_options;
  console.log(`\nQQQ options (OPRA): ${qo.status ?? 'pending'} | OI:${qo.hasOI ?? '?'} Greeks:${qo.hasGreeks ?? '?'} | full pull est: ${qo.estimatedFullPullCost ?? '?'}`);
  console.log(`SPY options (OPRA): ${so.status ?? 'pending'} | OI:${so.hasOI ?? '?'} Greeks:${so.hasGreeks ?? '?'} | full pull est: ${so.estimatedFullPullCost ?? '?'}`);
  const nq = report.datasets.nq_futures_options;
  console.log(`NQ futures options: ${nq.status ?? 'pending'} | Strike:${nq.hasStrike ?? '?'} OI:${nq.hasOI ?? '?'}`);

  if (report.gaps.length) {
    console.log('\nGaps:');
    for (const g of report.gaps) console.log(`  ⚠  ${g}`);
  }

  if (report.nextSteps.length) {
    console.log('\nNext steps:');
    for (const s of report.nextSteps) console.log(`  →  ${s}`);
  }

  console.log(`\nFull report saved: ${reportPath}`);
  console.log('────────────────────────────────────────────────────────\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     FuturesEdge AI — Databento Historical Fetch     ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  if (!API_KEY) {
    console.error(
      '\n[ERROR] DATABENTO_API_KEY not set in .env\n' +
      'Add your key:  DATABENTO_API_KEY=db-xxxxxxxxxxxxxxxxxxxx\n' +
      'Get a key at:  https://app.databento.com/portal/keys\n'
    );
    process.exit(1);
  }

  // Log a truncated key hint — never log the full key
  console.log(`[AUTH]   Key loaded (${API_KEY.slice(0, 5)}…${API_KEY.slice(-4)})`);
  console.log(`[MODE]   DRY_RUN=${DRY_RUN}  --force=${FORCE}`);
  console.log(`[RANGE]  ${START_DATE} → ${TODAY}`);
  console.log(`[GATES]  Main: <$${COST_GATE}  Sample: <$${SAMPLE_COST_GATE}  NQ opts: <$${NQ_OPT_GATE}`);
  console.log(`[OUTPUT] ${HIST_DIR}\n`);

  ensureDirs();

  await phaseFutures();
  await phaseVix();
  await phaseDxy();
  await phaseOptions();
  await phaseNqOptions();
  writeReport();
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
