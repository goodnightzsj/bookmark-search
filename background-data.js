import { getStorageWithStatus, setStorage, setStorageOrThrow, STORAGE_KEYS } from './storage-service.js';
import { compareBookmarks, flattenBookmarksTree } from './bookmark-logic.js';
import { HISTORY_ACTIONS, PATH_SEPARATOR, WARMUP_CONFIG } from './constants.js';
import { idbGet, idbGetAllDocuments, idbPatchDocuments, idbReplaceDocuments, idbSet } from './idb-service.js';
import { buildFaviconServiceKey, isLikelyPrivateHost } from './utils.js';
import { createLogger } from './logger.js';
import pinyin from 'tiny-pinyin';

const log = createLogger('Background');

// 书签数据管理模块

// 常量定义
const MAX_HISTORY_ITEMS = 100;  // 历史记录最大条数
const IDB_KEY_RECENT_OPENED_ROOTS = 'recentOpenedRoots:v1';  // 最近打开过的根域名快照（用于 warmup 优先级，防 SW 重启丢失）
const DOCUMENT_SOURCE_TYPE = 'bookmark';
const BOOKMARK_CACHE_TTL_DEFAULT_MS = 30 * 60 * 1000; // 默认主缓存 TTL：30 分钟
const STALE_REFRESH_MIN_GAP_MS = 30 * 1000; // 过期触发全量刷新的最小间隔
const STORAGE_METADATA_RETRY_DELAY_MS = 500;

function normalizeCacheMeta(meta, fallbackCount = 0, fallbackUpdatedAt = 0) {
  const safeMeta = (meta && typeof meta === 'object') ? meta : {};
  const updatedAtRaw = safeMeta.updatedAt;
  const countRaw = safeMeta.count;

  const updatedAt = (typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw) && updatedAtRaw > 0)
    ? updatedAtRaw
    : ((typeof fallbackUpdatedAt === 'number' && Number.isFinite(fallbackUpdatedAt) && fallbackUpdatedAt > 0) ? fallbackUpdatedAt : 0);

  const count = (typeof countRaw === 'number' && Number.isFinite(countRaw) && countRaw >= 0)
    ? Math.floor(countRaw)
    : ((typeof fallbackCount === 'number' && Number.isFinite(fallbackCount) && fallbackCount >= 0) ? Math.floor(fallbackCount) : 0);

  return { updatedAt, count };
}

function buildCacheMetaFromCount(count, updatedAt) {
  const safeCount = (typeof count === 'number' && Number.isFinite(count) && count >= 0) ? Math.floor(count) : 0;
  const safeUpdatedAt = (typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0) ? updatedAt : Date.now();
  return { updatedAt: safeUpdatedAt, count: safeCount };
}

function normalizeLastSyncValue(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : 0;
}

function normalizeHistoryList(list) {
  return Array.isArray(list) ? list.filter(Boolean).slice(0, MAX_HISTORY_ITEMS) : [];
}

function getHistorySignature(list) {
  return JSON.stringify(normalizeHistoryList(list));
}

const runtimeState = {
  // 运行时主数据：SearchDocument 数组
  documents: [],
  // 兼容视图：从 documents 派生的 bookmark 数组（供现有 compare/search/warmup 逻辑复用）
  bookmarks: [],
  // 快速索引：bookmarkId -> bookmarks index
  bookmarkIndexById: new Map()
};

// 运行时 documents fingerprint 缓存，避免 ensureCacheConsistency 每次重算
let runtimeDocumentsFingerprint = '';

// 倒排索引：bigram → Set<docIndex>，用于 searchDocuments 候选过滤（毫秒级缩圈）
// 不直接存 docId，存 documents 数组中的 index 以降低内存
let searchBigramIndex = null;

function extractBigramsFromText(text) {
  const safe = typeof text === 'string' ? text.toLowerCase() : '';
  if (!safe || safe.length < 2) return null;
  const out = new Set();
  for (let i = 0; i + 1 < safe.length; i++) {
    const c1 = safe.charCodeAt(i);
    const c2 = safe.charCodeAt(i + 1);
    // 跳过双空白：空白做分隔符，不参与索引
    if (c1 === 32 && c2 === 32) continue;
    out.add(safe.slice(i, i + 2));
  }
  return out;
}

function addBigramsForDoc(index, docIdx, text) {
  const grams = extractBigramsFromText(text);
  if (!grams) return;
  for (const g of grams) {
    let bucket = index.get(g);
    if (!bucket) {
      bucket = new Set();
      index.set(g, bucket);
    }
    bucket.add(docIdx);
  }
}

function buildSearchBigramIndex(documents) {
  const idx = new Map();
  const list = Array.isArray(documents) ? documents : [];
  for (let i = 0; i < list.length; i++) {
    const doc = list[i];
    if (!doc) continue;
    addBigramsForDoc(idx, i, doc.title);
    addBigramsForDoc(idx, i, doc.subtitle);
    addBigramsForDoc(idx, i, doc.url);
    addBigramsForDoc(idx, i, doc.pinyinFull);
    addBigramsForDoc(idx, i, doc.pinyinInitials);
  }
  return idx;
}

function ensureSearchBigramIndex(documents) {
  if (searchBigramIndex) return searchBigramIndex;
  searchBigramIndex = buildSearchBigramIndex(documents);
  return searchBigramIndex;
}

function invalidateSearchIndex() {
  searchBigramIndex = null;
}

// 书签变化历史
let bookmarkHistory = [];
// 并发锁：串行化 refresh 与增量事件处理
let isUpdating = false;
let updateQueued = false;
let pendingRefresh = false;
let pendingBookmarkEvents = [];
let pendingClearHistory = false;
// 缓存是否已从 storage 加载（避免重复 IO）
let isCacheLoaded = false;
let loadCachePromise = null;
let lastStaleRefreshAt = 0;
let runtimeCacheTtlMinutes = null;
let runtimeCacheTtlLoaded = false;
let runtimeLastSyncTime = null; // 内存缓存 lastSyncTime，避免每次搜索读 storage
let clearHistoryWaiters = [];
// 最近在搜索结果中实际打开过的 favicon key（用于 favicon 预热优先级）
// key: faviconKey -> { count, lastAt, sampleUrl }
const recentOpenedRootMap = new Map();
const RECENT_OPEN_ROOT_MAX = WARMUP_CONFIG.RECENT_OPEN_ROOT_MAX;
const RECENT_OPEN_ROOT_WINDOW_MS = WARMUP_CONFIG.RECENT_OPEN_ROOT_WINDOW_MS;
// 最近已用于 favicon 预热的 favicon key，避免多 tab 重复 warmup
// key: faviconKey -> lastWarmupAt
const recentWarmupDomains = new Map();
const RECENT_WARMUP_WINDOW_MS = WARMUP_CONFIG.RECENT_WARMUP_WINDOW_MS;

// 持久化：最近打开过的 favicon key（防 MV3 SW 重启/休眠丢失 warmup 优先级）
let recentOpenedRootsPersistChain = Promise.resolve();

function buildRecentOpenedRootsSnapshot(nowTs = Date.now()) {
  const now = (typeof nowTs === 'number' && Number.isFinite(nowTs) && nowTs > 0) ? nowTs : Date.now();
  const cutoff = now - RECENT_OPEN_ROOT_WINDOW_MS;
  const entries = [];

  for (const [root, info] of recentOpenedRootMap.entries()) {
    if (!root) continue;
    const lastAt = info && typeof info.lastAt === 'number' ? info.lastAt : 0;
    if (!lastAt || lastAt < cutoff) continue;
    const count = (info && typeof info.count === 'number' && Number.isFinite(info.count) && info.count >= 0) ? Math.floor(info.count) : 0;
    const sampleUrl = (info && typeof info.sampleUrl === 'string') ? info.sampleUrl : '';
    entries.push({ root, count, lastAt, sampleUrl });
  }

  entries.sort((a, b) => {
    const av = typeof a.lastAt === 'number' ? a.lastAt : 0;
    const bv = typeof b.lastAt === 'number' ? b.lastAt : 0;
    return bv - av;
  });

  if (entries.length > RECENT_OPEN_ROOT_MAX) {
    entries.length = RECENT_OPEN_ROOT_MAX;
  }

  return entries;
}

function restoreRecentOpenedRootsFromSnapshot(snapshot, nowTs = Date.now()) {
  recentOpenedRootMap.clear();

  const now = (typeof nowTs === 'number' && Number.isFinite(nowTs) && nowTs > 0) ? nowTs : Date.now();
  const cutoff = now - RECENT_OPEN_ROOT_WINDOW_MS;
  const list = Array.isArray(snapshot) ? snapshot : [];
  if (list.length === 0) return;

  const valid = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;

    const root = (typeof item.root === 'string') ? item.root.trim().toLowerCase() : '';
    if (!root) continue;

    const lastAt = (typeof item.lastAt === 'number' && Number.isFinite(item.lastAt)) ? item.lastAt : 0;
    if (!lastAt || lastAt < cutoff) continue;

    const count = (typeof item.count === 'number' && Number.isFinite(item.count) && item.count >= 0) ? Math.floor(item.count) : 0;
    const sampleUrl = (typeof item.sampleUrl === 'string') ? item.sampleUrl : '';
    valid.push({ root, count, lastAt, sampleUrl });
  }

  valid.sort((a, b) => {
    const av = typeof a.lastAt === 'number' ? a.lastAt : 0;
    const bv = typeof b.lastAt === 'number' ? b.lastAt : 0;
    return bv - av;
  });

  for (let i = 0; i < valid.length && i < RECENT_OPEN_ROOT_MAX; i++) {
    const item = valid[i];
    recentOpenedRootMap.set(item.root, { count: item.count, lastAt: item.lastAt, sampleUrl: item.sampleUrl });
  }
}

function persistRecentOpenedRootsToIdb(nowTs = Date.now()) {
  const snapshot = buildRecentOpenedRootsSnapshot(nowTs);

  recentOpenedRootsPersistChain = recentOpenedRootsPersistChain
    .catch(() => {})
    .then(() => idbSet(IDB_KEY_RECENT_OPENED_ROOTS, snapshot))
    .catch((error) => {
      log.warn('recent_open_roots_persist_failed', { message: error && error.message ? error.message : String(error) });
    });

  return recentOpenedRootsPersistChain;
}


function rebuildBookmarkIndex() {
  const next = new Map();
  const list = Array.isArray(runtimeState.bookmarks) ? runtimeState.bookmarks : [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || !b.id) continue;
    next.set(String(b.id), i);
  }
  runtimeState.bookmarkIndexById = next;
}

function computePinyinFields(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source) return { full: '', initials: '' };
  try {
    if (!pinyin || typeof pinyin.parse !== 'function' || !pinyin.isSupported()) {
      return { full: '', initials: '' };
    }
    const parts = pinyin.parse(source) || [];
    let full = '';
    let initials = '';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      // type 2 = Chinese char (has pinyin target); other = ASCII/symbol (target === source)
      const target = typeof p.target === 'string' ? p.target.toLowerCase() : '';
      if (!target) continue;
      full += target;
      if (p.type === 2) {
        initials += target.charAt(0);
      } else {
        // 非中文部分：保留原样作为 initials 的一部分（让 "gh" 匹配 "GitHub Hub"）
        initials += target;
      }
    }
    return { full, initials };
  } catch (e) {
    return { full: '', initials: '' };
  }
}

function mapBookmarkToSearchDocument(bookmark) {
  if (!bookmark || typeof bookmark !== 'object' || !bookmark.id || !bookmark.url) return null;
  const title = typeof bookmark.title === 'string' ? bookmark.title : '';
  const url = typeof bookmark.url === 'string' ? bookmark.url : '';
  const path = typeof bookmark.path === 'string' && bookmark.path
    ? String(bookmark.path).split(PATH_SEPARATOR).map((item) => item.trim()).filter(Boolean)
    : [];

  // 预计算 title 的拼音全拼与首字母，便于 "gh"→GitHub、"sjsj"→收藏夹设置 这类查询命中
  const pinyinData = computePinyinFields(title);

  return {
    id: `${DOCUMENT_SOURCE_TYPE}:${String(bookmark.id)}`,
    sourceType: DOCUMENT_SOURCE_TYPE,
    sourceId: String(bookmark.id),
    title,
    subtitle: path.join(PATH_SEPARATOR),
    url,
    path,
    iconKey: url,
    pinyinFull: pinyinData.full,
    pinyinInitials: pinyinData.initials,
    updatedAt: (typeof bookmark.dateAdded === 'number' && Number.isFinite(bookmark.dateAdded)) ? bookmark.dateAdded : 0,
    metadata: {
      dateAdded: (typeof bookmark.dateAdded === 'number' && Number.isFinite(bookmark.dateAdded)) ? bookmark.dateAdded : 0
    }
  };
}

function mapSearchDocumentToBookmark(doc) {
  if (!doc || typeof doc !== 'object' || doc.sourceType !== DOCUMENT_SOURCE_TYPE || !doc.sourceId || !doc.url) return null;
  return {
    id: doc.sourceId,
    title: typeof doc.title === 'string' ? doc.title : '',
    url: typeof doc.url === 'string' ? doc.url : '',
    path: Array.isArray(doc.path) ? doc.path.join(PATH_SEPARATOR) : '',
    dateAdded: doc.metadata && typeof doc.metadata.dateAdded === 'number' ? doc.metadata.dateAdded : 0
  };
}

function mapSearchDocumentsToBookmarks(documents) {
  const list = Array.isArray(documents) ? documents : [];
  const bookmarks = [];
  for (let i = 0; i < list.length; i++) {
    const bookmark = mapSearchDocumentToBookmark(list[i]);
    if (bookmark) bookmarks.push(bookmark);
  }
  return bookmarks;
}

// 判断查询 token 是否"可能是拼音查询"：纯 ASCII 字母且长度 >= 2
function isLikelyPinyinQuery(token) {
  if (!token || typeof token !== 'string') return false;
  if (token.length < 2) return false;
  // 只接受 a-z（token 已被 toLowerCase），不含数字/符号
  return /^[a-z]+$/.test(token);
}

function intersectInto(target, bucket) {
  // target ∩ bucket，返回新 Set（不修改 target / bucket）
  const next = new Set();
  const smaller = target.size <= bucket.size ? target : bucket;
  const larger  = smaller === target ? bucket : target;
  for (const idx of smaller) {
    if (larger.has(idx)) next.add(idx);
  }
  return next;
}

// 用 bigram 倒排索引缩圈出候选 doc index 集合。返回 null 表示"没有有效缩圈信息，需全量扫描"
// 改进：对每个 token 取所有相邻 2-gram（不只是第一个），逐一 intersect，最大化缩圈。
//   token "github" → ["gi","it","th","hu","ub"]；任一 bigram 的 bucket 不存在则候选为空。
function narrowCandidatesByBigram(tokens, documents) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const index = ensureSearchBigramIndex(documents);
  if (!index || index.size === 0) return null;

  let candidates = null;

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (!token || token.length < 2) {
      // 1 字符 token 信息量太少，不缩圈（避免误过滤）
      return null;
    }

    // 该 token 的所有相邻 bigram
    for (let b = 0; b + 1 < token.length; b++) {
      const bigram = token.slice(b, b + 2);
      const bucket = index.get(bigram);
      if (!bucket || bucket.size === 0) {
        // 有任何一个 bigram 不在索引里 → 必然无结果
        return new Set();
      }
      if (candidates === null) {
        candidates = new Set(bucket);
      } else {
        candidates = intersectInto(candidates, bucket);
        if (candidates.size === 0) return candidates;
      }
    }
  }
  return candidates;
}

function searchDocuments(documents, query, limit) {
  const list = Array.isArray(documents) ? documents : [];
  const raw = typeof query === 'string' ? query.trim() : '';
  if (!raw) return [];

  const queryLower = raw.toLowerCase();
  const tokens = queryLower.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const max = typeof limit === 'number' && limit > 0 ? limit : 10;
  const topK = [];

  // 倒排索引缩圈：把上万书签 × 每 token indexOf 的全量扫描，压缩到候选集合上
  // 小库（< 200）直接扫，索引收益不够
  const candidates = list.length >= 200 ? narrowCandidatesByBigram(tokens, list) : null;

  function scoreDoc(i) {
    const doc = list[i];
    if (!doc || !doc.url) return;

    const titleLower = String(doc.title || '').toLowerCase();
    const urlLower = String(doc.url || '').toLowerCase();
    const pathLower = String(doc.subtitle || '').toLowerCase();
    const pinyinFull = String(doc.pinyinFull || '');
    const pinyinInitials = String(doc.pinyinInitials || '');

    let score = 0;
    let matched = true;

    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t];
      const ti = titleLower.indexOf(token);
      const pi = pathLower.indexOf(token);
      const ui = urlLower.indexOf(token);

      let pyFullMatch = -1;
      let pyInitialMatch = -1;
      if (ti < 0 && isLikelyPinyinQuery(token)) {
        if (pinyinFull) pyFullMatch = pinyinFull.indexOf(token);
        if (pinyinInitials) pyInitialMatch = pinyinInitials.indexOf(token);
      }

      if (ti < 0 && pi < 0 && ui < 0 && pyFullMatch < 0 && pyInitialMatch < 0) {
        matched = false;
        break;
      }

      if (ti >= 0) {
        let tokenScore = ti;
        if (ti === 0) tokenScore -= 50;
        const beforeChar = ti > 0 ? titleLower.charCodeAt(ti - 1) : 0;
        if (beforeChar === 32 || beforeChar === 45 || beforeChar === 95 || beforeChar === 124) {
          tokenScore -= 20;
        }
        score += tokenScore;
      } else if (pyInitialMatch >= 0) {
        let tokenScore = 200 + pyInitialMatch;
        if (pyInitialMatch === 0) tokenScore -= 50;
        score += tokenScore;
      } else if (pyFullMatch >= 0) {
        let tokenScore = 300 + pyFullMatch;
        if (pyFullMatch === 0) tokenScore -= 50;
        score += tokenScore;
      } else if (pi >= 0) {
        let tokenScore = 500 + pi;
        if (pi === 0) tokenScore -= 30;
        score += tokenScore;
      } else {
        score += 1000 + ui;
      }
    }

    if (!matched) return;
    if (tokens.length === 1 && titleLower === queryLower) score -= 200;

    if (topK.length < max) {
      let insertIdx = topK.length;
      while (insertIdx > 0 && topK[insertIdx - 1].score > score) insertIdx--;
      topK.splice(insertIdx, 0, { score, doc });
    } else if (score < topK[max - 1].score) {
      topK.pop();
      let insertIdx = topK.length;
      while (insertIdx > 0 && topK[insertIdx - 1].score > score) insertIdx--;
      topK.splice(insertIdx, 0, { score, doc });
    }
  }

  if (candidates !== null) {
    // 索引缩圈路径：只评分候选集合
    for (const idx of candidates) scoreDoc(idx);
  } else {
    // 全量评分（小库 / 1 字符 token 等 fallback）
    for (let i = 0; i < list.length; i++) scoreDoc(i);
  }

  const results = [];
  for (let i = 0; i < topK.length; i++) {
    const bookmark = mapSearchDocumentToBookmark(topK[i].doc);
    if (bookmark) results.push(bookmark);
  }
  return results;
}

function setRuntimeDocuments(nextDocuments) {
  runtimeState.documents = Array.isArray(nextDocuments) ? nextDocuments.filter((doc) => doc && doc.sourceType === DOCUMENT_SOURCE_TYPE && doc.sourceId && doc.url) : [];
  runtimeState.bookmarks = mapSearchDocumentsToBookmarks(runtimeState.documents);
  runtimeDocumentsFingerprint = getDocumentsFingerprint(runtimeState.documents);
  invalidateSearchIndex();
  // 空闲时预热索引（10k 书签 ~200ms）。首次搜索就能命中已构建好的索引，
  // 省掉"用户打开搜索框输入第一个字符时才同步构建"的感知延迟。
  scheduleSearchIndexWarmup();
}

let searchIndexWarmupScheduled = false;
function scheduleSearchIndexWarmup() {
  if (searchIndexWarmupScheduled) return;
  searchIndexWarmupScheduled = true;
  const run = () => {
    searchIndexWarmupScheduled = false;
    const docs = getRuntimeDocuments();
    if (docs.length < 200) return; // 小库全量扫够快，不用索引
    try { ensureSearchBigramIndex(docs); } catch (e) {}
  };
  // SW 环境可能无 requestIdleCallback，fallback 到 setTimeout
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 500);
  }
}

function setRuntimeBookmarks(nextBookmarks) {
  const list = Array.isArray(nextBookmarks) ? nextBookmarks : [];
  const nextDocuments = [];
  for (let i = 0; i < list.length; i++) {
    const doc = mapBookmarkToSearchDocument(list[i]);
    if (doc) nextDocuments.push(doc);
  }
  setRuntimeDocuments(nextDocuments);
}

async function readPersistedDocuments() {
  const documents = await idbGetAllDocuments();
  return Array.isArray(documents) ? documents.filter((doc) => doc && doc.sourceType === DOCUMENT_SOURCE_TYPE && doc.sourceId && doc.url) : [];
}

function getRuntimeDocuments() {
  return Array.isArray(runtimeState.documents) ? runtimeState.documents : [];
}

function getDocumentsFingerprint(documents) {
  const list = Array.isArray(documents) ? documents : [];
  if (list.length === 0) return '0|';

  const summary = [];
  for (let i = 0; i < list.length; i++) {
    const doc = list[i] || {};
    summary.push(`${doc.id || ''}:${doc.updatedAt || 0}:${doc.url || ''}`);
  }
  summary.sort();

  // 用简单数值哈希遍历全部条目，避免采样截断漏检
  let h = 0x811c9dc5; // FNV-1a offset basis (32-bit)
  for (let i = 0; i < summary.length; i++) {
    const s = summary[i];
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 0x01000193); // FNV prime
    }
    h ^= 0x1f; // separator
    h = Math.imul(h, 0x01000193);
  }
  return `${summary.length}|${(h >>> 0).toString(36)}`;
}

function getRuntimeBookmarks() {
  return Array.isArray(runtimeState.bookmarks) ? runtimeState.bookmarks : [];
}

function getRuntimeState() {
  return runtimeState;
}

async function ensureRuntimeDocumentsAvailable() {
  const runtimeDocuments = getRuntimeDocuments();
  if (runtimeDocuments.length > 0) return runtimeDocuments;
  try {
    const documents = await readPersistedDocuments();
    if (documents.length > 0) {
      setRuntimeDocuments(documents);
      return getRuntimeDocuments();
    }
  } catch (error) {
    log.warn('documents_runtime_read_failed', { message: error && error.message ? error.message : String(error) });
  }
  return runtimeDocuments;
}

async function persistSearchDocuments() {
  await idbReplaceDocuments(getRuntimeDocuments());
}

function maybeScheduleStaleRefresh() {
  const now = Date.now();
  const tooSoon = (now - lastStaleRefreshAt) < STALE_REFRESH_MIN_GAP_MS;
  if (tooSoon) return;

  lastStaleRefreshAt = now;
  log.observe('stale_refresh_trigger', { reason: 'ttl_expired', at: now });
  refreshBookmarks().catch((error) => {
    log.warn('stale_refresh_failed', { message: error && error.message ? error.message : String(error) });
  });
}

async function ensureRuntimeCacheTtlMinutes() {
  if (runtimeCacheTtlLoaded && typeof runtimeCacheTtlMinutes === 'number' && runtimeCacheTtlMinutes > 0) {
    return runtimeCacheTtlMinutes;
  }

  const ttlRead = await getStorageWithStatus(STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES);
  if (!ttlRead.success && ttlRead.state && ttlRead.state[STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES] === 'failed') {
    log.warn('ttl_storage_read_failed', { error: ttlRead.error || 'unknown' });
  }

  const ttlRaw = ttlRead.data ? ttlRead.data[STORAGE_KEYS.BOOKMARK_CACHE_TTL_MINUTES] : null;
  const ttl = (typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) && ttlRaw > 0) ? ttlRaw : 30;

  runtimeCacheTtlMinutes = ttl;
  runtimeCacheTtlLoaded = true;
  return runtimeCacheTtlMinutes;
}

export function updateRuntimeCacheTtlMinutes(nextValue) {
  const ttl = (typeof nextValue === 'number' && Number.isFinite(nextValue) && nextValue > 0)
    ? Math.floor(nextValue)
    : null;

  if (ttl) {
    runtimeCacheTtlMinutes = ttl;
    runtimeCacheTtlLoaded = true;
    return;
  }

  runtimeCacheTtlMinutes = null;
  runtimeCacheTtlLoaded = false;
}

function getWarmupDomainKeyFromUrl(url) {
  const safeUrl = typeof url === 'string' ? url.trim() : '';
  if (!safeUrl) return '';
  return buildFaviconServiceKey(safeUrl);
}

function getWarmupFallbackSampleUrl(root) {
  const safeRoot = typeof root === 'string' ? root.trim() : '';
  if (!safeRoot) return '';
  return (isLikelyPrivateHost(safeRoot) ? 'http://' : 'https://') + safeRoot;
}

/**
 * Return recent opened bookmarks (for empty-state UI in the overlay).
 * Prefers bookmarks matched against recentOpenedRootMap; falls back to last-edited
 * items from bookmarkHistory when the map is empty.
 */
export async function getRecentOpenedBookmarks({ limit = 10 } = {}) {
  await loadCacheFromStorage();

  const max = (typeof limit === 'number' && Number.isFinite(limit) && limit > 0)
    ? Math.min(Math.floor(limit), 20)
    : 10;

  const documents = await ensureRuntimeDocumentsAvailable();
  const nowTs = Date.now();
  const cutoff = nowTs - RECENT_OPEN_ROOT_WINDOW_MS;

  const openedEntries = Array.from(recentOpenedRootMap.entries())
    .filter(([, info]) => info && typeof info.lastAt === 'number' && info.lastAt >= cutoff)
    .sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0));

  const pickedIds = new Set();
  const results = [];

  // 1) 按最近打开的 favicon key 反查一条匹配书签
  for (let i = 0; i < openedEntries.length && results.length < max; i++) {
    const [root, info] = openedEntries[i];
    const sampleUrl = info && typeof info.sampleUrl === 'string' ? info.sampleUrl : '';
    let match = null;
    if (sampleUrl) {
      for (let j = 0; j < documents.length; j++) {
        const doc = documents[j];
        if (!doc || !doc.url) continue;
        if (doc.url === sampleUrl) { match = doc; break; }
      }
    }
    if (!match) {
      for (let j = 0; j < documents.length; j++) {
        const doc = documents[j];
        if (!doc || !doc.url) continue;
        const key = getWarmupDomainKeyFromUrl(doc.url);
        if (key === root) { match = doc; break; }
      }
    }
    if (!match) continue;
    const bookmark = mapSearchDocumentToBookmark(match);
    if (!bookmark || pickedIds.has(bookmark.id)) continue;
    pickedIds.add(bookmark.id);
    results.push(bookmark);
  }

  // 2) 兜底：从历史记录里按最近 action 取
  if (results.length < max && Array.isArray(bookmarkHistory) && bookmarkHistory.length > 0) {
    const seenUrls = new Set(results.map((r) => r.url));
    for (let i = 0; i < bookmarkHistory.length && results.length < max; i++) {
      const item = bookmarkHistory[i];
      if (!item || typeof item.url !== 'string' || !item.url) continue;
      if (seenUrls.has(item.url)) continue;
      // 从 documents 中查出完整 bookmark，保留 id/path 等字段
      const doc = documents.find((d) => d && d.url === item.url);
      if (!doc) continue;
      const bookmark = mapSearchDocumentToBookmark(doc);
      if (!bookmark || pickedIds.has(bookmark.id)) continue;
      pickedIds.add(bookmark.id);
      seenUrls.add(item.url);
      results.push(bookmark);
    }
  }

  return results;
}

/**
 * URL 归一化：用于重复书签识别
 * - 小写 hostname
 * - 保留端口（同 IP / host 不同端口是不同服务，不应判为重复）
 * - 去掉 hash
 * - 去掉 URL 末尾多余斜杠（保留根路径 /）
 * - 保留 query string（同一页带不同参数算不同书签）
 */
function normalizeUrlForDedup(url) {
  const safe = typeof url === 'string' ? url.trim() : '';
  if (!safe) return '';
  try {
    const u = new URL(safe);
    const host = (u.hostname || '').toLowerCase();
    // 端口：非默认才保留（http 默认 80 / https 默认 443 不写入，减少 a://host/ 与 a://host:80/ 同源不同 key 的误判）
    let port = u.port || '';
    if ((u.protocol === 'http:' && port === '80') || (u.protocol === 'https:' && port === '443')) {
      port = '';
    }
    const hostWithPort = port ? `${host}:${port}` : host;
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${hostWithPort}${path}${u.search}`;
  } catch (e) {
    return safe.toLowerCase();
  }
}

/**
 * 查找重复书签：按归一化 URL 分组，返回每组 2+ 个的集合
 * 返回格式：
 *   [
 *     { key: 'https://example.com/', items: [{ id, title, url, path, dateAdded }, ...] },
 *     ...
 *   ]
 */
export async function findDuplicateBookmarks() {
  await loadCacheFromStorage();
  const documents = await ensureRuntimeDocumentsAvailable();
  const groups = new Map();
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (!doc || !doc.url) continue;
    const key = normalizeUrlForDedup(doc.url);
    if (!key) continue;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    const bookmark = mapSearchDocumentToBookmark(doc);
    if (bookmark) bucket.push(bookmark);
  }
  const result = [];
  for (const [key, items] of groups) {
    if (!items || items.length < 2) continue;
    // 按 dateAdded 升序排（旧的在前，新的在后；用户通常想保留新的）
    items.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    result.push({ key, items });
  }
  // 按组内书签数降序排（冲突最多的在顶）
  result.sort((a, b) => b.items.length - a.items.length);
  return result;
}

export async function recordBookmarkOpen(url) {
  const safeUrl = typeof url === 'string' ? url.trim() : '';
  if (!safeUrl) return;
  let href = '';
  try {
    const u = new URL(safeUrl);
    href = u && u.href ? u.href : safeUrl;
  } catch (e) {
    return;
  }
  const root = getWarmupDomainKeyFromUrl(safeUrl);
  if (!root) return;

  const nowTs = Date.now();
  const prev = recentOpenedRootMap.get(root) || { count: 0, lastAt: 0, sampleUrl: '' };
  const next = {
    count: (prev.count || 0) + 1,
    lastAt: nowTs,
    sampleUrl: prev.sampleUrl || href
  };
  recentOpenedRootMap.set(root, next);

  // 清理过期或过多的记录
  const cutoff = nowTs - RECENT_OPEN_ROOT_WINDOW_MS;
  const toDelete = [];
  for (const [key, value] of recentOpenedRootMap.entries()) {
    if (!value || typeof value.lastAt !== 'number' || value.lastAt < cutoff) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    recentOpenedRootMap.delete(key);
  }
  // 最多保留 RECENT_OPEN_ROOT_MAX 条，按 lastAt 从新到旧
  if (recentOpenedRootMap.size > RECENT_OPEN_ROOT_MAX) {
    const entries = Array.from(recentOpenedRootMap.entries());
    entries.sort((a, b) => {
      const av = a[1] && typeof a[1].lastAt === 'number' ? a[1].lastAt : 0;
      const bv = b[1] && typeof b[1].lastAt === 'number' ? b[1].lastAt : 0;
      return bv - av;
    });
    for (let i = RECENT_OPEN_ROOT_MAX; i < entries.length; i++) {
      recentOpenedRootMap.delete(entries[i][0]);
    }
  }

  // Best-effort: persist snapshot so warmup priority survives SW restarts
  await persistRecentOpenedRootsToIdb(nowTs);
}

async function runUpdateLoop() {
  if (isUpdating) {
    updateQueued = true;
    return { success: false, skipped: true };
  }

  isUpdating = true;
  let lastResult = { success: false };
  try {
    do {
      updateQueued = false;

      if (pendingRefresh) {
        pendingRefresh = false;
        // 先保留本轮 refresh 开始时已积攒的增量事件，失败则重新入队，避免 refresh 异常丢事件。
        const stashedEvents = pendingBookmarkEvents;
        pendingBookmarkEvents = [];
        lastResult = await refreshBookmarksOnce();
        const refreshFailed = !lastResult || lastResult.success === false;
        if (refreshFailed && Array.isArray(stashedEvents) && stashedEvents.length > 0) {
          // 本轮新到事件排在旧事件之后，保持先到先处理
          pendingBookmarkEvents = stashedEvents.concat(pendingBookmarkEvents);
          log.warn('refresh_failed_requeue_events', {
            requeued: stashedEvents.length,
            next: pendingBookmarkEvents.length,
            error: lastResult && lastResult.error ? lastResult.error : 'unknown'
          });
        }
        continue;
      }

      if (pendingBookmarkEvents.length > 0) {
        const batch = pendingBookmarkEvents;
        pendingBookmarkEvents = [];
        lastResult = await applyBookmarkEventsOnce(batch);
        continue;
      }

      if (pendingClearHistory) {
        pendingClearHistory = false;
        lastResult = await clearHistoryOnce();
        resolveClearHistoryWaiters(lastResult);
        continue;
      }

      lastResult = { success: true, idle: true };
    } while (updateQueued || pendingRefresh || pendingBookmarkEvents.length > 0);

    return lastResult;
  } catch (error) {
    if (clearHistoryWaiters.length > 0) {
      pendingClearHistory = false;
      rejectClearHistoryWaiters(error);
    }
    throw error;
  } finally {
    isUpdating = false;
  }
}

/**
 * 从 Chrome 获取书签树并处理
 */
export async function refreshBookmarks() {
  pendingRefresh = true;
  if (isUpdating) {
    updateQueued = true;
    log.info("刷新已在进行中，标记为待刷新");
    return { success: false, skipped: true };
  }

  return runUpdateLoop();
}

/**
 * 增量处理书签事件（尽量避免全量 getTree）
 */
export async function applyBookmarkEvents(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  if (list.length === 0) return { success: true, applied: 0 };

  pendingBookmarkEvents = pendingBookmarkEvents.concat(list);

  // 防止极端情况下队列无限增长（例如导入/批量操作）
  if (pendingBookmarkEvents.length > 500) {
    pendingRefresh = true;
  }

  if (isUpdating) {
    updateQueued = true;
    return { success: false, skipped: true };
  }

  return runUpdateLoop();
}

async function refreshBookmarksOnce() {
  log.info("开始刷新书签...");

  // 确保已有缓存基线，避免把“全量书签”误判成新增变更
  await loadCacheFromStorage();

  try {
    const syncTime = Date.now();
    const tree = await chrome.bookmarks.getTree();
    
    // 展平书签树
    const flatBookmarks = flattenBookmarksTree(tree);
    
    // 与旧数据对比，生成差异记录
    const currentBookmarks = mapSearchDocumentsToBookmarks(getRuntimeDocuments());
    const changes = compareBookmarks(currentBookmarks, flatBookmarks);
    
    if (changes.length > 0) {
      log.info("检测到 %d 个书签变化", changes.length);
      // 更新历史记录
      await updateHistory(changes);

      // 更新运行时主数据（documents）与兼容 bookmark 视图
      setRuntimeBookmarks(flatBookmarks);
      rebuildBookmarkIndex();

      // 保存到本地存储
      const saveResult = await saveToStorage(syncTime);
      if (!saveResult || !saveResult.success) {
        return {
          success: false,
          error: '持久化书签缓存失败',
          degraded: true,
          source: saveResult && saveResult.source ? saveResult.source : 'unknown'
        };
      }
    } else {
      log.info("书签无变化");
      await ensureCacheConsistency(syncTime);
    }
    
    return { success: true, count: flatBookmarks.length, changes: changes.length };
  } catch (error) {
    log.error("刷新书签失败:", error);
    return { success: false, error: error.message };
  }
}

/**
 * 批量预加载所有文件夹路径到缓存
 * @param {Map} cache - 路径缓存 Map
 * @param {Array} [existingTree] - 可选，已获取的书签树（避免重复 API 调用）
 */
async function preloadFolderPaths(cache, existingTree) {
  if (!cache) return;
  try {
    const tree = existingTree || await chrome.bookmarks.getTree();
    const buildPaths = (nodes, parentPath) => {
      for (const node of nodes) {
        if (!node) continue;
        const currentPath = parentPath
          ? (node.title ? parentPath + PATH_SEPARATOR + node.title : parentPath)
          : (node.title || '');
        // 只缓存文件夹（无 url 的节点）
        if (!node.url && node.id) {
          cache.set(node.id, currentPath);
        }
        if (node.children) {
          buildPaths(node.children, currentPath);
        }
      }
    };
    buildPaths(tree, '');
  } catch (error) {
    log.warn('预加载文件夹路径失败:', error);
  }
}

async function getFolderPath(parentId, cache) {
  const id = typeof parentId === 'string' ? parentId : String(parentId || '');
  if (!id || id === '0') return '';
  if (cache && cache.has(id)) return cache.get(id);

  // 缓存未命中时回退到单次查询（兼容增量更新场景）
  const parts = [];
  let currentId = id;

  while (currentId && currentId !== '0') {
    let nodes;
    try {
      nodes = await chrome.bookmarks.get(currentId);
    } catch (error) {
      break;
    }
    const node = nodes && nodes[0];
    if (!node) break;

    if (node.title) {
      parts.unshift(node.title);
    }

    if (node.parentId === '0') break;
    currentId = node.parentId;
  }

  const path = parts.join(PATH_SEPARATOR);
  if (cache) cache.set(id, path);
  return path;
}

function collectRemovedBookmarkIds(node, out) {
  if (!node) return;
  if (node.url && node.id) {
    out.push(String(node.id));
  }
  const children = node.children;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      collectRemovedBookmarkIds(children[i], out);
    }
  }
}

export function shouldFallbackRemovedEvent(removedIds, fallbackRemovedId, indexById) {
  const ids = Array.isArray(removedIds) ? removedIds : [];
  const fallbackId = typeof fallbackRemovedId === 'string' ? fallbackRemovedId : '';
  const index = indexById instanceof Map ? indexById : new Map();
  if (!fallbackId) return false;
  if (ids.length === 0) return !index.has(fallbackId);
  return ids.length === 1 && ids[0] === fallbackId && !index.has(fallbackId);
}

async function applyBookmarkEventsOnce(events) {
  log.info("开始增量处理书签事件: %d 条", Array.isArray(events) ? events.length : 0);

  await loadCacheFromStorage();

  const state = getRuntimeState();
  const bookmarks = state.bookmarks;
  const documents = state.documents;
  const indexById = state.bookmarkIndexById;
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return { success: true, applied: 0 };

  // 过大批次直接走全量刷新，避免长时间占用 service worker
  if (list.length > 200) {
    pendingRefresh = true;
    log.observe('incremental_fallback_full', { reason: 'batch_too_large', size: list.length });
    return { success: false, fallback: true };
  }

  // 只对"书签级别"的 create/change/move/remove 做增量；遇到 folder 级别的变更（changed/moved）
  // 或显式 forceRefresh/import 事件，直接走全量刷新，保证路径一致性。
  // 先收集本批次中新创建的书签 ID，避免 created→changed 同批次误判
  const createdIdsInBatch = new Set();
  for (let i = 0; i < list.length; i++) {
    const evt = list[i];
    if (evt && evt.type === 'created') {
      const node = evt.bookmark;
      const id = String(evt.id || (node && node.id) || '');
      if (id && node && node.url) createdIdsInBatch.add(id);
    }
  }

  for (let i = 0; i < list.length; i++) {
    const evt = list[i];
    const type = evt && evt.type;
    if (!type) continue;
    if (type === 'forceRefresh' || type === 'importBegan' || type === 'importEnded') {
      pendingRefresh = true;
      log.observe('incremental_fallback_full', { reason: type });
      return { success: false, fallback: true };
    }
    if (type === 'changed' || type === 'moved') {
      const id = String(evt.id || '');
      // 允许本批次新创建的书签被修改/移动
      if (!id || (!indexById.has(id) && !createdIdsInBatch.has(id))) {
        pendingRefresh = true;
        log.observe('incremental_fallback_full', { reason: type + '_without_baseline', id });
        return { success: false, fallback: true };
      }
    }
  }

  const folderPathCache = new Map();
  // 预加载所有文件夹路径，避免后续 N+1 查询
  await preloadFolderPaths(folderPathCache);

  // 构建 docId → documents 数组索引的映射，避免 findIndex O(n) 扫描
  const docIndexById = new Map();
  for (let di = 0; di < documents.length; di++) {
    const doc = documents[di];
    if (doc && doc.id) docIndexById.set(doc.id, di);
  }

  const changes = [];
  let mutated = false;
  const removedDocIds = new Set();
  const upsertedDocs = []; // 增量 IDB 写入：新增或修改的 document
  const now = Date.now;

  for (let i = 0; i < list.length; i++) {
    const evt = list[i];
    const type = evt && evt.type;
    if (!type) continue;

    if (type === 'created') {
      const node = evt.bookmark;
      if (!node || !node.url) continue; // folder created: ignore

      const id = String(evt.id || node.id || '');
      if (!id) continue;

      const title = node.title || '';
      const url = node.url || '';
      const path = await getFolderPath(node.parentId, folderPathCache);

      if (indexById.has(id)) continue;

      const item = {
        id,
        title,
        url,
        path,
        dateAdded: node.dateAdded
      };
      const newDoc = mapBookmarkToSearchDocument(item);
      documents.push(newDoc);
      if (newDoc && newDoc.id) {
        docIndexById.set(newDoc.id, documents.length - 1);
        upsertedDocs.push(newDoc);
      }
      // 同步更新 bookmarks + indexById，供同批次后续 changed/moved 事件查找
      bookmarks.push(item);
      indexById.set(id, bookmarks.length - 1);
      mutated = true;
      changes.push({
        action: HISTORY_ACTIONS.ADD,
        title,
        url,
        path,
        timestamp: now()
      });
      continue;
    }

    if (type === 'changed') {
      const id = String(evt.id || '');
      const idx = indexById.get(id);
      if (idx === undefined) continue;

      const item = bookmarks[idx];
      if (!item) continue;

      const changeInfo = evt.changeInfo && typeof evt.changeInfo === 'object' ? evt.changeInfo : {};
      const nextTitle = changeInfo.title !== undefined ? (changeInfo.title || '') : (item.title || '');
      const nextUrl = changeInfo.url !== undefined ? (changeInfo.url || '') : (item.url || '');

      if (nextTitle === item.title && nextUrl === item.url) continue;

      const oldTitle = item.title || '';
      const oldUrl = item.url || '';
      item.title = nextTitle;
      item.url = nextUrl;
      const docId = `${DOCUMENT_SOURCE_TYPE}:${id}`;
      const docIdx = docIndexById.get(docId);
      if (docIdx !== undefined && documents[docIdx]) {
        const path = Array.isArray(documents[docIdx].path) ? documents[docIdx].path : [];
        documents[docIdx] = {
          ...documents[docIdx],
          title: nextTitle,
          subtitle: path.join(PATH_SEPARATOR),
          url: nextUrl,
          iconKey: nextUrl
        };
        upsertedDocs.push(documents[docIdx]);
      }
      mutated = true;
      changes.push({
        action: HISTORY_ACTIONS.EDIT,
        oldTitle,
        title: nextTitle,
        oldUrl,
        url: nextUrl,
        path: item.path || '',
        timestamp: now()
      });
      continue;
    }

    if (type === 'moved') {
      const id = String(evt.id || '');
      const idx = indexById.get(id);
      if (idx === undefined) continue;

      const item = bookmarks[idx];
      if (!item) continue;

      const moveInfo = evt.moveInfo && typeof evt.moveInfo === 'object' ? evt.moveInfo : {};
      const nextPath = await getFolderPath(moveInfo.parentId, folderPathCache);
      const oldPath = item.path || '';

      if (nextPath === oldPath) continue;

      item.path = nextPath;
      const docId = `${DOCUMENT_SOURCE_TYPE}:${id}`;
      const docIdx = docIndexById.get(docId);
      if (docIdx !== undefined && documents[docIdx]) {
        const nextPathParts = typeof nextPath === 'string' && nextPath
          ? nextPath.split(PATH_SEPARATOR).map((part) => part.trim()).filter(Boolean)
          : [];
        documents[docIdx] = {
          ...documents[docIdx],
          path: nextPathParts,
          subtitle: nextPathParts.join(PATH_SEPARATOR)
        };
        upsertedDocs.push(documents[docIdx]);
      }
      mutated = true;
      changes.push({
        action: HISTORY_ACTIONS.MOVE,
        title: item.title || '',
        url: item.url || '',
        oldPath,
        newPath: nextPath,
        timestamp: now()
      });
      continue;
    }

    if (type === 'removed') {
      const removeInfo = evt.removeInfo && typeof evt.removeInfo === 'object' ? evt.removeInfo : {};
      const node = removeInfo.node;
      const removedIds = [];
      collectRemovedBookmarkIds(node, removedIds);

      // 兜底：某些场景 removeInfo.node 不完整时，至少删除当前事件 ID
      const fallbackRemovedId = String(evt.id || '');
      if (fallbackRemovedId && removedIds.indexOf(fallbackRemovedId) === -1) {
        removedIds.push(fallbackRemovedId);
      }

      if (shouldFallbackRemovedEvent(removedIds, fallbackRemovedId, indexById)) {
        pendingRefresh = true;
        log.observe('incremental_fallback_full', { reason: 'removed_without_subtree', id: fallbackRemovedId });
        return { success: false, fallback: true };
      }

      for (let j = 0; j < removedIds.length; j++) {
        const removedId = removedIds[j];
        const idx = indexById.get(removedId);
        if (idx === undefined) continue;

        const item = bookmarks[idx];
        if (!item) continue;

        // 标记为 null，不在循环中 splice documents（避免索引漂移）
        bookmarks[idx] = null;
        indexById.delete(removedId);
        removedDocIds.add(`${DOCUMENT_SOURCE_TYPE}:${removedId}`);
        mutated = true;

        changes.push({
          action: HISTORY_ACTIONS.DELETE,
          title: item.title || '',
          url: item.url || '',
          folder: item.path || '',
          timestamp: now()
        });
      }
    }
  }

  if (!mutated) {
    return { success: true, applied: 0 };
  }

  // 统一从 documents 重建运行时状态，确保 documents/bookmarks/index 三者一致
  let finalDocuments = documents;
  if (removedDocIds.size > 0) {
    finalDocuments = documents.filter((doc) => doc && !removedDocIds.has(doc.id));
  }
  setRuntimeDocuments(finalDocuments);
  rebuildBookmarkIndex();

  const finalCount = getRuntimeDocuments().length;

  updateHistory(changes);

  // 增量 IDB 写入：只 put 变化的 document，delete 被删除的 document
  const syncTime = Date.now();
  const deleteDocIds = removedDocIds.size > 0 ? Array.from(removedDocIds) : [];
  try {
    await idbPatchDocuments(upsertedDocs, deleteDocIds);
  } catch (error) {
    log.warn('incremental_idb_patch_failed, fallback to full replace', { message: error && error.message ? error.message : String(error) });
    // 回退到全量写入
    const fullOk = await writeDocumentsWithRetry();
    if (!fullOk) {
      return { success: false, error: '持久化书签缓存失败', degraded: true, source: 'documents_failed' };
    }
  }

  // 更新 storage 元数据（count/history/syncTime/meta）
  const meta = buildCacheMetaFromCount(finalCount, syncTime);
  const storageOk = await writeStorageMetadataWithRetry(meta, { history: bookmarkHistory });

  if (!storageOk) {
    return { success: false, error: '持久化元数据失败', degraded: true, source: 'storage_meta_failed' };
  }

  return { success: true, count: finalCount, changes: changes.length, incremental: true };
}

async function loadCacheFromStorage() {
  if (isCacheLoaded) return;
  if (loadCachePromise) return loadCachePromise;
  loadCachePromise = loadCacheFromStorageOnce();
  try { await loadCachePromise; } finally { loadCachePromise = null; }
}

async function loadCacheFromStorageOnce() {
  let idbRecentOpenedRoots;
  try {
    idbRecentOpenedRoots = await idbGet(IDB_KEY_RECENT_OPENED_ROOTS);
  } catch (error) {
    log.warn("从 IndexedDB 读取最近打开域名快照失败:", error);
  }

  // chrome.storage.local: only metadata + history (no full bookmark list)
  const storageRead = await getStorageWithStatus([
    STORAGE_KEYS.BOOKMARK_HISTORY,
    STORAGE_KEYS.LAST_SYNC_TIME,
    STORAGE_KEYS.BOOKMARKS_META
  ]);
  const storageData = storageRead.data || {};

  const storageHistoryRaw = storageData[STORAGE_KEYS.BOOKMARK_HISTORY];
  const storageHistory = Array.isArray(storageHistoryRaw) ? storageHistoryRaw : [];

  let documents = [];
  try {
    documents = await readPersistedDocuments();
  } catch (error) {
    log.warn('documents_load_failed', { message: error && error.message ? error.message : String(error) });
  }

  if (documents.length > 0) {
    setRuntimeDocuments(documents);
    log.observe('cache_source_selected', { source: 'documents', count: documents.length });
  } else {
    setRuntimeDocuments([]);
    log.observe('cache_source_selected', { source: 'empty', count: 0 });
  }

  const storedMeta = normalizeCacheMeta(storageData[STORAGE_KEYS.BOOKMARKS_META]);

  // 初始化 lastSyncTime 内存缓存
  const storedLastSync = storageData[STORAGE_KEYS.LAST_SYNC_TIME];
  if (typeof storedLastSync === 'number' && Number.isFinite(storedLastSync) && storedLastSync > 0) {
    runtimeLastSyncTime = storedLastSync;
  } else if (storedMeta.updatedAt > 0) {
    runtimeLastSyncTime = storedMeta.updatedAt;
  } else {
    runtimeLastSyncTime = null;
  }

  if (!storageRead.success && storageRead.state && storageRead.state[STORAGE_KEYS.BOOKMARK_HISTORY] === 'failed') {
    log.warn('history_load_failed_keep_memory', { error: storageRead.error || 'unknown' });
  } else {
    bookmarkHistory = storageHistory;
  }
  // Restore recently opened roots snapshot (warmup prioritization)
  try {
    restoreRecentOpenedRootsFromSnapshot(idbRecentOpenedRoots);
  } catch (e) {
    // best-effort only
  }
  rebuildBookmarkIndex();
  isCacheLoaded = true;
}

async function ensureCacheConsistency(syncTime) {
  const documents = getRuntimeDocuments();
  const meta = buildCacheMetaFromCount(documents.length, syncTime);

  // Phase 2: documents are the primary persistent source; legacy bookmark kv is no longer backfilled.
  let needBackfillDocuments = false;
  try {
    const persistedDocuments = await readPersistedDocuments();
    // 使用缓存的 runtime fingerprint，避免重复计算
    const persistedFp = getDocumentsFingerprint(persistedDocuments);
    needBackfillDocuments = persistedFp !== runtimeDocumentsFingerprint;
  } catch (error) {
    needBackfillDocuments = true;
  }

  // Check storage meta/history consistency — backfill when any mirror drifted or read failed.
  const storageRead = await getStorageWithStatus([
    STORAGE_KEYS.BOOKMARKS_META,
    STORAGE_KEYS.BOOKMARK_COUNT,
    STORAGE_KEYS.LAST_SYNC_TIME,
    STORAGE_KEYS.BOOKMARK_HISTORY
  ]);
  const needUpdateStorageMeta = needsStorageMetadataRepair(storageRead, meta, bookmarkHistory);

  if (!needBackfillDocuments && !needUpdateStorageMeta) {
    return;
  }

  log.observe('consistency_check_backfill', { needBackfillDocuments, needUpdateStorageMeta, updatedAt: meta.updatedAt, count: meta.count });

  const tasks = [];
  if (needBackfillDocuments) {
    tasks.push(
      idbReplaceDocuments(documents).catch((error) => {
        log.warn('consistency_backfill_failed', { target: 'documents', message: error && error.message ? error.message : String(error) });
      })
    );
  }

  if (needUpdateStorageMeta) {
    tasks.push(
      writeStorageMetadataWithRetry(meta, { history: bookmarkHistory }).then((ok) => {
        if (!ok) {
          log.warn('consistency_backfill_failed', { target: 'storage_meta', message: 'setStorage returned false' });
        }
      }).catch((error) => {
        log.warn('consistency_backfill_failed', { target: 'storage_meta', message: error && error.message ? error.message : String(error) });
      })
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

export function mergeBookmarkHistory(existingHistory, changes, maxItems = MAX_HISTORY_ITEMS) {
  const existing = Array.isArray(existingHistory) ? existingHistory : [];
  const incoming = Array.isArray(changes) ? changes.filter(Boolean) : [];
  const limit = (typeof maxItems === 'number' && Number.isFinite(maxItems) && maxItems > 0)
    ? Math.floor(maxItems)
    : MAX_HISTORY_ITEMS;

  return [...incoming, ...existing].slice(0, limit);
}

/**
 * 更新历史记录
 * 直接合并到内存中的 bookmarkHistory，由后续 saveToStorage 统一持久化。
 * bookmarkHistory 在 loadCacheFromStorageOnce 中从 storage 加载，之后只通过内存维护。
 * @param {Array} changes - 新变更
 */
function updateHistory(changes) {
  bookmarkHistory = mergeBookmarkHistory(bookmarkHistory, changes);
}

function waitForDelay(ms) {
  const delayMs = (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) ? ms : 0;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildStorageMetadataPayload(meta, historySnapshot = bookmarkHistory) {
  return {
    [STORAGE_KEYS.BOOKMARK_COUNT]: meta.count,
    [STORAGE_KEYS.BOOKMARK_HISTORY]: normalizeHistoryList(historySnapshot),
    [STORAGE_KEYS.LAST_SYNC_TIME]: meta.updatedAt,
    [STORAGE_KEYS.BOOKMARKS_META]: meta
  };
}

export function needsStorageMetadataRepair(storageRead, meta, historySnapshot = bookmarkHistory) {
  const expectedMeta = normalizeCacheMeta(meta);
  const expectedHistory = normalizeHistoryList(historySnapshot);

  if (!storageRead || !storageRead.success || !storageRead.data) {
    return true;
  }

  const data = storageRead.data || {};
  const state = storageRead.state && typeof storageRead.state === 'object' ? storageRead.state : {};
  const trackedKeys = [
    STORAGE_KEYS.BOOKMARKS_META,
    STORAGE_KEYS.BOOKMARK_COUNT,
    STORAGE_KEYS.LAST_SYNC_TIME,
    STORAGE_KEYS.BOOKMARK_HISTORY
  ];

  for (let i = 0; i < trackedKeys.length; i++) {
    if (state[trackedKeys[i]] === 'failed') return true;
  }

  const storedMeta = normalizeCacheMeta(data[STORAGE_KEYS.BOOKMARKS_META]);
  if (storedMeta.updatedAt !== expectedMeta.updatedAt || storedMeta.count !== expectedMeta.count) {
    return true;
  }

  const storedCountRaw = data[STORAGE_KEYS.BOOKMARK_COUNT];
  const storedCount = (typeof storedCountRaw === 'number' && Number.isFinite(storedCountRaw) && storedCountRaw >= 0)
    ? Math.floor(storedCountRaw)
    : 0;
  if (storedCount !== expectedMeta.count) {
    return true;
  }

  if (normalizeLastSyncValue(data[STORAGE_KEYS.LAST_SYNC_TIME]) !== normalizeLastSyncValue(expectedMeta.updatedAt)) {
    return true;
  }

  if (getHistorySignature(data[STORAGE_KEYS.BOOKMARK_HISTORY]) !== getHistorySignature(expectedHistory)) {
    return true;
  }

  return false;
}

export async function writeStorageMetadataWithRetry(meta, options = {}) {
  const expectedMeta = normalizeCacheMeta(meta);
  const retryDelayMs = (typeof options.retryDelayMs === 'number' && Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0)
    ? options.retryDelayMs
    : STORAGE_METADATA_RETRY_DELAY_MS;
  const payload = buildStorageMetadataPayload(expectedMeta, options.history);

  let storageOk = await setStorage(payload);
  if (!storageOk) {
    await waitForDelay(retryDelayMs);
    storageOk = await setStorage(payload);
  }

  if (!storageOk) {
    return false;
  }

  runtimeLastSyncTime = expectedMeta.updatedAt;
  return true;
}

/**
 * 保存到存储
 * IDB: `documents` is now the primary bookmark persistence.
 * chrome.storage.local: metadata only (count/history/syncTime/meta).
 * Legacy `cachedBookmarks` kv is no longer written in Phase 2.
 */
async function writeDocumentsWithRetry() {
  try {
    await persistSearchDocuments();
    return true;
  } catch (error) {
    log.warn("写入 IndexedDB documents 失败，500ms 后重试:", error);
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      persistSearchDocuments()
        .then(() => { resolve(true); })
        .catch((retryErr) => {
          log.warn("IndexedDB documents 重试仍失败:", retryErr);
          resolve(false);
        });
    }, 500);
  });
}

async function saveToStorage(syncTime) {
  const documents = getRuntimeDocuments();
  const meta = buildCacheMetaFromCount(documents.length, syncTime);

  const idbOk = await writeDocumentsWithRetry();
  if (!idbOk) {
    log.warn('cache_write_degraded', { source: 'documents_failed', updatedAt: meta.updatedAt, count: meta.count });
    return { success: false, degraded: true, source: 'documents_failed' };
  }

  const storageOk = await writeStorageMetadataWithRetry(meta, { history: bookmarkHistory });

  if (!storageOk) {
    log.warn('cache_write_degraded', { source: 'storage_meta_failed', updatedAt: meta.updatedAt, count: meta.count });
    return { success: false, degraded: true, source: 'storage_meta_failed' };
  }

  return { success: true };
}

/**
 * 加载初始数据
 */
export async function loadInitialData(options = {}) {
  const skipInitialRefresh = !!(options && options.skipInitialRefresh);
  await loadCacheFromStorage();

  const runtimeDocuments = getRuntimeDocuments();
  if (runtimeDocuments.length > 0) {
    log.info("已加载缓存书签: %d 条", runtimeDocuments.length);
  } else if (skipInitialRefresh) {
    log.info("初始缓存为空，等待迁移后的显式重建");
  } else {
    // 如果没有缓存，立即刷新一次
    await refreshBookmarks();
  }
  
  log.info("已加载历史记录: %d 条", bookmarkHistory.length);
}

/**
 * Search bookmarks from the cached, flattened list (preferred).
 * Falls back to `chrome.bookmarks.search` if cache is empty.
 */
export async function searchBookmarks(query, { limit = 10 } = {}) {
  await loadCacheFromStorage();

  // 使用内存缓存的 lastSyncTime 和 ttl，避免每次搜索都读 storage
  const lastSync = runtimeLastSyncTime;
  const ttlMinutes = runtimeCacheTtlLoaded && typeof runtimeCacheTtlMinutes === 'number' && runtimeCacheTtlMinutes > 0
    ? runtimeCacheTtlMinutes
    : await ensureRuntimeCacheTtlMinutes();
  const ttlMs = ttlMinutes * 60 * 1000 || BOOKMARK_CACHE_TTL_DEFAULT_MS;

  if (typeof lastSync === 'number' && lastSync > 0 && (Date.now() - lastSync) > ttlMs) {
    // 不阻塞当前搜索：异步触发刷新，避免用户感知延迟
    maybeScheduleStaleRefresh();
  }

  const documents = getRuntimeDocuments();
  if (documents.length > 0) {
    return searchDocuments(documents, query, limit);
  }

  await ensureRuntimeDocumentsAvailable();
  const hydratedDocuments = getRuntimeDocuments();
  if (hydratedDocuments.length > 0) {
    return searchDocuments(hydratedDocuments, query, limit);
  }

  // No cache yet (first run / storage cleared / IDB failure): fall back to the native API.
  try {
    const nodes = await chrome.bookmarks.search(String(query || '').trim());
    const results = (nodes || [])
      .filter((node) => node && node.url)
      .slice(0, limit)
      .map((node) => ({
        id: node.id,
        title: node.title || '',
        url: node.url || '',
        path: '',
        dateAdded: node.dateAdded
      }));

    // Best-effort: warm cache in the background for the next search.
    refreshBookmarks().catch(() => {});

    return results;
  } catch (error) {
    return [];
  }
}

/**
 * Provide a compact map for favicon warmup: favicon key -> sample page URL.
 * Used by content scripts so they don't have to keep a full bookmark copy in chrome.storage.local.
 */
export async function getWarmupDomainMap({ limit = 400 } = {}) {
  await loadCacheFromStorage();

  const documents = await ensureRuntimeDocumentsAvailable();
  const max = (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) ? Math.floor(limit) : 400;
  const output = Object.create(null);
  let count = 0;
  const nowTs = Date.now();

  // 清理最近 warmup 记录中过期的项目
  const warmupCutoff = nowTs - RECENT_WARMUP_WINDOW_MS;
  for (const [root, ts] of recentWarmupDomains.entries()) {
    if (typeof ts !== 'number' || ts < warmupCutoff) {
      recentWarmupDomains.delete(root);
    }
  }

  // 1) 最近实际打开过的 favicon key（根据 recordBookmarkOpen 记录），按最近打开时间排序
  if (recentOpenedRootMap.size > 0 && count < max) {
    const openedEntries = Array.from(recentOpenedRootMap.entries())
      .slice()
      .sort((a, b) => {
        const av = a[1] && typeof a[1].lastAt === 'number' ? a[1].lastAt : 0;
        const bv = b[1] && typeof b[1].lastAt === 'number' ? b[1].lastAt : 0;
        return bv - av;
      });
    for (let i = 0; i < openedEntries.length && count < max; i++) {
      const root = openedEntries[i][0];
      const info = openedEntries[i][1] || {};
      if (!root || output[root]) continue;
      if (recentWarmupDomains.has(root)) continue;
      const sampleUrl = typeof info.sampleUrl === 'string' && info.sampleUrl ? info.sampleUrl : getWarmupFallbackSampleUrl(root);
      output[root] = sampleUrl;
      recentWarmupDomains.set(root, nowTs);
      count++;
    }
  }

  // 预构建 faviconKey → sampleUrl 索引，避免后续步骤中对 documents 的 O(n) 嵌套扫描
  const docKeyToSampleUrl = Object.create(null);
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (!doc || !doc.url) continue;
    const rawUrl = String(doc.url || '').trim();
    if (!rawUrl) continue;
    try {
      const u = new URL(rawUrl);
      const key = buildFaviconServiceKey(u.href || rawUrl);
      if (key && !docKeyToSampleUrl[key]) {
        docKeyToSampleUrl[key] = u.href || getWarmupFallbackSampleUrl(key);
      }
    } catch (e) {}
  }

  // 2) 根据 bookmarkHistory 中最近的变更记录统计高频 favicon key
  if (Array.isArray(bookmarkHistory) && bookmarkHistory.length > 0 && count < max) {
    const freq = Object.create(null);
    const recent = bookmarkHistory.slice(0, MAX_HISTORY_ITEMS);
    for (let i = 0; i < recent.length; i++) {
      const item = recent[i];
      if (!item || typeof item.url !== 'string') continue;
      const rawUrl = String(item.url || '').trim();
      if (!rawUrl) continue;
      try {
        const key = buildFaviconServiceKey(rawUrl);
        if (!key) continue;
        freq[key] = (freq[key] || 0) + 1;
      } catch (e) {}
    }

    const hotRoots = Object.keys(freq)
      .sort((a, b) => freq[b] - freq[a]);

    for (let i = 0; i < hotRoots.length && count < max; i++) {
      const root = hotRoots[i];
      if (!root || output[root]) continue;
      if (recentWarmupDomains.has(root)) continue;
      const sampleUrl = docKeyToSampleUrl[root] || getWarmupFallbackSampleUrl(root);
      output[root] = sampleUrl;
      recentWarmupDomains.set(root, nowTs);
      count++;
    }
  }

  // 3) 兜底：按预构建索引顺序填充剩余名额
  const allDocKeys = Object.keys(docKeyToSampleUrl);
  for (let i = 0; i < allDocKeys.length && count < max; i++) {
    const root = allDocKeys[i];
    if (output[root]) continue;
    if (recentWarmupDomains.has(root)) continue;
    output[root] = docKeyToSampleUrl[root];
    recentWarmupDomains.set(root, nowTs);
    count++;
  }

  return output;
}

/**
 * 清空历史记录（同时清除内存和存储）
 */
export async function clearHistory() {
  pendingClearHistory = true;

  const completion = new Promise((resolve, reject) => {
    clearHistoryWaiters.push({ resolve, reject });
  });

  if (isUpdating) {
    updateQueued = true;
    return completion;
  }

  runUpdateLoop().catch((error) => {
    rejectClearHistoryWaiters(error);
  });

  return completion;
}

async function clearHistoryOnce() {
  const previousHistory = Array.isArray(bookmarkHistory) ? bookmarkHistory.slice() : [];
  bookmarkHistory = [];
  try {
    await setStorageOrThrow({ [STORAGE_KEYS.BOOKMARK_HISTORY]: [] });
  } catch (error) {
    bookmarkHistory = previousHistory;
    throw error;
  }
  log.info("历史记录已清空");
  return { success: true };
}

export function __resetBackgroundDataForTests() {
  bookmarkHistory = [];
  isUpdating = false;
  updateQueued = false;
  pendingRefresh = false;
  pendingBookmarkEvents = [];
  pendingClearHistory = false;
  isCacheLoaded = false;
  loadCachePromise = null;
  lastStaleRefreshAt = 0;
  runtimeCacheTtlMinutes = null;
  runtimeCacheTtlLoaded = false;
  runtimeLastSyncTime = null;
  clearHistoryWaiters = [];
  recentOpenedRootMap.clear();
  recentWarmupDomains.clear();
  recentOpenedRootsPersistChain = Promise.resolve();
  setRuntimeDocuments([]);
  rebuildBookmarkIndex();
}

export function __getBackgroundDataInternalsForTests() {
  return {
    runtimeLastSyncTime,
    bookmarkHistory: Array.isArray(bookmarkHistory) ? bookmarkHistory.slice() : []
  };
}

function resolveClearHistoryWaiters(result) {
  if (clearHistoryWaiters.length === 0) return;
  const waiters = clearHistoryWaiters;
  clearHistoryWaiters = [];
  for (let i = 0; i < waiters.length; i++) {
    waiters[i].resolve(result);
  }
}

function rejectClearHistoryWaiters(error) {
  if (clearHistoryWaiters.length === 0) return;
  const waiters = clearHistoryWaiters;
  clearHistoryWaiters = [];
  for (let i = 0; i < waiters.length; i++) {
    waiters[i].reject(error);
  }
}
