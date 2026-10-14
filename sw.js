// Keeps the app working with no signal in the shop.
const CACHE = "shop-tally-v13";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    // Network first, so updates arrive; cached copy when offline
    e.respondWith(
      fetch(e.request, { cache: "no-cache" })
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
        .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
    );
  } else if (url.hostname === "www.gstatic.com" || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com" || url.hostname === "dm.emea.cms.aldi.cx") {
    // Firebase code and fonts: cache first
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; }))
    );
  }
});
