/**
 * 扩展图标状态指示：当前活动标签页 URL 是否已收藏
 *
 * 视觉方案：
 *   - 已收藏：在原图标右下角叠加一个主题色实心圆点 + 白色描边
 *     （OffscreenCanvas 生成 ImageData，chrome.action.setIcon 切换整张 icon）
 *   - 未收藏：恢复默认多尺寸路径 icon
 *   - 不再使用 setBadgeText('●')——字符渲染粗糙且受系统字体影响
 *
 * 触发时机：
 *   - 活动 tab 切换（onActivated）
 *   - 活动 tab URL 变化（onUpdated with status=complete）
 *   - 浏览器书签 create/remove/changed 时，刷新所有匹配 tab
 */

import { SPECIAL_PROTOCOLS } from './utils.js';
import { createLogger } from './logger.js';

const log = createLogger('Badge');

// 主题色：与 overlay accent 对齐，保持整套扩展视觉一致
const INDICATOR_COLOR = '#5e6ad2';
const INDICATOR_STROKE = '#ffffff';

// 默认 icon 路径（未收藏态）
const DEFAULT_ICON_PATHS = {
  16: 'icon16.png',
  48: 'icon48.png',
  128: 'icon128.png'
};

// ImageBitmap 缓存：首次构建后不再重复解 PNG
let baseBitmapCache = null;
// 已收藏态 ImageData 缓存：{ '16': ImageData, '32': ImageData, '48': ImageData }
let bookmarkedImageDataCache = null;

async function loadBaseBitmaps() {
  if (baseBitmapCache) return baseBitmapCache;
  try {
    const entries = await Promise.all(Object.entries(DEFAULT_ICON_PATHS).map(async ([size, path]) => {
      const res = await fetch(chrome.runtime.getURL(path));
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      return [size, bitmap];
    }));
    baseBitmapCache = Object.fromEntries(entries);
    return baseBitmapCache;
  } catch (error) {
    log.warn('base bitmap load failed', { message: error && error.message ? error.message : String(error) });
    return null;
  }
}

// 在给定尺寸画布上绘制 "base icon + 右下角圆点 indicator"
function drawBookmarkedVariant(baseBitmap, size) {
  try {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) return null;

    // 1) 绘制原图
    ctx.drawImage(baseBitmap, 0, 0, size, size);

    // 2) 右下角 indicator：半径 ≈ size × 0.3，留 1px 白描边 + 内阴影感
    const dotR = Math.max(3, Math.round(size * 0.3));
    const strokeW = Math.max(1, Math.round(size / 16));
    const cx = size - dotR - Math.max(0, Math.round(size / 20));
    const cy = size - dotR - Math.max(0, Math.round(size / 20));

    // 白色描边圆（提升 indicator 在任意 icon 背景上的对比）
    ctx.fillStyle = INDICATOR_STROKE;
    ctx.beginPath();
    ctx.arc(cx, cy, dotR + strokeW, 0, Math.PI * 2);
    ctx.fill();

    // 主题色实心圆
    ctx.fillStyle = INDICATOR_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fill();

    return ctx.getImageData(0, 0, size, size);
  } catch (error) {
    log.warn('indicator draw failed', { size, message: error && error.message ? error.message : String(error) });
    return null;
  }
}

async function getBookmarkedImageData() {
  if (bookmarkedImageDataCache) return bookmarkedImageDataCache;
  const base = await loadBaseBitmaps();
  if (!base) return null;
  // Chrome MV3 action setIcon 接受 16/32/48 三个尺寸；128 不常用可省
  const d16 = drawBookmarkedVariant(base['16'], 16);
  const d32 = drawBookmarkedVariant(base['48'], 32);
  const d48 = drawBookmarkedVariant(base['48'], 48);
  if (!d16 || !d32 || !d48) return null;
  bookmarkedImageDataCache = { '16': d16, '32': d32, '48': d48 };
  return bookmarkedImageDataCache;
}

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

async function setBookmarkedIcon(tabId) {
  const imageData = await getBookmarkedImageData();
  if (!imageData) {
    // 生成失败退化：用一个小方块 badge（比原来的 ● 清爽）
    try {
      await chrome.action.setBadgeText({ tabId, text: ' ' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: INDICATOR_COLOR });
    } catch (e) {}
    return;
  }
  try {
    await chrome.action.setIcon({ tabId, imageData });
    // 确保之前的 badge text 被清除
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (e) {
    // tab 可能已关闭，忽略
  }
}

async function setDefaultIcon(tabId) {
  try {
    await chrome.action.setIcon({ tabId, path: DEFAULT_ICON_PATHS });
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (e) {
    // ignore
  }
}

async function applyBadgeForTab(tabId, url) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  const bookmarked = await isUrlBookmarked(url);
  if (bookmarked) {
    await setBookmarkedIcon(tabId);
  } else {
    await setDefaultIcon(tabId);
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
      if (changeInfo && typeof changeInfo.url === 'string') {
        refreshAllTabsMatchingUrl(changeInfo.url);
      }
      refreshActiveTabBadge();
    });
  }

  log.info('badge listeners installed');
  refreshActiveTabBadge();
}
