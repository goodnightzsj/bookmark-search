// 防止重复加载 - 使用IIFE包装
(function() {
  // 检查是否已加载
  if (window.__BOOKMARK_SEARCH_LOADED__) {
    console.log("[Content] content.js 已经加载过，跳过重复执行");
    return;
  }
  
  console.log("[Content] content.js 开始加载");
  window.__BOOKMARK_SEARCH_LOADED__ = true;

let searchContainer = null;
let searchOverlay = null;
let searchInput = null;
let resultsContainer = null;
let bookmarks = [];
let filteredResults = [];
let selectedIndex = -1;
let searchDebounceTimer = null;

// 创建搜索界面
function createSearchUI() {
  console.log("[Content] createSearchUI 被调用");
  
  // 创建背景遮罩
  searchOverlay = document.createElement("div");
  searchOverlay.className = "bookmark-search-overlay";
  console.log("[Content] 搜索遮罩层已创建");
  
  searchContainer = document.createElement("div");
  searchContainer.className = "bookmark-search-container";

  searchInput = document.createElement("input");
  searchInput.className = "bookmark-search-input";
  searchInput.placeholder = "搜索书签...";

  resultsContainer = document.createElement("div");
  resultsContainer.className = "bookmark-results";

  // 创建快捷键提示
  const shortcuts = document.createElement("div");
  shortcuts.className = "bookmark-shortcuts";
  shortcuts.innerHTML = `
    <div class="bookmark-shortcut">
      <kbd>↑</kbd><kbd>↓</kbd> 导航
    </div>
    <div class="bookmark-shortcut">
      <kbd>Enter</kbd> 新标签
    </div>
    <div class="bookmark-shortcut">
      <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 当前页
    </div>
    <div class="bookmark-shortcut">
      <kbd>Esc</kbd> 关闭
    </div>
  `;

  searchContainer.appendChild(searchInput);
  searchContainer.appendChild(resultsContainer);
  searchContainer.appendChild(shortcuts);
  searchOverlay.appendChild(searchContainer);
  
  // 显式设置初始状态为隐藏
  searchOverlay.style.display = "none";
  console.log("[Content] 设置初始 display = none");
  
  document.body.appendChild(searchOverlay);
  console.log("[Content] 搜索UI已添加到body");

  // 添加事件监听
  searchInput.addEventListener("input", handleSearchDebounced);
  searchInput.addEventListener("keydown", handleKeydown);

  // 点击遮罩关闭搜索框
  searchOverlay.addEventListener("click", (e) => {
    if (e.target === searchOverlay) {
      hideSearch();
    }
  });
}

// 显示搜索界面
function showSearch() {
  console.log("[Content] showSearch 被调用");
  
  if (!searchOverlay) {
    console.log("[Content] searchOverlay 不存在，创建UI");
    createSearchUI();
    loadBookmarks();
  }
  
  console.log("[Content] 显示搜索框");
  searchOverlay.style.display = "flex";
  searchInput.focus();
  console.log("[Content] 搜索框已显示并聚焦");
}

// 隐藏搜索界面
function hideSearch() {
  console.log("[Content] hideSearch 被调用");
  
  if (!searchOverlay) {
    console.log("[Content] searchOverlay 不存在，退出");
    return;
  }
  
  searchOverlay.style.display = "none";
  searchInput.value = "";
  resultsContainer.innerHTML = "";
  filteredResults = [];
  selectedIndex = -1;
  console.log("[Content] 搜索框已隐藏");
}

// 切换搜索界面显示/隐藏
function toggleSearch() {
  console.log("[Content] toggleSearch 被调用");
  
  const displayValue = searchOverlay ? searchOverlay.style.display : "不存在";
  console.log("[Content] searchOverlay 状态:", `display="${displayValue}"`);
  
  // 检查是否应该显示：不存在、display为none或空字符串
  const shouldShow = !searchOverlay || 
                     searchOverlay.style.display === "none" || 
                     searchOverlay.style.display === "";
  
  console.log("[Content] 判断结果: shouldShow =", shouldShow);
  
  if (shouldShow) {
    console.log("[Content] 准备显示搜索框");
    showSearch();
  } else {
    console.log("[Content] 准备隐藏搜索框");
    hideSearch();
  }
}

// 处理键盘导航
function handleKeydown(e) {
  switch (e.key) {
    case "Escape":
      hideSearch();
      break;
    case "ArrowDown":
      e.preventDefault();
      if (filteredResults.length > 0) {
        selectedIndex = selectedIndex >= filteredResults.length - 1 ? 0 : selectedIndex + 1;
        updateSelection();
      }
      break;
    case "ArrowUp":
      e.preventDefault();
      if (filteredResults.length > 0) {
        selectedIndex = selectedIndex <= 0 ? filteredResults.length - 1 : selectedIndex - 1;
        updateSelection();
      }
      break;
    case "Enter":
      e.preventDefault();
      if (selectedIndex >= 0 && filteredResults[selectedIndex]) {
        // 按住 Ctrl/Cmd 时在当前页打开，否则在新标签打开
        openBookmark(filteredResults[selectedIndex], !(e.ctrlKey || e.metaKey));
      }
      break;
  }
}

// 更新选中项的高亮
function updateSelection() {
  const items = resultsContainer.querySelectorAll(".bookmark-item");
  items.forEach((item, index) => {
    if (index === selectedIndex) {
      item.classList.add("selected");
      item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      item.classList.remove("selected");
    }
  });
}

// 防抖搜索
function handleSearchDebounced(e) {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    handleSearch(e.target.value);
  }, 200);
}

// 处理搜索
function handleSearch(query) {
  const queryLower = query.toLowerCase();
  
  if (!queryLower.trim()) {
    filteredResults = [];
    resultsContainer.innerHTML = "";
    selectedIndex = -1;
    return;
  }

  filteredResults = bookmarks.filter(
    (bookmark) =>
      bookmark.title.toLowerCase().includes(queryLower) ||
      bookmark.url.toLowerCase().includes(queryLower)
  ).slice(0, 10); // 限制显示前10个结果

  selectedIndex = filteredResults.length > 0 ? 0 : -1;
  displayResults(filteredResults);
}

// 显示搜索结果
function displayResults(results) {
  resultsContainer.innerHTML = "";

  if (results.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "bookmark-empty";
    emptyMsg.textContent = "未找到匹配的书签";
    resultsContainer.appendChild(emptyMsg);
    return;
  }

  results.forEach((bookmark, index) => {
    const item = document.createElement("div");
    item.className = "bookmark-item";
    if (index === selectedIndex) {
      item.classList.add("selected");
    }

    const favicon = document.createElement("img");
    favicon.className = "bookmark-favicon";
    favicon.src = `https://www.google.com/s2/favicons?domain=${
      new URL(bookmark.url).hostname
    }`;
    favicon.onerror = () => {
      favicon.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23999' d='M8 0a8 8 0 100 16A8 8 0 008 0z'/%3E%3C/svg%3E";
    };

    const textContainer = document.createElement("div");
    textContainer.className = "bookmark-text";

    const title = document.createElement("div");
    title.className = "bookmark-title";
    title.textContent = bookmark.title;

    const url = document.createElement("div");
    url.className = "bookmark-url";
    url.textContent = bookmark.url;

    textContainer.appendChild(title);
    textContainer.appendChild(url);

    item.appendChild(favicon);
    item.appendChild(textContainer);

    // 鼠标悬停时更新选中项
    item.addEventListener("mouseenter", () => {
      selectedIndex = index;
      updateSelection();
    });

    item.addEventListener("click", (e) => {
      // 按住 Ctrl/Cmd 时在当前页打开，否则在新标签打开
      openBookmark(bookmark, !(e.ctrlKey || e.metaKey));
    });

    resultsContainer.appendChild(item);
  });
}

// 打开书签
function openBookmark(bookmark, newTab = true) {
  if (newTab) {
    window.open(bookmark.url, "_blank");
  } else {
    window.location.href = bookmark.url;
  }
  hideSearch();
}

// 加载书签数据
function loadBookmarks() {
  console.log("[Content] loadBookmarks 被调用");
  
  chrome.storage.local.get(["bookmarks"], (result) => {
    if (result.bookmarks) {
      bookmarks = result.bookmarks;
      console.log("[Content] 书签数据已加载，数量:", bookmarks.length);
    } else {
      console.warn("[Content] 未找到书签数据");
    }
  });
}

// 监听来自background的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Content] 收到消息:", message);
  
  if (message.action === "toggleSearch") {
    console.log("[Content] 执行 toggleSearch 动作");
    try {
      toggleSearch();
      console.log("[Content] toggleSearch 执行完毕，发送响应");
      sendResponse({ success: true, message: "搜索框已切换" });
    } catch (error) {
      console.error("[Content] toggleSearch 执行失败:", error);
      sendResponse({ success: false, error: error.message });
    }
    return true; // 表示会异步调用 sendResponse
  }
  
  // 其他消息类型不需要响应
  return false;
});

// 初始化
function init() {
  console.log("[Content] init 被调用");
  
  // 防止重复初始化
  if (searchOverlay) {
    console.log("[Content] 已经初始化过，跳过");
    return;
  }
  
  try {
    createSearchUI();
    loadBookmarks();
    console.log("[Content] 初始化完成");
  } catch (error) {
    console.error("[Content] 初始化失败:", error);
  }
}

  console.log("[Content] 准备调用 init");
  init();
  console.log("[Content] content.js 加载完成");

})(); // 结束 IIFE
