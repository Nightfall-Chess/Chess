<<<<<<< HEAD
const CACHE_VERSION = "nightfall-v20";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const CORE_ASSETS = [
=======
const CACHE_PREFIX = "nightfall-static-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;

// Small files that every visit needs. Only these are downloaded while the worker installs,
// so the first page load is not slowed down by large downloads.
const SHELL_ASSETS = [
  "./",
>>>>>>> 82566ede208c26fa4a3ae5a5c1ff6ea38107bf0b
  "./index.html",
  "./nightfall-redesign.css?v=20",
  "./game-archive.mjs",
<<<<<<< HEAD
  "./achievements.mjs",
  "./opening-book.mjs",
  "./openings.json",
  "./puzzles.json",
  "./chess-icon.svg",
  "./assets/stockfish/stockfish-19-lite-single.js",
  "./assets/stockfish/stockfish-19-lite-single.wasm"
=======
  "./achievement-progress.mjs",
  "./opening-index.mjs",
  "./chess-icon.svg"
>>>>>>> 82566ede208c26fa4a3ae5a5c1ff6ea38107bf0b
];
const IMMUTABLE_ASSET = /\.(?:css|m?js|wasm|svg|png|jpe?g|webp|mp3|woff2?)$/i;

// Large files that rarely change. They are saved in the background after activation
// so the app also works offline, and are served from the cache first afterwards.
const LARGE_ASSETS = [
  "./assets/stockfish/stockfish-19-lite-single.js",
  "./assets/stockfish/stockfish-19-lite-single.wasm",
  "./openings.json",
  "./puzzles.json"
];

const MAX_CACHED_BYTES = 30 * 1024 * 1024;
const NETWORK_FIRST_TIMEOUT_MS = 3000;

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
  event.waitUntil(warmLargeAssets());
});

<<<<<<< HEAD
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
=======
async function warmLargeAssets() {
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const path of LARGE_ASSETS) {
      const request = new Request(new URL(path, self.registration.scope));
      if (await cache.match(request)) continue;
      try {
        await store(cache, request, await fetch(request));
      } catch (error) {
        console.warn("A large asset could not be saved for offline use:", path, error);
      }
    }
  } catch (error) {
    console.warn("Offline cache warm-up failed:", error);
  }
}

function isPuzzleApi(url) {
  return /\/api\/puzzles(?:\/|$)/.test(url.pathname);
}

function isCacheableResponse(response) {
  return response.ok
    && response.status === 200
    && response.type !== "opaque"
    && !/\bno-store\b/i.test(response.headers.get("Cache-Control") || "");
>>>>>>> 82566ede208c26fa4a3ae5a5c1ff6ea38107bf0b
}

async function store(cache, request, response) {
  if (!isCacheableResponse(response)) return;
  const size = Number(response.headers.get("Content-Length") || 0);
  if (size && size > MAX_CACHED_BYTES) return;
  try {
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn("A static asset could not be cached:", request.url, error);
  }
}

// Large, rarely changing files: answer from the cache immediately and refresh it in the background.
function isHeavyAsset(url) {
  return /\/assets\/stockfish\//.test(url.pathname)
    || /\.(?:wasm|json|png|jpe?g|webp|gif|svg|woff2?|ttf)$/i.test(url.pathname);
}

async function staleWhileRevalidate(event, cache, request) {
  const cached = await cache.match(request);
  const refresh = fetch(request).then(async response => {
    await store(cache, request, response);
    return response;
  });
  if (cached) {
    refresh.catch(() => {});
    if (typeof event.waitUntil === "function") event.waitUntil(refresh.catch(() => {}));
    return cached;
  }
  return refresh;
}

// Pages and scripts: always try the network so fixes show up right away, but fall back to the
// cached copy if the connection is slow or offline so the app never hangs waiting for it.
async function networkFirst(cache, request) {
  const cached = await cache.match(request);
  const fetched = fetch(request).then(async response => {
    await store(cache, request, response);
    return response;
  });
  try {
    if (!cached) return await fetched;
    return await Promise.race([
      fetched,
      new Promise((_, reject) => setTimeout(() => reject(new Error("slow network")), NETWORK_FIRST_TIMEOUT_MS))
    ]);
  } catch (error) {
    fetched.catch(() => {});
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await cache.match(new URL("./index.html", self.registration.scope));
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
<<<<<<< HEAD
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
=======
  if (request.method !== "GET" || url.origin !== self.location.origin || isPuzzleApi(url)) return;
  // Audio streams use range requests and are large; let the browser handle them directly.
  if (request.headers.get("range") || /\/Music\//i.test(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return isHeavyAsset(url) ? staleWhileRevalidate(event, cache, request) : networkFirst(cache, request);
  })());
>>>>>>> 82566ede208c26fa4a3ae5a5c1ff6ea38107bf0b
});
