import { idbDeleteByPrefix, idbGet, idbGetAllDocuments, idbReplaceDocuments, idbSetMeta } from './idb-service.js';
import { getStorageWithStatus, setStorageOrThrow, STORAGE_KEYS } from './storage-service.js';

const CURRENT_SCHEMA_VERSION = 3;
const LEGACY_SCHEMA_VERSION = 1;
const MIGRATION_STATES = {
  IDLE: 'idle',
  RUNNING: 'running',
  FAILED: 'failed'
};
const IDB_CACHE_KEY_BOOKMARKS = 'cachedBookmarks';
const IDB_KEY_PREFIX_FAVICON = 'favicon:';
const IDB_KEY_RECENT_OPENED_ROOTS = 'recentOpenedRoots:v1';
const DOCUMENT_SOURCE_TYPE = 'bookmark';
const IDB_META_KEY_SCHEMA_VERSION = 'schemaVersion';
const VALID_THEMES = new Set(['original', 'minimal', 'glass', 'dark']);
const VALID_HISTORY_ACTIONS = new Set(['add', 'delete', 'edit', 'move']);

function normalizeSchemaVersion(value) {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  return num >= 0 ? num : 0;
}

function normalizeTheme(value) {
  const safe = typeof value === 'string' ? value.trim() : '';
  return VALID_THEMES.has(safe) ? safe : 'original';
}

function normalizeSyncInterval(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : 30;
}

function normalizeLastSyncTime(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : null;
}

function normalizeBookmarkCount(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) {
    return Math.floor(fallback);
  }
  return 0;
}

function normalizeBookmarksMeta(value, fallbackCount = 0, fallbackUpdatedAt = 0) {
  const safe = (value && typeof value === 'object') ? value : {};
  const updatedAt = (typeof safe.updatedAt === 'number' && Number.isFinite(safe.updatedAt) && safe.updatedAt > 0)
    ? safe.updatedAt
    : ((typeof fallbackUpdatedAt === 'number' && Number.isFinite(fallbackUpdatedAt) && fallbackUpdatedAt > 0) ? fallbackUpdatedAt : 0);
  const count = (typeof safe.count === 'number' && Number.isFinite(safe.count) && safe.count >= 0)
    ? Math.floor(safe.count)
    : normalizeBookmarkCount(fallbackCount, 0);
  return { updatedAt, count };
}

function normalizeBookmarks(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object' && item.id !== undefined && typeof item.url === 'string');
}

function mapBookmarkToSearchDocument(bookmark) {
  if (!bookmark || typeof bookmark !== 'object' || !bookmark.id || !bookmark.url) return null;
  const path = typeof bookmark.path === 'string' && bookmark.path
    ? String(bookmark.path).split(' > ').map((item) => item.trim()).filter(Boolean)
    : [];
  const title = typeof bookmark.title === 'string' ? bookmark.title : '';
  const dateAdded = (typeof bookmark.dateAdded === 'number' && Number.isFinite(bookmark.dateAdded)) ? bookmark.dateAdded : 0;

  return {
    id: `${DOCUMENT_SOURCE_TYPE}:${String(bookmark.id)}`,
    sourceType: DOCUMENT_SOURCE_TYPE,
    sourceId: String(bookmark.id),
    title,
    subtitle: path.join(' > '),
    url: bookmark.url,
    path,
    keywords: path.slice(),
    tags: [],
    iconKey: bookmark.url,
    updatedAt: dateAdded,
    metadata: { dateAdded }
  };
}

async function migrateBookmarksToDocuments(bookmarks) {
  const list = Array.isArray(bookmarks) ? bookmarks : [];
  const documents = [];
  for (let i = 0; i < list.length; i++) {
    const doc = mapBookmarkToSearchDocument(list[i]);
    if (doc) documents.push(doc);
  }
  await idbReplaceDocuments(documents);
  return documents.length;
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const action = typeof entry.action === 'string' ? entry.action.trim().toLowerCase() : '';
  const timestamp = typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) ? entry.timestamp : 0;
  if (!VALID_HISTORY_ACTIONS.has(action) || timestamp <= 0) return null;

  const normalized = {
    action,
    timestamp,
    title: typeof entry.title === 'string' ? entry.title : '',
    url: typeof entry.url === 'string' ? entry.url : '',
    path: typeof entry.path === 'string' ? entry.path : ''
  };

  if (typeof entry.oldTitle === 'string') normalized.oldTitle = entry.oldTitle;
  if (typeof entry.oldUrl === 'string') normalized.oldUrl = entry.oldUrl;
  if (typeof entry.oldPath === 'string') normalized.oldPath = entry.oldPath;
  if (typeof entry.newPath === 'string') normalized.newPath = entry.newPath;
  if (typeof entry.folder === 'string') normalized.folder = entry.folder;

  return normalized;
}

function normalizeBookmarkHistory(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (let i = 0; i < value.length; i++) {
    const item = normalizeHistoryEntry(value[i]);
    if (item) list.push(item);
    if (list.length >= 100) break;
  }
  return list;
}

async function clearLegacyCaches() {
  let faviconDeletedCount = 0;
  let warmupDeleted = false;

  try {
    faviconDeletedCount = await idbDeleteByPrefix(IDB_KEY_PREFIX_FAVICON);
  } catch (error) {
    console.warn('[Migration] favicon cache clear failed:', error);
  }

  try {
    await idbDeleteByPrefix(IDB_KEY_RECENT_OPENED_ROOTS);
    warmupDeleted = true;
  } catch (error) {
    console.warn('[Migration] warmup snapshot clear failed:', error);
  }

  return { faviconDeletedCount, warmupDeleted };
}

async function migrateV1ToV2() {
  const storageRead = await getStorageWithStatus([
    STORAGE_KEYS.THEME,
    STORAGE_KEYS.SYNC_INTERVAL,
    STORAGE_KEYS.BOOKMARK_HISTORY,
    STORAGE_KEYS.BOOKMARKS_META,
    STORAGE_KEYS.BOOKMARK_COUNT,
    STORAGE_KEYS.LAST_SYNC_TIME,
    STORAGE_KEYS.BOOKMARKS,
    STORAGE_KEYS.NEEDS_REBUILD
  ]);

  const data = storageRead.data || {};
  let cachedBookmarks = [];
  try {
    cachedBookmarks = normalizeBookmarks(await idbGet(IDB_CACHE_KEY_BOOKMARKS));
  } catch (error) {
    console.warn('[Migration] cachedBookmarks read failed:', error);
  }

  const normalizedBookmarks = normalizeBookmarks(data[STORAGE_KEYS.BOOKMARKS]);
  const sourceBookmarks = cachedBookmarks.length > 0 ? cachedBookmarks : normalizedBookmarks;
  const fallbackCount = sourceBookmarks.length;
  const normalizedMeta = normalizeBookmarksMeta(
    data[STORAGE_KEYS.BOOKMARKS_META],
    fallbackCount,
    normalizeLastSyncTime(data[STORAGE_KEYS.LAST_SYNC_TIME]) || 0
  );

  const normalizedCount = normalizeBookmarkCount(
    data[STORAGE_KEYS.BOOKMARK_COUNT],
    normalizedMeta.count || fallbackCount
  );

  const existingDocuments = await idbGetAllDocuments().catch(() => []);
  const hasDocuments = Array.isArray(existingDocuments) && existingDocuments.length > 0;
  const needsRebuild = sourceBookmarks.length === 0;

  if (!hasDocuments && sourceBookmarks.length > 0) {
    await migrateBookmarksToDocuments(sourceBookmarks);
  }

  const storagePatch = {
    [STORAGE_KEYS.THEME]: normalizeTheme(data[STORAGE_KEYS.THEME]),
    [STORAGE_KEYS.SYNC_INTERVAL]: normalizeSyncInterval(data[STORAGE_KEYS.SYNC_INTERVAL]),
    [STORAGE_KEYS.BOOKMARK_HISTORY]: normalizeBookmarkHistory(data[STORAGE_KEYS.BOOKMARK_HISTORY]),
    [STORAGE_KEYS.BOOKMARKS_META]: {
      updatedAt: normalizedMeta.updatedAt,
      count: normalizedCount
    },
    [STORAGE_KEYS.BOOKMARK_COUNT]: normalizedCount,
    [STORAGE_KEYS.LAST_SYNC_TIME]: normalizeLastSyncTime(data[STORAGE_KEYS.LAST_SYNC_TIME]),
    [STORAGE_KEYS.BOOKMARKS]: normalizedBookmarks,
    [STORAGE_KEYS.NEEDS_REBUILD]: needsRebuild
  };

  const cleared = await clearLegacyCaches();
  await setStorageOrThrow(storagePatch);
  await idbSetMeta(IDB_META_KEY_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION).catch(() => {});

  return {
    success: true,
    rebuildScheduled: needsRebuild,
    normalizedBookmarkCount: normalizedCount,
    cleared,
    migratedDocuments: !hasDocuments && sourceBookmarks.length > 0
  };
}

async function migrateV2ToV3() {
  try {
    await idbDeleteByPrefix(IDB_CACHE_KEY_BOOKMARKS);
  } catch (error) {
    console.warn('[Migration] legacy cachedBookmarks clear failed:', error);
  }

  try {
    await idbDeleteByPrefix('cachedBookmarksTime');
  } catch (error) {
    console.warn('[Migration] legacy cachedBookmarksTime clear failed:', error);
  }

  return {
    success: true,
    rebuildScheduled: false,
    removedLegacyBookmarkCache: true
  };
}

async function runMigrations(fromVersion) {
  let version = fromVersion;
  const results = [];

  if (version < 2) {
    const result = await migrateV1ToV2();
    results.push({ fromVersion: Math.max(version, LEGACY_SCHEMA_VERSION), toVersion: 2, ...result });
    version = 2;
  }

  if (version < 3) {
    const result = await migrateV2ToV3();
    results.push({ fromVersion: 2, toVersion: 3, ...result });
    version = 3;
  }

  return { version, results };
}

export async function getMigrationStatus() {
  const storageRead = await getStorageWithStatus([
    STORAGE_KEYS.SCHEMA_VERSION,
    STORAGE_KEYS.MIGRATION_STATE,
    STORAGE_KEYS.LAST_MIGRATION_AT,
    STORAGE_KEYS.LAST_MIGRATION_ERROR,
    STORAGE_KEYS.NEEDS_REBUILD
  ]);
  const data = storageRead.data || {};
  const documents = await idbGetAllDocuments().catch(() => []);
  return {
    schemaVersion: normalizeSchemaVersion(data[STORAGE_KEYS.SCHEMA_VERSION]),
    migrationState: typeof data[STORAGE_KEYS.MIGRATION_STATE] === 'string' ? data[STORAGE_KEYS.MIGRATION_STATE] : MIGRATION_STATES.IDLE,
    lastMigrationAt: data[STORAGE_KEYS.LAST_MIGRATION_AT] || null,
    lastMigrationError: data[STORAGE_KEYS.LAST_MIGRATION_ERROR] || null,
    needsRebuild: !!data[STORAGE_KEYS.NEEDS_REBUILD],
    documentCount: Array.isArray(documents) ? documents.length : 0,
    currentSchemaVersion: CURRENT_SCHEMA_VERSION
  };
}

export async function ensureSchemaReady() {
  const storageRead = await getStorageWithStatus([
    STORAGE_KEYS.SCHEMA_VERSION,
    STORAGE_KEYS.MIGRATION_STATE,
    STORAGE_KEYS.NEEDS_REBUILD
  ]);
  const data = storageRead.data || {};
  const schemaVersion = normalizeSchemaVersion(data[STORAGE_KEYS.SCHEMA_VERSION]);
  const migrationState = typeof data[STORAGE_KEYS.MIGRATION_STATE] === 'string'
    ? data[STORAGE_KEYS.MIGRATION_STATE]
    : MIGRATION_STATES.IDLE;

  if (schemaVersion >= CURRENT_SCHEMA_VERSION && migrationState !== MIGRATION_STATES.RUNNING) {
    return {
      migrated: false,
      schemaVersion,
      needsRebuild: !!data[STORAGE_KEYS.NEEDS_REBUILD]
    };
  }

  await setStorageOrThrow({
    [STORAGE_KEYS.MIGRATION_STATE]: MIGRATION_STATES.RUNNING,
    [STORAGE_KEYS.LAST_MIGRATION_ERROR]: null
  });

  try {
    const effectiveFromVersion = schemaVersion > 0 ? schemaVersion : LEGACY_SCHEMA_VERSION;
    const migrationResult = await runMigrations(effectiveFromVersion);
    const finishedAt = Date.now();

    await setStorageOrThrow({
      [STORAGE_KEYS.SCHEMA_VERSION]: migrationResult.version,
      [STORAGE_KEYS.MIGRATION_STATE]: MIGRATION_STATES.IDLE,
      [STORAGE_KEYS.LAST_MIGRATION_AT]: finishedAt,
      [STORAGE_KEYS.LAST_MIGRATION_ERROR]: null
    });
    await idbSetMeta(IDB_META_KEY_SCHEMA_VERSION, migrationResult.version).catch(() => {});

    console.log('[Migration] schema ready', {
      fromVersion: effectiveFromVersion,
      toVersion: migrationResult.version,
      steps: migrationResult.results.length
    });

    return {
      migrated: migrationResult.results.length > 0,
      schemaVersion: migrationResult.version,
      needsRebuild: migrationResult.results.some((item) => !!item.rebuildScheduled),
      results: migrationResult.results
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    await setStorageOrThrow({
      [STORAGE_KEYS.MIGRATION_STATE]: MIGRATION_STATES.FAILED,
      [STORAGE_KEYS.LAST_MIGRATION_ERROR]: message
    });
    console.error('[Migration] schema migration failed:', error);
    throw error;
  }
}
