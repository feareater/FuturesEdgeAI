'use strict';
/**
 * instruments.js — Single source of truth for all instrument metadata.
 *
 * Imported by historicalPipeline.js, hpCompute.js, server/backtest/engine.js,
 * and all other modules that need tick/point/fee values.
 * All symbol lists, point values, tick sizes, fees, Databento tickers, and HP proxy
 * mappings are defined here — never hardcoded in individual modules.
 *
 * Runtime overrides: config/settings.json → instruments block.
 * Call loadSettingsOverrides() after server starts to merge user-editable values.
 */

const fs   = require('fs');
const path = require('path');

const SETTINGS_PATH = path.resolve(__dirname, '../../config/settings.json');

const INSTRUMENTS = {
  // ── Equity Index ─────────────────────────────────────────────────────────────
  MNQ: {
    databento: 'MNQ.c.0', dbRoot: 'MNQ',
    category: 'equity_index', pointValue: 2,    tickSize: 0.25,  tickValue: 0.50, feePerRT: 1.62,
    optionsProxy: 'QQQ', rthOnly: true,  sessionHours: 23, pdh_rr: 2.0, tradeable: true,
  },
  MES: {
    databento: 'MES.c.0', dbRoot: 'MES',
    category: 'equity_index', pointValue: 5,    tickSize: 0.25,  tickValue: 1.25, feePerRT: 1.62,
    optionsProxy: 'SPY', rthOnly: true,  sessionHours: 23, pdh_rr: 2.0, tradeable: true,
  },
  M2K: {
    databento: 'M2K.c.0', dbRoot: 'M2K',
    category: 'equity_index', pointValue: 5,    tickSize: 0.10,  tickValue: 0.50, feePerRT: 1.62,
    optionsProxy: 'IWM', rthOnly: true,  sessionHours: 23, pdh_rr: 2.0, tradeable: true,
  },
  MYM: {
    databento: 'MYM.c.0', dbRoot: 'MYM',
    category: 'equity_index', pointValue: 0.50, tickSize: 1.0,   tickValue: 0.50, feePerRT: 1.62,
    optionsProxy: 'DIA', rthOnly: true,  sessionHours: 23, pdh_rr: 2.0, tradeable: true,
  },
  // ── Commodity — Metal ────────────────────────────────────────────────────────
  MGC: {
    databento: 'GC.c.0', dbRoot: 'GC',     // Micro Gold → GC proxy (same price/oz)
    category: 'commodity_metal', pointValue: 10,   tickSize: 0.10,  tickValue: 1.00, feePerRT: 2.12,
    optionsProxy: 'GLD', rthOnly: false, sessionHours: 23, pdh_rr: 1.0, tradeable: true,
  },
  SIL: {
    databento: 'SI.c.0', dbRoot: 'SI',     // Micro Silver → SI proxy
    category: 'commodity_metal', pointValue: 200, tickSize: 0.005, tickValue: 1.00, feePerRT: 1.92,
    optionsProxy: 'SLV', rthOnly: false, sessionHours: 23, pdh_rr: 1.5, tradeable: true,
  },
  MHG: {
    databento: 'MHG.c.0', dbRoot: 'MHG', continuousRoot: 'HG',  // Micro Copper; individual contracts MHGN6 etc.
    category: 'commodity_metal', pointValue: 2500,  tickSize: 0.0005, tickValue: 1.25, feePerRT: 1.92,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.5, tradeable: true,
  },
  // ── Commodity — Energy ───────────────────────────────────────────────────────
  MCL: {
    databento: 'MCL.c.0', dbRoot: 'MCL',
    category: 'commodity_energy', pointValue: 100, tickSize: 0.01,  tickValue: 1.00, feePerRT: 1.92,
    optionsProxy: 'USO', rthOnly: false, sessionHours: 23, pdh_rr: 1.5, tradeable: true,
  },
  // ── FX (reference only — charts + breadth, no setup scanning) ────────────────
  M6E: {
    databento: 'M6E.c.0', dbRoot: 'M6E',
    category: 'fx', pointValue: 12500, tickSize: 0.0001, tickValue: 1.25,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.5, tradeable: false,
  },
  M6B: {
    databento: 'M6B.c.0', dbRoot: 'M6B',
    category: 'fx', pointValue: 62500, tickSize: 0.0001, tickValue: 6.25,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.5, tradeable: false,
  },
  // ── Fixed Income (reference only — bonds breadth) ────────────────────────────
  ZT: {
    databento: 'ZT.c.0', dbRoot: 'ZT',
    category: 'fixed_income', pointValue: 2000, tickSize: 0.0078125, tickValue: 15.625,
    optionsProxy: null,  rthOnly: true,  sessionHours: 23, pdh_rr: 1.0, tradeable: false,
  },
  ZF: {
    databento: 'ZF.c.0', dbRoot: 'ZF',
    category: 'fixed_income', pointValue: 1000, tickSize: 0.0078125, tickValue:  7.8125,
    optionsProxy: null,  rthOnly: true,  sessionHours: 23, pdh_rr: 1.0, tradeable: false,
  },
  ZN: {
    databento: 'ZN.c.0', dbRoot: 'ZN',
    category: 'fixed_income', pointValue: 1000, tickSize: 0.015625,  tickValue: 15.625,
    optionsProxy: null,  rthOnly: true,  sessionHours: 23, pdh_rr: 1.0, tradeable: false,
  },
  ZB: {
    databento: 'ZB.c.0', dbRoot: 'ZB',
    category: 'fixed_income', pointValue: 1000, tickSize: 0.03125,   tickValue: 31.25,
    optionsProxy: null,  rthOnly: true,  sessionHours: 23, pdh_rr: 1.0, tradeable: false,
  },
  UB: {
    databento: 'UB.c.0', dbRoot: 'UB',
    category: 'fixed_income', pointValue: 1000, tickSize: 0.03125,   tickValue: 31.25,
    optionsProxy: null,  rthOnly: true,  sessionHours: 23, pdh_rr: 1.0, tradeable: false,
  },
  // ── Crypto Futures CME (reference only — btcRegime breadth) ─────────────────
  MBT: {
    databento: 'MBT.c.0', dbRoot: 'MBT',
    category: 'crypto_cme', pointValue: 0.10, tickSize: 5.0, tickValue: 0.50,
    optionsProxy: null,  rthOnly: false, sessionHours: 24, pdh_rr: 2.0, tradeable: false,
  },
};

// ── Reverse map: Databento root ticker → internal symbol ─────────────────────
// Only entries where dbRoot !== internal symbol need explicit mapping.
const DATABENTO_ROOT_TO_INTERNAL = {};
for (const [sym, meta] of Object.entries(INSTRUMENTS)) {
  DATABENTO_ROOT_TO_INTERNAL[meta.dbRoot] = sym;
}
// Individual contract tickers for some micro instruments use the micro-prefix,
// not the standard-sized dbRoot used for continuous contracts.
// e.g., Micro Gold individual contracts are MGCJ6 (not GCJ6) even though
// the continuous contract is GC.c.0.  Add explicit overrides for these.
DATABENTO_ROOT_TO_INTERNAL['MGC'] = 'MGC';  // Micro Gold: MGCJ6, MGCM6, etc.
DATABENTO_ROOT_TO_INTERNAL['SIL'] = 'SIL';  // Micro Silver: SILH9, SILZ6, etc.
DATABENTO_ROOT_TO_INTERNAL['MHG'] = 'MHG';  // Micro Copper: MHGN2, etc.

// ── Convenience groupings ────────────────────────────────────────────────────

const ALL_SYMBOLS        = Object.keys(INSTRUMENTS);
const TRADEABLE_SYMBOLS  = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].tradeable === true);
const REFERENCE_SYMBOLS  = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].tradeable === false);
const EQUITY_INDEX       = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category === 'equity_index');
const COMMODITY          = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category.startsWith('commodity'));
const FX                 = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category === 'fx');
const FIXED_INCOME       = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category === 'fixed_income');
const CRYPTO_FUTURES     = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category === 'crypto_cme');
const RTH_SYMBOLS        = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].rthOnly);
const OPRA_ELIGIBLE      = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].optionsProxy !== null);

// OPRA underlyings (ETFs) and their futures proxy symbol
const OPRA_UNDERLYINGS = [
  { etf: 'QQQ', futuresProxy: 'MNQ' },
  { etf: 'SPY', futuresProxy: 'MES' },
  { etf: 'GLD', futuresProxy: 'MGC' },
  { etf: 'USO', futuresProxy: 'MCL' },
  { etf: 'IWM', futuresProxy: 'M2K' },
  { etf: 'SLV', futuresProxy: 'SIL' },
  { etf: 'DIA', futuresProxy: 'MYM' },
];

// Derived convenience maps
const ETF_TO_FUTURES = Object.fromEntries(OPRA_UNDERLYINGS.map(o => [o.etf, o.futuresProxy]));
const FUTURES_TO_ETF = Object.fromEntries(OPRA_UNDERLYINGS.map(o => [o.futuresProxy, o.etf]));

// ── Settings override: merge user-editable values from config/settings.json ──

/**
 * Load the instruments block from settings.json and merge overridable fields
 * (tickSize, tickValue, pointValue, feePerRT) into INSTRUMENTS.
 * Called at startup and after POST /api/instruments/:symbol.
 */
function loadSettingsOverrides() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const overrides = cfg.instruments;
    if (!overrides || typeof overrides !== 'object') return;
    for (const [sym, vals] of Object.entries(overrides)) {
      if (!INSTRUMENTS[sym]) continue;
      if (typeof vals.tickSize  === 'number') INSTRUMENTS[sym].tickSize  = vals.tickSize;
      if (typeof vals.tickValue === 'number') INSTRUMENTS[sym].tickValue = vals.tickValue;
      if (typeof vals.pointValue === 'number') INSTRUMENTS[sym].pointValue = vals.pointValue;
      if (typeof vals.feePerRT  === 'number') INSTRUMENTS[sym].feePerRT  = vals.feePerRT;
    }
  } catch { /* settings.json may not have instruments block yet — use defaults */ }
}

// Apply overrides on first load
loadSettingsOverrides();

// ── Derived convenience maps (live — always reflect current INSTRUMENTS) ────

function _pointValueMap() {
  return Object.fromEntries(ALL_SYMBOLS.map(s => [s, INSTRUMENTS[s].pointValue]));
}
function _tickSizeMap() {
  return Object.fromEntries(ALL_SYMBOLS.map(s => [s, INSTRUMENTS[s].tickSize]));
}
function _tickValueMap() {
  return Object.fromEntries(ALL_SYMBOLS.map(s => [s, INSTRUMENTS[s].tickValue]));
}
function _feePerRTMap() {
  return Object.fromEntries(ALL_SYMBOLS.filter(s => INSTRUMENTS[s].feePerRT != null).map(s => [s, INSTRUMENTS[s].feePerRT]));
}

// POINT_VALUE map (for backtest engine P&L calculations)
const POINT_VALUE = _pointValueMap();

// HP_PROXY map (for backtest engine HP snapshot loading)
const HP_PROXY = Object.fromEntries(ALL_SYMBOLS.map(s => [s, INSTRUMENTS[s].optionsProxy ?? null]));

module.exports = {
  INSTRUMENTS,
  DATABENTO_ROOT_TO_INTERNAL,
  ALL_SYMBOLS,
  TRADEABLE_SYMBOLS,
  REFERENCE_SYMBOLS,
  EQUITY_INDEX,
  COMMODITY,
  FX,
  FIXED_INCOME,
  CRYPTO_FUTURES,
  RTH_SYMBOLS,
  OPRA_ELIGIBLE,
  OPRA_UNDERLYINGS,
  ETF_TO_FUTURES,
  FUTURES_TO_ETF,
  POINT_VALUE,
  HP_PROXY,
  loadSettingsOverrides,
  getPointValue:  _pointValueMap,
  getTickSize:    _tickSizeMap,
  getTickValue:   _tickValueMap,
  getFeePerRT:    _feePerRTMap,
};
