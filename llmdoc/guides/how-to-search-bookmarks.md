# How to Search Bookmarks

A step-by-step guide for using the bookmark search overlay.

1. **Open the Search Overlay:** Press the global shortcut (default: `Ctrl+Space` or `Cmd+Space` on Mac). The overlay appears with a blurred backdrop and centered modal.

2. **Type Your Query:** Start typing in the search input. Search is debounced (200ms) and delegated to the background script. Results appear as you type (max 10 items).

3. **Navigate Results:**
   - `ArrowDown` / `ArrowUp`: Move selection with wrap-around.
   - `Mouse hover`: Updates selection to hovered item (does not auto-scroll the list; keyboard selection is not overridden unless you move the mouse).
   - Selected item shows blue left border and slight translateX animation.

4. **Open a Bookmark:**
   - `Enter`: Opens selected bookmark in a new tab.
   - `Ctrl+Enter` / `Cmd+Enter`: Opens in the current tab.
   - `Click`: Opens in new tab (or current tab with Ctrl/Cmd held).

5. **Close the Overlay:**
   - `Escape`: Closes and clears the search.
   - Click on the backdrop (outside the modal).
   - Opening a bookmark automatically closes the overlay.

6. **Verify Success:** The overlay disappears, and the bookmark opens in the target tab. Favicon cache is flushed before navigation to persist newly discovered icons.

**Notes:**
- IME users (Chinese/Japanese input): Enter key is ignored during composition to prevent accidental navigation.
- Favicons load asynchronously with state-aware fallback: in-memory → persisted success/failure records (IndexedDB) → browser cache (`chrome.favicon`) → external/local sources.
- Real favicon successes are kept for reuse. Persisted retry cooldown is now narrow: only explicit fast-fail site states (`5xx`, `429`, `421`) enter the short failure cooldown, while ordinary misses or placeholder results are treated as per-search failures instead of long-lived persisted state.
- Background warmup prefetches favicons after overlay closes for faster subsequent searches, but only trusted real successes are promoted into the persistent success cache.
- If you clear favicon cache from `settings.html`, both persisted favicon records and content-script in-memory state are invalidated, so the next search re-enters the favicon fetch chain.
- The overlay now follows all 4 themes (`original`, `minimal`, `glass`, `dark`) through the shared theme setting, including container, input, hover/selected states, empty state, shortcut bar, and scrollbar styling.
