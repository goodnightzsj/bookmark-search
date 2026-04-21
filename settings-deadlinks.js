/**
 * 死链检测（按需触发）：
 * - 用户点击"检测失效链接"时请求 <all_urls> 可选 host permission
 * - 获得授权后，遍历所有书签，用 HEAD 请求 + 8s 超时，并发 3
 * - 网络错误 / 4xx / 5xx 标记为"可能失效"
 * - 结果显示在独立 modal，内置滚动 + 单条"打开"跳转
 *
 * 误判率约 10%（某些站点屏蔽 HEAD / 反爬），UI 提示人工确认后再删。
 */

import { MESSAGE_ACTIONS } from './constants.js';
import { assertSuccessfulMessageResponse } from './message-response.js';
import { openResultModal } from './bs-result-modal.js';
import { formatRelativeTime } from './utils.js';

// SW 侧 fetch 放开并发瓶颈后提速；zigzag 按 host 分散保证单站仍温和
const CONCURRENCY = 8;
const TIMEOUT_MS = 8000;

const CACHE_KEY = 'settings.deadlinksCache.v1';

async function loadDlCache() {
  try {
    const r = await chrome.storage.local.get(CACHE_KEY);
    const raw = r && r[CACHE_KEY];
    if (!raw || typeof raw !== 'object') return null;
    if (!Array.isArray(raw.results)) return null;
    if (typeof raw.scannedAt !== 'number') return null;
    return raw;
  } catch (e) { return null; }
}

async function saveDlCache(results, scannedAt) {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: {
        scannedAt: typeof scannedAt === 'number' ? scannedAt : Date.now(),
        results: Array.isArray(results) ? results : []
      }
    });
  } catch (e) {}
}

function notifySettings(message, type = 'success') {
  try {
    if (typeof window !== 'undefined' && typeof window.__bsShowToast === 'function') {
      window.__bsShowToast(message, { type });
    }
  } catch (e) {}
}

function escapeHtml(text) {
  const s = String(text == null ? '' : text);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function flattenBookmarks(nodes, acc) {
  for (const node of nodes) {
    if (!node) continue;
    if (node.url) {
      if (/^https?:\/\//i.test(node.url)) {
        acc.push({ id: node.id, title: node.title || '', url: node.url });
      }
    }
    if (node.children) flattenBookmarks(node.children, acc);
  }
}

/**
 * 委托给 service worker 做 HEAD 探测。
 * 原因：在 settings 页直接 fetch 时，目标站响应头里若带
 * `Link: <...>; rel=modulepreload`，Chrome 会在扩展页上下文里预加载那些
 * JS chunk，触发扩展页默认 CSP `script-src 'self'` 的拦截，污染
 * chrome://extensions 的错误面板。SW 的 fetch 不会处理 modulepreload 头。
 */
async function fetchWithTimeout(url, timeoutMs) {
  try {
    const resp = await chrome.runtime.sendMessage({
      action: MESSAGE_ACTIONS.PROBE_URL_REACHABILITY,
      url,
      timeoutMs
    });
    if (!resp || resp.success === false) {
      const err = (resp && resp.error && resp.error.message) || 'probe failed';
      return { ok: false, status: 0, error: err };
    }
    return { ok: !!resp.ok, status: Number(resp.status) || 0, error: resp.error };
  } catch (e) {
    return { ok: false, status: 0, error: e && e.message ? e.message : String(e) };
  }
}

function classify(result) {
  // 只有明确证据才判 dead：状态码 404 / 410（页面已删除 / 永久消失）。
  // 其它异常（网络错 / 5xx / 403 / 超时）一律 suspect，让用户人工确认。
  // 之前把 status=0 和 5xx 都判 dead 是主要误判源。
  if (!result) return { level: 'suspect', reason: '未知' };
  if (result.ok) return { level: 'ok', reason: 'OK' };
  const st = result.status;
  if (st === 404 || st === 410) return { level: 'dead', reason: `HTTP ${st}` };
  if (st === 0) return { level: 'suspect', reason: result.error || '网络错误/超时' };
  if (st === 401) return { level: 'suspect', reason: 'HTTP 401（需鉴权）' };
  if (st === 403) return { level: 'suspect', reason: 'HTTP 403（可能反爬）' };
  if (st === 405) return { level: 'suspect', reason: 'HTTP 405（方法不允许）' };
  if (st === 429) return { level: 'suspect', reason: 'HTTP 429（限流）' };
  if (st >= 500 && st < 600) return { level: 'suspect', reason: `HTTP ${st}（服务端异常）` };
  if (st >= 400) return { level: 'suspect', reason: `HTTP ${st}` };
  return { level: 'suspect', reason: `HTTP ${st}` };
}

function getHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

async function runBatch(bookmarks, onProgress, resultsHolder) {
  let done = 0;
  const total = bookmarks.length;
  const hostCache = new Map();

  function updateProgress() {
    if (typeof onProgress === 'function') onProgress(done, total);
  }

  async function worker(queue) {
    while (queue.length > 0) {
      const bm = queue.shift();
      if (!bm) continue;
      const host = getHost(bm.url);
      let klass;
      // 同 host 缓存：**仅**对"网络完全不可达"（status=0 且非 timeout）复用，
      // 这是 host 级别问题（DNS / 证书 / 连接拒绝），确实适用整站所有路径。
      // 原先把 HTTP 404/5xx 按 host 缓存是错的：404 是路径级，5xx 可能瞬时。
      const cached = host ? hostCache.get(host) : null;
      if (cached) {
        klass = { level: cached.level, reason: cached.reason + '（同站缓存）' };
      } else {
        const res = await fetchWithTimeout(bm.url, TIMEOUT_MS);
        klass = classify(res);
        const isHostLevelNetFail = res && res.status === 0
          && res.error
          && res.error !== 'timeout'; // timeout 不一定是整站问题，可能某条路径慢
        if (host && isHostLevelNetFail) hostCache.set(host, klass);
      }
      resultsHolder.push({
        id: bm.id,
        title: bm.title,
        url: bm.url,
        level: klass.level,
        reason: klass.reason
      });
      done++;
      if (done % 2 === 0 || done === total) updateProgress();
    }
  }

  updateProgress();
  // zigzag：按 host 分组后轮询出队，同 host 不连续，避免 3 worker 同时打一个站
  const byHost = new Map();
  for (const bm of bookmarks) {
    const h = getHost(bm.url);
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(bm);
  }
  const groups = Array.from(byHost.values());
  let maxLen = 0;
  for (const g of groups) if (g.length > maxLen) maxLen = g.length;
  const queue = [];
  for (let i = 0; i < maxLen; i++) {
    for (const g of groups) if (i < g.length) queue.push(g[i]);
  }
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
    workers.push(worker(queue));
  }
  await Promise.all(workers);
}

// Modal context
let modalRef = null;

function renderResults(results, scannedAt) {
  if (!modalRef || !modalRef.isOpen()) return;
  const { bodyEl, actionsEl, setSubtitle } = modalRef;

  const dead = results.filter((r) => r.level === 'dead');
  const suspect = results.filter((r) => r.level === 'suspect');
  const ok = results.filter((r) => r.level === 'ok');

  const stamp = typeof scannedAt === 'number' && scannedAt > 0
    ? `<br><span class="bs-scan-stamp">上次检测：${formatRelativeTime(scannedAt, { showFullDate: false })}</span>`
    : '';

  setSubtitle(`共 <strong>${results.length}</strong> 条；疑似失效 <strong style="color:#dc2626">${dead.length}</strong> · 状态可疑 <strong style="color:#d97706">${suspect.length}</strong> · 正常 <strong>${ok.length}</strong>。误判率约 10%，请人工确认再删。${stamp}`);

  const problematic = dead.concat(suspect);
  if (problematic.length === 0) {
    actionsEl.innerHTML = '<button class="btn btn-secondary btn-sm bs-rescan-btn" id="dlRescan" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg><span>重新检测</span></button>';
    bodyEl.innerHTML = '<div class="bs-empty-state">没有发现疑似失效的链接 🎉</div>';
    wireDlRescan(actionsEl);
    return;
  }

  actionsEl.innerHTML = `
    <button class="btn btn-secondary btn-sm bs-rescan-btn" id="dlRescan" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg><span>重新检测</span></button>
    <span class="bs-action-divider"></span>
    <button class="btn btn-secondary btn-sm" id="dlSelectDead" type="button">选中所有疑似失效</button>
    <button class="btn btn-secondary btn-sm" id="dlSelectNone" type="button">全不选</button>
    <span class="bs-result-modal-action-sep"></span>
    <span class="duplicates-selected-count" id="dlSelectedCount">已选 0 条</span>
    <button class="btn btn-primary btn-sm" id="dlDeleteSelected" type="button">删除选中</button>
  `;

  const list = document.createElement('div');
  list.className = 'duplicates-list';

  problematic.forEach((r) => {
    const isDead = r.level === 'dead';
    const row = document.createElement('div');
    row.className = 'duplicates-item' + (isDead ? ' is-selected' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-pressed', isDead ? 'true' : 'false');
    row.dataset.bookmarkId = String(r.id || '');
    row.dataset.selected = isDead ? '1' : '0';
    row.dataset.level = r.level || '';
    row.dataset.url = String(r.url || '');
    const levelLabel = isDead ? '失效' : '可疑';
    const levelCls = isDead ? 'is-dead' : 'is-suspect';
    row.innerHTML = `
      <div class="duplicates-item-body">
        <div class="duplicates-item-title">${escapeHtml(r.title || '(无标题)')}</div>
        <div class="duplicates-item-meta">
          <span class="bs-status-badge ${levelCls}">${levelLabel}</span>
          <span class="duplicates-item-reason">${escapeHtml(r.reason)}</span>
        </div>
        <div class="duplicates-item-url" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</div>
      </div>
      <button type="button" class="duplicates-open-link" data-url="${escapeHtml(r.url)}" title="在新标签页打开" aria-label="在新标签页打开">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
        <span>打开</span>
      </button>
    `;
    list.appendChild(row);
  });

  bodyEl.innerHTML = '';
  bodyEl.appendChild(list);

  wireDeadlinkActions(bodyEl, actionsEl);
  wireDlRescan(actionsEl);
  updateDlCount(bodyEl, actionsEl);
}

function wireDlRescan(actionsEl) {
  const btn = actionsEl.querySelector('#dlRescan');
  if (btn) btn.addEventListener('click', () => runDeadLinkCheck());
}

function getDlRows(bodyEl) {
  return Array.from(bodyEl.querySelectorAll('.duplicates-item'));
}

function setDlRowSelected(row, selected) {
  if (!row) return;
  const on = !!selected;
  row.classList.toggle('is-selected', on);
  row.dataset.selected = on ? '1' : '0';
  row.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function updateDlCount(bodyEl, actionsEl) {
  const el = actionsEl.querySelector('#dlSelectedCount');
  if (!el) return;
  const selected = getDlRows(bodyEl).filter((r) => r.dataset.selected === '1').length;
  el.textContent = `已选 ${selected} 条`;
}

function openBookmarkUrl(url) {
  try {
    if (chrome && chrome.tabs && typeof chrome.tabs.create === 'function') {
      chrome.tabs.create({ url, active: true });
      return;
    }
  } catch (e) {}
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) {}
}

// bodyEl 的 click/keydown 委托只绑一次，防止 cache 命中 + 重新检测造成
// 同一 listener 被重复注册，点击时互相抵消导致"点不动"
function ensureBodyDelegation(bodyEl, actionsEl) {
  if (bodyEl.dataset.bsDelegated === '1') return;
  bodyEl.dataset.bsDelegated = '1';
  bodyEl.addEventListener('click', (e) => {
    const openBtn = e.target.closest('.duplicates-open-link');
    if (openBtn) {
      e.stopPropagation();
      const url = openBtn.dataset.url;
      if (url) openBookmarkUrl(url);
      return;
    }
    const row = e.target.closest('.duplicates-item');
    if (!row || !bodyEl.contains(row)) return;
    setDlRowSelected(row, row.dataset.selected !== '1');
    updateDlCount(bodyEl, actionsEl);
  });
  bodyEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const openBtn = e.target.closest && e.target.closest('.duplicates-open-link');
    if (openBtn) {
      e.preventDefault();
      e.stopPropagation();
      const url = openBtn.dataset.url;
      if (url) openBookmarkUrl(url);
      return;
    }
    const row = e.target.closest && e.target.closest('.duplicates-item');
    if (!row || !bodyEl.contains(row)) return;
    e.preventDefault();
    setDlRowSelected(row, row.dataset.selected !== '1');
    updateDlCount(bodyEl, actionsEl);
  });
}

function wireDeadlinkActions(bodyEl, actionsEl) {
  ensureBodyDelegation(bodyEl, actionsEl);
  // actionsEl.innerHTML 每次渲染被替换，里面的按钮每次都要重新绑定
  const btnDead = actionsEl.querySelector('#dlSelectDead');
  if (btnDead) btnDead.addEventListener('click', () => {
    getDlRows(bodyEl).forEach((row) => setDlRowSelected(row, row.dataset.level === 'dead'));
    updateDlCount(bodyEl, actionsEl);
  });
  const btnNone = actionsEl.querySelector('#dlSelectNone');
  if (btnNone) btnNone.addEventListener('click', () => {
    getDlRows(bodyEl).forEach((row) => setDlRowSelected(row, false));
    updateDlCount(bodyEl, actionsEl);
  });
  const btnDelete = actionsEl.querySelector('#dlDeleteSelected');
  if (btnDelete) btnDelete.addEventListener('click', async () => {
    const rows = getDlRows(bodyEl).filter((r) => r.dataset.selected === '1');
    const ids = rows.map((r) => r.dataset.bookmarkId).filter(Boolean);
    if (ids.length === 0) {
      notifySettings('请先选中要删除的书签', 'warning');
      return;
    }
    const confirmed = await (window.__bsConfirm
      ? window.__bsConfirm(`确定删除选中的 ${ids.length} 条书签？`, { tone: 'danger', confirmText: '删除' })
      : Promise.resolve(confirm(`确定删除选中的 ${ids.length} 条书签？`)));
    if (!confirmed) return;
    try {
      const resp = assertSuccessfulMessageResponse(
        await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.DELETE_BOOKMARKS_BATCH, ids }),
        '批量删除失败'
      );
      notifySettings(`已删除 ${resp && resp.removed ? resp.removed : ids.length} 条`);
      rows.forEach((row) => row.remove());
      updateDlCount(bodyEl, actionsEl);
      // 同步更新缓存：移除已删 id，保留原 scannedAt（不重置）
      try {
        const cached = await loadDlCache();
        if (cached) {
          const removedSet = new Set(ids);
          const next = cached.results.filter((r) => !removedSet.has(String(r.id)));
          await saveDlCache(next, cached.scannedAt);
        }
      } catch (e) {}
    } catch (e) {
      notifySettings('删除失败：' + (e && e.message ? e.message : String(e)), 'error');
    }
  });
}

async function requestHostPermission() {
  try {
    const granted = await chrome.permissions.request({ origins: ['*://*/*'] });
    return !!granted;
  } catch (e) {
    return false;
  }
}

async function runDeadLinkCheck() {
  if (!modalRef || !modalRef.isOpen()) return;
  const setProgress = (text) => {
    modalRef.setSubtitle(text);
  };

  setProgress('准备中…');
  modalRef.actionsEl.innerHTML = '';
  modalRef.bodyEl.innerHTML = '<div class="bs-loading-state">正在请求网络访问权限…</div>';

  const granted = await requestHostPermission();
  if (!granted) {
    setProgress('未授权');
    modalRef.bodyEl.innerHTML = '<div class="bs-empty-state">需要授权"访问所有网站"权限才能检测链接状态。请点按钮重新尝试并在权限对话框中允许。</div>';
    return;
  }

  let tree;
  try {
    tree = await chrome.bookmarks.getTree();
  } catch (e) {
    notifySettings('读取书签失败：' + (e.message || String(e)), 'error');
    modalRef.bodyEl.innerHTML = '';
    return;
  }
  const flat = [];
  flattenBookmarks(tree, flat);
  if (flat.length === 0) {
    setProgress('没有可检测的书签');
    modalRef.bodyEl.innerHTML = '<div class="bs-empty-state">没有找到可检测的书签（仅检测 http/https）。</div>';
    return;
  }

  modalRef.bodyEl.innerHTML = '<div class="bs-loading-state" id="dlProgress">检测中 0/' + flat.length + ' (0%)</div>';
  const results = [];
  const started = Date.now();
  await runBatch(flat, (done, total) => {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const el = modalRef && modalRef.bodyEl ? modalRef.bodyEl.querySelector('#dlProgress') : null;
    if (el) el.textContent = `检测中 ${done}/${total} (${pct}%)`;
    setProgress(`检测中 ${done}/${total} (${pct}%)`);
  }, results);
  const ms = Date.now() - started;
  const now = Date.now();
  saveDlCache(results);
  renderResults(results, now);
  notifySettings(`检测完成：${flat.length} 条 / 用时 ${(ms / 1000).toFixed(1)}s`);
}

export function bindDeadlinkEvents() {
  const btn = document.getElementById('checkDeadLinks');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    modalRef = openResultModal({
      title: '失效链接检测',
      subtitle: '加载中…',
      onClose: () => { modalRef = null; }
    });
    // 先尝试缓存；无缓存再跑
    const cached = await loadDlCache();
    if (cached) {
      renderResults(cached.results, cached.scannedAt);
      return;
    }
    btn.disabled = true;
    const label = btn.querySelector('.btn-text');
    const original = label ? label.textContent : '';
    if (label) label.textContent = '检测中…';
    try {
      await runDeadLinkCheck();
    } finally {
      btn.disabled = false;
      if (label) label.textContent = original;
    }
  });
}
