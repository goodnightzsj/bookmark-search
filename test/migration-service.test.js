import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchemaReady } from '../migration-service.js';
import { STORAGE_KEYS } from '../storage-service.js';

test('ensureSchemaReady: rejects before migration when schema state read fails', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const writes = [];

  globalThis.indexedDB = undefined;
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          throw new Error('schema storage unavailable');
        },
        async set(data) {
          writes.push(data);
        }
      }
    }
  };

  try {
    await assert.rejects(ensureSchemaReady(), /schema state read failed: schema storage unavailable/);
    assert.deepEqual(writes, []);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('ensureSchemaReady: does not overwrite normalized payload when migration read fails mid-run', async () => {
  const originalChrome = globalThis.chrome;
  const originalIndexedDb = globalThis.indexedDB;
  const writes = [];
  let getCall = 0;

  globalThis.indexedDB = undefined;
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          getCall++;
          if (getCall === 1) {
            return {
              [STORAGE_KEYS.SCHEMA_VERSION]: 1,
              [STORAGE_KEYS.MIGRATION_STATE]: 'idle',
              [STORAGE_KEYS.NEEDS_REBUILD]: false
            };
          }
          throw new Error('migration payload unavailable');
        },
        async set(data) {
          writes.push(data);
        }
      }
    }
  };

  try {
    await assert.rejects(ensureSchemaReady(), /v1 payload read failed: migration payload unavailable/);
    assert.deepEqual(writes, [
      {
        [STORAGE_KEYS.MIGRATION_STATE]: 'running',
        [STORAGE_KEYS.LAST_MIGRATION_ERROR]: null
      },
      {
        [STORAGE_KEYS.MIGRATION_STATE]: 'failed',
        [STORAGE_KEYS.LAST_MIGRATION_ERROR]: '[Migration] v1 payload read failed: migration payload unavailable'
      }
    ]);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.indexedDB = originalIndexedDb;
  }
});
