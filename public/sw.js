// Folio's service worker. Scope is deliberately narrow: Folio is a live
// Convex-backed editor, so we never cache API/websocket traffic or pretend
// stale content is current. All this does is (1) let the app install as a
// PWA and (2) show a calm "you're offline" page instead of the browser's
// dinosaur when navigation fails with no connection.
const CACHE_VERSION = "folio-shell-v1";
const OFFLINE_URL = "/offline";
const PRECACHE_URLS = [OFFLINE_URL, "/icons/192", "/icons/512"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Deliberately no clients.claim() here: claiming already-open tabs mid-
  // session races with in-flight requests on that page (e.g. Clerk's lazily-
  // imported clerk-js chunk) and can fail them outright. A newly-activated
  // worker only starts controlling a page on its *next* full navigation,
  // which is the safe default.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Page navigations: go to the network for live content, fall back to the
  // offline page only when the network is actually unreachable.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL)),
    );
    return;
  }

  // Next's hashed static assets are immutable — safe to cache-first. Any
  // Cache API hiccup falls back to a plain network fetch rather than letting
  // event.respondWith reject, which the browser reports as the resource
  // itself failing to load.
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches
        .match(request)
        .then(
          (cached) =>
            cached ??
            fetch(request).then((response) => {
              if (response.ok) {
                const copy = response.clone();
                caches
                  .open(CACHE_VERSION)
                  .then((cache) => cache.put(request, copy))
                  .catch(() => {});
              }
              return response;
            }),
        )
        .catch(() => fetch(request)),
    );
    return;
  }

  // Everything else (Convex, Clerk, API routes, non-static GETs) passes
  // straight through — no caching, no interception.
});
