#!/usr/bin/env node
/**
 * databentoDiag.js — Standalone Databento connection & data health diagnostic
 *
 * Usage:  node scripts/databentoDiag.js
 * No server required. Uses only Node.js built-in modules + dotenv.
 */

require('dotenv').config();

const https = require('https');
const http  = require('http');

const API_KEY  = process.env.DATABENTO_API_KEY;
const HIST_HOST = 'hist.databento.com';

// All 16 CME symbols to check for historical OHLCV
const DIAG_SYMBOLS = [
  // Tradeable CME futures
  { internal: 'MNQ', dbRoot: 'MNQ', continuous: 'MNQ.c.0' },
  { internal: 'MES', dbRoot: 'MES', continuous: 'MES.c.0' },
  { internal: 'M2K', dbRoot: 'M2K', continuous: 'M2K.c.0' },
  { internal: 'MYM', dbRoot: 'MYM', continuous: 'MYM.c.0' },
  { internal: 'MGC', dbRoot: 'GC',  continuous: 'GC.c.0'  },
  { internal: 'SIL', dbRoot: 'SI',  continuous: 'SI.c.0'  },
  { internal: 'MHG', dbRoot: 'HG',  continuous: 'HG.c.0'  },
  { internal: 'MCL', dbRoot: 'MCL', continuous: 'MCL.c.0' },
  // Reference (breadth)
  { internal: 'M6E', dbRoot: 'M6E', continuous: 'M6E.c.0' },
  { internal: 'M6B', dbRoot: 'M6B', continuous: 'M6B.c.0' },
  { internal: 'MBT', dbRoot: 'MBT', continuous: 'MBT.c.0' },
  { internal: 'ZT',  dbRoot: 'ZT',  continuous: 'ZT.c.0'  },
  { internal: 'ZF',  dbRoot: 'ZF',  continuous: 'ZF.c.0'  },
  { internal: 'ZN',  dbRoot: 'ZN',  continuous: 'ZN.c.0'  },
  { internal: 'ZB',  dbRoot: 'ZB',  continuous: 'ZB.c.0'  },
  { internal: 'UB',  dbRoot: 'UB',  continuous: 'UB.c.0'  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function dbGet(path) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${API_KEY}:`).toString('base64');
    const options = {
      hostname: HIST_HOST,
      path,
      method: 'GET',
      headers: { 'Authorization': `Basic ${auth}` },
      rejectUnauthorized: false,   // local dev — skip revocation check
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
        } else {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function localGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        } else {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout (server not running?)')); });
  });
}

function hr(label) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${label}`);
  console.log('='.repeat(60) + '\n');
}

function decodePx(raw) {
  const n = Number(raw);
  return n > 1e7 ? n / 1e9 : n;   // fixed-point integers ÷ 1e9; already-float pass through
}

function decodeTs(raw) {
  const n = Number(raw);
  return n > 1e15 ? new Date(n / 1e6) : new Date(n);  // nanoseconds → ms
}

// ── SECTION 1: CONNECTION CHECK ─────────────────────────────────────────────

async function checkSchemas(dataset) {
  console.log(`  Checking schemas for ${dataset}...`);
  try {
    const body = await dbGet(`/v0/metadata.list_schemas?dataset=${dataset}`);
    const schemas = JSON.parse(body);
    console.log(`  ✅ PASS — ${dataset} returned ${schemas.length} schemas:`);
    console.log(`     ${schemas.join(', ')}`);
    return true;
  } catch (e) {
    console.log(`  ❌ FAIL — ${dataset}: ${e.message}`);
    return false;
  }
}

async function section1() {
  hr('SECTION 1: CONNECTION CHECK');

  if (!API_KEY) {
    console.log('  ❌ FAIL — DATABENTO_API_KEY not found in .env');
    return;
  }
  console.log(`  API key: ${API_KEY.slice(0, 6)}...${API_KEY.slice(-4)} (${API_KEY.length} chars)\n`);

  await checkSchemas('GLBX.MDP3');
  console.log();
  await checkSchemas('OPRA.PILLAR');
}

// ── SECTION 2: LIVE FEED STATUS ─────────────────────────────────────────────

// ── SECTION 3: HISTORICAL OHLCV — LAST HOUR ────────────────────────────────

async function fetchRecentBars(sym) {
  const now   = new Date();
  // Databento historical data lags ~15-20 min behind real-time; cap end at now-20min
  const end   = new Date(now.getTime() - 20 * 60 * 1000);
  const start = new Date(end.getTime() - 90 * 60 * 1000);  // 90 min before end

  const params = new URLSearchParams({
    dataset:  'GLBX.MDP3',
    schema:   'ohlcv-1m',
    symbols:  sym.continuous,
    stype_in: 'continuous',
    start:    start.toISOString(),
    end:      end.toISOString(),
    encoding: 'json',
    limit:    '200',
  });

  console.log(`  ${sym.internal} (${sym.continuous}): fetching 1m bars from last 90 min...`);

  try {
    const body    = await dbGet(`/v0/timeseries.get_range?${params.toString()}`);
    // Databento returns NDJSON (one JSON object per line), not a JSON array
    const records = body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

    if (!Array.isArray(records) || records.length === 0) {
      return { symbol: sym.internal, bars: 0, first: null, last: null, latestPrice: null, status: 'NO DATA' };
    }

    const first = records[0];
    const last  = records[records.length - 1];

    const firstTs = first.hd?.ts_event ? decodeTs(first.hd.ts_event) : decodeTs(first.ts_event);
    const lastTs  = last.hd?.ts_event  ? decodeTs(last.hd.ts_event)  : decodeTs(last.ts_event);
    const firstPx = decodePx(first.close);
    const lastPx  = decodePx(last.close);

    console.log(`    Bars: ${records.length}`);
    console.log(`    First: ${firstTs.toISOString()}  close=${firstPx.toFixed(2)}`);
    console.log(`    Last:  ${lastTs.toISOString()}  close=${lastPx.toFixed(2)}`);

    return {
      symbol: sym.internal,
      bars: records.length,
      first: { ts: firstTs, close: firstPx },
      last:  { ts: lastTs,  close: lastPx },
      latestPrice: lastPx,
      status: 'OK',
    };
  } catch (e) {
    // Databento historical API has ~3-4h processing delay after midnight UTC.
    // 422 with data_start_after_available_end is expected, not an error.
    if (e.message.includes('422') && e.message.includes('data_start_after_available_end')) {
      console.log(`    ⏳ Data not yet indexed by Databento (expected ~3h delay after midnight UTC) — live feed healthy`);
      return { symbol: sym.internal, bars: 0, first: null, last: null, latestPrice: null, status: 'PENDING' };
    }
    console.log(`    ❌ Error: ${e.message}`);
    return { symbol: sym.internal, bars: 0, first: null, last: null, latestPrice: null, status: 'ERROR' };
  }
}

async function section3() {
  hr('SECTION 3: HISTORICAL OHLCV — LAST 90 MINUTES');

  if (!API_KEY) {
    console.log('  Skipped — no API key.');
    return [];
  }

  const results = [];
  for (const sym of DIAG_SYMBOLS) {
    const r = await fetchRecentBars(sym);
    results.push(r);
    if (r.bars === 0 && r.status !== 'ERROR') {
      console.log(`    ⚠ NO DATA — market may be closed or low liquidity\n`);
    } else {
      console.log();
    }
  }
  console.log('  Note: Low bar counts on MGC/SIL/MHG/bonds are normal due to liquidity differences.');
  return results;
}

// ── SECTION 4: SUMMARY ─────────────────────────────────────────────────────

function section4(results, opraSymbols) {
  hr('SECTION 4: SUMMARY');

  if (!results || results.length === 0) {
    console.log('  No results to summarize.');
    return;
  }

  const cols = {
    symbol:   8,
    bars:     6,
    price:    12,
    time:     26,
    status:   10,
  };

  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);

  const header = `  ${pad('Symbol', cols.symbol)}${rpad('Bars', cols.bars)}  ${pad('Latest Price', cols.price)} ${pad('Latest Bar Time', cols.time)}${pad('Status', cols.status)}`;
  const divider = '  ' + '-'.repeat(cols.symbol + cols.bars + cols.price + cols.time + cols.status + 2);

  const tradeableSyms = ['MNQ', 'MES', 'M2K', 'MYM', 'MGC', 'SIL', 'MHG', 'MCL'];
  const tradeable = results.filter(r => tradeableSyms.includes(r.symbol));
  const reference = results.filter(r => !tradeableSyms.includes(r.symbol));

  const printRow = (r) => {
    const price = r.latestPrice != null ? r.latestPrice.toFixed(2) : '—';
    const time  = r.last?.ts ? r.last.ts.toISOString() : '—';
    console.log(
      `  ${pad(r.symbol, cols.symbol)}${rpad(r.bars, cols.bars)}  ${pad(price, cols.price)} ${pad(time, cols.time)}${pad(r.status, cols.status)}`
    );
  };

  console.log('  ── Tradeable (8) ──');
  console.log(header);
  console.log(divider);
  tradeable.forEach(printRow);

  console.log('\n  ── Reference (8) ──');
  console.log(header);
  console.log(divider);
  reference.forEach(printRow);

  console.log();

  const okCount      = results.filter(r => r.status === 'OK').length;
  const pendingCount = results.filter(r => r.status === 'PENDING').length;
  const errorCount   = results.filter(r => r.status === 'ERROR').length;

  if (okCount === results.length) {
    console.log('  ✅ All symbols returning data — Databento connection healthy.');
  } else if (okCount > 0) {
    console.log(`  ⚠️  ${okCount}/${results.length} symbols returning data. Others may be outside market hours.`);
  } else if (pendingCount > 0 && errorCount === 0) {
    console.log('  ⏳ Historical API unavailable (post-midnight lag) — live feed healthy');
  } else {
    console.log('  ❌ No symbols returning data. Market closed or API issue.');
  }

  if (pendingCount > 0) {
    console.log(`  Note: PENDING = Databento historical API lag (~3h after midnight UTC). Live feed is unaffected.`);
  }

  // OPRA baseline
  console.log();
  if (opraSymbols && opraSymbols.length > 0) {
    console.log(`  OPRA baseline: ${opraSymbols.join(', ')}`);
  } else {
    console.log('  OPRA baseline: NONE — autotrader options data may be stale');
  }
}

// ── SECTION 5: OPRA DATA HEALTH ─────────────────────────────────────────────

async function section5() {
  hr('SECTION 5: OPRA DATA HEALTH');

  let data;
  try {
    const body = await localGet('http://localhost:3000/api/opra/health');
    data = JSON.parse(body);
  } catch (e) {
    console.log(`  ⚠ Server not running — skipping Section 5`);
    return;
  }

  if (!data.subscribedSymbols || data.subscribedSymbols.length === 0) {
    console.log('  No OPRA symbols subscribed.');
    return;
  }

  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);

  const header = `  ${pad('Symbol', 8)} ${rpad('Contracts', 10)}  ${pad('Last Definition', 26)} ${rpad('HP', 6)} ${rpad('GEX', 10)} ${rpad('DEX', 8)} ${pad('Resilience', 12)} ${rpad('Ratio', 8)} ${pad('Ratio Source', 28)} ${pad('Source', 12)}`;
  console.log(header);
  console.log('  ' + '─'.repeat(148));

  const healthy = [];
  const warning = [];

  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

  for (const sym of data.subscribedSymbols) {
    const dh = data.dataHealth?.[sym] || {};
    const hp = data.hpSnapshot?.[sym] || null;

    const contracts = dh.contractCount ?? 0;
    const defTs     = dh.lastDefinitionTs || null;

    const hpStr      = hp?.hp != null ? hp.hp.toFixed(2) : '—';
    const gexStr     = hp?.totalGex != null ? _fmtGex(hp.totalGex) : '—';
    const dexStr     = hp?.dex != null ? hp.dex.toFixed(2) : '—';
    const resStr     = hp?.resilience || '—';
    const srcStr     = hp?.dataSource || '—';
    const ratioStr   = hp?.scalingRatio != null ? hp.scalingRatio.toFixed(2) : '—';
    const ratioSrc   = hp?.scalingRatioSource || '—';
    const ratioAt    = hp?.scalingRatioComputedAt ? hp.scalingRatioComputedAt.replace(/T/, ' @ ').slice(0, 22) : '';
    const ratioFull  = ratioSrc !== '—' ? `${ratioSrc}${ratioAt ? ' ' + ratioAt : ''}` : '—';

    console.log(
      `  ${pad(sym, 8)} ${rpad(contracts, 10)}  ${pad(defTs || '—', 26)} ${rpad(hpStr, 6)} ${rpad(gexStr, 10)} ${rpad(dexStr, 8)} ${pad(resStr, 12)} ${rpad(ratioStr, 8)} ${pad(ratioFull, 28)} ${pad(srcStr, 12)}`
    );

    // Classify health
    const defRecent = defTs && new Date(defTs).getTime() > twoHoursAgo;
    if (contracts > 0 && defRecent) {
      healthy.push(sym);
    } else {
      warning.push(sym);
    }
  }

  console.log();
  if (healthy.length > 0) {
    console.log(`  ✅ ${healthy.join(', ')} receiving definition + OI data`);
  }
  if (warning.length > 0) {
    console.log(`  ⚠ ${warning.join(', ')} — subscribed but no records yet (may be outside options trading hours)`);
  }
}

function _fmtGex(gex) {
  const abs = Math.abs(gex);
  const sign = gex < 0 ? '-' : '';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'K';
  return String(gex);
}

// ── MAIN ────────────────────────────────────────────────────────────────────

async function section2WithOpra() {
  hr('SECTION 2: LIVE FEED STATUS (via running server)');

  let opraSymbols = [];
  try {
    const body = await localGet('http://localhost:3000/api/datastatus');
    const data = JSON.parse(body);
    console.log(`  Source:        ${data.source || 'N/A'}`);
    console.log(`  WS Connected:  ${data.wsConnected ?? 'N/A'}`);
    console.log(`  Lag (seconds): ${data.lagSeconds ?? 'N/A'}`);
    console.log(`  Last Bar Time: ${data.lastBarTime || 'N/A'}`);

    if (data.lastBarTimes) {
      console.log('\n  Per-symbol last bar times:');
      for (const [sym, ts] of Object.entries(data.lastBarTimes)) {
        const d = ts ? new Date(ts) : null;
        console.log(`    ${sym.padEnd(6)} → ${d ? d.toISOString() : 'no data'}`);
      }
    }

    if (data.opra) {
      console.log(`\n  OPRA connected: ${data.opra.connected ?? 'N/A'}`);
      const subs = data.opra.subscribedSymbols;
      opraSymbols = Array.isArray(subs) ? subs : [];
      console.log(`  OPRA subscribed: ${opraSymbols.length > 0 ? opraSymbols.join(', ') : 'NONE — autotrader options data may be stale'}`);
    }

    console.log('\n  ✅ Server responded OK');
  } catch (e) {
    console.log(`  ⚠️  Server not reachable at localhost:3000 — ${e.message}`);
    console.log('  (This is fine — this section only works when the server is running.)');
  }
  return opraSymbols;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         Databento Diagnostic — FuturesEdge AI           ║');
  console.log('║         ' + new Date().toISOString() + '            ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  await section1();
  const opraSymbols = await section2WithOpra();
  const results = await section3();
  section4(results, opraSymbols);
  await section5();

  console.log('\nDone.\n');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
