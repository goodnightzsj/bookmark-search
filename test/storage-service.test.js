import test from 'node:test';
import assert from 'node:assert/strict';

import { getStorageOrThrow, getValueOrThrow, STORAGE_KEYS } from '../storage-service.js';

test('getStorageOrThrow: returns default values for missing keys', async () => {
  const originalChrome = globalThis.chrome;

  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          return {};
        }
      }
    }
  };

  try {
    const result = await getStorageOrThrow([STORAGE_KEYS.BOOKMARK_COUNT, STORAGE_KEYS.SYNC_INTERVAL]);
    assert.equal(result[STORAGE_KEYS.BOOKMARK_COUNT], 0);
    assert.equal(result[STORAGE_KEYS.SYNC_INTERVAL], 30);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('getStorageOrThrow: rejects when chrome.storage.local.get fails', async () => {
  const originalChrome = globalThis.chrome;

  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          throw new Error('storage read failed');
        }
      }
    }
  };

  try {
    await assert.rejects(
      getStorageOrThrow(STORAGE_KEYS.BOOKMARK_HISTORY),
      /storage read failed/
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('getValueOrThrow: rejects on storage read failure', async () => {
  const originalChrome = globalThis.chrome;

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
    await assert.rejects(
      getValueOrThrow(STORAGE_KEYS.THEME),
      /storage unavailable/
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});
