import { formatRelativeTime, formatFutureTime, SPECIAL_PROTOCOLS } from './utils.js';
import { MESSAGE_ACTIONS } from './constants.js';
import { assertSuccessfulMessageResponse } from './message-response.js';

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
    // 并行加载各模块数据（互不依赖）
    await Promise.all([
      checkCurrentPageStatus(),
      loadShortcutInfo(isMac),
      loadPopupStatus()
    ]);

    // 绑定事件
    bindEvents();

    console.log("[Popup] 初始化完成");
  } catch (error) {
    console.error("[Popup] 初始化失败:", error);
  }
}

// 通过 sendMessage 从 background 拉取 popup 所需数据（取代 storage.onChanged 订阅）
async function loadPopupStatus() {
  try {
    const response = assertSuccessfulMessageResponse(
      await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.GET_POPUP_STATUS }),
      '加载状态失败'
    );
    applyBookmarkCount(response.bookmarkCount);
    applySyncTimes(response.lastSyncTime, response.syncInterval, response.nextSyncScheduledTime);
  } catch (error) {
    console.error("[Popup] 加载 popup 状态失败:", error);
    const countEl = document.getElementById('bookmarkCount');
    if (countEl) countEl.textContent = '!';
    const lastEl = document.getElementById('lastSyncTime');
    if (lastEl) lastEl.textContent = '错误';
    const nextEl = document.getElementById('nextSyncTime');
    if (nextEl) nextEl.textContent = '错误';
  }
}

function applyBookmarkCount(countValue) {
  const countElement = document.getElementById('bookmarkCount');
  if (!countElement) return;
  const count = (typeof countValue === 'number' && Number.isFinite(countValue)) ? countValue : 0;
  countElement.textContent = count;
  console.log("[Popup] 书签数量:", count);
}

function applySyncTimes(lastSyncTime, syncInterval, nextSyncScheduledTime) {
  const lastSyncElement = document.getElementById('lastSyncTime');
  const nextSyncElement = document.getElementById('nextSyncTime');
  if (!lastSyncElement || !nextSyncElement) return;

  if (lastSyncTime) {
    lastSyncElement.textContent = formatRelativeTime(lastSyncTime);
    console.log("[Popup] 最后同步:", new Date(lastSyncTime).toLocaleString());
  } else {
    lastSyncElement.textContent = '从未';
  }

  if (syncInterval === 0) {
    nextSyncElement.textContent = '已禁用';
  } else if (lastSyncTime && syncInterval) {
    const nextSyncTime = lastSyncTime + (syncInterval * 60 * 1000);
    nextSyncElement.textContent = formatFutureTime(nextSyncTime);
    console.log("[Popup] 下次同步:", new Date(nextSyncTime).toLocaleString());
  } else if (nextSyncScheduledTime) {
    nextSyncElement.textContent = formatFutureTime(nextSyncScheduledTime);
  } else {
    nextSyncElement.textContent = '未设置';
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
      const result = assertSuccessfulMessageResponse(
        await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.REFRESH_BOOKMARKS }),
        '刷新失败',
        { allowSkipped: true }
      );

      // 刷新完成后一次性拉取所有状态
      await loadPopupStatus();

      if (label) label.textContent = result && result.skipped ? '已排队' : '刷新成功';
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

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
