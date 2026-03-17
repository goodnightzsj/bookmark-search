const DB_NAME = 'bookmark-search';
const DB_VERSION = 2;
const KV_STORE_NAME = 'kv';
const DOCUMENTS_STORE_NAME = 'documents';
const META_STORE_NAME = 'meta';

let dbPromise = null;

function openDb() {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error('IndexedDB is not available in this context'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE_NAME)) {
        db.createObjectStore(KV_STORE_NAME, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(DOCUMENTS_STORE_NAME)) {
        db.createObjectStore(DOCUMENTS_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME, { keyPath: 'key' });
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

function isConnectionClosed(error) {
  return error && (error.name === 'InvalidStateError' || (error.message && error.message.indexOf('InvalidStateError') >= 0));
}

function resetConnection() {
  dbPromise = null;
}

function validateKey(key) {
  if (typeof key !== 'string' || !key) {
    throw new Error('IDB key must be a non-empty string');
  }
}

function validatePrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix) {
    throw new Error('IDB prefix must be a non-empty string');
  }
}

function withRetry(run) {
  return run().catch((error) => {
    if (!isConnectionClosed(error)) throw error;
    resetConnection();
    return run();
  });
}

async function getStore(storeName, mode) {
  const db = await getDb();
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function idbGet(key) {
  validateKey(key);
  return withRetry(() => idbGetOnce(key));
}

async function idbGetOnce(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE_NAME, 'readonly');
    const store = tx.objectStore(KV_STORE_NAME);
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
  return withRetry(() => idbGetManyOnce(keyList));
}

async function idbGetManyOnce(keyList) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE_NAME, 'readonly');
    const store = tx.objectStore(KV_STORE_NAME);
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
  validateKey(key);
  return withRetry(() => idbSetOnce(key, value));
}

async function idbSetOnce(key, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE_NAME, 'readwrite');
    const store = tx.objectStore(KV_STORE_NAME);

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
  return withRetry(() => idbSetManyOnce(items));
}

async function idbSetManyOnce(items) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE_NAME, 'readwrite');
    const store = tx.objectStore(KV_STORE_NAME);

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));

    for (const item of items) {
      store.put({ key: item.key, value: item.value });
    }
  });
}

export async function idbDeleteByPrefix(prefix) {
  validatePrefix(prefix);
  return withRetry(() => idbDeleteByPrefixOnce(prefix));
}

async function idbDeleteByPrefixOnce(prefix) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE_NAME, 'readwrite');
    const store = tx.objectStore(KV_STORE_NAME);
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
    const cursorReq = store.openCursor(range);
    let deletedCount = 0;
    let settled = false;

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(deletedCount);
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

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      deletedCount++;
      cursor.delete();
      cursor.continue();
    };
    cursorReq.onerror = () => {
      if (settled) return;
      settled = true;
      reject(cursorReq.error || new Error('IndexedDB cursor failed'));
    };
  });
}

export async function idbGetAllDocuments() {
  return withRetry(() => idbGetAllDocumentsOnce());
}

async function idbGetAllDocumentsOnce() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOCUMENTS_STORE_NAME, 'readonly');
    const store = tx.objectStore(DOCUMENTS_STORE_NAME);
    const req = store.getAll();

    req.onsuccess = () => {
      resolve(Array.isArray(req.result) ? req.result : []);
    };
    req.onerror = () => {
      reject(req.error || new Error('IndexedDB getAll documents failed'));
    };
    tx.onerror = () => {
      reject(tx.error || new Error('IndexedDB transaction failed'));
    };
  });
}

export async function idbReplaceDocuments(documents) {
  const items = Array.isArray(documents)
    ? documents.filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id)
    : [];
  return withRetry(() => idbReplaceDocumentsOnce(items));
}

async function idbReplaceDocumentsOnce(items) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOCUMENTS_STORE_NAME, 'readwrite');
    const store = tx.objectStore(DOCUMENTS_STORE_NAME);
    const clearReq = store.clear();

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));

    clearReq.onerror = () => {
      reject(clearReq.error || new Error('IndexedDB clear documents failed'));
    };
    clearReq.onsuccess = () => {
      for (const item of items) {
        store.put(item);
      }
    };
  });
}

export async function idbGetMeta(key) {
  validateKey(key);
  return withRetry(() => idbGetMetaOnce(key));
}

async function idbGetMetaOnce(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, 'readonly');
    const store = tx.objectStore(META_STORE_NAME);
    const req = store.get(key);

    req.onsuccess = () => {
      resolve(req.result ? req.result.value : undefined);
    };
    req.onerror = () => {
      reject(req.error || new Error('IndexedDB get meta failed'));
    };
    tx.onerror = () => {
      reject(tx.error || new Error('IndexedDB transaction failed'));
    };
  });
}

export async function idbSetMeta(key, value) {
  validateKey(key);
  return withRetry(() => idbSetMetaOnce(key, value));
}

async function idbSetMetaOnce(key, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, 'readwrite');
    const store = tx.objectStore(META_STORE_NAME);

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));

    store.put({ key, value });
  });
}
