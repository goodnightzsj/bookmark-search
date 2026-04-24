/**
 * 访问热度视图：显示"最常打开 TOP"与"久未访问"，都从 SW 的 openStatsByUrl 拉
 */

import { MESSAGE_ACTIONS } from './constants.js';
import { assertSuccessfulMessageResponse } from './message-response.js';
import { openResultModal } from './bs-result-modal.js';
import { formatRelativeTime } from './utils.js';

function escapeHtml(text) {
  const s = String(text == null ? '' : text);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function notifySettings(message, type = 'success') {
  try {
    if (typeof window !== 'undefined' && typeof window.__bsShowToast === 'function') {
      window.__bsShowToast(message, { type });
    }
  } catch (e) {}
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

let modalRef = null;

function renderSection(bodyEl, title, rows, emptyText) {
  const section = document.createElement('div');
  section.className = 'openstats-section';
  const header = document.createElement('div');
  header.className = 'openstats-section-header';
  header.textContent = title;
  section.appendChild(header);

  if (!rows || rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bs-empty-state';
    empty.style.padding = '24px';
    empty.textContent = emptyText;
    section.appendChild(empty);
    bodyEl.appendChild(section);
    return;
  }

  const list = document.createElement('div');
  list.className = 'duplicates-list';
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'duplicates-item';
    row.dataset.url = String(r.url || '');
    row.innerHTML = `
      <div class="duplicates-item-body">
        <div class="duplicates-item-title">${escapeHtml(r.title || '(无标题)')}</div>
        <div class="duplicates-item-meta">
          <span class="bs-count-badge" title="打开次数">${r.count} 次</span>
          <span class="duplicates-item-reason">最近 ${formatRelativeTime(r.lastAt, { showFullDate: false })}</span>
          ${r.path ? `<span class="duplicates-item-path">${escapeHtml(r.path)}</span>` : ''}
        </div>
        <div class="duplicates-item-url" title="${escapeHtml(r.url)}">${escapeHtml(r.url)}</div>
      </div>
      <button type="button" class="duplicates-open-link" data-url="${escapeHtml(r.url)}" title="在新标签页打开">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>
        <span>打开</span>
      </button>
    `;
    list.appendChild(row);
  });
  section.appendChild(list);
  bodyEl.appendChild(section);
}

function wireOpenBtnDelegation(bodyEl) {
  if (bodyEl.dataset.bsOpenWired === '1') return;
  bodyEl.dataset.bsOpenWired = '1';
  bodyEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.duplicates-open-link');
    if (!btn) return;
    e.stopPropagation();
    const url = btn.dataset.url;
    if (url) openBookmarkUrl(url);
  });
}

async function run() {
  if (!modalRef || !modalRef.isOpen()) return;
  modalRef.setSubtitle('加载中…');
  modalRef.actionsEl.innerHTML = '';
  modalRef.bodyEl.innerHTML = '<div class="bs-loading-state">正在统计访问数据…</div>';
  try {
    const resp = assertSuccessfulMessageResponse(
      await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.GET_OPEN_STATS_DIGEST, topN: 20, staleN: 20 }),
      '读取访问统计失败'
    );
    const total = Number(resp.totalTracked) || 0;
    const threshold = Number(resp.staleDaysThreshold) || 30;
    modalRef.setSubtitle(
      total === 0
        ? '还没有统计数据，打开几个书签后回来看看'
        : `已追踪 <strong>${total}</strong> 条 URL。搜索结果会按访问频次 × 时效衰减自动加权排序；${threshold} 天未访问归为"久未访问"。`
    );
    modalRef.actionsEl.innerHTML = `
      <button class="btn btn-secondary btn-sm bs-rescan-btn" id="openStatsReload" type="button"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg><span>刷新</span></button>
    `;
    modalRef.actionsEl.querySelector('#openStatsReload').addEventListener('click', () => run());

    modalRef.bodyEl.innerHTML = '';
    wireOpenBtnDelegation(modalRef.bodyEl);

    const top = Array.isArray(resp.top) ? resp.top : [];
    const stale = Array.isArray(resp.stale) ? resp.stale : [];

    renderSection(modalRef.bodyEl, `TOP ${top.length} 最常访问`, top, '暂无访问记录');
    renderSection(modalRef.bodyEl, `${stale.length} 条久未访问（超过 ${threshold} 天）`, stale, '没有长期闲置的书签');
  } catch (e) {
    modalRef.setSubtitle('读取失败');
    modalRef.bodyEl.innerHTML = `<div class="bs-empty-state">${escapeHtml(e && e.message ? e.message : String(e))}</div>`;
    notifySettings('读取访问热度失败：' + (e && e.message ? e.message : String(e)), 'error');
  }
}

export function bindOpenStatsEvents() {
  const btn = document.getElementById('viewOpenStats');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    modalRef = openResultModal({
      title: '访问热度',
      subtitle: '加载中…',
      onClose: () => { modalRef = null; }
    });
    await run();
  });
}
