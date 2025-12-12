console.log("[Popup] popup.js 开始加载");

// 特殊页面协议列表
const SPECIAL_PROTOCOLS = ['chrome://', 'edge://', 'about:', 'chrome-extension://', 'edge-extension://'];

// 初始化
async function init() {
  console.log("[Popup] 初始化开始");
  const isMac = /Mac/i.test(navigator.userAgent || '');
  
  try {
    // 检测当前页面状态
    await checkCurrentPageStatus();
    
    // 加载快捷键信息
    await loadShortcutInfo(isMac);
    
    // 加载书签数量
    await loadBookmarkCount();
    
    // 加载同步时间信息
    await loadSyncTimes();
    
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
async function loadShortcutInfo(isMac) {
  try {
    const commands = await chrome.commands.getAll();
    const toggleCommand = commands.find(cmd => cmd.name === 'toggle-overlay');
    
    const shortcutElement = document.getElementById('shortcut');
    const footerHint = document.getElementById('footerHint');
    
    if (toggleCommand && toggleCommand.shortcut) {
      const rawShortcut = toggleCommand.shortcut;
      // 替换快捷键中的特殊键名
      const shortcut = rawShortcut
        .replace('Ctrl', 'Ctrl')
        .replace('Alt', 'Alt')
        .replace('Shift', 'Shift')
        .replace('Command', '⌘');
      
      shortcutElement.innerHTML = `<span class="kbd">${shortcut}</span>`;
      
      const lowerShortcut = rawShortcut.toLowerCase();
      const isSpaceCombo = lowerShortcut.includes('space');
      const isApprovedSpaceCombo = /command\+space|ctrl\+space/.test(lowerShortcut);
      
      if (isSpaceCombo && !isApprovedSpaceCombo) {
        footerHint.innerHTML = isMac
          ? `<div class="hint-line"><span class="hint-title">⚠️ 当前组合不被支持</span><span class="hint-sep">请改为</span><kbd class="kbd">Command+Space</kbd><span class="hint-sep">或</span><kbd class="kbd">Command+Shift+Q</kbd></div>`
          : `<div class="hint-line"><span class="hint-title">⚠️ 当前组合不被支持</span><span class="hint-sep">请改为</span><kbd class="kbd">Ctrl+Shift+Q</kbd><span class="hint-sep">或</span><kbd class="kbd">Ctrl+Space</kbd></div>`;
      } else {
        footerHint.innerHTML = `<div class="hint-line">按 <kbd class="kbd">${shortcut}</kbd> 在任意页面快速搜索</div>`;
      }
      
      console.log("[Popup] 快捷键:", shortcut);
    } else {
      shortcutElement.innerHTML = '<span class="kbd">未设置</span>';
      footerHint.innerHTML = isMac
        ? `<div class="hint-title">⚠️ 快捷键未设置，请在设置中配置</div>
           <div class="hint-line">推荐：<kbd class="kbd">Command+Space</kbd><span class="hint-sep">或</span><kbd class="kbd">Command+Shift+Q</kbd></div>`
        : `<div class="hint-title">⚠️ 快捷键未设置，请在设置中配置</div>
           <div class="hint-line">推荐：<kbd class="kbd">Ctrl+Shift+Q</kbd><span class="hint-sep">或</span><kbd class="kbd">Ctrl+Space</kbd></div>`;
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

// 格式化相对时间
function formatRelativeTime(timestamp) {
  if (!timestamp) return '从未';
  
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  
  const date = new Date(timestamp);
  return date.toLocaleDateString('zh-CN');
}

// 格式化未来时间
function formatFutureTime(timestamp) {
  if (!timestamp) return '未知';
  
  const now = Date.now();
  const diff = timestamp - now;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (diff < 0) return '即将';
  if (minutes < 1) return '1分钟内';
  if (minutes < 60) return `${minutes}分钟后`;
  if (hours < 24) return `${hours}小时后`;
  
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// 加载同步时间信息
async function loadSyncTimes() {
  try {
    const result = await chrome.storage.local.get(['lastSyncTime', 'syncInterval']);
    const lastSyncElement = document.getElementById('lastSyncTime');
    const nextSyncElement = document.getElementById('nextSyncTime');
    
    // 显示最后同步时间
    if (result.lastSyncTime) {
      lastSyncElement.textContent = formatRelativeTime(result.lastSyncTime);
      console.log("[Popup] 最后同步:", new Date(result.lastSyncTime).toLocaleString());
    } else {
      lastSyncElement.textContent = '从未';
    }
    
    // 计算并显示下次同步时间
    if (result.lastSyncTime && result.syncInterval) {
      const nextSyncTime = result.lastSyncTime + (result.syncInterval * 60 * 1000);
      nextSyncElement.textContent = formatFutureTime(nextSyncTime);
      console.log("[Popup] 下次同步:", new Date(nextSyncTime).toLocaleString());
    } else {
      // 如果没有最后同步时间，获取alarm信息
      const alarms = await chrome.alarms.getAll();
      const syncAlarm = alarms.find(alarm => alarm.name === 'syncBookmarks');
      
      if (syncAlarm && syncAlarm.scheduledTime) {
        nextSyncElement.textContent = formatFutureTime(syncAlarm.scheduledTime);
      } else {
        nextSyncElement.textContent = '未设置';
      }
    }
  } catch (error) {
    console.error("[Popup] 加载同步时间失败:", error);
    document.getElementById('lastSyncTime').textContent = '错误';
    document.getElementById('nextSyncTime').textContent = '错误';
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
      
      // 重新加载书签数量和同步时间
      await loadBookmarkCount();
      await loadSyncTimes();
      
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
