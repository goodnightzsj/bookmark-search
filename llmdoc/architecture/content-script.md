# Architecture of Content Script (Search UI)

## 1. Identity

- **What it is:** Page-injected content script providing the bookmark search overlay UI.
- **Purpose:** Renders a floating search modal on any webpage, handles user input, displays results, and manages favicon loading.

## 2. Core Components

- `content.js:1-1376` (IIFE wrapper): Self-contained module with duplicate injection prevention via `__BOOKMARK_SEARCH_LOADED__` flag.
- `content.js:107-183` (`createSearchUI`): Builds DOM structure (overlay, container, input, results, shortcuts hint).
- `content.js:186-245` (`showSearch`): Displays overlay, enables focus management, cancels favicon warmup, and focuses the search input directly (with rAF/setTimeout retries) instead of briefly parking focus on the overlay.
- `content.js:248-291` (`hideSearch`): Hides overlay, clears state, flushes favicon persistence queue, schedules warmup.
- `content.js:293-399` (Focus Management): Three-layer system (`focusTrap`, `globalKeydownTrap`, `focusEnforcer`).
- `content.js:430-470` (`handleKeydown`): Keyboard navigation with IME composition + post-composition Enter suppression.
- `content.js:1392-1451` (`openBookmark`): Opens selected bookmark and sends best-effort `TRACK_BOOKMARK_OPEN` to background for favicon warmup prioritization.
- `content.js:1038-1091` (`searchBookmarksInBackground`): Delegates search to background via message passing.
- `content.js:1098-1208` (`displayResults`): Renders bookmark items (title, folder path, URL) with async favicon hydration. Uses event delegation on `resultsContainer` for hover (`mouseover`) and click instead of per-item listeners.
- `content.js:587` (`updateSelection`): Incremental DOM update — only modifies the previous and current selected items instead of iterating all items. Scrolls for keyboard navigation, but hover updates use `scroll: false` to avoid jarring list jumps.
- `content.js:20`, `content.js:231`, `content.js:1294`: Pointer-move gating for hover selection to avoid keyboard navigation being overridden when the list scrolls under a stationary cursor.
- `content.js:760-902` (`hydrateFaviconsForDomains`): 4-worker concurrent favicon loading with fallback chain.
- `content.js:984-1040` (`startFaviconWarmup`): Background prefetch of up to 600 bookmark favicons.
- `content.css`: Overlay styles with responsive design and reduced-motion accessibility. It keeps a single-file strategy and defines theme variants through `.bookmark-search-overlay[data-bs-theme="original|minimal|glass|dark"]`, covering container, input, result items (title, path, URL), empty state, shortcut bar, kbd, and scrollbar. `.bookmark-path` displays the bookmark's folder hierarchy between title and URL.

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
- **Layer 3 - Enforcer:** `startFocusEnforcer()` at `content.js:387-399` runs a periodic input-refocus check.
- **Open Timing Guard:** `showSearch()` now focuses the input immediately after showing the overlay, then retries on nested `requestAnimationFrame` plus a short timeout so host pages that steal focus during paint still land on the search box.

### Favicon Caching (State-Aware Fallback Strategy)

- **Tier 1 - In-Memory:** `faviconCache` at `content.js:37` for instant lookup. At content-script startup, `scheduleFaviconMemoryPrefetch()` triggers a lightweight IDB-only prefetch (no network) that populates this cache in small batches (80 domains per batch, `requestIdleCallback` between batches) so the first overlay open can skip the IDB round-trip. Cache keys now follow exact favicon service keys (`host` / `host:port`), while lookup keeps a small compatibility set for legacy persisted keys.
- **Tier 2 - Persisted (IDB):** `fetchPersistedFavicons()` via background message loads persisted success entries (`{ src, updatedAt }` / `{ state: 'success', src, updatedAt }`). Hydration only applies trusted `http/https` favicon URLs to the UI. Public-domain lookups no longer collapse by default to root-domain aliases, avoiding multi-tenant host collisions; legacy root-based entries are still read as compatibility fallbacks.
- **Tier 3 - Browser Cache:** Batch via `GET_BROWSER_FAVICONS_BATCH` (plus `GET_BROWSER_FAVICON` fallback) through background (uses short timeout and SW in-memory LRU). Responses now carry `{ src, isPlaceholder }`, allowing the content script to reject browser-provided placeholder/globe icons instead of treating every loadable data URL as a real success. The SW in-memory favicon cache is now pure LRU without positive TTL; entries survive across pages only while the current Service Worker stays alive. For private hosts, requests carry an optional debug flag and background applies a longer fetch timeout. Browser-returned SVG monogram placeholders are treated as placeholder failures for private hosts, so hydration continues into local fallback instead of persisting fake success.
- **Fallback - External / Local:** `loadFavicon()` keeps the existing source order (browser → local/origin → DuckDuckGo → Google S2 → Faviconkit), but local/origin fallback now relies only on direct image load success/timeout/error rather than a separate status-probe message. Public domains only try a minimal same-origin candidate set before external services; private/local hosts keep a broader origin-path list and exact `host:port` service keys. Only trusted `http/https` favicon URLs are persisted as long-lived success entries. Image probes that timeout or error now set `img.src = ''` to abort in-flight network requests.

### Favicon Warmup Flow

- **0. Startup Prefetch:** `scheduleFaviconMemoryPrefetch()` fires 2s after `init()`, calling `prefetchFaviconCacheFromIdb()` which fetches up to 400 domain keys from background, then batch-reads IDB in chunks of 80 with `requestIdleCallback` between batches. Pure IDB→memory, zero network requests.
- **1. Schedule:** `scheduleFaviconWarmup()` at `content.js:888-898` delays 5s after overlay close.
- **2. Fetch Domains:** `fetchWarmupDomainMapFromBackground()` at `content.js:933-943` now requests a reduced warmup window (120 domains instead of the older 600-style broad sweep).
- **3. Prefetch:** `warmupDomains()` at `content.js:945-995` now runs serial (concurrency=1) with 800ms inter-domain delay, caps each round to 12 actual network attempts, and skips domains already attempted in the last 10 minutes.
- **4. Persist:** `queuePersistFavicon()` batches writes (50 entries or 800ms). Warmup itself is throttled by recent-attempt timestamps rather than a separate persisted failure-cooldown path.

## 4. Design Rationale

- **IIFE Wrapper:** Prevents duplicate injection when script is re-injected on SPA navigation.
- **3-Layer Focus:** Handles aggressive focus-stealing by host pages (e.g., Google Docs, Notion). The overlay no longer steals focus first; `showSearch()` now targets the input directly to avoid opening with focus stuck outside the search box.
- **Token-Based Cancellation:** `backgroundSearchToken` and `faviconRenderToken` prevent stale async updates.
- **Cache Clear Broadcast:** `CLEAR_FAVICON_CACHE` lets the background worker invalidate content-script memory state by resetting `faviconCache`, pending persistence queue state, warmup timers, and render/search tokens. The settings page no longer waits for every tab broadcast to finish before reporting success; content invalidation is best-effort after the core clear completes.
- **Batched Persistence:** Reduces background script calls by batching favicon writes.
- **Warmup Throttling:** Background-assisted warmup is now deliberately low-priority: reduced domain window, serial execution (concurrency=1), 800ms inter-domain delay, 12-attempt budget, and 10-minute per-domain warmup backoff keep prefetch from over-consuming resources after the overlay closes.
- **Warmup Prioritization:** Recently opened root domains are reported from `openBookmark()` and prioritized by background when building warmup domain lists.
- **Private Host Detection:** `isLikelyPrivateHost()` skips external favicon services for localhost/IPs/internal-style suffixes, and local-origin fallback can be enabled for those hosts during result hydration.
- **Favicon Debug Switch:** Content script can enable favicon tracing via `window.__BOOKMARK_SEARCH_DEBUG_FAVICON__` or `chrome.storage.local.debugFavicon`; logs are budget-limited to avoid console spam.
- **IME Handling:** Avoids accidental navigation on IME commit by respecting composition state and briefly suppressing stray Enter right after `compositionend`.
- **Event Delegation:** `resultsContainer` handles `mouseover` and `click` via delegation instead of per-item listeners, reducing listener count from 2×N to 2. Uses `mouseover` (bubbles) instead of `mouseenter` (doesn’t bubble) with same-item dedup.
- **Hover vs Keyboard:** Hover only changes highlight (no scroll), and requires recent pointer movement so keyboard navigation doesn’t get “stolen” by hover when the list scrolls.
- **Incremental Selection:** `updateSelection` tracks `prevSelectedIndex` and only toggles classes on two DOM nodes per navigation step instead of iterating all items.
- **Favicon Service Key Consistency:** Content-side `buildFaviconServiceKey` matches the single-parameter `utils.js` version exactly (`pageUrl → host`), eliminating key drift between search-response favicon prefill and hydration lookup.
- **External Favicon Circuit Breaker:** 20 failures in 10 seconds triggers a 30-second cooldown; failure timestamps are cleared on circuit open to prevent stale counts from affecting the next recovery window.
