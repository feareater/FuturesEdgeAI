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
