# Bookmark Search - Review Report

Date: 2026-01-15

## Summary

This review focused on correctness, MV3 reliability, security/privacy posture, maintainability, and release readiness.

Key outcomes:

- Fixed multiple correctness issues in settings/history/background flows.
- Improved MV3 robustness (alarm-based debounce, refresh queueing, init coordination).
- Reduced privacy surface by switching from `<all_urls>` `content_scripts` to on-demand injection via `chrome.scripting` + `activeTab`.
- Added small, dependency-free unit tests using Node’s built-in test runner.
- Refactored pure logic into reusable modules (`bookmark-logic.js`, `bookmark-export.js`) and centralized constants (`constants.js`).

## Current Architecture (high level)

- `background.js` (MV3 service worker): initialization, bookmark-change debounce, periodic sync, keyboard command handling, and on-demand content script/CSS injection.
- `background-data.js`: bookmark cache management, refresh pipeline, history persistence with queueing and storage-safe merging.
- `popup.js`: status display + manual refresh; listens to storage changes while popup is open.
- `settings.js` + `settings-*.js`: modular settings UI (theme/shortcuts/sync/history).
- `content.js`: injected only when needed; displays overlay UI and searches local cached bookmarks.

## Code Review Checklist

### 1) Correctness

- Settings sync interval changes now persist correctly; refresh/sync buttons validate background response before showing “success”.
- History selection/export no longer depends on list indices; selection is tracked by stable item keys and is pruned on list refresh.
- Bookmark history persistence avoids reintroducing cleared history while the service worker stays alive.
- Export generation now supports nested folders based on ` > ` path segments.

Remaining notes:

- Consider whether deleted-history items should be exportable (currently allowed if they have a URL).

### 2) Readability & Cognitive Complexity

- Settings code is already modular and readable.
- Core bookmark logic and export logic were extracted into dedicated modules to reduce cognitive load in UI/background files.

### 3) Responsibility & Abstraction

- `storage-service.js` provides a good abstraction for storage defaults and error handling.
- Pure functions were extracted to improve separation of concerns and enable testing.

### 4) Coupling & Dependencies

- Alarm names and history action enums are centralized in `constants.js` to avoid string coupling across modules.
- Removed unused `rollup-plugin-obfuscator` dependency and dead code paths.

Notable constraint:

- `javascript-obfuscator@0.25.x` does not parse optional chaining; avoid `?.` (or upgrade obfuscator and verify compatibility).

### 5) Extensibility & Change Impact

- Adding new alarm-based behaviors or history actions should now be lower-impact due to centralized constants.
- Export logic can be extended (e.g., add “export only add/edit/move”) without touching DOM code.

### 6) Testability

- Added `node:test` unit tests (no extra dependencies):
  - `test/utils.test.js`
  - `test/bookmark-logic.test.js`
  - `test/bookmark-export.test.js`

### 7) Robustness & Error Handling

- Background refresh supports queueing: repeated refresh triggers during an in-flight refresh schedule another pass.
- Bookmark-change debounce uses `chrome.alarms` instead of `setTimeout` to avoid MV3 service worker suspension issues.
- Storage write failures are logged with warnings in critical background paths.
- On-demand injection skips special protocols and tolerates CSS injection failures.

### 8) Simplicity & Overengineering

- Obfuscation remains an intentional tradeoff; applied only on build to keep dev experience usable.
- Unused logger module removed to reduce dead code.

## Security / Privacy Notes

- The extension no longer injects scripts on all pages by default. Injection happens only after a user gesture (keyboard command), via `activeTab` and `chrome.scripting`.
- External favicon fetching was removed; favicon retrieval uses the extension `_favicon` endpoint.

## Commands

- Build: `pnpm build` (or `npm run build`)
- Test: `pnpm test` (or `npm test`)

## Release Packaging

- `vite build` outputs the unpacked extension to `dist/` (ignored by git).
- Package by zipping `dist/` for store upload (or “Load unpacked” for local testing).

