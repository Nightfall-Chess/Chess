import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

async function createWorkerHarness() {
  const listeners = new Map();
  const cached = new Map();
  const precached = [];
  let online = true;
  const origin = "https://nightfall.example";
  const scope = `${origin}/Chess/`;
  const cache = {
    async addAll(requests) {
      precached.push(...requests.map(request => request.url || request.href));
    },
    async match(request) {
      return cached.get(request.url);
    },
    async put(request, response) {
      cached.set(request.url, response);
    }
  };
  const self = {
    location: { origin },
    registration: { scope },
    clients: { claim: async () => {} },
    addEventListener(type, callback) { listeners.set(type, callback); },
    skipWaiting: async () => {}
  };
  const caches = {
    async open() { return cache; },
    async keys() { return ["nightfall-static-v1"]; },
    async delete() { return true; }
  };
  const networkFetch = async request => {
    if (!online) throw new TypeError("offline");
    const url = typeof request === "string" ? request : request.url;
    return new Response(url, { status: 200, headers: { "Content-Length": String(url.length) } });
  };
  const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  runInNewContext(
    source,
    { self, caches, fetch: networkFetch, Request, Response, URL, console, Promise },
    { filename: "service-worker.js" }
  );
  return {
    listeners,
    cached,
    precached,
    setOnline(value) { online = value; },
    origin,
    scope
  };
}

test("service worker pre-caches the app shell, leaves puzzle APIs uncached, and serves static assets offline", async () => {
  const harness = await createWorkerHarness();
  const install = { waitUntil(promise) { this.promise = promise; } };
  harness.listeners.get("install")(install);
  await install.promise;

  assert.ok(harness.precached.includes(`${harness.scope}index.html`), `Precacher received: ${harness.precached.join(", ")}`);
  assert.ok(harness.precached.includes(`${harness.scope}opening-book.mjs`));
  // Large files must not slow down the first page load while the worker installs.
  assert.equal(harness.precached.some(url => url.endsWith(".wasm") || url.endsWith("openings.json")), false);

  const activation = [];
  harness.listeners.get("activate")({ waitUntil(promise) { activation.push(promise); } });
  await Promise.all(activation);
  const wasmUrl = `${harness.scope}assets/stockfish/stockfish-19-lite-single.wasm`;
  assert.equal(harness.cached.has(wasmUrl), true);
  assert.equal(harness.cached.has(`${harness.scope}openings.json`), true);

  let audioIntercepted = false;
  harness.listeners.get("fetch")({
    request: new Request(`${harness.scope}Music/song.mp3`),
    respondWith() { audioIntercepted = true; }
  });
  assert.equal(audioIntercepted, false);

  let puzzleApiIntercepted = false;
  harness.listeners.get("fetch")({
    request: new Request(`${harness.scope}api/puzzles?offset=0`),
    respondWith() { puzzleApiIntercepted = true; }
  });
  assert.equal(puzzleApiIntercepted, false);

  const staticRequest = new Request(`${harness.scope}boards/board.png`);
  let responsePromise;
  harness.listeners.get("fetch")({ request: staticRequest, respondWith(promise) { responsePromise = promise; } });
  assert.equal((await responsePromise).status, 200);
  assert.equal(harness.cached.has(staticRequest.url), true);

  harness.setOnline(false);
  let offlineResponse;
  harness.listeners.get("fetch")({ request: staticRequest, respondWith(promise) { offlineResponse = promise; } });
  assert.equal((await offlineResponse).status, 200);
});
