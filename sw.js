// Service Worker – cacht nur die App-Hülle, niemals Google-API-Antworten.
const CACHE = "todo-shell-v201";
const SHELL = ["./", "./index.html", "./manifest.webmanifest?v=2", "./icon-192.png?v=2", "./icon-512.png?v=2", "./favicon-32.png?v=2"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Google-Domains (APIs, Auth) immer direkt aus dem Netz – nie cachen.
  if (url.hostname.endsWith("googleapis.com") ||
      url.hostname.endsWith("google.com") ||
      url.hostname.endsWith("gstatic.com")) {
    return;
  }
  if (e.request.method !== "GET") return;

  // Die Seite selbst: erst Netz, dann Cache. So sind Änderungen sofort sichtbar.
  const isHTML = e.request.mode === "navigate" ||
                 url.pathname.endsWith("/") ||
                 url.pathname.endsWith("/index.html");
  if (isHTML) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // Übrige App-Hülle (Icons, Manifest): erst Netz, dann Cache.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      return fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
