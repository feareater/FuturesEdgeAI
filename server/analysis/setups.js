'use strict';
// Setup detection: supply/demand zone rejection (primary), BOS/CHoCH (zone qualifier),
// and PDH/PDL breakout continuation.
// Liquidity sweeps removed: backtest showed 43% WR, PF 0.68 — no profitable filter found.
// BOS/CHoCH are detected but not returned as standalone trades. Instead they qualify zone
// rejections that fire in the same direction within a 24h window (+15 confidence bonus).
// Each setup includes entry, SL, TP (configurable R:R), retrospective outcome,
// and a scoreBreakdown object explaining every confidence point contribution.
// IOF confluence (FVG + Order Block proximity) boosts confidence scores.
// Pure function: candles + indicators + regime in → setup array out. No I/O.

const { iofConfluenceScore } = require('./iof');

const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'XRP', 'XLM']);

const SCAN_WINDOW           = 100; // how many recent candles to examine
const TRENDLINE_SCAN_WINDOW = 10;  // only look at last N candles for fresh trendline breaks

// BOS qualifier window: a BOS/CHoCH that fired in the same direction at least
// BOS_QUAL_MIN seconds ago (not concurrent) but within BOS_QUAL_MAX seconds
// boosts a subsequent zone rejection by BOS_QUAL_BONUS confidence points.
const BOS_QUAL_MIN   = 1800;        // 30 minutes — prevents same-candle double-count
const BOS_QUAL_MAX   = 24 * 3600;   // 24 hours — directional context stays relevant
const BOS_QUAL_BONUS = 15;          // confidence pts added to the qualifying zone

// PDH/PDL Breakout uses symbol-specific R:R (data-optimised):
//   MNQ → 2:1 (breakouts run further; ★ $6,593 PF 5.36 on 30d backtest)
//   MGC → 1:1 (tighter ATR range; ★ $2,856 PF 4.02 on 30d backtest)
//   MES → 2:1 (equity index micro, same breakout behavior as MNQ — pending backtest)
//   MCL → 1.5:1 (crude oil, wider ATR than gold — pending backtest)
const PDH_RR = { MNQ: 2.0, MGC: 1.0, MES: 2.0, MCL: 1.5, BTC: 2.0, ETH: 2.0, XRP: 2.0, XLM: 2.0, SIL: 1.5 };

/**
 * Detect trade setups in the candle history.
 *
 * @param {Array}  candles     Full candle array [{time,open,high,low,close,volume}]
 * @param {Object} indicators  Output from computeIndicators()
 * @param {Object} regime      classifyRegime() output + alignment boolean
 * @param {Object} opts
 * @param {number} opts.rrRatio  Take-profit R:R multiplier (default 1.0)
 * @param {string} opts.symbol   Instrument symbol (used by PDH breakout for R:R)
 * @returns {Array}            Setups found, sorted by confidence desc, max 10
 */
function detectSetups(candles, indicators, regime, opts = {}) {
  if (!candles || candles.length < 20) return [];

  const { swingHighs, swingLows, atrCurrent, pdh, pdl, fvgs = [], orderBlocks = [],
          openingRange } = indicators;
  if (!atrCurrent || !swingHighs.length || !swingLows.length) return [];

  const rrRatio       = opts.rrRatio        || 1.0;
  const symbol        = opts.symbol         || '';
  const trendlines    = opts.trendlines     || null;
  const calendarEvents = opts.calendarEvents || [];

  // Examine only the most recent SCAN_WINDOW candles, but use all known swings
  const scanStart   = Math.max(0, candles.length - SCAN_WINDOW);
  const scanCandles = candles.slice(scanStart);

  // Build enrichment context passed to scoring functions
  const vwapValue  = indicators.vwap?.length ? indicators.vwap[indicators.vwap.length - 1].value : null;
  const pocValue   = indicators.volumeProfile?.poc ?? null;
  const isCrypto   = CRYPTO_SYMBOLS.has(symbol);
  const volume20MA = _volumeMA(scanCandles, 20);
  const corrContext = opts.correlationMatrix ? _buildCorrContext(symbol, opts.correlationMatrix) : null;
  const extras     = { vwapValue, pocValue, isCrypto, symbol, volume20MA, corrContext };

  const pdhSetups  = _pdhBreakout(scanCandles, candles, pdh, pdl, atrCurrent, regime, fvgs, orderBlocks, symbol, extras);

  // Detect BOS/CHoCH internally — used as zone qualifiers, NOT returned as standalone trades.
  const bosSetups  = _bosChoch(scanCandles, candles, swingHighs, swingLows, atrCurrent, regime, fvgs, orderBlocks, rrRatio);

  // Zone rejections — primary signal.
  const rawZones   = _zoneRejection(scanCandles, candles, swingHighs, swingLows, atrCurrent, regime, fvgs, orderBlocks, rrRatio, extras);
  const zoneSetups = _applyBosQualifier(rawZones, bosSetups)
    .filter(z => _regimeGate(z, regime));

  // Trendline breaks.
  const tlSetups = trendlines
    ? _trendlineBreak(scanCandles, candles, trendlines, atrCurrent, regime, fvgs, orderBlocks, rrRatio, extras)
    : [];

  // Opening Range breakouts — only for non-crypto (no OR concept for 24/7 markets).
  const orSetups = (!isCrypto && openingRange?.formed)
    ? _orBreakout(scanCandles, candles, openingRange, atrCurrent, regime, fvgs, orderBlocks, rrRatio, extras)
    : [];

  // Merge: PDH always included, remaining slots by confidence.
  zoneSetups.sort((a, b) => b.confidence - a.confidence);
  tlSetups.sort((a, b) => b.confidence - a.confidence);
  orSetups.sort((a, b) => b.confidence - a.confidence);

  const remaining  = Math.max(0, 10 - pdhSetups.length);
  const top        = [...pdhSetups, ...zoneSetups.slice(0, remaining)];
  const tlSlots    = Math.min(2, Math.max(0, 10 - top.length));
  top.push(...tlSetups.slice(0, tlSlots));
  const orSlots    = Math.min(2, Math.max(0, 10 - top.length));
  top.push(...orSetups.slice(0, orSlots));

  // Calendar gating: flag setups near high-impact events (confidence -20, nearEvent: true)
  if (calendarEvents.length > 0) {
    for (const setup of top) {
      if (_isNearCalendarEvent(setup, symbol, calendarEvents)) {
        setup.confidence  = Math.max(0, setup.confidence - 20);
        setup.nearEvent   = true;
      }
    }
  }

  const bosQual = zoneSetups.filter(z => (z.scoreBreakdown?.bos || 0) > 0).length;
  console.log(
    `[setups]  found=${pdhSetups.length + zoneSetups.length + tlSetups.length + orSetups.length}  returned=${top.length}  rr=${rrRatio}:1  ` +
    `(zone=${zoneSetups.length}[bq=${bosQual}] bos_detected=${bosSetups.length} pdh=${pdhSetups.length} tl=${tlSetups.length} or=${orSetups.length})`
  );

  return top;
}

// ---------------------------------------------------------------------------
// Calendar event check
// ---------------------------------------------------------------------------

function _isNearCalendarEvent(setup, symbol, events, windowSec = 15 * 60) {
  return events.some(e =>
    e.symbols?.includes(symbol) &&
    Math.abs(e.time - setup.time) <= windowSec
  );
}

// ---------------------------------------------------------------------------
// Setup 1: Liquidity Sweep + Reversal
// ---------------------------------------------------------------------------

function _sweepReversal(scanCandles, allCandles, allSwingHighs, allSwingLows, atrCurrent, regime, fvgs, orderBlocks, rrRatio) {
  const found = [];
  const seen  = new Set();

  for (const c of scanCandles) {
    const totalRange = c.high - c.low;
    if (totalRange === 0) continue;

    const priorHighs = allSwingHighs.filter(s => s.time < c.time);
    const priorLows  = allSwingLows.filter(s => s.time < c.time);

    // ── Bullish sweep ─────────────────────────────────────────────────────────
    if (c.close > c.open) {
      const sweptLows = priorLows.filter(s => s.value > c.low && s.value < c.close);
      if (sweptLows.length) {
        const target   = sweptLows.reduce((best, s) => s.time > best.time ? s : best);
        const sweepKey = `bull_sweep_${target.value.toFixed(2)}`;

        if (!seen.has(sweepKey)) {
          seen.add(sweepKey);
          const entry      = c.close;
          const sl         = target.value - atrCurrent * 0.15;
          const { tp }     = _tp(entry, sl, 'bullish', rrRatio);
          const sweepDepth = target.value - c.low;
          const bodySize   = c.close - c.open;
          const iofBonus   = iofConfluenceScore(entry, 'bullish', fvgs, orderBlocks, atrCurrent);
          const { score: conf, breakdown: scoreBreakdown } = _sweepConf({ sweepDepth, bodySize, totalRange, atrCurrent, regime, direction: 'bullish', iofBonus });
          const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bullish', sl, tp });

          found.push({
            type: 'liquidity_sweep_reversal', direction: 'bullish',
            time: c.time, price: c.close,
            entry, sl, tp, riskPoints: Math.abs(entry - sl), outcome, outcomeTime,
            sweptLevel: target.value,
            confidence: conf, iofBonus, scoreBreakdown,
            rationale: _sweepRationale('bullish', target.value, iofBonus),
          });
        }
      }
    }

    // ── Bearish sweep ─────────────────────────────────────────────────────────
    if (c.close < c.open) {
      const sweptHighs = priorHighs.filter(s => s.value < c.high && s.value > c.close);
      if (sweptHighs.length) {
        const target   = sweptHighs.reduce((best, s) => s.time > best.time ? s : best);
        const sweepKey = `bear_sweep_${target.value.toFixed(2)}`;

        if (!seen.has(sweepKey)) {
          seen.add(sweepKey);
          const entry      = c.close;
          const sl         = target.value + atrCurrent * 0.15;
          const { tp }     = _tp(entry, sl, 'bearish', rrRatio);
          const sweepDepth = c.high - target.value;
          const bodySize   = c.open - c.close;
          const iofBonus   = iofConfluenceScore(entry, 'bearish', fvgs, orderBlocks, atrCurrent);
          const { score: conf, breakdown: scoreBreakdown } = _sweepConf({ sweepDepth, bodySize, totalRange, atrCurrent, regime, direction: 'bearish', iofBonus });
          const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bearish', sl, tp });

          found.push({
            type: 'liquidity_sweep_reversal', direction: 'bearish',
            time: c.time, price: c.close,
            entry, sl, tp, riskPoints: Math.abs(entry - sl), outcome, outcomeTime,
            sweptLevel: target.value,
            confidence: conf, iofBonus, scoreBreakdown,
            rationale: _sweepRationale('bearish', target.value, iofBonus),
          });
        }
      }
    }
  }

  return found;
}

function _sweepRationale(dir, level, iofBonus) {
  const base = dir === 'bullish'
    ? `Bullish sweep of swing low ${level.toFixed(2)} — close recovered above`
    : `Bearish sweep of swing high ${level.toFixed(2)} — close recovered below`;
  return iofBonus >= 10 ? base + ' · IOF confluence' : base;
}

// ---------------------------------------------------------------------------
// BOS qualifier — boosts zone rejections preceded by a structural break
// ---------------------------------------------------------------------------

/**
 * For each zone rejection, look for a prior BOS/CHoCH in the same direction.
 * If one exists (fired ≥30 min and ≤24 h before the zone), add BOS_QUAL_BONUS
 * confidence points and mark the scoreBreakdown.bos field.
 *
 * This captures the high-probability pattern:
 *   BOS/CHoCH fires (establishes direction) → price retraces to a zone →
 *   zone rejects (ideal entry, bias already confirmed by structure).
 */
function _applyBosQualifier(zones, bosSetups) {
  return zones.map(z => {
    // Find the most recent prior BOS/CHoCH in the same direction
    const prior = bosSetups
      .filter(b =>
        b.direction === z.direction &&
        b.time < z.time &&
        (z.time - b.time) >= BOS_QUAL_MIN &&
        (z.time - b.time) <= BOS_QUAL_MAX
      )
      .sort((a, b) => b.time - a.time)[0]; // most recent first

    if (!prior) return z;

    const isCHoCH = prior.type === 'choch';
    return {
      ...z,
      confidence:     Math.min(100, z.confidence + BOS_QUAL_BONUS),
      isBosQualified: true,
      bosQualType:    isCHoCH ? 'choch' : 'bos',   // used by regime gate
      scoreBreakdown: { ...z.scoreBreakdown, bos: BOS_QUAL_BONUS },
      rationale:      z.rationale + (isCHoCH ? ' · CHoCH qualified' : ' · BOS qualified'),
    };
  });
}

// ---------------------------------------------------------------------------
// Setup 2: Supply / Demand Zone Rejection
// ---------------------------------------------------------------------------

function _zoneRejection(scanCandles, allCandles, allSwingHighs, allSwingLows, atrCurrent, regime, fvgs, orderBlocks, rrRatio, extras = {}) {
  const found  = [];
  const seen   = new Set();
  const BUFFER = atrCurrent * 0.2;

  for (const c of scanCandles) {
    const totalRange = c.high - c.low;
    if (totalRange < atrCurrent * 0.3) continue;

    const priorHighs = allSwingHighs.filter(s => s.time < c.time).slice(-5);
    const priorLows  = allSwingLows.filter(s => s.time < c.time).slice(-5);

    // ── Bearish zone rejection ────────────────────────────────────────────────
    for (const sh of priorHighs) {
      const zoneBase  = sh.value - BUFFER;
      if (c.high < zoneBase) continue;
      if (c.close >= zoneBase) continue;
      const upperWick = c.high - Math.max(c.open, c.close);
      const wickRatio = upperWick / totalRange;
      if (wickRatio < 0.45) continue;

      const zoneKey = `supply_${sh.value.toFixed(2)}`;
      if (!seen.has(zoneKey)) {
        seen.add(zoneKey);
        const entry    = c.close;
        const sl       = sh.value + atrCurrent * 0.30;
        const { tp }   = _tp(entry, sl, 'bearish', rrRatio);
        const iofBonus = iofConfluenceScore(entry, 'bearish', fvgs, orderBlocks, atrCurrent);
        const { score: conf, breakdown: scoreBreakdown } = _zoneConf({
          wickRatio, atrCurrent, totalRange, regime, direction: 'bearish', iofBonus,
          candleTime: c.time, entryPrice: c.close, currentVolume: c.volume || 0, ...extras,
        });
        const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bearish', sl, tp });

        found.push({
          type: 'zone_rejection', direction: 'bearish',
          time: c.time, price: c.close,
          entry, sl, tp, riskPoints: Math.abs(entry - sl), outcome, outcomeTime,
          zoneLevel: sh.value,
          confidence: conf, iofBonus, scoreBreakdown,
          rationale: `Bearish rejection at supply ${sh.value.toFixed(2)} — ${(wickRatio * 100).toFixed(0)}% upper wick` +
            (iofBonus >= 10 ? ' · IOF confluence' : ''),
          entryGuidance: 'Limit at zone mid or market on next candle if still at zone',
        });
      }
    }

    // ── Bullish zone rejection ────────────────────────────────────────────────
    for (const sl_node of priorLows) {
      const zoneTop  = sl_node.value + BUFFER;
      if (c.low > zoneTop) continue;
      if (c.close <= zoneTop) continue;
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const wickRatio = lowerWick / totalRange;
      if (wickRatio < 0.45) continue;

      const zoneKey = `demand_${sl_node.value.toFixed(2)}`;
      if (!seen.has(zoneKey)) {
        seen.add(zoneKey);
        const entry    = c.close;
        const sl       = sl_node.value - atrCurrent * 0.30;
        const { tp }   = _tp(entry, sl, 'bullish', rrRatio);
        const iofBonus = iofConfluenceScore(entry, 'bullish', fvgs, orderBlocks, atrCurrent);
        const { score: conf, breakdown: scoreBreakdown } = _zoneConf({
          wickRatio, atrCurrent, totalRange, regime, direction: 'bullish', iofBonus,
          candleTime: c.time, entryPrice: c.close, currentVolume: c.volume || 0, ...extras,
        });
        const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bullish', sl, tp });

        found.push({
          type: 'zone_rejection', direction: 'bullish',
          time: c.time, price: c.close,
          entry, sl, tp, riskPoints: Math.abs(entry - sl), outcome, outcomeTime,
          zoneLevel: sl_node.value,
          confidence: conf, iofBonus, scoreBreakdown,
          rationale: `Bullish rejection at demand ${sl_node.value.toFixed(2)} — ${(wickRatio * 100).toFixed(0)}% lower wick` +
            (iofBonus >= 10 ? ' · IOF confluence' : ''),
          entryGuidance: 'Limit at zone mid or market on next candle if still at zone',
        });
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Setup 3: Break of Structure / Change of Character
// ---------------------------------------------------------------------------

function _bosChoch(scanCandles, allCandles, allSwingHighs, allSwingLows, atrCurrent, regime, fvgs, orderBlocks, rrRatio) {
  const found = [];
  const seen  = new Set();

  for (const c of scanCandles) {
    const priorHighs = allSwingHighs.filter(s => s.time < c.time);
    const priorLows  = allSwingLows.filter(s => s.time < c.time);
    if (!priorHighs.length || !priorLows.length) continue;

    const lastHigh = priorHighs[priorHighs.length - 1];
    const lastLow  = priorLows[priorLows.length - 1];

    // ── Bullish break ─────────────────────────────────────────────────────────
    if (c.close > lastHigh.value) {
      const key = `bull_${lastHigh.value.toFixed(2)}`;
      if (!seen.has(key)) {
        seen.add(key);
        const isCHoCH   = regime && regime.direction === 'bearish';
        const entry     = c.close;
        const sl        = lastHigh.value - atrCurrent * 0.10;
        const { tp }    = _tp(entry, sl, 'bullish', rrRatio);
        const breakSize = (entry - lastHigh.value) / atrCurrent;
        const iofBonus  = iofConfluenceScore(entry, 'bullish', fvgs, orderBlocks, atrCurrent);
        const { score: conf, breakdown: scoreBreakdown } = _structureConf({ breakSize, isCHoCH, regime, direction: 'bullish', iofBonus });
        const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bullish', sl, tp });

        found.push({
          type: isCHoCH ? 'choch' : 'bos', direction: 'bullish',
          time: c.time, price: c.close,
          entry, sl, tp, riskPoints: Math.abs(entry - sl), outcome, outcomeTime,
          brokenLevel: lastHigh.value,
          confidence: conf, iofBonus, scoreBreakdown,
          rationale: `Bullish ${isCHoCH ? 'CHoCH' : 'BOS'}: close above swing high ${lastHigh.value.toFixed(2)}` +
            (iofBonus >= 10 ? ' · IOF confluence' : ''),
          entryGuidance: 'Structure signal — no standalone entry',
        });
      }
    }

    // ── Bearish break ─────────────────────────────────────────────────────────
    if (c.close < lastLow.value) {
      const key = `bear_${lastLow.value.toFixed(2)}`;
      if (!seen.has(key)) {
        seen.add(key);
        const isCHoCH   = regime && regime.direction === 'bullish';
        const entry     = c.close;
        const sl        = lastLow.value + atrCurrent * 0.10;
        const { tp }    = _tp(entry, sl, 'bearish', rrRatio);
        const breakSize = (lastLow.value - entry) / atrCurrent;
        const iofBonus  = iofConfluenceScore(entry, 'bearish', fvgs, orderBlocks, atrCurrent);
        const { score: conf, breakdown: scoreBreakdown } = _structureConf({ breakSize, isCHoCH, regime, direction: 'bearish', iofBonus });
        const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bearish', sl, tp });

        found.push({
          type: isCHoCH ? 'choch' : 'bos', direction: 'bearish',
          time: c.time, price: c.close,
          entry, sl, tp, riskPoints: Math.abs(entry - sl), outcome, outcomeTime,
          brokenLevel: lastLow.value,
          confidence: conf, iofBonus, scoreBreakdown,
          rationale: `Bearish ${isCHoCH ? 'CHoCH' : 'BOS'}: close below swing low ${lastLow.value.toFixed(2)}` +
            (iofBonus >= 10 ? ' · IOF confluence' : ''),
          entryGuidance: 'Structure signal — no standalone entry',
        });
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// TP / SL helpers
// ---------------------------------------------------------------------------

/**
 * Compute take-profit at rrRatio:1 R:R from entry to SL.
 */
function _tp(entry, sl, direction, rrRatio) {
  const risk = Math.abs(entry - sl);
  const tp   = direction === 'bullish' ? entry + risk * rrRatio : entry - risk * rrRatio;
  return { tp };
}

/**
 * Retrospectively evaluate whether subsequent candles hit TP or SL first.
 * Capped at MAX_FORWARD_CANDLES: seed data always has a few trailing candles
 * past every setup, so scanning all candles would immediately resolve everything.
 * Setups not resolved within the window stay 'open' for Predictions to show.
 * The priceProgress field (computed in /api/alerts) handles cases where price
 * drifted past SL or near TP without a fast clean hit.
 */
const MAX_FORWARD_CANDLES = 4;

function _evaluateOutcome(candles, triggerTime, { direction, sl, tp }) {
  const idx = candles.findIndex(c => c.time === triggerTime);
  if (idx < 0 || idx >= candles.length - 1) {
    return { outcome: 'open', outcomeTime: null };
  }

  const limit = Math.min(candles.length, idx + 1 + MAX_FORWARD_CANDLES);
  for (let i = idx + 1; i < limit; i++) {
    const c = candles[i];
    if (direction === 'bullish') {
      const hitSL = c.low  <= sl;
      const hitTP = c.high >= tp;
      if (hitSL && hitTP) return { outcome: 'lost', outcomeTime: c.time };
      if (hitSL)          return { outcome: 'lost', outcomeTime: c.time };
      if (hitTP)          return { outcome: 'won',  outcomeTime: c.time };
    } else {
      const hitSL = c.high >= sl;
      const hitTP = c.low  <= tp;
      if (hitSL && hitTP) return { outcome: 'lost', outcomeTime: c.time };
      if (hitSL)          return { outcome: 'lost', outcomeTime: c.time };
      if (hitTP)          return { outcome: 'won',  outcomeTime: c.time };
    }
  }

  return { outcome: 'open', outcomeTime: null };
}

// ---------------------------------------------------------------------------
// Confidence scoring helpers
// Each returns { score: number, breakdown: object } for UI transparency.
// ---------------------------------------------------------------------------

function _sweepConf({ sweepDepth, bodySize, totalRange, atrCurrent, regime, direction, iofBonus }) {
  let score = 35;
  const bd = { base: 35, depth: 0, body: 0, regime: 0, align: 0, iof: iofBonus || 0 };

  if (atrCurrent > 0) {
    const d = Math.min(20, Math.round((sweepDepth / atrCurrent) * 30));
    score += d; bd.depth = d;
  }
  const bodyRatio = totalRange > 0 ? bodySize / totalRange : 0;
  if      (bodyRatio > 0.4)  { score += 15; bd.body = 15; }
  else if (bodyRatio > 0.25) { score += 8;  bd.body = 8; }
  if (regime?.direction === direction) { score += 15; bd.regime = 15; }
  if (regime?.alignment)               { score += 10; bd.align  = 10; }
  score += bd.iof;
  return { score: Math.round(Math.max(0, Math.min(100, score))), breakdown: bd };
}

function _zoneConf({ wickRatio, atrCurrent, totalRange, regime, direction, iofBonus,
                     candleTime, entryPrice, currentVolume, volume20MA,
                     vwapValue, pocValue, isCrypto, corrContext, symbol }) {
  let score = 30;
  const bd = { base: 30, wick: 0, size: 0, regime: 0, align: 0, iof: iofBonus || 0, bos: 0 };

  const wick = Math.round(wickRatio * 30);
  score += wick; bd.wick = wick;

  if (atrCurrent > 0 && totalRange >= atrCurrent * 0.5) { score += 10; bd.size = 10; }

  // Regime alignment — scaled by regime strength (weak regime = smaller bonus)
  if (regime?.direction === direction) {
    const regBonus = Math.round(((regime.strength ?? 100) / 100) * 15);
    score += regBonus; bd.regime = regBonus;
  }
  if (regime?.alignment) { score += 10; bd.align = 10; }

  score += bd.iof;

  // VWAP proximity: rejection near VWAP = institutional fair-value anchor → stronger hold
  if (vwapValue && entryPrice && atrCurrent > 0) {
    if (Math.abs(entryPrice - vwapValue) / atrCurrent <= 0.3) { score += 8; bd.vwap = 8; }
  }

  // Volume expansion: high-volume rejection = institutional participation
  if (volume20MA > 0 && currentVolume > volume20MA * 1.5) { score += 12; bd.vol = 12; }

  // Session POC confluence: rejection at volume-weighted fair value = structural support/resistance
  if (pocValue && entryPrice && atrCurrent > 0) {
    if (Math.abs(entryPrice - pocValue) / atrCurrent <= 0.3) { score += 6; bd.poc = 6; }
  }

  // Session transition suppression: elevated noise near RTH open (13:00–13:45 UTC) and close (20:45–21:30 UTC)
  if (!isCrypto && candleTime) {
    const h = _utcHour(candleTime);
    if ((h >= 13.0 && h <= 13.75) || (h >= 20.75 && h <= 21.5)) { score -= 10; bd.session = -10; }
  }

  // Correlation-driven adjustments
  if (corrContext) {
    const corrDelta = _corrAdjust(symbol, direction, corrContext);
    if (corrDelta !== 0) { score += corrDelta; bd.corr = corrDelta; }
  }

  return { score: Math.round(Math.max(0, Math.min(100, score))), breakdown: bd };
}

function _structureConf({ breakSize, isCHoCH, regime, direction, iofBonus }) {
  let score = 40;
  const bd = { base: 40, break: 0, choch: 0, regime: 0, align: 0, iof: iofBonus || 0 };

  const brk = Math.min(20, Math.round(breakSize * 20));
  score += brk; bd.break = brk;

  if (isCHoCH) { score += 10; bd.choch = 10; }
  if (regime?.direction === direction) { score += 15; bd.regime = 15; }
  if (regime?.alignment)               { score += 10; bd.align  = 10; }
  score += bd.iof;
  return { score: Math.round(Math.max(0, Math.min(100, score))), breakdown: bd };
}

// ---------------------------------------------------------------------------
// Setup 4: PDH / PDL Breakout Continuation
// ---------------------------------------------------------------------------
// When a candle closes above the Prior Day High (or below Prior Day Low) for
// the first time on a given UTC day, it signals institutional acceptance of
// a new price range. Enter on the next candle's open; SL just below the
// broken level (0.3 × ATR buffer); TP at symbol-optimised R:R.
// RTH filter: only fire between 13:00–21:30 UTC (covers 9:30–17:00 ET for
// both EST and EDT), so we don't act on pre-market or after-hours prints.
// ---------------------------------------------------------------------------

function _pdhBreakout(scanCandles, allCandles, pdh, pdl, atrCurrent, regime, fvgs, orderBlocks, symbol, extras = {}) {
  if (!pdh || !pdl) return [];

  const found = [];
  const seen  = new Set();
  const rrPDH = PDH_RR[symbol] ?? 1.0;

  for (let idx = 1; idx < scanCandles.length; idx++) {
    const c    = scanCandles[idx];
    const prev = scanCandles[idx - 1];

    // RTH filter (UTC): 13:00–21:30 covers both EST and EDT sessions.
    // Crypto trades 24/7 — skip the RTH gate entirely for BTC/ETH/XRP.
    const utcHour = Math.floor((c.time % 86400) / 3600);
    if (!CRYPTO_SYMBOLS.has(symbol) && (utcHour < 13 || utcHour >= 22)) continue;

    // ── Bullish breakout: closes above PDH, prior close was at or below PDH ──
    if (c.close > pdh && prev.close <= pdh) {
      const key = `bull_pdh_${pdh.toFixed(2)}`;
      if (!seen.has(key)) {
        seen.add(key);
        const entry       = c.close;
        const sl          = pdh - atrCurrent * 0.30;
        const riskPts     = Math.abs(entry - sl);
        const { tp }      = _tp(entry, sl, 'bullish', rrPDH);
        const closeOver   = (entry - pdh) / atrCurrent; // how far above PDH
        const iofBonus    = iofConfluenceScore(entry, 'bullish', fvgs, orderBlocks, atrCurrent);
        const { score: conf, breakdown: scoreBreakdown } = _pdhConf({
          closeOver, atrCurrent, regime, direction: 'bullish', iofBonus,
          candleTime: c.time, entryPrice: c.close, currentVolume: c.volume || 0, ...extras,
        });
        const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bullish', sl, tp });

        found.push({
          type: 'pdh_breakout', direction: 'bullish',
          time: c.time, price: c.close,
          entry, sl, tp, riskPoints: riskPts, outcome, outcomeTime,
          pdLevel: pdh,
          confidence: conf, iofBonus, scoreBreakdown,
          rationale: `Bullish PDH breakout above ${pdh.toFixed(2)} — close accepted above prior high` +
            (iofBonus >= 10 ? ' · IOF confluence' : ''),
          entryGuidance: 'Market after confirmed close above PDH; no chase > 0.5 ATR',
        });
      }
    }

    // ── Bearish breakdown: closes below PDL, prior close was at or above PDL ─
    if (c.close < pdl && prev.close >= pdl) {
      const key = `bear_pdl_${pdl.toFixed(2)}`;
      if (!seen.has(key)) {
        seen.add(key);
        const entry       = c.close;
        const sl          = pdl + atrCurrent * 0.30;
        const riskPts     = Math.abs(entry - sl);
        const { tp }      = _tp(entry, sl, 'bearish', rrPDH);
        const closeUnder  = (pdl - entry) / atrCurrent;
        const iofBonus    = iofConfluenceScore(entry, 'bearish', fvgs, orderBlocks, atrCurrent);
        const { score: conf, breakdown: scoreBreakdown } = _pdhConf({
          closeOver: closeUnder, atrCurrent, regime, direction: 'bearish', iofBonus,
          candleTime: c.time, entryPrice: c.close, currentVolume: c.volume || 0, ...extras,
        });
        const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bearish', sl, tp });

        found.push({
          type: 'pdh_breakout', direction: 'bearish',
          time: c.time, price: c.close,
          entry, sl, tp, riskPoints: riskPts, outcome, outcomeTime,
          pdLevel: pdl,
          confidence: conf, iofBonus, scoreBreakdown,
          rationale: `Bearish PDL breakdown below ${pdl.toFixed(2)} — close accepted below prior low` +
            (iofBonus >= 10 ? ' · IOF confluence' : ''),
          entryGuidance: 'Market after confirmed close below PDL; no chase > 0.5 ATR',
        });
      }
    }
  }

  return found;
}

function _pdhConf({ closeOver, atrCurrent, regime, direction, iofBonus,
                    candleTime, entryPrice, currentVolume, volume20MA,
                    vwapValue, isCrypto, corrContext, symbol }) {
  let score = 45;
  const bd = { base: 45, break: 0, regime: 0, align: 0, iof: iofBonus || 0 };

  // Reward a decisive close above the level (not just a tick)
  if      (closeOver > 0.5)  { score += 15; bd.break = 15; }
  else if (closeOver > 0.2)  { score += 8;  bd.break = 8; }

  // Regime alignment — scaled by regime strength
  if (regime?.direction === direction) {
    const regBonus = Math.round(((regime.strength ?? 100) / 100) * 15);
    score += regBonus; bd.regime = regBonus;
  }
  if (regime?.alignment) { score += 10; bd.align = 10; }

  score += bd.iof;

  // VWAP proximity: breakout through PDH/PDL while near VWAP = strong momentum
  if (vwapValue && entryPrice && atrCurrent > 0) {
    if (Math.abs(entryPrice - vwapValue) / atrCurrent <= 0.3) { score += 8; bd.vwap = 8; }
  }

  // Volume expansion on breakout candle confirms institutional participation
  if (volume20MA > 0 && currentVolume > volume20MA * 1.5) { score += 10; bd.vol = 10; }

  // Session transition suppression
  if (!isCrypto && candleTime) {
    const h = _utcHour(candleTime);
    if ((h >= 13.0 && h <= 13.75) || (h >= 20.75 && h <= 21.5)) { score -= 10; bd.session = -10; }
  }

  // Correlation adjustments
  if (corrContext) {
    const corrDelta = _corrAdjust(symbol, direction, corrContext);
    if (corrDelta !== 0) { score += corrDelta; bd.corr = corrDelta; }
  }

  return { score: Math.round(Math.max(0, Math.min(100, score))), breakdown: bd };
}

// ---------------------------------------------------------------------------
// Regime gate — prevents counter-trend zone rejections
// ---------------------------------------------------------------------------

/**
 * Returns true if this setup should be shown given the current regime.
 *
 * Policy:
 *   • Direction matches regime → always allow.
 *   • Counter-trend WITH a CHoCH qualifier → allow (CHoCH confirms actual trend shift).
 *   • Counter-trend with no qualifier, or only BOS-qualified → suppress.
 *
 * If regime is neutral or missing, all setups pass (no false negatives).
 */
function _regimeGate(setup, regime) {
  if (!regime || !regime.direction || regime.direction === 'neutral') return true;
  if (setup.direction === regime.direction) return true;
  // Counter-trend: only pass if a CHoCH (actual trend change) confirmed the shift
  return setup.isBosQualified && setup.bosQualType === 'choch';
}

// ---------------------------------------------------------------------------
// Setup 5: Trendline Break
// ---------------------------------------------------------------------------
// A trendline break fires when price closes on the opposite side of an
// established trendline for the first time (confirmed close, not just a wick).
// Only trendlines with ≥3 touches are considered — weak 1-2 touch lines are noise.
// Checks only the last TRENDLINE_SCAN_WINDOW candles to avoid stale signals.
// Works well with delayed data because momentum from a clean trendline break
// persists well beyond the 15-min data lag.

function _trendlineBreak(scanCandles, allCandles, trendlines, atrCurrent, regime, fvgs, orderBlocks, rrRatio, extras = {}) {
  const { support, resistance } = trendlines;
  const found = [];
  const seen  = new Set();

  // Restrict to most-recent candles for freshness (stale breaks are not actionable)
  const recentStart   = Math.max(0, scanCandles.length - TRENDLINE_SCAN_WINDOW);
  const recentCandles = scanCandles.slice(recentStart);

  for (let idx = 1; idx < recentCandles.length; idx++) {
    const c    = recentCandles[idx];
    const prev = recentCandles[idx - 1];

    // ── Bullish: close breaks ABOVE resistance trendline ──────────────────────
    if (resistance && resistance.touches >= 3) {
      const dt = resistance.endTime - resistance.startTime;
      if (dt > 0) {
        const slope    = (resistance.endPrice - resistance.startPrice) / dt;
        const lineNow  = resistance.startPrice + slope * (c.time    - resistance.startTime);
        const linePrev = resistance.startPrice + slope * (prev.time - resistance.startTime);

        // Fresh cross: this bar closed above, prior bar closed at or below
        if (c.close > lineNow && prev.close <= linePrev) {
          const breakKey = `bull_tl_resist_${resistance.startTime}`;
          if (!seen.has(breakKey)) {
            seen.add(breakKey);
            const entry     = c.close;
            const sl        = lineNow - atrCurrent * 0.30;
            const { tp }    = _tp(entry, sl, 'bullish', rrRatio);
            const breakSize = (c.close - lineNow) / atrCurrent;
            const iofBonus  = iofConfluenceScore(entry, 'bullish', fvgs, orderBlocks, atrCurrent);
            const { score: conf, breakdown: scoreBreakdown } = _trendlineConf({
              breakSize, touches: resistance.touches, regime, direction: 'bullish', iofBonus,
              candleTime: c.time, ...extras,
            });
            const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bullish', sl, tp });

            found.push({
              type: 'trendline_break', direction: 'bullish',
              time: c.time, price: c.close,
              entry, sl, tp, riskPoints: Math.abs(entry - sl), outcome, outcomeTime,
              trendlineLevel:   +lineNow.toFixed(4),
              trendlineTouches: resistance.touches,
              confidence: conf, iofBonus, scoreBreakdown,
              rationale: `Bullish trendline break above resistance — ${resistance.touches} touches` +
                (iofBonus >= 10 ? ' · IOF confluence' : ''),
              entryGuidance: 'Market on next open or limit on trendline retest',
            });
          }
        }
      }
    }

    // ── Bearish: close breaks BELOW support trendline ─────────────────────────
    if (support && support.touches >= 3) {
      const dt = support.endTime - support.startTime;
      if (dt > 0) {
        const slope    = (support.endPrice - support.startPrice) / dt;
        const lineNow  = support.startPrice + slope * (c.time    - support.startTime);
        const linePrev = support.startPrice + slope * (prev.time - support.startTime);

        // Fresh cross: this bar closed below, prior bar closed at or above
        if (c.close < lineNow && prev.close >= linePrev) {
          const breakKey = `bear_tl_support_${support.startTime}`;
          if (!seen.has(breakKey)) {
            seen.add(breakKey);
            const entry     = c.close;
            const sl        = lineNow + atrCurrent * 0.30;
            const { tp }    = _tp(entry, sl, 'bearish', rrRatio);
            const breakSize = (lineNow - c.close) / atrCurrent;
            const iofBonus  = iofConfluenceScore(entry, 'bearish', fvgs, orderBlocks, atrCurrent);
            const { score: conf, breakdown: scoreBreakdown } = _trendlineConf({
              breakSize, touches: support.touches, regime, direction: 'bearish', iofBonus,
              candleTime: c.time, ...extras,
            });
            const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bearish', sl, tp });

            found.push({
              type: 'trendline_break', direction: 'bearish',
              time: c.time, price: c.close,
              entry, sl, tp, riskPoints: Math.abs(entry - sl), outcome, outcomeTime,
              trendlineLevel:   +lineNow.toFixed(4),
              trendlineTouches: support.touches,
              confidence: conf, iofBonus, scoreBreakdown,
              rationale: `Bearish trendline break below support — ${support.touches} touches` +
                (iofBonus >= 10 ? ' · IOF confluence' : ''),
              entryGuidance: 'Market on next open or limit on trendline retest',
            });
          }
        }
      }
    }
  }

  return found;
}

function _trendlineConf({ breakSize, touches, regime, direction, iofBonus,
                          candleTime, isCrypto, corrContext, symbol }) {
  let score = 45;
  const bd  = { base: 45, break: 0, touches: 0, regime: 0, align: 0, iof: iofBonus || 0 };

  const brk = Math.min(10, Math.round(breakSize * 15));
  score += brk; bd.break = brk;

  if      (touches >= 5) { score += 10; bd.touches = 10; }
  else if (touches >= 3) { score += 5;  bd.touches = 5;  }

  // Regime strength scaling
  if (regime?.direction === direction) {
    const regBonus = Math.round(((regime.strength ?? 100) / 100) * 15);
    score += regBonus; bd.regime = regBonus;
  }
  if (regime?.alignment) { score += 10; bd.align = 10; }

  score += bd.iof;

  // Session transition suppression
  if (!isCrypto && candleTime) {
    const h = _utcHour(candleTime);
    if ((h >= 13.0 && h <= 13.75) || (h >= 20.75 && h <= 21.5)) { score -= 10; bd.session = -10; }
  }

  // Correlation adjustments
  if (corrContext) {
    const corrDelta = _corrAdjust(symbol, direction, corrContext);
    if (corrDelta !== 0) { score += corrDelta; bd.corr = corrDelta; }
  }

  return { score: Math.round(Math.max(0, Math.min(100, score))), breakdown: bd };
}

// ---------------------------------------------------------------------------
// Setup: Opening Range Breakout
// ---------------------------------------------------------------------------
// Fires when price closes beyond the OR high (bullish) or OR low (bearish)
// after the OR window closes (10:00 ET). RTH-gated (before 15:30 ET).
// SL = opposite OR bound, TP = SL distance × 2 (OR breakouts run further).

const OR_POST_START_UTC = 14.0;  // 10:00 ET — OR window closed
const OR_RTH_END_UTC    = 20.5;  // 16:30 ET — stop scanning late session

function _orBreakout(scanCandles, allCandles, openingRange, atrCurrent, regime, fvgs, orderBlocks, rrRatio, extras = {}) {
  if (!openingRange || !openingRange.formed) return [];
  const { high: orHigh, low: orLow } = openingRange;
  if (!orHigh || !orLow || orHigh <= orLow) return [];

  const found = [];
  const seen  = new Set();

  for (const c of scanCandles) {
    const h = _utcHour(c.time);
    if (h < OR_POST_START_UTC || h >= OR_RTH_END_UTC) continue;

    // Bullish breakout: first close above OR high
    if (c.close > orHigh && !seen.has(`bull_or_${c.time}`)) {
      seen.add(`bull_or_${c.time}`);
      const entry    = orHigh;
      const sl       = orLow;
      const risk     = Math.abs(entry - sl);
      const tp       = entry + risk * 2; // OR breaks tend to run 2:1
      const iofBonus = iofConfluenceScore(entry, 'bullish', fvgs, orderBlocks, atrCurrent);
      const breakMag = (c.close - orHigh) / atrCurrent;
      const { score: conf, breakdown: scoreBreakdown } = _orConf({ breakMag, regime, direction: 'bullish', iofBonus, candleTime: c.time, ...extras });
      const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bullish', sl, tp });

      found.push({
        type: 'or_breakout', direction: 'bullish',
        time: c.time, price: c.close,
        entry, sl, tp, riskPoints: risk, outcome, outcomeTime,
        orHigh, orLow,
        confidence: conf, iofBonus, scoreBreakdown,
        rationale: `Bullish OR breakout above ${orHigh.toFixed(2)} — close ${c.close.toFixed(2)}` +
                   (iofBonus >= 10 ? ' · IOF confluence' : ''),
        entryGuidance: 'Market on confirmed close outside OR range; RTH only',
      });
    }

    // Bearish breakout: first close below OR low
    if (c.close < orLow && !seen.has(`bear_or_${c.time}`)) {
      seen.add(`bear_or_${c.time}`);
      const entry    = orLow;
      const sl       = orHigh;
      const risk     = Math.abs(entry - sl);
      const tp       = entry - risk * 2;
      const iofBonus = iofConfluenceScore(entry, 'bearish', fvgs, orderBlocks, atrCurrent);
      const breakMag = (orLow - c.close) / atrCurrent;
      const { score: conf, breakdown: scoreBreakdown } = _orConf({ breakMag, regime, direction: 'bearish', iofBonus, candleTime: c.time, ...extras });
      const { outcome, outcomeTime } = _evaluateOutcome(allCandles, c.time, { direction: 'bearish', sl, tp });

      found.push({
        type: 'or_breakout', direction: 'bearish',
        time: c.time, price: c.close,
        entry, sl, tp, riskPoints: risk, outcome, outcomeTime,
        orHigh, orLow,
        confidence: conf, iofBonus, scoreBreakdown,
        rationale: `Bearish OR breakdown below ${orLow.toFixed(2)} — close ${c.close.toFixed(2)}` +
                   (iofBonus >= 10 ? ' · IOF confluence' : ''),
        entryGuidance: 'Market on confirmed close outside OR range; RTH only',
      });
    }
  }

  return found;
}

function _orConf({ breakMag, regime, direction, iofBonus,
                   candleTime, isCrypto, corrContext, symbol }) {
  let score = 35;
  const bd  = { base: 35, break: 0, regime: 0, align: 0, iof: iofBonus || 0 };

  const brk = Math.min(20, Math.round(breakMag * 20));
  score += brk; bd.break = brk;

  // Regime strength scaling
  if (regime?.direction === direction) {
    const regBonus = Math.round(((regime.strength ?? 100) / 100) * 15);
    score += regBonus; bd.regime = regBonus;
  }
  if (regime?.alignment) { score += 10; bd.align = 10; }

  score += bd.iof;

  // Session transition suppression
  if (!isCrypto && candleTime) {
    const h = _utcHour(candleTime);
    if ((h >= 13.0 && h <= 13.75) || (h >= 20.75 && h <= 21.5)) { score -= 10; bd.session = -10; }
  }

  // Correlation adjustments
  if (corrContext) {
    const corrDelta = _corrAdjust(symbol, direction, corrContext);
    if (corrDelta !== 0) { score += corrDelta; bd.corr = corrDelta; }
  }

  return { score: Math.round(Math.max(0, Math.min(100, score))), breakdown: bd };
}

function _utcHour(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

// ---------------------------------------------------------------------------
// Correlation-driven scoring helpers
// ---------------------------------------------------------------------------

/**
 * Build a correlation context object from the matrix for a given symbol.
 * Extracts the relationships most relevant to scoring: MNQ/MES divergence,
 * BTC/ETH crypto alignment, DXY and VIX vs the symbol.
 */
function _buildCorrContext(symbol, corrMatrix) {
  if (!corrMatrix?.matrix) return null;
  const mat = corrMatrix.matrix;
  const row = mat[symbol] || {};
  return {
    mnqMesCor: mat['MNQ']?.['MES'] ?? null,   // equity index coherence
    btcEthCor: mat['BTC']?.['ETH'] ?? null,   // crypto market coherence
    dxySymCor: row['DXY'] ?? null,             // dollar vs this symbol
    vixSymCor: row['VIX'] ?? null,             // fear index vs this symbol
  };
}

/**
 * Compute a confidence delta (+/-) based on intermarket correlation signals.
 *
 * Rules:
 *   Equity indices (MNQ, MES, SIL):
 *     – MNQ/MES correlation < 0.60 = stress/divergence → −15 pts
 *     – VIX positively correlated with symbol > 0.20 = unusual fear → −10 pts
 *     – DXY strongly aligned with equity > 0.30 = risk confusion → −8 pts
 *   Crypto (BTC, ETH, XRP, XLM):
 *     – BTC/ETH correlation < 0.70 = crypto market fracturing → −10 pts
 *     – DXY strongly negatively correlated (< −0.70) = dollar headwind:
 *         bull setups −8 pts; bear setups +5 pts
 *   Commodities (MGC, MCL):
 *     – DXY unusually positive (> 0.30) = dollar/commodity alignment confusion → −8 pts
 */
function _corrAdjust(symbol, direction, corr) {
  if (!corr) return 0;
  let delta = 0;

  if (symbol === 'MNQ' || symbol === 'MES' || symbol === 'SIL') {
    if (corr.mnqMesCor !== null && corr.mnqMesCor < 0.60) delta -= 15;
    if (corr.vixSymCor !== null && corr.vixSymCor > 0.20)  delta -= 10;
    if (corr.dxySymCor !== null && corr.dxySymCor > 0.30)  delta -= 8;
  }

  if (CRYPTO_SYMBOLS.has(symbol)) {
    if (corr.btcEthCor !== null && corr.btcEthCor < 0.70) delta -= 10;
    if (corr.dxySymCor !== null && corr.dxySymCor < -0.70) {
      delta += direction === 'bearish' ? 5 : -8;
    }
  }

  if (symbol === 'MGC' || symbol === 'MCL') {
    if (corr.dxySymCor !== null && corr.dxySymCor > 0.30) delta -= 8;
  }

  return delta;
}

/**
 * Compute 20-period volume moving average from recent candles.
 * Returns null when insufficient data or all volumes are zero (Yahoo Finance quirk).
 */
function _volumeMA(candles, period = 20) {
  const vols = candles.map(c => c.volume || 0).filter(v => v > 0);
  if (vols.length < period) return null;
  const recent = vols.slice(-period);
  const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
  return avg > 0 ? avg : null;
}

// ---------------------------------------------------------------------------

module.exports = { detectSetups };
