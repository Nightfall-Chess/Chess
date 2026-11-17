const CACHE_VERSION = "nightfall-v36";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./nightfall-redesign.css?v=36",
  "./online-supabase.js?v=online-authoritative-snapshot-20261117",
  "./game-archive.mjs",
  "./pgn-import.mjs",
  "./achievements.mjs",
  "./opening-book.mjs",
  "./chess-icon.svg"
];

const LARGE_ASSETS = [
  "./assets/stockfish/stockfish-19-lite-single.js",
  "./assets/stockfish/stockfish-19-lite-single.wasm",
  "./openings.json",
  "./puzzles.json"
];

const MAX_CACHED_BYTES = 30 * 1024 * 1024;
const NETWORK_FIRST_TIMEOUT_MS = 3000;

function isPuzzleApi(url) {
  return /\/api\/puzzles(?:\/|$)/.test(url.pathname);
}

function isCacheableResponse(response) {
  return response.ok && response.status === 200 && response.type !== "opaque"
    && !/\bno-store\b/i.test(response.headers.get("Cache-Control") || "");
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

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(CORE_ASSETS.map(path => new URL(path, self.registration.scope)));
    await self.skipWaiting();
  })());
});

async function warmLargeAssets() {
  const cache = await caches.open(RUNTIME_CACHE);
  for (const path of LARGE_ASSETS) {
    const request = new Request(new URL(path, self.registration.scope));
    if (await cache.match(request)) continue;
    try {
      await store(cache, request, await fetch(request));
    } catch (error) {
      console.warn("A large asset could not be saved for offline use:", path, error);
    }
  }
}

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith("nightfall-") && !name.startsWith(CACHE_VERSION))
      .map(name => caches.delete(name)));
    await self.clients.claim();
    await warmLargeAssets();
  })());
});

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
      const shell = await caches.match(new URL("./index.html", self.registration.scope));
      if (shell) return shell;
    }
    throw error;
  }
}

async function staleWhileRevalidate(event, cache, request) {
  const cached = await cache.match(request);
  const refresh = fetch(request).then(async response => {
    await store(cache, request, response);
    return response;
  });
  if (cached) {
    refresh.catch(() => {});
    event.waitUntil?.(refresh.catch(() => {}));
    return cached;
  }
  return refresh;
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isPuzzleApi(url)) return;
  if (request.headers.get("range") || /\/Music\//i.test(url.pathname)) return;

  event.respondWith((async () => {
    const staticCache = await caches.open(STATIC_CACHE);
    const runtimeCache = await caches.open(RUNTIME_CACHE);
    const heavy = /\/assets\/stockfish\//.test(url.pathname)
      || /\.(?:wasm|json|png|jpe?g|webp|gif|svg|woff2?|ttf)$/i.test(url.pathname);
    return heavy
      ? staleWhileRevalidate(event, runtimeCache, request)
      : networkFirst(staticCache, request);
  })());
});
