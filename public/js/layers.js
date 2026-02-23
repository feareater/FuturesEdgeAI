'use strict';
// Layer toggle panel — reads initial state from localStorage, writes changes
// back, and calls window.ChartAPI.setLayerVisible() on every toggle.
// Runs after chart.js, so window.ChartAPI is guaranteed to exist.

(function () {

  const STORAGE_KEY = 'futuresedge_layers';

  const DEFAULTS = {
    ema9:            true,
    ema21:           true,
    ema50:           true,
    vwap:            true,
    priorDayHighLow: true,
    swingHighLow:    true,
  };

  function load() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  const state = load();

  // Sync checkboxes to persisted state and wire up change handlers
  document.querySelectorAll('[data-layer]').forEach(checkbox => {
    const key = checkbox.dataset.layer;
    if (!(key in DEFAULTS)) return;

    checkbox.checked = state[key] ?? true;

    checkbox.addEventListener('change', () => {
      state[key] = checkbox.checked;
      save(state);
      window.ChartAPI.setLayerVisible(key, checkbox.checked);
    });
  });

  // Apply any non-default initial state to the chart.
  // chart.js defaults all layers to visible, so we only need to hide.
  for (const [key, visible] of Object.entries(state)) {
    if (!visible) window.ChartAPI.setLayerVisible(key, false);
  }

})();
