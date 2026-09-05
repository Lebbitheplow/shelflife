// Served via a route in server.js that replaces __APP_VERSION__ with the
// package.json version, so the cache name and precache list always match the
// asset versions the views link to.
const CACHE = 'shelflife-__APP_VERSION__';
const STATIC = [
  '/css/base.css?v=__APP_VERSION__',
  '/css/landing.css?v=__APP_VERSION__',
  '/css/library.css?v=__APP_VERSION__',
  '/css/modal.css?v=__APP_VERSION__',
  '/js/helpers.js?v=__APP_VERSION__',
  '/js/cards.js?v=__APP_VERSION__',
  '/js/app.js?v=__APP_VERSION__',
  '/js/store.js?v=__APP_VERSION__',
  '/js/modal.js?v=__APP_VERSION__',
  '/js/landing.js?v=__APP_VERSION__',
  '/favicon.svg',
  '/icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Cache-first for static assets
  if (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/favicon.svg'
  ) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        });
      })
    );
    return;
  }

  // Network-first for everything else (profile page, API)
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
