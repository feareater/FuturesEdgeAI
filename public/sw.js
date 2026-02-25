'use strict';
// public/sw.js — FuturesEdge AI Service Worker
// Strategy:
//   • Install  → pre-cache app shell (HTML / CSS / JS / icons)
//   • Activate → delete old caches, claim clients
//   • Fetch    → cache-first for shell assets; network-only for /api/ and /ws

const CACHE_NAME = 'futuresedge-v1';

// All assets required to render the UI — these are cached at install time.
// API calls are intentionally excluded: trading data must always be fresh.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/docs.html',
  '/commentary.html',
  '/css/dashboard.css',
  '/js/chart.js',
  '/js/layers.js',
  '/js/alerts.js',
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

// ── Fetch: network-only for API + WS; cache-first for everything else ─────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept API calls or WebSocket upgrade requests — they must be live.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return; // pass through to network
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Not in cache — fetch from network and cache the response for next time.
      return fetch(event.request)
        .then(response => {
          // Only cache valid same-origin or CORS-ok responses.
          if (!response || response.status !== 200 ||
              (response.type !== 'basic' && response.type !== 'cors')) {
            return response;
          }
          const toCache = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
          return response;
        })
        .catch(() => {
          // Network failed — for page navigations return the cached shell.
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
    })
  );
});
