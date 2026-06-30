const CACHE_VERSION = 'mes-prieres-pwa-prototype-v0.1.6-audited-4e95f662db2e';
const CACHE_PREFIX = 'mes-prieres-pwa-prototype-';
// v0.1.6 migrates only cache names emitted by the preceding app versions.
const LEGACY_CACHE_PATTERN = /^mes-prieres-v\d+\.\d+\.\d+-audited-[0-9a-f]{12}$/;
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './data/prayers.json',
  './data/prayers.js',
  './data/help.json',
  './data/help.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  // No skipWaiting(): an update must not take control of an open reading session.
  event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(CORE_ASSETS)));
});

self.addEventListener('message', event => {
  // Activation is permitted only after the visible app sends this explicit user-action message.
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  // Purge only this app namespace and explicitly recognised legacy cache keys.
  // Other same-origin applications, including any "mes-prieres-*" sibling, remain untouched.
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => (key.startsWith(CACHE_PREFIX) || LEGACY_CACHE_PATTERN.test(key)) && key !== CACHE_VERSION).map(key => caches.delete(key))
  )));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  // release.json deliberately remains network-only so the app can verify the currently published version.
  if (requestUrl.pathname.endsWith('/release.json')) { event.respondWith(fetch(event.request)); return; }
  event.respondWith((async () => {
    // Use only this app's active cache; caches.match() would search unrelated same-origin caches.
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response && response.ok) {
      const copy = response.clone();
      event.waitUntil(cache.put(event.request, copy));
    }
    return response;
  })());
});
