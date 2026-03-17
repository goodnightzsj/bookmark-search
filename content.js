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
	  // Favicon debug defaults to enabled during verification.
	  // Set `window.__BOOKMARK_SEARCH_DEBUG_FAVICON__ = false` or `chrome.storage.local.set({ debugFavicon: false })` to turn it off.
	  let debugFavicon = true;
	  let faviconDebugLogBudget = 200;
	  function isFaviconDebugEnabled() {
	    try {
	      if (debugFavicon) return true;
	      return !!(window && window.__BOOKMARK_SEARCH_DEBUG_FAVICON__);
	    } catch (e) {
	      return debugFavicon;
	    }
	  }
	  function faviconDebugLog() {
	    if (!isFaviconDebugEnabled()) return;
	    if (faviconDebugLogBudget <= 0) return;
	    faviconDebugLogBudget--;
	    try {
	      const args = Array.prototype.slice.call(arguments);
	      args.unshift('[Content][Favicon]');
	      console.log.apply(console, args);
	    } catch (e) {}
	  }
	  async function loadDebugSettings() {
	    try {
	      const result = await chrome.storage.local.get('debugFavicon');
	      if (result && Object.prototype.hasOwnProperty.call(result, 'debugFavicon')) {
	        debugFavicon = result.debugFavicon !== false;
	      }
	      if (debugFavicon) {
	        console.log('[Content] debugFavicon enabled');
	      }
	    } catch (e) {}
	  }
	  // SYNC: values must match constants.js MESSAGE_ACTIONS (IIFE cannot import ES modules)
	  const MESSAGE_ACTIONS = {
	    SEARCH_BOOKMARKS: 'searchBookmarks',
	    GET_WARMUP_DOMAINS: 'getWarmupDomains',
	    GET_BROWSER_FAVICON: 'getBrowserFavicon',
	    GET_BROWSER_FAVICONS_BATCH: 'getBrowserFaviconsBatch',
	    GET_FAVICONS: 'getFavicons',
	    SET_FAVICONS: 'setFavicons',
	    TRACK_BOOKMARK_OPEN: 'trackBookmarkOpen',
	    TOGGLE_SEARCH: 'toggleSearch',
	    CLEAR_FAVICON_CACHE: 'clearFaviconCache'
	  };
	  const REQUIRED_MESSAGE_ACTIONS = {
	    SEARCH_BOOKMARKS: true,
	    GET_WARMUP_DOMAINS: true,
	    GET_BROWSER_FAVICON: true,
	    GET_BROWSER_FAVICONS_BATCH: true,
	    GET_FAVICONS: true,
	    SET_FAVICONS: true,
	    TRACK_BOOKMARK_OPEN: true,
	    TOGGLE_SEARCH: true,
	    CLEAR_FAVICON_CACHE: true
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
	  const FAVICON_CACHE_MAX_SIZE = 2000;
	  let faviconCache = new Map(); // Map 自动维护插入顺序，支持 O(1) 删除和查找
	  let faviconRenderFailureDomains = Object.create(null);

	  const FAVICON_IMG_DATASET = {
	    DOMAIN: 'bsFaviconDomain',
	    PAGE_URL: 'bsFaviconPageUrl',
	    TOKEN: 'bsFaviconToken',
	    CANDIDATE_SRC: 'bsFaviconCandidateSrc',
	    ERROR_SRC: 'bsFaviconErrorSrc'
	  };

	  chrome.storage.onChanged.addListener((changes, area) => {
	    if (area !== 'local') return;
	    if (changes.debugFavicon) {
	      debugFavicon = changes.debugFavicon.newValue !== false;
	      if (debugFavicon) console.log('[Content] debugFavicon enabled (storage.onChanged)');
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
	  const MULTI_PART_PUBLIC_SUFFIXES = new Set([
	    'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
	    'com.cn', 'net.cn', 'org.cn', 'gov.cn',
	    'com.au', 'net.au', 'org.au',
	    'co.jp', 'ne.jp',
	    'co.kr',
	    'com.br', 'com.mx', 'com.tr'
	  ]);

	  function getRootDomain(domain) {
	    const safe = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
	    if (!safe) return '';
	    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(safe)) return safe;
	    if (safe === 'localhost') return safe;
	    if (safe.indexOf('.') === -1) return safe;

	    const parts = safe.split('.').filter(Boolean);
	    if (parts.length <= 2) return safe;

	    const lastTwo = parts.slice(-2).join('.');
	    if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
	      return parts.slice(-3).join('.');
	    }
	    return lastTwo;
	  }

	  function normalizeFaviconDomain(domain) {
	    const safe = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
	    if (!safe) return '';
	    if (safe.indexOf('www.') === 0) return safe.slice(4);
	    return safe;
	  }

	  function getHostForPrivateCheck(value) {
	    const safe = typeof value === 'string' ? value.trim().toLowerCase() : '';
	    if (!safe) return '';
	    try {
	      if (safe.indexOf('://') !== -1) return new URL(safe).hostname.toLowerCase();
	    } catch (e) {}
	    if (safe[0] === '[') {
	      const end = safe.indexOf(']');
	      return end >= 0 ? safe.slice(1, end) : safe;
	    }
	    const colon = safe.lastIndexOf(':');
	    if (colon > 0 && /^\d+$/.test(safe.slice(colon + 1)) && safe.indexOf(':') === colon) {
	      return safe.slice(0, colon);
	    }
	    return safe;
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
	    const safe = getHostForPrivateCheck(host);
	    if (!safe) return false;
	    if (safe === 'localhost') return true;
	    if (isIpAddress(safe)) return true;
	    if (safe.endsWith('.local')) return true;
	    // Common internal-only pseudo-TLDs / reserved suffixes.
	    if (safe.endsWith('.lan')) return true;
	    if (safe.endsWith('.internal')) return true;
	    if (safe.endsWith('.intranet')) return true;
	    if (safe.endsWith('.corp')) return true;
	    if (safe.endsWith('.home')) return true;
	    if (safe.endsWith('.localdomain')) return true;
	    if (safe.indexOf('.') === -1) return true;
	    return false;
	  }

	  function buildFaviconServiceKey(domain, pageUrl) {
	    const safeDomain = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
	    const safePageUrl = typeof pageUrl === 'string' ? pageUrl.trim() : '';
	    if (!safeDomain && !safePageUrl) return '';
	    try {
	      if (safePageUrl) {
	        const url = new URL(safePageUrl);
	        const host = (url.host || '').trim().toLowerCase();
	        const hostname = (url.hostname || '').trim().toLowerCase();
	        if (host && isLikelyPrivateHost(hostname || host)) return host;
	      }
	    } catch (e) {}
	    return normalizeFaviconDomain(safeDomain) || safeDomain;
	  }

	  function setFaviconCache(domain, src) {
	    if (!domain || typeof src !== 'string') return;
	    const safeDomain = String(domain).trim().toLowerCase();
	    if (!safeDomain) return;
	    const domainsToSet = [];
	    domainsToSet.push(safeDomain);
	    if (!isLikelyPrivateHost(safeDomain)) {
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
	    while (faviconCache.size > FAVICON_CACHE_MAX_SIZE) {
	      const oldest = faviconCache.keys().next().value;
	      faviconCache.delete(oldest);
	    }
	  }

	  // Favicon persistence batching (domain -> persisted favicon entry)
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
	  let faviconWarmupLastAttemptAt = Object.create(null);
	  let faviconWarmupRetryAt = Object.create(null);
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
		  loadThemeSetting();
	  loadDebugSettings();

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
  if (focusRetryTimer) clearTimeout(focusRetryTimer);
  focusSearchInput();
  try {
    const active = document.activeElement;
    if (active && active !== searchInput && active !== searchOverlay && typeof active.blur === 'function') {
      active.blur();
      focusSearchInput();
    }
  } catch (e) {}
  // 精简焦点重试：1 次 rAF + 1 次 setTimeout（原 5 次过度重试）
  requestAnimationFrame(() => {
    if (!searchOverlay || searchOverlay.style.display === "none") return;
    focusSearchInput();
    requestAnimationFrame(() => {
      if (!searchOverlay || searchOverlay.style.display === "none") return;
      focusSearchInput();
    });
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

	function isTrustedPersistableFaviconSrc(src) {
	  const safe = typeof src === 'string' ? src.trim() : '';
	  if (!isLoadableIconSrc(safe)) return false;
	  return safe.indexOf('http://') === 0 || safe.indexOf('https://') === 0;
	}

	function isBrowserFaviconPlaceholderResult(result) {
	  if (!result || typeof result !== 'object') return false;
	  return !!result.isPlaceholder;
	}

	function isSuccessfulFaviconResult(result) {
  if (!result || typeof result !== 'object') return false;
  const src = typeof result.src === 'string' ? result.src.trim() : '';
  if (!src || !isLoadableIconSrc(src)) return false;
  return result.state !== 'failure';
}

function shouldRetryAfterBrowserResult(result) {
  if (!result || typeof result !== 'object') return true;
  if (result.isPlaceholder) return true;
  const src = typeof result.src === 'string' ? result.src.trim() : '';
  if (!src || !isLoadableIconSrc(src)) return true;
  return !isTrustedPersistableFaviconSrc(src);
}

function buildFaviconFailureEntry(domain, retryAt) {
	  const safeDomain = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
	  if (!safeDomain) return null;
	  const now = Date.now();
	  const fallbackTtl = 10 * 60 * 1000;
	  const safeRetryAt = (typeof retryAt === 'number' && Number.isFinite(retryAt) && retryAt > now)
	    ? retryAt
	    : (now + fallbackTtl);
	  return { domain: safeDomain, state: 'failure', retryAt: safeRetryAt, updatedAt: now };
	}

	function shouldPersistFaviconFailure(reason) {
	  const safeReason = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
	  return safeReason === 'origin-fast-fail';
	}

	function collectDeclaredFaviconCandidates(pageUrl) {
	  const candidates = [];
	  try {
	    const safePageUrl = typeof pageUrl === 'string' ? pageUrl.trim() : '';
	    if (!safePageUrl || typeof document === 'undefined' || !document || !document.querySelectorAll) return candidates;
	    const currentHref = String((window && window.location && window.location.href) || '');
	    const currentOrigin = String((window && window.location && window.location.origin) || '');
	    const target = new URL(safePageUrl);
	    if (!currentOrigin || target.origin !== currentOrigin) return candidates;
	    const links = document.querySelectorAll('link[rel]');
	    for (let i = 0; i < links.length; i++) {
	      const el = links[i];
	      if (!el) continue;
	      const rel = String(el.getAttribute('rel') || '').toLowerCase();
	      if (!rel) continue;
	      if (rel.indexOf('icon') === -1 && rel.indexOf('apple-touch-icon') === -1) continue;
	      const href = String(el.getAttribute('href') || '').trim();
	      if (!href) continue;
	      try {
	        const resolved = new URL(href, currentHref || currentOrigin).href;
	        if (!resolved) continue;
	        if (candidates.indexOf(resolved) === -1) candidates.push(resolved);
	      } catch (e) {}
	    }
	  } catch (e) {}
	  return candidates;
	}

	function appendUniqueCandidate(list, url) {
	  const safe = typeof url === 'string' ? url.trim() : '';
	  if (!safe) return;
	  if (list.indexOf(safe) === -1) list.push(safe);
	}

	function buildOriginFaviconCandidates(pageUrl) {
	  const candidates = [];
	  try {
	    const safePageUrl = typeof pageUrl === 'string' ? pageUrl.trim() : '';
	    if (!safePageUrl) return candidates;
	    const u = new URL(safePageUrl);
	    const origin = u && u.origin ? String(u.origin) : '';
	    if (!origin || origin === 'null') return candidates;
	    const pathname = String(u.pathname || '/');
	    const hostname = String(u.hostname || '').trim().toLowerCase();
	    const isPrivate = isLikelyPrivateHost(hostname);
	    const commonRootPaths = isPrivate
	      ? [
	        '/favicon.ico',
	        '/favicon.svg',
	        '/favicon.png',
	        '/icon.svg',
	        '/icon.png',
	        '/apple-touch-icon.png',
	        '/static/common/img/favicon/favicon.ico',
	        '/static/favicon.ico',
	        '/static/favicon.svg',
	        '/assets/favicon.ico',
	        '/assets/favicon.svg',
	        '/images/favicon.ico',
	        '/images/favicon.svg',
	        '/img/favicon.ico',
	        '/img/favicon.svg',
	        '/luci-static/argon/img/argon.svg'
	      ]
	      : [
	        '/favicon.ico',
	        '/favicon.svg',
	        '/favicon.png',
	        '/apple-touch-icon.png'
	      ];
	    for (let i = 0; i < commonRootPaths.length; i++) {
	      appendUniqueCandidate(candidates, origin + commonRootPaths[i]);
	    }
	    if (isPrivate) {
	      const relativeCandidates = [
	        'favicon.ico',
	        'favicon.svg',
	        'favicon.png',
	        'icon.svg',
	        'icon.png',
	        'static/common/img/favicon/favicon.ico',
	        'static/favicon.ico',
	        'static/favicon.svg',
	        'assets/favicon.ico',
	        'assets/favicon.svg'
	      ];
	      for (let i = 0; i < relativeCandidates.length; i++) {
	        try {
	          appendUniqueCandidate(candidates, new URL(relativeCandidates[i], u).href);
	        } catch (e) {}
	      }
	    }
	    if (pathname.indexOf('/cgi-bin/luci/') !== -1) {
	      appendUniqueCandidate(candidates, origin + '/luci-static/bootstrap/favicon.ico');
	      appendUniqueCandidate(candidates, origin + '/luci-static/resources/cbi/favicon.ico');
	    }
	  } catch (e) {}
	  return candidates;
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

	function clearInMemoryFaviconState() {
	  faviconCache = new Map();
	  faviconRenderFailureDomains = Object.create(null);
	  faviconPersistQueue = Object.create(null);
	  faviconPersistQueueSize = 0;
	  faviconWarmupLastAttemptAt = Object.create(null);
	  faviconWarmupRetryAt = Object.create(null);
	  if (faviconPersistFlushTimer) {
	    clearTimeout(faviconPersistFlushTimer);
	    faviconPersistFlushTimer = null;
	  }
	  faviconPersistFlushPromise = null;
	  cancelFaviconWarmup();
	  faviconRenderToken++;
	  backgroundSearchToken++;
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
	    if (!entry || !entry.domain) continue;
	    if (entry.src || entry.state === 'failure') entries.push(entry);
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
	  if (!isTrustedPersistableFaviconSrc(safeSrc)) return;

	  const key = isLikelyPrivateHost(safeDomain)
	    ? safeDomain
	    : (normalizeFaviconDomain(safeDomain) || safeDomain);
	  const existed = !!faviconPersistQueue[key];
	  faviconPersistQueue[key] = { domain: key, src: safeSrc, updatedAt: Date.now() };
	  if (!existed) faviconPersistQueueSize++;

	  faviconDebugLog('persist success queued', { domain: key, src: safeSrc });

	  if (faviconPersistQueueSize >= 50) {
	    flushFaviconPersistQueue();
	  } else {
	    scheduleFaviconPersistFlush();
	  }
	}

	function queuePersistFaviconFailure(domain, retryAt, reason) {
	  const safeDomain = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
	  if (!safeDomain) return;
	  if (!shouldPersistFaviconFailure(reason)) {
	    faviconDebugLog('persist failure skipped', { domain: safeDomain, reason: reason || '' });
	    return;
	  }
	  const key = isLikelyPrivateHost(safeDomain)
	    ? safeDomain
	    : (normalizeFaviconDomain(safeDomain) || safeDomain);
	  const current = faviconPersistQueue[key];
	  if (current && typeof current.src === 'string' && current.src) return;
	  const entry = buildFaviconFailureEntry(key, retryAt);
	  if (!entry) return;
	  const existed = !!faviconPersistQueue[key];
	  faviconPersistQueue[key] = entry;
	  if (!existed) faviconPersistQueueSize++;

	  faviconDebugLog('persist failure queued', { domain: key, retryAt: entry.retryAt, reason: reason || '' });

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
	    if (isLikelyPrivateHost(lower)) {
	      if (!seen[lower]) {
	        seen[lower] = true;
	        uniq.push(lower);
	      }
	      continue;
	    }
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

	function isPersistedFailureEntry(entry) {
	  return !!(entry && typeof entry === 'object' && entry.state === 'failure' && typeof entry.retryAt === 'number' && entry.retryAt > Date.now());
	}

	function resetFaviconImageErrorState(img, src, token) {
	  if (!img || !img.dataset) return;
	  img.dataset[FAVICON_IMG_DATASET.TOKEN] = String(token || 0);
	  img.dataset[FAVICON_IMG_DATASET.CANDIDATE_SRC] = typeof src === 'string' ? src : '';
	  delete img.dataset[FAVICON_IMG_DATASET.ERROR_SRC];
	}

	function setFaviconImageContext(img, domain, pageUrl, token) {
	  if (!img || !img.dataset) return;
	  img.dataset[FAVICON_IMG_DATASET.DOMAIN] = typeof domain === 'string' ? domain : '';
	  img.dataset[FAVICON_IMG_DATASET.PAGE_URL] = typeof pageUrl === 'string' ? pageUrl : '';
	  img.dataset[FAVICON_IMG_DATASET.TOKEN] = String(token || 0);
	}

	function handleRenderedFaviconError(event) {
	  const img = event && event.currentTarget;
	  if (!img || !img.dataset) return;
	  if (img.isConnected === false) return;

	  const domain = typeof img.dataset[FAVICON_IMG_DATASET.DOMAIN] === 'string'
	    ? img.dataset[FAVICON_IMG_DATASET.DOMAIN].trim().toLowerCase()
	    : '';
	  const safeDomain = isLikelyPrivateHost(domain)
	    ? domain
	    : (normalizeFaviconDomain(domain) || domain);
	  const safeToken = Number(img.dataset[FAVICON_IMG_DATASET.TOKEN] || 0);
	  const candidateSrc = typeof img.dataset[FAVICON_IMG_DATASET.CANDIDATE_SRC] === 'string'
	    ? img.dataset[FAVICON_IMG_DATASET.CANDIDATE_SRC].trim()
	    : '';
	  const lastErrorSrc = typeof img.dataset[FAVICON_IMG_DATASET.ERROR_SRC] === 'string'
	    ? img.dataset[FAVICON_IMG_DATASET.ERROR_SRC].trim()
	    : '';
	  const currentSrc = typeof img.currentSrc === 'string' && img.currentSrc
	    ? img.currentSrc.trim()
	    : (typeof img.src === 'string' ? img.src.trim() : '');
	  const failingSrc = candidateSrc || currentSrc;

	  if (!safeDomain) return;
	  if (!failingSrc || failingSrc === defaultIcon) return;
	  if (!isLoadableIconSrc(failingSrc)) return;
	  if (safeToken !== faviconRenderToken) return;
	  if (lastErrorSrc && lastErrorSrc === failingSrc) return;

	  img.dataset[FAVICON_IMG_DATASET.ERROR_SRC] = failingSrc;
	  resetFaviconImageErrorState(img, defaultIcon, safeToken);
	  if (img.src !== defaultIcon) img.src = defaultIcon;

	  if (faviconRenderFailureDomains[safeDomain] === safeToken) return;
	  faviconRenderFailureDomains[safeDomain] = safeToken;
	  faviconDebugLog('render error fallback', {
	    domain: safeDomain,
	    pageUrl: img.dataset[FAVICON_IMG_DATASET.PAGE_URL] || '',
	    src: failingSrc,
	    token: safeToken
	  });
	  queuePersistFaviconFailure(safeDomain, undefined, 'render-error');
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
	    resetFaviconImageErrorState(img, safeSrc, token);
	    img.src = safeSrc;
	  }
	}

	function fetchBrowserFaviconForPageUrl(pageUrl) {
	  const safePageUrl = pageUrl ? String(pageUrl).trim() : '';
	  if (!safePageUrl) return Promise.resolve({ src: '', isPlaceholder: false });

	  return sendMessagePromise({ action: MESSAGE_ACTIONS.GET_BROWSER_FAVICON, pageUrl: safePageUrl, debug: isFaviconDebugEnabled() })
	    .then((response) => {
	      if (!response || response.success === false) return { src: '', isPlaceholder: false };
	      const src = response && typeof response.src === 'string' ? response.src : '';
	      const isPlaceholder = isBrowserFaviconPlaceholderResult(response);
	      if (!src) return { src: '', isPlaceholder };
	      if (!isLoadableIconSrc(src)) return { src: '', isPlaceholder };
	      return { src, isPlaceholder };
	    })
	    .catch(() => ({ src: '', isPlaceholder: false }));
	}

	function getCachedFaviconForDomain(domain) {
	  const raw = typeof domain === 'string' ? domain.trim() : '';
	  if (!raw) return '';

	  const lower = raw.toLowerCase();
	  if (isLikelyPrivateHost(lower)) {
	    return faviconCache.get(lower) || '';
	  }
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
	    if (isLikelyPrivateHost(domain)) continue;
	    const root = getRootDomain(domain);
	    if (root && !reqSeen[root]) { reqSeen[root] = true; requestDomains.push(root); }
	  }

	  let persisted = {};
	  try {
	    persisted = await fetchPersistedFavicons(requestDomains);
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
	  const failureCooldownDomains = Object.create(null);
	  for (let i = 0; i < domains.length; i++) {
	    const domain = domains[i];
	    const cached = getCachedFaviconForDomain(domain);
	    if (cached) {
	      applyFaviconToImages(domainToImages[domain], cached, token);
	      continue;
	    }
	    const persistedEntry = persisted && typeof persisted === 'object' ? persisted[domain] : undefined;
	    if (isPersistedFailureEntry(persistedEntry)) {
	      failureCooldownDomains[domain] = persistedEntry.retryAt;
	      faviconDebugLog('failure cooldown hit', { domain: domain, retryAt: persistedEntry.retryAt });
	      continue;
	    }
	    afterIdb.push(domain);
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
	      items,
	      debug: isFaviconDebugEnabled()
	    });
	    if (token !== faviconRenderToken) return;
	    const favicons = (response && response.favicons && typeof response.favicons === 'object') ? response.favicons : {};
	    for (const domain in favicons) {
	      if (!Object.prototype.hasOwnProperty.call(favicons, domain)) continue;
	      const entry = favicons[domain];
	      const src = entry && typeof entry === 'object'
	        ? (typeof entry.src === 'string' ? entry.src : '')
	        : (typeof entry === 'string' ? entry : '');
	      const isPlaceholder = entry && typeof entry === 'object' && !!entry.isPlaceholder;
	      if (!src || !isLoadableIconSrc(src) || isPlaceholder) {
	        if (isPlaceholder) faviconDebugLog('browser batch placeholder rejected', { domain: domain, pageUrl: domainToPageUrl[domain] || '' });
	        continue;
	      }
	      setFaviconCache(domain, src);
	      applyFaviconToImages(domainToImages[domain], src, token);
	    }
	  } catch (e) { /* proceed to external */ }

	  if (token !== faviconRenderToken) return;

	  // 2c) External sources for still-missing domains (DDG/Google/Faviconkit)
	  const afterBrowser = [];
	  for (let i = 0; i < afterIdb.length; i++) {
	    const domain = afterIdb[i];
	    if (failureCooldownDomains[domain]) continue;
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
	        loadFavicon(domain, pageUrl, function(result) {
	          if (token !== faviconRenderToken) { resolve(); return; }
	          const safeUrl = result && typeof result === 'object' ? String(result.src || '') : (typeof result === 'string' ? result : '');
	          if (safeUrl && isLoadableIconSrc(safeUrl)) {
	            setFaviconCache(domain, safeUrl);
	            applyFaviconToImages(domainToImages[domain], safeUrl, token);
	            queuePersistFavicon(domain, safeUrl);
	          } else {
	            const retryAt = result && typeof result === 'object' ? result.retryAt : undefined;
	            const reason = result && typeof result === 'object' ? result.reason : 'external-failed';
	            queuePersistFaviconFailure(domain, retryAt, reason);
	          }
	          resolve();
	        }, { allowBrowserCache: false, allowExternal: true, allowLocal: isLikelyPrivateHost(domain) });
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

	  const now = Date.now();
	  const filtered = [];
	  const WARMUP_MIN_INTERVAL_MS = 10 * 60 * 1000;
	  const WARMUP_MAX_ATTEMPTS = 24;
	  for (let i = 0; i < list.length; i++) {
	    const domain = list[i];
	    const retryAt = faviconWarmupRetryAt[domain] || 0;
	    if (retryAt > now) continue;
	    const lastAttemptAt = faviconWarmupLastAttemptAt[domain] || 0;
	    if (lastAttemptAt > 0 && now - lastAttemptAt < WARMUP_MIN_INTERVAL_MS) continue;
	    filtered.push(domain);
	    if (filtered.length >= WARMUP_MAX_ATTEMPTS) break;
	  }
	  if (filtered.length === 0) return;

	  const concurrency = Math.min(2, filtered.length);
	  let nextIndex = 0;

	  function loadFaviconPromise(domain, pageUrl) {
	    return new Promise((resolve) => {
	      // Warmup domains have already missed memory + IDB caches.
	      // Skip browser cache (250ms timeout per domain) to avoid warmup being heavy.
	      // Keep local fallback enabled so private hosts behave the same as real search hydration.
	      loadFavicon(domain, pageUrl, resolve, { allowBrowserCache: false, allowExternal: true, allowLocal: true });
	    });
	  }

	  async function worker() {
	    while (nextIndex < filtered.length) {
	      const index = nextIndex++;
	      const domain = filtered[index];
	      if (runId !== faviconWarmupRunId) return;
	      const pageUrl = domainToPageUrl[domain] || ("https://" + domain);
	      faviconWarmupLastAttemptAt[domain] = Date.now();
	      const result = await loadFaviconPromise(domain, pageUrl);
	      if (runId !== faviconWarmupRunId) return;
	      const safeSrc = result && typeof result === 'object' ? String(result.src || '') : (typeof result === 'string' ? result : '');
	      const reason = result && typeof result === 'object' ? result.reason : 'warmup-failed';
	      const isPrivateHost = isLikelyPrivateHost(domain);
	      faviconDebugLog('warmup result', {
	        domain,
	        pageUrl,
	        isPrivateHost,
	        ok: !!(safeSrc && isLoadableIconSrc(safeSrc)),
	        src: safeSrc,
	        reason
	      });
	      if (safeSrc && isLoadableIconSrc(safeSrc)) {
	        delete faviconWarmupRetryAt[domain];
	        setFaviconCache(domain, safeSrc);
	        queuePersistFavicon(domain, safeSrc);
	      } else {
	        const retryAt = result && typeof result === 'object' ? result.retryAt : undefined;
	        if (reason === 'origin-fast-fail') {
	          faviconWarmupRetryAt[domain] = retryAt && retryAt > Date.now() ? retryAt : (Date.now() + 10 * 60 * 1000);
	        }
	        if (isPrivateHost) {
	          faviconDebugLog('warmup private failure skipped', { domain, pageUrl, reason, retryAt: retryAt || 0 });
	          continue;
	        }
	        queuePersistFaviconFailure(domain, retryAt, reason);
	      }
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
	    const domainToPageUrl = await fetchWarmupDomainMapFromBackground(120);
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
  faviconRenderFailureDomains = Object.create(null);
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
    favicon.addEventListener('error', handleRenderedFaviconError);
    resetFaviconImageErrorState(favicon, defaultIcon, token);
    favicon.src = defaultIcon;
    let domain = "";
    try { domain = new URL(bookmark.url).hostname; } catch (e) {}
    if (domain) {
      domain = String(domain || '').trim().toLowerCase();
      let pageUrl = '';
      try {
        pageUrl = String(bookmark && bookmark.url ? bookmark.url : '');
        pageUrl = pageUrl ? new URL(pageUrl).href : '';
      } catch (e) {}
      const key = buildFaviconServiceKey(domain, pageUrl);
      const resolvedPageUrl = pageUrl || ("https://" + (key || domain));
      setFaviconImageContext(favicon, key, resolvedPageUrl, token);
      // 优先使用内存缓存（包括 data: 和外部 URL），避免二次搜索延迟
      const cachedSrc = getCachedFaviconForDomain(key);
      if (cachedSrc) {
        resetFaviconImageErrorState(favicon, cachedSrc, token);
        favicon.src = cachedSrc;
      } else {
        if (!domainToImages[key]) domainToImages[key] = [];
        domainToImages[key].push(favicon);
        if (!domainToPageUrl[key]) {
          // Use the full bookmark URL for better browser favicon cache hits.
          domainToPageUrl[key] = resolvedPageUrl;
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
  var localProbeStatusCache = Object.create(null);

  var allowExternal = !options || options.allowExternal !== false;
  var allowBrowserCache = !options || options.allowBrowserCache !== false;
  var allowLocal = !!(options && options.allowLocal);
  var safePageUrl = pageUrl ? String(pageUrl) : '';
  var done = false;

  function finish(result) {
    if (done) return;
    done = true;
    if (isSuccessfulFaviconResult(result)) {
      faviconDebugLog('finish success', {
        domain: domain,
        pageUrl: safePageUrl,
        src: result.src,
        source: result.source || ''
      });
    } else {
      faviconDebugLog('finish failure', {
        domain: domain,
        pageUrl: safePageUrl,
        reason: result && result.reason ? result.reason : 'unknown',
        retryAt: result && typeof result.retryAt === 'number' ? result.retryAt : 0,
        allowBrowserCache: allowBrowserCache,
        allowExternal: allowExternal,
        allowLocal: allowLocal
      });
    }
    if (callback) callback(result);
  }

  function finishFailure(reason, retryAt) {
    finish({ state: 'failure', src: '', reason: reason || 'favicon-failed', retryAt: retryAt });
  }

  function finishSuccess(src, source, extra) {
    finish({
      state: 'success',
      src: typeof src === 'string' ? src : '',
      source: source || '',
      isPlaceholder: !!(extra && extra.isPlaceholder)
    });
  }

  function probeLocalFaviconStatus(url) {
    var safeUrl = typeof url === 'string' ? url : '';
    if (!safeUrl) return Promise.resolve({ success: true, status: 0, isFastFailStatus: false });
    if (localProbeStatusCache[safeUrl]) return localProbeStatusCache[safeUrl];
    localProbeStatusCache[safeUrl] = sendMessagePromise({ action: MESSAGE_ACTIONS.PROBE_FAVICON_URL_STATUS, url: safeUrl }, 2500)
      .then(function(response) {
        return {
          success: !!(response && response.success),
          status: response && typeof response.status === 'number' ? response.status : 0,
          isFastFailStatus: !!(response && response.isFastFailStatus)
        };
      })
      .catch(function() {
        return { success: false, status: 0, isFastFailStatus: false };
      });
    return localProbeStatusCache[safeUrl];
  }

  // 构建源列表：优先浏览器 favicon 缓存，再按需降级第三方源。
  // 注意：不要直接请求站点自身 /favicon.ico（会触发 Mixed Content、证书错误、CORP 阻断等，且在 https 页面里 http 图标会被自动升级导致失败）。
  var sources = [];

  // 对局域网/私有主机：不走第三方 favicon 服务（一般会 404，且有隐私泄露）
  var isPrivateHost = isLikelyPrivateHost(domain);

  faviconDebugLog('start', { domain: domain, pageUrl: safePageUrl, isPrivateHost: isPrivateHost, allowBrowserCache: allowBrowserCache, allowExternal: allowExternal, allowLocal: allowLocal });

  // 对私有主机：在浏览器 favicon 缓存缺失时，允许从站点自身 origin 兜底（不走第三方）。
  // 注意：该兜底可能在某些页面因 Mixed Content / CSP 被拦截；仅用于私有主机且需显式开启 allowLocal。
  const declaredCandidates = collectDeclaredFaviconCandidates(safePageUrl);
  for (let i = 0; i < declaredCandidates.length; i++) appendUniqueCandidate(sources, declaredCandidates[i]);

  if (allowLocal && safePageUrl) {
    const localCandidates = buildOriginFaviconCandidates(safePageUrl);
    for (let i = 0; i < localCandidates.length; i++) appendUniqueCandidate(sources, localCandidates[i]);
  }

  if (allowLocal && isPrivateHost && safePageUrl && sources.length === 0) {
    try {
      const u = new URL(safePageUrl);
      appendUniqueCandidate(sources, new URL('/favicon.ico', u).href);
      appendUniqueCandidate(sources, new URL('/favicon.svg', u).href);
    } catch (e) {
      appendUniqueCandidate(sources, "https://" + domain + "/favicon.ico");
      appendUniqueCandidate(sources, "http://" + domain + "/favicon.ico");
      appendUniqueCandidate(sources, "http://" + domain + "/favicon.svg");
    }
  }

  if (allowExternal && !isPrivateHost) {
    // DDG
    appendUniqueCandidate(sources, "https://icons.duckduckgo.com/ip3/" + domain + ".ico");
    if (isSubdomain) {
      appendUniqueCandidate(sources, "https://icons.duckduckgo.com/ip3/" + rootDomain + ".ico");
    }

    // Google
    appendUniqueCandidate(sources, "https://www.google.com/s2/favicons?domain=" + domain + "&sz=32");
    if (isSubdomain) {
      appendUniqueCandidate(sources, "https://www.google.com/s2/favicons?domain=" + rootDomain + "&sz=32");
    }

    // Faviconkit
    appendUniqueCandidate(sources, "https://api.faviconkit.com/" + domain + "/32");
    if (isSubdomain) {
      appendUniqueCandidate(sources, "https://api.faviconkit.com/" + rootDomain + "/32");
    }
  }

  faviconDebugLog('sources', { domain: domain, isPrivateHost: isPrivateHost, count: sources.length, sources: sources.slice(0, 10) });

  function tryLoad(idx) {
    if (done) return;
    if (idx >= sources.length) {
      finishFailure('all-sources-failed');
      return;
    }
    var url = sources[idx];
    var isDDG = url.indexOf("duckduckgo.com") !== -1;
    var isThirdParty = isDDG || url.indexOf("google.com/s2/favicons") !== -1 || url.indexOf("api.faviconkit.com") !== -1;
    if (isThirdParty && (!allowExternal || !canUseExternalFavicons())) {
      faviconDebugLog('skip third-party (circuit/open/disabled)', { domain: domain, url: url, allowExternal: allowExternal });
      tryLoad(idx + 1);
      return;
    }

    function startImageLoad() {
      if (done) return;
      var settled = false;
      var timeoutMs = (isPrivateHost && allowLocal && !isThirdParty) ? 1200 : 3000;
      faviconDebugLog('try', { domain: domain, idx: idx, url: url, isThirdParty: isThirdParty, timeoutMs: timeoutMs });
      try {
        if (!isThirdParty && typeof window !== 'undefined' && window.location && window.location.protocol === 'https:' && url.indexOf('http://') === 0) {
          faviconDebugLog('possible mixed-content local favicon', { domain: domain, pageUrl: safePageUrl, currentPageProtocol: window.location.protocol, url: url });
        }
      } catch (e) {}
      var timer = setTimeout(function() {
        if (settled) return;
        settled = true;
        img.onload = null;
        img.onerror = null;
        faviconDebugLog('timeout', { domain: domain, url: url, idx: idx, timeoutMs: timeoutMs });
        tryLoad(idx + 1);
      }, timeoutMs);

      var img = new Image();
      img.onload = function() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (isDDG && img.naturalWidth === 48 && img.naturalHeight === 48) {
          recordExternalFaviconFailure();
          faviconDebugLog('loaded but DDG placeholder, skip', { domain: domain, url: url, w: img.naturalWidth, h: img.naturalHeight });
          tryLoad(idx + 1);
          return;
        }
        faviconDebugLog('loaded', { domain: domain, url: url, w: img.naturalWidth, h: img.naturalHeight, source: isThirdParty ? 'external' : 'local' });
        finishSuccess(url, isThirdParty ? 'external' : 'local');
      };
      img.onerror = function() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (isThirdParty) recordExternalFaviconFailure();
        faviconDebugLog('error', { domain: domain, url: url, idx: idx, isThirdParty: isThirdParty });
        tryLoad(idx + 1);
      };
      img.src = url;
    }

    if (!isThirdParty) {
      probeLocalFaviconStatus(url).then(function(probe) {
        if (done) return;
        if (probe && probe.isFastFailStatus) {
          faviconDebugLog('local probe fast-fail abort site', {
            domain: domain,
            url: url,
            idx: idx,
            status: probe.status || 0
          });
          finishFailure('origin-fast-fail');
          return;
        }
        startImageLoad();
      }).catch(function() {
        startImageLoad();
      });
      return;
    }

    startImageLoad();
  }

  if (allowBrowserCache && safePageUrl) {
    fetchBrowserFaviconForPageUrl(safePageUrl)
      .then((result) => {
        if (isSuccessfulFaviconResult(result) && !shouldRetryAfterBrowserResult(result)) {
          finishSuccess(result.src, 'browser-cache', { isPlaceholder: result.isPlaceholder });
          return;
        }
        if (result && result.isPlaceholder) {
          faviconDebugLog('browser placeholder rejected', { domain: domain, pageUrl: safePageUrl });
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

  if (message.action === MESSAGE_ACTIONS.CLEAR_FAVICON_CACHE) {
    try {
      clearInMemoryFaviconState();
      console.log('[Content] favicon 内存缓存已清理');
      sendResponse({ success: true });
    } catch (error) {
      console.error('[Content] 清理 favicon 内存缓存失败:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
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
