import { loadInitialData, refreshBookmarks } from './background-data.js';
import { handleAlarm, initSyncSettings } from './background-sync.js';
import { handleMessage } from './background-messages.js';
import { ALARM_NAMES } from './constants.js';
import { SPECIAL_PROTOCOLS } from './utils.js';

console.log("[Background] Service Worker 启动");

let initPromise = null;

// 初始化
async function init() {
  console.log("[Background] 初始化开始");

  // 加载数据
  await loadInitialData();
  
  // 初始化同步设置
  await initSyncSettings();
  
  console.log("[Background] 初始化完成");
}

function ensureInit() {
  if (initPromise) return initPromise;
  initPromise = init().catch((error) => {
    console.error("[Background] 初始化失败:", error);
    initPromise = null;
  });
  return initPromise;
}

// 监听安装事件
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Background] 扩展已安装/更新:", details.reason);
  await ensureInit();
});

// 监听浏览器启动事件（确保 alarm 等被正确设置）
chrome.runtime.onStartup.addListener(async () => {
  await ensureInit();
});

// 监听书签变化事件（浏览器原生书签变化时自动触发同步）
// 使用防抖避免批量导入时频繁刷新
const DEBOUNCE_DELAY_MS = 500;

const bookmarkEvents = [
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onRemoved,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onChildrenReordered,
  chrome.bookmarks.onImportBegan,
  chrome.bookmarks.onImportEnded
];

bookmarkEvents.forEach(event => {
  if (event && event.addListener) {
    event.addListener(() => {
      console.log("[Background] 检测到原生书签变化，等待防抖...");
      chrome.alarms.clear(ALARM_NAMES.BOOKMARK_REFRESH_DEBOUNCE)
        .catch(() => {}) // ignore
        .finally(() => {
          chrome.alarms.create(ALARM_NAMES.BOOKMARK_REFRESH_DEBOUNCE, { when: Date.now() + DEBOUNCE_DELAY_MS });
        });
    });
  }
});

// 监听定时任务
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAMES.BOOKMARK_REFRESH_DEBOUNCE) {
    console.log("[Background] 防抖 alarm 触发，开始同步");
    await refreshBookmarks();
  }
});

// 监听消息
chrome.runtime.onMessage.addListener(handleMessage);

// 监听快捷键
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-overlay') {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (error) {
      console.error("[Background] 获取当前标签页失败:", error);
      return;
    }

    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;
    if (tab.url && SPECIAL_PROTOCOLS.some(protocol => tab.url.startsWith(protocol))) {
      return;
    }

    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'toggleSearch' });
      return;
    } catch (error) {
      // Likely: "Receiving end does not exist" (content script not injected yet)
    }

    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content.css']
      });
    } catch (error) {
      // CSS may fail on some pages; still try to inject the script.
      console.warn("[Background] 注入 CSS 失败:", error);
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      await chrome.tabs.sendMessage(tab.id, { action: 'toggleSearch' });
    } catch (error) {
      console.error("[Background] 注入/唤起搜索失败:", error);
    }
  }
});

// 启动初始化
ensureInit();
