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
	  let filteredResults = [];
	  let selectedIndex = -1;
	  let cachedResultItems = null; // 缓存搜索结果 DOM 引用，避免 updateSelection 重复查询
	  // 记录最近一次真实鼠标移动时间，用于避免“键盘滚动导致光标下元素变化”触发 hover 抢夺选中态
	  let lastPointerMoveAt = 0;
	  let searchDebounceTimer = null;
	  let backgroundSearchToken = 0;
	  let imeComposing = false;
	  let imeEnterDuringComposition = false;
	  // Suppress stray/synthetic Enter events right after IME composition ends (esp. macOS built-in IME).
	  // Keep the window small so the user's next real Enter (to open) still works.
	  let imeSuppressEnterUntil = 0;
	  // SYNC: values must match constants.js MESSAGE_ACTIONS (IIFE cannot import ES modules)
	  const MESSAGE_ACTIONS = {
	    SEARCH_BOOKMARKS: 'searchBookmarks',
	    GET_WARMUP_DOMAINS: 'getWarmupDomains',
	    GET_BROWSER_FAVICON: 'getBrowserFavicon',
	    GET_BROWSER_FAVICONS_BATCH: 'getBrowserFaviconsBatch',
	    GET_FAVICONS: 'getFavicons',
	    SET_FAVICONS: 'setFavicons',
	    TRACK_BOOKMARK_OPEN: 'trackBookmarkOpen',
	    TOGGLE_SEARCH: 'toggleSearch'
	  };
	  const REQUIRED_MESSAGE_ACTIONS = {
	    SEARCH_BOOKMARKS: true,
	    GET_WARMUP_DOMAINS: true,
	    GET_BROWSER_FAVICON: true,
	    GET_BROWSER_FAVICONS_BATCH: true,
	    GET_FAVICONS: true,
	    SET_FAVICONS: true,
	    TRACK_BOOKMARK_OPEN: true,
	    TOGGLE_SEARCH: true
	  };
	  function validateMessageActionsConfig() {
	    const keys = Object.keys(REQUIRED_MESSAGE_ACTIONS);
	    for (let i = 0; i < keys.length; i++) {
	      const key = keys[i];
	      const value = MESSAGE_ACTIONS[key];
	      if (typeof value !== 'string' || !value) {
	        console.warn('[Content] MESSAGE_ACTIONS 配置缺失或无效:', key);
	        return;
	      }
	    }
	  }
	  // In-memory favicon cache (domain -> icon URL) with LRU eviction using Map for O(1) operations
	  const FAVICON_CACHE_DEFAULT_SIZE = 2000;
	  let faviconCacheMaxSize = FAVICON_CACHE_DEFAULT_SIZE;
	  let faviconCache = new Map(); // Map 自动维护插入顺序，支持 O(1) 删除和查找

	  // 从 storage 加载缓存大小设置
	  async function loadFaviconCacheSettings() {
	    try {
	      const result = await chrome.storage.local.get('faviconCacheSize');
	      if (result.faviconCacheSize && typeof result.faviconCacheSize === 'number') {
	        faviconCacheMaxSize = result.faviconCacheSize;
	        console.log('[Content] Favicon 缓存大小已加载:', faviconCacheMaxSize);
	      }
	    } catch (e) {
	      console.warn('[Content] 加载 Favicon 缓存大小设置失败:', e);
	    }
	  }

	  chrome.storage.onChanged.addListener((changes, area) => {
	    if (area !== 'local') return;
	    if (changes.faviconCacheSize) {
	      const newSize = changes.faviconCacheSize.newValue;
	      if (typeof newSize === 'number' && newSize > 0) {
	        faviconCacheMaxSize = newSize;
	        console.log('[Content] Favicon 缓存大小已更新:', faviconCacheMaxSize);
	        while (faviconCache.size > faviconCacheMaxSize) {
	          const oldest = faviconCache.keys().next().value;
	          faviconCache.delete(oldest);
	        }
	      }
	    }
	    if (changes.theme) {
	      const newTheme = changes.theme.newValue;
	      if (typeof newTheme === 'string' && newTheme) {
	        currentTheme = newTheme;
	        applyThemeToOverlay();
	      }
	    }
	  });

	  // NOTE: keep helper declarations before first usage.
	  // javascript-obfuscator may treat identifiers referenced before declaration as globals and skip renaming,
	  // which can cause runtime ReferenceError in the obfuscated dist build.
	  function getRootDomain(domain) {
	    const safe = typeof domain === 'string' ? domain.trim() : '';
	    if (!safe) return '';
	    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(safe)) return safe;
	    if (safe === 'localhost') return safe;
	    if (safe.indexOf('.') === -1) return safe;

	    const parts = safe.split('.');
	    if (parts.length <= 2) return safe;
	    return parts.slice(-2).join('.');
	  }

	  function normalizeFaviconDomain(domain) {
	    const safe = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
	    if (!safe) return '';
	    if (safe.indexOf('www.') === 0) return safe.slice(4);
	    return safe;
	  }

	  function setFaviconCache(domain, src) {
	    if (!domain || typeof src !== 'string') return;
	    const safeDomain = String(domain).trim().toLowerCase();
	    if (!safeDomain) return;
	    const domainsToSet = [];
	    domainsToSet.push(safeDomain);
	    // 额外为根域名写一份缓存键，提升跨子域命中率（例如 foo.example.com 与 bar.example.com 共用）
	    const root = getRootDomain(safeDomain);
	    if (root && root !== safeDomain) {
	      const rootNormalized = normalizeFaviconDomain(root);
	      if (rootNormalized && rootNormalized !== safeDomain) {
	        domainsToSet.push(rootNormalized);
	      } else if (root !== safeDomain) {
	        domainsToSet.push(root);
	      }
	    }
	    for (let i = 0; i < domainsToSet.length; i++) {
	      const key = domainsToSet[i];
	      if (!key) continue;
	      if (faviconCache.has(key)) {
	        faviconCache.delete(key);
	      }
	      faviconCache.set(key, src);
	    }
	    // LRU 淘汰（Map 迭代顺序即插入顺序，第一个是最旧的）
	    while (faviconCache.size > faviconCacheMaxSize) {
	      const oldest = faviconCache.keys().next().value;
	      faviconCache.delete(oldest);
	    }
	  }

	  // Favicon persistence batching (domain -> {domain, src, updatedAt})
	  let faviconPersistQueue = Object.create(null);
	  let faviconPersistQueueSize = 0;
	  let faviconPersistFlushTimer = null;
	  let faviconPersistFlushPromise = null;
	  // Used to ignore stale async favicon updates after re-render.
	  let faviconRenderToken = 0;
	  // Warmup state: prefetch favicons after closing the overlay.
	  let faviconWarmupTimer = null;
	  let faviconWarmupInProgress = false;
	  let faviconWarmupQueued = false;
	  let faviconWarmupRunId = 0;
	  // Focus retries (some pages may steal focus immediately after injection/show).
	  let focusRetryTimer = null;
	  let focusTrapEnabled = false;
	  let globalKeydownTrapEnabled = false;
	  let focusEnforcerTimer = null;

	  let currentTheme = 'original';

	  async function loadThemeSetting() {
	    try {
	      const result = await chrome.storage.local.get('theme');
	      if (result.theme && typeof result.theme === 'string') {
	        currentTheme = result.theme;
	        applyThemeToOverlay();
	      }
	    } catch (e) {}
	  }

	  function applyThemeToOverlay() {
	    if (!searchOverlay) return;
	    searchOverlay.setAttribute('data-bs-theme', currentTheme);
	  }

	  // 初始化时加载缓存设置
	  validateMessageActionsConfig();
	  loadFaviconCacheSettings();
	  loadThemeSetting();

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
  searchOverlay.setAttribute('data-bs-theme', currentTheme);
  searchOverlay.setAttribute('role', 'dialog');
  searchOverlay.setAttribute('aria-modal', 'true');
  searchOverlay.setAttribute('aria-label', '书签搜索');
  searchOverlay.tabIndex = -1;
  console.log("[Content] 搜索遮罩层已创建");
  
  searchContainer = document.createElement("div");
  searchContainer.className = "bookmark-search-container";

  searchInput = document.createElement("input");
  searchInput.className = "bookmark-search-input";
  searchInput.placeholder = "搜索书签...";
  searchInput.setAttribute('role', 'combobox');
  searchInput.setAttribute('aria-label', '搜索书签');
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.setAttribute('aria-controls', 'bs-results-listbox');
  searchInput.setAttribute('aria-autocomplete', 'list');

  resultsContainer = document.createElement("div");
  resultsContainer.className = "bookmark-results";
  resultsContainer.id = "bs-results-listbox";
  resultsContainer.setAttribute('role', 'listbox');
  resultsContainer.setAttribute('aria-live', 'polite');
  resultsContainer.addEventListener('mousemove', () => {
    lastPointerMoveAt = Date.now();
  });

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
  searchInput.addEventListener('compositionstart', () => {
    imeComposing = true;
    imeEnterDuringComposition = false;
  });
  searchInput.addEventListener('compositionend', () => {
    imeComposing = false;
    // Some IMEs emit an extra "Enter" keydown after compositionend (same physical keypress used to commit).
    // Suppress Enter briefly to avoid accidental navigation; use a slightly longer window when Enter was used.
    const now = Date.now();
    imeSuppressEnterUntil = now + (imeEnterDuringComposition ? 80 : 30);
    imeEnterDuringComposition = false;
  });
  searchInput.addEventListener('blur', () => {
    imeComposing = false;
    imeEnterDuringComposition = false;
    imeSuppressEnterUntil = 0;
  });

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
  // If a favicon warmup is running (after a previous close), stop it to prioritize interactive UX.
  cancelFaviconWarmup();

  if (!document.body) {
    console.log("[Content] document.body 未就绪，等待 DOMContentLoaded 后再显示");
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showSearch, { once: true });
    } else {
      setTimeout(showSearch, 0);
    }
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
  }
  
  console.log("[Content] 显示搜索框");
  searchOverlay.style.display = "flex";
  enableFocusTrap();
  enableGlobalKeydownTrap();
  try {
    if (searchOverlay && typeof searchOverlay.focus === 'function') {
      searchOverlay.focus({ preventScroll: true });
    }
  } catch (e) {
    try { searchOverlay && searchOverlay.focus && searchOverlay.focus(); } catch (e2) {}
  }
  try {
    const active = document.activeElement;
    if (active && active !== searchInput && typeof active.blur === 'function') {
      active.blur();
    }
  } catch (e) {}
  if (focusRetryTimer) clearTimeout(focusRetryTimer);
  focusSearchInput();
  // 精简焦点重试：1 次 rAF + 1 次 setTimeout（原 5 次过度重试）
  requestAnimationFrame(() => {
    if (!searchOverlay || searchOverlay.style.display === "none") return;
    focusSearchInput();
  });
  focusRetryTimer = setTimeout(() => {
    focusRetryTimer = null;
    if (!searchOverlay || searchOverlay.style.display === "none") return;
    focusSearchInput();
  }, 50);
  startFocusEnforcer();
  console.log("[Content] 搜索框已显示并聚焦");
}

// 隐藏搜索界面
function hideSearch() {
  console.log("[Content] hideSearch 被调用");
  
  if (!searchOverlay) {
    console.log("[Content] searchOverlay 不存在，退出");
    return;
  }

  stopFocusEnforcer();
  disableFocusTrap();
  disableGlobalKeydownTrap();

  if (focusRetryTimer) { clearTimeout(focusRetryTimer); focusRetryTimer = null; }
  
  clearTimeout(searchDebounceTimer);
  // Cancel any in-flight background search so it can't repopulate the UI after close.
  backgroundSearchToken++;

  searchOverlay.style.display = "none";
  if (searchInput) searchInput.value = "";
  if (resultsContainer) resultsContainer.innerHTML = "";
  filteredResults = [];
  selectedIndex = -1;
  cachedResultItems = null; // 清除 DOM 缓存
  console.log("[Content] 搜索框已隐藏");

  // Persist any newly discovered favicons ASAP so other tabs can benefit without waiting for timers.
  flushFaviconPersistQueue();

  // Start favicon warmup after the overlay is closed (runs in the background within this content script lifetime).
  scheduleFaviconWarmup();
}

function focusSearchInput() {
  if (!searchInput) return;
  try {
    // preventScroll is supported in modern Chromium; fall back if unavailable.
    searchInput.focus({ preventScroll: true });
  } catch (e) {
    try { searchInput.focus(); } catch (e2) {}
  }
  try {
    const len = searchInput.value ? searchInput.value.length : 0;
    searchInput.setSelectionRange(len, len);
  } catch (e3) {}
}

function handleFocusTrap(event) {
  if (!focusTrapEnabled) return;
  if (!searchOverlay || searchOverlay.style.display === "none") return;
  if (!searchInput) return;
  const target = event && event.target;
  if (target === searchInput) return;
  focusSearchInput();
}

function enableFocusTrap() {
  if (focusTrapEnabled) return;
  focusTrapEnabled = true;
  document.addEventListener('focusin', handleFocusTrap, true);
}

function disableFocusTrap() {
  if (!focusTrapEnabled) return;
  focusTrapEnabled = false;
  document.removeEventListener('focusin', handleFocusTrap, true);
}

function handleGlobalKeydown(event) {
  if (!globalKeydownTrapEnabled) return;
  if (!searchOverlay || searchOverlay.style.display === "none") return;
  if (!event || typeof event !== 'object') return;

  // If the user is already interacting with our overlay, let normal handlers run.
  if (event.target && searchOverlay.contains(event.target)) return;

  // Ignore IME composition keystrokes.
  if (event.isComposing) return;
  if (event.keyCode === 229) return;

  // Always try to focus the input while overlay is visible.
  focusSearchInput();

  const key = event.key;
  if (key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    hideSearch();
    return;
  }

  if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    handleKeydown(event);
    return;
  }

  if (!searchInput) return;

  if (key === 'Backspace') {
    event.preventDefault();
    event.stopPropagation();
    const value = String(searchInput.value || '');
    if (value.length > 0) {
      searchInput.value = value.slice(0, -1);
      handleSearchDebounced({ target: searchInput });
    }
    return;
  }

  if (key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  // Printable characters: redirect into the search input.
  if (typeof key === 'string' && key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    searchInput.value = String(searchInput.value || '') + key;
    handleSearchDebounced({ target: searchInput });
  }
}

function enableGlobalKeydownTrap() {
  if (globalKeydownTrapEnabled) return;
  globalKeydownTrapEnabled = true;
  document.addEventListener('keydown', handleGlobalKeydown, true);
}

function disableGlobalKeydownTrap() {
  if (!globalKeydownTrapEnabled) return;
  globalKeydownTrapEnabled = false;
  document.removeEventListener('keydown', handleGlobalKeydown, true);
}

function startFocusEnforcer() {
  stopFocusEnforcer();
  focusEnforcerTimer = setInterval(() => {
    if (!searchOverlay || searchOverlay.style.display === "none") {
      stopFocusEnforcer();
      return;
    }
    if (!searchInput) return;
    if (document.activeElement === searchInput) return;
    focusSearchInput();
  }, 350);
}

function stopFocusEnforcer() {
  if (!focusEnforcerTimer) return;
  clearInterval(focusEnforcerTimer);
  focusEnforcerTimer = null;
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
  // Prefer our own composition state over legacy keyCode=229 (macOS IME can keep 229 briefly after commit).
  const composing = !!(imeComposing || (e && e.isComposing));
  switch (e.key) {
    case "Escape":
      hideSearch();
      break;
    case "ArrowDown":
      if (composing) return;
      lastPointerMoveAt = 0;
      e.preventDefault();
      if (filteredResults.length > 0) {
        selectedIndex = selectedIndex >= filteredResults.length - 1 ? 0 : selectedIndex + 1;
        updateSelection();
      }
      break;
    case "ArrowUp":
      if (composing) return;
      lastPointerMoveAt = 0;
      e.preventDefault();
      if (filteredResults.length > 0) {
        selectedIndex = selectedIndex <= 0 ? filteredResults.length - 1 : selectedIndex - 1;
        updateSelection();
      }
      break;
    case "Enter":
      if (composing) {
        imeEnterDuringComposition = true;
        return;
      }
      if (imeSuppressEnterUntil && Date.now() < imeSuppressEnterUntil) {
        e.preventDefault();
        // 仅抑制一次，避免某些 IME 场景下需要 3 次 Enter 才能打开
        imeSuppressEnterUntil = 0;
        return;
      }
      imeSuppressEnterUntil = 0;
      e.preventDefault();
      if (selectedIndex >= 0 && filteredResults[selectedIndex]) {
        // 按住 Ctrl/Cmd 时在当前页打开，否则在新标签打开
        openBookmark(filteredResults[selectedIndex], !(e.ctrlKey || e.metaKey));
      }
      break;
  }
}

// 更新选中项的高亮
function updateSelection(options) {
  const shouldScroll = !(options && typeof options === 'object' && options.scroll === false);
  // 使用缓存的 DOM 引用（由 displayResults 设置），避免每次导航都查询
  const items = cachedResultItems || resultsContainer.querySelectorAll(".bookmark-item");
  let activeId = '';
  items.forEach((item, index) => {
    if (index === selectedIndex) {
      item.classList.add("selected");
      item.setAttribute('aria-selected', 'true');
      if (shouldScroll) {
        // 直接操作 scrollTop，避免 scrollIntoView 连带滚动宿主页面
        const ct = resultsContainer;
        const itemTop = item.offsetTop - ct.offsetTop;
        const itemBottom = itemTop + item.offsetHeight;
        if (itemTop < ct.scrollTop) {
          ct.scrollTop = itemTop;
        } else if (itemBottom > ct.scrollTop + ct.clientHeight) {
          ct.scrollTop = itemBottom - ct.clientHeight;
        }
      }
      activeId = item.id || '';
    } else {
      item.classList.remove("selected");
      item.setAttribute('aria-selected', 'false');
    }
  });
  if (searchInput) {
    searchInput.setAttribute('aria-activedescendant', activeId);
  }
}

	// 防抖搜索
	function handleSearchDebounced(e) {
	  clearTimeout(searchDebounceTimer);
	  searchDebounceTimer = setTimeout(() => {
	    handleSearch(e.target.value);
	  }, 200);
	}

	function sendMessagePromise(message, timeoutMs) {
	  const limit = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 30000;
	  return new Promise((resolve, reject) => {
	    let settled = false;
	    const timer = setTimeout(() => {
	      if (!settled) { settled = true; reject(new Error('sendMessage timeout')); }
	    }, limit);
	    try {
	      chrome.runtime.sendMessage(message, (response) => {
	        if (settled) return;
	        settled = true;
	        clearTimeout(timer);
	        const lastError = chrome.runtime && chrome.runtime.lastError;
	        if (lastError) {
	          reject(lastError);
	          return;
	        }
	        resolve(response);
	      });
	    } catch (error) {
	      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
	    }
	  });
	}


	function isLoadableIconSrc(src) {
	  const safe = typeof src === 'string' ? src.trim() : '';
	  if (!safe) return false;
	  if (safe === defaultIcon) return false;
	  const lower = safe.toLowerCase();
	  if (lower.indexOf('chrome://') === 0) return false;
	  if (lower.indexOf('edge://') === 0) return false;
	  if (lower.indexOf('about:') === 0) return false;
	  if (lower.indexOf('chrome-extension://') === 0) return false;
	  if (lower.indexOf('edge-extension://') === 0) return false;
	  if (lower.indexOf('javascript:') === 0) return false;
	  if (lower.indexOf('data:text/html') === 0) return false;
	  return true;
	}

	function isIpAddress(host) {
	  const safe = typeof host === 'string' ? host.trim() : '';
	  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(safe)) return false;
	  const parts = safe.split('.');
	  for (let i = 0; i < parts.length; i++) {
	    const n = Number(parts[i]);
	    if (!Number.isFinite(n) || n < 0 || n > 255) return false;
	  }
	  return true;
	}

	function isLikelyPrivateHost(host) {
	  const safe = typeof host === 'string' ? host.trim().toLowerCase() : '';
	  if (!safe) return false;
	  if (safe === 'localhost') return true;
	  if (isIpAddress(safe)) return true;
	  if (safe.endsWith('.local')) return true;
	  if (safe.indexOf('.') === -1) return true;
	  return false;
	}

	function prefetchImage(url, timeoutMs) {
	  return new Promise((resolve) => {
	    const safeUrl = url ? String(url) : '';
	    if (!safeUrl) {
	      resolve(false);
	      return;
	    }

	    const img = new Image();
	    let done = false;

	    function finish(ok) {
	      if (done) return;
	      done = true;
	      img.onload = null;
	      img.onerror = null;
	      resolve(ok);
	    }

	    const ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 8000;
	    const timer = setTimeout(() => finish(false), ms);

	    img.onload = function() {
	      clearTimeout(timer);
	      finish(true);
	    };
	    img.onerror = function() {
	      clearTimeout(timer);
	      finish(false);
	    };
	    img.src = safeUrl;
	  });
	}

	function scheduleFaviconPersistFlush() {
	  if (faviconPersistFlushTimer) return;
	  faviconPersistFlushTimer = setTimeout(() => {
	    faviconPersistFlushTimer = null;
	    flushFaviconPersistQueue();
	  }, 800);
	}

	function flushFaviconPersistQueue() {
	  if (faviconPersistFlushTimer) {
	    clearTimeout(faviconPersistFlushTimer);
	    faviconPersistFlushTimer = null;
	  }
	  if (faviconPersistFlushPromise) {
	    // Chain a follow-up flush for items queued during the current in-flight flush
	    faviconPersistFlushPromise.then(() => {
	      if (faviconPersistQueueSize > 0) scheduleFaviconPersistFlush();
	    });
	    return faviconPersistFlushPromise;
	  }
	  if (!faviconPersistQueue || faviconPersistQueueSize === 0) return Promise.resolve();

	  const entries = [];
	  for (const domain in faviconPersistQueue) {
	    if (!Object.prototype.hasOwnProperty.call(faviconPersistQueue, domain)) continue;
	    const entry = faviconPersistQueue[domain];
	    if (entry && entry.domain && entry.src) entries.push(entry);
	  }

	  faviconPersistQueue = Object.create(null);
	  faviconPersistQueueSize = 0;

	  faviconPersistFlushPromise = sendMessagePromise({ action: MESSAGE_ACTIONS.SET_FAVICONS, entries })
	    .catch((error) => {
	      console.warn("[Content] SET_FAVICONS 失败:", error);
	    })
	    .finally(() => {
	      faviconPersistFlushPromise = null;
	    });

	  return faviconPersistFlushPromise;
	}

	function queuePersistFavicon(domain, src) {
	  const safeDomain = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
	  const safeSrc = typeof src === 'string' ? src.trim() : '';
	  if (!safeDomain || !safeSrc) return;
	  if (!isLoadableIconSrc(safeSrc)) return;
	  // Avoid persisting browser-provided favicons (data URLs). Browser cache is the source of truth here.
	  if (safeSrc.indexOf('data:') === 0) return;

	  // 只持久化 normalized key（去 www.），避免 IDB 双 key 浪费
	  const key = normalizeFaviconDomain(safeDomain) || safeDomain;
	  const existed = !!faviconPersistQueue[key];
	  faviconPersistQueue[key] = { domain: key, src: safeSrc, updatedAt: Date.now() };
	  if (!existed) faviconPersistQueueSize++;

	  if (faviconPersistQueueSize >= 50) {
	    flushFaviconPersistQueue();
	  } else {
	    scheduleFaviconPersistFlush();
	  }
	}

	async function fetchPersistedFavicons(domains) {
	  const list = Array.isArray(domains) ? domains : [];
	  const uniq = [];
	  const seen = Object.create(null);
	  for (let i = 0; i < list.length; i++) {
	    const raw = typeof list[i] === 'string' ? list[i].trim() : '';
	    if (!raw) continue;

	    const lower = raw.toLowerCase();
	    const normalized = normalizeFaviconDomain(lower);

	    const variants = [lower];
	    if (normalized && normalized !== lower) variants.push(normalized);

	    // Compatibility: old caches might store `www.` variants even when current normalization strips them.
	    if (normalized && normalized.indexOf('.') !== -1 && normalized !== 'localhost' && !isIpAddress(normalized)) {
	      variants.push('www.' + normalized);
	    }

	    for (let j = 0; j < variants.length; j++) {
	      const d = variants[j];
	      if (!d) continue;
	      if (seen[d]) continue;
	      seen[d] = true;
	      uniq.push(d);
	    }
	  }

	  if (uniq.length === 0) return {};

	  try {
	    const response = await sendMessagePromise({ action: MESSAGE_ACTIONS.GET_FAVICONS, domains: uniq });
	    if (!response || response.success === false) return {};
	    const favicons = response.favicons;
	    return favicons && typeof favicons === 'object' ? favicons : {};
	  } catch (error) {
	    console.warn("[Content] GET_FAVICONS 失败:", error);
	    return {};
	  }
	}

	function applyFaviconToImages(images, src, token) {
	  const safeSrc = typeof src === 'string' ? src : '';
	  if (!safeSrc) return;
	  if (!Array.isArray(images) || images.length === 0) return;
	  for (let i = 0; i < images.length; i++) {
	    if (token !== faviconRenderToken) return;
	    const img = images[i];
	    if (!img) continue;
	    if (img.isConnected === false) continue;
	    img.src = safeSrc;
	  }
	}

	function fetchBrowserFaviconForPageUrl(pageUrl) {
	  const safePageUrl = pageUrl ? String(pageUrl).trim() : '';
	  if (!safePageUrl) return Promise.resolve('');

	  return sendMessagePromise({ action: MESSAGE_ACTIONS.GET_BROWSER_FAVICON, pageUrl: safePageUrl })
	    .then((response) => {
	      if (!response || response.success === false) return '';
	      const src = response && typeof response.src === 'string' ? response.src : '';
	      if (!src) return '';
	      if (!isLoadableIconSrc(src)) return '';
	      return src;
	    })
	    .catch(() => '');
	}

	function getCachedFaviconForDomain(domain) {
	  const raw = typeof domain === 'string' ? domain.trim() : '';
	  if (!raw) return '';

	  const lower = raw.toLowerCase();
	  const normalized = normalizeFaviconDomain(lower);
	  const root = getRootDomain(normalized || lower);
	  const rootNormalized = root ? normalizeFaviconDomain(root) : '';

	  const candidates = [];
	  if (normalized) candidates.push(normalized);
	  candidates.push(lower);

	  if (normalized && normalized.indexOf('.') !== -1 && normalized !== 'localhost' && !isIpAddress(normalized)) {
	    candidates.push('www.' + normalized);
	  }

	  if (rootNormalized) candidates.push(rootNormalized);
	  if (rootNormalized && rootNormalized.indexOf('.') !== -1 && rootNormalized !== 'localhost' && !isIpAddress(rootNormalized)) {
	    candidates.push('www.' + rootNormalized);
	  }

	  if (root) candidates.push(root);

	  for (let i = 0; i < candidates.length; i++) {
	    const key = candidates[i];
	    if (!key) continue;
	    const src = faviconCache.get(key);
	    if (typeof src !== 'string' || !src) continue;
	    if (!isLoadableIconSrc(src)) continue;
	    return src;
	  }

	  return '';
	}

	function hydrateFaviconsForDomains(domains, domainToImages, domainToPageUrl, token) {
	  const list = Array.isArray(domains) ? domains : [];
	  if (list.length === 0) return;

	  const uniq = [];
	  const seen = Object.create(null);
	  for (let i = 0; i < list.length; i++) {
	    const raw = typeof list[i] === 'string' ? list[i].trim().toLowerCase() : '';
	    if (!raw) continue;
	    if (seen[raw]) continue;
	    seen[raw] = true;
	    uniq.push(raw);
	  }
	  if (uniq.length === 0) return;

	  // Phase 1: apply memory cache hits immediately (populated by search response favicons)
	  const afterMemory = [];
	  for (let i = 0; i < uniq.length; i++) {
	    const domain = uniq[i];
	    const cached = getCachedFaviconForDomain(domain);
	    if (cached) {
	      applyFaviconToImages(domainToImages[domain], cached, token);
	    } else {
	      afterMemory.push(domain);
	    }
	  }
	  if (afterMemory.length === 0) return;

	  // Phase 2: batch IDB → batch browser favicon → external fallback (all async)
	  doAsyncHydration(afterMemory, domainToImages, domainToPageUrl, token)
	    .catch(() => {});
	}

	async function doAsyncHydration(domains, domainToImages, domainToPageUrl, token) {
	  // 2a) Batch IDB load
	  const requestDomains = [];
	  const reqSeen = Object.create(null);
	  for (let i = 0; i < domains.length; i++) {
	    const domain = domains[i];
	    if (!reqSeen[domain]) { reqSeen[domain] = true; requestDomains.push(domain); }
	    const root = getRootDomain(domain);
	    if (root && !reqSeen[root]) { reqSeen[root] = true; requestDomains.push(root); }
	  }

	  try {
	    const persisted = await fetchPersistedFavicons(requestDomains);
	    const map = (persisted && typeof persisted === 'object') ? persisted : {};
	    for (const key in map) {
	      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
	      const entry = map[key];
	      if (!entry || typeof entry !== 'object') continue;
	      if (typeof entry.src !== 'string' || !entry.src) continue;
	      if (!isLoadableIconSrc(entry.src)) continue;
	      setFaviconCache(key, entry.src);
	    }
	  } catch (e) { /* proceed with remaining sources */ }

	  if (token !== faviconRenderToken) return;

	  // Apply IDB hits and collect still-missing domains
	  const afterIdb = [];
	  for (let i = 0; i < domains.length; i++) {
	    const domain = domains[i];
	    const cached = getCachedFaviconForDomain(domain);
	    if (cached) {
	      applyFaviconToImages(domainToImages[domain], cached, token);
	    } else {
	      afterIdb.push(domain);
	    }
	  }
	  if (afterIdb.length === 0) return;

	  // 2b) Batch browser favicon request (single message round-trip for all remaining domains)
	  try {
	    const items = afterIdb.map((domain) => ({
	      domain,
	      pageUrl: domainToPageUrl[domain] || ("https://" + domain)
	    }));
	    const response = await sendMessagePromise({
	      action: MESSAGE_ACTIONS.GET_BROWSER_FAVICONS_BATCH,
	      items
	    });
	    if (token !== faviconRenderToken) return;
	    const favicons = (response && response.favicons && typeof response.favicons === 'object') ? response.favicons : {};
	    for (const domain in favicons) {
	      if (!Object.prototype.hasOwnProperty.call(favicons, domain)) continue;
	      const src = typeof favicons[domain] === 'string' ? favicons[domain] : '';
	      if (!src || !isLoadableIconSrc(src)) continue;
	      setFaviconCache(domain, src);
	      applyFaviconToImages(domainToImages[domain], src, token);
	    }
	  } catch (e) { /* proceed to external */ }

	  if (token !== faviconRenderToken) return;

	  // 2c) External sources for still-missing domains (DDG/Google/Faviconkit)
	  const afterBrowser = [];
	  for (let i = 0; i < afterIdb.length; i++) {
	    const domain = afterIdb[i];
	    if (!getCachedFaviconForDomain(domain)) afterBrowser.push(domain);
	  }
	  if (afterBrowser.length === 0) return;

	  const concurrency = Math.min(4, afterBrowser.length);
	  let nextIndex = 0;

	  async function worker() {
	    while (nextIndex < afterBrowser.length) {
	      if (token !== faviconRenderToken) return;
	      const idx = nextIndex++;
	      const domain = afterBrowser[idx];
	      const pageUrl = domainToPageUrl[domain] || ("https://" + domain);
	      await new Promise((resolve) => {
	        loadFavicon(domain, pageUrl, function(url) {
	          if (token !== faviconRenderToken) { resolve(); return; }
	          const safeUrl = typeof url === 'string' ? url : '';
	          if (safeUrl && isLoadableIconSrc(safeUrl)) {
	            setFaviconCache(domain, safeUrl);
	            applyFaviconToImages(domainToImages[domain], safeUrl, token);
	            queuePersistFavicon(domain, safeUrl);
	          }
	          resolve();
	        }, { allowBrowserCache: false, allowExternal: true });
	      });
	    }
	  }

	  const workers = [];
	  for (let i = 0; i < concurrency; i++) workers.push(worker());
	  await Promise.all(workers);
	}

	function cancelFaviconWarmup() {
	  faviconWarmupRunId++;
	  faviconWarmupQueued = false;
	  if (faviconWarmupTimer) {
	    clearTimeout(faviconWarmupTimer);
	    faviconWarmupTimer = null;
	  }
	}

	function scheduleFaviconWarmup() {
	  if (faviconWarmupInProgress) {
	    faviconWarmupQueued = true;
	    return;
	  }
	  if (faviconWarmupTimer) clearTimeout(faviconWarmupTimer);
	  faviconWarmupTimer = setTimeout(() => {
	    faviconWarmupTimer = null;
	    startFaviconWarmup();
	  }, 1500);
	}

	function fetchWarmupDomainMapFromBackground(limit) {
	  const max = (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) ? Math.floor(limit) : 400;
	  return sendMessagePromise({ action: MESSAGE_ACTIONS.GET_WARMUP_DOMAINS, limit: max })
	    .then((response) => {
	      if (!response || response.success === false) return null;
	      const map = response && response.domainToPageUrl;
	      if (!map || typeof map !== 'object') return null;
	      return map;
	    })
	    .catch(() => null);
	}

	async function warmupDomains(domains, domainToPageUrl, runId) {
	  const list = Array.isArray(domains) ? domains : [];
	  if (list.length === 0) return;

	  const concurrency = 4;
	  let nextIndex = 0;

	  function loadFaviconPromise(domain, pageUrl) {
	    return new Promise((resolve) => {
	      // Warmup domains have already missed memory + IDB caches.
	      // Skip browser cache (250ms timeout per domain) to avoid warmup being heavy.
	      // During actual search, hydrateOne step 3 still checks browser cache.
	      loadFavicon(domain, pageUrl, resolve, { allowBrowserCache: false, allowExternal: true });
	    });
	  }

	  async function worker() {
	    while (nextIndex < list.length) {
	      const index = nextIndex++;
	      const domain = list[index];
	      if (runId !== faviconWarmupRunId) return;
	      const pageUrl = domainToPageUrl[domain] || ("https://" + domain);
	      const src = await loadFaviconPromise(domain, pageUrl);
	      if (runId !== faviconWarmupRunId) return;
	      const safeSrc = typeof src === 'string' ? src : '';
	      if (!safeSrc) continue;
	      if (!isLoadableIconSrc(safeSrc)) continue;
	      setFaviconCache(domain, safeSrc);
	      queuePersistFavicon(domain, safeSrc);
	    }
	  }

	  const workers = [];
	  for (let i = 0; i < concurrency; i++) {
	    workers.push(worker());
	  }
	  await Promise.all(workers);
	}

	async function startFaviconWarmup() {
	  if (faviconWarmupInProgress) {
	    faviconWarmupQueued = true;
	    return;
	  }

	  const runId = ++faviconWarmupRunId;
	  faviconWarmupInProgress = true;
	  try {
	    const domainToPageUrl = await fetchWarmupDomainMapFromBackground(600);
	    if (!domainToPageUrl) return;

	    const domains = Object.keys(domainToPageUrl || {});
	    if (domains.length === 0) return;

	    const persisted = await fetchPersistedFavicons(domains);
	    if (runId !== faviconWarmupRunId) return;

	    for (const key in persisted) {
	      if (!Object.prototype.hasOwnProperty.call(persisted, key)) continue;
	      const entry = persisted[key];
	      if (!entry || typeof entry !== 'object') continue;
	      if (typeof entry.src !== 'string' || !entry.src) continue;
	      if (!isLoadableIconSrc(entry.src)) continue;
	      setFaviconCache(key, entry.src);
	    }

	    const missing = [];
	    for (let i = 0; i < domains.length; i++) {
	      const domain = domains[i];
	      if (getCachedFaviconForDomain(domain)) continue;
	      missing.push(domain);
	    }

	    if (missing.length === 0) return;

	    await warmupDomains(missing, domainToPageUrl, runId);
	    if (runId !== faviconWarmupRunId) return;

	    await flushFaviconPersistQueue();
	  } catch (error) {
	    console.warn("[Content] favicon 预热失败:", error);
	  } finally {
	    faviconWarmupInProgress = false;
	    if (faviconWarmupQueued) {
	      faviconWarmupQueued = false;
	      scheduleFaviconWarmup();
	    }
	  }
	}

async function searchBookmarksInBackground(query) {
	  const token = ++backgroundSearchToken;

	  try {
	    const response = await sendMessagePromise({ action: MESSAGE_ACTIONS.SEARCH_BOOKMARKS, query });
	    if (token !== backgroundSearchToken) return;

	    if (!response || response.success === false) {
	      const err = response && response.error;
	      const message = (err && typeof err === 'object' && typeof err.message === 'string')
	        ? err.message
	        : (typeof err === 'string' ? err : 'Search failed');
	      throw new Error(message);
	    }

	    const favicons = response && response.favicons;
	    if (favicons && typeof favicons === 'object') {
	      for (const domain in favicons) {
	        if (!Object.prototype.hasOwnProperty.call(favicons, domain)) continue;
	        const entry = favicons[domain];
	        if (!entry || typeof entry !== 'object') continue;
	        const src = typeof entry.src === 'string' ? entry.src : '';
	        if (!src) continue;
	        if (!isLoadableIconSrc(src)) continue;
	        setFaviconCache(domain, src);
	      }
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
	    cachedResultItems = null;
	    resultsContainer.innerHTML = "";

	    const emptyMsg = document.createElement("div");
	    emptyMsg.className = "bookmark-empty";
	    emptyMsg.textContent = "搜索失败，请重试";
	    resultsContainer.appendChild(emptyMsg);
	  }
	}

	// 处理搜索
	function handleSearch(query) {
	  // Invalidate any in-flight background search for previous queries.
	  backgroundSearchToken++;
	  const rawQuery = String(query || '').trim();
	  
	  if (!rawQuery) {
	    filteredResults = [];
	    resultsContainer.innerHTML = "";
	    cachedResultItems = null;
	    selectedIndex = -1;
	    if (searchInput) {
	      searchInput.setAttribute('aria-expanded', 'false');
	      searchInput.setAttribute('aria-activedescendant', '');
	    }
	    return;
	  }

	  searchBookmarksInBackground(rawQuery);
}

// 显示搜索结果
function displayResults(results) {
  resultsContainer.innerHTML = "";
  cachedResultItems = null; // 清除缓存
  const token = ++faviconRenderToken;
  const domainToImages = Object.create(null);
  const domainToPageUrl = Object.create(null);

  searchInput.setAttribute('aria-expanded', results.length > 0 ? 'true' : 'false');
  if (results.length === 0) {
    searchInput.setAttribute('aria-activedescendant', '');
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "bookmark-empty";
    emptyMsg.textContent = "未找到匹配的书签";
    resultsContainer.appendChild(emptyMsg);
    return;
  }

  // 使用 DocumentFragment 批量插入，减少重排次数
  const fragment = document.createDocumentFragment();

  results.forEach((bookmark, index) => {
    const item = document.createElement("div");
    item.className = "bookmark-item";
    item.id = 'bs-result-' + index;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
    if (index === selectedIndex) {
      item.classList.add("selected");
      searchInput.setAttribute('aria-activedescendant', item.id);
    }

    const favicon = document.createElement("img");
    favicon.className = "bookmark-favicon";
    favicon.src = defaultIcon;
    let domain = "";
    try { domain = new URL(bookmark.url).hostname; } catch (e) {}
    if (domain) {
      domain = String(domain || '').trim().toLowerCase();
      const domainKey = normalizeFaviconDomain(domain);
      const key = domainKey || domain;
      // 优先使用内存缓存（包括 data: 和外部 URL），避免二次搜索延迟
      const cachedSrc = getCachedFaviconForDomain(key);
      if (cachedSrc) {
        favicon.src = cachedSrc;
      } else {
        if (!domainToImages[key]) domainToImages[key] = [];
        domainToImages[key].push(favicon);
        if (!domainToPageUrl[key]) {
          // Use the full bookmark URL for better browser favicon cache hits.
          let pageUrl = '';
          try {
            pageUrl = String(bookmark && bookmark.url ? bookmark.url : '');
            pageUrl = pageUrl ? new URL(pageUrl).href : '';
          } catch (e) {}
          domainToPageUrl[key] = pageUrl || ("https://" + (domainKey || domain));
        }
      }
    }

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
      if (!lastPointerMoveAt || Date.now() - lastPointerMoveAt > 200) return;
      selectedIndex = index;
      // Hover 只更新高亮，不应改变滚动位置（否则会出现“列表顶部跳到当前悬浮项”的体验）
      updateSelection({ scroll: false });
    });

    item.addEventListener("click", (e) => {
      // 按住 Ctrl/Cmd 时在当前页打开，否则在新标签打开
      openBookmark(bookmark, !(e.ctrlKey || e.metaKey));
    });

    fragment.appendChild(item);
  });

  // 一次性插入所有结果
  resultsContainer.appendChild(fragment);

  // 缓存结果项 DOM 引用，供 updateSelection 使用（避免重复 querySelectorAll）
  cachedResultItems = resultsContainer.querySelectorAll(".bookmark-item");

  const domainsToHydrate = Object.keys(domainToImages);
  if (domainsToHydrate.length > 0) {
    hydrateFaviconsForDomains(domainsToHydrate, domainToImages, domainToPageUrl, token);
  }
}

// 加载 Favicon
	var defaultIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23999' d='M8 0a8 8 0 100 16A8 8 0 008 0z'/%3E%3C/svg%3E";
  var externalFaviconFailTimestamps = [];
  var externalFaviconCircuitUntil = 0;

  function canUseExternalFavicons() {
    var now = Date.now();
    return now >= externalFaviconCircuitUntil;
  }

  function recordExternalFaviconFailure() {
    var now = Date.now();
    externalFaviconFailTimestamps.push(now);
    // 只保留最近 10 秒的失败记录
    var windowMs = 10000;
    var cutoff = now - windowMs;
    externalFaviconFailTimestamps = externalFaviconFailTimestamps.filter(function (ts) {
      return typeof ts === 'number' && ts >= cutoff;
    });
    if (externalFaviconFailTimestamps.length >= 20 && now >= externalFaviconCircuitUntil) {
      // 10 秒内失败 >= 20 次，30 秒内不再请求外部 favicon
      externalFaviconCircuitUntil = now + 30000;
    }
  }

function loadFavicon(domain, pageUrl, callback, options) {
  // 提取一级域名（IP/localhost 直接返回自身）
  var rootDomain = getRootDomain(domain);
  var isSubdomain = rootDomain && domain !== rootDomain;

  var allowExternal = !options || options.allowExternal !== false;
  var allowBrowserCache = !options || options.allowBrowserCache !== false;
  var safePageUrl = pageUrl ? String(pageUrl) : '';
  var done = false;

  function finish(url) {
    if (done) return;
    done = true;
    if (callback) callback(url);
  }

  // 构建源列表：优先浏览器 favicon 缓存，再按需降级第三方源。
  // 注意：不要直接请求站点自身 /favicon.ico（会触发 Mixed Content、证书错误、CORP 阻断等，且在 https 页面里 http 图标会被自动升级导致失败）。
  var sources = [];

  // 对局域网/私有主机：不走第三方 favicon 服务（一般会 404，且有隐私泄露）
  var isPrivateHost = isLikelyPrivateHost(domain);

  if (allowExternal && !isPrivateHost) {
    // DDG
    sources.push("https://icons.duckduckgo.com/ip3/" + domain + ".ico");
    if (isSubdomain) {
      sources.push("https://icons.duckduckgo.com/ip3/" + rootDomain + ".ico");
    }

    // Google
    sources.push("https://www.google.com/s2/favicons?domain=" + domain + "&sz=32");
    if (isSubdomain) {
      sources.push("https://www.google.com/s2/favicons?domain=" + rootDomain + "&sz=32");
    }

    // Faviconkit
    sources.push("https://api.faviconkit.com/" + domain + "/32");
    if (isSubdomain) {
      sources.push("https://api.faviconkit.com/" + rootDomain + "/32");
    }
  }

  function tryLoad(idx) {
    if (done) return;
    if (idx >= sources.length) {
      finish(defaultIcon);
      return;
    }
    if (!allowExternal || !canUseExternalFavicons()) {
      finish(defaultIcon);
      return;
    }
    var url = sources[idx];
    var isDDG = url.indexOf("duckduckgo.com") !== -1;
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      tryLoad(idx + 1);
    }, 3000);

    var img = new Image();
    img.onload = function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (isDDG && img.naturalWidth === 48 && img.naturalHeight === 48) {
        recordExternalFaviconFailure();
        tryLoad(idx + 1);
        return;
      }
      finish(url);
    };
    img.onerror = function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      recordExternalFaviconFailure();
      tryLoad(idx + 1);
    };
    img.src = url;
  }

  if (allowBrowserCache && safePageUrl) {
    sendMessagePromise({ action: MESSAGE_ACTIONS.GET_BROWSER_FAVICON, pageUrl: safePageUrl })
      .then((response) => {
        if (!response || response.success === false) {
          tryLoad(0);
          return;
        }
        const src = response && typeof response.src === 'string' ? response.src : '';
        if (src && isLoadableIconSrc(src)) {
          finish(src);
          return;
        }
        tryLoad(0);
      })
      .catch(() => {
        tryLoad(0);
      });
    return;
  }

  tryLoad(0);
}

// 打开书签
function openBookmark(bookmark, newTab = true) {
  const url = bookmark && bookmark.url ? String(bookmark.url) : '';
  if (!url) return;

  // Best-effort: ensure favicon cache writes are kicked off before navigation / focus changes.
  flushFaviconPersistQueue();

	  // 记录用户实际选择的搜索结果，供 favicon 预热优先级使用（仅发送到 background，最佳努力）
	  try {
	    sendMessagePromise({ action: MESSAGE_ACTIONS.TRACK_BOOKMARK_OPEN, url }).catch(() => {});
	  } catch (e) {}

  if (newTab) {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  } else {
    window.location.href = url;
  }
  hideSearch();
}

// 监听来自background的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Content] 收到消息:", message);

  if (!message || typeof message !== 'object') {
    return false;
  }
  
  if (message.action === MESSAGE_ACTIONS.TOGGLE_SEARCH) {
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
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      setTimeout(init, 0);
    }
    return;
  }

  try {
    createSearchUI();
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

  // Best-effort flush when this page is unloaded (e.g., Ctrl+Enter navigation).
  window.addEventListener('pagehide', () => {
    flushFaviconPersistQueue();
  });

  // Mark loaded after all listeners are registered and init is attempted.
  window.__BOOKMARK_SEARCH_LOADED__ = true;
  console.log("[Content] content.js 加载完成");

  } catch (error) {
    console.error("[Content] content.js 加载失败:", error);
  } finally {
    window.__BOOKMARK_SEARCH_LOADING__ = false;
  }

})(); // 结束 IIFE
