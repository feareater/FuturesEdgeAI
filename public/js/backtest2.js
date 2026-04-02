'use strict';
/**
 * backtest2.js — FuturesEdge AI Backtesting UI
 *
 * Handles:
 *   - Config panel (form state, save/load from localStorage)
 *   - Job management (run, poll, list previous)
 *   - Summary tab (stat cards + equity curve + breakdowns)
 *   - Trades tab (sortable/filterable table, CSV export, click-to-replay)
 *   - Replay tab (animated chart replay with TradingView Lightweight Charts)
 */

// ─── State ────────────────────────────────────────────────────────────────────

let _currentResults = null;    // latest loaded backtest results
let _currentJobId   = null;
let _pollTimer      = null;
let _equityChart    = null;
let _equitySeries   = null;
let _trades         = [];      // current filtered trade list
let _sortKey        = 'date';
let _sortAsc        = true;

// Replay state
let _replayBars     = [];
let _replayAlerts   = [];
let _replayHP       = null;
let _replayCursor   = 0;
let _replayPlaying  = false;
let _replayTimer    = null;
let _replayChart    = null;
let _replaySeries   = null;
let _replayEntryLines = [];
let _replayPnl      = 0;
let _replayJobId    = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initHoursGrid();
  bindEvents();
  loadPreviousJobs();
  await loadAvailableDates();   // sets date defaults first
  loadSavedConfig();            // then restores other prefs (NOT dates)
});

// ─── Available date ranges ────────────────────────────────────────────────────

async function loadAvailableDates() {
  try {
    const data = await apiFetch('/api/backtest/available');
    const hint = document.getElementById('bt2-date-hint');
    if (data && typeof data === 'object') {
      const entries = Object.entries(data);
      if (entries.length > 0) {
        const first = entries[0][1];
        hint.textContent = `Data available: ${first.firstDate} → ${first.lastDate} (${first.tradingDays} days)`;
        // Always set defaults — loadSavedConfig runs after and won't touch dates
        document.getElementById('bt2-start').value = first.firstDate || '';
        document.getElementById('bt2-end').value   = first.lastDate  || '';
      }
    }
  } catch {}
}

// ─── Event binding ────────────────────────────────────────────────────────────

function bindEvents() {
  // Confidence slider
  const confSlider = document.getElementById('bt2-conf');
  confSlider.addEventListener('input', () => {
    document.getElementById('bt2-conf-label').textContent = confSlider.value;
  });

  // Tabs
  document.querySelectorAll('.bt2-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bt2-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.bt2-tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`bt2-tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'replay' && _replayBars.length === 0 && _currentResults) {
        initReplayFromResults(_currentResults);
      }
      if (btn.dataset.tab === 'compare') {
        initCompareTab();
      }
      if (btn.dataset.tab === 'optimize') {
        initOptimizeTab();
      }
    });
  });

  // Run
  document.getElementById('bt2-run-btn').addEventListener('click', runBacktest);

  // Save config
  document.getElementById('bt2-save-btn').addEventListener('click', saveConfig);

  // Trade table filters
  ['bt2-filter-outcome','bt2-filter-sym','bt2-filter-setup'].forEach(id => {
    document.getElementById(id).addEventListener('change', applyTradeFilters);
  });

  // Trade table sort
  document.querySelectorAll('#bt2-trades-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_sortKey === key) _sortAsc = !_sortAsc;
      else { _sortKey = key; _sortAsc = true; }
      renderTradesTable();
    });
  });

  // CSV export
  document.getElementById('bt2-export-csv').addEventListener('click', exportCSV);

  // Replay controls
  document.getElementById('bt2-ctrl-reset').addEventListener('click', () => replaySeek(0));
  document.getElementById('bt2-ctrl-back').addEventListener('click',  () => replayStep(-1));
  document.getElementById('bt2-ctrl-play').addEventListener('click',  toggleReplayPlay);
  document.getElementById('bt2-ctrl-fwd').addEventListener('click',   () => replayStep(1));
  document.getElementById('bt2-ctrl-next').addEventListener('click',  replaySkipToNextAlert);
  document.getElementById('bt2-replay-load').addEventListener('click', loadReplaySession);
  document.getElementById('bt2-replay-fullrun').addEventListener('click', loadFullRunReplay);
  document.getElementById('bt2-cmp-add').addEventListener('click', addCompareSlot);
  document.getElementById('bt2-cmp-export').addEventListener('click', exportCompareCSV);
}

// ─── Trading hours grid ───────────────────────────────────────────────────────

// Hours 0-23 ET split into sessions
const HOURS_OVERNIGHT    = [18,19,20,21,22,23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const HOURS_RTH          = [9,10,11,12,13,14,15,16];
const HOURS_AFTERHOURS   = [16,17];
// Canonical order for all 24 hours
const ALL_HOURS = Array.from({length:24}, (_,i) => i);

function _hourLabel(h) {
  const ampm = h < 12 ? 'am' : 'pm';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${ampm}`;
}

function initHoursGrid() {
  const sessions = [
    { id: 'bt2-hours-overnight',   hours: [18,19,20,21,22,23,0,1,2,3,4,5,6,7,8] },
    { id: 'bt2-hours-rth',         hours: [9,10,11,12,13,14,15,16] },
    { id: 'bt2-hours-afterhours',  hours: [17] },
  ];
  for (const { id, hours } of sessions) {
    const wrap = document.getElementById(id);
    if (!wrap) continue;
    hours.forEach(h => {
      const lbl = document.createElement('label');
      lbl.className = 'bt2-hour-cell';
      lbl.innerHTML = `<input type="checkbox" class="bt2-hour-cb" data-hour="${h}" checked />${_hourLabel(h)}`;
      wrap.appendChild(lbl);
    });
  }

  // Preset buttons
  document.querySelectorAll('.bt2-hours-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      document.querySelectorAll('.bt2-hour-cb').forEach(cb => {
        const h = +cb.dataset.hour;
        if (preset === 'all')  cb.checked = true;
        else if (preset === 'none') cb.checked = false;
        else if (preset === 'rth')  cb.checked = (h >= 9 && h <= 16);
      });
    });
  });
}

function getExcludeHours() {
  const excluded = [];
  document.querySelectorAll('.bt2-hour-cb').forEach(cb => {
    if (!cb.checked) excluded.push(+cb.dataset.hour);
  });
  return excluded;
}

function setExcludeHours(excludeHours) {
  document.querySelectorAll('.bt2-hour-cb').forEach(cb => {
    cb.checked = !excludeHours.includes(+cb.dataset.hour);
  });
}

// ─── Config save/load ─────────────────────────────────────────────────────────

function getConfig() {
  const symbols    = [...document.querySelectorAll('input[name="sym"]:checked')].map(i => i.value);
  const timeframes = [...document.querySelectorAll('input[name="tf"]:checked')].map(i => i.value);
  const setupTypes = [...document.querySelectorAll('input[name="st"]:checked')].map(i => i.value);
  const contracts  = {};
  document.querySelectorAll('.bt2-contracts').forEach(el => { contracts[el.dataset.sym] = +el.value || 1; });

  return {
    startDate:      document.getElementById('bt2-start').value,
    endDate:        document.getElementById('bt2-end').value,
    symbols,
    timeframes,
    setupTypes,
    minConfidence:  +document.getElementById('bt2-conf').value,
    useHP:          document.getElementById('bt2-use-hp').checked,
    maxHoldBars:    +document.getElementById('bt2-maxhold').value * 60,
    feePerRT:       +document.getElementById('bt2-fee').value,
    contracts,
    startingBalance: +document.getElementById('bt2-balance').value || 10000,
    excludeHours:   getExcludeHours(),
  };
}

function getStartingBalance() {
  return +document.getElementById('bt2-balance').value || 10000;
}

function saveConfig() {
  const cfg = getConfig();
  // Don't persist dates — they're session choices, not preferences
  delete cfg.startDate;
  delete cfg.endDate;
  localStorage.setItem('bt2_config', JSON.stringify(cfg));
  showToast('Config saved');
}

function loadSavedConfig() {
  try {
    const raw = localStorage.getItem('bt2_config');
    if (!raw) return;
    const cfg = JSON.parse(raw);
    // Dates are NOT restored — always use the available-range defaults
    if (cfg.minConfidence) {
      document.getElementById('bt2-conf').value = cfg.minConfidence;
      document.getElementById('bt2-conf-label').textContent = cfg.minConfidence;
    }
    if (cfg.symbols) {
      document.querySelectorAll('input[name="sym"]').forEach(el => {
        el.checked = cfg.symbols.includes(el.value);
      });
    }
    if (cfg.timeframes) {
      document.querySelectorAll('input[name="tf"]').forEach(el => {
        el.checked = cfg.timeframes.includes(el.value);
      });
    }
    if (cfg.setupTypes) {
      document.querySelectorAll('input[name="st"]').forEach(el => {
        el.checked = cfg.setupTypes.includes(el.value);
      });
    }
    if (cfg.contracts) {
      document.querySelectorAll('.bt2-contracts').forEach(el => {
        if (cfg.contracts[el.dataset.sym]) el.value = cfg.contracts[el.dataset.sym];
      });
    }
    if (cfg.useHP !== undefined) document.getElementById('bt2-use-hp').checked = cfg.useHP;
    if (cfg.maxHoldBars) document.getElementById('bt2-maxhold').value = Math.round(cfg.maxHoldBars / 60);
    if (cfg.feePerRT !== undefined) document.getElementById('bt2-fee').value = cfg.feePerRT;
    if (cfg.startingBalance) document.getElementById('bt2-balance').value = cfg.startingBalance;
    if (cfg.excludeHours) setExcludeHours(cfg.excludeHours);
  } catch {}
}

// ─── Run backtest ─────────────────────────────────────────────────────────────

async function runBacktest() {
  const config = getConfig();

  if (!config.startDate || !config.endDate) {
    showToast('Select start and end dates', 'error'); return;
  }
  if (config.symbols.length === 0) {
    showToast('Select at least one symbol', 'error'); return;
  }

  const btn = document.getElementById('bt2-run-btn');
  btn.disabled = true;

  showProgress(true, 'Starting...');

  try {
    const { jobId } = await apiFetch('/api/backtest/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    _currentJobId = jobId;
    pollJob(jobId);
  } catch (e) {
    showProgress(false);
    btn.disabled = false;
    showToast('Failed to start: ' + e.message, 'error');
  }
}

async function pollJob(jobId) {
  clearTimeout(_pollTimer);
  try {
    const status = await apiFetch(`/api/backtest/status/${jobId}`);
    showProgress(true, `Running… (${status.status})`);

    if (status.status === 'completed') {
      showProgress(false);
      document.getElementById('bt2-run-btn').disabled = false;
      const results = await apiFetch(`/api/backtest/results/${jobId}`);
      loadResults(results);
      loadPreviousJobs();
    } else if (status.status === 'error') {
      showProgress(false);
      document.getElementById('bt2-run-btn').disabled = false;
      showToast('Backtest error: ' + status.error, 'error');
    } else {
      _pollTimer = setTimeout(() => pollJob(jobId), 2000);
    }
  } catch {
    _pollTimer = setTimeout(() => pollJob(jobId), 3000);
  }
}

function showProgress(show, label) {
  const wrap = document.getElementById('bt2-progress-wrap');
  wrap.style.display = show ? '' : 'none';
  if (label) document.getElementById('bt2-progress-label').textContent = label;
}

// ─── Load results ─────────────────────────────────────────────────────────────

function loadResults(results) {
  _currentResults = results;
  _trades = results.trades || [];

  document.getElementById('bt2-no-results').style.display = 'none';
  document.getElementById('bt2-summary-content').style.display = '';

  const balance = getStartingBalance();
  renderStatCards(results.stats, balance);
  renderEquityChart(results.equity, balance);
  renderDrawdownChart(results.equity, balance);
  renderDailyChart(results.equity, balance);
  renderBreakdowns(results.stats);
  renderTradesTable();
  initReplayFromResults(results);
}

// ─── Stat cards ───────────────────────────────────────────────────────────────

function renderStatCards(stats, startingBalance = 10000) {
  const endingBalance = startingBalance + (stats.grossPnl ?? 0);
  const ddPct = startingBalance > 0 ? (stats.maxDrawdown / startingBalance * 100).toFixed(1) : '—';
  const cards = [
    { label: 'Total Trades',    value: stats.totalTrades },
    { label: 'Win Rate',        value: (stats.winRate * 100).toFixed(1) + '%',
      cls: stats.winRate >= 0.55 ? 'positive' : stats.winRate < 0.4 ? 'negative' : '' },
    { label: 'Profit Factor',   value: stats.profitFactor === Infinity ? '∞' : stats.profitFactor,
      cls: stats.profitFactor >= 1.5 ? 'positive' : stats.profitFactor < 1 ? 'negative' : '' },
    { label: 'Net P&L',         value: (stats.grossPnl >= 0 ? '+' : '') + '$' + fmtNum(stats.grossPnl),
      cls: stats.grossPnl >= 0 ? 'positive' : 'negative' },
    { label: 'Ending Balance',  value: '$' + fmtNum(endingBalance),
      cls: endingBalance >= startingBalance ? 'positive' : 'negative' },
    { label: 'Avg Win',         value: '$' + fmtNum(stats.avgWin), cls: 'positive' },
    { label: 'Avg Loss',        value: '$' + fmtNum(stats.avgLoss), cls: 'negative' },
    { label: 'Max Drawdown',    value: `$${fmtNum(stats.maxDrawdown)} (${ddPct}%)`, cls: 'negative' },
    { label: 'Expectancy',      value: '$' + fmtNum(stats.expectancy),
      cls: stats.expectancy >= 0 ? 'positive' : 'negative' },
    { label: 'Sharpe Ratio',    value: stats.sharpeRatio,
      cls: stats.sharpeRatio >= 1 ? 'positive' : stats.sharpeRatio < 0 ? 'negative' : '' },
  ];

  document.getElementById('bt2-stat-cards').innerHTML = cards.map(c => `
    <div class="bt2-card">
      <div class="bt2-card-label">${c.label}</div>
      <div class="bt2-card-value ${c.cls || ''}">${c.value}</div>
    </div>
  `).join('');
}

// ─── Equity chart ─────────────────────────────────────────────────────────────

function renderEquityChart(equity, startingBalance = 10000) {
  const el = document.getElementById('bt2-equity-chart');
  el.innerHTML = '';

  if (!equity || equity.length === 0) return;

  const chart = LightweightCharts.createChart(el, {
    layout: { background: { color: 'transparent' }, textColor: '#9ca3af' },
    grid:   { vertLines: { color: '#2a2d35' }, horzLines: { color: '#2a2d35' } },
    rightPriceScale: { borderColor: '#2a2d35' },
    timeScale: { borderColor: '#2a2d35', timeVisible: true },
    width:  el.clientWidth || 800,
    height: 200,
    crosshair: { mode: 1 },
  });

  const series = chart.addAreaSeries({
    topColor:    'rgba(99,102,241,0.3)',
    bottomColor: 'rgba(99,102,241,0.0)',
    lineColor:   '#6366f1',
    lineWidth:   2,
    priceFormat: { type: 'custom', formatter: v => '$' + fmtNum(v) },
  });

  const data = equity.map(pt => ({ time: pt.date, value: +(startingBalance + pt.cumPnl).toFixed(2) }));
  series.setData(data);
  chart.timeScale().fitContent();
  _equityChart = chart;
  _equitySeries = series;

  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
}

function renderDrawdownChart(equity, startingBalance = 10000) {
  const el = document.getElementById('bt2-drawdown-chart');
  if (!el) return;
  el.innerHTML = '';
  if (!equity || equity.length === 0) return;

  // Compute drawdown from peak balance
  let peak = startingBalance;
  const data = equity.map(pt => {
    const bal = startingBalance + pt.cumPnl;
    peak = Math.max(peak, bal);
    return { time: pt.date, value: +(bal - peak).toFixed(2) };
  });

  const chart = LightweightCharts.createChart(el, {
    layout: { background: { color: 'transparent' }, textColor: '#9ca3af' },
    grid:   { vertLines: { color: '#2a2d35' }, horzLines: { color: '#2a2d35' } },
    rightPriceScale: { borderColor: '#2a2d35' },
    timeScale: { borderColor: '#2a2d35', timeVisible: true },
    width:  el.clientWidth || 800,
    height: 100,
    crosshair: { mode: 1 },
  });

  const series = chart.addAreaSeries({
    topColor:    'rgba(239,68,68,0.15)',
    bottomColor: 'rgba(239,68,68,0.0)',
    lineColor:   '#ef4444',
    lineWidth:   1,
    priceFormat: { type: 'custom', formatter: v => '$' + fmtNum(v) },
  });

  series.setData(data);
  chart.timeScale().fitContent();
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);
}

// ─── Daily P&L chart ──────────────────────────────────────────────────────────

function renderDailyChart(equity, startingBalance = 10000) {
  const el = document.getElementById('bt2-daily-chart');
  if (!el || !equity?.length) return;

  const maxAbs = Math.max(1, ...equity.map(pt => Math.abs(pt.pnl)));

  const bars = equity.map((pt, i) => {
    const isPos = pt.pnl >= 0;
    const pct   = Math.abs(pt.pnl) / maxAbs * 100;
    const bal   = startingBalance + pt.cumPnl;
    const label = pt.date.substring(5); // MM-DD
    const title = `${pt.date}: ${pt.pnl >= 0 ? '+' : ''}$${fmtNum(pt.pnl)} | Balance: $${fmtNum(bal)}`;

    const barStyle = isPos
      ? `height:${pct.toFixed(1)}%;align-self:flex-end;margin-top:auto;`
      : `height:${pct.toFixed(1)}%;align-self:flex-start;margin-bottom:auto;`;

    return `<div class="bt2-daily-bar-wrap" title="${title}">
      <div class="bt2-daily-bar ${isPos ? 'pos' : 'neg'}" style="${barStyle}"></div>
      <span class="bt2-daily-label">${label}</span>
    </div>`;
  }).join('');

  const firstBal = startingBalance;
  const lastBal  = startingBalance + equity[equity.length - 1].cumPnl;
  const totalPnl = equity[equity.length - 1].cumPnl;

  el.innerHTML = `
    <div class="bt2-daily-bars">${bars}</div>
    <div class="bt2-daily-balance">
      <span>Start: $${fmtNum(firstBal)}</span>
      <span>Total P&L: <strong class="${totalPnl >= 0 ? 'positive' : 'negative'}">${totalPnl >= 0 ? '+' : ''}$${fmtNum(totalPnl)}</strong></span>
      <span>End: $${fmtNum(lastBal)}</span>
    </div>`;
}

// ─── Breakdown charts ─────────────────────────────────────────────────────────

function renderBreakdowns(stats) {
  const breakdowns = [
    { title: 'By Setup Type',     data: stats.bySetupType,     fmt: k => k.replace('_', ' ') },
    { title: 'By Symbol',         data: stats.bySymbol },
    { title: 'By Timeframe',      data: stats.byTimeframe },
    { title: 'By Hour (ET)',      data: stats.byHour,          fmt: k => k + ':00' },
    { title: 'By Confidence',     data: stats.byConfBucket },
    { title: 'By HP Proximity',   data: stats.byHPProximity,   fmt: k => k.replace('_', ' ') },
    { title: 'By Resilience',     data: stats.byResilienceLabel },
  ];

  const grid = document.getElementById('bt2-breakdown-grid');
  grid.innerHTML = breakdowns.map(bd => {
    if (!bd.data) return '';
    const entries = Object.entries(bd.data).sort((a, b) => b[1].trades - a[1].trades);
    const maxTrades = Math.max(1, ...entries.map(e => e[1].trades));
    const rows = entries.map(([k, v]) => {
      const pct = (v.trades / maxTrades * 100).toFixed(0);
      const wr  = (v.winRate * 100).toFixed(0);
      const label = bd.fmt ? bd.fmt(k) : k;
      const pnlCls = v.pnl >= 0 ? 'positive' : 'negative';
      return `
        <div class="bt2-bar-row" title="WR: ${wr}% | Trades: ${v.trades} | P&L: $${fmtNum(v.pnl)}">
          <span class="bt2-bar-key">${label}</span>
          <div class="bt2-bar-track"><div class="bt2-bar-fill ${pnlCls}" style="width:${pct}%"></div></div>
          <span class="bt2-bar-val ${pnlCls}">${wr}%</span>
        </div>`;
    }).join('');
    return `
      <div class="bt2-breakdown-card">
        <div class="bt2-breakdown-title">${bd.title}</div>
        ${rows}
      </div>`;
  }).join('');
}

// ─── Trades table ─────────────────────────────────────────────────────────────

function applyTradeFilters() {
  const outcome = document.getElementById('bt2-filter-outcome').value;
  const sym     = document.getElementById('bt2-filter-sym').value;
  const setup   = document.getElementById('bt2-filter-setup').value;

  _trades = (_currentResults?.trades || []).filter(t => {
    if (outcome && t.outcome !== outcome) return false;
    if (sym     && t.symbol    !== sym)   return false;
    if (setup   && t.setupType !== setup) return false;
    return true;
  });
  renderTradesTable();
}

function renderTradesTable() {
  const sorted = [..._trades].sort((a, b) => {
    let av = a[_sortKey], bv = b[_sortKey];
    if (typeof av === 'string') av = av.toLowerCase(), bv = bv?.toLowerCase() ?? '';
    return _sortAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });

  const tbody = document.getElementById('bt2-trades-tbody');
  tbody.innerHTML = sorted.map(t => {
    const isBull = t.direction === 'bullish';
    const dirCls = isBull ? 'bt2-dir-bull' : 'bt2-dir-bear';
    const pnlCls = t.netPnl >= 0 ? 'bt2-pnl-pos' : 'bt2-pnl-neg';
    const hpLabel = t.hpProximity === 'at_level' ? 'At' : t.hpProximity === 'near_level' ? 'Near' : '—';
    const ts = t.entryTs ? new Date(t.entryTs * 1000).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—';

    return `<tr class="bt2-${t.outcome}" data-id="${t.id}">
      <td>${t.date} ${ts}</td>
      <td>${t.symbol}</td>
      <td>${t.timeframe}</td>
      <td>${(t.setupType||'').replace('_',' ')}</td>
      <td class="${dirCls}">${isBull ? '▲' : '▼'}</td>
      <td>${fmtPrice(t.entry)}</td>
      <td>${fmtPrice(t.sl)}</td>
      <td>${fmtPrice(t.tp)}</td>
      <td>${fmtPrice(t.exitPrice)}</td>
      <td>${t.barsToOutcome ?? '—'}</td>
      <td><span class="bt2-outcome-badge ${t.outcome}">${t.outcome}</span></td>
      <td class="${pnlCls}">${t.netPnl >= 0 ? '+' : ''}$${fmtNum(t.netPnl)}</td>
      <td>${t.confidence ?? '—'}%</td>
      <td>${hpLabel}</td>
      <td>${t.dexBias ?? '—'}</td>
    </tr>`;
  }).join('');

  // Click row → switch to replay with that trade's date/symbol
  tbody.querySelectorAll('tr').forEach((row, i) => {
    row.addEventListener('click', () => {
      const trade = sorted[i];
      if (!trade) return;
      // Switch to replay tab
      document.querySelectorAll('.bt2-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.bt2-tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelector('.bt2-tab[data-tab="replay"]').classList.add('active');
      document.getElementById('bt2-tab-replay').classList.add('active');
      // Set replay selectors
      document.getElementById('bt2-replay-sym').value  = trade.symbol;
      document.getElementById('bt2-replay-date').value = trade.date;
      loadReplaySession();
    });
  });
}

function exportCSV() {
  if (!_trades.length) return;
  const headers = 'Date,Symbol,TF,Setup,Dir,Entry,SL,TP,Exit,Bars,Outcome,GrossPnl,Fee,NetPnl,Conf,HP,DEX';
  const rows = _trades.map(t => [
    t.date, t.symbol, t.timeframe, t.setupType, t.direction,
    t.entry, t.sl, t.tp, t.exitPrice, t.barsToOutcome,
    t.outcome, t.grossPnl, t.fee, t.netPnl, t.confidence,
    t.hpProximity, t.dexBias,
  ].join(','));
  const csv = [headers, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `backtest_${new Date().toISOString().substring(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ─── Previous jobs ────────────────────────────────────────────────────────────

async function loadPreviousJobs() {
  try {
    const jobs = await apiFetch('/api/backtest/jobs');
    const list = document.getElementById('bt2-jobs-list');
    if (!jobs || jobs.length === 0) { list.innerHTML = '<div style="color:#6b7280;font-size:11px">No runs yet</div>'; return; }

    const sorted = [...jobs].sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
    list.innerHTML = sorted.slice(0, 10).map(j => {
      const c = j.config || {};
      const s = j.stats  || {};

      // Header line
      const syms = (c.symbols || ['?']).join(', ');
      const dateRange = c.startDate && c.endDate
        ? `${c.startDate.substring(5)} → ${c.endDate.substring(5)}`
        : j.jobId.substring(0, 8);

      // Stats line
      let statsLine = '';
      if (s.totalTrades != null) {
        const pnl = s.grossPnl ?? 0;
        const pnlCls = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
        const pnlStr = `${pnl >= 0 ? '+' : ''}$${fmtNum(pnl)}`;
        const bal = (c.startingBalance || 10000) + pnl;
        statsLine = `${s.totalTrades} trades · WR:${(s.winRate*100).toFixed(0)}% · PF:${s.profitFactor} · <span class="${pnlCls}">${pnlStr}</span> · Bal:$${fmtNum(bal)}`;
      }

      // Config line
      const tfs     = (c.timeframes || []).join(',');
      const setups  = (c.setupTypes || []).map(t => t.replace('_breakout','').replace('_rejection','rej').replace('trendline_break','tl')).join(',');
      const contr   = c.contracts ? Object.entries(c.contracts).map(([k,v]) => `${k}:${v}`).join(' ') : '';
      const conf    = c.minConfidence ? `≥${c.minConfidence}%` : '';
      const configLine = [tfs, setups, contr, conf].filter(Boolean).join(' · ');

      return `<div class="bt2-job-row${j.jobId===_currentJobId?' selected':''}" data-job="${j.jobId}">
        <div class="bt2-job-row-head">
          <div class="bt2-job-status ${j.status}"></div>
          <span>${syms} &nbsp;${dateRange}</span>
          <button class="bt2-job-del" data-job="${j.jobId}" title="Delete">✕</button>
        </div>
        ${statsLine ? `<div class="bt2-job-meta">${statsLine}</div>` : ''}
        ${configLine ? `<div class="bt2-job-meta">${configLine}</div>` : ''}
      </div>`;
    }).join('');

    list.querySelectorAll('.bt2-job-row').forEach(row => {
      row.addEventListener('click', async e => {
        if (e.target.classList.contains('bt2-job-del')) return;
        const jobId = row.dataset.job;
        _currentJobId = jobId;
        const results = await apiFetch(`/api/backtest/results/${jobId}`);
        if (results) loadResults(results);
      });
    });

    list.querySelectorAll('.bt2-job-del').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const jobId = btn.dataset.job;
        await apiFetch(`/api/backtest/jobs/${jobId}`, { method: 'DELETE' });
        loadPreviousJobs();
      });
    });
  } catch {}
}

// ─── Compare ──────────────────────────────────────────────────────────────────

const CMP_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];
let _cmpJobs     = [];   // [{jobId, label, stats, equity, config}]
let _cmpChart    = null;
let _cmpAllJobs  = [];   // cached job list for selectors

const SETUP_LABELS = {
  zone_rejection: 'Zone Rejection',
  pdh_breakout:   'PDH Breakout',
  trendline_break:'Trendline Break',
  or_breakout:    'OR Breakout',
};

// Static metric rows — section headers use { section } property
const CMP_STATIC_METRICS = [
  // ── Configuration ──────────────────────────────────────────────────────────
  { section: 'Configuration' },
  { key: 'dateRange',    label: 'Date Range',      fmt: (s,cfg) => `${cfg?.startDate||'?'} → ${cfg?.endDate||'?'}` },
  { key: 'symbols',      label: 'Symbols',         fmt: (s,cfg) => (cfg?.symbols||[]).join(', ') },
  { key: 'timeframes',   label: 'Timeframes',      fmt: (s,cfg) => (cfg?.timeframes||[]).join(', ') },
  { key: 'setupTypes',   label: 'Setup Types',     fmt: (s,cfg) => (cfg?.setupTypes||[]).map(t => SETUP_LABELS[t]||t).join(', ') },
  { key: 'minConf',      label: 'Min Confidence',  fmt: (s,cfg) => (cfg?.minConfidence||65)+'%' },
  { key: 'maxHold',      label: 'Max Hold',        fmt: (s,cfg) => Math.round((cfg?.maxHoldBars||480)/60)+'h' },
  { key: 'feePerRT',     label: 'Fee / RT',        fmt: (s,cfg) => '$'+(cfg?.feePerRT??4) },
  { key: 'contracts',    label: 'Contracts',       fmt: (s,cfg) => Object.entries(cfg?.contracts||{}).map(([k,v])=>`${k}:${v}`).join(' ') },
  { key: 'excHours',     label: 'Excl. Hours',     fmt: (s,cfg) => {
    const ex = cfg?.excludeHours||[];
    return ex.length === 0 ? 'None' : ex.map(h => _hourLabel(h)).join(', ');
  }},

  // ── Overall Performance ────────────────────────────────────────────────────
  { section: 'Overall Performance' },
  { key: 'totalTrades',  label: 'Total Trades',    fmt: s => s.totalTrades },
  { key: 'won',          label: 'Won / Lost / TO', fmt: s => `${s.won} / ${s.lost} / ${s.timeout}` },
  { key: 'winRate',      label: 'Win Rate',        fmt: s => (s.winRate*100).toFixed(1)+'%',      best:'high', val: s => s.winRate },
  { key: 'profitFactor', label: 'Profit Factor',   fmt: s => s.profitFactor?.toFixed(2),          best:'high', val: s => s.profitFactor },
  { key: 'grossPnl',     label: 'Gross P&L',       fmt: s => '$'+s.grossPnl?.toFixed(0),          best:'high', val: s => s.grossPnl },
  { key: 'maxDrawdown',  label: 'Max Drawdown',    fmt: s => s.maxDrawdown > 0 ? '-$'+s.maxDrawdown?.toFixed(0) : '$0', best:'low', val: s => s.maxDrawdown },
  { key: 'avgWin',       label: 'Avg Win',         fmt: s => '$'+s.avgWin?.toFixed(0),            best:'high', val: s => s.avgWin },
  { key: 'avgLoss',      label: 'Avg Loss',        fmt: s => '$'+Math.abs(s.avgLoss||0).toFixed(0), best:'low', val: s => Math.abs(s.avgLoss||0) },
  { key: 'avgR',         label: 'Avg R ($)',       fmt: s => '$'+s.avgR?.toFixed(0),              best:'high', val: s => s.avgR },
  { key: 'expectancy',   label: 'Expectancy',      fmt: s => '$'+s.expectancy?.toFixed(0),        best:'high', val: s => s.expectancy },
  { key: 'sharpeRatio',  label: 'Sharpe Ratio',    fmt: s => s.sharpeRatio?.toFixed(2),           best:'high', val: s => s.sharpeRatio },
  { key: 'largestWin',   label: 'Largest Win',     fmt: s => '$'+s.largestWin?.toFixed(0) },
  { key: 'largestLoss',  label: 'Largest Loss',    fmt: s => '$'+Math.abs(s.largestLoss||0).toFixed(0) },
];

async function initCompareTab() {
  try {
    _cmpAllJobs = await apiFetch('/api/backtest/jobs') || [];
  } catch { _cmpAllJobs = []; }
  renderCompareSelectors();
  renderCompareBody();
}

function renderCompareSelectors() {
  const wrap = document.getElementById('bt2-cmp-selectors');
  wrap.innerHTML = '';
  _cmpJobs.forEach((job, idx) => {
    const color = CMP_COLORS[idx % CMP_COLORS.length];
    const div = document.createElement('div');
    div.className = 'bt2-cmp-selector';
    div.innerHTML = `
      <span class="bt2-cmp-dot" style="background:${color}"></span>
      <select class="bt2-cmp-sel" data-idx="${idx}">
        <option value="">— select run —</option>
        ${_cmpAllJobs.map(j => {
          const cfg = j.config || {};
          const label = `${cfg.startDate||'?'} → ${cfg.endDate||'?'} · ${(cfg.symbols||[]).join(',')} · ${(cfg.timeframes||[]).join(',')}`;
          return `<option value="${j.jobId}" ${j.jobId===job.jobId?'selected':''}>${label}</option>`;
        }).join('')}
      </select>
      <button class="bt2-cmp-remove" data-idx="${idx}" title="Remove">✕</button>`;
    wrap.appendChild(div);
  });

  wrap.querySelectorAll('.bt2-cmp-sel').forEach(sel => {
    sel.addEventListener('change', async () => {
      const idx = +sel.dataset.idx;
      const jobId = sel.value;
      if (!jobId) { _cmpJobs[idx] = { jobId: '' }; renderCompareBody(); return; }
      const jobMeta = _cmpAllJobs.find(j => j.jobId === jobId);
      if (!jobMeta) return;
      // Fetch equity curve
      let equity = [];
      try {
        const res = await apiFetch(`/api/backtest/jobs/${jobId}/results`);
        equity = res?.equity || [];
      } catch {}
      _cmpJobs[idx] = { jobId, label: sel.options[sel.selectedIndex].text, stats: jobMeta.stats, config: jobMeta.config, equity };
      renderCompareSelectors();
      renderCompareBody();
    });
  });

  wrap.querySelectorAll('.bt2-cmp-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      _cmpJobs.splice(+btn.dataset.idx, 1);
      renderCompareSelectors();
      renderCompareBody();
    });
  });
}

async function addCompareSlot() {
  if (_cmpJobs.length >= 6) { showToast('Max 6 runs', 'error'); return; }
  _cmpJobs.push({ jobId: '' });
  if (_cmpAllJobs.length === 0) {
    try { _cmpAllJobs = await apiFetch('/api/backtest/jobs') || []; } catch {}
  }
  renderCompareSelectors();
  renderCompareBody();
}

function _cmpRow(metric, cols) {
  const vals = cols.map(c => ({
    raw: metric.val ? metric.val(c.job.stats||{}) : null,
    fmt: metric.fmt(c.job.stats||{}, c.job.config||{}),
  }));
  let bestIdx = -1;
  if (metric.best && vals.every(v => v.raw != null && isFinite(v.raw))) {
    bestIdx = metric.best === 'high'
      ? vals.reduce((bi, v, i) => v.raw > vals[bi].raw ? i : bi, 0)
      : vals.reduce((bi, v, i) => v.raw < vals[bi].raw ? i : bi, 0);
  }
  const cells = vals.map((v, i) =>
    `<td class="${i === bestIdx ? 'bt2-cmp-best' : ''}">${v.fmt ?? '—'}</td>`
  ).join('');
  return `<tr><td class="bt2-cmp-metric">${metric.label}</td>${cells}</tr>`;
}

function _cmpSectionRow(label, colCount) {
  return `<tr class="bt2-cmp-section-row"><td colspan="${colCount + 1}">${label}</td></tr>`;
}

function renderCompareBody() {
  const body = document.getElementById('bt2-cmp-body');
  const active = _cmpJobs.filter(j => j.jobId && j.stats);

  if (active.length < 2) {
    body.innerHTML = '<div class="bt2-placeholder">Add two or more runs to compare.</div>';
    _cmpChart = null;
    return;
  }

  const cols = active.map(j => ({
    job: j,
    color: CMP_COLORS[_cmpJobs.indexOf(j) % CMP_COLORS.length],
    label: `${j.config?.startDate||'?'} → ${j.config?.endDate||'?'}`,
  }));

  // Build static rows
  let tableRows = '';
  for (const metric of CMP_STATIC_METRICS) {
    if (metric.section) {
      tableRows += _cmpSectionRow(metric.section, cols.length);
    } else {
      tableRows += _cmpRow(metric, cols);
    }
  }

  // ── By Setup Type ──────────────────────────────────────────────────────────
  const allSetupKeys = [...new Set(cols.flatMap(c => Object.keys(c.job.stats?.bySetupType||{})))];
  if (allSetupKeys.length > 0) {
    tableRows += _cmpSectionRow('By Setup Type', cols.length);
    for (const key of allSetupKeys) {
      const label = SETUP_LABELS[key] || key;
      // Win Rate
      tableRows += _cmpRow({
        label: `${label} — WR`,
        fmt: s => { const b = s.bySetupType?.[key]; return b ? (b.winRate*100).toFixed(1)+'% ('+b.trades+')' : '—'; },
        best: 'high', val: s => s.bySetupType?.[key]?.winRate ?? -1,
      }, cols);
      // P&L
      tableRows += _cmpRow({
        label: `${label} — P&L`,
        fmt: s => { const b = s.bySetupType?.[key]; return b ? '$'+b.pnl?.toFixed(0) : '—'; },
        best: 'high', val: s => s.bySetupType?.[key]?.pnl ?? -Infinity,
      }, cols);
    }
  }

  // ── By Timeframe ───────────────────────────────────────────────────────────
  const allTfKeys = [...new Set(cols.flatMap(c => Object.keys(c.job.stats?.byTimeframe||{})))];
  if (allTfKeys.length > 0) {
    tableRows += _cmpSectionRow('By Timeframe', cols.length);
    for (const tf of allTfKeys) {
      tableRows += _cmpRow({
        label: `${tf} — WR`,
        fmt: s => { const b = s.byTimeframe?.[tf]; return b ? (b.winRate*100).toFixed(1)+'% ('+b.trades+')' : '—'; },
        best: 'high', val: s => s.byTimeframe?.[tf]?.winRate ?? -1,
      }, cols);
      tableRows += _cmpRow({
        label: `${tf} — P&L`,
        fmt: s => { const b = s.byTimeframe?.[tf]; return b ? '$'+b.pnl?.toFixed(0) : '—'; },
        best: 'high', val: s => s.byTimeframe?.[tf]?.pnl ?? -Infinity,
      }, cols);
    }
  }

  // ── By Symbol ─────────────────────────────────────────────────────────────
  const allSymKeys = [...new Set(cols.flatMap(c => Object.keys(c.job.stats?.bySymbol||{})))];
  if (allSymKeys.length > 1) {
    tableRows += _cmpSectionRow('By Symbol', cols.length);
    for (const sym of allSymKeys) {
      tableRows += _cmpRow({
        label: `${sym} — WR`,
        fmt: s => { const b = s.bySymbol?.[sym]; return b ? (b.winRate*100).toFixed(1)+'% ('+b.trades+')' : '—'; },
        best: 'high', val: s => s.bySymbol?.[sym]?.winRate ?? -1,
      }, cols);
      tableRows += _cmpRow({
        label: `${sym} — P&L`,
        fmt: s => { const b = s.bySymbol?.[sym]; return b ? '$'+b.pnl?.toFixed(0) : '—'; },
        best: 'high', val: s => s.bySymbol?.[sym]?.pnl ?? -Infinity,
      }, cols);
    }
  }

  // ── By Direction ──────────────────────────────────────────────────────────
  tableRows += _cmpSectionRow('By Direction', cols.length);
  for (const dir of ['bullish', 'bearish']) {
    tableRows += _cmpRow({
      label: `${dir.charAt(0).toUpperCase()+dir.slice(1)} — WR`,
      fmt: s => { const b = s.byDirection?.[dir]; return b ? (b.winRate*100).toFixed(1)+'% ('+b.trades+')' : '—'; },
      best: 'high', val: s => s.byDirection?.[dir]?.winRate ?? -1,
    }, cols);
    tableRows += _cmpRow({
      label: `${dir.charAt(0).toUpperCase()+dir.slice(1)} — P&L`,
      fmt: s => { const b = s.byDirection?.[dir]; return b ? '$'+b.pnl?.toFixed(0) : '—'; },
      best: 'high', val: s => s.byDirection?.[dir]?.pnl ?? -Infinity,
    }, cols);
  }

  // ── By Confidence Bucket ──────────────────────────────────────────────────
  const allConfKeys = [...new Set(cols.flatMap(c => Object.keys(c.job.stats?.byConfBucket||{})))].sort();
  if (allConfKeys.length > 0) {
    tableRows += _cmpSectionRow('By Confidence', cols.length);
    for (const bucket of allConfKeys) {
      tableRows += _cmpRow({
        label: `${bucket}% — WR`,
        fmt: s => { const b = s.byConfBucket?.[bucket]; return b ? (b.winRate*100).toFixed(1)+'% ('+b.trades+')' : '—'; },
        best: 'high', val: s => s.byConfBucket?.[bucket]?.winRate ?? -1,
      }, cols);
    }
  }

  const headers = cols.map(c =>
    `<th><span class="bt2-cmp-dot" style="background:${c.color}"></span>${c.label}</th>`
  ).join('');

  body.innerHTML = `
    <div id="bt2-cmp-chart-wrap">
      <div class="bt2-section-label">Equity Curves (by trade #)</div>
      <div id="bt2-cmp-chart"></div>
    </div>
    <div id="bt2-cmp-table-wrap">
      <table id="bt2-cmp-table">
        <thead><tr><th>Metric</th>${headers}</tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;

  renderCompareChart(cols);
}

function renderCompareChart(cols) {
  const el = document.getElementById('bt2-cmp-chart');
  if (!el) return;

  if (_cmpChart) { try { _cmpChart.remove(); } catch {} _cmpChart = null; }

  _cmpChart = LightweightCharts.createChart(el, {
    width: el.clientWidth || 700,
    height: 220,
    layout: { background: { color: '#0f1117' }, textColor: '#9ca3af' },
    grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
    rightPriceScale: { borderColor: '#374151' },
    timeScale: { borderColor: '#374151', tickMarkFormatter: v => `#${v}` },
    crosshair: { mode: LightweightCharts.CrosshairMode.Magnet },
  });

  cols.forEach(({ job, color }) => {
    if (!job.equity || job.equity.length === 0) return;
    const series = _cmpChart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false });
    // Use trade index as x-axis so runs with different date ranges are comparable
    const pts = job.equity.map((pt, i) => ({ time: i + 1, value: pt.cumPnl }));
    // Pad so all series extend to the same length
    series.setData(pts);
  });

  // Zero line
  const maxLen = Math.max(...cols.map(c => c.job.equity?.length || 0));
  if (maxLen > 0) {
    const zero = _cmpChart.addLineSeries({ color: '#374151', lineWidth: 1, lineStyle: 2, priceLineVisible: false });
    zero.setData([{ time: 1, value: 0 }, { time: maxLen, value: 0 }]);
  }

  _cmpChart.timeScale().fitContent();
}

function exportCompareCSV() {
  const active = _cmpJobs.filter(j => j.jobId && j.stats);
  if (active.length < 2) { showToast('Nothing to export', 'error'); return; }
  const colHeaders = active.map(j => `"${j.config?.startDate}→${j.config?.endDate} ${(j.config?.symbols||[]).join('+')}"`);
  const lines = [['Metric', ...colHeaders].join(',')];

  // Pull rows from the rendered table so export always matches what's visible
  document.querySelectorAll('#bt2-cmp-table tbody tr').forEach(tr => {
    if (tr.classList.contains('bt2-cmp-section-row')) {
      lines.push('"'+tr.cells[0].textContent+'"');
    } else {
      const cells = [...tr.cells].map(td => '"'+td.textContent.trim()+'"');
      lines.push(cells.join(','));
    }
  });

  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], {type:'text/csv'}));
  a.download = 'backtest_compare.csv'; a.click();
}

// ─── Replay ───────────────────────────────────────────────────────────────────

function initReplayFromResults(results) {
  _replayJobId = results.jobId || _currentJobId;

  // Populate symbol selector
  const symSel = document.getElementById('bt2-replay-sym');
  const symbols = [...new Set((results.trades || []).map(t => t.symbol))];
  symSel.innerHTML = symbols.map(s => `<option>${s}</option>`).join('');

  // Populate date from first trade
  const trades = results.trades || [];
  if (trades.length > 0) {
    document.getElementById('bt2-replay-date').value = trades[0].date;
  }
}

async function loadReplaySession() {
  const sym  = document.getElementById('bt2-replay-sym').value;
  const date = document.getElementById('bt2-replay-date').value;
  if (!sym || !date || !_replayJobId) return;

  stopReplay();

  try {
    const data = await apiFetch(`/api/backtest/replay/${_replayJobId}?symbol=${sym}&date=${date}`);
    if (!data) return;

    _replayBars   = (data.bars1m || []).sort((a, b) => a.ts - b.ts);
    _replayAlerts = data.alerts || [];
    _replayHP     = data.hp || null;
    _replayCursor = 0;
    _replayPnl    = 0;
    _replayHPDrawn = false;
    _replayActivePriceLines = [];

    setupReplayChart();
    replaySeek(0);
    updateReplayTitle(sym, date);
  } catch (e) {
    console.warn('Replay load failed:', e.message);
  }
}

async function loadFullRunReplay() {
  const sym = document.getElementById('bt2-replay-sym').value;
  if (!sym || !_replayJobId) { showToast('No results loaded', 'error'); return; }

  stopReplay();
  const btn = document.getElementById('bt2-replay-fullrun');
  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const data = await apiFetch(`/api/backtest/replay/${_replayJobId}/full?symbol=${sym}`);
    if (!data) return;

    _replayBars   = (data.bars1m || []).sort((a, b) => a.ts - b.ts);
    _replayAlerts = data.alerts || [];
    _replayCursor = 0;
    _replayPnl    = 0;
    _replayHPDrawn = false;
    _replayActivePriceLines = [];

    setupReplayChart();
    replaySeek(0);
    document.getElementById('bt2-replay-title').textContent =
      `FULL RUN · ${sym} · ${data.dates?.[0] ?? ''} → ${data.dates?.[data.dates.length-1] ?? ''}`;
  } catch (e) {
    showToast('Full run load failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Full Run';
  }
}

function setupReplayChart() {
  const el = document.getElementById('bt2-replay-chart');
  if (_replayChart) { _replayChart.remove(); _replayChart = null; }
  el.innerHTML = '';

  _replayChart = LightweightCharts.createChart(el, {
    layout: { background: { color: 'transparent' }, textColor: '#9ca3af' },
    grid:   { vertLines: { color: '#2a2d35' }, horzLines: { color: '#2a2d35' } },
    rightPriceScale: { borderColor: '#2a2d35' },
    timeScale: { borderColor: '#2a2d35', timeVisible: true },
    width:  el.clientWidth || 800,
    height: 370,
    crosshair: { mode: 1 },
  });

  _replaySeries = _replayChart.addCandlestickSeries({
    upColor: '#22c55e', downColor: '#ef4444',
    wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    borderVisible: false,
  });

  new ResizeObserver(() => { if (_replayChart) _replayChart.applyOptions({ width: el.clientWidth }); }).observe(el);
}

function replaySeek(pos) {
  _replayCursor = Math.max(0, Math.min(pos, _replayBars.length - 1));
  renderReplayFrame();
}

function replayStep(delta) {
  replaySeek(_replayCursor + delta);
}

function toggleReplayPlay() {
  _replayPlaying = !_replayPlaying;
  document.getElementById('bt2-ctrl-play').textContent = _replayPlaying ? '⏸' : '▶';
  if (_replayPlaying) scheduleReplayTick();
  else clearTimeout(_replayTimer);
}

function stopReplay() {
  _replayPlaying = false;
  clearTimeout(_replayTimer);
  document.getElementById('bt2-ctrl-play').textContent = '▶';
}

function scheduleReplayTick() {
  if (!_replayPlaying) return;
  const speed = +document.getElementById('bt2-speed').value;
  // At speed N, we advance N bars per second
  const delayMs = Math.max(10, 1000 / speed);
  _replayTimer = setTimeout(() => {
    if (_replayCursor >= _replayBars.length - 1) {
      stopReplay();
      return;
    }
    replaySeek(_replayCursor + 1);
    scheduleReplayTick();
  }, delayMs);
}

function replaySkipToNextAlert() {
  const nextAlert = _replayAlerts.find(a => a.entryTs > (_replayBars[_replayCursor]?.ts ?? 0));
  if (!nextAlert) return;
  const idx = _replayBars.findIndex(b => b.ts >= nextAlert.entryTs);
  if (idx >= 0) replaySeek(Math.max(0, idx - 2));
}

// Track which HP lines and trade lines have been drawn to avoid duplication
let _replayHPDrawn = false;
let _replayActivePriceLines = []; // { line, alertId }

function renderReplayFrame() {
  if (!_replaySeries || _replayBars.length === 0) return;

  const visible = _replayBars.slice(0, _replayCursor + 1);
  const bar = _replayBars[_replayCursor];
  const curTs = bar?.ts ?? 0;

  // Update candle series
  _replaySeries.setData(visible.map(b => ({
    time:  b.ts,
    open:  b.open,
    high:  b.high,
    low:   b.low,
    close: b.close,
  })));

  // Draw HP levels once at session start
  if (!_replayHPDrawn && _replayHP) {
    _replayHPDrawn = true;
    const hpLevels = [
      { price: _replayHP.scaledGexFlip,  label: 'GEX Flip', color: '#22d3ee' },
      { price: _replayHP.scaledMaxPain,  label: 'Max Pain',  color: '#c084fc' },
      { price: _replayHP.scaledCallWall, label: 'Call Wall', color: '#f87171' },
      { price: _replayHP.scaledPutWall,  label: 'Put Wall',  color: '#4ade80' },
    ];
    for (const lvl of hpLevels) {
      if (lvl.price == null) continue;
      _replaySeries.createPriceLine({ price: lvl.price, color: lvl.color,
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: lvl.label });
    }
  }

  // Manage active trade price lines (entry/SL/TP)
  // Remove lines for trades that have exited
  _replayActivePriceLines = _replayActivePriceLines.filter(item => {
    const a = _replayAlerts.find(x => x.id === item.alertId);
    const exited = a && a.exitTs && a.exitTs <= curTs;
    if (exited) {
      try { _replaySeries.removePriceLine(item.line); } catch {}
      return false;
    }
    return true;
  });

  // Add lines for newly active trades
  for (const a of _replayAlerts) {
    if (a.entryTs > curTs) continue;  // not yet active
    const alreadyDrawn = _replayActivePriceLines.some(x => x.alertId === a.id && x.type === 'entry');
    if (alreadyDrawn) continue;
    if (a.exitTs && a.exitTs <= curTs) continue;  // already exited

    const isBull = a.direction === 'bullish';
    const entryLine = _replaySeries.createPriceLine({ price: a.entry, color: '#818cf8',
      lineWidth: 2, lineStyle: 0, axisLabelVisible: true,
      title: `${isBull ? '▲' : '▼'} Entry` });
    const slLine = _replaySeries.createPriceLine({ price: a.sl, color: '#ef4444',
      lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'SL' });
    const tpLine = _replaySeries.createPriceLine({ price: a.tp, color: '#22c55e',
      lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TP' });
    _replayActivePriceLines.push(
      { line: entryLine, alertId: a.id, type: 'entry' },
      { line: slLine,    alertId: a.id, type: 'sl' },
      { line: tpLine,    alertId: a.id, type: 'tp' },
    );
  }

  // Build series markers: entry arrows + exit markers
  const markers = [];
  for (const a of _replayAlerts) {
    if (a.entryTs > curTs) continue;

    const isBull = a.direction === 'bullish';
    // Entry marker
    markers.push({
      time:     a.entryTs,
      position: isBull ? 'belowBar' : 'aboveBar',
      color:    isBull ? '#818cf8' : '#818cf8',
      shape:    isBull ? 'arrowUp' : 'arrowDown',
      text:     `${(a.setupType || '').replace('_',' ')} ${a.confidence}%`,
      size:     1.5,
    });

    // Exit marker (when resolved and in view)
    if (a.exitTs && a.exitTs <= curTs && a.exitPrice) {
      const isWin = a.outcome === 'won';
      const isLoss = a.outcome === 'lost';
      const isClosed = a.outcome === 'closed';
      markers.push({
        time:     a.exitTs,
        position: isBull ? 'aboveBar' : 'belowBar',
        color:    isWin ? '#22c55e' : isLoss ? '#ef4444' : '#f59e0b',
        shape:    'circle',
        text:     `${isWin ? '✓' : isClosed ? '⏹' : '✗'} ${ (a.netPnl >= 0 ? '+' : '') + fmtNum(a.netPnl)}`,
        size:     1.2,
      });
    }
  }
  // Sort markers by time (required by Lightweight Charts)
  markers.sort((a, b) => a.time - b.time);
  _replaySeries.setMarkers(markers);

  // Cumulative P&L up to current bar (works for both single-day and full-run)
  _replayPnl = _replayAlerts
    .filter(a => a.exitTs && a.exitTs <= curTs)
    .reduce((s, a) => s + (a.netPnl ?? 0), 0);

  const startBal = getStartingBalance();
  const curBal   = startBal + _replayPnl;

  // Update controls
  const totalBars = _replayBars.length;
  const et = bar ? _tsToET(bar.ts) : '';
  document.getElementById('bt2-replay-pos').textContent = `Bar ${_replayCursor + 1}/${totalBars}`;
  document.getElementById('bt2-replay-ts').textContent = et;
  const pnlEl = document.getElementById('bt2-replay-pnl');
  pnlEl.textContent = `P&L: ${_replayPnl >= 0 ? '+' : ''}$${fmtNum(_replayPnl)}  Balance: $${fmtNum(curBal)}`;
  pnlEl.style.color = _replayPnl >= 0 ? '#22c55e' : '#ef4444';

  renderReplayAlertList(curTs);
  _replayChart?.timeScale().scrollToRealTime();
}

function _tsToET(ts) {
  // Approximate ET display (doesn't account for DST — close enough for display)
  const d = new Date((ts - 5 * 3600) * 1000);
  return d.toUTCString().substring(17, 25) + ' ET';
}

function renderReplayAlertList(curTs) {
  const list = document.getElementById('bt2-replay-alerts-list');
  list.innerHTML = _replayAlerts.map(a => {
    let cls = 'pending', result = '';
    if (a.entryTs <= curTs) {
      cls = 'active';
      if (a.exitTs && a.exitTs <= curTs) {
        cls = a.outcome === 'won' ? 'won-row' : 'lost-row';
        result = `${a.outcome === 'won' ? '+' : ''}$${fmtNum(a.netPnl ?? 0)}`;
      }
    }
    const ts = new Date(a.entryTs * 1000).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    const isBull = a.direction === 'bullish';
    return `<div class="bt2-replay-alert-row ${cls}">
      <span class="ral-time">${ts}</span>
      <span class="ral-type">${(a.setupType||'').replace('_',' ')}</span>
      <span class="ral-dir ${isBull ? 'bt2-dir-bull' : 'bt2-dir-bear'}">${isBull ? '▲ Bull' : '▼ Bear'}</span>
      <span class="ral-conf">${a.confidence}%</span>
      <span class="ral-result ${a.netPnl >= 0 ? 'bt2-pnl-pos' : 'bt2-pnl-neg'}">${result}</span>
    </div>`;
  }).join('');
}

function updateReplayTitle(sym, date) {
  document.getElementById('bt2-replay-title').textContent = `REPLAY · ${sym} · ${date}`;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

async function apiFetch(url, opts) {
  const resp = await fetch(url, opts);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.abs(n) >= 1000
    ? Math.round(n).toLocaleString()
    : n.toFixed(2);
}

function fmtPrice(p) {
  if (p == null) return '—';
  return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showToast(msg, type) {
  const div = document.createElement('div');
  div.style.cssText = `position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:6px;font-size:13px;z-index:9999;background:${type==='error'?'#ef4444':'#22c55e'};color:#fff;`;
  div.textContent = msg;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

// ═══════════════════════════════════════════════════════════════════════
// OPTIMIZE TAB
// Works entirely from _currentResults.trades — no additional API calls.
// Trade fields used: setupType, symbol, timeframe, direction, outcome,
//   confidence, entryTs, hour, entry, sl, tp, exitPrice, netPnl,
//   hpProximity (optional), resilienceLabel (optional).
// ═══════════════════════════════════════════════════════════════════════

let _bt2ActiveSubtab = localStorage.getItem('bt2_opt_subtab') || 'confidence';
let _bt2OptSetupType = 'all';
let _bt2OptSymbol    = 'all';

// ── Sub-tab pill listeners ─────────────────────────────────────────────────
document.querySelectorAll('.bt2-opt-pill').forEach(btn => {
  btn.addEventListener('click', () => _bt2OptSubtabName(btn.dataset.subtab));
});

// ── Shared select listeners (delegated — elements may not exist at parse time) ─
document.addEventListener('change', e => {
  if (e.target.id === 'bt2-opt-setup-sel') {
    _bt2OptSetupType = e.target.value;
    _renderOptimizeTab();
  }
  if (e.target.id === 'bt2-opt-symbol-sel') {
    _bt2OptSymbol = e.target.value;
    _renderOptimizeTab();
  }
});

// ── Sub-tab switch ─────────────────────────────────────────────────────────
function _bt2OptSubtabName(name) {
  _bt2ActiveSubtab = name;
  localStorage.setItem('bt2_opt_subtab', name);
  document.querySelectorAll('.bt2-opt-pill').forEach(b => {
    b.classList.toggle('active', b.dataset.subtab === name);
  });
  document.querySelectorAll('.bt2-opt-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById('bt2-opt-panel-' + name);
  if (panel) panel.style.display = '';
  _renderOptimizeTab();
}

// ── Entry point (called from tab click handler) ───────────────────────────
function initOptimizeTab() {
  _renderOptimizeTab();
}

// ── Master render dispatcher ──────────────────────────────────────────────
function _renderOptimizeTab() {
  const placeholder = document.getElementById('bt2-opt-placeholder');
  const main        = document.getElementById('bt2-opt-main');
  if (!placeholder || !main) return;

  if (!_currentResults) {
    placeholder.style.display = '';
    main.style.display = 'none';
    return;
  }

  placeholder.style.display = 'none';
  main.style.display = '';

  _bt2OptPopulateSelects();

  // Ensure correct sub-tab panel is shown
  document.querySelectorAll('.bt2-opt-panel').forEach(p => p.style.display = 'none');
  const activePanel = document.getElementById('bt2-opt-panel-' + _bt2ActiveSubtab);
  if (activePanel) activePanel.style.display = '';
  document.querySelectorAll('.bt2-opt-pill').forEach(b => {
    b.classList.toggle('active', b.dataset.subtab === _bt2ActiveSubtab);
  });

  switch (_bt2ActiveSubtab) {
    case 'confidence':    _bt2RenderConfidence(); break;
    case 'regime':        _bt2RenderRegime(); break;
    case 'heatmap':       _bt2RenderHeatmap(); break;
    case 'notifications': _bt2RenderNotifications(); break;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Populate setup type + symbol selects from current results, preserving selection */
function _bt2OptPopulateSelects() {
  const trades   = (_currentResults?.trades || []);
  const setupSel = document.getElementById('bt2-opt-setup-sel');
  const symSel   = document.getElementById('bt2-opt-symbol-sel');
  if (!setupSel || !symSel) return;

  const setups  = [...new Set(trades.map(t => t.setupType).filter(Boolean))].sort();
  const symbols = [...new Set(trades.map(t => t.symbol).filter(Boolean))].sort();

  const SETUP_LABELS = {
    zone_rejection: 'Zone Rejection', pdh_breakout: 'PDH Breakout',
    trendline_break: 'Trendline Break', or_breakout: 'OR Breakout',
  };

  setupSel.innerHTML = '<option value="all">All setups</option>' +
    setups.map(s => `<option value="${s}"${_bt2OptSetupType===s?' selected':''}>${SETUP_LABELS[s]||s}</option>`).join('');
  symSel.innerHTML = '<option value="all">All symbols</option>' +
    symbols.map(s => `<option value="${s}"${_bt2OptSymbol===s?' selected':''}>${s}</option>`).join('');

  // If selection no longer valid, reset
  if (_bt2OptSetupType !== 'all' && !setups.includes(_bt2OptSetupType)) _bt2OptSetupType = 'all';
  if (_bt2OptSymbol    !== 'all' && !symbols.includes(_bt2OptSymbol))    _bt2OptSymbol    = 'all';
}

/** Returns trades filtered by current setup type + symbol selects, outcome !== open */
function _bt2OptGetTrades() {
  return (_currentResults?.trades || []).filter(t => {
    if (t.outcome === 'open') return false;
    if (_bt2OptSetupType !== 'all' && t.setupType !== _bt2OptSetupType) return false;
    if (_bt2OptSymbol    !== 'all' && t.symbol    !== _bt2OptSymbol)    return false;
    return true;
  });
}

/** Compute R-multiple for a trade from entry/sl/tp/exit */
function _bt2R(t) {
  const risk = Math.abs((t.entry ?? 0) - (t.sl ?? 0));
  if (!risk) return 0;
  if (t.outcome === 'won') return +( Math.abs((t.tp ?? t.entry) - (t.entry ?? 0)) / risk ).toFixed(2);
  if (t.outcome === 'lost') return -1;
  // timeout / closed — use actual exit if available
  if (t.exitPrice != null && t.entry != null) {
    const signed = (t.direction === 'bullish' ? 1 : -1) * (t.exitPrice - t.entry);
    return +(signed / risk).toFixed(2);
  }
  return 0;
}

/**
 * Compute threshold analysis rows for a trade set.
 * Returns { rows: [{floor, n, wr, pf, avgR}], optimalFloor, sampleWarning }
 */
function _bt2ComputeThresholds(trades) {
  const FLOORS = [60, 65, 70, 75, 80, 85, 90];
  const rows = FLOORS.map(floor => {
    const sub  = trades.filter(t => (t.confidence ?? 0) >= floor);
    const n    = sub.length;
    if (n === 0) return { floor, n: 0, wr: null, pf: null, avgR: null };
    const won  = sub.filter(t => t.outcome === 'won');
    const lost = sub.filter(t => t.outcome === 'lost');
    const wr   = won.length / n;
    const sumWin  = won.reduce( (s, t) => s + Math.max(0, _bt2R(t)), 0);
    const sumLoss = lost.reduce((s, t) => s + Math.abs(_bt2R(t)),    0);
    const pf    = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? null : null);
    const allR  = sub.map(t => _bt2R(t));
    const avgR  = allR.reduce((s, r) => s + r, 0) / n;
    return {
      floor,
      n,
      wr:   +wr.toFixed(4),
      pf:   pf != null ? +pf.toFixed(2) : null,
      avgR: +avgR.toFixed(2),
    };
  });

  let optimalFloor = null, bestPf = -1;
  for (const r of rows) {
    if (r.n >= 10 && r.pf != null && r.pf > bestPf) { bestPf = r.pf; optimalFloor = r.floor; }
  }

  return { rows, optimalFloor, sampleWarning: trades.length < 30 };
}

/** Bar-row HTML helper used by Confidence and Regime tabs */
function _bt2BarRow(label, n, wr) {
  if (n < 3) {
    return `<div class="bt2-opt-bar-row">
      <div class="bt2-opt-bar-label">${label}</div>
      <div style="color:var(--muted,#6b7280);font-size:11px">insufficient data (n=${n})</div>
    </div>`;
  }
  const pct  = Math.round(wr * 100);
  const fill = wr >= 0.72 ? 'green' : wr >= 0.60 ? 'amber' : 'red';
  return `<div class="bt2-opt-bar-row">
    <div class="bt2-opt-bar-label">${label}</div>
    <div class="bt2-opt-bar-bg"><div class="bt2-opt-bar-fill ${fill}" style="width:${Math.min(100,pct)}%"></div></div>
    <div style="font-size:12px;font-weight:600;min-width:38px;text-align:right">${pct}%</div>
    <div class="bt2-opt-bar-n">n=${n}</div>
  </div>`;
}

/** Grade badge HTML */
function _bt2GradeBadge(wr, pf) {
  if (wr == null) return '';
  if (wr >= 0.75 && pf >= 2.5) return '<span class="bt2-opt-badge green">strong edge</span>';
  if (wr >= 0.65)               return '<span class="bt2-opt-badge amber">marginal</span>';
  return '<span class="bt2-opt-badge red">noise zone</span>';
}

// ── Confidence sub-tab ────────────────────────────────────────────────────
function _bt2RenderConfidence() {
  const panel = document.getElementById('bt2-opt-panel-confidence');
  if (!panel) return;

  const trades = _bt2OptGetTrades();
  const { rows, optimalFloor, sampleWarning } = _bt2ComputeThresholds(trades);
  const best = rows.find(r => r.floor === optimalFloor);

  // Metric cards
  const metrics = `<div class="bt2-opt-metrics">
    <div class="bt2-opt-metric">
      <div class="bt2-opt-metric-label">Optimal Floor</div>
      <div class="bt2-opt-metric-val">${optimalFloor != null ? optimalFloor + '%' : '—'}</div>
    </div>
    <div class="bt2-opt-metric">
      <div class="bt2-opt-metric-label">Win Rate @ Optimal</div>
      <div class="bt2-opt-metric-val">${best?.wr != null ? Math.round(best.wr*100)+'%' : '—'}</div>
    </div>
    <div class="bt2-opt-metric">
      <div class="bt2-opt-metric-label">Profit Factor @ Optimal</div>
      <div class="bt2-opt-metric-val">${best?.pf ?? '—'}</div>
    </div>
    <div class="bt2-opt-metric">
      <div class="bt2-opt-metric-label">Trades @ Optimal</div>
      <div class="bt2-opt-metric-val">${best?.n ?? '—'}</div>
    </div>
  </div>`;

  const warning = sampleWarning
    ? '<div class="bt2-opt-notice-amber">Fewer than 30 completed trades — results are indicative only.</div>'
    : '';

  // Threshold table
  const tableRows = rows.map(r => {
    const isOpt  = r.floor === optimalFloor;
    const wrPct  = r.wr != null ? Math.round(r.wr * 100) : null;
    const barClr = r.wr == null ? 'gray' : r.wr >= 0.72 ? 'green' : r.wr >= 0.60 ? 'amber' : 'red';
    const lowN   = (r.n > 0 && r.n < 10) ? '<span class="bt2-opt-badge amber" style="font-size:9px">low N</span>' : '';
    if (r.n === 0) {
      return `<tr><td>${r.floor}%</td><td>0</td><td colspan="4" style="color:var(--muted,#6b7280);text-align:center">—</td></tr>`;
    }
    return `<tr class="${isOpt ? 'opt-best' : ''}">
      <td>${isOpt ? '★ ' : ''}${r.floor}%</td>
      <td>${r.n} ${lowN}</td>
      <td><div class="bt2-opt-bar-bg" style="min-width:60px"><div class="bt2-opt-bar-fill ${barClr}" style="width:${wrPct}%"></div></div></td>
      <td>${wrPct != null ? wrPct+'%' : '—'}</td>
      <td>${r.pf ?? '—'}</td>
      <td>${r.avgR != null ? r.avgR+'R' : '—'}</td>
      <td>${_bt2GradeBadge(r.wr, r.pf)}</td>
    </tr>`;
  }).join('');

  const table = `<table class="bt2-opt-table">
    <thead><tr><th>Min Conf</th><th>N</th><th>Bar</th><th>Win Rate</th><th>PF</th><th>Avg R</th><th>Grade</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  // MTF section — group by mtfConfluence presence
  const mtfGroups = { 'MTF confirmed': [], 'No MTF': [] };
  for (const t of trades) {
    const mtf = t.mtfConfluence;
    if (mtf && (typeof mtf === 'object' ? (mtf.tfs?.length > 0) : true)) {
      mtfGroups['MTF confirmed'].push(t);
    } else {
      mtfGroups['No MTF'].push(t);
    }
  }
  const mtfGroupsWithData = Object.entries(mtfGroups).filter(([, g]) => g.length >= 3);
  let mtfHtml = '';
  if (mtfGroupsWithData.length >= 2) {
    const mtfRows = mtfGroupsWithData.map(([label, g]) => {
      const won = g.filter(t => t.outcome === 'won').length;
      const wr  = g.length > 0 ? won / g.length : 0;
      const sumWin  = g.filter(t=>t.outcome==='won').reduce((s,t)=>s+Math.max(0,_bt2R(t)),0);
      const sumLoss = g.filter(t=>t.outcome==='lost').reduce((s,t)=>s+Math.abs(_bt2R(t)),0);
      const pf = sumLoss > 0 ? +(sumWin/sumLoss).toFixed(2) : null;
      return `<tr><td>${label}</td><td>${g.length}</td><td>${Math.round(wr*100)}%</td><td>${pf??'—'}</td></tr>`;
    }).join('');
    mtfHtml = `<div style="margin-top:14px">
      <div class="bt2-section-label">MTF confluence impact</div>
      <table class="bt2-opt-table"><thead><tr><th>Group</th><th>N</th><th>WR</th><th>PF</th></tr></thead>
      <tbody>${mtfRows}</tbody></table>
    </div>`;
  }

  panel.innerHTML = metrics + warning + table + mtfHtml;
}

// ── Regime sub-tab ────────────────────────────────────────────────────────
function _bt2RenderRegime() {
  const panel = document.getElementById('bt2-opt-panel-regime');
  if (!panel) return;

  const trades = _bt2OptGetTrades();

  function card(title, groups) {
    const rows = groups.map(([label, g]) => {
      const won = g.filter(t => t.outcome === 'won').length;
      const wr  = g.length > 0 ? won / g.length : 0;
      return _bt2BarRow(label, g.length, wr);
    }).join('');
    return `<div class="bt2-card" style="margin-bottom:10px">
      <div class="bt2-section-label" style="margin-bottom:8px">${title}</div>
      <div class="bt2-opt-bar-rows">${rows}</div>
    </div>`;
  }

  // Card 1: Direction
  const bullTrades = trades.filter(t => t.direction === 'bullish');
  const bearTrades = trades.filter(t => t.direction === 'bearish');
  const dirCard = card('Direction', [
    ['Bullish setups', bullTrades],
    ['Bearish setups', bearTrades],
  ]);

  // Card 2: HP Proximity (if data exists)
  const hasHp = trades.some(t => t.hpProximity != null);
  let hpCard = '';
  if (hasHp) {
    const atLevel   = trades.filter(t => t.hpProximity === 'at_level');
    const nearLevel = trades.filter(t => t.hpProximity === 'near_level');
    const other     = trades.filter(t => t.hpProximity == null || (t.hpProximity !== 'at_level' && t.hpProximity !== 'near_level'));
    hpCard = card('HP Level Proximity', [
      ['At level',   atLevel],
      ['Near level', nearLevel],
      ['No HP data', other],
    ]);
  } else {
    hpCard = `<div class="bt2-card" style="margin-bottom:10px">
      <div class="bt2-section-label" style="margin-bottom:8px">HP Level Proximity</div>
      <div class="bt2-opt-notice-info">HP levels not enabled in this backtest run.</div>
    </div>`;
  }

  // Card 3: Regime / calendar — not on trade objects, show info
  const infoCard = `<div class="bt2-card">
    <div class="bt2-section-label" style="margin-bottom:8px">Regime &amp; Calendar Gate</div>
    <div class="bt2-opt-notice-info">Regime type, trend alignment, and calendar event data are not
      captured in backtest trade records (v10.x). These gates are applied upstream during signal
      detection — their effect is already reflected in overall win rate.
      Future backtest versions will include per-trade regime metadata.</div>
  </div>`;

  panel.innerHTML = dirCard + hpCard + infoCard;
}

// ── Time of Day sub-tab ───────────────────────────────────────────────────
function _bt2RenderHeatmap() {
  const panel = document.getElementById('bt2-opt-panel-heatmap');
  if (!panel) return;

  const allTrades = _bt2OptGetTrades();
  const ET_HOURS  = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  const RTH_HOURS = new Set([9, 10, 11, 12, 13, 14, 15, 16]);

  // Get ET hour from trade (use pre-computed trade.hour if available)
  function etHour(t) {
    if (t.hour != null) return t.hour;
    if (t.entryTs) return new Date((t.entryTs - 5 * 3600) * 1000).getUTCHours();
    return null;
  }

  function heatmapRow(label, trades) {
    const cells = ET_HOURS.map(h => {
      const bucket = trades.filter(t => etHour(t) === h);
      const n      = bucket.length;
      const won    = bucket.filter(t => t.outcome === 'won').length;
      const wr     = n >= 3 ? won / n : null;
      const rthBorder = RTH_HOURS.has(h) ? 'border-top:2px solid rgba(99,102,241,0.4)' : '';
      const title  = `${h}:00 ET — ${n} trade${n!==1?'s':''}`;

      if (wr === null) {
        return `<div class="bt2-opt-heatmap-cell" style="background:rgba(107,114,128,0.1);color:#9ca3af;${rthBorder}" title="${title}">—</div>`;
      }
      const pct  = Math.round(wr * 100);
      const bg   = wr >= 0.72 ? '#22c55e20' : wr >= 0.55 ? '#f59e0b20' : '#ef444420';
      const clr  = wr >= 0.72 ? '#22c55e'   : wr >= 0.55 ? '#f59e0b'   : '#ef4444';
      return `<div class="bt2-opt-heatmap-cell" style="background:${bg};color:${clr};${rthBorder}" title="${title}">${pct}%</div>`;
    }).join('');

    return `<div class="bt2-opt-heatmap-wrap">
      <div class="bt2-opt-heatmap-label">${label}</div>
      <div class="bt2-opt-heatmap-row">${cells}</div>
    </div>`;
  }

  // Hour header row
  const hourHeader = `<div style="margin-bottom:4px">
    <div style="display:grid;grid-template-columns:repeat(10,1fr);gap:2px;font-size:9px;color:var(--muted,#6b7280);text-align:center">
      ${ET_HOURS.map(h => `<div>${h}:00</div>`).join('')}
    </div>
  </div>`;

  // All row + per-setup-type rows
  const setups = [...new Set(allTrades.map(t => t.setupType).filter(Boolean))].sort();
  const SETUP_LABELS = {
    zone_rejection: 'Zone Rejection', pdh_breakout: 'PDH Breakout',
    trendline_break: 'Trendline Break', or_breakout: 'OR Breakout',
  };

  let html = hourHeader + heatmapRow('All setups', allTrades);
  for (const st of setups) {
    html += heatmapRow(SETUP_LABELS[st] || st, allTrades.filter(t => t.setupType === st));
  }

  html += `<div class="bt2-opt-notice-info" style="margin-top:12px">
    Hours with WR &lt; 50% receive a &minus;10 confidence adjustment before the notification threshold check.
  </div>`;

  panel.innerHTML = html;
}

// ── Notifications sub-tab (static) ────────────────────────────────────────
function _bt2RenderNotifications() {
  const panel = document.getElementById('bt2-opt-panel-notifications');
  if (!panel || panel.dataset.rendered) return;
  panel.dataset.rendered = '1';

  panel.innerHTML = `
    <!-- Tier cards -->
    <div class="bt2-section-label" style="margin-bottom:10px">Urgency tiers</div>

    <div class="bt2-opt-tier">
      <div class="bt2-opt-tier-icon" style="background:rgba(107,114,128,.2);color:#9ca3af">1</div>
      <div class="bt2-opt-tier-body">
        <div class="bt2-opt-tier-title">Confidence 65–74 <span class="bt2-opt-badge gray">sound only</span></div>
        <div class="bt2-opt-tier-desc">Sound only (existing behavior — two-tone chime). Alert appears in feed. No visual interrupt.</div>
      </div>
    </div>

    <div class="bt2-opt-tier">
      <div class="bt2-opt-tier-icon" style="background:rgba(245,158,11,.2);color:#f59e0b">2</div>
      <div class="bt2-opt-tier-body">
        <div class="bt2-opt-tier-title">Confidence 75–84 <span class="bt2-opt-badge amber">sound + flash</span></div>
        <div class="bt2-opt-tier-desc">Sound + topbar symbol badge pulses amber for 8 seconds. Non-blocking. Alert card border highlighted amber.</div>
      </div>
    </div>

    <div class="bt2-opt-tier" style="border-color:rgba(99,102,241,0.4)">
      <div class="bt2-opt-tier-icon" style="background:rgba(99,102,241,.2);color:#818cf8">3</div>
      <div class="bt2-opt-tier-body">
        <div class="bt2-opt-tier-title">Confidence 85+ <span class="bt2-opt-badge blue">full alert</span></div>
        <div class="bt2-opt-tier-desc">Sound + 12-second dismissible topbar banner + push notification. Banner shows symbol / setup type / direction. Alert pinned to top of feed.</div>
      </div>
    </div>

    <!-- Dedup steps -->
    <div class="bt2-section-label" style="margin:16px 0 10px">Deduplication logic</div>
    <div class="bt2-opt-steps">
      <div class="bt2-opt-step">
        <div class="bt2-opt-step-num">1</div>
        <div class="bt2-opt-step-text">New alert fires — <strong>symbol + direction + setup type</strong> captured.</div>
      </div>
      <div class="bt2-opt-step">
        <div class="bt2-opt-step-num">2</div>
        <div class="bt2-opt-step-text">Check alert cache: same symbol + direction + price within <strong>1×ATR</strong>, fired within last <strong>30 minutes</strong>.</div>
      </div>
      <div class="bt2-opt-step">
        <div class="bt2-opt-step-num">3a</div>
        <div class="bt2-opt-step-text"><strong>Match found</strong> → update confidence if higher. Suppress notification. Existing alert card refreshes its confidence badge.</div>
      </div>
      <div class="bt2-opt-step">
        <div class="bt2-opt-step-num">3b</div>
        <div class="bt2-opt-step-text"><strong>No match</strong> → proceed to tier check.</div>
      </div>
      <div class="bt2-opt-step">
        <div class="bt2-opt-step-num">4</div>
        <div class="bt2-opt-step-text">Time-of-day gate: if historical WR for this setup+hour &lt; 50%, reduce effective confidence by <strong>10</strong> before tier check.</div>
      </div>
    </div>
    <div class="bt2-opt-notice-info" style="margin-top:8px">
      Deduplication and tier behavior will be wired up in a separate implementation task. This panel is the design reference.
    </div>

    <!-- Staleness decay -->
    <div class="bt2-section-label" style="margin:16px 0 8px">Staleness decay</div>
    <div class="bt2-card">
      <div style="font-size:11px;color:var(--muted,#6b7280);margin-bottom:10px">
        Alert visual weight decays over time so stale alerts don't compete for attention with fresh ones.
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;gap:10px;font-size:11px">
          <span style="color:var(--muted,#6b7280);width:80px">0–15 min</span>
          <div style="flex:1;height:8px;background:#6366f1;border-radius:3px;opacity:1"></div>
          <span>100%</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:11px">
          <span style="color:var(--muted,#6b7280);width:80px">15–30 min</span>
          <div style="flex:1;height:8px;background:#6366f1;border-radius:3px;opacity:0.78"></div>
          <span>78%</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:11px">
          <span style="color:var(--muted,#6b7280);width:80px">30–45 min</span>
          <div style="flex:1;height:8px;background:#6366f1;border-radius:3px;opacity:0.60"></div>
          <span>60%</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:11px">
          <span style="color:var(--muted,#6b7280);width:80px">45+ min</span>
          <div style="flex:1;height:4px;background:rgba(99,102,241,0.3);border-radius:3px"></div>
          <span style="color:var(--muted,#6b7280)">collapses → compact row</span>
        </div>
      </div>
    </div>
  `;
}

// ── Dead code from old alert-based optimize (kept to avoid parse errors) ──
// These functions are no longer called but referenced by old variable names.
function _computeOptForAlerts(alerts) {
  const SETUP_TYPES      = ['zone_rejection', 'pdh_breakout', 'trendline_break', 'or_breakout'];
  const THRESHOLD_FLOORS = [60, 65, 70, 75, 80, 85, 90];
  const completed = alerts.filter(a =>
    a.setup?.outcome === 'won' || a.setup?.outcome === 'lost'
  );
  const bySetupAndThreshold = {};
  const byRegime    = {};
  const byAlignment = {};
  const byCalendar  = {};
  const byMtf       = {};
  const byHour      = {};

  for (const setupType of SETUP_TYPES) {
    const forSetup = completed.filter(a => a.setup?.type === setupType);

    const thresholds = THRESHOLD_FLOORS.map(floor => {
      const filt = forSetup.filter(a => (a.setup.confidence || 0) >= floor);
      if (!filt.length) return { floor, n: 0, wr: 0, pf: 0, avgR: 0 };
      const s = _optStats(filt);
      return { floor, n: filt.length, wr: s.wr, pf: s.pf, avgR: s.avgR };
    });
    let optimalFloor = null, bestPf = -1;
    for (const t of thresholds) {
      if (t.n >= 10 && t.pf > bestPf) { bestPf = t.pf; optimalFloor = t.floor; }
    }
    bySetupAndThreshold[setupType] = { thresholds, optimalFloor, sampleWarning: forSetup.length < 30 };

    const regGroups = { 'trend + aligned': [], 'trend + misaligned': [], 'range': [] };
    for (const a of forSetup) {
      const r = a.regime || {};
      if      (r.type === 'trend' && r.alignment === true)  regGroups['trend + aligned'].push(a);
      else if (r.type === 'trend' && r.alignment === false) regGroups['trend + misaligned'].push(a);
      else if (r.type === 'range')                          regGroups['range'].push(a);
    }
    byRegime[setupType] = Object.entries(regGroups).map(([label, g]) => ({
      label, n: g.length, wr: g.length ? _optStats(g).wr : 0,
    }));

    const aligned    = forSetup.filter(a => a.regime?.alignment === true);
    const misaligned = forSetup.filter(a => a.regime?.alignment !== true);
    byAlignment[setupType] = [
      { label: 'aligned',    n: aligned.length,    wr: aligned.length    ? _optStats(aligned).wr    : 0 },
      { label: 'misaligned', n: misaligned.length, wr: misaligned.length ? _optStats(misaligned).wr : 0 },
    ];

    const nearEvent = forSetup.filter(a =>  a.setup?.nearEvent === true);
    const notNear   = forSetup.filter(a => !a.setup?.nearEvent);
    byCalendar[setupType] = [
      { label: 'nearEvent: false', n: notNear.length,   wr: notNear.length   ? _optStats(notNear).wr   : 0 },
      { label: 'nearEvent: true',  n: nearEvent.length, wr: nearEvent.length ? _optStats(nearEvent).wr : 0 },
    ];

    const mtfBuckets = {};
    for (const a of forSetup) {
      const mtf = a.setup?.mtfConfluence;
      const lbl = (!mtf || !mtf.tfs || !mtf.tfs.length) ? 'no MTF' : 'MTF ' + mtf.tfs.join('+');
      if (!mtfBuckets[lbl]) mtfBuckets[lbl] = [];
      mtfBuckets[lbl].push(a);
    }
    const mtfResult = [], mtfOther = [];
    for (const [lbl, g] of Object.entries(mtfBuckets)) {
      if (lbl !== 'no MTF' && g.length < 5) { mtfOther.push(...g); }
      else { const s = _optStats(g); mtfResult.push({ label: lbl, n: g.length, wr: s.wr, pf: s.pf }); }
    }
    if (mtfOther.length) {
      const s = _optStats(mtfOther);
      mtfResult.push({ label: 'MTF (other)', n: mtfOther.length, wr: s.wr, pf: s.pf });
    }
    byMtf[setupType] = mtfResult;

    const hourBuckets = {};
    for (const a of forSetup) {
      if (!a.setup?.time) continue;
      const h = new Date(a.setup.time * 1000).getUTCHours();
      if (!hourBuckets[h]) hourBuckets[h] = [];
      hourBuckets[h].push(a);
    }
    byHour[setupType] = Object.entries(hourBuckets)
      .filter(([, g]) => g.length >= 3)
      .map(([h, g]) => ({ hour: +h, n: g.length, wr: _optStats(g).wr }))
      .sort((a, b) => a.hour - b.hour);
  }

  return { bySetupAndThreshold, byRegime, byAlignment, byCalendar, byMtf, byHour, rawAlerts: alerts };
}

function _optStats(alerts) {
  const won  = alerts.filter(a => a.setup.outcome === 'won');
  const lost = alerts.filter(a => a.setup.outcome === 'lost');
  const total = won.length + lost.length;
  if (total === 0) return { wr: 0, pf: 0, avgR: 0 };
  const wonR  = won.map(a  => _optCalcR(a, true)).filter(r => r != null);
  const lostR = lost.map(a => _optCalcR(a, false)).filter(r => r != null);
  const totalWonR  = wonR.reduce((s, r) => s + r, 0);
  const totalLostR = lostR.reduce((s, r) => s + r, 0);
  return {
    wr:   Math.round(won.length / total * 1000) / 10,
    pf:   totalLostR > 0 ? Math.round(totalWonR / totalLostR * 100) / 100 : 0,
    avgR: (wonR.length + lostR.length) > 0
      ? Math.round((totalWonR - totalLostR) / (wonR.length + lostR.length) * 100) / 100 : 0,
  };
}

function _optCalcR(alert, isWon) {
  const { entry, sl, tp } = alert.setup;
  if (entry == null || sl == null || tp == null) return null;
  const risk = Math.abs(entry - sl);
  if (risk === 0) return null;
  return isWon ? Math.abs(tp - entry) / risk : 1.0;
}

function _renderThresholdTab(data, setupType) {
  const panel = document.getElementById('opt-subpanel-threshold');
  if (!panel) return;
  const d = data.bySetupAndThreshold?.[setupType];
  if (!d) { panel.innerHTML = '<div class="opt-notice opt-notice-info">No data for this setup type.</div>'; return; }

  const optimal = d.optimalFloor;
  const best    = d.thresholds.find(t => t.floor === optimal);

  const metricHtml = `
    <div class="opt-metric-row">
      <div class="opt-metric"><div class="opt-metric-label">Optimal Floor</div>
        <div class="opt-metric-value">${optimal != null ? optimal + '%' : '—'}</div></div>
      <div class="opt-metric"><div class="opt-metric-label">Win Rate @ Optimal</div>
        <div class="opt-metric-value">${best ? best.wr + '%' : '—'}</div></div>
      <div class="opt-metric"><div class="opt-metric-label">Profit Factor @ Optimal</div>
        <div class="opt-metric-value">${best ? best.pf : '—'}</div></div>
      <div class="opt-metric"><div class="opt-metric-label">Sample (n)</div>
        <div class="opt-metric-value">${best ? best.n : '—'}</div></div>
    </div>
    ${d.sampleWarning ? '<div class="opt-notice opt-notice-info">Sample &lt; 30 — treat results as directional only.</div>' : ''}`;

  const maxWr = Math.max(1, ...d.thresholds.map(t => t.wr));
  const rows = d.thresholds.map(t => {
    const isOpt  = t.floor === optimal;
    const barPct = Math.round(t.wr / maxWr * 100);
    const lowN   = t.n < 10 ? '<span class="opt-lown">low n</span>' : '';
    return `<tr class="${isOpt ? 'opt-threshold-optimal' : ''}">
      <td>${t.floor}%${isOpt ? ' <span class="opt-badge-green">optimal</span>' : ''}</td>
      <td>${t.n} ${lowN}</td>
      <td class="opt-bar-cell">
        <div class="opt-bar-bg"><div class="opt-bar-fill" style="width:${barPct}%"></div></div>
        <span>${t.wr}%</span>
      </td>
      <td>${t.pf || '—'}</td>
      <td>${t.avgR || '—'}</td>
      <td>${_optAssessBadge(t.wr, t.pf)}</td>
    </tr>`;
  }).join('');

  const tableHtml = `
    <table class="opt-threshold-table">
      <thead><tr><th>Floor</th><th>n</th><th>Win Rate</th><th>PF</th><th>Avg R</th><th>Assessment</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  const mtfRows = (data.byMtf?.[setupType] || []).map(m => `
    <tr><td>${m.label}</td><td>${m.n}</td><td>${m.wr}%</td><td>${m.pf || '—'}</td></tr>`).join('');
  const mtfHtml = mtfRows ? `
    <div class="opt-section-title">MTF Confluence Impact</div>
    <table class="opt-threshold-table">
      <thead><tr><th>MTF Group</th><th>n</th><th>Win Rate</th><th>PF</th></tr></thead>
      <tbody>${mtfRows}</tbody>
    </table>` : '';

  panel.innerHTML = metricHtml + tableHtml + mtfHtml;
}

function _renderRegimeTab(data, setupType) {
  const panel = document.getElementById('opt-subpanel-regime');
  if (!panel) return;

  function barCard(title, rows) {
    const maxWr = Math.max(1, ...rows.map(r => r.wr));
    const bars  = rows.map(r => {
      const pct = Math.round(r.wr / maxWr * 100);
      return `<div class="opt-regime-row">
        <div class="opt-regime-label">${r.label} <span class="opt-regime-n">(n=${r.n})</span></div>
        <div class="opt-bar-bg"><div class="opt-bar-fill" style="width:${pct}%"></div></div>
        <span class="opt-regime-wr">${r.wr}%</span>
      </div>`;
    }).join('');
    const lowN = rows.some(r => r.n < 10) ? '<div class="opt-notice opt-notice-info">Some groups have n &lt; 10.</div>' : '';
    return `<div class="opt-card"><div class="opt-card-title">${title}</div>${bars}${lowN}</div>`;
  }

  const alignRows = data.byAlignment?.[setupType] || [];
  const wrDiff    = alignRows.length >= 2 ? Math.abs(alignRows[0].wr - alignRows[1].wr) : 0;
  const alignNotice = wrDiff < 5
    ? '<div class="opt-notice opt-notice-info">Alignment WR difference &lt; 5pp — gating may not add value for this setup type.</div>' : '';

  panel.innerHTML =
    barCard('Regime Type + Alignment', data.byRegime?.[setupType] || []) +
    alignNotice +
    barCard('Trend Alignment Gate', alignRows) +
    barCard('Calendar Gate (near high-impact event)', data.byCalendar?.[setupType] || []);
}

function _renderHeatmapTab(data) {
  const panel = document.getElementById('opt-subpanel-heatmap');
  if (!panel) return;

  const SETUP_LABELS = {
    zone_rejection: 'Zone Rejection', pdh_breakout: 'PDH Breakout',
    trendline_break: 'Trendline Break', or_breakout: 'OR Breakout',
  };
  const HOURS = Array.from({ length: 10 }, (_, i) => i + 12);

  let html = '';
  for (const [type, label] of Object.entries(SETUP_LABELS)) {
    const byHour = {};
    for (const h of (data.byHour?.[type] || [])) byHour[h.hour] = h;
    const cells = HOURS.map(h => {
      const d = byHour[h];
      if (!d) return `<div class="opt-heatmap-cell hm-gray"><div class="opt-heatmap-hour">${h}:00</div><div>—</div></div>`;
      const cls = d.wr >= 65 ? 'hm-green' : d.wr >= 50 ? 'hm-amber' : d.n >= 3 ? 'hm-red' : 'hm-gray';
      return `<div class="opt-heatmap-cell ${cls}" title="n=${d.n}">
        <div class="opt-heatmap-hour">${h}:00</div>
        <div>${d.wr}%</div>
        <div class="opt-heatmap-n">n=${d.n}</div>
      </div>`;
    }).join('');
    html += `<div class="opt-card"><div class="opt-card-title">${label} — Win Rate by UTC Hour</div>
      <div class="opt-heatmap-row">${cells}</div></div>`;
  }

  panel.innerHTML = html || '<div class="opt-notice opt-notice-info">No hourly data available yet.</div>';
}

function _renderNotifTab() {
  const panel = document.getElementById('opt-subpanel-notif');
  if (!panel) return;
  panel.innerHTML = `
    <div class="opt-card">
      <div class="opt-card-title">Notification Tiers</div>
      <div class="opt-notif-tier opt-badge-green">
        <strong>Tier 1 — High Priority</strong>
        <p>Confidence &ge; 80% · Trend-aligned · No near event · MTF confluence</p>
        <p>Action: immediate alert + sound + push notification</p>
      </div>
      <div class="opt-notif-tier opt-badge-amber">
        <strong>Tier 2 — Standard</strong>
        <p>Confidence 65–79% · Regime not counter-trend · Standard conditions</p>
        <p>Action: alert card only</p>
      </div>
      <div class="opt-notif-tier opt-badge-red">
        <strong>Tier 3 — Low Priority / Muted</strong>
        <p>Confidence &lt; 65% OR counter-trend OR near high-impact event</p>
        <p>Action: logged only, no push/sound</p>
      </div>
    </div>
    <div class="opt-card">
      <div class="opt-card-title">Alert Deduplication Logic</div>
      <div class="opt-dedup-step">1. Same symbol + setup type + direction within the same 5m bar → suppress duplicate.</div>
      <div class="opt-dedup-step">2. OR breakout: once per session per direction (re-fires only after RTH reset).</div>
      <div class="opt-dedup-step">3. Zone rejection at same level within 15 min → suppress if confidence &lt; 70%.</div>
    </div>
    <div class="opt-card">
      <div class="opt-card-title">Staleness Decay</div>
      <div class="opt-staleness-block">
        <p>Open alerts older than <strong>2 hours</strong> are automatically downgraded (no re-notification).</p>
        <p>PDH/PDL breakout signals remain valid for the full RTH session.</p>
        <p>Zone rejection signals decay after <strong>45 minutes</strong>.</p>
      </div>
    </div>`;
}

function _optAssessBadge(wr, pf) {
  if (!wr && !pf) return '<span class="opt-badge-gray">no data</span>';
  if (wr >= 60 && pf >= 1.5) return '<span class="opt-badge-green">strong edge</span>';
  if (wr >= 50 && pf >= 1.0) return '<span class="opt-badge-amber">marginal</span>';
  if (pf < 1.0 && wr > 0)    return '<span class="opt-badge-red">noise zone</span>';
  return '<span class="opt-badge-gray">insufficient data</span>';
}
