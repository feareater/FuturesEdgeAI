'use strict';
// TradingView Lightweight Charts renderer + indicator overlays.
// Exposes window.ChartAPI so layers.js can toggle series visibility.

(function () {

  // ── State ──────────────────────────────────────────────────────────────────
  let activeSymbol = 'MNQ';
  let activeTf     = '5m';
  let lastCandle   = null;

  // Chart + base series
  let chart        = null;
  let candleSeries = null;

  // Overlay line series (created once, data swapped on symbol/tf change)
  const lineSeries = { ema9: null, ema21: null, ema50: null, vwap: null };

  // PDH/PDL price line handles (re-created each load)
  let pdhLine = null;
  let pdlLine = null;
  let currentPDH = null;
  let currentPDL = null;

  // Swing marker arrays (merged + sorted before calling setMarkers)
  let swingHighMarkers = [];
  let swingLowMarkers  = [];

  // Layer visibility — layers.js writes here via ChartAPI before and after load
  const vis = {
    ema9:            true,
    ema21:           true,
    ema50:           true,
    vwap:            true,
    priorDayHighLow: true,
    swingHighLow:    true,
  };

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const chartContainer = document.getElementById('chart-container');
  const priceValue     = document.getElementById('price-value');
  const priceSymbol    = document.getElementById('price-symbol');
  const ohlcO = document.getElementById('ohlc-o');
  const ohlcH = document.getElementById('ohlc-h');
  const ohlcL = document.getElementById('ohlc-l');
  const ohlcC = document.getElementById('ohlc-c');

  // ── Chart + series init ────────────────────────────────────────────────────
  function initChart() {
    chart = LightweightCharts.createChart(chartContainer, {
      width:  chartContainer.clientWidth,
      height: chartContainer.clientHeight,
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
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: '#2a2e39',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true },
    });

    // Candlestick series — always on, not toggled
    candleSeries = chart.addCandlestickSeries({
      upColor:       '#26a69a',
      downColor:     '#ef5350',
      borderVisible: false,
      wickUpColor:   '#26a69a',
      wickDownColor: '#ef5350',
    });

    // EMA line series — created once, hidden/shown via applyOptions
    lineSeries.ema9 = chart.addLineSeries({
      color: '#2962ff', lineWidth: 1,
      priceLineVisible: false, crosshairMarkerVisible: false,
      title: 'EMA 9',
    });
    lineSeries.ema21 = chart.addLineSeries({
      color: '#ff6d00', lineWidth: 1,
      priceLineVisible: false, crosshairMarkerVisible: false,
      title: 'EMA 21',
    });
    lineSeries.ema50 = chart.addLineSeries({
      color: '#d500f9', lineWidth: 1,
      priceLineVisible: false, crosshairMarkerVisible: false,
      title: 'EMA 50',
    });

    // VWAP — dashed cyan line
    lineSeries.vwap = chart.addLineSeries({
      color: '#00bcd4', lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, crosshairMarkerVisible: false,
      title: 'VWAP',
    });

    // OHLC crosshair display
    chart.subscribeCrosshairMove(param => {
      if (!param.time || !param.seriesData) return;
      const d = param.seriesData.get(candleSeries);
      d ? setOHLC(d) : resetOHLC();
    });

    window.addEventListener('resize', () => {
      chart.applyOptions({
        width:  chartContainer.clientWidth,
        height: chartContainer.clientHeight,
      });
    });
  }

  // ── Data loading ───────────────────────────────────────────────────────────
  async function loadData(symbol, tf) {
    console.log(`[chart] Loading ${symbol} ${tf}`);

    // Fetch candles and indicators in parallel
    const [candleRes, indRes] = await Promise.all([
      fetch(`/api/candles?symbol=${symbol}&timeframe=${tf}`),
      fetch(`/api/indicators?symbol=${symbol}&timeframe=${tf}`),
    ]);

    if (!candleRes.ok) throw new Error(`/api/candles ${candleRes.status}`);
    if (!indRes.ok)    throw new Error(`/api/indicators ${indRes.status}`);

    const { candles }    = await candleRes.json();
    const indicators     = await indRes.json();

    if (!candles.length) throw new Error('No candles returned');

    // Candles
    candleSeries.setData(candles);
    chart.timeScale().fitContent();
    lastCandle = candles[candles.length - 1];
    resetOHLC();

    // Overlays
    renderIndicators(indicators);

    console.log(`[chart] Rendered ${candles.length} candles  ATR: ${indicators.atrCurrent?.toFixed(2)}`);
  }

  // ── Indicator rendering ────────────────────────────────────────────────────
  function renderIndicators(d) {
    // EMA + VWAP line series
    lineSeries.ema9.setData(d.ema9);
    lineSeries.ema21.setData(d.ema21);
    lineSeries.ema50.setData(d.ema50);
    lineSeries.vwap.setData(d.vwap);

    // PDH / PDL price lines — remove stale, store new values, redraw if visible
    clearPricelines();
    currentPDH = d.pdh;
    currentPDL = d.pdl;
    if (vis.priorDayHighLow) drawPricelines();

    // Swing markers
    swingHighMarkers = (d.swingHighs || []).map(s => ({
      time:     s.time,
      position: 'aboveBar',
      color:    '#ef5350',
      shape:    'arrowDown',
      size:     1,
    }));
    swingLowMarkers = (d.swingLows || []).map(s => ({
      time:     s.time,
      position: 'belowBar',
      color:    '#26a69a',
      shape:    'arrowUp',
      size:     1,
    }));
    updateMarkers();

    // Apply any visibility state that was set before this load completed
    for (const [key, visible] of Object.entries(vis)) {
      _applyVis(key, visible);
    }
  }

  function clearPricelines() {
    if (pdhLine) { candleSeries.removePriceLine(pdhLine); pdhLine = null; }
    if (pdlLine) { candleSeries.removePriceLine(pdlLine); pdlLine = null; }
  }

  function drawPricelines() {
    if (currentPDH != null) {
      pdhLine = candleSeries.createPriceLine({
        price: currentPDH,
        color: '#607d8b',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'PDH',
      });
    }
    if (currentPDL != null) {
      pdlLine = candleSeries.createPriceLine({
        price: currentPDL,
        color: '#607d8b',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'PDL',
      });
    }
  }

  function updateMarkers() {
    const markers = [
      ...(vis.swingHighLow ? swingHighMarkers : []),
      ...(vis.swingHighLow ? swingLowMarkers  : []),
    ].sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(markers);
  }

  // ── Visibility ─────────────────────────────────────────────────────────────
  function _applyVis(key, visible) {
    switch (key) {
      case 'ema9':
      case 'ema21':
      case 'ema50':
      case 'vwap':
        lineSeries[key]?.applyOptions({ visible });
        break;
      case 'priorDayHighLow':
        clearPricelines();
        if (visible) drawPricelines();
        break;
      case 'swingHighLow':
        updateMarkers();
        break;
    }
  }

  // ── Public API (consumed by layers.js) ────────────────────────────────────
  window.ChartAPI = {
    setLayerVisible(key, visible) {
      vis[key] = visible;
      _applyVis(key, visible);
    },
  };

  // ── OHLC display ───────────────────────────────────────────────────────────
  function fmt(n) { return n == null ? '—' : n.toFixed(2); }

  function setOHLC(d) {
    ohlcO.textContent = fmt(d.open);
    ohlcH.textContent = fmt(d.high);
    ohlcL.textContent = fmt(d.low);
    ohlcC.textContent = fmt(d.close);
  }

  function resetOHLC() {
    if (lastCandle) {
      setOHLC(lastCandle);
      priceValue.textContent = fmt(lastCandle.close);
    }
    priceSymbol.textContent = `${activeSymbol} · ${activeTf}`;
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  function setActive(selector, attr, value) {
    document.querySelectorAll(selector).forEach(btn => {
      btn.classList.toggle('active', btn.dataset[attr] === value);
    });
  }

  document.querySelectorAll('.sym-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeSymbol = btn.dataset.symbol;
      setActive('.sym-btn', 'symbol', activeSymbol);
      loadData(activeSymbol, activeTf).catch(err => console.error('[chart]', err.message));
    });
  });

  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTf = btn.dataset.tf;
      setActive('.tf-btn', 'tf', activeTf);
      loadData(activeSymbol, activeTf).catch(err => console.error('[chart]', err.message));
    });
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  initChart();
  loadData(activeSymbol, activeTf).catch(err => {
    console.error('[chart] Initial load failed:', err.message);
  });

})();
