'use strict';
// Stats page — aggregates Trade Log, Prop Firms, and Real Account data.

(function () {

  const TYPE_LABELS = {
    zone_rejection:  'Zone Rej',
    pdh_breakout:    'PDH Brk',
    trendline_break: 'TL Break',
    or_breakout:     'OR Break',
  };

  // ── Tab switching ──────────────────────────────────────────────────────────

  document.querySelectorAll('.perf-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.perf-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.perf-tab-content').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // ── Load all sources ───────────────────────────────────────────────────────

  async function load() {
    const [perfRes, alertRes, tradeRes, pfRes, raRes] = await Promise.allSettled([
      fetch('/api/performance'),
      fetch('/api/alerts?limit=500&minConfidence=0'),
      fetch('/api/trades'),
      fetch('/api/propfirms'),
      fetch('/api/realaccount'),
    ]);

    const perf  = perfRes.status  === 'fulfilled' && perfRes.value.ok  ? await perfRes.value.json()  : null;
    const alert = alertRes.status === 'fulfilled' && alertRes.value.ok ? await alertRes.value.json() : null;
    const tl    = tradeRes.status === 'fulfilled' && tradeRes.value.ok ? await tradeRes.value.json() : null;
    const pf    = pfRes.status    === 'fulfilled' && pfRes.value.ok    ? await pfRes.value.json()    : null;
    const ra    = raRes.status    === 'fulfilled' && raRes.value.ok    ? await raRes.value.json()    : null;

    _renderTradeLog(perf, alert?.alerts || [], tl?.trades || []);
    _renderPropFirms(pf);
    _renderRealAccount(ra);
    _renderOverview(perf, pf, ra);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _set(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls) { el.classList.remove('good', 'neutral', 'bad'); el.classList.add(cls); }
  }

  function _fmt$(v) {
    if (v == null || isNaN(v)) return '—';
    const abs = Math.abs(v);
    const s = abs >= 1000 ? `$${(abs/1000).toFixed(1)}k` : `$${abs.toFixed(0)}`;
    return v < 0 ? `-${s}` : s;
  }

  function _pct(v) { return v != null ? `${v.toFixed(1)}%` : '—'; }

  function _renderBarChart(id, entries, opts = {}) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    if (!entries || !entries.length) {
      el.innerHTML = '<div class="no-data">No data yet</div>';
      return;
    }
    const maxVal = Math.max(...entries.map(e => Math.abs(e.value)));
    for (const { label, value, meta, colorClass } of entries) {
      const pct  = maxVal > 0 ? Math.abs(value) / maxVal * 100 : 0;
      const cls  = colorClass || (value >= 55 ? '' : value >= 40 ? 'neutral' : 'bad');
      const row  = document.createElement('div');
      row.className = 'bar-row';
      const displayVal = opts.dollar ? _fmt$(value) : `${Number(value).toFixed(opts.decimals ?? 0)}${opts.suffix || '%'}`;
      row.innerHTML = `
        <div class="bar-label" title="${label}">${label}</div>
        <div class="bar-track">
          <div class="bar-fill ${cls}" style="width:${pct}%"></div>
        </div>
        <div class="bar-pct">${displayVal}</div>
        ${meta != null ? `<div class="bar-meta">${meta}</div>` : ''}
      `;
      el.appendChild(row);
    }
  }

  // ── TRADE LOG TAB ──────────────────────────────────────────────────────────

  function _renderTradeLog(perf, alerts, trades) {
    if (perf) {
      if (perf.overall) perf.overall.open = perf.openCount ?? 0;
      const s = perf.overall || {};
      const wr = s.winRate;
      _set('s-wr',    wr != null ? `${wr.toFixed(1)}%` : '—', wr >= 50 ? 'good' : wr >= 40 ? 'neutral' : 'bad');
      _set('s-pf',    s.profitFactor != null ? s.profitFactor.toFixed(2) : '—');
      _set('s-avgr',  s.avgR         != null ? `${s.avgR.toFixed(2)}R`   : '—');
      _set('s-total', s.total        != null ? String(s.total)            : '—');
      _set('s-wlo',   `${s.won ?? 0} / ${s.lost ?? 0} / ${s.open ?? 0}`);

      _renderBarChart('chart-by-symbol', _toBarEntries(perf.bySymbol));
      _renderBarChart('chart-by-type',   _toBarEntries(perf.bySetupType, k => TYPE_LABELS[k] || k));
      _renderBarChart('chart-by-tf',     _toBarEntries(perf.byTimeframe));
      _renderBarChart('chart-by-dir',    _toBarEntries(perf.byDirection));
      _renderTodHeatmap(perf.byHour);
    }

    _renderAlertTable(alerts);
    _renderManualTradeTable(trades);
  }

  function _toBarEntries(obj, labelFn) {
    if (!obj) return [];
    return Object.entries(obj)
      .filter(([, v]) => v.total > 0)
      .sort((a, b) => (b[1].winRate ?? 0) - (a[1].winRate ?? 0))
      .map(([k, v]) => ({
        label: labelFn ? labelFn(k) : k,
        value: v.winRate ?? 0,
        meta:  `${v.total}T`,
      }));
  }

  function _renderTodHeatmap(byHour) {
    const el = document.getElementById('tod-heatmap');
    if (!el || !byHour) return;
    el.innerHTML = '';
    const RTH_UTC_HOURS = [14,15,16,17,18,19,20];
    for (const utcH of RTH_UTC_HOURS) {
      const stats = byHour[utcH];
      const etH   = utcH - 5;
      const label = `${etH > 12 ? etH - 12 : etH}${etH >= 12 ? 'p' : 'a'}`;
      const wr    = stats?.winRate ?? null;
      const total = stats?.total   ?? 0;
      const barH  = wr != null ? Math.max(4, Math.round(wr * 0.6)) : 4;
      const bg    = wr == null
        ? 'rgba(255,255,255,0.06)'
        : wr >= 55 ? `rgba(38,166,154,${0.3 + wr/200})`
        : wr >= 40 ? 'rgba(255,152,0,0.5)'
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

  function _renderAlertTable(alerts) {
    const resolved = alerts.filter(a => a.setup?.outcome !== 'open');
    _set('table-count', `(${resolved.length})`);
    const tbody = document.getElementById('alert-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    for (const a of resolved.slice().reverse()) {
      const { symbol, timeframe, setup } = a;
      const dirCls = setup.direction === 'bullish' ? 'dir-bull' : 'dir-bear';
      const outCls = `outcome-${setup.outcome}`;
      const outLbl = { won: '✓ Won', lost: '✗ Lost', open: '○ Open' }[setup.outcome] ?? '—';
      const timeStr = new Date(setup.time * 1000).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        hour12: true, timeZone: 'America/New_York',
      });
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${symbol}</td><td>${timeframe}</td>
        <td>${TYPE_LABELS[setup.type] || setup.type}</td>
        <td class="${dirCls}">${setup.direction === 'bullish' ? '▲' : '▼'}</td>
        <td>${setup.confidence}%</td>
        <td class="${outCls}">${outLbl}</td>
        <td>${timeStr}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  const _chartInstances = new Map();

  function _renderManualTradeTable(trades) {
    const tbody = document.getElementById('trade-tbody');
    const count = document.getElementById('trade-count');
    if (!tbody) return;
    const sorted = [...trades].sort((a, b) => {
      const ta = a.takenAt || a.entries?.[0]?.time || '';
      const tb = b.takenAt || b.entries?.[0]?.time || '';
      return tb.localeCompare(ta);
    });
    if (count) count.textContent = `(${sorted.length})`;
    tbody.innerHTML = '';
    for (const t of sorted) {
      const dirCls = (t.direction || 'bullish') === 'bullish' ? 'dir-bull' : 'dir-bear';
      const outCls = `outcome-${t.outcome || 'open'}`;
      const outLbl = { won: '✓ Won', lost: '✗ Lost', open: '○ Open' }[t.outcome] ?? '—';
      const pnlCls = (t.pnl || 0) > 0 ? 'outcome-won' : (t.pnl || 0) < 0 ? 'outcome-lost' : '';
      const pnlStr = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}$${Number(t.pnl).toFixed(0)}` : '—';
      const nEntries = (t.entries || []).length || (t.actualEntry ? 1 : 0);
      const dateStr = t.takenAt
        ? new Date(t.takenAt).toLocaleString('en-US', { month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })
        : '—';
      const tr = document.createElement('tr');
      tr.className = 'trade-row';
      tr.innerHTML = `
        <td>${t.symbol || '—'}</td><td>${t.timeframe || '—'}</td>
        <td class="${dirCls}">${(t.direction||'bullish') === 'bullish' ? '▲' : '▼'}</td>
        <td>${nEntries}</td>
        <td>${t.actualEntry != null ? Number(t.actualEntry).toFixed(2) : '—'}</td>
        <td>${t.actualExit  != null ? Number(t.actualExit).toFixed(2)  : '—'}</td>
        <td class="${pnlCls}">${pnlStr}</td>
        <td class="${outCls}">${outLbl}</td>
        <td>${dateStr}</td>
        <td><button class="chart-btn">Chart</button></td>
      `;
      tbody.appendChild(tr);
      tr.querySelector('.chart-btn').addEventListener('click', e => {
        e.stopPropagation();
        _toggleTradeChart(t.id, e.target, tr);
      });
    }
  }

  function _toggleTradeChart(tradeId, btn, parentRow) {
    const existing = document.querySelector(`.trade-expand-row[data-for="${tradeId}"]`);
    if (existing) {
      const chart = _chartInstances.get(tradeId);
      if (chart) { try { chart.remove(); } catch {} _chartInstances.delete(tradeId); }
      existing.remove(); btn.textContent = 'Chart'; return;
    }
    btn.textContent = '▲';
    const expandRow = document.createElement('tr');
    expandRow.className = 'trade-expand-row';
    expandRow.dataset.for = tradeId;
    const td = document.createElement('td');
    td.colSpan = 10;
    const TFS = ['1m','5m','15m','30m','1h'];
    td.innerHTML = `
      <div class="chart-tf-bar" id="tc-tfbar-${tradeId}">
        ${TFS.map(tf => `<button class="chart-tf-btn${tf==='5m'?' active':''}" data-tf="${tf}">${tf}</button>`).join('')}
      </div>
      <div class="trade-chart-inline" id="tc-inline-${tradeId}">
        <div style="color:var(--text-dim);padding:16px;text-align:center">Loading…</div>
      </div>
    `;
    expandRow.appendChild(td);
    parentRow.insertAdjacentElement('afterend', expandRow);
    td.querySelectorAll('.chart-tf-btn').forEach(tfBtn => {
      tfBtn.addEventListener('click', () => {
        td.querySelectorAll('.chart-tf-btn').forEach(b => b.classList.remove('active'));
        tfBtn.classList.add('active');
        _renderChart(tradeId, tfBtn.dataset.tf);
      });
    });
    _renderChart(tradeId, '5m');
  }

  async function _renderChart(tradeId, tf) {
    const container = document.getElementById(`tc-inline-${tradeId}`);
    if (!container) return;
    const prev = _chartInstances.get(tradeId);
    if (prev) { try { prev.remove(); } catch {} _chartInstances.delete(tradeId); }
    container.innerHTML = '<div style="color:var(--text-dim);padding:16px;text-align:center">Loading…</div>';
    let data;
    try {
      const res = await fetch(`/api/trade-chart/${tradeId}?tf=${tf}`);
      if (!res.ok) { container.innerHTML = `<div style="color:var(--bear);padding:16px;text-align:center">No chart data</div>`; return; }
      data = await res.json();
    } catch { container.innerHTML = `<div style="color:var(--bear);padding:16px;text-align:center">Failed to load</div>`; return; }
    container.innerHTML = '';
    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth, height: 240,
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
    if (data.markers?.length) series.setMarkers(data.markers);
    chart.timeScale().fitContent();
    new ResizeObserver(() => {
      if (_chartInstances.has(tradeId)) _chartInstances.get(tradeId).applyOptions({ width: container.clientWidth });
    }).observe(container);
  }

  // ── PROP FIRMS TAB ─────────────────────────────────────────────────────────

  function _renderPropFirms(pf) {
    if (!pf) { _set('pf-spend', '—'); return; }

    const accounts  = pf.accounts  || [];
    const expenses  = pf.expenses  || [];
    const payouts   = pf.payouts   || [];

    const firmSpend   = accounts.reduce((s, a) => s + (a.cost || 0), 0);
    const toolsSpend  = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const totalPayout = payouts.reduce((s, p) => s + (p.amount || 0), 0);
    const netCost     = firmSpend + toolsSpend - totalPayout;

    const challenges = accounts.filter(a => a.phase === 'challenge');
    const passed     = challenges.filter(a => ['passed','funded','funded_failed'].includes(a.status));
    const passRate   = challenges.length ? (passed.length / challenges.length * 100) : null;
    const active     = accounts.filter(a => ['active','funded'].includes(a.status)).length;
    const avgCost    = challenges.length ? firmSpend / challenges.length : null;

    _set('pf-spend',    _fmt$(firmSpend));
    _set('pf-expenses', _fmt$(toolsSpend));
    _set('pf-payouts',  _fmt$(totalPayout), totalPayout > 0 ? 'good' : null);
    _set('pf-net',      _fmt$(netCost), netCost <= 0 ? 'good' : 'bad');
    _set('pf-attempts', String(challenges.length));
    _set('pf-passrate', passRate != null ? `${passRate.toFixed(0)}%` : '—', passRate >= 50 ? 'good' : passRate != null ? 'neutral' : null);
    _set('pf-active',   String(active));
    _set('pf-avgcost',  avgCost != null ? _fmt$(avgCost) : '—');

    // Cost by firm bar chart
    const byCost = {};
    accounts.forEach(a => { if (!byCost[a.firm]) byCost[a.firm] = 0; byCost[a.firm] += a.cost || 0; });
    _renderBarChart('pf-by-firm',
      Object.entries(byCost).sort((a,b) => b[1]-a[1]).map(([k,v]) => ({ label: k, value: v, colorClass: 'neutral' })),
      { dollar: true }
    );

    // Pass rate by firm
    const byFirmPR = {};
    challenges.forEach(a => {
      if (!byFirmPR[a.firm]) byFirmPR[a.firm] = { total: 0, passed: 0 };
      byFirmPR[a.firm].total++;
      if (['passed','funded','funded_failed'].includes(a.status)) byFirmPR[a.firm].passed++;
    });
    _renderBarChart('pf-passrate-chart',
      Object.entries(byFirmPR).map(([k,v]) => ({
        label: k, value: v.total ? v.passed/v.total*100 : 0, meta: `${v.passed}/${v.total}`,
      }))
    );

    // Payouts by firm
    const byPayout = {};
    payouts.forEach(p => { if (!byPayout[p.firm]) byPayout[p.firm] = 0; byPayout[p.firm] += p.amount || 0; });
    _renderBarChart('pf-payout-chart',
      Object.entries(byPayout).sort((a,b) => b[1]-a[1]).map(([k,v]) => ({ label: k, value: v, colorClass: '' })),
      { dollar: true }
    );

    // Failure reasons
    const failed = accounts.filter(a => ['failed','funded_failed'].includes(a.status) && a.blowReason);
    const reasons = {};
    failed.forEach(a => { const r = a.blowReason || 'Unknown'; reasons[r] = (reasons[r]||0) + 1; });
    _renderBarChart('pf-failures',
      Object.entries(reasons).sort((a,b) => b[1]-a[1]).map(([k,v]) => ({ label: k, value: v, colorClass: 'bad', meta: `${v}x` })),
      { suffix: '', decimals: 0 }
    );

    // Accounts table
    const tbody = document.getElementById('pf-accounts-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      const sorted = [...accounts].sort((a,b) => (b.date||'').localeCompare(a.date||''));
      for (const a of sorted) {
        const statusCls = { active:'dir-bull', passed:'dir-bull', funded:'dir-bull', failed:'dir-bear', funded_failed:'dir-bear' }[a.status] || '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${a.firm || '—'}</td>
          <td>${a.date || '—'}</td>
          <td>${a.size ? `$${(a.size/1000).toFixed(0)}k` : '—'}</td>
          <td>${_fmt$(a.cost)}</td>
          <td>${a.phase || '—'}</td>
          <td class="${statusCls}">${a.status || '—'}</td>
          <td style="max-width:200px;font-size:0.8em;color:var(--text-dim)">${a.notes || ''}</td>
        `;
        tbody.appendChild(tr);
      }
      if (!sorted.length) tbody.innerHTML = '<tr><td colspan="7" class="tl-empty">No accounts recorded.</td></tr>';
    }

    // Payouts table
    const ptbody = document.getElementById('pf-payouts-tbody');
    if (ptbody) {
      ptbody.innerHTML = '';
      const sorted = [...payouts].sort((a,b) => (b.date||'').localeCompare(a.date||''));
      for (const p of sorted) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${p.firm||'—'}</td><td>${p.date||'—'}</td><td class="outcome-won">${_fmt$(p.amount)}</td><td>${p.notes||''}</td>`;
        ptbody.appendChild(tr);
      }
      if (!sorted.length) ptbody.innerHTML = '<tr><td colspan="4" class="tl-empty">No payouts recorded.</td></tr>';
    }
  }

  // ── REAL ACCOUNT TAB ───────────────────────────────────────────────────────

  function _renderRealAccount(ra) {
    if (!ra) { _set('ra-start', '—'); return; }

    const trades   = ra.trades   || [];
    const deposits = ra.deposits || [];

    const totalDeposits    = deposits.filter(d => d.type === 'deposit').reduce((s,d) => s + (d.amount||0), 0);
    const totalWithdrawals = deposits.filter(d => d.type === 'withdrawal').reduce((s,d) => s + (d.amount||0), 0);
    const startBal         = totalDeposits - totalWithdrawals;

    const grossPnl = trades.reduce((s,t) => s + (t.pnl||0), 0);
    const totalFees = trades.reduce((s,t) => {
      const f = t.fees || {};
      return s + (f.commission||0) + (f.clearing||0) + (f.exchange||0) + (f.nfa||0) + (f.platform||0) + (f.coqPlatform||0) + (f.coqMarketData||0);
    }, 0);
    const netPnl  = grossPnl - totalFees;
    const curBal  = startBal + netPnl;

    const resolved = trades.filter(t => t.result && t.result !== 'scratch');
    const wins     = resolved.filter(t => t.result === 'win').length;
    const wr       = resolved.length ? wins / resolved.length * 100 : null;
    const avgFee   = trades.length ? totalFees / trades.length : null;

    _set('ra-start',   startBal ? _fmt$(startBal) : '—');
    _set('ra-current', _fmt$(curBal), netPnl > 0 ? 'good' : netPnl < 0 ? 'bad' : null);
    _set('ra-net-pnl', (netPnl >= 0 ? '+' : '') + _fmt$(netPnl), netPnl > 0 ? 'good' : netPnl < 0 ? 'bad' : null);
    _set('ra-fees',    _fmt$(totalFees));
    _set('ra-trades',  String(trades.length));
    _set('ra-wr',      wr != null ? `${wr.toFixed(1)}%` : '—', wr >= 50 ? 'good' : wr != null ? 'neutral' : null);
    _set('ra-gross',   (grossPnl >= 0 ? '+' : '') + _fmt$(grossPnl));
    _set('ra-avg-fee', avgFee != null ? _fmt$(avgFee) : '—');

    // P&L by symbol
    const bySymPnl = {};
    trades.forEach(t => { if (!bySymPnl[t.symbol]) bySymPnl[t.symbol] = 0; bySymPnl[t.symbol] += t.pnl||0; });
    _renderBarChart('ra-by-symbol',
      Object.entries(bySymPnl).sort((a,b) => b[1]-a[1]).map(([k,v]) => ({ label: k, value: v, colorClass: v >= 0 ? '' : 'bad' })),
      { dollar: true }
    );

    // Win rate by symbol
    const bySymWR = {};
    trades.forEach(t => {
      if (!t.result || t.result === 'scratch') return;
      if (!bySymWR[t.symbol]) bySymWR[t.symbol] = { total: 0, wins: 0 };
      bySymWR[t.symbol].total++;
      if (t.result === 'win') bySymWR[t.symbol].wins++;
    });
    _renderBarChart('ra-winrate-chart',
      Object.entries(bySymWR).map(([k,v]) => ({ label: k, value: v.total ? v.wins/v.total*100 : 0, meta: `${v.total}T` }))
    );

    // Monthly P&L
    const byMonth = {};
    trades.forEach(t => {
      if (!t.date) return;
      const mo = t.date.slice(0, 7); // YYYY-MM
      if (!byMonth[mo]) byMonth[mo] = 0;
      byMonth[mo] += t.pnl || 0;
    });
    _renderBarChart('ra-monthly',
      Object.entries(byMonth).sort().map(([k,v]) => ({ label: k.slice(5), value: v, colorClass: v >= 0 ? '' : 'bad' })),
      { dollar: true }
    );

    // Fees by type (aggregate across all trades)
    const feeTypes = { Commission:0, Clearing:0, Exchange:0, NFA:0, Platform:0 };
    trades.forEach(t => {
      const f = t.fees || {};
      feeTypes.Commission += f.commission || 0;
      feeTypes.Clearing   += f.clearing   || 0;
      feeTypes.Exchange   += f.exchange   || 0;
      feeTypes.NFA        += f.nfa        || 0;
      feeTypes.Platform   += (f.platform || 0) + (f.coqPlatform || 0) + (f.coqMarketData || 0);
    });
    _renderBarChart('ra-fees-chart',
      Object.entries(feeTypes).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1])
        .map(([k,v]) => ({ label: k, value: v, colorClass: 'neutral' })),
      { dollar: true }
    );

    // Trades table
    const tbody = document.getElementById('ra-trades-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      const sorted = [...trades].sort((a,b) => (b.date||'').localeCompare(a.date||''));
      for (const t of sorted) {
        const f = t.fees || {};
        const fees = (f.commission||0)+(f.clearing||0)+(f.exchange||0)+(f.nfa||0)+(f.platform||0)+(f.coqPlatform||0)+(f.coqMarketData||0);
        const net  = (t.pnl||0) - fees;
        const pnlCls = (t.pnl||0) > 0 ? 'outcome-won' : (t.pnl||0) < 0 ? 'outcome-lost' : '';
        const netCls = net > 0 ? 'outcome-won' : net < 0 ? 'outcome-lost' : '';
        const qty  = (t.buyQty||0) + (t.sellQty||0);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${t.date||'—'}</td>
          <td>${t.broker||'—'}</td>
          <td>${t.symbol||'—'}</td>
          <td>${qty||'—'}</td>
          <td class="${pnlCls}">${t.pnl!=null ? (t.pnl>=0?'+':'')+_fmt$(t.pnl) : '—'}</td>
          <td>${fees > 0 ? _fmt$(fees) : '—'}</td>
          <td class="${netCls}">${net!==0 ? (net>=0?'+':'')+_fmt$(net) : '—'}</td>
          <td style="font-size:0.8em;color:var(--text-dim)">${t.notes||''}</td>
        `;
        tbody.appendChild(tr);
      }
      if (!sorted.length) tbody.innerHTML = '<tr><td colspan="8" class="tl-empty">No trades recorded.</td></tr>';
    }
  }

  // ── OVERVIEW TAB ───────────────────────────────────────────────────────────

  function _renderOverview(perf, pf, ra) {
    // Trade Log summary
    const s = perf?.overall || {};
    const wr = s.winRate;
    _set('ov-tl-wr',     wr != null ? `${wr.toFixed(1)}%` : '—', wr >= 50 ? 'good' : wr != null ? 'neutral' : null);
    _set('ov-tl-pf',     s.profitFactor != null ? s.profitFactor.toFixed(2) : '—');
    _set('ov-tl-trades', s.total != null ? `${s.total} (${s.won||0}W / ${s.lost||0}L)` : '—');

    // Prop Firms summary
    if (pf) {
      const firmSpend  = (pf.accounts||[]).reduce((s,a) => s + (a.cost||0), 0);
      const toolsSpend = (pf.expenses||[]).reduce((s,e) => s + (e.amount||0), 0);
      const payoutSum  = (pf.payouts||[]).reduce((s,p) => s + (p.amount||0), 0);
      const net        = firmSpend + toolsSpend - payoutSum;
      const challenges = (pf.accounts||[]).filter(a => a.phase === 'challenge');
      const passed     = challenges.filter(a => ['passed','funded','funded_failed'].includes(a.status));
      const pr         = challenges.length ? passed.length / challenges.length * 100 : null;
      _set('ov-pf-net',     (net<=0?'+':'-') + _fmt$(Math.abs(net)), net <= 0 ? 'good' : 'bad');
      _set('ov-pf-pass',    pr != null ? `${pr.toFixed(0)}%` : '—', pr >= 50 ? 'good' : pr != null ? 'neutral' : null);
      _set('ov-pf-payouts', _fmt$(payoutSum), payoutSum > 0 ? 'good' : null);
    }

    // Real Account summary
    if (ra) {
      const trades   = ra.trades   || [];
      const deposits = ra.deposits || [];
      const grossPnl = trades.reduce((s,t) => s + (t.pnl||0), 0);
      const totalFees = trades.reduce((s,t) => {
        const f = t.fees || {};
        return s + (f.commission||0)+(f.clearing||0)+(f.exchange||0)+(f.nfa||0)+(f.platform||0)+(f.coqPlatform||0)+(f.coqMarketData||0);
      }, 0);
      const netPnl  = grossPnl - totalFees;
      const resolved = trades.filter(t => t.result && t.result !== 'scratch');
      const wins    = resolved.filter(t => t.result === 'win').length;
      const raWr    = resolved.length ? wins / resolved.length * 100 : null;

      _set('ov-ra-pnl',  (netPnl>=0?'+':'')+_fmt$(netPnl), netPnl > 0 ? 'good' : netPnl < 0 ? 'bad' : null);
      _set('ov-ra-wr',   raWr != null ? `${raWr.toFixed(1)}%` : '—', raWr >= 50 ? 'good' : raWr != null ? 'neutral' : null);
      _set('ov-ra-fees', _fmt$(totalFees));
    }

    // Combined P&L snapshot
    const el = document.getElementById('ov-combined');
    if (!el) return;
    const pfNetRaw = pf ? (() => {
      const firmSpend  = (pf.accounts||[]).reduce((s,a) => s + (a.cost||0), 0);
      const toolsSpend = (pf.expenses||[]).reduce((s,e) => s + (e.amount||0), 0);
      const payoutSum  = (pf.payouts||[]).reduce((s,p) => s + (p.amount||0), 0);
      return payoutSum - firmSpend - toolsSpend; // positive = profitable
    })() : null;
    const raNetRaw = ra ? (() => {
      const trades = ra.trades || [];
      const grossPnl = trades.reduce((s,t) => s + (t.pnl||0), 0);
      const totalFees = trades.reduce((s,t) => {
        const f = t.fees || {};
        return s + (f.commission||0)+(f.clearing||0)+(f.exchange||0)+(f.nfa||0)+(f.platform||0)+(f.coqPlatform||0)+(f.coqMarketData||0);
      }, 0);
      return grossPnl - totalFees;
    })() : null;

    const rows = [
      { label: 'Trade Log P&L',   value: perf?.overall ? null : null, note: 'See Trade Log tab for R-based metrics' },
      { label: 'Prop Firms',      value: pfNetRaw,  note: pfNetRaw != null ? (pfNetRaw >= 0 ? 'Net profitable' : 'Net cost') : '—' },
      { label: 'Real Account',    value: raNetRaw,  note: raNetRaw != null ? 'Net after fees' : '—' },
    ].filter(r => r.value != null);

    if (!rows.length) {
      el.innerHTML = '<div class="no-data">No data yet — log trades in Trade Log, Prop Firms, and Real Account pages.</div>';
      return;
    }

    el.innerHTML = rows.map(r => {
      const cls = r.value > 0 ? 'outcome-won' : r.value < 0 ? 'outcome-lost' : '';
      return `<div class="ov-row">
        <div class="ov-row-label">${r.label}</div>
        <div class="ov-row-value ${cls}">${r.value >= 0 ? '+' : ''}${_fmt$(r.value)}</div>
        <div class="ov-row-note">${r.note}</div>
      </div>`;
    }).join('');
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  load().catch(err => console.error('[stats] Load failed:', err));

})();
