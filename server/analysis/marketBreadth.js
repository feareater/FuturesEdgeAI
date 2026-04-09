'use strict';
/**
 * marketBreadth.js — Cross-market regime scoring from 16 CME instruments.
 *
 * Computes equity breadth, bond regime, copper regime, dollar regime, metals
 * breadth, fixed income breadth, and a composite risk appetite score.
 *
 * Live mode  : computeMarketBreadth(getCandles, currentSymbol)
 * Historical : computeMarketBreadthHistorical(dailyClosesBySym, sortedDates, date)
 *
 * Graceful degradation: if any instrument's data is unavailable, it is silently
 * skipped — the score reflects only available instruments.
 */

// ── Instrument groupings ───────────────────────────────────────────────────────

const EQUITY_SYMBOLS    = ['MNQ', 'MES', 'M2K', 'MYM'];
const BOND_PRIMARY      = 'ZN';      // 10-year note — primary bond regime
const BOND_CONFIRM      = 'ZB';      // 30-year bond — secondary confirmation
const YIELD_SHORT       = 'ZT';      // 2-year note — yield curve short end
const COPPER_SYMBOL     = 'MHG';     // Micro Copper — global growth proxy
const DOLLAR_SYMBOL     = 'M6E';     // EUR/USD micro — inverse USD proxy
const METALS_SYMBOLS    = ['MGC', 'SIL', 'MHG'];
const FIXED_INCOME_SYMS = ['ZT', 'ZF', 'ZN', 'ZB', 'UB'];
const BTC_SYMBOL        = 'MBT';     // Bitcoin futures — risk barometer

// ── Regime classifier ─────────────────────────────────────────────────────────

/**
 * Classify market regime from an array of (daily) close prices.
 * Requires ≥11 values; returns 'neutral' if insufficient data.
 *
 * Method:
 *   20-bar price position: close > 20-bar high × 0.95 → bullish price signal
 *                          close < 20-bar low  × 1.05 → bearish price signal
 *   10-bar SMA direction:  current SMA > prior SMA → rising (bullish)
 *                          current SMA < prior SMA → falling (bearish)
 *   Combination:
 *     Both agree  → that direction (strong)
 *     One neutral → the other's direction (weak)
 *     Disagree    → neutral
 *
 * @param {number[]} closes  Chronological close prices (oldest first)
 * @returns {'bullish'|'bearish'|'neutral'}
 */
function classifyInstrumentRegime(closes, _sym) {
  if (!closes || closes.length < 11) return 'neutral';

  const last = closes[closes.length - 1];

  // ── 20-bar price position ──
  const window20 = closes.slice(Math.max(0, closes.length - 21)); // up to 21 values
  const high20   = Math.max(...window20);
  const low20    = Math.min(...window20);

  let priceSignal = 'neutral';
  if (last > high20 * 0.95) priceSignal = 'bullish';
  else if (last < low20 * 1.05) priceSignal = 'bearish';

  // ── 10-bar SMA direction ──
  let smaSignal = 'neutral';
  if (closes.length >= 11) {
    const curr10 = closes.slice(-10);
    const prev10 = closes.slice(-11, -1);
    const currSma = curr10.reduce((s, v) => s + v, 0) / 10;
    const prevSma = prev10.reduce((s, v) => s + v, 0) / 10;
    // 0.05% threshold to filter noise
    if (currSma > prevSma * 1.0005) smaSignal = 'bullish';
    else if (currSma < prevSma * 0.9995) smaSignal = 'bearish';
  }

  // ── Combine (primary classification) ──
  let primary;
  if (priceSignal === smaSignal) primary = priceSignal;         // both agree (including both neutral)
  else if (priceSignal === 'neutral') primary = smaSignal;      // price ambiguous → follow SMA
  else if (smaSignal   === 'neutral') primary = priceSignal;    // SMA ambiguous → follow price position
  else primary = 'neutral';                                     // disagree → no signal

  // ── Short-term override (5-bar SMA vs primary) ──
  // Detects intraday reversals faster than the 20-bar window alone.
  // If the 5-bar SMA moves opposite to the primary classification by a
  // significant magnitude (relative to ATR), downgrade or flip the regime.
  if (closes.length >= 6) {
    const curr5 = closes.slice(-5);
    const prev5 = closes.slice(-6, -1);
    const curr5Sma = curr5.reduce((s, v) => s + v, 0) / 5;
    const prev5Sma = prev5.reduce((s, v) => s + v, 0) / 5;
    const sma5Dir = curr5Sma > prev5Sma ? 'bullish' : curr5Sma < prev5Sma ? 'bearish' : 'neutral';

    // Compute a simple ATR proxy from the available bars (mean absolute bar-to-bar change)
    const recentBars = closes.slice(-Math.min(14, closes.length));
    let atrSum = 0;
    let atrCount = 0;
    for (let i = 1; i < recentBars.length; i++) {
      const diff = Math.abs(recentBars[i] - recentBars[i - 1]);
      if (diff > 0) { atrSum += diff; atrCount++; }
    }
    let atrProxy = atrCount > 0 ? atrSum / atrCount : 0;

    // Fallback: if ATR proxy is zero or bars too few, use 0.1% of last close
    if (atrProxy === 0 || atrCount < 3) {
      const fallbackATR = last * 0.001;
      if (_sym) console.log(`[breadth] ${_sym}: ATR proxy fallback (count=${atrCount}, using 0.1% of ${last.toFixed(2)} = ${fallbackATR.toFixed(2)})`);
      atrProxy = fallbackATR;
    }

    if (atrProxy > 0) {
      const sma5Move = Math.abs(curr5Sma - prev5Sma);
      const moveRatio = sma5Move / atrProxy;

      // Check if 5-bar SMA is opposite to primary classification
      const isOpposite =
        (primary === 'bullish' && sma5Dir === 'bearish') ||
        (primary === 'bearish' && sma5Dir === 'bullish');

      if (_sym) {
        console.log(`[breadth] ${_sym}: primary=${primary}, sma5Dir=${sma5Dir}, moveMag=${sma5Move.toFixed(4)}, atrProxy=${atrProxy.toFixed(4)}, moveRatio=${moveRatio.toFixed(3)}, isOpposite=${isOpposite}, override=${isOpposite && moveRatio >= 0.15 ? (moveRatio >= 0.35 ? 'FLIP' : 'DOWNGRADE') : 'none'}`);
      }

      if (isOpposite) {
        if (moveRatio >= 0.35) {
          // Strong opposite move — flip classification fully
          primary = sma5Dir;
        } else if (moveRatio >= 0.15) {
          // Moderate opposite move — downgrade to neutral
          primary = 'neutral';
        }
      }
    }
  }

  return primary;
}

/**
 * Extended version that also reports whether a short-term override was applied.
 * Used internally by _computeFromCloseArrays to detect breadth staleness.
 * @param {number[]} closes
 * @returns {{ regime: string, overridden: boolean }}
 */
function _classifyWithOverrideFlag(closes, _sym) {
  if (!closes || closes.length < 11) return { regime: 'neutral', overridden: false };

  const last = closes[closes.length - 1];
  const window20 = closes.slice(Math.max(0, closes.length - 21));
  const high20   = Math.max(...window20);
  const low20    = Math.min(...window20);

  let priceSignal = 'neutral';
  if (last > high20 * 0.95) priceSignal = 'bullish';
  else if (last < low20 * 1.05) priceSignal = 'bearish';

  let smaSignal = 'neutral';
  if (closes.length >= 11) {
    const curr10 = closes.slice(-10);
    const prev10 = closes.slice(-11, -1);
    const currSma = curr10.reduce((s, v) => s + v, 0) / 10;
    const prevSma = prev10.reduce((s, v) => s + v, 0) / 10;
    if (currSma > prevSma * 1.0005) smaSignal = 'bullish';
    else if (currSma < prevSma * 0.9995) smaSignal = 'bearish';
  }

  let primary;
  if (priceSignal === smaSignal) primary = priceSignal;
  else if (priceSignal === 'neutral') primary = smaSignal;
  else if (smaSignal   === 'neutral') primary = priceSignal;
  else primary = 'neutral';

  let overridden = false;

  if (closes.length >= 6) {
    const curr5 = closes.slice(-5);
    const prev5 = closes.slice(-6, -1);
    const curr5Sma = curr5.reduce((s, v) => s + v, 0) / 5;
    const prev5Sma = prev5.reduce((s, v) => s + v, 0) / 5;
    const sma5Dir = curr5Sma > prev5Sma ? 'bullish' : curr5Sma < prev5Sma ? 'bearish' : 'neutral';

    const recentBars = closes.slice(-Math.min(14, closes.length));
    let atrSum = 0;
    let atrCount = 0;
    for (let i = 1; i < recentBars.length; i++) {
      const diff = Math.abs(recentBars[i] - recentBars[i - 1]);
      if (diff > 0) { atrSum += diff; atrCount++; }
    }
    let atrProxy = atrCount > 0 ? atrSum / atrCount : 0;

    // Fallback: if ATR proxy is zero or bars too few, use 0.1% of last close
    if (atrProxy === 0 || atrCount < 3) {
      atrProxy = last * 0.001;
    }

    if (atrProxy > 0) {
      const sma5Move = Math.abs(curr5Sma - prev5Sma);
      const moveRatio = sma5Move / atrProxy;
      const isOpposite =
        (primary === 'bullish' && sma5Dir === 'bearish') ||
        (primary === 'bearish' && sma5Dir === 'bullish');

      if (_sym) {
        console.log(`[breadth-eq] ${_sym}: primary=${primary}, sma5Dir=${sma5Dir}, moveMag=${sma5Move.toFixed(4)}, atrProxy=${atrProxy.toFixed(4)}, moveRatio=${moveRatio.toFixed(3)}, isOpposite=${isOpposite}, override=${isOpposite && moveRatio >= 0.15 ? (moveRatio >= 0.35 ? 'FLIP' : 'DOWNGRADE') : 'none'}`);
      }

      if (isOpposite) {
        if (moveRatio >= 0.35) {
          primary = sma5Dir;
          overridden = true;
        } else if (moveRatio >= 0.15) {
          primary = 'neutral';
          overridden = true;
        }
      }
    }
  }

  return { regime: primary, overridden };
}

// ── Risk appetite composite score ──────────────────────────────────────────────

/**
 * Compute composite risk appetite from breadth components.
 * Mutates the breadth object — adds riskAppetiteScore and riskAppetite.
 */
function _computeRiskAppetite(b) {
  let score = 0;

  // Equity signals (high weight)
  score += (b.equityBreadth ?? 0) * 3;
  score -= (b.equityBreadthBearish ?? 0) * 3;

  // Bond signals (medium weight — bond selling = risk-on in growth context)
  if (b.bondRegime === 'bearish') score += 2;   // yields rising = mild risk-on
  if (b.bondRegime === 'bullish') score -= 2;   // flight to safety = risk-off

  // Copper (medium weight — global growth proxy)
  if (b.copperRegime === 'bullish') score += 3;
  if (b.copperRegime === 'bearish') score -= 3;

  // Dollar (lower weight — context dependent)
  if (b.dollarRegime === 'falling') score += 1;
  if (b.dollarRegime === 'rising')  score -= 1;

  // Bitcoin (lowest weight — risk barometer)
  if (b.btcRegime === 'bullish') score += 1;
  if (b.btcRegime === 'bearish') score -= 1;

  b.riskAppetiteScore = score;
  b.riskAppetite = score >= 5 ? 'on' : score <= -5 ? 'off' : 'neutral';
}

// ── Yield curve classification ─────────────────────────────────────────────────

/**
 * Classify yield curve slope from ZT (2yr) and ZN (10yr) price regimes.
 * Rising 10yr prices (ZN bullish) = falling yields.
 * Steepening: 10yr yield rising faster → ZN more bearish than ZT.
 * Flattening: 2yr yield rising faster → ZT more bearish than ZN.
 *
 * @param {'bullish'|'bearish'|'neutral'} ztRegime
 * @param {'bullish'|'bearish'|'neutral'} znRegime
 * @returns {'steepening'|'flattening'|'flat'}
 */
function _classifyYieldCurve(ztRegime, znRegime) {
  if (znRegime === 'bearish' && ztRegime !== 'bearish') return 'steepening';
  if (ztRegime === 'bearish' && znRegime !== 'bearish') return 'flattening';
  if (znRegime === 'bullish' && ztRegime !== 'bullish') return 'flattening';
  if (ztRegime === 'bullish' && znRegime !== 'bullish') return 'steepening';
  return 'flat';
}

// ── Empty breadth result template ──────────────────────────────────────────────

function _emptyBreadth() {
  return {
    equityBreadth:        0,
    equityBreadthBearish: 0,
    equityBreadthSymbols: EQUITY_SYMBOLS.slice(),
    bondRegime:           'neutral',
    yieldCurve:           'flat',
    copperRegime:         'neutral',
    dollarRegime:         'flat',
    metalsBreadth:        0,
    metalsBreadthBearish: 0,
    fixedIncomeBreadth:   0,
    btcRegime:            'neutral',
    riskAppetite:         'neutral',
    riskAppetiteScore:    0,
    breadthStale:         false,
  };
}

// ── Build breadth from a close-series map ──────────────────────────────────────

/**
 * Shared inner computation: given a map of { symbol: [close0, close1, ...] },
 * compute market breadth. Each close array must be ordered oldest→newest.
 * Arrays with fewer than 11 values are skipped (graceful degradation).
 */
function _computeFromCloseArrays(closesBySym) {
  const b = _emptyBreadth();

  // ── Equity breadth (with short-term override tracking for staleness) ──
  let equityOverrideCount = 0;
  for (const sym of EQUITY_SYMBOLS) {
    const closes = closesBySym[sym];
    if (!closes || closes.length < 11) continue;
    const { regime, overridden } = _classifyWithOverrideFlag(closes, sym);
    if (regime === 'bullish') b.equityBreadth++;
    else if (regime === 'bearish') b.equityBreadthBearish++;
    if (overridden) equityOverrideCount++;
  }
  // breadthStale: true when short-term override has downgraded ≥2 equity instruments
  b.breadthStale = equityOverrideCount >= 2;

  // ── Bond regime (ZN primary, ZB confirmation) ──
  const znCloses = closesBySym[BOND_PRIMARY];
  if (znCloses && znCloses.length >= 11) {
    const znRegime = classifyInstrumentRegime(znCloses, 'ZN');
    const zbCloses = closesBySym[BOND_CONFIRM];
    if (zbCloses && zbCloses.length >= 11) {
      const zbRegime = classifyInstrumentRegime(zbCloses, 'ZB');
      // Both agree → use that; otherwise ZN only
      if (znRegime === zbRegime || zbRegime === 'neutral') {
        b.bondRegime = znRegime;
      } else if (znRegime === 'neutral') {
        b.bondRegime = zbRegime;
      } else {
        b.bondRegime = znRegime; // conflicting — trust primary
      }
    } else {
      b.bondRegime = znRegime;
    }

    // Yield curve: ZT vs ZN
    const ztCloses = closesBySym[YIELD_SHORT];
    if (ztCloses && ztCloses.length >= 11) {
      const ztRegime = classifyInstrumentRegime(ztCloses, 'ZT');
      b.yieldCurve = _classifyYieldCurve(ztRegime, znRegime);
    }
  }

  // ── Copper regime ──
  const mhgCloses = closesBySym[COPPER_SYMBOL];
  if (mhgCloses && mhgCloses.length >= 11) {
    b.copperRegime = classifyInstrumentRegime(mhgCloses, 'MHG');
  }

  // ── Dollar regime (M6E = EUR/USD — inverse of USD) ──
  const m6eCloses = closesBySym[DOLLAR_SYMBOL];
  if (m6eCloses && m6eCloses.length >= 11) {
    const m6eRegime = classifyInstrumentRegime(m6eCloses, 'M6E');
    // M6E bullish = EUR rising = USD falling; M6E bearish = USD rising
    b.dollarRegime = m6eRegime === 'bullish' ? 'falling'
      : m6eRegime === 'bearish' ? 'rising'
      : 'flat';
  }

  // ── Metals breadth ──
  for (const sym of METALS_SYMBOLS) {
    const closes = closesBySym[sym];
    if (!closes || closes.length < 11) continue;
    const regime = classifyInstrumentRegime(closes, sym);
    if (regime === 'bullish') b.metalsBreadth++;
    else if (regime === 'bearish') b.metalsBreadthBearish++;
  }

  // ── Fixed income breadth (bearish = bonds selling = yields rising = risk-on signal) ──
  for (const sym of FIXED_INCOME_SYMS) {
    const closes = closesBySym[sym];
    if (!closes || closes.length < 11) continue;
    if (classifyInstrumentRegime(closes, sym) === 'bearish') b.fixedIncomeBreadth++;
  }

  // ── Bitcoin regime ──
  const mbtCloses = closesBySym[BTC_SYMBOL];
  if (mbtCloses && mbtCloses.length >= 11) {
    b.btcRegime = classifyInstrumentRegime(mbtCloses, 'MBT');
  }

  _computeRiskAppetite(b);
  return b;
}

// ── Live mode ──────────────────────────────────────────────────────────────────

/**
 * Compute market breadth in live mode.
 * Calls getCandles for each of the 16 CME symbols; instruments with no data
 * are silently skipped. Returns a breadth object or null on total failure.
 *
 * @param {Function} getCandles   (symbol, tf) → candle array
 * @param {string}   currentSymbol Current symbol being analysed (unused — future use)
 * @returns {Object|null}
 */
async function computeMarketBreadth(getCandles, currentSymbol) {
  const ALL_BREADTH_SYMBOLS = [
    ...EQUITY_SYMBOLS, ...METALS_SYMBOLS, ...FIXED_INCOME_SYMS,
    COPPER_SYMBOL, DOLLAR_SYMBOL, BTC_SYMBOL,
    'MCL', 'M6B',
  ];

  const TF = '30m'; // 30m bars give sufficient context (20 bars ≈ 10h)

  const closesBySym = {};
  for (const sym of ALL_BREADTH_SYMBOLS) {
    try {
      const candles = getCandles(sym, TF);
      if (!Array.isArray(candles) || candles.length < 11) continue;
      closesBySym[sym] = candles.map(c => c.close ?? c.c ?? 0).filter(v => v > 0);
    } catch (_) {
      // Symbol unavailable in live feed — skip
    }
  }

  if (Object.keys(closesBySym).length === 0) return null;

  try {
    return _computeFromCloseArrays(closesBySym);
  } catch (err) {
    console.warn('[breadth] computeMarketBreadth error:', err.message);
    return null;
  }
}

// ── Historical mode ────────────────────────────────────────────────────────────

/**
 * Compute market breadth from pre-loaded daily close data.
 *
 * @param {Object}   dailyClosesBySym  { symbol: { 'YYYY-MM-DD': close } }
 * @param {string[]} sortedDates       All trading dates (sorted asc) in the dataset
 * @param {string}   date              Current trading date (YYYY-MM-DD)
 * @returns {Object|null}              Breadth object, or null if insufficient data
 */
function computeMarketBreadthHistorical(dailyClosesBySym, sortedDates, date) {
  const dateIdx = sortedDates.indexOf(date);
  if (dateIdx < 0) return null;

  // Use prior trading days' closes — strict no-lookahead:
  // On `date` we know prices up through end of `date-1`.
  const LOOKBACK = 21; // need 21 days for 20-bar high/low + 11 for SMA
  const priorDates = sortedDates.slice(Math.max(0, dateIdx - LOOKBACK), dateIdx);
  if (priorDates.length < 11) return null; // insufficient warmup

  const closesBySym = {};
  for (const [sym, closesMap] of Object.entries(dailyClosesBySym)) {
    const arr = priorDates
      .map(d => closesMap[d])
      .filter(v => v != null && v > 0);
    if (arr.length >= 11) closesBySym[sym] = arr;
  }

  if (Object.keys(closesBySym).length === 0) return null;

  try {
    return _computeFromCloseArrays(closesBySym);
  } catch (err) {
    console.warn('[breadth] computeMarketBreadthHistorical error:', err.message);
    return null;
  }
}

// ── Legacy alias for callers using the spec's function name ───────────────────
// Kept for compatibility; internally uses pre-loaded daily closes, not raw 1m bars.
function computeMarketBreadthFromBars(allSymbolBars, date, _barIndex) {
  // allSymbolBars expected as { symbol: { date: close } } (daily closes map)
  // This alias accepts that shape directly.
  if (!allSymbolBars || typeof allSymbolBars !== 'object') return null;
  const allDates = new Set();
  for (const closes of Object.values(allSymbolBars)) {
    if (closes && typeof closes === 'object' && !Array.isArray(closes)) {
      for (const d of Object.keys(closes)) allDates.add(d);
    }
  }
  const sortedDates = [...allDates].sort();
  return computeMarketBreadthHistorical(allSymbolBars, sortedDates, date);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  classifyInstrumentRegime,
  computeMarketBreadth,
  computeMarketBreadthHistorical,
  computeMarketBreadthFromBars,
};
