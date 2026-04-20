import { getWarmupDomainMap, refreshBookmarks, searchBookmarks, clearHistory, recordBookmarkOpen, getRecentOpenedBookmarks } from './background-data.js';
import { getMigrationStatus } from './migration-service.js';
import { setupAutoSync } from './background-sync.js';
import { MESSAGE_ACTIONS, MESSAGE_ACTION_VALUES, MESSAGE_ERROR_CODES, FAVICON_CONFIG } from './constants.js';
import { idbDeleteByPrefix, idbGetMany, idbSetMany } from './idb-service.js';
import { buildFaviconLookupKeys, buildFaviconServiceKey, isLikelyPrivateHost } from './utils.js';
import { setStorageOrThrow, STORAGE_KEYS } from './storage-service.js';
import { ensureInit } from './lifecycle.js';

const IDB_KEY_PREFIX_FAVICON = 'favicon:';

// Browser favicon cache (derived from chrome.favicon.getFaviconUrl).
// We keep a small in-memory LRU so repeated searches across tabs/pages don't re-fetch + re-base64 the same icon.
// Entries stay in memory until evicted by LRU or the service worker restarts.
const BROWSER_FAVICON_CACHE_MAX_SIZE = FAVICON_CONFIG.BROWSER_CACHE_MAX_SIZE;
const BROWSER_FAVICON_FETCH_TIMEOUT_MS = FAVICON_CONFIG.FETCH_TIMEOUT_MS;
const BROWSER_FAVICON_FETCH_TIMEOUT_PRIVATE_MS = FAVICON_CONFIG.FETCH_TIMEOUT_PRIVATE_MS;
const PERSISTED_FAVICON_FAILURE_TTL_MS = FAVICON_CONFIG.FAILURE_TTL_MS;
const PERSISTED_FAVICON_FAILURE_TTL_PRIVATE_MS = FAVICON_CONFIG.FAILURE_TTL_PRIVATE_MS;
const PERSISTED_FAVICON_FAILURE_TTL_MAX_MS = FAVICON_CONFIG.FAILURE_TTL_MAX_MS;

const browserFaviconCache = new Map(); // key -> { src, isPlaceholder }
const browserFaviconInFlight = new Map(); // key -> Promise<{ src, isPlaceholder }>

function decodeSvgDataUrlContent(src) {
  const safeSrc = typeof src === 'string' ? src.trim() : '';
  if (!safeSrc) return '';
  const match = safeSrc.match(/^data:image\/svg\+xml(?:;charset=[^;,]+)?(?:;base64)?,(.*)$/i);
  if (!match) return '';
  const payload = match[1] || '';
  try {
    if (/;base64,/i.test(safeSrc.slice(0, safeSrc.indexOf(',') + 1))) {
      return atob(payload);
    }
    return decodeURIComponent(payload);
  } catch (error) {
    return payload;
  }
}

function getBrowserFaviconCacheKey(pageUrl) {
  return buildFaviconServiceKey(pageUrl);
}

function getCachedBrowserFaviconSrc(key) {
  if (!key) return undefined;
  const entry = browserFaviconCache.get(key);
  if (!entry || typeof entry !== 'object') return undefined;

  // LRU bump
  browserFaviconCache.delete(key);
  browserFaviconCache.set(key, entry);

  return {
    src: typeof entry.src === 'string' ? entry.src : '',
    isPlaceholder: !!entry.isPlaceholder
  };
}

function setCachedBrowserFaviconSrc(key, src, isPlaceholder = false) {
  if (!key) return;
  const safeSrc = typeof src === 'string' ? src : '';

  if (!safeSrc) {
    browserFaviconCache.delete(key);
    return;
  }

  browserFaviconCache.delete(key);
  browserFaviconCache.set(key, { src: safeSrc, isPlaceholder: !!isPlaceholder });

  while (browserFaviconCache.size > BROWSER_FAVICON_CACHE_MAX_SIZE) {
    const oldestKey = browserFaviconCache.keys().next().value;
    browserFaviconCache.delete(oldestKey);
  }
}

function getPersistedFaviconFailureTtlMs(domain) {
  return isLikelyPrivateHost(domain) ? PERSISTED_FAVICON_FAILURE_TTL_PRIVATE_MS : PERSISTED_FAVICON_FAILURE_TTL_MS;
}

function clampRetryAt(retryAt, domain) {
  const now = Date.now();
  const fallback = now + getPersistedFaviconFailureTtlMs(domain);
  const raw = (typeof retryAt === 'number' && Number.isFinite(retryAt)) ? retryAt : fallback;
  const min = now;
  const max = now + PERSISTED_FAVICON_FAILURE_TTL_MAX_MS;
  if (raw < min) return fallback;
  if (raw > max) return max;
  return raw;
}

function isTrustedPersistedFaviconSrc(src) {
  const safe = typeof src === 'string' ? src.trim() : '';
  return safe.startsWith('https://') || safe.startsWith('http://');
}

function buildLegacyPersistedFaviconMigration(entry, domain) {
  if (!entry || typeof entry !== 'object') return null;
  const src = typeof entry.src === 'string' ? entry.src.trim() : '';
  if (!src) return null;
  const hasExplicitState = typeof entry.state === 'string' && !!entry.state;
  if (hasExplicitState) return null;

  const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : Date.now();

  if (isTrustedPersistedFaviconSrc(src)) {
    return {
      state: 'success',
      src,
      updatedAt
    };
  }

  return {
    state: 'failure',
    retryAt: Date.now(),
    updatedAt: Date.now()
  };
}

function getPersistedFaviconEntryState(entry, domain) {
  if (!entry || typeof entry !== 'object') return { kind: 'missing' };
  const src = typeof entry.src === 'string' ? entry.src.trim() : '';
  const legacyMigration = buildLegacyPersistedFaviconMigration(entry, domain);
  if (src) {
    if (legacyMigration && legacyMigration.state === 'failure') {
      return {
        kind: 'staleFailure',
        migration: legacyMigration
      };
    }
    return {
      kind: 'success',
      entry: {
        state: 'success',
        src,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
      },
      migration: legacyMigration
    };
  }

  const state = typeof entry.state === 'string' ? entry.state : '';
  const retryAt = typeof entry.retryAt === 'number' ? entry.retryAt : 0;
  if (state === 'failure' && retryAt > Date.now()) {
    return {
      kind: 'failure',
      entry: {
        state: 'failure',
        retryAt,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
      }
    };
  }

  return { kind: 'staleFailure' };
}

function isPersistedFaviconFailureActive(entry) {
  return getPersistedFaviconEntryState(entry).kind === 'failure';
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
    const src = 'data:' + (mime || 'image/png') + ';base64,' + base64;
    if (debug) console.log('[Background][Favicon] fetch ok', { pageUrl, host, bytes: buf && buf.byteLength, ms: Date.now() - startedAt });
    return src;
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

function isBrowserFaviconPlaceholder(src, pageUrl) {
  const safeSrc = typeof src === 'string' ? src.trim() : '';
  if (!safeSrc) return false;
  const lower = safeSrc.toLowerCase();
  if (lower.indexOf('data:image/svg+xml') !== 0) return false;

  const decodedSvg = decodeSvgDataUrlContent(safeSrc).toLowerCase();
  const placeholderByColor = lower.indexOf('%23999') !== -1 || lower.indexOf("fill='%23999'") !== -1 || lower.indexOf('fill="%23999"') !== -1;
  const hasTextTag = decodedSvg.indexOf('<text') !== -1;
  const hasMonogramText = decodedSvg.indexOf('text-anchor') !== -1 || decodedSvg.indexOf('font-size') !== -1 || decodedSvg.indexOf('dominant-baseline') !== -1;
  const hasShapeAndText = (decodedSvg.indexOf('<circle') !== -1 || decodedSvg.indexOf('<rect') !== -1) && hasTextTag;
  const host = getBrowserFaviconCacheKey(pageUrl);
  const privateHost = isLikelyPrivateHost(host);

  if (placeholderByColor) return true;
  if (privateHost && hasTextTag && (hasMonogramText || hasShapeAndText)) return true;
  return false;
}

function buildBrowserFaviconResult(pageUrl, src, debug) {
  const safeSrc = typeof src === 'string' ? src : '';
  const host = getBrowserFaviconCacheKey(pageUrl);
  const isPlaceholder = isBrowserFaviconPlaceholder(safeSrc, pageUrl);
  if (debug) {
    console.log('[Background][Favicon] browser result', {
      host,
      hasSrc: !!safeSrc,
      isPlaceholder
    });
  }
  return {
    src: safeSrc,
    isPlaceholder,
    source: 'browser-cache',
    host,
    debug: !!debug
  };
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

  const lookupKeysByResult = new Map();
  const lookupSet = new Set();
  for (const item of results) {
    if (!item || typeof item.url !== 'string') continue;
    try {
      const key = buildFaviconServiceKey(item.url);
      if (!key) continue;
      const candidates = buildFaviconLookupKeys(item.url);
      lookupKeysByResult.set(key, candidates);
      for (const candidate of candidates) lookupSet.add(candidate);
    } catch (e) { /* skip invalid URLs */ }
  }

  if (lookupSet.size === 0) return {};

  const keys = Array.from(lookupSet).map((d) => IDB_KEY_PREFIX_FAVICON + d);

  try {
    const result = await idbGetMany(keys);
    const favicons = {};
    for (const [domain, candidates] of lookupKeysByResult.entries()) {
      for (const candidate of candidates) {
        const entry = result ? result[IDB_KEY_PREFIX_FAVICON + candidate] : undefined;
        const state = getPersistedFaviconEntryState(entry, candidate);
        if (state.kind !== 'success') continue;
        favicons[domain] = state.entry;
        break;
      }
    }
    return favicons;
  } catch (e) {
    return {};
  }
}

function buildOkResponse(payload = {}) {
  return { success: true, ...(payload && typeof payload === 'object' ? payload : {}) };
}

function buildErrorResponse(code, message) {
  return { success: false, error: { code, message } };
}

function sendOkResponse(sendResponse, payload) {
  sendResponse(buildOkResponse(payload));
}

function sendErrorResponse(sendResponse, code, message) {
  sendResponse(buildErrorResponse(code, message));
}

function normalizeUnknownError(error) {
  return (error && error.message) ? error.message : String(error);
}

async function broadcastFaviconCacheCleared() {
  if (!chrome.tabs || typeof chrome.tabs.query !== 'function' || typeof chrome.tabs.sendMessage !== 'function') {
    return 0;
  }

  const tabs = await chrome.tabs.query({});
  let delivered = 0;

  await Promise.all((tabs || []).map(async (tab) => {
    const tabId = tab && typeof tab.id === 'number' ? tab.id : -1;
    if (tabId < 0) return;
    try {
      await chrome.tabs.sendMessage(tabId, { action: MESSAGE_ACTIONS.CLEAR_FAVICON_CACHE });
      delivered++;
    } catch (error) {
      // Ignore tabs without this content script.
    }
  }));

  return delivered;
}

async function clearFaviconCache() {
  browserFaviconCache.clear();
  browserFaviconInFlight.clear();

  const deletedCount = await idbDeleteByPrefix(IDB_KEY_PREFIX_FAVICON);
  broadcastFaviconCacheCleared().catch(() => 0);

  return {
    success: true,
    deletedCount
  };
}

function isValidAction(action) {
  return typeof action === 'string' && MESSAGE_ACTION_VALUES.indexOf(action) >= 0;
}

function isValidSyncInterval(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
    const run = ensureInit().then(asyncFn);
    run.catch((error) => {
      sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
    });
    return true;
  };

  switch (action) {
    case MESSAGE_ACTIONS.REFRESH_BOOKMARKS:
      return initThen(() =>
        refreshBookmarks()
          .then((result) => sendOkResponse(sendResponse, result))
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );

    case MESSAGE_ACTIONS.SET_SYNC_INTERVAL: {
      const interval = request.interval;
      if (!isValidSyncInterval(interval)) {
        sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_PARAMS, 'interval must be a non-negative number');
        return false;
      }

      return initThen(async () => {
        await setStorageOrThrow({ [STORAGE_KEYS.SYNC_INTERVAL]: interval });
        await setupAutoSync(interval);
        sendOkResponse(sendResponse, { interval });
      });
    }

    case MESSAGE_ACTIONS.GET_MIGRATION_STATUS:
      getMigrationStatus()
        .then((status) => sendOkResponse(sendResponse, status))
        .catch((error) => {
          sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
        });
      return true;

    case MESSAGE_ACTIONS.GET_POPUP_STATUS:
      return initThen(async () => {
        try {
          const result = await chrome.storage.local.get([
            STORAGE_KEYS.BOOKMARK_COUNT,
            STORAGE_KEYS.LAST_SYNC_TIME,
            STORAGE_KEYS.SYNC_INTERVAL
          ]);
          const alarms = await chrome.alarms.getAll();
          const syncAlarm = (alarms || []).find((a) => a && a.name === 'syncBookmarks');
          sendOkResponse(sendResponse, {
            bookmarkCount: typeof result[STORAGE_KEYS.BOOKMARK_COUNT] === 'number' ? result[STORAGE_KEYS.BOOKMARK_COUNT] : 0,
            lastSyncTime: typeof result[STORAGE_KEYS.LAST_SYNC_TIME] === 'number' ? result[STORAGE_KEYS.LAST_SYNC_TIME] : null,
            syncInterval: typeof result[STORAGE_KEYS.SYNC_INTERVAL] === 'number' ? result[STORAGE_KEYS.SYNC_INTERVAL] : 30,
            nextSyncScheduledTime: syncAlarm && syncAlarm.scheduledTime ? syncAlarm.scheduledTime : null
          });
        } catch (error) {
          sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
        }
      });

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
        sendOkResponse(sendResponse);
      });
    }

    case MESSAGE_ACTIONS.SEARCH_BOOKMARKS: {
      const query = String(request.query || '').trim().slice(0, 200);
      if (!query) {
        sendOkResponse(sendResponse, { results: [], favicons: {} });
        return false;
      }

      const searchLimit = (typeof request.limit === 'number' && request.limit > 0) ? Math.min(request.limit, 50) : 10;
      return initThen(() =>
        searchBookmarks(query, { limit: searchLimit })
          .then((resultsRaw) => {
            const results = Array.isArray(resultsRaw) ? resultsRaw : [];
            return loadFaviconsForResults(results).then((favicons) => {
              sendOkResponse(sendResponse, { results, favicons });
            });
          })
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );
    }

    case MESSAGE_ACTIONS.GET_RECENT_OPENED: {
      const limitRaw = request && request.limit;
      const limit = (typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0)
        ? Math.floor(limitRaw)
        : 10;

      return initThen(() =>
        getRecentOpenedBookmarks({ limit })
          .then((resultsRaw) => {
            const items = Array.isArray(resultsRaw) ? resultsRaw : [];
            return loadFaviconsForResults(items).then((favicons) => {
              sendOkResponse(sendResponse, { items, favicons });
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
            sendOkResponse(sendResponse, { domainToPageUrl: (domainToPageUrl && typeof domainToPageUrl === 'object') ? domainToPageUrl : {} });
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
        sendOkResponse(sendResponse, { src: '', isPlaceholder: false });
        return false;
      }

      const key = getBrowserFaviconCacheKey(pageUrl);
      if (key) {
        const cached = getCachedBrowserFaviconSrc(key);
        if (cached !== undefined) {
          if (debug) console.log('[Background][Favicon] cache hit', { key, hasSrc: !!cached.src, isPlaceholder: !!cached.isPlaceholder });
          sendOkResponse(sendResponse, { ...buildBrowserFaviconResult(pageUrl, cached.src, debug), isPlaceholder: !!cached.isPlaceholder });
          return false;
        }

        const inFlight = browserFaviconInFlight.get(key);
        if (inFlight) {
          if (debug) console.log('[Background][Favicon] inFlight reuse', { key });
          inFlight
            .then((result) => sendOkResponse(sendResponse, { ...buildBrowserFaviconResult(pageUrl, result && result.src, debug), isPlaceholder: !!(result && result.isPlaceholder) }))
            .catch(() => sendOkResponse(sendResponse, buildBrowserFaviconResult(pageUrl, '', debug)));
          return true;
        }

        const promise = fetchBrowserFaviconDataUrl(pageUrl, { debug })
          .then((src) => {
            const result = buildBrowserFaviconResult(pageUrl, src, debug);
            setCachedBrowserFaviconSrc(key, result.src, result.isPlaceholder);
            return result;
          })
          .finally(() => {
            browserFaviconInFlight.delete(key);
          });

        browserFaviconInFlight.set(key, promise);

        promise
          .then((result) => sendOkResponse(sendResponse, { ...buildBrowserFaviconResult(pageUrl, result && result.src, debug), isPlaceholder: !!(result && result.isPlaceholder) }))
          .catch(() => sendOkResponse(sendResponse, buildBrowserFaviconResult(pageUrl, '', debug)));
        return true;
      }

      sendOkResponse(sendResponse, { src: '', isPlaceholder: false });
      return false;
    }

    case MESSAGE_ACTIONS.GET_BROWSER_FAVICONS_BATCH: {
      const itemsRaw = request && request.items;
      const debug = !!(request && request.debug);
      const items = Array.isArray(itemsRaw)
        ? itemsRaw.filter((it) => it && typeof it.domain === 'string' && typeof it.pageUrl === 'string').slice(0, 50)
        : [];

      if (items.length === 0) {
        sendOkResponse(sendResponse, { favicons: {} });
        return false;
      }

      const promises = items.map((it) => {
        const domain = it.domain.trim();
        const pageUrl = it.pageUrl.trim();
        if (!pageUrl) return Promise.resolve({ domain, src: '', isPlaceholder: false });

        const key = getBrowserFaviconCacheKey(pageUrl);
        if (!key) return Promise.resolve({ domain, src: '', isPlaceholder: false });

        const cached = getCachedBrowserFaviconSrc(key);
        if (cached !== undefined) return Promise.resolve({ domain, src: cached.src, isPlaceholder: !!cached.isPlaceholder });

        const inFlight = browserFaviconInFlight.get(key);
        if (inFlight) {
          return inFlight
            .then((result) => ({ domain, src: (result && typeof result.src === 'string') ? result.src : '', isPlaceholder: !!(result && result.isPlaceholder) }))
            .catch(() => ({ domain, src: '', isPlaceholder: false }));
        }

        const promise = fetchBrowserFaviconDataUrl(pageUrl, { debug })
          .then((src) => {
            const result = buildBrowserFaviconResult(pageUrl, src, debug);
            setCachedBrowserFaviconSrc(key, result.src, result.isPlaceholder);
            return result;
          })
          .finally(() => { browserFaviconInFlight.delete(key); });

        browserFaviconInFlight.set(key, promise);

        return promise
          .then((result) => ({ domain, src: (result && typeof result.src === 'string') ? result.src : '', isPlaceholder: !!(result && result.isPlaceholder) }))
          .catch(() => ({ domain, src: '', isPlaceholder: false }));
      });

      Promise.all(promises)
        .then((results) => {
          const favicons = {};
          for (const r of results) {
            favicons[r.domain] = {
              src: r.src,
              isPlaceholder: !!r.isPlaceholder
            };
          }
          sendOkResponse(sendResponse, { favicons });
        })
        .catch(() => sendOkResponse(sendResponse, { favicons: {} }));

      return true;
    }

    case MESSAGE_ACTIONS.GET_FAVICONS: {
      const domainsRaw = request && request.domains;
      const domains = Array.isArray(domainsRaw)
        ? Array.from(new Set(domainsRaw.map((d) => (typeof d === 'string' ? d.trim().slice(0, 253) : '')).filter(Boolean))).slice(0, 5000)
        : [];

      if (domains.length === 0) {
        sendOkResponse(sendResponse, { favicons: {} });
        return false;
      }

      const keys = domains.map((domain) => IDB_KEY_PREFIX_FAVICON + domain);

      idbGetMany(keys)
        .then((result) => {
          const favicons = {};
          const migrations = [];
          for (const domain of domains) {
            const key = IDB_KEY_PREFIX_FAVICON + domain;
            const entry = result ? result[key] : undefined;
            const state = getPersistedFaviconEntryState(entry, domain);
            if (state.migration) {
              migrations.push({ key, value: state.migration });
            }
            if (state.kind === 'success' || state.kind === 'failure') {
              favicons[domain] = state.entry;
            }
          }

          const finish = () => sendOkResponse(sendResponse, { favicons });
          if (migrations.length === 0) {
            finish();
            return;
          }

          idbSetMany(migrations)
            .then(finish)
            .catch(() => finish());
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
        if (!domain) continue;

        const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now;
        const src = typeof entry.src === 'string' ? entry.src.trim() : '';
        if (src) {
          if (src.length > FAVICON_SRC_MAX_LEN) continue;
          if (!src.startsWith('https://') && !src.startsWith('http://')) continue;
          deduped.set(domain, { state: 'success', src, updatedAt });
          continue;
        }

        const state = typeof entry.state === 'string' ? entry.state : '';
        if (state !== 'failure') continue;
        const retryAt = clampRetryAt(entry.retryAt, domain);
        if (deduped.get(domain) && deduped.get(domain).state === 'success') continue;
        deduped.set(domain, { state: 'failure', retryAt, updatedAt });
      }

      if (deduped.size === 0) {
        sendOkResponse(sendResponse, { count: 0 });
        return false;
      }

      const keysToRead = [];
      for (const domain of deduped.keys()) {
        keysToRead.push(IDB_KEY_PREFIX_FAVICON + domain);
      }

      idbGetMany(keysToRead)
        .then((existing) => {
          const items = [];
          for (const [domain, value] of deduped) {
            const key = IDB_KEY_PREFIX_FAVICON + domain;
            const current = existing ? existing[key] : undefined;
            const currentState = getPersistedFaviconEntryState(current, domain);
            // Keep existing success sticky even when content later reports retryable failures
            // (including render-time broken-image cases that reuse the same failure schema).
            if (value.state === 'failure' && currentState.kind === 'success') continue;
            items.push({ key, value });
          }

          if (items.length === 0) {
            sendOkResponse(sendResponse, { count: 0 });
            return;
          }

          idbSetMany(items)
            .then(() => {
              sendOkResponse(sendResponse, { count: items.length });
            })
            .catch((error) => {
              sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
            });
        })
        .catch((error) => {
          sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
        });

      return true;
    }

    case MESSAGE_ACTIONS.CLEAR_FAVICON_CACHE:
      return initThen(() =>
        clearFaviconCache()
          .then((result) => sendOkResponse(sendResponse, result))
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );

    case MESSAGE_ACTIONS.CLEAR_HISTORY:
      return initThen(() =>
        clearHistory()
          .then((result) => sendOkResponse(sendResponse, result))
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );

    case MESSAGE_ACTIONS.DELETE_BOOKMARK: {
      const id = String((request && request.id) || '').trim();
      if (!id) {
        sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_PARAMS, 'bookmark id required');
        return false;
      }
      return initThen(async () => {
        try {
          await chrome.bookmarks.remove(id);
          sendOkResponse(sendResponse, { id });
        } catch (error) {
          sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
        }
      });
    }

    case MESSAGE_ACTIONS.OPEN_BOOKMARK_IN_WINDOW: {
      const url = String((request && request.url) || '').trim();
      if (!url) {
        sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_PARAMS, 'url required');
        return false;
      }
      return initThen(async () => {
        try {
          await chrome.windows.create({ url, focused: true });
          sendOkResponse(sendResponse, { url });
        } catch (error) {
          sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
        }
      });
    }

    case MESSAGE_ACTIONS.REVEAL_BOOKMARK: {
      const id = String((request && request.id) || '').trim();
      return initThen(async () => {
        try {
          const url = id ? ('chrome://bookmarks/?id=' + encodeURIComponent(id)) : 'chrome://bookmarks/';
          await chrome.tabs.create({ url });
          sendOkResponse(sendResponse, { id });
        } catch (error) {
          sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
        }
      });
    }

    default:
      sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_ACTION, 'Unknown action');
      return false;
  }
}
