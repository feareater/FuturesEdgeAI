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
  const TICK_SIZE  = { MNQ: 0.25,  MGC: 0.10 };
  const TICK_VALUE = { MNQ: 0.50,  MGC: 1.00  };

  // ── Settings (loaded from server defaults, overridden by localStorage) ─────
  let cfg = { mnqContracts: 5, mgcContracts: 3, maxRiskDollars: 200, rrRatio: 2.0 };
  let minConf = 65;

  // ── Active chart view — synced from chart.js via chartViewChange event ──────
  let activeSymbol = 'MNQ';
  let activeTf     = '5m';

  // Raw alerts from the last fetch (one per confidence threshold query)
  let currentAlerts = [];

  // ── Trade log (alertKey → trade object) ───────────────────────────────────
  const takenTrades = new Map();
  // Bridge for chart.js (which loads first) to check taken state
  window._isTaken = (key) => takenTrades.has(key);

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

  // ── Mobile tab DOM refs ────────────────────────────────────────────────────
  const rightPanel      = document.getElementById('right-panel');
  const tabAlertBadge   = document.getElementById('tab-alert-badge');

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
  }

  // ── Alert key helper ───────────────────────────────────────────────────────

  function _alertKey(a) {
    return `${a.symbol}:${a.timeframe}:${a.setup.type}:${a.setup.time}`;
  }

  // ── New alert banner ───────────────────────────────────────────────────────

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

  // ── Boot ────────────────────────────────────────────────────────────────────

  async function boot() {
    // Load server-side risk defaults (includes rrRatio from settings.json)
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const { risk } = await res.json();
        cfg = { ...cfg, ...risk };
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
    _updateSessionBadge();
    setInterval(_updateSessionBadge, 60_000);
    setInterval(_tickDataAge, 1000);  // live countdown

    // Listen for chart symbol/TF changes (dispatched by chart.js after each loadData)
    document.addEventListener('chartViewChange', (e) => {
      activeSymbol = e.detail.symbol;
      activeTf     = e.detail.tf;
      // Immediately sync markers — this clears stale markers (old symbol/TF alerts
      // won't match the new filter and produce an empty alertMarkers array).
      // fetchAndRender will re-populate with the correct alerts for the new view.
      _syncChartMarkers();
      fetchAndRender();
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
    if (!currentAlerts.length) {
      const msg = minConf > 0
        ? `No ${activeSymbol} setups at ≥${minConf}% confidence.`
        : `No ${activeSymbol} setups detected yet.`;
      alertFeed.innerHTML = `<p class="placeholder">${msg}</p>`;
      // Clear prev keys so next refresh can detect new alerts correctly
      _prevAlertKeys = new Set();
      return;
    }

    const active = currentAlerts.filter(a => !takenTrades.has(_alertKey(a)));
    const taken  = currentAlerts.filter(a =>  takenTrades.has(_alertKey(a)));

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

    // ── Taken Trades section ────────────────────────────────────────────────
    if (taken.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'taken-section-header';
      sep.innerHTML = `<span>Taken Trades</span><span class="taken-count">${taken.length}</span>`;
      alertFeed.appendChild(sep);

      for (const a of taken) {
        const card = _buildCard(a);
        card.classList.add('is-taken-card');
        alertFeed.appendChild(card);
      }
    }

    _prevAlertKeys = new Set(); // clear after render
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
    const contracts = alert.symbol === 'MNQ' ? cfg.mnqContracts : cfg.mgcContracts;
    const ticks     = pts / TICK_SIZE[alert.symbol];
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

    card.innerHTML = [
      `<div class="alert-header">`,
      `  <span class="alert-sym">${symbol}</span>`,
      `  <span class="alert-tf">${timeframe}</span>`,
      `  <span class="alert-type">${_fmtType(setup.type)}</span>`,
      `  <span class="alert-dir ${dirClass}">${dirArrow}</span>`,
      suppressed ? `  <span class="alert-suppressed-tag">filtered</span>` : '',
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
      default:                         return type;
    }
  }

  // ── Input wiring ───────────────────────────────────────────────────────────

  let _rrTimer = null;

  function _wireInputs() {
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
          fetchAndRender(); // re-fetch to keep trade filter accurate
        }
        if (msg.type === 'data_refresh') {
          // Snapshot prev keys before refetch so new cards can be highlighted
          _prevAlertKeys = new Set(currentAlerts.map(_alertKey));
          window.ChartAPI?.reload();   // re-fetch chart candles + indicators
          fetchAndRender();            // re-fetch alert feed (open outcomes may have resolved)
          _setRefreshTimes(msg.ts, msg.nextRefresh);
          if (msg.newAlerts > 0) _showNewAlertBanner(msg.newAlerts);
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
