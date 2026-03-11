# Architecture of Content Script (Search UI)

## 1. Identity

- **What it is:** Page-injected content script providing the bookmark search overlay UI.
- **Purpose:** Renders a floating search modal on any webpage, handles user input, displays results, and manages favicon loading.

## 2. Core Components

- `content.js:1-1376` (IIFE wrapper): Self-contained module with duplicate injection prevention via `__BOOKMARK_SEARCH_LOADED__` flag.
- `content.js:107-183` (`createSearchUI`): Builds DOM structure (overlay, container, input, results, shortcuts hint).
- `content.js:186-245` (`showSearch`): Displays overlay, enables focus management, cancels favicon warmup.
- `content.js:248-291` (`hideSearch`): Hides overlay, clears state, flushes favicon persistence queue, schedules warmup.
- `content.js:293-399` (Focus Management): Three-layer system (`focusTrap`, `globalKeydownTrap`, `focusEnforcer`).
- `content.js:430-470` (`handleKeydown`): Keyboard navigation with IME composition + post-composition Enter suppression.
- `content.js:1392-1451` (`openBookmark`): Opens selected bookmark and sends best-effort `TRACK_BOOKMARK_OPEN` to background for favicon warmup prioritization.
- `content.js:1038-1091` (`searchBookmarksInBackground`): Delegates search to background via message passing.
- `content.js:1098-1208` (`displayResults`): Renders bookmark items with async favicon hydration.
- `content.js:587` (`updateSelection`): Updates listbox selection state; scrolls for keyboard navigation, but hover updates use `scroll: false` to avoid jarring list jumps.
- `content.js:20`, `content.js:231`, `content.js:1294`: Pointer-move gating for hover selection to avoid keyboard navigation being overridden when the list scrolls under a stationary cursor.
- `content.js:760-902` (`hydrateFaviconsForDomains`): 4-worker concurrent favicon loading with fallback chain.
- `content.js:984-1040` (`startFaviconWarmup`): Background prefetch of up to 600 bookmark favicons.
- `content.css`: Overlay styles with responsive design and reduced-motion accessibility. It keeps a single-file strategy and now defines theme variants through `.bookmark-search-overlay[data-bs-theme="original|minimal|glass|dark"]`, covering container, input, result items, empty state, shortcut bar, kbd, and scrollbar without introducing a second theme transport layer.

## 3. Execution Flow (LLM Retrieval Map)

### Overlay Toggle Flow

- **1. Trigger:** Background sends `TOGGLE_SEARCH` message via `chrome.runtime.onMessage` listener at `content.js:1302-1325`.
- **2. Toggle:** `toggleSearch()` at `content.js:407-427` checks display state.
- **3. Show:** `showSearch()` at `content.js:186-245` enables focus traps, calls `focusSearchInput()`.
- **4. Hide:** `hideSearch()` at `content.js:248-291` disables traps, flushes favicon queue, schedules warmup.

### Search Flow

- **1. Input:** User types, `handleSearchDebounced()` at `content.js:487-493` debounces 200ms.
- **2. Delegate:** `handleSearch()` at `content.js:1082-1091` calls `searchBookmarksInBackground()`.
- **3. Message:** `sendMessagePromise()` at `content.js:494-519` sends `SEARCH_BOOKMARKS` to background.
- **4. Render:** `displayResults()` at `content.js:1098-1208` creates DOM, triggers favicon hydration.

### Focus Management (3-Layer Enforcement)

- **Layer 1 - Focus Trap:** `handleFocusTrap()` at `content.js:296-304` captures `focusin` events.
- **Layer 2 - Keydown Trap:** `handleGlobalKeydown()` at `content.js:317-372` intercepts all keystrokes.
- **Layer 3 - Enforcer:** `startFocusEnforcer()` at `content.js:387-399` runs 120ms interval check.

### Favicon Caching (State-Aware Fallback Strategy)

- **Tier 1 - In-Memory:** `faviconCache` at `content.js:37` for instant lookup.
- **Tier 2 - Persisted (IDB):** `fetchPersistedFavicons()` at `content.js:662-701` via background message. Returned records can now be either long-lived success entries (`{ src, updatedAt }` / `{ state: 'success', src, updatedAt }`) or active failure cooldown entries (`{ state: 'failure', retryAt, updatedAt }`). Hydration only applies success records to the UI; failure records suppress repeated retries until cooldown expires.
- **Tier 3 - Browser Cache:** Batch via `GET_BROWSER_FAVICONS_BATCH` (plus `GET_BROWSER_FAVICON` fallback) through background (uses short timeout and SW in-memory LRU). Responses now carry `{ src, isPlaceholder }`, allowing the content script to reject browser-provided placeholder/globe icons instead of treating every loadable data URL as a real success. For private hosts, requests carry an optional debug flag and background applies a longer fetch timeout with shorter negative caching. Browser-returned SVG monogram placeholders are treated as placeholder failures for private hosts, so hydration continues into local/external fallback instead of persisting fake success.
- **Fallback - External / Local:** `loadFavicon()` at `content.js:1197-1283` keeps the existing source order (browser → local/origin → DuckDuckGo → Google S2 → Faviconkit), but now returns structured success/failure results. Only trusted `http/https` favicon URLs are persisted as long-lived success; failures and fake-success outcomes are queued as retryable failure entries.

### Favicon Warmup Flow

- **1. Schedule:** `scheduleFaviconWarmup()` at `content.js:888-898` delays 1.5s after overlay close.
- **2. Fetch Domains:** `fetchWarmupDomainMapFromBackground()` at `content.js:933-943` gets up to 600 domains.
- **3. Prefetch:** `warmupDomains()` at `content.js:945-995` runs 4 concurrent workers.
- **4. Persist:** `queuePersistFavicon()` at `content.js:634-660` batches writes (50 entries or 800ms).

## 4. Design Rationale

- **IIFE Wrapper:** Prevents duplicate injection when script is re-injected on SPA navigation.
- **3-Layer Focus:** Handles aggressive focus-stealing by host pages (e.g., Google Docs, Notion).
- **Token-Based Cancellation:** `backgroundSearchToken` and `faviconRenderToken` prevent stale async updates.
- **Cache Clear Broadcast:** `CLEAR_FAVICON_CACHE` lets the background worker invalidate content-script memory state immediately by resetting `faviconCache`, pending persistence queue state, warmup timers, and render/search tokens.
- **Batched Persistence:** Reduces background script calls by batching favicon writes.
- **Warmup Prioritization:** Recently opened root domains are reported from `openBookmark()` and prioritized by background when building warmup domain lists.
- **Private Host Detection:** `isLikelyPrivateHost()` skips external favicon services for localhost/IPs/internal-style suffixes, and local-origin fallback can be enabled for those hosts during result hydration.
- **Favicon Debug Switch:** Content script can enable favicon tracing via `window.__BOOKMARK_SEARCH_DEBUG_FAVICON__` or `chrome.storage.local.debugFavicon`; logs are budget-limited to avoid console spam.
- **IME Handling:** Avoids accidental navigation on IME commit by respecting composition state and briefly suppressing stray Enter right after `compositionend`.
- **Hover vs Keyboard:** Hover only changes highlight (no scroll), and requires recent pointer movement so keyboard navigation doesn’t get “stolen” by hover when the list scrolls.
- **Obfuscator Compatibility:** Keep helper declarations before first usage in `content.js` (e.g., `getRootDomain` / `normalizeFaviconDomain` before `setFaviconCache`) to avoid runtime `ReferenceError` in obfuscated builds.
