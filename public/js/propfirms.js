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
  const passed     = _data.accounts.filter(a => a.status === 'passed').length;
  const active     = _data.accounts.filter(a => a.status === 'active').length;
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

function _statusBadge(s) {
  const cls = s === 'passed' ? 'pf-badge-passed' : s === 'active' ? 'pf-badge-active' : 'pf-badge-failed';
  return `<span class="pf-badge ${cls}">${s}</span>`;
}

function renderAccounts() {
  const statusFilter = $('filter-status')?.value || 'ALL';
  const firmFilter   = $('filter-firm')?.value   || 'ALL';

  const rows = _data.accounts
    .filter(a => (statusFilter === 'ALL' || a.status === statusFilter)
              && (firmFilter   === 'ALL' || a.firm === firmFilter))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const tbody = $('accounts-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="pf-empty">No accounts match the filter.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(a => `
    <tr data-id="${a.id}">
      <td><strong>${a.firm || '—'}</strong></td>
      <td>${fmtDate(a.date)}</td>
      <td>${fmtSize(a.accountSize)}</td>
      <td style="font-family:monospace">${fmt(a.cost)}</td>
      <td>${_statusBadge(a.status)}</td>
      <td class="pf-notes-cell">
        ${a.blowReason ? `<div class="pf-notes-reason">&#9888; ${_esc(a.blowReason)}</div>` : ''}
        ${a.notes      ? `<div class="pf-notes-text">${_esc(a.notes)}</div>` : ''}
      </td>
      <td>
        <div class="pf-row-actions">
          <button class="pf-edit-btn" onclick="editAccount('${a.id}')">Edit</button>
          <button class="pf-del-btn"  onclick="deleteAccount('${a.id}')">Del</button>
        </div>
      </td>
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
      <td><strong>${_esc(e.item || '—')}</strong></td>
      <td>${fmtDate(e.date)}</td>
      <td style="font-family:monospace">${fmt(e.amount)}</td>
      <td class="pf-notes-text">${_esc(e.notes || '')}</td>
      <td>
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
      <td><strong>${_esc(p.firm || '—')}</strong></td>
      <td>${fmtDate(p.date)}</td>
      <td style="font-family:monospace;color:var(--bull)">${fmt(p.amount)}</td>
      <td class="pf-notes-text">${_esc(p.notes || '')}</td>
      <td>
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
    const passed = all.filter(a => a.status === 'passed').length;
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
  ['af-id','af-firm','af-date','af-cost','af-blow','af-notes'].forEach(id => { $(id).value = ''; });
  $('af-size').value = '50000';
  $('af-status').value = 'active';
  $('af-size-custom-wrap').style.display = 'none';
  $('af-size-custom').value = '';
}

window.editAccount = function(id) {
  const a = _data.accounts.find(x => x.id === id);
  if (!a) return;
  $('af-id').value     = a.id;
  $('af-firm').value   = a.firm || '';
  $('af-date').value   = a.date || '';
  $('af-cost').value   = a.cost || '';
  $('af-blow').value   = a.blowReason || '';
  $('af-notes').value  = a.notes || '';
  $('af-status').value = a.status || 'active';
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
  _showAccountForm('Edit Prop Account');
};

window.deleteAccount = async function(id) {
  if (!confirm('Delete this account entry?')) return;
  await _api('DELETE', `/api/propfirms/account/${id}`);
  await load();
};

function _toggleBlowReason() {
  const status = $('af-status').value;
  $('af-blow-wrap').style.display = status === 'failed' ? '' : 'none';
}

async function _saveAccount() {
  const sizeEl = $('af-size');
  const size   = sizeEl.value === 'custom' ? +($('af-size-custom').value) : +sizeEl.value;
  await _api('POST', '/api/propfirms/account', {
    id:          $('af-id').value || undefined,
    firm:        $('af-firm').value.trim(),
    date:        $('af-date').value,
    accountSize: size,
    cost:        $('af-cost').value,
    status:      $('af-status').value,
    blowReason:  $('af-blow').value.trim(),
    notes:       $('af-notes').value.trim(),
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
