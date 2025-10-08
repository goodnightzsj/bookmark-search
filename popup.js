console.log("[Popup] popup.js 开始加载");

// 特殊页面协议列表
const SPECIAL_PROTOCOLS = ['chrome://', 'edge://', 'about:', 'chrome-extension://', 'edge-extension://'];

// 初始化
async function init() {
  console.log("[Popup] 初始化开始");
  
  try {
    // 检测当前页面状态
    await checkCurrentPageStatus();
    
    // 加载快捷键信息
    await loadShortcutInfo();
    
    // 加载书签数量
    await loadBookmarkCount();
    
    // 绑定事件
    bindEvents();
    
    console.log("[Popup] 初始化完成");
  } catch (error) {
    console.error("[Popup] 初始化失败:", error);
  }
}

// 检测当前页面状态
async function checkCurrentPageStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    
    if (!tab || !tab.url) {
      setStatus(statusIndicator, statusText, false, '未知');
      return;
    }
    
    const isSpecialPage = SPECIAL_PROTOCOLS.some(protocol => tab.url.startsWith(protocol));
    
    if (isSpecialPage) {
      setStatus(statusIndicator, statusText, false, '不支持');
      console.log("[Popup] 当前是特殊页面，不支持搜索");
    } else {
      setStatus(statusIndicator, statusText, true, '支持');
      console.log("[Popup] 当前页面支持搜索");
    }
  } catch (error) {
    console.error("[Popup] 检测页面状态失败:", error);
    setStatus(document.getElementById('statusIndicator'), document.getElementById('statusText'), false, '错误');
  }
}

// 设置状态显示
function setStatus(indicator, textElement, isSupported, text) {
  if (isSupported) {
    indicator.classList.add('active');
    indicator.classList.remove('inactive');
  } else {
    indicator.classList.add('inactive');
    indicator.classList.remove('active');
  }
  textElement.textContent = text;
}

// 加载快捷键信息
async function loadShortcutInfo() {
  try {
    const commands = await chrome.commands.getAll();
    const toggleCommand = commands.find(cmd => cmd.name === 'toggle-overlay');
    
    const shortcutElement = document.getElementById('shortcut');
    const footerHint = document.getElementById('footerHint');
    
    if (toggleCommand && toggleCommand.shortcut) {
      // 替换快捷键中的特殊键名
      const shortcut = toggleCommand.shortcut
        .replace('Ctrl', 'Ctrl')
        .replace('Alt', 'Alt')
        .replace('Shift', 'Shift')
        .replace('Command', '⌘');
      
      shortcutElement.innerHTML = `<span class="kbd">${shortcut}</span>`;
      
      // 检查是否包含 Space 键（浏览器不支持）
      if (shortcut.includes('Space')) {
        footerHint.innerHTML = '⚠️ <kbd class="kbd">' + shortcut + '</kbd> 不被浏览器支持，请在设置中修改为 <kbd class="kbd">Ctrl+Shift+F</kbd>';
      } else {
        footerHint.innerHTML = `按 <kbd class="kbd">${shortcut}</kbd> 在任意页面快速搜索`;
      }
      
      console.log("[Popup] 快捷键:", shortcut);
    } else {
      shortcutElement.innerHTML = '<span class="kbd">未设置</span>';
      footerHint.innerHTML = '⚠️ 快捷键未设置，请在设置中配置（推荐：<kbd class="kbd">Ctrl+Shift+F</kbd>）';
      console.warn("[Popup] 未找到快捷键配置");
    }
  } catch (error) {
    console.error("[Popup] 加载快捷键失败:", error);
    document.getElementById('shortcut').innerHTML = '<span class="kbd">加载失败</span>';
  }
}

// 加载书签数量
async function loadBookmarkCount() {
  try {
    const result = await chrome.storage.local.get(['bookmarks']);
    const countElement = document.getElementById('bookmarkCount');
    
    if (result.bookmarks && Array.isArray(result.bookmarks)) {
      const count = result.bookmarks.length;
      countElement.textContent = count;
      console.log("[Popup] 书签数量:", count);
    } else {
      countElement.textContent = '0';
      console.warn("[Popup] 未找到书签数据");
    }
  } catch (error) {
    console.error("[Popup] 加载书签数量失败:", error);
    document.getElementById('bookmarkCount').textContent = '!';
  }
}

// 绑定事件
function bindEvents() {
  // 打开设置页面
  document.getElementById('openSettings').addEventListener('click', () => {
    console.log("[Popup] 打开设置页面");
    chrome.runtime.openOptionsPage();
  });
  
  // 刷新书签
  document.getElementById('refreshBookmarks').addEventListener('click', async () => {
    console.log("[Popup] 刷新书签");
    const btn = document.getElementById('refreshBookmarks');
    const originalText = btn.innerHTML;
    
    btn.innerHTML = '<span class="icon">⏳</span> 刷新中...';
    btn.disabled = true;
    
    try {
      // 发送消息给 background 刷新书签
      await chrome.runtime.sendMessage({ action: 'refreshBookmarks' });
      
      // 重新加载书签数量
      await loadBookmarkCount();
      
      btn.innerHTML = '<span class="icon">✓</span> 刷新成功';
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
      }, 1500);
    } catch (error) {
      console.error("[Popup] 刷新书签失败:", error);
      btn.innerHTML = '<span class="icon">✗</span> 刷新失败';
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
      }, 1500);
    }
  });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
