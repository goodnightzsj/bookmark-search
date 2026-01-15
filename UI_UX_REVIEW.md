# UI/UX Review (Bookmark Search)

Date: 2026-01-15

## What Was Improved

- Replaced emoji-based UI icons in `popup.html` and `settings.html` with inline SVG (theme-friendly, consistent rendering).
- Removed remaining emoji “search” icons from CSS (`content.css`, `themes/popup-glass.css`).
- Improved accessibility basics:
  - Added a global `:focus-visible` ring in both popup and settings pages.
  - Added `prefers-reduced-motion` handling for overlay animations in `content.css`.
- Made loading/success/failure button states icon-free (keeps SVG icon stable; only updates `.btn-text`).

## Current Design System Notes

- The project uses 4 themes (original/minimal/glass/dark) via `theme-loader.js` and `themes/{page}-{theme}.css`.
- Popup and settings pages share component concepts (cards, rows, buttons), but theme CSS is duplicated across theme files.

## Opportunities (Next Level)

### Color & Tokens

- Introduce a shared token layer (e.g., `--bg`, `--surface`, `--border`, `--text-1`, `--accent`) across all themes to reduce drift and make future themes cheaper.
- Add per-theme `--focus-ring` so the focus outline matches theme accents.

### Layout & Typography

- Popup: consider shortening dense rows (combine “last/next sync” in one row on narrow widths) to reduce vertical scroll.
- Settings: convert the “About” section to a structured list (already started) and consider consistent spacing utilities instead of inline styles.

### Motion

- Prefer opacity + shadow transitions over “translateX” for list hover if you want a calmer feel; keep motion subtle and consistent.
- Ensure all key animations have `prefers-reduced-motion` fallbacks (popup/settings currently rely on theme CSS transitions).

### Icons

- Consider a shared SVG symbol sprite to avoid duplicating inline SVG markup across pages (optional; current approach is fine).

