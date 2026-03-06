import { getStorageWithStatus, setStorage, setValue, STORAGE_KEYS } from './storage-service.js';
import { compareBookmarks, flattenBookmarksTree } from './bookmark-logic.js';
import { HISTORY_ACTIONS, PATH_SEPARATOR } from './constants.js';
import { idbGet, idbSet, idbSetMany } from './idb-service.js';
import { getRootDomain } from './utils.js';

// 书签数据管理模块

// 常量定义
const MAX_HISTORY_ITEMS = 100;  // 历史记录最大条数
const IDB_CACHE_KEY_BOOKMARKS = 'cachedBookmarks';
const IDB_CACHE_KEY_TIMESTAMP = 'cachedBookmarksTime';  // IDB 缓存时间戳，用于与 storage 比较新鲜度
const IDB_KEY_RECENT_OPENED_ROOTS = 'recentOpenedRoots:v1';  // 最近打开过的根域名快照（用于 warmup 优先级，防 SW 重启丢失）
const BOOKMARK_CACHE_TTL_DEFAULT_MS = 30 * 60 * 1000; // 默认主缓存 TTL：30 分钟
const STALE_REFRESH_MIN_GAP_MS = 30 * 1000; // 过期触发全量刷新的最小间隔

function normalizeCacheMeta(meta, fallbackCount = 0, fallbackUpdatedAt = 0) {
  const safeMeta = (meta && typeof meta === 'object') ? meta : {};
  const updatedAtRaw = safeMeta.updatedAt;
  const countRaw = safeMeta.count;

  const updatedAt = (typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw) && updatedAtRaw > 0)
    ? updatedAtRaw
    : ((typeof fallbackUpdatedAt === 'number' && Number.isFinite(fallbackUpdatedAt) && fallbackUpdatedAt > 0) ? fallbackUpdatedAt : 0);

  const count = (typeof countRaw === 'number' && Number.isFinite(countRaw) && countRaw >= 0)
    ? Math.floor(countRaw)
    : ((typeof fallbackCount === 'number' && Number.isFinite(fallbackCount) && fallbackCount >= 0) ? Math.floor(fallbackCount) : 0);

  return { updatedAt, count };
}

function buildCacheMeta(bookmarks, updatedAt) {
  const list = Array.isArray(bookmarks) ? bookmarks : [];
  const safeUpdatedAt = (typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0) ? updatedAt : Date.now();
  return { updatedAt: safeUpdatedAt, count: list.length };
}

function getMetaFreshness(meta) {
  const safeMeta = normalizeCacheMeta(meta);
  return safeMeta.updatedAt;
}

// 本地存储的书签数据
let cachedBookmarks = [];
// 书签变化历史
let bookmarkHistory = [];
// 快速索引：bookmarkId -> cachedBookmarks index
let bookmarkIndexById = new Map();
// 并发锁：串行化 refresh 与增量事件处理
let isUpdating = false;
let updateQueued = false;
let pendingRefresh = false;
let pendingBookmarkEvents = [];
// 缓存是否已从 storage 加载（避免重复 IO）
let isCacheLoaded = false;
let loadCachePromise = null;
let lastStaleRefreshAt = 0;
let runtimeCacheTtlMinutes = null;
let runtimeCacheTtlLoaded = false;
// 最近在搜索结果中实际打开过的根域名（用于 favicon 预热优先级）
// key: rootDomain -> { count, lastAt, sampleUrl }
const recentOpenedRootMap = new Map();
const RECENT_OPEN_ROOT_MAX = 200;
const RECENT_OPEN_ROOT_WINDOW_MS = 60 * 60 * 1000; // 1 小时窗口
// 最近已用于 favicon 预热的根域名，避免多 tab 重复 warmup
// key: rootDomain -> lastWarmupAt
const recentWarmupDomains = new Map();
const RECENT_WARMUP_WINDOW_MS = 30 * 60 * 1000; // 30 分钟窗口

// 持久化：最近打开过的根域名（防 MV3 SW 重启/休眠丢失 warmup 优先级）
let recentOpenedRootsPersistChain = Promise.resolve();

function buildRecentOpenedRootsSnapshot(nowTs = Date.now()) {
  const now = (typeof nowTs === 'number' && Number.isFinite(nowTs) && nowTs > 0) ? nowTs : Date.now();
  const cutoff = now - RECENT_OPEN_ROOT_WINDOW_MS;
  const entries = [];

  for (const [root, info] of recentOpenedRootMap.entries()) {
    if (!root) continue;
    const lastAt = info && typeof info.lastAt === 'number' ? info.lastAt : 0;
    if (!lastAt || lastAt < cutoff) continue;
    const count = (info && typeof info.count === 'number' && Number.isFinite(info.count) && info.count >= 0) ? Math.floor(info.count) : 0;
    const sampleUrl = (info && typeof info.sampleUrl === 'string') ? info.sampleUrl : '';
    entries.push({ root, count, lastAt, sampleUrl });
  }

  entries.sort((a, b) => {
    const av = typeof a.lastAt === 'number' ? a.lastAt : 0;
    const bv = typeof b.lastAt === 'number' ? b.lastAt : 0;
    return bv - av;
  });

  if (entries.length > RECENT_OPEN_ROOT_MAX) {
    entries.length = RECENT_OPEN_ROOT_MAX;
  }

  return entries;
}

function restoreRecentOpenedRootsFromSnapshot(snapshot, nowTs = Date.now()) {
  recentOpenedRootMap.clear();

  const now = (typeof nowTs === 'number' && Number.isFinite(nowTs) && nowTs > 0) ? nowTs : Date.now();
  const cutoff = now - RECENT_OPEN_ROOT_WINDOW_MS;
  const list = Array.isArray(snapshot) ? snapshot : [];
  if (list.length === 0) return;

  const valid = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;

    const root = (typeof item.root === 'string') ? item.root.trim().toLowerCase() : '';
    if (!root) continue;

    const lastAt = (typeof item.lastAt === 'number' && Number.isFinite(item.lastAt)) ? item.lastAt : 0;
    if (!lastAt || lastAt < cutoff) continue;

    const count = (typeof item.count === 'number' && Number.isFinite(item.count) && item.count >= 0) ? Math.floor(item.count) : 0;
    const sampleUrl = (typeof item.sampleUrl === 'string') ? item.sampleUrl : '';
    valid.push({ root, count, lastAt, sampleUrl });
  }

  valid.sort((a, b) => {
    const av = typeof a.lastAt === 'number' ? a.lastAt : 0;
    const bv = typeof b.lastAt === 'number' ? b.lastAt : 0;
    return bv - av;
  });

  for (let i = 0; i < valid.length && i < RECENT_OPEN_ROOT_MAX; i++) {
    const item = valid[i];
    recentOpenedRootMap.set(item.root, { count: item.count, lastAt: item.lastAt, sampleUrl: item.sampleUrl });
  }
}

function persistRecentOpenedRootsToIdb(nowTs = Date.now()) {
  const snapshot = buildRecentOpenedRootsSnapshot(nowTs);

  recentOpenedRootsPersistChain = recentOpenedRootsPersistChain
    .catch(() => {})
    .then(() => idbSet(IDB_KEY_RECENT_OPENED_ROOTS, snapshot))
    .catch((error) => {
      console.warn('[Background][Observe] recent_open_roots_persist_failed', { message: error && error.message ? error.message : String(error) });
    });

  return recentOpenedRootsPersistChain;
}


function rebuildBookmarkIndex() {
  const next = new Map();
  const list = Array.isArray(cachedBookmarks) ? cachedBookmarks : [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || !b.id) continue;
    next.set(String(b.id), i);
  }
  bookmarkIndexById = next;
}

function maybeScheduleStaleRefresh() {
  const now = Date.now();
  const tooSoon = (now - lastStaleRefreshAt) < STALE_REFRESH_MIN_GAP_MS;
  if (tooSoon) return;

  lastStaleRefreshAt = now;
  console.log('[Background][Observe] stale_refresh_trigger', { reason: 'ttl_expired', at: now });
  refreshBookmarks().catch((error) => {
    console.warn('[Background][Observe] stale_refresh_failed', { message: error && error.message ? error.message : String(error) });
  });
}

async function ensureRuntimeCacheTtlMinutes() {
  if (runtimeCacheTtlLoaded && typeof runtimeCacheTtlMinutes === 'number' && runtimeCacheTtlMinutes > 0) {
    return runtimeCacheTtlMinutes;
  }

  const ttlRead = await getStorageWithStatus(STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES);
  if (!ttlRead.success && ttlRead.state && ttlRead.state[STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES] === 'failed') {
    console.warn('[Background][Observe] ttl_storage_read_failed', { error: ttlRead.error || 'unknown' });
  }

  const ttlRaw = ttlRead.data ? ttlRead.data[STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES] : null;
  const ttl = (typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) && ttlRaw > 0) ? ttlRaw : 30;

  runtimeCacheTtlMinutes = ttl;
  runtimeCacheTtlLoaded = true;
  return runtimeCacheTtlMinutes;
}

export function updateRuntimeCacheTtlMinutes(nextValue) {
  const ttl = (typeof nextValue === 'number' && Number.isFinite(nextValue) && nextValue > 0)
    ? Math.floor(nextValue)
    : null;

  if (ttl) {
    runtimeCacheTtlMinutes = ttl;
    runtimeCacheTtlLoaded = true;
    return;
  }

  runtimeCacheTtlMinutes = null;
  runtimeCacheTtlLoaded = false;
}

export async function recordBookmarkOpen(url) {
  const safeUrl = typeof url === 'string' ? url.trim() : '';
  if (!safeUrl) return;
  let host = '';
  let href = '';
  try {
    const u = new URL(safeUrl);
    host = u && u.hostname ? String(u.hostname).toLowerCase() : '';
    href = u && u.href ? u.href : safeUrl;
  } catch (e) {
    return;
  }
  if (!host) return;
  const root = getRootDomain(host);
  if (!root) return;

  const nowTs = Date.now();
  const prev = recentOpenedRootMap.get(root) || { count: 0, lastAt: 0, sampleUrl: '' };
  const next = {
    count: (prev.count || 0) + 1,
    lastAt: nowTs,
    sampleUrl: prev.sampleUrl || href
  };
  recentOpenedRootMap.set(root, next);

  // 清理过期或过多的记录
  const cutoff = nowTs - RECENT_OPEN_ROOT_WINDOW_MS;
  const toDelete = [];
  for (const [key, value] of recentOpenedRootMap.entries()) {
    if (!value || typeof value.lastAt !== 'number' || value.lastAt < cutoff) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    recentOpenedRootMap.delete(key);
  }
  // 最多保留 RECENT_OPEN_ROOT_MAX 条，按 lastAt 从新到旧
  if (recentOpenedRootMap.size > RECENT_OPEN_ROOT_MAX) {
    const entries = Array.from(recentOpenedRootMap.entries());
    entries.sort((a, b) => {
      const av = a[1] && typeof a[1].lastAt === 'number' ? a[1].lastAt : 0;
      const bv = b[1] && typeof b[1].lastAt === 'number' ? b[1].lastAt : 0;
      return bv - av;
    });
    for (let i = RECENT_OPEN_ROOT_MAX; i < entries.length; i++) {
      recentOpenedRootMap.delete(entries[i][0]);
    }
  }

  // Best-effort: persist snapshot so warmup priority survives SW restarts
  await persistRecentOpenedRootsToIdb(nowTs);
}

async function runUpdateLoop() {
  if (isUpdating) {
    updateQueued = true;
    return { success: false, skipped: true };
  }

  isUpdating = true;
  let lastResult = { success: false };
  try {
    do {
      updateQueued = false;

      if (pendingRefresh) {
        pendingRefresh = false;
        pendingBookmarkEvents = [];
        lastResult = await refreshBookmarksOnce();
        continue;
      }

      if (pendingBookmarkEvents.length > 0) {
        const batch = pendingBookmarkEvents;
        pendingBookmarkEvents = [];
        lastResult = await applyBookmarkEventsOnce(batch);
        continue;
      }

      lastResult = { success: true, idle: true };
    } while (updateQueued || pendingRefresh || pendingBookmarkEvents.length > 0);

    return lastResult;
  } finally {
    isUpdating = false;
  }
}

/**
 * 从 Chrome 获取书签树并处理
 */
export async function refreshBookmarks() {
  pendingRefresh = true;
  if (isUpdating) {
    updateQueued = true;
    console.log("[Background] 刷新已在进行中，标记为待刷新");
    return { success: false, skipped: true };
  }

  return runUpdateLoop();
}

/**
 * 增量处理书签事件（尽量避免全量 getTree）
 */
export async function applyBookmarkEvents(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  if (list.length === 0) return { success: true, applied: 0 };

  pendingBookmarkEvents = pendingBookmarkEvents.concat(list);

  // 防止极端情况下队列无限增长（例如导入/批量操作）
  if (pendingBookmarkEvents.length > 500) {
    pendingRefresh = true;
  }

  if (isUpdating) {
    updateQueued = true;
    return { success: false, skipped: true };
  }

  return runUpdateLoop();
}

async function refreshBookmarksOnce() {
  console.log("[Background] 开始刷新书签...");

  // 确保已有缓存基线，避免把“全量书签”误判成新增变更
  await loadCacheFromStorage();

  try {
    const syncTime = Date.now();
    const tree = await chrome.bookmarks.getTree();
    
    // 展平书签树
    const flatBookmarks = flattenBookmarksTree(tree);
    
    // 与旧数据对比，生成差异记录
    const changes = compareBookmarks(cachedBookmarks, flatBookmarks);
    
    if (changes.length > 0) {
      console.log("[Background] 检测到 %d 个书签变化", changes.length);
      // 更新历史记录
      await updateHistory(changes);

      // 更新缓存
      cachedBookmarks = flatBookmarks;
      rebuildBookmarkIndex();

      // 保存到本地存储
      await saveToStorage(syncTime);
    } else {
      console.log("[Background] 书签无变化");
      await ensureCacheConsistency(syncTime);
    }
    
    return { success: true, count: flatBookmarks.length, changes: changes.length };
  } catch (error) {
    console.error("[Background] 刷新书签失败:", error);
    return { success: false, error: error.message };
  }
}

/**
 * 批量预加载所有文件夹路径到缓存
 * @param {Map} cache - 路径缓存 Map
 * @param {Array} [existingTree] - 可选，已获取的书签树（避免重复 API 调用）
 */
async function preloadFolderPaths(cache, existingTree) {
  if (!cache) return;
  try {
    const tree = existingTree || await chrome.bookmarks.getTree();
    const buildPaths = (nodes, parentPath) => {
      for (const node of nodes) {
        if (!node) continue;
        const currentPath = parentPath
          ? (node.title ? parentPath + PATH_SEPARATOR + node.title : parentPath)
          : (node.title || '');
        // 只缓存文件夹（无 url 的节点）
        if (!node.url && node.id) {
          cache.set(node.id, currentPath);
        }
        if (node.children) {
          buildPaths(node.children, currentPath);
        }
      }
    };
    buildPaths(tree, '');
  } catch (error) {
    console.warn('[Background] 预加载文件夹路径失败:', error);
  }
}

async function getFolderPath(parentId, cache) {
  const id = typeof parentId === 'string' ? parentId : String(parentId || '');
  if (!id || id === '0') return '';
  if (cache && cache.has(id)) return cache.get(id);

  // 缓存未命中时回退到单次查询（兼容增量更新场景）
  const parts = [];
  let currentId = id;

  while (currentId && currentId !== '0') {
    let nodes;
    try {
      nodes = await chrome.bookmarks.get(currentId);
    } catch (error) {
      break;
    }
    const node = nodes && nodes[0];
    if (!node) break;

    if (node.title) {
      parts.unshift(node.title);
    }

    if (node.parentId === '0') break;
    currentId = node.parentId;
  }

  const path = parts.join(PATH_SEPARATOR);
  if (cache) cache.set(id, path);
  return path;
}

function collectRemovedBookmarkIds(node, out) {
  if (!node) return;
  if (node.url && node.id) {
    out.push(String(node.id));
  }
  const children = node.children;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      collectRemovedBookmarkIds(children[i], out);
    }
  }
}

async function applyBookmarkEventsOnce(events) {
  console.log("[Background] 开始增量处理书签事件: %d 条", Array.isArray(events) ? events.length : 0);

  await loadCacheFromStorage();

  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return { success: true, applied: 0 };

  // 过大批次直接走全量刷新，避免长时间占用 service worker
  if (list.length > 200) {
    pendingRefresh = true;
    console.log('[Background][Observe] incremental_fallback_full', { reason: 'batch_too_large', size: list.length });
    return { success: false, fallback: true };
  }

  // 只对"书签级别"的 create/change/move/remove 做增量；遇到 folder 级别的变更（changed/moved）
  // 或显式 forceRefresh/import 事件，直接走全量刷新，保证路径一致性。
  // 先收集本批次中新创建的书签 ID，避免 created→changed 同批次误判
  const createdIdsInBatch = new Set();
  for (let i = 0; i < list.length; i++) {
    const evt = list[i];
    if (evt && evt.type === 'created') {
      const node = evt.bookmark;
      const id = String(evt.id || (node && node.id) || '');
      if (id && node && node.url) createdIdsInBatch.add(id);
    }
  }

  for (let i = 0; i < list.length; i++) {
    const evt = list[i];
    const type = evt && evt.type;
    if (!type) continue;
    if (type === 'forceRefresh' || type === 'importBegan' || type === 'importEnded') {
      pendingRefresh = true;
      console.log('[Background][Observe] incremental_fallback_full', { reason: type });
      return { success: false, fallback: true };
    }
    if (type === 'changed' || type === 'moved') {
      const id = String(evt.id || '');
      // 允许本批次新创建的书签被修改/移动
      if (!id || (!bookmarkIndexById.has(id) && !createdIdsInBatch.has(id))) {
        pendingRefresh = true;
        console.log('[Background][Observe] incremental_fallback_full', { reason: type + '_without_baseline', id });
        return { success: false, fallback: true };
      }
    }
  }

  const folderPathCache = new Map();
  // 预加载所有文件夹路径，避免后续 N+1 查询
  await preloadFolderPaths(folderPathCache);

  const changes = [];
  let mutated = false;
  let removedAny = false;
  const now = Date.now;

  for (let i = 0; i < list.length; i++) {
    const evt = list[i];
    const type = evt && evt.type;
    if (!type) continue;

    if (type === 'created') {
      const node = evt.bookmark;
      if (!node || !node.url) continue; // folder created: ignore

      const id = String(evt.id || node.id || '');
      if (!id) continue;

      const title = node.title || '';
      const url = node.url || '';
      const path = await getFolderPath(node.parentId, folderPathCache);

      if (bookmarkIndexById.has(id)) continue;

      const item = {
        id,
        title,
        url,
        path,
        dateAdded: node.dateAdded
      };
      cachedBookmarks.push(item);
      bookmarkIndexById.set(id, cachedBookmarks.length - 1);
      mutated = true;
      changes.push({
        action: HISTORY_ACTIONS.ADD,
        title,
        url,
        path,
        timestamp: now()
      });
      continue;
    }

    if (type === 'changed') {
      const id = String(evt.id || '');
      const idx = bookmarkIndexById.get(id);
      if (idx === undefined) continue;

      const item = cachedBookmarks[idx];
      if (!item) continue;

      const changeInfo = evt.changeInfo && typeof evt.changeInfo === 'object' ? evt.changeInfo : {};
      const nextTitle = changeInfo.title !== undefined ? (changeInfo.title || '') : (item.title || '');
      const nextUrl = changeInfo.url !== undefined ? (changeInfo.url || '') : (item.url || '');

      if (nextTitle === item.title && nextUrl === item.url) continue;

      const oldTitle = item.title || '';
      const oldUrl = item.url || '';
      item.title = nextTitle;
      item.url = nextUrl;
      mutated = true;
      changes.push({
        action: HISTORY_ACTIONS.EDIT,
        oldTitle,
        title: nextTitle,
        oldUrl,
        url: nextUrl,
        path: item.path || '',
        timestamp: now()
      });
      continue;
    }

    if (type === 'moved') {
      const id = String(evt.id || '');
      const idx = bookmarkIndexById.get(id);
      if (idx === undefined) continue;

      const item = cachedBookmarks[idx];
      if (!item) continue;

      const moveInfo = evt.moveInfo && typeof evt.moveInfo === 'object' ? evt.moveInfo : {};
      const nextPath = await getFolderPath(moveInfo.parentId, folderPathCache);
      const oldPath = item.path || '';

      if (nextPath === oldPath) continue;

      item.path = nextPath;
      mutated = true;
      changes.push({
        action: HISTORY_ACTIONS.MOVE,
        title: item.title || '',
        url: item.url || '',
        oldPath,
        newPath: nextPath,
        timestamp: now()
      });
      continue;
    }

    if (type === 'removed') {
      const removeInfo = evt.removeInfo && typeof evt.removeInfo === 'object' ? evt.removeInfo : {};
      const node = removeInfo.node;
      const removedIds = [];
      collectRemovedBookmarkIds(node, removedIds);

      // 兜底：某些场景 removeInfo.node 不完整时，至少删除当前事件 ID
      const fallbackRemovedId = String(evt.id || '');
      if (fallbackRemovedId && removedIds.indexOf(fallbackRemovedId) === -1) {
        removedIds.push(fallbackRemovedId);
      }

      for (let j = 0; j < removedIds.length; j++) {
        const removedId = removedIds[j];
        const idx = bookmarkIndexById.get(removedId);
        if (idx === undefined) continue;

        const item = cachedBookmarks[idx];
        if (!item) continue;

        cachedBookmarks[idx] = null;
        bookmarkIndexById.delete(removedId);
        removedAny = true;
        mutated = true;

        changes.push({
          action: HISTORY_ACTIONS.DELETE,
          title: item.title || '',
          url: item.url || '',
          folder: item.path || '',
          timestamp: now()
        });
      }
    }
  }

  if (!mutated) {
    return { success: true, applied: 0 };
  }

  if (removedAny) {
    cachedBookmarks = cachedBookmarks.filter(Boolean);
    rebuildBookmarkIndex();
  }

  await updateHistory(changes);
  await saveToStorage(Date.now());

  return { success: true, count: cachedBookmarks.length, changes: changes.length, incremental: true };
}

async function loadCacheFromStorage() {
  if (isCacheLoaded) return;
  if (loadCachePromise) return loadCachePromise;
  loadCachePromise = loadCacheFromStorageOnce();
  try { await loadCachePromise; } finally { loadCachePromise = null; }
}

async function loadCacheFromStorageOnce() {
  // IDB is the primary store for the full bookmark list
  let idbBookmarks;
  let idbCacheTime = 0;
  let idbRecentOpenedRoots;
  try {
    const [bookmarksResult, timeResult, recentOpenedRootsResult] = await Promise.all([
      idbGet(IDB_CACHE_KEY_BOOKMARKS),
      idbGet(IDB_CACHE_KEY_TIMESTAMP),
      idbGet(IDB_KEY_RECENT_OPENED_ROOTS)
    ]);
    idbBookmarks = bookmarksResult;
    idbCacheTime = typeof timeResult === 'number' ? timeResult : 0;
    idbRecentOpenedRoots = recentOpenedRootsResult;
  } catch (error) {
    console.warn("[Background] 从 IndexedDB 读取书签缓存失败:", error);
  }

  // chrome.storage.local: only metadata + history (no full bookmark list)
  const storageRead = await getStorageWithStatus([
    STORAGE_KEYS.BOOKMARK_HISTORY,
    STORAGE_KEYS.LAST_SYNC_TIME,
    STORAGE_KEYS.BOOKMARKS_META
  ]);
  const storageData = storageRead.data || {};

  const storageHistoryRaw = storageData[STORAGE_KEYS.BOOKMARK_HISTORY];
  const storageHistory = Array.isArray(storageHistoryRaw) ? storageHistoryRaw : [];

  const idbHasData = Array.isArray(idbBookmarks) && idbBookmarks.length > 0;

  if (idbHasData) {
    cachedBookmarks = idbBookmarks;
    console.log('[Background][Observe] cache_source_selected', { source: 'idb', idbCacheTime, count: cachedBookmarks.length });
  } else {
    cachedBookmarks = [];
    console.log('[Background][Observe] cache_source_selected', { source: 'empty', idbCacheTime, count: 0 });
  }

  if (!storageRead.success && storageRead.state && storageRead.state[STORAGE_KEYS.BOOKMARK_HISTORY] === 'failed') {
    console.warn('[Background][Observe] history_load_failed_keep_memory', { error: storageRead.error || 'unknown' });
  } else {
    bookmarkHistory = storageHistory;
  }
  // Restore recently opened roots snapshot (warmup prioritization)
  try {
    restoreRecentOpenedRootsFromSnapshot(idbRecentOpenedRoots);
  } catch (e) {
    // best-effort only
  }
  rebuildBookmarkIndex();
  isCacheLoaded = true;
}

async function ensureCacheConsistency(syncTime) {
  const list = Array.isArray(cachedBookmarks) ? cachedBookmarks : [];
  const meta = buildCacheMeta(list, syncTime);

  // Only check IDB for bookmark list consistency (storage no longer holds full list)
  let needBackfillIdb = false;
  try {
    const [idbBookmarks, idbTimeRaw] = await Promise.all([
      idbGet(IDB_CACHE_KEY_BOOKMARKS),
      idbGet(IDB_CACHE_KEY_TIMESTAMP)
    ]);
    const idbTime = (typeof idbTimeRaw === 'number' && Number.isFinite(idbTimeRaw) && idbTimeRaw > 0) ? idbTimeRaw : 0;
    const idbCount = Array.isArray(idbBookmarks) ? idbBookmarks.length : 0;
    needBackfillIdb = idbTime < meta.updatedAt || idbCount !== meta.count;
  } catch (error) {
    needBackfillIdb = true;
  }

  // Check storage meta consistency
  let needUpdateStorageMeta = false;
  const storageRead = await getStorageWithStatus([STORAGE_KEYS.BOOKMARKS_META]);
  if (storageRead.success && storageRead.data) {
    const storageMeta = normalizeCacheMeta(storageRead.data[STORAGE_KEYS.BOOKMARKS_META]);
    needUpdateStorageMeta = storageMeta.updatedAt < meta.updatedAt || storageMeta.count !== meta.count;
  }

  if (!needBackfillIdb && !needUpdateStorageMeta) {
    return;
  }

  console.log('[Background][Observe] consistency_check_backfill', { needBackfillIdb, needUpdateStorageMeta, updatedAt: meta.updatedAt, count: meta.count });

  const tasks = [];
  if (needBackfillIdb) {
    tasks.push(
      Promise.all([
        idbSet(IDB_CACHE_KEY_BOOKMARKS, list),
        idbSet(IDB_CACHE_KEY_TIMESTAMP, meta.updatedAt)
      ]).catch((error) => {
        console.warn('[Background][Observe] consistency_backfill_failed', { target: 'idb', message: error && error.message ? error.message : String(error) });
      })
    );
  }

  if (needUpdateStorageMeta) {
    tasks.push(
      setStorage({
        [STORAGE_KEYS.BOOKMARKS_META]: meta,
        [STORAGE_KEYS.BOOKMARK_COUNT]: meta.count,
        [STORAGE_KEYS.LAST_SYNC_TIME]: meta.updatedAt
      }).then((ok) => {
        if (!ok) {
          console.warn('[Background][Observe] consistency_backfill_failed', { target: 'storage_meta', message: 'setStorage returned false' });
        }
      }).catch((error) => {
        console.warn('[Background][Observe] consistency_backfill_failed', { target: 'storage_meta', message: error && error.message ? error.message : String(error) });
      })
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

/**
 * 更新历史记录
 * @param {Array} changes - 新变更
 */
async function updateHistory(changes) {
  const storageRead = await getStorageWithStatus([STORAGE_KEYS.BOOKMARK_HISTORY]);
  if (!storageRead.success && storageRead.state && storageRead.state[STORAGE_KEYS.BOOKMARK_HISTORY] === 'failed') {
    console.warn('[Background][Observe] history_read_failed_skip_override', { error: storageRead.error || 'unknown' });
    return;
  }

  const existing = Array.isArray(storageRead.data ? storageRead.data[STORAGE_KEYS.BOOKMARK_HISTORY] : null)
    ? storageRead.data[STORAGE_KEYS.BOOKMARK_HISTORY]
    : [];

  // 仅保留最近的 MAX_HISTORY_ITEMS 条记录
  bookmarkHistory = [...changes, ...existing].slice(0, MAX_HISTORY_ITEMS);
}

/**
 * 保存到存储
 * IDB: 完整书签列表 + 时间戳（主存储）
 * chrome.storage.local: 仅元数据（count/history/syncTime/meta），不再写入完整列表
 */
async function saveToStorage(syncTime) {
  const meta = buildCacheMeta(cachedBookmarks, syncTime);

  const idbEntries = [
    { key: IDB_CACHE_KEY_BOOKMARKS, value: cachedBookmarks },
    { key: IDB_CACHE_KEY_TIMESTAMP, value: meta.updatedAt }
  ];

  const writeIdb = idbSetMany(idbEntries)
    .then(() => true)
    .catch((error) => {
      console.warn("[Background] 写入 IndexedDB 书签缓存失败，2s 后重试:", error);
      return new Promise((resolve) => {
        setTimeout(() => {
          idbSetMany(idbEntries)
            .then(() => { resolve(true); })
            .catch((retryErr) => {
              console.warn("[Background] IndexedDB 重试仍失败:", retryErr);
              resolve(false);
            });
        }, 2000);
      });
    });

  const writeStorage = setStorage({
    [STORAGE_KEYS.BOOKMARK_COUNT]: meta.count,
    [STORAGE_KEYS.BOOKMARK_HISTORY]: bookmarkHistory,
    [STORAGE_KEYS.LAST_SYNC_TIME]: meta.updatedAt,
    [STORAGE_KEYS.BOOKMARKS_META]: meta
  });

  const results = await Promise.all([writeIdb, writeStorage]);
  const idbOk = results[0];
  const storageOk = results[1];

  if (!idbOk) {
    console.warn('[Background][Observe] cache_write_degraded', { source: 'idb_failed', updatedAt: meta.updatedAt, count: meta.count });
  }
  if (!storageOk) {
    console.warn('[Background][Observe] cache_write_degraded', { source: 'storage_meta_failed', updatedAt: meta.updatedAt, count: meta.count });
  }
}

/**
 * 加载初始数据
 */
export async function loadInitialData() {
  await loadCacheFromStorage();

  if (cachedBookmarks.length > 0) {
    console.log("[Background] 已加载缓存书签: %d 条", cachedBookmarks.length);
  } else {
    // 如果没有缓存，立即刷新一次
    await refreshBookmarks();
  }
  
  console.log("[Background] 已加载历史记录: %d 条", bookmarkHistory.length);
}

function searchInList(bookmarkList, query, limit) {
  const list = Array.isArray(bookmarkList) ? bookmarkList : [];
  const raw = typeof query === 'string' ? query.trim() : '';
  if (!raw) return [];

  const queryLower = raw.toLowerCase();
  const tokens = queryLower.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const max = typeof limit === 'number' && limit > 0 ? limit : 10;
  const topK = [];

  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || !b.url) continue;

    const titleLower = String(b.title || '').toLowerCase();
    const urlLower = String(b.url || '').toLowerCase();

    let score = 0;
    let matched = true;

    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t];
      const ti = titleLower.indexOf(token);
      const ui = urlLower.indexOf(token);
      if (ti < 0 && ui < 0) {
        matched = false;
        break;
      }

      if (ti >= 0) {
        let tokenScore = ti;
        if (ti === 0) tokenScore -= 50;
        const beforeChar = ti > 0 ? titleLower.charCodeAt(ti - 1) : 0;
        if (beforeChar === 32 || beforeChar === 45 || beforeChar === 95 || beforeChar === 124) {
          tokenScore -= 20;
        }
        score += tokenScore;
      } else {
        score += 1000 + ui;
      }
    }

    if (!matched) continue;

    if (tokens.length === 1 && titleLower === queryLower) {
      score -= 200;
    }

    // Top-K 插入：保持 topK 按 score 升序，最多 max 个元素
    if (topK.length < max) {
      let insertIdx = topK.length;
      while (insertIdx > 0 && topK[insertIdx - 1].score > score) {
        insertIdx--;
      }
      topK.splice(insertIdx, 0, { score, bookmark: b });
    } else if (score < topK[max - 1].score) {
      topK.pop();
      let insertIdx = topK.length;
      while (insertIdx > 0 && topK[insertIdx - 1].score > score) {
        insertIdx--;
      }
      topK.splice(insertIdx, 0, { score, bookmark: b });
    }
  }

  return topK.map((x) => x.bookmark);
}

/**
 * Search bookmarks from the cached, flattened list (preferred).
 * Falls back to `chrome.bookmarks.search` if cache is empty.
 */
export async function searchBookmarks(query, { limit = 10 } = {}) {
  await loadCacheFromStorage();

  const syncRead = await getStorageWithStatus(STORAGE_KEYS.LAST_SYNC_TIME);
  const lastSync = syncRead.data ? syncRead.data[STORAGE_KEYS.LAST_SYNC_TIME] : null;

  if (!syncRead.success && syncRead.state && syncRead.state[STORAGE_KEYS.LAST_SYNC_TIME] === 'failed') {
    console.warn('[Background][Observe] last_sync_read_failed', { error: syncRead.error || 'unknown' });
  }

  const ttlMinutes = await ensureRuntimeCacheTtlMinutes();
  const ttlMs = ttlMinutes * 60 * 1000 || BOOKMARK_CACHE_TTL_DEFAULT_MS;

  if (typeof lastSync === 'number' && lastSync > 0 && (Date.now() - lastSync) > ttlMs) {
    // 不阻塞当前搜索：异步触发刷新，避免用户感知延迟
    maybeScheduleStaleRefresh();
  }

  const list = Array.isArray(cachedBookmarks) ? cachedBookmarks : [];
  if (list.length > 0) {
    return searchInList(list, query, limit);
  }

  // No cache yet (first run / storage cleared / IDB failure): fall back to the native API.
  try {
    const nodes = await chrome.bookmarks.search(String(query || '').trim());
    const results = (nodes || [])
      .filter((node) => node && node.url)
      .slice(0, limit)
      .map((node) => ({
        id: node.id,
        title: node.title || '',
        url: node.url || '',
        path: '',
        dateAdded: node.dateAdded
      }));

    // Best-effort: warm cache in the background for the next search.
    refreshBookmarks().catch(() => {});

    return results;
  } catch (error) {
    return [];
  }
}

/**
 * Provide a compact map for favicon warmup: rootDomain -> sample page URL.
 * Used by content scripts so they don't have to keep a full bookmark copy in chrome.storage.local.
 */
export async function getWarmupDomainMap({ limit = 400 } = {}) {
  await loadCacheFromStorage();

  const list = Array.isArray(cachedBookmarks) ? cachedBookmarks : [];
  const max = (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) ? Math.floor(limit) : 400;
  const output = Object.create(null);
  let count = 0;
  const nowTs = Date.now();

  // 清理最近 warmup 记录中过期的项目
  const warmupCutoff = nowTs - RECENT_WARMUP_WINDOW_MS;
  for (const [root, ts] of recentWarmupDomains.entries()) {
    if (typeof ts !== 'number' || ts < warmupCutoff) {
      recentWarmupDomains.delete(root);
    }
  }

  // 1) 最近实际打开过的根域名（根据 recordBookmarkOpen 记录），按最近打开时间排序
  if (recentOpenedRootMap.size > 0 && count < max) {
    const openedEntries = Array.from(recentOpenedRootMap.entries())
      .slice()
      .sort((a, b) => {
        const av = a[1] && typeof a[1].lastAt === 'number' ? a[1].lastAt : 0;
        const bv = b[1] && typeof b[1].lastAt === 'number' ? b[1].lastAt : 0;
        return bv - av;
      });
    for (let i = 0; i < openedEntries.length && count < max; i++) {
      const root = openedEntries[i][0];
      const info = openedEntries[i][1] || {};
      if (!root || output[root]) continue;
      if (recentWarmupDomains.has(root)) continue;
      const sampleUrl = typeof info.sampleUrl === 'string' && info.sampleUrl ? info.sampleUrl : ("https://" + root);
      output[root] = sampleUrl;
      recentWarmupDomains.set(root, nowTs);
      count++;
    }
  }

  // 2) 根据 bookmarkHistory 中最近的变更记录统计高频根域名
  if (Array.isArray(bookmarkHistory) && bookmarkHistory.length > 0 && count < max) {
    const freq = Object.create(null);
    const recent = bookmarkHistory.slice(0, MAX_HISTORY_ITEMS);
    for (let i = 0; i < recent.length; i++) {
      const item = recent[i];
      if (!item || typeof item.url !== 'string') continue;
      const rawUrl = String(item.url || '').trim();
      if (!rawUrl) continue;
      try {
        const u = new URL(rawUrl);
        const host = u && u.hostname ? String(u.hostname).toLowerCase() : '';
        if (!host) continue;
        const root = getRootDomain(host);
        if (!root) continue;
        freq[root] = (freq[root] || 0) + 1;
      } catch (e) {}
    }

    const hotRoots = Object.keys(freq)
      .sort((a, b) => freq[b] - freq[a]);

    for (let i = 0; i < hotRoots.length && count < max; i++) {
      const root = hotRoots[i];
      if (!root || output[root]) continue;
      if (recentWarmupDomains.has(root)) continue;
      // 从 bookmarks 中找一条该 root 对应的 URL 作为 sample
      let sampleUrl = '';
      for (let j = 0; j < list.length; j++) {
        const bookmark = list[j];
        if (!bookmark || !bookmark.url) continue;
        const rawUrl = String(bookmark.url || '').trim();
        if (!rawUrl) continue;
        try {
          const u = new URL(rawUrl);
          const host = u && u.hostname ? String(u.hostname).toLowerCase() : '';
          if (!host) continue;
          const r = getRootDomain(host);
          if (r === root) {
            sampleUrl = u.href || ("https://" + root);
            break;
          }
        } catch (e) {}
      }
      if (!sampleUrl) {
        sampleUrl = "https://" + root;
      }
      output[root] = sampleUrl;
      recentWarmupDomains.set(root, nowTs);
      count++;
    }
  }

  // 3) 兜底：按原逻辑从完整书签列表中按顺序填充剩余名额
  for (let i = 0; i < list.length && count < max; i++) {
    const bookmark = list[i];
    if (!bookmark || !bookmark.url) continue;
    const rawUrl = String(bookmark.url || '').trim();
    if (!rawUrl) continue;

    try {
      const u = new URL(rawUrl);
      const host = u && u.hostname ? String(u.hostname).toLowerCase() : '';
      if (!host) continue;
      const root = getRootDomain(host);
      if (!root) continue;
      if (output[root]) continue;
      if (recentWarmupDomains.has(root)) continue;
      output[root] = u.href || ("https://" + root);
      recentWarmupDomains.set(root, nowTs);
      count++;
    } catch (e) {}
  }

  return output;
}

/**
 * 清空历史记录（同时清除内存和存储）
 */
export async function clearHistory() {
  bookmarkHistory = [];
  const ok = await setValue(STORAGE_KEYS.BOOKMARK_HISTORY, []);
  console.log("[Background] 历史记录已清空");
  return { success: ok };
}
