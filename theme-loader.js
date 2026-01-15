import { THEMES, DEFAULT_THEME, THEME_CACHE_KEY, getCurrentTheme, saveTheme } from './theme-service.js';

// 重新导出 getCurrentTheme 供外部使用
export { getCurrentTheme };

// 设置并应用主题
export async function setTheme(themeName) {
  if (!THEMES[themeName]) themeName = DEFAULT_THEME;
  // 保存设置（委托给 theme-service）
  await saveTheme(themeName);
  applyTheme(themeName);
}

// 应用主题（加载对应的CSS文件）
function applyTheme(themeName) {
  const page = document.body.dataset.page || 'popup';
  const expectedHref = `themes/${page}-${themeName}.css`;
  
  const currentLink = document.getElementById('theme-css');
  
  // 检查是否已经是当前主题（防止初始化时重复加载或刷新）
  if (currentLink && currentLink.href.includes(expectedHref)) {
    // 即使是当前主题，也要确保 body class 正确
    document.body.classList.add('theme-ready');
    updateThemeSelector(themeName);
    return;
  }
  
  // 如果当前已经有主题CSS（说明不是第一次加载，而是切换），则刷新页面
  // TODO [技术债]: 考虑使用 CSS 变量或动态替换 <link> href 实现无刷新切换
  if (currentLink) {
    // 先更新缓存，确保刷新后加载新主题
    localStorage.setItem(THEME_CACHE_KEY, themeName);
    location.reload();
    return;
  }

  // 下面是初始化时的逻辑（首次加载）
  const link = document.createElement('link');
  link.id = 'theme-css';
  link.rel = 'stylesheet';
  link.href = expectedHref;
  
  link.onload = () => {
    document.body.classList.add('theme-ready');
  };
  
  document.head.appendChild(link);
  
  // 更新 localStorage 缓存
  localStorage.setItem(THEME_CACHE_KEY, themeName);
  updateThemeSelector(themeName);
}

function updateThemeSelector(themeName) {
  document.querySelectorAll('.theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === themeName);
  });
}

// 初始化主题（从 storage 同步到 localStorage）
async function initTheme() {
  const theme = await getCurrentTheme();
  // 检查当前加载的 CSS 是否正确
  const currentLink = document.getElementById('theme-css');
  const page = document.body.dataset.page || 'popup';
  const expectedHref = `themes/${page}-${theme}.css`;
  
  if (!currentLink || !currentLink.href.endsWith(expectedHref)) {
    applyTheme(theme);
  } else {
    document.body.classList.add('theme-ready');
  }
  
  // 更新主题选择器UI
  document.querySelectorAll('.theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === theme);
  });
}

// 监听主题变化（跨页面同步）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.theme) {
    localStorage.setItem(THEME_CACHE_KEY, changes.theme.newValue);
    applyTheme(changes.theme.newValue);
  }
});

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', initTheme);
