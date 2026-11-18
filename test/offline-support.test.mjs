import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("offline cache version is independent from asset query versions and includes app, study, and engine assets", async () => {
  const [html, worker] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../service-worker.js", import.meta.url), "utf8")
  ]);
  const cacheVersion = worker.match(/CACHE_VERSION\s*=\s*"nightfall-v(\d+)"/)?.[1];
  const stylesheetVersion = html.match(/nightfall-redesign\.css\?v=(\d+)/)?.[1];

  assert.ok(cacheVersion);
  assert.ok([...cacheVersion].every(character => character >= "0" && character <= "9"));
  assert.ok(stylesheetVersion, "the redesign stylesheet has an explicit asset version");
  assert.ok(worker.includes(`"./nightfall-redesign.css?v=${stylesheetVersion}"`));
  assert.ok(worker.includes("STATIC_CACHE"));
  assert.ok(worker.includes("RUNTIME_CACHE"));
  for (const asset of [
    "./index.html",
    "./online-supabase.js?v=online-authoritative-snapshot-20261117",
    "./pgn-import.mjs",
    "./openings.json",
    "./puzzles.json",
    "./assets/stockfish/stockfish-19-lite-single.js",
    "./assets/stockfish/stockfish-19-lite-single.wasm"
  ]) assert.ok(worker.includes(`"${asset}"`), `Missing offline asset ${asset}`);
});

test("offline fetch policy excludes APIs and cross-origin requests", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.match(worker, /url\.origin\s*!==\s*self\.location\.origin\s*\|\|\s*isPuzzleApi\(url\)/);
  assert.ok(worker.includes("function isPuzzleApi(url)"));
  assert.ok(worker.includes("api\\/puzzles"));
  assert.match(worker, /staleWhileRevalidate\(event,\s*runtimeCache,\s*request\)/);
  assert.match(worker, /networkFirst\(staticCache,\s*request\)/);
});
