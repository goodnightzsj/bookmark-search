import { getStorage, setStorage, setValue, STORAGE_KEYS } from './storage-service.js';
import { compareBookmarks, flattenBookmarksTree } from './bookmark-logic.js';
import { idbGet, idbSet } from './idb-service.js';

// 书签数据管理模块

// 常量定义
const MAX_HISTORY_ITEMS = 100;  // 历史记录最大条数
const IDB_CACHE_KEY_BOOKMARKS = 'cachedBookmarks';

// 本地存储的书签数据
let cachedBookmarks = [];
// 书签变化历史
let bookmarkHistory = [];
// 并发锁：防止重复刷新
let isRefreshing = false;
// 若刷新过程中再次触发，标记为“需要再刷新一次”
let refreshQueued = false;
// 缓存是否已从 storage 加载（避免重复 IO）
let isCacheLoaded = false;

/**
 * 从 Chrome 获取书签树并处理
 */
export async function refreshBookmarks() {
  if (isRefreshing) {
    refreshQueued = true;
    console.log("[Background] 刷新已在进行中，标记为待刷新");
    return { success: false, skipped: true };
  }
  
  isRefreshing = true;
  let lastResult = { success: false };
  try {
    do {
      refreshQueued = false;
      lastResult = await refreshBookmarksOnce();
    } while (refreshQueued);
    return lastResult;
  } finally {
    isRefreshing = false;
  }
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
      
      // 保存到本地存储
      await saveToStorage(syncTime);
    } else {
      console.log("[Background] 书签无变化");
      // 即使没变化，也更新最后同步时间（因为这是一次成功的检查）
      const ok = await setValue(STORAGE_KEYS.LAST_SYNC_TIME, syncTime);
      if (!ok) {
        console.warn("[Background] 写入最后同步时间失败");
      }
    }
    
    return { success: true, count: flatBookmarks.length, changes: changes.length };
  } catch (error) {
    console.error("[Background] 刷新书签失败:", error);
    return { success: false, error: error.message };
  }
}

async function loadCacheFromStorage() {
  if (isCacheLoaded) return;

  let idbBookmarks;
  try {
    idbBookmarks = await idbGet(IDB_CACHE_KEY_BOOKMARKS);
  } catch (error) {
    console.warn("[Background] 从 IndexedDB 读取书签缓存失败:", error);
  }

  const result = await getStorage([STORAGE_KEYS.BOOKMARKS, STORAGE_KEYS.BOOKMARK_HISTORY]);
  const storageBookmarks = result[STORAGE_KEYS.BOOKMARKS];

  if (Array.isArray(idbBookmarks) && (idbBookmarks.length > 0 || storageBookmarks.length === 0)) {
    cachedBookmarks = idbBookmarks;
  } else {
    cachedBookmarks = storageBookmarks;
  }

  // Migrate/backfill: if IndexedDB is empty but storage has data, write once.
  if ((!Array.isArray(idbBookmarks) || idbBookmarks.length === 0) && Array.isArray(storageBookmarks) && storageBookmarks.length > 0) {
    try {
      await idbSet(IDB_CACHE_KEY_BOOKMARKS, storageBookmarks);
    } catch (error) {
      console.warn("[Background] 回填 IndexedDB 书签缓存失败:", error);
    }
  }

  bookmarkHistory = result[STORAGE_KEYS.BOOKMARK_HISTORY];
  isCacheLoaded = true;
}

/**
 * 更新历史记录
 */
async function updateHistory(changes) {
  // 以 storage 为准，避免在 service worker 未重启时把“已清空的历史”重新写回
  const result = await getStorage(STORAGE_KEYS.BOOKMARK_HISTORY);
  const existing = Array.isArray(result[STORAGE_KEYS.BOOKMARK_HISTORY])
    ? result[STORAGE_KEYS.BOOKMARK_HISTORY]
    : [];

  // 仅保留最近的 MAX_HISTORY_ITEMS 条记录
  bookmarkHistory = [...changes, ...existing].slice(0, MAX_HISTORY_ITEMS);
  const ok = await setValue(STORAGE_KEYS.BOOKMARK_HISTORY, bookmarkHistory);
  if (!ok) {
    console.warn("[Background] 写入历史记录失败");
  }
}

/**
 * 保存到存储
 */
async function saveToStorage(syncTime) {
  try {
    await idbSet(IDB_CACHE_KEY_BOOKMARKS, cachedBookmarks);
  } catch (error) {
    console.warn("[Background] 写入 IndexedDB 书签缓存失败:", error);
  }

  const ok = await setStorage({
    [STORAGE_KEYS.BOOKMARKS]: cachedBookmarks,
    [STORAGE_KEYS.LAST_SYNC_TIME]: syncTime
  });
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
