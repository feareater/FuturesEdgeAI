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

    window.addEventListener('resize', () => {
      chart.applyOptions({
        width:  chartContainer.clientWidth,
        height: chartContainer.clientHeight,
      });
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

  // ── Data loading ───────────────────────────────────────────────────────────
  async function loadData(symbol, tf) {
    console.log(`[chart] Loading ${symbol} ${tf}`);

    // Clear alert markers before loading new data — prevents stale markers from a
    // different symbol/TF being passed to TradingView (which errors on unknown bar times).
    // alerts.js will re-populate via setAlertMarkers() after chartViewChange fires.
    alertMarkers     = [];
    alertMarkersData = [];

    const [candleRes, indRes, tlRes] = await Promise.all([
      fetch(`/api/candles?symbol=${symbol}&timeframe=${tf}`),
      fetch(`/api/indicators?symbol=${symbol}&timeframe=${tf}`),
      fetch(`/api/trendlines?symbol=${symbol}`),
    ]);

    if (!candleRes.ok) throw new Error(`/api/candles ${candleRes.status}`);
    if (!indRes.ok)    throw new Error(`/api/indicators ${indRes.status}`);

    const { candles } = await candleRes.json();
    const indicators  = await indRes.json();
    const tlData      = tlRes.ok ? await tlRes.json() : {};

    if (!candles.length) throw new Error('No candles returned');

    candleSeries.setData(candles);
    chart.timeScale().scrollToRealTime();
    lastCandle = candles[candles.length - 1];

    // Store sorted candle times for trendline timestamp snapping
    activeCandleTimes = candles.map(c => c.time);

    resetOHLC();
    renderIndicators(indicators, tlData.trendlines || {});

    if (pendingOverlay) { _drawSetupOverlay(pendingOverlay); pendingOverlay = null; }

    console.log(`[chart] Rendered ${candles.length} candles  ATR:${indicators.atrCurrent?.toFixed(2)}`);
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
    for (const fvg of fvgs) {
      const isB = fvg.type === 'bullish';
      const col = isB ? 'rgba(0,230,118,0.55)' : 'rgba(239,83,80,0.55)';
      const lbl = isB ? 'FVG↑' : 'FVG↓';

      iofPriceLines.push({ line: candleSeries.createPriceLine({
        price: fvg.top, color: col, lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: lbl,
      })});
      iofPriceLines.push({ line: candleSeries.createPriceLine({
        price: fvg.bottom, color: col, lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: false, title: '',
      })});
    }

    // ── Order Blocks ─────────────────────────────────────────────────────────
    for (const ob of obs) {
      const isB   = ob.type === 'bullish';
      const col   = isB ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)';
      const style = ob.status === 'untested'
        ? LightweightCharts.LineStyle.Solid
        : LightweightCharts.LineStyle.Dashed;
      const lbl = isB ? 'OB↑' : 'OB↓';

      iofPriceLines.push({ line: candleSeries.createPriceLine({
        price: ob.top, color: col, lineWidth: 1, lineStyle: style,
        axisLabelVisible: true, title: lbl,
      })});
      iofPriceLines.push({ line: candleSeries.createPriceLine({
        price: ob.bottom, color: col, lineWidth: 1, lineStyle: style,
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

      case 'correlationHeatmap': {
        const panel = document.getElementById('corr-heatmap-section');
        if (panel) panel.style.display = visible ? '' : 'none';
        break;
      }
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
