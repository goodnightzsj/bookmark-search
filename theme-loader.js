import { THEMES, DEFAULT_THEME, THEME_CACHE_KEY, getCurrentTheme, saveTheme, resolveActiveTheme } from './theme-service.js';

// 重新导出 getCurrentTheme 供外部使用
export { getCurrentTheme };

let themeLoadToken = 0;
// 防止 storage change listener 重复应用本 tab 刚刚设置的主题
let lastAppliedBySetTheme = '';
// 缓存 theme selector DOM 引用，避免重复查询
let cachedThemeOptions = null;
// 当前用户选择的原始主题名（含 'auto'）。auto 下根据 prefers-color-scheme 解析
let currentRawTheme = DEFAULT_THEME;
let autoMediaQuery = null;
let autoMediaListenerBound = false;

function getThemeOptions() {
  if (!cachedThemeOptions) {
    cachedThemeOptions = document.querySelectorAll('.theme-option');
  }
  return cachedThemeOptions;
}

// 设置并应用主题
export async function setTheme(themeName) {
  if (!THEMES[themeName]) themeName = DEFAULT_THEME;
  lastAppliedBySetTheme = themeName;
  currentRawTheme = themeName;
  ensureAutoMediaListener();
  // 保存设置（委托给 theme-service）
  try {
    await saveTheme(themeName);
  } catch (error) {
    if (lastAppliedBySetTheme === themeName) {
      lastAppliedBySetTheme = '';
    }
    throw error;
  }
  applyTheme(themeName);
}

function ensureAutoMediaListener() {
  if (autoMediaListenerBound) return;
  if (typeof matchMedia !== 'function') return;
  try {
    autoMediaQuery = matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (currentRawTheme === 'auto') applyTheme('auto');
    };
    if (typeof autoMediaQuery.addEventListener === 'function') {
      autoMediaQuery.addEventListener('change', handler);
    } else if (typeof autoMediaQuery.addListener === 'function') {
      autoMediaQuery.addListener(handler);
    }
    autoMediaListenerBound = true;
  } catch (e) {}
}

// 应用主题（加载对应的CSS文件）
function applyTheme(themeName) {
  currentRawTheme = THEMES[themeName] ? themeName : DEFAULT_THEME;
  const prefersDark = !!(autoMediaQuery && autoMediaQuery.matches)
    || !!(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = resolveActiveTheme(currentRawTheme, prefersDark);
  const page = document.body.dataset.page || 'popup';
  const expectedHref = `themes/${page}-${resolved}.css`;

  const currentLink = document.getElementById('theme-css');
  const token = ++themeLoadToken;
  const markReady = () => {
    if (token !== themeLoadToken) return;
    document.body.classList.add('theme-ready');
  };

  // 检查是否已经是当前主题（防止初始化时重复加载或刷新）
  if (currentLink && currentLink.href.includes(expectedHref)) {
    // 即使是当前主题，也要确保 body class 正确
    document.body.classList.add('theme-ready');
    updateThemeSelector(themeName);
    return;
  }

  // 如果当前已经有主题CSS（说明不是第一次加载，而是切换），则直接替换 href
  if (currentLink) {
    currentLink.onload = markReady;
    currentLink.onerror = markReady;
    currentLink.href = expectedHref;

    // 更新缓存
    localStorage.setItem(THEME_CACHE_KEY, themeName);
    updateThemeSelector(themeName);
    return;
  }

  // 下面是初始化时的逻辑（首次加载）
  const link = document.createElement('link');
  link.id = 'theme-css';
  link.rel = 'stylesheet';
  link.href = expectedHref;

  link.onload = markReady;
  link.onerror = markReady;

  document.head.appendChild(link);

  // 更新 localStorage 缓存
  localStorage.setItem(THEME_CACHE_KEY, themeName);
  updateThemeSelector(themeName);
}

function updateThemeSelector(themeName) {
  const options = getThemeOptions();
  options.forEach(el => {
    el.classList.toggle('active', el.dataset.theme === themeName);
  });
}

// 初始化主题（从 storage 同步到 localStorage）
async function initTheme() {
  const theme = await getCurrentTheme();
  currentRawTheme = theme;
  ensureAutoMediaListener();
  // 根据 auto 解析后的目标 CSS 来判定是否需要重新加载
  const prefersDark = !!(autoMediaQuery && autoMediaQuery.matches)
    || !!(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = resolveActiveTheme(theme, prefersDark);
  const currentLink = document.getElementById('theme-css');
  const page = document.body.dataset.page || 'popup';
  const expectedHref = `themes/${page}-${resolved}.css`;

  if (!currentLink || !currentLink.href.endsWith(expectedHref)) {
    applyTheme(theme);
  } else {
    document.body.classList.add('theme-ready');
  }

  // 更新主题选择器UI
  updateThemeSelector(theme);
}

// 监听主题变化（跨页面同步）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.theme) {
    const newTheme = changes.theme.newValue;
    if (!newTheme || !THEMES[newTheme]) return;
    // 跳过本 tab 刚通过 setTheme() 发起的变更，避免重复 applyTheme
    if (lastAppliedBySetTheme === newTheme) {
      lastAppliedBySetTheme = '';
      return;
    }
    localStorage.setItem(THEME_CACHE_KEY, newTheme);
    applyTheme(newTheme);
  }
});

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', initTheme);
