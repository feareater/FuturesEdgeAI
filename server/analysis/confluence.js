'use strict';
// Multi-timeframe confluence: checks whether a setup's key price level has a
// confirming IOF zone (open FVG or active Order Block) on a higher timeframe
// in the same direction.
//
// A zone rejection on the 5m that coincides with an open bullish FVG on the
// 15m means institutional demand is stacked — meaningfully higher probability.
//
// Usage: called by the scan engine in index.js after detectSetups() returns.

// For each base TF, which TFs count as "higher"
// 30m added as top of stack — 5m and 15m setups can now confirm against it.
const TF_HIGHER = {
  '1m':  ['5m', '15m', '30m'],
  '2m':  ['5m', '15m', '30m'],
  '3m':  ['5m', '15m', '30m'],
  '5m':  ['15m', '30m'],
  '15m': ['30m'],
  '30m': [],
};

// Backtest findings (Feb 2026, 45 resolved zone rejections):
//   MNQ + TF stack: 77.8% WR, PF 3.15  (+13% vs MNQ base) — clear positive edge
//   MGC + TF stack: 37.5% WR, PF 0.39  (-12% vs MGC base) — inverted signal
//
// MGC interpretation: when a short-TF MGC zone aligns with an HTF IOF zone,
// the level is actively contested on multiple timeframes — more likely to break
// than hold. TF stack is therefore only applied to MNQ.
//
// Double-stack (5m AND 15m both confirming): 50% WR, PF 0.65 — worse than
// single-TF confirm (60% WR, PF 1.80). Overloaded levels tend to already be
// tested. Cap at one confirming TF to avoid awarding a false high-conviction signal.
const STACK_BONUS_PER_TF = 15;  // confidence bonus for one confirming higher TF
const STACK_MAX          = 15;  // cap at 1 TF — double-stack is not additive
const PROX_ATR_MULT      = 0.5; // zone proximity = 0.5 × higher-TF ATR

// Symbols where HTF IOF alignment is an INVERTED predictor (contested levels break rather than hold).
// Backtest: MGC + HTF IOF = 37.5% WR, PF 0.39 vs 49.5% base — penalise by INVERTED_PENALTY.
const INVERTED_SYMBOLS = new Set(['MGC', 'MCL']);
const INVERTED_PENALTY = -15; // confidence pts when HTF IOF aligns on inverted symbols

/**
 * Check whether the setup's key price level has a confirming IOF zone
 * on one or more higher timeframes (same direction, active/open status).
 *
 * • MNQ / MES: positive predictor → +15 pts per confirming TF (capped at 1 TF).
 * • MGC / MCL: inverted predictor → −15 pts if ANY higher-TF IOF zone aligns
 *   (contested levels tend to break rather than hold).
 * • All other symbols: neutral (no bonus, no penalty).
 *
 * @param {Object}   setup             Setup object from detectSetups()
 * @param {string}   symbol
 * @param {string}   tf                Base timeframe of the setup
 * @param {Function} getCandles        (symbol, tf) → candle array
 * @param {Function} computeIndicators (candles, opts) → indicators
 * @param {Object}   settings          { swingLookback, impulseThreshold }
 * @returns {{ stackCount: number, bonus: number, tfs: string[], inverted: boolean }}
 */
function checkTFZoneStack(setup, symbol, tf, getCandles, computeIndicators, settings) {
  const isPositive = symbol === 'MNQ' || symbol === 'MES';
  const isInverted = INVERTED_SYMBOLS.has(symbol);

  if (!isPositive && !isInverted) return { stackCount: 0, bonus: 0, tfs: [], inverted: false };

  const higherTfs = TF_HIGHER[tf] || [];
  if (higherTfs.length === 0) return { stackCount: 0, bonus: 0, tfs: [], inverted: false };

  // Key level: zone price for zone rejections, entry otherwise
  const keyLevel = setup.zoneLevel ?? setup.entry ?? setup.price;
  const dir      = setup.direction;

  let stackCount = 0;
  const stackTfs = [];

  for (const htf of higherTfs) {
    try {
      const candles = getCandles(symbol, htf);
      const ind     = computeIndicators(candles, {
        swingLookback:    settings.swingLookback,
        impulseThreshold: settings.impulseThreshold,
      });
      const prox = (ind.atrCurrent || 1) * PROX_ATR_MULT;

      // Open FVG on higher TF in same direction that covers the key level
      const hasFVG = (ind.fvgs || []).some(f =>
        f.status === 'open' &&
        f.type   === dir    &&
        keyLevel >= f.bottom - prox &&
        keyLevel <= f.top    + prox
      );

      // Active (untested or tested) OB on higher TF in same direction
      const hasOB = (ind.orderBlocks || []).some(o =>
        o.status !== 'mitigated' &&
        o.type   === dir         &&
        keyLevel >= o.bottom - prox &&
        keyLevel <= o.top    + prox
      );

      if (hasFVG || hasOB) {
        stackCount++;
        stackTfs.push(htf);
      }
    } catch (_) {
      // getCandles() or computeIndicators() can fail for missing TF data — skip silently
    }
  }

  if (isInverted) {
    // Any HTF IOF alignment on MGC/MCL means contested level — apply penalty
    const bonus = stackCount > 0 ? INVERTED_PENALTY : 0;
    return { stackCount, bonus, tfs: stackTfs, inverted: true };
  }

  const bonus = Math.min(STACK_MAX, stackCount * STACK_BONUS_PER_TF);
  return { stackCount, bonus, tfs: stackTfs, inverted: false };
}

module.exports = { checkTFZoneStack };
