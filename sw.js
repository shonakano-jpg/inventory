/* Service Worker — オフライン対応
   - 自アプリのファイル(HTML/CSS/JS)は network-first（更新を確実に反映、オフライン時のみキャッシュ）
   - 外部ライブラリ(unpkg)は cache-first（変わらないので高速化）
*/
const CACHE = "furugi-tanaoroshi-v10";
const ASSETS = [
  "./", "./index.html", "./styles.css",
  "./config.js", "./db.js", "./scanner.js", "./app.js",
  "./manifest.webmanifest", "./icons/icon.svg", "./master.csv", "./stores.json",
  "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = req.url;
  if (req.method !== "GET") return;
  if (url.includes("supabase")) return; // APIは常に最新（キャッシュしない）

  const sameOrigin = url.startsWith(self.location.origin);

  if (sameOrigin) {
    // network-first
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
  } else {
    // cache-first（外部ライブラリ）
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok && (url.includes("unpkg.com") || url.includes("jsdelivr"))) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
