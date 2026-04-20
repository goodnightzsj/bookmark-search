import { loadInitialData, refreshBookmarks } from './background-data.js';
import { initSyncSettings } from './background-sync.js';
import { ensureSchemaReady } from './migration-service.js';
import { setStorageOrThrow, STORAGE_KEYS } from './storage-service.js';

// MV3 lifecycle wiring. Lives in its own module so background-messages.js can
// share the same ensureInit() without the circular setEnsureInit() indirection.

let initPromise = null;

async function init() {
  console.log('[Background] 初始化开始');

  const schemaResult = await ensureSchemaReady();
  const rebuildPending = !!(schemaResult && schemaResult.needsRebuild);
  if (schemaResult && schemaResult.migrated) {
    console.log('[Background] 数据迁移完成', {
      schemaVersion: schemaResult.schemaVersion,
      needsRebuild: rebuildPending
    });
  }

  await Promise.all([
    loadInitialData({ skipInitialRefresh: rebuildPending }),
    initSyncSettings()
  ]);

  if (rebuildPending) {
    console.log('[Background] 迁移后触发全量重建');
    const rebuildResult = await refreshBookmarks();
    if (rebuildResult && rebuildResult.success) {
      await setStorageOrThrow({ [STORAGE_KEYS.NEEDS_REBUILD]: false });
      console.log('[Background] 迁移后的重建完成，已清除 needsRebuild');
    } else {
      console.warn('[Background] 迁移后的重建未成功，保留 needsRebuild 以便后续重试', rebuildResult);
    }
  }

  console.log('[Background] 初始化完成');
}

export function ensureInit() {
  if (initPromise) return initPromise;
  initPromise = init().catch((error) => {
    console.error('[Background] 初始化失败:', error);
    initPromise = null;
    throw error;
  });
  return initPromise;
}
