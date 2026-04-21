/**
 * 轻量自定义 select：跨主题可控渲染（原生 select 的 option 列表由 OS 绘制，样式不可达）
 *
 * 使用方式：
 *   <select id="foo" class="form-input" data-custom-select="true">...</select>
 *   enhanceAllCustomSelects();
 *
 * 设计约束：
 * - 保留原 <select> 作为数据源与表单提交后备（仅视觉隐藏）
 * - 值变更时在原 <select> 上派发 'change' 事件，现有监听器无需改动
 * - 键盘无障碍：Arrow Up/Down 切换、Enter/Space 确认、Escape 关闭
 * - ARIA：button=combobox、menu=listbox、item=option
 * - 点击外部关闭；打开时 input 焦点可达
 */

const OPEN_CLASS = 'is-open';
const ACTIVE_CLASS = 'is-active';
const SELECTED_CLASS = 'is-selected';

// 跟踪当前打开的自定义 select，便于点击外部统一关闭
let currentOpen = null;

function closeCurrent() {
  if (currentOpen) {
    currentOpen.close();
    currentOpen = null;
  }
}

document.addEventListener('click', (e) => {
  if (!currentOpen) return;
  // menu 已 portal 到 body，既要放行 root（button）也要放行 menu 本身
  if (currentOpen.root.contains(e.target)) return;
  if (currentOpen.menu && currentOpen.menu.contains(e.target)) return;
  closeCurrent();
}, true);

document.addEventListener('keydown', (e) => {
  if (!currentOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCurrent();
    currentOpen && currentOpen.button.focus();
  }
}, true);

function buildChevron() {
  const span = document.createElement('span');
  span.className = 'custom-select-chevron';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 12 8" width="10" height="7"><path d="M1 1l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return span;
}

function enhanceOne(select) {
  if (!select || !(select instanceof HTMLSelectElement)) return;
  if (select.dataset.customSelectMounted === '1') return;
  select.dataset.customSelectMounted = '1';

  const root = document.createElement('div');
  root.className = 'custom-select';
  const selectId = select.id || '';
  if (selectId) root.dataset.selectId = selectId;

  // 把原 select 插到 root 里以便共享父级，但视觉隐藏
  select.parentNode.insertBefore(root, select);
  root.appendChild(select);
  select.classList.add('custom-select-native');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'form-input custom-select-button';
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  if (select.getAttribute('aria-label')) button.setAttribute('aria-label', select.getAttribute('aria-label'));
  const labelSpan = document.createElement('span');
  labelSpan.className = 'custom-select-label';
  button.appendChild(labelSpan);
  button.appendChild(buildChevron());
  root.appendChild(button);

  const menu = document.createElement('div');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('tabindex', '-1');
  // Portal 到 document.body：脱离父级 stacking context / overflow:hidden / transform 影响，
  // 确保下拉浮层永远在最上层、不被卡片 clip
  if (document.body) document.body.appendChild(menu);
  else root.appendChild(menu);

  function positionMenu() {
    const rect = button.getBoundingClientRect();
    // 宽度跟随 button；top 贴在 button 下方 6px，避免 layout thrash 用 viewport 坐标
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.width = rect.width + 'px';
    menu.style.minWidth = rect.width + 'px';
    // 若下方空间不足（视口底部 < 240px），翻转到 button 上方
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const needed = 240;
    if (spaceBelow < needed && spaceAbove > spaceBelow) {
      menu.style.top = (rect.top - 6 - Math.min(spaceAbove, 280)) + 'px';
      menu.style.maxHeight = Math.min(spaceAbove, 280) + 'px';
    } else {
      menu.style.maxHeight = Math.min(Math.max(spaceBelow, 160), 280) + 'px';
    }
  }

  function readOptions() {
    return Array.from(select.options).map((opt, index) => ({
      value: opt.value,
      text: opt.textContent || '',
      disabled: !!opt.disabled,
      selected: opt.selected,
      index
    }));
  }

  let activeIndex = -1;

  function renderMenu() {
    menu.innerHTML = '';
    const items = readOptions();
    items.forEach((opt) => {
      const item = document.createElement('div');
      item.className = 'custom-select-option';
      item.setAttribute('role', 'option');
      item.dataset.value = opt.value;
      item.dataset.index = String(opt.index);
      item.textContent = opt.text;
      if (opt.disabled) {
        item.classList.add('is-disabled');
        item.setAttribute('aria-disabled', 'true');
      }
      if (opt.selected) {
        item.classList.add(SELECTED_CLASS);
        item.setAttribute('aria-selected', 'true');
      } else {
        item.setAttribute('aria-selected', 'false');
      }
      item.addEventListener('click', (e) => {
        if (opt.disabled) return;
        e.stopPropagation();
        commitValue(opt.value);
        closeMenu();
        button.focus();
      });
      item.addEventListener('mouseenter', () => {
        setActiveIndex(opt.index);
      });
      menu.appendChild(item);
    });
  }

  function setActiveIndex(index) {
    const items = menu.querySelectorAll('.custom-select-option');
    items.forEach((el) => el.classList.remove(ACTIVE_CLASS));
    if (index < 0 || index >= items.length) { activeIndex = -1; return; }
    activeIndex = index;
    const target = items[index];
    if (target) {
      target.classList.add(ACTIVE_CLASS);
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  function refreshButtonLabel() {
    const selected = select.options[select.selectedIndex];
    labelSpan.textContent = selected ? (selected.textContent || '') : '';
  }

  function commitValue(value) {
    if (select.value === value) return;
    select.value = value;
    // 派发原生 change，使现有监听器无需改动
    select.dispatchEvent(new Event('change', { bubbles: true }));
    refreshButtonLabel();
    renderMenu();
  }

  let scrollHandler = null;
  let resizeHandler = null;

  function openMenu() {
    if (root.classList.contains(OPEN_CLASS)) return;
    closeCurrent();
    renderMenu();
    root.classList.add(OPEN_CLASS);
    menu.classList.add('is-open'); // portal 后 menu 与 root 没父子关系，用独立 class 触发 display
    button.setAttribute('aria-expanded', 'true');
    positionMenu();
    const selectedIndex = select.selectedIndex >= 0 ? select.selectedIndex : 0;
    setActiveIndex(selectedIndex);
    // 滚动 / resize 时跟随 button 位置
    scrollHandler = () => { if (root.classList.contains(OPEN_CLASS)) positionMenu(); };
    resizeHandler = scrollHandler;
    window.addEventListener('scroll', scrollHandler, true);
    window.addEventListener('resize', resizeHandler);
    currentOpen = { root, menu, button, close: closeMenu };
  }

  function closeMenu() {
    if (!root.classList.contains(OPEN_CLASS)) return;
    root.classList.remove(OPEN_CLASS);
    menu.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
    setActiveIndex(-1);
    if (scrollHandler) {
      window.removeEventListener('scroll', scrollHandler, true);
      window.removeEventListener('resize', resizeHandler);
      scrollHandler = null;
      resizeHandler = null;
    }
    if (currentOpen && currentOpen.root === root) currentOpen = null;
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (root.classList.contains(OPEN_CLASS)) closeMenu();
    else openMenu();
  });

  button.addEventListener('keydown', (e) => {
    const key = e.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
      e.preventDefault();
      if (!root.classList.contains(OPEN_CLASS)) {
        openMenu();
        return;
      }
    }
    if (!root.classList.contains(OPEN_CLASS)) return;
    const count = select.options.length;
    if (key === 'ArrowDown') {
      setActiveIndex(Math.min(count - 1, (activeIndex < 0 ? 0 : activeIndex + 1)));
    } else if (key === 'ArrowUp') {
      setActiveIndex(Math.max(0, (activeIndex < 0 ? count - 1 : activeIndex - 1)));
    } else if (key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (key === 'End') {
      e.preventDefault();
      setActiveIndex(count - 1);
    } else if (key === 'Enter' || key === ' ') {
      if (activeIndex >= 0) {
        const opt = select.options[activeIndex];
        if (opt && !opt.disabled) {
          commitValue(opt.value);
          closeMenu();
        }
      }
    } else if (key === 'Tab') {
      closeMenu();
    }
  });

  // 外部改变 select.value 时（比如 loadSyncSettings）同步 button 显示
  select.addEventListener('change', () => {
    refreshButtonLabel();
    if (root.classList.contains(OPEN_CLASS)) renderMenu();
  });

  refreshButtonLabel();
}

export function enhanceAllCustomSelects(root) {
  const scope = root || document;
  const selects = scope.querySelectorAll('select[data-custom-select="true"]');
  selects.forEach((s) => enhanceOne(s));
}
