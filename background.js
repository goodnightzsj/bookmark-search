console.log("[Background] ===== background.js 开始加载 =====");
let bookmarks = [];

// 检查存储的书签数据
console.log("[Background] 检查存储的书签数据");
chrome.storage.local.get(["bookmarks", "lastSyncTime"], (result) => {
  if (result.bookmarks && result.bookmarks.length > 0) {
    // 如果已有存储的数据，直接使用
    console.log("[Background] 从存储中获取书签数据，数量：", result.bookmarks.length);
    bookmarks = result.bookmarks;
  } else {
    // 没有存储的数据，获取并存储书签信息
    console.log("[Background] 存储中无书签数据，从浏览器获取");
    chrome.bookmarks.getTree((bookmarkTreeNodes) => {
      processBookmarks(bookmarkTreeNodes);
      console.log("[Background] 新获取的书签数据，数量：", bookmarks.length);

      // 将书签数据存储到 chrome.storage，并记录同步时间
      const syncTime = Date.now();
      chrome.storage.local.set({ bookmarks: bookmarks, lastSyncTime: syncTime }, () => {
        console.log("[Background] 书签数据已存储到 chrome.storage，同步时间:", new Date(syncTime).toLocaleString());
      });
    });
  }
});

console.log("[Background] ===== background.js 加载完成 =====");

// 递归遍历书签树，构建路径
function processBookmarks(nodes, parentPath = "") {
  for (const node of nodes) {
    if (node.children) {
      // 如果有子节点，说明是文件夹，继续递归
      const currentPath = parentPath ? `${parentPath}/${node.title}` : node.title;
      processBookmarks(node.children, currentPath);
    } else {
      // 没有子节点，说明是书签
      bookmarks.push({
        id: node.id,
        title: node.title,
        url: node.url,
        path: parentPath || "根目录"
      });
    }
  }
}

// 获取书签的完整路径
async function getBookmarkPath(bookmarkId) {
  try {
    const path = [];
    let currentId = bookmarkId;
    
    while (currentId) {
      const results = await chrome.bookmarks.get(currentId);
      if (!results || results.length === 0) break;
      
      const node = results[0];
      
      // 到达根节点时停止
      if (!node.parentId) break;
      
      // 获取父节点信息以构建路径
      const parentResults = await chrome.bookmarks.get(node.parentId);
      if (parentResults && parentResults.length > 0 && parentResults[0].title) {
        path.unshift(parentResults[0].title);
      }
      
      currentId = node.parentId;
    }
    
    return path.length > 0 ? path.join('/') : '根目录';
  } catch (error) {
    console.error("[Background] 获取书签路径失败:", error);
    return '未知路径';
  }
}

// 添加书签更新历史记录
async function addBookmarkHistory(action, bookmark) {
  try {
    const result = await chrome.storage.local.get(['bookmarkHistory']);
    const history = result.bookmarkHistory || [];
    
    // 添加新记录，保存所有相关信息
    history.push({
      action: action,
      title: bookmark.title,
      url: bookmark.url,
      path: bookmark.path,           // 当前位置
      oldPath: bookmark.oldPath,     // 移动前的位置（仅移动操作）
      newPath: bookmark.newPath,     // 移动后的位置（仅移动操作）
      timestamp: Date.now()
    });
    
    // 限制历史记录数量（最多保留100条）
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }
    
    await chrome.storage.local.set({ bookmarkHistory: history });
    console.log(`[Background] 书签历史记录已添加: ${action} - ${bookmark.title}`);
  } catch (error) {
    console.error("[Background] 添加书签历史失败:", error);
  }
}

// 更新书签数据的函数
async function updateBookmarks(action, id, bookmark, fullBookmark = null) {
  if (action === "add") {
    const path = await getBookmarkPath(bookmark.parentId || id);
    const newBookmark = {
      id: id,
      title: bookmark.title,
      url: bookmark.url,
      path: path
    };
    bookmarks.push(newBookmark);
    // 记录历史 - 新增只记录目的位置
    addBookmarkHistory("add", {
      title: newBookmark.title,
      url: newBookmark.url,
      path: path  // 新增到的位置
    });
    console.log("[Background] 新增书签已添加到数组，路径:", path);
  } else if (action === "delete") {
    // 先找到要删除的书签信息
    const deletedBookmark = bookmarks.find(mark => mark.id === id);
    bookmarks = bookmarks.filter((mark) => mark.id !== id);
    // 记录历史 - 删除只记录源位置
    if (deletedBookmark) {
      addBookmarkHistory("delete", {
        title: deletedBookmark.title,
        url: deletedBookmark.url,
        path: deletedBookmark.path  // 删除前的位置
      });
      console.log("[Background] 删除书签已从数组移除，路径:", deletedBookmark.path);
    }
  } else if (action === "edit") {
    let updatedBookmark = null;
    
    bookmarks = bookmarks.map((mark) => {
      if (mark.id === id) {
        // 优先使用完整书签信息，否则合并 changeInfo
        if (fullBookmark) {
          updatedBookmark = {
            id: fullBookmark.id,
            title: fullBookmark.title,
            url: fullBookmark.url,
            path: mark.path // 保留原路径
          };
        } else {
          updatedBookmark = { ...mark, ...bookmark };
        }
        return updatedBookmark;
      }
      return mark;
    });
    
    // 记录历史 - 修改只记录当前位置
    if (updatedBookmark) {
      addBookmarkHistory("edit", {
        title: updatedBookmark.title,
        url: updatedBookmark.url,
        path: updatedBookmark.path  // 修改后所在的位置
      });
      console.log("[Background] 编辑书签已更新:", updatedBookmark);
    } else {
      console.warn("[Background] 未找到要编辑的书签:", id);
    }
  } else if (action === "move") {
    // 移动书签时更新路径
    const newPath = await getBookmarkPath(id);
    bookmarks = bookmarks.map((mark) => {
      if (mark.id === id) {
        const oldPath = mark.path; // 保存旧路径
        const movedBookmark = { ...mark, path: newPath };
        
        // 记录历史 - 移动记录源位置和目的位置
        addBookmarkHistory("move", {
          title: movedBookmark.title,
          url: movedBookmark.url,
          oldPath: oldPath,  // 移动前的位置
          newPath: newPath   // 移动后的位置
        });
        
        console.log("[Background] 移动书签: 从", oldPath, "到", newPath);
        return movedBookmark;
      }
      return mark;
    });
  }
  
  // 存储更新后的数据
  chrome.storage.local.set({ bookmarks: bookmarks }, () => {
    console.log("[Background] 更新后的书签数据已存储，当前数量:", bookmarks.length);
  });
}

// 监听书签的变化
chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  console.log("新增书签：", id, bookmark);
  updateBookmarks("add", id, bookmark);
});

chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  console.log("删除书签：", id, removeInfo);
  updateBookmarks("delete", id, removeInfo);
});

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  console.log("[Background] 修改书签：", id, changeInfo);
  
  // chrome.bookmarks.onChanged 只提供变化的字段（title 或 url）
  // 需要获取完整的书签信息
  chrome.bookmarks.get(id, (results) => {
    if (results && results.length > 0) {
      const fullBookmark = results[0];
      console.log("[Background] 获取完整书签信息:", fullBookmark);
      updateBookmarks("edit", id, changeInfo, fullBookmark);
    } else {
      // 如果无法获取完整信息，使用 changeInfo
      console.warn("[Background] 无法获取完整书签信息，使用 changeInfo");
      updateBookmarks("edit", id, changeInfo, null);
    }
  });
});

// 监听书签位置变化（移动到不同文件夹）
chrome.bookmarks.onMoved.addListener(async (id, moveInfo) => {
  console.log("[Background] 移动书签：", id, moveInfo);
  
  // 更新书签的路径信息
  await updateBookmarks("move", id, moveInfo);
});
// 防止同时执行多次
let isToggling = false;

// 处理快捷键和图标点击的通用函数
async function toggleBookmarkSearch() {
  console.log("[Background] ===== toggleBookmarkSearch 被调用 =====");
  
  // 防止重复执行
  if (isToggling) {
    console.warn("[Background] 函数正在执行中，忽略重复调用");
    return;
  }
  
  isToggling = true;
  
  try {
    // 获取当前活动标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log("[Background] 当前标签页:", tab ? `id=${tab.id}, url=${tab.url}` : "未找到");
  
    if (!tab?.id || !tab.url) {
      console.warn("[Background] 标签页信息不完整，退出");
      return;
    }
    
    // 检查是否是特殊页面（不能注入content script的页面）
    const specialProtocols = ['chrome://', 'edge://', 'about:', 'chrome-extension://', 'edge-extension://'];
    const isSpecialPage = specialProtocols.some(protocol => tab.url.startsWith(protocol));
    console.log("[Background] 是否特殊页面:", isSpecialPage);
    
    if (isSpecialPage) {
      console.log("[Background] 无法在系统页面中使用书签搜索，准备显示通知");
      
      // 显示通知提示用户
      try {
        const notificationId = await chrome.notifications.create({
          type: 'basic',
          title: '书签搜索',
          message: '由于浏览器安全限制，无法在系统页面（chrome://、edge://等）使用扩展。\n请在普通网页中使用。',
          priority: 1
        });
        console.log("[Background] 通知已创建:", notificationId);
      } catch (notifyError) {
        console.error("[Background] 创建通知失败:", notifyError);
      }
      return;
    }
    
    // 向content script发送消息，并捕获错误
    console.log("[Background] 尝试发送消息到 content script (第1次)");
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: "toggleSearch" });
      console.log("[Background] ✓ 消息发送成功，收到响应:", response);
      return; // 成功发送后立即返回，不再执行后续代码
    } catch (error) {
      console.log("[Background] ✗ 消息发送失败:", error.message);
      console.log("[Background] Content script未加载，尝试动态注入...");
      
      // 如果content script未加载，动态注入
      try {
        console.log("[Background] 开始注入 content.js");
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        console.log("[Background] content.js 注入成功");
        
        console.log("[Background] 开始注入 content.css");
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['content.css']
        });
        console.log("[Background] content.css 注入成功");
        
        // 使用Promise和延迟来等待脚本初始化
        console.log("[Background] 等待150ms让脚本初始化...");
        await new Promise(resolve => setTimeout(resolve, 150));
        console.log("[Background] 等待完成，重新发送消息 (第2次)");
        
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: "toggleSearch" });
          console.log("[Background] ✓ 注入后消息发送成功，收到响应:", response);
        } catch (e) {
          console.error("[Background] ✗ 注入后仍无法发送消息:", e.message);
        }
      } catch (injectError) {
        console.error("[Background] ✗ 无法注入content script:", injectError.message);
      }
    }
    
    console.log("[Background] toggleBookmarkSearch 函数执行完毕");
  } finally {
    // 无论如何都要重置标志
    isToggling = false;
    console.log("[Background] ===== toggleBookmarkSearch 结束 =====");
  }
}

// 监听来自 popup 和 settings 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] 收到消息:", message);
  
  if (message.action === 'refreshBookmarks') {
    console.log("[Background] 刷新书签请求");
    
    // 重新获取书签
    chrome.bookmarks.getTree((bookmarkTreeNodes) => {
      bookmarks = [];
      processBookmarks(bookmarkTreeNodes);
      console.log("[Background] 刷新后的书签数量:", bookmarks.length);
      
      // 存储到 chrome.storage，并记录同步时间
      chrome.storage.local.set({ bookmarks: bookmarks, lastSyncTime: Date.now() }, () => {
        console.log("[Background] 书签刷新完成");
        sendResponse({ success: true, count: bookmarks.length });
      });
    });
    
    return true; // 保持消息通道开启
  }
  
  if (message.action === 'updateSyncInterval') {
    console.log("[Background] 更新同步间隔请求:", message.interval, "分钟");
    
    setupSyncAlarm(message.interval).then(() => {
      console.log("[Background] 同步间隔已更新");
      sendResponse({ success: true });
    }).catch((error) => {
      console.error("[Background] 更新同步间隔失败:", error);
      sendResponse({ success: false, error: error.message });
    });
    
    return true; // 保持消息通道开启
  }
  
  return false;
});

// 监听快捷键
chrome.commands.onCommand.addListener((command) => {
  console.log("[Background] ==== 快捷键触发 ====");
  console.log("[Background] 命令:", command);
  
  if (command === "toggle-overlay") {
    console.log("[Background] 执行 toggle-overlay 命令");
    toggleBookmarkSearch();
  } else {
    console.log("[Background] 未知命令:", command);
  }
});

// 定时同步书签的函数
async function syncBookmarks() {
  console.log("[Background] ==== 开始定时同步书签 ====");
  
  try {
    // 重新获取书签
    chrome.bookmarks.getTree((bookmarkTreeNodes) => {
      bookmarks = [];
      processBookmarks(bookmarkTreeNodes);
      console.log("[Background] 定时同步后的书签数量:", bookmarks.length);
      
      // 存储到 chrome.storage
      chrome.storage.local.set({ bookmarks: bookmarks, lastSyncTime: Date.now() }, () => {
        console.log("[Background] 定时同步完成，时间:", new Date().toLocaleString());
      });
    });
  } catch (error) {
    console.error("[Background] 定时同步书签失败:", error);
  }
}

// 创建或更新同步定时器
async function setupSyncAlarm(intervalMinutes) {
  // 先清除现有的定时器
  await chrome.alarms.clear('syncBookmarks');
  
  if (intervalMinutes > 0) {
    // 创建新的定时器
    chrome.alarms.create('syncBookmarks', {
      periodInMinutes: intervalMinutes
    });
    console.log("[Background] 定时器已创建/更新：每", intervalMinutes, "分钟同步一次书签");
  } else {
    console.log("[Background] 自动同步已禁用");
  }
}

// 初始化同步定时器
chrome.storage.local.get(['syncInterval'], async (result) => {
  const interval = result.syncInterval !== undefined ? result.syncInterval : 30;
  
  // 如果是首次运行，保存默认值
  if (result.syncInterval === undefined) {
    await chrome.storage.local.set({ syncInterval: interval });
    console.log("[Background] 首次运行，设置默认同步间隔:", interval, "分钟");
  }
  
  await setupSyncAlarm(interval);
});

// 监听定时器触发
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'syncBookmarks') {
    console.log("[Background] 定时器触发:", alarm.name);
    syncBookmarks();
  }
});
