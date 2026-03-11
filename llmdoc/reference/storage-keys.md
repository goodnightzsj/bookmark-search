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
| `faviconCacheSize` | `number` | `2000` | In-memory favicon cache size (content script LRU) |
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

**FaviconEntry:** `{ src, updatedAt }`

Notes:
- Favicon persisted cache now applies read-time TTL filtering in `background-messages.js:248-253` with `PERSISTED_FAVICON_TTL_MS`.
- Browser-provided favicon cache in `background-messages.js` keeps private hosts (`localhost`, IPv4, `.local/.lan/.internal/...`) on raw host keys, uses a 1200ms fetch timeout for those hosts, and shortens negative cache TTL to 30s so local-network sites recover quickly.
- Main bookmark cache staleness is controlled by `bookmarkCacheTtlMinutes` and checked in `background-data.js:627-636` during search (async stale refresh, non-blocking).
