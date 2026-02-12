import { getWarmupDomainMap, refreshBookmarks, searchBookmarks, clearHistory } from './background-data.js';
import { setupAutoSync } from './background-sync.js';
import { MESSAGE_ACTIONS } from './constants.js';
import { idbGetMany, idbSetMany } from './idb-service.js';

const IDB_KEY_PREFIX_FAVICON = 'favicon:';

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

/**
 * 处理扩展消息
 */
export function handleMessage(request, sender, sendResponse) {
  const action = request && request.action;
  console.log("[Background] 收到消息:", action);
  
  switch (action) {
    case MESSAGE_ACTIONS.REFRESH_BOOKMARKS:
      refreshBookmarks()
        .then(sendResponse)
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });
      return true; // 保持通道开启以进行异步响应
      
    case MESSAGE_ACTIONS.UPDATE_SYNC_INTERVAL: {
      const interval = request.interval;
      setupAutoSync(interval)
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });
      return true;
    }
      
    case MESSAGE_ACTIONS.GET_STATS:
      // 可以在这里返回统计信息
      sendResponse({ success: true });
      return false;

    case MESSAGE_ACTIONS.SEARCH_BOOKMARKS: {
      const query = String(request.query || '').trim();
      if (!query) {
        sendResponse({ success: true, results: [], favicons: {} });
        return false;
      }

      searchBookmarks(query, { limit: 10 })
        .then((resultsRaw) => {
          const results = Array.isArray(resultsRaw) ? resultsRaw : [];
          // NOTE: Keep search response minimal. Favicon selection is handled in the content script:
          // browser favicon cache -> persisted IDB cache -> external sources.
          sendResponse({ success: true, results, favicons: {} });
          return null;
        })
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });
      return true;
    }

    case MESSAGE_ACTIONS.GET_WARMUP_DOMAINS: {
      const limitRaw = request && request.limit;
      const limit = (typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0) ? Math.floor(limitRaw) : 400;

      getWarmupDomainMap({ limit })
        .then((domainToPageUrl) => {
          sendResponse({ success: true, domainToPageUrl: (domainToPageUrl && typeof domainToPageUrl === 'object') ? domainToPageUrl : {} });
        })
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });

      return true;
    }

    case MESSAGE_ACTIONS.GET_BROWSER_FAVICON: {
      const pageUrl = String((request && request.pageUrl) || '').trim();
      if (!pageUrl) {
        sendResponse({ success: true, src: '' });
        return false;
      }

      let faviconUrl = '';
      try {
        if (chrome.favicon && typeof chrome.favicon.getFaviconUrl === 'function') {
          faviconUrl = chrome.favicon.getFaviconUrl(pageUrl);
        }
      } catch (error) {
        faviconUrl = '';
      }

      if (!faviconUrl) {
        sendResponse({ success: true, src: '' });
        return false;
      }

      fetch(faviconUrl)
        .then((res) => {
          if (!res || !res.ok) {
            throw new Error('Favicon fetch failed');
          }
          const contentType = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
          return res.arrayBuffer().then((buf) => ({ buf, contentType }));
        })
        .then(({ buf, contentType }) => {
          const base64 = arrayBufferToBase64(buf);
          const mime = contentType ? String(contentType).split(';')[0].trim() : 'image/png';
          const src = 'data:' + (mime || 'image/png') + ';base64,' + base64;
          sendResponse({ success: true, src });
        })
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });

      return true;
    }

    case MESSAGE_ACTIONS.GET_FAVICONS: {
      const domainsRaw = request && request.domains;
      const domains = Array.isArray(domainsRaw)
        ? Array.from(new Set(domainsRaw.map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean))).slice(0, 5000)
        : [];

      if (domains.length === 0) {
        sendResponse({ success: true, favicons: {} });
        return false;
      }

      const keys = domains.map((domain) => IDB_KEY_PREFIX_FAVICON + domain);

      idbGetMany(keys)
        .then((result) => {
          const favicons = {};
          for (const domain of domains) {
            const key = IDB_KEY_PREFIX_FAVICON + domain;
            const entry = result ? result[key] : undefined;
            if (!entry || typeof entry !== 'object') continue;
            if (typeof entry.src !== 'string' || !entry.src) continue;
            favicons[domain] = entry;
          }
          sendResponse({ success: true, favicons });
        })
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });

      return true;
    }

    case MESSAGE_ACTIONS.SET_FAVICONS: {
      const entriesRaw = request && request.entries;
      const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
      const now = Date.now();

      const items = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const domain = typeof entry.domain === 'string' ? entry.domain.trim() : '';
        const src = typeof entry.src === 'string' ? entry.src.trim() : '';
        if (!domain || !src) continue;
        const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now;
        items.push({
          key: IDB_KEY_PREFIX_FAVICON + domain,
          value: { src, updatedAt }
        });
      }

      if (items.length === 0) {
        sendResponse({ success: true, count: 0 });
        return false;
      }

      idbSetMany(items)
        .then(() => {
          sendResponse({ success: true, count: items.length });
        })
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });

      return true;
    }

    case MESSAGE_ACTIONS.CLEAR_HISTORY:
      clearHistory()
        .then(sendResponse)
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          sendResponse({ success: false, error: message });
        });
      return true;

    default:
      console.warn("[Background] 未知的消息动作:", action);
      sendResponse({ success: false, error: 'Unknown action' });
      return false;
  }
}
