const CACHE_VERSION = "nightfall-v20";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const CORE_ASSETS = [
  "./index.html",
  "./nightfall-redesign.css?v=20",
  "./game-archive.mjs",
  "./achievements.mjs",
  "./opening-book.mjs",
  "./openings.json",
  "./puzzles.json",
  "./chess-icon.svg",
  "./assets/stockfish/stockfish-19-lite-single.js",
  "./assets/stockfish/stockfish-19-lite-single.wasm"
];
const IMMUTABLE_ASSET = /\.(?:css|m?js|wasm|svg|png|jpe?g|webp|mp3|woff2?)$/i;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(CORE_ASSETS.map(path => new URL(path, self.registration.scope)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith("nightfall-") && !name.startsWith(CACHE_VERSION)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function networkFirst(request, fallbackUrl = request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request) || await caches.match(fallbackUrl);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, new URL("./index.html", self.registration.scope)));
    return;
  }
  if (url.pathname.endsWith("/openings.json")) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (IMMUTABLE_ASSET.test(url.pathname)) event.respondWith(cacheFirst(request));
});
