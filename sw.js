// Оболочка кэшируется, данные всегда идут по сети — иначе можно увидеть
// вчерашний список задач и решить, что всё сделано.
const CACHE = 'runner-shell-v4';
const SHELL = ['./', 'index.html', 'styles.css?v=4', 'app.js?v=4', 'manifest.webmanifest', 'icon-256.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match('index.html')))
  );
});
