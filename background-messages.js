import { getWarmupDomainMap, refreshBookmarks, searchBookmarks, clearHistory, recordBookmarkOpen, getRecentOpenedBookmarks, findDuplicateBookmarks } from './background-data.js';
import { getMigrationStatus } from './migration-service.js';
import { setupAutoSync } from './background-sync.js';
import { MESSAGE_ACTIONS, MESSAGE_ACTION_VALUES, MESSAGE_ERROR_CODES, FAVICON_CONFIG } from './constants.js';
import { idbDeleteByPrefix, idbGetMany, idbSetMany } from './idb-service.js';
import { buildFaviconLookupKeys, buildFaviconServiceKey, isLikelyPrivateHost } from './utils.js';
import { setStorageOrThrow, STORAGE_KEYS } from './storage-service.js';
import { ensureInit } from './lifecycle.js';
import { createLogger } from './logger.js';

const log = createLogger('Messages');

const IDB_KEY_PREFIX_FAVICON = 'favicon:';

const PERSISTED_FAVICON_FAILURE_TTL_MS = FAVICON_CONFIG.FAILURE_TTL_MS;
const PERSISTED_FAVICON_FAILURE_TTL_PRIVATE_MS = FAVICON_CONFIG.FAILURE_TTL_PRIVATE_MS;
const PERSISTED_FAVICON_FAILURE_TTL_MAX_MS = FAVICON_CONFIG.FAILURE_TTL_MAX_MS;

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

function isTrustedPersistedPageUrl(pageUrl) {
  const safe = typeof pageUrl === 'string' ? pageUrl.trim() : '';
  return safe.startsWith('https://') || safe.startsWith('http://');
}

/**
 * 解析 IDB favicon 条目，统一返回 success / failure / missing / staleFailure 语义。
 * 新格式：{ state: 'success', pageUrl, updatedAt }
 * 旧格式（兼容）：{ src: 'data:image/...' 或 'https://...' , updatedAt }
 * 失败：{ state: 'failure', retryAt, updatedAt }
 */
function getPersistedFaviconEntryState(entry, domain) {
  if (!entry || typeof entry !== 'object') return { kind: 'missing' };

  // 新格式优先：pageUrl 字段
  const pageUrl = typeof entry.pageUrl === 'string' ? entry.pageUrl.trim() : '';
  if (pageUrl && isTrustedPersistedPageUrl(pageUrl)) {
    return {
      kind: 'success',
      entry: {
        state: 'success',
        pageUrl,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
      }
    };
  }

  // 旧格式：src 字段（可能是 base64 data URL，或曾经的第三方 favicon 服务 URL 如 DDG/Google/Faviconkit）
  const src = typeof entry.src === 'string' ? entry.src.trim() : '';
  if (src) {
    const explicitState = typeof entry.state === 'string' ? entry.state : '';
    if (explicitState === 'failure') {
      return { kind: 'staleFailure' };
    }
    // 旧 src 若是 http(s) URL，几乎都是历史上从 DDG/Google 第三方 favicon 服务抓来的图标 URL
    // （不是书签页面本身的 pageUrl）。v2.x 把它误当 pageUrl 喂给 _favicon，会拿到
    // DDG/Google 自身站的图标，不是用户书签目标站的。这里统一作为 staleFailure，
    // 让 content 用书签 URL 重新通过 _favicon 抓取。
    if (isTrustedPersistedPageUrl(src)) {
      return { kind: 'staleFailure' };
    }
    // data: URL（base64 PNG/SVG）直接作为 src 返回，content 仍可显示
    return {
      kind: 'success',
      entry: {
        state: 'success',
        src,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
      }
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
  // browserFaviconCache 已废弃（v2.x），只清 IDB
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

  log.debug('收到消息:', action);

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

    // GET_BROWSER_FAVICON / GET_BROWSER_FAVICONS_BATCH 已废弃（v2.x）：
    // content script 直接用 chrome-extension://_favicon/?pageUrl= 构造 URL，
    // 不需要 background 在 fetch + base64 中转。保留 action 常量只为老版本 content 兼容。

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

      const deduped = new Map();
      const forceOverride = new Set(); // 允许覆盖已有 success 的 domain（用于"_favicon 返回默认占位"场景）
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const domain = typeof entry.domain === 'string' ? entry.domain.trim().slice(0, 253) : '';
        if (!domain) continue;

        const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now;
        // 新格式优先：pageUrl（~100 bytes），而不是 base64 data URL
        const pageUrl = typeof entry.pageUrl === 'string' ? entry.pageUrl.trim() : '';
        if (pageUrl) {
          if (!pageUrl.startsWith('https://') && !pageUrl.startsWith('http://')) continue;
          if (pageUrl.length > 2048) continue;
          deduped.set(domain, { state: 'success', pageUrl, updatedAt });
          continue;
        }
        // 兼容旧调用：只传 src（http/https URL，非 data:）仍当作 pageUrl 处理
        const src = typeof entry.src === 'string' ? entry.src.trim() : '';
        if (src && (src.startsWith('https://') || src.startsWith('http://')) && src.length <= 2048) {
          deduped.set(domain, { state: 'success', pageUrl: src, updatedAt });
          continue;
        }

        const state = typeof entry.state === 'string' ? entry.state : '';
        if (state !== 'failure') continue;
        const retryAt = clampRetryAt(entry.retryAt, domain);
        if (deduped.get(domain) && deduped.get(domain).state === 'success') continue;
        if (entry.force === true) forceOverride.add(domain);
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
            // (including render-time broken-image cases that reuse the same failure schema)。
            // 例外：force=true 表示"持久化的 pageUrl 本身就有问题"（如 _favicon 返回默认占位），必须覆盖。
            if (value.state === 'failure' && currentState.kind === 'success' && !forceOverride.has(domain)) continue;
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

    case MESSAGE_ACTIONS.DELETE_BOOKMARKS_BATCH: {
      const idsRaw = request && request.ids;
      const ids = Array.isArray(idsRaw)
        ? idsRaw.map((i) => String(i || '').trim()).filter(Boolean)
        : [];
      if (ids.length === 0) {
        sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_PARAMS, 'ids required');
        return false;
      }
      return initThen(async () => {
        const failed = [];
        let removed = 0;
        for (const id of ids) {
          try {
            await chrome.bookmarks.remove(id);
            removed++;
          } catch (e) {
            failed.push({ id, error: e && e.message ? e.message : String(e) });
          }
        }
        sendOkResponse(sendResponse, { removed, failed });
      });
    }

    case MESSAGE_ACTIONS.FIND_DUPLICATE_BOOKMARKS:
      return initThen(() =>
        findDuplicateBookmarks()
          .then((groups) => sendOkResponse(sendResponse, { groups: Array.isArray(groups) ? groups : [] }))
          .catch((error) => {
            sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INTERNAL_ERROR, normalizeUnknownError(error));
          })
      );

    case MESSAGE_ACTIONS.PROBE_URL_REACHABILITY: {
      // 在 service worker 里执行 HEAD 探测：
      // 1) SW fetch 响应不会触发 Link: rel=modulepreload 的 script 预加载，
      //    从根本上避免扩展页因外站响应头带 modulepreload 而触发 script-src CSP 拦截
      // 2) 集中处理 timeout / AbortController
      const url = typeof request.url === 'string' ? request.url.trim() : '';
      const timeoutMs = (typeof request.timeoutMs === 'number' && request.timeoutMs > 0)
        ? Math.min(request.timeoutMs, 30000)
        : 8000;
      if (!url || !/^https?:\/\//i.test(url)) {
        sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_PARAMS, 'http(s) url required');
        return false;
      }
      (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: ctrl.signal,
            credentials: 'omit',
            cache: 'no-store'
          });
          sendOkResponse(sendResponse, { ok: !!res.ok, status: Number(res.status) || 0 });
        } catch (e) {
          const msg = e && e.name === 'AbortError' ? 'timeout' : (e && e.message ? e.message : String(e));
          sendOkResponse(sendResponse, { ok: false, status: 0, error: msg });
        } finally {
          clearTimeout(timer);
        }
      })();
      return true;
    }

    case MESSAGE_ACTIONS.TOGGLE_CURRENT_BOOKMARK: {
      const url = String((request && request.url) || '').trim();
      const title = String((request && request.title) || '').trim();
      if (!url || !(/^https?:\/\//i.test(url))) {
        sendErrorResponse(sendResponse, MESSAGE_ERROR_CODES.INVALID_PARAMS, 'only http(s) URLs are bookmarkable');
        return false;
      }
      return initThen(async () => {
        try {
          const existing = await chrome.bookmarks.search({ url });
          if (Array.isArray(existing) && existing.length > 0) {
            // 已收藏 → 全部删除（可能有多条）
            for (const bm of existing) {
              try { await chrome.bookmarks.remove(bm.id); } catch (e) {}
            }
            sendOkResponse(sendResponse, { bookmarked: false, removed: existing.length });
            return;
          }
          // 未收藏 → 添加到"其他书签"；在 Chrome/Edge 上 id 通常是 '2'，
          // 但部分配置（Firefox / 企业策略）会有不同；尝试从书签树顶层第二个节点取。
          let parentId = '2';
          try {
            const roots = await chrome.bookmarks.getChildren('0');
            // 顶层 children: [0]=bookmarks bar, [1]=other bookmarks, [2]=mobile bookmarks (某些平台)
            if (Array.isArray(roots) && roots[1] && roots[1].id) parentId = roots[1].id;
          } catch (e) {}
          const created = await chrome.bookmarks.create({
            parentId,
            title: title || url,
            url
          });
          sendOkResponse(sendResponse, { bookmarked: true, id: created && created.id });
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
