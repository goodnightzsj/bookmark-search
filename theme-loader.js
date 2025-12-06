// 主题加载器
const THEMES = {
  original: { name: '经典渐变', preview: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
  minimal: { name: '极简白', preview: '#ffffff' },
  glass: { name: '毛玻璃', preview: 'linear-gradient(135deg, #E0C3FC 0%, #8EC5FC 100%)' },
  dark: { name: '深色', preview: '#0a0a0a' }
};

const DEFAULT_THEME = 'original';
const THEME_CACHE_KEY = 'bookmark-search-theme';

// 获取当前主题
async function getCurrentTheme() {
  try {
    const result = await chrome.storage.local.get(['theme']);
    const theme = result.theme || DEFAULT_THEME;
    // 同步到 localStorage 作为缓存（用于快速加载）
    localStorage.setItem(THEME_CACHE_KEY, theme);
    return theme;
  } catch (e) {
    return localStorage.getItem(THEME_CACHE_KEY) || DEFAULT_THEME;
  }
}

// 设置主题
async function setTheme(themeName) {
  if (!THEMES[themeName]) themeName = DEFAULT_THEME;
  // 同时保存到 storage 和 localStorage
  localStorage.setItem(THEME_CACHE_KEY, themeName);
  await chrome.storage.local.set({ theme: themeName });
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
