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

module.exports = { saveAlertCache, loadAlertCache, saveCommentaryCache, loadCommentaryCache };
