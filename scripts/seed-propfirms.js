'use strict';
// One-time seed script — populates prop firm tracker from spreadsheet data.
// Run: node scripts/seed-propfirms.js

const BASE = 'http://localhost:3000';

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

const accounts = [
  { firm: 'Apex',               date: '2025-10-16', cost: 37.40,  status: 'failed' },
  { firm: 'Apex',               date: '2025-10-27', cost: 37.40,  status: 'failed' },
  { firm: 'Apex',               date: '2025-11-13', cost: 40.00,  status: 'failed' },
  { firm: 'Apex',               date: '2025-11-28', cost: 59.40,  status: 'failed' },
  { firm: 'Apex',               date: '2025-12-27', cost: 148.50, status: 'failed' },
  { firm: 'Apex',               date: '2026-01-22', cost: 65.00,  status: 'failed' },
  { firm: 'Apex',               date: '2026-01-22', cost: 39.20,  status: 'failed' },
  { firm: 'Apex',               date: '2026-01-27', cost: 19.70,  status: 'failed' },
  { firm: 'Apex',               date: '2026-01-27', cost: 19.70,  status: 'failed' },
  { firm: 'FFN',                date: '2025-11-28', cost: 87.50,  status: 'failed' },
  { firm: 'FFN',                date: '2026-01-23', cost: 87.50,  status: 'failed' },
  { firm: 'FFN',                date: '2026-01-23', cost: 87.50,  status: 'failed' },
  { firm: 'My Funded Future',   date: '2025-11-28', cost: 113.50, status: 'failed' },
  { firm: 'My Funded Future',   date: '2025-12-28', cost: 227.00, status: 'failed' },
  { firm: 'The Legends',        date: '2025-11-28', cost: 99.00,  status: 'failed' },
  { firm: 'Tradeify',           date: '2025-11-28', cost: 83.40,  status: 'failed' },
  { firm: 'Take Profit Trader', date: '2025-10-26', cost: 102.00, status: 'failed' },
  { firm: 'Take Profit Trader', date: '2025-11-28', cost: 119.00, status: 'failed' },
  { firm: 'Take Profit Trader', date: '2025-12-28', cost: 119.00, status: 'failed' },
  { firm: 'Take Profit Trader', date: '2026-01-22', cost: 100.00, status: 'failed' },
  { firm: 'Take Profit Trader', date: '2026-01-27', cost: 100.00, status: 'failed' },
  { firm: 'Take Profit Trader', date: '2026-01-28', cost: 119.00, status: 'failed' },
  { firm: 'Take Profit Trader', date: '2026-02-16', cost: 102.00, status: 'failed' },
  { firm: 'AlgoOne',            date: '2026-02-14', cost: 440.00, status: 'active' },
  { firm: 'Top Step',           date: '2026-02-16', cost: 76.30,  status: 'active' },
  { firm: 'Trade Day',          date: '2026-02-16', cost: 122.40, status: 'active' },
  { firm: 'Apex',               date: '2026-02-17', cost: 39.70,  status: 'failed' },
  { firm: 'Take Profit Trader', date: '2026-02-17', cost: 649.00, status: 'active' },
  { firm: 'Apex',               date: '2026-03-02', cost: 29.55,  status: 'passed' },
  { firm: 'Apex',               date: '2026-03-02', cost: 29.55,  status: 'failed' },
  { firm: 'Apex',               date: '2026-03-02', cost: 29.55,  status: 'failed' },
  { firm: 'Apex',               date: '2026-03-02', cost: 29.55,  status: 'failed' },
  { firm: 'Apex',               date: '2026-03-02', cost: 29.55,  status: 'active' },
  { firm: 'Take Profit Trader', date: '2026-03-04', cost: 100.00, status: 'active' },
];

const expenses = [
  { item: 'Affordable Indicators', date: '2025-01-12', amount: 295.00,  notes: 'One-time purchase' },
  { item: 'TradingView',           date: '2025-01-28', amount: 216.96,  notes: 'Subscription' },
  { item: 'Trade Phantoms',        date: '2025-10-03', amount: 329.00,  notes: 'One-time purchase' },
  { item: 'TradingView',           date: '2025-08-29', amount: 677.88,  notes: 'Subscription' },
  { item: 'Initial Investment',    date: '2026-01-29', amount: 1000.00, notes: 'Starting capital allocation' },
];

const payouts = [
  { firm: 'Payout', date: '2026-02-05', amount: 500.00,  notes: '' },
  { firm: 'Payout', date: '2026-02-11', amount: 1159.00, notes: '' },
  { firm: 'Payout', date: '2026-02-12', amount: 1040.00, notes: '' },
];

async function run() {
  console.log('Seeding prop firm tracker...\n');

  console.log(`Posting ${accounts.length} accounts...`);
  for (const a of accounts) {
    await post('/api/propfirms/account', { ...a, accountSize: 50000 });
    process.stdout.write('.');
  }
  console.log('\nDone.\n');

  console.log(`Posting ${expenses.length} expenses...`);
  for (const e of expenses) {
    await post('/api/propfirms/expense', e);
    process.stdout.write('.');
  }
  console.log('\nDone.\n');

  console.log(`Posting ${payouts.length} payouts...`);
  for (const p of payouts) {
    await post('/api/propfirms/payout', p);
    process.stdout.write('.');
  }
  console.log('\nDone.\n');

  // Verify totals
  const r    = await fetch(`${BASE}/api/propfirms`);
  const data = await r.json();
  const firmSpend = data.accounts.reduce((s, a) => s + a.cost, 0);
  const expSpend  = data.expenses.reduce((s, e) => s + e.amount, 0);
  const payTotal  = data.payouts.reduce((s, p) => s + p.amount, 0);
  console.log('=== Verification ===');
  console.log(`Accounts:  ${data.accounts.length}  |  Firm spend:  $${firmSpend.toFixed(2)}  (expected $3,587.85)`);
  console.log(`Expenses:  ${data.expenses.length}  |  Exp spend:   $${expSpend.toFixed(2)}  (expected $2,518.84)`);
  console.log(`Payouts:   ${data.payouts.length}  |  Payouts:     $${payTotal.toFixed(2)}  (expected $2,699.00)`);
  console.log(`Net cost:  $${(firmSpend + expSpend - payTotal).toFixed(2)}  (expected $3,407.69)`);
}

run().catch(console.error);
