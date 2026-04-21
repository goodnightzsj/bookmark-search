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
	  let currentQueryTokens = [];
	  let recentLoadToken = 0;
	  // 多选：存储被多选的 bookmark.id；独立于 selectedIndex（光标所在）
	  let multiSelectedIds = new Set();
	  // 最近一次"多选锚点" index，用于 Shift+Click 范围选
	  let multiSelectAnchorIndex = -1;
	  // 最近搜索词（本地持久化）
	  const RECENT_SEARCHES_KEY = 'recentSearches';
	  const RECENT_SEARCHES_MAX = 20;
	  let recentSearches = [];
	  let recentSearchesLoaded = false;
	  function loadRecentSearches() {
	    if (recentSearchesLoaded) return Promise.resolve(recentSearches);
	    return new Promise((resolve) => {
	      try {
	        chrome.storage.local.get(RECENT_SEARCHES_KEY, (result) => {
	          const list = result && Array.isArray(result[RECENT_SEARCHES_KEY]) ? result[RECENT_SEARCHES_KEY] : [];
	          recentSearches = list
	            .filter((item) => item && typeof item.query === 'string' && item.query)
	            .slice(0, RECENT_SEARCHES_MAX);
	          recentSearchesLoaded = true;
	          resolve(recentSearches);
	        });
	      } catch (e) {
	        recentSearchesLoaded = true;
	        resolve(recentSearches);
	      }
	    });
	  }
	  function recordRecentSearch(query) {
	    const safe = String(query || '').trim();
	    if (!safe) return;
	    if (safe.length < 2) return; // 单字符不记录
	    loadRecentSearches().then(() => {
	      // 去重 + 提到队首
	      recentSearches = recentSearches.filter((item) => item.query !== safe);
	      recentSearches.unshift({ query: safe, at: Date.now() });
	      if (recentSearches.length > RECENT_SEARCHES_MAX) {
	        recentSearches.length = RECENT_SEARCHES_MAX;
	      }
	      try {
	        chrome.storage.local.set({ [RECENT_SEARCHES_KEY]: recentSearches });
	      } catch (e) {}
	    });
	  }
	  let imeComposing = false;
	  let imeEnterDuringComposition = false;
	  // Suppress stray/synthetic Enter events right after IME composition ends (esp. macOS built-in IME).
	  // Keep the window small so the user's next real Enter (to open) still works.
	  let imeSuppressEnterUntil = 0;
	  // Favicon debug defaults to off. Enable via `window.__BOOKMARK_SEARCH_DEBUG_FAVICON__ = true` or `chrome.storage.local.set({ debugFavicon: true })`.
	  let debugFavicon = false;
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
	        debugFavicon = result.debugFavicon === true;
	      }
	    } catch (e) {}
	  }
	  // SYNC: values must match constants.js MESSAGE_ACTIONS (IIFE cannot import ES modules).
	  // Prefer the build-time injected table when available (see vite config `bs-inject-message-actions` plugin).
	  const INJECTED_MESSAGE_ACTIONS = (typeof window !== 'undefined' && window.__BS_INJECTED_MESSAGE_ACTIONS__)
	    || null;
	  const MESSAGE_ACTIONS = INJECTED_MESSAGE_ACTIONS || {
	    SEARCH_BOOKMARKS: 'searchBookmarks',
	    GET_WARMUP_DOMAINS: 'getWarmupDomains',
	    GET_FAVICONS: 'getFavicons',
	    SET_FAVICONS: 'setFavicons',
	    GET_RECENT_OPENED: 'getRecentOpened',
	    TRACK_BOOKMARK_OPEN: 'trackBookmarkOpen',
	    TOGGLE_SEARCH: 'toggleSearch',
	    CLEAR_FAVICON_CACHE: 'clearFaviconCache',
	    DELETE_BOOKMARK: 'deleteBookmark',
	    OPEN_BOOKMARK_IN_WINDOW: 'openBookmarkInWindow',
	    REVEAL_BOOKMARK: 'revealBookmark'
	  };
	  const REQUIRED_MESSAGE_ACTIONS = {
	    SEARCH_BOOKMARKS: true,
	    GET_WARMUP_DOMAINS: true,
	    GET_FAVICONS: true,
	    SET_FAVICONS: true,
	    GET_RECENT_OPENED: true,
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
	      debugFavicon = changes.debugFavicon.newValue === true;
	    }
	    if (changes.theme) {
	      const newTheme = changes.theme.newValue;
	      if (typeof newTheme === 'string' && newTheme) {
	        currentRawTheme = newTheme;
	        ensureOverlayMediaListener();
	        currentTheme = resolveOverlayTheme(newTheme);
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
	  const MULTI_TENANT_FAVICON_SUFFIXES = new Set([
	    'github.io',
	    'pages.dev',
	    'vercel.app',
	    'netlify.app',
	    'workers.dev',
	    'web.app',
	    'firebaseapp.com',
	    'blogspot.com',
	    'herokuapp.com',
	    'azurewebsites.net'
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
	    return safe.charAt(safe.length - 1) === '.' ? safe.slice(0, -1) : safe;
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

	  function isKnownMultiTenantFaviconHost(host) {
	    const safe = getHostForPrivateCheck(host);
	    if (!safe) return false;
	    const withoutWww = safe.indexOf('www.') === 0 ? safe.slice(4) : safe;
	    const suffixes = Array.from(MULTI_TENANT_FAVICON_SUFFIXES);
	    for (let i = 0; i < suffixes.length; i++) {
	      const suffix = suffixes[i];
	      if (withoutWww === suffix || withoutWww.endsWith('.' + suffix)) return true;
	    }
	    return false;
	  }

	  function getLegacyFaviconKey(host) {
	    const exact = normalizeFaviconDomain(host);
	    const hostname = getHostForPrivateCheck(exact);
	    if (!exact || !hostname) return '';
	    if (isLikelyPrivateHost(hostname)) return exact;
	    if (exact !== hostname) return '';
	    const withoutWww = hostname.indexOf('www.') === 0 ? hostname.slice(4) : hostname;
	    if (!withoutWww) return '';
	    if (isKnownMultiTenantFaviconHost(withoutWww)) return '';
	    return getRootDomain(withoutWww) || withoutWww;
	  }

	  function buildFaviconLookupKeys(value) {
	    const safe = typeof value === 'string' ? value.trim() : '';
	    if (!safe) return [];

	    let exact = '';
	    let hostname = '';
	    try {
	      if (safe.indexOf('://') !== -1) {
	        const url = new URL(safe);
	        exact = normalizeFaviconDomain(url.host || url.hostname);
	        hostname = normalizeFaviconDomain(url.hostname || '');
	      } else {
	        exact = normalizeFaviconDomain(safe);
	        hostname = normalizeFaviconDomain(getHostForPrivateCheck(safe));
	      }
	    } catch (e) {
	      exact = normalizeFaviconDomain(safe);
	      hostname = normalizeFaviconDomain(getHostForPrivateCheck(safe));
	    }

	    if (!exact) return [];

	    const keys = [];
	    const seen = Object.create(null);
	    function push(entry) {
	      const candidate = normalizeFaviconDomain(entry);
	      if (!candidate || seen[candidate]) return;
	      seen[candidate] = true;
	      keys.push(candidate);
	    }

	    push(exact);

	    if (hostname && exact === hostname && !isLikelyPrivateHost(hostname)) {
	      const withoutWww = hostname.indexOf('www.') === 0 ? hostname.slice(4) : hostname;
	      if (withoutWww && withoutWww !== hostname) push(withoutWww);
	      if (withoutWww && withoutWww.indexOf('.') !== -1 && hostname.indexOf('www.') !== 0 && !isKnownMultiTenantFaviconHost(withoutWww)) {
	        push('www.' + withoutWww);
	      }
	      const legacy = getLegacyFaviconKey(hostname);
	      if (legacy && legacy !== hostname) {
	        push(legacy);
	        if (legacy.indexOf('.') !== -1 && legacy.indexOf('www.') !== 0) {
	          push('www.' + legacy);
	        }
	      }
	    }

	    return keys;
	  }

	  // SYNC: must match utils.js buildFaviconServiceKey semantics
	  function buildFaviconServiceKey(pageUrl) {
	    const safe = typeof pageUrl === 'string' ? pageUrl.trim() : '';
	    if (!safe) return '';
	    try {
	      const url = new URL(safe);
	      return normalizeFaviconDomain(url.host || url.hostname);
	    } catch (e) {
	      return '';
	    }
	  }

	  // placeholder TTL：浏览器 _favicon 返回的"首字母灰方块"保守重试间隔
	  const FAVICON_PLACEHOLDER_TTL_MS = 30 * 60 * 1000;

	  function setFaviconCache(domain, src, options) {
	    if (!domain || typeof src !== 'string') return;
	    const safeDomain = String(domain).trim().toLowerCase();
	    if (!safeDomain) return;
	    const isPlaceholder = !!(options && options.isPlaceholder);
	    const entry = { src, isPlaceholder, ts: Date.now() };
	    if (faviconCache.has(safeDomain)) {
	      faviconCache.delete(safeDomain);
	    }
	    faviconCache.set(safeDomain, entry);
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
	  // Focus retries (some pages may steal focus immediately after injection/show).
	  let focusRetryTimer = null;
	  let focusTrapEnabled = false;
	  let globalKeydownTrapEnabled = false;
	  let focusEnforcerTimer = null;
	  let lastFocusTrapAt = 0;
	  // 记录呼出搜索框前页面焦点元素，关闭时还原
	  let savedFocusBeforeOverlay = null;

	  let currentTheme = 'original';
	  let currentRawTheme = 'original';
	  let overlayMediaQuery = null;
	  let overlayMediaListenerBound = false;

	  function resolveOverlayTheme(rawTheme) {
	    const theme = typeof rawTheme === 'string' ? rawTheme : '';
	    if (theme !== 'auto') return theme || 'original';
	    const prefersDark = !!(overlayMediaQuery && overlayMediaQuery.matches)
	      || !!(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
	    return prefersDark ? 'dark' : 'original';
	  }

	  function ensureOverlayMediaListener() {
	    if (overlayMediaListenerBound) return;
	    if (typeof matchMedia !== 'function') return;
	    try {
	      overlayMediaQuery = matchMedia('(prefers-color-scheme: dark)');
	      const handler = () => {
	        if (currentRawTheme === 'auto') {
	          currentTheme = resolveOverlayTheme(currentRawTheme);
	          applyThemeToOverlay();
	        }
	      };
	      if (typeof overlayMediaQuery.addEventListener === 'function') {
	        overlayMediaQuery.addEventListener('change', handler);
	      } else if (typeof overlayMediaQuery.addListener === 'function') {
	        overlayMediaQuery.addListener(handler);
	      }
	      overlayMediaListenerBound = true;
	    } catch (e) {}
	  }

	  async function loadThemeSetting() {
	    try {
	      const result = await chrome.storage.local.get('theme');
	      const raw = (result && typeof result.theme === 'string' && result.theme) ? result.theme : 'original';
	      currentRawTheme = raw;
	      ensureOverlayMediaListener();
	      currentTheme = resolveOverlayTheme(raw);
	      applyThemeToOverlay();
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
    // 鼠标移动时切回"鼠标模式"，:hover 视觉效果恢复；与键盘导航期间的
    // .selected 形成两种焦点视觉会引发"hover 不跟随选中"的观感
    if (resultsContainer && resultsContainer.dataset.inputMode !== 'mouse') {
      resultsContainer.dataset.inputMode = 'mouse';
    }
  });

  // 事件委托：统一处理结果项的 hover 和 click
  // 注意：mouseenter 不冒泡，必须用 mouseover 做委托
  let lastHoverIndex = -1;
  resultsContainer.addEventListener('mouseover', (e) => {
    const item = e.target && e.target.closest ? e.target.closest('.bookmark-item') : null;
    if (!item) return;
    if (!lastPointerMoveAt || Date.now() - lastPointerMoveAt > 200) return;
    const index = Array.prototype.indexOf.call(item.parentNode.children, item);
    if (index < 0 || index >= filteredResults.length) return;
    if (index === lastHoverIndex) return; // 同一项不重复触发
    lastHoverIndex = index;
    selectedIndex = index;
    updateSelection({ scroll: false });
  });

  resultsContainer.addEventListener('click', (e) => {
    const item = e.target && e.target.closest ? e.target.closest('.bookmark-item') : null;
    if (!item) return;
    const index = Array.prototype.indexOf.call(item.parentNode.children, item);
    if (index < 0 || index >= filteredResults.length) return;
    // Shift+click：
    //   - 已有锚点 → 选锚点到 index 之间所有项
    //   - 无锚点 → 锚点 = index + 切换当前
    if (e.shiftKey) {
      e.preventDefault();
      if (multiSelectAnchorIndex >= 0 && multiSelectAnchorIndex !== index) {
        rangeSelectMulti(multiSelectAnchorIndex, index);
      } else {
        multiSelectAnchorIndex = index;
        toggleMultiSelect(index);
      }
      return;
    }
    // 普通 click：如果已有多选，也不触发单条打开（避免误操作）
    if (multiSelectedIds.size > 0) {
      e.preventDefault();
      multiSelectAnchorIndex = index;
      toggleMultiSelect(index);
      return;
    }
    openBookmark(filteredResults[index], !(e.ctrlKey || e.metaKey));
  });

  // 右键 → action menu（对应结果行）
  resultsContainer.addEventListener('contextmenu', (e) => {
    const item = e.target && e.target.closest ? e.target.closest('.bookmark-item') : null;
    if (!item) return;
    const index = Array.prototype.indexOf.call(item.parentNode.children, item);
    if (index < 0 || index >= filteredResults.length) return;
    e.preventDefault();
    e.stopPropagation();
    selectedIndex = index;
    updateSelection({ scroll: false });
    showActionMenu(index);
  });

  // 创建搜索进度条（防抖期间可见）
  const progressBar = document.createElement("div");
  progressBar.className = "bookmark-progress";
  progressBar.setAttribute('aria-hidden', 'true');

  // 创建快捷键提示
  const isMacPlatform = (function() {
    try { return /Mac|iPod|iPhone|iPad/i.test(navigator.platform || ''); } catch (e) { return false; }
  })();
  const modKey = isMacPlatform ? '⌘' : 'Ctrl';
  const shortcuts = document.createElement("div");
  shortcuts.className = "bookmark-shortcuts";
  shortcuts.innerHTML = `
    <div class="bookmark-shortcut" data-hint="nav">
      <kbd>↑</kbd><kbd>↓</kbd> 导航
    </div>
    <div class="bookmark-shortcut" data-hint="open">
      <kbd>Enter</kbd> 新标签
    </div>
    <div class="bookmark-shortcut" data-hint="openCurrent">
      <kbd>${modKey}</kbd>+<kbd>Enter</kbd> 当前页
    </div>
    <div class="bookmark-shortcut" data-hint="jump">
      <kbd>${modKey}</kbd>+<kbd>1</kbd>~<kbd>9</kbd> 直达
    </div>
    <div class="bookmark-shortcut" data-hint="focus">
      <kbd>/</kbd> 聚焦
    </div>
    <div class="bookmark-shortcut" data-hint="close">
      <kbd>Esc</kbd> 关闭
    </div>
  `;

  searchContainer.appendChild(progressBar);
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
    if (e.target !== searchOverlay) return;
    // 特殊场景：焦点仍在地址栏/DevTools 等浏览器 chrome，搜索框从未真正拿到焦点。
    // 用户下意识点 overlay 是为了"让搜索框被聚焦"，而不是关闭 overlay。
    // 判据：点击发生时 deepActiveElement !== searchInput，且此前 savedFocusBeforeOverlay 已记录为"页面内元素"
    // → 用户的真实意图是激活输入框，而非关闭
    try {
      const deepActive = deepActiveElement();
      if (searchInput && deepActive !== searchInput) {
        focusSearchInput();
        // 二次验证：rAF 后如果仍未聚焦到 input，且浏览器 chrome 释放了焦点，再补一次
        requestAnimationFrame(() => {
          if (searchOverlay && searchOverlay.style.display !== 'none'
              && document.activeElement !== searchInput) {
            focusSearchInput();
          }
        });
        return;
      }
    } catch (err) {}
    hideSearch();
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
    resetSearchUiState();
  }

  if (!searchOverlay) {
    console.log("[Content] searchOverlay 不存在，创建UI");
    try {
      createSearchUI();
    } catch (error) {
      resetSearchUiState();
      throw error;
    }
  }

  // 全屏 / 嵌入式 PDF 查看器：全屏元素会拦截输入事件，必须先退出全屏 overlay 才能拿到焦点
  try {
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      document.exitFullscreen().catch(() => {});
    }
  } catch (e) {}

  // 记录呼出前的焦点元素（不是 body / overlay 内部元素）
  try {
    const active = document.activeElement;
    if (active && active !== document.body && !(searchOverlay && searchOverlay.contains(active))) {
      savedFocusBeforeOverlay = active;
    } else {
      savedFocusBeforeOverlay = null;
    }
  } catch (e) {
    savedFocusBeforeOverlay = null;
  }

  console.log("[Content] 显示搜索框");
  searchOverlay.style.display = "flex";
  // 尝试把窗口焦点拉到页面；对于"用户焦点在地址栏/DevTools/其它窗口时按快捷键"很关键，
  // 否则后续 searchInput.focus() 可能被浏览器 chrome 拦截（页面未激活）。
  try { window.focus(); } catch (e) {}
  enableFocusTrap();
  enableGlobalKeydownTrap();
  if (focusRetryTimer) clearTimeout(focusRetryTimer);
  // 不在 display 变更同帧同步 focus（layout 前 focus 可能静默失败），
  // 改为 rAF 后验证式聚焦，确保元素已完成 layout。
  requestAnimationFrame(() => {
    if (!searchOverlay || searchOverlay.style.display === "none") return;
    focusSearchInput();
    // 二次验证：覆盖宿主页面在首帧异步抢焦点的情况
    requestAnimationFrame(() => {
      if (!searchOverlay || searchOverlay.style.display === "none") return;
      if (document.activeElement !== searchInput) focusSearchInput();
    });
  });
  // 兜底 setTimeout（覆盖 rAF 被宿主节流的极端场景）
  focusRetryTimer = setTimeout(() => {
    focusRetryTimer = null;
    if (!searchOverlay || searchOverlay.style.display === "none") return;
    if (document.activeElement !== searchInput) focusSearchInput();
  }, 30);

  // 页面当前未获焦（在 DevTools / 其它窗口 / iframe / 地址栏）：
  // 订阅一次 window focus / visibilitychange，页面回焦时立即补一次 focus
  scheduleFocusOnWindowRegain();

  startFocusEnforcer();
  console.log("[Content] 搜索框已显示并聚焦");
}

// 一次性窗口获焦监听：覆盖"页面当前没焦点"场景（DevTools/地址栏/其它窗口）
function scheduleFocusOnWindowRegain() {
  try {
    if (document.hasFocus()) return;
  } catch (e) {}

  let done = false;
  const onRegain = () => {
    if (done) return;
    done = true;
    window.removeEventListener('focus', onRegain);
    document.removeEventListener('visibilitychange', onVis);
    if (!searchOverlay || searchOverlay.style.display === 'none') return;
    if (document.activeElement !== searchInput) focusSearchInput();
  };
  const onVis = () => {
    if (document.visibilityState === 'visible') onRegain();
  };
  window.addEventListener('focus', onRegain, { once: true });
  document.addEventListener('visibilitychange', onVis);
  // 3s 安全超时，避免残留监听
  setTimeout(() => {
    if (done) return;
    done = true;
    window.removeEventListener('focus', onRegain);
    document.removeEventListener('visibilitychange', onVis);
  }, 3000);
}

// 隐藏搜索界面
function hideSearch() {
  console.log("[Content] hideSearch 被调用");

  if (!searchOverlay) {
    console.log("[Content] searchOverlay 不存在，退出");
    return;
  }

  hideActionMenu();
  clearMultiSelect();
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
  cachedResultItems = null;
  prevSelectedIndex = -1;
  console.log("[Content] 搜索框已隐藏");

  // 还原呼出前的焦点元素（如果元素还在 DOM 中）
  const toRestore = savedFocusBeforeOverlay;
  savedFocusBeforeOverlay = null;
  if (toRestore && typeof toRestore.focus === 'function') {
    try {
      if (document.contains(toRestore)) {
        toRestore.focus({ preventScroll: true });
      }
    } catch (e) {
      try { toRestore.focus(); } catch (e2) {}
    }
  }

  // Persist any newly discovered favicons ASAP so other tabs can benefit without waiting for timers.
  flushFaviconPersistQueue();

  // Start favicon warmup after the overlay is closed (runs in the background within this content script lifetime).
  scheduleFaviconWarmup();
}

function resetSearchUiState() {
  stopFocusEnforcer();
  disableFocusTrap();
  disableGlobalKeydownTrap();
  if (focusRetryTimer) { clearTimeout(focusRetryTimer); focusRetryTimer = null; }

  try {
    if (searchOverlay && searchOverlay.parentNode) {
      searchOverlay.parentNode.removeChild(searchOverlay);
    }
  } catch (e) {}

  searchContainer = null;
  searchOverlay = null;
  searchInput = null;
  resultsContainer = null;
  filteredResults = [];
  selectedIndex = -1;
  cachedResultItems = null;
  prevSelectedIndex = -1;
}

// Shadow DOM 深度 activeElement：document.activeElement 只能看到 Shadow 宿主节点，
// 要穿透 shadowRoot 才能拿到真正聚焦的内层节点（Web Components 场景）
function deepActiveElement() {
  try {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  } catch (e) {
    return document.activeElement;
  }
}

function focusSearchInput() {
  if (!searchInput) return;
  // 中转策略：先 focus body（确保 document 有焦点），再 focus input。
  // 覆盖"页面整体未 foreground，浏览器拒绝直接把焦点落到深层 input"的场景。
  try {
    if (document.body && !document.body.hasAttribute('tabindex')) {
      document.body.setAttribute('tabindex', '-1');
    }
    if (document.body && document.activeElement !== searchInput && !document.hasFocus()) {
      try { document.body.focus({ preventScroll: true }); } catch (e) {}
    }
  } catch (e) {}

  try {
    searchInput.focus({ preventScroll: true });
  } catch (e) {
    try { searchInput.focus(); } catch (e2) {}
  }
  // 验证 focus 是否成功，失败则在微任务中重试一次
  if (document.activeElement !== searchInput) {
    Promise.resolve().then(() => {
      if (!searchInput || document.activeElement === searchInput) return;
      try { searchInput.focus({ preventScroll: true }); } catch (e) {}
    });
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
  // 豁免 overlay 内部所有元素的焦点事件
  if (target && searchOverlay.contains(target)) return;
  // iframe 抢焦点（内嵌视频/广告/文档）：先 blur iframe 本身，再把焦点拉回 input
  if (target && target.tagName === 'IFRAME') {
    try { target.blur(); } catch (e) {}
    try {
      if (target.contentWindow && typeof target.contentWindow.blur === 'function') {
        target.contentWindow.blur();
      }
    } catch (e) {}
  }
  // 防抖：避免高频焦点乒乓
  const now = Date.now();
  if (now - lastFocusTrapAt < 16) return;
  lastFocusTrapAt = now;
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

  // Cmd/Ctrl + 1~9 直达搜索结果（同 handleKeydown）
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
      && typeof key === 'string' && key.length === 1 && key >= '1' && key <= '9') {
    event.preventDefault();
    event.stopPropagation();
    handleKeydown(event);
    return;
  }

  // "/" 聚焦搜索框（不把 "/" 当成普通字符注入）
  if (key === '/') {
    event.preventDefault();
    event.stopPropagation();
    focusSearchInput();
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
  const startedAt = Date.now();
  let phase = 0; // 0: 16ms (0-500ms), 1: 100ms (500ms-2s), 2: 500ms (>2s)
  const tick = () => {
    if (!searchOverlay || searchOverlay.style.display === "none") {
      stopFocusEnforcer();
      return;
    }
    if (!searchInput) return;
    if (document.activeElement === searchInput) return;
    // Shadow DOM 场景：activeElement 停在宿主节点，要再往里看一层
    if (deepActiveElement() === searchInput) return;
    focusSearchInput();
  };
  focusEnforcerTimer = setInterval(() => {
    tick();
    const elapsed = Date.now() - startedAt;
    // 阶段 0 → 1：前 500ms 高频（16ms，约一帧），用于地址栏/弹窗短暂抢焦点场景
    if (phase === 0 && elapsed > 500) {
      phase = 1;
      clearInterval(focusEnforcerTimer);
      focusEnforcerTimer = setInterval(() => {
        tick();
        if (phase === 1 && Date.now() - startedAt > 2000) {
          phase = 2;
          clearInterval(focusEnforcerTimer);
          focusEnforcerTimer = setInterval(tick, 500);
        }
      }, 100);
    }
  }, 16);
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
  // 若 action menu 打开，全部键盘事件优先交给它
  if (actionMenuEl && handleActionMenuKeydown(e)) return;

  // Prefer our own composition state over legacy keyCode=229 (macOS IME can keep 229 briefly after commit).
  const composing = !!(imeComposing || (e && e.isComposing));

  // 多选态下的键盘：Enter 全部打开 / Delete 全部删除 / Esc 清空
  if (!composing && multiSelectedIds.size > 0) {
    if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      openAllMultiSelected();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Backspace 在 input 里是退字符，只拦 Delete
      if (e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        deleteAllMultiSelected();
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      clearMultiSelect();
      return;
    }
  }

  // Shift+Space 切换当前项的多选
  if (!composing && e.shiftKey && e.key === ' ' && selectedIndex >= 0) {
    e.preventDefault();
    e.stopPropagation();
    toggleMultiSelect(selectedIndex);
    return;
  }

  // Alt+Enter 在选中书签上打开 action menu
  if (!composing && e.altKey && e.key === 'Enter' && selectedIndex >= 0 && filteredResults[selectedIndex]) {
    e.preventDefault();
    e.stopPropagation();
    showActionMenu(selectedIndex);
    return;
  }

  // Cmd/Ctrl + 1~9 直达对应搜索结果（覆盖浏览器默认的切换 tab）
  if (!composing && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
      && typeof e.key === 'string' && e.key.length === 1
      && e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key, 10) - 1;
    if (idx >= 0 && idx < filteredResults.length && filteredResults[idx]) {
      e.preventDefault();
      e.stopPropagation();
      // Cmd/Ctrl 已被按下 → 在当前页打开
      openBookmark(filteredResults[idx], false);
      return;
    }
  }

  switch (e.key) {
    case "Escape":
      hideSearch();
      break;
    case "ArrowDown":
      if (composing) return;
      lastPointerMoveAt = 0;
      if (resultsContainer) resultsContainer.dataset.inputMode = 'keyboard';
      e.preventDefault();
      if (filteredResults.length > 0) {
        selectedIndex = selectedIndex >= filteredResults.length - 1 ? 0 : selectedIndex + 1;
        updateSelection();
      }
      break;
    case "ArrowUp":
      if (composing) return;
      lastPointerMoveAt = 0;
      if (resultsContainer) resultsContainer.dataset.inputMode = 'keyboard';
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

// 上一次选中的索引，用于增量更新 DOM
let prevSelectedIndex = -1;

// 更新选中项的高亮（只操作变化的节点，避免全量遍历）
function updateSelection(options) {
  const shouldScroll = !(options && typeof options === 'object' && options.scroll === false);
  const items = cachedResultItems || resultsContainer.querySelectorAll(".bookmark-item");

  // 清除上一个选中项
  if (prevSelectedIndex >= 0 && prevSelectedIndex !== selectedIndex && prevSelectedIndex < items.length) {
    const prevItem = items[prevSelectedIndex];
    prevItem.classList.remove("selected");
    prevItem.setAttribute('aria-selected', 'false');
  }

  // 设置当前选中项
  let activeId = '';
  if (selectedIndex >= 0 && selectedIndex < items.length) {
    const item = items[selectedIndex];
    item.classList.add("selected");
    item.setAttribute('aria-selected', 'true');
    activeId = item.id || '';
    if (shouldScroll) {
      const ct = resultsContainer;
      const itemTop = item.offsetTop - ct.offsetTop;
      const itemBottom = itemTop + item.offsetHeight;
      if (itemTop < ct.scrollTop) {
        ct.scrollTop = itemTop;
      } else if (itemBottom > ct.scrollTop + ct.clientHeight) {
        ct.scrollTop = itemBottom - ct.clientHeight;
      }
    }
  }

  prevSelectedIndex = selectedIndex;

  if (searchInput) {
    searchInput.setAttribute('aria-activedescendant', activeId);
  }
}

	// 防抖搜索
	function handleSearchDebounced(e) {
	  clearTimeout(searchDebounceTimer);
	  const value = String((e && e.target && e.target.value) || '');
	  // 只有用户真的在输入时才显示进度条；空查询不需要
	  if (value.trim()) setProgressVisible(true);
	  searchDebounceTimer = setTimeout(() => {
	    handleSearch(value);
	  }, 200);
	}

	function setProgressVisible(visible) {
	  if (!searchContainer) return;
	  const bar = searchContainer.querySelector('.bookmark-progress');
	  if (!bar) return;
	  bar.classList.toggle('is-active', !!visible);
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
	  // 允许走本扩展暴露的 _favicon 端点；其它 chrome-extension:// 仍拒绝以防注入
	  if (lower.indexOf('chrome-extension://') === 0) {
	    return lower.indexOf('/_favicon/') !== -1;
	  }
	  if (lower.indexOf('edge-extension://') === 0) {
	    return lower.indexOf('/_favicon/') !== -1;
	  }
	  if (lower.indexOf('javascript:') === 0) return false;
	  if (lower.indexOf('data:text/html') === 0) return false;
	  return true;
	}

	function isTrustedPersistableFaviconSrc(src) {
	  const safe = typeof src === 'string' ? src.trim() : '';
	  if (!isLoadableIconSrc(safe)) return false;
	  return safe.indexOf('http://') === 0 || safe.indexOf('https://') === 0;
	}

	function isSuccessfulFaviconResult(result) {
  if (!result || typeof result !== 'object') return false;
  const src = typeof result.src === 'string' ? result.src.trim() : '';
  if (!src || !isLoadableIconSrc(src)) return false;
  return result.state !== 'failure';
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
	      if (!ok) img.src = ''; // 中止正在进行的网络请求
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
	    // 新格式 {pageUrl} 或历史调用 {src}；失败态 {state: 'failure'}
	    if (entry.pageUrl || entry.src || entry.state === 'failure') entries.push(entry);
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

	/**
	 * 把 pageUrl 加入 persist queue（不再存 base64 src）
	 * 历史兼容：旧代码调用 queuePersistFavicon(domain, src) 时，若 src 是 http(s) URL 等价于 pageUrl，
	 * 若 src 是 data: URL 直接忽略不存（避免 IDB 膨胀）。
	 */
	function queuePersistFavicon(domain, pageUrlOrSrc) {
	  const safeDomain = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
	  const safe = typeof pageUrlOrSrc === 'string' ? pageUrlOrSrc.trim() : '';
	  if (!safeDomain || !safe) return;
	  // 只持久化 http(s) URL（做 pageUrl 用）；data:URL 不持久化
	  if (!isTrustedPersistableFaviconSrc(safe)) return;

	  const key = normalizeFaviconDomain(safeDomain) || safeDomain;
	  const existed = !!faviconPersistQueue[key];
	  faviconPersistQueue[key] = { domain: key, pageUrl: safe, updatedAt: Date.now() };
	  if (!existed) faviconPersistQueueSize++;

	  faviconDebugLog('persist pageUrl queued', { domain: key, pageUrl: safe });

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
		    const variants = buildFaviconLookupKeys(lower);

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
	  // 失败回退：显示 monogram（首字母 + 主题色圆），而不是灰色默认圆
	  const monogram = buildMonogramDataUrl(safeDomain);
	  resetFaviconImageErrorState(img, monogram, safeToken);
	  if (img.src !== monogram) img.src = monogram;
	  // 确保骨架 shimmer 关闭
	  if (img.dataset) delete img.dataset.bsLoading;

	  if (faviconRenderFailureDomains[safeDomain] === safeToken) return;
	  faviconRenderFailureDomains[safeDomain] = safeToken;
	  faviconDebugLog('render error fallback', {
	    domain: safeDomain,
	    pageUrl: img.dataset[FAVICON_IMG_DATASET.PAGE_URL] || '',
	    src: failingSrc,
	    token: safeToken
	  });
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

	function getCachedFaviconForDomain(domain) {
	  const raw = typeof domain === 'string' ? domain.trim() : '';
	  if (!raw) return '';

	  const candidates = buildFaviconLookupKeys(raw.toLowerCase());
	  const now = Date.now();

	  for (let i = 0; i < candidates.length; i++) {
	    const key = candidates[i];
	    if (!key) continue;
	    const entry = faviconCache.get(key);
	    if (!entry) continue;
	    // 兼容旧 Map 直接存 string 的历史数据：upgrade on read
	    const src = typeof entry === 'string' ? entry : entry.src;
	    if (typeof src !== 'string' || !src) continue;
	    if (!isLoadableIconSrc(src)) continue;
	    // placeholder 超过 TTL 允许重新获取（返回空字符串让 caller 走 hydrate 路径）
	    if (entry && entry.isPlaceholder && typeof entry.ts === 'number' && (now - entry.ts) > FAVICON_PLACEHOLDER_TTL_MS) {
	      continue;
	    }
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
	  // Phase 2a: 批量读 IDB，命中的条目用其 pageUrl 构造 _favicon URL
	  const requestDomains = [];
	  const reqSeen = Object.create(null);
	  for (let i = 0; i < domains.length; i++) {
	    const domain = domains[i];
	    const candidates = buildFaviconLookupKeys(domain);
	    for (let j = 0; j < candidates.length; j++) {
	      const candidate = candidates[j];
	      if (reqSeen[candidate]) continue;
	      reqSeen[candidate] = true;
	      requestDomains.push(candidate);
	    }
	  }

	  let persisted = {};
	  try {
	    persisted = await fetchPersistedFavicons(requestDomains);
	    const map = (persisted && typeof persisted === 'object') ? persisted : {};
	    for (const key in map) {
	      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
	      const entry = map[key];
	      if (!entry || typeof entry !== 'object') continue;
	      // 新格式：pageUrl；老格式：src（可能是 http URL 或 data:URL）
	      let usableSrc = '';
	      if (typeof entry.pageUrl === 'string' && entry.pageUrl) {
	        usableSrc = buildExtensionFaviconUrl(entry.pageUrl, 32);
	      } else if (typeof entry.src === 'string' && entry.src && isLoadableIconSrc(entry.src)) {
	        usableSrc = entry.src;
	      }
	      if (usableSrc && isLoadableIconSrc(usableSrc)) setFaviconCache(key, usableSrc);
	    }
	  } catch (e) { /* proceed with remaining sources */ }

	  if (token !== faviconRenderToken) return;

	  // 应用 IDB 命中 + 收集仍未命中的 domain
	  const missing = [];
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
	    missing.push(domain);
	  }
	  if (missing.length === 0) return;

	  // Phase 2b: 对未命中的 domain 直接用 chrome-extension://_favicon 构造 URL
	  // 浏览器内置 favicon 服务本地同步返回，不需要 fetch/base64/消息往返
	  for (let i = 0; i < missing.length; i++) {
	    const domain = missing[i];
	    const pageUrl = domainToPageUrl[domain] || ("https://" + domain);
	    const extUrl = buildExtensionFaviconUrl(pageUrl, 32);
	    if (!extUrl) continue;
	    setFaviconCache(domain, extUrl);
	    applyFaviconToImages(domainToImages[domain], extUrl, token);
	    // 持久化 pageUrl（不持久化 extUrl，因为里面含扩展 ID 不稳定）
	    queuePersistFavicon(domain, pageUrl);
	  }

	  // Phase 2c: 对私有主机 + declared link 的本地候选走 loadFavicon（仍保留兜底）
	  if (token !== faviconRenderToken) return;
	  const privateMissing = missing.filter((d) => isLikelyPrivateHost(d) && !failureCooldownDomains[d]);
	  if (privateMissing.length === 0) return;

	  const concurrency = Math.min(3, privateMissing.length);
	  let nextIndex = 0;
	  async function worker() {
	    while (nextIndex < privateMissing.length) {
	      if (token !== faviconRenderToken) return;
	      const idx = nextIndex++;
	      const domain = privateMissing[idx];
	      const pageUrl = domainToPageUrl[domain] || ("https://" + domain);
	      await new Promise((resolve) => {
	        loadFavicon(domain, pageUrl, function(result) {
	          if (token !== faviconRenderToken) { resolve(); return; }
	          const safeUrl = result && typeof result === 'object' ? String(result.src || '') : (typeof result === 'string' ? result : '');
	          if (safeUrl && isLoadableIconSrc(safeUrl)) {
	            setFaviconCache(domain, safeUrl);
	            applyFaviconToImages(domainToImages[domain], safeUrl, token);
	            // 私有主机本地命中的 URL（可能是 http://192.168...）也持久化
	            if (safeUrl.startsWith('http://') || safeUrl.startsWith('https://')) {
	              queuePersistFavicon(domain, safeUrl);
	            }
	          }
	          resolve();
	        }, { allowBrowserCache: false, allowExternal: false, allowLocal: true });
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
	  }, 5000);
	}

	/**
	 * Lightweight IDB-only prefetch: populates the in-memory favicon cache from
	 * persisted IDB entries at content-script startup so the first search-overlay
	 * open can skip the IDB round-trip entirely.
	 * No network requests are made — this is a pure read from IDB → memory.
	 *
	 * Resource-friendly: fetches in small batches (PREFETCH_BATCH_SIZE) with idle
	 * callbacks between batches so we never block the main thread noticeably.
	 */
	let faviconMemoryPrefetchDone = false;
	const PREFETCH_BATCH_SIZE = 80;

	function waitForIdle() {
	  return new Promise((resolve) => {
	    if (typeof requestIdleCallback === 'function') {
	      requestIdleCallback(resolve, { timeout: 2000 });
	    } else {
	      setTimeout(resolve, 50);
	    }
	  });
	}

	async function prefetchFaviconCacheFromIdb() {
	  if (faviconMemoryPrefetchDone) return;
	  faviconMemoryPrefetchDone = true;
	  try {
	    const domainToPageUrl = await fetchWarmupDomainMapFromBackground(400);
	    if (!domainToPageUrl) return;
	    const allDomains = Object.keys(domainToPageUrl);
	    if (allDomains.length === 0) return;

	    for (let offset = 0; offset < allDomains.length; offset += PREFETCH_BATCH_SIZE) {
	      const batch = allDomains.slice(offset, offset + PREFETCH_BATCH_SIZE);

	      await waitForIdle();

	      const persisted = await fetchPersistedFavicons(batch);
	      if (!persisted || typeof persisted !== 'object') continue;

	      for (const key in persisted) {
	        if (!Object.prototype.hasOwnProperty.call(persisted, key)) continue;
	        const entry = persisted[key];
	        if (!entry || typeof entry !== 'object') continue;
	        let src = '';
	        if (typeof entry.pageUrl === 'string' && entry.pageUrl) {
	          src = buildExtensionFaviconUrl(entry.pageUrl, 32);
	        }
	        if (!src && typeof entry.src === 'string' && entry.src) {
	          src = entry.src;
	        }
	        if (!src || !isLoadableIconSrc(src)) continue;
	        setFaviconCache(key, src);
	      }
	    }
	    faviconDebugLog('idb prefetch done', { loaded: faviconCache.size });
	  } catch (e) {
	    // Best-effort; failure is harmless — hydration will fallback to IDB at render time.
	  }
	}

	function scheduleFaviconMemoryPrefetch() {
	  // Delay so we don't compete with page's own resource loading.
	  setTimeout(prefetchFaviconCacheFromIdb, 2000);
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
	  const WARMUP_MAX_ATTEMPTS = 12;
	  for (let i = 0; i < list.length; i++) {
	    const domain = list[i];
	    const lastAttemptAt = faviconWarmupLastAttemptAt[domain] || 0;
	    if (lastAttemptAt > 0 && now - lastAttemptAt < WARMUP_MIN_INTERVAL_MS) continue;
	    filtered.push(domain);
	    if (filtered.length >= WARMUP_MAX_ATTEMPTS) break;
	  }
	  if (filtered.length === 0) return;

	  let nextIndex = 0;
	  const WARMUP_INTER_DOMAIN_DELAY_MS = 800;

	  function loadFaviconPromise(domain, pageUrl) {
	    return new Promise((resolve) => {
	      // Warmup domains have already missed memory + IDB caches.
	      // Skip browser cache (250ms timeout per domain) to avoid warmup being heavy.
	      // Keep local fallback enabled so private hosts behave the same as real search hydration.
	      loadFavicon(domain, pageUrl, resolve, { allowBrowserCache: false, allowExternal: true, allowLocal: true });
	    });
	  }

	  function warmupDelay() {
	    return new Promise((resolve) => setTimeout(resolve, WARMUP_INTER_DOMAIN_DELAY_MS));
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
	        setFaviconCache(domain, safeSrc);
	        queuePersistFavicon(domain, safeSrc);
	      } else if (isPrivateHost) {
	        faviconDebugLog('warmup private failure skipped', { domain, pageUrl, reason });
	        continue;
	      }
	      // Yield CPU between domains so warmup stays invisible to the user.
	      if (nextIndex < filtered.length) await warmupDelay();
	    }
	  }

	  // Serial execution (concurrency=1) to minimise background CPU footprint.
	  await worker();
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
	      let src = '';
	      if (typeof entry.pageUrl === 'string' && entry.pageUrl) {
	        src = buildExtensionFaviconUrl(entry.pageUrl, 32);
	      }
	      if (!src && typeof entry.src === 'string' && entry.src) {
	        src = entry.src;
	      }
	      if (!src || !isLoadableIconSrc(src)) continue;
	      setFaviconCache(key, src);
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
	    setProgressVisible(false);

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
	        // 新格式 {pageUrl} 优先：构造 _favicon URL；旧格式 {src} 向后兼容
	        let src = '';
	        if (typeof entry.pageUrl === 'string' && entry.pageUrl) {
	          src = buildExtensionFaviconUrl(entry.pageUrl, 32);
	        }
	        if (!src && typeof entry.src === 'string' && entry.src) {
	          src = entry.src;
	        }
	        if (!src || !isLoadableIconSrc(src)) continue;
	        setFaviconCache(domain, src);
	      }
	    }

	    const results = Array.isArray(response.results) ? response.results : [];
	    filteredResults = results.slice(0, 10);
	    selectedIndex = filteredResults.length > 0 ? 0 : -1;
	    displayResults(filteredResults);
	    // 记录查询词到最近搜索（仅当查询实际产出结果）
	    if (filteredResults.length > 0) recordRecentSearch(query);
	  } catch (error) {
	    if (token !== backgroundSearchToken) return;
	    setProgressVisible(false);

	    console.error("[Content] 后台搜索失败:", error);
	    filteredResults = [];
	    selectedIndex = -1;
	    cachedResultItems = null;
	    prevSelectedIndex = -1;
	    resultsContainer.innerHTML = "";

	    const emptyMsg = document.createElement("div");
	    emptyMsg.className = "bookmark-empty";
	    emptyMsg.innerHTML = '搜索失败 · 按 <kbd>Enter</kbd> 或修改查询词重试';
	    resultsContainer.appendChild(emptyMsg);
	    // Enter 键重试（在 input 外也能触发）
	    const lastQuery = searchInput ? String(searchInput.value || '').trim() : '';
	    const retryHandler = (ev) => {
	      // overlay 已关闭则立刻清理，避免误触发页面本身的 Enter
	      if (!searchOverlay || searchOverlay.style.display === 'none') {
	        document.removeEventListener('keydown', retryHandler, true);
	        return;
	      }
	      if (ev.key !== 'Enter') return;
	      if (!searchInput || !lastQuery) return;
	      document.removeEventListener('keydown', retryHandler, true);
	      searchBookmarksInBackground(lastQuery);
	    };
	    document.addEventListener('keydown', retryHandler, true);
	    // 兜底超时清理
	    setTimeout(() => document.removeEventListener('keydown', retryHandler, true), 10000);
	  }
	}

	// 处理搜索
	function handleSearch(query) {
	  // Invalidate any in-flight background search for previous queries.
	  backgroundSearchToken++;
	  const rawQuery = String(query || '').trim();

	  if (!rawQuery) {
	    currentQueryTokens = [];
	    setProgressVisible(false);
	    showRecentOpenedAsEmpty();
	    return;
	  }

	  currentQueryTokens = rawQuery.split(/\s+/).filter(Boolean);
	  searchBookmarksInBackground(rawQuery);
}

	function showRecentOpenedAsEmpty() {
	  if (!resultsContainer) return;
	  const token = ++recentLoadToken;
	  filteredResults = [];
	  resultsContainer.innerHTML = "";
	  cachedResultItems = null;
	  selectedIndex = -1;
	  prevSelectedIndex = -1;
	  if (searchInput) {
	    searchInput.setAttribute('aria-expanded', 'false');
	    searchInput.setAttribute('aria-activedescendant', '');
	  }

	  // 并行加载最近搜索和最近打开
	  Promise.all([
	    loadRecentSearches(),
	    sendMessagePromise({ action: MESSAGE_ACTIONS.GET_RECENT_OPENED, limit: 10 }).catch(() => null)
	  ]).then(([searches, response]) => {
	    if (token !== recentLoadToken) return;
	    const items = (response && response.success !== false && Array.isArray(response.items)) ? response.items : [];

	    const hasSearches = Array.isArray(searches) && searches.length > 0;
	    const hasItems = items.length > 0;

	    if (hasSearches) {
	      renderRecentSearchChips(searches.slice(0, 8));
	    }
	    if (hasItems) {
	      filteredResults = items.slice(0, 10);
	      selectedIndex = 0;
	      // 若前面已有 chips，不 clear container；追加 items
	      appendRecentItems(filteredResults);
	    } else if (!hasSearches) {
	      renderOnboardingEmpty();
	    }
	  }).catch((err) => {
	    console.warn('[Content] showRecentOpenedAsEmpty failed:', err);
	  });
}

function renderRecentSearchChips(searches) {
  if (!resultsContainer) return;
  const wrap = document.createElement('div');
  wrap.className = 'bookmark-recent-searches';
  const hint = document.createElement('div');
  hint.className = 'bookmark-section-hint';
  hint.textContent = '最近搜索';
  wrap.appendChild(hint);
  const chips = document.createElement('div');
  chips.className = 'bookmark-recent-searches-chips';
  for (let i = 0; i < searches.length; i++) {
    const item = searches[i];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bookmark-recent-chip';
    chip.textContent = item.query;
    chip.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (!searchInput) return;
      searchInput.value = item.query;
      searchInput.focus();
      handleSearchDebounced({ target: searchInput });
    });
    chips.appendChild(chip);
  }
  wrap.appendChild(chips);
  resultsContainer.appendChild(wrap);
}

function appendRecentItems(results) {
  // displayResults 会 clear container；为保留已 append 的 chips，这里包一个子容器
  // 简化做法：重建 + 先渲 chips 再渲 items
  const existingChips = resultsContainer.querySelector('.bookmark-recent-searches');
  const chipsMarkup = existingChips ? existingChips.outerHTML : '';
  displayResults(results, { isRecent: true });
  if (chipsMarkup) {
    resultsContainer.insertAdjacentHTML('afterbegin', chipsMarkup);
    // 重新绑定 chip 点击（insertAdjacentHTML 丢失事件）
    const chips = resultsContainer.querySelectorAll('.bookmark-recent-chip');
    chips.forEach((chip) => {
      chip.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (!searchInput) return;
        searchInput.value = chip.textContent;
        searchInput.focus();
        handleSearchDebounced({ target: searchInput });
      });
    });
  }
}

	function renderOnboardingEmpty() {
	  if (!resultsContainer) return;
	  resultsContainer.innerHTML = '';
	  const wrap = document.createElement('div');
	  wrap.className = 'bookmark-onboard';
	  wrap.innerHTML = `
	    <div class="bookmark-onboard-title">开始搜索书签</div>
	    <div class="bookmark-onboard-body">
	      <div class="bookmark-onboard-row">
	        <span class="bookmark-onboard-label">直接输入</span>
	        <span class="bookmark-onboard-value">title / URL / 文件夹路径 中的关键词</span>
	      </div>
	      <div class="bookmark-onboard-row">
	        <span class="bookmark-onboard-label">多词搜索</span>
	        <span class="bookmark-onboard-value">用空格分隔，所有词都要命中</span>
	      </div>
	      <div class="bookmark-onboard-row">
	        <span class="bookmark-onboard-label">快速打开</span>
	        <span class="bookmark-onboard-value">结果出现后按数字键直达前 9 条</span>
	      </div>
	    </div>
	  `;
	  resultsContainer.appendChild(wrap);
	}

function escapeRegExp(source) {
  return String(source || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 将 text 中命中 currentQueryTokens 的片段包裹成 <mark>，其余用 text 节点
function renderHighlightedText(text) {
  const safeText = String(text == null ? '' : text);
  const tokens = Array.isArray(currentQueryTokens) ? currentQueryTokens.filter(Boolean) : [];
  const frag = document.createDocumentFragment();
  if (!safeText) return frag;
  if (tokens.length === 0) {
    frag.appendChild(document.createTextNode(safeText));
    return frag;
  }
  const pattern = new RegExp('(' + tokens.map(escapeRegExp).join('|') + ')', 'gi');
  let lastIdx = 0;
  let match;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(safeText)) !== null) {
    if (match.index > lastIdx) {
      frag.appendChild(document.createTextNode(safeText.slice(lastIdx, match.index)));
    }
    const mark = document.createElement('mark');
    mark.className = 'bs-mark';
    mark.textContent = match[0];
    frag.appendChild(mark);
    lastIdx = pattern.lastIndex;
    // 避免零宽匹配导致死循环
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
  }
  if (lastIdx < safeText.length) {
    frag.appendChild(document.createTextNode(safeText.slice(lastIdx)));
  }
  return frag;
}

function renderPathBreadcrumb(container, pathValue) {
  container.textContent = '';
  const raw = typeof pathValue === 'string' ? pathValue : '';
  if (!raw) return;
  const parts = raw.split(' > ').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    container.appendChild(renderHighlightedText(raw));
    return;
  }
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'bookmark-path-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '›';
      container.appendChild(sep);
    }
    const seg = document.createElement('span');
    seg.className = 'bookmark-path-seg';
    seg.appendChild(renderHighlightedText(parts[i]));
    container.appendChild(seg);
  }
}

// 显示搜索结果
function displayResults(results, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const isRecent = !!opts.isRecent;
  resultsContainer.innerHTML = "";
  cachedResultItems = null;
  prevSelectedIndex = -1;
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

  if (isRecent) {
    const hint = document.createElement('div');
    hint.className = 'bookmark-section-hint';
    hint.textContent = '最近打开';
    resultsContainer.appendChild(hint);
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
    // 给前 9 条加一个 index badge，提示可用 Cmd/Ctrl+数字直达
    if (index < 9) {
      const badge = document.createElement('span');
      badge.className = 'bookmark-index-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = String(index + 1);
      item.appendChild(badge);
    }

    const favicon = document.createElement("img");
    favicon.className = "bookmark-favicon";
    favicon.addEventListener('error', handleRenderedFaviconError);
    resetFaviconImageErrorState(favicon, defaultIcon, token);
    favicon.src = defaultIcon;
    // 标记 loading 骨架；一旦拿到真实 src 就清掉
    favicon.dataset.bsLoading = 'true';
    favicon.addEventListener('load', function() {
      if (favicon.src && favicon.src !== defaultIcon) {
        delete favicon.dataset.bsLoading;
      }
    });
    let parsedUrl = null;
    try { parsedUrl = new URL(bookmark.url); } catch (e) {}
    if (parsedUrl && parsedUrl.hostname) {
      const pageUrl = parsedUrl.href;
      const key = buildFaviconServiceKey(pageUrl);
      const resolvedPageUrl = pageUrl || ("https://" + (key || parsedUrl.hostname));
      setFaviconImageContext(favicon, key, resolvedPageUrl, token);
      // 优先使用内存缓存（包括 data: 和外部 URL），避免二次搜索延迟
      const cachedSrc = getCachedFaviconForDomain(key);
      if (cachedSrc) {
        resetFaviconImageErrorState(favicon, cachedSrc, token);
        favicon.src = cachedSrc;
        delete favicon.dataset.bsLoading;
      } else {
        if (!domainToImages[key]) domainToImages[key] = [];
        domainToImages[key].push(favicon);
        if (!domainToPageUrl[key]) {
          // Use the full bookmark URL for better browser favicon cache hits.
          domainToPageUrl[key] = resolvedPageUrl;
        }
      }
    } else {
      // 无有效 URL 场景：不会有真实 favicon，尽快去除骨架
      delete favicon.dataset.bsLoading;
    }

    const textContainer = document.createElement("div");
    textContainer.className = "bookmark-text";

    const title = document.createElement("div");
    title.className = "bookmark-title";
    title.appendChild(renderHighlightedText(bookmark.title || ''));
    textContainer.appendChild(title);

    if (bookmark.path) {
      const pathEl = document.createElement("div");
      pathEl.className = "bookmark-path";
      renderPathBreadcrumb(pathEl, bookmark.path);
      textContainer.appendChild(pathEl);
    }

    const url = document.createElement("div");
    url.className = "bookmark-url";
    url.setAttribute('title', bookmark.url || '');
    url.appendChild(renderHighlightedText(bookmark.url || ''));
    textContainer.appendChild(url);

    item.appendChild(favicon);
    item.appendChild(textContainer);

    fragment.appendChild(item);
  });

  // 一次性插入所有结果
  resultsContainer.appendChild(fragment);

  // 缓存结果项 DOM 引用，供 updateSelection 使用（避免重复 querySelectorAll）
  cachedResultItems = resultsContainer.querySelectorAll(".bookmark-item");

  // 同步 prevSelectedIndex 到当前 selectedIndex，避免后续上下键/hover 时 updateSelection
  // 因 prevSelectedIndex 仍是 -1 而跳过清除分支，导致第一条持续高亮。
  prevSelectedIndex = (selectedIndex >= 0 && selectedIndex < cachedResultItems.length) ? selectedIndex : -1;

  // 多选态跨搜索保留：重绘命中项的 is-multi-selected class
  if (multiSelectedIds.size > 0) {
    repaintMultiSelectState();
    updateMultiSelectBar();
  }

  const domainsToHydrate = Object.keys(domainToImages);
  if (domainsToHydrate.length > 0) {
    hydrateFaviconsForDomains(domainsToHydrate, domainToImages, domainToPageUrl, token);
  }
}

// 加载 Favicon
	var defaultIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%23999' d='M8 0a8 8 0 100 16A8 8 0 008 0z'/%3E%3C/svg%3E";

	// Monogram fallback: favicon 加载失败时显示 "首字母 + 哈希主题色" 圆形
	var monogramCache = Object.create(null);
	function hashDomainHue(seed) {
	  const s = String(seed || '').trim().toLowerCase();
	  if (!s) return 200;
	  let h = 0;
	  for (let i = 0; i < s.length; i++) {
	    h = ((h << 5) - h) + s.charCodeAt(i);
	    h |= 0;
	  }
	  return Math.abs(h) % 360;
	}
	function monogramLetter(seed) {
	  const s = String(seed || '').trim().toLowerCase();
	  if (!s) return '?';
	  // 剥掉 www.
	  const cleaned = s.indexOf('www.') === 0 ? s.slice(4) : s;
	  const first = cleaned.charAt(0);
	  if (!first) return '?';
	  // 若首字符为 ASCII 字母/数字取大写；否则原样返回
	  if (/[a-z0-9]/i.test(first)) return first.toUpperCase();
	  return first;
	}
	function buildMonogramDataUrl(seed) {
	  const key = String(seed || '').trim().toLowerCase();
	  if (monogramCache[key]) return monogramCache[key];

	  // IP / localhost 用专用图标，而不是"首字母方块"
	  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(key);
	  const isLocalhost = key === 'localhost' || key.endsWith('.local') || key.endsWith('.lan');
	  let svg;
	  if (isIp || isLocalhost) {
	    const hue = hashDomainHue(key);
	    const bg = 'hsl(' + hue + ',42%,44%)';
	    const bgDark = 'hsl(' + hue + ',42%,32%)';
	    if (isIp) {
	      // 地球图标：IP 通常是服务器/内网设备
	      svg =
	        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
	        + '<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1">'
	        + '<stop offset="0" stop-color="' + bg + '"/>'
	        + '<stop offset="1" stop-color="' + bgDark + '"/>'
	        + '</linearGradient></defs>'
	        + '<rect width="16" height="16" rx="4" fill="url(#g)"/>'
	        + '<g stroke="#ffffff" stroke-width="1" stroke-linecap="round" fill="none" opacity="0.9">'
	        + '<circle cx="8" cy="8" r="4.2"/>'
	        + '<ellipse cx="8" cy="8" rx="2" ry="4.2"/>'
	        + '<line x1="3.8" y1="8" x2="12.2" y2="8"/>'
	        + '</g>'
	        + '</svg>';
	    } else {
	      // 服务器机架图标：localhost / *.local
	      svg =
	        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
	        + '<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1">'
	        + '<stop offset="0" stop-color="' + bg + '"/>'
	        + '<stop offset="1" stop-color="' + bgDark + '"/>'
	        + '</linearGradient></defs>'
	        + '<rect width="16" height="16" rx="4" fill="url(#g)"/>'
	        + '<g stroke="#ffffff" stroke-width="1" stroke-linecap="round" fill="none" opacity="0.9">'
	        + '<rect x="4" y="4" width="8" height="3" rx="0.5"/>'
	        + '<rect x="4" y="9" width="8" height="3" rx="0.5"/>'
	        + '<circle cx="6" cy="5.5" r="0.5" fill="#ffffff" stroke="none"/>'
	        + '<circle cx="6" cy="10.5" r="0.5" fill="#ffffff" stroke="none"/>'
	        + '</g>'
	        + '</svg>';
	    }
	  } else {
	    // 普通域名：首字母 hash 色方块
	    const letter = monogramLetter(key);
	    const hue = hashDomainHue(key);
	    const bg = 'hsl(' + hue + ',58%,48%)';
	    const bgDark = 'hsl(' + hue + ',58%,36%)';
	    const fontSize = letter.length > 1 ? 8 : 10;
	    svg =
	      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
	      + '<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1">'
	      + '<stop offset="0" stop-color="' + bg + '"/>'
	      + '<stop offset="1" stop-color="' + bgDark + '"/>'
	      + '</linearGradient></defs>'
	      + '<rect width="16" height="16" rx="4" fill="url(#g)"/>'
	      + '<text x="8" y="11.5" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="' + fontSize + '" font-weight="700" fill="#ffffff">' + escapeSvgText(letter) + '</text>'
	      + '</svg>';
	  }
	  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
	  monogramCache[key] = url;
	  return url;
	}
	function escapeSvgText(text) {
	  return String(text || '')
	    .replace(/&/g, '&amp;')
	    .replace(/</g, '&lt;')
	    .replace(/>/g, '&gt;')
	    .replace(/"/g, '&quot;')
	    .replace(/'/g, '&#39;');
	}
  function buildExtensionFaviconUrl(pageUrl, size) {
    try {
      if (!chrome || !chrome.runtime || typeof chrome.runtime.getURL !== 'function') return '';
      var safePage = typeof pageUrl === 'string' && pageUrl ? pageUrl : '';
      if (!safePage) return '';
      var base = chrome.runtime.getURL('_favicon/');
      if (!base || base.indexOf('chrome-extension://') !== 0) return '';
      var sz = (typeof size === 'number' && size > 0) ? Math.floor(size) : 32;
      return base + '?pageUrl=' + encodeURIComponent(safePage) + '&size=' + sz;
    } catch (e) {
      return '';
    }
  }

  // 启发式判断：Chrome _favicon 服务对无图标站点返回默认地球图标
  // （灰/白圆+地球线条），img.onload 会正常触发使得 fallback 不生效。
  // 通过 canvas 采样识别：4 角几乎透明 + 中心低饱和 + 全图颜色种类极少。
  function isLikelyDefaultGlobeFavicon(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) return false;
    try {
      var N = 16;
      var canvas = document.createElement('canvas');
      canvas.width = N;
      canvas.height = N;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.clearRect(0, 0, N, N);
      ctx.drawImage(img, 0, 0, N, N);
      var data;
      try {
        data = ctx.getImageData(0, 0, N, N).data;
      } catch (e) {
        return false; // cross-origin tainting
      }
      // 1) 四角必须基本透明（默认地球是圆形，四角空）
      var corners = [0, (N - 1) * 4, (N * (N - 1)) * 4, (N * N - 1) * 4];
      var transparentCorners = 0;
      for (var ci = 0; ci < corners.length; ci++) {
        if (data[corners[ci] + 3] < 40) transparentCorners++;
      }
      if (transparentCorners < 3) return false;
      // 2) 中心颜色低饱和（默认是灰 / 浅蓝灰）
      var cIdx = ((N >> 1) * N + (N >> 1)) * 4;
      var cR = data[cIdx], cG = data[cIdx + 1], cB = data[cIdx + 2], cA = data[cIdx + 3];
      if (cA < 60) return false;
      var cMax = Math.max(cR, cG, cB), cMin = Math.min(cR, cG, cB);
      var sat = cMax > 0 ? (cMax - cMin) / cMax : 0;
      if (sat > 0.35) return false;
      // 3) 色彩种类稀少（地球图案本质是单色线条 + 渐变）
      var colors = Object.create(null);
      var uniq = 0;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 32) continue;
        var key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        if (!colors[key]) { colors[key] = 1; uniq++; if (uniq > 6) return false; }
      }
      return uniq <= 4;
    } catch (e) {
      return false;
    }
  }

	function loadFavicon(domain, pageUrl, callback, options) {
	  // 提取一级域名（IP/localhost 直接返回自身）
	  var rootDomain = getRootDomain(domain);
	  var isSubdomain = rootDomain && domain !== rootDomain;

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

	  // 构建源列表：优先浏览器 favicon 缓存，再按需降级第三方源。
  // 注意：不要直接请求站点自身 /favicon.ico（会触发 Mixed Content、证书错误、CORP 阻断等，且在 https 页面里 http 图标会被自动升级导致失败）。
  var sources = [];

	  // 对局域网/私有主机：不走第三方 favicon 服务（一般会 404，且有隐私泄露）
	  var isPrivateHost = isLikelyPrivateHost(domain);
	  var allowRootDomainExternalFallback = !!(isSubdomain && rootDomain && !isKnownMultiTenantFaviconHost(rootDomain));

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
    // 优先使用 chrome-extension://_favicon/?pageUrl=...&size=32
    // 走浏览器原生 favicon 服务，避免走 DDG/Google 等第三方（含隐私泄露、断网不可用问题）
    var pageUrlForFavicon = safePageUrl || ("https://" + domain + "/");
    appendUniqueCandidate(sources, buildExtensionFaviconUrl(pageUrlForFavicon, 32));
    if (allowRootDomainExternalFallback) {
      appendUniqueCandidate(sources, buildExtensionFaviconUrl("https://" + rootDomain + "/", 32));
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
    var isExtensionFavicon = url.indexOf("chrome-extension://") === 0 && url.indexOf("/_favicon/") !== -1;

    var settled = false;
    // _favicon 走浏览器内置同步服务；本地 link/origin 候选给 3s；私有主机 allowLocal 时给 1.2s
    var timeoutMs = isExtensionFavicon ? 2000 : ((isPrivateHost && allowLocal) ? 1200 : 3000);
    faviconDebugLog('try', { domain: domain, idx: idx, url: url, isExtensionFavicon: isExtensionFavicon, timeoutMs: timeoutMs });
    var img = new Image();
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      img.src = ''; // 中止正在进行的网络请求
      faviconDebugLog('timeout', { domain: domain, url: url, idx: idx, timeoutMs: timeoutMs });
      tryLoad(idx + 1);
    }, timeoutMs);

    img.onload = function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      faviconDebugLog('loaded', { domain: domain, url: url, w: img.naturalWidth, h: img.naturalHeight, source: isExtensionFavicon ? '_favicon' : 'local' });
      // _favicon 源：对无图标站点会返回默认地球，识别后继续 fallback 到 monogram
      if (isExtensionFavicon && isLikelyDefaultGlobeFavicon(img)) {
        faviconDebugLog('favicon_default_globe_detected', { domain: domain, url: url });
        tryLoad(idx + 1);
        return;
      }
      finishSuccess(url, isExtensionFavicon ? '_favicon' : 'local');
    };
    img.onerror = function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.src = '';
      faviconDebugLog('error', { domain: domain, url: url, idx: idx });
      tryLoad(idx + 1);
    };
    img.src = url;
  }

  // allowBrowserCache 已退役（v2.x）：_favicon 已直接通过 URL 使用，sources 里包含
  tryLoad(0);
}

// ============ 多选（Shift+Click / Shift+Space） ============
function toggleMultiSelect(index) {
  if (index < 0 || index >= filteredResults.length) return;
  const bm = filteredResults[index];
  if (!bm || !bm.id) return;
  const id = String(bm.id);
  if (multiSelectedIds.has(id)) {
    multiSelectedIds.delete(id);
  } else {
    multiSelectedIds.add(id);
  }
  multiSelectAnchorIndex = index;
  repaintMultiSelectState();
  updateMultiSelectBar();
}

function clearMultiSelect() {
  if (multiSelectedIds.size === 0 && multiSelectAnchorIndex < 0) return;
  multiSelectedIds.clear();
  multiSelectAnchorIndex = -1;
  repaintMultiSelectState();
  updateMultiSelectBar();
}

function rangeSelectMulti(fromIndex, toIndex) {
  const lo = Math.max(0, Math.min(fromIndex, toIndex));
  const hi = Math.min(filteredResults.length - 1, Math.max(fromIndex, toIndex));
  for (let i = lo; i <= hi; i++) {
    const bm = filteredResults[i];
    if (bm && bm.id) multiSelectedIds.add(String(bm.id));
  }
  // 锚点保持为首个调用者指定的起点（fromIndex）
  multiSelectAnchorIndex = fromIndex;
  repaintMultiSelectState();
  updateMultiSelectBar();
}

function repaintMultiSelectState() {
  if (!cachedResultItems) return;
  for (let i = 0; i < cachedResultItems.length; i++) {
    const item = cachedResultItems[i];
    const bm = filteredResults[i];
    if (!item || !bm) continue;
    const isSel = multiSelectedIds.has(String(bm.id));
    item.classList.toggle('is-multi-selected', isSel);
  }
}

function updateMultiSelectBar() {
  if (!searchContainer) return;
  let bar = searchContainer.querySelector('.bookmark-multi-bar');
  const count = multiSelectedIds.size;
  if (count === 0) {
    if (bar) bar.parentNode.removeChild(bar);
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'bookmark-multi-bar';
    bar.innerHTML = `
      <span class="bookmark-multi-count"></span>
      <span class="bookmark-multi-hint">Enter 全部打开 · Del 删除 · Esc 取消</span>
      <button type="button" class="bookmark-multi-action" data-act="open">打开 (Enter)</button>
      <button type="button" class="bookmark-multi-action is-danger" data-act="delete">删除 (Del)</button>
    `;
    const shortcutsEl = searchContainer.querySelector('.bookmark-shortcuts');
    if (shortcutsEl) {
      searchContainer.insertBefore(bar, shortcutsEl);
    } else {
      searchContainer.appendChild(bar);
    }
    bar.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.bookmark-multi-action') : null;
      if (!btn) return;
      e.preventDefault();
      const act = btn.dataset.act;
      if (act === 'open') openAllMultiSelected();
      else if (act === 'delete') deleteAllMultiSelected();
    });
  }
  const countEl = bar.querySelector('.bookmark-multi-count');
  if (countEl) countEl.textContent = `已选 ${count} 条`;
}

function openAllMultiSelected() {
  if (multiSelectedIds.size === 0) return;
  const toOpen = filteredResults.filter((bm) => bm && multiSelectedIds.has(String(bm.id)));
  const ids = Array.from(multiSelectedIds);
  multiSelectedIds.clear();
  toOpen.forEach((bm) => {
    try {
      const opened = window.open(bm.url, '_blank', 'noopener,noreferrer');
      if (opened) opened.opener = null;
      sendMessagePromise({ action: MESSAGE_ACTIONS.TRACK_BOOKMARK_OPEN, url: bm.url }).catch(() => {});
    } catch (e) {}
  });
  hideSearch();
}

function deleteAllMultiSelected() {
  if (multiSelectedIds.size === 0) return;
  const ids = Array.from(multiSelectedIds);
  if (!window.confirm(`确定删除选中的 ${ids.length} 条书签？此操作会同步删除浏览器书签。`)) return;
  sendMessagePromise({ action: MESSAGE_ACTIONS.DELETE_BOOKMARKS_BATCH, ids })
    .then(() => {
      // 从当前结果中移除
      filteredResults = filteredResults.filter((bm) => !multiSelectedIds.has(String(bm.id)));
      multiSelectedIds.clear();
      if (selectedIndex >= filteredResults.length) selectedIndex = filteredResults.length - 1;
      displayResults(filteredResults);
    })
    .catch((e) => console.warn('[Content] batch delete failed:', e));
}

// ============ Action menu（右键/Alt+Enter 呼出） ============
let actionMenuEl = null;
let actionMenuTargetIndex = -1;
let actionMenuSelectedIndex = 0;

function getActionMenuItems(bookmark) {
  const items = [
    { key: 'copy',    label: '复制链接',       hint: 'C',      action: () => copyBookmarkUrl(bookmark) },
    { key: 'window',  label: '在新窗口打开',   hint: 'W',      action: () => openBookmarkInNewWindow(bookmark) },
    { key: 'reveal',  label: '在书签管理器中显示', hint: 'F', action: () => revealBookmarkInManager(bookmark) },
    { key: 'delete',  label: '删除此书签',     hint: 'Del',    action: () => deleteBookmarkWithConfirm(bookmark), danger: true }
  ];
  return items;
}

function showActionMenu(index) {
  hideActionMenu();
  if (!resultsContainer) return;
  if (index < 0 || index >= filteredResults.length) return;
  const bookmark = filteredResults[index];
  if (!bookmark) return;
  actionMenuTargetIndex = index;
  actionMenuSelectedIndex = 0;

  const items = getActionMenuItems(bookmark);
  const menu = document.createElement('div');
  menu.className = 'bookmark-action-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '书签操作菜单');

  items.forEach((item, i) => {
    const mi = document.createElement('div');
    mi.className = 'bookmark-action-menu-item';
    if (item.danger) mi.classList.add('is-danger');
    if (i === 0) mi.classList.add('is-active');
    mi.setAttribute('role', 'menuitem');
    mi.tabIndex = -1;
    mi.dataset.action = item.key;
    const label = document.createElement('span');
    label.className = 'bookmark-action-menu-label';
    label.textContent = item.label;
    const hint = document.createElement('kbd');
    hint.className = 'bookmark-action-menu-hint';
    hint.textContent = item.hint;
    mi.appendChild(label);
    mi.appendChild(hint);
    mi.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      invokeActionMenuItem(i);
    });
    menu.appendChild(mi);
  });

  // 位置：依附于当前选中的结果项
  const anchor = cachedResultItems && cachedResultItems[index];
  if (anchor && searchContainer) {
    const anchorRect = anchor.getBoundingClientRect();
    const containerRect = searchContainer.getBoundingClientRect();
    // 绝对定位到 searchContainer 内部
    menu.style.top = (anchorRect.bottom - containerRect.top + 4) + 'px';
    menu.style.right = '16px';
  }

  searchContainer.appendChild(menu);
  actionMenuEl = menu;
}

function hideActionMenu() {
  if (actionMenuEl) {
    try { actionMenuEl.parentNode.removeChild(actionMenuEl); } catch (e) {}
  }
  actionMenuEl = null;
  actionMenuTargetIndex = -1;
  actionMenuSelectedIndex = 0;
}

function updateActionMenuSelection() {
  if (!actionMenuEl) return;
  const items = actionMenuEl.querySelectorAll('.bookmark-action-menu-item');
  items.forEach((el, i) => el.classList.toggle('is-active', i === actionMenuSelectedIndex));
}

function invokeActionMenuItem(index) {
  if (!actionMenuEl) return;
  if (actionMenuTargetIndex < 0) { hideActionMenu(); return; }
  const bookmark = filteredResults[actionMenuTargetIndex];
  if (!bookmark) { hideActionMenu(); return; }
  const items = getActionMenuItems(bookmark);
  const item = items[index];
  if (!item) { hideActionMenu(); return; }
  try {
    item.action();
  } catch (e) {
    console.warn('[Content] action menu execute failed:', e);
  }
  hideActionMenu();
}

function handleActionMenuKeydown(e) {
  if (!actionMenuEl) return false;
  const items = getActionMenuItems(filteredResults[actionMenuTargetIndex] || {});
  const count = items.length;
  switch (e.key) {
    case 'Escape':
      e.preventDefault(); e.stopPropagation();
      hideActionMenu();
      return true;
    case 'ArrowDown':
      e.preventDefault(); e.stopPropagation();
      actionMenuSelectedIndex = (actionMenuSelectedIndex + 1) % count;
      updateActionMenuSelection();
      return true;
    case 'ArrowUp':
      e.preventDefault(); e.stopPropagation();
      actionMenuSelectedIndex = (actionMenuSelectedIndex - 1 + count) % count;
      updateActionMenuSelection();
      return true;
    case 'Enter':
      e.preventDefault(); e.stopPropagation();
      invokeActionMenuItem(actionMenuSelectedIndex);
      return true;
    case 'c': case 'C':
      e.preventDefault(); e.stopPropagation();
      invokeActionMenuItem(0);
      return true;
    case 'w': case 'W':
      e.preventDefault(); e.stopPropagation();
      invokeActionMenuItem(1);
      return true;
    case 'f': case 'F':
      e.preventDefault(); e.stopPropagation();
      invokeActionMenuItem(2);
      return true;
    case 'Delete': case 'Backspace':
      e.preventDefault(); e.stopPropagation();
      invokeActionMenuItem(3);
      return true;
  }
  return false;
}

function copyBookmarkUrl(bookmark) {
  const url = bookmark && bookmark.url ? String(bookmark.url) : '';
  if (!url) return;
  let success = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        () => showOverlayToast('已复制链接'),
        () => {
          if (legacyCopy(url)) showOverlayToast('已复制链接');
          else showOverlayToast('复制失败', true);
        }
      );
      return;
    }
    success = legacyCopy(url);
  } catch (e) {
    success = legacyCopy(url);
  }
  showOverlayToast(success ? '已复制链接' : '复制失败', !success);
}

function showOverlayToast(message, isError) {
  if (!searchContainer) return;
  const existing = searchContainer.querySelector('.bookmark-overlay-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'bookmark-overlay-toast';
  if (isError) el.classList.add('is-error');
  el.textContent = String(message || '');
  searchContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));
  setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { try { el.remove(); } catch (e) {} }, 220);
  }, 1600);
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

function openBookmarkInNewWindow(bookmark) {
  const url = bookmark && bookmark.url ? String(bookmark.url) : '';
  if (!url) return;
  sendMessagePromise({ action: MESSAGE_ACTIONS.OPEN_BOOKMARK_IN_WINDOW, url }).catch(() => {
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) {}
  });
  hideSearch();
}

function revealBookmarkInManager(bookmark) {
  const id = bookmark && bookmark.id ? String(bookmark.id) : '';
  sendMessagePromise({ action: MESSAGE_ACTIONS.REVEAL_BOOKMARK, id }).catch(() => {});
  hideSearch();
}

function deleteBookmarkWithConfirm(bookmark) {
  const id = bookmark && bookmark.id ? String(bookmark.id) : '';
  const title = bookmark && bookmark.title ? String(bookmark.title) : '';
  if (!id) return;
  const ok = window.confirm('确定删除「' + (title || bookmark.url) + '」？此操作会在浏览器书签中删除该条目。');
  if (!ok) return;
  sendMessagePromise({ action: MESSAGE_ACTIONS.DELETE_BOOKMARK, id })
    .then(() => {
      // 从当前结果中移除该项并重渲
      filteredResults = filteredResults.filter((b) => String(b.id) !== id);
      if (selectedIndex >= filteredResults.length) selectedIndex = filteredResults.length - 1;
      displayResults(filteredResults);
    })
    .catch((e) => {
      console.warn('[Content] delete bookmark failed:', e);
    });
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
      resetSearchUiState();
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
    resetSearchUiState();
  }
}

  console.log("[Content] 准备调用 init");
  init();

  // Pre-populate in-memory favicon cache from IDB so the first overlay open is instant.
  scheduleFaviconMemoryPrefetch();

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
