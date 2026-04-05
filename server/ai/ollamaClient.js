'use strict';
/**
 * ollamaClient.js — Local Ollama LLM integration for backtest analysis
 *
 * Provides:
 *   - checkOllamaHealth()            — status check + model list
 *   - buildBacktestSystemPrompt()    — full structured prompt from job results
 *   - streamOllamaResponse()         — NDJSON streaming from /api/chat
 *
 * Intentionally independent of commentary.js — different purpose, different model, offline.
 */

const OLLAMA_BASE_URL = () => process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

// ─── Health check ──────────────────────────────────────────────────────────────

/**
 * GET /api/tags — 5s timeout
 * Returns { available: bool, models: string[], error?: string }
 * Never throws.
 */
async function checkOllamaHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL()}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { available: false, models: [], error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const models = (data.models || []).map(m => m.name || m.model || String(m));
    return { available: true, models };
  } catch (err) {
    clearTimeout(timer);
    return { available: false, models: [], error: err.message || String(err) };
  }
}

// ─── System prompt builder ─────────────────────────────────────────────────────

/**
 * Accepts the full object from data/backtest/results/{jobId}.json
 * Returns a complete system prompt string.
 */
function buildBacktestSystemPrompt(jobResults) {
  const SECTION_1 = `You are a quantitative trading analyst reviewing backtest results for FuturesEdge AI, a systematic futures trading system.

INSTRUMENTS:
- MNQ: Micro E-mini Nasdaq-100 Futures (point value $2)
- MES: Micro E-mini S&P 500 Futures (point value $5)
- MGC: Micro Gold Futures (point value $10)
- MCL: Micro Crude Oil Futures (point value $100)

SETUP TYPES:
- or_breakout: Opening Range Breakout — price closes outside the 09:30-10:00 ET range for the first time. High R:R breakout strategy.
- pdh_breakout: Prior Day High/Low Breakout — close beyond prior session high (bullish) or low (bearish) with momentum confirmation.
- zone_rejection: Supply/Demand Zone Rejection — price enters a zone, wicks, closes back outside. Currently disabled — R:R inverted (AvgWin $16 vs AvgLoss $24 at all confidence levels).
- trendline_break: Price closes through a significance-ranked trendline with 3+ confirmed touches.`;

  const SECTION_2 = `CONTEXT FIELDS ON EACH TRADE RECORD:
- vixRegime: low/normal/elevated/crisis (realized vol proxy, MNQ 1m bars)
- vixLevel: numeric annualized volatility percentage
- dxyDirection: rising/falling/flat (US Dollar index 5-day trend)
- hpProximity: whether price was near a Hedge Pressure options level
- resilienceLabel: options market resilience classification
- dexBias: dealer delta exposure — bullish/bearish/neutral
- ddBandLabel: DD Band position relative to CME SPAN margin
- riskAppetite: on/neutral/off (composite: equity breadth + bonds + copper + dollar + bitcoin)
- riskAppetiteScore: numeric -20 to +20
- bondRegime: bullish/bearish/neutral (ZN primary, ZB confirmation)
- copperRegime: bullish/bearish/neutral (MHG futures)
- dollarRegime: falling/rising/flat (M6E inverse proxy)
- equityBreadth: 0-4 (count of MNQ/MES/M2K/MYM that are bullish)
- hour: ET hour of entry (0-23)
- confidence: 0-100 score from the detection engine
- outcome: won/lost/timeout
- netPnl: net P&L after fees in dollars
- grossPnl: gross P&L before fees`;

  const SECTION_3 = `RULES YOU MUST FOLLOW:
1. The BACKTEST SUMMARY STATISTICS section contains pre-computed breakdowns (bySetupType, bySymbol, byVixRegime, etc). ALWAYS use these pre-computed values when answering questions about win rates, profit factors, and trade counts. Do NOT manually calculate these from the raw trade records — the summary is accurate and complete. The raw trade records are provided for pattern discovery only (finding feature combinations not in the summary breakdowns). Use FEATURE COMBINATION ANALYSIS for all pattern questions. Use RAW TRADE SAMPLE only to verify specific edge cases. Use BACKTEST SUMMARY STATISTICS for overall metrics.
2. Only report patterns where n >= 30. Smaller samples are noise — do not mention them even as caveats.
3. Format every winning pattern rule exactly as:
   [condition] → [WR]% WR (n=[count], PF=[value])
4. Format every avoidance rule exactly as:
   AVOID [condition] — [WR]% WR (n=[count], PF=[value])
5. Only reference these indicators: EMA, VWAP, ATR, price structure, volume. Never mention MACD, RSI, Stochastic, Bollinger Bands, Ichimoku, or any indicator not in this list — they do not exist in this system.
6. Be specific. Use actual numbers from the data provided. No generic trading advice.
7. If you find a pattern with n < 30, silently skip it — do not mention it.`;

  // Section 4 — stats summary (selected fields)
  const stats = jobResults.stats || {};
  const statsSummary = {
    overall: stats.overall,
    bySetupType: stats.bySetupType,
    bySymbol: stats.bySymbol,
    byDirection: stats.byDirection,
    byTimeframe: stats.byTimeframe,
    byVixRegime: stats.byVixRegime,
    byDxyDirection: stats.byDxyDirection,
    byRiskAppetite: stats.byRiskAppetite,
    byBondRegime: stats.byBondRegime,
    byCopperRegime: stats.byCopperRegime,
    byEquityBreadth: stats.byEquityBreadth,
    byConfBucket: stats.byConfBucket,
    byHour: stats.byHour,
    maxDrawdown: stats.maxDrawdown,
    totalTrades: stats.totalTrades,
    winRate: stats.winRate,
    profitFactor: stats.profitFactor,
  };

  const SECTION_4 = `BACKTEST SUMMARY STATISTICS:\n${JSON.stringify(statsSummary, null, 2)}`;

  // Section 5 — pre-computed feature combination analysis + 200-trade sample
  const allTrades = jobResults.trades || [];
  const totalTrades = allTrades.length;

  const SECTION_5 = `FEATURE COMBINATION ANALYSIS (pre-computed from ${totalTrades} trades):

BY_HOUR_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => t.hour != null && t.setupType ? JSON.stringify({ hour: t.hour, setupType: t.setupType }) : null))}

BY_VIX_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => t.vixRegime && t.setupType ? JSON.stringify({ vixRegime: t.vixRegime, setupType: t.setupType }) : null))}

BY_RISK_APPETITE_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => t.riskAppetite && t.setupType ? JSON.stringify({ riskAppetite: t.riskAppetite, setupType: t.setupType }) : null))}

BY_BOND_REGIME_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => t.bondRegime && t.setupType ? JSON.stringify({ bondRegime: t.bondRegime, setupType: t.setupType }) : null))}

BY_EQUITY_BREADTH_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => t.equityBreadth != null && t.setupType ? JSON.stringify({ equityBreadth: t.equityBreadth, setupType: t.setupType }) : null))}

BY_DXY_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => t.dxyDirection && t.setupType ? JSON.stringify({ dxyDirection: t.dxyDirection, setupType: t.setupType }) : null))}

BY_DIRECTION_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => t.direction && t.setupType ? JSON.stringify({ direction: t.direction, setupType: t.setupType }) : null))}

BY_CONFIDENCE_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => {
    if (!t.setupType || t.confidence == null) return null;
    const c = t.confidence;
    const bucket = c >= 90 ? '90+' : c >= 85 ? '85-90' : c >= 80 ? '80-85' : c >= 75 ? '75-80' : c >= 70 ? '70-75' : '65-70';
    return JSON.stringify({ confBucket: bucket, setupType: t.setupType });
  }))}

BY_HP_PROXIMITY_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => t.hpProximity && t.setupType ? JSON.stringify({ hpProximity: t.hpProximity, setupType: t.setupType }) : null))}

BY_DD_BAND_AND_SETUP: ${JSON.stringify(_groupBy(allTrades, t => t.ddBandLabel && t.setupType ? JSON.stringify({ ddBandLabel: t.ddBandLabel, setupType: t.setupType }) : null))}

RAW TRADE SAMPLE (200 of ${totalTrades} trades — for pattern verification only):
${JSON.stringify(_sampleTrades(allTrades, 200))}`;

  return [
    '=== SECTION 1: ROLE & INSTRUMENTS ===',
    SECTION_1,
    '',
    '=== SECTION 2: CONTEXT FIELD DEFINITIONS ===',
    SECTION_2,
    '',
    '=== SECTION 3: ANALYSIS RULES ===',
    SECTION_3,
    '',
    '=== SECTION 4: SUMMARY STATISTICS ===',
    SECTION_4,
    '',
    '=== SECTION 5: FEATURE COMBINATION ANALYSIS & TRADE SAMPLE ===',
    SECTION_5,
  ].join('\n');
}

/**
 * Group trades by a composite key, compute WR/PF/avgPnl per group.
 * keyFn returns a JSON string key or null to skip the trade.
 * keyFields lists which fields to spread into the output object.
 * Only groups with count >= 10 are returned.
 */
function _groupBy(trades, keyFn) {
  const groups = {};
  for (const t of trades) {
    const key = keyFn(t);
    if (key === null || key === undefined) continue;
    if (!groups[key]) groups[key] = { count: 0, wins: 0, grossProfit: 0, grossLoss: 0, netSum: 0 };
    const g = groups[key];
    g.count++;
    if (t.outcome === 'won') g.wins++;
    const gp = t.grossPnl || 0;
    if (gp > 0) g.grossProfit += gp; else g.grossLoss += Math.abs(gp);
    g.netSum += (t.netPnl || 0);
  }
  return Object.entries(groups)
    .filter(([, g]) => g.count >= 10)
    .map(([key, g]) => {
      const pf = g.grossLoss > 0 ? +(g.grossProfit / g.grossLoss).toFixed(3)
               : g.grossProfit > 0 ? 999 : 0;
      return {
        ...JSON.parse(key),
        count: g.count,
        wr: +(g.wins / g.count * 100).toFixed(1),
        pf,
        avgPnl: +(g.netSum / g.count).toFixed(2),
      };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * Return a random sample of n trades, spread evenly across the full dataset.
 * Uses systematic sampling (every Nth trade) rather than Math.random()
 * to ensure even coverage without duplicates.
 */
function _sampleTrades(trades, n) {
  if (trades.length <= n) return trades;
  const step = trades.length / n;
  const sample = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(Math.floor(i * step + Math.random() * step), trades.length - 1);
    const t = trades[idx];
    // Keep only the fields useful for pattern verification
    sample.push({
      symbol: t.symbol, setupType: t.setupType, direction: t.direction,
      confidence: t.confidence, outcome: t.outcome, hour: t.hour,
      vixRegime: t.vixRegime, dxyDirection: t.dxyDirection,
      hpProximity: t.hpProximity, ddBandLabel: t.ddBandLabel,
      equityBreadth: t.equityBreadth, bondRegime: t.bondRegime,
      riskAppetite: t.riskAppetite, netPnl: t.netPnl,
    });
  }
  return sample;
}

// ─── Streaming response ────────────────────────────────────────────────────────

/**
 * POST /api/chat — streams NDJSON response token by token
 *
 * @param {string}   model        — e.g. 'qwen2.5:32b'
 * @param {string}   systemPrompt — from buildBacktestSystemPrompt()
 * @param {Array}    history      — [{role:'user'|'assistant', content:string}]
 * @param {string}   userMessage  — new question
 * @param {Function} onChunk      — called with each token string
 * @param {Function} onDone       — called when generation completes
 * @param {Function} onError      — called with error string on failure
 */
async function streamOllamaResponse(model, systemPrompt, history, userMessage, onChunk, onDone, onError, signal) {
  const tradeCount = (() => {
    try {
      const m = systemPrompt.match(/FULL TRADE RECORDS \((\d+) trades\)/);
      return m ? m[1] : '?';
    } catch { return '?'; }
  })();

  console.log(`[ollama] model=${model} trades=${tradeCount} ts=${new Date().toISOString()} msg="${userMessage.substring(0, 80)}"`);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  try {
    const res = await fetch(`${OLLAMA_BASE_URL()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, messages }),
      signal: signal || undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      onError(`Ollama returned HTTP ${res.status}: ${text.substring(0, 200)}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.message?.content) {
            onChunk(parsed.message.content);
          }
          if (parsed.done === true) {
            onDone();
            return;
          }
        } catch {
          // skip malformed NDJSON lines
        }
      }
    }

    // Stream ended without a done:true line
    onDone();

  } catch (err) {
    if (err.name === 'AbortError') {
      onDone(); // treat cancel as clean completion — partial response stays in UI
    } else {
      onError(`Connection failed: ${err.message}`);
    }
  }
}

module.exports = { checkOllamaHealth, buildBacktestSystemPrompt, streamOllamaResponse };
