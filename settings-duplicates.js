/**
 * 重复书签查找与清理（settings 页）
 */

import { MESSAGE_ACTIONS } from './constants.js';
import { assertSuccessfulMessageResponse } from './message-response.js';

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

function renderGroups(container, groups) {
  if (!container) return;
  container.innerHTML = '';
  if (!groups || groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'duplicates-empty';
    empty.textContent = '没有发现重复书签。';
    container.appendChild(empty);
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'duplicates-summary';
  const total = groups.reduce((acc, g) => acc + (g.items.length - 1), 0);
  summary.innerHTML = `发现 <strong>${groups.length}</strong> 组重复，可清理 <strong>${total}</strong> 条冗余书签。默认选中每组中较早添加的条目，保留最新一条。`;
  container.appendChild(summary);

  const actions = document.createElement('div');
  actions.className = 'duplicates-actions';
  actions.innerHTML = `
    <button class="btn btn-secondary btn-sm" id="dupSelectAllOlder" type="button">选中旧的（保留最新）</button>
    <button class="btn btn-secondary btn-sm" id="dupSelectNone" type="button">全不选</button>
    <span class="duplicates-action-sep"></span>
    <button class="btn btn-primary btn-sm" id="dupDeleteSelected" type="button">删除选中</button>
    <span class="duplicates-selected-count" id="dupSelectedCount">已选 0 条</span>
  `;
  container.appendChild(actions);

  const list = document.createElement('div');
  list.className = 'duplicates-list';
  container.appendChild(list);

  groups.forEach((group, gi) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'duplicates-group';
    const head = document.createElement('div');
    head.className = 'duplicates-group-head';
    head.innerHTML = `<span class="duplicates-group-count">${group.items.length} 条</span><span class="duplicates-group-key">${escapeHtml(group.key)}</span>`;
    groupEl.appendChild(head);

    const itemsEl = document.createElement('div');
    itemsEl.className = 'duplicates-group-items';
    group.items.forEach((bm, bi) => {
      const isOldest = bi < group.items.length - 1; // 默认选中每组除最后一条外的所有（保留最新）
      const row = document.createElement('div');
      row.className = 'duplicates-item' + (isOldest ? ' is-selected' : '');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-pressed', isOldest ? 'true' : 'false');
      row.dataset.bookmarkId = String(bm.id || '');
      row.dataset.selected = isOldest ? '1' : '0';
      row.innerHTML = `
        <div class="duplicates-item-body">
          <div class="duplicates-item-title">${escapeHtml(bm.title || '(无标题)')}</div>
          <div class="duplicates-item-meta">
            <span class="duplicates-item-path">${escapeHtml(bm.path || '—')}</span>
            <span class="duplicates-item-date">${formatDate(bm.dateAdded)}</span>
          </div>
          <div class="duplicates-item-url" title="${escapeHtml(bm.url)}">${escapeHtml(bm.url)}</div>
        </div>
      `;
      itemsEl.appendChild(row);
    });
    groupEl.appendChild(itemsEl);
    list.appendChild(groupEl);
  });

  wireActions(container);
  updateSelectedCount(container);
}

function getRows(container) {
  return Array.from(container.querySelectorAll('.duplicates-item'));
}

function setRowSelected(row, selected) {
  if (!row) return;
  const on = !!selected;
  row.classList.toggle('is-selected', on);
  row.dataset.selected = on ? '1' : '0';
  row.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function updateSelectedCount(container) {
  const countEl = container.querySelector('#dupSelectedCount');
  if (!countEl) return;
  const selected = getRows(container).filter((r) => r.dataset.selected === '1').length;
  countEl.textContent = `已选 ${selected} 条`;
}

function wireActions(container) {
  // 行整体点击切换选中
  container.addEventListener('click', (e) => {
    const row = e.target.closest('.duplicates-item');
    if (!row || !container.contains(row)) return;
    setRowSelected(row, row.dataset.selected !== '1');
    updateSelectedCount(container);
  });
  // 键盘可达：Enter / Space 切换
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest && e.target.closest('.duplicates-item');
    if (!row || !container.contains(row)) return;
    e.preventDefault();
    setRowSelected(row, row.dataset.selected !== '1');
    updateSelectedCount(container);
  });

  const selectAllOlder = container.querySelector('#dupSelectAllOlder');
  if (selectAllOlder) {
    selectAllOlder.addEventListener('click', () => {
      // 每组除最后一条外全选（保留最新）
      const groups = container.querySelectorAll('.duplicates-group');
      groups.forEach((g) => {
        const items = g.querySelectorAll('.duplicates-item');
        items.forEach((row, idx) => setRowSelected(row, idx < items.length - 1));
      });
      updateSelectedCount(container);
    });
  }

  const selectNone = container.querySelector('#dupSelectNone');
  if (selectNone) {
    selectNone.addEventListener('click', () => {
      getRows(container).forEach((row) => setRowSelected(row, false));
      updateSelectedCount(container);
    });
  }

  const deleteBtn = container.querySelector('#dupDeleteSelected');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => deleteSelected(container));
  }
}

async function deleteSelected(container) {
  const ids = getRows(container)
    .filter((r) => r.dataset.selected === '1')
    .map((r) => r.dataset.bookmarkId)
    .filter(Boolean);
  if (ids.length === 0) {
    notifySettings('请先勾选要删除的书签', 'warning');
    return;
  }
  const confirmed = await (window.__bsConfirm
    ? window.__bsConfirm(`确定删除选中的 ${ids.length} 条书签？浏览器书签中会被同步移除。`, { tone: 'danger', confirmText: '删除' })
    : Promise.resolve(confirm(`确定删除选中的 ${ids.length} 条书签？浏览器书签中会被同步移除。`)));
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
    // 重新扫描
    await runFindDuplicates(container);
  } catch (e) {
    notifySettings('批量删除失败：' + (e && e.message ? e.message : String(e)), 'error');
  }
}

async function runFindDuplicates(container) {
  // 保留页面滚动位置：innerHTML 替换会引发 layout 收缩，浏览器可能自动滚动
  const savedScrollY = window.scrollY;
  container.innerHTML = '<div class="duplicates-loading">扫描中…</div>';
  try {
    const resp = assertSuccessfulMessageResponse(
      await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.FIND_DUPLICATE_BOOKMARKS }),
      '查找重复失败'
    );
    const groups = resp && Array.isArray(resp.groups) ? resp.groups : [];
    renderGroups(container, groups);
  } catch (e) {
    container.innerHTML = '';
    notifySettings('查找失败：' + (e && e.message ? e.message : String(e)), 'error');
  } finally {
    // 渲染完成后还原滚动，用户视线不离开原来位置
    if (Math.abs(window.scrollY - savedScrollY) > 4) {
      window.scrollTo({ top: savedScrollY, behavior: 'instant' });
    }
  }
}

export function bindDuplicatesEvents() {
  const findBtn = document.getElementById('findDuplicates');
  const container = document.getElementById('duplicatesResult');
  if (!findBtn || !container) return;

  findBtn.addEventListener('click', async () => {
    container.style.display = 'block';
    await runFindDuplicates(container);
  });
}
