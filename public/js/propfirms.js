'use strict';
// Prop Firm Tracker — client-side logic

let _data = { accounts: [], expenses: [], payouts: [] };

// ── Utility ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const fmt = n => n == null ? '—' : '$' + (+n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = s => { if (!s) return '—'; const d = new Date(s + 'T12:00:00'); return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }); };
const fmtSize = n => { if (!n) return '—'; if (n >= 1000) return '$' + (n/1000).toFixed(0) + 'K'; return '$' + n; };

async function _api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  return r.json();
}

// ── Load & render ────────────────────────────────────────────────────────────

async function load() {
  _data = await _api('GET', '/api/propfirms');
  renderSummary();
  renderAccounts();
  renderExpenses();
  renderPayouts();
  renderAnalysis();
  populateFirmFilter();
}

function renderSummary() {
  const firmSpend  = _data.accounts.reduce((s, a) => s + (+a.cost || 0), 0);
  const expSpend   = _data.expenses.reduce((s, e) => s + (+e.amount || 0), 0);
  const payouts    = _data.payouts.reduce((s, p) => s + (+p.amount || 0), 0);
  const net        = firmSpend + expSpend - payouts;
  const attempts   = _data.accounts.length;
  const passed     = _data.accounts.filter(a => a.status === 'passed' || a.phase === 'funded').length;
  const active     = _data.accounts.filter(a => (!a.phase || a.phase === 'challenge') && a.status === 'active').length
                   + _data.accounts.filter(a => a.phase === 'funded' && !a.fundedFailed).length;
  const passRate   = attempts > 0 ? Math.round(passed / attempts * 100) : null;
  const avgCost    = attempts > 0 ? firmSpend / attempts : null;

  $('stat-firm-spend').textContent = fmt(firmSpend);
  $('stat-expenses').textContent   = fmt(expSpend);
  $('stat-payouts').textContent    = fmt(payouts);
  $('stat-net').textContent        = fmt(net);
  $('stat-attempts').textContent   = attempts;
  $('stat-passrate').textContent   = passRate != null ? passRate + '%' : '—';
  $('stat-active').textContent     = active;
  $('stat-avgcost').textContent    = avgCost != null ? fmt(avgCost) : '—';
}

function _statusBadge(a) {
  if (a.phase === 'funded') {
    if (a.fundedFailed) return `<span class="pf-badge pf-badge-funded-failed">Funded ✗</span>`;
    return `<span class="pf-badge pf-badge-funded">Funded</span>`;
  }
  const s   = a.status || 'active';
  const cls = s === 'passed' ? 'pf-badge-passed' : s === 'active' ? 'pf-badge-active' : 'pf-badge-failed';
  return `<span class="pf-badge ${cls}">${s}</span>`;
}

// ── Drawdown engine ──────────────────────────────────────────────────────────
// Returns { avail, floor, peak, type } or null if maxDrawdown not set.
// Three types:
//   static        — floor = accountSize - maxDD (never moves)
//   eod_trail     — floor trails highest EOD cumulative balance
//   intraday_trail— floor trails highest peak from log (uses entry.maxValue if present,
//                   otherwise falls back to that day's EOD balance)

function _computeDD(a) {
  const size  = +a.accountSize || 0;
  const maxDD = +a.maxDrawdown || 0;
  if (!maxDD) return null;

  const cv      = +a.currentValue || size;
  const entries = (a.dailyProgress || []).slice()
    .sort((x, y) => (x.date || '').localeCompare(y.date || ''));

  // ── Funded account: trail until lock threshold, then lock static at accountSize ──
  // Lock threshold = accountSize + maxDD + 100 (e.g. 50K + 2K + 100 = 52,100)
  // Once peak ever hits that threshold, floor permanently = accountSize.
  if (a.phase === 'funded') {
    const lockThreshold = size + maxDD + 100;
    let cumPnl = 0, peakBalance = size;
    for (const d of entries) {
      cumPnl += +d.pnl || 0;
      const eod      = size + cumPnl;
      const dayPeak  = (a.ddType === 'intraday_trail' && d.maxValue) ? +d.maxValue : eod;
      if (dayPeak > peakBalance) peakBalance = dayPeak;
    }
    const locked = peakBalance >= lockThreshold;
    if (locked) {
      return { avail: cv - size, floor: size, peak: peakBalance, type: 'funded_locked', locked: true };
    } else {
      const floor = peakBalance - maxDD;
      return { avail: cv - floor, floor, peak: peakBalance, lockThreshold, type: 'funded_trail', locked: false };
    }
  }

  // ── Challenge accounts ────────────────────────────────────────────────────────
  if (!a.ddType || a.ddType === 'static') {
    const floor = size - maxDD;
    return { avail: cv - floor, floor, peak: null, type: 'static' };
  }

  if (a.ddType === 'eod_trail') {
    let cumPnl = 0, peakEOD = size;
    for (const d of entries) {
      cumPnl += +d.pnl || 0;
      const eod = size + cumPnl;
      if (eod > peakEOD) peakEOD = eod;
    }
    const floor = peakEOD - maxDD;
    return { avail: cv - floor, floor, peak: peakEOD, type: 'eod_trail' };
  }

  if (a.ddType === 'intraday_trail') {
    let cumPnl = 0, peakAll = size;
    for (const d of entries) {
      cumPnl += +d.pnl || 0;
      const eod      = size + cumPnl;
      const dayPeak  = +d.maxValue || eod;   // use logged peak if available
      if (dayPeak > peakAll) peakAll = dayPeak;
    }
    const floor = peakAll - maxDD;
    return { avail: cv - floor, floor, peak: peakAll, type: 'intraday_trail' };
  }

  return null;
}

function _liveStats(a) {
  const size = +a.accountSize || 0;
  const cv   = +a.currentValue || 0;
  if (!cv) return '<span class="pf-dim">—</span>';

  const pnl    = cv - size;
  const pnlCls = pnl > 0 ? 'pf-pos' : pnl < 0 ? 'pf-neg' : '';
  const pnlStr = (pnl >= 0 ? '+' : '') + fmt(pnl);

  const dd      = _computeDD(a);
  const maxDD   = +a.maxDrawdown || 0;
  const ddAvail = dd ? dd.avail : null;
  const ddPct   = dd && maxDD > 0
    ? Math.min(100, Math.max(0, ((maxDD - dd.avail) / maxDD * 100))).toFixed(1)
    : 0;
  const ddCls   = ddAvail !== null && ddAvail < maxDD * 0.25 ? 'pf-neg'
                : ddAvail !== null && ddAvail < maxDD * 0.5  ? 'pf-warn'
                : 'pf-dim';

  const ddLabel = !dd ? ''
    : dd.type === 'funded_locked'  ? `LOCKED · floor = ${fmt(dd.floor)}`
    : dd.type === 'funded_trail'   ? `Trailing · need ${fmt(dd.lockThreshold)} to lock`
    : dd.type === 'eod_trail'      ? `EOD · peak ${fmt(dd.peak)}`
    : dd.type === 'intraday_trail' ? `Intraday · peak ${fmt(dd.peak)}`
    : 'Static';

  return `
    <div class="pf-live-val">${fmt(cv)}</div>
    <div class="pf-live-pnl ${pnlCls}">${pnlStr}</div>
    ${ddAvail !== null ? `
      <div class="pf-live-dd ${ddCls}">DD avail: ${fmt(ddAvail)}</div>
      ${dd.peak ? `<div class="pf-live-dd-label">${ddLabel}</div>` : ''}
      <div class="pf-dd-bar-wrap"><div class="pf-dd-bar" style="width:${ddPct}%"></div></div>
    ` : ''}
  `;
}

function _phaseLogTable(entries, startingSize, showPeak) {
  if (!entries.length) return '<div class="pf-empty" style="padding:10px 0">No entries logged for this phase.</div>';
  const chron  = entries.slice().sort((x, y) => (x.date || '').localeCompare(y.date || ''));
  const balMap = {};
  let cum = +startingSize || 0;
  for (const d of chron) { cum += +d.pnl || 0; balMap[d.id] = cum; }
  const display = entries.slice().sort((x, y) => (y.date || '').localeCompare(x.date || ''));
  return `
    <table class="pf-day-table">
      <thead><tr><th>Date</th><th>Daily P&L</th><th>Balance</th>${showPeak ? '<th>Peak Bal</th>' : ''}<th>Notes</th></tr></thead>
      <tbody>
        ${display.map(d => `
          <tr>
            <td>${fmtDate(d.date)}</td>
            <td style="font-family:monospace" class="${+d.pnl >= 0 ? 'pf-pos' : 'pf-neg'}">${+d.pnl >= 0 ? '+' : ''}${fmt(d.pnl)}</td>
            <td style="font-family:monospace" class="pf-dim">${fmt(balMap[d.id])}</td>
            ${showPeak ? `<td style="font-family:monospace" class="pf-dim">${d.maxValue ? fmt(d.maxValue) : '—'}</td>` : ''}
            <td class="pf-notes-text">${_esc(d.notes || '')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

function _progressPanel(a) {
  const entries   = (a.dailyProgress || []).slice().sort((x, y) => (y.date || '').localeCompare(x.date || ''));
  const total     = entries.reduce((s, d) => s + (+d.pnl || 0), 0);
  const totCls    = total > 0 ? 'pf-pos' : total < 0 ? 'pf-neg' : '';
  const showPeak  = a.ddType === 'intraday_trail';
  const dd        = _computeDD(a);
  const isFunded  = a.phase === 'funded';
  const history   = (a.phaseHistory || []);
  const curPhaseNum = history.length + 1;

  // Payouts linked to this account
  const acctPayouts = (_data.payouts || []).filter(p => p.accountId === a.id)
    .sort((x, y) => (y.date || '').localeCompare(x.date || ''));
  const totalReceived = acctPayouts.reduce((s, p) => s + (+p.amount || 0), 0);
  const totalGross    = acctPayouts.reduce((s, p) => s + (+p.grossAmount || +p.amount || 0), 0);

  const ddDetail = !dd ? '' : dd.type === 'funded_locked'
    ? `<span class="pf-dd-detail pf-dd-locked-label">
        DD LOCKED · Floor: ${fmt(dd.floor)} · Avail: <span class="${dd.avail < 0 ? 'pf-neg' : 'pf-pos'}">${fmt(dd.avail)}</span>
      </span>`
    : dd.type === 'funded_trail'
    ? `<span class="pf-dd-detail pf-dim">
        Trailing · Peak: ${fmt(dd.peak)} · Floor: ${fmt(dd.floor)} · Avail: <span class="${dd.avail < 0 ? 'pf-neg' : 'pf-pos'}">${fmt(dd.avail)}</span>
        <span class="pf-dd-lock-hint">· locks at ${fmt(dd.lockThreshold)}</span>
      </span>`
    : `<span class="pf-dd-detail pf-dim">
        Floor: ${fmt(dd.floor)}
        ${dd.peak ? `· Peak: ${fmt(dd.peak)}` : ''}
        · Avail: <span class="${dd.avail < 0 ? 'pf-neg' : 'pf-pos'}">${fmt(dd.avail)}</span>
      </span>`;

  // ── Phase history accordion ───────────────────────────────────────────────
  const historyHtml = !history.length ? '' : `
    <div class="pf-phase-history">
      <div class="pf-phase-history-title">Phase History (${history.length})</div>
      ${history.map((ph, i) => {
        const phCls   = ph.outcome === 'passed' ? 'pf-badge-passed' : 'pf-badge-failed';
        const phLabel = ph.outcome === 'passed' ? 'Passed' : 'Failed';
        const phPnlCls = ph.totalPnl > 0 ? 'pf-pos' : ph.totalPnl < 0 ? 'pf-neg' : '';
        const phShowPeak = ph.ddType === 'intraday_trail';
        return `
          <div class="pf-phase-card" id="phcard-${a.id}-${ph.id}">
            <div class="pf-phase-card-header" onclick="togglePhaseCard('${a.id}','${ph.id}')">
              <span class="pf-phase-card-name">${_esc(ph.phaseName)}</span>
              <span class="pf-dim" style="font-size:11px">${fmtDate(ph.startDate)} – ${fmtDate(ph.endDate)}</span>
              <span class="pf-phase-card-pnl ${phPnlCls}">${ph.totalPnl >= 0 ? '+' : ''}${fmt(ph.totalPnl)}</span>
              <span class="pf-badge ${phCls} pf-badge-sm">${phLabel}</span>
              <span class="pf-dim" style="font-size:11px">${(ph.dailyProgress || []).length} days</span>
              ${ph.notes ? `<span class="pf-phase-card-notes">${_esc(ph.notes)}</span>` : ''}
              <span class="pf-phase-chevron" id="chev-${a.id}-${ph.id}">▶</span>
            </div>
            <div class="pf-phase-card-body" id="phbody-${a.id}-${ph.id}" style="display:none">
              <div class="pf-phase-meta">
                <span>Start: ${fmt(ph.accountSize)}</span>
                <span>Final: ${fmt(ph.finalValue)}</span>
                <span>Max DD: ${ph.maxDrawdown ? fmt(ph.maxDrawdown) : '—'}</span>
                <span>DD Type: ${ph.ddType || 'static'}</span>
              </div>
              ${_phaseLogTable(ph.dailyProgress || [], ph.accountSize, phShowPeak)}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  return `
    <div class="pf-progress-panel">
      ${historyHtml}
      <div class="pf-progress-header">
        <span class="pf-progress-title">
          ${_esc(a.firm)} — Phase ${curPhaseNum}
          ${isFunded ? '<span class="pf-badge pf-badge-funded pf-badge-sm">Funded</span>' : ''}
        </span>
        ${entries.length ? `<span class="pf-progress-total ${totCls}">${total >= 0 ? '+' : ''}${fmt(total)}</span>` : ''}
        ${ddDetail}
        <button class="pf-add-day-btn" onclick="showAddDay('${a.id}')">+ Add Day</button>
        <button class="pf-advance-btn" onclick="showAdvancePhase('${a.id}')" title="Complete this phase and start the next">Complete Phase →</button>
      </div>
      <div id="add-day-${a.id}" class="pf-add-day-form" style="display:none">
        <input type="hidden" id="day-id-${a.id}" />
        <input type="date"   id="day-date-${a.id}" />
        <input type="number" step="0.01" id="day-pnl-${a.id}" placeholder="Daily P&L ($)" />
        ${showPeak ? `<input type="number" step="0.01" id="day-maxval-${a.id}" placeholder="Peak Balance ($)" />` : ''}
        <input type="text" id="day-notes-${a.id}" placeholder="Notes…" />
        <button class="pf-save-btn"   onclick="saveDayEntry('${a.id}')">Save</button>
        <button class="pf-cancel-btn" onclick="cancelDayEdit('${a.id}')">Cancel</button>
      </div>
      ${entries.length ? `
        <table class="pf-day-table">
          <thead><tr><th>Date</th><th>Daily P&L</th><th>Balance</th>${showPeak ? '<th>Peak Bal</th>' : ''}<th>Notes</th><th></th></tr></thead>
          <tbody>
            ${(function() {
              let cum = +a.accountSize || 0;
              const chron = (a.dailyProgress || []).slice().sort((x, y) => (x.date || '').localeCompare(y.date || ''));
              const balMap = {};
              for (const d of chron) { cum += +d.pnl || 0; balMap[d.id] = cum; }
              return entries.map(d => `
              <tr>
                <td>${fmtDate(d.date)}</td>
                <td style="font-family:monospace" class="${+d.pnl >= 0 ? 'pf-pos' : 'pf-neg'}">${+d.pnl >= 0 ? '+' : ''}${fmt(d.pnl)}</td>
                <td style="font-family:monospace" class="pf-dim">${fmt(balMap[d.id])}</td>
                ${showPeak ? `<td style="font-family:monospace" class="pf-dim">${d.maxValue ? fmt(d.maxValue) : '—'}</td>` : ''}
                <td class="pf-notes-text">${_esc(d.notes || '')}</td>
                <td>
                  <div class="pf-row-actions">
                    <button class="pf-edit-btn" onclick="editDayEntry('${a.id}','${d.id}')">Edit</button>
                    <button class="pf-del-btn"  onclick="deleteDayEntry('${a.id}','${d.id}')">Del</button>
                  </div>
                </td>
              </tr>
            `).join('');
            })()}
          </tbody>
        </table>
      ` : '<div class="pf-empty" style="padding:10px 0">No entries yet — click "+ Add Day" to start logging.</div>'}

      <!-- Advance Phase form -->
      <div id="advance-phase-${a.id}" class="pf-advance-form" style="display:none">
        <div class="pf-advance-title">Complete Phase ${curPhaseNum} &amp; Start Next</div>
        <div class="pf-advance-grid">
          <div class="pf-advance-field">
            <label>Phase Name (being completed)</label>
            <input type="text" id="adv-name-${a.id}" placeholder="Phase ${curPhaseNum}" value="Phase ${curPhaseNum}" />
          </div>
          <div class="pf-advance-field">
            <label>Outcome</label>
            <select id="adv-outcome-${a.id}">
              <option value="passed">Passed ✓</option>
              <option value="failed">Failed ✗</option>
            </select>
          </div>
          <div class="pf-advance-field pf-advance-wide">
            <label>Notes on this phase</label>
            <input type="text" id="adv-notes-${a.id}" placeholder="Hit profit target, clean drawdown…" />
          </div>
          <div class="pf-advance-sep">New Phase Settings</div>
          <div class="pf-advance-field">
            <label>Starting Balance ($)</label>
            <input type="number" id="adv-newsize-${a.id}" placeholder="${a.accountSize}" value="${a.accountSize}" />
          </div>
          <div class="pf-advance-field">
            <label>Max Drawdown ($)</label>
            <input type="number" id="adv-newdd-${a.id}" placeholder="${a.maxDrawdown || ''}" value="${a.maxDrawdown || ''}" />
          </div>
          <div class="pf-advance-field">
            <label>Drawdown Type</label>
            <select id="adv-newddtype-${a.id}">
              <option value="static"${(!a.ddType || a.ddType === 'static') ? ' selected' : ''}>Static</option>
              <option value="eod_trail"${a.ddType === 'eod_trail' ? ' selected' : ''}>EOD Trailing</option>
              <option value="intraday_trail"${a.ddType === 'intraday_trail' ? ' selected' : ''}>Intraday Trailing</option>
            </select>
          </div>
        </div>
        <div class="pf-advance-actions">
          <button class="pf-save-btn" onclick="confirmAdvancePhase('${a.id}')">Complete &amp; Advance →</button>
          <button class="pf-cancel-btn" onclick="cancelAdvancePhase('${a.id}')">Cancel</button>
        </div>
      </div>

      ${isFunded ? `
        <div class="pf-payout-section">
          <div class="pf-payout-header">
            <span class="pf-payout-title">Payouts</span>
            ${totalReceived > 0 ? `<span class="pf-pos pf-payout-total">${fmt(totalReceived)} received</span>` : ''}
            ${totalGross > totalReceived ? `<span class="pf-dim" style="font-size:11px">(${fmt(totalGross)} withdrawn)</span>` : ''}
            <button class="pf-add-day-btn" onclick="showAddAccountPayout('${a.id}')">+ Add Payout</button>
          </div>
          <div id="add-payout-${a.id}" class="pf-add-day-form" style="display:none">
            <input type="hidden" id="ap-id-${a.id}" />
            <input type="date"   id="ap-date-${a.id}" />
            <input type="number" step="0.01" id="ap-amount-${a.id}" placeholder="Received ($)" />
            <input type="number" step="0.01" id="ap-gross-${a.id}" placeholder="Gross withdrawal ($) if split" />
            <input type="text"   id="ap-notes-${a.id}" placeholder="Notes…" />
            <button class="pf-save-btn"   onclick="saveAccountPayout('${a.id}')">Save</button>
            <button class="pf-cancel-btn" onclick="cancelAccountPayout('${a.id}')">Cancel</button>
          </div>
          ${acctPayouts.length ? `
            <table class="pf-day-table">
              <thead><tr><th>Date</th><th>Received</th><th>Gross</th><th>Notes</th><th></th></tr></thead>
              <tbody>
                ${acctPayouts.map(p => `
                  <tr>
                    <td>${fmtDate(p.date)}</td>
                    <td style="font-family:monospace" class="pf-pos">${fmt(p.amount)}</td>
                    <td style="font-family:monospace" class="pf-dim">${p.grossAmount ? fmt(p.grossAmount) : '—'}</td>
                    <td class="pf-notes-text">${_esc(p.notes || '')}</td>
                    <td>
                      <div class="pf-row-actions">
                        <button class="pf-edit-btn" onclick="editAccountPayout('${a.id}','${p.id}')">Edit</button>
                        <button class="pf-del-btn"  onclick="deleteAccountPayout('${p.id}')">Del</button>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<div class="pf-empty" style="padding:6px 0;font-size:11px">No payouts yet.</div>'}
        </div>
      ` : ''}
    </div>
  `;
}

function renderAccounts() {
  const statusFilter = $('filter-status')?.value || 'ALL';
  const firmFilter   = $('filter-firm')?.value   || 'ALL';

  const rows = _data.accounts
    .filter(a => {
      if (firmFilter !== 'ALL' && a.firm !== firmFilter) return false;
      if (statusFilter === 'ALL')           return true;
      if (statusFilter === 'funded')        return a.phase === 'funded' && !a.fundedFailed;
      if (statusFilter === 'funded_failed') return a.phase === 'funded' && a.fundedFailed;
      return (!a.phase || a.phase === 'challenge') && a.status === statusFilter;
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const tbody = $('accounts-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="pf-empty">No accounts match the filter.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(a => `
    <tr data-id="${a.id}">
      <td data-label="Firm"><strong>${a.firm || '—'}</strong></td>
      <td data-label="Date">${fmtDate(a.date)}</td>
      <td data-label="Size">${fmtSize(a.accountSize)}</td>
      <td data-label="Cost" style="font-family:monospace">${fmt(a.cost)}</td>
      <td data-label="Status">
        ${_statusBadge(a)}
        ${a.subStatus ? `<div class="pf-sub-status">${_esc(a.subStatus)}</div>` : ''}
      </td>
      <td data-label="Live" class="pf-live-cell">${_liveStats(a)}</td>
      <td data-label="Notes" class="pf-notes-cell">
        ${a.blowReason ? `<div class="pf-notes-reason">&#9888; ${_esc(a.blowReason)}</div>` : ''}
        ${a.notes      ? `<div class="pf-notes-text">${_esc(a.notes)}</div>` : ''}
      </td>
      <td data-label="" class="pf-actions-cell">
        <div class="pf-row-actions">
          <button class="pf-log-btn"    onclick="toggleProgress('${a.id}')">Log</button>
          <button class="pf-trades-btn" onclick="location.href='/tradelog.html?accountId=pf:${a.id}'" title="View trades for this account">Trades</button>
          <button class="pf-edit-btn"   onclick="editAccount('${a.id}')">Edit</button>
          <button class="pf-del-btn"    onclick="deleteAccount('${a.id}')">Del</button>
        </div>
      </td>
    </tr>
    <tr class="pf-progress-row" id="prog-${a.id}" style="display:none">
      <td colspan="8" class="pf-progress-td">${_progressPanel(a)}</td>
    </tr>
  `).join('');
}

function renderExpenses() {
  const sorted = [..._data.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const tbody  = $('expenses-tbody');
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="pf-empty">No expenses yet.</td></tr>';
    return;
  }
  tbody.innerHTML = sorted.map(e => `
    <tr data-id="${e.id}">
      <td data-label="Item"><strong>${_esc(e.item || '—')}</strong></td>
      <td data-label="Date">${fmtDate(e.date)}</td>
      <td data-label="Amount" style="font-family:monospace">${fmt(e.amount)}</td>
      <td data-label="Notes" class="pf-notes-text">${_esc(e.notes || '')}</td>
      <td data-label="" class="pf-actions-cell">
        <div class="pf-row-actions">
          <button class="pf-edit-btn" onclick="editExpense('${e.id}')">Edit</button>
          <button class="pf-del-btn"  onclick="deleteExpense('${e.id}')">Del</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderPayouts() {
  const sorted = [..._data.payouts].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const tbody  = $('payouts-tbody');
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="pf-empty">No payouts recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = sorted.map(p => `
    <tr data-id="${p.id}">
      <td data-label="Firm"><strong>${_esc(p.firm || '—')}</strong></td>
      <td data-label="Date">${fmtDate(p.date)}</td>
      <td data-label="Amount" style="font-family:monospace;color:var(--bull)">${fmt(p.amount)}</td>
      <td data-label="Notes" class="pf-notes-text">${_esc(p.notes || '')}</td>
      <td data-label="" class="pf-actions-cell">
        <div class="pf-row-actions">
          <button class="pf-edit-btn" onclick="editPayout('${p.id}')">Edit</button>
          <button class="pf-del-btn"  onclick="deletePayout('${p.id}')">Del</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderAnalysis() {
  _renderFirmCosts();
  _renderPassRates();
  _renderMonthly();
  _renderFailurePatterns();
}

function _renderFirmCosts() {
  const el = $('analysis-by-firm');
  if (!_data.accounts.length) { el.innerHTML = '<div class="pf-notes-text">No data yet.</div>'; return; }
  const byFirm = {};
  _data.accounts.forEach(a => {
    byFirm[a.firm] = (byFirm[a.firm] || 0) + (+a.cost || 0);
  });
  const max = Math.max(...Object.values(byFirm), 1);
  el.innerHTML = Object.entries(byFirm)
    .sort((a,b) => b[1] - a[1])
    .map(([firm, total]) => `
      <div class="an-row">
        <div class="an-label">${_esc(firm)}</div>
        <div class="an-bar-wrap"><div class="an-bar" style="width:${(total/max*100).toFixed(1)}%"></div></div>
        <div class="an-val">${fmt(total)}</div>
      </div>
    `).join('');
}

function _renderPassRates() {
  const el = $('analysis-passrate');
  const firms = [...new Set(_data.accounts.map(a => a.firm))];
  if (!firms.length) { el.innerHTML = '<div class="pf-notes-text">No data yet.</div>'; return; }
  el.innerHTML = firms.map(firm => {
    const all    = _data.accounts.filter(a => a.firm === firm);
    const passed = all.filter(a => a.status === 'passed' || a.phase === 'funded').length;
    const pct    = Math.round(passed / all.length * 100);
    return `
      <div class="an-row">
        <div class="an-label">${_esc(firm)}</div>
        <div class="an-bar-wrap"><div class="an-bar ${pct >= 50 ? 'an-bar-green' : 'an-bar-red'}" style="width:${pct}%"></div></div>
        <div class="an-val">${pct}% <span style="color:var(--text-dim);font-size:10px">(${passed}/${all.length})</span></div>
      </div>
    `;
  }).join('');
}

function _renderMonthly() {
  const el = $('analysis-monthly');
  const byMonth = {};
  _data.accounts.forEach(a => {
    if (!a.date) return;
    const key = a.date.slice(0, 7);
    byMonth[key] = (byMonth[key] || 0) + (+a.cost || 0);
  });
  _data.expenses.forEach(e => {
    if (!e.date) return;
    const key = e.date.slice(0, 7);
    byMonth[key] = (byMonth[key] || 0) + (+e.amount || 0);
  });
  const sorted = Object.entries(byMonth).sort((a,b) => b[0].localeCompare(a[0]));
  if (!sorted.length) { el.innerHTML = '<div class="pf-notes-text">No data yet.</div>'; return; }
  const max = Math.max(...sorted.map(([,v]) => v), 1);
  el.innerHTML = sorted.slice(0, 12).map(([month, total]) => {
    const [yr, mo] = month.split('-');
    const label = new Date(+yr, +mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    return `
      <div class="an-row">
        <div class="an-label">${label}</div>
        <div class="an-bar-wrap"><div class="an-bar" style="width:${(total/max*100).toFixed(1)}%"></div></div>
        <div class="an-val">${fmt(total)}</div>
      </div>
    `;
  }).join('');
}

function _renderFailurePatterns() {
  const el = $('analysis-failures');
  const failed = _data.accounts.filter(a => a.status === 'failed' && a.blowReason);
  if (!failed.length) {
    el.innerHTML = '<div class="pf-notes-text">No failures with notes yet.<br>Add a "Reason Blown" when logging failed accounts to see patterns here.</div>';
    return;
  }
  // Count keyword frequency in blow reasons
  const keywords = {};
  const keyList  = ['news', 'overtraded', 'revenge', 'size', 'drawdown', 'stop', 'gap', 'emotional', 'rule', 'overnight', 'loss limit', 'daily loss'];
  failed.forEach(a => {
    const lower = (a.blowReason || '').toLowerCase();
    keyList.forEach(kw => {
      if (lower.includes(kw)) keywords[kw] = (keywords[kw] || 0) + 1;
    });
  });
  const matched = Object.entries(keywords).sort((a,b) => b[1]-a[1]);
  const recentFailed = failed.slice(-5).reverse();
  el.innerHTML = `
    ${matched.length ? `<div style="margin-bottom:10px;font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px">Common Themes</div>` : ''}
    ${matched.map(([kw, n]) => `
      <div class="an-pattern"><span>${kw}</span> mentioned ${n}x in failed accounts</div>
    `).join('')}
    <div style="margin:12px 0 6px;font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px">Recent Failures</div>
    ${recentFailed.map(a => `
      <div class="an-pattern">${_esc(a.firm)} ${fmtDate(a.date)} — <span>${_esc(a.blowReason)}</span></div>
    `).join('')}
  `;
}

function populateFirmFilter() {
  const sel  = $('filter-firm');
  if (!sel) return;
  const firms = [...new Set(_data.accounts.map(a => a.firm).filter(Boolean))].sort();
  const cur   = sel.value;
  sel.innerHTML = '<option value="ALL">All Firms</option>' + firms.map(f => `<option value="${_esc(f)}">${_esc(f)}</option>`).join('');
  sel.value = firms.includes(cur) ? cur : 'ALL';
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Account CRUD ─────────────────────────────────────────────────────────────

function _showAccountForm(title) {
  $('account-form-title').textContent = title;
  $('account-form-wrap').style.display = '';
  $('account-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _hideAccountForm() {
  $('account-form-wrap').style.display = 'none';
  ['af-id','af-firm','af-date','af-cost','af-blow','af-notes','af-substatus','af-maxdd','af-curval'].forEach(id => { $(id).value = ''; });
  $('af-ddtype').value = 'static';
  $('af-size').value = '50000';
  $('af-status').value = 'active';
  $('af-phase').value = 'challenge';
  $('af-funded-failed').checked = false;
  $('af-size-custom-wrap').style.display = 'none';
  $('af-size-custom').value = '';
  _togglePhaseFields();
}

window.editAccount = function(id) {
  const a = _data.accounts.find(x => x.id === id);
  if (!a) return;
  $('af-id').value           = a.id;
  $('af-firm').value         = a.firm || '';
  $('af-date').value         = a.date || '';
  $('af-cost').value         = a.cost || '';
  $('af-blow').value         = a.blowReason || '';
  $('af-notes').value        = a.notes || '';
  $('af-status').value       = a.status || 'active';
  $('af-substatus').value    = a.subStatus || '';
  $('af-maxdd').value        = a.maxDrawdown || '';
  $('af-curval').value       = a.currentValue || '';
  $('af-ddtype').value       = a.ddType || 'static';
  $('af-phase').value        = a.phase || 'challenge';
  $('af-funded-failed').checked = !!a.fundedFailed;
  const sizeEl = $('af-size');
  const knownSizes = ['25000','50000','100000','150000','200000'];
  if (knownSizes.includes(String(a.accountSize))) {
    sizeEl.value = String(a.accountSize);
    $('af-size-custom-wrap').style.display = 'none';
  } else {
    sizeEl.value = 'custom';
    $('af-size-custom-wrap').style.display = '';
    $('af-size-custom').value = a.accountSize || '';
  }
  _toggleBlowReason();
  _togglePhaseFields();
  _showAccountForm('Edit Prop Account');
};

window.deleteAccount = async function(id) {
  if (!confirm('Delete this account entry?')) return;
  await _api('DELETE', `/api/propfirms/account/${id}`);
  await load();
};

window.toggleProgress = function(id) {
  const row = document.getElementById('prog-' + id);
  if (!row) return;
  row.style.display = row.style.display === 'none' ? '' : 'none';
};

window.showAddDay = function(id) {
  const wrap = document.getElementById('add-day-' + id);
  if (!wrap) return;
  // Clear form for a new entry
  const idEl = document.getElementById('day-id-' + id);
  if (idEl) idEl.value = '';
  const pnlEl = document.getElementById('day-pnl-' + id);
  if (pnlEl) pnlEl.value = '';
  const mvEl = document.getElementById('day-maxval-' + id);
  if (mvEl) mvEl.value = '';
  const notesEl = document.getElementById('day-notes-' + id);
  if (notesEl) notesEl.value = '';
  const dateEl = document.getElementById('day-date-' + id);
  if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
  wrap.style.display = '';
};

window.cancelDayEdit = function(id) {
  const wrap = document.getElementById('add-day-' + id);
  if (wrap) wrap.style.display = 'none';
  const idEl = document.getElementById('day-id-' + id);
  if (idEl) idEl.value = '';
};

window.editDayEntry = function(accountId, dayId) {
  const a = _data.accounts.find(x => x.id === accountId);
  if (!a) return;
  const d = (a.dailyProgress || []).find(x => x.id === dayId);
  if (!d) return;
  const wrap = document.getElementById('add-day-' + accountId);
  if (wrap) wrap.style.display = '';
  const idEl = document.getElementById('day-id-' + accountId);
  if (idEl) idEl.value = dayId;
  const dateEl = document.getElementById('day-date-' + accountId);
  if (dateEl) dateEl.value = d.date || '';
  const pnlEl = document.getElementById('day-pnl-' + accountId);
  if (pnlEl) pnlEl.value = d.pnl !== undefined ? d.pnl : '';
  const mvEl = document.getElementById('day-maxval-' + accountId);
  if (mvEl) mvEl.value = d.maxValue || '';
  const notesEl = document.getElementById('day-notes-' + accountId);
  if (notesEl) notesEl.value = d.notes || '';
};

window.saveDayEntry = async function(accountId) {
  const dayId    = document.getElementById('day-id-'     + accountId)?.value || '';
  const date     = document.getElementById('day-date-'   + accountId)?.value;
  const pnl      = document.getElementById('day-pnl-'    + accountId)?.value;
  const maxValue = document.getElementById('day-maxval-' + accountId)?.value || '';
  const notes    = document.getElementById('day-notes-'  + accountId)?.value || '';
  if (!date) { alert('Please enter a date.'); return; }
  if (!pnl)  { alert('Please enter a P&L value.'); return; }
  await _api('POST', `/api/propfirms/account/${accountId}/day`, { dayId: dayId || undefined, date, pnl, maxValue, notes });
  await load();
};

window.deleteDayEntry = async function(accountId, dayId) {
  if (!confirm('Delete this daily entry?')) return;
  await _api('DELETE', `/api/propfirms/account/${accountId}/day/${dayId}`);
  await load();
};

window.showAddAccountPayout = function(accountId) {
  const wrap = document.getElementById('add-payout-' + accountId);
  if (!wrap) return;
  const idEl = document.getElementById('ap-id-' + accountId);
  if (idEl) idEl.value = '';
  const dateEl = document.getElementById('ap-date-' + accountId);
  if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
  ['ap-amount-','ap-gross-','ap-notes-'].forEach(pfx => {
    const el = document.getElementById(pfx + accountId);
    if (el) el.value = '';
  });
  wrap.style.display = '';
};

window.editAccountPayout = function(accountId, payoutId) {
  const p = (_data.payouts || []).find(x => x.id === payoutId);
  if (!p) return;
  const wrap = document.getElementById('add-payout-' + accountId);
  if (wrap) wrap.style.display = '';
  const idEl = document.getElementById('ap-id-' + accountId);
  if (idEl) idEl.value = payoutId;
  const dateEl = document.getElementById('ap-date-' + accountId);
  if (dateEl) dateEl.value = p.date || '';
  const amtEl = document.getElementById('ap-amount-' + accountId);
  if (amtEl) amtEl.value = p.amount || '';
  const grossEl = document.getElementById('ap-gross-' + accountId);
  if (grossEl) grossEl.value = p.grossAmount || '';
  const notesEl = document.getElementById('ap-notes-' + accountId);
  if (notesEl) notesEl.value = p.notes || '';
};

window.cancelAccountPayout = function(accountId) {
  const wrap = document.getElementById('add-payout-' + accountId);
  if (wrap) wrap.style.display = 'none';
  const idEl = document.getElementById('ap-id-' + accountId);
  if (idEl) idEl.value = '';
};

// ── Phase advance ─────────────────────────────────────────────────────────────

window.togglePhaseCard = function(accountId, phaseId) {
  const body = document.getElementById('phbody-' + accountId + '-' + phaseId);
  const chev = document.getElementById('chev-'   + accountId + '-' + phaseId);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (chev) chev.textContent = open ? '▶' : '▼';
};

window.showAdvancePhase = function(accountId) {
  // Hide add-day form if open
  const addDay = document.getElementById('add-day-' + accountId);
  if (addDay) addDay.style.display = 'none';
  const wrap = document.getElementById('advance-phase-' + accountId);
  if (wrap) wrap.style.display = '';
  wrap?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.cancelAdvancePhase = function(accountId) {
  const wrap = document.getElementById('advance-phase-' + accountId);
  if (wrap) wrap.style.display = 'none';
};

window.confirmAdvancePhase = async function(accountId) {
  const phaseName  = document.getElementById('adv-name-'      + accountId)?.value.trim();
  const outcome    = document.getElementById('adv-outcome-'   + accountId)?.value;
  const notes      = document.getElementById('adv-notes-'     + accountId)?.value.trim();
  const newSize    = document.getElementById('adv-newsize-'   + accountId)?.value;
  const newDD      = document.getElementById('adv-newdd-'     + accountId)?.value;
  const newDDType  = document.getElementById('adv-newddtype-' + accountId)?.value;

  if (!confirm(`Archive the current log as "${phaseName || 'Phase'}" (${outcome}) and start a fresh phase?\n\nThis cannot be undone.`)) return;

  await _api('POST', `/api/propfirms/account/${accountId}/advance-phase`, {
    phaseName, outcome, notes,
    newAccountSize: newSize,
    newMaxDrawdown: newDD,
    newDdType:      newDDType,
  });
  await load();
};

window.saveAccountPayout = async function(accountId) {
  const payoutId  = document.getElementById('ap-id-'     + accountId)?.value || '';
  const date      = document.getElementById('ap-date-'   + accountId)?.value;
  const amount    = document.getElementById('ap-amount-' + accountId)?.value;
  const grossAmount = document.getElementById('ap-gross-'  + accountId)?.value || '';
  const notes     = document.getElementById('ap-notes-'  + accountId)?.value || '';
  if (!date || !amount) { alert('Date and received amount required.'); return; }
  const a = _data.accounts.find(x => x.id === accountId);
  await _api('POST', '/api/propfirms/payout', {
    id: payoutId || undefined,
    accountId, firm: a?.firm || '', date, amount, grossAmount: grossAmount || undefined, notes
  });
  await load();
};

window.deleteAccountPayout = async function(payoutId) {
  if (!confirm('Delete this payout record?')) return;
  await _api('DELETE', `/api/propfirms/payout/${payoutId}`);
  await load();
};

function _toggleBlowReason() {
  const status      = $('af-status').value;
  const phase       = $('af-phase').value;
  const fundedFailed = $('af-funded-failed').checked;
  $('af-blow-wrap').style.display = (status === 'failed' || (phase === 'funded' && fundedFailed)) ? '' : 'none';
}

function _togglePhaseFields() {
  const isFunded = $('af-phase').value === 'funded';
  $('af-status-wrap').style.display       = isFunded ? 'none' : '';
  $('af-funded-failed-wrap').style.display = isFunded ? '' : 'none';
  _toggleBlowReason();
}

async function _saveAccount() {
  const sizeEl = $('af-size');
  const size   = sizeEl.value === 'custom' ? +($('af-size-custom').value) : +sizeEl.value;
  const phase  = $('af-phase').value;
  await _api('POST', '/api/propfirms/account', {
    id:           $('af-id').value || undefined,
    firm:         $('af-firm').value.trim(),
    date:         $('af-date').value,
    accountSize:  size,
    cost:         $('af-cost').value,
    status:       phase === 'funded' ? 'passed' : $('af-status').value,
    subStatus:    $('af-substatus').value.trim(),
    blowReason:   $('af-blow').value.trim(),
    notes:        $('af-notes').value.trim(),
    maxDrawdown:  $('af-maxdd').value,
    currentValue: $('af-curval').value,
    ddType:       $('af-ddtype').value,
    phase,
    fundedFailed: phase === 'funded' ? $('af-funded-failed').checked : false,
  });
  _hideAccountForm();
  await load();
}

// ── Expense CRUD ──────────────────────────────────────────────────────────────

function _hideExpenseForm() {
  $('expense-form-wrap').style.display = 'none';
  ['ef-id','ef-item','ef-date','ef-amount','ef-notes'].forEach(id => { $(id).value = ''; });
}

window.editExpense = function(id) {
  const e = _data.expenses.find(x => x.id === id);
  if (!e) return;
  $('ef-id').value     = e.id;
  $('ef-item').value   = e.item || '';
  $('ef-date').value   = e.date || '';
  $('ef-amount').value = e.amount || '';
  $('ef-notes').value  = e.notes || '';
  $('expense-form-title').textContent = 'Edit Expense';
  $('expense-form-wrap').style.display = '';
};

window.deleteExpense = async function(id) {
  if (!confirm('Delete this expense?')) return;
  await _api('DELETE', `/api/propfirms/expense/${id}`);
  await load();
};

async function _saveExpense() {
  await _api('POST', '/api/propfirms/expense', {
    id:     $('ef-id').value || undefined,
    item:   $('ef-item').value.trim(),
    date:   $('ef-date').value,
    amount: $('ef-amount').value,
    notes:  $('ef-notes').value.trim(),
  });
  _hideExpenseForm();
  await load();
}

// ── Payout CRUD ───────────────────────────────────────────────────────────────

function _hidePayoutForm() {
  $('payout-form-wrap').style.display = 'none';
  ['pf-id','pf-firm','pf-date','pf-amount','pf-notes'].forEach(id => { $(id).value = ''; });
}

window.editPayout = function(id) {
  const p = _data.payouts.find(x => x.id === id);
  if (!p) return;
  $('pf-id').value     = p.id;
  $('pf-firm').value   = p.firm || '';
  $('pf-date').value   = p.date || '';
  $('pf-amount').value = p.amount || '';
  $('pf-notes').value  = p.notes || '';
  $('payout-form-title').textContent = 'Edit Payout';
  $('payout-form-wrap').style.display = '';
};

window.deletePayout = async function(id) {
  if (!confirm('Delete this payout?')) return;
  await _api('DELETE', `/api/propfirms/payout/${id}`);
  await load();
};

async function _savePayout() {
  await _api('POST', '/api/propfirms/payout', {
    id:     $('pf-id').value || undefined,
    firm:   $('pf-firm').value.trim(),
    date:   $('pf-date').value,
    amount: $('pf-amount').value,
    notes:  $('pf-notes').value.trim(),
  });
  _hidePayoutForm();
  await load();
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function _initTabs() {
  document.querySelectorAll('.pf-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pf-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.pf-tab-content').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function init() {
  _initTabs();

  // Account form
  $('btn-add-account').addEventListener('click', () => {
    _hideAccountForm();
    _toggleBlowReason();
    _showAccountForm('Add Prop Account');
  });
  $('af-cancel').addEventListener('click', _hideAccountForm);
  $('af-save').addEventListener('click', _saveAccount);
  $('af-status').addEventListener('change', _toggleBlowReason);
  $('af-phase').addEventListener('change', _togglePhaseFields);
  $('af-funded-failed').addEventListener('change', _toggleBlowReason);
  $('af-size').addEventListener('change', () => {
    $('af-size-custom-wrap').style.display = $('af-size').value === 'custom' ? '' : 'none';
  });
  $('filter-status').addEventListener('change', renderAccounts);
  $('filter-firm').addEventListener('change', renderAccounts);

  // Expense form
  $('btn-add-expense').addEventListener('click', () => {
    _hideExpenseForm();
    $('expense-form-title').textContent = 'Add Expense';
    $('expense-form-wrap').style.display = '';
  });
  $('ef-cancel').addEventListener('click', _hideExpenseForm);
  $('ef-save').addEventListener('click', _saveExpense);

  // Payout form
  $('btn-add-payout').addEventListener('click', () => {
    _hidePayoutForm();
    $('payout-form-title').textContent = 'Add Payout';
    $('payout-form-wrap').style.display = '';
  });
  $('pf-cancel').addEventListener('click', _hidePayoutForm);
  $('pf-save').addEventListener('click', _savePayout);

  load();
}

document.addEventListener('DOMContentLoaded', init);
