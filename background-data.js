import { getStorageWithStatus, setStorage, setValue, STORAGE_KEYS } from './storage-service.js';
import { compareBookmarks, flattenBookmarksTree } from './bookmark-logic.js';
import { HISTORY_ACTIONS, PATH_SEPARATOR } from './constants.js';
import { idbGet, idbGetAllDocuments, idbReplaceDocuments, idbSet } from './idb-service.js';
import { getRootDomain } from './utils.js';

// 书签数据管理模块

// 常量定义
const MAX_HISTORY_ITEMS = 100;  // 历史记录最大条数
const IDB_KEY_RECENT_OPENED_ROOTS = 'recentOpenedRoots:v1';  // 最近打开过的根域名快照（用于 warmup 优先级，防 SW 重启丢失）
const DOCUMENT_SOURCE_TYPE = 'bookmark';
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

function buildCacheMetaFromCount(count, updatedAt) {
  const safeCount = (typeof count === 'number' && Number.isFinite(count) && count >= 0) ? Math.floor(count) : 0;
  const safeUpdatedAt = (typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0) ? updatedAt : Date.now();
  return { updatedAt: safeUpdatedAt, count: safeCount };
}

const runtimeState = {
  // 运行时主数据：SearchDocument 数组
  documents: [],
  // 兼容视图：从 documents 派生的 bookmark 数组（供现有 compare/search/warmup 逻辑复用）
  bookmarks: [],
  // 快速索引：bookmarkId -> bookmarks index
  bookmarkIndexById: new Map()
};

// 书签变化历史
let bookmarkHistory = [];
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
  const list = Array.isArray(runtimeState.bookmarks) ? runtimeState.bookmarks : [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || !b.id) continue;
    next.set(String(b.id), i);
  }
  runtimeState.bookmarkIndexById = next;
}

function mapBookmarkToSearchDocument(bookmark) {
  if (!bookmark || typeof bookmark !== 'object' || !bookmark.id || !bookmark.url) return null;
  const title = typeof bookmark.title === 'string' ? bookmark.title : '';
  const url = typeof bookmark.url === 'string' ? bookmark.url : '';
  const path = typeof bookmark.path === 'string' && bookmark.path
    ? String(bookmark.path).split(PATH_SEPARATOR).map((item) => item.trim()).filter(Boolean)
    : [];

  return {
    id: `${DOCUMENT_SOURCE_TYPE}:${String(bookmark.id)}`,
    sourceType: DOCUMENT_SOURCE_TYPE,
    sourceId: String(bookmark.id),
    title,
    subtitle: path.join(PATH_SEPARATOR),
    url,
    path,
    keywords: path.slice(),
    tags: [],
    iconKey: url,
    updatedAt: (typeof bookmark.dateAdded === 'number' && Number.isFinite(bookmark.dateAdded)) ? bookmark.dateAdded : 0,
    metadata: {
      dateAdded: (typeof bookmark.dateAdded === 'number' && Number.isFinite(bookmark.dateAdded)) ? bookmark.dateAdded : 0
    }
  };
}

function mapSearchDocumentToBookmark(doc) {
  if (!doc || typeof doc !== 'object' || doc.sourceType !== DOCUMENT_SOURCE_TYPE || !doc.sourceId || !doc.url) return null;
  return {
    id: doc.sourceId,
    title: typeof doc.title === 'string' ? doc.title : '',
    url: typeof doc.url === 'string' ? doc.url : '',
    path: Array.isArray(doc.path) ? doc.path.join(PATH_SEPARATOR) : '',
    dateAdded: doc.metadata && typeof doc.metadata.dateAdded === 'number' ? doc.metadata.dateAdded : 0
  };
}

function mapSearchDocumentsToBookmarks(documents) {
  const list = Array.isArray(documents) ? documents : [];
  const bookmarks = [];
  for (let i = 0; i < list.length; i++) {
    const bookmark = mapSearchDocumentToBookmark(list[i]);
    if (bookmark) bookmarks.push(bookmark);
  }
  return bookmarks;
}

function searchDocuments(documents, query, limit) {
  const list = Array.isArray(documents) ? documents : [];
  const raw = typeof query === 'string' ? query.trim() : '';
  if (!raw) return [];

  const queryLower = raw.toLowerCase();
  const tokens = queryLower.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const max = typeof limit === 'number' && limit > 0 ? limit : 10;
  const topK = [];

  for (let i = 0; i < list.length; i++) {
    const doc = list[i];
    if (!doc || !doc.url) continue;

    const titleLower = String(doc.title || '').toLowerCase();
    const urlLower = String(doc.url || '').toLowerCase();
    const pathLower = String(doc.subtitle || '').toLowerCase();

    let score = 0;
    let matched = true;

    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t];
      const ti = titleLower.indexOf(token);
      const pi = pathLower.indexOf(token);
      const ui = urlLower.indexOf(token);
      if (ti < 0 && pi < 0 && ui < 0) {
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
      } else if (pi >= 0) {
        // path 命中：优先级介于 title 和 url 之间
        let tokenScore = 500 + pi;
        if (pi === 0) tokenScore -= 30;
        score += tokenScore;
      } else {
        score += 1000 + ui;
      }
    }

    if (!matched) continue;
    if (tokens.length === 1 && titleLower === queryLower) score -= 200;

    if (topK.length < max) {
      let insertIdx = topK.length;
      while (insertIdx > 0 && topK[insertIdx - 1].score > score) {
        insertIdx--;
      }
      topK.splice(insertIdx, 0, { score, doc });
    } else if (score < topK[max - 1].score) {
      topK.pop();
      let insertIdx = topK.length;
      while (insertIdx > 0 && topK[insertIdx - 1].score > score) {
        insertIdx--;
      }
      topK.splice(insertIdx, 0, { score, doc });
    }
  }

  const results = [];
  for (let i = 0; i < topK.length; i++) {
    const bookmark = mapSearchDocumentToBookmark(topK[i].doc);
    if (bookmark) results.push(bookmark);
  }
  return results;
}

function setRuntimeDocuments(nextDocuments) {
  runtimeState.documents = Array.isArray(nextDocuments) ? nextDocuments.filter((doc) => doc && doc.sourceType === DOCUMENT_SOURCE_TYPE && doc.sourceId && doc.url) : [];
  runtimeState.bookmarks = mapSearchDocumentsToBookmarks(runtimeState.documents);
}

function setRuntimeBookmarks(nextBookmarks) {
  const list = Array.isArray(nextBookmarks) ? nextBookmarks : [];
  const nextDocuments = [];
  for (let i = 0; i < list.length; i++) {
    const doc = mapBookmarkToSearchDocument(list[i]);
    if (doc) nextDocuments.push(doc);
  }
  setRuntimeDocuments(nextDocuments);
}

async function readPersistedDocuments() {
  const documents = await idbGetAllDocuments();
  return Array.isArray(documents) ? documents.filter((doc) => doc && doc.sourceType === DOCUMENT_SOURCE_TYPE && doc.sourceId && doc.url) : [];
}

function getRuntimeDocuments() {
  return Array.isArray(runtimeState.documents) ? runtimeState.documents : [];
}

function getDocumentsFingerprint(documents) {
  const list = Array.isArray(documents) ? documents : [];
  if (list.length === 0) return '0|';

  const summary = [];
  for (let i = 0; i < list.length; i++) {
    const doc = list[i] || {};
    summary.push(`${doc.id || ''}:${doc.updatedAt || 0}:${doc.url || ''}`);
  }
  summary.sort();

  // 用简单数值哈希遍历全部条目，避免采样截断漏检
  let h = 0x811c9dc5; // FNV-1a offset basis (32-bit)
  for (let i = 0; i < summary.length; i++) {
    const s = summary[i];
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 0x01000193); // FNV prime
    }
    h ^= 0x1f; // separator
    h = Math.imul(h, 0x01000193);
  }
  return `${summary.length}|${(h >>> 0).toString(36)}`;
}

function getRuntimeBookmarks() {
  return Array.isArray(runtimeState.bookmarks) ? runtimeState.bookmarks : [];
}

function getRuntimeState() {
  return runtimeState;
}

async function ensureRuntimeDocumentsAvailable() {
  const runtimeDocuments = getRuntimeDocuments();
  if (runtimeDocuments.length > 0) return runtimeDocuments;
  try {
    const documents = await readPersistedDocuments();
    if (documents.length > 0) {
      setRuntimeDocuments(documents);
      return getRuntimeDocuments();
    }
  } catch (error) {
    console.warn('[Background][Observe] documents_runtime_read_failed', { message: error && error.message ? error.message : String(error) });
  }
  return runtimeDocuments;
}

async function persistSearchDocuments() {
  await idbReplaceDocuments(getRuntimeDocuments());
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

function getWarmupDomainKeyFromUrl(url) {
  const safeUrl = typeof url === 'string' ? url.trim() : '';
  if (!safeUrl) return '';
  try {
    const parsed = new URL(safeUrl);
    const host = parsed && parsed.host ? String(parsed.host).toLowerCase() : '';
    const hostname = parsed && parsed.hostname ? String(parsed.hostname).toLowerCase() : '';
    if (!host) return '';
    if (hostname === 'localhost') return host;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return host;
    if (hostname.endsWith('.local') || hostname.endsWith('.lan') || hostname.endsWith('.internal') || hostname.endsWith('.intranet') || hostname.endsWith('.corp') || hostname.endsWith('.home') || hostname.endsWith('.localdomain') || hostname.indexOf('.') === -1) {
      return host;
    }
    return getRootDomain(hostname) || host;
  } catch (error) {
    return '';
  }
}

export async function recordBookmarkOpen(url) {
  const safeUrl = typeof url === 'string' ? url.trim() : '';
  if (!safeUrl) return;
  let href = '';
  try {
    const u = new URL(safeUrl);
    href = u && u.href ? u.href : safeUrl;
  } catch (e) {
    return;
  }
  const root = getWarmupDomainKeyFromUrl(safeUrl);
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
    const currentBookmarks = mapSearchDocumentsToBookmarks(getRuntimeDocuments());
    const changes = compareBookmarks(currentBookmarks, flatBookmarks);
    
    if (changes.length > 0) {
      console.log("[Background] 检测到 %d 个书签变化", changes.length);
      // 更新历史记录
      await updateHistory(changes);

      // 更新运行时主数据（documents）与兼容 bookmark 视图
      setRuntimeBookmarks(flatBookmarks);
      rebuildBookmarkIndex();

      // 保存到本地存储
      const saveResult = await saveToStorage(syncTime);
      if (!saveResult || !saveResult.success) {
        return {
          success: false,
          error: '持久化书签缓存失败',
          degraded: true,
          source: saveResult && saveResult.source ? saveResult.source : 'unknown'
        };
      }
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

  const state = getRuntimeState();
  const bookmarks = state.bookmarks;
  const documents = state.documents;
  const indexById = state.bookmarkIndexById;
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
      if (!id || (!indexById.has(id) && !createdIdsInBatch.has(id))) {
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
  const removedDocIds = new Set();
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

      if (indexById.has(id)) continue;

      const item = {
        id,
        title,
        url,
        path,
        dateAdded: node.dateAdded
      };
      bookmarks.push(item);
      indexById.set(id, bookmarks.length - 1);
      documents.push(mapBookmarkToSearchDocument(item));
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
      const idx = indexById.get(id);
      if (idx === undefined) continue;

      const item = bookmarks[idx];
      if (!item) continue;

      const changeInfo = evt.changeInfo && typeof evt.changeInfo === 'object' ? evt.changeInfo : {};
      const nextTitle = changeInfo.title !== undefined ? (changeInfo.title || '') : (item.title || '');
      const nextUrl = changeInfo.url !== undefined ? (changeInfo.url || '') : (item.url || '');

      if (nextTitle === item.title && nextUrl === item.url) continue;

      const oldTitle = item.title || '';
      const oldUrl = item.url || '';
      item.title = nextTitle;
      item.url = nextUrl;
      const docId = `${DOCUMENT_SOURCE_TYPE}:${id}`;
      const docIdx = documents.findIndex((doc) => doc && doc.id === docId);
      if (docIdx >= 0) {
        const path = Array.isArray(documents[docIdx].path) ? documents[docIdx].path : [];
        documents[docIdx] = {
          ...documents[docIdx],
          title: nextTitle,
          subtitle: path.join(PATH_SEPARATOR),
          url: nextUrl,
          iconKey: nextUrl
        };
      }
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
      const idx = indexById.get(id);
      if (idx === undefined) continue;

      const item = bookmarks[idx];
      if (!item) continue;

      const moveInfo = evt.moveInfo && typeof evt.moveInfo === 'object' ? evt.moveInfo : {};
      const nextPath = await getFolderPath(moveInfo.parentId, folderPathCache);
      const oldPath = item.path || '';

      if (nextPath === oldPath) continue;

      item.path = nextPath;
      const docId = `${DOCUMENT_SOURCE_TYPE}:${id}`;
      const docIdx = documents.findIndex((doc) => doc && doc.id === docId);
      if (docIdx >= 0) {
        const nextPathParts = typeof nextPath === 'string' && nextPath
          ? nextPath.split(PATH_SEPARATOR).map((part) => part.trim()).filter(Boolean)
          : [];
        documents[docIdx] = {
          ...documents[docIdx],
          path: nextPathParts,
          subtitle: nextPathParts.join(PATH_SEPARATOR),
          keywords: nextPathParts.slice()
        };
      }
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
        const idx = indexById.get(removedId);
        if (idx === undefined) continue;

        const item = bookmarks[idx];
        if (!item) continue;

        // 标记为 null，不在循环中 splice documents（避免索引漂移）
        bookmarks[idx] = null;
        indexById.delete(removedId);
        removedDocIds.add(`${DOCUMENT_SOURCE_TYPE}:${removedId}`);
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

  // 统一从 documents 重建运行时状态，确保 documents/bookmarks/index 三者一致
  let finalDocuments = documents;
  if (removedDocIds.size > 0) {
    finalDocuments = documents.filter((doc) => doc && !removedDocIds.has(doc.id));
  }
  setRuntimeDocuments(finalDocuments);
  rebuildBookmarkIndex();

  const finalCount = getRuntimeDocuments().length;

  await updateHistory(changes);
  const saveResult = await saveToStorage(Date.now());
  if (!saveResult || !saveResult.success) {
    return {
      success: false,
      error: '持久化书签缓存失败',
      degraded: true,
      source: saveResult && saveResult.source ? saveResult.source : 'unknown'
    };
  }

  return { success: true, count: finalCount, changes: changes.length, incremental: true };
}

async function loadCacheFromStorage() {
  if (isCacheLoaded) return;
  if (loadCachePromise) return loadCachePromise;
  loadCachePromise = loadCacheFromStorageOnce();
  try { await loadCachePromise; } finally { loadCachePromise = null; }
}

async function loadCacheFromStorageOnce() {
  let idbRecentOpenedRoots;
  try {
    idbRecentOpenedRoots = await idbGet(IDB_KEY_RECENT_OPENED_ROOTS);
  } catch (error) {
    console.warn("[Background] 从 IndexedDB 读取最近打开域名快照失败:", error);
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

  let documents = [];
  try {
    documents = await readPersistedDocuments();
  } catch (error) {
    console.warn('[Background][Observe] documents_load_failed', { message: error && error.message ? error.message : String(error) });
  }

  if (documents.length > 0) {
    setRuntimeDocuments(documents);
    console.log('[Background][Observe] cache_source_selected', { source: 'documents', count: documents.length });
  } else {
    setRuntimeDocuments([]);
    console.log('[Background][Observe] cache_source_selected', { source: 'empty', count: 0 });
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
  const documents = getRuntimeDocuments();
  const meta = buildCacheMetaFromCount(documents.length, syncTime);

  // Phase 2: documents are the primary persistent source; legacy bookmark kv is no longer backfilled.
  let needBackfillDocuments = false;
  try {
    const persistedDocuments = await readPersistedDocuments();
    needBackfillDocuments = persistedDocuments.length !== documents.length
      || getDocumentsFingerprint(persistedDocuments) !== getDocumentsFingerprint(documents);
  } catch (error) {
    needBackfillDocuments = true;
  }

  // Check storage meta consistency — also backfill when storage read itself failed
  let needUpdateStorageMeta = false;
  const storageRead = await getStorageWithStatus([STORAGE_KEYS.BOOKMARKS_META]);
  if (storageRead.success && storageRead.data) {
    const storageMeta = normalizeCacheMeta(storageRead.data[STORAGE_KEYS.BOOKMARKS_META]);
    needUpdateStorageMeta = storageMeta.updatedAt < meta.updatedAt || storageMeta.count !== meta.count;
  } else {
    // Storage read failed or returned no data — attempt to repair metadata
    needUpdateStorageMeta = true;
  }

  if (!needBackfillDocuments && !needUpdateStorageMeta) {
    return;
  }

  console.log('[Background][Observe] consistency_check_backfill', { needBackfillDocuments, needUpdateStorageMeta, updatedAt: meta.updatedAt, count: meta.count });

  const tasks = [];
  if (needBackfillDocuments) {
    tasks.push(
      idbReplaceDocuments(documents).catch((error) => {
        console.warn('[Background][Observe] consistency_backfill_failed', { target: 'documents', message: error && error.message ? error.message : String(error) });
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
 * IDB: `documents` is now the primary bookmark persistence.
 * chrome.storage.local: metadata only (count/history/syncTime/meta).
 * Legacy `cachedBookmarks` kv is no longer written in Phase 2.
 */
async function writeDocumentsWithRetry() {
  try {
    await persistSearchDocuments();
    return true;
  } catch (error) {
    console.warn("[Background] 写入 IndexedDB documents 失败，2s 后重试:", error);
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      persistSearchDocuments()
        .then(() => { resolve(true); })
        .catch((retryErr) => {
          console.warn("[Background] IndexedDB documents 重试仍失败:", retryErr);
          resolve(false);
        });
    }, 2000);
  });
}

async function saveToStorage(syncTime) {
  const documents = getRuntimeDocuments();
  const meta = buildCacheMetaFromCount(documents.length, syncTime);

  const idbOk = await writeDocumentsWithRetry();
  if (!idbOk) {
    console.warn('[Background][Observe] cache_write_degraded', { source: 'documents_failed', updatedAt: meta.updatedAt, count: meta.count });
    return { success: false, degraded: true, source: 'documents_failed' };
  }

  const storageOk = await setStorage({
    [STORAGE_KEYS.BOOKMARK_COUNT]: meta.count,
    [STORAGE_KEYS.BOOKMARK_HISTORY]: bookmarkHistory,
    [STORAGE_KEYS.LAST_SYNC_TIME]: meta.updatedAt,
    [STORAGE_KEYS.BOOKMARKS_META]: meta
  });

  if (!storageOk) {
    console.warn('[Background][Observe] cache_write_degraded', { source: 'storage_meta_failed', updatedAt: meta.updatedAt, count: meta.count });
    return { success: false, degraded: true, source: 'storage_meta_failed' };
  }

  return { success: true };
}

/**
 * 加载初始数据
 */
export async function loadInitialData() {
  await loadCacheFromStorage();

  const runtimeDocuments = getRuntimeDocuments();
  if (runtimeDocuments.length > 0) {
    console.log("[Background] 已加载缓存书签: %d 条", runtimeDocuments.length);
  } else {
    // 如果没有缓存，立即刷新一次
    await refreshBookmarks();
  }
  
  console.log("[Background] 已加载历史记录: %d 条", bookmarkHistory.length);
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

  const documents = getRuntimeDocuments();
  if (documents.length > 0) {
    return searchDocuments(documents, query, limit);
  }

  await ensureRuntimeDocumentsAvailable();
  const hydratedDocuments = getRuntimeDocuments();
  if (hydratedDocuments.length > 0) {
    return searchDocuments(hydratedDocuments, query, limit);
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

  const documents = await ensureRuntimeDocumentsAvailable();
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
      // 从 documents 中找一条该 root 对应的 URL 作为 sample
      let sampleUrl = '';
      for (let j = 0; j < documents.length; j++) {
        const doc = documents[j];
        if (!doc || !doc.url) continue;
        const rawUrl = String(doc.url || '').trim();
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
  for (let i = 0; i < documents.length && count < max; i++) {
    const doc = documents[i];
    if (!doc || !doc.url) continue;
    const rawUrl = String(doc.url || '').trim();
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
