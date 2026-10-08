'use strict';

// Vigil service worker: keeps the app shell on the phone so it opens fast
// and on a weak signal, and shows notifications the way phones require
// (Android and iPhone only allow them through a service worker).
// Live data (/api/*) is never cached here; it always comes from the network.
const SHELL = 'vigil-shell-v1';
const FILES = ['/', '/index.html', '/app.js', '/styles.css', '/map-style.json', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App files and the map/script libraries: serve the saved copy right away
// and refresh it in the background, so the next open has the latest version.
const LIBS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const own = url.origin === self.location.origin;
  if (event.request.method !== 'GET' || (own && url.pathname.startsWith('/api/')) || (!own && !LIBS.includes(url.hostname))) return;
  const key = !own ? url.href : event.request.mode === 'navigate' ? '/index.html' : url.pathname;
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const saved = await cache.match(key);
      const fresh = fetch(event.request)
        .then((res) => {
          // Library scripts load without CORS, so their responses are opaque.
          if (res.ok || res.type === 'opaque') cache.put(key, res.clone());
          return res;
        })
        .catch(() => saved);
      return saved || fresh;
    })
  );
});

// Tapping a notification opens Vigil on that report or registry record.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const open = (event.notification.data && event.notification.data.open) || null;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const client = list[0];
      if (client) {
        if (open) client.postMessage({ type: 'open', ...open });
        return client.focus();
      }
      return self.clients.openWindow(open ? `/?open=${encodeURIComponent(open.kind)}:${encodeURIComponent(open.id)}` : '/');
    })
  );
});
