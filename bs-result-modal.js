/**
 * 结果面板 modal：三段式结构
 *   Header（标题 + 副标题 + 关闭按钮）
 *   Actions（操作栏，按钮由调用方填）
 *   Body（可滚动内容区）
 *
 * 设计原则：
 *   - 固定 viewport 高度上限（85vh），body 自身 overflow-y: auto 保证滚动
 *   - Escape / 点击外部 / 关闭按钮 三种方式关闭
 *   - 焦点陷阱（Tab/Shift+Tab 循环在 modal 内）
 *   - 主题化：样式写在 _tokens.css，跨四主题一致
 */

let activeModal = null;

function trapFocus(container, event) {
  if (event.key !== 'Tab') return;
  const focusables = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * 打开结果 modal。
 * @param {Object} opts
 * @param {string} opts.title      标题
 * @param {string} [opts.subtitle] 副标题 / 摘要（支持 HTML，调用方保证安全）
 * @returns {{ host:HTMLElement, subtitleEl:HTMLElement, actionsEl:HTMLElement, bodyEl:HTMLElement, setSubtitle:Function, close:Function, isOpen:Function }}
 */
export function openResultModal(opts = {}) {
  // 若已有 modal 打开，先关掉旧的
  if (activeModal) {
    try { activeModal.close(); } catch (e) {}
  }

  const overlay = document.createElement('div');
  overlay.className = 'bs-result-modal-overlay';

  const host = document.createElement('div');
  host.className = 'bs-result-modal';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  if (opts.title) host.setAttribute('aria-label', String(opts.title));

  // Header
  const header = document.createElement('header');
  header.className = 'bs-result-modal-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'bs-result-modal-title-wrap';
  const titleEl = document.createElement('h3');
  titleEl.className = 'bs-result-modal-title';
  titleEl.textContent = String(opts.title || '');
  titleWrap.appendChild(titleEl);
  const subtitleEl = document.createElement('p');
  subtitleEl.className = 'bs-result-modal-subtitle';
  if (opts.subtitle) subtitleEl.innerHTML = String(opts.subtitle);
  titleWrap.appendChild(subtitleEl);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'bs-result-modal-close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  header.appendChild(titleWrap);
  header.appendChild(closeBtn);
  host.appendChild(header);

  // Actions bar（可由调用方填 button）
  const actionsEl = document.createElement('div');
  actionsEl.className = 'bs-result-modal-actions';
  host.appendChild(actionsEl);

  // Body（scrollable）
  const bodyEl = document.createElement('div');
  bodyEl.className = 'bs-result-modal-body';
  host.appendChild(bodyEl);

  overlay.appendChild(host);
  document.body.appendChild(overlay);

  // 进入动画
  requestAnimationFrame(() => overlay.classList.add('is-visible'));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try { document.removeEventListener('keydown', onKey, true); } catch (e) {}
    overlay.classList.remove('is-visible');
    setTimeout(() => {
      try { overlay.parentNode && overlay.parentNode.removeChild(overlay); } catch (e) {}
    }, 180);
    if (activeModal && activeModal.host === host) activeModal = null;
    if (typeof opts.onClose === 'function') {
      try { opts.onClose(); } catch (e) {}
    }
  }

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      trapFocus(host, e);
    }
  };
  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // 首焦点：关闭按钮（可达性）
  setTimeout(() => closeBtn.focus(), 0);

  activeModal = {
    host,
    close,
    isOpen: () => !closed,
    setSubtitle: (html) => { subtitleEl.innerHTML = String(html == null ? '' : html); },
    subtitleEl,
    actionsEl,
    bodyEl
  };
  return activeModal;
}

export function closeActiveResultModal() {
  if (activeModal) {
    try { activeModal.close(); } catch (e) {}
    activeModal = null;
  }
}
