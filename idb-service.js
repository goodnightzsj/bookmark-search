const DB_NAME = 'bookmark-search';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

let dbPromise = null;

function openDb() {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('IndexedDB is not available in this context'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch (e) {}
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB'));
    };

    request.onblocked = () => {
      reject(new Error('IndexedDB open is blocked'));
    };
  });
}

function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = openDb().catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

export async function idbGet(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);

    req.onsuccess = () => {
      resolve(req.result ? req.result.value : undefined);
    };
    req.onerror = () => {
      reject(req.error || new Error('IndexedDB get failed'));
    };
    tx.onerror = () => {
      reject(tx.error || new Error('IndexedDB transaction failed'));
    };
  });
}

export async function idbGetMany(keys) {
  const keyList = Array.isArray(keys)
    ? Array.from(new Set(keys.filter((key) => typeof key === 'string' && key)))
    : [];

  if (keyList.length === 0) return {};

  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const output = {};
    let settled = false;

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(output);
    };
    tx.onerror = () => {
      if (settled) return;
      settled = true;
      reject(tx.error || new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      reject(tx.error || new Error('IndexedDB transaction aborted'));
    };

    keyList.forEach((key) => {
      const req = store.get(key);
      req.onsuccess = () => {
        output[key] = req.result ? req.result.value : undefined;
      };
    });
  });
}

export async function idbSet(key, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));

    store.put({ key, value });
  });
}

export async function idbSetMany(entries) {
  const items = Array.isArray(entries)
    ? entries.filter((item) => item && typeof item.key === 'string' && item.key)
    : [];

  if (items.length === 0) return true;

  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));

    for (const item of items) {
      store.put({ key: item.key, value: item.value });
    }
  });
}

export async function idbDelete(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));

    store.delete(key);
  });
}
