# Storage Keys Reference

## 1. Core Summary

The extension uses two storage layers: chrome.storage.local for metadata and settings, IndexedDB for large datasets. All chrome.storage keys have type-safe defaults defined in `storage-service.js`.

## 2. Source of Truth

- **Primary Code:** `storage-service.js` - STORAGE_KEYS and DEFAULTS definitions, including migration metadata keys and strict storage-write helper.
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
| `kv / recentOpenedRoots:v1` | `Array<{ root, count, lastAt, sampleUrl }>` | Recently opened root domains snapshot for favicon warmup prioritization (cleared during migration, then rebuilt) |
| `kv / favicon:{domain}` | `FaviconEntry` | Cached favicon per domain |
| `documents / {id}` | `SearchDocument` | Primary persisted bookmark/search records derived from bookmarks |
| `meta / schemaVersion` | `number` | IndexedDB-side schema version mirror for migration/debugging |

## 5. Data Schemas

**Bookmark:** `{ id, title, url, path, dateAdded }`

**SearchDocument:** `{ id, sourceType, sourceId, title, subtitle, url, path: string[], keywords: string[], tags: string[], iconKey, updatedAt, metadata }`

**HistoryEntry:** `{ action, title, url, path, timestamp, oldTitle?, oldUrl?, oldPath?, newPath?, folder? }`

**FaviconEntry:** success entries use `{ src, updatedAt }` / `{ state: 'success', src, updatedAt }`; retryable failures use `{ state: 'failure', retryAt, updatedAt }`.

Notes:
- Migration keeps user assets (settings/history/meta), but intentionally clears transient favicon and warmup caches. These are rebuilt lazily after upgrade instead of being compat-migrated.
- Bookmark persistence is now documents-first: the `documents` store is the durable bookmark source, while runtime bookmark arrays are derived in memory for compatibility with existing search/update logic.
- Schema V3 removes legacy `kv/cachedBookmarks` and `kv/cachedBookmarksTime` keys after the documents store takeover.
- Startup migration writes schema state to both `chrome.storage.local` and IDB `meta/schemaVersion`; migration-critical storage writes now use strict failure semantics and debug clients can query raw state through `GET_MIGRATION_STATUS`.
- Persisted favicon success entries are reused without read-time TTL; retry suppression is represented by failure entries with `retryAt` cooldown. Search-time failure cooldown is now only written for explicit fast-fail states (`5xx`, `429`, `421`), with a 10-minute TTL.
- Browser-provided favicon cache in `background-messages.js` is an in-memory SW LRU keyed by normalized host for public sites, but by exact `host:port` service key for private/local hosts. It no longer uses positive TTL; entries live until evicted by capacity or Service Worker restart. Private hosts (`localhost`, IPv4, `.local/.lan/.internal/...`) still use a 1200ms fetch timeout and placeholder rejection.
- Content-side in-memory and persisted favicon lookups follow the same rule: public domains may reuse root-domain aliases, while private/local hosts keep exact per-service (`host:port`) keys and skip root alias expansion.
- Main bookmark cache staleness is controlled by `bookmarkCacheTtlMinutes` and checked during search with async stale refresh (non-blocking).
- Sync interval updates now go through background message `SET_SYNC_INTERVAL`, which persists `syncInterval` and updates the browser alarm in one background-owned flow.
- Warmup recent-open aggregation now preserves `host:port` granularity for private/local services, while public sites still aggregate by root domain.