# Architecture of Background Service

## 1. Identity

- **What it is:** MV3 Service Worker that manages bookmark synchronization, message routing, and keyboard shortcut handling.
- **Purpose:** Provides the persistent backend for bookmark caching, change detection, and cross-component communication.

## 2. Core Components

- `background.js` (`init`, `ensureInit`, `enqueueBookmarkEvent`): Entry point and orchestration. Singleton initialization, schema migration bootstrap, bookmark event listeners with debounce, alarm handlers, command listener for keyboard shortcuts.
- `migration-service.js` (`ensureSchemaReady`, `getMigrationStatus`): Startup migration layer. Normalizes storage assets, clears transient legacy caches, migrates bookmark cache into the `documents` store, removes legacy bookmark-array keys in V3, and exposes migration diagnostics.
- `background-data.js` (`refreshBookmarks`, `applyBookmarkEvents`, `searchBookmarks`, `loadInitialData`, `getWarmupDomainMap`, `recordBookmarkOpen`): Data management layer. A single runtime state container keeps `documents` as the primary in-memory source plus a derived bookmark compatibility view and bookmark-id index for boundary logic. Search now prefers the runtime `documents` cache and can lazily hydrate it back from IndexedDB before falling back to the native Chrome bookmarks API. The module also handles concurrency control, incremental/full sync logic, stale-cache TTL trigger, and warmup domain prioritization.
- `background-messages.js` (`handleMessage`): Message router. Switch-based dispatcher for message actions (including `TRACK_BOOKMARK_OPEN`, `GET_MIGRATION_STATUS`, and `SET_SYNC_INTERVAL`), favicon operations via IndexedDB, persisted favicon success/failure state reads, plus SW in-memory LRU for browser-provided favicons. Favicon host/service-key normalization now reuses the shared `utils.js` helpers instead of maintaining a background-local copy, so private-host detection and root-domain folding stay aligned with the rest of the extension. Persisted success records are reused without read-time TTL, while failure records carry `retryAt` cooldown semantics so later searches can retry. Search-time cooldown is now intentionally narrow: only explicit fast-fail favicon states (`5xx`, `429`, `421`) are expected to persist, with a 10-minute TTL, while generic one-off misses are no longer stored as long-lived cooldown. Browser favicon responses also expose placeholder metadata to keep default browser globe results out of the long-lived success cache. The SW memory cache is now pure LRU without positive TTL; entries stay available until evicted by capacity or lost on Service Worker restart. For private hosts (localhost/IP/internal suffixes), browser favicon fetch still uses a longer timeout and keeps exact `host:port` service keys instead of collapsing them. Background also exposes a lightweight favicon-URL status probe used by content-script local/origin fallback; `5xx`, `429`, and `421` are surfaced as fast-fail signals so broken sites stop consuming the rest of the local candidate list. SVG/data-URL monogram placeholders from browser favicon are also rejected for private hosts, and `CLEAR_FAVICON_CACHE` now clears SW memory cache, deletes persisted `favicon:*` entries, and then best-effort broadcasts cache invalidation to content scripts without blocking the settings response. Message success replies also now go through a shared local helper, reducing per-branch response-shape drift while keeping the existing payload contract unchanged.
- `background-sync.js` (`setupAutoSync`, `handleAlarm`, `initSyncSettings`): Scheduling layer. Periodic sync via chrome.alarms, interval configuration.

## 3. Execution Flow (LLM Retrieval Map)

### Initialization Flow

1. **Entry:** Service Worker starts and `background.js` calls `ensureInit()`.
2. **Singleton Guard:** `ensureInit()` caches init promise to prevent duplicate initialization during rapid MV3 wakeups.
3. **Schema Check / Migration:** `migration-service.js:ensureSchemaReady()` runs before cache loading. It reads migration metadata, upgrades old storage records, clears transient legacy favicon/warmup caches, migrates bookmark cache into `documents` when needed, and removes legacy bookmark-array keys in schema V3.
4. **Data Load:** `background-data.js:loadInitialData()` loads runtime cache from IndexedDB/storage. It restores the runtime state container with `documents` as the bookmark source, then reconstructs bookmark-shaped in-memory records and a bookmark-id index only as compatibility helpers for incremental event handling and legacy boundary logic.
5. **Sync Setup:** `background-sync.js:initSyncSettings()` creates periodic alarm.
6. **Post-migration Rebuild:** If migration marked `needsRebuild`, background triggers one full bookmark refresh after initialization to regenerate the documents store and metadata mirrors.

### Event-Driven Sync Flow

1. **Event Capture:** `background.js:66-111` registers 6 bookmark event listeners (created/removed/changed/moved/importBegan/importEnded).
2. **Debounce Queue:** `background.js:59-64` (`enqueueBookmarkEvent`) pushes events to array, schedules 500ms alarm.
3. **Alarm Trigger:** `background.js:115-134` processes debounce alarm, calls `applyBookmarkEvents()`.
4. **Incremental Update:** `background-data.js:applyBookmarkEventsOnce()` mutates the runtime state container in memory, keeps the derived bookmark index aligned, and auto-falls back to full refresh if >200 events or folder-level changes.
5. **Full Refresh:** `background-data.js:refreshBookmarksOnce()` fetches `chrome.bookmarks.getTree`, flattens, diffs against the documents-derived bookmark view, then persists refreshed documents + metadata.

### Message Routing Flow

1. **Receive:** `background.js` registers `chrome.runtime.onMessage` listener.
2. **Dispatch:** `background-messages.js:handleMessage` switches on action type.
3. **Init Gate:** Actions that depend on data/migration readiness run behind `ensureInit()`.
4. **Diagnostics:** `GET_MIGRATION_STATUS` returns current schema version, migration state, rebuild flag, last migration timestamps/errors, and document count. It reads raw migration state directly instead of forcing `ensureInit()` first, so startup diagnostics remain observable.
5. **Response:** Async handlers return `true` to keep channel open, call `sendResponse()` on completion.

## 4. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Chrome Bookmark Events                       │
│  (onCreated, onRemoved, onChanged, onMoved, onImport*)          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  background.js: Debounce Queue (500ms alarm)                     │
│  - enqueueBookmarkEvent() → debounceBookmarkEvents[]             │
│  - Import in progress? Skip events, wait for importEnded         │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  background-data.js: Concurrency Control                         │
│  - runUpdateLoop() serializes all updates                        │
│  - pendingRefresh flag → full refresh                            │
│  - pendingBookmarkEvents[] → incremental update                  │
│  - >500 events or folder changes → auto-escalate to full         │
└──────────────────────────┬───────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────────┐  ┌─────────────────────────────────────┐
│  Incremental Update     │  │  Full Refresh                       │
│  - Process event types  │  │  - chrome.bookmarks.getTree()       │
│  - Update runtime docs  │  │  - flattenBookmarksTree()           │
│  - Derive bookmark view │  │  - compareBookmarks() → changes     │
└─────────────┬───────────┘  └──────────────────┬──────────────────┘
              │                                  │
              └────────────┬─────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Primary Persistence                                             │
│  - IndexedDB documents: normalized SearchDocument records        │
│  - chrome.storage.local: count, history, lastSyncTime, meta      │
└──────────────────────────────────────────────────────────────────┘
```

## 5. Design Rationale

- **Singleton Init:** MV3 Service Workers restart frequently; promise caching prevents race conditions during rapid startup events.
- **Migration-first Boot:** Schema migration runs before normal cache loading so extension updates can reshape persisted data without breaking runtime assumptions.
- **Debounce via Alarm:** In-memory timers don't survive Service Worker restarts; chrome.alarms persists across restarts.
- **Incremental + Full Hybrid:** Single bookmark changes use O(1) incremental updates; bulk imports trigger full refresh for consistency.
- **Stale TTL Self-heal:** Search reads `bookmarkCacheTtlMinutes`; when cache age exceeds TTL, it triggers async full refresh without blocking the current response.
- **Delete Event Fallback:** For remove events with incomplete `removeInfo.node`, fallback removal by `evt.id` prevents stale bookmark entries from lingering in cache.
- **Documents-first takeover:** Bookmark persistence has completed the transition from legacy `cachedBookmarks` to `documents`; old bookmark-array keys are now migration cleanup targets rather than active runtime dependencies.
- **Asset-vs-cache Policy:** User settings/history/meta are normalized and kept; transient favicon/warmup caches are cleared during migration and rebuilt lazily.
- **Concurrency Serialization:** `runUpdateLoop()` prevents race conditions when multiple sync triggers overlap.
- **Atomic Sync Interval Update:** settings now update `syncInterval` through a background-owned `SET_SYNC_INTERVAL` action so storage value and alarm schedule move together.
- **Queued Sync Feedback:** manual refresh callers distinguish queued/skipped state from completed sync, avoiding false “already finished” feedback.
