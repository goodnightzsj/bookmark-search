import { refreshBookmarks } from './background-data.js';
import { ALARM_NAMES } from './constants.js';
import { getValue, STORAGE_KEYS } from './storage-service.js';

/**
 * 设置自动同步
 * @param {number} intervalMinutes - 同步间隔（分钟），0表示禁用
 */
export async function setupAutoSync(intervalMinutes) {
  console.log("[Background] 设置自动同步间隔: %d 分钟", intervalMinutes);
  
  // 清除旧的alarm
  await chrome.alarms.clear(ALARM_NAMES.SYNC_BOOKMARKS);
  
  if (intervalMinutes > 0) {
    chrome.alarms.create(ALARM_NAMES.SYNC_BOOKMARKS, {
      periodInMinutes: intervalMinutes
    });
    console.log("[Background] 定时任务已启动");
  } else {
    console.log("[Background] 自动同步已禁用");
  }
}

/**
 * 处理定时任务警报
 */
export async function handleAlarm(alarm) {
  if (alarm.name === ALARM_NAMES.SYNC_BOOKMARKS) {
    console.log("[Background] 定时任务触发: 同步书签");
    await refreshBookmarks();
  }
}

/**
 * 初始化同步设置
 */
export async function initSyncSettings() {
  const interval = await getValue(STORAGE_KEYS.SYNC_INTERVAL);
  await setupAutoSync(interval);
}
