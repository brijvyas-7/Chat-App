// service-worker.js
const CACHE_NAME = 'chat-app-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/main.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .catch(console.error)
  );
});

self.addEventListener('fetch', (e) => {
  // Skip caching for:
  // - Video calls
  // - Socket.IO
  // - Chrome extensions
  if (e.request.url.includes('/socket.io/') || 
      e.request.url.includes('chrome-extension://') ||
      e.request.url.includes('video-call')) {
    return fetch(e.request);
  }

  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Only cache successful, full responses
        if (response.status === 200 && !response.headers.get('content-range')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
async function checkMediaPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach(track => track.stop()); // Immediately release
    return true;
  } catch (error) {
    console.error("Permission denied:", error);
    alert("Please allow camera/microphone access!");
    return false;
  }
}