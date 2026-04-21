import { applyBookmarkEvents, updateRuntimeCacheTtlMinutes } from './background-data.js';
import { handleSyncAlarm } from './background-sync.js';
import { handleMessage } from './background-messages.js';
import { ALARM_NAMES, MESSAGE_ACTIONS } from './constants.js';
import { idbGet, idbSet } from './idb-service.js';
import { SPECIAL_PROTOCOLS } from './utils.js';
import { ensureInit } from './lifecycle.js';
import { createLogger } from './logger.js';

const log = createLogger('Background');
log.info('Service Worker 启动');

// 监听安装事件
chrome.runtime.onInstalled.addListener(async (details) => {
  log.info("扩展已安装/更新:", details.reason);
  // v2.x 起不再在扩展 icon 上标识书签状态；升级后清掉旧版残留的 per-tab icon / badge
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all((tabs || []).map(async (t) => {
      if (!t || typeof t.id !== 'number') return;
      try { await chrome.action.setBadgeText({ tabId: t.id, text: '' }); } catch (e) {}
      try { await chrome.action.setIcon({ tabId: t.id, path: { 16: 'icon16.png', 48: 'icon48.png', 128: 'icon128.png' } }); } catch (e) {}
    }));
  } catch (e) {}
  await ensureInit();
});

// 监听浏览器启动事件（确保 alarm 等被正确设置）
chrome.runtime.onStartup.addListener(async () => {
  await ensureInit();
});

// 监听书签变化事件（浏览器原生书签变化时自动触发同步）
// 使用 setTimeout 防抖（chrome.alarms 最短延迟约 30s，不适合短间隔防抖）。
// 事件同时持久化到 IDB，并预约 alarm 作为 SW 挂起的兜底，避免掉事件。
const DEBOUNCE_DELAY_MS = 500;
const IDB_KEY_PENDING_BOOKMARK_EVENTS = 'pending-bookmark-events:v1';
const PENDING_EVENT_QUEUE_MAX = 2000;
const PENDING_FLUSH_ALARM_DELAY_MINUTES = 1;

let debounceBookmarkEvents = [];
let importInProgress = false;
let debounceTimer = null;
let pendingPersistChain = Promise.resolve();
let pendingRehydrated = false;

function scheduleBookmarkDebounce() {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushBookmarkDebounce, DEBOUNCE_DELAY_MS);
  // alarm 兜底：即使 SW 挂起，1 分钟后也会被唤起 flush。
  try {
    chrome.alarms.create(ALARM_NAMES.FLUSH_PENDING_EVENTS, { delayInMinutes: PENDING_FLUSH_ALARM_DELAY_MINUTES });
  } catch (e) {}
}

function sanitizePendingEventsForPersistence(events) {
  const list = Array.isArray(events) ? events : [];
  const safe = [];
  for (let i = 0; i < list.length && safe.length < PENDING_EVENT_QUEUE_MAX; i++) {
    const evt = list[i];
    if (!evt || typeof evt !== 'object' || !evt.type) continue;
    // 剥离可能不可结构化克隆的循环引用字段；只保留基础类型
    try {
      safe.push(JSON.parse(JSON.stringify(evt)));
    } catch (e) {}
  }
  return safe;
}

function persistPendingEventsSnapshot() {
  const snapshot = sanitizePendingEventsForPersistence(debounceBookmarkEvents);
  pendingPersistChain = pendingPersistChain
    .catch(() => {})
    .then(() => idbSet(IDB_KEY_PENDING_BOOKMARK_EVENTS, snapshot))
    .catch((error) => {
      log.warn('pending_events_persist_failed', {
        message: error && error.message ? error.message : String(error)
      });
    });
  return pendingPersistChain;
}

async function clearPendingEventsFromIdb() {
  pendingPersistChain = pendingPersistChain
    .catch(() => {})
    .then(() => idbSet(IDB_KEY_PENDING_BOOKMARK_EVENTS, []))
    .catch(() => {});
  return pendingPersistChain;
}

async function rehydratePendingEventsOnce() {
  if (pendingRehydrated) return;
  pendingRehydrated = true;
  try {
    const raw = await idbGet(IDB_KEY_PENDING_BOOKMARK_EVENTS);
    if (!Array.isArray(raw) || raw.length === 0) return;
    log.info('从 IDB 恢复 pending bookmark events: %d 条', raw.length);
    // 合并到内存队列并安排 flush；不立即写 IDB（flush 时会统一清理）
    for (let i = 0; i < raw.length && debounceBookmarkEvents.length < PENDING_EVENT_QUEUE_MAX; i++) {
      const evt = raw[i];
      if (evt && typeof evt === 'object' && evt.type) debounceBookmarkEvents.push(evt);
    }
    if (debounceBookmarkEvents.length > 0) scheduleBookmarkDebounce();
  } catch (error) {
    log.warn('pending_events_rehydrate_failed', {
      message: error && error.message ? error.message : String(error)
    });
  }
}

async function flushBookmarkDebounce() {
  debounceTimer = null;
  const events = debounceBookmarkEvents;
  debounceBookmarkEvents = [];

  log.info("防抖触发，开始同步（事件数=%d）", Array.isArray(events) ? events.length : 0);
  await ensureInit();
  if (importInProgress) {
    // Import 期间直接放弃（稍后的 importEnded 会触发全量刷新）
    await clearPendingEventsFromIdb();
    try { await chrome.alarms.clear(ALARM_NAMES.FLUSH_PENDING_EVENTS); } catch (e) {}
    return;
  }

  if (!Array.isArray(events) || events.length === 0) {
    log.info("防抖触发但事件队列为空，跳过");
    await clearPendingEventsFromIdb();
    try { await chrome.alarms.clear(ALARM_NAMES.FLUSH_PENDING_EVENTS); } catch (e) {}
    return;
  }

  try {
    const result = await applyBookmarkEvents(events);
    // 被上层认为成功或尚未调度的：清空持久化；失败则重新持久化
    if (!result || result.success !== false || result.skipped || result.fallback) {
      await clearPendingEventsFromIdb();
      try { await chrome.alarms.clear(ALARM_NAMES.FLUSH_PENDING_EVENTS); } catch (e) {}
    } else {
      // 处理失败，重新入队等待下一轮 flush
      debounceBookmarkEvents = events.concat(debounceBookmarkEvents);
      persistPendingEventsSnapshot();
      scheduleBookmarkDebounce();
    }
  } catch (error) {
    log.warn('applyBookmarkEvents 抛错，保留队列:', error);
    debounceBookmarkEvents = events.concat(debounceBookmarkEvents);
    persistPendingEventsSnapshot();
    scheduleBookmarkDebounce();
  }
}

function enqueueBookmarkEvent(evt) {
  if (importInProgress) return;
  if (!evt || typeof evt !== 'object') return;
  if (debounceBookmarkEvents.length >= PENDING_EVENT_QUEUE_MAX) {
    log.warn('pending event queue full，丢弃旧事件');
    debounceBookmarkEvents.splice(0, Math.max(1, PENDING_EVENT_QUEUE_MAX - debounceBookmarkEvents.length + 1));
  }
  debounceBookmarkEvents.push(evt);
  persistPendingEventsSnapshot();
  scheduleBookmarkDebounce();
}

if (chrome.bookmarks && chrome.bookmarks.onCreated) {
  chrome.bookmarks.onCreated.addListener((id, bookmark) => {
    log.info("原生书签创建，等待防抖...");
    enqueueBookmarkEvent({ type: 'created', id, bookmark });
  });
}

if (chrome.bookmarks && chrome.bookmarks.onRemoved) {
  chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
    log.info("原生书签删除，等待防抖...");
    enqueueBookmarkEvent({ type: 'removed', id, removeInfo });
  });
}

if (chrome.bookmarks && chrome.bookmarks.onChanged) {
  chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
    log.info("原生书签变更，等待防抖...");
    enqueueBookmarkEvent({ type: 'changed', id, changeInfo });
  });
}

if (chrome.bookmarks && chrome.bookmarks.onMoved) {
  chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
    log.info("原生书签移动，等待防抖...");
    enqueueBookmarkEvent({ type: 'moved', id, moveInfo });
  });
}

// Reorder within the same folder doesn't affect URL/title/path; ignore to reduce refresh noise.

if (chrome.bookmarks && chrome.bookmarks.onImportBegan) {
  chrome.bookmarks.onImportBegan.addListener(() => {
    log.info("书签导入开始，暂停增量并等待结束后全量刷新");
    importInProgress = true;
    debounceBookmarkEvents = [];
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
  });
}

if (chrome.bookmarks && chrome.bookmarks.onImportEnded) {
  chrome.bookmarks.onImportEnded.addListener(() => {
    log.info("书签导入结束，触发全量刷新（防抖）");
    importInProgress = false;
    enqueueBookmarkEvent({ type: 'forceRefresh' });
  });
}

function handleStorageChanged(changes, area) {
  if (area !== 'local' || !changes || typeof changes !== 'object') return;

  if (changes.bookmarkCacheTtlMinutes) {
    const nextValue = changes.bookmarkCacheTtlMinutes.newValue;
    updateRuntimeCacheTtlMinutes(nextValue);
    log.observe('ttl_runtime_updated', { value: nextValue });
  }
}

chrome.storage.onChanged.addListener(handleStorageChanged);

// 监听定时任务
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || !alarm.name) return;

  if (alarm.name === ALARM_NAMES.SYNC_BOOKMARKS) {
    await ensureInit();
    await handleSyncAlarm(alarm);
    return;
  }

  if (alarm.name === ALARM_NAMES.FLUSH_PENDING_EVENTS) {
    // SW 从挂起中被唤醒：补偿 flush 残留队列
    await ensureInit();
    await rehydratePendingEventsOnce();
    if (debounceBookmarkEvents.length > 0) {
      if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
      await flushBookmarkDebounce();
    }
    return;
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
      log.error("获取当前标签页失败:", error);
      return;
    }

    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;
    if (tab.url && SPECIAL_PROTOCOLS.some(protocol => tab.url.startsWith(protocol))) {
      return;
    }

    // 焦点迁移：
    //   1) 顶层 frame 执行 window.focus()：把窗口焦点从浏览器 chrome（地址栏等）
    //      拉回页面内容层，否则下一步 overlay input.focus() 可能被拦截。
    //   2) 所有 frame 内 blur 当前 activeElement，避免 overlay 出来后原 input
    //      继续截获键盘事件。
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: () => {
          try { window.focus(); } catch (e) {}
        }
      });
    } catch (error) {
      // best-effort
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          try {
            // 穿透 Shadow DOM：逐层跟随 shadowRoot.activeElement，blur 真正的内层焦点节点
            let node = document.activeElement;
            const visited = new Set();
            while (node && !visited.has(node)) {
              visited.add(node);
              if (node.shadowRoot && node.shadowRoot.activeElement) {
                const next = node.shadowRoot.activeElement;
                try { if (typeof node.blur === 'function') node.blur(); } catch (e) {}
                node = next;
                continue;
              }
              try { if (typeof node.blur === 'function') node.blur(); } catch (e) {}
              break;
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
      log.warn("注入 CSS 失败:", error);
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      await chrome.tabs.sendMessage(tab.id, { action: MESSAGE_ACTIONS.TOGGLE_SEARCH });
    } catch (error) {
      log.error("注入/唤起搜索失败:", error);
    }
  }
});

// 启动初始化 + 恢复 IDB 中残留的 pending events
ensureInit().then(() => rehydratePendingEventsOnce()).catch(() => {});
