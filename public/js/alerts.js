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
  // Crypto perps (Coinbase INTX): modeled as 1:1 per point per contract
  // BTC: $1 move = $1/contract  |  ETH: $0.01 move = $0.01/contract  |  XRP: $0.0001 = $0.0001
  const TICK_SIZE  = { MNQ: 0.25, MGC: 0.10, MES: 0.25, MCL: 0.01, BTC: 1.0, ETH: 0.01, XRP: 0.0001 };
  const TICK_VALUE = { MNQ: 0.50, MGC: 1.00, MES: 1.25, MCL: 1.00, BTC: 1.0, ETH: 0.01, XRP: 0.0001 };

  // ── Settings (loaded from server defaults, overridden by localStorage) ─────
  let cfg = { mnqContracts: 5, mgcContracts: 3, mesContracts: 2, mclContracts: 2,
              btcContracts: 1, ethContracts: 1, xrpContracts: 1,
              maxRiskDollars: 200, rrRatio: 2.0, features: {} };
  let minConf = 65;

  // Sound alerts enabled flag (toggleable by feature panel)
  window._soundAlertsEnabled = false;

  // ── Pine Script export ────────────────────────────────────────────────────
  window._copyPineScript = async function() {
    const btn = document.getElementById('pine-copy-btn');
    if (btn) { btn.textContent = 'Fetching…'; btn.disabled = true; }
    try {
      const res  = await fetch(`/api/pine-script?symbol=${activeSymbol}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      if (btn) { btn.textContent = '✓ Copied!'; btn.classList.add('copied'); }
      setTimeout(() => {
        if (btn) { btn.textContent = 'Pine Script'; btn.classList.remove('copied'); btn.disabled = false; }
      }, 3000);
    } catch (err) {
      if (btn) { btn.textContent = 'Error'; btn.disabled = false; }
      setTimeout(() => { if (btn) { btn.textContent = 'Pine Script'; } }, 2000);
      console.error('[pine] copy failed:', err.message);
    }
  };

  // ── Active chart view — synced from chart.js via chartViewChange event ──────
  let activeSymbol = 'MNQ';
  let activeTf     = '5m';

  // Raw alerts from the last fetch (one per confidence threshold query)
  let currentAlerts = [];
  // All-symbol alerts for the Predictions panel (no symbol filter)
  let allAlerts = [];

  // ── Trade log (alertKey → trade object) ───────────────────────────────────
  const takenTrades = new Map();
  // Bridge for chart.js (which loads first) to check taken state
  window._isTaken = (key) => takenTrades.has(key);

  // ── Price formatter — XRP uses 4 decimal places ───────────────────────────
  function _fmtP(symbol, n) {
    if (n == null) return '—';
    return symbol === 'XRP' ? n.toFixed(4) : n.toFixed(2);
  }

  // ── Taken+open alerts across all symbols ──────────────────────────────────
  // Persisted to localStorage so the section survives symbol changes and reloads.
  const takenOpenAlertData = new Map(); // alertKey → full alert object
  const _TAKEN_OPEN_LS = 'futuresedge_taken_open';

  // ── Resolved monitored trades (TP/SL hit) — shown in Resolved section ─────
  const resolvedAlertData = new Map(); // alertKey → full alert object with outcome set
  const _RESOLVED_LS = 'futuresedge_resolved';

  function _saveResolved() {
    try {
      localStorage.setItem(_RESOLVED_LS, JSON.stringify([...resolvedAlertData.values()]));
    } catch {}
  }

  function _saveTakenOpen() {
    try {
      localStorage.setItem(_TAKEN_OPEN_LS, JSON.stringify([...takenOpenAlertData.values()]));
    } catch {}
  }

  // ── Manual trades (not tied to detected setups) ────────────────────────────
  const manualTrades = [];

  // ── New-alert highlighting state ──────────────────────────────────────────
  let _prevAlertKeys      = new Set();
  let _lastKnownCandleTime = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const alertFeed      = document.getElementById('alert-feed');
  const wrWon          = document.getElementById('wr-won');
  const wrLost         = document.getElementById('wr-lost');
  const wrOpen         = document.getElementById('wr-open');
  const wrPct          = document.getElementById('wr-pct');
  const minConfInput   = document.getElementById('min-conf');
  const mnqInput       = document.getElementById('mnq-contracts');
  const mgcInput       = document.getElementById('mgc-contracts');
  const btcInput       = document.getElementById('btc-contracts');
  const ethInput       = document.getElementById('eth-contracts');
  const xrpInput       = document.getElementById('xrp-contracts');
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

  // ── Correlation heatmap ───────────────────────────────────────────────────

  const CORR_SYMS = ['MNQ', 'MES', 'MCL', 'MGC', 'SIL', 'DXY', 'VIX', 'BTC', 'ETH', 'XRP', 'XLM'];

  function _corrColor(v) {
    // v in [-1, 1]: green for high positive, red for high negative, dim for near-0
    if (v >= 0.7)  return '#4caf50';
    if (v >= 0.4)  return '#8bc34a';
    if (v >= 0.1)  return '#607d8b';
    if (v >= -0.1) return '#546e7a';
    if (v >= -0.4) return '#ef9a9a';
    return '#ef4444';
  }

  async function _updateCorrHeatmap() {
    const el = document.getElementById('corr-heatmap');
    const ageEl = document.getElementById('corr-age');
    if (!el) return;
    try {
      const res = await fetch('/api/correlation');
      if (!res.ok) return;
      const data = res.status === 204 ? null : await res.json();
      if (!data?.matrix) { el.innerHTML = '<div class="corr-loading">Not enough data yet.</div>'; return; }

      const { matrix, updatedAt } = data;
      if (ageEl && updatedAt) {
        const mins = Math.round((Date.now() - new Date(updatedAt)) / 60000);
        ageEl.textContent = mins < 2 ? '' : `${mins}m ago`;
      }

      // Header row — abbreviated for compact fit
      const abbr = { MNQ:'NQ', MES:'ES', MCL:'CL', MGC:'GC', SIL:'SI', DXY:'DX', VIX:'VX', BTC:'BT', ETH:'ET', XRP:'XR', XLM:'XL' };
      let html = '<table class="corr-table"><thead><tr><th></th>';
      CORR_SYMS.forEach(s => { html += `<th title="${s}">${abbr[s] || s}</th>`; });
      html += '</tr></thead><tbody>';

      CORR_SYMS.forEach(rowSym => {
        html += `<tr><td class="corr-sym">${rowSym}</td>`;
        CORR_SYMS.forEach(colSym => {
          const v = matrix[rowSym]?.[colSym] ?? 0;
          if (rowSym === colSym) {
            html += `<td class="corr-cell corr-diag">—</td>`;
          } else {
            const color = _corrColor(v);
            const label = v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
            html += `<td class="corr-cell" style="color:${color}" title="${rowSym} vs ${colSym}: ${label}">${label}</td>`;
          }
        });
        html += '</tr>';
      });

      html += '</tbody></table>';
      html += '<div class="corr-legend">';
      html += '<span style="color:#4caf50">■</span> Strong+ &nbsp;';
      html += '<span style="color:#8bc34a">■</span> Mild+ &nbsp;';
      html += '<span style="color:#607d8b">■</span> Neutral &nbsp;';
      html += '<span style="color:#ef9a9a">■</span> Mild− &nbsp;';
      html += '<span style="color:#ef4444">■</span> Strong−';
      html += '</div>';

      el.innerHTML = html;
    } catch (_) {}
  }

  // ── Options data (OI walls, max pain, P/C ratio, ATM IV) ───────────────────

  // ── Forex rate (Polygon.io) ───────────────────────────────────────────────

  async function _fetchForexRate() {
    const priceEl  = document.getElementById('forex-price');
    const changeEl = document.getElementById('forex-change');
    if (!priceEl) return;
    try {
      const res = await fetch('/api/forex?pair=GBPUSD');
      if (!res.ok) return;
      const { data } = await res.json();
      if (!data || data.price == null) return;
      priceEl.textContent  = data.price.toFixed(4);
      const chg = data.change;
      if (chg != null) {
        const label = data.label === 'prev-day' ? ' prev' : '';
        changeEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' + label;
        changeEl.className = 'forex-change ' + (chg >= 0 ? 'forex-up' : 'forex-down');
      }
    } catch (_) {}
  }

  // ── Data age badge ─────────────────────────────────────────────────────────
  // Shows how stale the last candle is relative to now.
  // Called on initial load (with last candle time) and on live_price ticks.

  const TF_SECS = { '1m':60,'2m':120,'3m':180,'5m':300,'15m':900,'30m':1800,'1h':3600,'2h':7200,'4h':14400 };

  function _updateDataAgeBadge(symbol, candleTimeUnix) {
    const el = document.getElementById('data-age-text');
    if (!el) return;
    const ageSecs  = Math.floor(Date.now() / 1000) - candleTimeUnix;
    const tfSecs   = TF_SECS[activeTf] || 300;
    const candles  = Math.floor(ageSecs / tfSecs);
    const mins     = Math.round(ageSecs / 60);
    const badge    = document.getElementById('data-age-badge');

    if (ageSecs < 60)       el.textContent = ageSecs + 's old';
    else if (mins < 60)     el.textContent = mins + 'm old';
    else                    el.textContent = Math.round(mins / 60) + 'h old';

    // Colour: green < 1 candle, amber 1-3 candles, red > 3 candles
    if (badge) {
      badge.className = 'data-age-badge ' + (
        candles < 1 ? 'age-fresh' : candles < 3 ? 'age-stale' : 'age-old'
      );
      // Show last candle time in MT on hover
      const candleMT = new Date(candleTimeUnix * 1000).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
        timeZone: 'America/Denver',
      });
      badge.title = `Last candle: ${candleMT} MT`;
    }
  }

    // Last gamma data — shared between options widget and predictions panel
  let _lastGammaData = null;

  // QQQ options expire Mon/Wed/Fri — these are 0DTE days for equity index futures (MNQ/MES)
  function _isZeroDTE() { const d = new Date().getDay(); return [1, 3, 5].includes(d); }

  async function _fetchOptionsData(symbol) {
    // Get current futures price for strike scaling
    let futuresPrice = null;
    try {
      const cr = await fetch(`/api/candles?symbol=${symbol}&timeframe=15m`);
      if (cr.ok) {
        const { candles } = await cr.json();
        futuresPrice = candles?.[candles.length - 1]?.close ?? null;
      }
    } catch (_) {}

    const fp = futuresPrice ? `&futuresPrice=${futuresPrice}` : '';

    // Try Polygon.io options flow first (better data), fall back to Yahoo Finance
    let usedPolygon = false;
    try {
      const [yahoRes, polyRes, gammaRes] = await Promise.all([
        fetch(`/api/options?symbol=${symbol}${fp}`),
        fetch(`/api/options/flow?symbol=${symbol}${fp}`),
        fetch(`/api/gamma?symbol=${symbol}${fp}`),
      ]);

      // Gamma levels (flip, call wall, put wall) — send to chart regardless of other data
      if (gammaRes.ok) {
        const { data: gd } = await gammaRes.json();
        _lastGammaData = gd;
        window.ChartAPI?.setGammaLevels?.(gd);
        _updateGammaWidget(gd);
      }

      // Polygon options (ETF proxy with scaled strikes)
      if (polyRes.ok) {
        const { data: polyData } = await polyRes.json();
        if (polyData) {
          const walls = (polyData.scaled?.oiWalls ?? polyData.oiWalls ?? [])
            .map(w => w.futuresStrike ?? w.strike)
            .filter(Boolean)
            .slice(0, 3);
          const maxPain = polyData.scaled?.maxPain ?? polyData.maxPain ?? null;
          const polyLevels = { oiWalls: walls, maxPain, pcRatio: polyData.pcRatio, atmIV: polyData.atmIV };
          window.ChartAPI?.setOptionsLevels?.(polyLevels);
          _updateOptionsWidget({ ...polyLevels, source: 'Polygon' });
          usedPolygon = true;
        }
      }

      // CBOE/Yahoo — QQQ/SPY proxy for MNQ/MES; GLD/USO for MGC/MCL.
      // Returns scaled* fields when futuresPrice was provided.
      if (!usedPolygon && yahoRes.ok) {
        const { options } = await yahoRes.json();
        if (options) {
          // Use futures-scaled levels when available (MNQ→QQQ proxy, scaled to NQ price space)
          const hasScaled = options.scaledOiWalls || options.scaledMaxPain;
          const scaledLevels = hasScaled
            ? {
                oiWalls:                options.scaledOiWalls           ?? options.oiWalls,
                maxPain:                options.scaledMaxPain            ?? options.maxPain,
                pcRatio:                options.pcRatio,
                atmIV:                  options.atmIV,
                source:                 options.source,
                dexScore:               options.dexScore,
                dexBias:                options.dexBias,
                resilience:             options.resilience,
                resilienceLabel:        options.resilienceLabel,
                scaledDaily:            options.scaledDaily             ?? null,
                scaledLiquidityZones:   options.scaledLiquidityZones    ?? null,
                scaledHedgePressureZones: options.scaledHedgePressureZones ?? null,
                scaledPivotCandidates:  options.scaledPivotCandidates   ?? null,
              }
            : options;
          window.ChartAPI?.setOptionsLevels?.(scaledLevels);
          _updateOptionsWidget(scaledLevels);

          // Also push gamma-derived levels to the gamma chart layer (flip, call wall, put wall)
          const flip     = options.scaledGexFlip   ?? options.gexFlip;
          const callWall = options.scaledCallWall  ?? options.callWall;
          const putWall  = options.scaledPutWall   ?? options.putWall;
          if (flip != null || callWall != null || putWall != null) {
            const gammaData = {
              flipLevel: flip, callWall, putWall,
              hasGreeks: true,
              isZeroDTE: _isZeroDTE(),
              source: options.source,
            };
            _lastGammaData = gammaData;
            window.ChartAPI?.setGammaLevels?.(gammaData);
            _updateGammaWidget(gammaData);
          }
        }
      }
    } catch (_) {}
  }

  function _updateGammaWidget(data) {
    const el = document.getElementById('gamma-widget');
    if (!el) return;
    if (!data) { el.style.display = 'none'; return; }
    el.style.display = '';

    const s = data.scaled || {};
    const flip = s.flipLevel ?? data.flipLevel;

    // Determine regime relative to current price
    // (We approximate current price from options widget or leave as context-only)
    const zdteTag = data.isZeroDTE ? ' <span class="gamma-0dte">0DTE</span>' : '';
    const flipStr = flip != null ? flip.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';

    let regimeHtml = '';
    if (flip != null) {
      // We'll update this after we know current price — for now show the level
      regimeHtml = `<span class="gamma-flip-label">γ Flip: <strong>${flipStr}</strong></span>`;
    }
    if (!data.hasGreeks) {
      regimeHtml += ' <span style="color:var(--text-dim);font-size:9px">(no greeks)</span>';
    }

    el.innerHTML = regimeHtml + zdteTag;
  }

  // Called by chart price update or after candles load to show above/below flip regime
  function _updateGammaRegime(currentPrice) {
    const el = document.getElementById('gamma-widget');
    if (!el || !_lastGammaData) return;
    const s = _lastGammaData.scaled || {};
    const flip = s.flipLevel ?? _lastGammaData.flipLevel;
    if (flip == null || currentPrice == null) return;
    const above = currentPrice >= flip;
    const zdteTag = _lastGammaData.isZeroDTE ? ' <span class="gamma-0dte">0DTE</span>' : '';
    const flipStr = flip.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const cls = above ? 'gamma-above' : 'gamma-below';
    const label = above ? '▲ Above γ Flip — low vol' : '▼ Below γ Flip — high vol';
    el.innerHTML = `<span class="${cls}">${label}</span> <span class="gamma-flip-label">(${flipStr})${zdteTag}</span>`;
  }

  function _updateOptionsWidget(data) {
    const widget        = document.getElementById('options-widget');
    const pcEl          = document.getElementById('opt-pc');
    const ivEl          = document.getElementById('opt-iv');
    const maxPainEl     = document.getElementById('opt-maxpain');
    const sourceEl      = document.getElementById('opt-source');
    const dexEl         = document.getElementById('opt-dex');
    const resilienceEl  = document.getElementById('opt-resilience');
    if (!widget) return;
    if (!data) { widget.style.display = 'none'; return; }
    widget.style.display = '';
    if (sourceEl) {
      sourceEl.textContent = data.source ? `${data.source} ` : '';
    }
    if (pcEl) {
      const v = data.pcRatio;
      pcEl.textContent = v != null ? v.toFixed(2) : '—';
      pcEl.className   = 'opt-value' + (v > 1.3 ? ' opt-bearish' : v < 0.7 ? ' opt-bullish' : '');
    }
    if (ivEl) {
      ivEl.textContent = data.atmIV != null ? `${(data.atmIV * 100).toFixed(1)}%` : '—';
    }
    if (maxPainEl) {
      const mp = data.maxPain;
      maxPainEl.textContent = mp != null ? mp.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
    }
    if (dexEl && data.dexBias != null) {
      const score = data.dexScore;
      dexEl.textContent = score != null ? `${score > 0 ? '+' : ''}${score}` : '—';
      dexEl.className   = 'opt-value' + (data.dexBias === 'bullish' ? ' opt-bullish' : data.dexBias === 'bearish' ? ' opt-bearish' : '');
      dexEl.title       = `Dealer Delta Exposure: dealers are net ${data.dexBias === 'bullish' ? 'long futures (buying pressure)' : data.dexBias === 'bearish' ? 'short futures (selling pressure)' : 'flat'}`;
    }
    if (resilienceEl && data.resilience != null) {
      resilienceEl.textContent = `${data.resilience}`;
      resilienceEl.className   = 'opt-value' + (data.resilience >= 65 ? ' opt-bullish' : data.resilience < 40 ? ' opt-bearish' : '');
      resilienceEl.title       = `Market resilience: ${data.resilienceLabel} — ${data.resilience >= 65 ? 'options market acting as shock absorber (mean-reverting)' : data.resilience < 40 ? 'options market amplifying moves (trending)' : 'mixed regime'}`;
    }
  }

  // ── Directional Prediction ───────────────────────────────────────────────

  async function _fetchPrediction() {
    const widget   = document.getElementById('prediction-widget');
    const symLabel = document.getElementById('pred-symbol-label');
    if (!widget) return;

    if (symLabel) symLabel.textContent = `${activeSymbol} · ${activeTf}`;
    widget.innerHTML = '<div class="pred-loading">Computing…</div>';

    try {
      const res = await fetch(`/api/predict?symbol=${activeSymbol}&timeframe=${activeTf}`);
      if (!res.ok) { widget.innerHTML = '<div class="pred-loading">Unavailable</div>'; return; }
      const d = await res.json();
      if (!d || !d.direction) { widget.innerHTML = '<div class="pred-loading">No data</div>'; return; }

      const cls   = d.direction === 'bullish' ? 'bull' : d.direction === 'bearish' ? 'bear' : 'neut';
      const arrow = d.direction === 'bullish' ? '▲' : d.direction === 'bearish' ? '▼' : '—';
      const label = d.direction === 'bullish' ? 'LONG' : d.direction === 'bearish' ? 'SHORT' : 'NEUTRAL';
      const conf  = d.confidence ?? 0;
      const score = d.score ?? 0;
      const scoreStr = (score >= 0 ? '+' : '') + score;

      const fmt = v => v != null ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—';
      const diff = (v, base) => {
        if (v == null || base == null) return '';
        const delta = v - base;
        return `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`;
      };

      const factorsHtml = (d.factors || []).map(f => {
        const ptsCls = f.pts >= 0 ? 'pos' : 'neg';
        const ptsStr = (f.pts >= 0 ? '+' : '') + f.pts;
        return `<div class="pred-factor-row"><span>${f.label}</span><span class="pf-pts ${ptsCls}">${ptsStr}</span></div>`;
      }).join('');

      const candleTime = d.candleTime
        ? new Date(d.candleTime * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }) + ' ET'
        : '—';

      widget.innerHTML = `
        <div class="pred-direction">
          <span class="pred-arrow ${cls}">${arrow}</span>
          <span class="pred-label ${cls}">${label}</span>
          <span style="font-size:10px;color:var(--text-dim);margin-left:auto">score: ${scoreStr}</span>
        </div>
        <div class="pred-conf-row">
          <span style="font-size:10px;color:var(--text-dim)">Confidence</span>
          <div class="pred-conf-bar"><div class="pred-conf-fill ${cls}" style="width:${conf}%"></div></div>
          <span class="pred-conf-pct">${conf}%</span>
        </div>
        <div class="pred-prices">
          <span class="pred-pl">Current</span><span class="pred-pv">${fmt(d.price)}</span><span></span>
          <span class="pred-pl">Target TP</span><span class="pred-pv">${fmt(d.predictedTP)}</span><span class="pred-pp ${cls}">${diff(d.predictedTP, d.price)}</span>
          <span class="pred-pl">Stop SL</span><span class="pred-pv">${fmt(d.predictedSL)}</span><span class="pred-pp ${d.direction === 'bullish' ? 'bear' : 'bull'}">${diff(d.predictedSL, d.price)}</span>
          <span class="pred-pl">↑ ${fmt(d.targetUp)}</span><span class="pred-pv" style="font-size:10px;color:var(--bull)">+${d.movePoints}</span><span></span>
          <span class="pred-pl">↓ ${fmt(d.targetDown)}</span><span class="pred-pv" style="font-size:10px;color:var(--bear)">−${d.movePoints}</span><span></span>
        </div>
        ${factorsHtml ? `<div class="pred-factors">${factorsHtml}</div>` : ''}
        <div class="pred-candle-time">Candle: ${candleTime}</div>
      `;

      // ── Take This Bias button ───────────────────────────────────────────
      if (d.direction !== 'neutral' && d.predictedTP != null && d.predictedSL != null) {
        const biasTime = d.candleTime || Math.floor(Date.now() / 1000);
        const aiKey    = `${activeSymbol}:${activeTf}:bias:${biasTime}`;

        const takeWrap = document.createElement('div');
        takeWrap.className = 'bias-take-wrap';
        takeWrap.innerHTML = `
          <div class="bias-btn-row">
            <button class="bias-monitor-btn">Monitor</button>
            <button class="bias-take-btn">Take</button>
          </div>
          <div class="bias-trade-form" style="display:none"></div>`;
        widget.appendChild(takeWrap);

        const biasMonitorBtn = takeWrap.querySelector('.bias-monitor-btn');
        const biasTakeBtn    = takeWrap.querySelector('.bias-take-btn');
        const biasFormEl     = takeWrap.querySelector('.bias-trade-form');
        const fv = n => n != null ? n.toFixed(2) : '';

        // Monitor: immediate, no form
        biasMonitorBtn.addEventListener('click', async e => {
          e.stopPropagation();
          const factorSummary = (d.factors || []).map(f => f.label).join(', ');
          const syntheticAlert = {
            symbol: activeSymbol, timeframe: activeTf,
            ts: new Date().toISOString(),
            setup: {
              type: 'bias', direction: d.direction, time: biasTime,
              price: d.price, entry: d.price, sl: d.predictedSL, tp: d.predictedTP,
              riskPoints: Math.abs(d.price - (d.predictedSL || d.price)),
              confidence: d.confidence,
              rationale: `${label} bias · ${conf}% · ${factorSummary}`,
              outcome: 'open',
            },
            mode: 'monitor', takenAt: new Date().toISOString(),
          };
          try {
            const res = await fetch('/api/trades', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                alertKey: aiKey, symbol: activeSymbol, timeframe: activeTf, setupType: 'bias', mode: 'monitor',
                actualEntry: d.price, actualSL: d.predictedSL, actualTP: d.predictedTP,
              }),
            });
            if (!res.ok) throw new Error(res.status);
            const { trade } = await res.json();
            takenTrades.set(aiKey, trade);
            takenOpenAlertData.set(aiKey, syntheticAlert);
            _saveTakenOpen();
            _renderFeed();
            biasMonitorBtn.textContent = '● Monitoring';
            biasMonitorBtn.disabled    = true;
            biasTakeBtn.disabled       = true;
          } catch (err) {
            console.error('[bias-monitor] Save failed:', err.message);
          }
        });

        biasTakeBtn.addEventListener('click', e => {
          e.stopPropagation();
          const isOpen = biasFormEl.style.display !== 'none';
          biasFormEl.style.display = isOpen ? 'none' : 'block';
          if (!isOpen) {
            biasFormEl.innerHTML = `
              <div class="trade-form-inner">
                <div class="tf-row">
                  <label>Entry</label>
                  <input class="tf-entry" type="number" step="0.25" value="${fv(d.price)}">
                  <label>SL</label>
                  <input class="tf-sl" type="number" step="0.25" value="${fv(d.predictedSL)}">
                  <label>TP</label>
                  <input class="tf-tp" type="number" step="0.25" value="${fv(d.predictedTP)}">
                </div>
                <div class="tf-row">
                  <label>Notes</label>
                  <input class="tf-notes" type="text" placeholder="Optional" style="flex:1">
                </div>
                <div class="tf-btns">
                  <button class="tf-save">Confirm Take</button>
                  <button class="tf-cancel">Cancel</button>
                </div>
              </div>`;
            biasFormEl.querySelector('.tf-cancel').addEventListener('click', ev => {
              ev.stopPropagation();
              biasFormEl.style.display = 'none';
            });
            biasFormEl.querySelector('.tf-save').addEventListener('click', async ev => {
              ev.stopPropagation();
              const factorSummary = (d.factors || []).map(f => f.label).join(', ');
              const riskPts = Math.abs(d.price - d.predictedSL);
              const syntheticAlert = {
                symbol:    activeSymbol,
                timeframe: activeTf,
                ts:        new Date().toISOString(),
                setup: {
                  type:        'bias',
                  direction:   d.direction,
                  time:        biasTime,
                  price:       d.price,
                  entry:       parseFloat(biasFormEl.querySelector('.tf-entry').value) || d.price,
                  sl:          parseFloat(biasFormEl.querySelector('.tf-sl').value)    || d.predictedSL,
                  tp:          parseFloat(biasFormEl.querySelector('.tf-tp').value)    || d.predictedTP,
                  riskPoints:  riskPts,
                  confidence:  d.confidence,
                  rationale:   `${label} bias · ${conf}% · ${factorSummary}`,
                  outcome:     'open',
                },
              };
              const actualEntry = parseFloat(biasFormEl.querySelector('.tf-entry').value) || d.price;
              const actualSL    = parseFloat(biasFormEl.querySelector('.tf-sl').value)    || d.predictedSL;
              const actualTP    = parseFloat(biasFormEl.querySelector('.tf-tp').value)    || d.predictedTP;
              const body = {
                alertKey: aiKey, symbol: activeSymbol, timeframe: activeTf,
                setupType: 'bias', mode: 'take',
                actualEntry, actualSL, actualTP,
                notes: biasFormEl.querySelector('.tf-notes').value,
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
                const takeData = { ...syntheticAlert, mode: 'take', takenAt: new Date().toISOString(), actualEntry, actualSL, actualTP };
                takenOpenAlertData.set(aiKey, takeData);
                _saveTakenOpen();
                _renderFeed();
                _updateStats();
                biasFormEl.style.display = 'none';
                biasTakeBtn.textContent  = 'Taken ✓';
                biasTakeBtn.disabled     = true;
                biasMonitorBtn.disabled  = true;
              } catch (err) {
                console.error('[bias-take] Save failed:', err.message);
              }
            });
          }
        });
      }
    } catch (err) {
      widget.innerHTML = '<div class="pred-loading">Error loading prediction</div>';
      console.warn('[predict] fetch failed:', err.message);
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

    // Also wire any inline tab-switch buttons inside panels (e.g. "📈 Chart" in alert header)
    document.querySelectorAll('.tab-btn-inline[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
    });

    // On mobile default to Alerts so setups are immediately visible;
    // on desktop the bottom nav is hidden so this call has no effect.
    const startTab = window.matchMedia('(max-width: 767px)').matches ? 'alerts' : 'chart';
    _switchTab(startTab);
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
        // Request notification permission if push notifications enabled
        if (features?.pushNotifications && 'Notification' in window) {
          if (Notification.permission === 'default') {
            Notification.requestPermission();
          }
        }
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
    // Seed the data-age badge immediately from the actual last candle (don't wait for an alert)
    try {
      const cRes = await fetch(`/api/candles?symbol=${activeSymbol}&timeframe=5m`);
      if (cRes.ok) {
        const { candles } = await cRes.json();
        if (candles && candles.length) {
          const lastCandle = candles[candles.length - 1];
          _lastKnownCandleTime = lastCandle.time;
          _updateDataAgeBadge(activeSymbol, lastCandle.time);
        }
      }
    } catch (_) {}

    // Load trade log
    try {
      const tr = await fetch('/api/trades');
      if (tr.ok) {
        const { trades } = await tr.json();
        trades.forEach(t => takenTrades.set(t.alertKey, t));
        // If trades were cleared (e.g. manual reset), clear the local caches too
        if (trades.length === 0) {
          localStorage.removeItem(_TAKEN_OPEN_LS);
          localStorage.removeItem(_RESOLVED_LS);
        }
      }
    } catch (_) {}

    // Restore taken+open alert data from localStorage
    try {
      const saved = JSON.parse(localStorage.getItem(_TAKEN_OPEN_LS) || '[]');
      saved.forEach(a => {
        if (a?.setup?.outcome === 'open') takenOpenAlertData.set(_alertKey(a), a);
      });
    } catch (_) {}

    // Restore resolved monitored trades from localStorage
    try {
      const saved = JSON.parse(localStorage.getItem(_RESOLVED_LS) || '[]');
      saved.forEach(a => { if (a?.setup?.outcome) resolvedAlertData.set(_alertKey(a), a); });
    } catch (_) {}

    // Restore any locally saved overrides (client-only: contracts, maxRisk, minConf)
    const saved = _loadLocal();
    if (saved) {
      cfg.mnqContracts   = saved.mnqContracts   ?? cfg.mnqContracts;
      cfg.mgcContracts   = saved.mgcContracts   ?? cfg.mgcContracts;
      cfg.btcContracts   = saved.btcContracts   ?? cfg.btcContracts;
      cfg.ethContracts   = saved.ethContracts   ?? cfg.ethContracts;
      cfg.xrpContracts   = saved.xrpContracts   ?? cfg.xrpContracts;
      cfg.maxRiskDollars = saved.maxRiskDollars ?? cfg.maxRiskDollars;
    }
    minConf = saved?.minConfidence ?? cfg.minConfidence ?? 0;

    // Populate inputs
    minConfInput.value  = minConf;
    mnqInput.value      = cfg.mnqContracts;
    mgcInput.value      = cfg.mgcContracts;
    if (btcInput) btcInput.value = cfg.btcContracts;
    if (ethInput) ethInput.value = cfg.ethContracts;
    if (xrpInput) xrpInput.value = cfg.xrpContracts;
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

    // ── Live clock (Mountain Time) ──────────────────────────────────────
    const _clockEl = document.getElementById('live-clock');
    function _tickClock() {
      if (!_clockEl) return;
      _clockEl.textContent = new Date().toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', second: '2-digit',
        hour12: true, timeZone: 'America/Denver',
      }) + ' MT';
    }
    _tickClock();
    setInterval(_tickClock, 1000);

    // Initial calendar load
    if (cfg.features?.economicCalendar)   _updateCalendarBadge();
    if (cfg.features?.relativeStrength && (activeSymbol === 'MNQ' || activeSymbol === 'MES')) {
      _updateRSWidget();
    }
    if (cfg.features?.correlationHeatmap) {
      _updateCorrHeatmap();
      setInterval(_updateCorrHeatmap, 5 * 60 * 1000); // refresh every 5 min
    }
    _fetchOptionsData(activeSymbol);
    _fetchForexRate();
    _fetchPrediction();
    setInterval(_fetchForexRate, 10 * 60 * 1000); // refresh every 10 min

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
      _fetchPrediction();
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
        const [symRes, allRes] = await Promise.all([
          fetch(`/api/alerts?limit=100&minConfidence=${minConf}&symbol=${activeSymbol}`),
          fetch(`/api/alerts?limit=200&minConfidence=${minConf}`),
        ]);
        if (!symRes.ok) throw new Error(`/api/alerts ${symRes.status}`);
        const { alerts } = await symRes.json();
        currentAlerts = alerts;
        allAlerts = allRes.ok ? (await allRes.json()).alerts : alerts;
        // Update data-age badge from the most-recent alert's candle time
        if (alerts.length > 0) {
          const newestCandle = Math.max(...alerts.map(a => a.setup.time || 0));
          if (newestCandle > 0) {
            _lastKnownCandleTime = newestCandle;
            _updateDataAgeBadge(activeSymbol, newestCandle);
          }
        }
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
        _renderPredictions();
        _updateStats();
        _syncChartMarkers();
        console.log(`[alerts] ${alerts.length} alerts  sym=${activeSymbol}  minConf=${minConf}`);
      } catch (err) {
        console.error('[alerts] Fetch failed:', err.message, '\n', err.stack);
        alertFeed.innerHTML =
          '<p class="placeholder error">Could not load alerts. <a id="alerts-retry">Retry</a></p>';
        document.getElementById('alerts-retry')?.addEventListener('click', () => fetchAndRender());
      }
    }, debounceMs);
  }

  // ── Feed section collapse helpers ────────────────────────────────────────
  const _FEED_COLL_KEY = 'futuresedge_feed_sections';
  function _isFeedSectionCollapsed(id) {
    try { return JSON.parse(localStorage.getItem(_FEED_COLL_KEY) || '{}')[id] === true; } catch { return false; }
  }
  function _setFeedSectionCollapsed(id, val) {
    try {
      const s = JSON.parse(localStorage.getItem(_FEED_COLL_KEY) || '{}');
      s[id] = val;
      localStorage.setItem(_FEED_COLL_KEY, JSON.stringify(s));
    } catch {}
  }
  // Builds a collapsible section header + body and appends both to target (defaults to alertFeed).
  function _appendFeedSection(label, count, sectionId, hdrExtraClass, cards, target) {
    target = target || alertFeed;
    const collapsed = _isFeedSectionCollapsed(sectionId);
    const hdr = document.createElement('div');
    hdr.className = 'taken-section-header feed-section-hdr' + (hdrExtraClass ? ` ${hdrExtraClass}` : '');
    hdr.innerHTML = `<span>${label}</span>` +
      `<span class="feed-section-hdr-right">` +
      `<span class="taken-count">${count}</span>` +
      `<span class="feed-chevron">${collapsed ? '▸' : '▾'}</span>` +
      `</span>`;
    target.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'feed-section-body';
    if (collapsed) body.style.display = 'none';
    for (const card of cards) body.appendChild(card);
    target.appendChild(body);

    hdr.addEventListener('click', () => {
      const isNowCollapsed = body.style.display === 'none';
      body.style.display = isNowCollapsed ? '' : 'none';
      hdr.querySelector('.feed-chevron').textContent = isNowCollapsed ? '▾' : '▸';
      _setFeedSectionCollapsed(sectionId, !isNowCollapsed);
    });
  }

  function _renderFeed() {
    alertFeed.innerHTML = '';

    const openTaken = [...takenOpenAlertData.values()];

    if (openTaken.length === 0) {
      alertFeed.innerHTML = '<p class="placeholder">No active trades.<br>Monitor or Take a prediction to start.</p>';
      _renderManualTrades();
      return;
    }

    const monCards  = openTaken.filter(a => a.mode === 'monitor').map(a => _buildMonitoringCard(a));
    const tkCards   = openTaken.filter(a => a.mode !== 'monitor').map(a => _buildTakenCard(a));
    const resCards  = [...resolvedAlertData.values()].map(a => _buildResolvedCard(a));

    if (monCards.length > 0) {
      _appendFeedSection('Monitoring', monCards.length, 'monitor-trades', 'feed-hdr-monitor', monCards);
    }
    if (tkCards.length > 0) {
      _appendFeedSection('Taken', tkCards.length, 'active-trades', 'feed-hdr-active', tkCards);
    }
    if (resCards.length > 0) {
      _appendFeedSection('Resolved', resCards.length, 'resolved-trades', 'feed-hdr-resolved', resCards);
    }
    _renderManualTrades();
  }

  // ── Predictions panel (right panel) ────────────────────────────────────────

  // Daily risk gate — fetch today's P&L and warn if approaching daily loss limit
  async function _checkDailyRisk() {
    try {
      const res = await fetch('/api/realaccount/daily-pnl');
      if (!res.ok) return;
      const { netPnl, trades } = await res.json();
      if (trades === 0 || netPnl >= 0) {
        const riskEl = document.getElementById('daily-risk-banner');
        if (riskEl) riskEl.style.display = 'none';
        return;
      }
      const dailyLossLimit = (cfg.maxRiskDollars || 200) * 3; // 3× per-trade risk = daily limit
      const pct = Math.abs(netPnl) / dailyLossLimit;
      const riskEl = document.getElementById('daily-risk-banner');
      if (!riskEl) return;
      if (pct >= 1.0) {
        riskEl.style.display = '';
        riskEl.className = 'daily-risk-banner danger';
        riskEl.textContent = `Daily limit hit: -$${Math.abs(netPnl).toFixed(0)} — no new trades`;
      } else if (pct >= 0.66) {
        riskEl.style.display = '';
        riskEl.className = 'daily-risk-banner warning';
        riskEl.textContent = `Daily P&L: -$${Math.abs(netPnl).toFixed(0)} — approaching limit`;
      } else {
        riskEl.style.display = 'none';
      }
    } catch (_) {}
  }

  function _renderPredictions() {
    const predFeed   = document.getElementById('predictions-feed');
    const countBadge = document.getElementById('pred-count-badge');
    if (!predFeed) return;

    // Open setups = untaken alerts with open or no outcome — across ALL symbols.
    // Validity window scales with the setup's timeframe: a 15m signal is stale
    // after ~3h; a 4h signal after ~20h. Based on ~10 candles of the setup's TF.
    // Once that window passes the setup context has shifted and the trade isn't worth taking.
    const TF_EXPIRY_SECS = { '15m': 3*3600, '30m': 5*3600, '1h': 8*3600, '2h': 12*3600, '4h': 20*3600 };
    const newestCandleTime = allAlerts.reduce((max, a) => Math.max(max, a.setup?.time || 0), 0);
    const openSetups = allAlerts.filter(a => {
      if (takenTrades.has(_alertKey(a))) return false;
      if (a.setup?.outcome && a.setup.outcome !== 'open') return false;
      const expirySecs = TF_EXPIRY_SECS[a.timeframe] ?? 8 * 3600;
      if ((a.setup?.time ?? 0) < newestCandleTime - expirySecs) return false;
      // Price proximity: hide if SL already breached (progress < 0) or price has
      // traveled ≥60% from entry toward TP — entering now means chasing with poor R:R.
      if (a.priceProgress != null && (a.priceProgress < 0 || a.priceProgress >= 0.6)) return false;
      return true;
    });

    if (countBadge) countBadge.textContent = openSetups.length > 0 ? String(openSetups.length) : '';

    _checkDailyRisk();

    if (openSetups.length === 0) {
      predFeed.innerHTML = '<p class="placeholder">No predictions yet.</p>';
      return;
    }

    predFeed.innerHTML = '';
    for (const alert of openSetups) {
      const card = _buildPredCard(alert);
      if (_prevAlertKeys.size > 0 && !_prevAlertKeys.has(_alertKey(alert))) {
        card.classList.add('is-new');
        setTimeout(() => card.classList.remove('is-new'), 10_000);
      }
      predFeed.appendChild(card);
    }

    _prevAlertKeys = new Set(openSetups.map(_alertKey));
  }

  // ── Monitoring card (mode='monitor') — auto-watches TP/SL ──────────────────

  function _buildMonitoringCard(alertData) {
    const { symbol, timeframe, setup } = alertData;
    const aiKey = _alertKey(alertData);
    const dir   = setup.direction;
    const cls   = dir === 'bullish' ? 'bull' : 'bear';
    const arrow = dir === 'bullish' ? '▲' : '▼';
    const fmtP  = n => _fmtP(symbol, n);
    const riskDollars = _calcRisk(alertData);
    const riskText    = riskDollars != null ? `$${riskDollars}` : '';

    const card = document.createElement('div');
    card.className = `monitor-card ${cls}`;
    card.dataset.alertKey = aiKey;

    card.innerHTML = `
      <div class="mc-header">
        <span class="mc-sym">${symbol}</span>
        <span class="mc-tf">${timeframe}</span>
        <span class="mc-type">${_fmtType(setup.type)}</span>
        <span class="mc-dir ${cls}">${arrow}</span>
        <span class="mc-conf">${setup.confidence}%</span>
        ${riskText ? `<span class="mc-risk">${riskText}</span>` : ''}
      </div>
      <div class="mc-rationale">${setup.rationale || '—'}</div>
      <div class="mc-levels">
        <span class="mc-label">Entry</span><span class="mc-val">${fmtP(setup.entry ?? setup.price)}</span>
        <span class="mc-label sl">SL</span><span class="mc-val sl">${fmtP(setup.sl)}</span>
        <span class="mc-label tp">TP</span><span class="mc-val tp">${fmtP(setup.tp)}</span>
      </div>
      <div class="mc-action-row">
        <span class="mc-watching">● Watching</span>
        <button class="mc-won-btn">✓ Won</button>
        <button class="mc-lost-btn">✗ Lost</button>
        <button class="mc-dismiss-btn" title="Dismiss">✕</button>
      </div>`;

    card.style.cursor = 'pointer';
    card.addEventListener('click', () => { window.ChartAPI?.highlightSetup(alertData); });

    async function _resolveMonitor(outcome) {
      alertData.setup.outcome = outcome;
      alertData.resolvedAt = new Date().toISOString();
      takenOpenAlertData.delete(aiKey);
      resolvedAlertData.set(aiKey, alertData);
      _saveTakenOpen();
      _saveResolved();
      _renderFeed();
      _updateStats();
      try {
        await fetch(`/api/alerts/${encodeURIComponent(aiKey)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome }),
        });
      } catch (_) {}
      _showFillToast(`${symbol} ${outcome === 'won' ? '✓ WON' : '✗ LOST'} (monitored)`);
    }

    card.querySelector('.mc-won-btn') .addEventListener('click', e => { e.stopPropagation(); _resolveMonitor('won'); });
    card.querySelector('.mc-lost-btn').addEventListener('click', e => { e.stopPropagation(); _resolveMonitor('lost'); });
    card.querySelector('.mc-dismiss-btn').addEventListener('click', e => {
      e.stopPropagation();
      takenOpenAlertData.delete(aiKey);
      _saveTakenOpen();
      _renderFeed();
    });

    return card;
  }

  // ── Taken card (mode='take') — manual outcome + P&L entry ─────────────────

  function _buildTakenCard(alertData) {
    const { symbol, timeframe, setup } = alertData;
    const aiKey = _alertKey(alertData);
    const dir   = setup.direction;
    const cls   = dir === 'bullish' ? 'bull' : 'bear';
    const arrow = dir === 'bullish' ? '▲' : '▼';
    const fmtP  = n => _fmtP(symbol, n);
    const entry = alertData.actualEntry ?? setup.entry ?? setup.price;
    const sl    = alertData.actualSL    ?? setup.sl;
    const tp    = alertData.actualTP    ?? setup.tp;
    const riskDollars = _calcRisk(alertData);
    const riskText    = riskDollars != null ? `$${riskDollars} risk` : '';

    const card = document.createElement('div');
    card.className = `taken-card ${cls}`;
    card.dataset.alertKey = aiKey;

    card.innerHTML = `
      <div class="mc-header">
        <span class="mc-sym">${symbol}</span>
        <span class="mc-tf">${timeframe}</span>
        <span class="mc-type">${_fmtType(setup.type)}</span>
        <span class="mc-dir ${cls}">${arrow}</span>
        <span class="mc-conf">${setup.confidence}%</span>
        ${riskText ? `<span class="mc-risk">${riskText}</span>` : ''}
      </div>
      <div class="mc-rationale">${setup.rationale || '—'}</div>
      <div class="mc-levels">
        <span class="mc-label">Entry</span><span class="mc-val">${fmtP(entry)}</span>
        <span class="mc-label sl">SL</span><span class="mc-val sl">${fmtP(sl)}</span>
        <span class="mc-label tp">TP</span><span class="mc-val tp">${fmtP(tp)}</span>
      </div>
      <div class="mc-outcome-row">
        <button class="mc-tp-btn">TP Hit</button>
        <button class="mc-sl-btn">SL Hit</button>
        <input class="mc-exit-price" type="number" step="0.01" placeholder="Exit @">
        <button class="mc-exit-btn">Exit</button>
        <input class="mc-pnl-input" type="number" step="0.01" placeholder="P&L $">
      </div>`;

    card.style.cursor = 'pointer';
    card.addEventListener('click', () => { window.ChartAPI?.highlightSetup(alertData); });

    const pnlInput       = card.querySelector('.mc-pnl-input');
    const exitPriceInput = card.querySelector('.mc-exit-price');

    async function _resolveOutcome(outcome, exitPrice) {
      const pnl = parseFloat(pnlInput.value) || null;
      alertData.setup.outcome = outcome;
      if (exitPrice != null) alertData.setup.actualExit = exitPrice;
      if (pnl != null) alertData.setup.pnl = pnl;
      alertData.resolvedAt = new Date().toISOString();
      takenOpenAlertData.delete(aiKey);
      resolvedAlertData.set(aiKey, alertData);  // show in Resolved section
      _saveTakenOpen();
      _saveResolved();
      _renderFeed();
      _updateStats();
      try {
        await fetch(`/api/alerts/${encodeURIComponent(aiKey)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome }),
        });
        await fetch('/api/trades', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            alertKey: aiKey, symbol, timeframe, setupType: setup.type, mode: 'take',
            direction: alertData.setup?.direction,
            confidence: alertData.setup?.confidence,
            rationale: alertData.setup?.rationale,
            actualEntry: entry, actualSL: sl, actualTP: tp,
            actualExit: exitPrice, pnl, outcome,
            contracts: alertData.contracts ?? null,
            dca:       alertData.dca       ?? false,
            sentiment: alertData.sentiment ?? 'neutral',
            notes:     alertData.notes     ?? '',
          }),
        });
      } catch (_) {}
      const pnlStr = pnl != null ? ` · ${pnl >= 0 ? '+' : ''}$${pnl}` : '';
      _showFillToast(`${symbol} ${outcome === 'won' ? '✓ TP HIT' : outcome === 'lost' ? '✗ SL HIT' : '◎ EXITED'}${pnlStr}`);
    }

    card.querySelector('.mc-tp-btn').addEventListener('click', e => { e.stopPropagation(); _resolveOutcome('won', tp); });
    card.querySelector('.mc-sl-btn').addEventListener('click', e => { e.stopPropagation(); _resolveOutcome('lost', sl); });
    card.querySelector('.mc-exit-btn').addEventListener('click', e => {
      e.stopPropagation();
      const exitP = parseFloat(exitPriceInput.value);
      if (!isNaN(exitP)) {
        const isBull  = dir === 'bullish';
        const outcome = (isBull ? exitP > entry : exitP < entry) ? 'won' : 'lost';
        _resolveOutcome(outcome, exitP);
      }
    });

    // ── Partial exit tracking ─────────────────────────────────────────────────
    const partialBtn = document.createElement('div');
    partialBtn.className = 'mc-partial-row';
    const partials = alertData.partialExits || [];
    const partialHtml = partials.length
      ? partials.map(p => `<span class="partial-chip">Partial ${p.qty}ct @ ${_fmtP(symbol, p.price)} = $${p.pnl?.toFixed(0) ?? '?'}</span>`).join('')
      : '';

    partialBtn.innerHTML = `
      ${partialHtml ? `<div class="partial-chips">${partialHtml}</div>` : ''}
      <div class="partial-add-row">
        <input class="partial-qty" type="number" min="1" step="1" placeholder="Qty" style="width:48px">
        <input class="partial-price" type="number" step="0.01" placeholder="Price">
        <input class="partial-pnl" type="number" step="0.01" placeholder="P&L">
        <button class="partial-save-btn">+ Partial</button>
      </div>`;

    card.appendChild(partialBtn);

    partialBtn.querySelector('.partial-save-btn').addEventListener('click', e => {
      e.stopPropagation();
      const qty   = parseInt(partialBtn.querySelector('.partial-qty').value) || 1;
      const price = parseFloat(partialBtn.querySelector('.partial-price').value) || null;
      const pnl   = parseFloat(partialBtn.querySelector('.partial-pnl').value) || null;
      if (!price) return;
      if (!alertData.partialExits) alertData.partialExits = [];
      alertData.partialExits.push({ qty, price, pnl, exitedAt: new Date().toISOString() });
      // Move SL to breakeven if this is the first partial
      if (alertData.partialExits.length === 1) {
        alertData.actualSL = alertData.actualEntry ?? alertData.setup.entry;
      }
      takenOpenAlertData.set(aiKey, alertData);
      _saveTakenOpen();
      _renderFeed();
    });

    return card;
  }

  // ── Resolved card (monitored trades that hit TP or SL) ───────────────────

  function _buildResolvedCard(alertData) {
    const { symbol, timeframe, setup } = alertData;
    const aiKey   = _alertKey(alertData);
    const outcome = setup.outcome;
    const dir     = setup.direction;
    const cls     = outcome === 'won' ? 'outcome-won' : 'outcome-lost';
    const dirCls  = dir === 'bullish' ? 'bull' : 'bear';
    const arrow   = dir === 'bullish' ? '▲' : '▼';
    const fmtP    = n => _fmtP(symbol, n);

    const resolvedTime = alertData.resolvedAt
      ? new Date(alertData.resolvedAt).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Denver',
        }) + ' MT'
      : '';

    const card = document.createElement('div');
    card.className = `resolved-card ${dirCls} ${cls}`;
    card.dataset.alertKey = aiKey;

    card.innerHTML = `
      <div class="mc-header">
        <span class="mc-sym">${symbol}</span>
        <span class="mc-tf">${timeframe}</span>
        <span class="mc-type">${_fmtType(setup.type)}</span>
        <span class="mc-dir ${dirCls}">${arrow}</span>
        <span class="rc-outcome ${outcome === 'won' ? 'rc-won' : 'rc-lost'}">
          ${outcome === 'won' ? '✓ WON' : '✗ LOST'}
        </span>
        <button class="rc-clear-btn" title="Clear">✕</button>
      </div>
      <div class="mc-levels">
        <span class="mc-label">Entry</span><span class="mc-val">${fmtP(setup.entry ?? setup.price)}</span>
        <span class="mc-label sl">SL</span><span class="mc-val sl">${fmtP(setup.sl)}</span>
        ${setup.actualExit != null
          ? `<span class="mc-label" style="color:var(--accent)">Exit</span><span class="mc-val" style="color:var(--accent)">${fmtP(setup.actualExit)}</span>`
          : `<span class="mc-label tp">TP</span><span class="mc-val tp">${fmtP(setup.tp)}</span>`}
        ${setup.pnl != null ? `<span class="mc-label">P&L</span><span class="mc-val ${setup.pnl >= 0 ? 'tp' : 'sl'}">${setup.pnl >= 0 ? '+' : ''}$${setup.pnl.toFixed(2)}</span>` : ''}
      </div>
      ${resolvedTime ? `<div class="rc-time">${resolvedTime}</div>` : ''}`;

    card.querySelector('.rc-clear-btn').addEventListener('click', e => {
      e.stopPropagation();
      resolvedAlertData.delete(aiKey);
      _saveResolved();
      _renderFeed();
    });

    return card;
  }

  // ── Auto-monitor: check TP/SL crossing on live price updates ──────────────

  function _checkMonitoredTrades(symbol, price) {
    let changed = false;
    for (const [key, alertData] of takenOpenAlertData) {
      if (alertData.symbol !== symbol || alertData.mode !== 'monitor') continue;
      if (alertData.setup?.outcome !== 'open') continue;
      const { setup } = alertData;
      const isBull = setup.direction === 'bullish';
      let hit = null;
      if (isBull) {
        if (price >= setup.tp)   hit = 'won';
        else if (price <= setup.sl) hit = 'lost';
      } else {
        if (price <= setup.tp)   hit = 'won';
        else if (price >= setup.sl) hit = 'lost';
      }
      if (hit) { _autoResolveMonitor(key, alertData, hit); changed = true; }
    }
    if (changed) { _renderFeed(); _updateStats(); }
  }

  async function _autoResolveMonitor(key, alertData, outcome) {
    alertData.setup.outcome = outcome;
    alertData.resolvedAt = new Date().toISOString();
    takenOpenAlertData.delete(key);
    resolvedAlertData.set(key, alertData);
    _saveTakenOpen();
    _saveResolved();
    try {
      await fetch(`/api/alerts/${encodeURIComponent(key)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      });
    } catch (_) {}
    _showFillToast(`${alertData.symbol} ${outcome === 'won' ? '✓ TP HIT' : '✗ SL HIT'} (auto)`);
  }

  // ── Compact prediction card for the right panel ─────────────────────────────

  function _buildPredCard(alert) {
    const { symbol, timeframe, setup } = alert;
    const dir   = setup.direction;
    const cls   = dir === 'bullish' ? 'bull' : 'bear';
    const arrow = dir === 'bullish' ? '▲' : '▼';
    const aiKey = _alertKey(alert);
    const fmtP  = n => _fmtP(symbol, n);
    const riskDollars = _calcRisk(alert);
    const overBudget  = riskDollars != null && riskDollars > cfg.maxRiskDollars;

    const ageMins = Math.round((Date.now() - setup.time * 1000) / 60000);
    const ageText = ageMins < 2 ? 'now' : ageMins < 60 ? `${ageMins}m` : `${Math.floor(ageMins / 60)}h`;

    const card = document.createElement('div');
    card.className = `pred-card ${cls}${overBudget ? ' over-budget' : ''}`;
    card.dataset.alertKey = aiKey;

    card.innerHTML = `
      <div class="pred-card-header">
        <span class="pred-card-sym">${symbol}</span>
        <span class="pred-card-tf">${timeframe}</span>
        <span class="pred-card-type">${_fmtType(setup.type)}</span>
        <span class="pred-card-dir ${cls}">${arrow}</span>
        <span class="pred-card-conf">${setup.confidence}%</span>
        <span class="pred-card-age">${ageText}</span>
      </div>
      <div class="pred-card-rationale">${setup.rationale || '—'}</div>
      ${setup.entryGuidance ? `<div class="pred-card-guidance"><em>${setup.entryGuidance}</em></div>` : ''}
      <div class="pred-card-prices">
        <span class="pcp-label">Entry</span><span class="pcp-val">${fmtP(setup.entry ?? setup.price)}</span>
        <span class="pcp-label sl">SL</span><span class="pcp-val sl">${fmtP(setup.sl)}</span>
        <span class="pcp-label tp">TP</span><span class="pcp-val tp">${fmtP(setup.tp)}</span>
      </div>
      ${setup.suggestedContracts != null ? `<div class="pred-card-sizing">${setup.suggestedContracts} contract${setup.suggestedContracts !== 1 ? 's' : ''} · $${riskDollars != null ? riskDollars : '—'} risk</div>` : ''}
      <div class="pred-card-footer">
        <span class="pred-card-risk ${overBudget ? 'risk-over' : 'risk-ok'}">${riskDollars != null ? '$' + riskDollars : ''}</span>
        <button class="pred-monitor-btn" data-key="${aiKey}">Monitor</button>
        <button class="pred-take-btn" data-key="${aiKey}">Take</button>
      </div>
      <div class="trade-form" style="display:none"></div>`;

    // Click → highlight on chart
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      document.querySelectorAll('.pred-card.selected').forEach(el => el.classList.remove('selected'));
      card.classList.add('selected');
      window.ChartAPI?.highlightSetup(alert);
    });

    const tradeFormEl = card.querySelector('.trade-form');
    const monitorBtn  = card.querySelector('.pred-monitor-btn');
    const takeBtn     = card.querySelector('.pred-take-btn');

    // Monitor → immediate, no form; system watches TP/SL automatically
    monitorBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const monitorData = { ...alert, mode: 'monitor', takenAt: new Date().toISOString() };
      if (!monitorData.setup.outcome) monitorData.setup.outcome = 'open';
      try {
        const res = await fetch('/api/trades', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            alertKey: aiKey, symbol, timeframe, setupType: setup.type, mode: 'monitor',
            actualEntry: setup.entry ?? setup.price, actualSL: setup.sl, actualTP: setup.tp,
          }),
        });
        if (!res.ok) throw new Error(res.status);
        const { trade } = await res.json();
        takenTrades.set(aiKey, trade);
        takenOpenAlertData.set(aiKey, monitorData);
        _saveTakenOpen();
        _renderFeed();
        _renderPredictions();
        _updateStats();
        monitorBtn.textContent = '● Monitoring';
        monitorBtn.disabled = true;
        takeBtn.disabled    = true;
      } catch (err) {
        console.error('[pred-monitor] Save failed:', err.message);
      }
    });

    // Take → inline form; user fills in actual entry/SL/TP, then marks outcome + P&L
    function _openPredTradeForm() {
      const fv = n => n != null ? n.toFixed(2) : '';
      tradeFormEl.innerHTML = `
        <div class="trade-form-inner">
          <div class="tf-row">
            <label>Entry</label>
            <input class="tf-entry" type="number" step="0.25" value="${fv(setup.entry ?? setup.price)}">
            <label>SL</label>
            <input class="tf-sl" type="number" step="0.25" value="${fv(setup.sl)}">
            <label>TP</label>
            <input class="tf-tp" type="number" step="0.25" value="${fv(setup.tp)}">
          </div>
          <div class="tf-row">
            <label>Contracts</label>
            <input class="tf-contracts" type="number" min="1" step="1" value="${setup.suggestedContracts ?? 1}" style="width:56px">
            <label>Sentiment</label>
            <select class="tf-sentiment">
              <option value="bullish" ${setup.direction === 'bullish' ? 'selected' : ''}>Bullish</option>
              <option value="bearish" ${setup.direction === 'bearish' ? 'selected' : ''}>Bearish</option>
              <option value="neutral">Neutral</option>
            </select>
            <label class="tf-dca-label"><input class="tf-dca" type="checkbox"> DCA</label>
          </div>
          <div class="tf-row">
            <label>Notes</label>
            <input class="tf-notes" type="text" placeholder="Optional" style="flex:1">
          </div>
          <div class="tf-btns">
            <button class="tf-save">Confirm Take</button>
            <button class="tf-cancel">Cancel</button>
          </div>
        </div>`;
      tradeFormEl.style.display = 'block';

      tradeFormEl.querySelector('.tf-cancel').addEventListener('click', e => {
        e.stopPropagation();
        tradeFormEl.style.display = 'none';
      });

      tradeFormEl.querySelector('.tf-save').addEventListener('click', async e => {
        e.stopPropagation();
        const actualEntry = parseFloat(tradeFormEl.querySelector('.tf-entry').value);
        const actualSL    = parseFloat(tradeFormEl.querySelector('.tf-sl').value);
        const actualTP    = parseFloat(tradeFormEl.querySelector('.tf-tp').value);
        const body = {
          alertKey: aiKey, symbol, timeframe, setupType: setup.type, mode: 'take',
          direction: setup.direction,
          confidence: setup.confidence,
          rationale: setup.rationale,
          actualEntry, actualSL, actualTP,
          contracts:  parseInt(tradeFormEl.querySelector('.tf-contracts').value) || 1,
          sentiment:  tradeFormEl.querySelector('.tf-sentiment').value,
          dca:        tradeFormEl.querySelector('.tf-dca').checked,
          notes:      tradeFormEl.querySelector('.tf-notes').value,
        };
        try {
          const res = await fetch('/api/trades', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(res.status);
          const { trade } = await res.json();
          takenTrades.set(aiKey, trade);
          const takeData = { ...alert, mode: 'take', takenAt: new Date().toISOString(), actualEntry, actualSL, actualTP };
          if (!takeData.setup.outcome) takeData.setup.outcome = 'open';
          takenOpenAlertData.set(aiKey, takeData);
          _saveTakenOpen();
          _renderFeed();
          _renderPredictions();
          _updateStats();
          if (window._soundAlertsEnabled) _playAlertSound(setup.direction);
        } catch (err) {
          console.error('[pred-take] Save failed:', err.message);
        }
      });
    }

    takeBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = tradeFormEl.style.display !== 'none';
      tradeFormEl.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) _openPredTradeForm();
    });

    return card;
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
                    : alert.symbol === 'BTC' ? cfg.btcContracts
                    : alert.symbol === 'ETH' ? cfg.ethContracts
                    : alert.symbol === 'XRP' ? cfg.xrpContracts
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

    const fmtP = n => _fmtP(symbol, n);
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

            // Auto-resolve outcome if exit price was provided
            if (body.actualExit) {
              const exitP  = parseFloat(body.actualExit);
              const entryP = parseFloat(body.actualEntry);
              if (!isNaN(exitP) && !isNaN(entryP) && exitP !== entryP) {
                const isBull  = setup.direction === 'bullish';
                const outcome = (isBull ? exitP > entryP : exitP < entryP) ? 'won' : 'lost';
                await _setOutcome(outcome); // removes from Active Trades + re-renders feed
                return;
              }
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
      case 'bias':                     return 'Bias';
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

    // Build cards first, then use the shared collapsible helper
    const cards = [];
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

      cards.push(c);
    }

    const section = document.createElement('div');
    section.className = 'manual-trades-section';
    alertFeed.appendChild(section);
    _appendFeedSection('Manual Trades', cards.length, 'manual-trades', 'feed-hdr-dim', cards, section);
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
    const riskInputs = [mnqInput, mgcInput, btcInput, ethInput, xrpInput, maxRiskInput].filter(Boolean);
    riskInputs.forEach(el => {
      el.addEventListener('input', () => {
        cfg.mnqContracts   = parseInt(mnqInput.value)   || 1;
        cfg.mgcContracts   = parseInt(mgcInput.value)   || 1;
        cfg.btcContracts   = parseInt(btcInput?.value)  || 1;
        cfg.ethContracts   = parseInt(ethInput?.value)  || 1;
        cfg.xrpContracts   = parseInt(xrpInput?.value)  || 1;
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
          // Browser push notification for new high-confidence setups
          if (cfg.features?.pushNotifications && Notification.permission === 'granted') {
            const conf  = msg.setup?.confidence ?? 0;
            const dir   = msg.setup?.direction === 'bullish' ? '▲' : '▼';
            const type  = msg.setup?.type?.replace(/_/g, ' ') ?? 'setup';
            new Notification(`${msg.symbol} ${msg.timeframe} ${dir}`, {
              body: `${type} · ${conf}% confidence · Entry ${msg.setup?.entry?.toFixed(2) ?? ''}`,
              icon: '/icons/icon-192.png',
              tag:  `${msg.symbol}-${msg.timeframe}-${msg.setup?.time}`,
              requireInteraction: false,
            });
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
        if (msg.type === 'live_price') {
          // Real-time tick from Coinbase WS (BTC/ETH/XRP only)
          window.ChartAPI?.updateLivePrice?.(msg.symbol, msg.price, msg.time);
          _updateDataAgeBadge(msg.symbol, msg.time);
          _checkMonitoredTrades(msg.symbol, msg.price);
        }
                if (msg.type === 'data_refresh') {
          // Snapshot prev keys before refetch so new cards can be highlighted
          _prevAlertKeys = new Set(allAlerts.map(_alertKey));
          window.ChartAPI?.reload();   // re-fetch chart candles + indicators
          fetchAndRender();            // re-fetch alert feed (open outcomes may have resolved)
          _setRefreshTimes(msg.ts, msg.nextRefresh);
          if (msg.newAlerts > 0) _showNewAlertBanner(msg.newAlerts);
          // Update data-age badge directly from last candle time — don't wait for alerts
          if (msg.lastCandleTime && msg.lastCandleTime[activeSymbol]) {
            _lastKnownCandleTime = msg.lastCandleTime[activeSymbol];
            _updateDataAgeBadge(activeSymbol, msg.lastCandleTime[activeSymbol]);
          }
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
      btcContracts:  cfg.btcContracts,
      ethContracts:  cfg.ethContracts,
      xrpContracts:  cfg.xrpContracts,
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
