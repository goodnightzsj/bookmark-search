/**
 * 存储访问层 - 封装 chrome.storage.local 操作
 * 提供类型安全的默认值和统一的错误处理
 */

// 存储键名常量
export const STORAGE_KEYS = {
  BOOKMARKS: 'bookmarks',
  BOOKMARK_HISTORY: 'bookmarkHistory',
  LAST_SYNC_TIME: 'lastSyncTime',
  SYNC_INTERVAL: 'syncInterval',
  THEME: 'theme'
};

// 默认值
const DEFAULTS = {
  [STORAGE_KEYS.BOOKMARKS]: [],
  [STORAGE_KEYS.BOOKMARK_HISTORY]: [],
  [STORAGE_KEYS.LAST_SYNC_TIME]: null,
  [STORAGE_KEYS.SYNC_INTERVAL]: 30,
  [STORAGE_KEYS.THEME]: 'original'
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
    console.error('[Storage] 读取失败:', error);
    
    // 返回默认值
    const fallback = {};
    for (const key of keyArray) {
      fallback[key] = DEFAULTS[key];
    }
    return fallback;
  }
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
    console.error('[Storage] 写入失败:', error);
    return false;
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
 * 设置单个值（快捷方法）
 * @param {string} key - 键名
 * @param {*} value - 值
 * @returns {Promise<boolean>} 是否成功
 */
export async function setValue(key, value) {
  return setStorage({ [key]: value });
}
