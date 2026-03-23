import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __getBackgroundDataInternalsForTests,
  __resetBackgroundDataForTests,
  clearHistory,
  loadInitialData,
  mergeBookmarkHistory,
  needsStorageMetadataRepair,
  shouldFallbackRemovedEvent,
  writeStorageMetadataWithRetry
} from '../background-data.js';
import { STORAGE_KEYS } from '../storage-service.js';

test('loadInitialData: skipInitialRefresh avoids triggering bookmark refresh when cache is empty', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;

  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          return {};
        }
      }
    },
    bookmarks: new Proxy({}, {
      get() {
        throw new Error('bookmark API should not be used when skipInitialRefresh is true');
      }
    })
  };
  globalThis.indexedDB = undefined;

  try {
    await assert.doesNotReject(loadInitialData({ skipInitialRefresh: true }));
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('mergeBookmarkHistory: keeps current changes when storage read fallback is needed', () => {
  const existing = [
    { action: 'add', title: 'Older', timestamp: 1 }
  ];
  const changes = [
    { action: 'delete', title: 'Newer', timestamp: 2 }
  ];

  const merged = mergeBookmarkHistory(existing, changes, 10);

  assert.deepEqual(merged, [
    { action: 'delete', title: 'Newer', timestamp: 2 },
    { action: 'add', title: 'Older', timestamp: 1 }
  ]);
});

test('shouldFallbackRemovedEvent: falls back to full refresh for folder removal without subtree details', () => {
  const indexById = new Map([
    ['bookmark-1', 0]
  ]);

  assert.equal(
    shouldFallbackRemovedEvent(['folder-1'], 'folder-1', indexById),
    true
  );

  assert.equal(
    shouldFallbackRemovedEvent(['bookmark-1'], 'bookmark-1', indexById),
    false
  );
});

test('needsStorageMetadataRepair: repairs when bookmarkCount mirror is missing but meta is current', () => {
  const meta = { updatedAt: 123, count: 7 };
  const storageRead = {
    success: true,
    data: {
      [STORAGE_KEYS.BOOKMARKS_META]: { updatedAt: 123, count: 7 },
      [STORAGE_KEYS.BOOKMARK_COUNT]: 0,
      [STORAGE_KEYS.LAST_SYNC_TIME]: 123,
      [STORAGE_KEYS.BOOKMARK_HISTORY]: []
    },
    state: {
      [STORAGE_KEYS.BOOKMARKS_META]: 'ok',
      [STORAGE_KEYS.BOOKMARK_COUNT]: 'missing',
      [STORAGE_KEYS.LAST_SYNC_TIME]: 'ok',
      [STORAGE_KEYS.BOOKMARK_HISTORY]: 'ok'
    }
  };

  assert.equal(needsStorageMetadataRepair(storageRead, meta, []), true);
});

test('needsStorageMetadataRepair: repairs when stored history drifts from runtime history', () => {
  const meta = { updatedAt: 123, count: 1 };
  const runtimeHistory = [
    { action: 'add', title: 'A', url: 'https://a.com', timestamp: 123 }
  ];
  const storageRead = {
    success: true,
    data: {
      [STORAGE_KEYS.BOOKMARKS_META]: { updatedAt: 123, count: 1 },
      [STORAGE_KEYS.BOOKMARK_COUNT]: 1,
      [STORAGE_KEYS.LAST_SYNC_TIME]: 123,
      [STORAGE_KEYS.BOOKMARK_HISTORY]: []
    },
    state: {
      [STORAGE_KEYS.BOOKMARKS_META]: 'ok',
      [STORAGE_KEYS.BOOKMARK_COUNT]: 'ok',
      [STORAGE_KEYS.LAST_SYNC_TIME]: 'ok',
      [STORAGE_KEYS.BOOKMARK_HISTORY]: 'ok'
    }
  };

  assert.equal(needsStorageMetadataRepair(storageRead, meta, runtimeHistory), true);
});

test('writeStorageMetadataWithRetry: updates runtimeLastSyncTime only after a successful retry', async () => {
  const originalChrome = globalThis.chrome;
  let attempts = 0;

  __resetBackgroundDataForTests();
  globalThis.chrome = {
    storage: {
      local: {
        async set() {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('transient storage failure');
          }
        },
        async get() {
          return {};
        }
      }
    }
  };

  try {
    const ok = await writeStorageMetadataWithRetry(
      { updatedAt: 456, count: 3 },
      {
        history: [{ action: 'add', title: 'A', url: 'https://a.com', timestamp: 456 }],
        retryDelayMs: 0
      }
    );

    assert.equal(ok, true);
    assert.equal(attempts, 2);
    assert.equal(__getBackgroundDataInternalsForTests().runtimeLastSyncTime, 456);
  } finally {
    __resetBackgroundDataForTests();
    globalThis.chrome = originalChrome;
  }
});

test('clearHistory: restores in-memory history when storage clear fails', async () => {
  const originalChrome = globalThis.chrome;

  __resetBackgroundDataForTests();
  globalThis.chrome = {
    storage: {
      local: {
        async set() {
          throw new Error('clear failed');
        },
        async get(keys) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result = {};
          if (keyList.includes(STORAGE_KEYS.BOOKMARK_HISTORY)) {
            result[STORAGE_KEYS.BOOKMARK_HISTORY] = [
              { action: 'add', title: 'A', url: 'https://a.com', timestamp: 1 }
            ];
          }
          return result;
        }
      }
    }
  };

  try {
    await loadInitialData({ skipInitialRefresh: true });
    await assert.rejects(clearHistory(), /chrome\.storage\.local\.set failed/);
    assert.deepEqual(__getBackgroundDataInternalsForTests().bookmarkHistory, [
      { action: 'add', title: 'A', url: 'https://a.com', timestamp: 1 }
    ]);
  } finally {
    __resetBackgroundDataForTests();
    globalThis.chrome = originalChrome;
  }
});
