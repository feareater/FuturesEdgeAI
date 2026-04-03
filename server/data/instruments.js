'use strict';
/**
 * instruments.js — Single source of truth for all instrument metadata.
 *
 * Imported by historicalPipeline.js, hpCompute.js, and server/backtest/engine.js.
 * All symbol lists, point values, tick sizes, Databento tickers, and HP proxy
 * mappings are defined here — never hardcoded in individual modules.
 */

const INSTRUMENTS = {
  // ── Equity Index ─────────────────────────────────────────────────────────────
  MNQ: {
    databento: 'MNQ.c.0', dbRoot: 'MNQ',
    category: 'equity_index', pointValue: 2,    tickSize: 0.25,  tickValue: 0.50,
    optionsProxy: 'QQQ', rthOnly: true,  sessionHours: 23, pdh_rr: 2.0,
  },
  MES: {
    databento: 'MES.c.0', dbRoot: 'MES',
    category: 'equity_index', pointValue: 5,    tickSize: 0.25,  tickValue: 1.25,
    optionsProxy: 'SPY', rthOnly: true,  sessionHours: 23, pdh_rr: 2.0,
  },
  M2K: {
    databento: 'M2K.c.0', dbRoot: 'M2K',
    category: 'equity_index', pointValue: 5,    tickSize: 0.10,  tickValue: 0.50,
    optionsProxy: 'IWM', rthOnly: true,  sessionHours: 23, pdh_rr: 2.0,
  },
  MYM: {
    databento: 'MYM.c.0', dbRoot: 'MYM',
    category: 'equity_index', pointValue: 0.50, tickSize: 1.0,   tickValue: 0.50,
    optionsProxy: null,  rthOnly: true,  sessionHours: 23, pdh_rr: 2.0,
  },
  // ── Commodity — Metal ────────────────────────────────────────────────────────
  MGC: {
    databento: 'GC.c.0', dbRoot: 'GC',     // Micro Gold → GC proxy (same price/oz)
    category: 'commodity_metal', pointValue: 10,   tickSize: 0.10,  tickValue: 1.00,
    optionsProxy: 'GLD', rthOnly: false, sessionHours: 23, pdh_rr: 1.0,
  },
  SIL: {
    databento: 'SI.c.0', dbRoot: 'SI',     // Micro Silver → SI proxy
    category: 'commodity_metal', pointValue: 1000, tickSize: 0.005, tickValue: 5.00,
    optionsProxy: 'SLV', rthOnly: false, sessionHours: 23, pdh_rr: 1.5,
  },
  MHG: {
    databento: 'HG.c.0', dbRoot: 'HG',    // Micro Copper → HG proxy
    category: 'commodity_metal', pointValue: 1250, tickSize: 0.0005, tickValue: 0.625,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.5,
  },
  // ── Commodity — Energy ───────────────────────────────────────────────────────
  MCL: {
    databento: 'MCL.c.0', dbRoot: 'MCL',
    category: 'commodity_energy', pointValue: 100, tickSize: 0.01,  tickValue: 1.00,
    optionsProxy: 'USO', rthOnly: false, sessionHours: 23, pdh_rr: 1.5,
  },
  // ── FX ───────────────────────────────────────────────────────────────────────
  M6E: {
    databento: 'M6E.c.0', dbRoot: 'M6E',
    category: 'fx', pointValue: 12500, tickSize: 0.0001, tickValue: 1.25,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.5,
  },
  M6B: {
    databento: 'M6B.c.0', dbRoot: 'M6B',
    category: 'fx', pointValue: 6250,  tickSize: 0.0001, tickValue: 0.625,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.5,
  },
  // ── Fixed Income ─────────────────────────────────────────────────────────────
  ZT: {
    databento: 'ZT.c.0', dbRoot: 'ZT',
    category: 'fixed_income', pointValue: 2000, tickSize: 0.0078125, tickValue: 15.625,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.0,
  },
  ZF: {
    databento: 'ZF.c.0', dbRoot: 'ZF',
    category: 'fixed_income', pointValue: 1000, tickSize: 0.015625,  tickValue: 15.625,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.0,
  },
  ZN: {
    databento: 'ZN.c.0', dbRoot: 'ZN',
    category: 'fixed_income', pointValue: 1000, tickSize: 0.015625,  tickValue: 15.625,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.0,
  },
  ZB: {
    databento: 'ZB.c.0', dbRoot: 'ZB',
    category: 'fixed_income', pointValue: 1000, tickSize: 0.03125,   tickValue: 31.25,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.0,
  },
  UB: {
    databento: 'UB.c.0', dbRoot: 'UB',
    category: 'fixed_income', pointValue: 1000, tickSize: 0.03125,   tickValue: 31.25,
    optionsProxy: null,  rthOnly: false, sessionHours: 23, pdh_rr: 1.0,
  },
  // ── Crypto Futures ───────────────────────────────────────────────────────────
  MBT: {
    databento: 'MBT.c.0', dbRoot: 'MBT',
    category: 'crypto', pointValue: 5, tickSize: 5.0, tickValue: 25.00,
    optionsProxy: null,  rthOnly: false, sessionHours: 24, pdh_rr: 2.0,
  },
};

// ── Reverse map: Databento root ticker → internal symbol ─────────────────────
// Only entries where dbRoot !== internal symbol need explicit mapping.
const DATABENTO_ROOT_TO_INTERNAL = {};
for (const [sym, meta] of Object.entries(INSTRUMENTS)) {
  DATABENTO_ROOT_TO_INTERNAL[meta.dbRoot] = sym;
}

// ── Convenience groupings ────────────────────────────────────────────────────

const ALL_SYMBOLS     = Object.keys(INSTRUMENTS);
const EQUITY_INDEX    = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category === 'equity_index');
const COMMODITY       = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category.startsWith('commodity'));
const FX              = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category === 'fx');
const FIXED_INCOME    = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category === 'fixed_income');
const CRYPTO_FUTURES  = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].category === 'crypto');
const RTH_SYMBOLS     = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].rthOnly);
const OPRA_ELIGIBLE   = ALL_SYMBOLS.filter(s => INSTRUMENTS[s].optionsProxy !== null);

// OPRA underlyings (ETFs) and their futures proxy symbol
const OPRA_UNDERLYINGS = [
  { etf: 'QQQ', futuresProxy: 'MNQ' },
  { etf: 'SPY', futuresProxy: 'MES' },
  { etf: 'GLD', futuresProxy: 'MGC' },
  { etf: 'USO', futuresProxy: 'MCL' },
  { etf: 'IWM', futuresProxy: 'M2K' },
  { etf: 'SLV', futuresProxy: 'SIL' },
];

// Derived convenience maps
const ETF_TO_FUTURES = Object.fromEntries(OPRA_UNDERLYINGS.map(o => [o.etf, o.futuresProxy]));
const FUTURES_TO_ETF = Object.fromEntries(OPRA_UNDERLYINGS.map(o => [o.futuresProxy, o.etf]));

// POINT_VALUE map (for backtest engine P&L calculations)
const POINT_VALUE = Object.fromEntries(ALL_SYMBOLS.map(s => [s, INSTRUMENTS[s].pointValue]));

// HP_PROXY map (for backtest engine HP snapshot loading)
const HP_PROXY = Object.fromEntries(ALL_SYMBOLS.map(s => [s, INSTRUMENTS[s].optionsProxy ?? null]));

module.exports = {
  INSTRUMENTS,
  DATABENTO_ROOT_TO_INTERNAL,
  ALL_SYMBOLS,
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
};
