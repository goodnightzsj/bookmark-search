# Storage Keys Reference

## 1. Core Summary

The extension uses two storage layers: chrome.storage.local for metadata and settings, IndexedDB for large datasets. All chrome.storage keys have type-safe defaults defined in `storage-service.js`.

## 2. Source of Truth

- **Primary Code:** `storage-service.js:7-24` - STORAGE_KEYS and DEFAULTS definitions.
- **IDB Service:** `idb-service.js:1-3` - Database configuration (name, version, store).
- **Integration:** `background-data.js:10` - IDB_CACHE_KEY_BOOKMARKS constant.
- **Favicon Keys:** `background-messages.js:6` - IDB_KEY_PREFIX_FAVICON constant.

## 3. chrome.storage.local Keys

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `bookmarks` | `Array<Bookmark>` | `[]` | Fallback bookmark storage (primary in IDB) |
| `bookmarkCount` | `number` | `0` | Total bookmark count for UI display |
| `bookmarkHistory` | `Array<HistoryEntry>` | `[]` | Recent changes (max 100 items) |
| `lastSyncTime` | `number \| null` | `null` | Timestamp of last successful sync |
| `syncInterval` | `number` | `30` | Sync frequency in minutes |
| `bookmarkCacheTtlMinutes` | `number` | `30` | Main bookmark cache TTL (minutes), used to trigger background stale refresh on search |
| `bookmarksMeta` | `{ updatedAt: number, count: number }` | `{ updatedAt: 0, count: 0 }` | Bookmark cache metadata mirror (used for UI and consistency checks) |
| `theme` | `string` | `'original'` | Active theme name |

## 4. IndexedDB Keys

| Key Pattern | Type | Purpose |
|-------------|------|---------|
| `cachedBookmarks` | `Array<Bookmark>` | Primary bookmark array storage |
| `recentOpenedRoots:v1` | `Array<{ root, count, lastAt, sampleUrl }>` | Recently opened root domains snapshot for favicon warmup prioritization (persists across SW restarts) |
| `favicon:{domain}` | `FaviconEntry` | Cached favicon per domain |

## 5. Data Schemas

**Bookmark:** `{ id, title, url, path, dateAdded }`

**HistoryEntry:** `{ action, title, url, path, timestamp, oldTitle?, oldUrl?, oldPath?, newPath?, folder? }`

**FaviconEntry:** success entries use `{ src, updatedAt }` / `{ state: 'success', src, updatedAt }`; retryable failures use `{ state: 'failure', retryAt, updatedAt }`.

Notes:
- Persisted favicon success entries are reused without read-time TTL; retry suppression is represented by failure entries with `retryAt` cooldown. Search-time failure cooldown is now only written for explicit fast-fail states (`5xx`, `429`, `421`), with a 10-minute TTL.
- Browser-provided favicon cache in `background-messages.js` is an in-memory SW LRU keyed by normalized host for public sites, but by exact `host:port` service key for private/local hosts. It no longer uses positive TTL; entries live until evicted by capacity or Service Worker restart. Private hosts (`localhost`, IPv4, `.local/.lan/.internal/...`) still use a 1200ms fetch timeout and placeholder rejection.
- Content-side in-memory and persisted favicon lookups follow the same rule: public domains may reuse root-domain aliases, while private/local hosts keep exact per-service (`host:port`) keys and skip root alias expansion.
- Main bookmark cache staleness is controlled by `bookmarkCacheTtlMinutes` and checked in `background-data.js:627-636` during search (async stale refresh, non-blocking).
