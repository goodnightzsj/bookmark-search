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

// 所有可加载的主题名（排除 'auto'——它解析为具体主题）
const LOADABLE_THEMES = Object.keys(THEMES).filter((name) => name !== 'auto');
// themeName → HTMLLinkElement 的缓存；所有主题 CSS 预加载 + 通过 disabled 切换，消除切换闪动
const themeLinkCache = new Map();

function ensureThemeLink(themeName) {
  if (themeLinkCache.has(themeName)) return themeLinkCache.get(themeName);
  const page = document.body.dataset.page || 'popup';
  const href = `themes/${page}-${themeName}.css`;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.theme = themeName;
  // 默认禁用；下方 applyTheme 会启用目标主题
  link.disabled = true;
  document.head.appendChild(link);
  themeLinkCache.set(themeName, link);
  return link;
}

// 应用主题：先确保目标 CSS 已加载，再统一关掉其它主题，避免"先无样式再新样式"的 FOUC
function applyTheme(themeName) {
  currentRawTheme = THEMES[themeName] ? themeName : DEFAULT_THEME;
  const prefersDark = !!(autoMediaQuery && autoMediaQuery.matches)
    || !!(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = resolveActiveTheme(currentRawTheme, prefersDark);
  const token = ++themeLoadToken;

  const targetLink = ensureThemeLink(resolved);

  // 一次性完成切换：启用目标 + 禁用其它
  const doSwap = () => {
    if (token !== themeLoadToken) return;
    targetLink.disabled = false;
    for (const name of LOADABLE_THEMES) {
      if (name === resolved) continue;
      const link = themeLinkCache.get(name);
      if (link && !link.disabled) link.disabled = true;
    }
    document.body.classList.add('theme-ready');
  };

  if (targetLink.sheet) {
    // 已经解析过 → 直接瞬切
    doSwap();
  } else {
    // 尚未加载：先启用目标让浏览器开始加载（如果之前是 disabled），
    // 同时保持旧主题 enabled，避免出现"无样式"帧。等新主题 load 后再禁用旧主题。
    targetLink.disabled = false;
    const onReady = () => {
      targetLink.removeEventListener('load', onReady);
      targetLink.removeEventListener('error', onReady);
      doSwap();
    };
    targetLink.addEventListener('load', onReady);
    targetLink.addEventListener('error', onReady);
  }

  localStorage.setItem(THEME_CACHE_KEY, themeName);
  updateThemeSelector(themeName);
}

function updateThemeSelector(themeName) {
  const options = getThemeOptions();
  options.forEach(el => {
    el.classList.toggle('active', el.dataset.theme === themeName);
  });
}

// 初始化主题：应用当前选中主题 + 后台预加载其它主题（消除后续切换延迟）
async function initTheme() {
  const theme = await getCurrentTheme();
  currentRawTheme = theme;
  ensureAutoMediaListener();
  applyTheme(theme);
  // 空闲时间预热其它主题 CSS，后续切换瞬完成
  const idle = (cb) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 2000 }) : setTimeout(cb, 400));
  idle(() => {
    for (const name of LOADABLE_THEMES) ensureThemeLink(name);
  });
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
