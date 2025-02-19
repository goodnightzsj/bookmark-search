let searchContainer = null;
let searchInput = null;
let resultsContainer = null;
let bookmarks = [];

// 创建搜索界面
function createSearchUI() {
  searchContainer = document.createElement("div");
  searchContainer.className = "bookmark-search-container";

  searchInput = document.createElement("input");
  searchInput.className = "bookmark-search-input";
  searchInput.placeholder = "搜索书签...";

  resultsContainer = document.createElement("div");
  resultsContainer.className = "bookmark-results";

  searchContainer.appendChild(searchInput);
  searchContainer.appendChild(resultsContainer);
  document.body.appendChild(searchContainer);

  // 添加事件监听
  searchInput.addEventListener("input", handleSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideSearch();
    }
  });

  // 点击外部关闭搜索框
  document.addEventListener("click", (e) => {
    if (!searchContainer.contains(e.target)) {
      hideSearch();
    }
  });
}

// 显示搜索界面
function showSearch() {
  searchContainer.style.display = "block";
  searchInput.focus();
}

// 隐藏搜索界面
function hideSearch() {
  searchContainer.style.display = "none";
  searchInput.value = "";
  resultsContainer.innerHTML = "";
}

// 处理搜索
function handleSearch(e) {
  const query = e.target.value.toLowerCase();
  const results = bookmarks.filter(
    (bookmark) =>
      bookmark.title.toLowerCase().includes(query) ||
      bookmark.url.toLowerCase().includes(query)
  );

  displayResults(results.slice(0, 10)); // 限制显示前10个结果
}

// 显示搜索结果
function displayResults(results) {
  resultsContainer.innerHTML = "";

  results.forEach((bookmark) => {
    const item = document.createElement("div");
    item.className = "bookmark-item";

    const favicon = document.createElement("img");
    favicon.className = "bookmark-favicon";
    favicon.src = `https://www.google.com/s2/favicons?domain=${
      new URL(bookmark.url).hostname
    }`;

    const title = document.createElement("div");
    title.className = "bookmark-title";
    title.textContent = bookmark.title;

    item.appendChild(favicon);
    item.appendChild(title);

    item.addEventListener("click", () => {
      window.location.href = bookmark.url;
    });

    resultsContainer.appendChild(item);
  });
}

// 初始化
function init() {
  createSearchUI();

  // 从存储中获取书签数据
  chrome.storage.local.get(["bookmarks"], (result) => {
    if (result.bookmarks) {
      bookmarks = result.bookmarks;
    }
  });

  // 监听快捷键
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.code === "Space") {
      e.preventDefault(); // 阻止默认行为
      showSearch();
    }
  });
}

init();
