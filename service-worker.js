// public/service-worker.js
// Caches the static app shell only, for installability and faster reloads.
// Deliberately does NOT cache API/socket traffic, messages, files, or any
// route under /api or /socket.io - those must always hit the network so
// stale ciphertext or ephemeral content is never served from a cache.

const CACHE = 'evolt-shell-v6';
const SHELL_FILES = [
  './',
  'index.html',
  'css/style.css',
  'fonts/fonts.css',
  'js/app.js',
  'js/config.js',
  'js/crypto.js',
  'js/pairing.js',
  'js/store.js',
  'js/filetransfer.js',
  'js/webrtc.js',
  'js/vendor/pako.umd.min.js',
  'js/vendor/qrcode.js',
  'manifest.json',
  'icons/icon.svg',
  'icons/mark.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // Cache each shell file independently: cache.addAll() rejects the whole
  // install if any single file 404s, which would silently leave the app
  // with no offline shell at all.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(SHELL_FILES.map((f) => cache.add(f)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) {
    return; // always network, never cached
  }
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
