/**
 * 扩展图标 badge：当前活动标签页的 URL 是否已收藏
 * - 已收藏：显示 "●" badge，主题色底
 * - 未收藏：清空 badge
 * 触发时机：
 *   - 活动 tab 切换（onActivated）
 *   - 活动 tab URL 变化（onUpdated with status=complete）
 *   - 浏览器书签 create/remove 时，刷新所有 tab
 */

import { SPECIAL_PROTOCOLS } from './utils.js';
import { createLogger } from './logger.js';

const log = createLogger('Badge');

const BADGE_TEXT_BOOKMARKED = '●';
const BADGE_COLOR_BOOKMARKED = '#5e6ad2';

function isSkippableUrl(url) {
  const safe = typeof url === 'string' ? url : '';
  if (!safe) return true;
  for (let i = 0; i < SPECIAL_PROTOCOLS.length; i++) {
    if (safe.indexOf(SPECIAL_PROTOCOLS[i]) === 0) return true;
  }
  return false;
}

async function isUrlBookmarked(url) {
  if (isSkippableUrl(url)) return false;
  try {
    const results = await chrome.bookmarks.search({ url });
    return Array.isArray(results) && results.length > 0;
  } catch (e) {
    return false;
  }
}

async function applyBadgeForTab(tabId, url) {
  try {
    if (typeof tabId !== 'number' || tabId < 0) return;
    const bookmarked = await isUrlBookmarked(url);
    if (bookmarked) {
      await chrome.action.setBadgeText({ tabId, text: BADGE_TEXT_BOOKMARKED });
      try {
        await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR_BOOKMARKED });
      } catch (e) {}
      try {
        if (chrome.action.setBadgeTextColor) {
          await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
        }
      } catch (e) {}
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch (e) {
    // ignore: tab may have closed
  }
}

async function refreshActiveTabBadge() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    for (const t of tabs || []) {
      if (t && typeof t.id === 'number') {
        await applyBadgeForTab(t.id, t.url || '');
      }
    }
  } catch (e) {}
}

async function refreshAllTabsMatchingUrl(url) {
  const safe = typeof url === 'string' ? url : '';
  if (!safe || isSkippableUrl(safe)) return;
  try {
    const tabs = await chrome.tabs.query({ url: safe });
    for (const t of tabs || []) {
      if (t && typeof t.id === 'number') {
        await applyBadgeForTab(t.id, t.url || safe);
      }
    }
  } catch (e) {
    // chrome.tabs.query 可能因为 URL 不合法抛错；忽略
  }
}

export function installBadgeListeners() {
  if (!chrome || !chrome.tabs || !chrome.action) return;

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      applyBadgeForTab(tabId, tab && tab.url ? tab.url : '');
    } catch (e) {}
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 只在 URL 变化或加载完成时刷新 badge，避免重复刷
    if (!changeInfo) return;
    const urlChanged = typeof changeInfo.url === 'string';
    const becameComplete = changeInfo.status === 'complete';
    if (!urlChanged && !becameComplete) return;
    if (!tab || !tab.active) return;
    applyBadgeForTab(tabId, tab.url || '');
  });

  // 书签增删 → 所有匹配该 URL 的 tab 刷新
  if (chrome.bookmarks && chrome.bookmarks.onCreated) {
    chrome.bookmarks.onCreated.addListener((id, bookmark) => {
      if (bookmark && bookmark.url) refreshAllTabsMatchingUrl(bookmark.url);
    });
  }
  if (chrome.bookmarks && chrome.bookmarks.onRemoved) {
    chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
      const url = removeInfo && removeInfo.node && removeInfo.node.url;
      if (url) refreshAllTabsMatchingUrl(url);
    });
  }
  if (chrome.bookmarks && chrome.bookmarks.onChanged) {
    chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
      // URL 变化时刷新新旧 URL 对应的 tab
      if (changeInfo && typeof changeInfo.url === 'string') {
        refreshAllTabsMatchingUrl(changeInfo.url);
      }
      // 当前活动 tab 也顺便 refresh
      refreshActiveTabBadge();
    });
  }

  log.info('badge listeners installed');
  // 启动时补一次
  refreshActiveTabBadge();
}
