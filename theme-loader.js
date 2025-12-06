// 主题加载器
const THEMES = {
  original: { name: '经典渐变', preview: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
  minimal: { name: '极简白', preview: '#ffffff' },
  glass: { name: '毛玻璃', preview: 'linear-gradient(135deg, #E0C3FC 0%, #8EC5FC 100%)' },
  dark: { name: '深色', preview: '#0a0a0a' }
};

const DEFAULT_THEME = 'original';

// 获取当前主题
async function getCurrentTheme() {
  try {
    const result = await chrome.storage.local.get(['theme']);
    return result.theme || DEFAULT_THEME;
  } catch (e) {
    return DEFAULT_THEME;
  }
}

// 设置主题
async function setTheme(themeName) {
  if (!THEMES[themeName]) themeName = DEFAULT_THEME;
  await chrome.storage.local.set({ theme: themeName });
  applyTheme(themeName);
}

// 应用主题（加载对应的CSS文件）
function applyTheme(themeName) {
  const page = document.body.dataset.page || 'popup';
  const cssFile = `themes/${page}-${themeName}.css`;
  
  // 移除旧的主题样式
  const oldLink = document.getElementById('theme-css');
  if (oldLink) oldLink.remove();
  
  // 添加新的主题样式
  const link = document.createElement('link');
  link.id = 'theme-css';
  link.rel = 'stylesheet';
  link.href = cssFile;
  document.head.appendChild(link);
  
  // 更新主题选择器UI（如果存在）
  document.querySelectorAll('.theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === themeName);
  });
}

// 初始化主题
async function initTheme() {
  const theme = await getCurrentTheme();
  applyTheme(theme);
}

// 监听主题变化（跨页面同步）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.theme) {
    applyTheme(changes.theme.newValue);
  }
});

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', initTheme);
