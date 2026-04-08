'use strict';
// chartManager.js — Multi-symbol grid mode and single chart mode orchestration.
//
// Grid mode: 7 simultaneous mini charts (MNQ, MES, MGC, MCL, BTC, ETH, XRP)
//   Each cell has candlesticks + EMA9/EMA21/VWAP, a per-symbol TF selector,
//   live price display, and click-to-expand back to single mode.
//
// Single mode: delegates to the existing chart.js (ChartAPI) — no changes to
//   overlay or indicator logic. This module only handles mode switching.
//
// Persistence:
//   localStorage 'fe_chart_mode'      — 'single' | 'grid'
//   localStorage 'fe_grid_tf_all'     — shared default TF for grid
//   localStorage 'fe_grid_tf_{SYM}'   — per-symbol TF override

(function () {

  // ── Constants ───────────────────────────────────────────────────────────────
  // Row 1 — Equity Futures (4 cols)
  const EQUITY_ROW = ['MNQ', 'MES', 'M2K', 'MYM'];
  // Row 2 — Commodities & FX (4 cols)
  const COMMODITIES_ROW = ['MGC', 'MCL', 'MHG', 'M6E'];
  // Row 3 — Crypto (3 cols)
  const CRYPTO       = ['BTC', 'ETH', 'XRP'];
  const GRID_SYMBOLS = [...EQUITY_ROW, ...COMMODITIES_ROW, ...CRYPTO];

  // Decimal places for each symbol's price display
  const PRICE_DEC = {
    MNQ: 2, MES: 2, M2K: 2, MYM: 0,
    MGC: 1, MCL: 2, MHG: 4, M6E: 4,
    BTC: 0, ETH: 2, XRP: 4,
  };

  const LS_MODE    = 'fe_chart_mode';
  const LS_GRID_TF = 'fe_grid_tf_all';
  const LS_TF_PFX  = 'fe_grid_tf_';

  // ── State ───────────────────────────────────────────────────────────────────
  let mode   = localStorage.getItem(LS_MODE) || 'single';
  let gridTf = localStorage.getItem(LS_GRID_TF) || '5m';

  // Per-symbol chart instances: { symbol: { chart, candleSeries, ema9, ema21, vwap, tf } }
  const gridCharts = {};

  // Last known close price for each symbol (for coloring price up/down)
  const gridPrices    = {};
  const gridPrevClose = {};

  // ── Price formatting ────────────────────────────────────────────────────────
  function _fmtPrice(sym, n) {
    if (n == null || isNaN(n)) return '—';
    const dec = PRICE_DEC[sym] ?? 2;
    return n.toLocaleString('en-US', {
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    });
  }

  // ── localStorage TF helpers ─────────────────────────────────────────────────
  function _getTf(sym) {
    return localStorage.getItem(`${LS_TF_PFX}${sym}`) || gridTf;
  }

  function _setTf(sym, tf) {
    localStorage.setItem(`${LS_TF_PFX}${sym}`, tf);
  }

  // ── Grid HTML construction ──────────────────────────────────────────────────
  function _cellHTML(sym) {
    const tf = _getTf(sym);
    const tfBtns = ['1m', '5m', '15m', '30m'].map(t =>
      `<button class="chart-grid-tf-btn${t === tf ? ' active' : ''}" data-sym="${sym}" data-tf="${t}">${t}</button>`
    ).join('');

    return `<div class="chart-grid-cell" id="grid-cell-${sym}" data-symbol="${sym}">
  <div class="chart-grid-cell-header">
    <span class="chart-grid-symbol">${sym}</span>
    <span class="chart-grid-price" id="grid-price-${sym}">—</span>
    <span class="chart-grid-expand" title="Expand to single chart">&#8599;</span>
  </div>
  <div class="chart-grid-tf-selector">${tfBtns}</div>
  <div class="chart-grid-chart-area" id="grid-chart-${sym}">
    <div class="chart-grid-loading" id="grid-loading-${sym}">Loading…</div>
  </div>
</div>`;
  }

  function _buildGridHTML() {
    const equityHTML     = EQUITY_ROW.map(_cellHTML).join('');
    const commodHTML     = COMMODITIES_ROW.map(_cellHTML).join('');
    const cryptoHTML     = CRYPTO.map(_cellHTML).join('');
    return `<div class="chart-grid-row chart-grid-label">Equity Futures</div>
<div class="chart-grid-futures">${equityHTML}</div>
<div class="chart-grid-row chart-grid-label">Commodities &amp; FX</div>
<div class="chart-grid-commodities">${commodHTML}</div>
<div class="chart-grid-row chart-grid-label">Crypto</div>
<div class="chart-grid-crypto">${cryptoHTML}</div>`;
  }

  // ── Price display update ────────────────────────────────────────────────────
  function _updatePriceDisplay(sym, price) {
    const el = document.getElementById(`grid-price-${sym}`);
    if (!el) return;
    el.textContent = _fmtPrice(sym, price);
    const prev = gridPrevClose[sym];
    if (prev != null) {
      el.classList.toggle('up',   price >= prev);
      el.classList.toggle('down', price <  prev);
    } else {
      el.classList.remove('up', 'down');
    }
  }

  // ── Load data for one grid cell ─────────────────────────────────────────────
  async function _loadGridData(sym, tf) {
    const loadingEl = document.getElementById(`grid-loading-${sym}`);
    const g         = gridCharts[sym];

    try {
      if (loadingEl) { loadingEl.textContent = 'Loading…'; loadingEl.style.display = 'flex'; }

      const [candleRes, indRes] = await Promise.all([
        fetch(`/api/candles?symbol=${sym}&timeframe=${tf}`),
        fetch(`/api/indicators?symbol=${sym}&timeframe=${tf}`),
      ]);

      if (!candleRes.ok) {
        const msg = tf === '1m'
          ? '1m requires live feed'
          : `Error ${candleRes.status}`;
        if (loadingEl) { loadingEl.textContent = msg; loadingEl.style.display = 'flex'; }
        if (g) {
          g.candleSeries.setData([]);
          g.ema9.setData([]);
          g.ema21.setData([]);
          g.vwap.setData([]);
        }
        return;
      }

      const { candles } = await candleRes.json();
      if (!candles || !candles.length) {
        if (loadingEl) { loadingEl.textContent = 'No data'; loadingEl.style.display = 'flex'; }
        return;
      }

      if (loadingEl) loadingEl.style.display = 'none';
      if (!g) return;

      g.candleSeries.setData(candles);
      g.chart.timeScale().scrollToRealTime();
      g.tf = tf;

      // Price display — use last candle close; prev close from penultimate candle
      const last = candles[candles.length - 1];
      const prev = candles.length > 1 ? candles[candles.length - 2].close : null;
      gridPrices[sym]    = last.close;
      gridPrevClose[sym] = prev;
      _updatePriceDisplay(sym, last.close);

      // Indicators
      if (indRes.ok) {
        const ind = await indRes.json();
        if (ind.ema9?.length)  g.ema9.setData(ind.ema9);
        if (ind.ema21?.length) g.ema21.setData(ind.ema21);
        if (ind.vwap?.length)  g.vwap.setData(ind.vwap);
      }

    } catch (err) {
      console.error(`[chartManager] ${sym} ${tf}:`, err.message);
      if (loadingEl) { loadingEl.textContent = 'No data'; loadingEl.style.display = 'flex'; }
    }
  }

  // ── Initialize one grid chart instance ──────────────────────────────────────
  function _initGridChart(sym) {
    const el = document.getElementById(`grid-chart-${sym}`);
    if (!el) return Promise.resolve();

    // Clean up any prior instance for this symbol
    if (gridCharts[sym]) {
      try { gridCharts[sym].chart.remove(); } catch (_) {}
      delete gridCharts[sym];
    }

    const tf  = _getTf(sym);
    const dec = sym === 'XRP' ? 4 : 2;

    const chart = LightweightCharts.createChart(el, {
      width:  el.clientWidth  || 200,
      height: el.clientHeight || 220,
      layout: {
        background: { type: 'solid', color: '#131722' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: '#1e222d' },
        horzLines: { color: '#1e222d' },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: '#2a2e39',
        scaleMargins: { top: 0.06, bottom: 0.06 },
      },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      handleScroll: true,
      handleScale:  true,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      priceFormat: {
        type: 'price',
        precision: dec,
        minMove: dec === 4 ? 0.0001 : 0.01,
      },
    });

    const ema9 = chart.addLineSeries({
      color: '#2962ff', lineWidth: 1,
      priceLineVisible: false, crosshairMarkerVisible: false,
    });
    const ema21 = chart.addLineSeries({
      color: '#ff6d00', lineWidth: 1,
      priceLineVisible: false, crosshairMarkerVisible: false,
    });
    const vwap = chart.addLineSeries({
      color: '#00bcd4', lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, crosshairMarkerVisible: false,
    });

    gridCharts[sym] = { chart, candleSeries, ema9, ema21, vwap, tf };

    // Click cell → expand to single mode for this symbol
    const cell = document.getElementById(`grid-cell-${sym}`);
    if (cell) {
      cell.addEventListener('click', (e) => {
        if (e.target.classList.contains('chart-grid-tf-btn')) return;
        _expandToSingle(sym, gridCharts[sym]?.tf || gridTf);
      }, { once: false });
    }

    return _loadGridData(sym, tf);
  }

  // ── Expand from grid cell to single chart ───────────────────────────────────
  function _expandToSingle(sym, tf) {
    setMode('single');
    // chartLoadSymbol is handled in chart.js — loads the symbol directly
    document.dispatchEvent(new CustomEvent('chartLoadSymbol', {
      detail: { symbol: sym, tf: tf || activeTf() },
    }));
    // Also switch the Futures/Crypto dashboard mode toggle so the symbol button
    // highlights correctly in the topbar
    if (CRYPTO.includes(sym)) {
      const btn = document.getElementById('dash-mode-crypto');
      if (btn && !btn.classList.contains('active')) btn.click();
    } else {
      const btn = document.getElementById('dash-mode-index');
      if (btn && !btn.classList.contains('active')) btn.click();
    }
  }

  // Helper: get the currently active TF from the main TF selector
  function activeTf() {
    const active = document.querySelector('.tf-btn.active');
    return active ? active.dataset.tf : '5m';
  }

  // ── Wire TF buttons inside grid cells ──────────────────────────────────────
  function _wireTfButtons(container) {
    container.querySelectorAll('.chart-grid-tf-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = btn.dataset.sym;
        const tf  = btn.dataset.tf;
        // Update active state within this cell
        const cell = document.getElementById(`grid-cell-${sym}`);
        if (cell) {
          cell.querySelectorAll('.chart-grid-tf-btn').forEach(b => b.classList.remove('active'));
        }
        btn.classList.add('active');
        _setTf(sym, tf);
        if (gridCharts[sym]) gridCharts[sym].tf = tf;
        _loadGridData(sym, tf);
      });
    });
  }

  // ── Initialize all 7 grid charts in parallel ────────────────────────────────
  async function initGrid() {
    const container = document.getElementById('chart-grid-container');
    if (!container) return;

    // Destroy any existing instances first
    _destroyAll();

    // Build HTML fresh (picks up current per-symbol TF from localStorage)
    container.innerHTML = _buildGridHTML();

    // Wire TF selector buttons
    _wireTfButtons(container);

    // Initialize all charts in parallel
    await Promise.all(GRID_SYMBOLS.map(sym => _initGridChart(sym)));
  }

  // ── Destroy all grid chart instances ────────────────────────────────────────
  function _destroyAll() {
    for (const sym of GRID_SYMBOLS) {
      if (gridCharts[sym]) {
        try { gridCharts[sym].chart.remove(); } catch (_) {}
        delete gridCharts[sym];
      }
    }
  }

  // ── Mode switching ──────────────────────────────────────────────────────────
  function setMode(m) {
    mode = m;
    localStorage.setItem(LS_MODE, m);

    const chartWrap = document.getElementById('chart-wrap');
    const gridWrap  = document.getElementById('chart-grid-container');
    const toggleBtn = document.getElementById('chart-mode-toggle');

    if (m === 'grid') {
      if (chartWrap) chartWrap.style.display = 'none';
      if (gridWrap)  gridWrap.style.display  = 'flex';
      if (toggleBtn) {
        toggleBtn.textContent = 'Single';
        toggleBtn.title       = 'Switch to single chart';
        toggleBtn.classList.add('grid-active');
      }
      initGrid().catch(err => console.error('[chartManager] initGrid:', err.message));
    } else {
      if (chartWrap) chartWrap.style.display = '';
      if (gridWrap)  gridWrap.style.display  = 'none';
      if (toggleBtn) {
        toggleBtn.textContent = 'Grid';
        toggleBtn.title       = 'Switch to grid view';
        toggleBtn.classList.remove('grid-active');
      }
      _destroyAll();
    }
  }

  // ── Live price updates from WebSocket (crypto ticks from Coinbase) ──────────
  document.addEventListener('livePriceTick', (e) => {
    if (mode !== 'grid') return;
    const { symbol, price } = e.detail;
    if (!gridCharts[symbol]) return;
    gridPrices[symbol] = price;
    _updatePriceDisplay(symbol, price);
  });

  // ── Data refresh (Databento live candle or periodic seed refresh) ────────────
  document.addEventListener('dataRefresh', () => {
    if (mode !== 'grid') return;
    for (const sym of GRID_SYMBOLS) {
      if (gridCharts[sym]) {
        _loadGridData(sym, gridCharts[sym].tf || gridTf);
      }
    }
  });

  // ── Window resize — resize all grid charts ──────────────────────────────────
  window.addEventListener('resize', () => {
    for (const sym of GRID_SYMBOLS) {
      const g  = gridCharts[sym];
      const el = document.getElementById(`grid-chart-${sym}`);
      if (g && el) {
        g.chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      }
    }
  });

  // ── Mode toggle button + initial mode restore ───────────────────────────────
  // Script runs at end of <body> so DOM is available immediately — no need for DOMContentLoaded.
  const _toggleBtn = document.getElementById('chart-mode-toggle');
  if (_toggleBtn) {
    _toggleBtn.addEventListener('click', () => {
      setMode(mode === 'grid' ? 'single' : 'grid');
    });
  }

  // Restore persisted mode on load (after chart.js has booted)
  if (mode === 'grid') {
    // Defer one tick so chart.js finishes its initial loadData() call first
    setTimeout(() => setMode('grid'), 0);
  }

})();
