'use strict';

require('dotenv').config();

const API_URL = process.env.TRADOVATE_API_URL;

// Renew 15 minutes before the 90-minute expiry, as Tradovate recommends.
// Do NOT call accessTokenRequest to refresh — it opens a new session and burns
// one of your two allowed concurrent session slots.
const RENEW_BEFORE_MS = 15 * 60 * 1000;

// In-memory session state — shared across the process lifetime
const session = {
  accessToken: null,
  mdAccessToken: null,   // used to authenticate the market-data WebSocket
  expirationTime: null,
  userId: null,
};

let renewTimer = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new Tradovate session. Call once on server startup.
 * Schedules automatic token renewal going forward.
 */
async function authenticate() {
  console.log('[auth] Requesting Tradovate access token...');

  // cid is the numeric API Key ID from Settings → Generate API Key.
  // It is distinct from appId (a freeform app name string).
  const body = {
    name:       process.env.TRADOVATE_USERNAME,
    password:   process.env.TRADOVATE_PASSWORD,
    appId:      'FuturesEdge AI',
    appVersion: '1.0',
    cid:        process.env.TRADOVATE_APP_ID,
    sec:        process.env.TRADOVATE_APP_SECRET,
  };

  const res = await fetch(`${API_URL}/auth/accessTokenRequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`[auth] HTTP ${res.status} from accessTokenRequest`);
  }

  const data = await res.json();

  if (data.errorText) {
    throw new Error(`[auth] ${data.errorText}`);
  }

  applyToken(data);
  console.log(`[auth] Authenticated — userId: ${session.userId}, expires: ${session.expirationTime.toISOString()}`);

  return session;
}

/**
 * Extend the current session without opening a new one.
 * Falls back to full re-authentication if renewal fails.
 */
async function renewToken() {
  console.log('[auth] Renewing access token...');

  const res = await fetch(`${API_URL}/auth/renewAccessToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.accessToken}`,
    },
  });

  if (!res.ok) {
    console.warn(`[auth] Renewal HTTP ${res.status} — falling back to full re-auth`);
    return authenticate();
  }

  const data = await res.json();

  if (data.errorText) {
    console.warn(`[auth] Renewal error: ${data.errorText} — falling back to full re-auth`);
    return authenticate();
  }

  applyToken(data);
  console.log(`[auth] Token renewed — new expiry: ${session.expirationTime.toISOString()}`);

  return session;
}

/** Return the access token (for REST requests). */
function getToken() {
  return session.accessToken;
}

/** Return the market-data access token (for WebSocket auth). */
function getMdToken() {
  return session.mdAccessToken;
}

/** True only while a valid, non-expired token is held. */
function isAuthenticated() {
  return !!session.accessToken && session.expirationTime > new Date();
}

/**
 * Guarantee an authenticated session before making an API call.
 * Safe to call on every request — is a no-op when already authenticated.
 */
async function ensureAuthenticated() {
  if (!isAuthenticated()) {
    await authenticate();
  }
  return session.accessToken;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function applyToken(data) {
  session.accessToken   = data.accessToken;
  session.mdAccessToken = data.mdAccessToken ?? null;
  session.expirationTime = new Date(data.expirationTime);
  session.userId        = data.userId ?? session.userId;

  scheduleRenewal();
}

function scheduleRenewal() {
  if (renewTimer) clearTimeout(renewTimer);

  const delay = session.expirationTime.getTime() - Date.now() - RENEW_BEFORE_MS;

  if (delay <= 0) {
    // Already inside the renewal window — act immediately
    renewToken().catch(err => console.error('[auth] Immediate renewal failed:', err.message));
    return;
  }

  console.log(`[auth] Next renewal in ${Math.round(delay / 60_000)} minute(s).`);

  renewTimer = setTimeout(() => {
    renewToken().catch(err => console.error('[auth] Scheduled renewal failed:', err.message));
  }, delay);
}

// ---------------------------------------------------------------------------

module.exports = {
  authenticate,
  renewToken,
  getToken,
  getMdToken,
  isAuthenticated,
  ensureAuthenticated,
  session,
};
