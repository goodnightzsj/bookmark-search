import { getStorage, setStorage, setValue, STORAGE_KEYS } from './storage-service.js';
import { compareBookmarks, flattenBookmarksTree } from './bookmark-logic.js';
import { HISTORY_ACTIONS } from './constants.js';
import { idbGet, idbSet } from './idb-service.js';
import { getRootDomain } from './utils.js';

// 书签数据管理模块

// 常量定义
const MAX_HISTORY_ITEMS = 100;  // 历史记录最大条数
const IDB_CACHE_KEY_BOOKMARKS = 'cachedBookmarks';
const IDB_CACHE_KEY_TIMESTAMP = 'cachedBookmarksTime';  // IDB 缓存时间戳，用于与 storage 比较新鲜度
const PATH_SEPARATOR = ' > ';

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
      // 即使没变化，也更新最后同步时间和书签数量（确保 count 始终与实际一致）
      const ok = await setStorage({
        [STORAGE_KEYS.LAST_SYNC_TIME]: syncTime,
        [STORAGE_KEYS.BOOKMARK_COUNT]: flatBookmarks.length
      });
      if (!ok) {
        console.warn("[Background] 写入同步状态失败");
      }
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
      return { success: false, fallback: true };
    }
    if (type === 'changed' || type === 'moved') {
      const id = String(evt.id || '');
      // 允许本批次新创建的书签被修改/移动
      if (!id || (!bookmarkIndexById.has(id) && !createdIdsInBatch.has(id))) {
        pendingRefresh = true;
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

  let idbBookmarks;
  let idbCacheTime = 0;
  try {
    const [bookmarksResult, timeResult] = await Promise.all([
      idbGet(IDB_CACHE_KEY_BOOKMARKS),
      idbGet(IDB_CACHE_KEY_TIMESTAMP)
    ]);
    idbBookmarks = bookmarksResult;
    idbCacheTime = typeof timeResult === 'number' ? timeResult : 0;
  } catch (error) {
    console.warn("[Background] 从 IndexedDB 读取书签缓存失败:", error);
  }

  const result = await getStorage([STORAGE_KEYS.BOOKMARKS, STORAGE_KEYS.BOOKMARK_HISTORY, STORAGE_KEYS.LAST_SYNC_TIME]);
  const storageBookmarksRaw = result[STORAGE_KEYS.BOOKMARKS];
  const storageBookmarks = Array.isArray(storageBookmarksRaw) ? storageBookmarksRaw : [];
  const storageHistoryRaw = result[STORAGE_KEYS.BOOKMARK_HISTORY];
  const storageHistory = Array.isArray(storageHistoryRaw) ? storageHistoryRaw : [];
  const storageSyncTime = typeof result[STORAGE_KEYS.LAST_SYNC_TIME] === 'number' ? result[STORAGE_KEYS.LAST_SYNC_TIME] : 0;

  // 优先使用更新的数据源：比较 IDB 缓存时间与 storage 同步时间
  // 1. 如果 IDB 有数据且时间戳 >= storage 时间戳，用 IDB
  // 2. 如果 storage 有数据且时间戳 > IDB 时间戳（IDB 写失败的 fallback 场景），用 storage
  // 3. 两者都为空或时间戳相同时，优先 IDB（正常路径）
  const idbHasData = Array.isArray(idbBookmarks) && idbBookmarks.length > 0;
  const storageHasData = storageBookmarks.length > 0;
  const storageFresher = storageHasData && storageSyncTime > idbCacheTime;

  if (storageFresher) {
    cachedBookmarks = storageBookmarks;
    console.log("[Background] 使用 storage 书签缓存（更新）: IDB=%d, storage=%d", idbCacheTime, storageSyncTime);
  } else if (idbHasData) {
    cachedBookmarks = idbBookmarks;
  } else {
    cachedBookmarks = storageBookmarks;
  }

  // Migrate/backfill: if IndexedDB is empty/stale but storage has fresher data, write once.
  if (storageFresher || ((!idbHasData) && storageHasData)) {
    try {
      await Promise.all([
        idbSet(IDB_CACHE_KEY_BOOKMARKS, cachedBookmarks),
        idbSet(IDB_CACHE_KEY_TIMESTAMP, storageSyncTime || Date.now())
      ]);
    } catch (error) {
      console.warn("[Background] 回填 IndexedDB 书签缓存失败:", error);
    }
  }

  bookmarkHistory = storageHistory;
  rebuildBookmarkIndex();
  isCacheLoaded = true;
}

/**
 * 更新历史记录
 * @param {Array} changes - 新变更
 * @param {boolean} [forceReload=false] - 是否强制重新读取 storage（用于 SW 刚重启场景）
 */
async function updateHistory(changes, forceReload = false) {
  // 仅在缓存未加载或强制刷新时读取 storage，避免冗余 I/O
  let existing = bookmarkHistory;
  if (!isCacheLoaded || forceReload) {
    const result = await getStorage(STORAGE_KEYS.BOOKMARK_HISTORY);
    existing = Array.isArray(result[STORAGE_KEYS.BOOKMARK_HISTORY])
      ? result[STORAGE_KEYS.BOOKMARK_HISTORY]
      : [];
  }

  // 仅保留最近的 MAX_HISTORY_ITEMS 条记录
  bookmarkHistory = [...changes, ...existing].slice(0, MAX_HISTORY_ITEMS);
}

/**
 * 保存到存储
 */
async function saveToStorage(syncTime) {
  // 同时写入 IDB 书签和时间戳
  const writeIdb = Promise.all([
    idbSet(IDB_CACHE_KEY_BOOKMARKS, cachedBookmarks),
    idbSet(IDB_CACHE_KEY_TIMESTAMP, syncTime)
  ])
    .then(() => true)
    .catch((error) => {
      console.warn("[Background] 写入 IndexedDB 书签缓存失败:", error);
      return false;
    });

  const okPromise = setStorage({
    [STORAGE_KEYS.BOOKMARK_COUNT]: Array.isArray(cachedBookmarks) ? cachedBookmarks.length : 0,
    [STORAGE_KEYS.BOOKMARK_HISTORY]: bookmarkHistory,
    [STORAGE_KEYS.LAST_SYNC_TIME]: syncTime
  });

  const results = await Promise.all([writeIdb, okPromise]);
  const idbOk = results[0];
  const ok = results[1];

  // Fallback: if IndexedDB write fails, keep a storage copy so the UI/search can still work.
  // 下次加载时会通过时间戳比较发现 storage 更新，自动使用 storage 数据
  if (!idbOk) {
    await setStorage({ [STORAGE_KEYS.BOOKMARKS]: cachedBookmarks });
  }
  if (!ok) {
    console.warn("[Background] 写入缓存书签失败");
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
  // 使用固定大小数组维护 top-K，避免泛查询时对所有匹配项排序
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
      // Prefer title matches over URL matches.
      score += ti >= 0 ? ti : (1000 + ui);
    }

    if (!matched) continue;

    // Top-K 插入：保持 topK 按 score 升序，最多 max 个元素
    if (topK.length < max) {
      // 数组未满，插入排序
      let insertIdx = topK.length;
      while (insertIdx > 0 && topK[insertIdx - 1].score > score) {
        insertIdx--;
      }
      topK.splice(insertIdx, 0, { score, bookmark: b });
    } else if (score < topK[max - 1].score) {
      // 数组已满且当前 score 比最差的好，替换并重新插入
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

  for (let i = 0; i < list.length; i++) {
    if (count >= max) break;
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
      output[root] = u.href || ("https://" + root);
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
