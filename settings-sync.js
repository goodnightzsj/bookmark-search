import { formatRelativeTime, formatFutureTime } from './utils.js';
import { ALARM_NAMES } from './constants.js';
import { getStorage, setValue, STORAGE_KEYS } from './storage-service.js';

/**
 * 加载同步设置
 */
export async function loadSyncSettings() {
  try {
    const result = await getStorage([STORAGE_KEYS.SYNC_INTERVAL, STORAGE_KEYS.LAST_SYNC_TIME]);
    const syncIntervalSelect = document.getElementById('syncInterval');
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
  }
}

/**
 * 加载书签统计
 */
export async function loadBookmarkStats() {
  try {
    const result = await getStorage(STORAGE_KEYS.BOOKMARKS);
    const totalElement = document.getElementById('totalBookmarks');

    const bookmarks = result[STORAGE_KEYS.BOOKMARKS];
    if (bookmarks && Array.isArray(bookmarks)) {
      const count = bookmarks.length;
      totalElement.textContent = count;
      console.log("[Settings] 书签总数:", count);
    } else {
      totalElement.textContent = '0';
      console.warn("[Settings] 未找到书签数据");
    }
  } catch (error) {
    console.error("[Settings] 加载书签统计失败:", error);
    document.getElementById('totalBookmarks').textContent = '!';
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
      const result = await chrome.runtime.sendMessage({ action: 'refreshBookmarks' });
      if (result && result.success === false && !result.skipped) {
        throw new Error(result.error || '同步失败');
      }
      await loadBookmarkStats();
      await loadSyncSettings();

      if (label) label.textContent = '同步成功';
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
  document.getElementById('syncInterval').addEventListener('change', async (e) => {
    const interval = parseInt(e.target.value);
    console.log("[Settings] 修改同步间隔为:", interval, "分钟");

    try {
      // 保存到storage
      await setValue(STORAGE_KEYS.SYNC_INTERVAL, interval);
      
      // 通知background更新定时器
      await chrome.runtime.sendMessage({ 
        action: 'updateSyncInterval', 
        interval: interval 
      });
      
      // 重新加载同步设置显示
      await loadSyncSettings();
      
      console.log("[Settings] 同步间隔已更新");
    } catch (error) {
      console.error("[Settings] 更新同步间隔失败:", error);
      alert('设置失败：' + error.message);
    }
  });
}
