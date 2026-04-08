'use strict';
/**
 * ZR-A: Run zone_rejection-only backtest on MNQ (15m+30m, 24-month window)
 * and extract winners for analysis.
 *
 * Usage: node scripts/zr_extract.js
 * Output: data/analysis/ZR_A_winners.json, ZR_A_all.json, ZR_A_prompt.txt
 */

const path = require('path');
const fs   = require('fs');
const { runBacktestMTF, computeStats } = require('../server/backtest/engine');

const OUT_DIR = path.resolve(__dirname, '../data/analysis');
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  console.log('[ZR-A] Running zone_rejection-only backtest: MNQ, 15m+30m, 2024-01-01 to 2026-04-01');
  const config = {
    symbols:       ['MNQ'],
    timeframes:    ['15m', '30m'],
    startDate:     '2024-01-01',
    endDate:       '2026-04-01',
    minConfidence: 50,          // low floor — we want ALL zone_rejection trades for analysis
    setupTypes:    ['zone_rejection'],
    contracts:     { MNQ: 1 },
    useHP:         true,
    feePerRT:      4,
    spanMargin:    { MNQ: 1320 },
    excludeHours:  [],
  };

  const results = await runBacktestMTF(config, (p) => {
    if (p.pct % 20 === 0) console.log(`  [progress] ${p.phase} ${p.pct}% — ${p.message || ''}`);
  });

  const trades = results.trades || [];
  console.log(`[ZR-A] Total zone_rejection trades: ${trades.length}`);

  // Save all trades
  fs.writeFileSync(path.join(OUT_DIR, 'ZR_A_all.json'), JSON.stringify({ config, trades, stats: results.stats }, null, 2));

  // Winners
  const winners = trades.filter(t => t.outcome === 'won');
  const losers  = trades.filter(t => t.outcome === 'lost');
  const timeouts = trades.filter(t => t.outcome === 'timeout');
  console.log(`[ZR-A] Winners: ${winners.length}, Losers: ${losers.length}, Timeouts: ${timeouts.length}`);

  fs.writeFileSync(path.join(OUT_DIR, 'ZR_A_winners.json'), JSON.stringify(winners, null, 2));

  // Quick stats
  const avgWinPnl  = winners.length ? (winners.reduce((s, t) => s + (t.netPnl || 0), 0) / winners.length).toFixed(2) : 0;
  const avgLossPnl = losers.length  ? (losers.reduce((s, t) => s + (t.netPnl || 0), 0) / losers.length).toFixed(2) : 0;
  const wr = trades.length ? ((winners.length / trades.length) * 100).toFixed(1) : 0;
  const netPnl = trades.reduce((s, t) => s + (t.netPnl || 0), 0).toFixed(2);
  console.log(`[ZR-A] WR: ${wr}%, AvgWin: $${avgWinPnl}, AvgLoss: $${avgLossPnl}, Net: $${netPnl}`);

  // Build the prompt file for Claude analysis
  const tradeFields = trades.map(t => ({
    outcome:       t.outcome,
    direction:     t.direction,
    timeframe:     t.timeframe,
    confidence:    t.confidence,
    hour:          t.hour,
    entry:         t.entry,
    sl:            t.sl,
    tp:            t.tp,
    riskPoints:    t.riskPoints,
    netPnl:        t.netPnl,
    grossPnl:      t.grossPnl,
    holdBars:      t.holdBars,
    vixRegime:     t.vixRegime,
    vixLevel:      t.vixLevel,
    dxyDirection:  t.dxyDirection,
    hpProximity:   t.hpProximity,
    resilienceLabel: t.resilienceLabel,
    dexBias:       t.dexBias,
    ddBandLabel:   t.ddBandLabel,
    ddBandScore:   t.ddBandScore,
    equityBreadth: t.equityBreadth,
    bondRegime:    t.bondRegime,
    copperRegime:  t.copperRegime,
    riskAppetite:  t.riskAppetite,
    scoreBreakdown: t.scoreBreakdown,
    zoneLevel:     t.zoneLevel,
  }));

  const prompt = `You are analyzing zone_rejection trades from a systematic futures trading backtest.

CONTEXT:
- Instrument: MNQ (Micro Nasdaq-100 Futures)
- Timeframes: 15m, 30m
- Date range: 2024-01-01 to 2026-04-01 (24 months)
- Setup type: zone_rejection only (price enters supply/demand zone, produces rejection wick, closes back outside)
- Current R:R: 1:1 (rrRatio = 1.0)
- SL placement: 0.30 × ATR beyond the swing high/low (zone far edge)
- zone_rejection is currently DISABLED in production because R:R is structurally inverted (AvgWin ~$16 vs AvgLoss ~$24 at all confidence levels)

SUMMARY STATS:
- Total trades: ${trades.length}
- Winners: ${winners.length} (${wr}% WR)
- Losers: ${losers.length}
- Timeouts: ${timeouts.length}
- Avg Win P&L: $${avgWinPnl}
- Avg Loss P&L: $${avgLossPnl}
- Net P&L: $${netPnl}

TRADE RECORDS:
${JSON.stringify(tradeFields, null, 2)}

ANALYSIS REQUESTED:

1. **Winner characteristics**: What do the winning zone_rejection trades have in common? Analyze by:
   - Symbol direction (bullish vs bearish)
   - Hour of day (ET)
   - VIX regime (low/normal/elevated/crisis)
   - DXY direction (rising/falling/flat)
   - Equity breadth (0-4)
   - Risk appetite (on/neutral/off)
   - HP proximity (at_level/near_level/other)
   - DD Band label (room_to_run/approaching_dd/neutral/etc.)
   - Confidence score distribution

2. **Confidence threshold analysis**: WR and PF by confidence bucket (50-59, 60-69, 70-79, 80-89, 90+). Is there a confidence threshold where zone_rejection becomes profitable?

3. **Time-of-day pattern**: Heatmap of WR by ET hour. Are there specific hours where zone_rejection wins disproportionately?

4. **R-multiple and hold time**: Average R-multiple and hold bars for winners vs losers. Do winners resolve quickly or slowly?

5. **Actionable filter rules**: Based on the above, propose specific conditional filters (with sample sizes n >= 10) that would improve zone_rejection WR to >= 45% and PF >= 1.2. Format each rule as:
   "[condition] → [WR]% WR (n=[count], PF=[value])"

6. **Structural diagnosis**: Is the core problem the SL placement (too wide), the TP placement (too ambitious), the zone definition (too shallow), or the entry timing? Which of these four would you change FIRST?

Return findings as specific, quantified rules. Only report patterns where n >= 10.
`;

  fs.writeFileSync(path.join(OUT_DIR, 'ZR_A_prompt.txt'), prompt);
  console.log(`[ZR-A] Output written to data/analysis/ZR_A_winners.json, ZR_A_all.json, ZR_A_prompt.txt`);
})();
