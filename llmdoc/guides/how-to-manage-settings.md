# How to Manage Settings

## Available Settings

| Setting | Location | Options | Default | Storage Key |
|---------|----------|---------|---------|-------------|
| Theme | Theme card | original, minimal, glass, dark | original | `STORAGE_KEYS.THEME` |
| Sync Interval | Sync card dropdown | 5/10/15/30/60/120/360/720/1440 min, 0 (disabled) | 30 | `STORAGE_KEYS.SYNC_INTERVAL` |
| Bookmark Cache TTL | Sync card dropdown | 30/60/360/720/1440 min | 30 | `STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES` |
| Favicon Cache Clear | Sync card button | Manual clear | - | Message action `CLEAR_FAVICON_CACHE` |
| Keyboard Shortcut | Shortcuts card | Read-only (modify via Chrome) | - | `chrome.commands` |

Theme changes now update a fully themed settings page: theme chooser, shortcut panel, sync stats, strategy rows, maintenance card, history toolbar/list, and about section all follow the active theme.
Theme writes now use strict storage semantics; failed writes surface an error instead of leaving the selector in a false-success state.

## Configure Sync Interval

1. Open settings page via popup or `chrome-extension://[id]/settings.html`.
2. Locate "书签同步设置" card, find the dropdown `#syncInterval`.
3. Select desired interval. `settings-sync.js` sends `MESSAGE_ACTIONS.SET_SYNC_INTERVAL` to background and treats any missing/failed runtime response as an error.
4. Background service worker persists the new interval and updates `chrome.alarms` schedule in the same flow.
5. Verify: "下次同步时间" display updates immediately.

## Configure Main Cache TTL

1. In "书签同步设置", locate dropdown `#bookmarkCacheTtl`.
2. Choose one of 30 分钟 / 1 小时 / 6 小时 / 12 小时 / 24 小时.
3. `settings-sync.js` writes `STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES` with strong failure semantics; on failure the select is reloaded back to the persisted value.
4. Search path (`background-data.js:627-636`) reads this value and compares against `lastSyncTime`.
5. If stale, it triggers `refreshBookmarks()` asynchronously (non-blocking), so current search result returns immediately and data self-heals in background.

## Clear Favicon Cache

1. In "书签同步设置", locate the `#clearFaviconCache` button near favicon-related controls.
2. Click the button to send `MESSAGE_ACTIONS.CLEAR_FAVICON_CACHE` from `settings-sync.js:184-217`.
3. Background clears its in-memory browser favicon cache, deletes persisted `favicon:*` entries via IndexedDB, then best-effort broadcasts the same action to active content scripts without blocking the settings response.
4. Active content scripts reset in-memory favicon state immediately, so future searches re-enter the favicon fetch chain.
5. Scope boundary: this only clears the extension's own icon/favicon cache; it does not clear Chrome's built-in favicon cache.

## View and Export History

1. Scroll to "书签更新历史" card.
2. Click "导出书签" button to enter export mode (`settings-history.js:281-302`).
3. Use "全选" / "取消全选" or click individual items to select.
4. Click "导出选中" to generate Netscape HTML file (`bookmark-export.js`). Duplicate URLs are preserved if they came from different history entries.
5. File downloads as `bookmarks_export.html`, importable to any browser.

## Clear History

1. In the history card, click "清空历史记录".
2. The settings page sends `MESSAGE_ACTIONS.CLEAR_HISTORY` to background instead of mutating storage locally.
3. Background serializes clear-history with refresh/incremental sync work, so clear and sync cannot race.
4. If the storage write fails, in-memory history is rolled back and the settings page shows an error.

## Add a New Setting

1. Add storage key to `storage-service.js` (`STORAGE_KEYS`) and default value to `DEFAULTS`.
2. Create or update sub-module in `settings-*.js` with load/bind functions.
3. Add UI elements to `settings.html` in appropriate card section.
4. Import and call new functions in `settings.js` (`init` and `bindAllEvents`).
5. If setting affects background, add message handler in `background-messages.js` using `MESSAGE_ACTIONS`.
6. Add storage key to `setupStorageListener` in `settings.js:40-68` if real-time UI update is needed.
