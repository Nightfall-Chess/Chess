const DATABASE_NAME = "nightfall-chess-archive";
const DATABASE_VERSION = 2;

let databasePromise;

function openDatabase() {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("This browser does not support persistent game archives."));
  }
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("games")) {
        database.createObjectStore("games", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("moments")) {
        database.createObjectStore("moments", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("preferences")) {
        database.createObjectStore("preferences", { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains("achievements")) {
        database.createObjectStore("achievements", { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error("Could not open the game archive."));
    request.onblocked = () => reject(new Error("The game archive is busy in another tab. Close older Nightfall tabs and retry."));
  }).catch(error => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

function requestResult(request, operation) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`${operation} failed.`));
  });
}

async function storeRequest(storeName, mode, operation) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, mode);
  const result = await requestResult(operation(transaction.objectStore(storeName)), `Archive ${mode}`);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("The archive transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("The archive transaction was cancelled."));
  });
  return result;
}

export function listGames() {
  return storeRequest("games", "readonly", store => store.getAll());
}

export function saveGame(game) {
  return storeRequest("games", "readwrite", store => store.put(game));
}

export function getGame(id) {
  return storeRequest("games", "readonly", store => store.get(id));
}

export function deleteGame(id) {
  return storeRequest("games", "readwrite", store => store.delete(id));
}

export async function saveGameAnalysis(id, index, analysis) {
  const database = await openDatabase();
  const transaction = database.transaction("games", "readwrite");
  const store = transaction.objectStore("games");
  const game = await requestResult(store.get(id), "Read archived game");
  if (!game || !game.entries[index]) return;
  game.entries[index].analysis = analysis;
  await requestResult(store.put(game), "Cache game analysis");
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("The archive transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("The archive transaction was cancelled."));
  });
}

export function listMoments() {
  return storeRequest("moments", "readonly", store => store.getAll());
}

export function saveMoment(moment) {
  return storeRequest("moments", "readwrite", store => store.put(moment));
}

export function deleteMoment(id) {
  return storeRequest("moments", "readwrite", store => store.delete(id));
}

export async function getPreference(key) {
  const record = await storeRequest("preferences", "readonly", store => store.get(key));
  return record?.value;
}

export function savePreference(key, value) {
  if (typeof key !== "string" || !key) {
    return Promise.reject(new TypeError("A preference key is required."));
  }
  return storeRequest("preferences", "readwrite", store => store.put({ key, value, updatedAt: Date.now() }));
}

export async function getAchievementProgress() {
  const record = await storeRequest("achievements", "readonly", store => store.get("progress"));
  return record?.value ?? {};
}

export function saveAchievementProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Promise.reject(new TypeError("Achievement progress must be an object."));
  }
  return storeRequest("achievements", "readwrite", store => store.put({ key: "progress", value, updatedAt: Date.now() }));
}
