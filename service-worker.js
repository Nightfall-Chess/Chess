const CACHE_VERSION = "nightfall-v44";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./nightfall-redesign.css?v=43",
  "./nightfall-themes.css?v=5",
  "./nightfall-visual-system.css?v=1",
  "./nightfall-theme-contrast.css?v=5",
  "./assets/nightfall-king-mask.svg",
  "./orbit-enhancements.css?v=1",
  "./orbit-enhancements.js",
  "./orbit-chat.css",
  "./orbit-chat.js",
  "./manifest.webmanifest",
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
const AUDIO_CACHE = `${CACHE_VERSION}-audio`;
const MAX_AUDIO_FILES = 8;
const MAX_AUDIO_BYTES = 48 * 1024 * 1024;
const fillingAudio = new Set();

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

async function fillAudio(url) {
  if (fillingAudio.has(url)) return;
  fillingAudio.add(url);
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    const size = Number(response.headers.get("Content-Length") || 0);
    if (!response.ok || response.status !== 200 || (size && size > MAX_AUDIO_BYTES)) return;
    const cache = await caches.open(AUDIO_CACHE);
    await cache.put(url, response.clone());
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_AUDIO_FILES; i++) await cache.delete(keys[i]);
  } catch (error) {
    console.warn("A music file could not be cached for offline use:", url, error);
  } finally {
    fillingAudio.delete(url);
  }
}

async function sliceAudioRange(response, range) {
  const blob = await response.blob();
  const size = blob.size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || "");
  if (!match) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
  let start = 0;
  let end = size - 1;
  if (match[1]) {
    start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
  } else if (match[2]) {
    start = Math.max(0, size - Number(match[2]));
  }
  end = Math.min(end, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "audio/mpeg",
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes"
    }
  });
}

async function handleMusic(request) {
  const keyUrl = new URL(request.url);
  keyUrl.hash = "";
  const key = keyUrl.href;
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(key);
  if (cached) {
    const range = request.headers.get("Range");
    return range ? sliceAudioRange(cached, range) : cached;
  }
  void fillAudio(key);
  return fetch(request);
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
  if (request.destination === "audio" && url.pathname.toLowerCase().includes("/music/")) {
    event.respondWith(handleMusic(request));
    return;
  }
  if (request.headers.get("range")) return;

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
