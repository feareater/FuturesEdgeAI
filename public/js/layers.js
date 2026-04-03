'use strict';
// Layer toggle panel — reads initial state from localStorage, writes changes
// back, and calls window.ChartAPI.setLayerVisible() on every toggle.
// Runs after chart.js, so window.ChartAPI is guaranteed to exist.

(function () {

  const STORAGE_KEY = 'futuresedge_layers';

  const DEFAULTS = {
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
    ddBands:            true,
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

  // Sync layer checkboxes to persisted state and wire up change handlers
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


  // ── Collapsible panel sections ───────────────────────────────────────────
  const COLLAPSED_KEY = 'futuresedge_sections_collapsed';

  function _loadCollapsed() {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch { return new Set(); }
  }
  function _saveCollapsed(set) {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  }

  const collapsedSections = _loadCollapsed();

  document.querySelectorAll('.collapsible-header').forEach(header => {
    const section = header.dataset.section;
    if (!section) return;
    const body = header.nextElementSibling; // .section-body

    // Apply persisted collapsed state
    if (collapsedSections.has(section)) {
      header.classList.add('collapsed');
      if (body) body.style.display = 'none';
    }

    header.addEventListener('click', () => {
      const isCollapsed = collapsedSections.has(section);
      if (isCollapsed) {
        collapsedSections.delete(section);
        header.classList.remove('collapsed');
        if (body) body.style.display = '';
      } else {
        collapsedSections.add(section);
        header.classList.add('collapsed');
        if (body) body.style.display = 'none';
      }
      _saveCollapsed(collapsedSections);
    });
  });

})();
