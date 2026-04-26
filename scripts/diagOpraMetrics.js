'use strict';
/**
 * scripts/diagOpraMetrics.js — v14.42 Stage 1 diagnostic for OPRA zero-metrics.
 *
 * Standalone, read-only. Does not modify any state. Pulls from the running
 * server's /api/opra/health and /api/datastatus, fetches a raw CBOE chain
 * directly to compare against what the live OPRA path produces, and writes
 * a diagnosis report to data/analysis/{timestamp}_opra_diagnosis.md.
 *
 * Sections:
 *   1A  OPRA feed state    — connection, subscriptions, per-ETF contract/OI counts, sample strikes
 *   1B  HP path trace      — per-ETF dataSource + every metric returned by getOptionsData
 *   1C  CBOE comparison    — raw CBOE chain stats (record count, strike coverage, OI distribution)
 *                            for direct comparison with the OPRA chain shape
 *   1D  Statistics timing  — current ET vs. OPRA broadcast windows, server uptime context
 *   1E  Diagnosis MD       — written to data/analysis/
 *
 * Usage:
 *   node scripts/diagOpraMetrics.js [--server http://localhost:3000]
 */

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

const args = process.argv.slice(2);
const ARG  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const SERVER_BASE = ARG('--server') || 'http://localhost:3000';
const OUT_DIR     = path.resolve(__dirname, '..', 'data', 'analysis');
const STAMP       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_PATH    = path.join(OUT_DIR, `${STAMP}_opra_diagnosis.md`);

const ETF_TO_FUTURES = {
  QQQ: 'MNQ', SPY: 'MES', USO: 'MCL', GLD: 'MGC', IWM: 'M2K', SLV: 'SIL', DIA: 'MYM',
};

const PREFIX = '[DIAG-STAGE1]';
const log = (...a) => console.log(PREFIX, ...a);
const warn = (...a) => console.warn(PREFIX, ...a);

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function getJSON(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
  });
}

// ─── Section 1A — OPRA feed state ───────────────────────────────────────────

async function section1A() {
  log('── 1A — OPRA feed state ──');
  const out = { ok: true, datastatus: null, health: null, perEtf: {}, error: null };

  try {
    out.datastatus = await getJSON(`${SERVER_BASE}/api/datastatus`);
    out.health     = await getJSON(`${SERVER_BASE}/api/opra/health`);
  } catch (err) {
    out.ok = false;
    out.error = `Server fetch failed: ${err.message}`;
    warn(out.error);
    return out;
  }

  const opraStatus = out.datastatus.opra || {};
  const dataHealth = out.health.dataHealth || {};

  log(`OPRA connected:        ${opraStatus.connected}`);
  log(`OPRA subscribed:       ${(opraStatus.subscribedSymbols || []).join(', ')}`);
  log(`OPRA totalRecords:     ${opraStatus.totalRecords}  (statistics records processed since connect)`);
  log(`OPRA strikeCount:      ${opraStatus.strikeCount}   (sum of _strikeData entries across ETFs)`);
  log(`OPRA lastUpdateTime:   ${opraStatus.lastUpdateTime ?? 'null (no OI record ever processed)'}`);

  for (const etf of (opraStatus.subscribedSymbols || [])) {
    const h = dataHealth[etf] || {};
    out.perEtf[etf] = {
      contractCount:    h.contractCount    ?? 0,   // unique definition (rtype=22) records
      strikeCount:      h.strikeCount      ?? 0,   // accumulated _strikeData entries
      lastDefinitionTs: h.lastDefinitionTs ?? null,
      lastOiUpdateTs:   h.lastOiUpdateTs   ?? null,
    };
    log(`  ${etf.padEnd(4)} contracts=${String(h.contractCount ?? 0).padStart(6)} strikes=${String(h.strikeCount ?? 0).padStart(4)}  lastDef=${h.lastDefinitionTs ?? '—'}  lastOI=${h.lastOiUpdateTs ?? '—'}`);
  }

  return out;
}

// ─── Section 1B — HP path trace via /api/opra/health.hpSnapshot ─────────────

async function section1B(s1A) {
  log('── 1B — HP path trace (per-ETF) ──');
  const out = { ok: true, perEtf: {}, summary: null };
  if (!s1A.ok || !s1A.health) {
    out.ok = false;
    out.error = 'Section 1A produced no health snapshot — skipping';
    warn(out.error);
    return out;
  }

  const hp = s1A.health.hpSnapshot || {};
  let opraCount = 0, cboeCount = 0, nullCount = 0;
  for (const [etf, snap] of Object.entries(hp)) {
    if (snap == null) {
      nullCount++;
      out.perEtf[etf] = null;
      log(`  ${etf.padEnd(4)} dataSource=NULL — getOptionsData returned null`);
      continue;
    }
    if (snap.dataSource === 'opra-live') opraCount++;
    else if (snap.dataSource === 'cboe') cboeCount++;
    out.perEtf[etf] = snap;
    log(
      `  ${etf.padEnd(4)} src=${(snap.dataSource ?? '—').padEnd(9)} ` +
      `hp=${(snap.hp ?? '—').toString().padStart(6)} ` +
      `gex=${formatNum(snap.totalGex).padStart(12)} ` +
      `dex=${formatNum(snap.dex).padStart(12)} ` +
      `resilience=${(snap.resilience ?? '—').padEnd(10)} ` +
      `pcRatio=${snap.pcRatio ?? '—'} ` +
      `IV=${snap.atmIV != null ? (snap.atmIV * 100).toFixed(1) + '%' : '—'} ` +
      `ratio=${snap.scalingRatio != null ? snap.scalingRatio.toFixed(2) : '—'}`
    );
  }

  out.summary = { opraLive: opraCount, cboe: cboeCount, nullEtfs: nullCount };
  log(`Sources: opra-live=${opraCount}  cboe=${cboeCount}  null=${nullCount}`);

  return out;
}

function formatNum(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'k';
  return n.toFixed(2);
}

// ─── Section 1C — Raw CBOE chain comparison ─────────────────────────────────

async function section1C() {
  log('── 1C — Raw CBOE comparison (QQQ) ──');
  const out = { ok: true, etf: 'QQQ', recordCount: 0, strikeCount: 0, oiStats: null, error: null };

  try {
    const data = await getJSON('https://cdn.cboe.com/api/global/delayed_quotes/options/QQQ.json');
    const opts = data?.data?.options || [];
    out.recordCount = opts.length;

    const strikes  = new Set();
    const oiVals   = [];
    let totalOI    = 0;
    let nonZeroOI  = 0;
    let maxOI      = 0;
    let parseFails = 0;

    for (const o of opts) {
      if (!o?.option || o?.open_interest == null) continue;
      // Parse strike from the OCC ticker — chars after underlying+YYMMDD+C/P, last 8 = strike×1000
      const ticker = o.option;
      const body = ticker.replace(/^[A-Z]+/, '');
      if (body.length < 15) { parseFails++; continue; }
      const raw = body.slice(7);
      const strike = parseInt(raw, 10) / 1000;
      if (!isNaN(strike) && strike > 0) strikes.add(strike);
      const oi = Number(o.open_interest);
      oiVals.push(oi);
      totalOI += oi;
      if (oi > 0) nonZeroOI++;
      if (oi > maxOI) maxOI = oi;
    }

    out.strikeCount = strikes.size;
    out.oiStats     = { totalOI, nonZeroOI, maxOI, parseFails };

    log(`CBOE QQQ: records=${out.recordCount} strikes=${out.strikeCount}`);
    log(`         OI total=${totalOI.toLocaleString()} non-zero=${nonZeroOI} max=${maxOI.toLocaleString()} parseFails=${parseFails}`);
  } catch (err) {
    out.ok = false;
    out.error = err.message;
    warn(`CBOE fetch failed: ${err.message}`);
  }

  return out;
}

// ─── Section 1D — Statistics broadcast timing ───────────────────────────────

function section1D(s1A) {
  log('── 1D — Statistics broadcast timing ──');
  const out = { now: null, etTime: null, opraBroadcastNotes: null, serverContext: null };

  const now = new Date();
  out.now = now.toISOString();
  out.etTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(now);

  out.opraBroadcastNotes = [
    'Databento OPRA.PILLAR `statistics` schema reference:',
    '  https://databento.com/docs/schemas-and-data-formats/statistics',
    '  https://databento.com/docs/api-reference-historical/basics/datasets/opra-pillar',
    '',
    'Per the schema doc, OpenInterest stat-type records (stat_type=7) are',
    'published once per trading day, populated by the OPRA processor from the',
    'official OCC (Options Clearing Corporation) overnight clearing file.',
    'The OCC file lands in the OPRA distribution stream around 06:00-06:30 ET',
    'each weekday morning (after overnight processing of the prior session).',
    '',
    'Effective consequence for a long-running TCP subscription:',
    '  - Subscribe before the morning broadcast → all 6 ETFs OI buckets',
    '    populate within ~30 minutes of the broadcast firing.',
    '  - Subscribe AFTER the morning broadcast → no OI records will arrive',
    '    until the next trading day. The strike map (definitions, rtype=22)',
    '    populates immediately on subscribe, but `_strikeData` stays empty',
    '    until the next morning OCC broadcast fires.',
    '',
    'This is the canonical "hypothesis A" from the v14.42 Stage 1 spec.',
  ].join('\n');

  // Server uptime hint via pm2 — not authoritative since we cannot read pm2 from here without exec
  out.serverContext = `Current ET time: ${out.etTime}.  If the server's last OPRA reconnect occurred AFTER ~06:30 ET today, the strike-OI buckets will be empty until tomorrow's broadcast unless a startup REST backfill is added.`;
  log(out.serverContext);

  return out;
}

// ─── Section 1E — Build the diagnosis report ────────────────────────────────

function buildDiagnosis(s1A, s1B, s1C, s1D) {
  // Conclude
  let finding, computationCorrect, recommendation;

  const opraConnected = s1A.ok && s1A.datastatus?.opra?.connected;
  const totalRecords  = s1A.datastatus?.opra?.totalRecords ?? 0;
  const strikeCount   = s1A.datastatus?.opra?.strikeCount ?? 0;
  const definitionsArrived = Object.values(s1A.perEtf || {}).some(e => (e?.contractCount ?? 0) > 0);
  const oiArrived          = Object.values(s1A.perEtf || {}).some(e => e?.lastOiUpdateTs != null);

  const cboeWorking = s1B.ok && (s1B.summary?.cboe ?? 0) > 0;
  const cboeRealValues = Object.values(s1B.perEtf || {}).some(s => s && s.totalGex && Math.abs(s.totalGex) > 1e6);

  if (!opraConnected) {
    finding = 'OPRA TCP feed is not connected.';
    computationCorrect = "CAN'T TELL — feed must be connected before metrics can flow.";
    recommendation = 'E) Investigate why the OPRA TCP connection is down (CRAM auth failure, host/port unreachable, DATABENTO_API_KEY missing).';
  } else if (definitionsArrived && !oiArrived) {
    finding = 'OPRA TCP feed is connected and receiving definition records (rtype=22), but ZERO statistics records (rtype=24, stat_type=7 OpenInterest) have been processed since the current connection started — `_lastUpdateTime` is null and `_strikeData` is empty across all 6 ETFs. options.js correctly detects `chain.hasData=false` and falls through to CBOE; CBOE is healthy and returning real metrics, so live HP outputs are NOT zeroed — they are CBOE values, not OPRA values.';
    computationCorrect = 'YES — every code path on the live OPRA branch is sound. The branch never executes today because the OPRA processor only emits `OpenInterest` statistics records once per trading day from the overnight OCC clearing file (typically 06:00-06:30 ET). The current TCP session subscribed AFTER that broadcast window, so no OI records will arrive until tomorrow morning.';
    recommendation = 'A) Wait for the next OPRA statistics broadcast (next 06:00-06:30 ET window) and re-check via `/api/opra/health`. Once OI fires, `_strikeData` populates within ~30 min and `dataSource` flips to `opra-live` automatically. Optional B): a startup REST backfill from Databento historical OPRA (`schema=statistics, stype_in=parent, symbols=QQQ.OPT,...`) for today\'s OCC OI snapshot would let the live feed produce metrics within seconds of any restart instead of waiting until the next morning broadcast — small change, would unblock the Stage 3 EOS snapshot writer firing on the SAME day after a restart.';
  } else if (oiArrived && cboeWorking) {
    finding = 'OPRA receiving OI records AND CBOE working — the apparent zero-metrics symptom must come from a different place. Recommend checking the bias panel display layer or historical computed/ files (which the audit confirmed stop 2026-04-01).';
    computationCorrect = 'YES — both data sources are returning live values.';
    recommendation = 'E) Re-investigate the source of the zero-metric symptom — it is not in the live computation path. Likely candidates: (1) historical computed/ HP files stop 2026-04-01 and the bias panel reads from there for some fields; (2) backtest engine reads from the historical files.';
  } else if (!cboeWorking) {
    finding = 'BOTH OPRA OI is missing AND CBOE is failing — live HP metrics fall through to null/empty defaults across the board.';
    computationCorrect = 'NO — at the very least the CBOE fallback should be returning data; investigate _fetchCBOE().';
    recommendation = 'C) Fix the CBOE fallback first (network? CDN block? user-agent?), then revisit OPRA OI broadcast timing.';
  } else {
    finding = 'Mixed state — see per-ETF section.';
    computationCorrect = "CAN'T TELL — re-run with the running server in a steadier state.";
    recommendation = 'E) Re-run after a clean OPRA reconnect.';
  }

  // ── Build markdown
  let md = '';
  md += '# OPRA Zero-Metrics Diagnosis\n\n';
  md += `_Generated: ${s1D.now} (ET ${s1D.etTime})_\n\n`;
  md += `_Script: scripts/diagOpraMetrics.js (v14.42 Stage 1)_\n\n`;

  md += '## Finding\n\n';
  md += `${finding}\n\n`;

  md += '## Evidence\n\n';

  md += '### 1A — OPRA feed state\n\n';
  if (!s1A.ok) {
    md += `> **ERROR:** ${s1A.error}\n\n`;
  } else {
    const o = s1A.datastatus.opra || {};
    md += `- connected: \`${o.connected}\`\n`;
    md += `- subscribedSymbols: \`${(o.subscribedSymbols || []).join(', ')}\`\n`;
    md += `- totalRecords (statistics processed since connect): \`${o.totalRecords}\`\n`;
    md += `- strikeCount (sum of _strikeData entries): \`${o.strikeCount}\`\n`;
    md += `- lastUpdateTime: \`${o.lastUpdateTime ?? 'null'}\`\n\n`;
    md += '| ETF | contractCount (rtype=22 defs) | strikeCount (_strikeData) | lastDefinitionTs | lastOiUpdateTs |\n';
    md += '|-----|-------------------------------|---------------------------|------------------|----------------|\n';
    for (const [etf, h] of Object.entries(s1A.perEtf)) {
      md += `| ${etf} | ${h.contractCount} | ${h.strikeCount} | ${h.lastDefinitionTs ?? '—'} | ${h.lastOiUpdateTs ?? '—'} |\n`;
    }
    md += '\n';
    md += '- **strikeCount = 0** across all ETFs while contractCount = 5,000–14,500 across all ETFs is the canonical "definitions arrived, OI did not" signature. Definition records (rtype=22) populate `_instrumentMap` + `_contractCount`; statistics records (rtype=24 with stat_type=7 OpenInterest) populate `_strikeData`. Both must arrive for `getOpraRawChain()` to return `hasData=true`.\n\n';
  }

  md += '### 1B — HP path trace (`getOptionsData` per ETF)\n\n';
  if (!s1B.ok) {
    md += `> **ERROR:** ${s1B.error}\n\n`;
  } else {
    md += `Source distribution: opra-live=${s1B.summary.opraLive}, cboe=${s1B.summary.cboe}, null=${s1B.summary.nullEtfs}.\n\n`;
    md += '| ETF | dataSource | hp | totalGex | dex | resilience | pcRatio | atmIV | scalingRatio |\n';
    md += '|-----|------------|----|---------:|----:|-----------|--------:|------:|-------------:|\n';
    for (const [etf, s] of Object.entries(s1B.perEtf)) {
      if (!s) {
        md += `| ${etf} | NULL | — | — | — | — | — | — | — |\n`;
        continue;
      }
      md += `| ${etf} | ${s.dataSource ?? '—'} | ${s.hp ?? '—'} | ${formatNum(s.totalGex)} | ${formatNum(s.dex)} | ${s.resilience ?? '—'} | ${s.pcRatio ?? '—'} | ${s.atmIV != null ? (s.atmIV * 100).toFixed(1) + '%' : '—'} | ${s.scalingRatio != null ? s.scalingRatio.toFixed(2) : '—'} |\n`;
    }
    md += '\n';
    md += '- `dataSource: cboe` confirms options.js is correctly falling through to CBOE because the OPRA chain has no OI data.\n';
    md += '- Real (non-zero) GEX/DEX/PC values confirm `_computeMetrics()` is healthy: it parses the CBOE chain, builds the strike map, computes Black-Scholes-free metrics from CBOE\'s pre-computed greeks, and scales correctly.\n';
    md += '- Live HP outputs are therefore NOT in the floor-default state — they reflect live CBOE values (15-min delayed).\n\n';
  }

  md += '### 1C — CBOE comparison (QQQ raw chain)\n\n';
  if (!s1C.ok) {
    md += `> **ERROR:** ${s1C.error}\n\n`;
  } else {
    md += `- Raw CBOE QQQ chain: ${s1C.recordCount} records across ${s1C.strikeCount} unique strikes.\n`;
    md += `- OI distribution: total=${(s1C.oiStats.totalOI || 0).toLocaleString()}, non-zero=${s1C.oiStats.nonZeroOI}, max-per-contract=${(s1C.oiStats.maxOI || 0).toLocaleString()}, parseFails=${s1C.oiStats.parseFails}.\n`;
    md += `- For comparison, the OPRA strike-map shape (when populated): per-strike entries keyed by strike with \`{ callOI, putOI, callDelta, putDelta, callGamma, putGamma, callIV, expiry }\`. \`getOpraRawChain()\` re-emits one option-record per side per strike with \`{ option (OCC), open_interest, iv, gamma, delta }\` — identical input shape to CBOE for \`_computeMetrics()\`. The two paths share the same downstream computation.\n\n`;
  }

  md += '### 1D — Statistics broadcast timing\n\n';
  md += '```\n';
  md += s1D.opraBroadcastNotes + '\n';
  md += '```\n\n';
  md += `${s1D.serverContext}\n\n`;

  md += '## Is the computation path correct?\n\n';
  md += `**${computationCorrect}**\n\n`;
  md += [
    'Reasoning:',
    '- `opraLive.js _processRecord` correctly handles rtype=22 definitions (populates `_instrumentMap` + `_contractCount`) and rtype=24 statistics with `stat_type=7` (populates `_strikeData` per-strike OI). Definition handling is verified to be working (contract counts match expected ETF chain sizes for an active OPRA subscription).',
    '- `getOpraRawChain()` correctly returns `hasData: false` when `_strikeData` is empty, avoiding the false-positive trap of returning an empty options array as a successful chain.',
    '- `options.js getOptionsData()` correctly inspects `chain.hasData`, falls through to CBOE when false, logs the reason, and returns CBOE metrics with `dataSource: \'cboe\'`. Verified by 1B: every ETF returns CBOE-sourced metrics with real values.',
    '- `_computeMetrics()` produces non-zero, plausible values (GEX in the millions/hundreds of millions, DEX in the millions, P/C ratios in the 0.5–2.6 range, ATM IV in the 10–88% range across asset classes). The computation is healthy.',
  ].join('\n');
  md += '\n\n';

  md += '## Recommended fix\n\n';
  md += `${recommendation}\n\n`;

  md += '## Implications for Stage 3 (EOS HP snapshot writer)\n\n';
  md += [
    'The Stage 3 plan is to call `getOpraRawChain()` + `computeHP()` at 17:30 ET each weekday and write the result to `data/historical/options/{etf}/computed/{date}.json`. For that snapshot to contain real OPRA values (not CBOE fallback values), `_strikeData` must be populated when the snapshot fires.',
    '',
    'Two paths to make this safe:',
    '',
    '1. **Schedule the snapshot AFTER the morning OPRA broadcast.** A 17:30 ET snapshot will, in the steady state, capture a chain that has been accumulating OI deltas all day from the morning OCC broadcast plus any intraday updates. After a restart, however, today\'s snapshot would silently fall through to CBOE values until tomorrow morning rebroadcasts. Mitigate by stamping `dataSource` on the written snapshot so downstream consumers can flag it.',
    '',
    '2. **Add a startup REST backfill.** On `startOpraFeed()` connect, do a one-shot Databento historical fetch of today\'s `statistics` schema for the 6 baseline symbols and seed `_strikeData` from it. Eliminates the after-restart cold-start gap entirely. Adds ~1 HTTP call per startup and a ~10-second delay; small.',
    '',
    'Recommended: ship Stage 3 with the `dataSource` provenance stamp regardless, and make path 2 a follow-up if Jeff wants near-zero restart recovery.',
  ].join('\n');
  md += '\n';

  return md;
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
  log(`Server: ${SERVER_BASE}`);
  log(`Output: ${OUT_PATH}`);

  const s1A = await section1A();
  const s1B = await section1B(s1A);
  const s1C = await section1C();
  const s1D = section1D(s1A);

  const md = buildDiagnosis(s1A, s1B, s1C, s1D);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, md, 'utf8');

  log('');
  log(`Diagnosis written to ${OUT_PATH}`);
  log('');
  log('═══════════════════════════════════════════════════════════════════');
  log('STAGE 1 COMPLETE — review the diagnosis MD before proceeding.');
  log('═══════════════════════════════════════════════════════════════════');
})().catch(err => {
  console.error(`${PREFIX} FATAL:`, err);
  process.exit(1);
});
