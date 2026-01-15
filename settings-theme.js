import { getCurrentTheme, setTheme } from './theme-loader.js';

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
  document.getElementById('themeGrid').addEventListener('click', async (e) => {
    const option = e.target.closest('.theme-option');
    if (!option) return;
    
    const theme = option.dataset.theme;
    await setTheme(theme);
    console.log("[Settings] 主题已切换为:", theme);
    
    // 更新UI选中状态
    document.querySelectorAll('.theme-option').forEach(el => {
      el.classList.toggle('active', el.dataset.theme === theme);
    });
  });
}
