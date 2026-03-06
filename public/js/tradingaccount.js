'use strict';
// Real Account Tracker — client-side CRUD + analytics

const BASE = '';

// ── State ─────────────────────────────────────────────────────────────────

let _trades   = [];
let _deposits = [];

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  setupTabs();
  setupTradeForm();
  setupDepositForm();
  setupFilters();
  await load();
}

// ── Data fetch ────────────────────────────────────────────────────────────

async function load() {
  try {
    const r = await fetch(`${BASE}/api/realaccount`);
    const d = await r.json();
    _trades   = (d.trades   || []).sort((a, b) => a.date.localeCompare(b.date));
    _deposits = (d.deposits || []).sort((a, b) => a.date.localeCompare(b.date));
    renderSummary();
    renderTrades();
    renderDeposits();
    renderFeeBreakdown();
    renderAnalysis();
  } catch (err) {
    console.error('[RA] load error', err);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────

function renderSummary() {
  const totalDeposited   = _deposits.filter(d => d.type === 'deposit').reduce((s, d) => s + d.amount, 0);
  const totalWithdrawn   = _deposits.filter(d => d.type === 'withdrawal').reduce((s, d) => s + d.amount, 0);
  const startBal         = totalDeposited - totalWithdrawn;
  const grossPnl         = _trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalFees        = _trades.reduce((s, t) => s + (t.fees?.total || 0) + (t.coq?.platform || 0) + (t.coq?.marketData || 0), 0);
  const netPnl           = grossPnl - totalFees;
  const totalCashOut     = _trades.reduce((s, t) => s + (t.cashOut || 0), 0);
  const currentBal       = startBal + netPnl - totalCashOut;
  const wins             = _trades.filter(t => t.pnl > 0).length;
  const total            = _trades.length;
  const winRate          = total > 0 ? ((wins / total) * 100).toFixed(1) + '%' : '—';
  const avgFee           = total > 0 ? '$' + (totalFees / total).toFixed(2) : '—';

  setText('stat-start-bal',   fmt(startBal));
  setText('stat-current-bal', fmt(currentBal));
  setText('stat-net-pnl',     fmt(netPnl));
  setText('stat-total-fees',  fmt(totalFees));
  setText('stat-trades',      total.toString());
  setText('stat-winrate',     winRate);
  setText('stat-gross-pnl',   fmt(grossPnl));
  setText('stat-avg-fee',     avgFee);

  colorCard('card-current', currentBal - startBal);
  colorCard('card-net-pnl', netPnl);
  colorCard('card-gross-pnl', grossPnl);
}

function colorCard(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('ra-card-green', 'ra-card-red');
  if (val > 0) el.classList.add('ra-card-green');
  else if (val < 0) el.classList.add('ra-card-red');
}

// ── Trades table ──────────────────────────────────────────────────────────

function renderTrades() {
  const sym = document.getElementById('filter-symbol')?.value || 'ALL';
  const res = document.getElementById('filter-result')?.value || 'ALL';

  // Compute running balance — always from all trades sorted by date
  let runningBal = _computeStartBal();
  const withBal = _trades.map(t => {
    const netFees = (t.fees?.total || 0) + (t.coq?.platform || 0) + (t.coq?.marketData || 0);
    const net     = (t.pnl || 0) - netFees;
    runningBal    += net - (t.cashOut || 0);
    return { ...t, _netFees: netFees, _net: net, _runBal: runningBal };
  });

  const filtered = withBal.filter(t => {
    if (sym !== 'ALL' && t.symbol !== sym) return false;
    if (res !== 'ALL') {
      if (res === 'win'     && t.pnl <= 0) return false;
      if (res === 'loss'    && t.pnl >= 0) return false;
      if (res === 'scratch' && t.pnl !== 0) return false;
    }
    return true;
  });

  const tbody = document.getElementById('trades-tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="ra-empty">No trades match the current filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(t => {
    const qty    = Math.max(t.buy || 0, t.sell || 0);
    const pnlCls = t.pnl > 0 ? 'ra-pos' : t.pnl < 0 ? 'ra-neg' : 'ra-zero';
    const netCls = t._net > 0 ? 'ra-pos' : t._net < 0 ? 'ra-neg' : 'ra-zero';
    const balCls = t._runBal >= 0 ? '' : 'ra-neg';
    const co     = t.cashOut > 0 ? `<span class="ra-neg">${fmt(t.cashOut)}</span>` : '—';
    return `<tr>
      <td data-label="Date">${t.date}</td>
      <td data-label="Symbol"><span class="ra-sym">${t.symbol}</span></td>
      <td data-label="Qty">${qty}</td>
      <td data-label="P&amp;L" class="${pnlCls}">${fmt(t.pnl)}</td>
      <td data-label="Fees" class="ra-neg">${fmt(t._netFees)}</td>
      <td data-label="Net" class="${netCls}">${fmt(t._net)}</td>
      <td data-label="Cash Out">${co}</td>
      <td data-label="Balance" class="${balCls}" style="font-family:monospace">${fmt(t._runBal)}</td>
      <td data-label="Notes" style="color:var(--text-dim);font-size:11px">${t.notes || ''}</td>
      <td data-label="" class="ra-actions-cell"><div class="ra-row-actions">
        <button class="ra-edit-btn" data-id="${t.id}">Edit</button>
        <button class="ra-del-btn"  data-id="${t.id}">Del</button>
      </div></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.ra-edit-btn').forEach(b => b.addEventListener('click', () => openTradeForm(b.dataset.id)));
  tbody.querySelectorAll('.ra-del-btn').forEach(b  => b.addEventListener('click', () => deleteTrade(b.dataset.id)));
}

function _computeStartBal() {
  const dep = _deposits.filter(d => d.type === 'deposit').reduce((s, d) => s + d.amount, 0);
  const wd  = _deposits.filter(d => d.type === 'withdrawal').reduce((s, d) => s + d.amount, 0);
  return dep - wd;
}

// ── Deposits table ────────────────────────────────────────────────────────

function renderDeposits() {
  const tbody = document.getElementById('deposits-tbody');
  if (!_deposits.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="ra-empty">No deposits recorded yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = _deposits.map(d => {
    const badgeCls = d.type === 'deposit' ? 'ra-badge-deposit' : 'ra-badge-withdrawal';
    const amtCls   = d.type === 'deposit' ? 'ra-pos' : 'ra-neg';
    return `<tr>
      <td data-label="Date">${d.date}</td>
      <td data-label="Type"><span class="${badgeCls}">${d.type}</span></td>
      <td data-label="Amount" class="${amtCls}">${fmt(d.amount)}</td>
      <td data-label="Notes" style="color:var(--text-dim);font-size:11px">${d.notes || ''}</td>
      <td data-label="" class="ra-actions-cell"><div class="ra-row-actions">
        <button class="ra-edit-btn" data-id="${d.id}">Edit</button>
        <button class="ra-del-btn"  data-id="${d.id}">Del</button>
      </div></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.ra-edit-btn').forEach(b => b.addEventListener('click', () => openDepositForm(b.dataset.id)));
  tbody.querySelectorAll('.ra-del-btn').forEach(b  => b.addEventListener('click', () => deleteDeposit(b.dataset.id)));
}

// ── Fee Breakdown ─────────────────────────────────────────────────────────

function renderFeeBreakdown() {
  // Totals by fee type
  const totals = { commission: 0, clearingFee: 0, exchangeFee: 0, nfaFee: 0, platformFee: 0, coqPlatform: 0, coqMarketData: 0, wireFee: 0 };
  _trades.forEach(t => {
    totals.commission    += t.fees?.commission  || 0;
    totals.clearingFee   += t.fees?.clearingFee || 0;
    totals.exchangeFee   += t.fees?.exchangeFee || 0;
    totals.nfaFee        += t.fees?.nfaFee      || 0;
    totals.platformFee   += t.fees?.platformFee || 0;
    totals.coqPlatform   += t.coq?.platform     || 0;
    totals.coqMarketData += t.coq?.marketData   || 0;
  });
  // CQG/wire fees are stored as withdrawal entries in deposits, not on individual trades
  _deposits.forEach(d => {
    if (d.type !== 'withdrawal') return;
    const n = (d.notes || '').toLowerCase();
    if (n.includes('cqg platform') || n.includes('coq platform'))       totals.coqPlatform   += d.amount;
    else if (n.includes('cqg market') || n.includes('coq market'))      totals.coqMarketData += d.amount;
    else if (n.includes('wire'))                                         totals.wireFee       += d.amount;
  });
  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);

  const byTypeEl = document.getElementById('fees-by-type');
  byTypeEl.innerHTML = [
    ['Commission',    totals.commission],
    ['Clearing Fee',  totals.clearingFee],
    ['Exchange Fee',  totals.exchangeFee],
    ['NFA Fee',       totals.nfaFee],
    ['Platform Fee',  totals.platformFee],
    ['CQG Platform',  totals.coqPlatform],
    ['CQG Mkt Data',  totals.coqMarketData],
    ['Wire Fee',      totals.wireFee],
  ].map(([label, val]) => {
    const pct = grandTotal > 0 ? (val / grandTotal * 100) : 0;
    return `<div class="an-row">
      <span class="an-label">${label}</span>
      <div class="an-bar-wrap"><div class="an-bar an-bar-red" style="width:${pct.toFixed(1)}%"></div></div>
      <span class="an-val">${fmt(val)}</span>
    </div>`;
  }).join('');

  // Fees by symbol
  const syms = ['MNQ', 'MGC', 'MES', 'MCL'];
  const symFees = {};
  syms.forEach(s => symFees[s] = 0);
  _trades.forEach(t => {
    const sym = t.symbol;
    if (symFees[sym] !== undefined) {
      symFees[sym] += (t.fees?.total || 0) + (t.coq?.platform || 0) + (t.coq?.marketData || 0);
    }
  });
  const maxSymFee = Math.max(...Object.values(symFees), 0.01);
  const bySymEl = document.getElementById('fees-by-symbol');
  bySymEl.innerHTML = syms.map(s => {
    const pct = (symFees[s] / maxSymFee * 100);
    return `<div class="an-row">
      <span class="an-label">${s}</span>
      <div class="an-bar-wrap"><div class="an-bar an-bar-red" style="width:${pct.toFixed(1)}%"></div></div>
      <span class="an-val">${fmt(symFees[s])}</span>
    </div>`;
  }).join('');

  // Per-contract averages
  const perC = { commission: 0, clearingFee: 0, exchangeFee: 0, nfaFee: 0, platformFee: 0 };
  let pcCount = 0;
  _trades.forEach(t => {
    const q = Math.max(t.buy || 0, t.sell || 0);
    if (!q) return;
    pcCount++;
    perC.commission  += (t.fees?.perContract?.commission  || 0);
    perC.clearingFee += (t.fees?.perContract?.clearingFee || 0);
    perC.exchangeFee += (t.fees?.perContract?.exchangeFee || 0);
    perC.nfaFee      += (t.fees?.perContract?.nfaFee      || 0);
    perC.platformFee += (t.fees?.perContract?.platformFee || 0);
  });
  const pcEl = document.getElementById('fees-per-contract');
  if (!pcCount) {
    pcEl.innerHTML = '<div style="color:var(--text-dim)">No trade data yet.</div>';
  } else {
    const avg = k => '$' + (perC[k] / pcCount).toFixed(4);
    pcEl.innerHTML = [
      ['Commission',   avg('commission')],
      ['Clearing Fee', avg('clearingFee')],
      ['Exchange Fee', avg('exchangeFee')],
      ['NFA Fee',      avg('nfaFee')],
      ['Platform Fee', avg('platformFee')],
    ].map(([k, v]) => `<div class="an-row-plain"><span class="an-key">${k}</span><span class="an-val2">${v}</span></div>`).join('');
  }

  // Fee impact
  const grossPnl = _trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const netPnl   = grossPnl - grandTotal;
  const impactEl = document.getElementById('fees-impact');
  impactEl.innerHTML = [
    ['Gross P&L',        fmt(grossPnl)],
    ['Total Fees',       fmt(grandTotal)],
    ['Net P&L',          fmt(netPnl)],
    ['Fees as % of Gross', grandTotal > 0 && grossPnl !== 0 ? (Math.abs(grandTotal / grossPnl) * 100).toFixed(1) + '%' : '—'],
    ['Avg Fee / Trade',  _trades.length ? fmt(grandTotal / _trades.length) : '—'],
  ].map(([k, v]) => `<div class="an-row-plain"><span class="an-key">${k}</span><span class="an-val2">${v}</span></div>`).join('');
}

// ── Analysis ──────────────────────────────────────────────────────────────

function renderAnalysis() {
  const syms = ['MNQ', 'MGC', 'MES', 'MCL'];

  // P&L by symbol
  const symPnl  = {};
  const symWins = {};
  const symTot  = {};
  syms.forEach(s => { symPnl[s] = 0; symWins[s] = 0; symTot[s] = 0; });
  _trades.forEach(t => {
    if (symPnl[t.symbol] !== undefined) {
      const fees = (t.fees?.total || 0) + (t.coq?.platform || 0) + (t.coq?.marketData || 0);
      symPnl[t.symbol]  += (t.pnl || 0) - fees;
      symTot[t.symbol]  += 1;
      if (t.pnl > 0) symWins[t.symbol] += 1;
    }
  });
  const maxAbsPnl = Math.max(...syms.map(s => Math.abs(symPnl[s])), 0.01);

  const pnlEl = document.getElementById('analysis-by-symbol');
  pnlEl.innerHTML = syms.map(s => {
    const pct   = (Math.abs(symPnl[s]) / maxAbsPnl * 100);
    const barCls = symPnl[s] >= 0 ? 'an-bar-green' : 'an-bar-red';
    const valCls = symPnl[s] >= 0 ? 'ra-pos' : symPnl[s] < 0 ? 'ra-neg' : '';
    return `<div class="an-row">
      <span class="an-label">${s}</span>
      <div class="an-bar-wrap"><div class="an-bar ${barCls}" style="width:${pct.toFixed(1)}%"></div></div>
      <span class="an-val ${valCls}">${fmt(symPnl[s])}</span>
    </div>`;
  }).join('');

  // Win rate by symbol
  const wrEl = document.getElementById('analysis-winrate');
  wrEl.innerHTML = syms.map(s => {
    const wr  = symTot[s] > 0 ? (symWins[s] / symTot[s] * 100) : 0;
    const lbl = symTot[s] > 0 ? wr.toFixed(0) + '%' : '—';
    return `<div class="an-row">
      <span class="an-label">${s}</span>
      <div class="an-bar-wrap"><div class="an-bar" style="width:${wr.toFixed(1)}%"></div></div>
      <span class="an-val">${lbl}</span>
    </div>`;
  }).join('');

  // Monthly P&L
  const monthly = {};
  _trades.forEach(t => {
    const m = t.date.slice(0, 7);
    if (!monthly[m]) monthly[m] = 0;
    const fees = (t.fees?.total || 0) + (t.coq?.platform || 0) + (t.coq?.marketData || 0);
    monthly[m] += (t.pnl || 0) - fees;
  });
  const months = Object.keys(monthly).sort();
  const maxAbs = Math.max(...months.map(m => Math.abs(monthly[m])), 0.01);
  const monthEl = document.getElementById('analysis-monthly');
  monthEl.innerHTML = months.length
    ? months.map(m => {
        const v      = monthly[m];
        const pct    = (Math.abs(v) / maxAbs * 100);
        const barCls = v >= 0 ? 'an-bar-green' : 'an-bar-red';
        const valCls = v >= 0 ? 'ra-pos' : 'ra-neg';
        return `<div class="an-row">
          <span class="an-label">${m}</span>
          <div class="an-bar-wrap"><div class="an-bar ${barCls}" style="width:${pct.toFixed(1)}%"></div></div>
          <span class="an-val ${valCls}">${fmt(v)}</span>
        </div>`;
      }).join('')
    : '<div style="color:var(--text-dim)">No trades yet.</div>';

  // Best & worst trades
  const sorted    = [..._trades].sort((a, b) => (b.pnl || 0) - (a.pnl || 0));
  const best3     = sorted.slice(0, 3);
  const worst3    = sorted.slice(-3).reverse();
  const extremeEl = document.getElementById('analysis-extremes');
  extremeEl.innerHTML = `
    <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Best</div>
    ${best3.map(t => `<div class="an-row-plain">
      <span class="an-key">${t.date} <span class="ra-sym" style="font-size:9px">${t.symbol}</span></span>
      <span class="an-val2 ra-pos">${fmt(t.pnl)}</span>
    </div>`).join('') || '<div style="color:var(--text-dim)">—</div>'}
    <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin:10px 0 6px">Worst</div>
    ${worst3.map(t => `<div class="an-row-plain">
      <span class="an-key">${t.date} <span class="ra-sym" style="font-size:9px">${t.symbol}</span></span>
      <span class="an-val2 ra-neg">${fmt(t.pnl)}</span>
    </div>`).join('') || '<div style="color:var(--text-dim)">—</div>'}
  `;
}

// ── Tabs ──────────────────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll('.ra-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ra-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.ra-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab)?.classList.add('active');
    });
  });
}

// ── Filters ───────────────────────────────────────────────────────────────

function setupFilters() {
  document.getElementById('filter-symbol')?.addEventListener('change', renderTrades);
  document.getElementById('filter-result')?.addEventListener('change', renderTrades);
}

// ── Trade form ────────────────────────────────────────────────────────────

function setupTradeForm() {
  document.getElementById('btn-add-trade')?.addEventListener('click', () => openTradeForm(null));
  document.getElementById('tf-cancel')?.addEventListener('click', () => {
    document.getElementById('trade-form-wrap').style.display = 'none';
  });
  document.getElementById('tf-save')?.addEventListener('click', saveTrade);
}

function openTradeForm(id) {
  const wrap  = document.getElementById('trade-form-wrap');
  const title = document.getElementById('trade-form-title');
  wrap.style.display = '';
  clearTradeForm();

  if (id) {
    const t = _trades.find(x => x.id === id);
    if (!t) return;
    title.textContent = 'Edit Trade';
    document.getElementById('tf-id').value        = t.id;
    document.getElementById('tf-date').value      = t.date;
    document.getElementById('tf-symbol').value    = t.symbol;
    document.getElementById('tf-buy').value       = t.buy || '';
    document.getElementById('tf-sell').value      = t.sell || '';
    document.getElementById('tf-pnl').value       = t.pnl ?? '';
    document.getElementById('tf-cashout').value   = t.cashOut || '';
    document.getElementById('tf-fee-comm').value  = t.fees?.commission  || '';
    document.getElementById('tf-fee-clear').value = t.fees?.clearingFee || '';
    document.getElementById('tf-fee-exch').value  = t.fees?.exchangeFee || '';
    document.getElementById('tf-fee-nfa').value   = t.fees?.nfaFee      || '';
    document.getElementById('tf-fee-plat').value  = t.fees?.platformFee || '';
    document.getElementById('tf-coq-plat').value  = t.coq?.platform     || '';
    document.getElementById('tf-coq-mkt').value   = t.coq?.marketData   || '';
    document.getElementById('tf-notes').value     = t.notes || '';
  } else {
    title.textContent = 'Add Trade';
    document.getElementById('tf-date').value = new Date().toISOString().slice(0, 10);
  }
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearTradeForm() {
  ['tf-id','tf-date','tf-symbol','tf-buy','tf-sell','tf-pnl','tf-cashout',
   'tf-fee-comm','tf-fee-clear','tf-fee-exch','tf-fee-nfa','tf-fee-plat',
   'tf-coq-plat','tf-coq-mkt','tf-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.tagName !== 'SELECT') el.value = '';
  });
}

async function saveTrade() {
  const get = id => document.getElementById(id)?.value?.trim();
  const fNum = id => parseFloat(get(id)) || 0;
  const comm  = fNum('tf-fee-comm');
  const clear = fNum('tf-fee-clear');
  const exch  = fNum('tf-fee-exch');
  const nfa   = fNum('tf-fee-nfa');
  const plat  = fNum('tf-fee-plat');
  const qty   = Math.max(fNum('tf-buy'), fNum('tf-sell'));

  const body = {
    id:      get('tf-id') || undefined,
    date:    get('tf-date'),
    symbol:  get('tf-symbol'),
    buy:     fNum('tf-buy'),
    sell:    fNum('tf-sell'),
    pnl:     fNum('tf-pnl'),
    cashOut: fNum('tf-cashout'),
    fees: {
      commission:  comm,
      clearingFee: clear,
      exchangeFee: exch,
      nfaFee:      nfa,
      platformFee: plat,
      total:       comm + clear + exch + nfa + plat,
      perContract: qty > 0 ? {
        commission:  comm  / qty,
        clearingFee: clear / qty,
        exchangeFee: exch  / qty,
        nfaFee:      nfa   / qty,
        platformFee: plat  / qty,
      } : { commission: 0, clearingFee: 0, exchangeFee: 0, nfaFee: 0, platformFee: 0 },
    },
    coq: { platform: fNum('tf-coq-plat'), marketData: fNum('tf-coq-mkt') },
    notes: get('tf-notes'),
  };

  await fetch(`${BASE}/api/realaccount/trade`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  document.getElementById('trade-form-wrap').style.display = 'none';
  await load();
}

async function deleteTrade(id) {
  if (!confirm('Delete this trade?')) return;
  await fetch(`${BASE}/api/realaccount/trade/${id}`, { method: 'DELETE' });
  await load();
}

// ── Deposit form ──────────────────────────────────────────────────────────

function setupDepositForm() {
  document.getElementById('btn-add-deposit')?.addEventListener('click', () => openDepositForm(null));
  document.getElementById('df-cancel')?.addEventListener('click', () => {
    document.getElementById('deposit-form-wrap').style.display = 'none';
  });
  document.getElementById('df-save')?.addEventListener('click', saveDeposit);
}

function openDepositForm(id) {
  const wrap  = document.getElementById('deposit-form-wrap');
  const title = document.getElementById('deposit-form-title');
  wrap.style.display = '';

  if (id) {
    const d = _deposits.find(x => x.id === id);
    if (!d) return;
    title.textContent = 'Edit Entry';
    document.getElementById('df-id').value     = d.id;
    document.getElementById('df-date').value   = d.date;
    document.getElementById('df-type').value   = d.type;
    document.getElementById('df-amount').value = d.amount;
    document.getElementById('df-notes').value  = d.notes || '';
  } else {
    title.textContent = 'Add Deposit / Withdrawal';
    document.getElementById('df-id').value     = '';
    document.getElementById('df-date').value   = new Date().toISOString().slice(0, 10);
    document.getElementById('df-type').value   = 'deposit';
    document.getElementById('df-amount').value = '';
    document.getElementById('df-notes').value  = '';
  }
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveDeposit() {
  const get = id => document.getElementById(id)?.value?.trim();
  const body = {
    id:     get('df-id') || undefined,
    date:   get('df-date'),
    type:   get('df-type'),
    amount: parseFloat(get('df-amount')) || 0,
    notes:  get('df-notes'),
  };
  await fetch(`${BASE}/api/realaccount/deposit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  document.getElementById('deposit-form-wrap').style.display = 'none';
  await load();
}

async function deleteDeposit(id) {
  if (!confirm('Delete this entry?')) return;
  await fetch(`${BASE}/api/realaccount/deposit/${id}`, { method: 'DELETE' });
  await load();
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmt(val) {
  const n = parseFloat(val) || 0;
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ── Init ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', boot);
