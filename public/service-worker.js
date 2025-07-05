const cacheName = 'chatapp-v1';
const assets = [
  '/',
  '/index.html',
  '/chat.html',
  '/css/style.css',
  '/js/main.js',
  '/manifest.json',
  '/sounds/notification.mp3',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(cacheName).then((cache) => {
      return cache.addAll(assets);
    })
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((res) => {
      return res || fetch(e.request);
    })
  );
});
