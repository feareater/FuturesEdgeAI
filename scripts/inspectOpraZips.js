'use strict';
/**
 * scripts/inspectOpraZips.js — read-only manifest inspection for OPRA zips.
 *
 * Walks Historical_data/OPRA/{etf}/*.zip, extracts ONLY metadata.json from each
 * zip via the unzipper streaming API (does NOT extract the .csv.zst payload),
 * and prints a table of: ETF | zip | schema | dataset | start | end | symbols.
 *
 * Use this BEFORE running phase 1b to confirm:
 *   1. Each zip's schema is statistics or definitions (no surprises)
 *   2. Date coverage of the new zips
 *   3. Whether any zip contains a non-{statistics,definitions} schema that
 *      would need a filter in phase 1b
 */

const fs        = require('fs');
const path      = require('path');
const unzipper  = require('unzipper');

const HIST_DATA = path.resolve(__dirname, '..', 'Historical_data');
const OPRA_DIR  = path.join(HIST_DATA, 'OPRA');
const ETFS      = ['QQQ', 'SPY', 'IWM', 'GLD', 'USO', 'SLV', 'DIA'];

const PREFIX = '[INSPECT-OPRA]';
const log = (...a) => console.log(PREFIX, ...a);

async function readMetadata(zipPath) {
  try {
    const directory = await unzipper.Open.file(zipPath);
    const entry = directory.files.find(f => f.path === 'metadata.json');
    if (!entry) return { error: 'no metadata.json in zip' };
    const buf = await entry.buffer();
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    return { error: err.message };
  }
}

async function listZipEntries(zipPath) {
  try {
    const directory = await unzipper.Open.file(zipPath);
    return directory.files.map(f => ({ path: f.path, size: f.uncompressedSize, type: f.type }));
  } catch (err) {
    return [{ error: err.message }];
  }
}

(async () => {
  log(`Scanning ${OPRA_DIR}`);
  const rows = [];

  for (const etf of ETFS) {
    const dir = path.join(OPRA_DIR, etf);
    if (!fs.existsSync(dir)) { log(`  ${etf}: no dir`); continue; }
    const zips = fs.readdirSync(dir).filter(f => f.endsWith('.zip')).sort();

    for (const z of zips) {
      const zipPath = path.join(dir, z);
      const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
      const meta = await readMetadata(zipPath);

      if (meta.error) {
        rows.push({ etf, zip: z, sizeMB, schema: '?', dataset: '?', start: '?', end: '?', symbols: meta.error });
        log(`  ${etf} ${z} (${sizeMB} MB): metadata error: ${meta.error}`);
        continue;
      }

      const q       = meta?.query  || {};
      const schema  = q.schema     || '?';
      const dataset = q.dataset    || '?';
      const start   = String(q.start ?? '').slice(0, 19);
      const end     = String(q.end   ?? '').slice(0, 19);
      const symbols = Array.isArray(q.symbols) ? q.symbols.slice(0, 3).join(',') + (q.symbols.length > 3 ? `...+${q.symbols.length - 3}` : '') : '?';

      rows.push({ etf, zip: z, sizeMB, schema, dataset, start, end, symbols });
      log(`  ${etf} ${z} (${sizeMB} MB): schema=${schema} dataset=${dataset} ${start}..${end}`);

      // Sample a few entry filenames to detect any extra schemas inside
      const entries = await listZipEntries(zipPath);
      const firstFile = entries.filter(e => e.type !== 'Directory' && e.path !== 'metadata.json' && e.path !== 'condition.json' && e.path !== 'manifest.json').slice(0, 3);
      for (const e of firstFile) {
        log(`        sample entry: ${e.path}`);
      }
      // Distinct schema patterns inside (e.g. .statistics., .definition., .ohlcv-1s.)
      const patterns = new Set();
      for (const e of entries) {
        if (e.type === 'Directory') continue;
        const m = e.path.match(/\.(statistics|definition|ohlcv-1s|ohlcv-1d|trades|tcbbo|tbbo|mbp|mbo)\./);
        if (m) patterns.add(m[1]);
      }
      log(`        schema patterns in zip: ${[...patterns].join(', ') || '—'}`);
    }
  }

  log('');
  log('═══ SUMMARY ═══');
  console.table(rows);
})().catch(err => { console.error(`${PREFIX} FATAL:`, err); process.exit(1); });
