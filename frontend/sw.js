// Service Worker for Coaching Center Management System
const CACHE_NAME = 'coaching-center-cache-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/students.html',
  '/student-details.html',
  '/payments.html',
  '/monthly-overview.html',
  '/expenses.html',
  '/reports.html',
  '/settings.html',
  '/dashboard',
  '/students',
  '/student-details',
  '/payments',
  '/monthly-overview',
  '/expenses',
  '/reports',
  '/settings',
  '/css/fonts.css',
  '/css/global.css',
  '/dashboard.css',
  '/students.css',
  '/student-details.css',
  '/payments.css',
  '/monthly-overview.css',
  '/expenses.css',
  '/reports.css',
  '/settings.css',
  '/js/api.js',
  '/dashboard.js',
  '/students.js',
  '/student-details.js',
  '/payments.js',
  '/monthly-overview.js',
  '/expenses.js',
  '/reports.js',
  '/settings.js',
  '/manifest.json',
  '/css/fonts/app-icon.svg',
  '/css/fonts/material-symbols-outlined.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching offline shell and core assets');
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Some non-critical assets could not be pre-cached:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // API calls: Network first, fall back to offline error or cached GET
  if (url.pathname.startsWith('/api/')) {
    if (request.method === 'GET') {
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => caches.match(request))
      );
    }
    return;
  }

  // HTML page navigations: Network first with Cache fallback
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            // Fallback to dashboard.html if specific page not cached
            return caches.match('/dashboard.html');
          });
        })
    );
    return;
  }

  // Static Assets (CSS, JS, Fonts, Images): Cache First with background revalidation
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached asset immediately, revalidate in background
        fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse));
          }
        }).catch(() => {/* offline, keep cached */});
        return cachedResponse;
      }

      // If not in cache, fetch from network and cache it
      return fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return networkResponse;
      });
    })
  );
});
