/* Shared DOM primitives for canonical screens. No domain logic belongs here. */

export function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

export function uiButton(label, { cls = '', ariaLabel, pressed, onClick } = {}) {
  const node = h('button', cls, label);
  node.type = 'button';
  if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
  if (pressed != null) node.setAttribute('aria-pressed', String(!!pressed));
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

export function screen(title, { subtitle, actions, id } = {}) {
  const root = h('section', 'ui-screen');
  if (id) root.dataset.screen = id;
  const head = h('header', 'ui-screen-head');
  const copy = h('div', 'ui-screen-head-copy');
  const heading = h('h1', 'ui-screen-title', title);
  copy.append(heading);
  if (subtitle) copy.append(h('p', 'ui-screen-subtitle', subtitle));
  head.append(copy);
  if (actions) head.append(actions);
  const body = h('div', 'ui-screen-body');
  root.append(head, body);
  return { root, head, body, heading };
}

export function card(title, { subtitle, className = '' } = {}) {
  const root = h('section', ('ui-card ' + className).trim());
  if (title) root.append(h('h2', 'ui-card-title', title));
  if (subtitle) root.append(h('p', 'ui-card-subtitle', subtitle));
  const body = h('div', 'ui-card-body');
  root.append(body);
  return { root, body };
}

export function emptyState(title, text, action) {
  const root = h('div', 'ui-state ui-empty-state');
  root.append(h('strong', 'ui-state-title', title));
  if (text) root.append(h('p', 'ui-state-text', text));
  if (action) root.append(action);
  return root;
}

export function loadingState(text = '読み込み中…') {
  const root = h('div', 'ui-state ui-loading-state');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  const spinner = h('span', 'ui-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  root.append(spinner, h('span', null, text));
  return root;
}

export function errorState(title, text, action) {
  const root = h('div', 'ui-state ui-error-state');
  root.setAttribute('role', 'alert');
  root.append(h('strong', 'ui-state-title', title));
  if (text) root.append(h('p', 'ui-state-text', text));
  if (action) root.append(action);
  return root;
}

const EVIDENCE = {
  confirmed: ['Confirmed', '確認済み'],
  likely: ['Likely', '可能性が高い'],
  unverified: ['Unverified', '未確認'],
  contradicted: ['Contradicted', '矛盾あり'],
};

export function evidenceBadge(status, { ja = true, detail } = {}) {
  const key = EVIDENCE[status] ? status : 'unverified';
  const node = h('span', 'evidence-badge evidence-' + key, ja ? EVIDENCE[key][1] : EVIDENCE[key][0]);
  node.dataset.evidence = key;
  node.setAttribute('aria-label', (ja ? EVIDENCE[key][1] : EVIDENCE[key][0]) + (detail ? ': ' + detail : ''));
  return node;
}

export function tabs(items, active, onChange, { orientation = 'horizontal' } = {}) {
  const root = h('div', 'ui-tabs');
  root.setAttribute('role', 'tablist');
  root.setAttribute('aria-orientation', orientation === 'vertical' ? 'vertical' : 'horizontal');
  const buttons = [];
  const activate = (index, { focus = true } = {}) => {
    const button = buttons[index];
    const item = items[index];
    if (!button || !item || button.disabled) return;
    if (typeof onChange === 'function') onChange(item.id);
    if (focus) button.focus({ preventScroll: true });
  };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const selected = item.id === active;
    const b = uiButton(item.label, {
      cls: 'ui-tab' + (selected ? ' active' : ''),
      onClick: () => activate(index, { focus: false }),
    });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = selected ? 0 : -1;
    if (item.disabled) b.disabled = true;
    if (item.tabId) b.id = String(item.tabId);
    if (item.panelId) b.setAttribute('aria-controls', String(item.panelId));
    buttons.push(b);
    root.append(b);
  }
  root.addEventListener('keydown', (event) => {
    const current = buttons.indexOf(document.activeElement);
    if (current < 0) return;
    const vertical = orientation === 'vertical';
    const previousKey = vertical ? 'ArrowUp' : 'ArrowLeft';
    const nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
    let target = null;
    if (event.key === 'Home') target = firstEnabled(buttons);
    else if (event.key === 'End') target = lastEnabled(buttons);
    else if (event.key === previousKey) target = nextEnabled(buttons, current, -1);
    else if (event.key === nextKey) target = nextEnabled(buttons, current, 1);
    if (target == null) return;
    event.preventDefault();
    activate(target);
  });
  return root;
}

function firstEnabled(buttons) { return buttons.findIndex((button) => !button.disabled); }
function lastEnabled(buttons) {
  for (let index = buttons.length - 1; index >= 0; index--) if (!buttons[index].disabled) return index;
  return -1;
}
function nextEnabled(buttons, start, direction) {
  if (!buttons.length) return -1;
  for (let step = 1; step <= buttons.length; step++) {
    const index = (start + direction * step + buttons.length) % buttons.length;
    if (!buttons[index].disabled) return index;
  }
  return -1;
}

export function sectionTitle(title, detail) {
  const wrap = h('div', 'ui-section-heading');
  wrap.append(h('h2', null, title));
  if (detail) wrap.append(h('span', null, detail));
  return wrap;
}

export function listRow({ title, subtitle, meta, badge, onClick, mono = false }) {
  const tag = onClick ? 'button' : 'div';
  const row = h(tag, 'ui-list-row' + (mono ? ' mono' : ''));
  if (onClick) {
    row.type = 'button';
    row.addEventListener('click', onClick);
  }
  const main = h('span', 'ui-list-row-main');
  main.append(h('strong', 'ui-list-row-title', title));
  if (subtitle) main.append(h('span', 'ui-list-row-subtitle', subtitle));
  row.append(main);
  const tail = h('span', 'ui-list-row-tail');
  if (badge) tail.append(badge);
  if (meta) tail.append(h('span', 'ui-list-row-meta', meta));
  if (onClick) tail.append(h('span', 'ui-chevron', '›'));
  if (tail.childNodes.length) row.append(tail);
  return row;
}

function validLazySource(value) {
  return value && !Array.isArray(value) && Number.isSafeInteger(value.length) && value.length >= 0 && typeof value.itemAt === 'function';
}

function sourceLength(value) {
  if (Array.isArray(value)) return value.length;
  if (validLazySource(value)) return value.length;
  return 0;
}

function sourceItem(value, index) {
  return Array.isArray(value) ? value[index] : value.itemAt(index);
}

/*
 * Windowed list: only visible rows exist in the DOM.
 *
 * `items` may be a normal Array or a lazy source `{ length, itemAt(index) }`.
 * The latter is important for 100k–300k function indexes on iPad: the UI can
 * expose every function without first allocating one JS object per function.
 */
export class VirtualList {
  constructor({ items = [], rowHeight = 60, overscan = 6, renderRow, ariaLabel = '一覧' } = {}) {
    this.items = items;
    this.rowHeight = Math.max(44, rowHeight);
    this.overscan = overscan;
    this.renderRow = renderRow;
    this.root = h('div', 'ui-virtual-list');
    this.root.setAttribute('role', 'list');
    this.root.setAttribute('aria-label', ariaLabel);
    this.root.tabIndex = 0;
    this.spacer = h('div', 'ui-virtual-spacer');
    this.window = h('div', 'ui-virtual-window');
    this.root.append(this.spacer, this.window);
    this.onScroll = () => this.render();
    this.root.addEventListener('scroll', this.onScroll, { passive: true });
    this.setItems(items);
  }

  setItems(items) {
    this.items = Array.isArray(items) || validLazySource(items) ? items : [];
    this.spacer.style.height = (sourceLength(this.items) * this.rowHeight) + 'px'; // runtime geometry
    this.first = undefined;
    this.last = undefined;
    this.render(true);
  }

  render(reset = false) {
    const active = document.activeElement;
    const focusedIndex = active && this.window.contains(active) ? Number(active.dataset.virtualIndex) : null;
    if (reset) this.root.scrollTop = 0;
    const height = this.root.clientHeight || 480;
    const length = sourceLength(this.items);
    const first = Math.max(0, Math.floor(this.root.scrollTop / this.rowHeight) - this.overscan);
    const count = Math.ceil(height / this.rowHeight) + this.overscan * 2;
    const last = Math.min(length, first + count);
    if (first === this.first && last === this.last) return;
    this.first = first; this.last = last;
    const frag = document.createDocumentFragment();
    for (let index = first; index < last; index++) {
      const row = this.renderRow(sourceItem(this.items, index), index);
      row.classList.add('ui-virtual-row');
      row.setAttribute('role', 'listitem');
      row.dataset.virtualIndex = String(index);
      if (!row.id) row.id = `ui-virtual-row-${index}`;
      row.style.height = this.rowHeight + 'px'; // virtualization geometry
      frag.append(row);
    }
    this.window.replaceChildren(frag);
    this.window.style.transform = `translateY(${first * this.rowHeight}px)`; // virtualization geometry

    if (Number.isInteger(focusedIndex)) {
      const replacement = this.window.querySelector(`[data-virtual-index="${focusedIndex}"]`);
      if (replacement && typeof replacement.focus === 'function') {
        replacement.focus({ preventScroll: true });
      } else {
        // Never allow virtualization alone to dump keyboard/VoiceOver focus on
        // document.body. Preserve the logical list as the focus owner.
        this.root.dataset.activeVirtualIndex = String(focusedIndex);
        this.root.focus({ preventScroll: true });
      }
    }
  }

  getState() { return { scrollTop: this.root.scrollTop, activeIndex: this.root.dataset.activeVirtualIndex || null }; }
  restoreState(state) {
    if (!state) return;
    this.root.scrollTop = Number(state.scrollTop) || 0;
    if (state.activeIndex != null) this.root.dataset.activeVirtualIndex = String(state.activeIndex);
    this.render();
  }
  dispose() { this.root.removeEventListener('scroll', this.onScroll); }
}