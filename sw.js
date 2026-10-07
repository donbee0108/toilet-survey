// 오프라인용: 앱 파일을 휴대폰에 저장해 두고, 인터넷이 없어도 앱이 열리게 한다.
// ★ 앱 파일(config.js 포함)을 고쳐 올릴 때는 반드시 VERSION을 하나 올린다 (v1 → v2).
//   VERSION이 바뀌어야 휴대폰이 새 파일 전체를 한 번에 받아 바꾼다. 파일이 섞여 앱이 깨지는 일을 막기 위함.
const VERSION = 'v6';
const CACHE = `toilet-survey-${VERSION}`;
const FILES = [
  './', './index.html', './styles.css', './config.js', './manifest.webmanifest',
  './js/app.js', './js/logic.js', './js/skip.js', './js/store.js', './js/api.js', './js/photo.js', './js/sync.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // 브라우저 임시 저장본이 아닌 서버의 최신 파일을 받는다. 하나라도 실패하면 설치를 취소하고 예전 버전을 계속 쓴다.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('toilet-survey-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 같은 사이트의 파일만 다룬다(서버 호출은 건드리지 않음). 저장된 버전의 파일만 쓰므로 신호가 약해도 바로 열린다.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true })
      || (e.request.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    return hit || fetch(e.request);
  })());
});
