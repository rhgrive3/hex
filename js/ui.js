/*
 * UI primitives: sheets, menus, dialogs, toasts.
 * Everything is built with createElement + textContent — no innerHTML anywhere,
 * so file names and disassembly text can never be interpreted as markup.
 */

const overlays = () => document.getElementById('overlays');

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function button(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/* ── Sheet ──────────────────────────────────────────────────── */

let openSheet = null;

export class Sheet {
  constructor(title, { onClose, anchor, dim } = {}) {
    this.backdrop = el('div', 'backdrop' + (dim === 'light' ? ' light' : ''));
    this.root = el('div', 'sheet' + (anchor === 'bottom' ? ' bottom' : ''));
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');

    const head = el('div', 'sheet-head');
    const spacer = el('div');
    spacer.style.minWidth = '44px';
    head.append(spacer, el('div', 'sheet-title', title),
      button('Done', 'tb-btn', () => this.close()));
    this.body = el('div', 'sheet-body');
    this.root.append(head, this.body);

    this.onClose = onClose;
    this.backdrop.addEventListener('click', () => this.close());
    overlays().append(this.backdrop, this.root);

    if (openSheet) openSheet.close();
    openSheet = this;
  }

  close() {
    if (!this.root.isConnected) return;
    this.backdrop.remove();
    this.root.remove();
    if (openSheet === this) openSheet = null;
    if (this.onClose) this.onClose();
  }
}

export function closeTopSheet() {
  if (openSheet) { openSheet.close(); return true; }
  return false;
}

/* ── List helpers ───────────────────────────────────────────── */

export function list() { return el('ul', 'list'); }

export function groupRow(label) {
  const li = el('li', 'grp', label);
  return li;
}

export function kvRow(k, v, sub) {
  const li = el('li');
  li.append(el('span', 'k', k));
  const val = el('span', 'v', v == null ? '—' : String(v));
  if (sub) val.append(el('span', 'sub', sub));
  li.append(val);
  return li;
}

export function tapRow(label, { sub, right, tag, tagClass, disabled, indent, onTap } = {}) {
  const li = el('li', disabled ? 'disabled' : 'tappable');
  const main = el('div');
  main.style.minWidth = '0';
  main.append(el('span', null, label));
  if (sub) main.append(el('span', 'sub', sub));
  li.append(main);
  if (indent) li.classList.add('indent');
  if (tag) li.append(el('span', 'tag' + (tagClass ? ' ' + tagClass : ''), tag));
  if (right) li.append(el('span', 'v', right));
  if (!disabled && onTap) li.addEventListener('click', onTap);
  return li;
}

/* ── Menu (long-press / ⋯) ──────────────────────────────────── */

let openMenu = null;

export function menu(items, x, y) {
  closeMenu();
  const backdrop = el('div', 'backdrop');
  backdrop.style.background = 'transparent';
  const m = el('div', 'menu');
  for (const it of items) {
    if (it === '-') { m.append(el('hr')); continue; }
    m.append(button(it.label, null, () => { closeMenu(); it.action(); }));
  }
  overlays().append(backdrop, m);

  const r = m.getBoundingClientRect();
  const pad = 8;
  let left = Math.min(Math.max(pad, x - r.width / 2), window.innerWidth - r.width - pad);
  let top = y + 8;
  if (top + r.height > window.innerHeight - pad) top = Math.max(pad, y - r.height - 8);
  m.style.left = Math.round(left) + 'px';
  m.style.top = Math.round(top) + 'px';

  const close = () => closeMenu();
  backdrop.addEventListener('click', close);
  openMenu = { m, backdrop };
}

export function closeMenu() {
  if (!openMenu) return false;
  openMenu.m.remove();
  openMenu.backdrop.remove();
  openMenu = null;
  return true;
}

/* ── Dialog ─────────────────────────────────────────────────── */

export function alertDialog(title, message, { confirmLabel = 'OK', onConfirm } = {}) {
  const backdrop = el('div', 'backdrop');
  const d = el('div', 'dialog');
  d.setAttribute('role', 'alertdialog');
  d.append(el('h3', null, title), el('p', null, message));
  const actions = el('div', 'actions');
  const done = () => { backdrop.remove(); d.remove(); if (onConfirm) onConfirm(); };
  actions.append(button(confirmLabel, null, done));
  d.append(actions);
  overlays().append(backdrop, d);
  backdrop.addEventListener('click', done);
  return d;
}

/* ── Toast ──────────────────────────────────────────────────── */

let toastEl = null, toastTimer = 0;

export function toast(text) {
  if (!toastEl) {
    toastEl = el('div', 'toast');
    overlays().append(toastEl);
  }
  toastEl.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 1900);
}

/* ── Clipboard ──────────────────────────────────────────────── */

export async function copyText(text, label) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('copy rejected');
    }
    toast((label || 'Copied') + ' — copied');
  } catch {
    toast('Could not copy. Long-press the value to select it.');
  }
}
