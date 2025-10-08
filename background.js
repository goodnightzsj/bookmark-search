console.log("[Background] ===== background.js 开始加载 =====");
let bookmarks = [];

// 检查存储的书签数据
console.log("[Background] 检查存储的书签数据");
chrome.storage.local.get(["bookmarks"], (result) => {
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

      // 将书签数据存储到 chrome.storage
      chrome.storage.local.set({ bookmarks: bookmarks }, () => {
        console.log("[Background] 书签数据已存储到 chrome.storage");
      });
    });
  }
});

console.log("[Background] ===== background.js 加载完成 =====");

// 递归遍历书签树
function processBookmarks(nodes) {
  for (const node of nodes) {
    if (node.children) {
      // 如果有子节点，说明是文件夹，继续递归
      processBookmarks(node.children);
    } else {
      // 没有子节点，说明是书签
      bookmarks.push({
        id: node.id,
        title: node.title,
        url: node.url,
      });
    }
  }
}

// 添加书签更新历史记录
async function addBookmarkHistory(action, bookmark) {
  try {
    const result = await chrome.storage.local.get(['bookmarkHistory']);
    const history = result.bookmarkHistory || [];
    
    // 添加新记录
    history.push({
      action: action,
      title: bookmark.title,
      url: bookmark.url,
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
function updateBookmarks(action, id, bookmark, fullBookmark = null) {
  if (action === "add") {
    bookmarks.push({
      id: id,
      title: bookmark.title,
      url: bookmark.url,
    });
    // 记录历史
    addBookmarkHistory("add", bookmark);
    console.log("[Background] 新增书签已添加到数组");
  } else if (action === "delete") {
    // 先找到要删除的书签信息
    const deletedBookmark = bookmarks.find(mark => mark.id === id);
    bookmarks = bookmarks.filter((mark) => mark.id !== id);
    // 记录历史
    if (deletedBookmark) {
      addBookmarkHistory("delete", deletedBookmark);
      console.log("[Background] 删除书签已从数组移除");
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
            url: fullBookmark.url
          };
        } else {
          updatedBookmark = { ...mark, ...bookmark };
        }
        return updatedBookmark;
      }
      return mark;
    });
    
    // 记录历史（使用完整信息）
    if (updatedBookmark) {
      addBookmarkHistory("edit", updatedBookmark);
      console.log("[Background] 编辑书签已更新:", updatedBookmark);
    } else {
      console.warn("[Background] 未找到要编辑的书签:", id);
    }
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
chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
  console.log("[Background] 移动书签：", id, moveInfo);
  
  // 获取完整书签信息
  chrome.bookmarks.get(id, (results) => {
    if (results && results.length > 0) {
      const fullBookmark = results[0];
      console.log("[Background] 获取移动的书签信息:", fullBookmark);
      
      // 获取新父文件夹信息
      chrome.bookmarks.get(moveInfo.parentId, (parentResults) => {
        const parentFolder = parentResults[0];
        const folderName = parentFolder ? parentFolder.title : '未知文件夹';
        
        console.log("[Background] 移动到文件夹:", folderName);
        
        // 记录移动历史
        addBookmarkHistory("move", {
          ...fullBookmark,
          folder: folderName
        });
      });
    }
  });
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
          iconUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"%3E%3Ctext y="32" font-size="32"%3E🔖%3C/text%3E%3C/svg%3E',
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
      
      // 存储到 chrome.storage
      chrome.storage.local.set({ bookmarks: bookmarks }, () => {
        console.log("[Background] 书签刷新完成");
        sendResponse({ success: true, count: bookmarks.length });
      });
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
