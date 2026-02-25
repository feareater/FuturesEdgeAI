'use strict';
// start-shared.js — starts the FuturesEdge server + a Cloudflare public tunnel.
// Run with:  node start-shared.js   OR   npm run share
// Press Ctrl+C to stop both.
//
// Smart behaviour:
//   • If nothing is on :3000, starts the server then opens the tunnel.
//   • If a server is already running on :3000, skips spawning and just tunnels.
//   • Tunnel never opens unless /api/health responds 200.

const { spawn } = require('child_process');
const http      = require('http');

let server, tunnel;
let _tunnelStarted = false;

// ── health check ─────────────────────────────────────────────────────────────

function checkHealth(cb) {
  const req = http.get('http://localhost:3000/api/health', (res) => {
    res.resume();                    // drain body
    cb(res.statusCode === 200);
  });
  req.on('error', () => cb(false));
  req.setTimeout(2000, () => { req.destroy(); cb(false); });
}

// Retry health check every 500 ms for up to `maxMs` milliseconds.
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

// ── tunnel ────────────────────────────────────────────────────────────────────

function startTunnel() {
  if (_tunnelStarted) return;
  _tunnelStarted = true;

  console.log('[launcher] Opening Cloudflare tunnel to port 3000…\n');
  tunnel = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:3000'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  function handleOutput(data) {
    const text = data.toString();

    text.split('\n').forEach(line => {
      if (line.includes('trycloudflare.com') || line.includes('ERR') || line.includes('Registered')) {
        process.stdout.write(line + '\n');
      }
    });

    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      const url = match[0];
      console.log('\n' + '═'.repeat(60));
      console.log('  ✅  DASHBOARD IS PUBLIC');
      console.log('');
      console.log(`  Share this URL with anyone:  ${url}`);
      console.log('');
      console.log('  ⚠  URL changes each time this script restarts.');
      console.log('  Press Ctrl+C to stop and close the tunnel.');
      console.log('═'.repeat(60) + '\n');
    }
  }

  tunnel.stdout.on('data', handleOutput);
  tunnel.stderr.on('data', handleOutput);
  tunnel.on('exit', (code) => {
    if (code !== null) console.log(`[launcher] Tunnel closed (code ${code})`);
  });
}

// ── server ────────────────────────────────────────────────────────────────────

function startServer() {
  console.log('[launcher] Starting FuturesEdge server…');
  server = spawn('node', ['server/index.js'], { stdio: 'inherit' });

  server.on('exit', (code) => {
    if (code === 1) {
      // Likely EADDRINUSE — check whether an existing server is healthy
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

  // Wait up to 10 s for the server to become healthy before opening the tunnel.
  console.log('[launcher] Waiting for server to be ready…');
  waitForHealth(10_000, (ok) => {
    if (ok) {
      startTunnel();
    } else {
      // server.on('exit') will handle the failure path (e.g. EADDRINUSE)
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
