'use strict';
// Phase 4 of data-layer remediation (v14.37).
//
// Pulls daily OHLCV closes for one or more ETF tickers via the Databento
// historical REST API (DBEQ.BASIC, ohlcv-1d) and merges them into
// `data/historical/etf_closes.json` — the same map that `historicalPipeline.js`
// Phase 1d populates from local zip extracts, and that `hpCompute.js` +
// `options.js` consume to look up underlying ETF prices for HP / GEX / DEX /
// resilience computation.
//
// Primary use case at introduction: DIA (Dow Jones ETF, MYM options proxy)
// had zero entries in etf_closes.json because the raw daily-close zip was
// never purchased from Databento. Hitting the REST API instead of the local
// zip extract path unblocks MYM options-proxy HP without a data procurement
// detour.
//
// Secondary use case: bring IWM (or any other ETF) current when its local
// zip only covers up to 2026-04-02 but recent closes are needed.
//
// Merge semantics: per-date last-write-wins within the ETF's sub-map. Other
// ETFs in etf_closes.json are left untouched.
//
// Flags:
//   --ticker TKR   Required. ETF ticker (repeatable).
//   --start ISO    Start date (YYYY-MM-DD or ISO). Default 2018-01-01.
//   --end ISO      End date   (YYYY-MM-DD or ISO). Default yesterday UTC.
//   --dry-run      Fetch + report; no write.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');

const { fetchETFDailyCloses } = require('../server/data/databento');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

function flagVals(flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1]);
  return out;
}

const tickers = flagVals('--ticker');
if (tickers.length === 0) {
  console.error('Usage: node scripts/backfillETFDailyCloses.js --ticker DIA [--ticker IWM] [--start 2018-01-01] [--end 2026-04-20] [--dry-run]');
  process.exit(1);
}

const startIsoArg = flagVals('--start')[0] || '2018-01-01';
const endIsoArg   = flagVals('--end')[0]   || new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);

function toIso(d) { return /T/.test(d) ? d : `${d}T00:00:00Z`; }
const startIso = toIso(startIsoArg);
const endIso   = toIso(endIsoArg);

const CLOSES_PATH = path.resolve(__dirname, '..', 'data', 'historical', 'etf_closes.json');

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' ETF daily-close backfill via Databento REST (Phase 4)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Tickers: ${tickers.join(', ')}`);
  console.log(` Window:  ${startIso} → ${endIso}`);
  console.log(` DRY_RUN=${DRY_RUN}`);
  console.log('');

  if (!process.env.DATABENTO_API_KEY) {
    console.error('DATABENTO_API_KEY not set');
    process.exit(1);
  }

  let closesMap = {};
  try {
    closesMap = JSON.parse(fs.readFileSync(CLOSES_PATH, 'utf8'));
  } catch {
    console.warn(`  [NEW FILE] etf_closes.json not found — will create at ${CLOSES_PATH}`);
  }

  for (const ticker of tickers) {
    const before = closesMap[ticker] ? Object.keys(closesMap[ticker]).length : 0;
    console.log(`── ${ticker} — fetching (existing entries: ${before}) ──`);

    let fetched;
    try {
      fetched = await fetchETFDailyCloses(ticker, startIso, endIso);
    } catch (err) {
      console.error(`  [ERROR] ${ticker}: ${err.message}`);
      continue;
    }

    const fetchedDates = Object.keys(fetched).sort();
    if (fetchedDates.length === 0) {
      console.warn(`  [EMPTY] ${ticker}: 0 dates returned`);
      continue;
    }
    console.log(`  ${ticker}: ${fetchedDates.length} dates fetched (${fetchedDates[0]} → ${fetchedDates[fetchedDates.length - 1]})`);

    if (DRY_RUN) continue;

    closesMap[ticker] = closesMap[ticker] || {};
    let added = 0, updated = 0;
    for (const [date, close] of Object.entries(fetched)) {
      if (closesMap[ticker][date] === undefined) added++;
      else if (closesMap[ticker][date] !== close) updated++;
      closesMap[ticker][date] = close;
    }
    const after = Object.keys(closesMap[ticker]).length;
    console.log(`  ${ticker}: merged — added=${added} updated=${updated} total=${after}`);
  }

  if (DRY_RUN) {
    console.log('\n(dry run — etf_closes.json not written)');
    return;
  }

  if (fs.existsSync(CLOSES_PATH)) {
    fs.copyFileSync(CLOSES_PATH, CLOSES_PATH + '.bak');
  }
  fs.writeFileSync(CLOSES_PATH, JSON.stringify(closesMap), 'utf8');
  console.log(`\nWrote ${CLOSES_PATH} (previous version saved as etf_closes.json.bak)`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
