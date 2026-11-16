import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("offline cache version matches the stylesheet and includes app, study, and engine assets", async () => {
  const [html, worker] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../service-worker.js", import.meta.url), "utf8")
  ]);
  const cacheVersion = worker.match(/CACHE_VERSION\s*=\s*"nightfall-v(\d+)"/)?.[1];
  const stylesheetVersion = html.match(/nightfall-redesign\.css\?v=(\d+)/)?.[1];

  assert.ok(cacheVersion);
  assert.equal(cacheVersion, stylesheetVersion);
  for (const asset of [
    "./index.html",
    "./openings.json",
    "./puzzles.json",
    "./assets/stockfish/stockfish-19-lite-single.js",
    "./assets/stockfish/stockfish-19-lite-single.wasm"
  ]) assert.ok(worker.includes(`"${asset}"`), `Missing offline asset ${asset}`);
});

test("offline fetch policy excludes APIs and cross-origin requests", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.match(worker, /url\.origin\s*!==\s*self\.location\.origin\s*\|\|\s*url\.pathname\.includes\("\/api\/"\)/);
  assert.match(worker, /request\.mode\s*===\s*"navigate"/);
  assert.match(worker, /IMMUTABLE_ASSET\.test\(url\.pathname\)/);
});
