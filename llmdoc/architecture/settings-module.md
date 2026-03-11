# Architecture of Settings Module

## 1. Identity

- **What it is:** A modular settings page for the bookmark search extension.
- **Purpose:** Provides user configuration for themes, sync intervals, keyboard shortcuts, and bookmark history management with real-time UI updates.

## 2. Core Components

- `settings.js` (`init`, `setupStorageListener`): Main orchestrator that initializes all sub-modules and sets up `chrome.storage.onChanged` listener for real-time UI updates.
- `settings-theme.js` (`initThemeSelector`): Manages theme selection UI with 4 options (original/minimal/glass/dark), persists via `theme-loader.js`.
- `settings-shortcuts.js` (`loadShortcutInfo`, `bindShortcutEvents`, `checkShortcutConflicts`): Displays current shortcut via `chrome.commands` API, detects conflicts against 11 common browser shortcuts.
- `settings-sync.js` (`loadSyncSettings`, `loadBookmarkStats`, `bindSyncEvents`): Manages sync interval dropdown (5min-24h or disabled), displays sync times, triggers manual sync via message passing.
- `settings-history.js` (`loadUpdateHistory`, `bindHistoryEvents`, `exportSelectedBookmarks`): Displays bookmark change history, supports export mode with checkbox selection, generates Netscape HTML format.
- `settings.html`: Single-page card-based layout with 5 sections (theme, shortcuts, sync, history, about). The current UI structure is organized around `settings-section`, `stats-grid`, `settings-stack`, `action-grid`, `card-actions`, `shortcut-panel`, and `about-*` semantic blocks, and the 4 `themes/settings-*.css` files now provide full coverage for these shared structures with theme-specific visual treatments.

## 3. Execution Flow (LLM Retrieval Map)

- **1. Page Load:** `settings.html:202-204` loads `theme-loader.js` then `settings.js`.
- **2. Initialization:** `settings.js:9-30` (`init`) sequentially initializes all modules: theme → shortcuts → stats → sync → history.
- **3. Event Binding:** `settings.js:33-37` (`bindAllEvents`) binds events for shortcuts, sync, and history modules.
- **4. Storage Listener:** `settings.js:40-68` (`setupStorageListener`) monitors `chrome.storage.onChanged` for keys: `bookmarkCount`, `bookmarks`, `lastSyncTime`, `syncInterval`, `bookmarkHistory`.
- **5. Sync Flow:** User changes interval → `settings-sync.js:113-135` saves to storage → sends `MESSAGE_ACTIONS.UPDATE_SYNC_INTERVAL` to background → background updates `chrome.alarms`.
- **6. Manual Sync:** `settings-sync.js:80-110` sends `MESSAGE_ACTIONS.REFRESH_BOOKMARKS` → disables button → shows feedback for 1.5s.
- **7. History Export:** `settings-history.js:320-352` filters selected items → deduplicates by URL (keeps newest) → calls `bookmark-export.js` (`generateNetscapeBookmarkFile`) → triggers download.

## 4. UI Structure (5 Card Sections)

| Section | DOM ID | Sub-module | Key Elements |
|---------|--------|------------|--------------|
| Theme | `themeGrid` | `settings-theme.js` | 4 `.theme-option` with `data-theme` |
| Shortcuts | `shortcutInput`, `shortcutConflict` | `settings-shortcuts.js` | Read-only input, conflict alert |
| Sync | `syncInterval`, `syncBookmarks`, `totalBookmarks` | `settings-sync.js` | Dropdown, button, stats display |
| History | `historyList`, `exportControls` | `settings-history.js` | Timeline list, export toolbar |
| About | - | - | Static version info |

## 5. History Tracking (4 Action Types)

Defined in `constants.js` (`HISTORY_ACTIONS`):

| Action | Display Text | Fields |
|--------|--------------|--------|
| `add` | 新增 | timestamp, title, url, path |
| `delete` | 删除 | timestamp, title, url, path |
| `edit` | 编辑 | timestamp, title, url, oldTitle, oldUrl |
| `move` | 移动 | timestamp, title, oldPath, newPath |

## 6. Design Rationale

- **Modular Architecture:** Each settings domain (theme/shortcuts/sync/history) is isolated in its own file for maintainability.
- **Real-time Updates:** `chrome.storage.onChanged` listener enables instant UI refresh when background sync completes.
- **Stable Selection Keys:** History export uses composite keys (timestamp+action+url+...) instead of indices to prevent selection drift during list updates.
