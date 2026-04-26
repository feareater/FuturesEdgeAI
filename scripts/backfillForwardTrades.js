'use strict';
/**
 * backfillForwardTrades.js — v14.41 Phase 2E.
 *
 * Backfills null market-context fields on post-v14.32 forward trade records
 * whose resolution predates the simulator fix landing fully. Specifically:
 *
 * - equityBreadth / riskAppetite / bondRegime — read from breadth_cache.json
 *   for the ET trading date of entry. Uses the entry-time date, NOT exit-time
 *   (the cache is per-trading-day so both dates would usually match; entry is
 *   the authoritative moment of the market snapshot).
 * - dxyDirection — applies the v14.41 fallback chain:
 *     if breadth cache has `dollarRegime` in {rising, falling} → use it
 *     else leave the existing stamped value alone (it's 'flat' or null and
 *     accurately reflects what the live pipeline produced at trade time).
 *
 * Writes `_backfilledFields: [...]` onto every modified record to preserve
 * provenance. Leaves all other fields untouched. Produces a `.bak` sidecar
 * of the original file before writing.
 *
 * Usage:
 *   node scripts/backfillForwardTrades.js            # apply backfill
 *   node scripts/backfillForwardTrades.js --dry-run  # report only, no writes
 *   node scripts/backfillForwardTrades.js --verify   # show per-record changes
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TRADES_PATH = path.join(ROOT, 'data', 'logs', 'forward_trades.json');
const BREADTH_CACHE_PATH = path.join(ROOT, 'data', 'historical', 'breadth_cache.json');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERIFY  = argv.includes('--verify');

const V14_32_BOUNDARY = '2026-04-20T00:00:00Z';

function toETDate(isoString) {
  // v14.29 simulator toETDate: EDT (Mar–Nov) UTC-4, EST (Nov–Feb) UTC-5
  const dt = new Date(isoString);
  const month = dt.getUTCMonth() + 1;
  const offsetHours = (month >= 3 && month <= 11) ? 4 : 5;
  const et = new Date(dt.getTime() - offsetHours * 3600000);
  return et.toISOString().slice(0, 10);
}

function main() {
  const trades = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'));
  const breadth = JSON.parse(fs.readFileSync(BREADTH_CACHE_PATH, 'utf8'));

  console.log(`[Phase-2E] Loaded ${trades.length} forward trades, ${Object.keys(breadth).length} breadth cache entries.`);

  let modified = 0;
  let cannotBackfill = 0;
  const perTrade = [];

  for (const t of trades) {
    // Only backfill post-v14.32 trades with null breadth fields
    if (!t.exitTime || t.exitTime < V14_32_BOUNDARY) continue;
    const needsBackfill = t.equityBreadth == null || t.riskAppetite == null || t.bondRegime == null;
    if (!needsBackfill) continue;

    // Use entry-time ET date for breadth lookup
    const etDate = toETDate(t.entryTime);
    const b = breadth[etDate];
    if (!b) {
      cannotBackfill++;
      perTrade.push({ alertKey: t.alertKey, entryDate: etDate, status: 'no-breadth-cache-entry' });
      continue;
    }

    const backfilled = [];
    const before = {
      equityBreadth: t.equityBreadth,
      riskAppetite:  t.riskAppetite,
      bondRegime:    t.bondRegime,
      dxyDirection:  t.dxyDirection,
    };

    if (t.equityBreadth == null && b.equityBreadth != null) {
      t.equityBreadth = b.equityBreadth;
      backfilled.push('equityBreadth');
    }
    if (t.riskAppetite == null && b.riskAppetite != null) {
      t.riskAppetite = b.riskAppetite;
      backfilled.push('riskAppetite');
    }
    if (t.bondRegime == null && b.bondRegime != null) {
      t.bondRegime = b.bondRegime;
      backfilled.push('bondRegime');
    }
    // DxyDirection: only upgrade if breadth says rising/falling (never downgrade 'flat' stamped value)
    if (t.dxyDirection === 'flat' && (b.dollarRegime === 'rising' || b.dollarRegime === 'falling')) {
      t.dxyDirection = b.dollarRegime;
      backfilled.push('dxyDirection');
    }

    if (backfilled.length > 0) {
      // Preserve provenance
      if (!Array.isArray(t._backfilledFields)) t._backfilledFields = [];
      for (const f of backfilled) if (!t._backfilledFields.includes(f)) t._backfilledFields.push(f);
      t._backfilledFrom = `breadth_cache.json [${etDate}]`;
      t._backfilledAt = new Date().toISOString();
      t._backfilledPhase = 'v14.41-2E';
      modified++;

      if (VERIFY || modified <= 5) {
        perTrade.push({
          alertKey: t.alertKey,
          entryDate: etDate,
          fields: backfilled,
          before,
          after: {
            equityBreadth: t.equityBreadth,
            riskAppetite:  t.riskAppetite,
            bondRegime:    t.bondRegime,
            dxyDirection:  t.dxyDirection,
          },
        });
      }
    }
  }

  console.log(`[Phase-2E] Modified ${modified} trade records; ${cannotBackfill} could not be backfilled (no breadth cache entry for their entry date).`);
  if (perTrade.length > 0) {
    console.log('[Phase-2E] Sample modifications (first 5 / failures):');
    for (const p of perTrade.slice(0, 10)) console.log('  ', JSON.stringify(p));
  }

  if (!DRY_RUN && modified > 0) {
    const bakPath = TRADES_PATH + '.bak';
    if (fs.existsSync(TRADES_PATH) && !fs.existsSync(bakPath)) {
      fs.copyFileSync(TRADES_PATH, bakPath);
      console.log(`[Phase-2E] Backup: ${bakPath}`);
    }
    fs.writeFileSync(TRADES_PATH, JSON.stringify(trades, null, 2));
    console.log(`[Phase-2E] Wrote ${TRADES_PATH}`);
  } else if (DRY_RUN) {
    console.log('[Phase-2E] DRY-RUN — no files written.');
  }
}

main();
