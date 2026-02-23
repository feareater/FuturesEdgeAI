'use strict';

require('dotenv').config();

const http    = require('http');
const path    = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { authenticate }    = require('./auth/tradovate');
const { getCandles }      = require('./data/snapshot');

const PORT        = process.env.PORT        || 3000;
const DATA_SOURCE = process.env.DATA_SOURCE || 'seed';

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', dataSource: DATA_SOURCE, ts: new Date().toISOString() });
});

// GET /api/candles?symbol=MNQ&timeframe=5m
app.get('/api/candles', (req, res) => {
  const { symbol = 'MNQ', timeframe = '5m' } = req.query;
  try {
    const candles = getCandles(symbol, timeframe);
    console.log(`[api] /candles  symbol=${symbol}  tf=${timeframe}  count=${candles.length}`);
    res.json({ symbol, timeframe, candles });
  } catch (err) {
    console.error(`[api] /candles error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[ws] Client connected');
  ws.on('close', () => console.log('[ws] Client disconnected'));
  ws.on('error', (err) => console.error('[ws] Error:', err.message));
});

// Broadcast a JSON payload to all connected browser clients.
// Called by later modules (data, analysis, ai) when they have something to push.
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  console.log(`[startup] Data source: ${DATA_SOURCE}`);

  if (DATA_SOURCE === 'seed') {
    // No broker credentials needed — candles come from data/seed/*.json
    console.log('[startup] Seed mode — skipping broker auth');
  } else {
    // Live mode — require Tradovate credentials before opening the port
    const required = [
      'TRADOVATE_USERNAME',
      'TRADOVATE_PASSWORD',
      'TRADOVATE_APP_ID',
      'TRADOVATE_APP_SECRET',
      'TRADOVATE_API_URL',
    ];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
      console.error('[startup] Missing required env vars:', missing.join(', '));
      console.error('[startup] Fill in .env and restart.');
      process.exit(1);
    }
    await authenticate();
  }

  server.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});

module.exports = { app, server, wss, broadcast };
