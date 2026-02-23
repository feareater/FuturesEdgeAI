'use strict';
// TradingView Lightweight Charts renderer
// Expects LightweightCharts global from the CDN script loaded in index.html

(function () {

  // ── State ──────────────────────────────────────────────────────────────────
  let activeSymbol    = 'MNQ';
  let activeTf        = '5m';
  let chart           = null;
  let candleSeries    = null;
  let lastCandle      = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const chartContainer = document.getElementById('chart-container');
  const priceValue     = document.getElementById('price-value');
  const priceSymbol    = document.getElementById('price-symbol');
  const ohlcO          = document.getElementById('ohlc-o');
  const ohlcH          = document.getElementById('ohlc-h');
  const ohlcL          = document.getElementById('ohlc-l');
  const ohlcC          = document.getElementById('ohlc-c');

  // ── Chart init ─────────────────────────────────────────────────────────────
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
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
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
      handleScroll:  { mouseWheel: true, pressedMouseMove: true },
      handleScale:   { mouseWheel: true, pinch: true },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor:      '#26a69a',
      downColor:    '#ef5350',
      borderVisible: false,
      wickUpColor:  '#26a69a',
      wickDownColor: '#ef5350',
    });

    // Update OHLC display as the crosshair moves over candles
    chart.subscribeCrosshairMove(param => {
      if (!param.time || !param.seriesData) return;
      const d = param.seriesData.get(candleSeries);
      if (d) {
        setOHLC(d);
      } else {
        resetOHLC();
      }
    });

    // Resize chart when the window changes size
    window.addEventListener('resize', () => {
      chart.applyOptions({
        width:  chartContainer.clientWidth,
        height: chartContainer.clientHeight,
      });
    });
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  async function loadCandles(symbol, timeframe) {
    console.log(`[chart] Fetching ${symbol} ${timeframe}`);

    const res = await fetch(`/api/candles?symbol=${symbol}&timeframe=${timeframe}`);
    if (!res.ok) throw new Error(`/api/candles returned ${res.status}`);

    const { candles } = await res.json();
    if (!candles.length) throw new Error('No candles returned');

    candleSeries.setData(candles);
    chart.timeScale().fitContent();

    lastCandle = candles[candles.length - 1];
    resetOHLC();

    console.log(`[chart] Rendered ${candles.length} candles`);
  }

  // ── OHLC display helpers ───────────────────────────────────────────────────
  function fmt(n) {
    return n == null ? '—' : n.toFixed(2);
  }

  function setOHLC(d) {
    ohlcO.textContent = fmt(d.open);
    ohlcH.textContent = fmt(d.high);
    ohlcL.textContent = fmt(d.low);
    ohlcC.textContent = fmt(d.close);
  }

  function resetOHLC() {
    if (lastCandle) {
      setOHLC(lastCandle);
      priceValue.textContent  = fmt(lastCandle.close);
    }
    priceSymbol.textContent = `${activeSymbol} · ${activeTf}`;
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  function setActive(selector, matchAttr, value) {
    document.querySelectorAll(selector).forEach(btn => {
      btn.classList.toggle('active', btn.dataset[matchAttr] === value);
    });
  }

  document.querySelectorAll('.sym-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeSymbol = btn.dataset.symbol;
      setActive('.sym-btn', 'symbol', activeSymbol);
      loadCandles(activeSymbol, activeTf).catch(err => console.error('[chart]', err.message));
    });
  });

  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTf = btn.dataset.tf;
      setActive('.tf-btn', 'tf', activeTf);
      loadCandles(activeSymbol, activeTf).catch(err => console.error('[chart]', err.message));
    });
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  initChart();
  loadCandles(activeSymbol, activeTf).catch(err => {
    console.error('[chart] Initial load failed:', err.message);
  });

})();
