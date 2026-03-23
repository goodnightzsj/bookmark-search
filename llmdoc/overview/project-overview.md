# Bookmark Search - Project Overview

## 1. Identity

- **What it is:** A Chrome Extension (Manifest V3) for rapid bookmark search and management via global keyboard shortcut.
- **Purpose:** Enables users to instantly search and open bookmarks from any webpage without leaving the current context.

## 2. High-Level Description

Bookmark Search provides a spotlight-style search overlay that can be invoked on any webpage via a configurable keyboard shortcut. The extension maintains a synchronized cache of the user's bookmarks, supports real-time search with multi-token matching, and tracks bookmark change history. It targets power users who manage large bookmark collections and need fast, keyboard-driven access.

## 3. Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Chrome Extension Manifest V3 |
| Build | Vite 5.x + Terser |
| Storage | chrome.storage.local (metadata) + IndexedDB (large data) |
| Testing | Node.js built-in test runner |
| i18n | Chrome i18n API (`_locales/`) |

## 4. Architecture Components

| Component | Entry Point | Responsibility |
|-----------|-------------|----------------|
| Service Worker | `background.js` | Bookmark sync, message routing, shortcut handling, alarm scheduling |
| Content Script | `content.js` | Search overlay UI, keyboard navigation, favicon caching |
| Popup | `popup.html/js` | Extension status display, quick actions |
| Settings | `settings.html/js` | Theme selection, sync config, history viewer, shortcut management |
| Shared Modules | `storage-service.js`, `idb-service.js`, `theme-*.js`, `message-response.js` | Storage abstraction, theme system, runtime message contract validation |

## 5. Key Features

- **Global Shortcut Search:** Invoke search overlay on any page via keyboard shortcut (default: Ctrl+Space; mac: Command+Space)
- **Real-time Bookmark Sync:** Hybrid sync with event-driven incremental updates + periodic full refresh
- **Change History Tracking:** Records add/delete/edit/move operations (100-item cap)
- **Hardened Persistence Paths:** Strict storage read/write semantics, metadata mirror repair, and rollback on failed history clear
- **Theme System:** 4 themes (original, minimal, glass, dark) with instant switching
- **Favicon Caching:** Multi-tier cache (content memory, Service Worker LRU memory, persisted IndexedDB) with background warmup
- **IME Support:** Proper handling for Chinese/Japanese input composition

## 6. Target Users

- Power users with large bookmark collections (1000+)
- Keyboard-centric workflow users who prefer shortcuts over mouse navigation
- Users who frequently add/organize bookmarks and want change tracking

## 7. Source of Truth

- **Extension Manifest:** `manifest.json`
- **Build Config:** `vite.config.js`
- **Storage Keys:** `storage-service.js` (STORAGE_KEYS, DEFAULTS)
- **Message Protocol:** `constants.js` (MESSAGE_ACTIONS)
