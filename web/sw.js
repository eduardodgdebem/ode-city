// Keeps the app on the device, so it opens with no network at all.
//
// Everything the app is made of is cached when the worker installs. After
// that, a request is answered from the cache at once, and fetched again in
// the background so the next launch gets whatever was deployed since.
// Bump VERSION to drop the old cache outright; the page shows its number,
// so it can be told which deploy it is running.
//
// Both go to the network past the browser's own HTTP cache, which GitHub
// Pages lets keep a file ten minutes: an update would otherwise fetch the
// same old files again.

const VERSION = 'ode-city-10';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'gl.js',
  'city.wasm',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const fresh = fetch(request, { cache: 'no-cache' })
        .then((response) => {
          if (response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? fresh;
    }),
  );
});

// The page asks which version is serving it.
self.addEventListener('message', (event) => {
  if (event.data === 'version') {
    event.source.postMessage({ version: VERSION.replace('ode-city-', '') });
  }
});
