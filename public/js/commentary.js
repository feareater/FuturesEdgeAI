'use strict';
// Commentary page — fetches /api/commentary and renders AI-generated setup analysis.
// Auto-refreshes via WebSocket when the server broadcasts a new commentary event.

(function () {

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const grid      = document.getElementById('commentary-grid');
  const metaGen   = document.getElementById('meta-generated');
  const metaCount = document.getElementById('meta-count');
  const statusEl  = document.getElementById('commentary-status');
  const refreshBtn = document.getElementById('refresh-btn');

  // ── Fetch + render ─────────────────────────────────────────────────────────

  async function load() {
    statusEl.textContent = 'Loading…';
    statusEl.className = 'commentary-status loading';
    try {
      const res = await fetch('/api/commentary');
      if (!res.ok) throw new Error(`/api/commentary ${res.status}`);
      const data = await res.json();
      render(data);
    } catch (err) {
      console.error('[commentary] Fetch failed:', err.message);
      grid.innerHTML = '<p class="commentary-error">Could not load analysis. Check server.</p>';
      statusEl.textContent = 'Error';
      statusEl.className = 'commentary-status error';
    }
  }

  function render(data) {
    grid.innerHTML = '';

    if (!data.generated || !data.items || data.items.length === 0) {
      grid.innerHTML = '<div class="commentary-placeholder"><p>No analysis yet — the server generates commentary after each scan. Try Refresh.</p></div>';
      metaGen.textContent = 'Not yet generated';
      metaCount.textContent = '';
      statusEl.textContent = 'No data';
      statusEl.className = 'commentary-status idle';
      return;
    }

    const genTime = new Date(data.generated).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'America/Denver',
    });
    metaGen.textContent = `Generated ${genTime} MT`;
    metaCount.textContent = `${data.items.length} setup${data.items.length !== 1 ? 's' : ''}`;
    statusEl.textContent = 'Live';
    statusEl.className = 'commentary-status live';

    data.items.forEach(item => grid.appendChild(_buildCard(item)));
  }

  // ── Card builder ───────────────────────────────────────────────────────────

  function _buildCard(item) {
    const alert = item.alert;
    const setup = alert?.setup;
    if (!setup) {
      const el = document.createElement('div');
      el.className = 'commentary-card';
      el.innerHTML = `<p class="commentary-text">${_escHtml(item.commentary || '—')}</p>`;
      return el;
    }

    const dir      = setup.direction;
    const dirClass = dir === 'bullish' ? 'bull' : 'bear';
    const dirArrow = dir === 'bullish' ? '▲' : '▼';
    const fmtP     = n => (n != null ? n.toFixed(2) : '—');
    const entry    = setup.entry != null ? setup.entry : setup.price;

    const typeLabel = {
      zone_rejection: 'Zone Rejection',
      pdh_breakout:   'PDH Breakout',
      bos:            'BOS',
      choch:          'CHoCH',
    }[setup.type] || setup.type;

    const time = new Date(setup.time * 1000).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'America/Denver',
    });

    const regime   = alert.regime || {};
    const bqBadge  = (setup.scoreBreakdown?.bos || 0) > 0
      ? '<span class="badge bq">BOS Qualified</span>' : '';
    const alignBadge = regime.alignment
      ? '<span class="badge aligned">TF Aligned</span>' : '';

    const confClass = setup.confidence >= 80 ? 'conf-high'
                    : setup.confidence >= 60 ? 'conf-mid' : 'conf-low';

    const outcomeLabel = { won: '✓ WON', lost: '✗ LOST', open: '○ Open' }[setup.outcome] || '—';
    const outcomeClass = setup.outcome || 'open';

    const card = document.createElement('div');
    card.className = `commentary-card ${dirClass}`;

    card.innerHTML = `
      <div class="cc-header">
        <span class="cc-sym">${item.symbol}</span>
        <span class="cc-tf">${item.timeframe}</span>
        <span class="cc-type">${typeLabel}</span>
        <span class="cc-dir ${dirClass}">${dirArrow}</span>
        <span class="cc-conf ${confClass}">${setup.confidence}%</span>
        ${bqBadge}${alignBadge}
        <span class="cc-outcome ${outcomeClass}">${outcomeLabel}</span>
        <span class="cc-time">${time} MT</span>
      </div>
      <div class="cc-levels">
        <span class="cc-level-label">Entry</span><span class="cc-level-val">${fmtP(entry)}</span>
        <span class="cc-level-label sl">SL</span><span class="cc-level-val sl">${fmtP(setup.sl)}</span>
        <span class="cc-level-label tp">TP</span><span class="cc-level-val tp">${fmtP(setup.tp)}</span>
        <span class="cc-level-label">Regime</span><span class="cc-level-val regime">${regime.direction || '—'} ${regime.type || ''}</span>
      </div>
      <div class="cc-rationale">${_escHtml(setup.rationale)}</div>
      <div class="cc-divider"></div>
      <div class="cc-ai-label">AI Analysis</div>
      <div class="cc-commentary">${_fmtCommentary(item.commentary)}</div>
    `;

    return card;
  }

  // Convert each sentence to its own paragraph for readability
  function _fmtCommentary(text) {
    if (!text) return '<em>No commentary available.</em>';
    return text
      .split(/(?<=[.!?])\s+/)
      .filter(s => s.trim())
      .map(s => `<p>${_escHtml(s)}</p>`)
      .join('');
  }

  function _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Refresh button ─────────────────────────────────────────────────────────

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '↻ Scanning…';
    statusEl.textContent = 'Scanning…';
    statusEl.className = 'commentary-status loading';
    try {
      // Trigger a full server rescan which will regenerate commentary
      const res = await fetch('/api/scan');
      if (!res.ok) throw new Error(`/api/scan ${res.status}`);
      // Commentary arrives via WebSocket; also poll immediately
      setTimeout(load, 2000);
    } catch (err) {
      console.error('[commentary] Refresh failed:', err.message);
      statusEl.textContent = 'Error';
      statusEl.className = 'commentary-status error';
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ Refresh';
    }
  });

  // ── WebSocket — auto-update when server generates new commentary ───────────

  function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);
    ws.onopen  = () => console.log('[ws] Connected');
    ws.onclose = () => setTimeout(connectWS, 3000);
    ws.onerror = err => console.error('[ws] Error:', err);
    ws.onmessage = event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'commentary') {
          console.log('[commentary] New commentary broadcast received — reloading');
          load();
        }
      } catch (_) {}
    };
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  load();
  connectWS();

})();
