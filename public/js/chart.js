'use strict';
// TradingView Lightweight Charts renderer + indicator overlays.
// Exposes window.ChartAPI so layers.js can toggle series visibility.

(function () {

  // ── Multi-TF trendline constants ───────────────────────────────────────────
  const TRENDLINE_TFS = ['1m', '5m', '15m'];
  const TREND_COLORS = {
    '1m':  { support: 'rgba(102,187,106,0.50)', resistance: 'rgba(239,154,154,0.50)', width: 1 },
    '5m':  { support: 'rgba(0,220,110,0.72)',   resistance: 'rgba(239,83,80,0.72)',   width: 1 },
    '15m': { support: '#00e676',                resistance: '#ef5350',               width: 2 },
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let activeSymbol = 'MNQ';
  let activeTf     = '5m';
  let lastCandle   = null;
  let _liveTickBar = null;  // in-progress bar for the current 1m window (from live_price ticks)
  let _gapRefetchPending = false;  // prevents multiple auto-refetches
  let _gapRetryCount     = 0;     // tracks retry attempts (max 3)
  let _gapRetryTimer     = null;  // setTimeout ID — cleared on symbol/TF switch to prevent stale data overwrite
  const _GAP_RETRY_DELAYS = [2000, 5000, 15000];  // backoff delays in ms
  let _currentFetchController = null;  // AbortController for in-flight candle/indicator fetches

  // Chart + base series
  let chart        = null;
  let candleSeries = null;

  // EMA / VWAP overlay line series
  const lineSeries = {
    ema9:  null,
    ema21: null,
    ema50: null,
    vwap:  null,
  };

  // Multi-TF trendline series — keys like '1m_support', '15m_resistance'
  const trendLineSeries = {};

  // PDH/PDL price line handles (re-created each load)
  let pdhLine = null;
  let pdlLine = null;
  let currentPDH = null;
  let currentPDL = null;

  // IOF zone price line handles (re-created each load)
  let iofPriceLines = [];
  let lastFVGs      = [];
  let lastOBs       = [];

  // Volume Profile price line handles
  let vpPriceLines      = [];
  let lastVolumeProfile = null;

  // Opening Range price line handles
  let orPriceLines    = [];
  let lastOpeningRange = null;

  // Session Level price line handles
  let sessionPriceLines = [];
  let lastSessionLevels = null;

  // CVD sub-chart
  let cvdChart      = null;
  let cvdHistSeries = null;
  let cvdLineSeries = null;
  let rawCandles    = [];

  // DD Band / SPAN price line handles
  let ddBandLines    = [];
  let lastDDBands    = null;

  // Options Levels price line handles
  let optionsPriceLines = [];
  let lastOptionsLevels = null;

  // Monthly / Quarterly HP price line handles (separate from daily HP in optionsPriceLines)
  let monthlyHPLines   = [];
  let quarterlyHPLines = [];

  // Gamma Levels price line handles (gamma flip, call wall, put wall)
  let gammaLines     = [];
  let lastGammaData  = null;

  // Marker arrays merged into candleSeries
  let swingHighMarkers = [];
  let swingLowMarkers  = [];
  let trendlineMarkers = [];   // TF endpoint labels
  let setupEntryMkr    = null;
  let alertMarkers     = [];   // alert setup arrows
  let alertMarkersData = [];   // parallel alert objects (for click lookup)

  // Active candle times (sorted) for snapping trendline timestamps
  let activeCandleTimes = [];

  // Setup overlay (click-to-chart)
  let setupSlLine    = null;
  let setupTpLine    = null;
  let pendingOverlay = null;

  // Layer visibility
  const vis = {
    ema9:               true,
    ema21:              true,
    ema50:              true,
    vwap:               true,
    priorDayHighLow:    true,
    swingHighLow:       true,
    trendlines:         true,
    iofZones:           true,
    volumeProfile:      true,
    openingRange:       true,
    sessionLevels:      true,
    correlationHeatmap: true,
    cvd:                true,
    optionsLevels:      true,
    hpMonthly:          true,
    hpQuarterly:        true,
    ddBands:            true,
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
        // Axis tick labels in 12-hour Mountain Time.
        // tickMarkType: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
        tickMarkFormatter: (time, tickMarkType) => {
          const d = new Date(time * 1000);
          if (tickMarkType >= 3) {
            return d.toLocaleTimeString('en-US', {
              hour: 'numeric', minute: '2-digit', hour12: true,
              timeZone: 'America/Denver',
            });
          }
          return d.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric',
            timeZone: 'America/Denver',
          });
        },
      },
      // Display all chart times in Mountain Time (MST = UTC-7, MDT = UTC-6)
      localization: {
        timeFormatter: (ts) => new Date(ts * 1000).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true,
          timeZone: 'America/Denver',
        }),
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true },
    });

    // Candlestick series — always on
    candleSeries = chart.addCandlestickSeries({
      upColor:       '#26a69a',
      downColor:     '#ef5350',
      borderVisible: false,
      wickUpColor:   '#26a69a',
      wickDownColor: '#ef5350',
    });

    // EMA line series
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

    // VWAP — dashed cyan
    lineSeries.vwap = chart.addLineSeries({
      color: '#00bcd4', lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, crosshairMarkerVisible: false,
      title: 'VWAP',
    });

    // Multi-TF trendline series (6 total: 3 TFs × support + resistance)
    for (const tf of TRENDLINE_TFS) {
      const c = TREND_COLORS[tf];
      trendLineSeries[`${tf}_support`] = chart.addLineSeries({
        color: c.support, lineWidth: c.width,
        priceLineVisible: false, crosshairMarkerVisible: false,
        lastValueVisible: false,
      });
      trendLineSeries[`${tf}_resistance`] = chart.addLineSeries({
        color: c.resistance, lineWidth: c.width,
        priceLineVisible: false, crosshairMarkerVisible: false,
        lastValueVisible: false,
      });
    }

    // OHLC crosshair display
    chart.subscribeCrosshairMove(param => {
      if (!param.time || !param.seriesData) return;
      const d = param.seriesData.get(candleSeries);
      d ? setOHLC(d) : resetOHLC();
    });

    // CVD sub-chart — initialized here but only shown when cvd layer is on
    const cvdEl = document.getElementById('cvd-container');
    if (cvdEl) {
      cvdChart = LightweightCharts.createChart(cvdEl, {
        width:  cvdEl.clientWidth,
        height: cvdEl.clientHeight,
        layout: {
          background: { type: 'solid', color: '#131722' },
          textColor: '#d1d4dc',
        },
        grid: {
          vertLines: { color: '#1e222d' },
          horzLines: { color: '#1e222d' },
        },
        rightPriceScale: { borderColor: '#2a2e39', autoScale: true },
        timeScale: { borderColor: '#2a2e39', visible: false },
        handleScroll: false,
        handleScale: false,
      });
      cvdHistSeries = cvdChart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      cvdLineSeries = cvdChart.addLineSeries({
        color: '#2196f3', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: true, title: 'CVD',
      });
      // One-way time sync: main chart scroll/zoom drives CVD sub-chart
      chart.timeScale().subscribeVisibleTimeRangeChange(range => {
        if (!range || !vis.cvd) return;
        try { cvdChart.timeScale().setVisibleRange(range); } catch (_) {}
      });
    }

    window.addEventListener('resize', () => {
      chart.applyOptions({
        width:  chartContainer.clientWidth,
        height: chartContainer.clientHeight,
      });
      if (cvdChart && vis.cvd) {
        const el = document.getElementById('cvd-container');
        if (el) cvdChart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      }
    });

    // Alert marker click — find alerts whose snapped time matches the clicked bar.
    chart.subscribeClick(param => {
      if (!param.time || !alertMarkersData.length) return;
      const hit = alertMarkersData.filter(a => _snapToCandle(a.setup.time) === param.time);
      if (hit.length === 0) return;
      document.dispatchEvent(new CustomEvent('chartMarkerClick', {
        detail: { alerts: hit },
      }));
    });
  }

  // ── Gap detection ──────────────────────────────────────────────────────────
  const _TF_SECS = { '1m':60, '2m':120, '3m':180, '5m':300, '15m':900, '30m':1800, '1h':3600, '2h':7200, '4h':14400 };

  function _detectChartGaps(candles, tf) {
    const tfSec = _TF_SECS[tf] ?? 300;
    const threshold = tfSec * 2;

    // Check for tail gap (last bar vs current time)
    const nowTs = Math.floor(Date.now() / 1000);
    const lastTs = candles[candles.length - 1]?.time ?? 0;
    if (nowTs - lastTs > threshold) {
      return { hasGap: true, gapStart: lastTs, gapEnd: nowTs, type: 'tail' };
    }

    // Check for internal gaps
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].time - candles[i - 1].time > threshold) {
        return { hasGap: true, gapStart: candles[i - 1].time, gapEnd: candles[i].time, type: 'internal' };
      }
    }
    return { hasGap: false };
  }

  function _showGapIndicator(msg) {
    const el = document.getElementById('chart-gap-indicator');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  function _hideGapIndicator() {
    const el = document.getElementById('chart-gap-indicator');
    if (el) el.style.display = 'none';
  }

  /**
   * Schedule a gap refetch with exponential backoff.
   * Retries up to 3 times (2s, 5s, 15s) before showing "Gap in data".
   */
  function _scheduleGapRetry(symbol, tf) {
    if (_gapRetryCount >= _GAP_RETRY_DELAYS.length) {
      _showGapIndicator('Gap in data');
      _gapRefetchPending = false;
      console.log(`[chart] Gap persists after ${_gapRetryCount} retries — giving up`);
      return;
    }

    const delay = _GAP_RETRY_DELAYS[_gapRetryCount];
    _gapRefetchPending = true;
    _showGapIndicator('\u27F3 Refreshing data...');
    console.log(`[chart] Gap detected — refetch ${_gapRetryCount + 1}/${_GAP_RETRY_DELAYS.length} in ${delay / 1000}s`);

    _gapRetryTimer = setTimeout(async () => {
      _gapRetryTimer = null;

      // Guard: if user switched symbol/TF since this retry was scheduled, abort
      if (symbol !== activeSymbol || tf !== activeTf) {
        console.log(`[chart] Gap retry cancelled — symbol changed from ${symbol} to ${activeSymbol}`);
        _gapRefetchPending = false;
        _gapRetryCount = 0;
        return;
      }

      try {
        const refreshRes = await fetch(`/api/candles?symbol=${symbol}&timeframe=${tf}&refresh=true`);
        // Re-check after await — user may have switched during fetch
        if (symbol !== activeSymbol || tf !== activeTf) {
          console.log(`[chart] Gap retry result discarded — symbol changed during fetch`);
          _gapRefetchPending = false;
          _gapRetryCount = 0;
          return;
        }
        if (refreshRes.ok) {
          const { candles: freshCandles } = await refreshRes.json();
          if (freshCandles && freshCandles.length >= 2) {
            candleSeries.setData(freshCandles);
            rawCandles = freshCandles;
            lastCandle = freshCandles[freshCandles.length - 1];
            _liveTickBar = null;
            activeCandleTimes = freshCandles.map(c => c.time);
            console.log(`[chart] Refreshed: ${freshCandles.length} candles`);
          }
        }
      } catch (err) {
        console.warn('[chart] Gap refetch failed:', err.message);
      }

      const postGap = _detectChartGaps(rawCandles, tf);
      if (postGap.hasGap) {
        _gapRetryCount++;
        console.log(`[chart] Gap still present after refetch ${_gapRetryCount}, retrying...`);
        _scheduleGapRetry(symbol, tf);
      } else {
        _hideGapIndicator();
        _gapRefetchPending = false;
        _gapRetryCount = 0;
      }
    }, delay);
  }

  // ── Loading overlay ──────────────────────────────────────────────────────
  function _showChartLoading(symbol) {
    let el = document.getElementById('chart-loading-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chart-loading-overlay';
      el.style.cssText = [
        'position:absolute', 'inset:0', 'z-index:10',
        'background:rgba(0,0,0,0.45)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'color:var(--text-dim,#999)', 'font-size:0.9em', 'letter-spacing:0.05em',
        'pointer-events:none', 'font-family:inherit'
      ].join(';');
      const chartEl = document.getElementById('chart');
      if (chartEl) {
        chartEl.style.position = 'relative';
        chartEl.appendChild(el);
      }
    }
    el.textContent = `Loading ${symbol}...`;
    el.style.display = 'flex';
  }

  function _hideChartLoading() {
    const el = document.getElementById('chart-loading-overlay');
    if (el) el.style.display = 'none';
  }

  /**
   * Clear all chart series data and price lines immediately.
   * Called on symbol/TF switch to prevent stale data from persisting during fetch.
   */
  function _clearAllSeriesAndOverlays() {
    // Clear candlestick data
    if (candleSeries) candleSeries.setData([]);

    // Clear EMA + VWAP overlay lines
    if (lineSeries.ema9)  lineSeries.ema9.setData([]);
    if (lineSeries.ema21) lineSeries.ema21.setData([]);
    if (lineSeries.ema50) lineSeries.ema50.setData([]);
    if (lineSeries.vwap)  lineSeries.vwap.setData([]);

    // Clear all price lines (PDH/PDL, IOF, VP, OR, sessions, DD bands, options, HP, gamma)
    clearPricelines();
    for (const { line } of iofPriceLines) { try { candleSeries.removePriceLine(line); } catch (_) {} }
    iofPriceLines = [];
    for (const { line } of vpPriceLines) { try { candleSeries.removePriceLine(line); } catch (_) {} }
    vpPriceLines = [];
    for (const { line } of orPriceLines) { try { candleSeries.removePriceLine(line); } catch (_) {} }
    orPriceLines = [];
    for (const { line } of sessionPriceLines) { try { candleSeries.removePriceLine(line); } catch (_) {} }
    sessionPriceLines = [];
    for (const line of ddBandLines) { try { candleSeries.removePriceLine(line); } catch (_) {} }
    ddBandLines = [];
    for (const { line } of optionsPriceLines) { try { candleSeries.removePriceLine(line); } catch (_) {} }
    optionsPriceLines = [];
    for (const { line } of monthlyHPLines) { try { candleSeries.removePriceLine(line); } catch (_) {} }
    monthlyHPLines = [];
    for (const line of quarterlyHPLines) { try { candleSeries.removePriceLine(line); } catch (_) {} }
    quarterlyHPLines = [];
    for (const line of gammaLines) { try { candleSeries.removePriceLine(line); } catch (_) {} }
    gammaLines = [];

    // Clear markers
    if (candleSeries) candleSeries.setMarkers([]);

    // Clear trendline series data
    for (const key of Object.keys(trendLineSeries)) {
      if (trendLineSeries[key]) trendLineSeries[key].setData([]);
    }

    // Clear CVD sub-chart
    if (cvdHistSeries) cvdHistSeries.setData([]);
    if (cvdLineSeries) cvdLineSeries.setData([]);
  }

  // ── Data loading ───────────────────────────────────────────────────────────
  async function loadData(symbol, tf) {
    console.log(`[chart] Loading ${symbol} ${tf}`);

    // Cancel any previous in-flight fetch
    if (_currentFetchController) {
      _currentFetchController.abort();
    }
    _currentFetchController = new AbortController();
    const signal = _currentFetchController.signal;

    // Cancel any pending gap retry — its closure captured the OLD symbol and would
    // overwrite this new symbol's chart data when it fires
    if (_gapRetryTimer) {
      clearTimeout(_gapRetryTimer);
      _gapRetryTimer = null;
      _gapRefetchPending = false;
      _gapRetryCount = 0;
    }

    // Clear all series and overlays immediately — prevents stale data from
    // the previous symbol persisting during the async fetch
    _clearAllSeriesAndOverlays();
    _showChartLoading(symbol);

    // Clear all symbol-specific state before loading new data — prevents stale
    // markers, overlays, and price lines from the previous symbol persisting.
    alertMarkers     = [];
    alertMarkersData = [];
    _clearSetupOverlay();
    _liveTickBar = null;

    // Clear any previous no-data message
    const noDataEl = document.getElementById('chart-no-data');
    if (noDataEl) noDataEl.style.display = 'none';

    let candleRes, indRes, tlRes;
    try {
      [candleRes, indRes, tlRes] = await Promise.all([
        fetch(`/api/candles?symbol=${symbol}&timeframe=${tf}`, { signal }),
        fetch(`/api/indicators?symbol=${symbol}&timeframe=${tf}`, { signal }),
        fetch(`/api/trendlines?symbol=${symbol}`, { signal }),
      ]);
    } catch (err) {
      if (err.name === 'AbortError') { return; } // user switched away, ignore
      _hideChartLoading();
      throw err;
    }

    if (!candleRes.ok) {
      _hideChartLoading();
      // 1m seed data doesn't exist for all symbols — show friendly message instead of throwing
      if (tf === '1m') {
        if (noDataEl) {
          noDataEl.textContent = '1m data requires live feed (enable Databento in features)';
          noDataEl.style.display = 'block';
        }
        return;
      }
      throw new Error(`/api/candles ${candleRes.status}`);
    }
    if (!indRes.ok) { _hideChartLoading(); throw new Error(`/api/indicators ${indRes.status}`); }

    const { candles } = await candleRes.json();
    const indicators  = await indRes.json();
    const tlData      = tlRes.ok ? await tlRes.json() : {};

    if (!candles || candles.length < 2) {
      _hideChartLoading();
      // Show "Waiting for data" overlay — auto-dismiss on next successful load
      if (noDataEl) {
        noDataEl.textContent = `Waiting for data… (${symbol} ${tf})`;
        noDataEl.style.display = 'block';
      }
      console.warn(`[chart] No candle data for ${symbol} ${tf} — showing waiting overlay`);
      _notifyView();
      return;
    }

    // Apply symbol-specific price format (XRP needs 4 decimal places)
    const dec = _priceDec(symbol);
    candleSeries.applyOptions({
      priceFormat: { type: 'price', precision: dec, minMove: dec === 4 ? 0.0001 : 0.01 },
    });

    // Abort guard: if user switched symbols during JSON parsing, bail out
    if (signal.aborted) return;

    candleSeries.setData(candles);
    rawCandles = candles;
    chart.timeScale().scrollToRealTime();
    lastCandle   = candles[candles.length - 1];
    _liveTickBar = null;  // reset in-progress bar on fresh data load

    // Store sorted candle times for trendline timestamp snapping
    activeCandleTimes = candles.map(c => c.time);

    resetOHLC();
    renderIndicators(indicators, tlData.trendlines || {});

    _hideChartLoading();

    if (pendingOverlay) { _drawSetupOverlay(pendingOverlay); pendingOverlay = null; }

    console.log(`[chart] Rendered ${candles.length} candles  ATR:${indicators.atrCurrent?.toFixed(2)}`);

    // Gap detection: auto-refetch with backoff (up to 3 retries: 2s, 5s, 15s)
    _hideGapIndicator();
    const gapResult = _detectChartGaps(candles, tf);
    if (gapResult.hasGap && !_gapRefetchPending) {
      _gapRetryCount = 0;
      _scheduleGapRetry(symbol, tf);
    } else if (!gapResult.hasGap) {
      _hideGapIndicator();
      _gapRetryCount = 0;
    }

    _notifyView();
  }

  /** Broadcast current symbol+TF to other modules via a DOM custom event. */
  function _notifyView() {
    document.dispatchEvent(new CustomEvent('chartViewChange', {
      detail: { symbol: activeSymbol, tf: activeTf },
    }));
  }

  // ── Indicator rendering ────────────────────────────────────────────────────
  function renderIndicators(d, multiTFTrendlines) {
    // EMA + VWAP
    lineSeries.ema9.setData(d.ema9);
    lineSeries.ema21.setData(d.ema21);
    lineSeries.ema50.setData(d.ema50);
    lineSeries.vwap.setData(d.vwap);

    // PDH/PDL
    clearPricelines();
    currentPDH = d.pdh;
    currentPDL = d.pdl;
    if (vis.priorDayHighLow) drawPricelines();

    // Swing markers — small circles only (structural context).
    // Arrows are reserved for the entry/exit overlay (click-to-chart).
    swingHighMarkers = (d.swingHighs || []).map(s => ({
      time:     s.time,
      position: 'aboveBar',
      color:    'rgba(239,83,80,0.40)',
      shape:    'circle',
      size:     1,
    }));
    swingLowMarkers = (d.swingLows || []).map(s => ({
      time:     s.time,
      position: 'belowBar',
      color:    'rgba(38,166,154,0.40)',
      shape:    'circle',
      size:     1,
    }));
    updateMarkers();

    // Multi-TF trendlines (1m, 5m, 15m — shown regardless of active TF)
    _renderMultiTFTrendlines(multiTFTrendlines);

    // IOF zones (FVGs + Order Blocks)
    lastFVGs = d.fvgs        || [];
    lastOBs  = d.orderBlocks || [];
    clearIOFZones();
    if (vis.iofZones) _drawIOFZones(lastFVGs, lastOBs);

    // Volume Profile
    lastVolumeProfile = d.volumeProfile || null;
    clearVPLines();
    if (vis.volumeProfile && lastVolumeProfile) _drawVolumeProfile(lastVolumeProfile);

    // Opening Range
    lastOpeningRange = d.openingRange || null;
    clearORLines();
    if (vis.openingRange && lastOpeningRange?.formed) _drawOpeningRange(lastOpeningRange);

    // Session Levels
    lastSessionLevels = d.sessionLevels || null;
    clearSessionLines();
    if (vis.sessionLevels && lastSessionLevels) _drawSessionLevels(lastSessionLevels);

    // CVD — recompute from rawCandles on every data load
    clearCVD();
    if (vis.cvd) _drawCVD();

    // Options Levels — cleared here; fresh data arrives async via setOptionsLevels()
    clearOptionsLines();
    clearMonthlyHPLines();
    clearQuarterlyHPLines();
    lastOptionsLevels = null;

    // DD Bands — cleared here; fresh data arrives async via setDDBands()
    clearDDBandLines();
    lastDDBands = null;

    // Apply persisted visibility state
    for (const [key, visible] of Object.entries(vis)) {
      _applyVis(key, visible);
    }
  }

  // ── Multi-TF Trendlines ─────────────────────────────────────────────────────

  /**
   * Binary-search snap: find the nearest active candle timestamp.
   * Ensures trendline endpoints align to the chart's time axis.
   */
  function _snapToCandle(ts) {
    if (!activeCandleTimes.length) return ts;
    let lo = 0, hi = activeCandleTimes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (activeCandleTimes[mid] < ts) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return activeCandleTimes[0];
    const before = activeCandleTimes[lo - 1];
    const after  = activeCandleTimes[lo];
    return (ts - before <= after - ts) ? before : after;
  }

  /** Interpolate the trendline price at a new (snapped) timestamp. */
  function _trendlinePrice(origT, origP, endT, endP, newT) {
    if (endT === origT) return origP;
    return origP + (endP - origP) * (newT - origT) / (endT - origT);
  }

  function _renderMultiTFTrendlines(data) {
    trendlineMarkers = [];

    for (const tf of TRENDLINE_TFS) {
      const tfData = data[tf] || {};

      // ── Support ────────────────────────────────────────────────────────────
      const supp    = tfData.support;
      const suppKey = `${tf}_support`;
      if (supp) {
        const t0 = _snapToCandle(supp.startTime);
        const t1 = _snapToCandle(supp.endTime);
        if (t0 < t1) {
          const p0 = _trendlinePrice(supp.startTime, supp.startPrice, supp.endTime, supp.endPrice, t0);
          const p1 = _trendlinePrice(supp.startTime, supp.startPrice, supp.endTime, supp.endPrice, t1);
          trendLineSeries[suppKey].setData([{ time: t0, value: p0 }, { time: t1, value: p1 }]);
          trendlineMarkers.push({
            time: t1, position: 'belowBar',
            color: TREND_COLORS[tf].support, shape: 'circle', size: 0, text: tf,
          });
        } else {
          trendLineSeries[suppKey].setData([]);
        }
      } else {
        trendLineSeries[suppKey].setData([]);
      }

      // ── Resistance ─────────────────────────────────────────────────────────
      const res    = tfData.resistance;
      const resKey = `${tf}_resistance`;
      if (res) {
        const t0 = _snapToCandle(res.startTime);
        const t1 = _snapToCandle(res.endTime);
        if (t0 < t1) {
          const p0 = _trendlinePrice(res.startTime, res.startPrice, res.endTime, res.endPrice, t0);
          const p1 = _trendlinePrice(res.startTime, res.startPrice, res.endTime, res.endPrice, t1);
          trendLineSeries[resKey].setData([{ time: t0, value: p0 }, { time: t1, value: p1 }]);
          trendlineMarkers.push({
            time: t1, position: 'aboveBar',
            color: TREND_COLORS[tf].resistance, shape: 'circle', size: 0, text: tf,
          });
        } else {
          trendLineSeries[resKey].setData([]);
        }
      } else {
        trendLineSeries[resKey].setData([]);
      }
    }

    updateMarkers();
  }

  // ── IOF Zones (FVGs + Order Blocks) ────────────────────────────────────────

  function clearIOFZones() {
    for (const { line } of iofPriceLines) {
      try { candleSeries.removePriceLine(line); } catch (_) {}
    }
    iofPriceLines = [];
  }

  function _drawIOFZones(fvgs, obs) {
    // ── Fair Value Gaps ──────────────────────────────────────────────────────
    // strong: brighter, thicker; normal: standard; weak already filtered server-side
    for (const fvg of fvgs) {
      const isB     = fvg.type === 'bullish';
      const isStrong = fvg.strength === 'strong';
      const alpha   = isStrong ? '0.75' : '0.45';
      const col     = isB ? `rgba(0,230,118,${alpha})` : `rgba(239,83,80,${alpha})`;
      const lbl     = isB
        ? (isStrong ? 'FVG↑★' : 'FVG↑')
        : (isStrong ? 'FVG↓★' : 'FVG↓');
      const width   = isStrong ? 2 : 1;

      iofPriceLines.push({ line: candleSeries.createPriceLine({
        price: fvg.top, color: col, lineWidth: width,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: lbl,
      })});
      iofPriceLines.push({ line: candleSeries.createPriceLine({
        price: fvg.bottom, color: col, lineWidth: width,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: false, title: '',
      })});
    }

    // ── Order Blocks ─────────────────────────────────────────────────────────
    // untested: solid, full opacity; tested: dashed, dimmed; strong: thicker line + star label
    for (const ob of obs) {
      const isB      = ob.type === 'bullish';
      const isStrong = ob.strength === 'strong';
      const isTested = ob.status === 'tested';

      // Tested OBs are dimmer (price has touched them — weakened but not broken)
      const alpha = isTested ? '0.40' : '0.80';
      const col   = isB ? `rgba(38,166,154,${alpha})` : `rgba(239,83,80,${alpha})`;
      const style = isTested
        ? LightweightCharts.LineStyle.Dashed
        : LightweightCharts.LineStyle.Solid;
      const width = isStrong ? 2 : 1;

      // Label: untested = OB↑ or OB↑★; tested = OB↑~ (tilde = touched)
      const baseDir = isB ? '↑' : '↓';
      const lbl = isTested
        ? `OB${baseDir}~`
        : (isStrong ? `OB${baseDir}★` : `OB${baseDir}`);

      iofPriceLines.push({ line: candleSeries.createPriceLine({
        price: ob.top, color: col, lineWidth: width, lineStyle: style,
        axisLabelVisible: true, title: lbl,
      })});
      iofPriceLines.push({ line: candleSeries.createPriceLine({
        price: ob.bottom, color: col, lineWidth: width, lineStyle: style,
        axisLabelVisible: false, title: '',
      })});
    }
  }

  // ── Volume Profile (POC / VAH / VAL) ───────────────────────────────────────

  function clearVPLines() {
    for (const { line } of vpPriceLines) {
      try { candleSeries.removePriceLine(line); } catch (_) {}
    }
    vpPriceLines = [];
  }

  function _drawVolumeProfile(vp) {
    const add = (price, color, style, title, axisLabel = true) => {
      if (price == null) return;
      vpPriceLines.push({ line: candleSeries.createPriceLine({
        price, color, lineWidth: 1, lineStyle: style,
        axisLabelVisible: axisLabel, title,
      })});
    };
    const Dotted  = LightweightCharts.LineStyle.Dotted;
    const Dashed  = LightweightCharts.LineStyle.Dashed;
    add(vp.poc,     'rgba(255,255,255,0.85)', Dashed,  'POC');
    add(vp.vah,     'rgba(38,166,154,0.80)',  Dashed,  'VAH');
    add(vp.val,     'rgba(239,83,80,0.80)',   Dashed,  'VAL');
    add(vp.prevPoc, 'rgba(180,180,180,0.40)', Dotted,  'pPOC');
    // HVN — amber dotted, axis label hidden to reduce clutter
    for (const price of (vp.hvn || [])) {
      add(price, 'rgba(255,193,7,0.55)', Dotted, 'HVN', false);
    }
    // LVN — lavender dotted, axis label hidden
    for (const price of (vp.lvn || [])) {
      add(price, 'rgba(179,136,255,0.55)', Dotted, 'LVN', false);
    }
  }

  // ── CVD (Cumulative Volume Delta) ──────────────────────────────────────────

  function _computeCVD(candles) {
    // Crypto (24/7): reset CVD at midnight UTC each day.
    // Futures: reset at RTH session open (13:30 UTC = 09:30 ET).
    const isCrypto = ['BTC', 'ETH', 'XRP'].includes(activeSymbol);
    const RTH_SECS = 13 * 3600 + 30 * 60; // 13:30 UTC
    let cumDelta = 0, currentDay = null;
    const histData = [], lineData = [];
    for (const c of candles) {
      const d = new Date(c.time * 1000);
      const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      if (isCrypto) {
        // Reset at each new UTC calendar day
        if (dayKey !== currentDay) { cumDelta = 0; currentDay = dayKey; }
      } else {
        // Reset at RTH session open
        const utcSec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60;
        if (dayKey !== currentDay && utcSec >= RTH_SECS) { cumDelta = 0; currentDay = dayKey; }
        if (!currentDay) continue;
      }
      const hl = c.high - c.low;
      const delta = hl > 0 ? c.volume * (2 * (c.close - c.low) / hl - 1) : 0;
      cumDelta += delta;
      histData.push({ time: c.time, value: delta, color: delta >= 0 ? '#26a69a' : '#ef5350' });
      lineData.push({ time: c.time, value: cumDelta });
    }
    return { histData, lineData };
  }

  function clearCVD() {
    if (cvdHistSeries) cvdHistSeries.setData([]);
    if (cvdLineSeries)  cvdLineSeries.setData([]);
  }

  function _drawCVD() {
    if (!rawCandles.length || !cvdHistSeries) return;
    const { histData, lineData } = _computeCVD(rawCandles);
    cvdHistSeries.setData(histData);
    cvdLineSeries.setData(lineData);
    try {
      const r = chart.timeScale().getVisibleRange();
      if (r && cvdChart) cvdChart.timeScale().setVisibleRange(r);
    } catch (_) {}
  }

  // ── Options Levels ─────────────────────────────────────────────────────────

  function clearOptionsLines() {
    for (const { line } of optionsPriceLines) {
      try { candleSeries.removePriceLine(line); } catch (_) {}
    }
    optionsPriceLines = [];
  }

  function _drawOptionsLevels(data) {
    if (!data) return;
    const Dashed = LightweightCharts.LineStyle.Dashed;
    const Dotted = LightweightCharts.LineStyle.Dotted;
    // OI Walls — deep orange dashed, dimming by rank
    (data.oiWalls || []).forEach((strike, i) => {
      if (strike == null) return;
      optionsPriceLines.push({ line: candleSeries.createPriceLine({
        price: strike,
        color: `rgba(255,87,34,${(0.85 - i * 0.15).toFixed(2)})`,
        lineWidth: i === 0 ? 2 : 1,
        lineStyle: Dashed,
        axisLabelVisible: true,
        title: `OI${i + 1}`,
      })});
    });
    // Max Pain — magenta dotted
    if (data.maxPain != null) {
      optionsPriceLines.push({ line: candleSeries.createPriceLine({
        price: data.maxPain,
        color: 'rgba(233,30,99,0.80)',
        lineWidth: 1,
        lineStyle: Dotted,
        axisLabelVisible: true,
        title: 'MaxPain',
      })});
    }
    // Liquidity Zones — shaded price bands where clustered OI creates friction
    // call-biased = overhead resistance (blue), put-biased = below support (green), balanced = pivot zone (yellow)
    (data.scaledLiquidityZones || []).forEach((z, i) => {
      if (z.center == null) return;
      const opacity = (0.55 - i * 0.08).toFixed(2);
      const color = z.bias === 'call'     ? `rgba(33,150,243,${opacity})`   // blue  — resistance liquidity
                  : z.bias === 'put'      ? `rgba(38,166,154,${opacity})`   // teal  — support liquidity
                  :                         `rgba(255,235,59,${opacity})`;  // yellow — balanced/pivot
      optionsPriceLines.push({ line: candleSeries.createPriceLine({
        price: z.center,
        color,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.SparseDotted,
        axisLabelVisible: i === 0,
        title: i === 0 ? `LZ ${z.bias[0].toUpperCase()}` : '',
      })});
    });

    // Hedge Pressure Zones — where dealer gamma hedging is most mechanically intense
    // support pressure = dealers buy dips here (green solid), resistance = dealers sell rips (red solid)
    (data.scaledHedgePressureZones || []).slice(0, 3).forEach((z, i) => {
      if (z.strike == null) return;
      const opacity = (0.70 - i * 0.15).toFixed(2);
      const color = z.pressure === 'support'
        ? `rgba(76,175,80,${opacity})`    // green — mechanical buying
        : `rgba(244,67,54,${opacity})`;   // red   — mechanical selling
      optionsPriceLines.push({ line: candleSeries.createPriceLine({
        price: z.strike,
        color,
        lineWidth: i === 0 ? 2 : 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `HP ${z.pressure === 'support' ? '▲' : '▼'}`,
      })});
    });

    // Pivot Candidates — balanced call/put OI, most likely natural turning points
    (data.scaledPivotCandidates || []).slice(0, 3).forEach((z, i) => {
      if (z.strike == null) return;
      optionsPriceLines.push({ line: candleSeries.createPriceLine({
        price: z.strike,
        color: `rgba(255,152,0,${(0.70 - i * 0.15).toFixed(2)})`,  // orange
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.SparseDotted,
        axisLabelVisible: i === 0,
        title: i === 0 ? 'Pivot' : '',
      })});
    });

    // Proxy ETF daily reference levels — scaled to futures price space
    const dl = data.scaledDaily;
    if (dl) {
      const PROXY_LABEL = { MNQ: 'QQQ', MES: 'SPY', MGC: 'GLD', MCL: 'USO', SIL: 'SLV' };
      const proxy = PROXY_LABEL[activeSymbol] || 'ETF';
      if (dl.prevDayOpen != null) {
        optionsPriceLines.push({ line: candleSeries.createPriceLine({
          price: dl.prevDayOpen,
          color: 'rgba(179,136,255,0.75)',  // soft purple
          lineWidth: 1,
          lineStyle: Dotted,
          axisLabelVisible: true,
          title: `${proxy} PDO`,
        })});
      }
      if (dl.prevDayClose != null) {
        optionsPriceLines.push({ line: candleSeries.createPriceLine({
          price: dl.prevDayClose,
          color: 'rgba(255,213,79,0.80)',   // amber
          lineWidth: 1,
          lineStyle: Dotted,
          axisLabelVisible: true,
          title: `${proxy} PDC`,
        })});
      }
      if (dl.curDayOpen != null) {
        optionsPriceLines.push({ line: candleSeries.createPriceLine({
          price: dl.curDayOpen,
          color: 'rgba(224,224,224,0.70)',  // light grey
          lineWidth: 1,
          lineStyle: Dotted,
          axisLabelVisible: true,
          title: `${proxy} DO`,
        })});
      }
    }
  }

  // ── Monthly / Quarterly HP Lines ─────────────────────────────────────────

  function clearMonthlyHPLines() {
    for (const { line } of monthlyHPLines) {
      try { candleSeries.removePriceLine(line); } catch (_) {}
    }
    monthlyHPLines = [];
  }

  function clearQuarterlyHPLines() {
    for (const { line } of quarterlyHPLines) {
      try { candleSeries.removePriceLine(line); } catch (_) {}
    }
    quarterlyHPLines = [];
  }

  function _drawMonthlyHP(data) {
    if (!data?.weeklyMonthlyHP?.zones) return;
    const Solid = LightweightCharts.LineStyle.Solid;
    // Show top 2 monthly HP zones
    data.weeklyMonthlyHP.zones.slice(0, 2).forEach((z) => {
      const price = z.scaled ?? z.strike;
      if (price == null) return;
      const color = z.pressure === 'support'
        ? '#00e676'    // bright green — monthly support
        : '#ff5252';   // bright red   — monthly resistance
      monthlyHPLines.push({ line: candleSeries.createPriceLine({
        price,
        color,
        lineWidth: 2,
        lineStyle: Solid,
        axisLabelVisible: true,
        title: `HP M ${z.pressure === 'support' ? '▲' : '▼'}`,
      })});
    });
  }

  function _drawQuarterlyHP(data) {
    if (!data?.quarterlyHP?.zones) return;
    const Solid = LightweightCharts.LineStyle.Solid;
    // Show top 1 quarterly HP zone only (single most significant level)
    const z = data.quarterlyHP.zones[0];
    if (!z) return;
    const price = z.scaled ?? z.strike;
    if (price == null) return;
    const color = z.pressure === 'support'
      ? '#69ff8c'    // brightest green — quarterly support
      : '#ff8a80';   // brightest red   — quarterly resistance
    quarterlyHPLines.push({ line: candleSeries.createPriceLine({
      price,
      color,
      lineWidth: 3,
      lineStyle: Solid,
      axisLabelVisible: true,
      title: `HP Q ${z.pressure === 'support' ? '▲' : '▼'}`,
    })});
  }

  // ── Gamma Levels ───────────────────────────────────────────────────────────

  function clearGammaLines() {
    for (const l of gammaLines) {
      try { candleSeries.removePriceLine(l); } catch (_) {}
    }
    gammaLines = [];
  }

  function _drawGammaLevels(data) {
    if (!data) return;
    const Dashed = LightweightCharts.LineStyle.Dashed;
    const Dotted = LightweightCharts.LineStyle.Dotted;
    // Use scaled (futures-space) levels when available, fall back to ETF-space
    const s = data.scaled || {};

    const flip     = s.flipLevel ?? data.flipLevel;
    const callWall = s.callWall  ?? data.callWall;
    const putWall  = s.putWall   ?? data.putWall;

    if (flip != null) {
      gammaLines.push(candleSeries.createPriceLine({
        price: flip,
        color: 'rgba(0,229,255,0.85)',   // bright cyan
        lineWidth: 2,
        lineStyle: Dashed,
        axisLabelVisible: true,
        title: 'γ Flip',
      }));
    }
    if (callWall != null) {
      gammaLines.push(candleSeries.createPriceLine({
        price: callWall,
        color: 'rgba(38,166,154,0.70)',  // teal
        lineWidth: 1,
        lineStyle: Dotted,
        axisLabelVisible: true,
        title: 'Call Wall',
      }));
    }
    if (putWall != null) {
      gammaLines.push(candleSeries.createPriceLine({
        price: putWall,
        color: 'rgba(239,83,80,0.70)',   // red
        lineWidth: 1,
        lineStyle: Dotted,
        axisLabelVisible: true,
        title: 'Put Wall',
      }));
    }
  }

  // ── Opening Range ───────────────────────────────────────────────────────────

  function clearORLines() {
    for (const { line } of orPriceLines) {
      try { candleSeries.removePriceLine(line); } catch (_) {}
    }
    orPriceLines = [];
  }

  function _drawOpeningRange(or_) {
    const add = (price, style, title) => {
      if (price == null) return;
      orPriceLines.push({ line: candleSeries.createPriceLine({
        price, color: '#ff9800', lineWidth: 1, lineStyle: style,
        axisLabelVisible: true, title,
      })});
    };
    const Solid  = LightweightCharts.LineStyle.Solid;
    const Dashed = LightweightCharts.LineStyle.Dashed;
    add(or_.high, Solid,  'OR Hi');
    add(or_.low,  Solid,  'OR Lo');
    add(or_.mid,  Dashed, 'OR Mid');
  }

  // ── Session Levels ──────────────────────────────────────────────────────────

  function clearSessionLines() {
    for (const { line } of sessionPriceLines) {
      try { candleSeries.removePriceLine(line); } catch (_) {}
    }
    sessionPriceLines = [];
  }

  function _drawSessionLevels(sl) {
    const add = (price, color, title) => {
      if (price == null) return;
      sessionPriceLines.push({ line: candleSeries.createPriceLine({
        price, color, lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title,
      })});
    };
    if (sl.asian) {
      add(sl.asian.high, 'rgba(255,193,7,0.80)',   'Asia Hi');
      add(sl.asian.low,  'rgba(255,193,7,0.80)',   'Asia Lo');
    }
    if (sl.london) {
      add(sl.london.high, 'rgba(156,39,176,0.80)', 'Lon Hi');
      add(sl.london.low,  'rgba(156,39,176,0.80)', 'Lon Lo');
    }
  }

  // ── DD Band / CME SPAN Levels ──────────────────────────────────────────────

  function clearDDBandLines() {
    for (const line of ddBandLines) {
      try { candleSeries.removePriceLine(line); } catch (_) {}
    }
    ddBandLines = [];
  }

  function _drawDDBands(dd) {
    if (!dd || !candleSeries) return;
    const Solid  = LightweightCharts.LineStyle.Solid;
    const Dashed = LightweightCharts.LineStyle.Dashed;

    const levels = [
      { price: dd.ddBandUpper, color: 'rgba(249,115,22,0.85)', title: 'DD↑',    style: Solid,  width: 1 },
      { price: dd.ddBandLower, color: 'rgba(249,115,22,0.85)', title: 'DD↓',    style: Solid,  width: 1 },
      { price: dd.spanUpper,   color: 'rgba(249,115,22,0.45)', title: 'SPAN↑',  style: Dashed, width: 1 },
      { price: dd.spanLower,   color: 'rgba(249,115,22,0.45)', title: 'SPAN↓',  style: Dashed, width: 1 },
      { price: dd.priorClose,  color: 'rgba(148,163,184,0.40)', title: 'pClose', style: LightweightCharts.LineStyle.Dotted, width: 1 },
    ];

    for (const { price, color, title, style, width } of levels) {
      if (price == null) continue;
      ddBandLines.push(candleSeries.createPriceLine({
        price, color, lineWidth: width, lineStyle: style,
        axisLabelVisible: true, title,
      }));
    }
  }

  // ── PDH / PDL ──────────────────────────────────────────────────────────────

  function clearPricelines() {
    if (pdhLine) { candleSeries.removePriceLine(pdhLine); pdhLine = null; }
    if (pdlLine) { candleSeries.removePriceLine(pdlLine); pdlLine = null; }
  }

  function drawPricelines() {
    if (currentPDH != null) {
      pdhLine = candleSeries.createPriceLine({
        price: currentPDH, color: '#607d8b', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'PDH',
      });
    }
    if (currentPDL != null) {
      pdlLine = candleSeries.createPriceLine({
        price: currentPDL, color: '#607d8b', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'PDL',
      });
    }
  }

  // ── Markers ────────────────────────────────────────────────────────────────

  function updateMarkers() {
    const markers = [
      ...(vis.swingHighLow ? swingHighMarkers : []),
      ...(vis.swingHighLow ? swingLowMarkers  : []),
      ...(vis.trendlines   ? trendlineMarkers : []),
      ...alertMarkers,                              // alert setup arrows (always visible)
      ...(setupEntryMkr    ? [setupEntryMkr]  : []),
    ].sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(markers);
  }

  // ── Setup overlay (click-to-chart) ─────────────────────────────────────────

  function _clearSetupOverlay() {
    if (setupSlLine)   { candleSeries.removePriceLine(setupSlLine);  setupSlLine  = null; }
    if (setupTpLine)   { candleSeries.removePriceLine(setupTpLine);  setupTpLine  = null; }
    if (setupEntryMkr) { setupEntryMkr = null; updateMarkers(); }
  }

  function _drawSetupOverlay(setup) {
    _clearSetupOverlay();
    if (setup.sl != null) {
      setupSlLine = candleSeries.createPriceLine({
        price: setup.sl, color: '#ef5350', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'SL',
      });
    }
    if (setup.tp != null) {
      setupTpLine = candleSeries.createPriceLine({
        price: setup.tp, color: '#26a69a', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'TP',
      });
    }
    // Entry marker — yellow arrow; the only arrow signal on the chart
    setupEntryMkr = {
      time:     setup.time,
      position: setup.direction === 'bullish' ? 'belowBar' : 'aboveBar',
      color:    '#ffeb3b',
      shape:    setup.direction === 'bullish' ? 'arrowUp' : 'arrowDown',
      text:     'Entry',
      size:     2,
    };
    updateMarkers();
    try {
      chart.timeScale().setVisibleRange({
        from: setup.time - 7200,
        to:   setup.time + 7200,
      });
    } catch (_) {}
  }

  // ── Layer visibility ────────────────────────────────────────────────────────

  function _applyVis(key, visible) {
    switch (key) {
      case 'ema9':
      case 'ema21':
      case 'ema50':
      case 'vwap':
        lineSeries[key]?.applyOptions({ visible });
        break;

      case 'trendlines':
        for (const s of Object.values(trendLineSeries)) {
          s.applyOptions({ visible });
        }
        updateMarkers(); // show/hide TF endpoint label markers
        break;

      case 'priorDayHighLow':
        clearPricelines();
        if (visible) drawPricelines();
        break;

      case 'swingHighLow':
        updateMarkers();
        break;

      case 'iofZones':
        clearIOFZones();
        if (visible) _drawIOFZones(lastFVGs, lastOBs);
        break;

      case 'volumeProfile':
        clearVPLines();
        if (visible && lastVolumeProfile) _drawVolumeProfile(lastVolumeProfile);
        break;

      case 'openingRange':
        clearORLines();
        if (visible && lastOpeningRange?.formed) _drawOpeningRange(lastOpeningRange);
        break;

      case 'sessionLevels':
        clearSessionLines();
        if (visible && lastSessionLevels) _drawSessionLevels(lastSessionLevels);
        break;

      case 'cvd': {
        const el = document.getElementById('cvd-container');
        if (!el) break;
        if (visible) {
          el.classList.add('cvd-visible');
          if (cvdChart) cvdChart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
          _drawCVD();
        } else {
          el.classList.remove('cvd-visible');
          clearCVD();
        }
        // Trigger main chart to recalculate its flex height
        chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
        break;
      }

      case 'optionsLevels':
        clearOptionsLines();
        clearGammaLines();
        if (visible && lastOptionsLevels) _drawOptionsLevels(lastOptionsLevels);
        if (visible && lastGammaData)     _drawGammaLevels(lastGammaData);
        break;

      case 'hpMonthly':
        clearMonthlyHPLines();
        if (visible && lastOptionsLevels) _drawMonthlyHP(lastOptionsLevels);
        break;

      case 'hpQuarterly':
        clearQuarterlyHPLines();
        if (visible && lastOptionsLevels) _drawQuarterlyHP(lastOptionsLevels);
        break;

      case 'ddBands':
        clearDDBandLines();
        if (visible && lastDDBands) _drawDDBands(lastDDBands);
        break;
    }
  }

  // ── Public API (consumed by layers.js + alerts.js) ─────────────────────────
  window.ChartAPI = {
    setLayerVisible(key, visible) {
      vis[key] = visible;
      _applyVis(key, visible);
    },

    highlightSetup(alert) {
      const { symbol, timeframe, setup } = alert;
      if (symbol !== activeSymbol || timeframe !== activeTf) {
        activeSymbol   = symbol;
        activeTf       = timeframe;
        pendingOverlay = setup;
        setActive('.sym-btn', 'symbol', activeSymbol);
        setActive('.tf-btn',  'tf',     activeTf);
        loadData(activeSymbol, activeTf).catch(err => console.error('[chart]', err.message));
      } else {
        _drawSetupOverlay(setup);
      }
    },

    // Reload chart data for the active symbol + timeframe.
    // Called by alerts.js when a data_refresh WebSocket message is received.
    reload() {
      loadData(activeSymbol, activeTf)
        .catch(err => console.error('[chart] reload:', err.message));
    },

    // Push a live price tick onto the chart as an in-progress bar for the current 1m window.
    // Works for both Coinbase crypto ticks and Databento 1s futures bars.
    updateLivePrice(symbol, price, time) {
      if (symbol !== activeSymbol || !candleSeries || !lastCandle) return;

      // Client-side spike filter: reject ticks that deviate beyond per-symbol threshold
      // from the last known close. The server also filters via rolling median, but this
      // is a second safety net for the chart.
      const _CLIENT_SPIKE = { MNQ:0.015, MES:0.015, M2K:0.015, MYM:0.015, MGC:0.012, SIL:0.015, MHG:0.012, MCL:0.020 };
      const spikeThresh = _CLIENT_SPIKE[symbol] || 0.015;
      const refPrice = _liveTickBar ? _liveTickBar.close : lastCandle.close;
      if (refPrice > 0 && Math.abs(price - refPrice) / refPrice > spikeThresh) {
        console.warn(`[chart] spike filtered: ${price.toFixed(2)} vs ref ${refPrice.toFixed(2)}`);
        return;
      }

      // Align tick to the 1m bar window it belongs to.
      // activeTf granularity: on 1m chart use 60s, on 5m use 300s, etc.
      const TF_SECONDS = { '1m':60, '2m':120, '3m':180, '5m':300, '15m':900, '30m':1800, '1h':3600, '2h':7200, '4h':14400 };
      const tfSecs  = TF_SECONDS[activeTf] ?? 60;
      const barTime = time ? Math.floor(time / tfSecs) * tfSecs : lastCandle.time;

      // Only build an in-progress bar when the tick is newer than the last completed bar.
      // If barTime === lastCandle.time the bar hasn't closed yet — update it in place.
      // If barTime > lastCandle.time a new window has opened — start a fresh bar.
      if (barTime < lastCandle.time) return;  // stale tick, ignore

      if (!_liveTickBar || _liveTickBar.time !== barTime) {
        // New window: open at the close of the last completed bar (gap-free)
        _liveTickBar = {
          time:  barTime,
          open:  barTime === lastCandle.time ? lastCandle.open : lastCandle.close,
          high:  Math.max(barTime === lastCandle.time ? lastCandle.high : lastCandle.close, price),
          low:   Math.min(barTime === lastCandle.time ? lastCandle.low  : lastCandle.close, price),
          close: price,
        };
      } else {
        _liveTickBar.high  = Math.max(_liveTickBar.high,  price);
        _liveTickBar.low   = Math.min(_liveTickBar.low,   price);
        _liveTickBar.close = price;
      }

      candleSeries.update(_liveTickBar);
      // Update price display
      priceValue.textContent = price.toFixed(price < 10 ? 4 : price < 1000 ? 2 : 0);
    },

        // Replace the in-progress tick bar with a completed bar from the live feed.
    // Called when a live_candle WS message arrives (1m bar close from Databento).
    updateLiveCandle(symbol, timeframe, candle) {
      if (symbol !== activeSymbol || timeframe !== activeTf || !candleSeries) return;
      candleSeries.update(candle);
      lastCandle   = candle;
      _liveTickBar = null;  // completed bar supersedes the in-progress tick bar
    },

    // Set options levels from /api/options — called by alerts.js after each symbol change.
    setOptionsLevels(data) {
      lastOptionsLevels = data;
      clearOptionsLines();
      clearMonthlyHPLines();
      clearQuarterlyHPLines();
      if (vis.optionsLevels && data) _drawOptionsLevels(data);
      if (vis.hpMonthly    && data) _drawMonthlyHP(data);
      if (vis.hpQuarterly  && data) _drawQuarterlyHP(data);
    },

    // Set DD Band / SPAN levels — called by alerts.js after /api/ddbands fetch.
    setDDBands(data) {
      lastDDBands = data;
      clearDDBandLines();
      if (vis.ddBands && data) _drawDDBands(data);
    },

    // Set gamma levels (flip, call wall, put wall) — called by alerts.js after gamma fetch.
    setGammaLevels(data) {
      lastGammaData = data;
      clearGammaLines();
      if (vis.optionsLevels && data) _drawGammaLevels(data);
    },

    // Plot colored alert arrows on the chart for the current symbol + TF.
    // Called by alerts.js after every fetch. Colors: blue=open, teal=won, red=lost, gold=taken.
    setAlertMarkers(alerts, symbol, tf) {
      const relevant = alerts.filter(
        a => a.symbol === symbol && a.timeframe === tf && !a.suppressed
      );
      alertMarkersData = relevant;
      alertMarkers = relevant.map(a => {
        const isBull   = a.setup.direction === 'bullish';
        const takenKey = `${a.symbol}:${a.timeframe}:${a.setup.type}:${a.setup.time}`;
        const isTaken  = typeof window._isTaken === 'function' && window._isTaken(takenKey);
        const color = isTaken                      ? '#ffb300'
                    : a.setup.outcome === 'won'    ? '#26a69a'
                    : a.setup.outcome === 'lost'   ? '#ef5350'
                    :                                '#2196f3';
        const label = a.setup.type === 'zone_rejection'  ? 'ZR'
                    : a.setup.type === 'trendline_break' ? 'TL'
                    : a.setup.type === 'or_breakout'     ? 'OR'
                    : 'PDH';
        // Snap to the nearest bar time so TradingView can render the marker correctly.
        const snappedTime = _snapToCandle(a.setup.time);
        return {
          time:     snappedTime,
          position: isBull ? 'belowBar' : 'aboveBar',
          color,
          shape:    isBull ? 'arrowUp' : 'arrowDown',
          text:     label,
          size:     1,
        };
      });
      updateMarkers();
    },
  };

  // ── Price precision (XRP trades at 4 decimal places) ──────────────────────
  function _priceDec(sym) { return sym === 'XRP' ? 4 : 2; }

  // ── OHLC display ───────────────────────────────────────────────────────────
  function fmt(n) { return n == null ? '—' : n.toFixed(_priceDec(activeSymbol)); }

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

  // Dashboard mode switch (Futures ↔ Crypto) — load default symbol for new mode
  document.addEventListener('dashModeChange', (e) => {
    activeSymbol = e.detail.symbol;
    setActive('.sym-btn', 'symbol', activeSymbol);
    loadData(activeSymbol, activeTf).catch(err => console.error('[chart] dashModeChange:', err.message));
  });

  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTf = btn.dataset.tf;
      setActive('.tf-btn', 'tf', activeTf);
      loadData(activeSymbol, activeTf).catch(err => console.error('[chart]', err.message));
    });
  });

  // Manual chart refresh button
  const refreshBtn = document.getElementById('chart-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.classList.add('spinning');
      _gapRetryCount = 0;      // reset retry counter so gap retry will try again fresh
      _gapRefetchPending = false;
      _showGapIndicator('\u27F3 Refreshing data...');
      const snapSymbol = activeSymbol;
      const snapTf     = activeTf;
      try {
        const res = await fetch(`/api/candles?symbol=${snapSymbol}&timeframe=${snapTf}&refresh=true`);
        // Discard result if user switched symbol during the fetch
        if (snapSymbol !== activeSymbol || snapTf !== activeTf) {
          console.log('[chart] Manual refresh result discarded — symbol changed during fetch');
          refreshBtn.classList.remove('spinning');
          return;
        }
        if (res.ok) {
          const { candles: freshCandles } = await res.json();
          if (freshCandles && freshCandles.length >= 2) {
            candleSeries.setData(freshCandles);
            rawCandles = freshCandles;
            lastCandle = freshCandles[freshCandles.length - 1];
            _liveTickBar = null;
            activeCandleTimes = freshCandles.map(c => c.time);
            console.log(`[chart] Manual refresh: ${freshCandles.length} candles`);
          }
        }
      } catch (err) {
        console.warn('[chart] Manual refresh failed:', err.message);
      }
      _hideGapIndicator();
      refreshBtn.classList.remove('spinning');
    });
  }

  // chartLoadSymbol — allows chartManager.js to switch to any symbol/TF directly
  // without needing to simulate button clicks or deal with mode toggle state.
  document.addEventListener('chartLoadSymbol', (e) => {
    activeSymbol = e.detail.symbol;
    if (e.detail.tf) activeTf = e.detail.tf;
    setActive('.sym-btn', 'symbol', activeSymbol);
    setActive('.tf-btn',  'tf',     activeTf);
    loadData(activeSymbol, activeTf).catch(err => console.error('[chart] chartLoadSymbol:', err.message));
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  initChart();
  loadData(activeSymbol, activeTf).catch(err => {
    console.error('[chart] Initial load failed:', err.message);
  });

})();
