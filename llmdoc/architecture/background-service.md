# Architecture of Background Service

## 1. Identity

- **What it is:** MV3 Service Worker that manages bookmark synchronization, message routing, and keyboard shortcut handling.
- **Purpose:** Provides the persistent backend for bookmark caching, change detection, and cross-component communication.

## 2. Core Components

- `background.js` (`init`, `ensureInit`, `enqueueBookmarkEvent`): Entry point and orchestration. Singleton initialization, bookmark event listeners with debounce, alarm handlers, command listener for keyboard shortcuts.
- `background-data.js` (`refreshBookmarks`, `applyBookmarkEvents`, `searchBookmarks`, `loadInitialData`, `getWarmupDomainMap`, `recordBookmarkOpen`): Data management layer. In-memory cache, concurrency control, incremental/full sync logic, search algorithm, stale-cache TTL trigger, warmup domain prioritization.
- `background-messages.js` (`handleMessage`): Message router. Switch-based dispatcher for message actions (including `TRACK_BOOKMARK_OPEN`), favicon operations via IndexedDB, read-time TTL filter for persisted favicons, plus SW in-memory LRU for browser-provided favicons. For private hosts (localhost/IP/internal suffixes), browser favicon fetch uses longer timeout, shorter negative TTL, and keeps raw host keys instead of collapsing them.
- `background-sync.js` (`setupAutoSync`, `handleAlarm`, `initSyncSettings`): Scheduling layer. Periodic sync via chrome.alarms, interval configuration.

## 3. Execution Flow (LLM Retrieval Map)

### Initialization Flow

1. **Entry:** Service Worker starts, `background.js:204` calls `ensureInit()`.
2. **Singleton Guard:** `background.js:24-31` caches init promise to prevent duplicate initialization.
3. **Data Load:** `background-data.js:458-469` (`loadInitialData`) loads cache from IndexedDB/storage.
4. **Sync Setup:** `background-sync.js:38-41` (`initSyncSettings`) creates periodic alarm.

### Event-Driven Sync Flow

1. **Event Capture:** `background.js:66-111` registers 6 bookmark event listeners (created/removed/changed/moved/importBegan/importEnded).
2. **Debounce Queue:** `background.js:59-64` (`enqueueBookmarkEvent`) pushes events to array, schedules 500ms alarm.
3. **Alarm Trigger:** `background.js:115-134` processes debounce alarm, calls `applyBookmarkEvents()`.
4. **Incremental Update:** `background-data.js:196-374` (`applyBookmarkEventsOnce`) processes events, auto-fallback to full refresh if >200 events or folder-level changes.
5. **Full Refresh:** `background-data.js:109-150` (`refreshBookmarksOnce`) fetches `chrome.bookmarks.getTree`, flattens, diffs, saves.

### Message Routing Flow

1. **Receive:** `background.js:137` registers `chrome.runtime.onMessage` listener.
2. **Dispatch:** `background-messages.js:112-312` (`handleMessage`) switch on action type.
3. **Response:** Async handlers return `true` to keep channel open, call `sendResponse()` on completion.

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
│  - Update cache in-place│  │  - flattenBookmarksTree()           │
│  - O(1) lookup via Map  │  │  - compareBookmarks() → changes     │
└─────────────┬───────────┘  └──────────────────┬──────────────────┘
              │                                  │
              └────────────┬─────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Dual Storage Write                                              │
│  - IndexedDB (primary): cachedBookmarks array                    │
│  - chrome.storage.local (fallback): count, history, lastSyncTime │
└──────────────────────────────────────────────────────────────────┘
```

## 5. Design Rationale

- **Singleton Init:** MV3 Service Workers restart frequently; promise caching prevents race conditions during rapid startup events.
- **Debounce via Alarm:** In-memory timers don't survive Service Worker restarts; chrome.alarms persists across restarts.
- **Incremental + Full Hybrid:** Single bookmark changes use O(1) incremental updates; bulk imports trigger full refresh for consistency.
- **Stale TTL Self-heal:** Search reads `bookmarkCacheTtlMinutes`; when cache age exceeds TTL, it triggers async full refresh without blocking the current response.
- **Delete Event Fallback:** For remove events with incomplete `removeInfo.node`, fallback removal by `evt.id` prevents stale bookmark entries from lingering in cache.
- **Dual Storage:** IndexedDB handles large bookmark arrays (no quota issues); chrome.storage.local provides fast metadata access and fallback.
- **Concurrency Serialization:** `runUpdateLoop()` prevents race conditions when multiple sync triggers overlap.
