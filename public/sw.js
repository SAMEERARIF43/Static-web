// Anime Hub Service Worker — PWA Offline Engine (Phase 5, Task 1)
// Cache versioning with automatic stale-cache cleanup on activation.
const CACHE_NAME = 'anime-hub-v1';
const STATIC_CACHE = 'anime-hub-static-v1';
const API_CACHE = 'anime-hub-api-v1';

// Static assets served cache-first (with network fallback).
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/watchlist-utils.js',
  '/reading-list-utils.js',
  '/assets/favicon.svg',
  '/assets/favicon-64.png',
  '/assets/favicon-192.svg',
  '/assets/favicon-512.svg',
  '/assets/images/background.png',
  '/manifest.json'
];

// API endpoints served network-first with stale-cache fallback.
const API_CACHE_ENDPOINTS = [
  '/api/browse',
  '/api/search',
  '/api/recommendations',
  '/api/genre',
  '/api/genres',
  '/api/popular',
  '/api/trending',
  '/api/movies',
  '/api/series',
  '/api/animated-movies'
];

// Install: precache static assets.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(error => {
        console.warn('[SW] Install: some static assets failed to cache:', error);
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean up stale caches.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => {
          return name !== CACHE_NAME && name !== STATIC_CACHE && name !== API_CACHE;
        }).map(name => {
          return caches.delete(name);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: route requests by strategy.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // API routes: network-first with stale-cache fallback.
  if (API_CACHE_ENDPOINTS.some(prefix => path.startsWith(prefix)) || path.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).then(networkResponse => {
        // Clone and cache successful GET responses.
        if (networkResponse.ok && event.request.method === 'GET') {
          const responseClone = networkResponse.clone();
          caches.open(API_CACHE).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Network failed: try stale cache.
        return caches.match(event.request).then(cachedResponse => {
          if (cachedResponse) return cachedResponse;
          // Return a minimal offline JSON for API requests.
          return new Response(
            JSON.stringify({ error: 'offline', message: 'You are offline. Cached data unavailable.' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        });
      })
    );
    return;
  }

  // Static assets: cache-first with network fallback.
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then(networkResponse => {
        if (!networkResponse.ok) return networkResponse;
        const responseClone = networkResponse.clone();
        caches.open(STATIC_CACHE).then(cache => {
          cache.put(event.request, responseClone);
        });
        return networkResponse;
      }).catch(() => {
        // Both cache and network failed for a page request: return offline shell.
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
        return new Response('', { status: 404 });
      });
    })
  );
});

// Listen for messages from the client (e.g., skipWaiting).
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
