// 최소 service worker: 정적 자산 캐시. 캐시 이름에 앱 버전을 포함한다.
// 새 버전은 설치 즉시 활성화하고(skipWaiting·clients.claim), 화면(HTML)은 네트워크를 먼저 써서 이전 화면이 남지 않게 한다.
const CACHE = 're-sample-app-v1.0.1';
const ASSETS = [
  './',
  './index.html',
  './src/style.css',
  './src/app.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  // HTTP 캐시를 거치지 않고 새 파일을 받는다.
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // 화면은 네트워크 우선, 오프라인일 때만 캐시
    event.respondWith(fetch(request)
      .then((response) => {
        const copy = response.clone();
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html'))));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
