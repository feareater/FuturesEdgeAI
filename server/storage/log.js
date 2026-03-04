'use strict';
// Alert and commentary cache persistence.
// Saves to data/logs/ so alert history and AI commentary survive server restarts.
// Write failures are always caught and logged — never crash the server.

const fs   = require('fs');
const path = require('path');

const LOG_DIR         = path.join(__dirname, '..', '..', 'data', 'logs');
const ALERTS_FILE     = path.join(LOG_DIR, 'alerts.json');
const COMMENTARY_FILE = path.join(LOG_DIR, 'commentary.json');

function _ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ── Alert cache ───────────────────────────────────────────────────────────────

/**
 * Write the full alertCache array to disk.
 * Called after every scan and after single-setup commentary is attached.
 */
function saveAlertCache(alerts) {
  try {
    _ensureDir();
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
  } catch (err) {
    console.error('[log] saveAlertCache failed:', err.message);
  }
}

/**
 * Load the alert cache from disk.
 * Returns [] if the file does not exist or cannot be parsed.
 */
function loadAlertCache() {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
  } catch (err) {
    console.error('[log] loadAlertCache failed:', err.message);
    return [];
  }
}

// ── Commentary cache ──────────────────────────────────────────────────────────

/**
 * Write the commentaryCache object { generated, items } to disk.
 */
function saveCommentaryCache(cache) {
  try {
    _ensureDir();
    fs.writeFileSync(COMMENTARY_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[log] saveCommentaryCache failed:', err.message);
  }
}

/**
 * Load the commentary cache from disk.
 * Returns { generated: null, items: [] } if the file does not exist.
 */
function loadCommentaryCache() {
  try {
    if (!fs.existsSync(COMMENTARY_FILE)) return { generated: null, items: [] };
    return JSON.parse(fs.readFileSync(COMMENTARY_FILE, 'utf8'));
  } catch (err) {
    console.error('[log] loadCommentaryCache failed:', err.message);
    return { generated: null, items: [] };
  }
}

// ── Trade log ─────────────────────────────────────────────────────────────────

const TRADES_FILE = path.join(LOG_DIR, 'trades.json');

/**
 * Write the full tradeLog array to disk.
 */
function saveTradeLog(trades) {
  try {
    _ensureDir();
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  } catch (err) {
    console.error('[log] saveTradeLog failed:', err.message);
  }
}

/**
 * Load the trade log from disk.
 * Returns [] if the file does not exist or cannot be parsed.
 */
function loadTradeLog() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return [];
    return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch (err) {
    console.error('[log] loadTradeLog failed:', err.message);
    return [];
  }
}

// ── Setup archive (append-only historical record) ─────────────────────────────

const ARCHIVE_FILE = path.join(LOG_DIR, 'setup_archive.json');

/**
 * Load the setup archive from disk.
 * Returns [] if the file does not exist or cannot be parsed.
 */
function loadArchive() {
  try {
    if (!fs.existsSync(ARCHIVE_FILE)) return [];
    return JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  } catch (err) {
    console.error('[log] loadArchive failed:', err.message);
    return [];
  }
}

/**
 * Append a new alert snapshot to the archive (dedup by key).
 * This is append-only — existing entries are never modified here.
 */
function appendToArchive(alert) {
  try {
    _ensureDir();
    const key     = `${alert.symbol}:${alert.timeframe}:${alert.setup.type}:${alert.setup.time}`;
    const archive = loadArchive();
    if (archive.some(a => `${a.symbol}:${a.timeframe}:${a.setup.type}:${a.setup.time}` === key)) return;
    archive.push(alert);
    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive, null, 2));
  } catch (err) {
    console.error('[log] appendToArchive failed:', err.message);
  }
}

/**
 * Update the outcome of an archived setup.
 * Only updates outcome + outcomeTime (preserves original snapshot otherwise).
 */
function updateArchiveOutcome(key, outcome, outcomeTime, userOverride = false) {
  try {
    _ensureDir();
    const archive = loadArchive();
    const entry   = archive.find(a => `${a.symbol}:${a.timeframe}:${a.setup.type}:${a.setup.time}` === key);
    if (!entry) return;
    entry.setup.outcome     = outcome;
    entry.setup.outcomeTime = outcomeTime;
    if (userOverride) entry.setup.userOverride = true;
    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive, null, 2));
  } catch (err) {
    console.error('[log] updateArchiveOutcome failed:', err.message);
  }
}

module.exports = {
  saveAlertCache, loadAlertCache,
  saveCommentaryCache, loadCommentaryCache,
  saveTradeLog, loadTradeLog,
  loadArchive, appendToArchive, updateArchiveOutcome,
};
