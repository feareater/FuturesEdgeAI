'use strict';
/**
 * forwardtest.js — FuturesEdge AI Forward-Test (Paper Trading) Page
 *
 * Handles:
 *   - Data fetch + 60s auto-refresh from /api/forwardtest/trades
 *   - Client-side filtering across all tabs
 *   - Summary tab: stat cards + equity/daily/WR charts (canvas)
 *   - Trade Log tab: sortable table, expandable rows, CSV export
 *   - Breakdown tab: by symbol, hour, VIX, DXY, breadth, risk, confidence, setup
 *   - AI Export tab: structured prompt generator with copy/download/save
 */

// ─── State ────────────────────────────────────────────────────────────────────

let _allTrades   = [];   // full trade list from API
let _filtered    = [];   // after filter application
let _sortKey     = 'date';
let _sortAsc     = false; // newest first by default
let _refreshTimer = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  _initTabs();
  _initFilters();
  _initTradeLog();
  _initExport();
  _loadTrades();

  // Auto-refresh every 60s
  _refreshTimer = setInterval(_loadTrades, 60000);
});

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function _loadTrades() {
  try {
    const res = await fetch('/api/forwardtest/trades?limit=500');
    const data = await res.json();
    _allTrades = (data.trades || []).reverse(); // oldest first for equity curve
    _populateSymbolFilter();
    _applyFilters();
  } catch (err) {
    console.error('[ft] Failed to load trades:', err);
  }
}

function _populateSymbolFilter() {
  const sel = document.getElementById('ft-filter-symbol');
  const syms = [...new Set(_allTrades.map(t => t.symbol))].sort();
  const current = sel.value;
  // Keep "All" option + unique symbols
  sel.innerHTML = '<option value="" selected>All</option>';
  for (const s of syms) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

// ─── Filtering ────────────────────────────────────────────────────────────────

function _initFilters() {
  const ids = ['ft-filter-symbol', 'ft-filter-setup', 'ft-filter-dir', 'ft-filter-outcome', 'ft-filter-from', 'ft-filter-to'];
  for (const id of ids) {
    document.getElementById(id)?.addEventListener('change', _applyFilters);
  }
  document.getElementById('ft-filter-reset')?.addEventListener('click', () => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    _applyFilters();
  });
}

function _applyFilters() {
  const sym     = document.getElementById('ft-filter-symbol').value;
  const setup   = document.getElementById('ft-filter-setup').value;
  const dir     = document.getElementById('ft-filter-dir').value;
  const outcome = document.getElementById('ft-filter-outcome').value;
  const from    = document.getElementById('ft-filter-from').value;
  const to      = document.getElementById('ft-filter-to').value;

  _filtered = _allTrades.filter(t => {
    if (sym     && t.symbol !== sym) return false;
    if (setup   && t.setupType !== setup) return false;
    if (dir     && t.direction !== dir) return false;
    if (outcome && t.outcome !== outcome) return false;
    if (from) {
      const d = (t.entryTime || t.ts || '').substring(0, 10);
      if (d < from) return false;
    }
    if (to) {
      const d = (t.entryTime || t.ts || '').substring(0, 10);
      if (d > to) return false;
    }
    return true;
  });

  const countEl = document.getElementById('ft-trade-count');
  if (countEl) countEl.textContent = `${_filtered.length} / ${_allTrades.length} trades`;

  _renderSummary();
  _renderTradeLog();
  _renderBreakdown();
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function _initTabs() {
  const tabs = document.querySelectorAll('.ft-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.ft-tab-panel').forEach(p => p.classList.remove('active'));
      const panel = document.getElementById('ft-tab-' + tab.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });
}

// ─── Summary Tab ──────────────────────────────────────────────────────────────

function _renderSummary() {
  const trades = _filtered;
  const noEl = document.getElementById('ft-no-trades');
  const contentEl = document.getElementById('ft-summary-content');

  if (!trades.length) {
    noEl.style.display = '';
    contentEl.style.display = 'none';
    return;
  }
  noEl.style.display = 'none';
  contentEl.style.display = '';

  const stats = _computeStats(trades);
  _renderStatCards(stats);
  _renderEquityCurve(trades);
  _renderDailyPnl(trades);
  _renderRollingWR(trades);
}

function _computeStats(trades) {
  const won     = trades.filter(t => t.outcome === 'won');
  const lost    = trades.filter(t => t.outcome === 'lost');
  const timeout = trades.filter(t => t.outcome === 'timeout');

  const totalWins  = won.reduce((s, t) => s + (t.netPnl || 0), 0);
  const totalLoss  = lost.reduce((s, t) => s + Math.abs(t.netPnl || 0), 0);
  const timeoutPnl = timeout.reduce((s, t) => s + (t.netPnl || 0), 0);
  const netPnl     = totalWins - totalLoss + timeoutPnl;

  const winRate = trades.length > 0 ? won.length / trades.length : 0;
  const pf      = totalLoss > 0 ? totalWins / totalLoss : (won.length > 0 ? Infinity : 0);
  const avgWin  = won.length  > 0 ? totalWins / won.length  : 0;
  const avgLoss = lost.length > 0 ? totalLoss / lost.length : 0;
  const expectancy = trades.length > 0 ? netPnl / trades.length : 0;

  // Max drawdown (running)
  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) {
    equity += (t.netPnl || 0);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Open positions (fetched separately)
  let openCount = 0;
  fetch('/api/forwardtest/open').then(r => r.json()).then(d => {
    const el = document.querySelector('.ft-stat-card[data-key="open"] .value');
    if (el) el.textContent = (d.positions || []).length;
  }).catch(() => {});

  return {
    totalTrades: trades.length,
    winRate, pf, netPnl, avgWin, avgLoss, expectancy, maxDD, openCount
  };
}

function _renderStatCards(s) {
  const container = document.getElementById('ft-stat-cards');
  const cards = [
    { key: 'total',  label: 'Total Trades', value: s.totalTrades },
    { key: 'wr',     label: 'Win Rate',     value: (s.winRate * 100).toFixed(1) + '%' },
    { key: 'pf',     label: 'Profit Factor', value: s.pf === Infinity ? '\u221e' : s.pf.toFixed(2) },
    { key: 'net',    label: 'Net P&L',      value: '$' + s.netPnl.toFixed(0), cls: s.netPnl >= 0 ? 'positive' : 'negative' },
    { key: 'avgw',   label: 'Avg Win',      value: '$' + s.avgWin.toFixed(0), cls: 'positive' },
    { key: 'avgl',   label: 'Avg Loss',     value: '-$' + s.avgLoss.toFixed(0), cls: 'negative' },
    { key: 'exp',    label: 'Expectancy',   value: '$' + s.expectancy.toFixed(2), cls: s.expectancy >= 0 ? 'positive' : 'negative' },
    { key: 'dd',     label: 'Max Drawdown', value: '-$' + s.maxDD.toFixed(0), cls: 'negative' },
    { key: 'open',   label: 'Open Positions', value: s.openCount },
  ];
  container.innerHTML = cards.map(c =>
    `<div class="ft-stat-card" data-key="${c.key}">
      <div class="label">${c.label}</div>
      <div class="value ${c.cls || ''}">${c.value}</div>
    </div>`
  ).join('');
}

// ── Canvas Charts ─────────────────────────────────────────────────────────────

function _renderEquityCurve(trades) {
  const canvas = document.getElementById('ft-equity-chart');
  const ctx = canvas.getContext('2d');
  _resizeCanvas(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (trades.length < 2) return;

  const equities = [];
  let eq = 0;
  for (const t of trades) { eq += (t.netPnl || 0); equities.push(eq); }

  _drawLineChart(ctx, canvas, equities, { color: '#2196f3', fill: true, zero: true });
}

function _renderDailyPnl(trades) {
  const canvas = document.getElementById('ft-daily-chart');
  const ctx = canvas.getContext('2d');
  _resizeCanvas(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Group by date
  const byDate = {};
  for (const t of trades) {
    const d = (t.entryTime || t.ts || '').substring(0, 10);
    if (!d) continue;
    byDate[d] = (byDate[d] || 0) + (t.netPnl || 0);
  }
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return;

  const values = dates.map(d => byDate[d]);
  _drawBarChart(ctx, canvas, values, dates);
}

function _renderRollingWR(trades) {
  const canvas = document.getElementById('ft-wr-chart');
  const ctx = canvas.getContext('2d');
  _resizeCanvas(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (trades.length < 5) return;

  const window = 20;
  const wrValues = [];
  for (let i = 0; i < trades.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = trades.slice(start, i + 1);
    const wins  = slice.filter(t => t.outcome === 'won').length;
    wrValues.push(wins / slice.length * 100);
  }

  _drawLineChart(ctx, canvas, wrValues, { color: '#ff9800', fill: false, zero: false, yLabel: '%' });
}

function _resizeCanvas(canvas) {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width  = rect.width - 24;
  canvas.height = 200;
}

function _drawLineChart(ctx, canvas, data, opts) {
  const w = canvas.width, h = canvas.height;
  const pad = { t: 10, b: 20, l: 50, r: 10 };
  const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;

  const min = Math.min(...data, opts.zero ? 0 : Infinity);
  const max = Math.max(...data, opts.zero ? 0 : -Infinity);
  const range = max - min || 1;

  const xStep = cw / (data.length - 1 || 1);

  // Grid lines
  ctx.strokeStyle = 'rgba(42,46,57,0.5)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    const val = max - (range / 4) * i;
    ctx.fillStyle = '#787b86';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText((opts.yLabel === '%' ? val.toFixed(1) + '%' : '$' + val.toFixed(0)), pad.l - 4, y + 3);
  }

  // Zero line
  if (opts.zero && min < 0 && max > 0) {
    const zeroY = pad.t + ch * (max / range);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(w - pad.r, zeroY); ctx.stroke();
  }

  // Line
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = pad.l + i * xStep;
    const y = pad.t + ch * (1 - (data[i] - min) / range);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill
  if (opts.fill) {
    const zeroY = opts.zero && min < 0 ? pad.t + ch * (max / range) : h - pad.b;
    ctx.lineTo(pad.l + (data.length - 1) * xStep, zeroY);
    ctx.lineTo(pad.l, zeroY);
    ctx.closePath();
    ctx.fillStyle = opts.color.replace(')', ',0.08)').replace('rgb', 'rgba');
    ctx.fill();
  }
}

function _drawBarChart(ctx, canvas, values, labels) {
  const w = canvas.width, h = canvas.height;
  const pad = { t: 10, b: 20, l: 50, r: 10 };
  const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;

  const absMax = Math.max(...values.map(Math.abs), 1);
  const barW = Math.max(2, Math.min(20, cw / values.length - 2));

  // Zero line
  const zeroY = pad.t + ch / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(w - pad.r, zeroY); ctx.stroke();

  // Y labels
  ctx.fillStyle = '#787b86';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('$' + absMax.toFixed(0), pad.l - 4, pad.t + 10);
  ctx.fillText('-$' + absMax.toFixed(0), pad.l - 4, h - pad.b - 2);
  ctx.fillText('$0', pad.l - 4, zeroY + 3);

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const x = pad.l + (cw / values.length) * i + (cw / values.length - barW) / 2;
    const barH = (Math.abs(v) / absMax) * (ch / 2);
    const y = v >= 0 ? zeroY - barH : zeroY;

    ctx.fillStyle = v >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)';
    ctx.fillRect(x, y, barW, barH);
  }
}

// ─── Trade Log Tab ────────────────────────────────────────────────────────────

function _initTradeLog() {
  // Column sorting
  document.querySelectorAll('#ft-trades-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_sortKey === key) _sortAsc = !_sortAsc;
      else { _sortKey = key; _sortAsc = true; }
      _renderTradeLog();
    });
  });

  // CSV export
  document.getElementById('ft-export-csv')?.addEventListener('click', _exportCSV);
}

function _renderTradeLog() {
  const tbody = document.getElementById('ft-trades-tbody');
  if (!tbody) return;

  const sorted = [..._filtered].sort((a, b) => {
    let va = _getSortVal(a, _sortKey);
    let vb = _getSortVal(b, _sortKey);
    if (va < vb) return _sortAsc ? -1 : 1;
    if (va > vb) return _sortAsc ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = '';
  for (const t of sorted) {
    const tr = document.createElement('tr');
    tr.className = `${t.outcome || ''} expandable`;

    const entryTime = t.entryTime || t.ts || '';
    const etTime = _toET(entryTime);
    const date = entryTime.substring(0, 10);

    tr.innerHTML = `
      <td>${date}</td>
      <td>${etTime}</td>
      <td>${t.symbol || ''}</td>
      <td>${_fmtSetup(t.setupType)}</td>
      <td>${t.timeframe || ''}</td>
      <td class="${t.direction === 'bullish' ? 'positive' : 'negative'}">${t.direction || ''}</td>
      <td>${t.confidence || ''}</td>
      <td>${_fmtPrice(t.entryPrice || t.entry)}</td>
      <td>${_fmtPrice(t.exitPrice)}</td>
      <td class="${t.outcome === 'won' ? 'positive' : t.outcome === 'lost' ? 'negative' : ''}">${t.outcome || ''}</td>
      <td class="${(t.netPnl || 0) >= 0 ? 'positive' : 'negative'}">$${(t.netPnl || 0).toFixed(2)}</td>
      <td>${t.vixRegime || ''}</td>
      <td>${t.dxyDirection || ''}</td>
      <td>${t.equityBreadth != null ? t.equityBreadth + '/4' : ''}</td>
      <td>${t.riskAppetite || ''}</td>
      <td>${t.hpNearest || ''}</td>
    `;

    // Expandable row
    tr.addEventListener('click', () => {
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('ft-expanded-row')) {
        next.remove();
      } else {
        const expTr = document.createElement('tr');
        expTr.className = 'ft-expanded-row';
        expTr.innerHTML = `<td colspan="16">${_buildExpandedContent(t)}</td>`;
        tr.after(expTr);
      }
    });

    tbody.appendChild(tr);
  }
}

function _buildExpandedContent(t) {
  const fields = [
    ['Exit Reason', t.exitReason],
    ['DEX Bias', t.dexBias],
    ['DD Band', t.ddBandLabel],
    ['Resilience', t.resilienceLabel],
    ['MTF Confluence', t.mtfConfluence ? JSON.stringify(t.mtfConfluence) : ''],
    ['VIX Level', t.vixLevel],
    ['Bond Regime', t.bondRegime],
    ['Gross P&L', t.grossPnl != null ? '$' + t.grossPnl.toFixed(2) : ''],
    ['Fee', t.fee != null ? '$' + t.fee.toFixed(2) : ''],
    ['Alert Key', t.alertKey || ''],
  ].filter(([, v]) => v != null && v !== '');

  return fields.map(([k, v]) => `<strong>${k}:</strong> ${v}`).join(' &nbsp;|&nbsp; ');
}

function _getSortVal(t, key) {
  switch (key) {
    case 'date':      return t.entryTime || t.ts || '';
    case 'time':      return t.entryTime || t.ts || '';
    case 'symbol':    return t.symbol || '';
    case 'setupType': return t.setupType || '';
    case 'timeframe': return t.timeframe || '';
    case 'direction': return t.direction || '';
    case 'confidence': return t.confidence || 0;
    case 'entry':     return t.entryPrice || t.entry || 0;
    case 'exitPrice': return t.exitPrice || 0;
    case 'outcome':   return t.outcome || '';
    case 'netPnl':    return t.netPnl || 0;
    case 'vixRegime': return t.vixRegime || '';
    case 'dxyDirection': return t.dxyDirection || '';
    case 'equityBreadth': return t.equityBreadth ?? -1;
    case 'riskAppetite': return t.riskAppetite || '';
    case 'hpNearest':  return t.hpNearest || '';
    default: return '';
  }
}

function _exportCSV() {
  const headers = ['Date','Time (ET)','Symbol','Setup','TF','Direction','Confidence','Entry','Exit','Result','P&L','VIX','DXY','Breadth','Risk Appetite','HP Proximity'];
  const rows = _filtered.map(t => [
    (t.entryTime || t.ts || '').substring(0, 10),
    _toET(t.entryTime || t.ts || ''),
    t.symbol, t.setupType, t.timeframe, t.direction, t.confidence,
    t.entryPrice || t.entry, t.exitPrice, t.outcome,
    (t.netPnl || 0).toFixed(2),
    t.vixRegime, t.dxyDirection, t.equityBreadth, t.riskAppetite, t.hpNearest
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  _downloadText(csv, `forwardtest_trades_${_dateStamp()}.csv`, 'text/csv');
}

// ─── Breakdown Tab ────────────────────────────────────────────────────────────

function _renderBreakdown() {
  const container = document.getElementById('ft-breakdown-content');
  if (!container) return;

  const trades = _filtered;
  if (!trades.length) {
    container.innerHTML = '<div class="ft-placeholder">No trades to break down.</div>';
    return;
  }

  container.innerHTML = '';

  // By Symbol
  container.innerHTML += _buildBreakdownTable('By Symbol', trades, t => t.symbol || '?');

  // By Hour (ET)
  container.innerHTML += _buildBreakdownTable('By Hour (ET)', trades, t => {
    try {
      return new Date(t.entryTime || t.ts).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    } catch { return '?'; }
  }, ['9','10','11','12','13','14','15','16','17']);

  // By VIX Regime
  container.innerHTML += _buildBreakdownTable('By VIX Regime', trades, t => t.vixRegime || 'unknown');

  // By DXY Direction
  container.innerHTML += _buildBreakdownTable('By DXY Direction', trades, t => t.dxyDirection || 'unknown');

  // By Equity Breadth
  container.innerHTML += _buildBreakdownTable('By Equity Breadth', trades, t => t.equityBreadth != null ? t.equityBreadth + '/4' : 'unknown');

  // By Risk Appetite
  container.innerHTML += _buildBreakdownTable('By Risk Appetite', trades, t => t.riskAppetite || 'unknown');

  // By Confidence Bucket
  container.innerHTML += _buildBreakdownTable('By Confidence', trades, t => {
    const c = t.confidence || 0;
    if (c >= 90) return '90+';
    if (c >= 80) return '80-89';
    if (c >= 70) return '70-79';
    return '60-69';
  });

  // By Setup Type
  container.innerHTML += _buildBreakdownTable('By Setup Type', trades, t => _fmtSetup(t.setupType || '?'));
}

function _buildBreakdownTable(title, trades, keyFn, forcedKeys) {
  const buckets = {};
  for (const t of trades) {
    const key = keyFn(t);
    if (!buckets[key]) buckets[key] = { trades: [], won: 0, totalWin: 0, totalLoss: 0 };
    buckets[key].trades.push(t);
    if (t.outcome === 'won') { buckets[key].won++; buckets[key].totalWin += (t.netPnl || 0); }
    if (t.outcome === 'lost') { buckets[key].totalLoss += Math.abs(t.netPnl || 0); }
  }

  const keys = forcedKeys || Object.keys(buckets).sort();

  let rows = '';
  for (const key of keys) {
    const b = buckets[key];
    if (!b || !b.trades.length) continue;
    const n = b.trades.length;
    if (n < 5) {
      rows += `<tr class="insufficient"><td>${key}</td><td>${n}</td><td colspan="4">insufficient data</td></tr>`;
      continue;
    }
    const wr  = (b.won / n * 100).toFixed(1);
    const pf  = b.totalLoss > 0 ? (b.totalWin / b.totalLoss).toFixed(2) : (b.won > 0 ? '\u221e' : '0');
    const net = (b.totalWin - b.totalLoss).toFixed(0);
    const avgW = b.won > 0 ? (b.totalWin / b.won).toFixed(0) : '0';
    const lostCount = b.trades.filter(t => t.outcome === 'lost').length;
    const avgL = lostCount > 0 ? (b.totalLoss / lostCount).toFixed(0) : '0';

    rows += `<tr>
      <td>${key}</td>
      <td>${n}</td>
      <td>${wr}%</td>
      <td>${pf}</td>
      <td class="${parseFloat(net) >= 0 ? 'positive' : 'negative'}">$${net}</td>
      <td>$${avgW}</td>
      <td>-$${avgL}</td>
    </tr>`;
  }

  return `<div class="ft-breakdown-panel">
    <h4>${title}</h4>
    <table class="ft-breakdown-table">
      <thead><tr><th>${title.replace('By ', '')}</th><th>n</th><th>WR%</th><th>PF</th><th>Net P&L</th><th>Avg Win</th><th>Avg Loss</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#787b86">No data</td></tr>'}</tbody>
    </table>
  </div>`;
}

// ─── AI Export Tab ────────────────────────────────────────────────────────────

function _initExport() {
  // Sample count slider label
  const slider = document.getElementById('ft-sample-count');
  const label  = document.getElementById('ft-sample-count-label');
  if (slider && label) {
    slider.addEventListener('input', () => { label.textContent = slider.value; });
  }

  document.getElementById('ft-generate-prompt')?.addEventListener('click', _generatePrompt);
  document.getElementById('ft-copy-prompt')?.addEventListener('click', _copyPrompt);
  document.getElementById('ft-download-prompt')?.addEventListener('click', _downloadPrompt);
  document.getElementById('ft-save-prompt')?.addEventListener('click', _savePrompt);
}

function _generatePrompt() {
  const trades = _filtered;
  if (!trades.length) {
    alert('No trades to analyze. Adjust filters or wait for trades to resolve.');
    return;
  }

  const stats = _computeStats(trades);
  const sampleCount = parseInt(document.getElementById('ft-sample-count').value, 10) || 0;
  const focus = document.getElementById('ft-analysis-focus').value;
  const customQ = document.getElementById('ft-custom-question').value.trim();

  // Which breakdowns to include
  const bdChecks = document.querySelectorAll('input[name="bd"]:checked');
  const includeBD = [...bdChecks].map(c => c.value);

  // Active filters description
  const activeFilters = [];
  if (document.getElementById('ft-filter-symbol').value) activeFilters.push('Symbol: ' + document.getElementById('ft-filter-symbol').value);
  if (document.getElementById('ft-filter-setup').value) activeFilters.push('Setup: ' + document.getElementById('ft-filter-setup').value);
  if (document.getElementById('ft-filter-dir').value) activeFilters.push('Direction: ' + document.getElementById('ft-filter-dir').value);
  if (document.getElementById('ft-filter-outcome').value) activeFilters.push('Outcome: ' + document.getElementById('ft-filter-outcome').value);
  if (document.getElementById('ft-filter-from').value) activeFilters.push('From: ' + document.getElementById('ft-filter-from').value);
  if (document.getElementById('ft-filter-to').value) activeFilters.push('To: ' + document.getElementById('ft-filter-to').value);

  // Date range
  const dates = trades.map(t => (t.entryTime || t.ts || '').substring(0, 10)).filter(Boolean).sort();
  const dateRange = dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : 'unknown';

  let prompt = `You are analyzing live forward-test trades from a systematic futures trading system (FuturesEdge AI).

SYSTEM CONTEXT:
- Active setups: or_breakout (primary), pdh_breakout
- Active symbols: MNQ, MES, MCL
- Trading hours: 9-10 ET (or_breakout), RTH (pdh_breakout)
- Backtest baseline (B8, 24-month): WR 41.8%, PF 2.239, Net +$156,848

FORWARD-TEST PERIOD: ${dateRange}
FILTERS APPLIED: ${activeFilters.length ? activeFilters.join(', ') : 'None'}

OVERALL STATS:
| Metric | Value |
|--------|-------|
| Total Trades | ${stats.totalTrades} |
| Win Rate | ${(stats.winRate * 100).toFixed(1)}% |
| Profit Factor | ${stats.pf === Infinity ? 'Inf' : stats.pf.toFixed(2)} |
| Net P&L | $${stats.netPnl.toFixed(2)} |
| Avg Win | $${stats.avgWin.toFixed(2)} |
| Avg Loss | -$${stats.avgLoss.toFixed(2)} |
| Expectancy | $${stats.expectancy.toFixed(2)} |
| Max Drawdown | -$${stats.maxDD.toFixed(2)} |
`;

  // Breakdown tables
  if (includeBD.length) {
    prompt += '\nBREAKDOWN TABLES:\n';
    if (includeBD.includes('symbol'))     prompt += _breakdownToMD('By Symbol', trades, t => t.symbol || '?');
    if (includeBD.includes('hour'))       prompt += _breakdownToMD('By Hour (ET)', trades, t => {
      try { return new Date(t.entryTime || t.ts).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }); } catch { return '?'; }
    });
    if (includeBD.includes('vix'))        prompt += _breakdownToMD('By VIX Regime', trades, t => t.vixRegime || 'unknown');
    if (includeBD.includes('dxy'))        prompt += _breakdownToMD('By DXY Direction', trades, t => t.dxyDirection || 'unknown');
    if (includeBD.includes('breadth'))    prompt += _breakdownToMD('By Equity Breadth', trades, t => t.equityBreadth != null ? t.equityBreadth + '/4' : 'unknown');
    if (includeBD.includes('risk'))       prompt += _breakdownToMD('By Risk Appetite', trades, t => t.riskAppetite || 'unknown');
    if (includeBD.includes('confidence')) prompt += _breakdownToMD('By Confidence', trades, t => {
      const c = t.confidence || 0;
      if (c >= 90) return '90+';
      if (c >= 80) return '80-89';
      if (c >= 70) return '70-79';
      return '60-69';
    });
    if (includeBD.includes('setup'))      prompt += _breakdownToMD('By Setup Type', trades, t => t.setupType || '?');
  }

  // Sample trades
  if (sampleCount > 0) {
    let sample;
    if (focus === 'winners') {
      sample = trades.filter(t => t.outcome === 'won').slice(-sampleCount);
    } else if (focus === 'losers') {
      sample = trades.filter(t => t.outcome === 'lost').slice(-sampleCount);
    } else {
      sample = trades.slice(-sampleCount);
    }

    const sampleFields = sample.map(t => ({
      date: (t.entryTime || t.ts || '').substring(0, 10),
      symbol: t.symbol, setup: t.setupType, tf: t.timeframe,
      direction: t.direction, confidence: t.confidence,
      entry: t.entryPrice || t.entry, exit: t.exitPrice,
      outcome: t.outcome, netPnl: t.netPnl,
      vixRegime: t.vixRegime, dxyDirection: t.dxyDirection,
      equityBreadth: t.equityBreadth, riskAppetite: t.riskAppetite,
      ddBandLabel: t.ddBandLabel, hpNearest: t.hpNearest,
      exitReason: t.exitReason
    }));

    prompt += `\nSAMPLE TRADES (${sample.length} ${focus === 'winners' ? 'winning' : focus === 'losers' ? 'losing' : ''} trades):\n`;
    prompt += JSON.stringify(sampleFields, null, 2) + '\n';
  }

  // Analysis focus
  const focusMap = {
    general:  'Provide a general performance review. What is working? What needs improvement? Are results in line with B8 backtest expectations?',
    winners:  'Focus on winning trades only. What feature combinations predict winners? Format findings as conditional rules.',
    losers:   'Focus on losing trades only. What do they share? What avoidance rules would reduce losses? Format as: AVOID [condition] - [WR]% WR (n=[count]).',
    symbol:   'Analyze performance by symbol. Which symbols are carrying edge? Which are dragging? Should any symbol be removed?',
    tod:      'Analyze performance by time of day. Which ET hours are most profitable? Should the trading window be narrowed or expanded?',
    compare:  'Compare these live results to the B8 backtest baseline (WR 41.8%, PF 2.239). Is the system performing as expected? Flag any significant deviations and possible causes.',
  };

  prompt += `\nANALYSIS REQUESTED:\n${focusMap[focus] || focusMap.general}\n`;
  if (customQ) prompt += `\nADDITIONAL QUESTION:\n${customQ}\n`;

  prompt += `\nCompare results to the B8 backtest baseline where relevant.
Only report patterns where n >= 5.
Format findings as specific conditional rules where possible.`;

  // Show output
  document.getElementById('ft-prompt-output').value = prompt;
  document.getElementById('ft-export-result').style.display = '';
  document.getElementById('ft-save-status').textContent = '';
}

function _breakdownToMD(title, trades, keyFn) {
  const buckets = {};
  for (const t of trades) {
    const key = keyFn(t);
    if (!buckets[key]) buckets[key] = { n: 0, won: 0, totalWin: 0, totalLoss: 0 };
    buckets[key].n++;
    if (t.outcome === 'won') { buckets[key].won++; buckets[key].totalWin += (t.netPnl || 0); }
    if (t.outcome === 'lost') { buckets[key].totalLoss += Math.abs(t.netPnl || 0); }
  }

  let md = `\n### ${title}\n| ${title.replace('By ', '')} | n | WR% | PF | Net P&L | Avg Win | Avg Loss |\n|---|---|---|---|---|---|---|\n`;
  for (const [key, b] of Object.entries(buckets).sort((a, b) => b[1].n - a[1].n)) {
    if (b.n < 5) continue;
    const wr = (b.won / b.n * 100).toFixed(1);
    const pf = b.totalLoss > 0 ? (b.totalWin / b.totalLoss).toFixed(2) : (b.won > 0 ? 'Inf' : '0');
    const net = (b.totalWin - b.totalLoss).toFixed(0);
    const avgW = b.won > 0 ? (b.totalWin / b.won).toFixed(0) : '0';
    const lostN = Object.values(trades.filter(t => keyFn(t) === key && t.outcome === 'lost')).length;
    const avgL = lostN > 0 ? (b.totalLoss / lostN).toFixed(0) : '0';
    md += `| ${key} | ${b.n} | ${wr}% | ${pf} | $${net} | $${avgW} | -$${avgL} |\n`;
  }
  return md;
}

async function _copyPrompt() {
  const text = document.getElementById('ft-prompt-output').value;
  try {
    await navigator.clipboard.writeText(text);
    _showSaveStatus('Copied!');
  } catch { _showSaveStatus('Copy failed', true); }
}

function _downloadPrompt() {
  const text = document.getElementById('ft-prompt-output').value;
  _downloadText(text, `forwardtest_analysis_${_dateStamp()}.txt`, 'text/plain');
}

async function _savePrompt() {
  const text = document.getElementById('ft-prompt-output').value;
  const filename = `${_dateStamp()}_forwardtest_prompt.txt`;
  try {
    const res = await fetch('/api/forwardtest/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text, filename })
    });
    const data = await res.json();
    if (data.saved) {
      _showSaveStatus('Saved to ' + data.path);
    } else {
      _showSaveStatus('Save failed', true);
    }
  } catch (err) {
    _showSaveStatus('Save failed: ' + err.message, true);
  }
}

function _showSaveStatus(msg, isError) {
  const el = document.getElementById('ft-save-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'ft-save-status' + (isError ? ' error' : '');
  setTimeout(() => { el.textContent = ''; }, 4000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _toET(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch { return ''; }
}

function _fmtSetup(type) {
  const map = { or_breakout: 'OR Break', pdh_breakout: 'PDH Break', zone_rejection: 'Zone Rej', trendline_break: 'TL Break' };
  return map[type] || type || '';
}

function _fmtPrice(p) {
  if (p == null) return '';
  return typeof p === 'number' ? p.toFixed(2) : p;
}

function _dateStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

function _downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
