/**
 * 死链检测（按需触发）：
 * - 用户点击"检测失效链接"时请求 <all_urls> 可选 host permission
 * - 获得授权后，遍历所有书签，用 HEAD 请求 + 8s 超时，并发 3
 * - 网络错误 / 4xx / 5xx 标记为"可能失效"
 * - 结果列表支持勾选后批量删除
 *
 * 注意：这只是启发式——某些站点会屏蔽 HEAD、需要 UA、要求登录、或返回 403 反爬。
 * 误判率不低于 10%，UI 会明确提示用户人工确认后再删。
 */

import { MESSAGE_ACTIONS } from './constants.js';
import { assertSuccessfulMessageResponse } from './message-response.js';

const CONCURRENCY = 3;
const TIMEOUT_MS = 8000;

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

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timeout' : (e && e.message ? e.message : String(e));
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function classify(result) {
  // 返回 { level: 'dead' | 'suspect' | 'ok', reason: string }
  if (!result) return { level: 'suspect', reason: '未知' };
  if (result.ok) return { level: 'ok', reason: 'OK' };
  if (result.status === 0) return { level: 'dead', reason: result.error || '网络错误' };
  if (result.status >= 500) return { level: 'dead', reason: `HTTP ${result.status}` };
  if (result.status === 404 || result.status === 410) return { level: 'dead', reason: `HTTP ${result.status}` };
  if (result.status === 403 || result.status === 405) return { level: 'suspect', reason: `HTTP ${result.status} (可能反爬)` };
  if (result.status >= 400) return { level: 'suspect', reason: `HTTP ${result.status}` };
  return { level: 'suspect', reason: `HTTP ${result.status}` };
}

async function runBatch(bookmarks, progressEl, resultsHolder) {
  let done = 0;
  const total = bookmarks.length;

  function updateProgress() {
    if (!progressEl) return;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressEl.textContent = `检测中 ${done}/${total} (${pct}%)`;
  }

  async function worker(queue) {
    while (queue.length > 0) {
      const bm = queue.shift();
      if (!bm) continue;
      const res = await fetchWithTimeout(bm.url, TIMEOUT_MS);
      const klass = classify(res);
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
  const queue = bookmarks.slice();
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
    workers.push(worker(queue));
  }
  await Promise.all(workers);
}

function renderResults(container, results) {
  container.innerHTML = '';
  const dead = results.filter((r) => r.level === 'dead');
  const suspect = results.filter((r) => r.level === 'suspect');
  const ok = results.filter((r) => r.level === 'ok');

  const summary = document.createElement('div');
  summary.className = 'duplicates-summary';
  summary.innerHTML = `共 <strong>${results.length}</strong> 条；疑似失效 <strong style="color:#dc2626">${dead.length}</strong> · 状态可疑 <strong style="color:#d97706">${suspect.length}</strong> · 正常 <strong>${ok.length}</strong>。误判率约 10% 左右，请人工确认再删。`;
  container.appendChild(summary);

  const actions = document.createElement('div');
  actions.className = 'duplicates-actions';
  actions.innerHTML = `
    <button class="btn btn-secondary btn-sm" id="dlSelectDead" type="button">勾选所有疑似失效</button>
    <button class="btn btn-secondary btn-sm" id="dlSelectNone" type="button">全不选</button>
    <span class="duplicates-action-sep"></span>
    <button class="btn btn-primary btn-sm" id="dlDeleteSelected" type="button">删除选中</button>
    <span class="duplicates-selected-count" id="dlSelectedCount">已选 0 条</span>
  `;
  container.appendChild(actions);

  const list = document.createElement('div');
  list.className = 'duplicates-list';

  const problematic = dead.concat(suspect);
  if (problematic.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'duplicates-empty';
    empty.textContent = '没有发现疑似失效的链接 🎉';
    container.appendChild(empty);
    return;
  }

  problematic.forEach((r) => {
    const row = document.createElement('label');
    row.className = 'duplicates-item';
    const levelLabel = r.level === 'dead' ? '失效' : '可疑';
    const levelColor = r.level === 'dead' ? '#dc2626' : '#d97706';
    row.innerHTML = `
      <input type="checkbox" class="history-checkbox dl-checkbox" data-bookmark-id="${escapeHtml(r.id)}" ${r.level === 'dead' ? 'checked' : ''}>
      <div class="duplicates-item-body">
        <div class="duplicates-item-title">${escapeHtml(r.title || '(无标题)')}</div>
        <div class="duplicates-item-meta">
          <span class="duplicates-item-path" style="color:${levelColor};font-weight:600;">${levelLabel} · ${escapeHtml(r.reason)}</span>
        </div>
        <div class="duplicates-item-url" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</div>
      </div>
    `;
    list.appendChild(row);
  });
  container.appendChild(list);

  wireDeadlinkActions(container);
  updateDlCount(container);
}

function getDlCheckboxes(container) {
  return Array.from(container.querySelectorAll('.dl-checkbox'));
}

function updateDlCount(container) {
  const el = container.querySelector('#dlSelectedCount');
  if (!el) return;
  const selected = getDlCheckboxes(container).filter((cb) => cb.checked).length;
  el.textContent = `已选 ${selected} 条`;
}

function wireDeadlinkActions(container) {
  container.querySelectorAll('.dl-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => updateDlCount(container));
  });
  const btnDead = container.querySelector('#dlSelectDead');
  if (btnDead) btnDead.addEventListener('click', () => {
    getDlCheckboxes(container).forEach((cb) => {
      const label = cb.parentElement && cb.parentElement.querySelector('.duplicates-item-path');
      const isDead = label && label.textContent.indexOf('失效') === 0;
      cb.checked = !!isDead;
    });
    updateDlCount(container);
  });
  const btnNone = container.querySelector('#dlSelectNone');
  if (btnNone) btnNone.addEventListener('click', () => {
    getDlCheckboxes(container).forEach((cb) => cb.checked = false);
    updateDlCount(container);
  });
  const btnDelete = container.querySelector('#dlDeleteSelected');
  if (btnDelete) btnDelete.addEventListener('click', async () => {
    const ids = getDlCheckboxes(container).filter((cb) => cb.checked).map((cb) => cb.dataset.bookmarkId).filter(Boolean);
    if (ids.length === 0) {
      notifySettings('请先勾选要删除的书签', 'warning');
      return;
    }
    if (!confirm(`确定删除选中的 ${ids.length} 条书签？`)) return;
    try {
      const resp = assertSuccessfulMessageResponse(
        await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.DELETE_BOOKMARKS_BATCH, ids }),
        '批量删除失败'
      );
      notifySettings(`已删除 ${resp && resp.removed ? resp.removed : ids.length} 条`);
      // 移除已删除的行
      ids.forEach((id) => {
        const cb = container.querySelector(`.dl-checkbox[data-bookmark-id="${CSS.escape(id)}"]`);
        if (cb) {
          const row = cb.closest('.duplicates-item');
          if (row) row.remove();
        }
      });
      updateDlCount(container);
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

async function runDeadLinkCheck(container) {
  container.innerHTML = '<div class="duplicates-loading" id="dlProgress">准备中…</div>';

  const granted = await requestHostPermission();
  if (!granted) {
    container.innerHTML = '<div class="duplicates-empty">需要授权"访问所有网站"权限才能检测链接状态。请点击按钮后在弹出的权限对话框中允许。</div>';
    return;
  }

  let tree;
  try {
    tree = await chrome.bookmarks.getTree();
  } catch (e) {
    notifySettings('读取书签失败：' + (e.message || String(e)), 'error');
    container.innerHTML = '';
    return;
  }
  const flat = [];
  flattenBookmarks(tree, flat);
  if (flat.length === 0) {
    container.innerHTML = '<div class="duplicates-empty">没有找到可检测的书签（仅检测 http/https）。</div>';
    return;
  }

  const progressEl = container.querySelector('#dlProgress');
  const results = [];
  const started = Date.now();
  await runBatch(flat, progressEl, results);
  const ms = Date.now() - started;
  renderResults(container, results);
  notifySettings(`检测完成：${flat.length} 条 / 用时 ${(ms / 1000).toFixed(1)}s`);
}

export function bindDeadlinkEvents() {
  const btn = document.getElementById('checkDeadLinks');
  const container = document.getElementById('deadlinksResult');
  if (!btn || !container) return;
  btn.addEventListener('click', async () => {
    container.style.display = 'block';
    btn.disabled = true;
    const label = btn.querySelector('.btn-text');
    const original = label ? label.textContent : '';
    if (label) label.textContent = '检测中…';
    try {
      await runDeadLinkCheck(container);
    } finally {
      btn.disabled = false;
      if (label) label.textContent = original;
    }
  });
}
