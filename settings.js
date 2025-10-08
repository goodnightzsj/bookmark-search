console.log("[Settings] settings.js 开始加载");

// 初始化
async function init() {
  console.log("[Settings] 初始化开始");

  try {
    // 加载快捷键信息
    await loadShortcutInfo();

    // 加载书签统计
    await loadBookmarkStats();

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

      historyList.innerHTML = history.map(item => `
        <div class="history-item">
          <div class="history-header">
            <span class="history-type ${item.action}">${getActionText(item.action)}</span>
            <span class="history-time">${formatTime(item.timestamp)}</span>
          </div>
          <div class="history-content">
            ${escapeHtml(item.title || '(无标题)')}
          </div>
          ${item.url ? `<div class="history-url">${escapeHtml(item.url)}</div>` : ''}
          ${item.folder ? `<div class="history-folder">📁 ${escapeHtml(item.folder)}</div>` : ''}
        </div>
      `).join('');

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
