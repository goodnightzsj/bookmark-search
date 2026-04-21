/**
 * 主题化 confirm / alert / prompt 模态
 * - 返回 Promise，替换原生 confirm() / alert() 的阻塞调用
 * - Escape = 取消；Enter = 确认
 * - 焦点陷阱：tab 循环在对话框内
 * - 复用主题变量（accent / card-bg / border），跨主题一致
 */

const ROOT_ID = 'bs-dialog-root';
let activeDialog = null;

function ensureRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

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

function buildDialog({ title, message, confirmText, cancelText, tone, showCancel }) {
  const overlay = document.createElement('div');
  overlay.className = 'bs-dialog-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  if (title) overlay.setAttribute('aria-label', title);

  const box = document.createElement('div');
  box.className = 'bs-dialog-box';
  overlay.appendChild(box);

  if (title) {
    const h = document.createElement('div');
    h.className = 'bs-dialog-title';
    h.textContent = title;
    box.appendChild(h);
  }

  const body = document.createElement('div');
  body.className = 'bs-dialog-body';
  // 保留换行
  String(message || '').split('\n').forEach((line, i, arr) => {
    const p = document.createElement('div');
    p.textContent = line;
    body.appendChild(p);
    if (i < arr.length - 1) body.appendChild(document.createElement('br'));
  });
  box.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'bs-dialog-actions';

  let cancelBtn = null;
  if (showCancel) {
    cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'bs-dialog-btn bs-dialog-btn-secondary';
    cancelBtn.textContent = cancelText || '取消';
    actions.appendChild(cancelBtn);
  }

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'bs-dialog-btn bs-dialog-btn-primary' + (tone === 'danger' ? ' bs-dialog-btn-danger' : '');
  okBtn.textContent = confirmText || '确定';
  actions.appendChild(okBtn);
  box.appendChild(actions);

  return { overlay, okBtn, cancelBtn };
}

function closeActive() {
  if (!activeDialog) return;
  const { overlay, onKeydown, resolve, resolveWith } = activeDialog;
  activeDialog = null;
  try { document.removeEventListener('keydown', onKeydown, true); } catch (e) {}
  overlay.classList.remove('is-visible');
  setTimeout(() => {
    try { overlay.parentNode && overlay.parentNode.removeChild(overlay); } catch (e) {}
  }, 160);
  if (resolve) resolve(resolveWith);
}

function openDialog(opts) {
  const showCancel = opts.showCancel !== false;
  return new Promise((resolve) => {
    // 关闭任意前序对话框，避免堆叠
    if (activeDialog) {
      activeDialog.resolveWith = false;
      closeActive();
    }
    const { overlay, okBtn, cancelBtn } = buildDialog({
      title: opts.title,
      message: opts.message,
      confirmText: opts.confirmText,
      cancelText: opts.cancelText,
      tone: opts.tone,
      showCancel
    });
    ensureRoot().appendChild(overlay);
    // 下一帧添加 visible，触发进入动画
    requestAnimationFrame(() => overlay.classList.add('is-visible'));

    const finish = (value) => {
      if (activeDialog) activeDialog.resolveWith = value;
      closeActive();
    };
    okBtn.addEventListener('click', () => finish(true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => finish(false));
    // 点击外层（非 box）关闭 = 取消
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(showCancel ? false : true);
    });

    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(showCancel ? false : true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Tab') {
        trapFocus(overlay, e);
      }
    };
    document.addEventListener('keydown', onKeydown, true);

    activeDialog = { overlay, onKeydown, resolve, resolveWith: false };
    // 初始焦点：确认/取消按钮（危险操作优先放在取消上，减少误按）
    const preferCancel = opts.tone === 'danger' && cancelBtn;
    setTimeout(() => {
      (preferCancel ? cancelBtn : okBtn).focus();
    }, 0);
  });
}

export function bsConfirm(message, opts = {}) {
  return openDialog({
    title: opts.title || '请确认',
    message,
    confirmText: opts.confirmText || '确定',
    cancelText: opts.cancelText || '取消',
    tone: opts.tone || null,
    showCancel: true
  });
}

export function bsAlert(message, opts = {}) {
  return openDialog({
    title: opts.title || '提示',
    message,
    confirmText: opts.confirmText || '知道了',
    tone: opts.tone || null,
    showCancel: false
  });
}

// 暴露到 window 供 content.js 非模块作用域 / 迁移期使用
if (typeof window !== 'undefined') {
  window.__bsConfirm = bsConfirm;
  window.__bsAlert = bsAlert;
}
