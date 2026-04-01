'use strict';
// Layer toggle panel — reads initial state from localStorage, writes changes
// back, and calls window.ChartAPI.setLayerVisible() on every toggle.
// Runs after chart.js, so window.ChartAPI is guaranteed to exist.

(function () {

  const STORAGE_KEY   = 'futuresedge_layers';
  const FEATURES_KEY  = 'futuresedge_features';

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

  // ── Feature toggles ─────────────────────────────────────────────────────────
  // Fetches the server feature flags, builds the feature toggle UI, and wires
  // POST /api/features for hot-toggle without restarting the server.

  let serverFeatures = {};

  async function loadFeatures() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const { features } = await res.json();
      serverFeatures = features || {};

      // Merge cached local overrides (in case settings.json was updated without reload)
      try {
        const cached = JSON.parse(localStorage.getItem(FEATURES_KEY) || '{}');
        serverFeatures = { ...serverFeatures, ...cached };
      } catch {}

      _renderFeatureToggles(serverFeatures);
    } catch (err) {
      console.warn('[layers] Could not load features:', err.message);
    }
  }

  function _renderFeatureToggles(features) {
    const container = document.getElementById('feature-list');
    if (!container) return;
    container.innerHTML = '';

    const labels = {
      volumeProfile:      'Volume Profile (POC/VAH/VAL)',
      openingRange:       'Opening Range (OR Hi/Lo)',
      sessionLevels:      'Session Levels (Asia/London)',
      economicCalendar:   'Economic Calendar',
      relativeStrength:   'Relative Strength (MNQ/MES)',
      alertReplay:        'Alert Replay / Backtest',
      soundAlerts:        'Sound Alerts',
      pushNotifications:  'Push Notifications',
      performanceStats:   'Performance Analytics',
    };

    for (const [key, label] of Object.entries(labels)) {
      if (!(key in features)) continue;
      const row = document.createElement('label');
      row.className = 'layer-row feature-row';

      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.dataset.feature = key;
      cb.checked = !!features[key];

      const span = document.createElement('span');
      span.className   = 'layer-name';
      span.textContent = label;

      row.appendChild(cb);
      row.appendChild(span);
      container.appendChild(row);

      cb.addEventListener('change', () => {
        features[key] = cb.checked;
        // Persist locally in case the API call fails
        try { localStorage.setItem(FEATURES_KEY, JSON.stringify(features)); } catch {}
        // Hot-toggle on server
        fetch('/api/features', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: cb.checked }),
        }).catch(err => console.warn('[features] Toggle failed:', err.message));

        // Visual-only toggles handled client-side immediately
        if (key === 'volumeProfile' ||
            key === 'openingRange' || key === 'sessionLevels') {
          window.ChartAPI.setLayerVisible(key, cb.checked);
        }
        if (key === 'soundAlerts') {
          window._soundAlertsEnabled = cb.checked;
        }
      });
    }
  }

  loadFeatures();

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
