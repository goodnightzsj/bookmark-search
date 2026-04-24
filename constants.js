/**
 * @file 跨模块共享常量。所有 MESSAGE_ACTIONS 值会在构建期被 vite plugin 注入到 content.js。
 */

/** @type {string} */
export const PATH_SEPARATOR = ' > ';

export const ALARM_NAMES = {
  SYNC_BOOKMARKS: 'syncBookmarks',
  FLUSH_PENDING_EVENTS: 'flushPendingBookmarkEvents'
};

export const HISTORY_ACTIONS = {
  ADD: 'add',
  DELETE: 'delete',
  EDIT: 'edit',
  MOVE: 'move'
};

export const MESSAGE_ACTIONS = {
  REFRESH_BOOKMARKS: 'refreshBookmarks',
  SET_SYNC_INTERVAL: 'setSyncInterval',
  TRACK_BOOKMARK_OPEN: 'trackBookmarkOpen',
  SEARCH_BOOKMARKS: 'searchBookmarks',
  GET_WARMUP_DOMAINS: 'getWarmupDomains',
  GET_BROWSER_FAVICON: 'getBrowserFavicon',
  GET_BROWSER_FAVICONS_BATCH: 'getBrowserFaviconsBatch',
  GET_FAVICONS: 'getFavicons',
  SET_FAVICONS: 'setFavicons',
  GET_RECENT_OPENED: 'getRecentOpened',
  GET_POPUP_STATUS: 'getPopupStatus',
  GET_MIGRATION_STATUS: 'getMigrationStatus',
  TOGGLE_SEARCH: 'toggleSearch',
  CLEAR_FAVICON_CACHE: 'clearFaviconCache',
  CLEAR_HISTORY: 'clearHistory',
  DELETE_BOOKMARK: 'deleteBookmark',
  DELETE_BOOKMARKS_BATCH: 'deleteBookmarksBatch',
  OPEN_BOOKMARK_IN_WINDOW: 'openBookmarkInWindow',
  REVEAL_BOOKMARK: 'revealBookmark',
  FIND_DUPLICATE_BOOKMARKS: 'findDuplicateBookmarks',
  TOGGLE_CURRENT_BOOKMARK: 'toggleCurrentBookmark',
  PROBE_URL_REACHABILITY: 'probeUrlReachability',
  GET_OPEN_STATS_DIGEST: 'getOpenStatsDigest'
};

export const MESSAGE_ACTION_VALUES = Object.freeze(Object.values(MESSAGE_ACTIONS));

export const MESSAGE_ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

export const FAVICON_CONFIG = Object.freeze({
  BROWSER_CACHE_MAX_SIZE: 800,
  CONTENT_CACHE_MAX_SIZE: 2000,
  FETCH_TIMEOUT_MS: 500,
  FETCH_TIMEOUT_PRIVATE_MS: 1200,
  FAILURE_TTL_MS: 10 * 60 * 1000,
  FAILURE_TTL_PRIVATE_MS: 10 * 60 * 1000,
  FAILURE_TTL_MAX_MS: 24 * 60 * 60 * 1000
});

export const WARMUP_CONFIG = Object.freeze({
  RECENT_OPEN_ROOT_MAX: 200,
  RECENT_OPEN_ROOT_WINDOW_MS: 60 * 60 * 1000,
  RECENT_WARMUP_WINDOW_MS: 30 * 60 * 1000
});

export const THEME_NAMES = Object.freeze({
  ORIGINAL: 'original',
  MINIMAL: 'minimal',
  GLASS: 'glass',
  DARK: 'dark',
  AUTO: 'auto'
});
