const CACHE_PREFIX = "nightfall-static-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./nightfall-redesign.css?v=19",
  "./supabase-config.js",
  "./game-archive.mjs",
  "./achievement-progress.mjs",
  "./opening-index.mjs",
  "./openings.json",
  "./puzzles.json",
  "./chess-icon.svg",
  "./assets/stockfish/stockfish-19-lite-single.js",
  "./assets/stockfish/stockfish-19-lite-single.wasm"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_ASSETS.map(path => new Request(new URL(path, self.registration.scope))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function isPuzzleApi(url) {
  return /\/api\/puzzles(?:\/|$)/.test(url.pathname);
}

function isCacheableResponse(response) {
  return response.ok
    && response.type !== "opaque"
    && !/\bno-store\b/i.test(response.headers.get("Cache-Control") || "");
}

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || isPuzzleApi(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    let response;
    try {
      response = await fetch(request);
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") {
        const shell = await cache.match(new URL("./index.html", self.registration.scope));
        if (shell) return shell;
      }
      throw error;
    }
    if (isCacheableResponse(response)) {
      const size = Number(response.headers.get("Content-Length") || 0);
      if (!size || size <= 30 * 1024 * 1024) {
        try {
          await cache.put(request, response.clone());
        } catch (error) {
          console.warn("A static asset could not be cached:", request.url, error);
        }
      }
    }
    return response;
  })());
});
