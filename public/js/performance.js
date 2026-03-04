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
      const [perfRes, alertRes] = await Promise.all([
        fetch('/api/performance'),
        fetch('/api/alerts?limit=100&minConfidence=0'),
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

  // ── Wire table sort ────────────────────────────────────────────────────────

  // Add data-sort attributes after DOM is ready (below in the HTML we already have th's)
  function _initTable() {
    const ths = document.querySelectorAll('#alert-table th');
    const keys = ['sym', 'tf', 'type', 'dir', 'conf', 'outcome', 'time'];
    ths.forEach((th, i) => { if (keys[i]) th.dataset.sort = keys[i]; });
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  _initTable();
  load();

})();
