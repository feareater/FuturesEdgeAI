'use strict';
// Claude API commentary generator — phase 4.
// Accepts the top N alert objects + a candle-fetcher function, sends a single
// batch request to claude-sonnet-4-6, and returns structured commentary for
// each setup.  One-call-for-all avoids per-setup latency and lets Claude
// compare setups against each other.
//
// Rate limit: controlled by settings.aiRateLimitMs (default 60 000 ms).
// The limiter is global — if the last generation ran within the window,
// generateCommentary returns null so the caller can serve cached data.

const Anthropic = require('@anthropic-ai/sdk');

let client = null; // lazy-init so missing key doesn't crash at require-time

function _getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set in environment');
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// ── Rate-limit state ─────────────────────────────────────────────────────────
let lastGenTs = 0;

// ── Per-key cache for single-setup requests ──────────────────────────────────
const singleCache  = new Map();
const SINGLE_TTL   = 30_000; // 30 s — don't re-call Claude for the same setup

// ── Session helper ────────────────────────────────────────────────────────────
function _session() {
  const h = new Date().getUTCHours();
  if (h >= 14 && h < 21) return 'RTH (9:30 – 16:00 ET)';
  if (h >= 21 || h < 1)  return 'After-hours';
  return 'Pre-market';
}

// ── Type label map ─────────────────────────────────────────────────────────────
const TYPE_LABEL = {
  zone_rejection: 'Supply/Demand Zone Rejection',
  pdh_breakout:   'Prior Day High/Low Breakout',
  bos:            'Break of Structure',
  choch:          'Change of Character',
};

// ── Prompt builder ────────────────────────────────────────────────────────────

function _buildPrompt(alerts, getCandles) {
  const blocks = alerts.map((alert, i) => {
    const { symbol, timeframe, regime, setup: s } = alert;
    const entry = s.entry != null ? s.entry : s.price;

    // Last 5 candles from current data (shows current price context)
    let candleStr = '—';
    try {
      const candles = getCandles(symbol, timeframe);
      candleStr = candles.slice(-5).map(c =>
        `O${c.open.toFixed(2)} H${c.high.toFixed(2)} L${c.low.toFixed(2)} C${c.close.toFixed(2)}`
      ).join(' | ');
    } catch (_) {}

    const time = new Date(s.time * 1000).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Denver',
    });

    const typeLabel = TYPE_LABEL[s.type] || s.type;
    const aligned   = regime?.alignment ? ', TF-aligned' : '';
    const bqNote    = (s.scoreBreakdown?.bos || 0) > 0 ? ' · BOS-qualified' : '';
    const keyLevel  = (s.zoneLevel ?? s.sweptLevel ?? s.brokenLevel ?? s.pdLevel ?? entry).toFixed(2);

    return [
      `SETUP ${i + 1}: ${symbol} ${timeframe} — ${s.direction.toUpperCase()} ${typeLabel}`,
      `Time: ${time} MT | Entry: ${entry.toFixed(2)} | SL: ${(s.sl || 0).toFixed(2)} | TP: ${(s.tp || 0).toFixed(2)} | Risk: ${(s.riskPoints || 0).toFixed(2)} pts`,
      `Regime: ${regime?.type || '—'} ${regime?.direction || '—'} (strength ${regime?.strength || 0}/100${aligned})`,
      `Confidence: ${s.confidence}%${bqNote} | Key level: ${keyLevel}`,
      `Recent candles: ${candleStr}`,
      `Rationale: ${s.rationale}`,
    ].join('\n');
  }).join('\n\n---\n\n');

  return [
    `UTC: ${new Date().toISOString()} | Session: ${_session()}`,
    '',
    `Analyze these ${alerts.length} active futures trade setup${alerts.length > 1 ? 's' : ''} for Jeff, a professional retail trader.`,
    '',
    blocks,
    '',
    '---',
    'Respond with a JSON array — one object per setup in the same order.',
    'Each object must have exactly: "symbol" (string), "timeframe" (string),',
    '"setupTime" (number — Unix timestamp), "commentary" (string — 3 to 4 sentences).',
    '',
    'Commentary structure per setup:',
    '  1. What happened on the chart (the price action that triggered this setup).',
    '  2. Quality assessment — what makes it high or low conviction.',
    '  3. Key confirmation signal and the exact price level that invalidates the trade.',
    '',
    'Be direct and specific. No generic disclaimers. Return only valid JSON.',
  ].join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate AI commentary for up to N alerts in a single Claude API call.
 *
 * @param {Array}    alerts     Alert objects (already filtered + sorted by caller)
 * @param {Function} getCandles (symbol, tf) → candle array
 * @param {Object}   settings   Config (uses settings.aiRateLimitMs)
 * @returns {Array|null}        Array of { symbol, timeframe, setupTime, commentary, alert }
 *                              or null if rate-limited or API unavailable.
 */
async function generateCommentary(alerts, getCandles, settings) {
  if (!alerts || alerts.length === 0) return [];

  const rateMs = settings?.aiRateLimitMs ?? 60_000;
  const elapsed = Date.now() - lastGenTs;
  if (elapsed < rateMs) {
    const wait = Math.ceil((rateMs - elapsed) / 1000);
    console.log(`[ai] Rate-limited — ${wait}s until next generation`);
    return null; // caller should serve cached data
  }

  lastGenTs = Date.now();

  const system = [
    'You are an expert futures trading analyst providing concise, actionable commentary.',
    'Focus on price action quality, market structure, and specific risk levels.',
    'Never add generic disclaimers. Be technical and direct.',
  ].join(' ');

  const userPrompt = _buildPrompt(alerts, getCandles);

  console.log(`[ai] Generating commentary for ${alerts.length} setup(s)…`);

  try {
    const msg = await _getClient().messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1200,
      system,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const raw = msg.content[0]?.text?.trim() || '[]';

    // Claude sometimes wraps JSON in markdown fences — strip them
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed  = JSON.parse(cleaned);

    // Re-attach full alert objects for the frontend
    const result = parsed.map(item => {
      const alert = alerts.find(a =>
        a.symbol === item.symbol &&
        a.timeframe === item.timeframe &&
        a.setup.time === item.setupTime
      ) || alerts.find(a =>
        a.symbol === item.symbol && a.timeframe === item.timeframe
      );
      return { symbol: item.symbol, timeframe: item.timeframe,
               setupTime: item.setupTime, commentary: item.commentary, alert };
    });

    console.log(`[ai] Commentary ready — ${result.length} item(s)`);
    return result;

  } catch (err) {
    console.error('[ai] Commentary failed:', err.message);
    return null;
  }
}

// ── On-demand single-setup commentary ────────────────────────────────────────

/**
 * Generate AI commentary for a single alert, with a per-key TTL cache so
 * the same setup isn't re-sent to Claude within 30 seconds.
 *
 * @param {Object}   alert      Full alert object from alertCache
 * @param {Function} getCandles (symbol, tf) → candle array
 * @returns {string|null}       Commentary text, or null on failure
 */
async function generateSingle(alert, getCandles) {
  const { symbol, timeframe, setup: s } = alert;
  const key = `${symbol}:${timeframe}:${s.type}:${s.time}`;

  // Commentary already on the alert object (from batch run or persisted prior request)
  if (alert.commentary) {
    console.log(`[ai] Single commentary from alert object: ${key}`);
    return alert.commentary;
  }

  const cached = singleCache.get(key);
  if (cached && Date.now() - cached.ts < SINGLE_TTL) {
    console.log(`[ai] Single cache hit: ${key}`);
    return cached.commentary;
  }

  const system = [
    'You are an expert futures trading analyst providing concise, actionable commentary.',
    'Focus on price action quality, market structure, and specific risk levels.',
    'Never add generic disclaimers. Be technical and direct.',
  ].join(' ');

  // Reuse the batch prompt builder with a single-item array;
  // response is a JSON array — extract item[0].commentary.
  const userPrompt = _buildPrompt([alert], getCandles);
  console.log(`[ai] Generating single commentary: ${key}`);

  try {
    const msg = await _getClient().messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      system,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const raw     = msg.content[0]?.text?.trim() || '[]';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed  = JSON.parse(cleaned);
    const commentary = Array.isArray(parsed) ? (parsed[0]?.commentary || null) : null;

    if (commentary) {
      alert.commentary = commentary; // attach for persistence — saved to disk by caller
      singleCache.set(key, { commentary, ts: Date.now() });
    }
    return commentary;

  } catch (err) {
    console.error('[ai] Single commentary failed:', err.message);
    return null;
  }
}

module.exports = { generateCommentary, generateSingle };
