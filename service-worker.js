// Offline cache: every app file is cached on install. Requests are answered from the
// cache at once and refreshed in the background, so a page load never waits for a
// slow or missing connection; a new version shows on the load after it was fetched.
// Bump CACHE with every release so old files are dropped.

const CACHE = 'stomp-commander-v1.0.0';
const FILES = [
  './', 'index.html', 'app.css', 'manifest.webmanifest', 'icon.svg',
  'js/main.js', 'js/midi.js', 'js/zoomg1.js', 'js/zoomms.js', 'js/zdl.js', 'js/pcfs.js', 'js/idb.js', 'js/keepalive.js', 'js/cli.js',
];

// Files are fetched past the browser's HTTP cache (install: reload, refresh: revalidate),
// so the offline copy never picks up stale files.
self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const f of FILES) {
      const res = await fetch(f, { cache: 'reload' });
      if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
      await cache.put(f, res);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('stomp-commander-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  ev.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    if (hit) {
      ev.waitUntil(fresh.catch(() => {}));
      return hit;
    }
    return fresh;
  }));
});
