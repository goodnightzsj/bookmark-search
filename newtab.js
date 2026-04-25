/**
 * 新标签页 Dashboard
 * - 时间感知问候 + 大时钟（细分到每段时辰，并伴有副文案）
 * - 搜索框：Ctrl+Space / `/` / Cmd+K 聚焦；IME 友好；favicon 失败兜底 monogram
 * - Speed Dial 12 格（基于 openStats TOP，不够用最近添加补齐）
 * - 时间感知渐变壁纸 + 主题感知（用户在设置里选 dark 主题时整体反色）
 * - 接管首页可在设置里关掉 → 显示极简"已禁用"页
 */

import { MESSAGE_ACTIONS, SEARCH_ENGINE_PRESETS } from './constants.js';
import { STORAGE_KEYS } from './storage-service.js';
import { resolveActiveTheme } from './theme-service.js';

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

// 把任意 URL 缩成"易读形态"：example.com/foo/bar，超长加省略号
function displayUrl(url) {
  try {
    const u = new URL(url);
    let host = (u.hostname || '').replace(/^www\./, '');
    let path = u.pathname || '';
    if (path === '/') path = '';
    let s = host + path + (u.search || '');
    if (s.length > 60) s = s.slice(0, 57) + '…';
    return s;
  } catch (e) {
    return String(url || '').slice(0, 60);
  }
}

let navLoadingTimer = null;
function showNavigationLoading({ url, title }) {
  const titleEl = document.getElementById('ntLoadingTitle');
  const urlEl = document.getElementById('ntLoadingUrl');
  const faviconEl = document.getElementById('ntLoadingFavicon');
  if (titleEl) titleEl.textContent = title || '正在打开';
  if (urlEl) urlEl.textContent = displayUrl(url);
  if (faviconEl) {
    // 跟搜索结果一致：先尝试 _favicon，失败/默认占位走 monogram
    faviconEl.removeAttribute('src');
    if (url) applyFaviconWithFallback(faviconEl, url, hostOf(url));
  }
  document.body.dataset.loading = '1';
  // 兜底超时：连续触发时 reset，避免前一次的 timer 把后一次的 loading 提前清掉
  if (navLoadingTimer) clearTimeout(navLoadingTimer);
  navLoadingTimer = setTimeout(() => {
    navLoadingTimer = null;
    if (document.body.dataset.loading === '1') document.body.dataset.loading = '';
  }, 8000);
}

function openUrl(url, newTab = false, meta = {}) {
  if (!url) return;
  try { sendMessagePromise({ action: MESSAGE_ACTIONS.TRACK_BOOKMARK_OPEN, url }).catch(() => {}); } catch (e) {}
  if (newTab) {
    // 在新 tab 打开时本页不变，不需要 loading
    try { chrome.tabs.create({ url, active: true }); return; } catch (e) {}
    try { window.open(url, '_blank', 'noopener,noreferrer'); return; } catch (e) {}
    return;
  }
  showNavigationLoading({ url, title: meta.title || '正在打开' });
  // 同帧同步导航会让 loading 来不及渲染；用 rAF 让浏览器先 paint
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.location.href = url;
  }));
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

// ----------------------------------------------------------------
// favicon 兜底：默认 globe / 加载失败 → monogram
// ----------------------------------------------------------------
function hashHue(seed) {
  const s = String(seed || '').toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h) % 360;
}
function monogramLetter(domain) {
  const s = String(domain || '').trim().toLowerCase();
  if (!s) return '?';
  const cleaned = s.indexOf('www.') === 0 ? s.slice(4) : s;
  const c = cleaned.charAt(0);
  return /[a-z0-9]/i.test(c) ? c.toUpperCase() : (c || '?');
}
const monogramCache = Object.create(null);
function buildMonogramDataUrl(domain) {
  const key = String(domain || '').toLowerCase();
  if (monogramCache[key]) return monogramCache[key];
  const hue = hashHue(key);
  const bg = `hsl(${hue},58%,48%)`;
  const bgDark = `hsl(${hue},58%,36%)`;
  const letter = monogramLetter(key);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
    + `<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${bgDark}"/></linearGradient></defs>`
    + '<rect width="16" height="16" rx="4" fill="url(#g)"/>'
    + `<text x="8" y="11.5" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="10" font-weight="700" fill="#ffffff">${letter}</text>`
    + '</svg>';
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  monogramCache[key] = url;
  return url;
}

// 检测 _favicon 返回的"默认占位"（灰地球 / 文档图标）
function isLikelyDefaultFavicon(img) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return false;
  try {
    const N = 16;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: false });
    if (!ctx) return false;
    ctx.clearRect(0, 0, N, N);
    ctx.drawImage(img, 0, 0, N, N);
    let data;
    try { data = ctx.getImageData(0, 0, N, N).data; } catch (e) { return false; }
    let opaque = 0, satSum = 0, top = 0;
    const colors = Object.create(null);
    let uniq = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 40) continue;
      opaque++;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      satSum += mx > 0 ? (mx - mn) / mx : 0;
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      if (colors[k]) colors[k]++; else { colors[k] = 1; uniq++; }
      if (colors[k] > top) top = colors[k];
    }
    if (opaque < 10) return false;
    const avgSat = satSum / opaque;
    const topRatio = top / opaque;
    if (avgSat < 0.2 && uniq <= 8) return true;
    if (avgSat < 0.3 && topRatio >= 0.65) return true;
    return false;
  } catch (e) { return false; }
}

// 给 img 装上"加载完成 → 检测默认 → 失败兜底 monogram"的统一逻辑
function applyFaviconWithFallback(img, pageUrl, domain) {
  const dom = String(domain || hostOf(pageUrl) || '');
  const monogram = buildMonogramDataUrl(dom);
  const src = buildFaviconUrl(pageUrl, 32) || monogram;
  let fallbackApplied = false;
  function fallback() {
    if (fallbackApplied) return;
    fallbackApplied = true;
    img.src = monogram;
  }
  img.addEventListener('error', fallback, { once: true });
  img.addEventListener('load', () => {
    if (fallbackApplied) return;
    if (img.src.indexOf('/_favicon/') !== -1 && isLikelyDefaultFavicon(img)) {
      fallback();
    }
  }, { once: true });
  img.src = src;
}

// ----------------------------------------------------------------
// 时钟 + 时段感知问候（细分到每个时辰，副文案随机）
// ----------------------------------------------------------------
const SUBTITLES_BY_TOD = {
  earlymorning: ['新的一天开始了', '清晨好，慢慢来', '晨光中开个好头'],
  morning:      ['今天有好事发生', '专注片刻就好', '开个好头'],
  noon:         ['吃饱了再继续', '休息会儿，眼睛会感谢你', '一杯水，再看看屏幕'],
  afternoon:    ['再战一会儿', '保持节奏', '屏幕之外阳光正好'],
  evening:      ['辛苦了', '收个尾，准备下班', '抬头看看窗外'],
  night:        ['今天过得怎么样', '该休息了', '愿你睡个好觉'],
  latenight:    ['夜深了，注意眼睛', '少熬一会儿', '让大脑也下班吧']
};
function pickSubtitle(tod) {
  const list = SUBTITLES_BY_TOD[tod] || SUBTITLES_BY_TOD.morning;
  // 当天稳定：用 yyyy-mm-dd + tod 哈希取模，同一时段同一天看到同一句
  const seed = new Date().toDateString() + ':' + tod;
  let h = 0;
  for (let i = 0; i < seed.length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
  return list[Math.abs(h) % list.length];
}

function greetingFor(hour, name) {
  const prefix = name ? `${name}，` : '';
  if (hour >= 5 && hour < 7) return prefix + '清晨好';
  if (hour >= 7 && hour < 11) return prefix + '早上好';
  if (hour >= 11 && hour < 13) return prefix + '中午好';
  if (hour >= 13 && hour < 17) return prefix + '下午好';
  if (hour >= 17 && hour < 19) return prefix + '傍晚好';
  if (hour >= 19 && hour < 22) return prefix + '晚上好';
  return prefix + '夜深了';
}
function timeOfDay(hour) {
  if (hour >= 5 && hour < 7) return 'earlymorning';
  if (hour >= 7 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 13) return 'noon';
  if (hour >= 13 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 19) return 'evening';
  if (hour >= 19 && hour < 22) return 'night';
  return 'latenight';
}
function todPalette(tod) {
  // 给 wallpaper 选粗粒度色调；与上面 7 个细分时段对应
  if (tod === 'earlymorning' || tod === 'morning') return 'dawn';
  if (tod === 'noon' || tod === 'afternoon') return 'day';
  if (tod === 'evening') return 'sunset';
  return 'night'; // night / latenight
}
function pad2(n) { return n < 10 ? '0' + n : String(n); }
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let lastTod = null;
function tickClock() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const tod = timeOfDay(h);
  const palette = todPalette(tod);

  const clockEl = document.getElementById('ntTime');
  if (clockEl) clockEl.textContent = `${pad2(h)}:${pad2(m)}`;

  const greetEl = document.getElementById('ntGreeting');
  if (greetEl) greetEl.textContent = greetingFor(h);

  const subtitleEl = document.getElementById('ntSubtitle');
  if (subtitleEl && lastTod !== tod) subtitleEl.textContent = pickSubtitle(tod);

  const dateEl = document.getElementById('ntDate');
  if (dateEl) {
    const y = now.getFullYear();
    const mo = now.getMonth() + 1;
    const d = now.getDate();
    const w = WEEKDAYS[now.getDay()];
    dateEl.textContent = `${y} 年 ${mo} 月 ${d} 日 · ${w}`;
  }

  // 主题感知：根据用户在设置里选的主题映射到对应 mood
  //   auto      → 解析系统色模式：浅色 → daylight；深色 → midnight
  //   original  → linear 整洁专业（Sunrise paper）
  //   dark      → night 暖琥珀（Studio Dusk）
  //   glass     → glass 液态玻璃（lavender→sky-blue）
  //   minimal   → minimal 纯白纪律
  //   daylight/midnight → 直接对应 mood（防御兜底）
  let mood;
  if (themePref === 'dark')           mood = 'night';
  else if (themePref === 'midnight')  mood = 'midnight';
  else if (themePref === 'daylight')  mood = 'daylight';
  else if (themePref === 'original')  mood = 'linear';
  else if (themePref === 'glass')     mood = 'glass';
  else if (themePref === 'minimal')   mood = 'minimal';
  else if (themePref === 'auto') {
    const resolved = resolveActiveTheme('auto');
    mood = resolved === 'midnight' ? 'midnight' : 'daylight';
  }
  else /* 未知 */                     mood = palette;

  document.body.dataset.mood = mood;
  lastTod = tod;
}

// ----------------------------------------------------------------
// 主题偏好（与 overlay / settings 同步）
// ----------------------------------------------------------------
let themePref = 'auto';
async function loadThemePref() {
  try {
    const r = await chrome.storage.local.get('theme');
    if (r && typeof r.theme === 'string') themePref = r.theme || 'auto';
  } catch (e) {}
}

// ----------------------------------------------------------------
// 接管开关
// ----------------------------------------------------------------
let newtabOverrideEnabled = true;
async function loadOverridePref() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEYS.NEWTAB_OVERRIDE_ENABLED);
    const v = r && r[STORAGE_KEYS.NEWTAB_OVERRIDE_ENABLED];
    if (v === false) newtabOverrideEnabled = false;
  } catch (e) {}
}

function renderDisabledFallback() {
  document.body.classList.add('nt-override-disabled');
  const main = document.querySelector('.nt-main');
  if (main) main.style.display = 'none';
  const root = document.querySelector('body');
  if (!root) return;
  const fallback = document.createElement('div');
  fallback.className = 'nt-disabled-card';
  fallback.innerHTML = `
    <div class="nt-disabled-title">已关闭新标签页接管</div>
    <p class="nt-disabled-desc">在 <a id="ntGoSettings" href="#">扩展设置</a> 里重新启用。或者在地址栏输入网址。</p>
  `;
  root.appendChild(fallback);
  const link = document.getElementById('ntGoSettings');
  if (link) link.addEventListener('click', (e) => {
    e.preventDefault();
    try { chrome.runtime.openOptionsPage(); }
    catch (err) { window.open(chrome.runtime.getURL('settings.html'), '_blank'); }
  });
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

    items.forEach((item, idx) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'nt-dial-card';
      card.style.setProperty('--enter-delay', (idx * 30) + 'ms');
      card.title = `${item.title || ''}\n${item.url || ''}`;
      card.dataset.url = item.url || '';

      const iconWrap = document.createElement('div');
      iconWrap.className = 'nt-dial-icon';
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      iconWrap.appendChild(img);

      const label = document.createElement('div');
      label.className = 'nt-dial-label';
      label.textContent = item.title || hostOf(item.url) || '(无标题)';

      card.appendChild(iconWrap);
      card.appendChild(label);

      // 装上 favicon + 默认图检测兜底
      applyFaviconWithFallback(img, item.url, hostOf(item.url));

      card.addEventListener('click', (e) => openUrl(item.url, e.metaKey || e.ctrlKey, { title: '正在打开 ' + (item.title || '') }));
      card.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); openUrl(item.url, true); } });

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

// ----------------------------------------------------------------
// 搜索
// ----------------------------------------------------------------
let searchDebounceTimer = null;
let currentSearchToken = 0;
let filteredResults = [];
let selectedIndex = -1;
let searchEngineConfig = { enabled: false, engine: 'google', customUrl: '' };

// IME 状态：和 overlay 一致
let imeComposing = false;
let imeSuppressEnterUntil = 0;

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

// newtab 的搜索引擎兜底语义和 overlay 不同：
//   overlay：用户在设置里启用 enabled 才显示（默认关闭，避免无意中把查询泄露给搜索引擎）
//   newtab：作为 launcher 类页面，搜索引擎兜底是默认行为（类似 Chrome 原生新标签页就内置 Google 搜索）
//          没配置时用 Google；用户在设置里改了引擎/自定义 URL 也跟着用
function resolveSearchEngine() {
  const c = searchEngineConfig;
  if (c.engine === 'custom') {
    const tpl = (c.customUrl || '').trim();
    if (tpl && tpl.indexOf('{q}') !== -1 && /^https?:\/\//i.test(tpl)) {
      return { label: '自定义', url: tpl };
    }
    // 自定义但 URL 无效：退回 Google（newtab 必有兜底）
    return SEARCH_ENGINE_PRESETS.google;
  }
  return SEARCH_ENGINE_PRESETS[c.engine] || SEARCH_ENGINE_PRESETS.google;
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

  const bookmarkResults = Array.isArray(items) ? items : [];
  const query = (document.getElementById('ntQuery').value || '').trim();

  // 渲染书签结果
  bookmarkResults.forEach((bm) => {
    const row = document.createElement('div');
    row.className = 'nt-result';
    row.setAttribute('role', 'option');

    const iconImg = document.createElement('img');
    iconImg.className = 'nt-result-icon';
    iconImg.alt = '';
    iconImg.loading = 'lazy';
    iconImg.referrerPolicy = 'no-referrer';

    const body = document.createElement('div');
    body.className = 'nt-result-body';
    body.innerHTML = `
      <div class="nt-result-title">${escapeHtml(bm.title || '(无标题)')}</div>
      <div class="nt-result-subtitle">${bm.path ? escapeHtml(bm.path) + ' · ' : ''}${escapeHtml(bm.url || '')}</div>
    `;

    row.appendChild(iconImg);
    row.appendChild(body);

    applyFaviconWithFallback(iconImg, bm.url, hostOf(bm.url));
    resultsEl.appendChild(row);
  });

  // 追加搜索引擎兜底行：query 非空就显示（newtab 永远兜底，与 overlay 不同）
  let fallbackEntry = null;
  if (query) {
    const info = resolveSearchEngine();
    const fallbackUrl = info ? buildSearchEngineUrl(query) : '';
    if (info && fallbackUrl) {
      fallbackEntry = { __fallback: true, url: fallbackUrl, query, label: info.label };
      const row = document.createElement('div');
      row.className = 'nt-result nt-result-fallback';
      row.setAttribute('role', 'option');
      row.innerHTML = `
        <div class="nt-result-icon nt-result-icon-search">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        </div>
        <div class="nt-result-body">
          <div class="nt-result-title">在 <strong>${escapeHtml(info.label)}</strong> 搜索 <span class="nt-result-q">${escapeHtml(query)}</span></div>
          <div class="nt-result-subtitle">${bookmarkResults.length > 0 ? '在结果里没找到？继续到搜索引擎' : '按 Enter 直接跳转'}</div>
        </div>
        <kbd class="nt-result-kbd">Enter</kbd>
      `;
      resultsEl.appendChild(row);
    }
  }

  // 合并选中索引数组：先书签结果，再 fallback
  filteredResults = bookmarkResults.slice();
  if (fallbackEntry) filteredResults.push(fallbackEntry);

  // 给所有 row 标 index + click + hover；fallback 行永远是最后一个
  const rows = resultsEl.querySelectorAll('.nt-result');
  rows.forEach((row, idx) => {
    row.dataset.index = String(idx);
    row.addEventListener('click', (e) => {
      const item = filteredResults[idx];
      if (!item) return;
      if (item.__fallback) openUrl(item.url, false, { title: '在 ' + (item.label || '搜索引擎') + ' 搜索' });
      else openUrl(item.url, e.metaKey || e.ctrlKey, { title: '正在打开 ' + (item.title || '') });
    });
    row.addEventListener('mouseenter', () => { selectedIndex = idx; updateSelection(); });
  });

  if (filteredResults.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'nt-result-empty';
    empty.textContent = '未找到匹配的书签';
    resultsEl.appendChild(empty);
    selectedIndex = -1;
  } else {
    selectedIndex = 0;
  }
  resultsEl.classList.add('is-visible');
  updateSelection();
}

function updateSelection() {
  const resultsEl = document.getElementById('ntResults');
  if (!resultsEl) return;
  const rows = resultsEl.querySelectorAll('.nt-result');
  rows.forEach((row, i) => row.classList.toggle('is-selected', i === selectedIndex));
  if (selectedIndex >= 0 && rows[selectedIndex]) {
    rows[selectedIndex].scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
}

async function handleSearch(query) {
  const token = ++currentSearchToken;
  const safe = String(query || '').trim();
  if (!safe) { clearResults(); return; }
  try {
    const resp = await sendMessagePromise({ action: MESSAGE_ACTIONS.SEARCH_BOOKMARKS, query: safe, limit: RESULTS_LIMIT });
    if (token !== currentSearchToken) return;
    if (!resp || resp.success === false) { renderResults([]); return; }
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

  // IME composition：和 overlay 同款，Enter 在 composition 中只是确认拼音不开网址
  input.addEventListener('compositionstart', () => { imeComposing = true; });
  input.addEventListener('compositionend', () => {
    imeComposing = false;
    // composition 结束后短窗口里抑制一次 Enter（macOS 内置 IME 偶尔伪造一个 Enter）
    imeSuppressEnterUntil = Date.now() + 50;
  });

  input.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => handleSearch(e.target.value), 120);
  });

  input.addEventListener('keydown', (e) => {
    // IME 期间方向 / Enter 全部交给 IME，不抢
    if (imeComposing || e.isComposing || e.keyCode === 229) return;

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
      // composition 刚结束的伪 Enter：吞一次
      if (imeSuppressEnterUntil && Date.now() < imeSuppressEnterUntil) {
        e.preventDefault();
        imeSuppressEnterUntil = 0;
        return;
      }
      e.preventDefault();
      if (selectedIndex >= 0 && filteredResults[selectedIndex]) {
        const item = filteredResults[selectedIndex];
        if (item.__fallback) openUrl(item.url, false, { title: '在 ' + (item.label || '搜索引擎') + ' 搜索' });
        else openUrl(item.url, e.metaKey || e.ctrlKey, { title: '正在打开 ' + (item.title || '') });
      }
    } else if (e.key === 'Escape') {
      if (input.value) {
        input.value = '';
        clearResults();
      }
    }
  });

  // 全局快捷键聚焦
  document.addEventListener('keydown', (e) => {
    if (e.target === input) return;
    if (imeComposing || e.isComposing) return;
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      input.focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      input.focus(); input.select();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
      // Ctrl/Cmd+Space：和扩展全局快捷键一致，但浏览器 chrome 会捕获 Cmd+Space（IME）
      // 这里只能拦截到的部分情况下 focus 输入框
      e.preventDefault();
      input.focus(); input.select();
    }
  });
}

// 接收 background.js 转发的 TOGGLE_SEARCH（来自全局 Ctrl+Space）
function setupRuntimeListener() {
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.action === MESSAGE_ACTIONS.TOGGLE_SEARCH) {
        const input = document.getElementById('ntQuery');
        if (input) { input.focus(); input.select(); }
        try { sendResponse({ success: true }); } catch (e) {}
        return false;
      }
      return false;
    });
  } catch (e) {}
}

// ----------------------------------------------------------------
// Footer 按钮
// ----------------------------------------------------------------
function setupFooter() {
  const openSettings = document.getElementById('ntOpenSettings');
  if (openSettings) {
    openSettings.addEventListener('click', () => {
      try { chrome.runtime.openOptionsPage(); }
      catch (e) { window.open(chrome.runtime.getURL('settings.html'), '_blank'); }
    });
  }
  const openManager = document.getElementById('ntOpenManager');
  if (openManager) {
    openManager.addEventListener('click', () => {
      try { chrome.tabs.create({ url: 'chrome://bookmarks/' }); }
      catch (e) { window.location.href = 'chrome://bookmarks/'; }
    });
  }
}

// ----------------------------------------------------------------
// 启动
// ----------------------------------------------------------------
async function init() {
  await Promise.all([loadOverridePref(), loadThemePref()]);

  if (!newtabOverrideEnabled) {
    renderDisabledFallback();
    return;
  }

  tickClock();
  setInterval(tickClock, 30_000);

  // auto 主题：系统切换浅/深色时立即重渲 mood，避免等到下个 30s tick
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => { if (themePref === 'auto') tickClock(); });
  } catch (e) {}

  // 入场动画解除：data-loaded 触发 main 元素的 fade-up
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.dataset.loaded = '1'));

  await Promise.all([loadSearchEngineConfig(), loadSpeedDial()]);

  setupSearch();
  setupFooter();
  setupRuntimeListener();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      if (changes.searchEngineFallback) loadSearchEngineConfig();
      if (changes.theme) {
        const v = changes.theme.newValue;
        themePref = typeof v === 'string' ? v : 'auto';
        tickClock();
      }
      if (changes[STORAGE_KEYS.NEWTAB_OVERRIDE_ENABLED]) {
        // 改了接管开关后下次开新标签页才生效；当前页提示一下
        const v = changes[STORAGE_KEYS.NEWTAB_OVERRIDE_ENABLED].newValue;
        if (v === false && !document.body.classList.contains('nt-override-disabled')) {
          // 不强制刷新，只是给个轻提示
        }
      }
    });
  } catch (e) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
