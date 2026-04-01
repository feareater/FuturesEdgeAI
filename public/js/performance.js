'use strict';
// Performance analytics page — fetches /api/performance and /api/alerts,
// renders summary stats, bar charts (CSS-only), ToD heat map, and alert table.

(function () {

  const TYPE_LABELS = {
    zone_rejection:  'Zone Rej',
    pdh_breakout:    'PDH Brk',
    trendline_break: 'TL Break',
    or_breakout:     'OR Break',
  };

  // ── Fetch and render ───────────────────────────────────────────────────────

  async function load() {
    try {
      const [perfRes, alertRes, tradeRes] = await Promise.all([
        fetch('/api/performance'),
        fetch('/api/alerts?limit=100&minConfidence=0'),
        fetch('/api/trades'),
      ]);

      if (perfRes.ok) {
        const stats = await perfRes.json();
        if (stats.overall) stats.overall.open = stats.openCount ?? 0;
        _renderSummary(stats.overall);
        _renderBarChart('chart-by-symbol', stats.bySymbol,   k => k);
        _renderBarChart('chart-by-type',   stats.bySetupType, k => TYPE_LABELS[k] || k);
        _renderBarChart('chart-by-tf',     stats.byTimeframe, k => k);
        _renderBarChart('chart-by-dir',    stats.byDirection, k => k);
        _renderTodHeatmap('tod-heatmap',   stats.byHour);
      }

      if (alertRes.ok) {
        const { alerts } = await alertRes.json();
        _renderTable(alerts);
      }

      if (tradeRes.ok) {
        const { trades } = await tradeRes.json();
        _renderTradeTable(trades || []);
      }
    } catch (err) {
      console.error('[performance] Load failed:', err.message);
    }
  }

  // ── Summary cards ──────────────────────────────────────────────────────────

  function _renderSummary(s) {
    if (!s) return;
    const wr = s.winRate != null ? `${s.winRate.toFixed(1)}%` : '—';
    _set('s-wr',    wr,  s.winRate >= 50 ? 'good' : s.winRate >= 40 ? 'neutral' : 'bad');
    _set('s-pf',    s.profitFactor != null ? s.profitFactor.toFixed(2) : '—');
    _set('s-avgr',  s.avgR         != null ? s.avgR.toFixed(2) + 'R'   : '—');
    _set('s-total', s.total        != null ? String(s.total)            : '—');
    _set('s-wlo',   `${s.won ?? 0} / ${s.lost ?? 0} / ${s.open ?? 0}`);
  }

  function _set(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls) {
      el.classList.remove('good', 'neutral', 'bad');
      el.classList.add(cls);
    }
  }

  // ── Bar charts ─────────────────────────────────────────────────────────────

  function _renderBarChart(id, obj, labelFn) {
    const el = document.getElementById(id);
    if (!el || !obj) return;
    el.innerHTML = '';

    const entries = Object.entries(obj).filter(([, v]) => v.total > 0);
    if (!entries.length) {
      el.innerHTML = '<div class="no-data">No resolved trades yet</div>';
      return;
    }
    entries.sort((a, b) => (b[1].winRate ?? 0) - (a[1].winRate ?? 0));

    for (const [key, stats] of entries) {
      const wr    = stats.winRate ?? 0;
      const cls   = wr >= 55 ? '' : wr >= 40 ? 'neutral' : 'bad';
      const row   = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = `
        <div class="bar-label" title="${key}">${labelFn(key)}</div>
        <div class="bar-track">
          <div class="bar-fill ${cls}" style="width:${wr}%"></div>
        </div>
        <div class="bar-pct">${wr.toFixed(0)}%</div>
        <div class="bar-meta">${stats.total}T</div>
      `;
      el.appendChild(row);
    }
  }

  // ── Time-of-Day heat map ───────────────────────────────────────────────────

  function _renderTodHeatmap(id, byHour) {
    const el = document.getElementById(id);
    if (!el || !byHour) return;
    el.innerHTML = '';

    // Show hours 9–16 ET (14–21 UTC)
    const RTH_UTC_HOURS = [14,15,16,17,18,19,20];
    const maxWR = 100;

    for (const utcH of RTH_UTC_HOURS) {
      const stats = byHour[utcH];
      const etH   = utcH - 5; // approximate ET (ignores DST — good enough for display)
      const label = `${etH > 12 ? etH - 12 : etH}${etH >= 12 ? 'p' : 'a'}`;
      const wr    = stats?.winRate ?? null;
      const total = stats?.total   ?? 0;

      const barH  = wr != null ? Math.max(4, Math.round(wr * 0.6)) : 4;
      const bg    = wr == null
        ? 'rgba(255,255,255,0.06)'
        : wr >= 55 ? `rgba(38,166,154,${0.3 + wr/200})`
        : wr >= 40 ? `rgba(255,152,0,0.5)`
        :            `rgba(239,83,80,${0.3 + (100-wr)/200})`;

      const cell = document.createElement('div');
      cell.className = 'tod-cell';
      cell.title     = wr != null ? `${label} ET: ${wr.toFixed(0)}% WR (${total} trades)` : `${label} ET: no data`;
      cell.innerHTML = `
        <div class="tod-bar" style="height:${barH}px;background:${bg}"></div>
        <div class="tod-label">${label}</div>
        ${total > 0 ? `<div class="tod-label">${wr.toFixed(0)}%</div>` : ''}
      `;
      el.appendChild(cell);
    }
  }

  // ── Alert table ────────────────────────────────────────────────────────────

  let _tableAlerts = [];
  let _sortKey     = 'time';
  let _sortAsc     = false;

  function _renderTable(alerts) {
    _tableAlerts = alerts.filter(a => a.setup.outcome !== 'open');
    document.getElementById('table-count').textContent = `(${_tableAlerts.length})`;
    _sortAndRender();

    // Wire sort headers
    document.querySelectorAll('#alert-table th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        if (_sortKey === th.dataset.sort) _sortAsc = !_sortAsc;
        else { _sortKey = th.dataset.sort; _sortAsc = false; }
        _sortAndRender();
      });
    });
  }

  function _sortAndRender() {
    const tbody = document.getElementById('alert-tbody');
    if (!tbody) return;

    const sorted = [..._tableAlerts].sort((a, b) => {
      let va, vb;
      switch (_sortKey) {
        case 'conf':    va = a.setup.confidence; vb = b.setup.confidence; break;
        case 'outcome': va = a.setup.outcome;    vb = b.setup.outcome;    break;
        default:        va = a.setup.time;       vb = b.setup.time;
      }
      if (va < vb) return _sortAsc ? -1 : 1;
      if (va > vb) return _sortAsc ?  1 : -1;
      return 0;
    });

    tbody.innerHTML = '';
    for (const a of sorted) {
      const { symbol, timeframe, setup } = a;
      const dir     = setup.direction === 'bullish' ? '▲' : '▼';
      const dirCls  = setup.direction === 'bullish' ? 'dir-bull' : 'dir-bear';
      const outCls  = `outcome-${setup.outcome}`;
      const outLbl  = { won: '✓ Won', lost: '✗ Lost', open: '○ Open' }[setup.outcome] ?? '—';
      const timeStr = new Date(setup.time * 1000).toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: 'America/New_York',
      });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${symbol}</td>
        <td>${timeframe}</td>
        <td>${TYPE_LABELS[setup.type] || setup.type}</td>
        <td class="${dirCls}">${dir}</td>
        <td>${setup.confidence}%</td>
        <td class="${outCls}">${outLbl}</td>
        <td>${timeStr}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  // ── Trade table ────────────────────────────────────────────────────────────

  const _chartInstances = new Map(); // tradeId → LW chart instance

  function _renderTradeTable(trades) {
    const tbody = document.getElementById('trade-tbody');
    const count = document.getElementById('trade-count');
    if (!tbody) return;

    // Sort newest first
    const sorted = [...trades].sort((a, b) => {
      const ta = a.takenAt || a.entries?.[0]?.time || '';
      const tb = b.takenAt || b.entries?.[0]?.time || '';
      return tb.localeCompare(ta);
    });

    if (count) count.textContent = `(${sorted.length})`;

    tbody.innerHTML = '';
    for (const t of sorted) {
      const dir    = (t.direction || 'bullish') === 'bullish' ? '▲' : '▼';
      const dirCls = (t.direction || 'bullish') === 'bullish' ? 'dir-bull' : 'dir-bear';
      const outCls = `outcome-${t.outcome || 'open'}`;
      const outLbl = { won: '✓ Won', lost: '✗ Lost', open: '○ Open' }[t.outcome] ?? '—';
      const pnlCls = (t.pnl || 0) > 0 ? 'outcome-won' : (t.pnl || 0) < 0 ? 'outcome-lost' : '';
      const pnlStr = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}$${Number(t.pnl).toFixed(0)}` : '—';

      const entryPx  = t.actualEntry != null ? Number(t.actualEntry).toFixed(2) : '—';
      const exitPx   = t.actualExit  != null ? Number(t.actualExit).toFixed(2)  : '—';
      const nEntries = (t.entries || []).length || (t.actualEntry ? 1 : 0);

      const dateStr = t.takenAt
        ? new Date(t.takenAt).toLocaleString('en-US', { month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })
        : '—';

      const tr = document.createElement('tr');
      tr.className = 'trade-row';
      tr.innerHTML = `
        <td>${t.symbol || '—'}</td>
        <td>${t.timeframe || '—'}</td>
        <td class="${dirCls}">${dir}</td>
        <td>${nEntries}</td>
        <td>${entryPx}</td>
        <td>${exitPx}</td>
        <td class="${pnlCls}">${pnlStr}</td>
        <td class="${outCls}">${outLbl}</td>
        <td>${dateStr}</td>
        <td><button class="chart-btn">📊</button></td>
      `;
      tbody.appendChild(tr);

      const btn = tr.querySelector('.chart-btn');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _toggleTradeChart(t.id, btn, tr);
      });
    }
  }

  // ── Inline trade chart (expand row) ────────────────────────────────────────

  const CHART_TFS = ['1m', '5m', '15m', '30m', '1h'];

  function _toggleTradeChart(tradeId, btn, parentRow) {
    const existing = document.querySelector(`.trade-expand-row[data-for="${tradeId}"]`);
    if (existing) {
      const chart = _chartInstances.get(tradeId);
      if (chart) { try { chart.remove(); } catch {} _chartInstances.delete(tradeId); }
      existing.remove();
      btn.textContent = '📊';
      btn.classList.remove('active');
      return;
    }

    btn.textContent = '▲';
    btn.classList.add('active');

    const expandRow = document.createElement('tr');
    expandRow.className = 'trade-expand-row';
    expandRow.dataset.for = tradeId;
    const td = document.createElement('td');
    td.colSpan = 10;
    td.innerHTML = `
      <div class="chart-tf-bar" id="tc-tfbar-${tradeId}">
        ${CHART_TFS.map(tf => `<button class="chart-tf-btn${tf === '1m' ? ' active' : ''}" data-tf="${tf}">${tf}</button>`).join('')}
      </div>
      <div class="trade-chart-inline" id="tc-inline-${tradeId}">
        <div style="color:var(--text-dim);padding:16px;text-align:center">Loading…</div>
      </div>
      <div class="tc-legend" id="tc-leg-${tradeId}"></div>
    `;
    expandRow.appendChild(td);
    parentRow.insertAdjacentElement('afterend', expandRow);

    // Wire TF buttons
    td.querySelectorAll('.chart-tf-btn').forEach(tfBtn => {
      tfBtn.addEventListener('click', () => {
        td.querySelectorAll('.chart-tf-btn').forEach(b => b.classList.remove('active'));
        tfBtn.classList.add('active');
        _renderChart(tradeId, tfBtn.dataset.tf);
      });
    });

    _renderChart(tradeId, '1m');
  }

  async function _renderChart(tradeId, tf) {
    const container = document.getElementById(`tc-inline-${tradeId}`);
    const legEl     = document.getElementById(`tc-leg-${tradeId}`);
    if (!container) return;

    // Destroy previous chart instance
    const prev = _chartInstances.get(tradeId);
    if (prev) { try { prev.remove(); } catch {} _chartInstances.delete(tradeId); }
    container.innerHTML = '<div style="color:var(--text-dim);padding:16px;text-align:center">Loading…</div>';
    if (legEl) legEl.innerHTML = '';

    let data;
    try {
      const res = await fetch(`/api/trade-chart/${tradeId}?tf=${tf}`);
      if (!res.ok) {
        let errMsg = 'Server error';
        try { errMsg = (await res.json()).error || errMsg; } catch { errMsg = await res.text().catch(() => errMsg); }
        container.innerHTML = `<div style="color:var(--bear);padding:16px;text-align:center">${errMsg}</div>`;
        return;
      }
      data = await res.json();
    } catch {
      container.innerHTML = `<div style="color:var(--bear);padding:16px;text-align:center">Failed to load chart</div>`;
      return;
    }

    container.innerHTML = '';
    const chart = LightweightCharts.createChart(container, {
      width:   container.clientWidth,
      height:  260,
      layout:  { background: { color: '#141624' }, textColor: '#e2e8f0' },
      grid:    { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: { borderColor: '#1e2235', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#1e2235' },
    });
    _chartInstances.set(tradeId, chart);

    const series = chart.addCandlestickSeries({
      upColor: '#4caf50', downColor: '#ef4444',
      borderUpColor: '#4caf50', borderDownColor: '#ef4444',
      wickUpColor: '#4caf50', wickDownColor: '#ef4444',
    });
    series.setData(data.candles);
    if (data.markers && data.markers.length) series.setMarkers(data.markers);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (_chartInstances.has(tradeId)) _chartInstances.get(tradeId).applyOptions({ width: container.clientWidth });
    });
    ro.observe(container);

    if (legEl) {
      const entries = data.markers.filter(m => m.color === '#4caf50' && m.text.startsWith('B '));
      const exits   = data.markers.filter(m => m.text.startsWith('S '));
      const items = [
        ...entries.map(m => `<span class="tc-leg-entry">▲ ${m.text}</span>`),
        ...exits.map(m => `<span class="${m.color === '#ef4444' ? 'tc-leg-exit-loss' : 'tc-leg-exit-win'}">▼ ${m.text}</span>`),
      ];
      legEl.innerHTML = items.join('') || '<span>No fill markers (seed data may not cover this date)</span>';
    }
  }

  // ── Wire table sort ────────────────────────────────────────────────────────

  function _initTable() {
    const ths = document.querySelectorAll('#alert-table th');
    const keys = ['sym', 'tf', 'type', 'dir', 'conf', 'outcome', 'time'];
    ths.forEach((th, i) => { if (keys[i]) th.dataset.sort = keys[i]; });
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  _initTable();
  load();

})();
