import { formatRelativeTime, formatFutureTime, SPECIAL_PROTOCOLS } from './utils.js';
import { ALARM_NAMES } from './constants.js';
import { getStorage, getValue, STORAGE_KEYS } from './storage-service.js';

// 常量定义
const BUTTON_RESET_DELAY_MS = 1500;  // 按钮状态恢复延时

console.log("[Popup] popup.js 开始加载");

// 检测当前页面状态
async function checkCurrentPageStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.url) {
      setStatus('unknown', '无法获取页面信息');
      return;
    }
    
    // 检查是否为特殊页面
    const isSpecialPage = SPECIAL_PROTOCOLS.some(protocol => tab.url.startsWith(protocol));
    
    if (isSpecialPage) {
      setStatus('warning', '特殊页面（需在普通页面使用）');
    } else {
      setStatus('success', '可用');
    }
  } catch (error) {
    console.error("[Popup] 检测页面状态失败:", error);
    setStatus('error', '检测失败');
  }
}

// 设置状态显示
function setStatus(type, text) {
  const indicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  
  if (!indicator || !statusText) return;
  
  // 清除所有状态类
  indicator.className = 'status-indicator';
  
  // 添加对应状态类
  switch (type) {
    case 'success':
      indicator.classList.add('status-success');
      break;
    case 'warning':
      indicator.classList.add('status-warning');
      break;
    case 'error':
      indicator.classList.add('status-error');
      break;
    default:
      indicator.classList.add('status-unknown');
  }
  
  statusText.textContent = text;
}

// 加载快捷键信息
async function loadShortcutInfo(isMac) {
  try {
    const commands = await chrome.commands.getAll();
    const toggleCommand = commands.find(cmd => cmd.name === 'toggle-overlay');
    
    const shortcutElement = document.getElementById('shortcut');
    if (!shortcutElement) return;
    
    // 清空旧内容
    shortcutElement.textContent = '';
    
    if (toggleCommand && toggleCommand.shortcut) {
      const kbd = document.createElement('span');
      kbd.className = 'kbd';
      kbd.textContent = toggleCommand.shortcut;
      shortcutElement.appendChild(kbd);
      console.log("[Popup] 当前快捷键:", toggleCommand.shortcut);
    } else {
      // 显示默认建议
      const defaultKey = isMac ? 'Command+Space' : 'Ctrl+Space';
      const kbd = document.createElement('span');
      kbd.className = 'kbd';
      kbd.textContent = defaultKey;
      const hint = document.createElement('span');
      hint.style.opacity = '0.7';
      hint.textContent = ' (未设置)';
      shortcutElement.appendChild(kbd);
      shortcutElement.appendChild(hint);
    }
  } catch (error) {
    console.error("[Popup] 加载快捷键失败:", error);
  }
}

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

    // 监听 storage 变化，保持展示信息最新
    setupStorageListener();
    
    console.log("[Popup] 初始化完成");
  } catch (error) {
    console.error("[Popup] 初始化失败:", error);
  }
}

// 加载书签数量
async function loadBookmarkCount() {
  const countElement = document.getElementById('bookmarkCount');
  if (!countElement) return;
  
  try {
    const bookmarks = await getValue(STORAGE_KEYS.BOOKMARKS);
    
    const count = Array.isArray(bookmarks) ? bookmarks.length : 0;
    countElement.textContent = count;
    console.log("[Popup] 书签数量:", count);
  } catch (error) {
    console.error("[Popup] 加载书签数量失败:", error);
    document.getElementById('bookmarkCount').textContent = '!';
  }
}



// 加载同步时间信息
async function loadSyncTimes() {
  try {
    const result = await getStorage([STORAGE_KEYS.LAST_SYNC_TIME, STORAGE_KEYS.SYNC_INTERVAL]);
    const lastSyncElement = document.getElementById('lastSyncTime');
    const nextSyncElement = document.getElementById('nextSyncTime');
    
    const lastSyncTime = result[STORAGE_KEYS.LAST_SYNC_TIME];
    const syncInterval = result[STORAGE_KEYS.SYNC_INTERVAL];

    // 显示最后同步时间
    if (lastSyncTime) {
      lastSyncElement.textContent = formatRelativeTime(lastSyncTime);
      console.log("[Popup] 最后同步:", new Date(lastSyncTime).toLocaleString());
    } else {
      lastSyncElement.textContent = '从未';
    }
    
    // 计算并显示下次同步时间
    if (lastSyncTime && syncInterval) {
      const nextSyncTime = lastSyncTime + (syncInterval * 60 * 1000);
      nextSyncElement.textContent = formatFutureTime(nextSyncTime);
      console.log("[Popup] 下次同步:", new Date(nextSyncTime).toLocaleString());
    } else {
      // 如果没有最后同步时间，获取alarm信息
      const alarms = await chrome.alarms.getAll();
      const syncAlarm = alarms.find(alarm => alarm.name === ALARM_NAMES.SYNC_BOOKMARKS);
      
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
    const label = btn.querySelector('.btn-text');
    const originalText = label ? label.textContent : '';
    
    if (label) label.textContent = '刷新中...';
    btn.disabled = true;
    
    try {
      // 发送消息给 background 刷新书签
      const result = await chrome.runtime.sendMessage({ action: 'refreshBookmarks' });
      if (result && result.success === false && !result.skipped) {
        throw new Error(result.error || '刷新失败');
      }
      
      // 重新加载书签数量和同步时间
      await loadBookmarkCount();
      await loadSyncTimes();
      
      if (label) label.textContent = '刷新成功';
      setTimeout(() => {
        if (label) label.textContent = originalText;
        btn.disabled = false;
      }, BUTTON_RESET_DELAY_MS);
    } catch (error) {
      console.error("[Popup] 刷新书签失败:", error);
      if (label) label.textContent = '刷新失败';
      setTimeout(() => {
        if (label) label.textContent = originalText;
        btn.disabled = false;
      }, BUTTON_RESET_DELAY_MS);
    }
  });
}

// 监听存储变化（当 popup 打开时自动刷新显示）
function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.bookmarks) loadBookmarkCount();
    if (changes.lastSyncTime || changes.syncInterval) loadSyncTimes();
  });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
