import { getCurrentTheme, setTheme } from './theme-loader.js';
import { THEMES } from './theme-service.js';

function notify(message, type = 'success') {
  try {
    if (typeof window !== 'undefined' && typeof window.__bsShowToast === 'function') {
      window.__bsShowToast(message, { type });
    }
  } catch (e) {}
}

/**
 * 初始化主题选择器
 */
export async function initThemeSelector() {
  const currentTheme = await getCurrentTheme();

  // 标记当前主题
  document.querySelectorAll('.theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === currentTheme);
  });

  // 绑定点击事件
  const themeGrid = document.getElementById('themeGrid');
  if (!themeGrid) return;
  themeGrid.addEventListener('click', async (e) => {
    const option = e.target.closest('.theme-option');
    if (!option) return;

    const theme = option.dataset.theme;
    const displayName = (THEMES[theme] && THEMES[theme].name) || theme;
    try {
      await setTheme(theme);
      notify('已切换至「' + displayName + '」主题');
      console.log("[Settings] 主题已切换为:", theme);
    } catch (error) {
      console.error("[Settings] 主题切换失败:", error);
      notify('主题切换失败：' + (error && error.message ? error.message : String(error)), 'error');
    }
  });
}
