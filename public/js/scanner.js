'use strict';
// FuturesEdge AI — Scanner page
// Displays all active setups across every symbol × timeframe in a live,
// sortable, filterable table. Connects via WebSocket for instant updates.

(function () {

  // ── State ──────────────────────────────────────────────────────────────────
  let allAlerts   = [];   // raw from server (newest-first)
  let sortCol     = 'confidence';
  let sortDir     = 'desc';
  let filterDir   = 'ALL';
  let filterType  = 'ALL';
  let filterSym   = 'ALL';
  let filterStatus = 'open';
  let mtfOnly     = false;
  let minConf     = 65;

  // Track which alert keys we've seen so new rows can be flashed
  let prevKeys = new Set();

  // ── DOM ────────────────────────────────────────────────────────────────────
  const tbody         = document.getElementById('scan-body');
  const scCount       = document.getElementById('sc-count');
  const scMtf         = document.getElementById('sc-mtf-count');
  const scBull        = document.getElementById('sc-bull-count');
  const scBear        = document.getElementById('sc-bear-count');
  const scTs          = document.getElementById('sc-ts');
  const wsDot         = document.getElementById('sc-ws-dot');
  const minConfEl     = document.getElementById('sc-minconf');
  const mtfOnlyEl     = document.getElementById('sc-mtf-only');
  const scanCards     = document.getElementById('scan-cards');
  const scanTableWrap = document.getElementById('scan-table-wrap');
  const filterToggle  = document.getElementById('sc-filter-toggle');
  const scCountInline = document.getElementById('sc-count-inline');
  const filtersEl     = document.querySelector('.scan-filters');

  // ── Setup type labels ──────────────────────────────────────────────────────
  const TYPE_LABEL = {
    zone_rejection: 'Zone Rej',
    pdh_breakout:   'PDH Break',
    or_breakout:    'OR Break',
    trendline_break:'TL Break',
    bos_retest:     'BOS Retest',
  };

  // ── Mobile detection ───────────────────────────────────────────────────────

  function _isMobile() {
    return window.matchMedia('(max-width: 767px)').matches;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _alertKey(a) {
    return `${a.symbol}:${a.timeframe}:${a.setup.type}:${a.setup.time}`;
  }

  function _age(ts) {
    const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (secs < 60)          return `${secs}s`;
    if (secs < 3600)        return `${Math.floor(secs / 60)}m`;
    if (secs < 86400)       return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
  }

  function _px(price, sym) {
    if (price == null || isNaN(price)) return '—';
    const decimals = sym === 'XRP' ? 4 : sym === 'MCL' ? 2
                   : sym === 'ETH' ? 2 : sym === 'BTC' ? 0
                   : 2;
    return price.toFixed(decimals);
  }

  // ── Filter + sort ──────────────────────────────────────────────────────────

  function _filtered() {
    return allAlerts.filter(a => {
      if (a.setup.confidence < minConf)          return false;
      if (filterDir  !== 'ALL' && a.setup.direction !== filterDir)  return false;
      if (filterType !== 'ALL' && a.setup.type      !== filterType) return false;
      if (filterSym  !== 'ALL' && a.symbol           !== filterSym)  return false;
      if (filterStatus === 'open' && a.setup.outcome !== 'open')    return false;
      if (mtfOnly && !a.setup.mtfConfluence)                        return false;
      return true;
    });
  }

  const TF_ORDER = { '5m':0, '15m':1, '30m':2, '1h':3, '2h':4, '4h':5 };

  function _sorted(list) {
    const mult = sortDir === 'asc' ? 1 : -1;
    return list.slice().sort((a, b) => {
      let va, vb;
      switch (sortCol) {
        case 'symbol':     va = a.symbol;         vb = b.symbol;         break;
        case 'timeframe':  va = TF_ORDER[a.timeframe] ?? 99;
                           vb = TF_ORDER[b.timeframe] ?? 99;             break;
        case 'type':       va = a.setup.type;     vb = b.setup.type;     break;
        case 'direction':  va = a.setup.direction; vb = b.setup.direction; break;
        case 'confidence': va = a.setup.confidence; vb = b.setup.confidence; break;
        case 'regime':     va = a.regime?.type ?? '';  vb = b.regime?.type ?? ''; break;
        case 'mtf':        va = a.setup.mtfConfluence ? 1 : 0;
                           vb = b.setup.mtfConfluence ? 1 : 0;           break;
        case 'age':        va = new Date(a.ts).getTime();
                           vb = new Date(b.ts).getTime();                break;
        default:           va = 0; vb = 0;
      }
      if (typeof va === 'string') return mult * va.localeCompare(vb);
      return mult * (va - vb);
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function _buildAlertParts(a) {
    const key      = _alertKey(a);
    const conf     = a.setup.confidence;
    const confCls  = conf >= 80 ? 'high' : conf >= 65 ? 'med' : 'low';
    const dirCls   = a.setup.direction === 'bullish' ? 'sc-dir-long' : 'sc-dir-short';
    const dirArrow = a.setup.direction === 'bullish' ? '▲ Long' : '▼ Short';
    const regime   = a.regime || {};
    const regDir   = regime.direction || regime.dir || '';
    const regClass = regime.type === 'trend' && regDir === 'bullish' ? 'trend-bull'
                   : regime.type === 'trend' && regDir === 'bearish' ? 'trend-bear'
                   : 'range-neut';
    const regLabel = regime.type === 'trend'
      ? `Trend ${regDir === 'bullish' ? '▲' : '▼'}`
      : 'Range';
    const mtf      = a.setup.mtfConfluence;
    const eventBadge = a.setup.nearEvent
      ? '<span class="sc-event-badge">⚠</span>' : '';
    return { key, conf, confCls, dirCls, dirArrow, regClass, regLabel, mtf, eventBadge };
  }

  function _renderTable(sorted, newKeys) {
    if (scanTableWrap) scanTableWrap.style.display = '';
    if (scanCards)     scanCards.style.display = 'none';

    if (sorted.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="scan-empty">No setups match current filters.</td></tr>';
      return;
    }

    const rows = sorted.map(a => {
      const isNew = !prevKeys.has(_alertKey(a));
      const { key, conf, confCls, dirCls, dirArrow, regClass, regLabel, mtf, eventBadge } = _buildAlertParts(a);
      const mtfCell = mtf
        ? mtf.tfs.map(tf => `<span class="sc-mtf-pill">${tf}</span>`).join('')
        : '<span class="sc-mtf-none">—</span>';
      return `<tr class="${isNew ? 'row-new' : ''}" data-key="${key}">
        <td><span class="sc-sym">${a.symbol}</span>${eventBadge}</td>
        <td><span class="sc-tf">${a.timeframe}</span></td>
        <td><span class="sc-type">${TYPE_LABEL[a.setup.type] || a.setup.type}</span></td>
        <td><span class="${dirCls}">${dirArrow}</span></td>
        <td>
          <div class="sc-conf-wrap">
            <div class="sc-conf-bar"><div class="sc-conf-fill ${confCls}" style="width:${conf}%"></div></div>
            <span class="sc-conf-val">${conf}</span>
          </div>
        </td>
        <td>${_px(a.setup.entry, a.symbol)}</td>
        <td>${_px(a.setup.tp,    a.symbol)}</td>
        <td>${_px(a.setup.sl,    a.symbol)}</td>
        <td><span class="sc-regime ${regClass}">${regLabel}</span></td>
        <td><div class="sc-mtf">${mtfCell}</div></td>
        <td><span class="sc-age">${_age(a.ts)}</span></td>
        <td><button class="sc-view-btn" data-key="${key}">View ↗</button></td>
      </tr>`;
    }).join('');

    tbody.innerHTML = rows;

    tbody.querySelectorAll('.sc-view-btn').forEach(btn => {
      btn.addEventListener('click', () => _jumpToChart(btn.dataset.key));
    });
  }

  function _renderCards(sorted, newKeys) {
    if (scanTableWrap) scanTableWrap.style.display = 'none';
    if (scanCards)     scanCards.style.display = '';

    if (sorted.length === 0) {
      scanCards.innerHTML = '<div class="sc-cards-empty">No setups match current filters.</div>';
      return;
    }

    const cards = sorted.map(a => {
      const isNew = !prevKeys.has(_alertKey(a));
      const { key, conf, confCls, dirCls, dirArrow, regClass, regLabel, mtf, eventBadge } = _buildAlertParts(a);
      const isBull = a.setup.direction === 'bullish';
      const mtfHtml = mtf
        ? `<div class="sc-card-mtf">${mtf.tfs.map(tf => `<span class="sc-mtf-pill">${tf}</span>`).join('')}</div>`
        : '';
      const rationale = a.setup.rationale
        ? `<div class="sc-card-rationale">${a.setup.rationale}</div>`
        : '';
      return `<div class="sc-card ${isBull ? 'bull' : 'bear'} ${isNew ? 'card-new' : ''}" data-key="${key}">
        <div class="sc-card-header">
          <span class="sc-sym">${a.symbol}</span>
          <span class="sc-tf">${a.timeframe}</span>
          <span class="sc-type">${TYPE_LABEL[a.setup.type] || a.setup.type}</span>
          <span class="${dirCls}">${dirArrow}</span>
          ${eventBadge}
          <span class="sc-card-age">${_age(a.ts)}</span>
        </div>
        <div class="sc-card-meta">
          <div class="sc-conf-wrap sc-conf-wide">
            <div class="sc-conf-bar"><div class="sc-conf-fill ${confCls}" style="width:${conf}%"></div></div>
            <span class="sc-conf-val">${conf}%</span>
          </div>
          ${mtfHtml}
          <span class="sc-regime ${regClass}">${regLabel}</span>
        </div>
        <div class="sc-card-levels">
          <span class="sc-card-level"><span class="sc-level-label">Entry</span><span class="sc-level-val">${_px(a.setup.entry, a.symbol)}</span></span>
          <span class="sc-card-level"><span class="sc-level-label tp">TP</span><span class="sc-level-val tp">${_px(a.setup.tp, a.symbol)}</span></span>
          <span class="sc-card-level"><span class="sc-level-label sl">SL</span><span class="sc-level-val sl">${_px(a.setup.sl, a.symbol)}</span></span>
        </div>
        ${rationale}
        <button class="sc-view-btn sc-view-btn-full" data-key="${key}">View on Chart ↗</button>
      </div>`;
    }).join('');

    scanCards.innerHTML = cards;

    scanCards.querySelectorAll('.sc-view-btn').forEach(btn => {
      btn.addEventListener('click', () => _jumpToChart(btn.dataset.key));
    });
  }

  function _jumpToChart(key) {
    const alert = allAlerts.find(a => _alertKey(a) === key);
    if (!alert) return;
    sessionStorage.setItem('bt_jump', JSON.stringify({
      symbol:    alert.symbol,
      timeframe: alert.timeframe,
      setupTime: alert.setup.time,
    }));
    window.location.href = '/';
  }

  function _render() {
    const filtered = _filtered();
    const sorted   = _sorted(filtered);
    const newKeys  = new Set(sorted.map(_alertKey));

    // Summary counts
    const mtfCount  = filtered.filter(a => a.setup.mtfConfluence).length;
    const bullCount = filtered.filter(a => a.setup.direction === 'bullish').length;
    const bearCount = filtered.filter(a => a.setup.direction === 'bearish').length;
    scCount.textContent = `${sorted.length} setup${sorted.length !== 1 ? 's' : ''}`;
    scMtf.textContent   = `${mtfCount} with MTF`;
    scBull.textContent  = `${bullCount} long`;
    scBear.textContent  = `${bearCount} short`;
    if (scCountInline) scCountInline.textContent = `${sorted.length} setup${sorted.length !== 1 ? 's' : ''}`;

    if (_isMobile()) {
      _renderCards(sorted, newKeys);
    } else {
      _renderTable(sorted, newKeys);
    }

    prevKeys = newKeys;
    _scheduleAgeUpdate();
  }

  // ── Age ticker ─────────────────────────────────────────────────────────────
  let _ageTimer = null;

  function _scheduleAgeUpdate() {
    clearTimeout(_ageTimer);
    _ageTimer = setTimeout(() => {
      // Update ages in table rows
      tbody.querySelectorAll('.sc-age').forEach(el => {
        const row = el.closest('tr');
        if (!row) return;
        const alert = allAlerts.find(a => _alertKey(a) === row.dataset.key);
        if (alert) el.textContent = _age(alert.ts);
      });
      // Update ages in cards
      if (scanCards) {
        scanCards.querySelectorAll('.sc-card-age').forEach(el => {
          const card = el.closest('.sc-card');
          if (!card) return;
          const alert = allAlerts.find(a => _alertKey(a) === card.dataset.key);
          if (alert) el.textContent = _age(alert.ts);
        });
      }
      _scheduleAgeUpdate();
    }, 30_000);
  }

  // ── Sort headers ───────────────────────────────────────────────────────────

  document.querySelectorAll('#scan-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortCol === col) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortCol = col;
        sortDir = col === 'age' ? 'desc' : 'desc';
      }
      // Update header classes
      document.querySelectorAll('#scan-table th').forEach(h => {
        h.classList.remove('sorted-asc', 'sorted-desc');
      });
      th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      _render();
    });
  });

  // ── Filter controls ────────────────────────────────────────────────────────

  function _bindToggle(selector, stateKey, onChange) {
    document.querySelectorAll(selector).forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(selector).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(btn.dataset[stateKey] || btn.dataset.sym || btn.dataset.status || btn.dataset.dir || btn.dataset.type);
        _render();
      });
    });
  }

  _bindToggle('.dir-btn',    'dir',    v => { filterDir    = v; });
  _bindToggle('.type-btn',   'type',   v => { filterType   = v; });
  _bindToggle('.sym-btn',    'sym',    v => { filterSym    = v; });
  _bindToggle('.status-btn', 'status', v => { filterStatus = v; });

  minConfEl.addEventListener('change', () => {
    minConf = parseInt(minConfEl.value) || 0;
    _render();
  });

  mtfOnlyEl.addEventListener('change', () => {
    mtfOnly = mtfOnlyEl.checked;
    _render();
  });

  // ── Data fetch ─────────────────────────────────────────────────────────────

  async function fetchAlerts() {
    try {
      const res  = await fetch('/api/alerts?limit=100');
      const data = await res.json();
      // API returns { alerts: [...] } wrapper
      allAlerts  = Array.isArray(data) ? data : (Array.isArray(data.alerts) ? data.alerts : []);
      scTs.textContent = `updated ${new Date().toLocaleTimeString()}`;
      _render();
    } catch (err) {
      console.error('[scanner] fetch error:', err.message);
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  function _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
      wsDot.className = 'sc-ws-dot connected';
    });

    ws.addEventListener('close', () => {
      wsDot.className = 'sc-ws-dot disconnected';
      setTimeout(_connect, 3000);
    });

    ws.addEventListener('error', () => {
      wsDot.className = 'sc-ws-dot disconnected';
    });

    ws.addEventListener('message', e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'setup') {
          // Prepend new alert and re-render
          const key = `${msg.symbol}:${msg.timeframe}:${msg.setup.type}:${msg.setup.time}`;
          if (!allAlerts.find(a => _alertKey(a) === key)) {
            allAlerts.unshift({
              symbol:    msg.symbol,
              timeframe: msg.timeframe,
              regime:    msg.regime,
              setup:     msg.setup,
              ts:        msg.ts || new Date().toISOString(),
            });
            if (allAlerts.length > 100) allAlerts.pop();
          }
          scTs.textContent = `updated ${new Date().toLocaleTimeString()}`;
          _render();
        } else if (msg.type === 'data_refresh') {
          fetchAlerts();
        } else if (msg.type === 'outcome_update') {
          const alert = allAlerts.find(a => _alertKey(a) === msg.key);
          if (alert) { alert.setup.outcome = msg.outcome; _render(); }
        }
      } catch {}
    });
  }

  // ── Filter toggle (mobile) ─────────────────────────────────────────────────

  if (filterToggle && filtersEl) {
    filterToggle.addEventListener('click', () => {
      const hidden = filtersEl.classList.toggle('sc-filters-hidden');
      filterToggle.classList.toggle('active', !hidden);
    });
    // Hide filters by default on mobile
    if (_isMobile()) filtersEl.classList.add('sc-filters-hidden');
  }

  // Re-render on orientation/resize (switch between table and card layout)
  window.addEventListener('resize', () => _render());

  // ── Init ───────────────────────────────────────────────────────────────────

  fetchAlerts();
  _connect();

})();
