// VoiceScribe Service Worker
// Network-First戦略で常に最新アセットを配信

const CACHE_NAME = 'voicescribe-v96';
const MODEL_CACHE = 'voicescribe-whisper-models-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/app-recording-health.js',
  './js/app-recording-session.js',
  './js/recorder.js',
  './js/transcriber-policy.js',
  './js/transcriber-ja-text.js',
  './js/transcriber.js',
  './js/whisper.js',
  './js/whisper-live-text.js',
  './js/whisper-live.js',
  './js/whisper-live-worker.js',
  './js/whisper-pcm-worklet.js',
  './js/storage.js',
  './js/visualizer.js',
  './js/obsidian.js',
  './js/ui.js',
  './manifest.json?v=80',
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
          .filter((name) => name !== CACHE_NAME && name !== MODEL_CACHE && name !== 'transformers-cache')
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Network First戦略: 常に最新をサーバーから取得し、ネットワーク不通時のみキャッシュを使用
function isWhisperRuntimeRequest(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === 'huggingface.co' || host.endsWith('.huggingface.co')) return true;
    if (host === 'cdn.jsdelivr.net' && /\/(?:@huggingface\/transformers|onnxruntime-web)\//.test(parsed.pathname)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function whisperRuntimeFetch(request) {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const network = await fetch(request);
  if (network && network.ok) {
    try {
      await cache.put(request, network.clone());
    } catch {
      // iOS の Cache Storage 上限。transformers-cache 側が残っていればオフラインを続ける。
    }
  }
  return network;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (isWhisperRuntimeRequest(event.request.url)) {
    event.respondWith(whisperRuntimeFetch(event.request).catch(async () => {
      const loose = await caches.match(event.request);
      if (loose) return loose;
      return new Response('', { status: 504, statusText: 'whisper model offline' });
    }));
    return;
  }

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
