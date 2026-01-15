// 防止重复加载 - 使用IIFE包装
(function() {
  // 检查是否已加载/正在加载
  if (window.__BOOKMARK_SEARCH_LOADED__ || window.__BOOKMARK_SEARCH_LOADING__) {
    console.log("[Content] content.js 已经加载过，跳过重复执行");
    return;
  }
  
  console.log("[Content] content.js 开始加载");
  window.__BOOKMARK_SEARCH_LOADING__ = true;

  let searchContainer = null;
  let searchOverlay = null;
  let searchInput = null;
  let resultsContainer = null;
	  let bookmarks = [];
	  let filteredResults = [];
	  let selectedIndex = -1;
	  let searchDebounceTimer = null;
	  let backgroundSearchToken = 0;

  try {

// 创建搜索界面
function createSearchUI() {
  console.log("[Content] createSearchUI 被调用");

  if (!document.body) {
    throw new Error('document.body not ready');
  }
  
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

  if (!document.body) {
    console.log("[Content] document.body 未就绪，等待 DOMContentLoaded 后再显示");
    document.addEventListener('DOMContentLoaded', showSearch, { once: true });
    return;
  }

  // 若之前创建失败导致元素未挂载到 DOM，则重置并重建
  if (searchOverlay && !document.body.contains(searchOverlay)) {
    try { searchOverlay.remove(); } catch (e) {}
    searchContainer = null;
    searchOverlay = null;
    searchInput = null;
    resultsContainer = null;
    filteredResults = [];
    selectedIndex = -1;
  }

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
  if (searchInput) searchInput.value = "";
  if (resultsContainer) resultsContainer.innerHTML = "";
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

	function sendMessagePromise(message) {
	  return new Promise((resolve, reject) => {
	    try {
	      chrome.runtime.sendMessage(message, (response) => {
	        const lastError = chrome.runtime && chrome.runtime.lastError;
	        if (lastError) {
	          reject(lastError);
	          return;
	        }
	        resolve(response);
	      });
	    } catch (error) {
	      reject(error);
	    }
	  });
	}

	async function searchBookmarksInBackground(query) {
	  const token = ++backgroundSearchToken;

	  try {
	    const response = await sendMessagePromise({ action: 'searchBookmarks', query });
	    if (token !== backgroundSearchToken) return;

	    if (!response || response.success === false) {
	      throw new Error((response && response.error) || 'Search failed');
	    }

	    const results = Array.isArray(response.results) ? response.results : [];
	    filteredResults = results.slice(0, 10);
	    selectedIndex = filteredResults.length > 0 ? 0 : -1;
	    displayResults(filteredResults);
	  } catch (error) {
	    if (token !== backgroundSearchToken) return;

	    console.error("[Content] 后台搜索失败:", error);
	    filteredResults = [];
	    selectedIndex = -1;
	    resultsContainer.innerHTML = "";

	    const emptyMsg = document.createElement("div");
	    emptyMsg.className = "bookmark-empty";
	    emptyMsg.textContent = "搜索失败，请重试";
	    resultsContainer.appendChild(emptyMsg);
	  }
	}

	// 处理搜索
	function handleSearch(query) {
	  const rawQuery = String(query || '').trim();
	  const queryLower = rawQuery.toLowerCase();
	  
	  if (!rawQuery) {
	    filteredResults = [];
	    resultsContainer.innerHTML = "";
	    selectedIndex = -1;
	    return;
	  }

	  if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
	    searchBookmarksInBackground(rawQuery);
	    return;
	  }

	  filteredResults = bookmarks
	    .filter((bookmark) => {
	      const title = String((bookmark && bookmark.title) || '').toLowerCase();
	      const url = String((bookmark && bookmark.url) || '').toLowerCase();
      return title.includes(queryLower) || url.includes(queryLower);
    })
    .slice(0, 10); // 限制显示前10个结果

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
    favicon.src = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(bookmark.url)}&size=32`);
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
  const url = bookmark && bookmark.url ? String(bookmark.url) : '';
  if (!url) return;

  if (newTab) {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  } else {
    window.location.href = url;
  }
  hideSearch();
}

// 加载书签数据
function loadBookmarks() {
  console.log("[Content] loadBookmarks 被调用");
  
  chrome.storage.local.get(["bookmarks"], (result) => {
    const nextBookmarks = result.bookmarks;
    bookmarks = Array.isArray(nextBookmarks) ? nextBookmarks : [];

    if (bookmarks.length > 0) {
      console.log("[Content] 书签数据已加载，数量:", bookmarks.length);
    } else {
      console.warn("[Content] 未找到书签数据");
    }
  });
}

// 监听书签数据变化（避免页面驻留时数据过期）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes.bookmarks) return;

  const nextBookmarks = changes.bookmarks.newValue;
  bookmarks = Array.isArray(nextBookmarks) ? nextBookmarks : [];
  console.log("[Content] 书签数据已更新，数量:", bookmarks.length);
});

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
  if (searchOverlay && (!document.body || document.body.contains(searchOverlay))) {
    console.log("[Content] 已经初始化过，跳过");
    return;
  }

  if (!document.body) {
    console.log("[Content] document.body 未就绪，等待 DOMContentLoaded 后再初始化");
    document.addEventListener('DOMContentLoaded', init, { once: true });
    return;
  }

  try {
    createSearchUI();
    loadBookmarks();
    console.log("[Content] 初始化完成");
  } catch (error) {
    console.error("[Content] 初始化失败:", error);
    try { if (searchOverlay) searchOverlay.remove(); } catch (e) {}
    searchContainer = null;
    searchOverlay = null;
    searchInput = null;
    resultsContainer = null;
    filteredResults = [];
    selectedIndex = -1;
  }
}

  console.log("[Content] 准备调用 init");
  init();

  // Mark loaded after all listeners are registered and init is attempted.
  window.__BOOKMARK_SEARCH_LOADED__ = true;
  console.log("[Content] content.js 加载完成");

  } catch (error) {
    console.error("[Content] content.js 加载失败:", error);
  } finally {
    window.__BOOKMARK_SEARCH_LOADING__ = false;
  }

})(); // 结束 IIFE
