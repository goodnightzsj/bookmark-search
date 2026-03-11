import { getWarmupDomainMap, refreshBookmarks, searchBookmarks, clearHistory, recordBookmarkOpen } from './background-data.js';
import { setupAutoSync } from './background-sync.js';
import { MESSAGE_ACTIONS, MESSAGE_ACTION_VALUES, MESSAGE_ERROR_CODES } from './constants.js';
import { idbGetMany, idbSetMany } from './idb-service.js';
import { getRootDomain } from './utils.js';

const IDB_KEY_PREFIX_FAVICON = 'favicon:';

// Browser favicon cache (derived from chrome.favicon.getFaviconUrl).
// We keep a small in-memory LRU so repeated searches across tabs/pages don't re-fetch + re-base64 the same icon.
// A short fetch timeout approximates "browser already has it cached" vs "needs to fetch/compute".
const BROWSER_FAVICON_CACHE_MAX_SIZE = 800;
const BROWSER_FAVICON_POSITIVE_TTL_MS = 60 * 60 * 1000; // 1h
const BROWSER_FAVICON_NEGATIVE_TTL_MS = 5 * 60 * 1000; // 5m
const BROWSER_FAVICON_NEGATIVE_TTL_PRIVATE_MS = 30 * 1000; // 30s
const BROWSER_FAVICON_FETCH_TIMEOUT_MS = 250;
const BROWSER_FAVICON_FETCH_TIMEOUT_PRIVATE_MS = 1200;
const PERSISTED_FAVICON_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const browserFaviconCache = new Map(); // key -> { src, expiresAt }
const browserFaviconInFlight = new Map(); // key -> Promise<string>

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
  if (safe.endsWith('.lan')) return true;
  if (safe.endsWith('.internal')) return true;
  if (safe.endsWith('.intranet')) return true;
  if (safe.endsWith('.corp')) return true;
  if (safe.endsWith('.home')) return true;
  if (safe.endsWith('.localdomain')) return true;
  if (safe.indexOf('.') === -1) return true;
  return false;
}

function normalizeFaviconHost(host) {
  const safe = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (!safe) return '';
  // 去掉 www 前缀
  const withoutWww = safe.startsWith('www.') ? safe.slice(4) : safe;
  // 对于类似 a.b.example.com，取根域名 example.com，提高跨子域命中率。
  // 注意：IPv4 / localhost 需要保留原值（例如 192.168.0.1 不能被错误折叠为 0.1）。
  return getRootDomain(withoutWww) || withoutWww;
}

function getBrowserFaviconCacheKey(pageUrl) {
  const safe = typeof pageUrl === 'string' ? pageUrl.trim() : '';
  if (!safe) return '';
  try {
    return normalizeFaviconHost(new URL(safe).hostname);
  } catch (e) {
    return '';
  }
}

function getCachedBrowserFaviconSrc(key) {
  if (!key) return undefined;
  const entry = browserFaviconCache.get(key);
  if (!entry || typeof entry !== 'object') return undefined;
  const now = Date.now();
  const expiresAt = entry.expiresAt;
  if (typeof expiresAt !== 'number' || expiresAt <= now) {
    browserFaviconCache.delete(key);
    return undefined;
  }

  // LRU bump
  browserFaviconCache.delete(key);
  browserFaviconCache.set(key, entry);

  const src = entry.src;
  return typeof src === 'string' ? src : '';
}

function setCachedBrowserFaviconSrc(key, src, ttlMs) {
  if (!key) return;
  const safeSrc = typeof src === 'string' ? src : '';
  const ttl = (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) ? ttlMs : BROWSER_FAVICON_NEGATIVE_TTL_MS;

  browserFaviconCache.delete(key);
  browserFaviconCache.set(key, { src: safeSrc, expiresAt: Date.now() + ttl });

  while (browserFaviconCache.size > BROWSER_FAVICON_CACHE_MAX_SIZE) {
    const oldestKey = browserFaviconCache.keys().next().value;
    browserFaviconCache.delete(oldestKey);
  }
}

async function fetchBrowserFaviconDataUrl(pageUrl, options = {}) {
  const debug = !!(options && options.debug);
  let host = '';
  try {
    host = new URL(pageUrl).hostname || '';
  } catch (e) {
    host = '';
  }
  const timeoutMs = isLikelyPrivateHost(host) ? BROWSER_FAVICON_FETCH_TIMEOUT_PRIVATE_MS : BROWSER_FAVICON_FETCH_TIMEOUT_MS;
  let faviconUrl = '';
  try {
    if (chrome.favicon && typeof chrome.favicon.getFaviconUrl === 'function') {
      faviconUrl = chrome.favicon.getFaviconUrl(pageUrl);
    }
  } catch (error) {
    faviconUrl = '';
  }

  if (!faviconUrl) {
    if (debug) console.log('[Background][Favicon] getFaviconUrl empty', { pageUrl, host });
    return '';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(faviconUrl, { signal: controller.signal });
    if (!res || !res.ok) {
      if (debug) console.log('[Background][Favicon] fetch faviconUrl not ok', { pageUrl, host, faviconUrl, status: res && res.status });
      return '';
    }
    const contentType = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
    const buf = await res.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const mime = contentType ? String(contentType).split(';')[0].trim() : 'image/png';
    if (debug) console.log('[Background][Favicon] fetch ok', { pageUrl, host, bytes: buf && buf.byteLength, ms: Date.now() - startedAt });
    return 'data:' + (mime || 'image/png') + ';base64,' + base64;
  } catch (error) {
    if (debug) {
      console.log('[Background][Favicon] fetch error', {
        pageUrl,
        host,
        faviconUrl,
        ms: Date.now() - startedAt,
        aborted: controller.signal.aborted,
        error: (error && error.name) ? error.name : String(error)
      });
    }
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

async function loadFaviconsForResults(results) {
  if (!Array.isArray(results) || results.length === 0) return {};

  const domainSet = new Set();
  for (const item of results) {
    if (!item || typeof item.url !== 'string') continue;
    try {
      const host = new URL(item.url).hostname;
      const key = normalizeFaviconHost(host);
      if (key) domainSet.add(key);
    } catch (e) { /* skip invalid URLs */ }
  }

  if (domainSet.size === 0) return {};

  const domains = Array.from(domainSet);
  const keys = domains.map((d) => IDB_KEY_PREFIX_FAVICON + d);

  try {
    const result = await idbGetMany(keys);
    const favicons = {};
    const now = Date.now();
    for (const domain of domains) {
      const entry = result ? result[IDB_KEY_PREFIX_FAVICON + domain] : undefined;
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.src !== 'string' || !entry.src) continue;
      const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
      if (updatedAt > 0 && (now - updatedAt) > PERSISTED_FAVICON_TTL_MS) continue;
      favicons[domain] = entry;
    }
    return favicons;
  } catch (e) {
    return {};
  }
}

function buildErrorResponse(code, message) {
  return { success: false, error: { code, message } };
}

function sendErrorResponse(sendResponse, code, message) {
  sendResponse(buildErrorResponse(code, message));
}

function normalizeUnknownError(error) {
  return (error && error.message) ? error.message : String(error);
}

function isValidAction(action) {
  return typeof action === 'string' && MESSAGE_ACTION_VALUES.indexOf(action) >= 0;
}

function isValidSyncInterval(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

let _ensureInit = null;

/**
 * 注入 ensureInit 函数（避免循环导入）
 */
export function setEnsureInit(fn) {
  _ensureInit = fn;
}

/**
 * 处理扩展消息
 */
export function handleMessage(request, sender, sendResponse) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_REQUEST, 'Request must be an object');
    return false;
  }

  const action = request.action;
  if (!isValidAction(action)) {
    sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_ACTION, 'Unknown action');
    return false;
  }

  console.log("[Background] 收到消息:", action);

  // 需要初始化的异步 action，在 ensureInit 完成后再执行
  const initThen = (asyncFn) => {
    const run = _ensureInit ? _ensureInit().then(asyncFn) : asyncFn();
    run.catch((error) => {
      sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
    });
    return true;
  };

  switch (action) {
    case MESSAGE_ACTIONS.REFRESH_BOOKMARKS:
      return initThen(() =>
        refreshBookmarks()
          .then(sendResponse)
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );

    case MESSAGE_ACTIONS.UPDATE_SYNC_INTERVAL: {
      const interval = request.interval;
      if (!isValidSyncInterval(interval)) {
        sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_PARAMS, 'interval must be a non-negative number');
        return false;
      }

      return initThen(() =>
        setupAutoSync(interval)
          .then(() => {
            sendResponse({ success: true });
          })
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );
    }
      
    case MESSAGE_ACTIONS.GET_STATS:
      sendResponse({ success: true });
      return false;

    case MESSAGE_ACTIONS.TRACK_BOOKMARK_OPEN: {
      const url = String(request && request.url ? request.url : '').trim();

      return initThen(async () => {
        if (url) {
          try {
            await recordBookmarkOpen(url);
          } catch (e) {
            // best-effort only
          }
        }
        sendResponse({ success: true });
      });
    }

    case MESSAGE_ACTIONS.SEARCH_BOOKMARKS: {
      const query = String(request.query || '').trim().slice(0, 200);
      if (!query) {
        sendResponse({ success: true, results: [], favicons: {} });
        return false;
      }

      const searchLimit = (typeof request.limit === 'number' && request.limit > 0) ? Math.min(request.limit, 50) : 10;
      return initThen(() =>
        searchBookmarks(query, { limit: searchLimit })
          .then((resultsRaw) => {
            const results = Array.isArray(resultsRaw) ? resultsRaw : [];
            return loadFaviconsForResults(results).then((favicons) => {
              sendResponse({ success: true, results, favicons });
            });
          })
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );
    }

    case MESSAGE_ACTIONS.GET_WARMUP_DOMAINS: {
      const limitRaw = request && request.limit;
      const limit = (typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0) ? Math.floor(limitRaw) : 400;

      return initThen(() =>
        getWarmupDomainMap({ limit })
          .then((domainToPageUrl) => {
            sendResponse({ success: true, domainToPageUrl: (domainToPageUrl && typeof domainToPageUrl === 'object') ? domainToPageUrl : {} });
          })
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );
    }

    case MESSAGE_ACTIONS.GET_BROWSER_FAVICON: {
      const pageUrl = String((request && request.pageUrl) || '').trim();
      const debug = !!(request && request.debug);
      if (!pageUrl) {
        sendResponse({ success: true, src: '' });
        return false;
      }

      const key = getBrowserFaviconCacheKey(pageUrl);
      if (key) {
        const cached = getCachedBrowserFaviconSrc(key);
        if (cached !== undefined) {
          if (debug) console.log('[Background][Favicon] cache hit', { key, src: cached ? 'data' : '' });
          sendResponse({ success: true, src: cached });
          return false;
        }

        const inFlight = browserFaviconInFlight.get(key);
        if (inFlight) {
          if (debug) console.log('[Background][Favicon] inFlight reuse', { key });
          inFlight
            .then((src) => sendResponse({ success: true, src: (typeof src === 'string' ? src : '') }))
            .catch(() => sendResponse({ success: true, src: '' }));
          return true;
        }

        const promise = fetchBrowserFaviconDataUrl(pageUrl, { debug })
          .then((src) => {
            const safeSrc = typeof src === 'string' ? src : '';
            const ttl = safeSrc
              ? BROWSER_FAVICON_POSITIVE_TTL_MS
              : (isLikelyPrivateHost(key) ? BROWSER_FAVICON_NEGATIVE_TTL_PRIVATE_MS : BROWSER_FAVICON_NEGATIVE_TTL_MS);
            setCachedBrowserFaviconSrc(key, safeSrc, ttl);
            return safeSrc;
          })
          .finally(() => {
            browserFaviconInFlight.delete(key);
          });

        browserFaviconInFlight.set(key, promise);

        promise
          .then((src) => sendResponse({ success: true, src: (typeof src === 'string' ? src : '') }))
          .catch(() => sendResponse({ success: true, src: '' }));
        return true;
      }

      sendResponse({ success: true, src: '' });
      return false;
    }

    case MESSAGE_ACTIONS.GET_BROWSER_FAVICONS_BATCH: {
      const itemsRaw = request && request.items;
      const debug = !!(request && request.debug);
      const items = Array.isArray(itemsRaw)
        ? itemsRaw.filter((it) => it && typeof it.domain === 'string' && typeof it.pageUrl === 'string').slice(0, 50)
        : [];

      if (items.length === 0) {
        sendResponse({ success: true, favicons: {} });
        return false;
      }

      const promises = items.map((it) => {
        const domain = it.domain.trim();
        const pageUrl = it.pageUrl.trim();
        if (!pageUrl) return Promise.resolve({ domain, src: '' });

        const key = getBrowserFaviconCacheKey(pageUrl);
        if (!key) return Promise.resolve({ domain, src: '' });

        const cached = getCachedBrowserFaviconSrc(key);
        if (cached !== undefined) return Promise.resolve({ domain, src: cached });

        const inFlight = browserFaviconInFlight.get(key);
        if (inFlight) return inFlight.then((src) => ({ domain, src: typeof src === 'string' ? src : '' })).catch(() => ({ domain, src: '' }));

        const promise = fetchBrowserFaviconDataUrl(pageUrl, { debug })
          .then((src) => {
            const safeSrc = typeof src === 'string' ? src : '';
            const ttl = safeSrc
              ? BROWSER_FAVICON_POSITIVE_TTL_MS
              : (isLikelyPrivateHost(key) ? BROWSER_FAVICON_NEGATIVE_TTL_PRIVATE_MS : BROWSER_FAVICON_NEGATIVE_TTL_MS);
            setCachedBrowserFaviconSrc(key, safeSrc, ttl);
            return safeSrc;
          })
          .finally(() => { browserFaviconInFlight.delete(key); });

        browserFaviconInFlight.set(key, promise);

        return promise.then((src) => ({ domain, src: typeof src === 'string' ? src : '' })).catch(() => ({ domain, src: '' }));
      });

      Promise.all(promises)
        .then((results) => {
          const favicons = {};
          for (const r of results) {
            if (r.src) favicons[r.domain] = r.src;
          }
          sendResponse({ success: true, favicons });
        })
        .catch(() => sendResponse({ success: true, favicons: {} }));

      return true;
    }

    case MESSAGE_ACTIONS.GET_FAVICONS: {
      const domainsRaw = request && request.domains;
      const domains = Array.isArray(domainsRaw)
        ? Array.from(new Set(domainsRaw.map((d) => (typeof d === 'string' ? d.trim().slice(0, 253) : '')).filter(Boolean))).slice(0, 5000)
        : [];

      if (domains.length === 0) {
        sendResponse({ success: true, favicons: {} });
        return false;
      }

      const keys = domains.map((domain) => IDB_KEY_PREFIX_FAVICON + domain);

      idbGetMany(keys)
        .then((result) => {
          const favicons = {};
          const now = Date.now();
          for (const domain of domains) {
            const key = IDB_KEY_PREFIX_FAVICON + domain;
            const entry = result ? result[key] : undefined;
            if (!entry || typeof entry !== 'object') continue;
            if (typeof entry.src !== 'string' || !entry.src) continue;
            // TTL check: skip entries older than 30 days
            const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
            if (updatedAt > 0 && (now - updatedAt) > PERSISTED_FAVICON_TTL_MS) continue;
            favicons[domain] = entry;
          }
          sendResponse({ success: true, favicons });
        })
        .catch((error) => {
          sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
        });

      return true;
    }

    case MESSAGE_ACTIONS.SET_FAVICONS: {
      const entriesRaw = request && request.entries;
      const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
      const now = Date.now();

      const FAVICON_SRC_MAX_LEN = 102400; // 100KB
      const deduped = new Map();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const domain = typeof entry.domain === 'string' ? entry.domain.trim().slice(0, 253) : '';
        const src = typeof entry.src === 'string' ? entry.src.trim() : '';
        if (!domain || !src || src.length > FAVICON_SRC_MAX_LEN) continue;
        if (!src.startsWith('https://') && !src.startsWith('http://')) continue;
        const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now;
        deduped.set(domain, { src, updatedAt });
      }

      if (deduped.size === 0) {
        sendResponse({ success: true, count: 0 });
        return false;
      }

      const items = [];
      for (const [domain, value] of deduped) {
        items.push({ key: IDB_KEY_PREFIX_FAVICON + domain, value });
      }

      idbSetMany(items)
        .then(() => {
          sendResponse({ success: true, count: items.length });
        })
        .catch((error) => {
          sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
        });

      return true;
    }

    case MESSAGE_ACTIONS.CLEAR_HISTORY:
      return initThen(() =>
        clearHistory()
          .then(sendResponse)
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );

    default:
      sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_ACTION, 'Unknown action');
      return false;
  }
}
