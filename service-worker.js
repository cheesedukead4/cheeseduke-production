/* 離線快取：網站檔案先走網路，4 秒沒回應或失敗才用快取。雲端資料請求不經過快取。
   修改網站檔案後，把 CACHE 的版本號加 1；新增檔案時也要加進 ASSETS。
   另外負責系統通知（新通知、行程提醒）被點一下時，切回 App 視窗。 */
var CACHE = 'pd-app-v1';
var NET_TIMEOUT_MS = 4000;
var ASSETS = [
  './', './index.html', './config.js', './manifest.webmanifest',
  './css/app.css',
  './js/auth.js', './js/cloud-store.js', './js/app.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); })); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  // 只清掉本 App 自己的舊快取（pd-app-…），不動同網域其他網站（採購看板 pb-app-、檔期包材 cms-app-、庫存效期 fe-app-）的快取
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('pd-app-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function cachedFor(req, nav) {
  return caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      if (nav && (!hit || hit.redirected)) return c.match('./');
      return hit;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var nav = req.mode === 'navigate';
  if (url.search && !nav) return;
  e.respondWith(cachedFor(req, nav).then(function (hit) {
    var net = fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok && !res.redirected && !url.search) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    });
    if (!hit) return net;
    var slow = new Promise(function (resolve) { setTimeout(function () { resolve(hit); }, NET_TIMEOUT_MS); });
    return Promise.race([net.catch(function () { return hit; }), slow]);
  }));
});

// 點系統通知：回到已開啟的 App 視窗（沒有就開一個），並打開那則通知
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.hash) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
        c.postMessage({ type: 'open', target: target });
        return c.focus();
      }
    }
    return self.clients.openWindow('./' + (target ? '#' + target : ''));
  }));
});
