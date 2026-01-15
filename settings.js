import { initThemeSelector } from './settings-theme.js';
import { loadShortcutInfo, bindShortcutEvents } from './settings-shortcuts.js';
import { loadSyncSettings, loadBookmarkStats, bindSyncEvents } from './settings-sync.js';
import { loadUpdateHistory, bindHistoryEvents, showUpdateNotification } from './settings-history.js';

console.log("[Settings] settings.js 开始加载 (主入口)");

// 初始化
async function init() {
  console.log("[Settings] 初始化开始");

  try {
    // 初始化各模块
    await initThemeSelector();
    await loadShortcutInfo();
    await loadBookmarkStats();
    await loadSyncSettings();
    await loadUpdateHistory();

    // 绑定事件
    bindAllEvents();

    // 监听存储变化，实现实时更新
    setupStorageListener();

    console.log("[Settings] 初始化完成");
  } catch (error) {
    console.error("[Settings] 初始化失败:", error);
  }
}

// 绑定所有事件
function bindAllEvents() {
  bindShortcutEvents();
  bindSyncEvents();
  bindHistoryEvents();
}

// 设置存储监听器，实现实时更新
function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    console.log("[Settings] 存储发生变化:", Object.keys(changes));

    // 书签数据变化时，更新统计
    if (changes.bookmarks) {
      console.log("[Settings] 检测到书签数据变化，重新加载统计");
      loadBookmarkStats();
    }

    // 同步时间变化时，更新显示
    if (changes.lastSyncTime || changes.syncInterval) {
      console.log("[Settings] 检测到同步设置变化，重新加载同步信息");
      loadSyncSettings();
    }

    // 书签历史变化时，更新历史列表
    if (changes.bookmarkHistory) {
      console.log("[Settings] 检测到书签历史变化，重新加载历史");
      loadUpdateHistory();
      
      // 显示更新提示
      showUpdateNotification();
    }
  });

  console.log("[Settings] 存储监听器已设置");
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
