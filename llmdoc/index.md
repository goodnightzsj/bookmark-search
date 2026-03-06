# Bookmark Search - LLM Documentation Index

> Chrome Extension (MV3) for rapid bookmark search via global keyboard shortcut.

## Quick Navigation

| Category | Purpose | Documents |
|----------|---------|-----------|
| [Overview](#overview) | Project context and identity | 1 |
| [Architecture](#architecture) | System design and execution flows | 4 |
| [Guides](#guides) | Step-by-step operational instructions | 3 |
| [Reference](#reference) | Lookup tables and conventions | 2 |

---

## Overview

High-level project context for understanding scope and purpose.

| Document | Description |
|----------|-------------|
| [project-overview.md](overview/project-overview.md) | Extension identity, tech stack, architecture components, key features, and target users. |

---

## Architecture

System design documents with execution flows for LLM retrieval.

| Document | Description |
|----------|-------------|
| [background-service.md](architecture/background-service.md) | MV3 Service Worker: bookmark sync, message routing, event debouncing, alarm scheduling. |
| [content-script.md](architecture/content-script.md) | Search overlay UI: DOM rendering, 3-layer focus management, favicon caching, IME handling. |
| [settings-module.md](architecture/settings-module.md) | Settings page: theme/sync/shortcuts/history modules, real-time storage listener. |
| [storage-layer.md](architecture/storage-layer.md) | Dual-tier storage: chrome.storage.local + IndexedDB, read/write paths, graceful degradation. |

---

## Guides

Step-by-step instructions for common development tasks.

| Document | Description |
|----------|-------------|
| [how-to-search-bookmarks.md](guides/how-to-search-bookmarks.md) | User flow: open overlay, search, navigate results, open bookmark, keyboard shortcuts. |
| [how-to-sync-bookmarks.md](guides/how-to-sync-bookmarks.md) | Sync triggers (auto/manual), incremental vs full refresh logic, adding message handlers. |
| [how-to-manage-settings.md](guides/how-to-manage-settings.md) | Configure sync interval, view/export history, add new settings to the extension. |

---

## Reference

Factual lookup information and coding standards.

| Document | Description |
|----------|-------------|
| [coding-conventions.md](reference/coding-conventions.md) | ES Modules, naming conventions, comment style, logging format, error handling patterns. |
| [storage-keys.md](reference/storage-keys.md) | chrome.storage.local keys, IndexedDB keys, data schemas (Bookmark, HistoryEntry, FaviconEntry). |

---

## Document Structure

```
llmdoc/
├── index.md                          # This file
├── overview/
│   └── project-overview.md           # Project identity and tech stack
├── architecture/
│   ├── background-service.md         # Service Worker architecture
│   ├── content-script.md             # Search UI architecture
│   ├── settings-module.md            # Settings page architecture
│   └── storage-layer.md              # Dual-tier storage architecture
├── guides/
│   ├── how-to-search-bookmarks.md    # Search overlay usage
│   ├── how-to-sync-bookmarks.md      # Sync mechanism guide
│   └── how-to-manage-settings.md     # Settings configuration guide
└── reference/
    ├── coding-conventions.md         # Code style and patterns
    └── storage-keys.md               # Storage key reference
```

---

## Entry Points (Source Code)

| Component | File | Key Symbols |
|-----------|------|-------------|
| Service Worker | `background.js` | `init`, `ensureInit`, `enqueueBookmarkEvent` |
| Data Layer | `background-data.js` | `refreshBookmarks`, `searchBookmarks`, `loadInitialData` |
| Message Router | `background-messages.js` | `handleMessage` |
| Search UI | `content.js` | `createSearchUI`, `showSearch`, `hideSearch`, `displayResults` |
| Storage | `storage-service.js` | `STORAGE_KEYS`, `DEFAULTS`, `getStorage`, `setStorage` |
| IndexedDB | `idb-service.js` | `idbGet`, `idbSet`, `idbGetMany`, `idbSetMany` |
| Constants | `constants.js` | `MESSAGE_ACTIONS`, `HISTORY_ACTIONS`, `ALARM_NAMES` |

---

*Last updated: 2026-03-06*
