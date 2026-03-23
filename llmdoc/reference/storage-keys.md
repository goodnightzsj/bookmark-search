# Storage Keys Reference

## 1. Core Summary

The extension uses two storage layers: chrome.storage.local for metadata and settings, IndexedDB for large datasets. All chrome.storage keys have type-safe defaults defined in `storage-service.js`.

## 2. Source of Truth

- **Primary Code:** `storage-service.js` - STORAGE_KEYS and DEFAULTS definitions, plus permissive vs strict storage read/write helpers (`getStorage`, `getStorageWithStatus`, `getStorageOrThrow`, `setStorageOrThrow`).
- **IDB Service:** `idb-service.js` - Database configuration and multi-store accessors (`kv`, `documents`, `meta`).
- **Migration Runner:** `migration-service.js` - schema migration, asset normalization, cache cleanup, bookmark-to-document migration, and V3 legacy bookmark-key cleanup.
- **Integration:** `background-data.js` - documents-first bookmark persistence with derived bookmark runtime compatibility view.
- **Favicon Keys:** `background-messages.js` - IDB_KEY_PREFIX_FAVICON constant.

## 3. chrome.storage.local Keys

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `bookmarks` | `Array<Bookmark>` | `[]` | Legacy compatibility key kept in chrome.storage.local defaults; active bookmark persistence is in IDB `documents` |
| `bookmarkCount` | `number` | `0` | Total bookmark count for UI display |
| `bookmarkHistory` | `Array<HistoryEntry>` | `[]` | Recent changes (max 100 items) |
| `lastSyncTime` | `number \| null` | `null` | Timestamp of last successful sync |
| `syncInterval` | `number` | `30` | Sync frequency in minutes |
| `bookmarkCacheTtlMinutes` | `number` | `30` | Main bookmark cache TTL (minutes), used to trigger background stale refresh on search |
| `bookmarksMeta` | `{ updatedAt: number, count: number }` | `{ updatedAt: 0, count: 0 }` | Bookmark cache metadata mirror (used for UI and consistency checks) |
| `theme` | `string` | `'original'` | Active theme name |
| `schemaVersion` | `number` | `0` | Current persisted schema version; current migration writes `3` |
| `migrationState` | `'idle' \| 'running' \| 'failed'` | `'idle'` | Migration runner state used during startup/update |
| `lastMigrationAt` | `number \| null` | `null` | Timestamp of the last successful migration |
| `lastMigrationError` | `string \| null` | `null` | Last migration failure summary |
| `needsRebuild` | `boolean` | `false` | Signals post-migration full bookmark rebuild if old caches were unusable |

## 4. IndexedDB Keys

| Store / Key Pattern | Type | Purpose |
|-------------|------|---------|
| `kv / recentOpenedRoots:v1` | `Array<{ root, count, lastAt, sampleUrl }>` | Recently opened favicon-key snapshot for warmup prioritization (cleared during migration, then rebuilt) |
| `kv / favicon:{domain}` | `FaviconEntry` | Cached favicon per favicon service key (`host` / `host:port`) |
| `documents / {id}` | `SearchDocument` | Primary persisted bookmark/search records derived from bookmarks |
| `meta / schemaVersion` | `number` | IndexedDB-side schema version mirror for migration/debugging |

## 5. Data Schemas

**Bookmark:** `{ id, title, url, path, dateAdded }`

**SearchDocument:** `{ id, sourceType, sourceId, title, subtitle, url, path: string[], iconKey, updatedAt, metadata }`

**HistoryEntry:** `{ action, title, url, path, timestamp, oldTitle?, oldUrl?, oldPath?, newPath?, folder? }`

**FaviconEntry:** success entries use `{ src, updatedAt }` / `{ state: 'success', src, updatedAt }`.

Notes:
- Migration keeps user assets (settings/history/meta), but intentionally clears transient favicon and warmup caches. These are rebuilt lazily after upgrade instead of being compat-migrated.
- Bookmark persistence is now documents-first: the `documents` store is the durable bookmark source, while background runtime state keeps `documents` as the primary in-memory cache and derives bookmark arrays plus a bookmark-id index only for compatibility with incremental update and compare logic.
- Schema V3 removes legacy `kv/cachedBookmarks` and `kv/cachedBookmarksTime` keys after the documents store takeover.
- Startup migration writes schema state to both `chrome.storage.local` and IDB `meta/schemaVersion`; migration-critical storage writes now use strict failure semantics and debug clients can query raw state through `GET_MIGRATION_STATUS`.
- `bookmarksMeta`, `bookmarkCount`, `lastSyncTime`, and `bookmarkHistory` are treated as one metadata mirror set. Background consistency repair rewrites them together when any key drifts or a storage read fails.
- Metadata mirror writes retry once before giving up, and runtime `lastSyncTime` only advances after the write succeeds.
- Persisted favicon success entries are reused without read-time TTL. Browser-provided favicon cache in `background-messages.js` is an in-memory SW LRU keyed by exact favicon service key (`host` / `host:port`) and lives until evicted by capacity or Service Worker restart.
- Private hosts (`localhost`, IPv4, `.local/.lan/.internal/...`) still use a 1200ms browser-favicon fetch timeout and placeholder rejection.
- Content-side in-memory and persisted favicon lookups now use the same exact service-key semantics as background-side lookup, with compatibility reads for older root-based entries.
- Main bookmark cache staleness is controlled by `bookmarkCacheTtlMinutes` and checked during search with async stale refresh (non-blocking).
- Sync interval updates now go through background message `SET_SYNC_INTERVAL`, which persists `syncInterval` and updates the browser alarm in one background-owned flow.
- Warmup recent-open aggregation now uses the same favicon service-key semantics as render-time lookup, preserving `host:port` granularity where needed.
- Background-side favicon host/service-key normalization now also uses the shared `utils.js` helpers, reducing drift between persistence, browser-favicon cache, warmup, and content-side lookup rules.
- Documents consistency repair uses an order-insensitive fingerprint summary before backfilling IndexedDB, so reordering without content change is less likely to trigger unnecessary repairs. Search reads the runtime `documents` cache first, then lazily rehydrates it from IndexedDB when needed before falling back to `chrome.bookmarks.search`.
- Background message success replies are now normalized through a local helper while preserving the existing `{ success: true, ...payload }` wire contract.
- Theme reads use strict storage access in user-facing pages and fall back to the localStorage theme cache only when the storage read actually fails.
