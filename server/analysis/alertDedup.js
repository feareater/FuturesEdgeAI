'use strict';

/**
 * server/analysis/alertDedup.js
 *
 * Alert deduplication and staleness decay for the live scan engine.
 *
 * isDuplicate()    — suppress repeat signals at the same zone within 15 min
 * applyStaleness() — tag open alerts as fresh / aging / stale; add decayedConfidence
 * pruneExpired()   — drop open alerts older than maxAgeMs from the in-memory cache
 *
 * IMPORTANT: decayedConfidence is a display field only.
 *            setup.confidence must NEVER be modified after alert creation —
 *            backtest comparison depends on it being immutable.
 */

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------

/**
 * Returns true if newAlert is a duplicate of any open alert in existingAlerts.
 *
 * Duplicate criteria (ALL must match):
 *   - Same symbol
 *   - Same setup.type
 *   - Same setup.direction
 *   - setup.time within 15 minutes (900 s) of newAlert.setup.time
 *   - |zoneLevel - newAlert.zoneLevel| <= 0.25 × atr  (or |entry - newAlert.entry| if no zoneLevel)
 *   - outcome === 'open' (resolved alerts never block new signals)
 *
 * @param {Object}   newAlert        - incoming alert object
 * @param {Object[]} existingAlerts  - current alertCache
 * @param {number}   atr             - ATR(14) at alert creation time; 0 = exact-level match only
 * @returns {boolean}
 */
function isDuplicate(newAlert, existingAlerts, atr) {
  const ns = newAlert.setup;
  if (!ns) return false;

  const proximity = (atr > 0) ? 0.25 * atr : 0;

  for (const existing of existingAlerts) {
    const es = existing.setup;
    if (!es) continue;

    // Must still be open — resolved alerts do not block new signals
    if (es.outcome !== 'open' && es.outcome != null) continue;

    // Symbol / type / direction must match
    if (existing.symbol     !== newAlert.symbol)    continue;
    if (es.type             !== ns.type)            continue;
    if (es.direction        !== ns.direction)        continue;

    // Time window: within 15 minutes
    const timeDiff = Math.abs((es.time || 0) - (ns.time || 0));
    if (timeDiff > 900) continue;

    // Zone-level proximity
    const existingLevel = es.zoneLevel ?? es.entry;
    const newLevel      = ns.zoneLevel ?? ns.entry;
    if (existingLevel == null || newLevel == null) continue;

    const priceDiff = Math.abs(existingLevel - newLevel);
    if (priceDiff > proximity && proximity > 0) continue;
    if (proximity === 0 && priceDiff !== 0) continue;

    // All criteria met — duplicate
    console.log(
      `[Dedup] Suppressing duplicate ${newAlert.symbol} ${ns.type} ${ns.direction}` +
      ` — within 15-min cooldown at same level` +
      ` (existing @ ${existingLevel}, new @ ${newLevel}, diff=${priceDiff.toFixed(2)}, ATR=${atr.toFixed(2)})`
    );
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// applyStaleness
// ---------------------------------------------------------------------------

/**
 * Tags each open alert with a staleness field and a decayedConfidence.
 *
 * Thresholds:
 *   >= 60 min → staleness: 'stale',  decayedConfidence = round(confidence × 0.70)
 *   >= 30 min → staleness: 'aging',  decayedConfidence = round(confidence × 0.85)
 *    < 30 min → staleness: 'fresh',  decayedConfidence = confidence
 *
 * Mutates alerts in place. Returns the same array for chaining.
 *
 * NEVER modifies setup.confidence — decayedConfidence is display-only.
 */
function applyStaleness(alerts) {
  const now = Date.now();

  for (const alert of alerts) {
    const s = alert.setup;
    if (!s) continue;
    if (s.outcome !== 'open' && s.outcome != null) continue;  // only tag open alerts

    const ageMs = now - ((s.time || 0) * 1000);

    if (ageMs >= 60 * 60 * 1000) {
      s.staleness        = 'stale';
      s.decayedConfidence = Math.round((s.confidence || 0) * 0.70);
    } else if (ageMs >= 30 * 60 * 1000) {
      s.staleness        = 'aging';
      s.decayedConfidence = Math.round((s.confidence || 0) * 0.85);
    } else {
      s.staleness        = 'fresh';
      s.decayedConfidence = s.confidence || 0;
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// pruneExpired
// ---------------------------------------------------------------------------

/**
 * Returns a new array with open alerts older than maxAgeMs removed.
 * Resolved alerts (won/lost/timeout) are always kept.
 * Silently prunes — prevents unbounded cache growth in long live sessions.
 *
 * @param {Object[]} alerts
 * @param {number}   maxAgeMs  default 4 hours
 * @returns {Object[]}
 */
function pruneExpired(alerts, maxAgeMs = 4 * 60 * 60 * 1000) {
  const now     = Date.now();
  const before  = alerts.length;

  const filtered = alerts.filter(a => {
    const s = a.setup;
    if (!s) return true;
    // Resolved alerts are kept for history
    if (s.outcome !== 'open' && s.outcome != null) return true;
    const ageMs = now - ((s.time || 0) * 1000);
    return ageMs < maxAgeMs;
  });

  const pruned = before - filtered.length;
  if (pruned > 0) {
    console.log(`[Dedup] Pruned ${pruned} expired open alert(s) from cache`);
  }

  return filtered;
}

// ---------------------------------------------------------------------------

module.exports = { isDuplicate, applyStaleness, pruneExpired };
