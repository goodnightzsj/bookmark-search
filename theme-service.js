/**
 * 主题服务 - 集中管理主题相关逻辑
 * 整合 theme-loader.js 和 settings-theme.js 的共享常量
 */

import { getValueOrThrow, setStorageOrThrow, STORAGE_KEYS } from './storage-service.js';

// 可用主题配置
export const THEMES = {
  original: {
    name: '经典渐变',
    preview: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    description: '默认紫色渐变主题'
  },
  minimal: {
    name: '极简白',
    preview: '#ffffff',
    description: '简洁明亮的白色主题'
  },
  glass: {
    name: '毛玻璃',
    preview: 'linear-gradient(135deg, #E0C3FC 0%, #8EC5FC 100%)',
    description: '半透明毛玻璃效果'
  },
  dark: {
    name: '深色',
    preview: '#0a0a0a',
    description: '护眼深色主题'
  },
  auto: {
    name: '跟随系统',
    preview: 'linear-gradient(135deg, #fafafa 0%, #0a0a0a 100%)',
    description: '根据系统浅色/深色偏好自动切换'
  }
};

// auto 主题解析出的浅色/深色基准
export const AUTO_DARK_THEME = 'dark';
export const AUTO_LIGHT_THEME = 'original';

// 默认主题
export const DEFAULT_THEME = 'original';

// 将 'auto' 解析为实际用于加载 CSS 的主题名
export function resolveActiveTheme(themeName, matchesDark) {
  if (!THEMES[themeName]) return DEFAULT_THEME;
  if (themeName !== 'auto') return themeName;
  const prefersDark = typeof matchesDark === 'boolean'
    ? matchesDark
    : !!(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  return prefersDark ? AUTO_DARK_THEME : AUTO_LIGHT_THEME;
}

// 本地缓存键（用于快速加载，避免 storage API 延迟）
export const THEME_CACHE_KEY = 'bookmark-search-theme';

/**
 * 获取当前主题名称
 * @returns {Promise<string>} 主题名称
 */
export async function getCurrentTheme() {
  try {
    const theme = await getValueOrThrow(STORAGE_KEYS.THEME);
    const validTheme = THEMES[theme] ? theme : DEFAULT_THEME;
    // 同步到 localStorage 作为缓存
    localStorage.setItem(THEME_CACHE_KEY, validTheme);
    return validTheme;
  } catch (e) {
    const cachedTheme = localStorage.getItem(THEME_CACHE_KEY);
    return THEMES[cachedTheme] ? cachedTheme : DEFAULT_THEME;
  }
}

/**
 * 仅保存主题设置（不应用）
 * 用于需要保存但不立即应用的场景
 * @param {string} themeName - 主题名称
 * @returns {Promise<boolean>} 是否成功
 */
export async function saveTheme(themeName) {
  if (!THEMES[themeName]) {
    themeName = DEFAULT_THEME;
  }
  
  // 先写 chrome.storage；成功后再更新 localStorage 保持一致性
  await setStorageOrThrow({ [STORAGE_KEYS.THEME]: themeName });
  localStorage.setItem(THEME_CACHE_KEY, themeName);
  
  return true;
}

/**
 * 获取主题列表（用于 UI 渲染）
 * @returns {Array} 主题列表
 */
export function getThemeList() {
  return Object.entries(THEMES).map(([id, config]) => ({
    id,
    ...config
  }));
}

/**
 * 验证主题名称是否有效
 * @param {string} themeName - 主题名称
 * @returns {boolean}
 */
export function isValidTheme(themeName) {
  return themeName in THEMES;
}
