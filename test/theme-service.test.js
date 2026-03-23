import test from 'node:test';
import assert from 'node:assert/strict';

import { getCurrentTheme, saveTheme, THEME_CACHE_KEY } from '../theme-service.js';
import { STORAGE_KEYS } from '../storage-service.js';

function createLocalStorageMock(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

test('saveTheme: persists to chrome.storage before updating local cache', async () => {
  const originalChrome = globalThis.chrome;
  const originalLocalStorage = globalThis.localStorage;
  const writes = [];

  globalThis.localStorage = createLocalStorageMock();
  globalThis.chrome = {
    storage: {
      local: {
        async set(data) {
          writes.push(data);
        }
      }
    }
  };

  try {
    await saveTheme('minimal');

    assert.deepEqual(writes, [{ [STORAGE_KEYS.THEME]: 'minimal' }]);
    assert.equal(globalThis.localStorage.getItem(THEME_CACHE_KEY), 'minimal');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.localStorage = originalLocalStorage;
  }
});

test('saveTheme: throws and keeps local cache unchanged when storage write fails', async () => {
  const originalChrome = globalThis.chrome;
  const originalLocalStorage = globalThis.localStorage;

  globalThis.localStorage = createLocalStorageMock({ [THEME_CACHE_KEY]: 'original' });
  globalThis.chrome = {
    storage: {
      local: {
        async set() {
          throw new Error('storage unavailable');
        }
      }
    }
  };

  try {
    await assert.rejects(saveTheme('dark'), /chrome\.storage\.local\.set failed/);
    assert.equal(globalThis.localStorage.getItem(THEME_CACHE_KEY), 'original');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.localStorage = originalLocalStorage;
  }
});

test('getCurrentTheme: falls back to cached local theme when storage read fails', async () => {
  const originalChrome = globalThis.chrome;
  const originalLocalStorage = globalThis.localStorage;

  globalThis.localStorage = createLocalStorageMock({ [THEME_CACHE_KEY]: 'dark' });
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          throw new Error('storage unavailable');
        }
      }
    }
  };

  try {
    const theme = await getCurrentTheme();
    assert.equal(theme, 'dark');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.localStorage = originalLocalStorage;
  }
});
