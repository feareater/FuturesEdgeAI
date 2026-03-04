'use strict';
// Economic calendar — fetches high-impact events from ForexFactory public feed.
// Cached in-memory for 1 hour. Falls back to empty array on failure (never crashes scan).
//
// Symbol relevance mapping:
//   MNQ / MES: equity index micros → US macro events
//   MGC:       gold → USD/rates events
//   MCL:       crude oil → EIA petroleum, OPEC

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Keywords that map to instrument relevance
const SYMBOL_KEYWORDS = {
  MNQ: ['fomc', 'federal', 'nfp', 'non-farm', 'cpi', 'ppi', 'gdp', 'ism', 'retail', 'jobless', 'claims', 'unemployment', 'fed', 'interest rate', 'payroll'],
  MES: ['fomc', 'federal', 'nfp', 'non-farm', 'cpi', 'ppi', 'gdp', 'ism', 'retail', 'jobless', 'claims', 'unemployment', 'fed', 'interest rate', 'payroll'],
  MGC: ['fomc', 'federal', 'cpi', 'ppi', 'nfp', 'non-farm', 'interest rate', 'fed', 'dollar', 'dxy', 'treasury'],
  MCL: ['eia', 'petroleum', 'crude', 'opec', 'inventory', 'oil', 'natural gas'],
};

let _cache      = null;
let _cacheTime  = 0;

/**
 * Get upcoming high-impact economic events, filtered to instrument-relevant ones.
 * Returns events from the current week, sorted by time.
 *
 * @param {string} [symbol]  If provided, filter to events relevant to this symbol
 * @returns {Promise<Array>}  [{time, title, impact, symbols, country}]
 */
async function getCalendarEvents(symbol) {
  await _maybeRefresh();

  let events = _cache || [];

  if (symbol) {
    events = events.filter(e => e.symbols.includes(symbol));
  }

  return events;
}

/**
 * Get the next high-impact event for a symbol within the next N hours.
 * Returns null if no upcoming event found.
 */
async function getNextEvent(symbol, withinHours = 3) {
  const events = await getCalendarEvents(symbol);
  const now    = Date.now() / 1000;
  const limit  = now + withinHours * 3600;

  return events.find(e =>
    e.impact === 'high' &&
    e.time >= now       &&
    e.time <= limit
  ) ?? null;
}

/**
 * Check if a setup time is within N minutes of a high-impact event for a symbol.
 * Used by setups.js for calendar gating.
 */
function isNearEvent(setupTime, symbol, events, windowMinutes = 15) {
  const windowSec = windowMinutes * 60;
  return events.some(e =>
    e.impact === 'high' &&
    e.symbols.includes(symbol) &&
    Math.abs(e.time - setupTime) <= windowSec
  );
}

// ---------------------------------------------------------------------------

async function _maybeRefresh() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) return;

  try {
    const res  = await fetch(CALENDAR_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();
    _cache    = _normalize(raw);
    _cacheTime = now;
    console.log(`[calendar] Fetched ${_cache.length} events`);
  } catch (err) {
    console.warn(`[calendar] Fetch failed: ${err.message} — using cached/empty`);
    if (!_cache) _cache = _fallbackEvents();
  }
}

function _normalize(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(e => e.impact === 'High')
    .map(e => {
      const time    = _parseEventTime(e.date);
      const title   = (e.title || '').toLowerCase();
      const symbols = _mapSymbols(title, e.country);

      return {
        time,
        title:   e.title || 'Unknown Event',
        impact:  'high',
        symbols,
        country: e.country || 'USD',
      };
    })
    .filter(e => e.time > 0 && e.symbols.length > 0)
    .sort((a, b) => a.time - b.time);
}

function _mapSymbols(titleLower, country) {
  if (country && country !== 'USD') return []; // Only USD events affect our instruments

  const matched = new Set();
  for (const [sym, keywords] of Object.entries(SYMBOL_KEYWORDS)) {
    if (keywords.some(kw => titleLower.includes(kw))) {
      matched.add(sym);
    }
  }
  return [...matched];
}

function _parseEventTime(dateStr) {
  if (!dateStr) return 0;
  try {
    // ForexFactory dates are in format: "2026-03-05T08:30:00-05:00" (ET)
    return Math.floor(new Date(dateStr).getTime() / 1000);
  } catch {
    return 0;
  }
}

// Hardcoded fallback for when the feed is unavailable
// Updated manually for the current week if needed
function _fallbackEvents() {
  return [];
}

module.exports = { getCalendarEvents, getNextEvent, isNearEvent };
