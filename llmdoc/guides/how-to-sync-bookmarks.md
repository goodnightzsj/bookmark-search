# How to Sync Bookmarks

## Sync Trigger Methods

### Automatic Triggers

1. **Periodic Sync:** Configured via `STORAGE_KEYS.SYNC_INTERVAL` (default 30 minutes). Alarm fires `ALARM_NAMES.SYNC_BOOKMARKS`, handled by `background-sync.js:28-32`.

2. **Event-Driven Sync:** Native bookmark changes (create/remove/change/move) trigger debounced sync after 500ms idle. See `background.js:66-92`.

3. **Import Completion:** `onImportEnded` triggers full refresh via `forceRefresh` event. See `background.js:105-111`.

### Manual Triggers

1. **Message API:** Send `MESSAGE_ACTIONS.REFRESH_BOOKMARKS` via `chrome.runtime.sendMessage()`. Handled by `background-messages.js:50-57`.

2. **Direct Call:** From background context, call `refreshBookmarks()` from `background-data.js`. The update loop will serialize it with any pending incremental batches.

## Incremental vs Full Refresh Logic

| Condition | Sync Type | Code Reference |
|-----------|-----------|----------------|
| Single bookmark create/change/move/remove | Incremental | `background-data.js:240-359` |
| Event queue > 200 items | Full refresh | `background-data.js:205-208` |
| Event queue > 500 items | Full refresh | `background-data.js:97-99` |
| Folder-level change/move | Full refresh | `background-data.js:220-227` |
| Import operation | Full refresh | `background-data.js:216-218` |
| Service Worker restart (lost queue) | Full refresh | `background.js:126-128` |

## Adding a New Message Handler

1. **Define Action:** Add constant to `constants.js` in `MESSAGE_ACTIONS` object.

2. **Implement Handler:** Add case to switch in `background-messages.js`. Follow the existing success/error wrapper pattern so async branches keep the stable `{ success: true, ...payload }` / `{ success: false, error }` contract when replying.

3. **Call from Client:** Use `chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.YOUR_ACTION, ...params })`, then validate that the reply is an object with `success === true`. Current popup/settings callers use `message-response.js` for this check.

## Modifying Sync Intervals

1. **Change Default:** Edit `DEFAULTS.syncInterval` in `storage-service.js` (value in minutes, 0 disables).

2. **Runtime Update:** Send `MESSAGE_ACTIONS.SET_SYNC_INTERVAL` with `{ interval: minutes }`. Background persists the new value and updates the alarm in the same flow.

3. **Debounce Delay:** Modify `DEBOUNCE_DELAY_MS` constant in `background.js:46` (value in milliseconds).

## Verification

- Check `chrome://extensions` → Service Worker → Inspect → Console for `[Background]` logs.
- For favicon diagnosis, enable `chrome.storage.local.set({ debugFavicon: true })` or set `window.__BOOKMARK_SEARCH_DEBUG_FAVICON__ = true` in the page console before reopening the overlay, then inspect `[Content][Favicon]` and `[Background][Favicon]` logs.
- Verify alarm status: `chrome.alarms.getAll()` in DevTools console.
- Check storage: `chrome.storage.local.get(['bookmarksMeta', 'bookmarkCount', 'lastSyncTime', 'bookmarkHistory'])`.
