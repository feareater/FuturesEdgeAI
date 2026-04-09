'use strict';
// Bar validation / sanity check for live 1m bars from the Databento feed.
// Catches out-of-range ticks, intra-bar inconsistencies, and spike artifacts
// BEFORE bars reach the chart, disk, or aggregator.

// ---------------------------------------------------------------------------
// Per-symbol rolling ATR and stats
// ---------------------------------------------------------------------------

const _state = {};  // symbol → { atrBuf: number[], atrSum: number, rollingATR: number }
const _stats = {};  // symbol → { total: 0, flagged: 0, rejected: 0 }

const ATR_PERIOD    = 20;
const SPIKE_ATR_MULT = 4;   // range > 4× ATR = spike (reduced from 5×)
const CLAMP_ATR_MULT = 1.5; // clamp spikes to open ± 1.5× ATR
const OPEN_GAP_PCT   = 0.03; // 3% max open-gap from previous close

// Per-symbol ATR sanity bounds for 1m bars (floor, ceiling).
// Prevents contaminated ATR from disabling the spike clamp.
// If rolling ATR falls outside these bounds, it's clamped before use.
const ATR_BOUNDS_1M = {
  MNQ: [5,    150],   // 5–150 pts per 1m bar
  MES: [0.5,  20],    // 0.5–20 pts per 1m bar
  M2K: [0.2,  8],     // 0.2–8 pts per 1m bar
  MYM: [5,    250],   // 5–250 pts per 1m bar
  MGC: [0.5,  30],    // 0.5–30 pts per 1m bar
  SIL: [0.05, 2],     // 0.05–2 pts per 1m bar
  MHG: [0.002, 0.08], // 0.002–0.08 pts per 1m bar (copper is tight)
  MCL: [0.05, 2],     // 0.05–2 pts per 1m bar
};

function _ensureState(symbol) {
  if (!_state[symbol]) {
    _state[symbol] = { atrBuf: [], atrSum: 0, rollingATR: 0 };
  }
  if (!_stats[symbol]) {
    _stats[symbol] = { total: 0, flagged: 0, rejected: 0 };
  }
}

/**
 * Update the rolling ATR estimate for a symbol with a new bar's range.
 */
function _updateATR(symbol, range) {
  const s = _state[symbol];
  s.atrBuf.push(range);
  s.atrSum += range;
  if (s.atrBuf.length > ATR_PERIOD) {
    s.atrSum -= s.atrBuf.shift();
  }
  s.rollingATR = s.atrSum / s.atrBuf.length;
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validate and optionally correct a 1m bar before it enters the pipeline.
 *
 * @param {string} symbol       Internal symbol (e.g. 'MNQ')
 * @param {Object} bar          { time, open, high, low, close, volume }
 * @param {Object|null} previousBar  The prior completed bar (same symbol), or null
 * @returns {Object|null}  Corrected bar, or null if bar must be rejected entirely
 */
function validateBar(symbol, bar, previousBar) {
  _ensureState(symbol);
  const stats = _stats[symbol];
  stats.total++;

  // --- RULE 4: Zero / null / NaN guard ---
  if (!_isFinitePositive(bar.open) || !_isFinitePositive(bar.high) ||
      !_isFinitePositive(bar.low)  || !_isFinitePositive(bar.close)) {
    console.warn(`[barValidator] REJECTED ${symbol} @ ${bar.time}: null/zero/NaN in OHLC — o=${bar.open} h=${bar.high} l=${bar.low} c=${bar.close}`);
    stats.rejected++;
    return null;
  }

  let corrected = { ...bar };
  let flagged = false;

  // --- RULE 1: Price continuity check (open vs previous close) ---
  if (previousBar && _isFinitePositive(previousBar.close)) {
    const deviation = Math.abs(corrected.open - previousBar.close) / previousBar.close;
    if (deviation > OPEN_GAP_PCT) {
      console.warn(`[barValidator] OPEN GAP ${symbol} @ ${corrected.time}: open=${corrected.open}, prevClose=${previousBar.close}, dev=${(deviation * 100).toFixed(2)}% — clamping`);
      corrected.open = previousBar.close;
      corrected.validated = false;
      corrected.reason = 'open_gap';
      flagged = true;
    }
  }

  // --- RULE 2: Intra-bar consistency ---
  {
    const o = corrected.open, c = corrected.close;
    let h = corrected.high, l = corrected.low;
    let fixed = false;

    if (h < o || h < c || h < l) {
      h = Math.max(o, c, l);
      fixed = true;
    }
    if (l > o || l > c) {
      l = Math.min(o, c);
      fixed = true;
    }

    if (fixed) {
      console.warn(`[barValidator] OHLC FIX ${symbol} @ ${corrected.time}: reconstructed h=${h} l=${l} from o=${o} c=${c}`);
      corrected.high = h;
      corrected.low = l;
      flagged = true;
    }
  }

  // --- RULE 3a: Suspicious intra-bar range (open-relative) ---
  {
    const pctHigh = corrected.open > 0 ? corrected.high / corrected.open : 1;
    const pctLow  = corrected.open > 0 ? corrected.low  / corrected.open : 1;
    if (pctHigh > 1.05 || pctLow < 0.95) {
      console.warn(`[barValidator] SUSPICIOUS ${symbol} @ ${corrected.time}: >5%% range — o=${corrected.open} h=${corrected.high} l=${corrected.low} c=${corrected.close}`);
      flagged = true;
    }
    if (pctHigh > 1.10 || pctLow < 0.90) {
      console.warn(`[barValidator] EXTREME CLAMP ${symbol} @ ${corrected.time}: >10%% range — clamping h/l to ±10%% of open`);
      corrected.high = Math.min(corrected.high, corrected.open * 1.10);
      corrected.low  = Math.max(corrected.low,  corrected.open * 0.90);
      corrected.high = Math.max(corrected.high, corrected.open, corrected.close);
      corrected.low  = Math.min(corrected.low,  corrected.open, corrected.close);
      flagged = true;
    }
  }

  // --- RULE 3b: Range spike filter (ATR-based) ---
  const range = corrected.high - corrected.low;
  const s = _state[symbol];

  // Clamp rolling ATR to per-symbol bounds before using it as spike reference
  let effectiveATR = s.rollingATR;
  const bounds = ATR_BOUNDS_1M[symbol];
  if (bounds && effectiveATR > 0) {
    if (effectiveATR < bounds[0]) {
      console.warn(`[barValidator] ${symbol} ATR ${effectiveATR.toFixed(4)} below floor ${bounds[0]}, using floor`);
      effectiveATR = bounds[0];
    }
    if (effectiveATR > bounds[1]) {
      console.warn(`[barValidator] ${symbol} ATR ${effectiveATR.toFixed(4)} above ceiling ${bounds[1]}, using ceiling`);
      effectiveATR = bounds[1];
    }
  }

  if (effectiveATR > 0 && range > SPIKE_ATR_MULT * effectiveATR) {
    const atr = effectiveATR;
    console.warn(`[barValidator] SPIKE CLAMPED ${symbol} @ ${corrected.time}: range was ${range.toFixed(4)}, ATR=${atr.toFixed(4)}`);
    corrected.high = corrected.open + (CLAMP_ATR_MULT * atr);
    corrected.low  = corrected.open - (CLAMP_ATR_MULT * atr);
    // Re-apply consistency after clamping
    corrected.high = Math.max(corrected.high, corrected.open, corrected.close);
    corrected.low  = Math.min(corrected.low, corrected.open, corrected.close);
    flagged = true;
  }

  // Update rolling ATR with the (possibly clamped) range
  _updateATR(symbol, corrected.high - corrected.low);

  // --- RULE 5: Volume guard ---
  if (corrected.volume == null || !isFinite(corrected.volume)) {
    corrected.volume = 0;
  }
  if (corrected.volume < 0) {
    corrected.volume = 0;
  }
  if (corrected.volume > 1_000_000) {
    console.warn(`[barValidator] HIGH VOLUME ${symbol} @ ${corrected.time}: vol=${corrected.volume}`);
    // Don't reject — just log
  }

  if (flagged) stats.flagged++;
  return corrected;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _isFinitePositive(v) {
  return v != null && isFinite(v) && v > 0;
}

// ---------------------------------------------------------------------------
// Stats export
// ---------------------------------------------------------------------------

/**
 * Return per-symbol validation statistics.
 * @returns {{ bySymbol: Object }}
 */
function getValidatorStats() {
  const bySymbol = {};
  for (const [sym, s] of Object.entries(_stats)) {
    bySymbol[sym] = { ...s };
  }
  return { bySymbol };
}

module.exports = { validateBar, getValidatorStats };
