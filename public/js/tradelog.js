/* FuturesEdge AI — Trade Log page */
(function () {
  'use strict';

  let _trades    = [];
  let _filtered  = [];
  let _accounts  = [];
  let _sortKey   = 'takenAt';
  let _sortAsc   = false;
  let _editId    = null;
  let _ladderId  = null;   // trade ID currently open in Fill Ladder
  let _totalFees = 0;      // updated by _updateFeesStat, used in _renderSummary

  const _chartInstances = new Map(); // tradeId → LW chart instance

  const $ = id => document.getElementById(id);

  // ── Accounts ──────────────────────────────────────────────────────────────

  async function _loadAccounts() {
    try {
      const r = await fetch('/api/accounts');
      const { accounts } = await r.json();
      _accounts = accounts || [];
      _populateAccountDropdowns();
      // Apply URL param after accounts are loaded
      const urlAcct = new URLSearchParams(location.search).get('accountId');
      if (urlAcct) {
        $('filter-account').value = urlAcct;
        // Show account name in heading
        const acct = _accounts.find(a => a.id === urlAcct);
        if (acct) {
          const badge = document.createElement('span');
          badge.className = 'tl-acct-heading';
          badge.textContent = `Showing: ${acct.label}`;
          $('tl-toolbar').prepend(badge);
        }
      }
    } catch (_) {}
  }

  function _populateAccountDropdowns() {
    const fundedAccts    = _accounts.filter(a => a.type === 'propfirm'    && a.phase === 'funded');
    const challengeAccts = _accounts.filter(a => a.type === 'propfirm'    && a.phase !== 'funded');
    const raAccts        = _accounts.filter(a => a.type === 'realaccount');

    function _appendGroup(sel, label, list) {
      if (!list.length) return;
      const grp = document.createElement('optgroup');
      grp.label = label;
      list.forEach(a => {
        const o = document.createElement('option');
        o.value = a.id; o.textContent = a.label;
        grp.appendChild(o);
      });
      sel.appendChild(grp);
    }

    function _buildOptions(sel) {
      sel.innerHTML = '<option value="">— None —</option>';
      _appendGroup(sel, 'Funded Accounts',    fundedAccts);
      _appendGroup(sel, 'Challenge Accounts', challengeAccts);
      _appendGroup(sel, 'Real Accounts',      raAccts);
    }

    // Filter dropdown — has extra "All Accounts" option
    const filterSel = $('filter-account');
    const prev = filterSel.value;
    filterSel.innerHTML = '<option value="">All Accounts</option>';
    _appendGroup(filterSel, 'Funded Accounts',    fundedAccts);
    _appendGroup(filterSel, 'Challenge Accounts', challengeAccts);
    _appendGroup(filterSel, 'Real Accounts',      raAccts);
    if (prev) filterSel.value = prev;

    ['mt-account','em-account','im-account','fim-account'].forEach(id => {
      const sel = $(id);
      if (sel) _buildOptions(sel);
    });
  }

  // Point values — loaded from server (instruments.js is source of truth)
  let POINT_VALUE = { MNQ: 2, MGC: 10, MES: 5, MCL: 100, SIL: 200, M2K: 5, MYM: 0.5, MHG: 2500, BTC: 1, ETH: 0.01, XRP: 0.0001 };
  fetch('/api/instruments').then(r => r.json()).then(data => {
    for (const [sym, meta] of Object.entries(data)) {
      if (meta.pointValue != null) POINT_VALUE[sym] = meta.pointValue;
    }
  }).catch(() => {});

  // ── Fetch ─────────────────────────────────────────────────────────────────

  async function _load() {
    try {
      const r = await fetch('/api/trades');
      const { trades } = await r.json();
      _trades = (trades || []).sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt));
      _applyFilters();
      // Refresh ladder if open
      if (_ladderId) {
        const t = _trades.find(x => x.id === _ladderId);
        if (t) _renderLadder(t);
      }
    } catch (e) {
      $('tl-tbody').innerHTML = `<tr><td colspan="16" class="tl-empty">Failed to load trades</td></tr>`;
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  function _applyFilters() {
    const sym   = $('filter-symbol').value;
    const out   = $('filter-outcome').value;
    const sent  = $('filter-sentiment').value;
    const acct  = $('filter-account').value;
    const from  = $('filter-date-from').value;
    const to    = $('filter-date-to').value;

    _filtered = _trades.filter(t => {
      if (sym  && t.symbol    !== sym)  return false;
      if (sent && t.sentiment !== sent) return false;
      if (acct && t.accountId !== acct) return false;
      if (out) {
        const o = t.outcome || 'open';
        if (out === 'open' && o !== 'open' && o !== null && o !== '') return false;
        if (out === 'won'  && o !== 'won')  return false;
        if (out === 'lost' && o !== 'lost') return false;
      }
      if (from && t.takenAt < from) return false;
      if (to   && t.takenAt.slice(0,10) > to) return false;
      return true;
    });

    _sort();
    _renderSummary();
    _renderTable();
  }

  // ── Sort ──────────────────────────────────────────────────────────────────

  function _sort() {
    _filtered.sort((a, b) => {
      let va = a[_sortKey], vb = b[_sortKey];
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (typeof va === 'string') return _sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return _sortAsc ? va - vb : vb - va;
    });
  }

  // ── Summary bar ───────────────────────────────────────────────────────────

  function _renderSummary() {
    const total  = _filtered.length;
    const won    = _filtered.filter(t => t.outcome === 'won').length;
    const lost   = _filtered.filter(t => t.outcome === 'lost').length;
    const open   = _filtered.filter(t => !t.outcome || t.outcome === 'open').length;
    const wr     = (won + lost) > 0 ? Math.round(won / (won + lost) * 100) : null;
    const grossPnl = _filtered.reduce((s, t) => s + (t.pnl || 0), 0);
    const netPnl   = grossPnl - _totalFees;

    $('stat-total').textContent = `${total} trade${total !== 1 ? 's' : ''}`;
    $('stat-won').textContent   = `${won} won`;
    $('stat-lost').textContent  = `${lost} lost`;
    $('stat-open').textContent  = `${open} open`;
    $('stat-wr').textContent    = wr != null ? `${wr}% WR` : '—% WR';
    $('stat-pnl').textContent   = `${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(0)} gross P&L`;
    $('stat-pnl').className     = `tl-stat ${grossPnl >= 0 ? 'bull' : 'bear'}`;
    const netEl = $('stat-net-pnl');
    if (netEl) {
      netEl.textContent = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(0)} net P&L`;
      netEl.className   = `tl-stat ${netPnl >= 0 ? 'bull' : 'bear'}`;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
           ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function _fmtP(sym, n) {
    if (n == null || isNaN(n)) return '—';
    const dp = ['BTC','ETH'].includes(sym) ? 2 : 2;
    return Number(n).toFixed(dp);
  }

  function _setupLabel(t) {
    const map = { zone_rejection:'Zone Rej', pdh_breakout:'PDH/PDL', trendline_break:'TL Break', or_breakout:'OR Break', bias:'Bias', manual:'Manual' };
    return map[t.setupType || t.manualSetupType] || (t.setupType || '—');
  }

  function _outcomeHtml(t) {
    const o = t.outcome || 'open';
    if (o === 'won')  return `<span class="tl-badge won">Won</span>`;
    if (o === 'lost') return `<span class="tl-badge lost">Lost</span>`;
    return `<span class="tl-badge open">Open</span>`;
  }

  function _dirHtml(t) {
    const d = t.direction || '';
    if (d === 'bullish') return `<span class="tl-dir bull">▲</span>`;
    if (d === 'bearish') return `<span class="tl-dir bear">▼</span>`;
    return '—';
  }

  function _sentimentHtml(t) {
    const s = t.sentiment || 'neutral';
    return `<span class="tl-sent ${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</span>`;
  }

  function _accountPayload(selectedId) {
    if (!selectedId) return { accountId: null, accountLabel: null, accountType: null };
    const acct = _accounts.find(a => a.id === selectedId);
    return {
      accountId:    selectedId,
      accountLabel: acct?.label || selectedId,
      accountType:  acct?.type  || 'propfirm',
    };
  }

  function _accountHtml(t) {
    if (!t.accountId && !t.accountLabel) return '<span class="td-acct-none">—</span>';
    const label = t.accountLabel || t.accountId || '—';
    const type  = t.accountType || 'propfirm';
    const cls   = type === 'realaccount' ? 'acct-real' : 'acct-pf';
    const short = label.length > 22 ? label.slice(0, 20) + '…' : label;
    return `<span class="tl-acct-badge ${cls}" title="${label.replace(/"/g,'&quot;')}">${short}</span>`;
  }

  function _pnlHtml(t) {
    if (t.pnl == null) return '—';
    const cls = t.pnl >= 0 ? 'bull' : 'bear';
    return `<span class="${cls}">${t.pnl >= 0 ? '+' : ''}$${Number(t.pnl).toFixed(0)}</span>`;
  }

  function _calcBlended(entries) {
    if (!entries || entries.length === 0) return null;
    const totalQty = entries.reduce((s, e) => s + e.qty, 0);
    if (totalQty === 0) return null;
    return entries.reduce((s, e) => s + e.qty * e.price, 0) / totalQty;
  }

  // ── Table render ──────────────────────────────────────────────────────────

  function _renderTable() {
    const tbody = $('tl-tbody');

    // Destroy any open chart instances before re-rendering
    _chartInstances.forEach(chart => { try { chart.remove(); } catch {} });
    _chartInstances.clear();

    if (_filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="17" class="tl-empty">No trades match the current filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = _filtered.map(t => {
      const hasFills  = (t.entries && t.entries.length > 0) || (t.exits && t.exits.length > 0);
      const dcaCount  = t.entries ? t.entries.length : 0;
      const dcaBadge  = t.dca
        ? `<span class="tl-badge dca">${dcaCount > 1 ? `DCA×${dcaCount}` : 'DCA'}</span>`
        : '—';
      const ladderBadge = hasFills
        ? `<span class="tl-badge ladder">🪜 ${dcaCount}E/${(t.exits||[]).length}X</span>`
        : '';
      return `
      <tr class="tl-row ${t.outcome === 'won' ? 'row-won' : t.outcome === 'lost' ? 'row-lost' : ''}"
          data-id="${t.id}">
        <td class="td-date">${_fmtDate(t.takenAt)}</td>
        <td class="td-sym"><strong>${t.symbol || '—'}</strong></td>
        <td>${t.timeframe || '—'}</td>
        <td>${_setupLabel(t)}</td>
        <td>${_dirHtml(t)}</td>
        <td>${_fmtP(t.symbol, t.actualEntry)}</td>
        <td class="bull">${_fmtP(t.symbol, t.actualTP)}</td>
        <td class="bear">${_fmtP(t.symbol, t.actualSL)}</td>
        <td>${_fmtP(t.symbol, t.actualExit)}</td>
        <td>${t.contracts ?? '—'}${t.remainingContracts != null && t.remainingContracts !== t.contracts ? `<span class="td-remain"> (${t.remainingContracts} rem)</span>` : ''}</td>
        <td>${_pnlHtml(t)}</td>
        <td>${_outcomeHtml(t)}</td>
        <td>${_sentimentHtml(t)}</td>
        <td class="td-dca">${dcaBadge}</td>
        <td class="td-account">${_accountHtml(t)}</td>
        <td class="td-notes" title="${(t.notes || '').replace(/"/g, '&quot;')}">${t.notes || '—'}</td>
        <td class="td-actions">
          <button class="tl-chart-btn"  data-id="${t.id}" title="Chart">📊</button>
          <button class="tl-ladder-btn" data-id="${t.id}" title="Fill Ladder — log DCA entries &amp; exits">🪜</button>
          <button class="tl-edit-btn"   data-id="${t.id}" title="Edit">✎</button>
          <button class="tl-del-btn"    data-id="${t.id}" title="Delete">✕</button>
        </td>
      </tr>
      ${hasFills ? `<tr class="tl-fills-row" data-id="${t.id}"><td colspan="16" class="td-fills-bar">${ladderBadge} ${_fillsSummaryHtml(t)}</td></tr>` : ''}
    `}).join('');

    tbody.querySelectorAll('.tl-ladder-btn').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); _openLadder(btn.dataset.id); }));
    tbody.querySelectorAll('.tl-edit-btn').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); _openEdit(btn.dataset.id); }));
    tbody.querySelectorAll('.tl-del-btn').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); _deleteTrade(btn.dataset.id); }));
    tbody.querySelectorAll('.tl-chart-btn').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const parentRow = btn.closest('.tl-row');
        _toggleTradeChart(btn.dataset.id, btn, parentRow);
      }));
  }

  // ── Inline trade chart (expand row) ────────────────────────────────────────

  const CHART_TFS = ['1m', '5m', '15m', '30m', '1h'];

  function _toggleTradeChart(tradeId, btn, parentRow) {
    const existing = document.querySelector(`.tl-expand-row[data-for="${tradeId}"]`);
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
    expandRow.className = 'tl-expand-row';
    expandRow.dataset.for = tradeId;
    const td = document.createElement('td');
    td.colSpan = 17;
    td.innerHTML = `
      <div class="chart-tf-bar" id="tlc-tfbar-${tradeId}">
        ${CHART_TFS.map(tf => `<button class="chart-tf-btn${tf === '1m' ? ' active' : ''}" data-tf="${tf}">${tf}</button>`).join('')}
      </div>
      <div class="tl-chart-inline" id="tlc-inline-${tradeId}">
        <div style="color:var(--text-dim);padding:16px;text-align:center">Loading…</div>
      </div>
      <div class="tc-legend" id="tlc-leg-${tradeId}"></div>
    `;
    expandRow.appendChild(td);

    // Insert after fills row if present, otherwise after trade row
    const fillsRow = document.querySelector(`.tl-fills-row[data-id="${tradeId}"]`);
    (fillsRow || parentRow).insertAdjacentElement('afterend', expandRow);

    // Wire TF buttons
    td.querySelectorAll('.chart-tf-btn').forEach(tfBtn => {
      tfBtn.addEventListener('click', () => {
        td.querySelectorAll('.chart-tf-btn').forEach(b => b.classList.remove('active'));
        tfBtn.classList.add('active');
        _renderTlChart(tradeId, tfBtn.dataset.tf);
      });
    });

    _renderTlChart(tradeId, '1m');
  }

  async function _renderTlChart(tradeId, tf) {
    const container = document.getElementById(`tlc-inline-${tradeId}`);
    const legEl     = document.getElementById(`tlc-leg-${tradeId}`);
    if (!container) return;

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

  function _fillsSummaryHtml(t) {
    const entries = t.entries || [];
    const exits   = t.exits   || [];
    const parts = [];
    if (entries.length > 0) {
      const CHIP_NUMS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
      parts.push(entries.map((e, i) => `<span class="fill-chip entry-chip">${CHIP_NUMS[i] || (i+1)} ${e.qty}ct @ ${e.price}</span>`).join(''));
    }
    if (exits.length > 0) {
      parts.push(exits.map(x => {
        const cls = (x.pnl || 0) >= 0 ? 'exit-chip-win' : 'exit-chip-loss';
        return `<span class="fill-chip ${cls}">${x.qty}ct @ ${x.price} ${x.pnl != null ? (x.pnl >= 0 ? `+$${x.pnl.toFixed(0)}` : `-$${Math.abs(x.pnl).toFixed(0)}`) : ''}</span>`;
      }).join(''));
    }
    return parts.join('<span class="fill-sep">→</span>');
  }

  // ── Fill Ladder modal ─────────────────────────────────────────────────────

  function _openLadder(id) {
    const t = _trades.find(x => x.id === id);
    if (!t) return;
    _ladderId = id;
    _renderLadder(t);
    $('ladder-modal').style.display = 'flex';
  }

  function _closeLadder() {
    $('ladder-modal').style.display = 'none';
    _ladderId = null;
  }

  function _renderLadder(t) {
    const entries = t.entries || [];
    const exits   = t.exits   || [];
    const dir     = t.direction || 'bullish';
    const pv      = POINT_VALUE[t.symbol] || 1;
    const avg     = _calcBlended(entries) ?? t.actualEntry;
    const totalCts   = entries.reduce((s, e) => s + e.qty, 0) || t.contracts || 0;
    const exitedCts  = exits.reduce((s, e) => s + e.qty, 0);
    const remainCts  = Math.max(0, totalCts - exitedCts);
    const totalPnl   = exits.reduce((s, e) => s + (e.pnl || 0), 0);
    const NUMS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];

    // Header
    const dirArrow = dir === 'bullish' ? '▲' : '▼';
    const dirCls   = dir === 'bullish' ? 'bull' : 'bear';
    $('lm-title').innerHTML = `🪜 <strong>${t.symbol}</strong> · <span class="${dirCls}">${dirArrow} ${dir.charAt(0).toUpperCase() + dir.slice(1)}</span> DCA Trade`;

    // Avg badge
    $('lm-avg-badge').textContent = avg != null ? `avg ${avg.toFixed(2)}` : 'avg —';
    $('lm-avg-badge').className = `lm-avg-badge ${dirCls}`;

    // Remain badge
    $('lm-remain-badge').textContent = `${remainCts} / ${totalCts} cts remaining`;
    $('lm-remain-badge').className   = `lm-remain-badge ${remainCts === 0 ? 'dim' : ''}`;

    // Stats footer
    $('lm-stats').innerHTML = [
      avg != null ? `<span>Avg Entry: <strong>${avg.toFixed(2)}</strong></span>` : '',
      `<span>Total: <strong>${totalCts} cts</strong></span>`,
      `<span>Remaining: <strong>${remainCts} cts</strong></span>`,
      exits.length > 0 ? `<span class="${totalPnl >= 0 ? 'bull' : 'bear'}">Realized: <strong>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</strong></span>` : '',
    ].filter(Boolean).join('<span class="lm-sep">·</span>');

    // P&L total panel
    if (exits.length > 0) {
      $('lm-pnl-total').innerHTML = `<span class="${totalPnl >= 0 ? 'bull' : 'bear'}">Realized P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</span>`;
    } else {
      $('lm-pnl-total').textContent = 'No exits yet';
    }

    // ── Entry ladder ─────────────────────────────────────────────────────────
    const entryEl = $('lm-entry-ladder');
    if (entries.length === 0) {
      entryEl.innerHTML = `<div class="lm-empty-fills">No entries yet — add your first fill below</div>`;
    } else {
      // Sort by price descending so highest is at top
      const sorted = [...entries].map((e, i) => ({ ...e, _orig: i })).sort((a, b) => b.price - a.price);
      const maxQty = Math.max(...entries.map(e => e.qty));
      entryEl.innerHTML = sorted.map(e => {
        const barPct = Math.round((e.qty / maxQty) * 100);
        const isAvg  = avg != null && Math.abs(e.price - avg) < 0.01;
        return `
          <div class="lm-fill-row entry-row ${isAvg ? 'is-avg' : ''}" data-orig="${e._orig}">
            <span class="lm-num">${NUMS[e._orig] || (e._orig + 1)}</span>
            <div class="lm-bar-wrap">
              <div class="lm-bar entry-bar" style="width:${barPct}%"></div>
            </div>
            <span class="lm-fill-qty">${e.qty} ct</span>
            <span class="lm-fill-price">@ ${e.price.toFixed(2)}</span>
            <span class="lm-fill-time">${_fmtTime(e.at)}</span>
            <button class="lm-rm-btn" data-type="entry" data-idx="${e._orig}" title="Remove">✕</button>
          </div>`;
      }).join('');

      // Avg line
      if (avg != null) {
        entryEl.insertAdjacentHTML('beforeend', `
          <div class="lm-avg-line">
            <span class="lm-avg-label ${dirCls}">══ avg ${avg.toFixed(2)} ══</span>
          </div>`);
      }
    }

    // ── Exit ladder ──────────────────────────────────────────────────────────
    const exitEl = $('lm-exit-ladder');
    if (exits.length === 0) {
      exitEl.innerHTML = `<div class="lm-empty-fills">No exits yet — log your first exit below</div>`;
    } else {
      const sorted = [...exits].map((e, i) => ({ ...e, _orig: i })).sort((a, b) => b.price - a.price);
      exitEl.innerHTML = sorted.map(x => {
        const pnlCls = (x.pnl || 0) >= 0 ? 'bull' : 'bear';
        const pnlStr = x.pnl != null ? `${x.pnl >= 0 ? '+' : ''}$${x.pnl.toFixed(2)}` : '—';
        return `
          <div class="lm-fill-row exit-row" data-orig="${x._orig}">
            <span class="lm-xnum">${x._orig + 1}</span>
            <div class="lm-bar-wrap">
              <div class="lm-bar exit-bar ${pnlCls}-bar"></div>
            </div>
            <span class="lm-fill-qty">${x.qty} ct</span>
            <span class="lm-fill-price">@ ${x.price.toFixed(2)}</span>
            <span class="lm-fill-pnl ${pnlCls}">${pnlStr}</span>
            <span class="lm-fill-time">${_fmtTime(x.at)}</span>
            <button class="lm-rm-btn" data-type="exit" data-idx="${x._orig}" title="Remove">✕</button>
          </div>`;
      }).join('');
    }

    // Remove buttons
    document.querySelectorAll('.lm-rm-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const type = btn.dataset.type;
        const idx  = btn.dataset.idx;
        await fetch(`/api/trades/${_ladderId}/${type}/${idx}`, { method: 'DELETE' });
        await _load();
      });
    });

    // ── Price visualization ───────────────────────────────────────────────────
    _renderViz(t, entries, exits, avg);

    // ── Wire add-entry inputs ─────────────────────────────────────────────────
    // Live P&L preview for exit
    const xPrice = $('lm-x-price');
    const xQty   = $('lm-x-qty');
    function _updatePnlPreview() {
      const p = parseFloat(xPrice.value);
      const q = parseInt(xQty.value) || 1;
      if (avg != null && !isNaN(p)) {
        const pnl = (dir === 'bullish' ? p - avg : avg - p) * q * pv;
        const el  = $('lm-pnl-preview');
        el.textContent = `≈ ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`;
        el.className   = `lm-pnl-preview ${pnl >= 0 ? 'bull' : 'bear'}`;
      }
    }
    xPrice.removeEventListener('input', _updatePnlPreview);
    xQty.removeEventListener('input', _updatePnlPreview);
    xPrice.addEventListener('input', _updatePnlPreview);
    xQty.addEventListener('input', _updatePnlPreview);
  }

  function _fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function _renderViz(t, entries, exits, avg) {
    const viz = $('lm-viz');
    const allPrices = [
      ...entries.map(e => e.price),
      ...exits.map(x => x.price),
      ...(avg != null ? [avg] : []),
      ...(t.actualTP ? [t.actualTP] : []),
      ...(t.actualSL ? [t.actualSL] : []),
    ];
    if (allPrices.length < 2) { viz.innerHTML = ''; return; }

    const minP = Math.min(...allPrices);
    const maxP = Math.max(...allPrices);
    const range = maxP - minP || 1;
    const toY = p => 100 - ((p - minP) / range * 86) - 7; // 7% padding top/bottom

    let svgLines = '';
    // TP / SL dotted lines
    if (t.actualTP) svgLines += `<line x1="0" y1="${toY(t.actualTP)}%" x2="100%" y2="${toY(t.actualTP)}%" stroke="rgba(38,166,154,0.4)" stroke-width="1" stroke-dasharray="4,3"/>
      <text x="3" y="${toY(t.actualTP)}%" dy="-3" fill="rgba(38,166,154,0.7)" font-size="8">TP</text>`;
    if (t.actualSL) svgLines += `<line x1="0" y1="${toY(t.actualSL)}%" x2="100%" y2="${toY(t.actualSL)}%" stroke="rgba(239,83,80,0.4)" stroke-width="1" stroke-dasharray="4,3"/>
      <text x="3" y="${toY(t.actualSL)}%" dy="-3" fill="rgba(239,83,80,0.7)" font-size="8">SL</text>`;
    // Avg line
    if (avg != null) svgLines += `<line x1="0" y1="${toY(avg)}%" x2="100%" y2="${toY(avg)}%" stroke="rgba(255,193,7,0.85)" stroke-width="1.5" stroke-dasharray="6,3"/>`;

    // Entry dots
    entries.forEach((e, i) => {
      const alpha = 0.4 + (0.6 / Math.max(entries.length, 1)) * (i + 1);
      svgLines += `<circle cx="30%" cy="${toY(e.price)}%" r="5" fill="rgba(33,150,243,${alpha})" stroke="rgba(33,150,243,0.9)" stroke-width="1"/>
        <text x="38%" y="${toY(e.price)}%" dy="4" fill="rgba(33,150,243,0.9)" font-size="8">${e.qty}ct</text>`;
    });

    // Exit dots
    exits.forEach(x => {
      const isWin = (x.pnl || 0) >= 0;
      const col   = isWin ? 'rgba(38,166,154,0.9)' : 'rgba(239,83,80,0.9)';
      svgLines += `<polygon points="70%,${toY(x.price)}% ${parseFloat('70')+4}%,${toY(x.price) - 3}% ${parseFloat('70')+4}%,${toY(x.price) + 3}%" fill="${col}"/>
        <text x="77%" y="${toY(x.price)}%" dy="4" fill="${col}" font-size="8">${x.qty}ct</text>`;
    });

    viz.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100%">${svgLines}</svg>`;
  }

  // ── Add entry/exit handlers ────────────────────────────────────────────────

  $('lm-add-entry').addEventListener('click', async () => {
    const qty   = parseInt($('lm-e-qty').value);
    const price = parseFloat($('lm-e-price').value);
    if (!qty || isNaN(price)) return;
    await fetch(`/api/trades/${_ladderId}/entry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qty, price }),
    });
    $('lm-e-qty').value = '';
    $('lm-e-price').value = '';
    await _load();
  });

  $('lm-add-exit').addEventListener('click', async () => {
    const qty   = parseInt($('lm-x-qty').value);
    const price = parseFloat($('lm-x-price').value);
    if (!qty || isNaN(price)) return;
    await fetch(`/api/trades/${_ladderId}/exit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qty, price }),
    });
    $('lm-x-qty').value   = '';
    $('lm-x-price').value = '';
    $('lm-pnl-preview').textContent = '';
    await _load();
  });

  // Enter key in ladder inputs
  $('lm-e-price').addEventListener('keydown', e => { if (e.key === 'Enter') $('lm-add-entry').click(); });
  $('lm-x-price').addEventListener('keydown', e => { if (e.key === 'Enter') $('lm-add-exit').click(); });

  $('lm-close').addEventListener('click', _closeLadder);
  $('ladder-modal').querySelector('.lm-backdrop').addEventListener('click', _closeLadder);

  // ── Edit modal ────────────────────────────────────────────────────────────

  function _openEdit(id) {
    const t = _trades.find(x => x.id === id);
    if (!t) return;
    _editId = id;
    $('em-entry').value     = t.actualEntry ?? '';
    $('em-tp').value        = t.actualTP    ?? '';
    $('em-sl').value        = t.actualSL    ?? '';
    $('em-exit').value      = t.actualExit  ?? '';
    $('em-contracts').value = t.contracts   ?? 1;
    $('em-pnl').value       = t.pnl         ?? '';
    $('em-outcome').value   = t.outcome     || '';
    $('em-sentiment').value = t.sentiment   || 'neutral';
    $('em-dca').checked     = !!t.dca;
    $('em-notes').value     = t.notes       || '';
    $('em-account').value   = t.accountId   || '';
    $('edit-modal').style.display = 'flex';
  }

  function _closeEdit() {
    $('edit-modal').style.display = 'none';
    _editId = null;
  }

  async function _saveEdit() {
    if (!_editId) return;
    const body = {
      actualEntry: parseFloat($('em-entry').value)   || null,
      actualTP:    parseFloat($('em-tp').value)      || null,
      actualSL:    parseFloat($('em-sl').value)      || null,
      actualExit:  $('em-exit').value !== '' ? parseFloat($('em-exit').value) : null,
      contracts:   parseInt($('em-contracts').value) || null,
      pnl:         $('em-pnl').value  !== '' ? parseFloat($('em-pnl').value)  : null,
      outcome:     $('em-outcome').value || null,
      sentiment:   $('em-sentiment').value,
      dca:         $('em-dca').checked,
      notes:       $('em-notes').value,
      ..._accountPayload($('em-account').value),
    };
    try {
      const r = await fetch(`/api/trades/${encodeURIComponent(_editId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(r.status);
      _closeEdit();
      await _load();
    } catch (e) { alert('Failed to save: ' + e.message); }
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function _deleteTrade(id) {
    const t = _trades.find(x => x.id === id);
    if (!t) return;
    if (!confirm(`Delete ${t.symbol} trade from ${_fmtDate(t.takenAt)}?`)) return;
    try {
      await fetch(`/api/trades/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await _load();
    } catch (e) { alert('Delete failed: ' + e.message); }
  }

  // ── Manual trade form ─────────────────────────────────────────────────────

  function _showManualForm(show) {
    $('manual-trade-form').style.display = show ? 'block' : 'none';
    if (show) {
      ['mt-entry','mt-tp','mt-sl','mt-exit','mt-pnl'].forEach(id => { $(id).value = ''; });
      $('mt-contracts').value = 1;
      $('mt-symbol').value    = 'MNQ';
      $('mt-tf').value        = '15m';
      $('mt-setup').value     = 'manual';
      $('mt-direction').value = 'bullish';
      $('mt-sentiment').value = 'bullish';
      $('mt-dca').checked     = false;
      $('mt-notes').value     = '';
    }
  }

  async function _saveManual() {
    const entry = parseFloat($('mt-entry').value);
    const sl    = parseFloat($('mt-sl').value);
    const tp    = parseFloat($('mt-tp').value);
    if (isNaN(entry) || isNaN(sl) || isNaN(tp)) { alert('Entry, TP, and SL are required.'); return; }
    const exitVal = $('mt-exit').value !== '' ? parseFloat($('mt-exit').value) : null;
    const pnlVal  = $('mt-pnl').value  !== '' ? parseFloat($('mt-pnl').value)  : null;
    const body = {
      symbol: $('mt-symbol').value, timeframe: $('mt-tf').value,
      setupType: $('mt-setup').value, direction: $('mt-direction').value,
      actualEntry: entry, actualSL: sl, actualTP: tp,
      actualExit: exitVal, contracts: parseInt($('mt-contracts').value) || 1,
      pnl: pnlVal, sentiment: $('mt-sentiment').value,
      dca: $('mt-dca').checked, notes: $('mt-notes').value, isManual: true,
      ..._accountPayload($('mt-account').value),
    };
    if (exitVal != null) {
      body.outcome = (body.direction === 'bullish' ? exitVal > entry : exitVal < entry) ? 'won' : 'lost';
    }
    try {
      const r = await fetch('/api/trades', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(r.status);
      const { trade } = await r.json();
      _showManualForm(false);
      await _load();
      // Auto-open ladder if DCA checked
      if ($('mt-dca').checked) _openLadder(trade.id);
    } catch (e) { alert('Failed to save: ' + e.message); }
  }

  // ── Sort header clicks ────────────────────────────────────────────────────

  document.querySelectorAll('#tl-table th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_sortKey === key) _sortAsc = !_sortAsc;
      else { _sortKey = key; _sortAsc = false; }
      document.querySelectorAll('#tl-table th').forEach(h => h.classList.remove('sort-asc','sort-desc'));
      th.classList.add(_sortAsc ? 'sort-asc' : 'sort-desc');
      _sort();
      _renderTable();
    });
  });

  // ── Wire controls ─────────────────────────────────────────────────────────

  ['filter-symbol','filter-outcome','filter-sentiment','filter-account','filter-date-from','filter-date-to']
    .forEach(id => $(id)?.addEventListener('change', _applyFilters));

  $('filter-clear').addEventListener('click', () => {
    ['filter-symbol','filter-outcome','filter-sentiment','filter-account'].forEach(id => { $(id).value = ''; });
    ['filter-date-from','filter-date-to'].forEach(id => { $(id).value = ''; });
    // Clear URL param too
    history.replaceState({}, '', location.pathname);
    document.querySelector('.tl-acct-heading')?.remove();
    _applyFilters();
  });

  $('btn-add-trade').addEventListener('click', () => _showManualForm(true));
  $('mt-save').addEventListener('click', _saveManual);
  $('mt-cancel').addEventListener('click', () => _showManualForm(false));
  $('em-save').addEventListener('click', _saveEdit);
  $('em-cancel').addEventListener('click', _closeEdit);
  $('edit-modal').querySelector('.em-backdrop').addEventListener('click', _closeEdit);

  // ── CSV Import ────────────────────────────────────────────────────────────

  let _importCsvText = null;
  let _importPreviewTrades = [];

  function _openImport() {
    $('import-modal').style.display = '';
    $('im-file').value = '';
    $('im-file-text').textContent = '📂 Choose CSV file…';
    $('im-preview').innerHTML = '';
    $('im-status').textContent = '';
    $('im-confirm').disabled = true;
    _importCsvText = null;
    _importPreviewTrades = [];
    // populate account dropdown
    const sel = $('im-account');
    sel.innerHTML = '<option value="">— None —</option>';
    for (const grp of $('filter-account').querySelectorAll('optgroup')) {
      const og = document.createElement('optgroup');
      og.label = grp.label;
      for (const opt of grp.querySelectorAll('option')) {
        const o = document.createElement('option');
        o.value = opt.value; o.textContent = opt.textContent;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
  }

  function _closeImport() { $('import-modal').style.display = 'none'; }

  function _fmtImportDir(d) { return d === 'bullish' ? '▲ Long' : '▼ Short'; }
  function _fmtPnl(v) {
    if (v == null) return '—';
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
  }

  async function _runDryRun(csvText) {
    $('im-status').textContent = 'Analyzing…';
    $('im-confirm').disabled = true;
    $('im-preview').innerHTML = '';
    try {
      const r = await fetch('/api/trades/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, dryRun: true }),
      });
      const data = await r.json();
      if (!r.ok) { $('im-status').textContent = '⚠ ' + (data.error || 'Parse error'); return; }
      _importPreviewTrades = data.trades || [];
      const dupMsg = data.duplicates > 0 ? ` (${data.duplicates} already imported)` : '';
      $('im-status').textContent = `${data.new} trade${data.new !== 1 ? 's' : ''} detected${dupMsg}`;
      if (data.new === 0) { $('im-preview').innerHTML = '<p class="im-empty">No new trades to import.</p>'; return; }

      const rows = _importPreviewTrades.map(t => {
        const entryDesc = t.entries.length === 1
          ? `${t.entries[0].qty} ct @ ${t.entries[0].price}`
          : `${t.entries.length} fills · avg ${t.actualEntry}`;
        const exitDesc = t.exits.length === 0 ? '<em>Open</em>'
          : t.exits.length === 1 ? `${t.exits[0].qty} ct @ ${t.exits[0].price}`
          : `${t.exits.length} exits`;
        const pnlCls  = t.pnl > 0 ? 'im-win' : t.pnl < 0 ? 'im-loss' : '';
        const datePart = t.openTime ? new Date(t.openTime).toLocaleDateString() : '—';
        return `<tr>
          <td>${datePart}</td>
          <td><strong>${t.symbol}</strong></td>
          <td class="${t.direction === 'bullish' ? 'bull' : 'bear'}">${_fmtImportDir(t.direction)}</td>
          <td>${entryDesc}</td>
          <td>${exitDesc}</td>
          <td class="${pnlCls}">${_fmtPnl(t.pnl)}</td>
          <td>${t.outcome || 'open'}</td>
        </tr>`;
      }).join('');

      $('im-preview').innerHTML = `
        <table class="im-table">
          <thead><tr><th>Date</th><th>Symbol</th><th>Dir</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Result</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      $('im-confirm').disabled = false;
      $('im-confirm').textContent = `Import ${data.new} Trade${data.new !== 1 ? 's' : ''}`;
    } catch (e) {
      $('im-status').textContent = '⚠ ' + e.message;
    }
  }

  $('im-file-label').addEventListener('click', () => $('im-file').click());
  $('im-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('im-file-text').textContent = '📄 ' + file.name;
    _importCsvText = await file.text();
    await _runDryRun(_importCsvText);
  });

  $('im-confirm').addEventListener('click', async () => {
    if (!_importCsvText) return;
    $('im-confirm').disabled = true;
    $('im-status').textContent = 'Importing…';
    const acctSel = $('im-account');
    const selectedId = acctSel.value;
    let accountId = null, accountLabel = null, accountType = null;
    if (selectedId) {
      accountId = selectedId;
      accountLabel = acctSel.options[acctSel.selectedIndex].textContent.trim();
      accountType  = selectedId.startsWith('pf:') ? 'propfirm' : 'realaccount';
    }
    try {
      const r = await fetch('/api/trades/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: _importCsvText, accountId, accountLabel, accountType }),
      });
      const data = await r.json();
      if (!r.ok) { $('im-status').textContent = '⚠ ' + (data.error || 'Import failed'); $('im-confirm').disabled = false; return; }
      const dupNote = data.duplicates > 0 ? `, ${data.duplicates} skipped (duplicate)` : '';
      $('im-status').textContent = `✓ Imported ${data.created} trade${data.created !== 1 ? 's' : ''}${dupNote}`;
      $('im-preview').innerHTML = '';
      setTimeout(_closeImport, 1200);
      _load();
    } catch (e) {
      $('im-status').textContent = '⚠ ' + e.message;
      $('im-confirm').disabled = false;
    }
  });

  $('btn-import-csv').addEventListener('click', _openImport);
  $('im-close').addEventListener('click', _closeImport);
  $('im-cancel').addEventListener('click', _closeImport);
  $('import-modal').querySelector('.im-backdrop').addEventListener('click', _closeImport);

  // ── Tab switching ─────────────────────────────────────────────────────────

  window.tlSwitchTab = function(tab) {
    const isFeesTab = tab === 'fees';
    $('tab-trades').classList.toggle('active', !isFeesTab);
    $('tab-fees').classList.toggle('active', isFeesTab);
    $('tl-table-wrap').style.display     = isFeesTab ? 'none' : '';
    $('fees-table-wrap').style.display   = isFeesTab ? '' : 'none';
    $('btn-import-csv').style.display    = isFeesTab ? 'none' : '';
    $('btn-import-fees').style.display   = isFeesTab ? '' : 'none';
    $('btn-add-trade').style.display     = isFeesTab ? 'none' : '';
    // Hide manual form when switching tabs
    $('manual-trade-form').style.display = 'none';
    if (isFeesTab) _loadFees();
  };

  // ── Fees ──────────────────────────────────────────────────────────────────

  let _feesImportCsvText = null;

  async function _loadFees() {
    try {
      const params = new URLSearchParams();
      const acctVal = $('filter-account').value;
      if (acctVal) params.set('accountId', acctVal);
      const sym = $('filter-symbol').value;
      if (sym) params.set('symbol', sym);
      const df = $('filter-date-from').value;
      if (df) params.set('dateFrom', df);
      const dt = $('filter-date-to').value;
      if (dt) params.set('dateTo', dt);
      const res = await fetch('/api/fees?' + params.toString());
      const { fees } = await res.json();
      _renderFees(fees);
      _updateFeesStat(fees);
    } catch(e) { console.error('[fees]', e); }
  }

  function _renderFees(fees) {
    const tbody = $('fees-tfoot') ? $('fees-tbody') : null;
    if (!tbody) return;
    if (!fees.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="tl-empty">No fees found. Import a TradeDay fees CSV.</td></tr>';
      $('fees-tfoot').innerHTML = '';
      $('fees-summary-bar').innerHTML = '';
      return;
    }

    // Aggregate by date+symbol for display
    const byDateSym = new Map();
    for (const f of fees) {
      const key = `${f.date}|${f.symbol}`;
      if (!byDateSym.has(key)) byDateSym.set(key, { date: f.date, symbol: f.symbol, accountLabel: f.accountLabel || f.sourceAccount || '—', exchange: 0, clearing: 0, nfa: 0, commission: 0, total: 0, fills: 0 });
      const g = byDateSym.get(key);
      g.exchange   += f.exchange;
      g.clearing   += f.clearing;
      g.nfa        += f.nfa;
      g.commission += f.commission;
      g.total      += f.total;
      g.fills++;
    }

    const rows = [...byDateSym.values()].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
    const fmt = v => '$' + Math.abs(v).toFixed(2);

    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.date}</td>
        <td><span class="sym-badge">${r.symbol}</span></td>
        <td class="fee-acct">${r.accountLabel}</td>
        <td class="fee-num">${fmt(r.exchange)}</td>
        <td class="fee-num">${fmt(r.clearing)}</td>
        <td class="fee-num">${fmt(r.nfa)}</td>
        <td class="fee-num">${fmt(r.commission)}</td>
        <td class="fee-num fee-total">${fmt(r.total)}</td>
      </tr>`).join('');

    // Totals footer
    const tot = rows.reduce((s, r) => {
      s.exchange += r.exchange; s.clearing += r.clearing;
      s.nfa += r.nfa; s.commission += r.commission; s.total += r.total; return s;
    }, { exchange: 0, clearing: 0, nfa: 0, commission: 0, total: 0 });
    $('fees-tfoot').innerHTML = `
      <tr class="fees-total-row">
        <td colspan="3">Total (${rows.length} day/symbol combos, ${fees.length} fills)</td>
        <td class="fee-num">${fmt(tot.exchange)}</td>
        <td class="fee-num">${fmt(tot.clearing)}</td>
        <td class="fee-num">${fmt(tot.nfa)}</td>
        <td class="fee-num">${fmt(tot.commission)}</td>
        <td class="fee-num fee-total">${fmt(tot.total)}</td>
      </tr>`;

    // Symbol summary chips
    const bySym = new Map();
    for (const r of rows) {
      if (!bySym.has(r.symbol)) bySym.set(r.symbol, 0);
      bySym.set(r.symbol, bySym.get(r.symbol) + r.total);
    }
    $('fees-summary-bar').innerHTML = [...bySym.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sym, t]) => `<span class="fee-chip"><span class="sym-badge">${sym}</span> ${fmt(t)}</span>`)
      .join('') + `<span class="fee-chip fee-chip-total">Total ${fmt(tot.total)}</span>`;
  }

  function _updateFeesStat(fees) {
    if (!fees) return;
    _totalFees = fees.reduce((s, f) => s + f.total, 0);
    const el = $('stat-fees');
    if (el) el.textContent = _totalFees > 0 ? `-$${_totalFees.toFixed(2)} fees` : '$0 fees';
    _renderSummary(); // recalculate net P&L with updated fees
  }

  // Open fees import modal
  function _openFeesImport() {
    _feesImportCsvText = null;
    $('fim-file-text').textContent = '📂 Choose CSV file…';
    $('fim-preview').innerHTML = '';
    $('fim-status').textContent = '';
    $('fim-confirm').disabled = true;
    $('fees-import-modal').style.display = 'flex';
  }
  function _closeFeesImport() { $('fees-import-modal').style.display = 'none'; }

  $('fim-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    $('fim-file-text').textContent = '📄 ' + file.name;
    const reader = new FileReader();
    reader.onload = ev => {
      _feesImportCsvText = ev.target.result;
      // Quick preview: count fee rows
      const lines = _feesImportCsvText.split('\n').filter(l => l.trim() && !l.startsWith('Account,'));
      const feeTypes = ['Exchange Fee', 'Clearing Fee', 'Nfa Fee', 'Commission'];
      const feeRows = lines.filter(l => feeTypes.some(t => l.includes(t)));
      const fillCount = Math.round(feeRows.length / 4);
      $('fim-preview').innerHTML = `<div class="im-preview-note">📊 ${feeRows.length} fee rows detected ≈ ${fillCount} round-turn fills</div>`;
      $('fim-confirm').disabled = false;
      $('fim-status').textContent = '';
    };
    reader.readAsText(file);
  });

  $('fim-confirm').addEventListener('click', async () => {
    if (!_feesImportCsvText) return;
    $('fim-confirm').disabled = true;
    $('fim-status').textContent = 'Importing…';
    const sel = $('fim-account').value;
    const acctOpt = $('fim-account').options[$('fim-account').selectedIndex];
    const { accountId, accountLabel, accountType } = _accountPayload ? _accountPayload(sel) : { accountId: sel, accountLabel: acctOpt?.text || '', accountType: '' };
    try {
      const r = await fetch('/api/fees/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: _feesImportCsvText, accountId, accountLabel, accountType }),
      });
      const data = await r.json();
      if (!r.ok) { $('fim-status').textContent = '⚠ ' + (data.error || 'Import failed'); $('fim-confirm').disabled = false; return; }
      const dupNote = data.duplicates > 0 ? `, ${data.duplicates} skipped (duplicate)` : '';
      $('fim-status').textContent = `✓ Imported ${data.created} fill${data.created !== 1 ? 's' : ''}${dupNote}`;
      setTimeout(() => { _closeFeesImport(); _loadFees(); }, 1200);
    } catch(e) { $('fim-status').textContent = '⚠ ' + e.message; $('fim-confirm').disabled = false; }
  });

  $('btn-import-fees').addEventListener('click', _openFeesImport);
  $('fim-close').addEventListener('click', _closeFeesImport);
  $('fim-cancel').addEventListener('click', _closeFeesImport);
  $('fees-import-modal').querySelector('.im-backdrop').addEventListener('click', _closeFeesImport);

  // ── Boot ──────────────────────────────────────────────────────────────────

  _loadAccounts().then(() => {
    _applyFilters();
  });
  _load();

  // Load fee total for summary bar on page load
  fetch('/api/fees').then(r => r.json()).then(({ fees }) => _updateFeesStat(fees)).catch(() => {});

})();
