import { formatRelativeTime, formatFutureTime } from './utils.js';
import { ALARM_NAMES, MESSAGE_ACTIONS } from './constants.js';
import { assertSuccessfulMessageResponse } from './message-response.js';
import { getStorageOrThrow, setStorageOrThrow, STORAGE_KEYS } from './storage-service.js';

function notifySettings(message, type = 'success') {
  try {
    if (typeof window !== 'undefined' && typeof window.__bsShowToast === 'function') {
      window.__bsShowToast(message, { type });
    }
  } catch (e) {}
}

/**
 * 加载同步设置
 */
export async function loadSyncSettings() {
  try {
    const result = await getStorageOrThrow([
      STORAGE_KEYS.SYNC_INTERVAL,
      STORAGE_KEYS.LAST_SYNC_TIME,
      STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES
    ]);
    const syncIntervalSelect = document.getElementById('syncInterval');
    const bookmarkCacheTtlSelect = document.getElementById('bookmarkCacheTtl');
    const lastSyncDisplay = document.getElementById('lastSyncDisplay');
    const nextSyncDisplay = document.getElementById('nextSyncDisplay');

    if (!syncIntervalSelect || !lastSyncDisplay || !nextSyncDisplay) {
      console.warn("[Settings] 同步设置所需的 DOM 元素未完全找到");
      return;
    }

    // 设置同步间隔（getStorage 已自动提供默认值）
    const interval = result[STORAGE_KEYS.SYNC_INTERVAL];
    syncIntervalSelect.value = interval;
    console.log("[Settings] 同步间隔:", interval, "分钟");

    // 设置主缓存过期时间
    if (bookmarkCacheTtlSelect) {
      const ttlMinutes = result[STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES] || 30;
      bookmarkCacheTtlSelect.value = ttlMinutes;
      console.log("[Settings] 主缓存 TTL:", ttlMinutes, "分钟");
    }

    // 显示最后同步时间
    if (result[STORAGE_KEYS.LAST_SYNC_TIME]) {
      lastSyncDisplay.textContent = formatRelativeTime(result[STORAGE_KEYS.LAST_SYNC_TIME]);
    } else {
      lastSyncDisplay.textContent = '从未';
    }

    // 计算并显示下次同步时间
    if (interval > 0) {
      if (result[STORAGE_KEYS.LAST_SYNC_TIME]) {
        const nextSyncTime = result[STORAGE_KEYS.LAST_SYNC_TIME] + (interval * 60 * 1000);
        nextSyncDisplay.textContent = formatFutureTime(nextSyncTime);
      } else {
        // 如果没有最后同步时间，获取alarm信息
        const alarms = await chrome.alarms.getAll();
        const syncAlarm = alarms.find(alarm => alarm.name === ALARM_NAMES.SYNC_BOOKMARKS);

        if (syncAlarm && syncAlarm.scheduledTime) {
          nextSyncDisplay.textContent = formatFutureTime(syncAlarm.scheduledTime);
        } else {
          nextSyncDisplay.textContent = '启动后开始';
        }
      }
    } else {
      nextSyncDisplay.textContent = '已禁用';
    }
  } catch (error) {
    console.error("[Settings] 加载同步设置失败:", error);
    const lastSyncDisplay = document.getElementById('lastSyncDisplay');
    const nextSyncDisplay = document.getElementById('nextSyncDisplay');
    if (lastSyncDisplay) lastSyncDisplay.textContent = '错误';
    if (nextSyncDisplay) nextSyncDisplay.textContent = '错误';
  }
}

/**
 * 加载书签统计
 */
export async function loadBookmarkStats() {
  try {
    const result = await getStorageOrThrow([STORAGE_KEYS.BOOKMARK_COUNT]);
    const totalElement = document.getElementById('totalBookmarks');

    const countValue = result[STORAGE_KEYS.BOOKMARK_COUNT];
    const count = (typeof countValue === 'number' && Number.isFinite(countValue)) ? countValue : 0;

    totalElement.textContent = count;
    console.log("[Settings] 书签总数:", count);
  } catch (error) {
    console.error("[Settings] 加载书签统计失败:", error);
    const totalElement = document.getElementById('totalBookmarks');
    if (totalElement) totalElement.textContent = '!';
  }
}

/**
 * 绑定同步相关事件
 */
export function bindSyncEvents() {
  // 同步书签
  document.getElementById('syncBookmarks').addEventListener('click', async () => {
    console.log("[Settings] 同步书签");
    const btn = document.getElementById('syncBookmarks');
    const label = btn.querySelector('.btn-text');
    const originalText = label ? label.textContent : '';

    if (label) label.textContent = '同步中...';
    btn.disabled = true;

    try {
      const result = assertSuccessfulMessageResponse(
        await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.REFRESH_BOOKMARKS }),
        '同步失败',
        { allowSkipped: true }
      );
      // 并行重新加载书签统计和同步设置
      await Promise.all([loadBookmarkStats(), loadSyncSettings()]);

      if (label) label.textContent = result && result.skipped ? '已排队' : '同步成功';
      setTimeout(() => {
        if (label) label.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    } catch (error) {
      console.error("[Settings] 同步书签失败:", error);
      if (label) label.textContent = '同步失败';
      setTimeout(() => {
        if (label) label.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  });

  // 同步间隔变化
  const VALID_SYNC_INTERVALS = [0, 5, 10, 15, 30, 60, 120, 360, 720, 1440];
  document.getElementById('syncInterval').addEventListener('change', async (e) => {
    const interval = parseInt(e.target.value);
    if (!VALID_SYNC_INTERVALS.includes(interval)) return;
    console.log("[Settings] 修改同步间隔为:", interval, "分钟");

    try {
      assertSuccessfulMessageResponse(await chrome.runtime.sendMessage({
        action: MESSAGE_ACTIONS.SET_SYNC_INTERVAL,
        interval: interval
      }), '设置失败');

      // 重新加载同步设置显示
      await loadSyncSettings();

      console.log("[Settings] 同步间隔已更新");
      notifySettings(interval === 0 ? '已禁用自动同步' : `同步间隔已更新为 ${interval} 分钟`);
    } catch (error) {
      console.error("[Settings] 更新同步间隔失败:", error);
      await loadSyncSettings();
      notifySettings('设置失败：' + (error && error.message ? error.message : String(error)), 'error');
    }
  });

  // 主缓存过期时间变化
  const bookmarkCacheTtlSelect = document.getElementById('bookmarkCacheTtl');
  const VALID_CACHE_TTL = [30, 60, 360, 720, 1440];
  if (bookmarkCacheTtlSelect) {
    bookmarkCacheTtlSelect.addEventListener('change', async (e) => {
      const ttlMinutes = parseInt(e.target.value);
      if (!VALID_CACHE_TTL.includes(ttlMinutes)) return;
      console.log("[Settings] 修改主缓存 TTL 为:", ttlMinutes, "分钟");

      try {
        await setStorageOrThrow({ [STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES]: ttlMinutes });
        console.log("[Settings] 主缓存 TTL 已更新");
        notifySettings(`主缓存 TTL 已更新为 ${ttlMinutes} 分钟`);
      } catch (error) {
        console.error("[Settings] 更新主缓存 TTL 失败:", error);
        await loadSyncSettings();
        notifySettings('设置失败：' + (error && error.message ? error.message : String(error)), 'error');
      }
    });
  }

  // 清除 favicon 缓存
  const clearFaviconCacheBtn = document.getElementById('clearFaviconCache');
  if (clearFaviconCacheBtn) {
    clearFaviconCacheBtn.addEventListener('click', async () => {
      const confirmed = await (window.__bsConfirm
        ? window.__bsConfirm('确定要清除扩展内置的 icon / favicon 缓存吗？\n清除后，下次搜索时图标会重新从浏览器缓存或网络抓取，首次可能略慢。', { confirmText: '清除' })
        : Promise.resolve(confirm('确定要清除扩展内置的 icon / favicon 缓存吗？')));
      if (!confirmed) return;
      const btn = clearFaviconCacheBtn;
      const label = btn.querySelector('.btn-text');
      const originalText = label ? label.textContent : '';

      if (label) label.textContent = '清理中...';
      btn.disabled = true;

      try {
        assertSuccessfulMessageResponse(
          await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.CLEAR_FAVICON_CACHE }),
          '清理失败'
        );

        if (label) label.textContent = '清理成功';
        notifySettings('图标缓存已清除');
        setTimeout(() => {
          if (label) label.textContent = originalText;
          btn.disabled = false;
        }, 1500);
      } catch (error) {
        console.error('[Settings] 清除 favicon 缓存失败:', error);
        if (label) label.textContent = '清理失败';
        notifySettings('清除图标缓存失败：' + (error && error.message ? error.message : String(error)), 'error');
        setTimeout(() => {
          if (label) label.textContent = originalText;
          btn.disabled = false;
        }, 1500);
      }
    });
  }
}
