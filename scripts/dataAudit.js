'use strict';
/**
 * dataAudit.js — v14.41 comprehensive data trust audit (read-only).
 *
 * Phase 1: audits 10 categories and writes findings to
 *   data/analysis/{ts}_data_trust_audit_phase1.{json,txt}
 *
 * Phase 3: re-run with --phase3 writes
 *   data/analysis/{ts}_data_trust_audit_phase3_postfix.{json,txt}
 *
 * No writes to data files. Pure inspection.
 *
 * Usage:
 *   node scripts/dataAudit.js [--phase1|--phase3] [--progress-file PATH]
 */

const fs   = require('fs');
const path = require('path');

const ROOT        = path.resolve(__dirname, '..');
const DATA_DIR    = path.join(ROOT, 'data');
const HIST_DIR    = path.join(DATA_DIR, 'historical');
const FUTURES_DIR = path.join(HIST_DIR, 'futures');
const AGG_DIR     = path.join(HIST_DIR, 'futures_agg');
const LOGS_DIR    = path.join(DATA_DIR, 'logs');
const ANALYSIS_DIR = path.join(DATA_DIR, 'analysis');

const {
  INSTRUMENTS, ALL_SYMBOLS, TRADEABLE_SYMBOLS, REFERENCE_SYMBOLS,
  POINT_VALUE, HP_PROXY, OPRA_UNDERLYINGS, DATABENTO_ROOT_TO_INTERNAL,
} = require('../server/data/instruments');
const { computeMarketBreadthHistorical } = require('../server/analysis/marketBreadth');

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const PHASE = argv.includes('--phase3') ? 'phase3_postfix' : 'phase1';
const PROGRESS_IDX = argv.indexOf('--progress-file');
const PROGRESS_FILE = PROGRESS_IDX >= 0 ? argv[PROGRESS_IDX + 1] : null;
const SEED_IDX = argv.indexOf('--seed');
const SEED = SEED_IDX >= 0 ? parseInt(argv[SEED_IDX + 1], 10) : 12345;

// Simple seeded PRNG (LCG) for deterministic sampling
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rng = mkRng(SEED);

function pickRandomN(arr, n) {
  const copy = arr.slice();
  const out = [];
  while (out.length < n && copy.length > 0) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

function progress(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (PROGRESS_FILE) {
    try { fs.appendFileSync(PROGRESS_FILE, line + '\n'); } catch {}
  }
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function sortedAsc(arr) { return arr.slice().sort((a, b) => a < b ? -1 : a > b ? 1 : 0); }

function listDateFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''));
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

// ─── Findings accumulator ─────────────────────────────────────────────────────

const findings = {
  phase: PHASE,
  startedAt: new Date().toISOString(),
  endedAt: null,
  categories: {},
  status: {},
  overallStatus: null,
  notes: [],
};

function setStatus(cat, status, notes = {}) {
  findings.status[cat] = status;
  findings.categories[cat] = { status, ...notes };
}

// ─── 1A. Bar schema & file integrity ──────────────────────────────────────────

function audit1A() {
  progress('[AUDIT-1A] Starting bar schema & file integrity audit');

  const TRADEABLE_MIN = 1000;   // ≥1000 bars for a weekday on tradeable symbols
  const REFERENCE_MIN = 800;    // ≥800 bars for a weekday on reference symbols
  const THIN_THRESHOLD = 500;   // flag as thin if <500 bars on a weekday

  const perSymbol = {};
  const problems = [];          // top-N list
  let totalFiles = 0;
  let tsOnlyFiles = 0;
  let neitherFiles = 0;
  let filesWithDupes = 0;
  let filesOutOfOrder = 0;
  let filesWithBadOHLC = 0;
  let filesWithNegVol = 0;
  let filesWithNaN = 0;
  let thinWeekdays = 0;
  let aggFuturesMismatch = 0;

  for (const sym of ALL_SYMBOLS) {
    const tradeable = !!INSTRUMENTS[sym].tradeable;
    const minExpected = tradeable ? TRADEABLE_MIN : REFERENCE_MIN;
    const symStat = {
      tf: {},
      totalFiles: 0,
      totalBars: 0,
      tsOnlyFiles: 0,
      dupeFiles: 0,
      unorderedFiles: 0,
      badOHLCFiles: 0,
      thinWeekdays: 0,
      aggFuturesMismatch: 0,
    };

    for (const tf of ['1m', '5m', '15m', '30m']) {
      const dir = path.join(FUTURES_DIR, sym, tf);
      if (!fs.existsSync(dir)) {
        symStat.tf[tf] = { files: 0, note: 'missing' };
        continue;
      }

      const dates = listDateFiles(dir);
      const tfStat = { files: dates.length, bars: 0, dupes: 0, tsOnly: 0, neither: 0, unordered: 0, badOHLC: 0, negVol: 0, nanBars: 0, thin: 0, aggMatches: 0, aggMismatches: 0, aggMissing: 0 };

      for (const date of dates) {
        const fp = path.join(dir, date + '.json');
        const bars = readJSON(fp);
        if (!Array.isArray(bars)) continue;
        totalFiles++;
        tfStat.bars += bars.length;

        let hasTsOnly = false, hasNeither = false, badOHLC = 0, negVol = 0, nanCt = 0;
        let sawDupe = false;
        const seenTimes = new Set();
        let prevT = -Infinity;
        let outOfOrder = false;

        for (const b of bars) {
          const hasTime = b.time != null;
          const hasTs = b.ts != null;
          if (!hasTime && hasTs) hasTsOnly = true;
          if (!hasTime && !hasTs) hasNeither = true;
          const t = b.time ?? b.ts;
          if (t == null) continue;
          if (seenTimes.has(t)) sawDupe = true; else seenTimes.add(t);
          if (t < prevT) outOfOrder = true;
          prevT = t;
          const o = b.open, h = b.high, l = b.low, c = b.close, v = b.volume;
          if ([o, h, l, c, v].some(x => x == null || (typeof x === 'number' && !Number.isFinite(x)))) nanCt++;
          if (typeof o !== 'number' || typeof h !== 'number' || typeof l !== 'number' || typeof c !== 'number') { badOHLC++; continue; }
          if (o <= 0 || h <= 0 || l <= 0 || c <= 0) badOHLC++;
          else if (l > o || l > c || l > h || h < o || h < c) badOHLC++;
          if (typeof v === 'number' && v < 0) negVol++;
        }

        if (hasTsOnly) { tfStat.tsOnly++; symStat.tsOnlyFiles++; tsOnlyFiles++; }
        if (hasNeither) { tfStat.neither++; neitherFiles++; }
        if (sawDupe)  { tfStat.dupes++;  symStat.dupeFiles++; filesWithDupes++; }
        if (outOfOrder) { tfStat.unordered++; symStat.unorderedFiles++; filesOutOfOrder++; }
        if (badOHLC > 0) { tfStat.badOHLC++; symStat.badOHLCFiles++; filesWithBadOHLC++; }
        if (negVol > 0) { tfStat.negVol++; filesWithNegVol++; }
        if (nanCt > 0)  { tfStat.nanBars++; filesWithNaN++; }

        // Thin weekdays — only on 1m
        if (tf === '1m' && !isWeekend(date)) {
          if (bars.length < THIN_THRESHOLD) {
            tfStat.thin++; symStat.thinWeekdays++; thinWeekdays++;
            if (problems.length < 300) problems.push({ kind: 'thin', sym, tf, date, bars: bars.length, minExpected });
          }
        }

        // Aggregate TF consistency with futures_agg/
        if (tf !== '1m') {
          const aggFp = path.join(AGG_DIR, sym, tf, date + '.json');
          if (fs.existsSync(aggFp)) {
            const aggBars = readJSON(aggFp);
            if (Array.isArray(aggBars) && aggBars.length === bars.length) tfStat.aggMatches++;
            else { tfStat.aggMismatches++; symStat.aggFuturesMismatch++; aggFuturesMismatch++; }
          } else {
            tfStat.aggMissing++;
          }
        }
      }
      symStat.tf[tf] = tfStat;
      symStat.totalFiles += tfStat.files;
      symStat.totalBars  += tfStat.bars;
    }

    perSymbol[sym] = symStat;
  }

  let status = 'green';
  const details = {
    totalFilesScanned: totalFiles,
    filesWithTsOnly: tsOnlyFiles,
    filesWithNeitherField: neitherFiles,
    filesWithDupes,
    filesOutOfOrder,
    filesWithBadOHLC,
    filesWithNegVol,
    filesWithNaN,
    thinWeekdays,
    aggFuturesMismatch,
    perSymbol,
    topProblems: problems.slice(0, 50),
  };

  if (tsOnlyFiles > 0 || neitherFiles > 0 || filesOutOfOrder > 0 || filesWithBadOHLC > 0) status = 'red';
  else if (filesWithDupes > 0 || thinWeekdays > 0 || aggFuturesMismatch > 0) status = 'yellow';

  setStatus('1A', status, details);
  progress(`[AUDIT-1A] ${status} — files=${totalFiles} tsOnly=${tsOnlyFiles} dupes=${filesWithDupes} thin=${thinWeekdays} aggMismatch=${aggFuturesMismatch}`);
}

// ─── 1B. Aggregated TF consistency (stratified sample) ────────────────────────

function reaggregate(bars1m, minutes) {
  if (!bars1m || bars1m.length === 0) return [];
  const tfSec = minutes * 60;
  const out = [];
  const _t = b => b.time ?? b.ts;
  let windowStart = Math.floor(_t(bars1m[0]) / tfSec) * tfSec;
  let bucket = [];
  for (const bar of bars1m) {
    const bw = Math.floor(_t(bar) / tfSec) * tfSec;
    if (bw !== windowStart) {
      if (bucket.length > 0) {
        out.push({
          time: windowStart,
          open: bucket[0].open,
          high: Math.max(...bucket.map(b => b.high)),
          low: Math.min(...bucket.map(b => b.low)),
          close: bucket[bucket.length - 1].close,
          volume: bucket.reduce((s, b) => s + b.volume, 0),
        });
      }
      windowStart = bw;
      bucket = [];
    }
    bucket.push(bar);
  }
  if (bucket.length > 0) {
    out.push({
      time: windowStart,
      open: bucket[0].open,
      high: Math.max(...bucket.map(b => b.high)),
      low: Math.min(...bucket.map(b => b.low)),
      close: bucket[bucket.length - 1].close,
      volume: bucket.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

function audit1B() {
  progress('[AUDIT-1B] Starting aggregated-TF consistency (stratified sample)');
  const TOL_PRICE = 1e-6;
  const TOL_VOL = 1; // allow off-by-1 for rounding

  const today = new Date();
  const cutoffTs = today.getTime() - 90 * 86400 * 1000;

  const results = [];
  let totalChecks = 0;
  let divergences = 0;

  for (const sym of ALL_SYMBOLS) {
    const dir = path.join(FUTURES_DIR, sym, '1m');
    if (!fs.existsSync(dir)) continue;
    const dates = listDateFiles(dir).filter(d => {
      const ts = new Date(d + 'T00:00:00Z').getTime();
      return ts >= cutoffTs;
    });
    const sample = pickRandomN(dates, Math.min(10, dates.length));
    for (const date of sample) {
      const src = readJSON(path.join(dir, date + '.json'));
      if (!Array.isArray(src) || src.length === 0) continue;
      for (const tf of ['5m', '15m', '30m']) {
        const minutes = parseInt(tf, 10);
        const recomputed = reaggregate(src, minutes);
        const onDisk = readJSON(path.join(FUTURES_DIR, sym, tf, date + '.json'));
        if (!Array.isArray(onDisk)) {
          results.push({ sym, date, tf, note: 'on-disk missing', recomputedLen: recomputed.length });
          continue;
        }
        totalChecks++;
        if (onDisk.length !== recomputed.length) {
          divergences++;
          results.push({ sym, date, tf, note: `length diff on-disk=${onDisk.length} recomputed=${recomputed.length}` });
          continue;
        }
        let diff = 0;
        for (let i = 0; i < onDisk.length; i++) {
          const a = onDisk[i], b = recomputed[i];
          const at = a.time ?? a.ts;
          if (at !== b.time) { diff++; continue; }
          if (Math.abs((a.open ?? 0) - b.open) > TOL_PRICE) { diff++; continue; }
          if (Math.abs((a.high ?? 0) - b.high) > TOL_PRICE) { diff++; continue; }
          if (Math.abs((a.low ?? 0) - b.low) > TOL_PRICE) { diff++; continue; }
          if (Math.abs((a.close ?? 0) - b.close) > TOL_PRICE) { diff++; continue; }
          if (Math.abs((a.volume ?? 0) - b.volume) > TOL_VOL) { diff++; continue; }
        }
        if (diff > 0) {
          divergences++;
          results.push({ sym, date, tf, diffBars: diff });
        }
      }
    }
  }

  let status = 'green';
  if (divergences > totalChecks * 0.1) status = 'red';
  else if (divergences > 0) status = 'yellow';

  setStatus('1B', status, {
    totalChecks,
    divergences,
    sampleSize: results.length,
    sampleDivergences: results.slice(0, 40),
  });
  progress(`[AUDIT-1B] ${status} — checks=${totalChecks} divergences=${divergences}`);
}

// ─── 1C. Breadth cache ────────────────────────────────────────────────────────

function audit1C() {
  progress('[AUDIT-1C] Starting breadth cache audit');
  const cachePath = path.join(HIST_DIR, 'breadth_cache.json');
  const cache = readJSON(cachePath);
  if (!cache) {
    setStatus('1C', 'red', { note: 'breadth_cache.json missing' });
    progress('[AUDIT-1C] red — cache missing');
    return;
  }
  const dates = Object.keys(cache).sort();
  const nullEntries = dates.filter(d => !cache[d]);

  // Collect source dates (from 1m files per symbol) to detect missing
  const allSrcDates = new Set();
  for (const sym of ALL_SYMBOLS) {
    const dir = path.join(FUTURES_DIR, sym, '1m');
    if (!fs.existsSync(dir)) continue;
    for (const d of listDateFiles(dir)) allSrcDates.add(d);
  }
  const allSrc = [...allSrcDates].sort();

  // Last 24 months
  const cutoff = new Date(Date.now() - 730 * 86400 * 1000).toISOString().slice(0, 10);
  const recentSrc = allSrc.filter(d => d >= cutoff);
  const missingInCache = recentSrc.filter(d => !(d in cache));
  const nullInRecent = recentSrc.filter(d => d in cache && !cache[d]);

  // Spot-check 30 random dates by re-deriving and comparing
  const checkable = recentSrc.filter(d => cache[d]);
  const sample = pickRandomN(checkable, Math.min(30, checkable.length));

  // Build dailyClosesBySym
  const dailyClosesBySym = {};
  for (const sym of ALL_SYMBOLS) {
    const dir = path.join(FUTURES_DIR, sym, '1m');
    if (!fs.existsSync(dir)) continue;
    const map = {};
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.bak'))) {
      const date = f.replace('.json', '');
      const bars = readJSON(path.join(dir, f));
      if (Array.isArray(bars) && bars.length > 0) {
        const last = bars[bars.length - 1];
        const c = last.close ?? last.c ?? 0;
        if (c > 0) map[date] = c;
      }
    }
    dailyClosesBySym[sym] = map;
  }
  const sortedAllDates = [...allSrcDates].sort();

  const spotCheck = [];
  let mismatches = 0;
  for (const d of sample) {
    const cached = cache[d];
    const recomputed = computeMarketBreadthHistorical(dailyClosesBySym, sortedAllDates, d);
    if (!recomputed) {
      spotCheck.push({ date: d, note: 'could not recompute (insufficient warmup)' });
      continue;
    }
    const fields = ['equityBreadth', 'bondRegime', 'copperRegime', 'dollarRegime', 'riskAppetite', 'riskAppetiteScore'];
    const diff = {};
    for (const f of fields) {
      if ((cached?.[f] ?? null) !== (recomputed?.[f] ?? null)) diff[f] = { cached: cached?.[f], recomputed: recomputed?.[f] };
    }
    if (Object.keys(diff).length > 0) { mismatches++; spotCheck.push({ date: d, diff }); }
  }

  let status = 'green';
  if (missingInCache.length > 0) status = 'yellow';
  if (mismatches > sample.length * 0.1) status = 'red';

  setStatus('1C', status, {
    totalCacheDates: dates.length,
    firstCacheDate: dates[0],
    lastCacheDate: dates[dates.length - 1],
    nullEntries: nullEntries.length,
    recentSourceDates: recentSrc.length,
    missingInCacheSince24Months: missingInCache.length,
    missingDates: missingInCache.slice(0, 30),
    nullInRecentDates: nullInRecent,
    spotCheckSampleSize: sample.length,
    spotCheckMismatches: mismatches,
    spotCheckDiffs: spotCheck.slice(0, 30),
  });
  progress(`[AUDIT-1C] ${status} — cacheDates=${dates.length} missing24mo=${missingInCache.length} spotCheckMismatches=${mismatches}/${sample.length}`);
}

// ─── 1D. DXY / VIX / ETF closes ───────────────────────────────────────────────

function audit1D() {
  progress('[AUDIT-1D] Starting DXY / VIX / ETF-close audit');
  const dxyPath = path.join(HIST_DIR, 'dxy.json');
  const vixPath = path.join(HIST_DIR, 'vix.json');
  const etfPath = path.join(HIST_DIR, 'etf_closes.json');

  const dxy = readJSON(dxyPath) || {};
  const vix = readJSON(vixPath) || {};
  const etf = readJSON(etfPath) || {};

  function analyzeSeries(name, map) {
    const dates = Object.keys(map).sort();
    if (dates.length === 0) return { name, empty: true };
    const today = new Date();
    const daysSinceLast = Math.floor((today.getTime() - new Date(dates[dates.length - 1] + 'T12:00:00Z').getTime()) / 86400000);
    // Find gaps >5 weekdays
    let gaps = 0;
    const gapList = [];
    for (let i = 1; i < dates.length; i++) {
      const d0 = new Date(dates[i - 1] + 'T00:00:00Z').getTime();
      const d1 = new Date(dates[i]     + 'T00:00:00Z').getTime();
      const diffDays = Math.round((d1 - d0) / 86400000);
      if (diffDays > 5) {
        gaps++;
        if (gapList.length < 20) gapList.push({ from: dates[i - 1], to: dates[i], diffDays });
      }
    }
    return {
      name,
      total: dates.length,
      first: dates[0],
      last: dates[dates.length - 1],
      daysSinceLast,
      largeGaps: gaps,
      gapSamples: gapList,
    };
  }

  const dxyRep = analyzeSeries('dxy', dxy);
  const vixRep = analyzeSeries('vix', vix);
  const etfRep = {};
  for (const [etfName, map] of Object.entries(etf)) {
    etfRep[etfName] = analyzeSeries(etfName, map);
  }

  // Sanity check: March 2020 VIX spike to ~80
  const mar2020 = Object.entries(vix)
    .filter(([d]) => d.startsWith('2020-03'))
    .map(([d, v]) => ({ d, v }));
  const marMax = mar2020.length > 0 ? Math.max(...mar2020.map(e => e.v)) : null;

  let status = 'green';
  if (dxyRep.daysSinceLast > 7 || vixRep.daysSinceLast > 7) status = 'yellow';
  if (dxyRep.daysSinceLast > 21 || vixRep.daysSinceLast > 21) status = 'red';
  for (const er of Object.values(etfRep)) {
    if (er.daysSinceLast > 7) status = Math.max(status === 'red' ? 2 : status === 'yellow' ? 1 : 0, 1) === 2 ? 'red' : 'yellow';
    if (er.daysSinceLast > 21) status = 'red';
  }

  setStatus('1D', status, {
    dxy: dxyRep,
    vix: vixRep,
    vixMar2020PeakCheck: { mar2020Max: marMax, expectedApprox: '60-80%', sane: marMax != null && marMax >= 40 },
    etfs: etfRep,
  });
  progress(`[AUDIT-1D] ${status} — DXY lastAgo=${dxyRep.daysSinceLast}d VIX lastAgo=${vixRep.daysSinceLast}d`);
}

// ─── 1E. Options / HP coverage ────────────────────────────────────────────────

function audit1E() {
  progress('[AUDIT-1E] Starting options / HP coverage audit');
  const etfs = OPRA_UNDERLYINGS.map(o => o.etf);
  const rep = {};
  for (const etf of etfs) {
    const dir = path.join(HIST_DIR, 'options', etf, 'computed');
    if (!fs.existsSync(dir)) { rep[etf] = { note: 'missing dir' }; continue; }
    const dates = listDateFiles(dir);
    if (dates.length === 0) { rep[etf] = { dates: 0 }; continue; }
    const sorted = sortedAsc(dates);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const today = new Date();
    const daysSinceLast = Math.floor((today.getTime() - new Date(last + 'T12:00:00Z').getTime()) / 86400000);
    rep[etf] = { dates: dates.length, first, last, daysSinceLast };
  }
  // Known-documented gap: HP ends ~2026-04-01 because no new OPRA zips past that date
  const allLast = Object.values(rep).map(r => r.last).filter(Boolean);
  const maxGap = Math.max(...Object.values(rep).map(r => r.daysSinceLast ?? 0));
  const status = 'yellow'; // documented known gap — not fixable tonight

  setStatus('1E', status, {
    etfs: rep,
    knownIssue: 'HP coverage ends 2026-04-01 because raw OPRA zips were not extended past 2026-04-02. Fix requires Databento purchase decision — out of scope for this audit.',
  });
  progress(`[AUDIT-1E] ${status} — maxDaysSinceLast=${maxGap}d (known HP gap)`);
}

// ─── 1F. Forward-test trade-record stamping ───────────────────────────────────

function audit1F() {
  progress('[AUDIT-1F] Starting forward-test stamping audit');
  const forwardPath = path.join(LOGS_DIR, 'forward_trades.json');
  const trades = readJSON(forwardPath) || [];
  const V14_32_BOUNDARY = '2026-04-20T00:00:00Z';

  const expectedFields = [
    'equityBreadth', 'bondRegime', 'riskAppetite',
    'dxyDirection', 'vixRegime', 'vixLevel',
    'hpNearest', 'resilienceLabel', 'dexBias',
    'ddBandLabel',
  ];

  const cohorts = { pre_v14_32: 0, post_v14_32: 0 };
  const perCohort = {};
  for (const coh of ['pre_v14_32', 'post_v14_32']) {
    perCohort[coh] = { total: 0, byField: {} };
    for (const f of expectedFields) perCohort[coh].byField[f] = { populated: 0, null: 0, distinctValues: {} };
  }

  const postFlatDxyCount = { flat: 0, rising: 0, falling: 0, null: 0, other: 0 };

  for (const t of trades) {
    const exitTs = t.exitTime;
    const cohort = exitTs && exitTs >= V14_32_BOUNDARY ? 'post_v14_32' : 'pre_v14_32';
    cohorts[cohort]++;
    const pc = perCohort[cohort];
    pc.total++;
    for (const f of expectedFields) {
      const v = t[f];
      if (v == null) pc.byField[f].null++;
      else pc.byField[f].populated++;
      if (v != null && typeof v !== 'object') {
        pc.byField[f].distinctValues[String(v)] = (pc.byField[f].distinctValues[String(v)] || 0) + 1;
      }
    }
    if (cohort === 'post_v14_32') {
      const d = t.dxyDirection;
      if (d === 'flat') postFlatDxyCount.flat++;
      else if (d === 'rising') postFlatDxyCount.rising++;
      else if (d === 'falling') postFlatDxyCount.falling++;
      else if (d == null) postFlatDxyCount.null++;
      else postFlatDxyCount.other++;
    }
  }

  // Field-level null% for post-v14.32 cohort
  const post = perCohort.post_v14_32;
  const alerts = [];
  for (const f of expectedFields) {
    const fld = post.byField[f];
    const total = fld.populated + fld.null;
    const pctNull = total > 0 ? (fld.null / total * 100) : 0;
    if (pctNull > 5 && ['equityBreadth', 'bondRegime', 'riskAppetite', 'dxyDirection'].includes(f)) {
      alerts.push({ field: f, pctNull: pctNull.toFixed(1), totalTrades: total });
    }
  }

  // Null cluster detection: which post-v14.32 dates have high null%?
  const byDate = {};
  for (const t of trades) {
    if (!t.exitTime || t.exitTime < V14_32_BOUNDARY) continue;
    const d = t.exitTime.slice(0, 10);
    if (!byDate[d]) byDate[d] = { total: 0, equityBreadthNull: 0, dxyFlat: 0, dxyOther: 0 };
    byDate[d].total++;
    if (t.equityBreadth == null) byDate[d].equityBreadthNull++;
    if (t.dxyDirection === 'flat') byDate[d].dxyFlat++;
    else byDate[d].dxyOther++;
  }

  let status = 'green';
  if (post.total === 0) status = 'yellow';
  else {
    // If post-v14.32 any field is >5% null, red
    if (alerts.some(a => parseFloat(a.pctNull) > 5)) status = 'red';
    // dxyDirection 100% flat = suspicious (known Jeff finding)
    if (postFlatDxyCount.flat === post.total && post.total > 0) {
      if (status === 'green') status = 'yellow';
    }
  }

  setStatus('1F', status, {
    totalTrades: trades.length,
    cohorts,
    perCohort,
    postV14_32DxyDirection: postFlatDxyCount,
    fieldAlerts: alerts,
    byExitDate: byDate,
  });
  progress(`[AUDIT-1F] ${status} — total=${trades.length} pre=${cohorts.pre_v14_32} post=${cohorts.post_v14_32} dxyAllFlatPost=${postFlatDxyCount.flat}/${post.total}`);
}

// ─── 1G. Backtest record completeness ─────────────────────────────────────────

function audit1G() {
  progress('[AUDIT-1G] Starting backtest record completeness audit');
  // Sample per-job result files from data/analysis/*_results.json
  const dir = ANALYSIS_DIR;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('_results.json'));
  if (files.length === 0) {
    setStatus('1G', 'yellow', { note: 'No backtest results files to audit under data/analysis/' });
    progress('[AUDIT-1G] yellow — no backtest results files');
    return;
  }
  // Use B9_*_results.json as the canonical reference
  const refFile = files.find(f => f.startsWith('B9_')) || files[0];
  const rp = path.join(dir, refFile);
  const ref = readJSON(rp);
  const trades = ref?.trades || [];

  const expected = ['equityBreadth', 'bondRegime', 'copperRegime', 'dollarRegime', 'riskAppetite', 'riskAppetiteScore', 'dxyDirection', 'dxyClose', 'vixRegime', 'vixLevel'];
  const nullCounts = {};
  for (const f of expected) nullCounts[f] = 0;
  for (const t of trades) for (const f of expected) if (t[f] == null) nullCounts[f]++;

  const pctNull = {};
  for (const f of expected) pctNull[f] = trades.length > 0 ? +(nullCounts[f] / trades.length * 100).toFixed(1) : 0;

  // Live-vs-backtest divergence: sample 5 dates present in both forward_trades and backtest trades
  const forwardPath = path.join(LOGS_DIR, 'forward_trades.json');
  const fwd = readJSON(forwardPath) || [];
  const fwdByDateSymPair = {};
  for (const t of fwd) {
    if (!t.entryTime) continue;
    const date = t.entryTime.slice(0, 10);
    const key = `${date}:${t.symbol}`;
    (fwdByDateSymPair[key] ||= []).push(t);
  }
  const btByDateSymPair = {};
  for (const t of trades) {
    const date = t.date;
    const key = `${date}:${t.symbol}`;
    (btByDateSymPair[key] ||= []).push(t);
  }
  const sharedKeys = Object.keys(fwdByDateSymPair).filter(k => btByDateSymPair[k]);
  const pickedKeys = sharedKeys.slice(0, 5);
  const parityChecks = [];
  for (const k of pickedKeys) {
    const fwdT = fwdByDateSymPair[k][0];
    const btT = btByDateSymPair[k][0];
    parityChecks.push({
      key: k,
      forward: {
        equityBreadth: fwdT.equityBreadth, bondRegime: fwdT.bondRegime,
        dxyDirection: fwdT.dxyDirection, vixRegime: fwdT.vixRegime,
      },
      backtest: {
        equityBreadth: btT.equityBreadth, bondRegime: btT.bondRegime,
        dxyDirection: btT.dxyDirection, vixRegime: btT.vixRegime,
      },
    });
  }

  const status = Object.values(pctNull).some(p => p > 5) ? 'yellow' : 'green';
  setStatus('1G', status, {
    referenceFile: refFile,
    tradeCount: trades.length,
    nullCounts,
    pctNull,
    forwardVsBacktestParityChecks: parityChecks,
  });
  progress(`[AUDIT-1G] ${status} — ref=${refFile} trades=${trades.length}`);
}

// ─── 1H. Live-feed → historical handoff ───────────────────────────────────────

function audit1H() {
  progress('[AUDIT-1H] Starting live→historical handoff audit');
  const TRADEABLE_MIN = 1000;
  const lastN = 7;
  const today = new Date();
  const checkDates = [];
  for (let i = 1; i <= lastN; i++) {
    const d = new Date(today.getTime() - i * 86400 * 1000);
    checkDates.push(d.toISOString().slice(0, 10));
  }

  const perSymbolRecent = {};
  const thinList = [];
  for (const sym of TRADEABLE_SYMBOLS) {
    const row = {};
    for (const date of checkDates) {
      const fp = path.join(FUTURES_DIR, sym, '1m', date + '.json');
      if (!fs.existsSync(fp)) { row[date] = { exists: false }; continue; }
      const bars = readJSON(fp);
      if (!Array.isArray(bars)) { row[date] = { exists: true, error: 'not array' }; continue; }
      const seen = new Set();
      let dupes = 0;
      for (const b of bars) { const t = b.time ?? b.ts; if (seen.has(t)) dupes++; seen.add(t); }
      row[date] = { exists: true, bars: bars.length, dupes };
      if (!isWeekend(date) && bars.length < TRADEABLE_MIN) {
        thinList.push({ sym, date, bars: bars.length, dupes });
      }
    }
    perSymbolRecent[sym] = row;
  }

  const status = thinList.length > 0 ? 'yellow' : 'green';
  setStatus('1H', status, { perSymbolRecent, thinList });
  progress(`[AUDIT-1H] ${status} — thinWeekdays=${thinList.length} across last ${lastN}d`);
}

// ─── 1I. Settings, configs, instrument metadata ───────────────────────────────

function audit1I() {
  progress('[AUDIT-1I] Starting settings + instrument metadata audit');
  const cfgPath = path.join(ROOT, 'config', 'settings.json');
  const cfg = readJSON(cfgPath);
  const fees = {}, points = {}, ticks = {}, tickVals = {};
  for (const sym of ALL_SYMBOLS) {
    const i = INSTRUMENTS[sym];
    fees[sym] = i.feePerRT ?? null;
    points[sym] = i.pointValue;
    ticks[sym] = i.tickSize;
    tickVals[sym] = i.tickValue;
  }
  // Expected values per CLAUDE.md / known published values
  const expected = {
    MNQ: { pointValue: 2,   tickSize: 0.25, tickValue: 0.50 },
    MES: { pointValue: 5,   tickSize: 0.25, tickValue: 1.25 },
    M2K: { pointValue: 5,   tickSize: 0.10, tickValue: 0.50 },
    MYM: { pointValue: 0.5, tickSize: 1.0,  tickValue: 0.50 },
    MGC: { pointValue: 10,  tickSize: 0.10, tickValue: 1.00 },
    SIL: { pointValue: 200, tickSize: 0.005, tickValue: 1.00 },
    MHG: { pointValue: 2500, tickSize: 0.0005, tickValue: 1.25 },
    MCL: { pointValue: 100, tickSize: 0.01, tickValue: 1.00 },
  };
  const mismatches = [];
  for (const [sym, vals] of Object.entries(expected)) {
    for (const f of Object.keys(vals)) {
      if (INSTRUMENTS[sym][f] !== vals[f]) {
        mismatches.push({ sym, field: f, expected: vals[f], actual: INSTRUMENTS[sym][f] });
      }
    }
  }
  const tradeableCount = TRADEABLE_SYMBOLS.length;
  const refCount = REFERENCE_SYMBOLS.length;
  const expectedTradeable = ['MNQ', 'MES', 'M2K', 'MYM', 'MGC', 'SIL', 'MHG', 'MCL'];
  const expectedReference = ['M6E', 'M6B', 'MBT', 'ZT', 'ZF', 'ZN', 'ZB', 'UB'];
  const tradeableOK = expectedTradeable.every(s => TRADEABLE_SYMBOLS.includes(s));
  const referenceOK = expectedReference.every(s => REFERENCE_SYMBOLS.includes(s));
  const status = (mismatches.length > 0 || !tradeableOK || !referenceOK) ? 'red' : 'green';

  setStatus('1I', status, {
    spanMargin: cfg?.spanMargin || null,
    pointValues: points,
    tickSizes: ticks,
    tickValues: tickVals,
    fees,
    instrumentMismatches: mismatches,
    tradeableSymbols: TRADEABLE_SYMBOLS,
    referenceSymbols: REFERENCE_SYMBOLS,
    tradeableOK, referenceOK,
  });
  progress(`[AUDIT-1I] ${status} — mismatches=${mismatches.length}`);
}

// ─── 1J. Auxiliary data integrity ─────────────────────────────────────────────

function audit1J() {
  progress('[AUDIT-1J] Starting auxiliary data integrity audit');
  const report = {};
  // OPRA raw
  const opraDir = path.join(HIST_DIR, 'raw', 'OPRA');
  if (fs.existsSync(opraDir)) {
    report.opra = {};
    for (const etf of fs.readdirSync(opraDir)) {
      const subdir = path.join(opraDir, etf);
      if (!fs.statSync(subdir).isDirectory()) continue;
      const files = fs.readdirSync(subdir).filter(f => f.includes('.csv') || f.endsWith('.zst') || f.endsWith('.zip'));
      report.opra[etf] = { files: files.length };
    }
  }
  // DX raw
  const dxDir = path.join(HIST_DIR, 'raw', 'DX');
  if (fs.existsSync(dxDir)) {
    report.dx = { files: fs.readdirSync(dxDir).length };
  }
  // ETF closes raw
  const etfClosesDir = path.join(HIST_DIR, 'raw', 'ETF_closes');
  if (fs.existsSync(etfClosesDir)) {
    report.etfClosesRaw = {};
    for (const etf of fs.readdirSync(etfClosesDir)) {
      const sub = path.join(etfClosesDir, etf);
      if (!fs.statSync(sub).isDirectory()) continue;
      report.etfClosesRaw[etf] = { files: fs.readdirSync(sub).length };
    }
  }
  // Seed dir
  const seedDir = path.join(DATA_DIR, 'seed');
  if (fs.existsSync(seedDir)) {
    const seedFiles = fs.readdirSync(seedDir).filter(f => f.endsWith('.json'));
    const seedStatus = {};
    for (const f of seedFiles) {
      const fp = path.join(seedDir, f);
      const arr = readJSON(fp);
      if (Array.isArray(arr) && arr.length > 0) {
        const last = arr[arr.length - 1];
        const t = last.time ?? last.ts;
        seedStatus[f] = { bars: arr.length, lastTs: t, lastISO: t ? new Date(t * 1000).toISOString() : null };
      } else {
        seedStatus[f] = { bars: 0 };
      }
    }
    report.seed = seedStatus;
  }

  setStatus('1J', 'green', report);
  progress('[AUDIT-1J] green — auxiliary data walked');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function rollupOverall() {
  const order = { green: 0, yellow: 1, red: 2 };
  let worst = 'green';
  for (const s of Object.values(findings.status)) {
    if (order[s] > order[worst]) worst = s;
  }
  findings.overallStatus = worst;
}

function writeFindings() {
  if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
  const baseName = `${ts.slice(0,10)}_data_trust_audit_${PHASE}`;
  const jsonPath = path.join(ANALYSIS_DIR, `${baseName}.json`);
  const txtPath  = path.join(ANALYSIS_DIR, `${baseName}.txt`);
  fs.writeFileSync(jsonPath, JSON.stringify(findings, null, 2));
  // Human-readable summary
  const lines = [];
  lines.push(`Data Trust Audit — ${PHASE} — ${findings.startedAt}`);
  lines.push('='.repeat(72));
  lines.push(`Overall: ${findings.overallStatus}`);
  lines.push('');
  lines.push('Status by category:');
  for (const [cat, status] of Object.entries(findings.status)) {
    lines.push(`  ${cat}: ${status}`);
  }
  lines.push('');
  for (const [cat, data] of Object.entries(findings.categories)) {
    lines.push('-'.repeat(72));
    lines.push(`${cat}: ${data.status}`);
    const copy = { ...data };
    delete copy.status;
    // Truncate large per-symbol maps for readability
    for (const [k, v] of Object.entries(copy)) {
      if (typeof v === 'string') {
        lines.push(`  ${k}: ${v}`);
      } else {
        let s = JSON.stringify(v, null, 2);
        if (s.length > 4000) s = s.slice(0, 4000) + '\n  ... (truncated; full in JSON) ...';
        lines.push(`  ${k}:`);
        for (const ln of s.split('\n')) lines.push('    ' + ln);
      }
    }
  }
  fs.writeFileSync(txtPath, lines.join('\n'));
  progress(`[DONE] wrote ${jsonPath}`);
  progress(`[DONE] wrote ${txtPath}`);
  return { jsonPath, txtPath };
}

async function main() {
  const t0 = Date.now();
  progress(`[START] Data trust audit ${PHASE}`);

  audit1A();
  audit1B();
  audit1C();
  audit1D();
  audit1E();
  audit1F();
  audit1G();
  audit1H();
  audit1I();
  audit1J();

  rollupOverall();
  findings.endedAt = new Date().toISOString();
  findings.durationSec = Math.round((Date.now() - t0) / 1000);

  const paths = writeFindings();
  progress(`[END] Duration ${findings.durationSec}s — overall=${findings.overallStatus}`);
  progress(`[END] ${paths.jsonPath}`);
  progress(`[END] ${paths.txtPath}`);
  process.exitCode = 0;
}

main().catch(err => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});
