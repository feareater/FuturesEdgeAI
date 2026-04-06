'use strict';
// Coinbase Exchange WebSocket — live price ticker for BTC, ETH, XRP (spot).
// Connects to the public Coinbase Exchange WebSocket feed (no auth required).
// Emits 'price' events: { symbol: 'BTC', price: 73200.50, time: <unix secs> }
// The server wires these into the broadcast() function so browser clients
// receive { type: 'live_price', symbol, price, time } WebSocket messages.

const { EventEmitter } = require('events');
const { WebSocket }    = require('ws');

const WS_URL      = 'wss://ws-feed.exchange.coinbase.com';
const PRODUCTS    = ['BTC-USD', 'ETH-USD', 'XRP-USD'];
const SYM_MAP     = { 'BTC-USD': 'BTC', 'ETH-USD': 'ETH', 'XRP-USD': 'XRP' };
const RECONNECT   = 5_000; // ms
const TICK_LOG_MS = 60_000; // log current prices once per minute

class CoinbaseWS extends EventEmitter {
  constructor() {
    super();
    this._ws        = null;
    this._connected = false;
    this._prices    = {};   // symbol → last price
    this._started   = false;
    this._lastTickLog = 0;  // timestamp of last tick summary log
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._connect();
  }

  _connect() {
    console.log('[coinbaseWS] Connecting to Coinbase Exchange ticker…');
    const ws = new WebSocket(WS_URL);
    this._ws = ws;

    ws.on('open', () => {
      this._connected = true;
      console.log('[coinbaseWS] Connected');
      ws.send(JSON.stringify({
        type:        'subscribe',
        product_ids: PRODUCTS,
        channels:    ['ticker'],
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'ticker') return;
        const symbol = SYM_MAP[msg.product_id];
        if (!symbol) return;
        const price = parseFloat(msg.price);
        if (isNaN(price)) return;
        const time = msg.time
          ? Math.floor(new Date(msg.time).getTime() / 1000)
          : Math.floor(Date.now() / 1000);
        this._prices[symbol] = price;
        this.emit('price', { symbol, price, time });
        // Log combined price snapshot once per minute
        const now = Date.now();
        if (now - this._lastTickLog >= TICK_LOG_MS) {
          this._lastTickLog = now;
          const snap = Object.entries(this._prices)
            .map(([s, p]) => `${s} $${p.toLocaleString('en-US', { maximumFractionDigits: 4 })}`)
            .join(' ');
          console.log(`[coinbaseWS] Tick: ${snap}`);
        }
      } catch {}
    });

    ws.on('close', () => {
      this._connected = false;
      console.log('[coinbaseWS] Disconnected — reconnecting in 5s…');
      setTimeout(() => this._connect(), RECONNECT);
    });

    ws.on('error', (err) => {
      console.error('[coinbaseWS] Error:', err.message);
      // close event will follow and trigger reconnect
    });
  }

  /** Last known price for a symbol, or null. */
  getPrice(symbol) { return this._prices[symbol] ?? null; }

  isConnected()    { return this._connected; }
}

module.exports = new CoinbaseWS();
