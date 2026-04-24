/**
 * 新标签页 Dashboard
 * - 时间感知问候 + 大时钟
 * - 搜索框（直接走 SEARCH_BOOKMARKS 消息；复用 fallback 引擎配置）
 * - Speed Dial 12 格（基于 openStats TOP，不够用最近添加补齐）
 * - 时间感知渐变壁纸（dawn / day / sunset / night）
 */

import { MESSAGE_ACTIONS, SEARCH_ENGINE_PRESETS } from './constants.js';
import { STORAGE_KEYS } from './storage-service.js';

// ----------------------------------------------------------------
// 工具
// ----------------------------------------------------------------
const RESULTS_LIMIT = 8;

function sendMessagePromise(message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; reject(new Error('timeout')); } }, timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
        resolve(resp);
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(t); reject(e); }
    }
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildFaviconUrl(pageUrl, size) {
  try {
    const base = chrome.runtime.getURL('_favicon/');
    if (!base || base.indexOf('chrome-extension://') !== 0) return '';
    return base + '?pageUrl=' + encodeURIComponent(pageUrl) + '&size=' + (size || 32);
  } catch (e) { return ''; }
}

function openUrl(url, newTab = false) {
  if (!url) return;
  try { sendMessagePromise({ action: MESSAGE_ACTIONS.TRACK_BOOKMARK_OPEN, url }).catch(() => {}); } catch (e) {}
  if (newTab) {
    try { chrome.tabs.create({ url, active: true }); return; } catch (e) {}
    try { window.open(url, '_blank', 'noopener,noreferrer'); return; } catch (e) {}
  }
  window.location.href = url;
}

// ----------------------------------------------------------------
// 时钟 + 问候 + 时间感知配色
// ----------------------------------------------------------------
function greetingFor(hour) {
  if (hour >= 5 && hour < 11) return '早上好';
  if (hour >= 11 && hour < 14) return '中午好';
  if (hour >= 14 && hour < 18) return '下午好';
  if (hour >= 18 && hour < 22) return '晚上好';
  return '夜深了';
}

function timeOfDay(hour) {
  if (hour >= 5 && hour < 11) return 'dawn';
  if (hour >= 11 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'sunset';
  return 'night';
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function tickClock() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const clockEl = document.getElementById('ntTime');
  if (clockEl) clockEl.textContent = `${pad2(h)}:${pad2(m)}`;

  const greetEl = document.getElementById('ntGreeting');
  if (greetEl) greetEl.textContent = greetingFor(h);

  const dateEl = document.getElementById('ntDate');
  if (dateEl) {
    const y = now.getFullYear();
    const mo = now.getMonth() + 1;
    const d = now.getDate();
    const w = WEEKDAYS[now.getDay()];
    dateEl.textContent = `${y} 年 ${mo} 月 ${d} 日 · ${w}`;
  }

  document.body.dataset.tod = timeOfDay(h);
}

// ----------------------------------------------------------------
// Speed Dial
// ----------------------------------------------------------------
async function loadSpeedDial() {
  const gridEl = document.getElementById('ntDialGrid');
  const titleEl = document.getElementById('ntDialTitle');
  if (!gridEl) return;

  gridEl.innerHTML = '';
  try {
    const resp = await sendMessagePromise({ action: MESSAGE_ACTIONS.GET_SPEED_DIAL, limit: 12 });
    if (!resp || resp.success === false) throw new Error((resp && resp.error && resp.error.message) || '加载失败');
    const items = Array.isArray(resp.items) ? resp.items : [];
    if (items.length === 0) {
      if (titleEl) titleEl.textContent = '还没有书签';
      const empty = document.createElement('div');
      empty.className = 'nt-dial-empty';
      empty.textContent = '在地址栏输入 URL 并收藏后，这里会自动出现。';
      gridEl.appendChild(empty);
      return;
    }

    const hasOpens = items.some((i) => i.source === 'opens');
    if (titleEl) titleEl.textContent = hasOpens ? '常用书签' : '最近添加';

    items.forEach((item) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'nt-dial-card';
      card.title = `${item.title || ''}\n${item.url || ''}`;
      card.dataset.url = item.url || '';

      const iconWrap = document.createElement('div');
      iconWrap.className = 'nt-dial-icon';
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = buildFaviconUrl(item.url, 48);
      iconWrap.appendChild(img);

      const label = document.createElement('div');
      label.className = 'nt-dial-label';
      label.textContent = item.title || hostOf(item.url) || '(无标题)';

      card.appendChild(iconWrap);
      card.appendChild(label);

      card.addEventListener('click', (e) => {
        openUrl(item.url, e.metaKey || e.ctrlKey);
      });
      card.addEventListener('auxclick', (e) => {
        // 鼠标中键打开新 tab
        if (e.button === 1) { e.preventDefault(); openUrl(item.url, true); }
      });

      gridEl.appendChild(card);
    });
  } catch (e) {
    if (titleEl) titleEl.textContent = '常用书签';
    const err = document.createElement('div');
    err.className = 'nt-dial-empty';
    err.textContent = '加载失败：' + (e && e.message ? e.message : String(e));
    gridEl.appendChild(err);
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

// ----------------------------------------------------------------
// 搜索
// ----------------------------------------------------------------
let searchDebounceTimer = null;
let currentSearchToken = 0;
let filteredResults = [];
let selectedIndex = -1;
let searchEngineConfig = { enabled: false, engine: 'google', customUrl: '' };

async function loadSearchEngineConfig() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEYS.SEARCH_ENGINE_FALLBACK);
    const raw = r && r[STORAGE_KEYS.SEARCH_ENGINE_FALLBACK];
    if (raw && typeof raw === 'object') {
      searchEngineConfig = {
        enabled: raw.enabled === true,
        engine: typeof raw.engine === 'string' ? raw.engine : 'google',
        customUrl: typeof raw.customUrl === 'string' ? raw.customUrl : ''
      };
    }
  } catch (e) {}
}

function resolveSearchEngine() {
  const c = searchEngineConfig;
  if (!c.enabled) return null;
  if (c.engine === 'custom') {
    const tpl = (c.customUrl || '').trim();
    if (!tpl || tpl.indexOf('{q}') === -1) return null;
    if (!/^https?:\/\//i.test(tpl)) return null;
    return { label: '自定义', url: tpl };
  }
  return SEARCH_ENGINE_PRESETS[c.engine] || null;
}

function buildSearchEngineUrl(q) {
  const info = resolveSearchEngine();
  if (!info) return '';
  const safe = String(q || '').trim();
  if (!safe) return '';
  return info.url.replace(/\{q\}/g, encodeURIComponent(safe));
}

function clearResults() {
  const resultsEl = document.getElementById('ntResults');
  if (!resultsEl) return;
  resultsEl.innerHTML = '';
  resultsEl.classList.remove('is-visible');
  filteredResults = [];
  selectedIndex = -1;
  const dialEl = document.getElementById('ntDial');
  if (dialEl) dialEl.classList.remove('is-dimmed');
}

function renderResults(items) {
  const resultsEl = document.getElementById('ntResults');
  if (!resultsEl) return;
  resultsEl.innerHTML = '';
  filteredResults = Array.isArray(items) ? items : [];

  if (filteredResults.length === 0) {
    const query = document.getElementById('ntQuery').value.trim();
    const info = resolveSearchEngine();
    if (info && query) {
      const row = document.createElement('div');
      row.className = 'nt-result nt-result-fallback';
      row.setAttribute('role', 'option');
      row.dataset.index = '0';
      row.innerHTML = `
        <div class="nt-result-icon nt-result-icon-search">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        </div>
        <div class="nt-result-body">
          <div class="nt-result-title">在 <strong>${escapeHtml(info.label)}</strong> 搜索 <span class="nt-result-q">${escapeHtml(query)}</span></div>
          <div class="nt-result-subtitle">按 Enter 直接跳转</div>
        </div>
        <kbd class="nt-result-kbd">Enter</kbd>
      `;
      row.addEventListener('click', () => {
        openUrl(buildSearchEngineUrl(query), false);
      });
      resultsEl.appendChild(row);
      selectedIndex = 0;
      filteredResults = [{ __fallback: true, url: buildSearchEngineUrl(query) }];
    } else {
      const empty = document.createElement('div');
      empty.className = 'nt-result-empty';
      empty.textContent = '未找到匹配的书签';
      resultsEl.appendChild(empty);
      selectedIndex = -1;
    }
    resultsEl.classList.add('is-visible');
    updateSelection();
    return;
  }

  filteredResults.forEach((bm, idx) => {
    const row = document.createElement('div');
    row.className = 'nt-result';
    row.setAttribute('role', 'option');
    row.dataset.index = String(idx);

    row.innerHTML = `
      <img class="nt-result-icon" src="${escapeHtml(buildFaviconUrl(bm.url, 32))}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <div class="nt-result-body">
        <div class="nt-result-title">${escapeHtml(bm.title || '(无标题)')}</div>
        <div class="nt-result-subtitle">${bm.path ? escapeHtml(bm.path) + ' · ' : ''}${escapeHtml(bm.url || '')}</div>
      </div>
    `;
    row.addEventListener('click', (e) => openUrl(bm.url, e.metaKey || e.ctrlKey));
    row.addEventListener('mouseenter', () => { selectedIndex = idx; updateSelection(); });
    resultsEl.appendChild(row);
  });

  selectedIndex = 0;
  resultsEl.classList.add('is-visible');
  updateSelection();
}

function updateSelection() {
  const resultsEl = document.getElementById('ntResults');
  if (!resultsEl) return;
  const rows = resultsEl.querySelectorAll('.nt-result');
  rows.forEach((row, i) => {
    row.classList.toggle('is-selected', i === selectedIndex);
  });
  if (selectedIndex >= 0 && rows[selectedIndex]) {
    rows[selectedIndex].scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
}

async function handleSearch(query) {
  const token = ++currentSearchToken;
  const safe = String(query || '').trim();
  if (!safe) {
    clearResults();
    return;
  }
  try {
    const resp = await sendMessagePromise({ action: MESSAGE_ACTIONS.SEARCH_BOOKMARKS, query: safe, limit: RESULTS_LIMIT });
    if (token !== currentSearchToken) return;
    if (!resp || resp.success === false) {
      renderResults([]);
      return;
    }
    renderResults(Array.isArray(resp.results) ? resp.results : []);
    const dialEl = document.getElementById('ntDial');
    if (dialEl) dialEl.classList.add('is-dimmed');
  } catch (e) {
    if (token !== currentSearchToken) return;
    renderResults([]);
  }
}

function setupSearch() {
  const input = document.getElementById('ntQuery');
  if (!input) return;

  input.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => handleSearch(e.target.value), 120);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      if (filteredResults.length > 0) {
        e.preventDefault();
        selectedIndex = selectedIndex >= filteredResults.length - 1 ? 0 : selectedIndex + 1;
        updateSelection();
      }
    } else if (e.key === 'ArrowUp') {
      if (filteredResults.length > 0) {
        e.preventDefault();
        selectedIndex = selectedIndex <= 0 ? filteredResults.length - 1 : selectedIndex - 1;
        updateSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && filteredResults[selectedIndex]) {
        const item = filteredResults[selectedIndex];
        if (item.__fallback) {
          openUrl(item.url, false);
        } else {
          openUrl(item.url, e.metaKey || e.ctrlKey);
        }
      }
    } else if (e.key === 'Escape') {
      if (input.value) {
        input.value = '';
        clearResults();
      }
    }
  });

  // "/" 快捷键聚焦（input 自己输入时忽略）
  document.addEventListener('keydown', (e) => {
    if (e.target === input) return;
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      input.focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

// ----------------------------------------------------------------
// Footer 按钮
// ----------------------------------------------------------------
function setupFooter() {
  const openSettings = document.getElementById('ntOpenSettings');
  if (openSettings) {
    openSettings.addEventListener('click', () => {
      try { chrome.runtime.openOptionsPage(); } catch (e) {
        window.open(chrome.runtime.getURL('settings.html'), '_blank');
      }
    });
  }
  const openManager = document.getElementById('ntOpenManager');
  if (openManager) {
    openManager.addEventListener('click', () => {
      try { chrome.tabs.create({ url: 'chrome://bookmarks/' }); } catch (e) {
        window.location.href = 'chrome://bookmarks/';
      }
    });
  }
}

// ----------------------------------------------------------------
// 启动
// ----------------------------------------------------------------
async function init() {
  tickClock();
  setInterval(tickClock, 30_000);

  await Promise.all([
    loadSearchEngineConfig(),
    loadSpeedDial()
  ]);

  setupSearch();
  setupFooter();

  // storage 变更（切主题 / 改引擎 / 改 speed dial 源）时局部刷新
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      if (changes.searchEngineFallback) loadSearchEngineConfig();
    });
  } catch (e) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
