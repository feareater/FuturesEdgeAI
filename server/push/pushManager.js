'use strict';

/**
 * server/push/pushManager.js
 *
 * Browser Push API subscription management and notification dispatch.
 *
 * Subscriptions are stored in memory and persisted to data/push/subscriptions.json.
 * Uses the web-push npm package with VAPID authentication.
 *
 * Gracefully degrades if web-push is unavailable or VAPID keys are not set
 * in .env — all functions become no-ops with a single startup warning.
 */

const fs   = require('fs');
const path = require('path');

const SUBS_DIR  = path.join(__dirname, '..', '..', 'data', 'push');
const SUBS_FILE = path.join(SUBS_DIR, 'subscriptions.json');

// ---------------------------------------------------------------------------
// web-push init — graceful degrade if keys not set
// ---------------------------------------------------------------------------

let webpush = null;
let _ready  = false;

try {
  webpush = require('web-push');
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:jeff@futuresedge.local';
  if (pub && priv) {
    webpush.setVapidDetails(subj, pub, priv);
    _ready = true;
    console.log('[Push] VAPID keys loaded — push notifications enabled');
  } else {
    console.warn('[Push] VAPID keys not set in .env — push notifications disabled');
  }
} catch (err) {
  console.warn('[Push] web-push not available:', err.message);
}

// ---------------------------------------------------------------------------
// In-memory subscription store
// ---------------------------------------------------------------------------

let _subscriptions = [];  // array of PushSubscription objects (endpoint + keys)

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function _ensureDir() {
  if (!fs.existsSync(SUBS_DIR)) fs.mkdirSync(SUBS_DIR, { recursive: true });
}

function _persist() {
  try {
    _ensureDir();
    fs.writeFileSync(SUBS_FILE, JSON.stringify(_subscriptions, null, 2));
  } catch (err) {
    console.error('[Push] Failed to persist subscriptions:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load subscriptions from disk at startup.
 * Call once during server init.
 */
function loadSubscriptions() {
  try {
    if (!fs.existsSync(SUBS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    if (Array.isArray(data)) {
      _subscriptions = data;
      console.log(`[Push] Loaded ${_subscriptions.length} subscription(s) from disk`);
    }
  } catch (err) {
    console.error('[Push] Failed to load subscriptions:', err.message);
  }
}

/**
 * Add a new PushSubscription object.
 * Deduplicates by endpoint URL. Persists immediately.
 */
function saveSubscription(sub) {
  if (!sub || !sub.endpoint) return;
  const exists = _subscriptions.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    _subscriptions.push(sub);
    _persist();
    console.log(`[Push] New subscription saved (total: ${_subscriptions.length})`);
  }
}

/**
 * Remove a subscription by its endpoint URL. Persists immediately.
 */
function removeSubscription(endpoint) {
  const before = _subscriptions.length;
  _subscriptions = _subscriptions.filter(s => s.endpoint !== endpoint);
  if (_subscriptions.length !== before) {
    _persist();
    console.log(`[Push] Subscription removed (total: ${_subscriptions.length})`);
  }
}

/**
 * Send a push notification to all stored subscriptions.
 *
 * Payload shape: { title, body, icon, data }
 * Subscriptions that return HTTP 410 Gone are removed automatically.
 * All other errors are logged but never thrown.
 */
async function sendPushNotification(payload) {
  if (!_ready || !webpush) return;
  if (_subscriptions.length === 0) return;

  const json = JSON.stringify(payload);
  console.log(`[Push] Sending notification to ${_subscriptions.length} subscriber(s): ${payload.title}`);

  const toRemove = [];
  for (const sub of [..._subscriptions]) {
    try {
      await webpush.sendNotification(sub, json);
    } catch (err) {
      if (err.statusCode === 410) {
        // User unsubscribed — remove silently
        toRemove.push(sub.endpoint);
      } else {
        console.error(`[Push] sendNotification error (${sub.endpoint.slice(-20)}):`, err.message);
      }
    }
  }

  for (const endpoint of toRemove) {
    removeSubscription(endpoint);
  }
}

/**
 * Returns the VAPID public key string (safe to expose to browser clients).
 */
function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * Returns true if push is configured and ready.
 */
function isReady() {
  return _ready;
}

// ---------------------------------------------------------------------------

module.exports = {
  loadSubscriptions,
  saveSubscription,
  removeSubscription,
  sendPushNotification,
  getVapidPublicKey,
  isReady,
};
