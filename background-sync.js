import { refreshBookmarks } from './background-data.js';
import { ALARM_NAMES } from './constants.js';
import { getStorageWithStatus, STORAGE_KEYS } from './storage-service.js';
import { createLogger } from './logger.js';

const log = createLogger('Sync');

/**
 * 设置自动同步
 * @param {number} intervalMinutes - 同步间隔（分钟），0表示禁用
 */
export async function setupAutoSync(intervalMinutes) {
  log.info("设置自动同步间隔: %d 分钟", intervalMinutes);
  
  // 清除旧的alarm
  await chrome.alarms.clear(ALARM_NAMES.SYNC_BOOKMARKS);
  
  if (intervalMinutes > 0) {
    chrome.alarms.create(ALARM_NAMES.SYNC_BOOKMARKS, {
      periodInMinutes: intervalMinutes
    });
    log.info("定时任务已启动");
  } else {
    log.info("自动同步已禁用");
  }
}

/**
 * 处理定时任务警报（仅同步 alarm）
 */
export async function handleSyncAlarm(alarm) {
  if (alarm && alarm.name === ALARM_NAMES.SYNC_BOOKMARKS) {
    log.info("定时任务触发: 同步书签");
    await refreshBookmarks();
  }
}

/**
 * 初始化同步设置
 */
export async function initSyncSettings() {
  const read = await getStorageWithStatus(STORAGE_KEYS.SYNC_INTERVAL);
  if (!read.success && read.state && read.state[STORAGE_KEYS.SYNC_INTERVAL] === 'failed') {
    log.warn('sync_interval_read_failed_use_default', { error: read.error || 'unknown' });
  }

  const intervalRaw = read.data ? read.data[STORAGE_KEYS.SYNC_INTERVAL] : null;
  const interval = (typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) && intervalRaw >= 0) ? intervalRaw : 30;
  await setupAutoSync(interval);
}
