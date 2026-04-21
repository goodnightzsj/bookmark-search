/**
 * 存储访问层 - 封装 chrome.storage.local 操作
 * 提供类型安全的默认值和统一的错误处理
 */
import { createLogger } from './logger.js';

const log = createLogger('Storage');

// 存储键名常量
export const STORAGE_KEYS = {
  BOOKMARKS: 'bookmarks',
  BOOKMARK_COUNT: 'bookmarkCount',
  BOOKMARK_HISTORY: 'bookmarkHistory',
  LAST_SYNC_TIME: 'lastSyncTime',
  SYNC_INTERVAL: 'syncInterval',
  THEME: 'theme',
  BOOKMARK_CACHE_TTL_MINUTES: 'bookmarkCacheTtlMinutes',
  BOOKMARKS_META: 'bookmarksMeta',
  SCHEMA_VERSION: 'schemaVersion',
  MIGRATION_STATE: 'migrationState',
  LAST_MIGRATION_AT: 'lastMigrationAt',
  LAST_MIGRATION_ERROR: 'lastMigrationError',
  NEEDS_REBUILD: 'needsRebuild'
};

// 默认值
const DEFAULTS = {
  [STORAGE_KEYS.BOOKMARKS]: [],
  [STORAGE_KEYS.BOOKMARK_COUNT]: 0,
  [STORAGE_KEYS.BOOKMARK_HISTORY]: [],
  [STORAGE_KEYS.LAST_SYNC_TIME]: null,
  [STORAGE_KEYS.SYNC_INTERVAL]: 30,
  [STORAGE_KEYS.THEME]: 'original',
  [STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES]: 30,
  [STORAGE_KEYS.BOOKMARKS_META]: { updatedAt: 0, count: 0 },
  [STORAGE_KEYS.SCHEMA_VERSION]: 0,
  [STORAGE_KEYS.MIGRATION_STATE]: 'idle',
  [STORAGE_KEYS.LAST_MIGRATION_AT]: null,
  [STORAGE_KEYS.LAST_MIGRATION_ERROR]: null,
  [STORAGE_KEYS.NEEDS_REBUILD]: false
};

/**
 * 获取存储数据（带默认值）
 * @param {string|string[]} keys - 要获取的键名或键名数组
 * @returns {Promise<Object>} 包含请求数据的对象
 */
export async function getStorage(keys) {
  const keyArray = Array.isArray(keys) ? keys : [keys];

  try {
    const result = await chrome.storage.local.get(keyArray);

    // 为缺失的键填充默认值
    const output = {};
    for (const key of keyArray) {
      output[key] = result[key] !== undefined ? result[key] : DEFAULTS[key];
    }

    return output;
  } catch (error) {
    log.error('读取失败:', error);

    // 返回默认值
    const fallback = {};
    for (const key of keyArray) {
      fallback[key] = DEFAULTS[key];
    }
    return fallback;
  }
}

/**
 * 获取存储数据（区分 missing 与 failed）
 * @param {string|string[]} keys - 要获取的键名或键名数组
 * @returns {Promise<{success:boolean,error?:string,data:Object,state:Object}>}
 */
export async function getStorageWithStatus(keys) {
  const keyArray = Array.isArray(keys) ? keys : [keys];

  try {
    const result = await chrome.storage.local.get(keyArray);
    const data = {};
    const state = {};

    for (const key of keyArray) {
      if (result[key] === undefined) {
        data[key] = DEFAULTS[key];
        state[key] = 'missing';
      } else {
        data[key] = result[key];
        state[key] = 'ok';
      }
    }

    return { success: true, data, state };
  } catch (error) {
    log.error('读取失败:', error);

    const fallback = {};
    const state = {};
    for (const key of keyArray) {
      fallback[key] = DEFAULTS[key];
      state[key] = 'failed';
    }

    const message = error && error.message ? error.message : String(error);
    return { success: false, error: message, data: fallback, state };
  }
}

/**
 * 获取存储数据（读取失败时抛错，缺失键仍回退默认值）
 * @param {string|string[]} keys - 要获取的键名或键名数组
 * @returns {Promise<Object>}
 */
export async function getStorageOrThrow(keys) {
  const keyArray = Array.isArray(keys) ? keys : [keys];
  const read = await getStorageWithStatus(keyArray);
  const state = read && read.state && typeof read.state === 'object' ? read.state : {};
  const hasFailedKey = keyArray.some((key) => state[key] === 'failed');

  if (!read.success && hasFailedKey) {
    throw new Error(read.error || 'chrome.storage.local.get failed');
  }

  return read && read.data && typeof read.data === 'object' ? read.data : {};
}

/**
 * 设置存储数据
 * @param {Object} data - 要存储的键值对
 * @returns {Promise<boolean>} 是否成功
 */
export async function setStorage(data) {
  try {
    await chrome.storage.local.set(data);
    return true;
  } catch (error) {
    log.error('写入失败:', error);
    return false;
  }
}

/**
 * 设置存储数据（强失败语义）
 * @param {Object} data - 要存储的键值对
 * @returns {Promise<void>}
 */
export async function setStorageOrThrow(data) {
  const ok = await setStorage(data);
  if (!ok) {
    throw new Error('chrome.storage.local.set failed');
  }
}

/**
 * 获取单个值（快捷方法）
 * @param {string} key - 键名
 * @returns {Promise<*>} 对应的值
 */
export async function getValue(key) {
  const result = await getStorage(key);
  return result[key];
}

/**
 * 获取单个值（读取失败时抛错）
 * @param {string} key - 键名
 * @returns {Promise<*>}
 */
export async function getValueOrThrow(key) {
  const result = await getStorageOrThrow(key);
  return result[key];
}

/**
 * 设置单个值（快捷方法）
 * @param {string} key - 键名
 * @param {*} value - 值
 * @returns {Promise<boolean>} 是否成功
 */
export async function setValue(key, value) {
  return setStorage({ [key]: value });
}
