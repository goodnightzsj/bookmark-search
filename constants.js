export const PATH_SEPARATOR = ' > ';

export const ALARM_NAMES = {
  SYNC_BOOKMARKS: 'syncBookmarks'
};

export const HISTORY_ACTIONS = {
  ADD: 'add',
  DELETE: 'delete',
  EDIT: 'edit',
  MOVE: 'move'
};

export const MESSAGE_ACTIONS = {
  REFRESH_BOOKMARKS: 'refreshBookmarks',
  UPDATE_SYNC_INTERVAL: 'updateSyncInterval',
  GET_STATS: 'getStats',
  TRACK_BOOKMARK_OPEN: 'trackBookmarkOpen',
  SEARCH_BOOKMARKS: 'searchBookmarks',
  GET_WARMUP_DOMAINS: 'getWarmupDomains',
  GET_BROWSER_FAVICON: 'getBrowserFavicon',
  GET_BROWSER_FAVICONS_BATCH: 'getBrowserFaviconsBatch',
  GET_FAVICONS: 'getFavicons',
  SET_FAVICONS: 'setFavicons',
  PROBE_FAVICON_URL_STATUS: 'probeFaviconUrlStatus',
  TOGGLE_SEARCH: 'toggleSearch',
  CLEAR_FAVICON_CACHE: 'clearFaviconCache',
  CLEAR_HISTORY: 'clearHistory'
};

export const MESSAGE_ACTION_VALUES = Object.freeze(Object.values(MESSAGE_ACTIONS));

export const MESSAGE_ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};
