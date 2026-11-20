// SmartTools service worker (F1, docs/ARCHITECTURE.md): the app works with no network.
//   pages (/hud, /memory, /markers ...)  network first, the cached copy when offline
//   /_next/static/*                      cache first (file names are content hashes)
//   /engine, /models, /icons             cached, refreshed in the background (stale-while-revalidate)
// Nothing here is on the real-time path: it only serves files.

const VERSION = "st-v1";
const SHELL = ["/hud", "/memory", "/markers", "/", "/engine/nav_core.wasm", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      for (const url of SHELL) {
        try {
          const res = await fetch(url, { cache: "reload" });
          if (!res.ok) continue;
          await cache.put(url, res.clone());
          // the scripts and styles a page needs, so it opens offline after one visit
          if ((res.headers.get("content-type") || "").includes("text/html")) {
            const html = await res.text();
            const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]);
            await Promise.all([...new Set(assets)].map((a) => cache.add(a).catch(() => {})));
          }
        } catch {
          // offline during install: the next visit fills the cache
        }
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(req));
  } else if (/^\/(engine|models|icons)\//.test(url.pathname) || url.pathname === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(req, event));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(new URL(req.url).pathname, res.clone());
    return res;
  } catch {
    const hit = (await cache.match(new URL(req.url).pathname)) || (await cache.match("/hud"));
    return hit || new Response("Offline, and this page was never opened online.", { status: 503, headers: { "content-type": "text/plain" } });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const update = fetch(req)
    .then((res) => (res.ok ? cache.put(req, res.clone()).then(() => res) : res))
    .catch(() => hit);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  return update;
}
