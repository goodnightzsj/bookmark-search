# Architecture of Storage Layer

## 1. Identity

- **What it is:** A dual-tier storage system combining chrome.storage.local and IndexedDB.
- **Purpose:** Provides persistent data storage with quota optimization, type-safe defaults, and graceful degradation.

## 2. Core Components

- `storage-service.js` (STORAGE_KEYS, DEFAULTS, getStorage, setStorage, getValue, setValue): Wraps chrome.storage.local with type-safe defaults and unified error handling.
- `idb-service.js` (idbGet, idbGetMany, idbSet, idbSetMany): IndexedDB key-value store for large datasets (bookmarks, favicons).
- `background-data.js` (loadCacheFromStorage, saveToStorage): Orchestrates dual-layer read/write with automatic migration.
- `background-messages.js` (GET_FAVICONS, SET_FAVICONS handlers): Manages favicon cache in IndexedDB.

## 3. Execution Flow (LLM Retrieval Map)

### Read Path (Bookmark Load)

- **1. Entry:** `loadCacheFromStorage` called in `background-data.js:376-410`.
- **2. IDB Attempt:** Calls `idbGet('cachedBookmarks')` from `idb-service.js:50-67`.
- **3. Fallback:** If IDB empty/fails, calls `getStorage(STORAGE_KEYS.BOOKMARKS)` from `storage-service.js:31-54`.
- **4. Migration:** If IDB was empty but chrome.storage had data, backfills IDB via `idbSet`.

### Write Path (Bookmark Save)

- **1. Entry:** `saveToStorage` called in `background-data.js:429-453`.
- **2. Parallel Write:** Simultaneously writes bookmarks to IDB (`idbSet('cachedBookmarks')`) and metadata to chrome.storage (`setStorage`).
- **3. Fallback:** If IDB write fails, stores bookmarks in chrome.storage as fallback.

### Favicon Cache Path

- **1. Read:** `GET_FAVICONS` handler in `background-messages.js:230-261` calls `idbGetMany` with prefixed keys (`favicon:` + domain).
- **2. Write:** `SET_FAVICONS` handler in `background-messages.js:263-296` calls `idbSetMany` for batch storage.

## 4. Design Rationale

- **Dual-layer architecture** avoids chrome.storage.local quota limits (~5MB) by offloading large bookmark arrays to IndexedDB.
- **chrome.storage.local** remains source of truth for metadata (count, sync time, theme) due to its reliability and sync capabilities.
- **Singleton DB connection** (`dbPromise` pattern) prevents connection leaks in Service Worker lifecycle.
- **Graceful degradation** ensures functionality even when IndexedDB is unavailable (e.g., private browsing).

## 5. IndexedDB Schema

- **Database:** `bookmark-search` (version 1)
- **Object Store:** `kv` with `key` as keyPath
- **Record Format:** `{ key: string, value: any }`
- **Key Patterns:**
  - `cachedBookmarks` - Full bookmark array
  - `favicon:{domain}` - Favicon data per domain
  - `recentOpenedRoots:v1` - Recently opened root domains snapshot (favicon warmup priority)
