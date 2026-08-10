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
import { brief, categoryOf, explain } from './arm64.js';
import { EMPTY_INDEX } from './symbols.js';
import { lang } from './i18n.js';

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
    this.onRangeChange = opts.onRangeChange || (() => {});

    this.region = null;
    this.mode = 'asm';
    this.hexJoined = false;
    // 「各行に日本語の意味を出す」モード。行が 2 段になるので row-h も変わる。
    this.showNotes = false;
    this.noteStyle = 'ja';
    this.symbols = EMPTY_INDEX;
    this._ctx = null;
    this.totalRows = 0;
    this.windowRows = 0;
    this.baseRow = 0;
    this.rowH = 24;
    this.pool = [];
    // Selection is always a range: `selAnchor` is where it started, `selFocus`
    // the end the user moves. A single row is anchor === focus. `rangeMode`
    // says taps extend the range instead of starting a new one.
    this.selAnchor = -1;
    this.selFocus = -1;
    this.rangeMode = false;
    this._selLo = -1;
    this._selHi = -1;
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

  /*
   * 行の高さは CSS の --line-h / --note-h から組み立てて、--row-h として書き戻す。
   * calc() のまま読むと parseFloat できないので、計算は JS 側で持つ。
   */
  measure() {
    const cs = getComputedStyle(document.documentElement);
    const line = parseFloat(cs.getPropertyValue('--line-h')) || 24;
    const note = parseFloat(cs.getPropertyValue('--note-h')) || 18;
    const h = (this.showNotes && this.mode === 'asm') ? line + note : line;
    document.documentElement.style.setProperty('--row-h', h + 'px');
    this.rowH = h;
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
    this.selAnchor = -1;
    this.selFocus = -1;
    this.rangeMode = false;
    this.markedRow = -1;
    this.lastTopRow = -1;          // force the address bar to refresh
    this.vp.scrollTop = 0;
    this._recomputeWindow(false);
    this.invalidate();
    this.onRangeChange();
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.vp.classList.toggle('mode-asm', mode === 'asm');
    this.vp.classList.toggle('mode-hex', mode === 'hex');
    for (const el of this.pool) { el._hex = null; el._ops = null; el._mn = null; el._note = null; }
    // 16 進表示に解説行は付かないので、行の高さが変わる
    if (this.showNotes) this.measure();
    else this.invalidate();
  }

  setHexJoined(on) {
    this.hexJoined = !!on;
    for (const el of this.pool) el._hex = null;
    this.invalidate();
  }

  /** 解説行の表示。行の高さが変わるので、測り直してから位置を戻す。 */
  setNotes(on, style) {
    const changed = this.showNotes !== !!on;
    this.showNotes = !!on;
    if (style) this.noteStyle = style;
    document.documentElement.classList.toggle('with-notes', this.showNotes);
    for (const el of this.pool) el._note = null;
    if (changed) this.measure();
    else this.invalidate();
  }

  /** 名前と関数の索引を差し替える（ファイルやスライスを開き直したとき）。 */
  setSymbols(index) {
    this.symbols = index || EMPTY_INDEX;
    this._ctx = null;
    for (const el of this.pool) { el._note = null; el._fn = null; }
    this.invalidate();
  }

  /**
   * 1 行ぶんの解説文。
   *
   * adrp の直後の add / ldr だけは、前の行と組で初めて意味が決まるので、
   * キャッシュを通さずに前の行を渡して解き直し、できあがったアドレスを添える。
   * 初心者がいちばんつまずくのがこの 2 行組なので、ここだけは特別扱いする。
   */
  _noteFor(row, idx, mn, ops, asmEntry) {
    const base = mn.toLowerCase();
    if ((base === 'add' || base === 'ldr') && idx > 0 && asmEntry && asmEntry.mn &&
        /^adrp$/i.test(asmEntry.mn[idx - 1] || '')) {
      const ctx = Object.assign({}, this._explainCtx(), {
        prev: { mn: asmEntry.mn[idx - 1], ops: asmEntry.ops[idx - 1] || '' },
      });
      const e = explain(mn, ops, this.rowAddress(row), ctx);
      let text = this.noteStyle === 'pseudo' ? e.pseudo
        : this.noteStyle === 'both' ? e.pseudo + '   — ' + e.title
        : (e.summary || e.title);
      if (e.target != null) {
        const name = this.symbols.nameAt(e.target);
        text += '  → ' + (name || '0x' + e.target.toString(16).toUpperCase());
      }
      return text.replace(/\s+/g, ' ').trim();
    }
    return brief(mn, ops, this.noteStyle, this._explainCtx());
  }

  /** 解説エンジンに渡す文脈。1 フレームに 1 回だけ作る。 */
  _explainCtx() {
    if (!this._ctx || this._ctx.gen !== this.symbols.gen || this._ctx.lang !== lang()) {
      const sym = this.symbols;
      this._ctx = {
        gen: sym.gen,
        lang: lang(),
        symbolFor: (addr) => sym.nameAt(addr),
      };
    }
    return this._ctx;
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

  /** Bring `row` into view without re-centring if it is already visible. */
  revealRow(row) {
    if (!this.totalRows) return;
    row = this.clampRow(row);
    const top = this.topRow();
    const visible = this.visibleRows();
    if (row <= top) this.goToRow(row, 'top');
    else if (row >= top + visible - 1) this.goToRow(Math.max(0, row - visible + 2), 'top');
  }

  /** Highlight without moving (used by search results). */
  mark(row) {
    this.markedRow = row;
    this.invalidate();
  }

  /* ── selection ────────────────────────────────────────────── */

  /** The selected rows as { start, end, count }, or null when nothing is. */
  selectionRange() {
    if (!this.totalRows || this.selAnchor < 0 || this.selFocus < 0) return null;
    const start = Math.min(this.selAnchor, this.selFocus);
    const end = Math.max(this.selAnchor, this.selFocus);
    return { start, end, count: end - start + 1 };
  }

  /** The single row a one-row selection is on, or -1. */
  get selectedRow() {
    return this.selAnchor >= 0 && this.selAnchor === this.selFocus ? this.selAnchor : -1;
  }

  /** Select exactly one row; leaves range mode. */
  select(row, notify = true) {
    row = this.clampRow(row);
    const wasRange = this.rangeMode;
    this.rangeMode = false;
    if (row !== this.selAnchor || row !== this.selFocus) {
      this.selAnchor = row;
      this.selFocus = row;
      this.invalidate();
    }
    if (wasRange) this.onRangeChange();
    if (notify) this.onSelect(row);
  }

  deselect() {
    const wasRange = this.rangeMode;
    if (this.selAnchor < 0 && !wasRange) return;
    this.selAnchor = -1;
    this.selFocus = -1;
    this.rangeMode = false;
    this.invalidate();
    if (wasRange) this.onRangeChange();
  }

  /** Anchor a range at `row`; subsequent taps move its far end. */
  beginRange(row) {
    if (!this.totalRows) return;
    row = this.clampRow(row);
    this.selAnchor = row;
    this.selFocus = row;
    this.rangeMode = true;
    this.invalidate();
    this.onRangeChange();
  }

  /** Move the free end of the range, anchoring one first if needed. */
  extendTo(row) {
    if (!this.totalRows) return;
    row = this.clampRow(row);
    if (this.selAnchor < 0) this.selAnchor = row;
    this.selFocus = row;
    this.rangeMode = true;
    this.invalidate();
    this.onRangeChange();
  }

  /** Keyboard extension: move the free end by `n` rows and follow it. */
  extendByRows(n) {
    if (!this.totalRows) return;
    const from = this.selFocus >= 0 ? this.selFocus : this.topRow();
    const row = this.clampRow(from + n);
    this.extendTo(row);
    this.revealRow(row);
  }

  extendByPages(n) {
    this.extendByRows(n * Math.max(1, this.visibleRows() - 2));
  }

  extendToRow(row) {
    this.extendTo(row);
    this.revealRow(this.selFocus);
  }

  selectAllRows() {
    if (!this.totalRows) return;
    this.selAnchor = 0;
    this.selFocus = this.totalRows - 1;
    this.rangeMode = true;
    this.invalidate();
    this.onRangeChange();
  }

  clearRange() { this.deselect(); }

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
    // Resolved once per frame so _paintRow stays allocation-free.
    this._selLo = this.selAnchor < 0 ? -1 : Math.min(this.selAnchor, this.selFocus);
    this._selHi = this.selAnchor < 0 ? -1 : Math.max(this.selAnchor, this.selFocus);
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
      // 2 行目: 関数名のしるし＋日本語の意味
      const n = document.createElement('span'); n.className = 'c-note';
      const f = document.createElement('i'); f.className = 'fnname';
      const nt = document.createTextNode('');
      n.append(f, nt);
      el.append(a, h, m, o, s, n);
      el._a = a; el._h = h; el._m = m; el._o = o; el._s = s; el._n = n; el._f = f; el._nt = nt;
      el._row = -1; el._addr = null; el._hex = null; el._mn = null; el._ops = null;
      el._ascii = null; el._top = -1; el._cls = ''; el._note = null; el._fn = null;
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

    // 2 行目（解説）と、関数の先頭のしるし
    const isFnStart = this.symbols.functionCount > 0 && this.symbols.isFunctionStart(this.rowAddress(row));
    if (this.showNotes && this.mode === 'asm') {
      const fnName = isFnStart ? (this.symbols.nameAt(this.rowAddress(row)) || '') : '';
      if (el._fn !== fnName) { el._f.textContent = fnName ? '▼ ' + fnName : ''; el._fn = fnName; }
      let note = '';
      if (mn && mn !== '…' && mn !== '???') {
        note = this._noteFor(row, idx, mn, ops, asmEntry);
      }
      if (el._note !== note) { el._nt.nodeValue = note; el._note = note; }
    } else if (el._note !== '') {
      el._nt.nodeValue = ''; el._note = '';
      el._f.textContent = ''; el._fn = '';
    }

    let cls = 'row';
    if (this.mode === 'asm') {
      const k = (asmEntry && asmEntry.mn) ? mnemonicClass(mn) : '';
      if (k) cls += ' ' + k;
      if (!asmEntry || !asmEntry.mn) cls += ' pending';
      const cg = (asmEntry && asmEntry.mn) ? categoryOf(mn) : '';
      if (cg) cls += ' cat-' + cg;
      if (isFnStart) cls += ' fnstart';
    } else if (avail <= 0) cls += ' pending';
    if (row >= this._selLo && row <= this._selHi) {
      cls += ' sel';
      if (this._selLo !== this._selHi) {
        if (row === this._selLo) cls += ' sel-first';
        if (row === this._selHi) cls += ' sel-last';
      }
    }
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
    // In range mode a tap moves the end of the range; otherwise it selects.
    const touch = (row) => {
      if (this.rangeMode) this.extendTo(row);
      else this.select(row);
    };

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
        touch(downRow);
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
        touch(row);
      }
      downRow = -1;
    }, { passive: true });

    this.vp.addEventListener('pointercancel', () => { cancel(); longFired = false; downRow = -1; });
    this.vp.addEventListener('contextmenu', (e) => {
      const row = rowFrom(e.target);
      if (row < 0) return;
      e.preventDefault();
      touch(row);
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
