'use strict';
// Phase 2 of data-layer remediation (v14.35).
//
// Walks every per-date bar file under `data/historical/futures/{sym}/{tf}/{date}.json`
// and heals two defects identified in the 2026-04-21 audit:
//   - Bug 1: ts→time schema drift (some bars have `ts`, some have `time`, some both).
//   - Bug 2 / Bug 6: duplicate timestamps (Bug 2 produces single dupes on every hourly
//     refresh interleave; Bug 6 shows ~50% dup pile-up on 2026-04-08/09).
//
// For every bar in every file:
//   - If bar has both `time` and `ts` → keep `time`, drop `ts`.
//   - If bar has only `ts`          → rename to `time`.
//   - If bar has only `time`        → no change.
//   - If bar has neither            → log warning, drop bar.
//
// After per-bar normalization, dedup by `time`:
//   - When duplicates differ in `volume`, keep the one with highest volume (more
//     complete bar).
//   - On volume ties, last occurrence wins (stable semantics; matches how the
//     hourly refresh authoritatively replaces earlier live-archive writes).
//
// Then sort by `time` ascending and write back only if the file changed.
//
// Backup (per Phase 2 gate decision, 2026-04-21): each modified file is renamed
// to `<file>.bak` before the new content is written. Zero-cost per-file rollback:
//     find data/historical/futures -name '*.json.bak' \
//       | xargs -I{} bash -c 'mv "{}" "${1%.bak}"' _ {}
// Use `--no-backup` to skip `.bak` creation.
//
// Flags:
//   --dry-run            Report what would be done; write nothing. ALWAYS run this first.
//   --symbol SYM         Restrict to one symbol (for spot-testing).
//   --verbose            Log every file processed.
//   --no-backup          Skip .bak sidecar creation (not recommended).
//   (default, no flags)  Real run on all symbols with .bak sidecars.

const fs   = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const DRY_RUN     = argv.includes('--dry-run');
const VERBOSE     = argv.includes('--verbose');
const NO_BACKUP   = argv.includes('--no-backup');
const SYMBOL_IDX  = argv.indexOf('--symbol');
const SYMBOL      = SYMBOL_IDX >= 0 ? argv[SYMBOL_IDX + 1] : null;

const FUT_ROOT = path.join(__dirname, '..', 'data', 'historical', 'futures');

function log(...args)  { console.log(...args); }
function vlog(...args) { if (VERBOSE) console.log(...args); }
function warn(...args) { console.warn(...args); }

const stats = {
  filesScanned:      0,
  filesChanged:      0,
  filesUnchanged:    0,
  filesSkippedEmpty: 0,
  filesBackedUp:     0,
  barsTotal:         0,
  barsRenamed:       0,   // ts-only → time
  barsDroppedBoth:   0,   // dropped `ts` when both present
  barsDroppedBad:    0,   // neither field present — logged + dropped
  barsDeduped:       0,   // removed as duplicates
  perSymbolChanges:  {},  // symbol → { files: N, barsIn: N, barsOut: N }
};

function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    return Array.isArray(obj) ? obj : null;
  } catch (e) {
    warn(`  [READ-ERROR] ${filePath}: ${e.message}`);
    return null;
  }
}

function writeJSON(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
}

/**
 * Normalize a single file in memory. Returns { bars, changed } where `bars` is
 * the cleaned array and `changed` is true if any edit is required vs the input.
 */
function normalizeFile(relPath, originalBars, symbol) {
  const out = [];
  let renamed = 0;
  let droppedBoth = 0;
  let droppedBad = 0;

  for (const b of originalBars) {
    const hasTime = b && b.time !== undefined && b.time !== null;
    const hasTs   = b && b.ts   !== undefined && b.ts   !== null;

    if (hasTime && hasTs) {
      // Keep `time`, drop `ts`. Bar is otherwise unchanged.
      const { ts: _dropped, ...rest } = b;
      out.push(rest);
      droppedBoth++;
    } else if (hasTs && !hasTime) {
      // Rename ts → time.
      const { ts, ...rest } = b;
      out.push({ time: ts, ...rest });
      renamed++;
    } else if (hasTime && !hasTs) {
      // Already canonical.
      out.push(b);
    } else {
      // Neither field — bar is unusable. Log and drop.
      warn(`  [BAD-BAR] ${relPath}: dropping bar with no time/ts field: ${JSON.stringify(b).slice(0, 120)}`);
      droppedBad++;
    }
  }

  // Dedup by `time`: highest volume wins; last-occurrence breaks volume ties.
  // Build a Map keyed by time; later entries replace earlier ones only when
  // their volume is strictly higher, OR when volumes are equal (last wins).
  const byTime = new Map();
  for (const b of out) {
    const t = b.time;
    const existing = byTime.get(t);
    if (!existing) {
      byTime.set(t, b);
    } else {
      const vExisting = Number(existing.volume ?? 0);
      const vNew      = Number(b.volume ?? 0);
      if (vNew > vExisting) {
        byTime.set(t, b);
      } else if (vNew === vExisting) {
        byTime.set(t, b); // last-occurrence wins on ties (replaces existing)
      }
      // else: keep existing (higher volume)
    }
  }
  const deduped = Array.from(byTime.values());
  const dedupedCount = out.length - deduped.length;

  // Sort ascending by time.
  deduped.sort((a, b) => a.time - b.time);

  // Compare against input to decide `changed`. Cheap sentinel checks first.
  let changed = false;
  if (deduped.length !== originalBars.length) {
    changed = true;
  } else {
    for (let i = 0; i < deduped.length; i++) {
      const a = deduped[i];
      const b = originalBars[i];
      if (!b || a.time !== (b.time ?? b.ts) || a.close !== b.close || a.volume !== b.volume || a.ts !== undefined || b.ts !== undefined) {
        changed = true;
        break;
      }
    }
  }

  return {
    bars:       deduped,
    changed,
    renamed,
    droppedBoth,
    droppedBad,
    dedupedCount,
  };
}

function processFile(symbol, tf, filePath) {
  const relPath = path.relative(FUT_ROOT, filePath);
  stats.filesScanned++;

  const bars = readJSON(filePath);
  if (!bars) {
    // Read failure already logged; skip this file.
    return;
  }
  if (bars.length === 0) {
    stats.filesSkippedEmpty++;
    vlog(`  [EMPTY] ${relPath}`);
    return;
  }

  const result = normalizeFile(relPath, bars, symbol);
  stats.barsTotal          += bars.length;
  stats.barsRenamed        += result.renamed;
  stats.barsDroppedBoth    += result.droppedBoth;
  stats.barsDroppedBad     += result.droppedBad;
  stats.barsDeduped        += result.dedupedCount;

  const s = (stats.perSymbolChanges[symbol] ||= { files: 0, barsIn: 0, barsOut: 0, deduped: 0, renamed: 0 });
  s.barsIn  += bars.length;
  s.barsOut += result.bars.length;

  if (!result.changed) {
    stats.filesUnchanged++;
    vlog(`  [UNCHANGED] ${relPath} (${bars.length} bars)`);
    return;
  }

  stats.filesChanged++;
  s.files++;
  s.deduped += result.dedupedCount;
  s.renamed += result.renamed;

  vlog(`  [CHANGED] ${relPath}: ${bars.length}→${result.bars.length} bars ` +
       `(renamed=${result.renamed} droppedBoth=${result.droppedBoth} ` +
       `droppedBad=${result.droppedBad} deduped=${result.dedupedCount})`);

  if (DRY_RUN) return;

  // Backup: rename original to <file>.bak (unless --no-backup)
  if (!NO_BACKUP) {
    try {
      fs.renameSync(filePath, filePath + '.bak');
      stats.filesBackedUp++;
    } catch (e) {
      warn(`  [BACKUP-ERROR] ${relPath}: ${e.message} — SKIPPING write to avoid data loss`);
      return;
    }
  }
  writeJSON(filePath, result.bars);
}

function walkSymbol(symbol) {
  const symDir = path.join(FUT_ROOT, symbol);
  if (!fs.existsSync(symDir)) return;

  const tfs = fs.readdirSync(symDir).filter(tf => {
    const p = path.join(symDir, tf);
    return fs.statSync(p).isDirectory();
  });

  for (const tf of tfs) {
    const tfDir = path.join(symDir, tf);
    const files = fs.readdirSync(tfDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    for (const f of files) {
      processFile(symbol, tf, path.join(tfDir, f));
    }
  }
}

function main() {
  log('═══════════════════════════════════════════════════════════');
  log(' Bar schema migration — v14.35 (Phase 2)');
  log('═══════════════════════════════════════════════════════════');
  log(` DRY_RUN=${DRY_RUN}  SYMBOL=${SYMBOL || 'all'}  NO_BACKUP=${NO_BACKUP}  VERBOSE=${VERBOSE}`);
  log('');

  if (!fs.existsSync(FUT_ROOT)) {
    warn(`Root missing: ${FUT_ROOT}`);
    process.exit(1);
  }

  const symbols = SYMBOL
    ? [SYMBOL]
    : fs.readdirSync(FUT_ROOT).filter(s => fs.statSync(path.join(FUT_ROOT, s)).isDirectory());

  const t0 = Date.now();
  for (const sym of symbols) {
    log(`── ${sym} ─────────────────────────────────`);
    const before = { files: stats.filesScanned, changed: stats.filesChanged };
    walkSymbol(sym);
    const touched = stats.filesChanged - before.changed;
    const scanned = stats.filesScanned - before.files;
    log(`  scanned=${scanned} changed=${touched}`);
  }
  const elapsedMs = Date.now() - t0;

  log('');
  log('═══════════════════════════════════════════════════════════');
  log(' Summary');
  log('═══════════════════════════════════════════════════════════');
  log(` Files scanned:       ${stats.filesScanned.toLocaleString()}`);
  log(` Files changed:       ${stats.filesChanged.toLocaleString()}`);
  log(` Files unchanged:     ${stats.filesUnchanged.toLocaleString()}`);
  log(` Files empty/skipped: ${stats.filesSkippedEmpty.toLocaleString()}`);
  log(` Files backed up:     ${stats.filesBackedUp.toLocaleString()}`);
  log('');
  log(` Bars processed:              ${stats.barsTotal.toLocaleString()}`);
  log(` Bars migrated (ts→time):     ${stats.barsRenamed.toLocaleString()}`);
  log(` Bars cleaned (both→time):    ${stats.barsDroppedBoth.toLocaleString()}`);
  log(` Bars dropped (no time/ts):   ${stats.barsDroppedBad.toLocaleString()}`);
  log(` Bars deduped:                ${stats.barsDeduped.toLocaleString()}`);
  log('');
  log(` Per-symbol changes:`);
  for (const [sym, s] of Object.entries(stats.perSymbolChanges).sort(([a],[b]) => a.localeCompare(b))) {
    log(`   ${sym.padEnd(6)} files=${String(s.files).padStart(5)}  barsIn=${String(s.barsIn).padStart(9)}  barsOut=${String(s.barsOut).padStart(9)}  renamed=${String(s.renamed).padStart(9)}  deduped=${String(s.deduped).padStart(9)}`);
  }
  log('');
  log(` Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
  if (DRY_RUN) log(' (dry run — no files written)');
  log('');
}

main();
