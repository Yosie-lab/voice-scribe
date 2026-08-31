// VoiceScribe Service Worker
// Network-First戦略で常に最新アセットを配信

const CACHE_NAME = 'voicescribe-v47';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/recorder.js',
  './js/transcriber.js',
  './js/whisper.js',
  './js/storage.js',
  './js/visualizer.js',
  './js/ui.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// インストール時に即座にアクティブ化
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// アクティベーション時に過去のキャッシュを全削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Network First戦略: 常に最新をサーバーから取得し、ネットワーク不通時のみキャッシュを使用
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
