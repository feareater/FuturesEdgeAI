'use strict';
// One-time seed script — populates Real Account tracker from spreadsheet data.
// Run: node scripts/seed-realaccount.js

const BASE = 'http://localhost:3000';

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ── Per-round-turn fee rates by symbol ────────────────────────────────────
// (buy + sell counted as one round turn per contract)
const RATES = {
  MNQ: { comm: 0.50, clear: 0.18, exch: 0.70, nfa: 0.04, plat: 0.20 },
  MES: { comm: 0.50, clear: 0.18, exch: 0.70, nfa: 0.04, plat: 0.20 },
  MCL: { comm: 0.50, clear: 0.18, exch: 1.00, nfa: 0.04, plat: 0.20 },
  MGC: { comm: 0.50, clear: 0.18, exch: 1.20, nfa: 0.04, plat: 0.20 },
};

function mkTrade(date, symbol, qty, pnl, cashOut = 0, notes = '') {
  const r = RATES[symbol];
  const total = (r.comm + r.clear + r.exch + r.nfa + r.plat) * qty;
  return {
    date, symbol,
    buy: qty, sell: qty,
    pnl,
    cashOut,
    notes,
    fees: {
      commission:  +(r.comm  * qty).toFixed(2),
      clearingFee: +(r.clear * qty).toFixed(2),
      exchangeFee: +(r.exch  * qty).toFixed(2),
      nfaFee:      +(r.nfa   * qty).toFixed(2),
      platformFee: +(r.plat  * qty).toFixed(2),
      total:       +total.toFixed(2),
      perContract: { commission: r.comm, clearingFee: r.clear, exchangeFee: r.exch, nfaFee: r.nfa, platformFee: r.plat },
    },
    coq: { platform: 0, marketData: 0 },
  };
}

// ── Deposits, withdrawals, and account-level charges ─────────────────────
// These appear in the CQG PLATFORM / CQG MARKET DATA / WIRE FEE / CASH OUT
// columns in the spreadsheet (not tied to individual trades).
const deposits = [
  // ── Initial funding ──────────────────────────────────────────────────────
  { date: '2026-01-29', type: 'deposit',    amount: 1000.00, notes: 'Initial account funding' },

  // ── CQG monthly fees (first charge — deducted before first trade) ────────
  { date: '2026-01-29', type: 'withdrawal', amount:   10.00, notes: 'CQG Platform fee (Jan)' },
  { date: '2026-01-29', type: 'withdrawal', amount:    9.00, notes: 'CQG Market Data fee (Jan)' },

  // ── CQG monthly fees (second charge — deducted ~2/1/2026) ───────────────
  { date: '2026-02-01', type: 'withdrawal', amount:   10.00, notes: 'CQG Platform fee (Feb)' },
  { date: '2026-02-01', type: 'withdrawal', amount:    9.00, notes: 'CQG Market Data fee (Feb)' },

  // ── Wire fee + cash-out (after 2/5/2026 MGC trade) ──────────────────────
  { date: '2026-02-05', type: 'withdrawal', amount:   40.00, notes: 'Wire transfer fee' },
  { date: '2026-02-05', type: 'withdrawal', amount:  500.00, notes: 'Cash out / withdrawal' },
];

// ── Trade log ─────────────────────────────────────────────────────────────
// Format: mkTrade(date, symbol, contracts, grossPnl, cashOut, notes)
// P&L values are GROSS (before futures fees are deducted), matching the
// "P&L" column in the spreadsheet. Fee columns are already broken out separately.
const trades = [
  // ── January 2026 ─────────────────────────────────────────────────────────
  mkTrade('2026-01-29', 'MNQ',  2,    -2.00),
  mkTrade('2026-01-30', 'MNQ',  1,   164.50),
  mkTrade('2026-01-30', 'MCL',  3,    75.00),

  // ── February 2026 ────────────────────────────────────────────────────────
  mkTrade('2026-02-02', 'MCL',  4,    88.00),
  mkTrade('2026-02-03', 'MNQ', 17,  -298.00),
  mkTrade('2026-02-03', 'MGC', 16,   763.00),
  mkTrade('2026-02-04', 'MGC',  6,    79.00),
  mkTrade('2026-02-05', 'MGC',  6,   174.00),
  mkTrade('2026-02-06', 'MNQ',  4,   162.00),
  mkTrade('2026-02-06', 'MGC',  7,  -346.00),
  mkTrade('2026-02-06', 'MCL',  2,    44.00),
  mkTrade('2026-02-09', 'MNQ',  2,   -39.50),
  mkTrade('2026-02-09', 'MGC',  1,    75.00),
  mkTrade('2026-02-09', 'MCL',  2,   -24.00),
  mkTrade('2026-02-10', 'MNQ',  8,   314.00),
  mkTrade('2026-02-10', 'MGC',  4,  -213.00),
  mkTrade('2026-02-10', 'MCL',  1,     9.00),
  mkTrade('2026-02-11', 'MNQ', 54,   193.50),
  mkTrade('2026-02-11', 'MGC',  5,   -59.00),
  mkTrade('2026-02-12', 'MES',  2,    21.00),
  mkTrade('2026-02-12', 'MNQ', 67,    47.50),
  mkTrade('2026-02-12', 'MGC',  2,  -251.00),
  mkTrade('2026-02-13', 'MNQ', 24,   -20.50),
  mkTrade('2026-02-17', 'MNQ', 10,  -254.00),
  mkTrade('2026-02-18', 'MNQ',  3,    36.50),
  mkTrade('2026-02-23', 'MNQ',  1,  -114.00),
  mkTrade('2026-02-27', 'MNQ',  2,    50.50),
];

// ── Verification targets (from spreadsheet) ───────────────────────────────
// Gross P&L:    $675.50
// Total futures fees: $441.82
// Account charges: $578.00 (CQG $38 + Wire $40 + Cash Out $500)
// Final balance:  $655.68

async function run() {
  console.log('Seeding real account tracker...\n');

  console.log(`Posting ${deposits.length} deposit/withdrawal entries...`);
  for (const d of deposits) {
    await post('/api/realaccount/deposit', d);
    process.stdout.write('.');
  }
  console.log('\nDone.\n');

  console.log(`Posting ${trades.length} trades...`);
  for (const t of trades) {
    await post('/api/realaccount/trade', t);
    process.stdout.write('.');
  }
  console.log('\nDone.\n');

  // Verify
  const r    = await fetch(`${BASE}/api/realaccount`);
  const data = await r.json();

  const grossPnl    = data.trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const futuresFees = data.trades.reduce((s, t) => s + (t.fees?.total || 0), 0);
  const deposited   = data.deposits.filter(d => d.type === 'deposit').reduce((s, d) => s + d.amount, 0);
  const withdrawn   = data.deposits.filter(d => d.type === 'withdrawal').reduce((s, d) => s + d.amount, 0);
  const netPnl      = grossPnl - futuresFees;
  const currentBal  = deposited - withdrawn + netPnl;

  console.log('=== Verification ===');
  console.log(`Trades:        ${data.trades.length}    (expected 27)`);
  console.log(`Gross P&L:     $${grossPnl.toFixed(2).padStart(8)}  (expected $675.50)`);
  console.log(`Futures fees: -$${futuresFees.toFixed(2).padStart(8)}  (expected $441.82)`);
  console.log(`Deposited:     $${deposited.toFixed(2).padStart(8)}  (expected $1000.00)`);
  console.log(`Withdrawn:    -$${withdrawn.toFixed(2).padStart(8)}  (expected $578.00)`);
  console.log(`Current bal:   $${currentBal.toFixed(2).padStart(8)}  (expected $655.68)`);
}

run().catch(console.error);
