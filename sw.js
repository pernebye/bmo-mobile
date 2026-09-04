// Оболочка кэшируется, данные всегда идут по сети — иначе можно увидеть
// вчерашний список задач и решить, что всё сделано.
const VERSION = 'v26';
const CACHE = 'bmo-shell-' + VERSION;
const SHELL = ['./', 'index.html', 'styles.css?v=26', 'icons.js?v=26', 'app.js?v=26', 'manifest.webmanifest', 'icon-256.png'];

self.addEventListener('install', (event) => {
  // берём файлы напрямую с сервера, минуя HTTP-кэш браузера — иначе новая
  // версия ставится из старых копий и обновление не доезжает
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(client => client.postMessage({ type: 'updated', version: VERSION })))
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET' || url.origin !== location.origin) return;

  // страницу всегда перепроверяем на сервере: GitHub Pages кэширует её на 10 минут
  const request = event.request.mode === 'navigate'
    ? new Request(event.request, { cache: 'no-cache' })
    : event.request;

  event.respondWith(
    fetch(request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match('index.html')))
  );
});
