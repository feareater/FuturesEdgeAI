'use strict';
// Alert feed — loads alerts from REST, connects WebSocket for live pushes.
// Supports confidence filtering, per-symbol dollar risk calculation, and
// win-rate stats that update in real-time as the confidence threshold changes.
// Click a card to highlight the setup on the chart.
// Features: symbol+TF sync filter, refresh countdown, new-alert highlight, trade log.

(function () {

  // ── Contract specs — tick-based (per exchange spec) ──────────────────────
  // MNQ: tick = 0.25 pts, tick value = $0.50/contract  →  $2.00 / point
  // MGC: tick = 0.10 pts, tick value = $1.00/contract  →  $10.00 / point
  // MES: tick = 0.25 pts, tick value = $1.25/contract  →  $5.00 / point
  // MCL: tick = 0.01 pts, tick value = $1.00/contract  →  $100 / point
  const TICK_SIZE  = { MNQ: 0.25, MGC: 0.10, MES: 0.25, MCL: 0.01 };
  const TICK_VALUE = { MNQ: 0.50, MGC: 1.00, MES: 1.25, MCL: 1.00 };

  // ── Settings (loaded from server defaults, overridden by localStorage) ─────
  let cfg = { mnqContracts: 5, mgcContracts: 3, mesContracts: 2, mclContracts: 2,
              maxRiskDollars: 200, rrRatio: 2.0, features: {} };
  let minConf = 65;

  // Sound alerts enabled flag (toggleable by feature panel)
  window._soundAlertsEnabled = false;

  // ── Active chart view — synced from chart.js via chartViewChange event ──────
  let activeSymbol = 'MNQ';
  let activeTf     = '5m';

  // Raw alerts from the last fetch (one per confidence threshold query)
  let currentAlerts = [];

  // ── Trade log (alertKey → trade object) ───────────────────────────────────
  const takenTrades = new Map();
  // Bridge for chart.js (which loads first) to check taken state
  window._isTaken = (key) => takenTrades.has(key);

  // ── Taken+open alerts across all symbols ──────────────────────────────────
  // Persisted to localStorage so the section survives symbol changes and reloads.
  const takenOpenAlertData = new Map(); // alertKey → full alert object
  const _TAKEN_OPEN_LS = 'futuresedge_taken_open';

  function _saveTakenOpen() {
    try {
      localStorage.setItem(_TAKEN_OPEN_LS, JSON.stringify([...takenOpenAlertData.values()]));
    } catch {}
  }

  // ── Manual trades (not tied to detected setups) ────────────────────────────
  const manualTrades = [];

  // ── New-alert highlighting state ──────────────────────────────────────────
  let _prevAlertKeys = new Set();

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const alertFeed      = document.getElementById('alert-feed');
  const wrWon          = document.getElementById('wr-won');
  const wrLost         = document.getElementById('wr-lost');
  const wrOpen         = document.getElementById('wr-open');
  const wrPct          = document.getElementById('wr-pct');
  const minConfInput   = document.getElementById('min-conf');
  const mnqInput       = document.getElementById('mnq-contracts');
  const mgcInput       = document.getElementById('mgc-contracts');
  const maxRiskInput   = document.getElementById('max-risk');
  const rrInput        = document.getElementById('rr-ratio');
  const rrStatusEl        = document.getElementById('rr-status');
  const sessionBadgeEl    = document.getElementById('session-badge');
  const dataAgeEl         = document.getElementById('data-age');
  const refreshIntervalEl = document.getElementById('refresh-interval');
  const refreshNowBtn     = document.getElementById('refresh-now-btn');
  const logTradeBtnEl     = document.getElementById('log-trade-btn');
  const manualFormEl      = document.getElementById('manual-trade-form');

  // ── Mobile tab DOM refs ────────────────────────────────────────────────────
  const rightPanel      = document.getElementById('right-panel');
  const tabAlertBadge   = document.getElementById('tab-alert-badge');

  // ── AutoTrader DOM refs ────────────────────────────────────────────────────
  const atToggleBtn    = document.getElementById('at-toggle-btn');
  const atStatusDot    = document.getElementById('at-status-dot');
  const atPositionRow  = document.getElementById('at-position-row');
  const atSummaryRow   = document.getElementById('at-summary-row');
  const atMinConfInput = document.getElementById('at-min-conf');
  const atLastOrderEl  = document.getElementById('at-last-order');

  // ── Data freshness display + countdown ────────────────────────────────────

  let _lastRefreshTs = null;
  let _nextRefreshTs = null;

  function _setRefreshTimes(lastTs, nextTs) {
    if (lastTs) _lastRefreshTs = lastTs;
    if (nextTs) _nextRefreshTs = nextTs;
    _tickDataAge();
  }

  function _tickDataAge() {
    if (!dataAgeEl) return;
    let text = '—';
    if (_lastRefreshTs) {
      const t = new Date(_lastRefreshTs).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: 'America/Denver',
      });
      text = `Data: ${t} MT`;
    }
    if (_nextRefreshTs) {
      const secsLeft = Math.max(0, Math.round((new Date(_nextRefreshTs) - Date.now()) / 1000));
      const m = Math.floor(secsLeft / 60);
      const s = secsLeft % 60;
      text += ` · ${m}:${s.toString().padStart(2, '0')}`;
    }
    if (dataAgeEl) dataAgeEl.textContent = text;
  }

  // ── Session badge ──────────────────────────────────────────────────────────

  function _updateSessionBadge() {
    const h = new Date().getUTCHours();
    let label, cls;
    if (h >= 14 && h < 21)     { label = 'RTH';         cls = 'session-rth'; }
    else if (h >= 21 || h < 1) { label = 'After-hours'; cls = 'session-eth'; }
    else                        { label = 'Pre-market';  cls = 'session-pre'; }
    if (sessionBadgeEl) {
      sessionBadgeEl.textContent = label;
      sessionBadgeEl.className   = `session-badge ${cls}`;
    }
    // Update calendar event countdown badge
    if (cfg.features?.economicCalendar) _updateCalendarBadge();
    // Update RS widget
    if (cfg.features?.relativeStrength && (activeSymbol === 'MNQ' || activeSymbol === 'MES')) {
      _updateRSWidget();
    }
  }

  // ── Calendar event badge ────────────────────────────────────────────────────

  const calendarBadgeEl = document.getElementById('calendar-badge');

  async function _updateCalendarBadge() {
    try {
      const res = await fetch(`/api/calendar?symbol=${activeSymbol}`);
      if (!res.ok) return;
      const { events } = await res.json();
      const now   = Date.now() / 1000;
      const limit = now + 3 * 3600; // 3h window
      const next  = events.find(e => e.impact === 'high' && e.time >= now && e.time <= limit);
      if (!calendarBadgeEl) return;
      if (next) {
        const minsAway = Math.round((next.time - now) / 60);
        const display  = minsAway >= 60
          ? `${Math.floor(minsAway / 60)}h ${minsAway % 60}m`
          : `${minsAway}m`;
        calendarBadgeEl.textContent = `⚠ ${next.title.split(' ').slice(0, 2).join(' ')} in ${display}`;
        calendarBadgeEl.style.display = '';
      } else {
        calendarBadgeEl.style.display = 'none';
      }
    } catch (_) {}
  }

  // ── RS (Relative Strength) widget ──────────────────────────────────────────

  const rsWidget = document.getElementById('rs-widget');
  const rsRatioEl = document.getElementById('rs-ratio');
  const rsSignalEl = document.getElementById('rs-signal');

  async function _updateRSWidget() {
    try {
      const res = await fetch('/api/relativestrength?base=MNQ&compare=MES');
      if (!res.ok) return;
      const { ratio, correlation, signal } = await res.json();
      if (!rsWidget) return;
      rsWidget.style.display = '';
      if (rsRatioEl) {
        rsRatioEl.textContent = ratio?.toFixed(3) ?? '—';
        rsRatioEl.className   = 'rs-ratio' + (ratio > 1.02 ? ' rs-leading' : ratio < 0.98 ? ' rs-lagging' : '');
      }
      if (rsSignalEl) {
        const labels = { mnq_leading: 'MNQ ▲', mes_leading: 'MES ▲', neutral: 'Neutral' };
        rsSignalEl.textContent = labels[signal] ?? signal;
        rsSignalEl.className   = 'rs-signal ' + (signal === 'mnq_leading' ? 'rs-bull' : signal === 'mes_leading' ? 'rs-bear' : '');
      }
    } catch (_) {}
  }

  // ── Options data (OI walls, max pain, P/C ratio, ATM IV) ───────────────────

  async function _fetchOptionsData(symbol) {
    try {
      const res = await fetch(`/api/options?symbol=${symbol}`);
      if (!res.ok) return;
      const { options } = await res.json();
      window.ChartAPI?.setOptionsLevels?.(options);
      _updateOptionsWidget(options);
    } catch (_) {}
  }

  function _updateOptionsWidget(data) {
    const widget = document.getElementById('options-widget');
    const pcEl   = document.getElementById('opt-pc');
    const ivEl   = document.getElementById('opt-iv');
    if (!widget) return;
    if (!data) { widget.style.display = 'none'; return; }
    widget.style.display = '';
    if (pcEl) {
      const v = data.pcRatio;
      pcEl.textContent = v != null ? v.toFixed(2) : '—';
      pcEl.className   = 'opt-value' + (v > 1.3 ? ' opt-bearish' : v < 0.7 ? ' opt-bullish' : '');
    }
    if (ivEl) {
      ivEl.textContent = data.atmIV != null ? `${(data.atmIV * 100).toFixed(1)}%` : '—';
    }
  }

  // ── Correlation heatmap ─────────────────────────────────────────────────────

  const CORR_SYMBOLS = ['MNQ', 'MGC', 'MES', 'MCL'];

  async function _updateCorrelationHeatmap() {
    const grid = document.getElementById('corr-grid');
    const upd  = document.getElementById('corr-updated');
    if (!grid) return;
    try {
      const res = await fetch('/api/correlation');
      if (!res.ok) return;
      const { matrix, updatedAt } = await res.json();
      if (!matrix) return;
      grid.innerHTML = '';

      // Header row
      const headers = ['', ...CORR_SYMBOLS];
      for (const h of headers) {
        const cell = document.createElement('div');
        cell.className   = 'corr-cell corr-header';
        cell.textContent = h;
        grid.appendChild(cell);
      }
      // Data rows
      for (const rowSym of CORR_SYMBOLS) {
        const rowLabel = document.createElement('div');
        rowLabel.className   = 'corr-cell corr-header';
        rowLabel.textContent = rowSym;
        grid.appendChild(rowLabel);

        for (const colSym of CORR_SYMBOLS) {
          const val  = matrix[rowSym]?.[colSym] ?? 0;
          const cell = document.createElement('div');
          cell.className   = 'corr-cell';
          cell.textContent = val.toFixed(2);
          // Color: green (+1) → gray (0) → red (-1)
          const r = val < 0 ? Math.round(-val * 180) : 0;
          const g = val > 0 ? Math.round(val  * 150) : 0;
          const b = 0;
          cell.style.background = `rgba(${r},${g},${b},0.6)`;
          cell.style.color = Math.abs(val) > 0.5 ? '#fff' : 'var(--text-dim)';
          cell.title = `${rowSym}↔${colSym}: ${val.toFixed(3)}`;
          grid.appendChild(cell);
        }
      }
      if (upd && updatedAt) {
        const t = new Date(updatedAt).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Denver',
        });
        upd.textContent = t;
      }
    } catch (err) {
      console.warn('[corr] Update failed:', err.message);
    }
  }

  // ── Alert key helper ───────────────────────────────────────────────────────

  function _alertKey(a) {
    return `${a.symbol}:${a.timeframe}:${a.setup.type}:${a.setup.time}`;
  }

  // ── New alert banner ───────────────────────────────────────────────────────

  function _showFillToast(text) {
    const existing = document.querySelector('.sim-fill-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className   = 'sim-fill-toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  function _showNewAlertBanner(count) {
    const existing = document.querySelector('.new-alert-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.className   = 'new-alert-banner';
    banner.textContent = `🔔 ${count} new setup${count > 1 ? 's' : ''} — check alert feed`;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 6000);
  }

  // ── Mobile bottom-tab navigation ─────────────────────────────────────────────

  function _initMobileTabs() {
    const tabBtns = document.querySelectorAll('#bottom-nav .tab-btn');
    if (!tabBtns.length) return;

    const app = document.getElementById('app');

    function _switchTab(tab) {
      app.dataset.mobileTab = tab;
      tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      if (tab === 'chart') {
        // Give the chart container one frame to reappear before resizing
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      }
    }

    tabBtns.forEach(btn => btn.addEventListener('click', () => _switchTab(btn.dataset.tab)));

    // Start on chart tab
    _switchTab('chart');
  }

  // ── Sound alerts (Web Audio API) ──────────────────────────────────────────

  function _playAlertSound(direction) {
    if (!window._soundAlertsEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const f1 = direction === 'bullish' ? 440 : 550;
      const f2 = direction === 'bullish' ? 550 : 440;

      [f1, f2].forEach((freq, i) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type      = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.15);
        osc.stop(ctx.currentTime  + i * 0.15 + 0.3);
      });
    } catch (_) {}
  }

  // ── Boot ────────────────────────────────────────────────────────────────────

  async function boot() {
    // Load server-side risk defaults (includes rrRatio from settings.json)
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const { risk, features } = await res.json();
        cfg = { ...cfg, ...risk, features: features || {} };
        window._soundAlertsEnabled = !!features?.soundAlerts;
      }
    } catch (_) {}

    // Load initial data-age + nextRefresh from health endpoint
    try {
      const hRes = await fetch('/api/health');
      if (hRes.ok) {
        const { lastRefresh, nextRefresh, refreshIntervalMins } = await hRes.json();
        _setRefreshTimes(lastRefresh, nextRefresh);
        if (refreshIntervalMins && refreshIntervalEl) {
          refreshIntervalEl.value = refreshIntervalMins;
        }
      }
    } catch (_) {}

    // Load trade log
    try {
      const tr = await fetch('/api/trades');
      if (tr.ok) {
        const { trades } = await tr.json();
        trades.forEach(t => takenTrades.set(t.alertKey, t));
      }
    } catch (_) {}

    // Restore taken+open alert data from localStorage
    try {
      const saved = JSON.parse(localStorage.getItem(_TAKEN_OPEN_LS) || '[]');
      saved.forEach(a => {
        if (a?.setup?.outcome === 'open') takenOpenAlertData.set(_alertKey(a), a);
      });
    } catch (_) {}

    // Restore any locally saved overrides (client-only: contracts, maxRisk, minConf)
    const saved = _loadLocal();
    if (saved) {
      cfg.mnqContracts   = saved.mnqContracts   ?? cfg.mnqContracts;
      cfg.mgcContracts   = saved.mgcContracts   ?? cfg.mgcContracts;
      cfg.maxRiskDollars = saved.maxRiskDollars ?? cfg.maxRiskDollars;
    }
    minConf = saved?.minConfidence ?? cfg.minConfidence ?? 0;

    // Populate inputs
    minConfInput.value  = minConf;
    mnqInput.value      = cfg.mnqContracts;
    mgcInput.value      = cfg.mgcContracts;
    maxRiskInput.value  = cfg.maxRiskDollars;
    rrInput.value       = cfg.rrRatio;

    await fetchAndRender();
    connectWS();
    _wireInputs();
    _initMobileTabs();
    _initAutotrader();
    _updateSessionBadge();
    setInterval(_updateSessionBadge, 60_000);
    setInterval(_tickDataAge, 1000);  // live countdown

    // Initial correlation heatmap + calendar loads
    if (cfg.features?.correlationHeatmap) _updateCorrelationHeatmap();
    if (cfg.features?.economicCalendar)   _updateCalendarBadge();
    if (cfg.features?.relativeStrength && (activeSymbol === 'MNQ' || activeSymbol === 'MES')) {
      _updateRSWidget();
    }
    _fetchOptionsData(activeSymbol);

    // Listen for chart symbol/TF changes (dispatched by chart.js after each loadData)
    document.addEventListener('chartViewChange', (e) => {
      activeSymbol = e.detail.symbol;
      activeTf     = e.detail.tf;
      // Immediately sync markers — this clears stale markers (old symbol/TF alerts
      // won't match the new filter and produce an empty alertMarkers array).
      // fetchAndRender will re-populate with the correct alerts for the new view.
      _syncChartMarkers();
      fetchAndRender();
      // RS widget only relevant for equity index symbols
      const rsWidget = document.getElementById('rs-widget');
      if (rsWidget) rsWidget.style.display = (activeSymbol === 'MNQ' || activeSymbol === 'MES') ? '' : 'none';
      if (cfg.features?.relativeStrength && (activeSymbol === 'MNQ' || activeSymbol === 'MES')) {
        _updateRSWidget();
      }
      if (cfg.features?.economicCalendar) _updateCalendarBadge();
      _fetchOptionsData(activeSymbol);
    });

    // Listen for chart marker clicks — scroll to and highlight the matching alert card
    document.addEventListener('chartMarkerClick', (e) => {
      const alert = e.detail.alerts[0];
      if (!alert) return;
      const key = _alertKey(alert);

      // On mobile: switch to Alerts tab first, then scroll after a frame
      if (window.matchMedia('(max-width: 767px)').matches) {
        const app = document.getElementById('app');
        if (app.dataset.mobileTab !== 'alerts') {
          app.dataset.mobileTab = 'alerts';
          document.querySelectorAll('#bottom-nav .tab-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.tab === 'alerts')
          );
          setTimeout(() => _scrollToAlert(key), 80);
          return;
        }
      }
      _scrollToAlert(key);
    });
  }

  // ── Fetch + render ─────────────────────────────────────────────────────────

  let _fetchTimer = null;

  async function fetchAndRender(debounceMs = 0) {
    clearTimeout(_fetchTimer);
    _fetchTimer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/alerts?limit=100&minConfidence=${minConf}&symbol=${activeSymbol}`
        );
        if (!res.ok) throw new Error(`/api/alerts ${res.status}`);
        const { alerts } = await res.json();
        currentAlerts = alerts;
        // Sync server-resolved outcomes back into the cross-symbol cache
        let takenOpenChanged = false;
        for (const a of currentAlerts) {
          const key = _alertKey(a);
          if (takenOpenAlertData.has(key) && a.setup?.outcome !== 'open') {
            takenOpenAlertData.delete(key);
            takenOpenChanged = true;
          }
        }
        if (takenOpenChanged) _saveTakenOpen();
        _renderFeed();
        _updateStats();
        _syncChartMarkers();
        console.log(`[alerts] ${alerts.length} alerts  sym=${activeSymbol}  minConf=${minConf}`);
      } catch (err) {
        console.error('[alerts] Fetch failed:', err.message);
        alertFeed.innerHTML =
          '<p class="placeholder error">Could not load alerts. <a id="alerts-retry">Retry</a></p>';
        document.getElementById('alerts-retry')?.addEventListener('click', () => fetchAndRender());
      }
    }, debounceMs);
  }

  function _renderFeed() {
    alertFeed.innerHTML = '';

    // ── Active Trades — top, all symbols, taken+open ────────────────────────
    const openTaken = [...takenOpenAlertData.values()];
    if (openTaken.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'taken-section-header';
      sep.innerHTML = `<span>Active Trades</span><span class="taken-count">${openTaken.length}</span>`;
      alertFeed.appendChild(sep);
      for (const a of openTaken) {
        const card = _buildCard(a);
        card.classList.add('is-active-taken');
        alertFeed.appendChild(card);
      }
    }

    if (!currentAlerts.length) {
      if (openTaken.length === 0) {
        const msg = minConf > 0
          ? `No ${activeSymbol} setups at ≥${minConf}% confidence.`
          : `No ${activeSymbol} setups detected yet.`;
        alertFeed.innerHTML = `<p class="placeholder">${msg}</p>`;
      }
      _prevAlertKeys = new Set();
      _renderManualTrades();
      return;
    }

    const active = currentAlerts.filter(a => !takenTrades.has(_alertKey(a)));
    // Resolved taken alerts (not open, not already shown in top section)
    const takenResolved = currentAlerts.filter(a =>
      takenTrades.has(_alertKey(a)) && !takenOpenAlertData.has(_alertKey(a))
    );

    // ── Active + suppressed alerts ──────────────────────────────────────────
    for (const a of active) {
      const card = _buildCard(a);
      // Highlight cards that weren't present before the last refresh
      if (_prevAlertKeys.size > 0 && !_prevAlertKeys.has(_alertKey(a))) {
        card.classList.add('is-new');
        setTimeout(() => card.classList.remove('is-new'), 10_000);
      }
      alertFeed.appendChild(card);
    }

    // ── Resolved Taken Trades (current symbol only) ─────────────────────────
    if (takenResolved.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'taken-section-header';
      sep.innerHTML = `<span>Taken Trades</span><span class="taken-count">${takenResolved.length}</span>`;
      alertFeed.appendChild(sep);
      for (const a of takenResolved) {
        const card = _buildCard(a);
        card.classList.add('is-taken-card');
        alertFeed.appendChild(card);
      }
    }

    _prevAlertKeys = new Set(); // clear after render
    _renderManualTrades();
  }

  // ── Chart marker sync ──────────────────────────────────────────────────────

  function _syncChartMarkers() {
    window.ChartAPI?.setAlertMarkers(currentAlerts, activeSymbol, activeTf);
  }

  function _scrollToAlert(key) {
    const card = alertFeed.querySelector(`[data-alert-key="${key}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('marker-highlight');
    setTimeout(() => card.classList.remove('marker-highlight'), 3000);
  }

  // ── Win-rate stats ─────────────────────────────────────────────────────────

  function _updateStats() {
    // Only count non-suppressed alerts for the win rate
    const active = currentAlerts.filter(a => !a.suppressed);
    const won    = active.filter(a => a.setup.outcome === 'won').length;
    const lost   = active.filter(a => a.setup.outcome === 'lost').length;
    const open   = active.filter(a => a.setup.outcome === 'open').length;
    const total  = won + lost;
    const wr     = total > 0 ? Math.round((won / total) * 100) : null;

    wrWon.textContent  = `W ${won}`;
    wrLost.textContent = `L ${lost}`;
    wrOpen.textContent = `O ${open}`;
    wrPct.textContent  = wr !== null ? `${wr}% WR` : '— WR';
    wrPct.className    = 'wr-pct' + (wr === null ? '' : wr >= 50 ? ' good' : wr >= 40 ? ' neutral' : ' bad');

    // Update alert count badge on bottom nav tab
    if (tabAlertBadge) {
      const n = currentAlerts.filter(a => !a.suppressed).length;
      tabAlertBadge.textContent = n > 0 ? String(n) : '';
    }
  }

  // ── Dollar risk (tick-based calculation) ───────────────────────────────────

  function _calcRisk(alert) {
    const pts = alert.setup.riskPoints;
    if (pts == null || !TICK_SIZE[alert.symbol]) return null;
    const contracts = alert.symbol === 'MNQ' ? cfg.mnqContracts
                    : alert.symbol === 'MGC' ? cfg.mgcContracts
                    : alert.symbol === 'MES' ? cfg.mesContracts
                    : alert.symbol === 'MCL' ? cfg.mclContracts
                    : 1;
    const ticks = pts / TICK_SIZE[alert.symbol];
    return Math.round(ticks * TICK_VALUE[alert.symbol] * contracts);
  }

  // ── Score breakdown rendering ──────────────────────────────────────────────

  function _fmtBreakdown(sd) {
    if (!sd) return '';
    const parts = [];
    if (sd.base   > 0) parts.push(`<span class="bd-base">${sd.base}</span>`);
    if (sd.depth  > 0) parts.push(`<span class="bd-item">+D${sd.depth}</span>`);
    if (sd.body   > 0) parts.push(`<span class="bd-item">+B${sd.body}</span>`);
    if (sd.wick   > 0) parts.push(`<span class="bd-item">+W${sd.wick}</span>`);
    if (sd.size   > 0) parts.push(`<span class="bd-item">+Sz${sd.size}</span>`);
    if (sd.break   > 0) parts.push(`<span class="bd-item">+Br${sd.break}</span>`);
    if (sd.touches > 0) parts.push(`<span class="bd-item">+T${sd.touches}</span>`);
    if (sd.choch   > 0) parts.push(`<span class="bd-item">+CH${sd.choch}</span>`);
    if (sd.regime > 0) parts.push(`<span class="bd-item bd-regime">+R${sd.regime}</span>`);
    if (sd.align  > 0) parts.push(`<span class="bd-item bd-align">+A${sd.align}</span>`);
    if (sd.iof    > 0) parts.push(`<span class="bd-item bd-iof">+IOF${sd.iof}</span>`);
    if (sd.bos    > 0) parts.push(`<span class="bd-item bd-bos">+BQ${sd.bos}</span>`);
    if (sd.tfStack > 0) parts.push(`<span class="bd-item bd-tfstack">+TFS${sd.tfStack}</span>`);
    return `<div class="alert-score-bd">${parts.join('')}</div>`;
  }

  // ── Card rendering ─────────────────────────────────────────────────────────

  function _buildCard(alert) {
    const { symbol, timeframe, setup } = alert;
    const suppressed = !!alert.suppressed;
    const dir        = setup.direction;
    const dirClass   = dir === 'bullish' ? 'bull' : 'bear';
    const dirArrow   = dir === 'bullish' ? '▲' : '▼';

    const fmtP = n => (n != null ? n.toFixed(2) : '—');
    // Display time + age in Mountain Time (MST/MDT)
    const time = new Date(setup.time * 1000).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/Denver',
    });
    const ageMins = Math.round((Date.now() - setup.time * 1000) / 60000);
    const ageText = ageMins < 2 ? 'just now'
      : ageMins < 60  ? `${ageMins}m`
      : `${Math.floor(ageMins / 60)}h`;

    const riskDollars  = _calcRisk(alert);
    const overBudget   = riskDollars != null && riskDollars > cfg.maxRiskDollars;
    const riskText     = riskDollars != null ? `$${riskDollars}` : '—';
    const riskClass    = overBudget ? 'risk-over' : 'risk-ok';

    const outcomeLabel = { won: '✓ WON', lost: '✗ LOST', open: '○ Open' }[setup.outcome] || '—';
    const outcomeClass = setup.outcome || 'open';

    const isTaken = takenTrades.has(`${symbol}:${timeframe}:${setup.type}:${setup.time}`);
    const aiKey   = `${symbol}:${timeframe}:${setup.type}:${setup.time}`;

    // Border class: reflects outcome for resolved trades (won=green, lost=red);
    // direction class still drives the arrow color inside the card.
    const borderClass = setup.outcome === 'won'  ? 'outcome-won'
                      : setup.outcome === 'lost' ? 'outcome-lost'
                      :                            '';

    const card = document.createElement('div');
    card.className = `alert-card ${dirClass}${borderClass ? ` ${borderClass}` : ''}${suppressed ? ' suppressed' : ''}${overBudget ? ' over-budget' : ''}`;
    card.dataset.alertKey = aiKey;  // used by chart marker click handler

    // Outcome header badge (shown prominently on taken + resolved cards)
    const outcomeHeaderBadge = isTaken && setup.outcome === 'won'
      ? `  <span class="outcome-header-badge won">✓ WON</span>`
      : isTaken && setup.outcome === 'lost'
        ? `  <span class="outcome-header-badge lost">✗ LOST</span>`
        : '';

    // Won/Lost mark buttons — only on taken cards still open (not yet manually marked)
    const outcomeButtons = isTaken && setup.outcome === 'open' && !setup.userOverride
      ? `<button class="outcome-btn won-btn" data-key="${aiKey}" title="Mark as Won">✓ Won</button>` +
        `<button class="outcome-btn lost-btn" data-key="${aiKey}" title="Mark as Lost">✗ Lost</button>`
      : '';

    card.innerHTML = [
      `<div class="alert-header">`,
      `  <span class="alert-sym">${symbol}</span>`,
      `  <span class="alert-tf">${timeframe}</span>`,
      `  <span class="alert-type">${_fmtType(setup.type)}</span>`,
      `  <span class="alert-dir ${dirClass}">${dirArrow}</span>`,
      suppressed ? `  <span class="alert-suppressed-tag">filtered</span>` : '',
      setup.nearEvent ? `  <span class="near-event-badge">⚠ Near Event</span>` : '',
      outcomeHeaderBadge,
      `</div>`,
      `<div class="alert-rationale">${setup.rationale}</div>`,
      _fmtBreakdown(setup.scoreBreakdown),
      `<div class="alert-prices">`,
      `  <span class="price-label">Entry</span><span class="price-val">${fmtP(setup.entry ?? setup.price)}</span>`,
      `  <span class="price-label sl">SL</span><span class="price-val sl">${fmtP(setup.sl)}</span>`,
      `  <span class="price-label tp">TP</span><span class="price-val tp">${fmtP(setup.tp)}</span>`,
      `</div>`,
      `<div class="alert-footer">`,
      `  <span class="alert-conf">${setup.confidence}%</span>`,
      `  <span class="alert-outcome ${outcomeClass}">${outcomeLabel}</span>`,
      `  <span class="alert-risk ${riskClass}">${riskText}</span>`,
      outcomeButtons,
      !suppressed ? `  <button class="ai-btn" data-key="${aiKey}" title="Get AI analysis">✦ AI</button>` : '',
      !suppressed && !isTaken
        ? `  <button class="take-btn" data-key="${aiKey}" title="Mark as taken">Take</button>`
        : isTaken
          ? `  <span class="taken-badge" data-key="${aiKey}" title="View/edit trade">TAKEN</span>`
          : '',
      `  <span class="alert-time">${time} MT</span><span class="alert-age">${ageText}</span>`,
      `</div>`,
      `<div class="alert-commentary"></div>`,
      `<div class="trade-form" style="display:none"></div>`,
    ].join('');

    if (!suppressed) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => {
        document.querySelectorAll('.alert-card.selected')
          .forEach(el => el.classList.remove('selected'));
        card.classList.add('selected');
        window.ChartAPI?.highlightSetup(alert);
      });

      const aiBtn        = card.querySelector('.ai-btn');
      const commentaryEl = card.querySelector('.alert-commentary');

      aiBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); // don't trigger chart highlight

        // Toggle if commentary is already loaded
        if (commentaryEl.dataset.loaded) {
          const nowHidden = commentaryEl.style.display === 'none';
          commentaryEl.style.display = nowHidden ? 'block' : 'none';
          aiBtn.classList.toggle('active', nowHidden);
          return;
        }

        // Commentary pre-attached from batch run or persisted disk cache — no API call needed
        if (alert.commentary) {
          commentaryEl.className = 'alert-commentary';
          alert.commentary.split(/(?<=[.!?])\s+/).filter(s => s.trim()).forEach(s => {
            const p = document.createElement('p');
            p.textContent = s;
            commentaryEl.appendChild(p);
          });
          commentaryEl.dataset.loaded = '1';
          commentaryEl.style.display  = 'block';
          aiBtn.classList.add('active');
          return;
        }

        aiBtn.disabled    = true;
        aiBtn.textContent = '…';
        commentaryEl.className   = 'alert-commentary loading';
        commentaryEl.textContent = 'Generating…';
        commentaryEl.style.display = 'block';

        try {
          const res = await fetch('/api/commentary/single', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ key: aiBtn.dataset.key }),
          });
          if (!res.ok) throw new Error(`${res.status}`);
          const { commentary } = await res.json();

          // Render sentences as paragraphs using safe DOM methods
          commentaryEl.className = 'alert-commentary';
          commentaryEl.innerHTML = '';
          commentary.split(/(?<=[.!?])\s+/).filter(s => s.trim()).forEach(s => {
            const p = document.createElement('p');
            p.textContent = s;
            commentaryEl.appendChild(p);
          });
          commentaryEl.dataset.loaded = '1';
          aiBtn.classList.add('active');

        } catch (err) {
          commentaryEl.className   = 'alert-commentary error';
          commentaryEl.textContent = err.message === '503'
            ? 'Rate-limited — try again shortly.'
            : 'Could not load analysis.';
        } finally {
          aiBtn.disabled    = false;
          aiBtn.textContent = '✦ AI';
        }
      });

      // ── Trade journal form ─────────────────────────────────────────────────
      const tradeFormEl = card.querySelector('.trade-form');
      const takeBtn     = card.querySelector('.take-btn');
      const takenBadge  = card.querySelector('.taken-badge');

      function _openTradeForm(existing) {
        const t = existing || {};
        tradeFormEl.innerHTML = `
          <div class="trade-form-inner">
            <div class="tf-row">
              <label>Entry</label>
              <input class="tf-entry" type="number" step="0.25" value="${t.actualEntry ?? fmtP(setup.entry ?? setup.price)}">
              <label>SL</label>
              <input class="tf-sl" type="number" step="0.25" value="${t.actualSL ?? fmtP(setup.sl)}">
              <label>TP</label>
              <input class="tf-tp" type="number" step="0.25" value="${t.actualTP ?? fmtP(setup.tp)}">
            </div>
            <div class="tf-row">
              <label>Exit</label>
              <input class="tf-exit" type="number" step="0.25" value="${t.actualExit ?? ''}">
              <label>Notes</label>
              <input class="tf-notes" type="text" value="${t.notes ?? ''}" placeholder="Optional notes">
            </div>
            <div class="tf-btns">
              <button class="tf-save">Save</button>
              <button class="tf-cancel">Cancel</button>
            </div>
          </div>`;
        tradeFormEl.style.display = 'block';

        tradeFormEl.querySelector('.tf-cancel').addEventListener('click', (e) => {
          e.stopPropagation();
          tradeFormEl.style.display = 'none';
        });

        tradeFormEl.querySelector('.tf-save').addEventListener('click', async (e) => {
          e.stopPropagation();
          const body = {
            alertKey:    aiKey,
            symbol,
            timeframe,
            setupType:   setup.type,
            actualEntry: tradeFormEl.querySelector('.tf-entry').value,
            actualSL:    tradeFormEl.querySelector('.tf-sl').value,
            actualTP:    tradeFormEl.querySelector('.tf-tp').value,
            actualExit:  tradeFormEl.querySelector('.tf-exit').value || null,
            notes:       tradeFormEl.querySelector('.tf-notes').value,
          };
          try {
            const res = await fetch('/api/trades', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify(body),
            });
            if (!res.ok) throw new Error(res.status);
            const { trade } = await res.json();
            takenTrades.set(aiKey, trade);
            // Save full alert object for cross-symbol Active Trades section
            if (alert.setup?.outcome === 'open' || alert.setup?.outcome == null) {
              takenOpenAlertData.set(aiKey, alert);
              _saveTakenOpen();
            }
            tradeFormEl.style.display = 'none';

            // Swap Take button → TAKEN badge without full re-render
            if (takeBtn) {
              const badge = document.createElement('span');
              badge.className  = 'taken-badge';
              badge.dataset.key = aiKey;
              badge.title       = 'View/edit trade';
              badge.textContent = 'TAKEN';
              badge.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const isOpen = tradeFormEl.style.display !== 'none';
                tradeFormEl.style.display = isOpen ? 'none' : 'block';
                if (!isOpen) _openTradeForm(takenTrades.get(aiKey));
              });
              takeBtn.replaceWith(badge);
            }
          } catch (err) {
            console.error('[trade] Save failed:', err.message);
          }
        });
      }

      if (takeBtn) {
        takeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = tradeFormEl.style.display !== 'none';
          tradeFormEl.style.display = isOpen ? 'none' : 'block';
          if (!isOpen) _openTradeForm();
        });
      }
      if (takenBadge) {
        takenBadge.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = tradeFormEl.style.display !== 'none';
          tradeFormEl.style.display = isOpen ? 'none' : 'block';
          if (!isOpen) _openTradeForm(takenTrades.get(aiKey));
        });
      }

      // ── Won / Lost outcome buttons ─────────────────────────────────────────
      const wonBtn  = card.querySelector('.won-btn');
      const lostBtn = card.querySelector('.lost-btn');

      async function _setOutcome(outcome) {
        try {
          const res = await fetch(`/api/alerts/${encodeURIComponent(aiKey)}`, {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ outcome }),
          });
          if (!res.ok) throw new Error(res.status);
          // Update local alert object and re-render to reflect new outcome
          alert.setup.outcome      = outcome;
          alert.setup.userOverride = true;
          // Remove from cross-symbol Active Trades section
          takenOpenAlertData.delete(aiKey);
          _saveTakenOpen();
          _renderFeed();
          _updateStats();
        } catch (err) {
          console.error('[outcome] Set failed:', err.message);
        }
      }

      if (wonBtn)  wonBtn.addEventListener('click',  (e) => { e.stopPropagation(); _setOutcome('won');  });
      if (lostBtn) lostBtn.addEventListener('click', (e) => { e.stopPropagation(); _setOutcome('lost'); });
    }

    return card;
  }

  function _fmtType(type) {
    switch (type) {
      case 'liquidity_sweep_reversal': return 'Sweep';
      case 'zone_rejection':           return 'Zone Rej';
      case 'bos':                      return 'BOS';
      case 'choch':                    return 'CHoCH';
      case 'pdh_breakout':             return 'PDH Brk';
      case 'trendline_break':          return 'TL Break';
      case 'or_breakout':              return 'OR Break';
      default:                         return type;
    }
  }

  // ── Manual trade form ──────────────────────────────────────────────────────

  function _openManualForm() {
    if (!manualFormEl) return;
    manualFormEl.innerHTML = `
      <div class="manual-form-inner">
        <div class="mf-row">
          <label>Symbol</label>
          <select class="mf-sym filter-select">
            <option>MNQ</option><option>MGC</option><option>MES</option><option>MCL</option>
          </select>
          <span class="mf-dir-toggle">
            <button class="mf-dir-btn active" data-dir="bullish">Long</button>
            <button class="mf-dir-btn" data-dir="bearish">Short</button>
          </span>
        </div>
        <div class="mf-row">
          <label>Entry</label><input class="mf-entry filter-input" type="number" step="0.25" placeholder="0.00">
          <label>SL</label><input class="mf-sl filter-input" type="number" step="0.25" placeholder="0.00">
          <label>TP</label><input class="mf-tp filter-input" type="number" step="0.25" placeholder="0.00">
        </div>
        <div class="mf-row">
          <label>Exit</label><input class="mf-exit filter-input" type="number" step="0.25" placeholder="Optional">
          <label>Setup</label><input class="mf-type filter-input wide" type="text" placeholder="e.g. VWAP reclaim">
        </div>
        <div class="mf-row">
          <label>Notes</label><input class="mf-notes filter-input wide" type="text" placeholder="Optional notes">
        </div>
        <div class="mf-btns">
          <button class="mf-save">Log Trade</button>
          <button class="mf-cancel">Cancel</button>
        </div>
      </div>`;
    manualFormEl.style.display = 'block';

    let selectedDir = 'bullish';
    manualFormEl.querySelectorAll('.mf-dir-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        manualFormEl.querySelectorAll('.mf-dir-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedDir = btn.dataset.dir;
      });
    });

    manualFormEl.querySelector('.mf-cancel').addEventListener('click', () => {
      manualFormEl.style.display = 'none';
    });

    manualFormEl.querySelector('.mf-save').addEventListener('click', async () => {
      const sym   = manualFormEl.querySelector('.mf-sym').value;
      const entry = manualFormEl.querySelector('.mf-entry').value;
      const sl    = manualFormEl.querySelector('.mf-sl').value;
      const tp    = manualFormEl.querySelector('.mf-tp').value;
      if (!entry || !sl || !tp) { alert('Entry, SL, and TP are required.'); return; }

      const body = {
        symbol:          sym,
        direction:       selectedDir,
        actualEntry:     entry,
        actualSL:        sl,
        actualTP:        tp,
        actualExit:      manualFormEl.querySelector('.mf-exit').value  || null,
        manualSetupType: manualFormEl.querySelector('.mf-type').value  || 'Manual',
        notes:           manualFormEl.querySelector('.mf-notes').value || '',
        isManual:        true,
      };
      try {
        const res = await fetch('/api/trades', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        if (!res.ok) throw new Error(res.status);
        const { trade } = await res.json();
        manualTrades.push(trade);
        manualFormEl.style.display = 'none';
        _renderManualTrades();
      } catch (err) {
        console.error('[manual-trade] Save failed:', err.message);
      }
    });
  }

  function _renderManualTrades() {
    // Remove existing manual section if present
    const existing = alertFeed.querySelector('.manual-trades-section');
    if (existing) existing.remove();
    if (!manualTrades.length) return;

    const section = document.createElement('div');
    section.className = 'manual-trades-section';
    section.innerHTML = `<div class="taken-section-header"><span>Manual Trades</span><span class="taken-count">${manualTrades.length}</span></div>`;

    for (const t of manualTrades) {
      const c = document.createElement('div');
      const dir = t.direction === 'bearish' ? 'bear' : 'bull';
      const arrow = t.direction === 'bearish' ? '▼' : '▲';
      const outc = t.outcome || 'open';
      const outcLabel = { won: '✓ WON', lost: '✗ LOST', open: '○ Open' }[outc] || '—';
      const borderCls = outc === 'won' ? ' outcome-won' : outc === 'lost' ? ' outcome-lost' : '';
      c.className = `alert-card ${dir} is-taken-card manual-card${borderCls}`;
      c.innerHTML = `
        <div class="alert-header">
          <span class="alert-sym">${t.symbol || '—'}</span>
          <span class="alert-tf">${t.timeframe || '—'}</span>
          <span class="alert-type">${t.manualSetupType || 'Manual'}</span>
          <span class="alert-dir ${dir}">${arrow}</span>
          <span class="manual-badge">MANUAL</span>
          ${outc !== 'open' ? `<span class="outcome-header-badge ${outc}">${outcLabel}</span>` : ''}
        </div>
        <div class="alert-prices">
          <span class="price-label">Entry</span><span class="price-val">${(+t.actualEntry).toFixed(2)}</span>
          <span class="price-label sl">SL</span><span class="price-val sl">${(+t.actualSL).toFixed(2)}</span>
          <span class="price-label tp">TP</span><span class="price-val tp">${(+t.actualTP).toFixed(2)}</span>
        </div>
        <div class="alert-footer">
          <span class="alert-outcome ${outc}">${outcLabel}</span>
          ${outc === 'open'
            ? `<button class="outcome-btn won-btn" data-tid="${t.id}">✓ Won</button><button class="outcome-btn lost-btn" data-tid="${t.id}">✗ Lost</button>`
            : ''}
          <span class="alert-time">${new Date(t.takenAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:'America/Denver'})} MT</span>
        </div>
        ${t.notes ? `<div class="alert-rationale">${t.notes}</div>` : ''}`;

      c.querySelectorAll('.outcome-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const outcome = btn.classList.contains('won-btn') ? 'won' : 'lost';
          t.outcome = outcome;
          _renderManualTrades();
        });
      });

      section.appendChild(c);
    }
    alertFeed.appendChild(section);
  }

  // ── Input wiring ───────────────────────────────────────────────────────────

  let _rrTimer = null;

  function _wireInputs() {
    // Log Trade button — opens manual trade entry form
    if (logTradeBtnEl) {
      logTradeBtnEl.addEventListener('click', () => {
        const isOpen = manualFormEl && manualFormEl.style.display !== 'none';
        if (isOpen) {
          manualFormEl.style.display = 'none';
        } else {
          _openManualForm();
        }
      });
    }

    // Confidence threshold — refetch from server (trade filter must see the new set)
    minConfInput.addEventListener('input', () => {
      minConf = parseInt(minConfInput.value) || 0;
      _saveLocal();
      fetchAndRender(400); // debounce 400ms
    });

    // Contract counts + max risk — client-side recalc only, no refetch
    const riskInputs = [mnqInput, mgcInput, maxRiskInput];
    riskInputs.forEach(el => {
      el.addEventListener('input', () => {
        cfg.mnqContracts   = parseInt(mnqInput.value)   || 1;
        cfg.mgcContracts   = parseInt(mgcInput.value)   || 1;
        cfg.maxRiskDollars = parseInt(maxRiskInput.value) || 200;
        _saveLocal();
        _renderFeed();   // rebuild cards with new dollar values
        _updateStats();
      });
    });

    // R:R ratio — server-side (TP/outcome depend on it); debounce + POST + rescan
    rrInput.addEventListener('input', () => {
      const rr = parseFloat(rrInput.value);
      if (!rr || rr < 1.0) return;
      cfg.rrRatio = rr;
      _saveLocal();
      clearTimeout(_rrTimer);
      _rrTimer = setTimeout(() => _postRatio(rr), 600);
    });

    // Refresh interval — POST to server, no re-render needed (countdown resets via WS)
    if (refreshIntervalEl) {
      refreshIntervalEl.addEventListener('change', async () => {
        const mins = parseInt(refreshIntervalEl.value);
        try {
          await fetch('/api/settings', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ refreshIntervalMins: mins }),
          });
          console.log(`[alerts] Refresh interval set to ${mins} min`);
        } catch (_) {}
      });
    }

    // Refresh now — immediate data fetch + reset interval countdown
    if (refreshNowBtn) {
      refreshNowBtn.addEventListener('click', async () => {
        refreshNowBtn.disabled    = true;
        refreshNowBtn.textContent = '…';
        try {
          const res = await fetch('/api/refresh', { method: 'POST' });
          if (res.ok) {
            const { ts, nextRefresh } = await res.json();
            _setRefreshTimes(ts, nextRefresh);
          }
        } catch (_) {}
        refreshNowBtn.disabled    = false;
        refreshNowBtn.textContent = '↻ Now';
      });
    }
  }

  function _showRrStatus(msg, cls) {
    if (!rrStatusEl) return;
    rrStatusEl.textContent = msg;
    rrStatusEl.className   = `filter-unit rr-status ${cls}`;
    setTimeout(() => {
      rrStatusEl.textContent = '';
      rrStatusEl.className   = 'filter-unit rr-status';
    }, 2000);
  }

  async function _postRatio(rr) {
    rrInput.disabled = true;
    try {
      const res = await fetch('/api/settings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ rrRatio: rr }),
      });
      if (!res.ok) throw new Error(`/api/settings ${res.status}`);
      console.log(`[alerts] R:R updated to ${rr}:1 — rescanning`);
      _showRrStatus('Saved ✓', 'ok');
      await fetchAndRender();
    } catch (err) {
      console.error('[alerts] R:R update failed:', err.message);
      _showRrStatus('Error', 'err');
    } finally {
      rrInput.disabled = false;
    }
  }

  // ── AutoTrader status polling ──────────────────────────────────────────────

  async function _pollAutotrader() {
    try {
      const res = await fetch('/api/autotrader/status');
      if (!res.ok) return;
      _applyAutotraderState(await res.json());
    } catch (_) {}
  }

  function _applyAutotraderState({ enabled, minConfidence, lastOrder, authError, positions, summary }) {
    if (!atToggleBtn || !atStatusDot) return;

    const cls = enabled && !authError ? 'at-live' : authError ? 'at-error' : 'at-paused';
    atStatusDot.className   = `at-dot ${cls}`;
    atToggleBtn.className   = `at-toggle-btn ${cls}`;
    atToggleBtn.textContent = enabled && !authError ? 'LIVE' : authError ? 'AUTH ERR' : 'PAUSED';

    // Open positions row
    const open = (positions || []).filter(p => p.netPos !== 0);
    if (atPositionRow) {
      atPositionRow.textContent = open.length
        ? open.map(p => `${p.symbol} ${p.netPos > 0 ? '+' : ''}${p.netPos} @ ${p.avgPrice}`).join(' · ')
        : 'No open positions';
      atPositionRow.className = `at-position-row${open.length ? ' has-position' : ''}`;
    }

    // P&L summary row
    if (atSummaryRow && summary && summary.trades > 0) {
      const pnlSign  = summary.totalPnl >= 0 ? '+' : '';
      const pnlColor = summary.totalPnl >= 0 ? 'var(--bull)' : 'var(--bear)';
      atSummaryRow.innerHTML =
        `<span style="color:var(--text-dim)">Sim: ${summary.trades}T</span>` +
        `&nbsp;${summary.won}W / ${summary.lost}L` +
        (summary.winRate !== null ? `&nbsp;<span style="color:var(--text-dim)">${summary.winRate}% WR</span>` : '') +
        `&nbsp;·&nbsp;<span style="color:${pnlColor};font-weight:700">${pnlSign}$${summary.totalPnl}</span>`;
    } else if (atSummaryRow) {
      atSummaryRow.textContent = '';
    }

    if (lastOrder && atLastOrderEl) {
      atLastOrderEl.textContent =
        `Last: ${lastOrder.symbol} ${lastOrder.direction === 'bullish' ? '▲' : '▼'} #${lastOrder.orderId}`;
    }
    if (atMinConfInput && minConfidence != null) atMinConfInput.value = minConfidence;
  }

  function _initAutotrader() {
    // Toggle button
    atToggleBtn?.addEventListener('click', async () => {
      const nowLive = atToggleBtn.classList.contains('at-live');
      await fetch('/api/autotrader/toggle', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled: !nowLive }),
      });
      _pollAutotrader();
    });

    // Min-confidence input
    atMinConfInput?.addEventListener('change', () => {
      fetch('/api/autotrader/settings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ minConfidence: parseInt(atMinConfInput.value) }),
      });
    });

    // Initial poll + 10-second refresh
    _pollAutotrader();
    setInterval(_pollAutotrader, 10_000);
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  let _wsRetryDelay = 1000;
  const _wsMaxDelay = 30_000;

  function _setWsStatus(state) {
    const el = document.getElementById('ws-status');
    if (el) el.className = `ws-status ws-${state}`;
  }

  function connectWS() {
    _setWsStatus('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      _wsRetryDelay = 1000; // reset on successful connect
      _setWsStatus('connected');
      console.log('[ws] Connected');
    };
    ws.onclose = () => {
      _setWsStatus('disconnected');
      const jitter = Math.random() * 500;
      setTimeout(connectWS, _wsRetryDelay + jitter);
      _wsRetryDelay = Math.min(_wsMaxDelay, _wsRetryDelay * 2);
    };
    ws.onerror = err => console.error('[ws] Error:', err);

    ws.onmessage = event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'setup') {
          // Play sound alert if enabled and confidence passes user filter
          if (window._soundAlertsEnabled && (msg.setup?.confidence ?? 0) >= minConf) {
            _playAlertSound(msg.setup?.direction);
          }
          fetchAndRender(); // re-fetch to keep trade filter accurate
        }
        if (msg.type === 'order') {
          // A virtual order was placed — flash the last-order display
          if (atLastOrderEl) {
            atLastOrderEl.textContent =
              `✓ ${msg.symbol} ${msg.direction === 'bullish' ? '▲' : '▼'} placed`;
            atLastOrderEl.style.color = 'var(--bull)';
            setTimeout(() => {
              atLastOrderEl.style.color = '';
              _pollAutotrader();
            }, 4000);
          }
        }
        if (msg.type === 'sim_fill') {
          // Simulator position closed — show a toast and refresh stats
          const won  = msg.status === 'hit_tp';
          const sign = msg.pnl >= 0 ? '+' : '';
          _showFillToast(
            `${won ? '✓' : '✗'} ${msg.symbol} ${won ? 'TP HIT' : 'SL HIT'} · ${sign}$${msg.pnl}`
          );
          _pollAutotrader();
          fetchAndRender();
        }
        if (msg.type === 'data_refresh') {
          // Snapshot prev keys before refetch so new cards can be highlighted
          _prevAlertKeys = new Set(currentAlerts.map(_alertKey));
          window.ChartAPI?.reload();   // re-fetch chart candles + indicators
          fetchAndRender();            // re-fetch alert feed (open outcomes may have resolved)
          _setRefreshTimes(msg.ts, msg.nextRefresh);
          if (msg.newAlerts > 0) _showNewAlertBanner(msg.newAlerts);
          // Refresh correlation heatmap on data refresh
          if (cfg.features?.correlationHeatmap) _updateCorrelationHeatmap();
        }
        if (msg.type === 'refresh_schedule') {
          // Server rescheduled the interval (e.g. settings change) — sync countdown + select
          _setRefreshTimes(null, msg.nextRefresh);
          if (refreshIntervalEl && msg.intervalMins) {
            refreshIntervalEl.value = msg.intervalMins;
          }
        }
      } catch (_) {}
    };
  }

  // ── localStorage helpers ───────────────────────────────────────────────────

  const LS_KEY = 'futuresedge_risk';

  function _saveLocal() {
    localStorage.setItem(LS_KEY, JSON.stringify({
      mnqContracts:  cfg.mnqContracts,
      mgcContracts:  cfg.mgcContracts,
      maxRiskDollars: cfg.maxRiskDollars,
      minConfidence: minConf,
      rrRatio:       cfg.rrRatio,
    }));
  }

  function _loadLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }
    catch (_) { return null; }
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  boot();

})();
