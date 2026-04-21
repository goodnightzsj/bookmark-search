import { formatTime, escapeHtml } from './utils.js';
import { HISTORY_ACTIONS, MESSAGE_ACTIONS } from './constants.js';
import { generateNetscapeBookmarkFile } from './bookmark-export.js';
import { assertSuccessfulMessageResponse } from './message-response.js';
import { getStorageOrThrow, STORAGE_KEYS } from './storage-service.js';

// 状态变量
let exportMode = false;
// Store stable keys (not indices) to avoid selection shifting when list re-sorts/updates
let selectedItems = new Set();
let currentHistory = [];
// 缓存 DOM 引用，避免重复 querySelectorAll
let cachedSelectableItems = null;

function syncExportModeControls() {
  const exportControls = document.getElementById('exportControls');
  const toggleBtn = document.getElementById('toggleExportMode');
  if (exportControls) {
    exportControls.style.display = exportMode ? 'flex' : 'none';
  }
  if (toggleBtn) {
    const label = toggleBtn.querySelector('.btn-text');
    if (label) label.textContent = exportMode ? '取消导出' : '导出书签';
  }
}

function clearHistorySelectionState(resetExportMode = false) {
  selectedItems.clear();
  if (resetExportMode) {
    exportMode = false;
  }
  syncExportModeControls();
}

function renderHistoryLoadError() {
  const historyList = document.getElementById('historyList');
  const historyCount = document.getElementById('historyCount');
  if (!historyList || !historyCount) return;

  currentHistory = [];
  cachedSelectableItems = null;
  clearHistorySelectionState(true);
  historyCount.textContent = '!';
  historyList.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2 1 21h22L12 2z"/><path d="M12 9v5"/><circle cx="12" cy="17" r="1"/></svg></div>
      <p>历史记录加载失败，请稍后重试</p>
    </div>
  `;
  updateSelectionUI();
}

/**
 * 加载更新历史
 */
export async function loadUpdateHistory() {
  try {
    const result = await getStorageOrThrow(STORAGE_KEYS.BOOKMARK_HISTORY);
    const historyList = document.getElementById('historyList');
    const historyCount = document.getElementById('historyCount');

    if (!historyList || !historyCount) {
      console.warn("[Settings] 未找到历史记录相关的 DOM 元素");
      return;
    }

    const history = result[STORAGE_KEYS.BOOKMARK_HISTORY];
    if (history && Array.isArray(history) && history.length > 0) {
      // 按时间倒序排列（创建副本避免修改原始数据）
      const sortedHistory = assignHistorySelectionKeys([...history].sort((a, b) => b.timestamp - a.timestamp));
      currentHistory = sortedHistory; // 保存排序后的历史（与 UI 索引保持一致）
      historyCount.textContent = currentHistory.length;

      // Prune selection for items that no longer exist
      if (selectedItems.size > 0) {
        const validKeys = new Set(currentHistory.map(getHistoryItemKey));
        for (const key of selectedItems) {
          if (!validKeys.has(key)) selectedItems.delete(key);
        }
      }

      historyList.innerHTML = currentHistory.map((item, index) => {
        // 兼容旧数据：历史 action 可能为 update（旧版本）
        const action = item.action === 'update' ? HISTORY_ACTIONS.EDIT : item.action;
        const itemKey = getHistoryItemKey(item);

        // 位置信息
        let locationInfo = '';
        
        if (action === HISTORY_ACTIONS.MOVE && item.oldPath && item.newPath) {
          locationInfo = `
            <div class="history-folder history-folder-from">从：${escapeHtml(item.oldPath)}</div>
            <div class="history-folder history-folder-to">到：${escapeHtml(item.newPath)}</div>
          `;
        } else if (item.path) {
          locationInfo = `<div class="history-folder">${escapeHtml(item.path)}</div>`;
        } else if (item.folder) {
          locationInfo = `<div class="history-folder">${escapeHtml(item.folder)}</div>`;
        }
        
        const isSelected = selectedItems.has(itemKey);
        const selectableClass = exportMode ? 'selectable' : '';
        const selectedClass = isSelected ? 'selected' : '';
        const checkboxHtml = exportMode ? `<input type="checkbox" class="history-checkbox" data-index="${index}" ${isSelected ? 'checked' : ''}>` : '';
        
        return `
          <div class="history-item ${selectableClass} ${selectedClass}" data-index="${index}">
            ${checkboxHtml}
            <div class="history-header">
              <span class="history-type ${action}">${getActionText(action)}</span>
              <span class="history-time">${formatTime(item.timestamp)}</span>
            </div>
            <div class="history-content">${escapeHtml(item.title || '(无标题)')}</div>
            ${item.url ? `<div class="history-url">${escapeHtml(item.url)}</div>` : ''}
            ${locationInfo}
          </div>
        `;
      }).join('');

      // DOM 已重建，清除缓存的 DOM 引用
      cachedSelectableItems = null;

      // 绑定选择事件
      if (exportMode) {
        bindSelectionEvents();
        updateSelectionUI();
      }

      console.log("[Settings] 加载了 %d 条历史记录", history.length);
    } else {
      currentHistory = [];
      cachedSelectableItems = null; // 清除缓存
      clearHistorySelectionState(true);
      historyCount.textContent = '0';
      historyList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 12l2-7h14l2 7v7H3v-7z"/><path d="M3 12h6l2 3h2l2-3h6"/></svg></div>
          <p>暂无书签更新记录</p>
        </div>
      `;
      updateSelectionUI();
      console.log("[Settings] 无历史记录");
    }
  } catch (error) {
    console.error("[Settings] 加载更新历史失败:", error);
    renderHistoryLoadError();
  }
}

/**
 * 绑定历史记录相关事件
 */
export function bindHistoryEvents() {
  // 清空历史记录
  const clearHistoryBtn = document.getElementById('clearHistory');
  const toggleExportBtn = document.getElementById('toggleExportMode');
  const selectAllBtn = document.getElementById('selectAll');
  const deselectAllBtn = document.getElementById('deselectAll');
  const exportSelectedBtn = document.getElementById('exportSelected');
  
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', async () => {
      console.log("[Settings] 清空历史记录");
      const confirmed = await (window.__bsConfirm
        ? window.__bsConfirm('确定要清空所有书签更新历史记录吗？', { tone: 'danger', confirmText: '清空' })
        : Promise.resolve(confirm('确定要清空所有书签更新历史记录吗？')));
      if (!confirmed) return;

      try {
        // 通知 background 清空历史（同步内存和存储）
        assertSuccessfulMessageResponse(
          await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.CLEAR_HISTORY }),
          '清空失败'
        );
        await loadUpdateHistory();
        console.log("[Settings] 历史记录已清空");
      } catch (error) {
        console.error("[Settings] 清空历史记录失败:", error);
        if (window.__bsAlert) window.__bsAlert('清空失败：' + error.message, { tone: 'danger' });
        else alert('清空失败：' + error.message);
      }
    });
  }

  // 切换导出模式
  if (toggleExportBtn) {
    toggleExportBtn.addEventListener('click', toggleExportMode);
  }

  // 全选
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      selectAllItems();
    });
  }

  // 取消全选
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => {
      deselectAllItems();
    });
  }

  // 导出选中
  if (exportSelectedBtn) {
    exportSelectedBtn.addEventListener('click', exportSelectedBookmarks);
  }
}

let notificationTimerOuter = null;
let notificationTimerInner = null;

export function clearUpdateNotification() {
  if (notificationTimerOuter !== null) { clearTimeout(notificationTimerOuter); notificationTimerOuter = null; }
  if (notificationTimerInner !== null) { clearTimeout(notificationTimerInner); notificationTimerInner = null; }

  const historyList = document.getElementById('historyList');
  if (!historyList) return;
  const historyCard = historyList.closest('.card');
  if (!historyCard) return;

  const existingNotice = historyCard.querySelector('.update-notice');
  if (existingNotice) {
    existingNotice.remove();
  }
}

/**
 * 显示更新通知
 */
export function showUpdateNotification() {
  const historyList = document.getElementById('historyList');
  if (!historyList) return;

  const historyCard = historyList.closest('.card');
  if (!historyCard) return;

  clearUpdateNotification();

  // 创建通知元素
  const notice = document.createElement('div');
  notice.className = 'alert alert-success update-notice';
  notice.style.marginTop = '12px';
  notice.innerHTML = `
    <span>✓</span>
    <div>书签历史已自动更新</div>
  `;

  // 插入到历史卡片的顶部
  const cardTitle = historyCard.querySelector('.card-title');
  if (!cardTitle) return;
  cardTitle.insertAdjacentElement('afterend', notice);

  // 3秒后自动消失
  notificationTimerOuter = setTimeout(() => {
    notificationTimerOuter = null;
    notice.style.transition = 'opacity 0.3s';
    notice.style.opacity = '0';
    notificationTimerInner = setTimeout(() => {
      notificationTimerInner = null;
      notice.remove();
    }, 300);
  }, 3000);
}

// === 内部辅助函数 ===

function getHistoryItemKey(item) {
  if (item && typeof item.selectionKey === 'string' && item.selectionKey) {
    return item.selectionKey;
  }
  return getHistoryItemBaseKey(item);
}

function getHistoryItemBaseKey(item) {
  if (!item) return '';
  const action = item.action === 'update' ? HISTORY_ACTIONS.EDIT : item.action;
  const parts = [
    item.timestamp || 0,
    action || '',
    item.url || '',
    item.oldUrl || '',
    item.title || '',
    item.oldTitle || '',
    item.path || '',
    item.oldPath || '',
    item.newPath || '',
    item.folder || ''
  ];
  return parts.join('\u001F');
}

export function assignHistorySelectionKeys(items) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Map();

  return list.map((item) => {
    const baseKey = getHistoryItemBaseKey(item);
    const nextOrdinal = (seen.get(baseKey) || 0) + 1;
    seen.set(baseKey, nextOrdinal);
    return {
      ...(item && typeof item === 'object' ? item : {}),
      selectionKey: `${baseKey}\u001Fdup:${nextOrdinal}`
    };
  });
}

// 获取操作文本
function getActionText(action) {
  const texts = {
    [HISTORY_ACTIONS.ADD]: '新增',
    [HISTORY_ACTIONS.DELETE]: '删除',
    [HISTORY_ACTIONS.EDIT]: '编辑',
    [HISTORY_ACTIONS.MOVE]: '移动'
  };
  return texts[action] || action;
}

// 获取可选择的历史项（带缓存）
function getSelectableItems() {
  if (!cachedSelectableItems) {
    cachedSelectableItems = document.querySelectorAll('.history-item.selectable');
  }
  return cachedSelectableItems;
}

let selectionDelegationBound = false;

// 事件委托：在 historyList 容器上绑定单个 click 监听器
function bindSelectionEvents() {
  if (selectionDelegationBound) return;
  const historyList = document.getElementById('historyList');
  if (!historyList) return;

  selectionDelegationBound = true;
  historyList.addEventListener('click', (e) => {
    if (!exportMode) return;
    const item = e.target.closest('.history-item.selectable');
    if (!item) return;
    const index = parseInt(item.dataset.index);
    if (Number.isNaN(index)) return;
    toggleSelection(index);
  });
}

// 切换选择状态
function toggleSelection(index) {
  const item = currentHistory[index];
  if (!item) return;
  const key = getHistoryItemKey(item);

  if (selectedItems.has(key)) selectedItems.delete(key);
  else selectedItems.add(key);

  updateSelectionUI();
}

// 更新选择UI
function updateSelectionUI() {
  // 更新选中计数
  const selectInfo = document.getElementById('selectInfo');
  if (selectInfo) selectInfo.textContent = `已选择 ${selectedItems.size} 条`;

  syncExportModeControls();

  if (!exportMode) return;

  // 更新每个item的选中状态（使用缓存的 DOM 引用）
  const items = getSelectableItems();
  items.forEach(item => {
    const index = parseInt(item.dataset.index);
    const checkbox = item.querySelector('.history-checkbox');

    const historyItem = currentHistory[index];
    const selected = historyItem ? selectedItems.has(getHistoryItemKey(historyItem)) : false;

    if (selected) {
      item.classList.add('selected');
      if (checkbox) checkbox.checked = true;
    } else {
      item.classList.remove('selected');
      if (checkbox) checkbox.checked = false;
    }
  });
}

// 切换导出模式
function toggleExportMode() {
  exportMode = !exportMode;

  if (exportMode) {
    // 默认全选
    selectAllItems();
  } else {
    clearHistorySelectionState(false);
  }

  // 重新渲染历史列表
  loadUpdateHistory();
}

// 全选
function selectAllItems() {
  selectedItems.clear();
  currentHistory.forEach((item) => {
    selectedItems.add(getHistoryItemKey(item));
  });
  updateSelectionUI();
}

// 取消全选
function deselectAllItems() {
  selectedItems.clear();
  updateSelectionUI();
}

export function getExportableHistoryItems(items) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((item) => item && item.url);
}

// 导出选中的书签
async function exportSelectedBookmarks() {
  if (selectedItems.size === 0) {
    if (window.__bsAlert) window.__bsAlert('请先选择要导出的书签', { tone: 'warning' });
    else alert('请先选择要导出的书签');
    return;
  }

  // 获取选中的历史记录
  const selectedHistory = getExportableHistoryItems(
    currentHistory.filter(item => item && selectedItems.has(getHistoryItemKey(item)))
  );

  if (selectedHistory.length === 0) {
    if (window.__bsAlert) window.__bsAlert('选中的记录中没有可导出的书签');
    else alert('选中的记录中没有可导出的书签');
    return;
  }

  console.log(`[Settings] 导出 ${selectedHistory.length} 个书签`);
  
  // 生成Netscape格式的书签HTML
  const html = generateNetscapeBookmarkFile(selectedHistory);
  
  // 下载文件
  downloadFile(html, 'bookmarks_export.html', 'text/html');
}

// 下载文件
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  
  URL.revokeObjectURL(url);
  console.log(`[Settings] 文件已下载: ${filename}`);
}
