'use strict';
// start-shared.js — starts the FuturesEdge server + an ngrok public tunnel.
// Run with:  node start-shared.js   OR   npm run share
// Press Ctrl+C to stop both.
//
// Smart behaviour:
//   • If nothing is on :3000, starts the server then opens the tunnel.
//   • If a server is already running on :3000, skips spawning and just tunnels.
//   • URL is read from ngrok's local API (http://localhost:4040/api/tunnels).

const { spawn } = require('child_process');
const http      = require('http');

let server, tunnel;
let _tunnelStarted = false;

// ── helpers ───────────────────────────────────────────────────────────────────

function checkHealth(cb) {
  const req = http.get('http://localhost:3000/api/health', (res) => {
    res.resume();
    cb(res.statusCode === 200);
  });
  req.on('error', () => cb(false));
  req.setTimeout(2000, () => { req.destroy(); cb(false); });
}

function waitForHealth(maxMs, cb) {
  const deadline = Date.now() + maxMs;
  function attempt() {
    checkHealth((ok) => {
      if (ok) return cb(true);
      if (Date.now() >= deadline) return cb(false);
      setTimeout(attempt, 500);
    });
  }
  attempt();
}

// Poll ngrok's local API until we get the HTTPS public URL.
function waitForNgrokUrl(maxMs, cb) {
  const deadline = Date.now() + maxMs;
  function attempt() {
    const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const { tunnels } = JSON.parse(body);
          const t = tunnels.find(t => t.proto === 'https');
          if (t) return cb(t.public_url);
        } catch (_) {}
        if (Date.now() >= deadline) return cb(null);
        setTimeout(attempt, 1000);
      });
    });
    req.on('error', () => {
      if (Date.now() >= deadline) return cb(null);
      setTimeout(attempt, 1000);
    });
    req.setTimeout(2000, () => { req.destroy(); });
  }
  setTimeout(attempt, 1500);   // give ngrok a moment to start its API
}

// ── tunnel ────────────────────────────────────────────────────────────────────

function startTunnel() {
  if (_tunnelStarted) return;
  _tunnelStarted = true;

  console.log('[launcher] Starting ngrok tunnel to port 3000…');
  tunnel = spawn('ngrok', ['http', '3000'], { stdio: 'ignore' });

  tunnel.on('exit', (code) => {
    if (code !== null) console.log(`[launcher] Tunnel closed (code ${code})`);
  });

  console.log('[launcher] Waiting for ngrok URL…');
  waitForNgrokUrl(20_000, (url) => {
    if (!url) {
      console.error('[launcher] Could not retrieve ngrok URL. Is ngrok authenticated? Run: ngrok config add-authtoken <token>');
      return;
    }
    console.log('\n' + '═'.repeat(60));
    console.log('  ✅  DASHBOARD IS PUBLIC');
    console.log('');
    console.log(`  Share this URL with anyone:  ${url}`);
    console.log('');
    console.log('  ⚠  URL changes each time this script restarts.');
    console.log('  Press Ctrl+C to stop and close the tunnel.');
    console.log('═'.repeat(60) + '\n');
  });
}

// ── server ────────────────────────────────────────────────────────────────────

function startServer() {
  console.log('[launcher] Starting FuturesEdge server…');
  server = spawn('node', ['server/index.js'], { stdio: 'inherit' });

  server.on('exit', (code) => {
    if (code === 1) {
      console.log('[launcher] Server spawn failed — checking for existing server on :3000…');
      checkHealth((ok) => {
        if (ok) {
          console.log('[launcher] Existing healthy server found — proceeding with tunnel.');
          startTunnel();
        } else {
          console.error('[launcher] No healthy server on :3000. Check the error above, then retry.');
          if (tunnel) tunnel.kill();
          process.exit(1);
        }
      });
    } else if (code !== null) {
      console.log(`[launcher] Server exited (code ${code})`);
    }
  });

  console.log('[launcher] Waiting for server to be ready…');
  waitForHealth(10_000, (ok) => {
    if (ok) {
      startTunnel();
    } else {
      console.log('[launcher] Server not yet ready — waiting for exit event…');
    }
  });
}

// ── shutdown ──────────────────────────────────────────────────────────────────

function shutdown() {
  console.log('\n[launcher] Shutting down…');
  if (tunnel) tunnel.kill();
  if (server) server.kill();
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ── entry point ───────────────────────────────────────────────────────────────

console.log('[launcher] Checking for existing server on :3000…');
checkHealth((running) => {
  if (running) {
    console.log('[launcher] Server already running on :3000 — skipping server start.');
    startTunnel();
  } else {
    startServer();
  }
});
