'use strict';
/**
 * engine.js — FuturesEdge AI Backtest Engine
 *
 * Stateless bar-by-bar replay of the analysis pipeline.
 * CRITICAL: Never exposes future bars to the analysis functions.
 * All results are deterministic given the same config.
 *
 * Usage:
 *   const { runBacktest } = require('./engine');
 *   const results = await runBacktest(config);
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const { computeIndicators, computeDDBands }  = require('../analysis/indicators');
const { classifyRegime }     = require('../analysis/regime');
const { detectSetups }       = require('../analysis/setups');
const { buildMarketContext } = require('../analysis/marketContext');

// ─── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(__dirname, '../../data/historical');
const RESULTS_DIR = path.resolve(__dirname, '../../data/backtest/results');

const POINT_VALUE = { MNQ: 2, MES: 5, MGC: 10, MCL: 100 };

/** Bar duration in seconds for each timeframe (bar ts = bar open; close = ts + duration) */
const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400 };

// Max hold time in 1m bars (default 8h = 480 bars)
const DEFAULT_MAX_BARS = 480;

// HP_PROXY: which underlying maps to which symbol
const HP_PROXY = { MNQ: 'QQQ', MES: 'SPY', MGC: null, MCL: null };

// ─── In-progress jobs ─────────────────────────────────────────────────────────

const _jobs = new Map(); // jobId → { status, progress, eta, config, results, startedAt, completedAt, error }

// ─── File I/O helpers ─────────────────────────────────────────────────────────

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

/** Load bars for a symbol+date+timeframe. Normalizes ts→time for indicators.js. */
function loadDailyBars(symbol, date, tf) {
  const tfDir = tf || '1m';
  const f = path.join(DATA_DIR, 'futures', symbol, tfDir, `${date}.json`);
  const bars = readJSON(f) || [];
  // indicators.js uses c.time; historical files store c.ts — normalize
  return bars.map(b => b.time != null ? b : { ...b, time: b.ts });
}

/** Load HP snapshot for a symbol+date. Returns null if unavailable. */
function loadHPSnapshot(symbol, date) {
  const proxy = HP_PROXY[symbol];
  if (!proxy) return null;
  const f = path.join(DATA_DIR, 'options', proxy, 'computed', `${date}.json`);
  return readJSON(f);
}

/** Get all trading dates available for a symbol between start/end inclusive */
function getTradingDays(symbol, startDate, endDate) {
  const dir = path.join(DATA_DIR, 'futures', symbol, '1m');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .filter(d => d >= startDate && d <= endDate)
    .sort();
}

/** Build market context from HP snapshot (backtest version — no live fetch) */
function buildMarketContextFromHP(hp, indicators) {
  if (!hp) return null;
  const price = indicators?.close ?? 0;

  // Build the same structure as marketContext.js's hp sub-object
  const levels = [];
  if (hp.scaledHedgePressureZones) {
    for (const z of hp.scaledHedgePressureZones) {
      levels.push({ type: `HP ${z.pressure === 'support' ? 'Sup' : 'Res'}`, price: z.scaledStrike, pressure: z.pressure });
    }
  }
  if (hp.scaledGexFlip   != null) levels.push({ type: 'GEX Flip', price: hp.scaledGexFlip,   pressure: 'neutral' });
  if (hp.scaledMaxPain   != null) levels.push({ type: 'Max Pain', price: hp.scaledMaxPain,    pressure: 'neutral' });
  if (hp.scaledCallWall  != null) levels.push({ type: 'Call Wall', price: hp.scaledCallWall,  pressure: 'resistance' });
  if (hp.scaledPutWall   != null) levels.push({ type: 'Put Wall',  price: hp.scaledPutWall,   pressure: 'support' });

  // Find nearest level
  let nearestLevel = null;
  let nearestDist  = Infinity;
  for (const lvl of levels) {
    const d = Math.abs(price - lvl.price);
    if (d < nearestDist) { nearestDist = d; nearestLevel = lvl; }
  }

  return {
    hp: {
      levels,
      nearestLevel,
      nearestDistAtr: indicators?.atr ? nearestDist / indicators.atr : null,
      pressureDirection: nearestLevel?.pressure ?? 'neutral',
      dexScore: hp.dexScore ?? 0,
      dexBias: hp.dexBias ?? 'neutral',
      resilienceScore: hp.resilienceScore ?? 50,
      resilienceLabel: hp.resilienceLabel ?? 'neutral',
      lastFetchedAt: null, // historical — no freshness decay
    },
    options: hp, // full snapshot available for scoring
    vix: { regime: 'normal', direction: 'flat', value: null }, // VIX not in historical data
    dxy: { direction: 'flat', alignmentBonusLong: 0, alignmentBonusShort: 0, applicable: false },
  };
}

// ─── Time gate helpers ────────────────────────────────────────────────────────

/**
 * Returns whether a Unix-seconds timestamp falls in DST (US Eastern).
 * DST 2026: starts March 8 02:00 ET, ends November 1 02:00 ET.
 */
function _isDST(tsSeconds) {
  const d = new Date(tsSeconds * 1000);
  const y = d.getUTCFullYear();
  // Second Sunday of March at 2am ET = 7am UTC
  const dstStart = _nthSunday(y, 2, 2) + 7 * 3600;
  // First Sunday of November at 2am ET = 6am UTC
  const dstEnd   = _nthSunday(y, 10, 1) + 6 * 3600;
  return tsSeconds >= dstStart && tsSeconds < dstEnd;
}

function _nthSunday(year, month, n) {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    if (d.getUTCDay() === 0 && ++count === n) return d.getTime() / 1000;
  }
  return Infinity;
}

/** Get ET hour and minute from Unix seconds */
function _etHourMin(tsSeconds) {
  const offsetHours = _isDST(tsSeconds) ? 4 : 5;
  const etMs = tsSeconds * 1000 - offsetHours * 3600000;
  const d = new Date(etMs);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), totalMins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/**
 * Is this timestamp in the RTH close window? (16:45–18:05 ET)
 * No new entries, and force-close any open trade.
 */
function _inCloseWindow(tsSeconds) {
  const { totalMins } = _etHourMin(tsSeconds);
  return totalMins >= 16 * 60 + 45 && totalMins < 18 * 60 + 5;
}

/**
 * Get force-close timestamp for a date: 16:45:00 ET as Unix seconds.
 * Uses the bars array to find actual bar closest to 16:45 ET.
 */
function _forceCloseTs(date, bars1m) {
  // Find the last bar at or before 16:45 ET.
  // Bars span overnight (17:01 ET prev day → 17:00 ET this day), so
  // totalMins wraps through midnight — can't use early break.
  const TARGET = 16 * 60 + 45; // 1005
  let best = null;
  for (const bar of bars1m) {
    const { totalMins } = _etHourMin(bar.ts);
    // Only consider RTH/ETH bars before 16:45
    if (totalMins <= TARGET) best = bar.ts;
  }
  return best;
}

// ─── Outcome Resolution ───────────────────────────────────────────────────────

/**
 * Walk forward through 1m bars to resolve win/loss/timeout.
 * @param {object} setup          — { direction, entry, sl, tp }
 * @param {Array}  futBars        — 1m bars from (i+1) onward
 * @param {number} maxBars        — give up after this many bars
 * @param {number} forceCloseTs   — force-close at this timestamp (16:45 ET)
 * @returns {object} { outcome, exitPrice, barsToOutcome, pnl, exitTs, forceClosed }
 */
function resolveOutcome(setup, futBars, maxBars, pointValue, contracts, forceCloseTs) {
  const { direction, entry, sl, tp } = setup;
  const isBull = direction === 'bullish';
  const pts = pointValue ?? 1;
  const qty = contracts ?? 1;

  let barsChecked = 0;
  for (const bar of futBars) {
    if (barsChecked >= maxBars) break;
    barsChecked++;

    // Force-close at 16:45 ET — exit at this bar's close, mark as 'closed'
    if (forceCloseTs && bar.ts >= forceCloseTs) {
      const exitPrice = bar.close;
      const pnl = isBull
        ? (exitPrice - entry) * pts * qty
        : (entry - exitPrice) * pts * qty;
      return { outcome: 'closed', exitPrice, barsToOutcome: barsChecked, pnl, exitTs: bar.ts, forceClosed: true };
    }

    if (isBull) {
      if (bar.low <= sl) {
        const exitPrice = sl;
        const pnl = (exitPrice - entry) * pts * qty;
        return { outcome: 'lost', exitPrice, barsToOutcome: barsChecked, pnl, exitTs: bar.ts };
      }
      if (bar.high >= tp) {
        const exitPrice = tp;
        const pnl = (exitPrice - entry) * pts * qty;
        return { outcome: 'won', exitPrice, barsToOutcome: barsChecked, pnl, exitTs: bar.ts };
      }
    } else {
      if (bar.high >= sl) {
        const exitPrice = sl;
        const pnl = (entry - exitPrice) * pts * qty;
        return { outcome: 'lost', exitPrice, barsToOutcome: barsChecked, pnl, exitTs: bar.ts };
      }
      if (bar.low <= tp) {
        const exitPrice = tp;
        const pnl = (entry - exitPrice) * pts * qty;
        return { outcome: 'won', exitPrice, barsToOutcome: barsChecked, pnl, exitTs: bar.ts };
      }
    }
  }

  // Timeout — exit at last bar close
  const lastBar = futBars[Math.min(barsChecked - 1, futBars.length - 1)];
  const exitPrice = lastBar?.close ?? entry;
  const pnl = isBull
    ? (exitPrice - entry) * pts * qty
    : (entry - exitPrice) * pts * qty;
  return { outcome: 'timeout', exitPrice, barsToOutcome: barsChecked, pnl, exitTs: lastBar?.ts };
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function computeStats(trades, equity) {
  const won     = trades.filter(t => t.outcome === 'won');
  const lost    = trades.filter(t => t.outcome === 'lost');
  const timeout = trades.filter(t => t.outcome === 'timeout' || t.outcome === 'closed');

  const grossWin  = won.reduce((s, t) => s + (t.netPnl ?? 0), 0);
  const grossLoss = Math.abs(lost.reduce((s, t) => s + (t.netPnl ?? 0), 0));
  const winRate   = trades.length > 0 ? won.length / trades.length : 0;
  const pf        = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  const pnls = trades.map(t => t.netPnl ?? 0);
  const avgWin  = won.length > 0  ? grossWin / won.length  : 0;
  const avgLoss = lost.length > 0 ? -grossLoss / lost.length : 0;
  const avgR    = pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) / pnls.length : 0;

  // Max drawdown — compute from individual trade sequence (daily equity misses intraday losses)
  let peak = 0, maxDD = 0, ddStart = null, curDDStart = null;
  let cumPnl = 0;
  const sortedTrades = [...trades].sort((a, b) => (a.entryTs ?? 0) - (b.entryTs ?? 0));
  for (const t of sortedTrades) {
    cumPnl += t.netPnl ?? 0;
    if (cumPnl > peak) { peak = cumPnl; curDDStart = t.date; }
    const dd = peak - cumPnl;
    if (dd > maxDD) { maxDD = dd; ddStart = curDDStart; }
  }

  // Sharpe (daily returns)
  const dailyPnls = [];
  let lastCum = 0;
  for (const pt of equity) {
    dailyPnls.push(pt.cumPnl - lastCum);
    lastCum = pt.cumPnl;
  }
  const mean = dailyPnls.length > 0 ? dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length : 0;
  const stddev = dailyPnls.length > 1
    ? Math.sqrt(dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1))
    : 0;
  const sharpe = stddev > 0 ? (mean / stddev) * Math.sqrt(252) : 0;

  // Expectancy
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;

  // Breakdown helpers
  const breakdown = (keyFn) => {
    const map = {};
    for (const t of trades) {
      const k = keyFn(t);
      if (!map[k]) map[k] = { trades: 0, won: 0, lost: 0, timeout: 0, pnl: 0 };
      map[k].trades++;
      map[k][t.outcome]++;
      map[k].pnl += t.netPnl ?? 0;
    }
    const result = {};
    for (const [k, v] of Object.entries(map)) {
      result[k] = { ...v, winRate: v.trades > 0 ? v.won / v.trades : 0 };
    }
    return result;
  };

  return {
    totalTrades:     trades.length,
    won:             won.length,
    lost:            lost.length,
    timeout:         timeout.length,
    winRate:         +winRate.toFixed(4),
    profitFactor:    isFinite(pf) ? +pf.toFixed(3) : pf > 0 ? 999 : 0,
    avgWin:          +avgWin.toFixed(2),
    avgLoss:         +avgLoss.toFixed(2),
    avgR:            +avgR.toFixed(2),
    grossPnl:        +pnls.reduce((s, v) => s + v, 0).toFixed(2),
    maxDrawdown:     +maxDD.toFixed(2),
    maxDrawdownStart: ddStart,
    sharpeRatio:     +sharpe.toFixed(3),
    expectancy:      +expectancy.toFixed(2),
    largestWin:      won.length  > 0 ? +Math.max(...won.map(t => t.netPnl ?? 0)).toFixed(2) : 0,
    largestLoss:     lost.length > 0 ? +Math.min(...lost.map(t => t.netPnl ?? 0)).toFixed(2) : 0,
    bySymbol:        breakdown(t => t.symbol),
    bySetupType:     breakdown(t => t.setupType),
    byTimeframe:     breakdown(t => t.timeframe),
    byHour:          breakdown(t => t.hour),
    byDirection:     breakdown(t => t.direction),
    byConfBucket:    breakdown(t => {
      const c = t.confidence ?? 0;
      if (c < 70) return '65-70';
      if (c < 80) return '70-80';
      if (c < 90) return '80-90';
      return '90+';
    }),
    byHPProximity:   breakdown(t => t.hpProximity ?? 'none'),
    byResilienceLabel: breakdown(t => t.resilienceLabel ?? 'unknown'),
  };
}

// ─── Core Backtest Loop ───────────────────────────────────────────────────────

async function runBacktest(config) {
  const {
    symbols      = ['MNQ'],
    timeframes   = ['5m', '15m'],
    startDate,
    endDate,
    minConfidence = 65,
    setupTypes    = ['zone_rejection', 'pdh_breakout', 'trendline_break', 'or_breakout'],
    contracts     = { MNQ: 1, MES: 1, MGC: 1, MCL: 1 },
    useHP         = true,
    maxHoldBars   = DEFAULT_MAX_BARS,
    feePerRT      = 4,
  } = config;

  const alerts = [];  // all detected setups (including non-traded)
  const trades = [];  // resolved trades
  const equityMap = {}; // date → dailyPnl

  let totalBarsProcessed = 0;
  const startMs = Date.now();

  for (const symbol of symbols) {
    const pointVal  = POINT_VALUE[symbol] ?? 2;
    const numContracts = contracts[symbol] ?? 1;
    const days = getTradingDays(symbol, startDate, endDate);

    console.log(`[BT] ${symbol}: ${days.length} trading days`);

    // Load ALL 1m bars for the range into a flat array for forward-look resolution
    // We keep day boundaries to avoid look-ahead across days... but for outcome resolution
    // we need to see next-day bars (a setup can resolve on the following session).
    // We load up to 3 days of future bars for resolution.
    const dayBarsCache = {};
    for (const d of days) {
      dayBarsCache[d] = loadDailyBars(symbol, d);
    }

    for (let di = 0; di < days.length; di++) {
      const date = days[di];
      const bars1m = dayBarsCache[date];
      if (!bars1m || bars1m.length === 0) continue;

      // HP snapshot for this date (null if unavailable or useHP=false)
      const hp = useHP ? loadHPSnapshot(symbol, date) : null;

      // Build future bars pool: remainder of day + next day + day after
      const futureDayBars = [];
      for (let fdi = di; fdi < Math.min(di + 3, days.length); fdi++) {
        futureDayBars.push(...(dayBarsCache[days[fdi]] || []));
      }

      // Track which setup IDs we've already seen to avoid duplicate alerts
      const seenSetupKeys = new Set();

      // Bar-by-bar replay — CRITICAL: only bars[0..i] visible
      for (let i = 0; i < bars1m.length; i++) {
        const visibleBars = bars1m.slice(0, i + 1);
        totalBarsProcessed++;

        // Only run analysis every N bars for performance (every 5 bars for 1m)
        // Full indicators every 5 bars; we won't miss setups because we catch them
        // on the next 5-bar window still within the same candle close.
        if (i % 5 !== 0 && i !== bars1m.length - 1) continue;

        let indicators;
        try {
          indicators = computeIndicators(visibleBars, {
            symbol,
            swingLookback: 10,
            impulseThreshold: 1.5,
          });
        } catch { continue; }

        let regime;
        try {
          regime = classifyRegime(indicators);
        } catch { continue; }

        // Build market context (HP-only in backtest, no live VIX/DXY)
        const currentPrice = visibleBars[visibleBars.length - 1]?.close ?? 0;
        const indForHP = { ...indicators, close: currentPrice };
        const mktCtx = useHP && hp ? buildMarketContextFromHP(hp, indForHP) : null;

        let setups;
        try {
          setups = detectSetups(visibleBars, indicators, regime, {
            marketContext: mktCtx,
          });
        } catch { continue; }

        if (!setups || setups.length === 0) continue;

        for (const setup of setups) {
          if (setup.confidence < minConfidence) continue;
          if (!setupTypes.includes(setup.type)) continue;

          // Only process setups triggered by the bar that just closed (no stale entries).
          if (setup.time !== bars1m[i].ts) continue;

          const setupKey = setup.type === 'or_breakout'
            ? `${symbol}-${date}-or_breakout-${setup.direction}`
            : `${symbol}-${setup.time}-${setup.type}-${setup.direction}`;
          if (seenSetupKeys.has(setupKey)) continue;
          seenSetupKeys.add(setupKey);

          // The setup is detected at bar i — entry is at next bar's open
          // Futures bars remaining from i+1 forward (same day + next days)
          const barsSinceCurrent = futureDayBars.findIndex(b => b.ts > bars1m[i].ts);
          const futBars = barsSinceCurrent >= 0 ? futureDayBars.slice(barsSinceCurrent) : [];

          const resolution = resolveOutcome(setup, futBars, maxHoldBars, pointVal, numContracts);
          const grossPnl = resolution.pnl ?? 0;
          const netPnl   = grossPnl - feePerRT;

          // Hour in ET for time-of-day breakdown
          const barTs = bars1m[i].ts;
          const etHour = new Date((barTs - 5 * 3600) * 1000).getUTCHours(); // approx EST

          // HP proximity classification
          let hpProximity = 'none';
          if (mktCtx?.hp?.nearestDistAtr != null) {
            const d = mktCtx.hp.nearestDistAtr;
            if (d < 0.3) hpProximity = 'at_level';
            else if (d < 1.0) hpProximity = 'near_level';
          }

          const trade = {
            id:             `${symbol}-${date}-${i}-${setup.type}`,
            symbol,
            date,
            timeframe:      '1m_derived', // actual TF would come from multi-TF scan
            setupType:      setup.type,
            direction:      setup.direction,
            entryTs:        bars1m[i].ts,
            entry:          setup.entry,
            sl:             setup.sl,
            tp:             setup.tp,
            confidence:     setup.confidence,
            scoreBreakdown: setup.scoreBreakdown,
            outcome:        resolution.outcome,
            exitTs:         resolution.exitTs,
            exitPrice:      resolution.exitPrice,
            barsToOutcome:  resolution.barsToOutcome,
            grossPnl:       +grossPnl.toFixed(2),
            fee:            feePerRT,
            netPnl:         +netPnl.toFixed(2),
            hour:           etHour,
            hpProximity,
            resilienceLabel: mktCtx?.hp?.resilienceLabel ?? null,
            dexBias:        mktCtx?.hp?.dexBias ?? null,
          };

          alerts.push(trade);
          trades.push(trade);

          // Equity tracking
          if (!equityMap[date]) equityMap[date] = 0;
          equityMap[date] += netPnl;
        }
      }
    }
  }

  // Build equity curve (cumulative)
  const equity = [];
  let cumPnl = 0;
  for (const date of Object.keys(equityMap).sort()) {
    cumPnl += equityMap[date];
    equity.push({ date, pnl: +equityMap[date].toFixed(2), cumPnl: +cumPnl.toFixed(2) });
  }

  const stats = computeStats(trades, equity);

  console.log(`[BT] Complete: ${trades.length} trades, WR=${(stats.winRate * 100).toFixed(1)}%, PF=${stats.profitFactor}, NetPnL=$${stats.grossPnl}`);

  return {
    config,
    alerts,
    trades,
    equity,
    stats,
    meta: {
      totalBarsProcessed,
      durationMs: Date.now() - startMs,
      completedAt: new Date().toISOString(),
    },
  };
}

// ─── Multi-timeframe backtest wrapper ─────────────────────────────────────────

/**
 * runBacktestMTF — runs the scan-based backtest using 5m/15m/30m bars
 * (same approach as the live server's runScan).
 * This is the primary backtest mode — it uses the pre-derived timeframe files.
 */
async function runBacktestMTF(config) {
  const {
    symbols      = ['MNQ'],
    timeframes   = ['5m', '15m'],
    startDate,
    endDate,
    minConfidence = 65,
    setupTypes    = ['zone_rejection', 'pdh_breakout', 'trendline_break', 'or_breakout'],
    contracts     = { MNQ: 1, MES: 1, MGC: 1, MCL: 1 },
    useHP         = true,
    maxHoldBars   = DEFAULT_MAX_BARS,
    feePerRT      = 4,
    excludeHours  = [],   // ET hours (0-23) to skip — empty = trade all hours
    spanMargin    = {},   // CME SPAN margins — { MNQ:1320, MES:660, ... }
  } = config;

  const alerts = [];
  const trades = [];
  const equityMap = {};

  let totalBarsProcessed = 0;
  const startMs = Date.now();

  // Per-symbol: track exit timestamp of last trade (1-trade-at-a-time across all TFs)
  const lastExitTs = {};
  for (const sym of symbols) lastExitTs[sym] = 0;

  for (const symbol of symbols) {
    const pointVal     = POINT_VALUE[symbol] ?? 2;
    const numContracts = contracts[symbol] ?? 1;
    const days = getTradingDays(symbol, startDate, endDate);

    console.log(`[BT-MTF] ${symbol}: ${days.length} days × ${timeframes.join('/')} TFs`);

    for (const tf of timeframes) {
      const tfDir = path.join(DATA_DIR, 'futures', symbol, tf);
      if (!fs.existsSync(tfDir)) {
        console.log(`  [SKIP] No ${tf} data for ${symbol}`);
        continue;
      }

      for (let di = 0; di < days.length; di++) {
        const date = days[di];
        const todayBars = loadDailyBars(symbol, date, tf);
        if (!todayBars || todayBars.length < 20) continue;

        const hp = useHP ? loadHPSnapshot(symbol, date) : null;

        // Build context: last 2 prior days (needed for PDH/PDL, EMA warmup, VWAP)
        const contextBars = [];
        for (let ci = Math.max(0, di - 2); ci < di; ci++) {
          const cb = loadDailyBars(symbol, days[ci], tf);
          contextBars.push(...cb);
        }

        // Load 1m bars for forward outcome resolution
        const fut1mBars = [];
        for (let fdi = di; fdi < Math.min(di + 3, days.length); fdi++) {
          const b = loadDailyBars(symbol, days[fdi], '1m');
          if (b) fut1mBars.push(...b);
        }

        // Force-close timestamp: last 1m bar at or before 16:45 ET on this date
        const today1mBars = loadDailyBars(symbol, date, '1m');
        const forceCloseTs = _forceCloseTs(date, today1mBars);

        const seenSetupKeys = new Set();

        // Duration of one bar in seconds (bar ts = bar open; bar closes at ts + barDur)
        const barDur = TF_SECONDS[tf] ?? 60;

        // Replay TF bars bar-by-bar
        for (let i = 20; i < todayBars.length; i++) {
          const detectTs  = todayBars[i].ts;
          // Bar closes barDur seconds after its open — this is when the signal becomes actionable
          const barCloseTs = detectTs + barDur;

          // Skip if bar close falls in RTH close window (16:45–18:05 ET) — no new entries
          if (_inCloseWindow(barCloseTs)) continue;

          // CRITICAL: context bars + today[0..i] — never see future bars
          const visibleBars = [...contextBars, ...todayBars.slice(0, i + 1)];
          totalBarsProcessed++;

          let indicators;
          try {
            indicators = computeIndicators(visibleBars, { symbol, swingLookback: 10, impulseThreshold: 1.5 });
          } catch { continue; }

          let regime;
          try { regime = classifyRegime(indicators); } catch { continue; }

          const currentPrice = visibleBars[visibleBars.length - 1]?.close ?? 0;
          const mktCtx = useHP && hp ? buildMarketContextFromHP(hp, { ...indicators, close: currentPrice }) : null;

          // Compute DD Bands from visible bars (no lookahead — same slice seen by indicators)
          const ddBandsHist = computeDDBands(visibleBars, symbol, spanMargin);

          let setups;
          try {
            setups = detectSetups(visibleBars, indicators, regime, { marketContext: mktCtx, ddBands: ddBandsHist });
          } catch { continue; }
          if (!setups?.length) continue;

          for (const setup of setups) {
            if (setup.confidence < minConfidence) continue;
            if (!setupTypes.includes(setup.type)) continue;

            // CRITICAL: Only process setups triggered by the bar that just closed.
            // setup.time is the triggering candle's timestamp. If it's an older bar,
            // the entry price (setup.entry = c.close) is stale — price has already moved.
            // Rejecting old setups ensures entry price always equals the current bar close.
            if (setup.time !== detectTs) continue;

            // OR breakout: dedup per-session per-direction (fire once on first break).
            // Zone/PDH/trendline: dedup per triggering candle.
            const setupKey = setup.type === 'or_breakout'
              ? `${symbol}-${date}-or_breakout-${setup.direction}`
              : `${symbol}-${tf}-${setup.time}-${setup.type}-${setup.direction}`;
            if (seenSetupKeys.has(setupKey)) continue;
            seenSetupKeys.add(setupKey);

            // Hour filter: skip if this ET hour is excluded by the user
            const { hour: etHourCheck } = _etHourMin(barCloseTs);
            if (excludeHours.length > 0 && excludeHours.includes(etHourCheck)) continue;

            // 1-trade-at-a-time: skip if a previous trade hasn't exited yet
            // Use barCloseTs — that's when we'd actually enter
            if (barCloseTs <= lastExitTs[symbol]) continue;

            // Resolve outcome: walk 1m bars from bar CLOSE onward (no lookahead)
            const futBarsFrom = fut1mBars.filter(b => b.ts >= barCloseTs);
            const resolution = resolveOutcome(setup, futBarsFrom, maxHoldBars, pointVal, numContracts, forceCloseTs);

            // Record exit time for 1-trade-at-a-time enforcement
            if (resolution.exitTs) lastExitTs[symbol] = resolution.exitTs;

            const grossPnl = resolution.pnl ?? 0;
            const netPnl   = grossPnl - feePerRT;
            const etHour   = etHourCheck;

            let hpProximity = 'none';
            if (mktCtx?.hp?.nearestDistAtr != null) {
              const d = mktCtx.hp.nearestDistAtr;
              if (d < 0.3) hpProximity = 'at_level';
              else if (d < 1.0) hpProximity = 'near_level';
            }

            const trade = {
              id:             `${symbol}-${date}-${tf}-${i}-${setup.type}`,
              symbol, date,
              timeframe:      tf,
              setupType:      setup.type,
              direction:      setup.direction,
              entryTs:        barCloseTs,  // bar close = when signal is actionable
              entry:          setup.entry,
              sl:             setup.sl,
              tp:             setup.tp,
              confidence:     setup.confidence,
              scoreBreakdown: setup.scoreBreakdown,
              outcome:        resolution.outcome,
              exitTs:         resolution.exitTs,
              exitPrice:      resolution.exitPrice,
              barsToOutcome:  resolution.barsToOutcome,
              grossPnl:       +grossPnl.toFixed(2),
              fee:            feePerRT,
              netPnl:         +netPnl.toFixed(2),
              hour:           etHour,
              hpProximity,
              resilienceLabel: mktCtx?.hp?.resilienceLabel ?? null,
              dexBias:        mktCtx?.hp?.dexBias ?? null,
              ddBandLabel:    setup.ddBandLabel || 'no_data',
              ddBandScore:    setup.scoreBreakdown?.ddBand || 0,
            };

            alerts.push(trade);
            trades.push(trade);

            if (!equityMap[date]) equityMap[date] = 0;
            equityMap[date] += netPnl;
          }
        }
      }
    }
  }

  const equity = [];
  let cumPnl = 0;
  for (const date of Object.keys(equityMap).sort()) {
    cumPnl += equityMap[date];
    equity.push({ date, pnl: +equityMap[date].toFixed(2), cumPnl: +cumPnl.toFixed(2) });
  }

  const stats = computeStats(trades, equity);

  console.log(`[BT-MTF] Complete: ${trades.length} trades, WR=${(stats.winRate * 100).toFixed(1)}%, PF=${stats.profitFactor}, Net=$${stats.grossPnl}`);

  return {
    config,
    alerts,
    trades,
    equity,
    stats,
    meta: {
      totalBarsProcessed,
      durationMs: Date.now() - startMs,
      completedAt: new Date().toISOString(),
    },
  };
}

// ─── Job Management ───────────────────────────────────────────────────────────

function createJob(config) {
  const jobId = crypto.randomBytes(6).toString('hex');
  _jobs.set(jobId, {
    status:      'queued',
    progress:    0,
    config,
    startedAt:   null,
    completedAt: null,
    error:       null,
  });
  return jobId;
}

function getJob(jobId) {
  // Check in-memory first
  if (_jobs.has(jobId)) return _jobs.get(jobId);
  // Fall back to saved file
  const f = path.join(RESULTS_DIR, `${jobId}.json`);
  if (fs.existsSync(f)) {
    return { status: 'completed', fromFile: true };
  }
  return null;
}

function getJobResults(jobId) {
  const f = path.join(RESULTS_DIR, `${jobId}.json`);
  return readJSON(f);
}

function listJobs() {
  const jobs = [];
  // In-memory jobs (running / recently queued)
  for (const [id, job] of _jobs.entries()) {
    jobs.push({ jobId: id, status: job.status, config: job.config,
      startedAt: job.startedAt, completedAt: job.completedAt, stats: job.stats });
  }
  // Saved result files
  if (fs.existsSync(RESULTS_DIR)) {
    for (const f of fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'))) {
      const jobId = f.replace('.json', '');
      if (!_jobs.has(jobId)) {
        const data = readJSON(path.join(RESULTS_DIR, f));
        if (data) {
          jobs.push({ jobId, status: 'completed', config: data.config,
            startedAt: null, completedAt: data.meta?.completedAt,
            stats: data.stats });
        }
      }
    }
  }
  return jobs;
}

function deleteJob(jobId) {
  _jobs.delete(jobId);
  const f = path.join(RESULTS_DIR, `${jobId}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

/** Launch a backtest asynchronously. Returns jobId immediately. */
function launchBacktest(config) {
  const jobId = createJob(config);
  const job = _jobs.get(jobId);
  job.status    = 'running';
  job.startedAt = new Date().toISOString();

  // Run async without blocking
  const useMTF = (config.timeframes || []).some(tf => ['5m', '15m', '30m', '1h'].includes(tf));
  const runner = useMTF ? runBacktestMTF : runBacktest;

  runner(config).then(results => {
    job.status      = 'completed';
    job.completedAt = new Date().toISOString();
    job.progress    = 100;
    job.stats       = results.stats;  // cache for listJobs

    // Save results (immutable)
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const f = path.join(RESULTS_DIR, `${jobId}.json`);
    writeJSON(f, { jobId, ...results });
    console.log(`[BT] Job ${jobId} saved → ${f}`);
  }).catch(err => {
    job.status = 'error';
    job.error  = err.message;
    console.error(`[BT] Job ${jobId} failed: ${err.message}`);
  });

  return jobId;
}

// ─── Replay data loader ───────────────────────────────────────────────────────

function getReplayData(jobId, symbol, date) {
  const results = getJobResults(jobId);
  if (!results) return null;

  const bars1m = loadDailyBars(symbol, date);
  const hp     = loadHPSnapshot(symbol, date);
  const alerts = (results.trades || []).filter(t => t.symbol === symbol && t.date === date);

  return { bars1m, hp, alerts };
}

/** Return all 1m bars + all alerts for a symbol across the entire job run. */
function getFullRunReplayData(jobId, symbol) {
  const results = getJobResults(jobId);
  if (!results) return null;

  // Unique sorted dates that have 1m data for this symbol
  const allDates = getTradingDays(symbol,
    results.config?.startDate || '2000-01-01',
    results.config?.endDate   || '2099-12-31');

  if (allDates.length === 0) return null;

  const bars1m = [];
  for (const date of allDates) {
    const dayBars = loadDailyBars(symbol, date, '1m');
    if (dayBars?.length) bars1m.push(...dayBars);
  }

  const alerts = (results.trades || [])
    .filter(t => t.symbol === symbol)
    .sort((a, b) => (a.entryTs ?? 0) - (b.entryTs ?? 0));

  return { bars1m, alerts, dates: allDates };
}

// ─── Available date ranges ────────────────────────────────────────────────────

function getAvailableDateRange() {
  const ranges = {};
  for (const sym of Object.keys(POINT_VALUE)) {
    const dir = path.join(DATA_DIR, 'futures', sym, '1m');
    if (!fs.existsSync(dir)) continue;
    const dates = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
    if (dates.length > 0) {
      ranges[sym] = { firstDate: dates[0], lastDate: dates[dates.length - 1], tradingDays: dates.length };
    }
  }
  return ranges;
}

module.exports = {
  runBacktest,
  runBacktestMTF,
  launchBacktest,
  getJob,
  getJobResults,
  listJobs,
  deleteJob,
  getReplayData,
  getFullRunReplayData,
  getAvailableDateRange,
  buildMarketContextFromHP,
};
