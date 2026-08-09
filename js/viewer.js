/*
 * Virtualized code viewer.
 *
 * Two things make this survive multi-hundred-megabyte inputs:
 *
 *  1. Only the rows on screen exist in the DOM. Row elements are pooled and
 *     reused; nothing is created or destroyed while scrolling.
 *
 *  2. The scroll container is never taller than WINDOW_PX. It shows a *window*
 *     of `windowRows` rows starting at `baseRow`; when the user scrolls near
 *     either end of that window (and the scroll has come to rest) the window is
 *     re-based and scrollTop is shifted by the same amount, so the pixels on
 *     screen do not move. That keeps native inertial scrolling intact while
 *     addressing an arbitrarily large region.
 *
 * ARM64 is fixed-width, so row ↔ address is exact:  addr = vmAddr + row * 4.
 */
import { CHUNK_ROWS } from './backend.js';
import { addrText, bytesHex, bytesAscii, mnemonicClass } from './format.js';

const WINDOW_PX = 6_000_000;    // well inside every browser's scroll limit
const OVERSCAN = 6;             // rows rendered above/below the viewport
const IDLE_MS = 140;            // "scrolling has stopped" threshold
const PREFETCH_CHUNKS = 1;

const IMM_RE = /(#?-?0x[0-9a-f]+|#-?\d+)/gi;

export class CodeViewer {
  constructor(opts) {
    this.vp = opts.viewport;
    this.rowsEl = opts.rows;
    this.backend = opts.backend;
    this.onTopChange = opts.onTopChange || (() => {});
    this.onSelect = opts.onSelect || (() => {});
    this.onLongPress = opts.onLongPress || (() => {});

    this.region = null;
    this.mode = 'asm';
    this.hexJoined = false;
    this.totalRows = 0;
    this.windowRows = 0;
    this.baseRow = 0;
    this.rowH = 24;
    this.pool = [];
    this.selectedRow = -1;
    this.markedRow = -1;
    this.frame = 0;
    this.idleTimer = 0;
    this.lastTopRow = -1;

    this._onScroll = this._onScroll.bind(this);
    this._render = this._render.bind(this);
    this.vp.addEventListener('scroll', this._onScroll, { passive: true });

    this._bindPointer();
    this.measure();
  }

  /* ── geometry ─────────────────────────────────────────────── */

  measure() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
    const h = parseFloat(raw);
    this.rowH = h > 0 ? h : 24;
    this._recomputeWindow(true);
  }

  _recomputeWindow(keepPosition) {
    const maxWindowRows = Math.max(1, Math.floor(WINDOW_PX / this.rowH));
    const anchor = keepPosition ? this.topRow() : 0;
    this.windowRows = Math.min(this.totalRows, maxWindowRows);
    this.maxBase = Math.max(0, this.totalRows - this.windowRows);
    this.baseRow = Math.min(this.baseRow, this.maxBase);
    this.rowsEl.style.height = (this.windowRows * this.rowH) + 'px';
    if (keepPosition && this.totalRows) this.goToRow(anchor, 'top');
    else this.invalidate();
  }

  visibleRows() {
    return Math.max(1, Math.floor(this.vp.clientHeight / this.rowH));
  }

  topRow() {
    return Math.min(Math.max(0, this.totalRows - 1),
                    this.baseRow + Math.floor(this.vp.scrollTop / this.rowH));
  }

  topAddress() {
    if (!this.region) return null;
    return this.region.vmAddr + BigInt(this.topRow()) * 4n;
  }

  rowAddress(row) {
    return this.region.vmAddr + BigInt(row) * 4n;
  }

  /* ── content ──────────────────────────────────────────────── */

  setRegion(region) {
    this.region = region;
    this.totalRows = region ? Number((region.size + 3n) / 4n) : 0;
    this.baseRow = 0;
    this.selectedRow = -1;
    this.markedRow = -1;
    this.lastTopRow = -1;          // force the address bar to refresh
    this.vp.scrollTop = 0;
    this._recomputeWindow(false);
    this.invalidate();
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.vp.classList.toggle('mode-asm', mode === 'asm');
    this.vp.classList.toggle('mode-hex', mode === 'hex');
    for (const el of this.pool) { el._hex = null; el._ops = null; el._mn = null; }
    this.invalidate();
  }

  setHexJoined(on) {
    this.hexJoined = !!on;
    for (const el of this.pool) el._hex = null;
    this.invalidate();
  }

  wantAsm() {
    return this.mode === 'asm' && !!(this.region && this.region.disasm !== false);
  }

  /* ── navigation ───────────────────────────────────────────── */

  clampRow(row) {
    if (!this.totalRows) return 0;
    return Math.max(0, Math.min(this.totalRows - 1, row));
  }

  /** where: 'top' | 'center' | 'third' */
  goToRow(row, where = 'third') {
    if (!this.totalRows) return;
    row = this.clampRow(row);
    const vpH = this.vp.clientHeight;
    let lead = 0;
    if (where === 'center') lead = Math.max(0, Math.floor((vpH - this.rowH) / 2));
    else if (where === 'third') lead = Math.max(0, Math.floor(vpH / 3));
    lead = Math.floor(lead / this.rowH) * this.rowH;

    const windowPx = this.windowRows * this.rowH;
    if (this.maxBase > 0) {
      const desiredBase = row - Math.floor(this.windowRows / 2);
      this.baseRow = Math.max(0, Math.min(this.maxBase, desiredBase));
    } else {
      this.baseRow = 0;
    }
    const local = row - this.baseRow;
    const top = Math.max(0, Math.min(windowPx - vpH, local * this.rowH - lead));
    this.vp.scrollTop = top;
    this.invalidate();
  }

  goToAddress(addr) {
    if (!this.region) return false;
    const rel = addr - this.region.vmAddr;
    if (rel < 0n || rel >= this.region.size) return false;
    this.goToRow(Number(rel / 4n), 'third');
    return true;
  }

  scrollByRows(n) {
    const target = this.topRow() + n;
    this.goToRow(target, 'top');
  }

  scrollByPages(n) {
    this.scrollByRows(n * Math.max(1, this.visibleRows() - 2));
  }

  /** Highlight without moving (used by search results). */
  mark(row) {
    this.markedRow = row;
    this.invalidate();
  }

  select(row, notify = true) {
    if (row !== this.selectedRow) {
      this.selectedRow = row;
      this.invalidate();
    }
    if (notify) this.onSelect(row);
  }

  deselect() {
    if (this.selectedRow < 0) return;
    this.selectedRow = -1;
    this.invalidate();
  }

  /** Everything the detail panel needs for one row, or null if not loaded. */
  rowData(row) {
    if (!this.region || row < 0 || row >= this.totalRows) return null;
    const chunk = Math.floor(row / CHUNK_ROWS);
    const idx = row - chunk * CHUNK_ROWS;
    const entry = this.backend.peek(this.region.id, chunk, false);
    const out = {
      row,
      address: this.rowAddress(row),
      bytes: null,
      mnemonic: null,
      operands: null,
    };
    if (entry && entry.bytes) {
      const off = idx * 4;
      const n = Math.min(4, entry.bytes.length - off);
      if (n > 0) out.bytes = bytesHex(entry.bytes, off, n, true);
    }
    const asm = this.backend.peek(this.region.id, chunk, true);
    if (asm && asm.mn) {
      out.mnemonic = asm.mn[idx] || '';
      out.operands = asm.ops[idx] || '';
    }
    return out;
  }

  /* ── rendering ────────────────────────────────────────────── */

  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(this._render);
  }

  _onScroll() {
    this.invalidate();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this._rebase(), IDLE_MS);
  }

  /** Re-centre the scroll window once the user has stopped moving. */
  _rebase() {
    if (!this.maxBase || !this.totalRows) return;
    const windowPx = this.windowRows * this.rowH;
    const vpH = this.vp.clientHeight;
    const st = this.vp.scrollTop;
    const lo = windowPx * 0.25;
    const hi = windowPx * 0.75 - vpH;
    if (st > lo && st < hi) return;

    const target = Math.max(0, (windowPx - vpH) / 2);
    let delta = Math.round((st - target) / this.rowH);
    const newBase = Math.max(0, Math.min(this.maxBase, this.baseRow + delta));
    delta = newBase - this.baseRow;
    if (!delta) return;
    this.baseRow = newBase;
    this.vp.scrollTop = st - delta * this.rowH;
    this.invalidate();
  }

  _render() {
    this.frame = 0;
    if (!this.region || !this.totalRows) {
      for (const el of this.pool) el.style.display = 'none';
      return;
    }
    const rowH = this.rowH;
    const vpH = this.vp.clientHeight;
    const firstLocal = Math.max(0, Math.floor(this.vp.scrollTop / rowH) - OVERSCAN);
    const count = Math.min(
      this.windowRows - firstLocal,
      Math.ceil(vpH / rowH) + OVERSCAN * 2);
    const startRow = this.baseRow + firstLocal;
    const endRow = Math.min(this.totalRows, startRow + Math.max(0, count));

    this._ensurePool(endRow - startRow);
    const wantAsm = this.wantAsm();

    let chunkIdx = -1, entry = null, asmEntry = null;
    for (let r = startRow, i = 0; r < endRow; r++, i++) {
      const el = this.pool[i];
      const c = Math.floor(r / CHUNK_ROWS);
      if (c !== chunkIdx) {
        chunkIdx = c;
        entry = this.backend.peek(this.region.id, c, false);
        asmEntry = wantAsm ? this.backend.peek(this.region.id, c, true) : null;
        if (!entry || (wantAsm && !asmEntry)) this.backend.request(this.region.id, c, wantAsm);
      }
      this._paintRow(el, r, entry, asmEntry, (r - this.baseRow) * rowH);
    }
    for (let i = endRow - startRow; i < this.pool.length; i++) {
      if (this.pool[i].style.display !== 'none') this.pool[i].style.display = 'none';
    }

    // Prefetch neighbouring chunks so fast flicks stay filled in.
    const firstChunk = Math.floor(startRow / CHUNK_ROWS);
    const lastChunk = Math.floor((endRow - 1) / CHUNK_ROWS);
    const maxChunk = Math.floor((this.totalRows - 1) / CHUNK_ROWS);
    for (let c = Math.max(0, firstChunk - PREFETCH_CHUNKS); c <= Math.min(maxChunk, lastChunk + PREFETCH_CHUNKS); c++) {
      if (c >= firstChunk && c <= lastChunk) continue;
      this.backend.request(this.region.id, c, wantAsm);
    }

    const top = this.topRow();
    if (top !== this.lastTopRow) {
      this.lastTopRow = top;
      this.onTopChange(top, this.rowAddress(top));
    }
    this._updateScrubber();
  }

  _ensurePool(n) {
    while (this.pool.length < n) {
      const el = document.createElement('div');
      el.className = 'row';
      const a = document.createElement('span'); a.className = 'c-addr';
      const h = document.createElement('span'); h.className = 'c-hex';
      const m = document.createElement('span'); m.className = 'c-mn';
      const o = document.createElement('span'); o.className = 'c-ops';
      const s = document.createElement('span'); s.className = 'c-ascii';
      el.append(a, h, m, o, s);
      el._a = a; el._h = h; el._m = m; el._o = o; el._s = s;
      el._row = -1; el._addr = null; el._hex = null; el._mn = null; el._ops = null;
      el._ascii = null; el._top = -1; el._cls = '';
      this.rowsEl.appendChild(el);
      this.pool.push(el);
    }
  }

  _paintRow(el, row, entry, asmEntry, top) {
    if (el.style.display === 'none') el.style.display = '';
    if (el._top !== top) { el.style.top = top + 'px'; el._top = top; }
    el._row = row;

    const addr = addrText(this.rowAddress(row));
    if (el._addr !== addr) { el._a.textContent = addr; el._addr = addr; }

    const idx = row - Math.floor(row / CHUNK_ROWS) * CHUNK_ROWS;
    const off = idx * 4;
    const avail = entry && entry.bytes ? Math.min(4, entry.bytes.length - off) : 0;

    let hex = null, ascii = null;
    if (avail > 0) {
      hex = bytesHex(entry.bytes, off, avail, !this.hexJoined);
      if (this.mode === 'hex') ascii = bytesAscii(entry.bytes, off, avail);
    }
    const hexText = hex === null ? '·· ·· ·· ··' : hex;
    if (el._hex !== hexText) { el._h.textContent = hexText; el._hex = hexText; }
    if (this.mode === 'hex') {
      const asciiText = ascii === null ? '' : ascii;
      if (el._ascii !== asciiText) { el._s.textContent = asciiText; el._ascii = asciiText; }
    }

    let mn = '', ops = '';
    if (this.mode === 'asm') {
      if (asmEntry && asmEntry.mn) { mn = asmEntry.mn[idx] || ''; ops = asmEntry.ops[idx] || ''; }
      else if (entry && entry.error) { mn = '???'; ops = ''; }
      else { mn = '…'; ops = ''; }
      if (el._mn !== mn) { el._m.textContent = mn; el._mn = mn; }
      this._setOps(el, ops);
    } else if (el._mn !== '') {
      // Hex mode: clear the (hidden) assembly cells so nothing stale is kept.
      el._m.textContent = ''; el._mn = '';
      this._setOps(el, '');
    }

    let cls = 'row';
    if (this.mode === 'asm') {
      const k = (asmEntry && asmEntry.mn) ? mnemonicClass(mn) : '';
      if (k) cls += ' ' + k;
      if (!asmEntry || !asmEntry.mn) cls += ' pending';
    } else if (avail <= 0) cls += ' pending';
    if (row === this.selectedRow) cls += ' sel';
    if (row === this.markedRow) cls += ' hit';
    if (el._cls !== cls) { el.className = cls; el._cls = cls; }
  }

  /** Operand text with immediates coloured. Rebuilt only when it changes. */
  _setOps(el, str) {
    if (el._ops === str) return;
    el._ops = str;
    const target = el._o;
    if (!str) { target.textContent = ''; return; }
    IMM_RE.lastIndex = 0;
    if (!IMM_RE.test(str)) { target.textContent = str; return; }
    target.textContent = '';
    const parts = str.split(IMM_RE);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (i % 2 === 1) {
        const s = document.createElement('span');
        s.className = 'tok-imm';
        s.textContent = p;
        target.appendChild(s);
      } else {
        target.appendChild(document.createTextNode(p));
      }
    }
  }

  /* ── scrubber ─────────────────────────────────────────────── */

  attachScrubber(track, thumb) {
    this.track = track;
    this.thumb = thumb;
    let dragging = false;

    const posToRow = (clientY) => {
      const rect = track.getBoundingClientRect();
      const thumbH = this._thumbHeight(rect.height);
      const usable = Math.max(1, rect.height - thumbH);
      const y = Math.max(0, Math.min(usable, clientY - rect.top - thumbH / 2));
      const frac = y / usable;
      const span = Math.max(0, this.totalRows - this.visibleRows());
      return Math.round(frac * span);
    };

    track.addEventListener('pointerdown', (e) => {
      if (!this.totalRows) return;
      dragging = true;
      track.classList.add('dragging');
      track.setPointerCapture(e.pointerId);
      this.goToRow(posToRow(e.clientY), 'top');
      e.preventDefault();
    });
    track.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.goToRow(posToRow(e.clientY), 'top');
      e.preventDefault();
    });
    const end = () => { dragging = false; track.classList.remove('dragging'); };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  }

  _thumbHeight(trackH) {
    if (!this.totalRows) return 28;
    const frac = Math.min(1, this.visibleRows() / this.totalRows);
    return Math.max(28, Math.round(trackH * frac));
  }

  _updateScrubber() {
    if (!this.track) return;
    const trackH = this.track.clientHeight;
    if (!trackH || !this.totalRows) return;
    const thumbH = this._thumbHeight(trackH);
    const span = Math.max(1, this.totalRows - this.visibleRows());
    const frac = Math.max(0, Math.min(1, this.topRow() / span));
    const y = Math.round(frac * (trackH - thumbH));
    const style = this.thumb.style;
    const h = thumbH + 'px', t = y + 'px';
    if (style.height !== h) style.height = h;
    if (style.top !== t) style.top = t;
  }

  /* ── input ────────────────────────────────────────────────── */

  _bindPointer() {
    let downRow = -1, downX = 0, downY = 0, timer = 0, longFired = false, pid = -1;

    const rowFrom = (target) => {
      const el = target && target.closest ? target.closest('.row') : null;
      if (!el || el._row == null) return -1;
      return el._row;
    };
    const cancel = () => { clearTimeout(timer); timer = 0; };

    this.vp.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pid = e.pointerId;
      downRow = rowFrom(e.target);
      downX = e.clientX; downY = e.clientY;
      longFired = false;
      if (downRow < 0) return;
      cancel();
      timer = setTimeout(() => {
        timer = 0;
        longFired = true;
        this.select(downRow);
        this.onLongPress(downRow, downX, downY);
      }, 500);
    }, { passive: true });

    this.vp.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid || !timer) return;
      if (Math.abs(e.clientX - downX) > 10 || Math.abs(e.clientY - downY) > 10) cancel();
    }, { passive: true });

    this.vp.addEventListener('pointerup', (e) => {
      if (e.pointerId !== pid) return;
      cancel();
      if (longFired) { longFired = false; return; }
      const row = rowFrom(e.target);
      if (row >= 0 && row === downRow &&
          Math.abs(e.clientX - downX) < 10 && Math.abs(e.clientY - downY) < 10) {
        this.select(row);
      }
      downRow = -1;
    }, { passive: true });

    this.vp.addEventListener('pointercancel', () => { cancel(); longFired = false; downRow = -1; });
    this.vp.addEventListener('contextmenu', (e) => {
      const row = rowFrom(e.target);
      if (row < 0) return;
      e.preventDefault();
      this.select(row);
      this.onLongPress(row, e.clientX, e.clientY);
    });
  }

  /** Called when a chunk lands; repaint only if it is on screen. */
  chunkArrived(regionId, chunk) {
    if (!this.region || regionId !== this.region.id) return;
    const first = Math.floor(this.topRow() / CHUNK_ROWS) - 1;
    const last = Math.floor((this.topRow() + this.visibleRows()) / CHUNK_ROWS) + 1;
    if (chunk >= first && chunk <= last) this.invalidate();
  }
}
