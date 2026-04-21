/**
 * 重复书签查找与清理（settings 页）
 * 结果展示在独立 modal 内，不再嵌入 action-card
 */

import { MESSAGE_ACTIONS } from './constants.js';
import { assertSuccessfulMessageResponse } from './message-response.js';
import { openResultModal } from './bs-result-modal.js';
import { formatRelativeTime } from './utils.js';

const CACHE_KEY = 'settings.duplicatesCache.v1';

async function loadDupCache() {
  try {
    const r = await chrome.storage.local.get(CACHE_KEY);
    const raw = r && r[CACHE_KEY];
    if (!raw || typeof raw !== 'object') return null;
    if (!Array.isArray(raw.groups)) return null;
    if (typeof raw.scannedAt !== 'number') return null;
    return raw;
  } catch (e) { return null; }
}

async function saveDupCache(groups) {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { scannedAt: Date.now(), groups: Array.isArray(groups) ? groups : [] }
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
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(ts) {
  if (!ts || typeof ts !== 'number') return '—';
  try {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch (e) { return '—'; }
}

// Modal context：每次运行复用，避免不必要的 DOM 重建
let modalRef = null;

function renderGroups(groups, scannedAt) {
  if (!modalRef || !modalRef.isOpen()) return;
  const { bodyEl, actionsEl, setSubtitle } = modalRef;

  const stamp = typeof scannedAt === 'number' && scannedAt > 0
    ? `<span class="bs-scan-stamp">上次检测：${formatRelativeTime(scannedAt, { showFullDate: false })}</span>`
    : '';

  if (!groups || groups.length === 0) {
    setSubtitle(`没有发现重复书签 🎉${stamp ? '　' + stamp : ''}`);
    actionsEl.innerHTML = '<button class="btn btn-secondary btn-sm bs-rescan-btn" id="dupRescan" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg><span>重新检测</span></button>';
    bodyEl.innerHTML = '<div class="bs-empty-state">所有书签 URL 均唯一。</div>';
    wireRescan(actionsEl);
    return;
  }

  const total = groups.reduce((acc, g) => acc + (g.items.length - 1), 0);
  setSubtitle(`共 <strong>${groups.length}</strong> 组重复，可清理 <strong>${total}</strong> 条冗余。默认选中每组中较早的条目，保留最新一条。${stamp ? '<br>' + stamp : ''}`);

  actionsEl.innerHTML = `
    <button class="btn btn-secondary btn-sm bs-rescan-btn" id="dupRescan" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg><span>重新检测</span></button>
    <span class="bs-action-divider"></span>
    <button class="btn btn-secondary btn-sm" id="dupSelectAllOlder" type="button">选中旧的（保留最新）</button>
    <button class="btn btn-secondary btn-sm" id="dupSelectNone" type="button">全不选</button>
    <span class="bs-result-modal-action-sep"></span>
    <span class="duplicates-selected-count" id="dupSelectedCount">已选 0 条</span>
    <button class="btn btn-primary btn-sm" id="dupDeleteSelected" type="button">删除选中</button>
  `;

  const list = document.createElement('div');
  list.className = 'duplicates-list';

  groups.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'duplicates-group';
    const head = document.createElement('div');
    head.className = 'duplicates-group-head';
    head.innerHTML = `<span class="duplicates-group-count">${group.items.length} 条</span><span class="duplicates-group-key">${escapeHtml(group.key)}</span>`;
    groupEl.appendChild(head);

    const itemsEl = document.createElement('div');
    itemsEl.className = 'duplicates-group-items';
    group.items.forEach((bm, bi) => {
      const isOldest = bi < group.items.length - 1;
      const row = document.createElement('div');
      row.className = 'duplicates-item' + (isOldest ? ' is-selected' : '');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-pressed', isOldest ? 'true' : 'false');
      row.dataset.bookmarkId = String(bm.id || '');
      row.dataset.selected = isOldest ? '1' : '0';
      row.dataset.url = String(bm.url || '');
      row.innerHTML = `
        <div class="duplicates-item-body">
          <div class="duplicates-item-title">${escapeHtml(bm.title || '(无标题)')}</div>
          <div class="duplicates-item-meta">
            <span class="duplicates-item-path">${escapeHtml(bm.path || '—')}</span>
            <span class="duplicates-item-date">${formatDate(bm.dateAdded)}</span>
          </div>
          <div class="duplicates-item-url" title="${escapeHtml(bm.url)}">${escapeHtml(bm.url)}</div>
        </div>
        <a class="duplicates-open-link" href="${escapeHtml(bm.url)}" target="_blank" rel="noopener noreferrer" title="在新标签页打开" aria-label="在新标签页打开该书签">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
          <span>打开</span>
        </a>
      `;
      itemsEl.appendChild(row);
    });
    groupEl.appendChild(itemsEl);
    list.appendChild(groupEl);
  });

  bodyEl.innerHTML = '';
  bodyEl.appendChild(list);

  wireActions(bodyEl, actionsEl);
  wireRescan(actionsEl);
  updateSelectedCount(bodyEl, actionsEl);
}

function wireRescan(actionsEl) {
  const btn = actionsEl.querySelector('#dupRescan');
  if (btn) btn.addEventListener('click', () => runFindDuplicates());
}

function getRows(bodyEl) {
  return Array.from(bodyEl.querySelectorAll('.duplicates-item'));
}

function setRowSelected(row, selected) {
  if (!row) return;
  const on = !!selected;
  row.classList.toggle('is-selected', on);
  row.dataset.selected = on ? '1' : '0';
  row.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function updateSelectedCount(bodyEl, actionsEl) {
  const countEl = actionsEl.querySelector('#dupSelectedCount');
  if (!countEl) return;
  const selected = getRows(bodyEl).filter((r) => r.dataset.selected === '1').length;
  countEl.textContent = `已选 ${selected} 条`;
}

function wireActions(bodyEl, actionsEl) {
  bodyEl.addEventListener('click', (e) => {
    // 打开链接的 <a> 不触发行选中切换
    if (e.target.closest('.duplicates-open-link')) return;
    const row = e.target.closest('.duplicates-item');
    if (!row || !bodyEl.contains(row)) return;
    setRowSelected(row, row.dataset.selected !== '1');
    updateSelectedCount(bodyEl, actionsEl);
  });
  bodyEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest && e.target.closest('.duplicates-item');
    if (!row || !bodyEl.contains(row)) return;
    // 聚焦到 <a> 时按 Enter 走默认跳转，不切换选中
    if (e.target.closest && e.target.closest('.duplicates-open-link')) return;
    e.preventDefault();
    setRowSelected(row, row.dataset.selected !== '1');
    updateSelectedCount(bodyEl, actionsEl);
  });

  const selectAllOlder = actionsEl.querySelector('#dupSelectAllOlder');
  if (selectAllOlder) {
    selectAllOlder.addEventListener('click', () => {
      const groups = bodyEl.querySelectorAll('.duplicates-group');
      groups.forEach((g) => {
        const items = g.querySelectorAll('.duplicates-item');
        items.forEach((row, idx) => setRowSelected(row, idx < items.length - 1));
      });
      updateSelectedCount(bodyEl, actionsEl);
    });
  }

  const selectNone = actionsEl.querySelector('#dupSelectNone');
  if (selectNone) {
    selectNone.addEventListener('click', () => {
      getRows(bodyEl).forEach((row) => setRowSelected(row, false));
      updateSelectedCount(bodyEl, actionsEl);
    });
  }

  const deleteBtn = actionsEl.querySelector('#dupDeleteSelected');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => deleteSelected(bodyEl, actionsEl));
  }
}

async function deleteSelected(bodyEl, actionsEl) {
  const ids = getRows(bodyEl)
    .filter((r) => r.dataset.selected === '1')
    .map((r) => r.dataset.bookmarkId)
    .filter(Boolean);
  if (ids.length === 0) {
    notifySettings('请先选中要删除的书签', 'warning');
    return;
  }
  const confirmed = await (window.__bsConfirm
    ? window.__bsConfirm(`确定删除选中的 ${ids.length} 条书签？浏览器书签中会被同步移除。`, { tone: 'danger', confirmText: '删除' })
    : Promise.resolve(confirm(`确定删除选中的 ${ids.length} 条书签？`)));
  if (!confirmed) return;

  try {
    const resp = assertSuccessfulMessageResponse(
      await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.DELETE_BOOKMARKS_BATCH, ids }),
      '批量删除失败'
    );
    const removed = resp && typeof resp.removed === 'number' ? resp.removed : 0;
    const failedCount = resp && Array.isArray(resp.failed) ? resp.failed.length : 0;
    if (failedCount === 0) {
      notifySettings(`已删除 ${removed} 条重复书签`);
    } else {
      notifySettings(`已删除 ${removed} 条，${failedCount} 条失败`, 'warning');
    }
    await runFindDuplicates();
  } catch (e) {
    notifySettings('批量删除失败：' + (e && e.message ? e.message : String(e)), 'error');
  }
}

async function runFindDuplicates() {
  if (!modalRef || !modalRef.isOpen()) return;
  modalRef.setSubtitle('扫描中…');
  modalRef.actionsEl.innerHTML = '';
  modalRef.bodyEl.innerHTML = '<div class="bs-loading-state">正在扫描所有书签…</div>';
  try {
    const resp = assertSuccessfulMessageResponse(
      await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.FIND_DUPLICATE_BOOKMARKS }),
      '查找重复失败'
    );
    const groups = resp && Array.isArray(resp.groups) ? resp.groups : [];
    const now = Date.now();
    saveDupCache(groups);
    renderGroups(groups, now);
  } catch (e) {
    modalRef.setSubtitle('扫描失败');
    modalRef.bodyEl.innerHTML = `<div class="bs-empty-state">${escapeHtml(e && e.message ? e.message : String(e))}</div>`;
    notifySettings('查找失败：' + (e && e.message ? e.message : String(e)), 'error');
  }
}

export function bindDuplicatesEvents() {
  const findBtn = document.getElementById('findDuplicates');
  if (!findBtn) return;

  findBtn.addEventListener('click', async () => {
    modalRef = openResultModal({
      title: '重复书签清理',
      subtitle: '加载中…',
      onClose: () => { modalRef = null; }
    });
    // 先尝试缓存；无缓存再实扫
    const cached = await loadDupCache();
    if (cached) {
      renderGroups(cached.groups, cached.scannedAt);
    } else {
      await runFindDuplicates();
    }
  });
}
