import { initThemeSelector } from './settings-theme.js';
import { loadShortcutInfo, bindShortcutEvents } from './settings-shortcuts.js';
import { loadSyncSettings, loadBookmarkStats, bindSyncEvents } from './settings-sync.js';
import { loadUpdateHistory, bindHistoryEvents, clearUpdateNotification, showUpdateNotification } from './settings-history.js';
import { bindDuplicatesEvents } from './settings-duplicates.js';
import { bindDeadlinkEvents } from './settings-deadlinks.js';

console.log("[Settings] settings.js 开始加载 (主入口)");

/**
 * 轻量 toast：设置变更 / 维护操作成功的非打断反馈。
 * 暴露到 window 方便各子模块使用。
 */
function showToast(message, options = {}) {
  const type = options.type === 'error' ? 'error' : (options.type === 'warning' ? 'warning' : 'success');
  const duration = typeof options.duration === 'number' ? options.duration : 2400;

  let container = document.getElementById('bs-toast-root');
  if (!container) {
    container = document.createElement('div');
    container.id = 'bs-toast-root';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = 'bs-toast bs-toast-' + type;
  toast.textContent = String(message || '');
  container.appendChild(toast);

  // enter
  requestAnimationFrame(() => toast.classList.add('bs-toast-visible'));

  // exit + cleanup
  setTimeout(() => {
    toast.classList.remove('bs-toast-visible');
    setTimeout(() => { try { container.removeChild(toast); } catch (e) {} }, 220);
  }, duration);
}

if (typeof window !== 'undefined') {
  window.__bsShowToast = showToast;
}

// 初始化
async function init() {
  console.log("[Settings] 初始化开始");

  try {
    // 并行初始化各模块（互不依赖，可同时加载）
    await Promise.all([
      initThemeSelector(),
      loadShortcutInfo(),
      loadBookmarkStats(),
      loadSyncSettings(),
      loadUpdateHistory()
    ]);

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
  bindDuplicatesEvents();
  bindDeadlinkEvents();
  bindSidebarNav();
}

// 侧边栏锚点导航：点击平滑滚动 + 滚动时高亮当前 section
function bindSidebarNav() {
  const links = Array.from(document.querySelectorAll('.settings-nav-link'));
  if (links.length === 0) return;
  const sections = links
    .map((a) => ({ link: a, target: document.getElementById(a.dataset.target) }))
    .filter((s) => s.target);
  if (sections.length === 0) return;

  // 点击 → 平滑滚动到 section（避免默认锚点跳转的突变）
  links.forEach((link) => {
    link.addEventListener('click', (e) => {
      const target = document.getElementById(link.dataset.target);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // IntersectionObserver 高亮当前可视 section
  if (typeof IntersectionObserver !== 'function') return;
  const activate = (id) => {
    sections.forEach(({ link, target }) => {
      link.classList.toggle('is-active', target.id === id);
    });
  };
  const observer = new IntersectionObserver((entries) => {
    // 选离顶部最近的可视 section
    let best = null;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const rect = entry.target.getBoundingClientRect();
      if (!best || rect.top < best.rect.top) best = { id: entry.target.id, rect };
    }
    if (best) activate(best.id);
  }, { rootMargin: '-20% 0px -60% 0px', threshold: 0 });
  sections.forEach(({ target }) => observer.observe(target));

  // 初始态：选中第一个
  activate(sections[0].target.id);
}

// 设置存储监听器，实现实时更新
function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    console.log("[Settings] 存储发生变化:", Object.keys(changes));

    // 书签统计或元数据变化时，更新统计
    if (changes.bookmarkCount || changes.bookmarksMeta) {
      console.log("[Settings] 检测到书签统计变化，重新加载统计");
      loadBookmarkStats();
    }

    // 同步时间变化时，更新显示
    if (changes.lastSyncTime || changes.syncInterval || changes.bookmarkCacheTtlMinutes) {
      console.log("[Settings] 检测到同步设置变化，重新加载同步信息");
      loadSyncSettings();
    }

    // 书签历史变化时，更新历史列表
    if (changes.bookmarkHistory) {
      console.log("[Settings] 检测到书签历史变化，重新加载历史");
      loadUpdateHistory();
      
      const nextHistory = changes.bookmarkHistory.newValue;
      if (Array.isArray(nextHistory) && nextHistory.length > 0) {
        showUpdateNotification();
      } else {
        clearUpdateNotification();
      }
    }
  });

  console.log("[Settings] 存储监听器已设置");
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
