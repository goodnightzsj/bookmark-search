/**
 * 加载快捷键信息
 */
export async function loadShortcutInfo() {
  try {
    const commands = await chrome.commands.getAll();
    const toggleCommand = commands.find(cmd => cmd.name === 'toggle-overlay');

    const shortcutInput = document.getElementById('shortcutInput');
    if (!shortcutInput) {
      console.warn("[Settings] 未找到 shortcutInput 元素");
      return;
    }
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

/**
 * 绑定快捷键相关事件
 */
export function bindShortcutEvents() {
  // 打开快捷键设置页面
  document.getElementById('openShortcutsPage').addEventListener('click', () => {
    console.log("[Settings] 打开快捷键设置页面");
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

// 内部函数：检测快捷键冲突
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

    // 检测与本扩展其他命令的冲突（chrome.commands.getAll 仅返回本扩展命令）
    allCommands.forEach(cmd => {
      if (cmd.name !== 'toggle-overlay' && cmd.shortcut === shortcut) {
        hasConflict = true;
        conflictsWith.push(`本扩展其他命令: ${cmd.description || cmd.name}`);
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
