'use strict';
// start-shared.js — starts the FuturesEdge server + a Cloudflare public tunnel.
// Run with:  node start-shared.js
// Press Ctrl+C to stop both.

const { spawn } = require('child_process');

let server, tunnel;

function startServer() {
  console.log('[launcher] Starting FuturesEdge server…');
  server = spawn('node', ['server/index.js'], { stdio: 'inherit' });
  server.on('exit', (code) => {
    if (code !== null) console.log(`[launcher] Server exited (code ${code})`);
  });
}

function startTunnel() {
  // Give the server a moment to bind before opening the tunnel
  setTimeout(() => {
    console.log('[launcher] Opening Cloudflare tunnel to port 3000…\n');
    tunnel = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:3000'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    function handleOutput(data) {
      const text = data.toString();

      // Print cloudflared's own log lines (filtered to useful ones)
      text.split('\n').forEach(line => {
        if (line.includes('trycloudflare.com') || line.includes('ERR') || line.includes('Registered')) {
          process.stdout.write(line + '\n');
        }
      });

      // Extract and prominently display the public URL
      const match = text.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
      if (match) {
        const url = match[0];
        console.log('\n' + '═'.repeat(58));
        console.log('  ✅  DASHBOARD IS PUBLIC');
        console.log('');
        console.log(`  Share this URL with anyone:  ${url}`);
        console.log('');
        console.log('  ⚠  URL changes each time this script restarts.');
        console.log('  Press Ctrl+C to stop and close the tunnel.');
        console.log('═'.repeat(58) + '\n');
      }
    }

    tunnel.stdout.on('data', handleOutput);
    tunnel.stderr.on('data', handleOutput);

    tunnel.on('exit', (code) => {
      if (code !== null) console.log(`[launcher] Tunnel closed (code ${code})`);
    });
  }, 2000);
}

function shutdown() {
  console.log('\n[launcher] Shutting down…');
  if (tunnel) tunnel.kill();
  if (server) server.kill();
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

startServer();
startTunnel();
