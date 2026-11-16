import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

class FakeRequest {
  result = undefined;
  error = null;
  onsuccess = null;
  onerror = null;
}

class FakeTransaction {
  oncomplete = null;
  onerror = null;
  onabort = null;
  #pending = 0;
  #completionQueued = false;
  #completed = false;

  constructor(stores, storeName) {
    this.stores = stores;
    this.storeName = storeName;
  }

  objectStore(name) {
    assert.equal(name, this.storeName);
    const records = this.stores.get(name);
    return {
      get: key => this.#request(() => structuredClone(records.get(key))),
      getAll: () => this.#request(() => [...records.values()].map(record => structuredClone(record))),
      put: value => this.#request(() => {
        records.set(value.id, structuredClone(value));
        return value.id;
      }),
      delete: key => this.#request(() => records.delete(key))
    };
  }

  #request(operation) {
    const request = new FakeRequest();
    this.#pending++;
    setImmediate(() => {
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
      this.#pending--;
      this.#queueCompletion();
    });
    return request;
  }

  #queueCompletion() {
    if (this.#pending || this.#completionQueued || this.#completed) return;
    this.#completionQueued = true;
    setImmediate(() => {
      this.#completionQueued = false;
      if (this.#pending || this.#completed) return;
      this.#completed = true;
      this.oncomplete?.();
    });
  }
}

class FakeDatabase {
  stores = new Map();
  objectStoreNames = { contains: name => this.stores.has(name) };

  createObjectStore(name) {
    this.stores.set(name, new Map());
  }

  transaction(storeName) {
    assert.ok(this.stores.has(storeName), `Missing object store ${storeName}`);
    return new FakeTransaction(this.stores, storeName);
  }
}

function installFakeIndexedDb() {
  const databases = new Map();
  globalThis.indexedDB = {
    open(name) {
      const request = new FakeRequest();
      setImmediate(() => {
        let database = databases.get(name);
        const isNew = !database;
        if (isNew) {
          database = new FakeDatabase();
          databases.set(name, database);
        }
        request.result = database;
        if (isNew) request.onupgradeneeded?.({ target: request });
        setImmediate(() => request.onsuccess?.({ target: request }));
      });
      return request;
    }
  };
}

test("archive actions retain record identity, persist favorites, cache analysis, and delete only the selected game", async () => {
  installFakeIndexedDb();
  const archive = await import("../game-archive.mjs");
  const game = { id: "game-one", plies: 1, entries: [{ san: "e4" }] };
  await archive.saveGame(game);
  await archive.saveGame({ ...game, favorite: true });
  await archive.saveGame({ id: "game-two", plies: 0, entries: [] });
  await archive.saveGameAnalysis("game-one", 0, { label: "Good", accuracy: 91 });

  assert.equal((await archive.getGame("game-one")).favorite, true);
  assert.deepEqual((await archive.getGame("game-one")).entries[0].analysis, { label: "Good", accuracy: 91 });
  assert.deepEqual((await archive.listGames()).map(record => record.id).sort(), ["game-one", "game-two"]);
  await archive.deleteGame("game-one");
  assert.equal(await archive.getGame("game-one"), undefined);
  assert.equal((await archive.getGame("game-two")).id, "game-two");
});

test("Game Review keeps eight semantic columns and prevents rows becoming CSS grids", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../nightfall-redesign.css", import.meta.url), "utf8");
  const colgroup = html.match(/<colgroup>(.*?)<\/colgroup>/s)?.[1];
  const headers = html.match(/<thead id="analysisHeaders">([\s\S]*?)<\/thead>/)?.[1];

  assert.equal((colgroup?.match(/<col>/g) || []).length, 8);
  assert.equal((headers?.match(/<th\b/g) || []).length, 8);
  assert.match(css, /\.analysis-table tr\.analysis-row\s*\{\s*display:\s*table-row;/);
  assert.match(html, /id="analysisPlayerFilter"/);
  assert.match(html, /id="analysisClassificationFilter"/);
});
