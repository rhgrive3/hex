/*
 * UI primitives: sheets, menus, dialogs, toasts.
 * Everything is built with createElement + textContent — no innerHTML anywhere,
 * so file names and disassembly text can never be interpreted as markup.
 */

import { t } from './i18n.js';

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
      button(t('btn.done'), 'tb-btn', () => this.close()));
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

/* ── 読み物のための部品（用語集・学習コース・詳細解説） ─────── */

/** 小見出し。 */
export function heading(text) { return el('h4', 'doc-h', text); }

/** 段落。改行はそのまま活かす。 */
export function para(text, cls) {
  const p = el('p', 'doc-p' + (cls ? ' ' + cls : ''));
  p.textContent = text;
  return p;
}

/** 等幅のブロック。命令の例やメモリ図に使う。横にはみ出す場合はスクロール。 */
export function codeBlock(lines) {
  const pre = el('pre', 'doc-code');
  pre.textContent = Array.isArray(lines) ? lines.join('\n') : String(lines);
  return pre;
}

/** 目立たせたい補足。 */
export function noteBox(text) { return el('div', 'doc-note', text); }

/** 箇条書き。 */
export function bullets(items) {
  const ul = el('ul', 'doc-list');
  for (const it of items) ul.append(el('li', null, it));
  return ul;
}

/** 用語へのリンクを横に並べたもの。 */
export function termChips(ids, labelFor, onTap) {
  const wrap = el('div', 'termchips');
  for (const id of ids) {
    const label = labelFor(id);
    if (!label) continue;
    wrap.append(button(label, 'termchip', () => onTap(id)));
  }
  return wrap.childElementCount ? wrap : null;
}

/** 見出しつきの区切り（詳細画面の各ブロック）。 */
export function block(title) {
  const d = el('div', 'blk');
  if (title) d.append(el('div', 'blk-title', title));
  return d;
}

/**
 * たたんでおける区切り。「まず日本語、次に処理、最後に ARM64」という順で
 * 見せるために使う。中身は open のときだけ組み立てる（重い一覧を抱えないため）。
 *
 * @param {string} title
 * @param {{open?:boolean, build?:function(HTMLElement):void}} opts
 */
export function disclosure(title, { open = false, build } = {}) {
  const d = el('details', 'disc');
  const s = el('summary', 'disc-sum', title);
  d.append(s);
  const body = el('div', 'disc-body');
  d.append(body);
  let built = false;
  const fill = () => {
    if (built || !build) return;
    built = true;
    build(body);
  };
  if (open) { d.open = true; fill(); }
  d.addEventListener('toggle', () => { if (d.open) fill(); });
  d.body = body;
  return d;
}

/** 値をタップでコピーできる大きめの表示。 */
export function bigValue(text, onTap) {
  const d = el('div', 'bigval mono', text);
  if (onTap) { d.classList.add('tappable'); d.addEventListener('click', onTap); }
  return d;
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

export function alertDialog(title, message, { confirmLabel = t('btn.ok'), onConfirm } = {}) {
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
  const s = String(text);
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(s);
      toast(t('toast.copied', { what: label || '' }));
      return true;
    } catch { /* no gesture left, or permission denied — try the old way */ }
  }
  if (legacyCopy(s)) {
    toast(t('toast.copied', { what: label || '' }));
    return true;
  }
  toast(t('err.copyFailed'));
  return false;
}

function legacyCopy(text) {
  try {
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
    return !!ok;
  } catch { return false; }
}

/**
 * Copy text that is still being assembled.
 *
 * Gathering a range means awaiting the worker, and by the time it answers the
 * tap that started the copy no longer counts as a user gesture — Safari would
 * reject a plain writeText(). Handing ClipboardItem the *promise* keeps the
 * gesture alive, so the write is authorised up front and settles when the text
 * is ready. Engines without that path fall back to waiting and writing.
 */
export async function copyTextLazy(textPromise, label) {
  const settled = Promise.resolve(textPromise);
  settled.catch(() => {});          // the handler below reports it
  if (navigator.clipboard && navigator.clipboard.write &&
      window.isSecureContext && typeof window.ClipboardItem === 'function') {
    try {
      const blob = settled.then((text) => new Blob([String(text)], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      toast(t('toast.copied', { what: label || '' }));
      return true;
    } catch {
      /* Older engines only accept a resolved value; fall through. */
    }
  }
  let text;
  try {
    text = await settled;
  } catch (err) {
    toast((err && err.message) ? err.message : t('err.copyFailed'));
    return false;
  }
  return copyText(text, label);
}
