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

/* ── Sheet ──────────────────────────────────────────────────────
 *
 * シートは 1 枚ずつではなく、**重なり**として持つ。
 *
 * 以前は新しいシートを開くたびに前のシートを捨てていたので、
 * 「解析ツール → 逆コンパイル」と 2 つ潜ったら、閉じるボタンで一気に
 * 画面まで戻るしかなかった（道具箱には戻れない）。
 *
 * ここでは、閉じたシートをその場では捨てずに一旦「待たせて」おく。
 * 同じ処理の流れの中で次のシートが作られたら、待っていた方を親として
 * つなぎ、戻るボタンでそこへ帰れるようにする。誰も次を開かなければ、
 * そのときに初めて親ごと片付ける（＝「完了」を押したときの動き）。
 *
 * この仕組みのおかげで、呼ぶ側は今までどおり
 *   sheet.close(); showSomething();
 * と書くだけでよく、書き換えなくても戻れるようになる。
 */

let openSheet = null;
let parkedSheet = null;      // 閉じたが、まだ捨てていないシート
let parkTimer = 0;

const MAX_DEPTH = 8;         // 重ねすぎ（＝DOM の持ちすぎ）を防ぐ

export class Sheet {
  constructor(title, { onClose, anchor, dim, size } = {}) {
    this.backdrop = el('div', 'backdrop' + (dim === 'light' ? ' light' : ''));
    this.root = el('div', 'sheet' +
      (anchor === 'bottom' ? ' bottom' : '') +
      (size === 'full' ? ' full' : size === 'wide' ? ' wide' : ''));
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');

    /* 親を決める。直前のシートがあれば、それが親になる。 */
    this.parent = null;
    if (parkedSheet) {
      this.parent = parkedSheet;
      parkedSheet = null;
      clearTimeout(parkTimer);
    } else if (openSheet) {
      this.parent = openSheet;
      openSheet.park();
    }
    /* 深くなりすぎたら、いちばん古いものから捨てる。 */
    let depth = 0;
    for (let p = this.parent; p; p = p.parent) {
      depth++;
      if (depth >= MAX_DEPTH && p.parent) { p.parent.destroyChain(); p.parent = null; break; }
    }

    const head = el('div', 'sheet-head');
    if (this.parent) {
      this.backBtn = button('‹ ' + t('btn.back'), 'tb-btn back', () => this.back());
      head.append(this.backBtn);
    } else {
      const spacer = el('div');
      spacer.style.minWidth = '52px';
      head.append(spacer);
    }
    this.titleEl = el('div', 'sheet-title', title);
    head.append(this.titleEl, button(t('btn.done'), 'tb-btn', () => this.close()));
    this.body = el('div', 'sheet-body');
    this.root.append(head, this.body);

    this.onClose = onClose;
    /* 背景を押したときは 1 枚戻る。全部消えるより迷わない。 */
    this.backdrop.addEventListener('click', () => this.back());
    overlays().append(this.backdrop, this.root);
    openSheet = this;
  }

  /** 見出しを後から差し替える（中身が決まってから名前が付く画面のため）。 */
  setTitle(text) { if (this.titleEl) this.titleEl.textContent = text; }

  /** 表示から外すだけ。中身も onClose も生かしたまま。 */
  park() {
    this.root.classList.add('parked');
    this.backdrop.classList.add('parked');
    if (openSheet === this) openSheet = null;
  }

  /** 親として待たせていたものを、また表に出す。 */
  unpark() {
    this.root.classList.remove('parked');
    this.backdrop.classList.remove('parked');
    openSheet = this;
  }

  /** このシートだけを捨てる。 */
  destroy() {
    if (!this.root.isConnected) return;
    this.backdrop.remove();
    this.root.remove();
    if (openSheet === this) openSheet = null;
    if (parkedSheet === this) parkedSheet = null;
    if (this.onClose) this.onClose();
  }

  /** このシートと、その親をすべて捨てる。 */
  destroyChain() {
    let p = this.parent;
    this.parent = null;
    this.destroy();
    while (p) { const next = p.parent; p.parent = null; p.destroy(); p = next; }
  }

  /** 1 枚戻る。親がいなければ、そのまま閉じる。 */
  back() {
    const parent = this.parent;
    this.parent = null;
    this.destroy();
    if (parent) parent.unpark();
  }

  /**
   * 閉じる。
   *
   * ただしその場では捨てない。同じ流れの中で次のシートが作られたら
   * 「移動」だったと分かるので、そのときは親として残す。
   * 誰も開かなければ、重なりごと片付ける。
   */
  close() {
    if (!this.root.isConnected) return;
    this.park();
    parkedSheet = this;
    clearTimeout(parkTimer);
    parkTimer = setTimeout(() => {
      if (parkedSheet === this) { parkedSheet = null; this.destroyChain(); }
    }, 0);
  }
}

/** Esc・端末の戻る操作。1 枚だけ戻る。 */
export function closeTopSheet() {
  if (openSheet) { openSheet.back(); return true; }
  return false;
}

/** 重なりをまとめて閉じる（ファイルを開き直したときなど）。 */
export function closeAllSheets() {
  clearTimeout(parkTimer);
  const s = openSheet || parkedSheet;
  parkedSheet = null;
  if (s) { s.destroyChain(); return true; }
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

export function tapRow(label, { sub, right, tag, tagClass, disabled, indent, mono, onTap } = {}) {
  const li = el('li', disabled ? 'disabled' : 'tappable');
  const main = el('div');
  main.style.minWidth = '0';
  // 式や命令を並べる行は等幅で。桁がそろわないと、式は式として読めない。
  main.append(el('span', mono ? 'mono' : null, label));
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

function viewportRect() {
  const vv = window.visualViewport;
  if (!vv) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height };
}

function armMenuDismiss(entry) {
  const outside = (e) => {
    if (!openMenu || openMenu !== entry || entry.m.contains(e.target)) return;
    // Native context menus consume the first outside tap. Do the same here so
    // removing the transparent backdrop cannot accidentally activate a button
    // underneath it on iOS Safari.
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    closeMenu();
  };
  const key = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    }
  };
  const move = () => closeMenu();

  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', move, { passive: true });
  window.addEventListener('orientationchange', move, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', move, { passive: true });
    window.visualViewport.addEventListener('scroll', move, { passive: true });
  }

  entry.cleanup = () => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', move);
    window.removeEventListener('orientationchange', move);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', move);
      window.visualViewport.removeEventListener('scroll', move);
    }
  };
}

export function menu(items, x, y) {
  closeMenu();
  const backdrop = el('div', 'backdrop');
  backdrop.style.background = 'transparent';
  const m = el('div', 'menu');
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') { m.append(el('hr')); continue; }
    const b = button(it.label, null, () => { closeMenu(); it.action(); });
    b.setAttribute('role', 'menuitem');
    /* まだ押せないものは、消さずに「今は押せない」と見せる（項目が動くと迷うため）。 */
    if (it.disabled) { b.disabled = true; b.classList.add('is-disabled'); }
    m.append(b);
  }
  overlays().append(backdrop, m);

  const r = m.getBoundingClientRect();
  const vv = viewportRect();
  const pad = 8;
  const maxLeft = vv.left + vv.width - r.width - pad;
  const maxTop = vv.top + vv.height - r.height - pad;
  let left = Math.min(Math.max(vv.left + pad, x - r.width / 2), Math.max(vv.left + pad, maxLeft));
  let top = y + 8;
  if (top > maxTop) top = Math.max(vv.top + pad, y - r.height - 8);
  m.style.left = Math.round(left) + 'px';
  m.style.top = Math.round(top) + 'px';

  const entry = { m, backdrop, cleanup: null };
  openMenu = entry;
  // Keep the backdrop click as a simple fallback, but capture pointerdown at
  // document level too. Safari can occasionally retarget a tap during a
  // long-press/callout transition, which used to leave this menu stuck open.
  backdrop.addEventListener('click', () => closeMenu());
  armMenuDismiss(entry);
}

export function closeMenu() {
  if (!openMenu) return false;
  const entry = openMenu;
  openMenu = null;
  if (entry.cleanup) entry.cleanup();
  entry.m.remove();
  entry.backdrop.remove();
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
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    overlays().append(toastEl);
  }
  toastEl.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 1900);
}

/* ── Clipboard ──────────────────────────────────────────────── */

async function modernCopy(text) {
  if (!navigator.clipboard || !navigator.clipboard.writeText || !window.isSecureContext) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text, label) {
  const s = String(text);
  const ok = await modernCopy(s) || legacyCopy(s);
  toast(ok ? t('toast.copied', { what: label || '' }) : t('err.copyFailed'));
  return ok;
}

function legacyCopy(text) {
  let ta = null;
  const active = document.activeElement;
  const selection = window.getSelection ? window.getSelection() : null;
  const ranges = [];
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
  }
  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;

  try {
    ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('aria-hidden', 'true');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('spellcheck', 'false');
    // iOS Safari is less reliable when the selection lives in a readonly or
    // display:none/fully transparent control. Keep a 1px editable control in
    // the rendered tree, far outside the viewport, for the duration of copy.
    Object.assign(ta.style, {
      position: 'fixed',
      left: '-9999px',
      top: '0',
      width: '1px',
      height: '1px',
      padding: '0',
      border: '0',
      opacity: '0.01',
      fontSize: '16px',
      pointerEvents: 'none',
    });
    document.body.appendChild(ta);
    try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    return !!document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (ta) ta.remove();
    if (selection) {
      try {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      } catch { /* selection restoration is best effort */ }
    }
    if (active && active !== document.body && typeof active.focus === 'function') {
      try { active.focus({ preventScroll: true }); } catch { /* best effort */ }
    }
    if (typeof window.scrollTo === 'function') {
      try { window.scrollTo(scrollX, scrollY); } catch { /* best effort */ }
    }
  }
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
      /* Older WebKit builds reject a promised ClipboardItem; fall through. */
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
