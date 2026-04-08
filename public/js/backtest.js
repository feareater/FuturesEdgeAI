'use strict';
// Alert Replay / Backtester — fetches /api/alerts with date+symbol filters,
// renders chronological cards with P&L tracker and step-through mode.

(function () {

  // ── Instrument point values — loaded from server (instruments.js is source of truth) ──
  let POINT_VALUE = { MNQ: 2, MES: 5, MGC: 10, MCL: 100, SIL: 200, M2K: 5, MYM: 0.5, MHG: 2500 };
  fetch('/api/instruments').then(r => r.json()).then(data => {
    for (const [sym, meta] of Object.entries(data)) {
      if (meta.pointValue != null) POINT_VALUE[sym] = meta.pointValue;
    }
  }).catch(() => {});

  const TYPE_LABELS = {
    zone_rejection:  'Zone Rej',
    pdh_breakout:    'PDH',
    trendline_break: 'TL',
    or_breakout:     'OR',
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let _alerts   = [];   // filtered + sorted alerts
  let _stepIdx  = -1;   // current step-through index
  let _symFilter  = 'ALL';
  let _typeFilter = 'ALL';

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const startInput    = document.getElementById('bt-start');
  const endInput      = document.getElementById('bt-end');
  const minConfInput  = document.getElementById('bt-minconf');
  const contractsInput = document.getElementById('bt-contracts');
  const runBtn        = document.getElementById('bt-run');
  const prevBtn       = document.getElementById('bt-prev');
  const nextBtn       = document.getElementById('bt-next');
  const toDashBtn     = document.getElementById('bt-to-dashboard');
  const stepLabel     = document.getElementById('bt-step-label');
  const summaryEl     = document.getElementById('bt-summary');
  const feedEl        = document.getElementById('bt-feed');
  const equitySection = document.getElementById('equity-section');

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    // Default date range: past 7 days
    const today = new Date();
    const week  = new Date(today);
    week.setDate(week.getDate() - 7);
    startInput.value = week.toISOString().slice(0, 10);
    endInput.value   = today.toISOString().slice(0, 10);

    runBtn.addEventListener('click', run);

    // Symbol filter buttons
    document.querySelectorAll('.sym-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sym-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _symFilter = btn.dataset.sym;
      });
    });

    // Setup type filter buttons
    document.querySelectorAll('.type-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _typeFilter = btn.dataset.type;
      });
    });

    // Step through
    prevBtn.addEventListener('click', () => _step(-1));
    nextBtn.addEventListener('click', () => _step(1));

    toDashBtn.addEventListener('click', () => {
      if (_stepIdx < 0 || _stepIdx >= _alerts.length) return;
      const a = _alerts[_stepIdx];
      // Store in sessionStorage; dashboard reads this on focus
      sessionStorage.setItem('fe_highlight', JSON.stringify(a));
      window.open('/', '_blank');
    });
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  async function run() {
    runBtn.disabled = true;
    runBtn.textContent = '…';
    feedEl.innerHTML = '<div class="bt-placeholder">Loading…</div>';

    try {
      const params = new URLSearchParams({
        limit: 200,
        minConfidence: minConfInput.value || 0,
      });
      if (startInput.value) params.set('start', startInput.value + 'T00:00:00Z');
      if (endInput.value)   params.set('end',   endInput.value   + 'T23:59:59Z');
      if (_symFilter  !== 'ALL') params.set('symbol',  _symFilter);

      const res = await fetch(`/api/alerts?${params}`);
      if (!res.ok) throw new Error(`/api/alerts ${res.status}`);
      let { alerts } = await res.json();

      // Client-side type filter
      if (_typeFilter !== 'ALL') {
        alerts = alerts.filter(a => a.setup.type === _typeFilter);
      }

      // Sort oldest first for chronological replay
      alerts.sort((a, b) => a.setup.time - b.setup.time);
      _alerts  = alerts;
      _stepIdx = -1;

      _renderFeed();
      _renderSummary();
      _renderEquity();
      _updateStepUI();

    } catch (err) {
      feedEl.innerHTML = `<div class="bt-placeholder">Error: ${err.message}</div>`;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = 'Run';
    }
  }

  // ── Render feed ────────────────────────────────────────────────────────────

  function _renderFeed() {
    feedEl.innerHTML = '';
    if (!_alerts.length) {
      feedEl.innerHTML = '<div class="bt-placeholder">No alerts matched the filters.</div>';
      return;
    }

    const contracts = parseInt(contractsInput.value) || 1;

    _alerts.forEach((a, idx) => {
      const card = _buildCard(a, contracts, idx);
      feedEl.appendChild(card);
    });
  }

  function _buildCard(a, contracts, idx) {
    const { symbol, timeframe, setup } = a;
    const dir      = setup.direction === 'bullish' ? '▲' : '▼';
    const dirCls   = setup.direction === 'bullish' ? 'bt-dir-bull' : 'bt-dir-bear';
    const pnl      = _calcPnl(a, contracts);
    const pnlText  = pnl != null
      ? `${pnl >= 0 ? '+' : ''}$${pnl}`
      : '';
    const pnlCls   = pnl == null ? '' : pnl >= 0 ? 'bt-pnl-pos' : 'bt-pnl-neg';
    const outCls   = `outcome-${setup.outcome}`;
    const outLabel = { won: '✓ Won', lost: '✗ Lost', open: '○ Open' }[setup.outcome] ?? '—';
    const outFmtCls = `bt-outcome-${setup.outcome || 'open'}`;
    const timeStr  = new Date(setup.time * 1000).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    });

    const card = document.createElement('div');
    card.className    = `bt-card ${outCls}`;
    card.dataset.idx  = idx;

    card.innerHTML = `
      <div class="bt-card-header">
        <span class="bt-sym">${symbol}</span>
        <span class="bt-tf">${timeframe}</span>
        <span class="bt-type">${TYPE_LABELS[setup.type] || setup.type}</span>
        <span class="${dirCls}">${dir}</span>
      </div>
      <div class="bt-card-prices">
        Entry&nbsp;<span>${_fmt(setup.entry ?? setup.price)}</span>
        SL&nbsp;<span>${_fmt(setup.sl)}</span>
        TP&nbsp;<span>${_fmt(setup.tp)}</span>
      </div>
      <div class="bt-card-footer">
        <span class="bt-conf">${setup.confidence}%</span>
        <span class="${outFmtCls}">${outLabel}</span>
        ${pnlText ? `<span class="${pnlCls}">${pnlText}</span>` : ''}
        <span class="bt-time">${timeStr} ET</span>
      </div>
    `;

    card.addEventListener('click', () => _setStep(idx));
    return card;
  }

  function _fmt(n) { return n != null ? n.toFixed(2) : '—'; }

  // ── P&L calculation ────────────────────────────────────────────────────────

  function _calcPnl(alert, contracts) {
    const { entry, sl, tp, direction, outcome } = alert.setup;
    if (entry == null || sl == null || tp == null || outcome === 'open') return null;
    const pv = POINT_VALUE[alert.symbol];
    if (!pv) return null;
    const pts = outcome === 'won'
      ? Math.abs(tp - entry)   * (direction === 'bullish' ? 1 : 1)
      : -Math.abs(entry - sl);
    return Math.round(pts * pv * contracts);
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  function _renderSummary() {
    const contracts = parseInt(contractsInput.value) || 1;
    const resolved  = _alerts.filter(a => a.setup.outcome !== 'open');
    const won       = resolved.filter(a => a.setup.outcome === 'won').length;
    const lost      = resolved.filter(a => a.setup.outcome === 'lost').length;
    const wr        = resolved.length > 0 ? Math.round(won / resolved.length * 100) : null;
    const totalPnl  = _alerts.reduce((sum, a) => sum + (_calcPnl(a, contracts) ?? 0), 0);
    const sign      = totalPnl >= 0 ? '+' : '';

    summaryEl.innerHTML =
      `<strong>${_alerts.length}</strong> alerts  · ` +
      `W&nbsp;<strong>${won}</strong>  L&nbsp;<strong>${lost}</strong>` +
      (wr != null ? `  · WR <strong>${wr}%</strong>` : '') +
      `  · P&amp;L <strong class="${totalPnl >= 0 ? 'bt-pnl-pos' : 'bt-pnl-neg'}">${sign}$${totalPnl}</strong>`;
  }

  // ── Equity curve ───────────────────────────────────────────────────────────

  function _renderEquity() {
    const contracts = parseInt(contractsInput.value) || 1;
    const barsEl    = document.getElementById('equity-bars');
    const axisEl    = document.getElementById('equity-axis');
    if (!barsEl) return;

    const resolved = _alerts.filter(a => _calcPnl(a, contracts) != null);
    if (!resolved.length) { equitySection.style.display = 'none'; return; }

    equitySection.style.display = '';
    barsEl.innerHTML = '';
    axisEl.innerHTML = '';

    // Build cumulative curve
    let cumulative = 0;
    const curve = resolved.map(a => {
      const pnl = _calcPnl(a, contracts);
      cumulative += pnl;
      return cumulative;
    });

    const maxAbs = Math.max(1, ...curve.map(Math.abs));

    for (const val of curve) {
      const pct  = Math.abs(val) / maxAbs;
      const h    = Math.max(2, Math.round(pct * 76));
      const bar  = document.createElement('div');
      bar.className = `eq-bar ${val >= 0 ? 'eq-pos' : 'eq-neg'}`;
      bar.style.height = `${h}px`;
      bar.title  = `${val >= 0 ? '+' : ''}$${val}`;
      barsEl.appendChild(bar);
    }

    const start = curve[0];
    const end   = curve[curve.length - 1];
    axisEl.innerHTML =
      `<span>${start >= 0 ? '+' : ''}$${start}</span>` +
      `<span style="color:${end >= 0 ? 'var(--bull)' : 'var(--bear)'};font-weight:700">${end >= 0 ? '+' : ''}$${end}</span>`;
  }

  // ── Step-through ───────────────────────────────────────────────────────────

  function _step(dir) {
    _setStep(Math.max(0, Math.min(_alerts.length - 1, _stepIdx + dir)));
  }

  function _setStep(idx) {
    _stepIdx = idx;
    _updateStepUI();

    // Highlight active card
    document.querySelectorAll('.bt-card').forEach(c => c.classList.remove('is-active'));
    const card = feedEl.querySelector(`[data-idx="${idx}"]`);
    if (card) {
      card.classList.add('is-active');
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function _updateStepUI() {
    const hasAlerts = _alerts.length > 0;
    prevBtn.disabled   = !hasAlerts || _stepIdx <= 0;
    nextBtn.disabled   = !hasAlerts || _stepIdx >= _alerts.length - 1;
    toDashBtn.disabled = _stepIdx < 0 || _stepIdx >= _alerts.length;

    if (_stepIdx >= 0 && _stepIdx < _alerts.length) {
      stepLabel.textContent = `${_stepIdx + 1} / ${_alerts.length}`;
    } else if (hasAlerts) {
      stepLabel.textContent = `0 / ${_alerts.length}`;
      _setStep(0); // auto-select first
    } else {
      stepLabel.textContent = '—';
    }
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  init();

})();
