# Architecture of Storage Layer

## 1. Identity

- **What it is:** A dual-tier storage system combining chrome.storage.local and IndexedDB.
- **Purpose:** Provides persistent data storage with quota optimization, type-safe defaults, and graceful degradation.

## 2. Core Components

- `storage-service.js` (STORAGE_KEYS, DEFAULTS, getStorage, setStorage, getValue, setValue): Wraps chrome.storage.local with type-safe defaults and unified error handling, including schema/migration metadata keys.
- `idb-service.js` (idbGet, idbGetMany, idbSet, idbSetMany, idbGetAllDocuments, idbReplaceDocuments, idbGetMeta, idbSetMeta): IndexedDB access layer. The active bookmark persistence is now the `documents` store, while `kv` remains for non-bookmark keyed records such as favicon and warmup snapshots.
- `migration-service.js` (`ensureSchemaReady`, `getMigrationStatus`): Version migration runner. Normalizes persisted assets, migrates legacy bookmark cache into `documents`, clears transient caches, and in V3 removes the old bookmark-array keys from `kv`.
- `background-data.js` (loadCacheFromStorage, saveToStorage): Orchestrates documents-first bookmark cache read/write, keeps a derived bookmark-shaped runtime view for search logic, and syncs metadata into chrome.storage.local.
- `background-messages.js` (GET_FAVICONS, SET_FAVICONS, GET_MIGRATION_STATUS handlers): Manages favicon cache in IndexedDB and exposes migration diagnostics.

## 3. Execution Flow (LLM Retrieval Map)

### Startup Migration Path

- **1. Entry:** `background.js:init` calls `ensureSchemaReady()` before loading caches.
- **2. Version Check:** `migration-service.js` reads `schemaVersion`, `migrationState`, and `needsRebuild` from `chrome.storage.local`.
- **3. Asset Normalization:** User settings/history/meta are normalized in place; invalid values fall back to defaults.
- **4. Cache Cleanup:** Transient IDB caches (`favicon:*`, `recentOpenedRoots:v1`) are deleted during migration instead of being compatibility-migrated.
- **5. Data Migration:** V1 bookmark arrays are mapped into `SearchDocument` records and written into `documents` when needed.
- **6. Legacy Cleanup:** V3 removes old `kv/cachedBookmarks` and `kv/cachedBookmarksTime` keys after the documents store has become the primary source.
- **7. Finalize:** Schema version is persisted to both storage metadata and IDB `meta`, then background continues initialization.

### Read Path (Bookmark Load)

- **1. Entry:** `loadCacheFromStorage` reads bookmark history/meta from chrome.storage.local and bookmark records from IndexedDB `documents`.
- **2. Runtime Shape:** `background-data.js` restores `cachedDocuments` as the primary runtime state, then derives `cachedBookmarks` as a compatibility view for compare/search/warmup code paths.
- **3. Fallback:** If `documents` is empty, runtime cache stays empty and normal startup/search fallback logic triggers a fresh bookmark rebuild.
- **4. Result:** Persisted bookmark truth is documents-only; chrome.storage.local only mirrors metadata.

### Write Path (Bookmark Save)

- **1. Entry:** `saveToStorage` remains the main write path after full/incremental sync.
- **2. Primary Persistence:** Runtime bookmark changes are normalized into `SearchDocument` records and replace the full `documents` store contents.
- **3. Metadata Write:** chrome.storage.local stores only count/history/lastSync/meta for UI and bootstrapping. The legacy `bookmarks` key still exists as a compatibility/default slot, but the active save path no longer writes full bookmark arrays there.
- **4. Consistency Repair:** `ensureCacheConsistency` backfills `documents` and storage metadata when drift is detected; it no longer backfills legacy bookmark-array keys.

### Favicon Cache Path

- **1. Read:** `GET_FAVICONS` reads `favicon:` records from IDB `kv`.
- **2. Write:** `SET_FAVICONS` batch writes persisted favicon records into `kv`.
- **3. Migration Policy:** favicon cache is intentionally not migrated across schema versions; it is cleared and rebuilt lazily.

## 4. Design Rationale

- **Dual-layer architecture** avoids chrome.storage.local quota limits (~5MB) by offloading large bookmark data to IndexedDB.
- **Documents-first persistence** makes the new search model the single durable bookmark source, while keeping a lightweight derived bookmark runtime view for compatibility with existing algorithms.
- **chrome.storage.local** remains source of truth for metadata (count, sync time, theme) plus migration state because it is available very early in Service Worker startup.
- **Singleton DB connection** (`dbPromise` pattern) prevents connection leaks in Service Worker lifecycle.
- **Graceful degradation** ensures functionality even when IndexedDB is unavailable (e.g., private browsing).
- **Asset-vs-cache migration policy** keeps user settings/history, but intentionally clears favicon/warmup caches because they are transient and cheaper to rebuild than to compat-migrate.
- **Versioned cleanup** lets the extension first introduce new structures safely, then remove obsolete bookmark-array persistence once runtime reads/writes have fully switched over.

## 5. IndexedDB Schema

- **Database:** `bookmark-search` (version 2)
- **Object Stores:**
  - `kv` with `key` as keyPath — keyed cache store for favicon records and warmup snapshots.
  - `documents` with `id` as keyPath — primary bookmark-derived search document store.
  - `meta` with `key` as keyPath — internal DB metadata such as schema version.
- **Active `kv` Key Patterns:**
  - `favicon:{domain}` - Favicon data per domain
  - `recentOpenedRoots:v1` - Recently opened root domains snapshot for favicon warmup prioritization
- **Removed Legacy `kv` Key Patterns (cleaned by V3 migration):**
  - `cachedBookmarks`
  - `cachedBookmarksTime`
- **Document Schema:** bookmark-derived records use `{ id, sourceType, sourceId, title, subtitle, url, path, keywords, tags, iconKey, updatedAt, metadata }`.
