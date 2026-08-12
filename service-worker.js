/**
 * Service Worker - 今晚还能玩多久
 * 提供离线缓存支持
 */

const CACHE_NAME = 'homework-timer-v10';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css?v=10',
  './time-utils.js?v=10',
  './app.js?v=10',
  './api-service.js?v=10',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 安装：预缓存核心资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// 请求拦截：API 始终走网络；静态资源网络优先、缓存回退。
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok && event.request.method === 'GET' &&
            event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'SHOW_REMINDER') return;
  const { title, body, tag } = event.data;
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: tag || 'family-reminder',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find(client => 'focus' in client);
      return existing ? existing.focus() : self.clients.openWindow('./');
    })
  );
});
