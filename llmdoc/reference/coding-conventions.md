# Coding Conventions

## 1. Core Summary

This project uses ES Modules with a functional programming style. Code is written in vanilla JavaScript targeting Chrome Extension MV3 runtime. Comments are in Chinese for the target user base, while code identifiers use English.

## 2. Source of Truth

- **Module Config:** `package.json:6` - `"type": "module"` enables ESM
- **Build Config:** `vite.config.js` - Vite 5.x with Terser minification
- **Constants Pattern:** `constants.js`, `storage-service.js:7-14` (`STORAGE_KEYS`)

## 3. Module System

- ES Modules with named exports (no default exports)
- Import style: `import { fn1, fn2 } from './module.js'`
- File extension `.js` required in imports

## 4. Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files | `kebab-case.js` | `storage-service.js`, `background-data.js` |
| Constants | `SCREAMING_SNAKE_CASE` | `STORAGE_KEYS`, `ALARM_NAMES`, `DB_NAME` |
| Functions | `camelCase` | `getStorage`, `formatRelativeTime` |
| Variables | `camelCase` | `dbPromise`, `initPromise` |
| Exported Objects | `SCREAMING_SNAKE_CASE` | `MESSAGE_ACTIONS`, `HISTORY_ACTIONS` |

## 5. Comment Style

- File headers: JSDoc block describing module purpose (Chinese)
- Function docs: JSDoc with `@param`, `@returns` (Chinese descriptions)
- Inline comments: Chinese, placed above the relevant line
- Deprecation: `@deprecated` tag with migration hint

Reference: `utils.js:1-12`, `storage-service.js:1-4`, `storage-service.js:26-30`

## 6. Logging Convention

Format: `console.log("[ModuleName] 中文描述", ...args)`

| Module | Prefix |
|--------|--------|
| Background | `[Background]` |
| Storage | `[Storage]` |

Levels used:
- `console.log` - Info/debug
- `console.warn` - Non-critical failures
- `console.error` - Critical errors

Reference: `background.js:7`, `background.js:27`, `storage-service.js:45`

## 7. Error Handling Patterns

**Pattern A: Try-catch with fallback (async functions)**
```javascript
try {
  const result = await asyncOp();
  return result;
} catch (error) {
  console.error('[Module] 操作失败:', error);
  return fallbackValue;
}
```
Reference: `storage-service.js:34-53`

**Pattern B: Promise rejection with descriptive Error**
```javascript
reject(request.error || new Error('Descriptive message'));
```
Reference: `idb-service.js:31-37`

**Pattern C: Silent catch for non-critical operations**
```javascript
.catch(() => {}) // ignore
```
Reference: `background.js:53`

## 8. Async Patterns

- Prefer `async/await` over raw Promises
- Use Promise wrapper for callback-based APIs (IndexedDB, Chrome APIs)
- Singleton initialization pattern with cached promise

Reference: `background.js:24-31` (`ensureInit`), `idb-service.js:41-48` (`getDb`)

## 9. Constants Organization

- Group related constants in exported objects
- Define defaults alongside keys for storage values
- Use computed property names for key-value mapping

Reference: `storage-service.js:7-24`, `constants.js:1-24`
