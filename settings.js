console.log("[Settings] settings.js 开始加载");

// 初始化
async function init() {
  console.log("[Settings] 初始化开始");

  try {
    // 加载快捷键信息
    await loadShortcutInfo();

    // 加载书签统计
    await loadBookmarkStats();

    // 加载同步设置
    await loadSyncSettings();

    // 加载更新历史
    await loadUpdateHistory();

    // 绑定事件
    bindEvents();

    // 监听存储变化，实现实时更新
    setupStorageListener();

    console.log("[Settings] 初始化完成");
  } catch (error) {
    console.error("[Settings] 初始化失败:", error);
  }
}

// 设置存储监听器，实现实时更新
function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    console.log("[Settings] 存储发生变化:", Object.keys(changes));

    // 书签数据变化时，更新统计
    if (changes.bookmarks) {
      console.log("[Settings] 检测到书签数据变化，重新加载统计");
      loadBookmarkStats();
    }

    // 同步时间变化时，更新显示
    if (changes.lastSyncTime || changes.syncInterval) {
      console.log("[Settings] 检测到同步设置变化，重新加载同步信息");
      loadSyncSettings();
    }

    // 书签历史变化时，更新历史列表
    if (changes.bookmarkHistory) {
      console.log("[Settings] 检测到书签历史变化，重新加载历史");
      loadUpdateHistory();
      
      // 显示更新提示
      showUpdateNotification();
    }
  });

  console.log("[Settings] 存储监听器已设置");
}

// 显示更新通知
function showUpdateNotification() {
  const historyCard = document.querySelector('.card:has(#historyList)');
  if (!historyCard) return;

  // 移除已存在的通知
  const existingNotice = historyCard.querySelector('.update-notice');
  if (existingNotice) {
    existingNotice.remove();
  }

  // 创建通知元素
  const notice = document.createElement('div');
  notice.className = 'alert alert-success update-notice';
  notice.style.marginTop = '12px';
  notice.innerHTML = `
    <span>✓</span>
    <div>书签历史已自动更新</div>
  `;

  // 插入到历史卡片的顶部
  const cardTitle = historyCard.querySelector('.card-title');
  cardTitle.after(notice);

  // 3秒后自动消失
  setTimeout(() => {
    notice.style.transition = 'opacity 0.3s';
    notice.style.opacity = '0';
    setTimeout(() => notice.remove(), 300);
  }, 3000);
}

// 加载快捷键信息
async function loadShortcutInfo() {
  try {
    const commands = await chrome.commands.getAll();
    const toggleCommand = commands.find(cmd => cmd.name === 'toggle-overlay');

    const shortcutInput = document.getElementById('shortcutInput');

    if (toggleCommand && toggleCommand.shortcut) {
      shortcutInput.value = toggleCommand.shortcut;
      console.log("[Settings] 当前快捷键:", toggleCommand.shortcut);

      // 检测快捷键冲突
      await checkShortcutConflicts(toggleCommand.shortcut);
    } else {
      shortcutInput.value = '未设置';
      shortcutInput.placeholder = '点击下方按钮设置快捷键';
      console.warn("[Settings] 快捷键未设置");
    }
  } catch (error) {
    console.error("[Settings] 加载快捷键失败:", error);
  }
}

// 检测快捷键冲突
async function checkShortcutConflicts(shortcut) {
  try {
    const conflictAlert = document.getElementById('shortcutConflict');
    const conflictMessage = document.getElementById('conflictMessage');

    // 常见快捷键冲突列表
    const commonConflicts = {
      'Ctrl+T': 'Chrome 新标签页',
      'Ctrl+N': 'Chrome 新窗口',
      'Ctrl+W': 'Chrome 关闭标签',
      'Ctrl+Tab': 'Chrome 切换标签',
      'Ctrl+F': '页面内搜索',
      'Ctrl+L': '地址栏聚焦',
      'Ctrl+H': 'Chrome 历史记录',
      'Ctrl+D': 'Chrome 添加书签',
      'Ctrl+Shift+T': 'Chrome 恢复关闭的标签',
      'Alt+F4': '关闭窗口',
      'Alt+Tab': '切换窗口'
    };

    // 检测所有已注册的命令
    const allCommands = await chrome.commands.getAll();
    let hasConflict = false;
    let conflictsWith = [];

    // 检测与浏览器内置快捷键的冲突
    if (commonConflicts[shortcut]) {
      hasConflict = true;
      conflictsWith.push(commonConflicts[shortcut]);
    }

    // 检测与其他扩展的冲突
    allCommands.forEach(cmd => {
      if (cmd.name !== 'toggle-overlay' && cmd.shortcut === shortcut) {
        hasConflict = true;
        conflictsWith.push(`其他命令: ${cmd.description || cmd.name}`);
      }
    });

    if (hasConflict) {
      conflictMessage.innerHTML = `
        此快捷键可能与以下功能冲突：<br>
        ${conflictsWith.map(c => `• ${c}`).join('<br>')}
      `;
      conflictAlert.style.display = 'flex';
      console.warn("[Settings] 检测到快捷键冲突:", conflictsWith);
    } else {
      conflictAlert.style.display = 'none';
      console.log("[Settings] 快捷键无冲突");
    }
  } catch (error) {
    console.error("[Settings] 检测快捷键冲突失败:", error);
  }
}

// 加载书签统计
async function loadBookmarkStats() {
  try {
    const result = await chrome.storage.local.get(['bookmarks']);
    const totalElement = document.getElementById('totalBookmarks');

    if (result.bookmarks && Array.isArray(result.bookmarks)) {
      const count = result.bookmarks.length;
      totalElement.textContent = count;
      console.log("[Settings] 书签总数:", count);
    } else {
      totalElement.textContent = '0';
      console.warn("[Settings] 未找到书签数据");
    }
  } catch (error) {
    console.error("[Settings] 加载书签统计失败:", error);
    document.getElementById('totalBookmarks').textContent = '!';
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
  return date.toLocaleString('zh-CN');
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
  return date.toLocaleString('zh-CN');
}

// 加载同步设置
async function loadSyncSettings() {
  try {
    const result = await chrome.storage.local.get(['syncInterval', 'lastSyncTime']);
    const syncIntervalSelect = document.getElementById('syncInterval');
    const lastSyncDisplay = document.getElementById('lastSyncDisplay');
    const nextSyncDisplay = document.getElementById('nextSyncDisplay');
    
    // 设置同步间隔
    const interval = result.syncInterval !== undefined ? result.syncInterval : 30;
    syncIntervalSelect.value = interval;
    console.log("[Settings] 同步间隔:", interval, "分钟");
    
    // 显示最后同步时间
    if (result.lastSyncTime) {
      lastSyncDisplay.textContent = formatRelativeTime(result.lastSyncTime);
    } else {
      lastSyncDisplay.textContent = '从未';
    }
    
    // 计算并显示下次同步时间
    if (interval > 0) {
      if (result.lastSyncTime) {
        const nextSyncTime = result.lastSyncTime + (interval * 60 * 1000);
        nextSyncDisplay.textContent = formatFutureTime(nextSyncTime);
      } else {
        // 如果没有最后同步时间，获取alarm信息
        const alarms = await chrome.alarms.getAll();
        const syncAlarm = alarms.find(alarm => alarm.name === 'syncBookmarks');
        
        if (syncAlarm && syncAlarm.scheduledTime) {
          nextSyncDisplay.textContent = formatFutureTime(syncAlarm.scheduledTime);
        } else {
          nextSyncDisplay.textContent = '启动后开始';
        }
      }
    } else {
      nextSyncDisplay.textContent = '已禁用';
    }
  } catch (error) {
    console.error("[Settings] 加载同步设置失败:", error);
  }
}

// 加载更新历史
async function loadUpdateHistory() {
  try {
    const result = await chrome.storage.local.get(['bookmarkHistory']);
    const historyList = document.getElementById('historyList');
    const historyCount = document.getElementById('historyCount');

    if (result.bookmarkHistory && Array.isArray(result.bookmarkHistory) && result.bookmarkHistory.length > 0) {
      const history = result.bookmarkHistory;
      historyCount.textContent = history.length;

      // 按时间倒序排列
      history.sort((a, b) => b.timestamp - a.timestamp);

      historyList.innerHTML = history.map(item => {
        // 根据操作类型显示不同的位置信息
        let locationInfo = '';
        
        if (item.action === 'add' && item.path) {
          // 新增操作：显示新增到的位置
          locationInfo = `
            <div class="history-folder" style="color: #059669;">
              📁 新增到：${escapeHtml(item.path)}
            </div>
          `;
        } else if (item.action === 'delete' && item.path) {
          // 删除操作：显示删除前的位置
          locationInfo = `
            <div class="history-folder" style="color: #dc2626;">
              📁 删除自：${escapeHtml(item.path)}
            </div>
          `;
        } else if (item.action === 'edit' && item.path) {
          // 修改操作：显示修改后所在的位置
          locationInfo = `
            <div class="history-folder" style="color: #2563eb;">
              📁 位置：${escapeHtml(item.path)}
            </div>
          `;
        } else if (item.action === 'move' && item.oldPath && item.newPath) {
          // 移动操作：显示源位置和目的位置
          locationInfo = `
            <div class="history-folder" style="color: #dc2626;">
              📁 从：${escapeHtml(item.oldPath)}
            </div>
            <div class="history-folder" style="color: #059669;">
              📁 到：${escapeHtml(item.newPath)}
            </div>
          `;
        } else if (item.path) {
          // 兼容旧数据 - 有path但不确定操作类型
          locationInfo = `<div class="history-folder">📁 ${escapeHtml(item.path)}</div>`;
        } else if (item.folder) {
          // 兼容更旧的数据
          locationInfo = `<div class="history-folder">📁 ${escapeHtml(item.folder)}</div>`;
        }
        
        return `
          <div class="history-item">
            <div class="history-header">
              <span class="history-type ${item.action}">${getActionText(item.action)}</span>
              <span class="history-time">${formatTime(item.timestamp)}</span>
            </div>
            <div class="history-content">
              ${escapeHtml(item.title || '(无标题)')}
            </div>
            ${item.url ? `<div class="history-url">${escapeHtml(item.url)}</div>` : ''}
            ${locationInfo}
          </div>
        `;
      }).join('');

      console.log("[Settings] 加载了 %d 条历史记录", history.length);
    } else {
      historyCount.textContent = '0';
      historyList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <p>暂无书签更新记录</p>
        </div>
      `;
      console.log("[Settings] 无历史记录");
    }
  } catch (error) {
    console.error("[Settings] 加载更新历史失败:", error);
  }
}

// 获取操作文本
function getActionText(action) {
  const texts = {
    'add': '新增',
    'delete': '删除',
    'edit': '编辑',
    'move': '移动'
  };
  return texts[action] || action;
}

// 格式化时间
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  // 小于1分钟
  if (diff < 60000) {
    return '刚刚';
  }
  // 小于1小时
  if (diff < 3600000) {
    return Math.floor(diff / 60000) + ' 分钟前';
  }
  // 小于24小时
  if (diff < 86400000) {
    return Math.floor(diff / 3600000) + ' 小时前';
  }
  // 小于7天
  if (diff < 604800000) {
    return Math.floor(diff / 86400000) + ' 天前';
  }

  // 完整日期时间
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// HTML转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 绑定事件
function bindEvents() {
  // 打开快捷键设置页面
  document.getElementById('openShortcutsPage').addEventListener('click', () => {
    console.log("[Settings] 打开快捷键设置页面");
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // 同步书签
  document.getElementById('syncBookmarks').addEventListener('click', async () => {
    console.log("[Settings] 同步书签");
    const btn = document.getElementById('syncBookmarks');
    const originalHTML = btn.innerHTML;

    btn.innerHTML = '<span>⏳</span><span>同步中...</span>';
    btn.disabled = true;

    try {
      await chrome.runtime.sendMessage({ action: 'refreshBookmarks' });
      await loadBookmarkStats();
      await loadSyncSettings();

      btn.innerHTML = '<span>✓</span><span>同步成功</span>';
      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
      }, 1500);
    } catch (error) {
      console.error("[Settings] 同步书签失败:", error);
      btn.innerHTML = '<span>✗</span><span>同步失败</span>';
      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
      }, 1500);
    }
  });

  // 同步间隔变化
  document.getElementById('syncInterval').addEventListener('change', async (e) => {
    const interval = parseInt(e.target.value);
    console.log("[Settings] 修改同步间隔为:", interval, "分钟");

    try {
      // 保存到storage
      await chrome.storage.local.set({ syncInterval: interval });
      
      // 通知background更新定时器
      await chrome.runtime.sendMessage({ 
        action: 'updateSyncInterval', 
        interval: interval 
      });
      
      // 重新加载同步设置显示
      await loadSyncSettings();
      
      console.log("[Settings] 同步间隔已更新");
    } catch (error) {
      console.error("[Settings] 更新同步间隔失败:", error);
      alert('设置失败：' + error.message);
    }
  });

  // 清空历史记录
  document.getElementById('clearHistory').addEventListener('click', async () => {
    console.log("[Settings] 清空历史记录");
    if (!confirm('确定要清空所有书签更新历史记录吗？')) {
      return;
    }

    try {
      await chrome.storage.local.set({ bookmarkHistory: [] });
      await loadUpdateHistory();
      console.log("[Settings] 历史记录已清空");
    } catch (error) {
      console.error("[Settings] 清空历史记录失败:", error);
      alert('清空失败：' + error.message);
    }
  });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
