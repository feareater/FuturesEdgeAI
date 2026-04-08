'use strict';
// public/sw.js — FuturesEdge AI Service Worker
// Strategy:
//   • Install  → pre-cache app shell (HTML / CSS / JS / icons)
//   • Activate → delete old caches, claim clients
//   • Fetch    → cache-first for shell assets; network-only for /api/ and /ws

const CACHE_NAME = 'futuresedge-v37';

// All assets required to render the UI — these are cached at install time.
// API calls are intentionally excluded: trading data must always be fresh.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/docs.html',
  '/commentary.html',
  '/performance.html',
  '/backtest.html',
  '/backtest2.html',
  '/scanner.html',
  '/propfirms.html',
  '/tradingaccount.html',
  '/forwardtest.html',
  '/css/dashboard.css',
  '/css/performance.css',
  '/css/backtest.css',
  '/css/backtest2.css',
  '/css/scanner.css',
  '/css/propfirms.css',
  '/css/tradingaccount.css',
  '/css/forwardtest.css',
  '/js/chart.js',
  '/js/layers.js',
  '/js/alerts.js',
  '/js/performance.js',
  '/js/backtest.js',
  '/js/backtest2.js',
  '/js/scanner.js',
  '/js/propfirms.js',
  '/js/tradingaccount.js',
  '/js/forwardtest.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon.svg',
  // TradingView Lightweight Charts — pinned version so it caches reliably
  'https://unpkg.com/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.js',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Install — caching shell assets');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())   // take over immediately, no tab-close needed
  );
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activate');
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => { console.log('[SW] Removing old cache:', k); return caches.delete(k); })
      ))
      .then(() => self.clients.claim())  // control all open tabs immediately
  );
});

// ── Push: show OS notification when a push event arrives ─────────────────────
self.addEventListener('push', event => {
  const data    = event.data ? event.data.json() : {};
  const title   = data.title || 'FuturesEdge Alert';
  const options = {
    body:              data.body  || '',
    icon:              data.icon  || '/icons/icon-192.png',
    badge:             '/icons/icon-192.png',
    data:              data.data  || {},
    requireInteraction: false,
    silent:            false,
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click: focus or open the dashboard ───────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if (client.url.includes('/') && 'focus' in client) return client.focus();
        }
        return clients.openWindow('/');
      })
  );
});

// ── Fetch: network-only for API + WS; network-first for shell assets ──────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept API calls or WebSocket upgrade requests — they must be live.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return; // pass through to network
  }

  // Network-first: try the network, fall back to cache if offline.
  // This ensures HTML/JS/CSS changes are picked up without a hard refresh.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache the fresh response for offline fallback.
        if (response && response.status === 200 &&
            (response.type === 'basic' || response.type === 'cors')) {
          const toCache = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        }
        return response;
      })
      .catch(() => {
        // Network failed — serve from cache (offline support).
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') return caches.match('/index.html');
        });
      })
  );
});
