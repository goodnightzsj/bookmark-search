import { applyBookmarkEvents, loadInitialData, refreshBookmarks } from './background-data.js';
import { handleAlarm, initSyncSettings } from './background-sync.js';
import { handleMessage } from './background-messages.js';
import { ALARM_NAMES, MESSAGE_ACTIONS } from './constants.js';
import { SPECIAL_PROTOCOLS } from './utils.js';

console.log("[Background] Service Worker 启动");

let initPromise = null;

// 初始化
async function init() {
  console.log("[Background] 初始化开始");

  // 并行加载数据和初始化同步设置（互不依赖）
  await Promise.all([
    loadInitialData(),
    initSyncSettings()
  ]);

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

let debounceBookmarkEvents = [];
let importInProgress = false;

function scheduleBookmarkDebounce() {
  chrome.alarms.clear(ALARM_NAMES.BOOKMARK_REFRESH_DEBOUNCE)
    .catch(() => {}) // ignore
    .finally(() => {
      chrome.alarms.create(ALARM_NAMES.BOOKMARK_REFRESH_DEBOUNCE, { when: Date.now() + DEBOUNCE_DELAY_MS });
    });
}

function enqueueBookmarkEvent(evt) {
  if (importInProgress) return;
  if (!evt || typeof evt !== 'object') return;
  debounceBookmarkEvents.push(evt);
  scheduleBookmarkDebounce();
}

if (chrome.bookmarks && chrome.bookmarks.onCreated) {
  chrome.bookmarks.onCreated.addListener((id, bookmark) => {
    console.log("[Background] 原生书签创建，等待防抖...");
    enqueueBookmarkEvent({ type: 'created', id, bookmark });
  });
}

if (chrome.bookmarks && chrome.bookmarks.onRemoved) {
  chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
    console.log("[Background] 原生书签删除，等待防抖...");
    enqueueBookmarkEvent({ type: 'removed', id, removeInfo });
  });
}

if (chrome.bookmarks && chrome.bookmarks.onChanged) {
  chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
    console.log("[Background] 原生书签变更，等待防抖...");
    enqueueBookmarkEvent({ type: 'changed', id, changeInfo });
  });
}

if (chrome.bookmarks && chrome.bookmarks.onMoved) {
  chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
    console.log("[Background] 原生书签移动，等待防抖...");
    enqueueBookmarkEvent({ type: 'moved', id, moveInfo });
  });
}

// Reorder within the same folder doesn't affect URL/title/path; ignore to reduce refresh noise.

if (chrome.bookmarks && chrome.bookmarks.onImportBegan) {
  chrome.bookmarks.onImportBegan.addListener(() => {
    console.log("[Background] 书签导入开始，暂停增量并等待结束后全量刷新");
    importInProgress = true;
    debounceBookmarkEvents = [];
    chrome.alarms.clear(ALARM_NAMES.BOOKMARK_REFRESH_DEBOUNCE).catch(() => {});
  });
}

if (chrome.bookmarks && chrome.bookmarks.onImportEnded) {
  chrome.bookmarks.onImportEnded.addListener(() => {
    console.log("[Background] 书签导入结束，触发全量刷新（防抖）");
    importInProgress = false;
    enqueueBookmarkEvent({ type: 'forceRefresh' });
  });
}

// 监听定时任务
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAMES.BOOKMARK_REFRESH_DEBOUNCE) {
    const events = debounceBookmarkEvents;
    debounceBookmarkEvents = [];

    console.log("[Background] 防抖 alarm 触发，开始同步（事件数=%d）", Array.isArray(events) ? events.length : 0);
    await ensureInit();
    if (importInProgress) return;

    // If the service worker restarted after scheduling the alarm, the in-memory event queue may be lost.
    // In that case, fall back to a full refresh to keep data consistent.
    if (!Array.isArray(events) || events.length === 0) {
      await refreshBookmarks();
      return;
    }

    // Prefer incremental updates; will auto-fallback to full refresh when needed.
    await applyBookmarkEvents(events);
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

    // Some pages keep focus inside inputs/iframes; proactively blur active elements in all frames
    // so the overlay input can reliably take focus after it appears.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          try {
            const active = document.activeElement;
            if (active && typeof active.blur === 'function') {
              active.blur();
            }
          } catch (e) {}
        }
      });
    } catch (error) {
      // Ignore: focusing is best-effort and may fail on some pages/frames.
    }

    try {
      await chrome.tabs.sendMessage(tab.id, { action: MESSAGE_ACTIONS.TOGGLE_SEARCH });
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
      await chrome.tabs.sendMessage(tab.id, { action: MESSAGE_ACTIONS.TOGGLE_SEARCH });
    } catch (error) {
      console.error("[Background] 注入/唤起搜索失败:", error);
    }
  }
});

// 启动初始化
ensureInit();
