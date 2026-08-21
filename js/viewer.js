/*
 * Virtualized code viewer.
 *
 * Fixed-width targets keep the exact O(1) row/address mapping used by the
 * legacy ARM64 viewer. Variable-width targets use a bounded address-first
 * decode index: rows are only a local projection of proven instruction
 * boundaries and never become semantic addresses.
 */
import { CHUNK_ROWS } from './backend.js';
import { addrText, bytesHex, bytesAscii, mnemonicClass } from './format.js';
import { EMPTY_INDEX } from './symbols.js';
import { lang } from './i18n.js';
import { uiRoot } from './ui-root.js';
import { instructionCategory, instructionNote, supportsBeginnerInstructionNotes } from './viewer/architecture-presentation.js';
import { VariableInstructionIndex } from './viewer/variable-instruction-index.js';

const WINDOW_PX = 6_000_000;
const OVERSCAN = 6;
const IDLE_MS = 140;
const PREFETCH_CHUNKS = 1;
const HEX_ROW_BYTES = 4;
const IMM_RE = /(#?-?0x[0-9a-f]+|#-?\d+)/gi;

function isAbort(error) { return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'; }

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
    this.modeAddressAnchor = null;
    this.hexJoined = false;
    this.showNotes = false;
    this.noteStyle = 'ja';
    this.symbols = EMPTY_INDEX;
    this.blockOverlay = null;
    this.blockRegionId = null;
    this._ctx = null;
    this.totalRows = 0;
    this.windowRows = 0;
    this.baseRow = 0;
    this.rowH = 24;
    this.pool = [];
    this.selAnchor = -1;
    this.selFocus = -1;
    this.rangeMode = false;
    this._selLo = -1;
    this._selHi = -1;
    this.markedRow = -1;
    this.frame = 0;
    this.idleTimer = 0;
    this.lastTopRow = -1;
    this.disposed = false;

    this.variableRows = Object.freeze([]);
    this.variableError = null;
    this.variableNavigation = 0;
    this.variableIndex = new VariableInstructionIndex({
      disassembleAt:(address, options) => this.backend.disassembleAt(address, options),
      onPublish:() => this._variablePublished(),
    });

    this._onScroll = this._onScroll.bind(this);
    this._render = this._render.bind(this);
    this.vp.addEventListener('scroll', this._onScroll, { passive:true });
    this._bindPointer();
    this.measure();
  }

  architectureId() {
    return String(this.region?.capability?.architecture
      || this.backend?.platformInfo?.capability?.architecture
      || this.backend?.legacyInfo?.capability?.architecture
      || 'arm64').toLowerCase();
  }

  fixedInstructionSize() {
    const cap = this.region?.capability || this.backend?.platformInfo?.capability || this.backend?.legacyInfo?.capability || null;
    if (cap && Object.prototype.hasOwnProperty.call(cap, 'fixedInstructionSize')) {
      const n = cap.fixedInstructionSize;
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    return this.region?.disasm === false ? null : 4;
  }

  isVariableAsm() {
    if (!this.region || this.mode !== 'asm' || this.region.disasm === false) return false;
    const cap = this.region?.capability || this.backend?.platformInfo?.capability || this.backend?.legacyInfo?.capability || null;
    const decode = cap?.capabilities?.decode ?? cap?.decode ?? null;
    return this.fixedInstructionSize() == null && decode !== 'unsupported' && this.architectureId() !== 'unknown';
  }

  instrumentation() {
    return Object.freeze({
      ...this.variableIndex.metrics(),
      domRows:this.pool.length,
      visibleRows:this.visibleRows(),
      overscanRows:OVERSCAN,
      localProjectedRows:this.variableRows.length,
    });
  }

  measure() {
    const root = uiRoot();
    const cs = getComputedStyle(root);
    const line = parseFloat(cs.getPropertyValue('--line-h')) || 24;
    const note = parseFloat(cs.getPropertyValue('--note-h')) || 18;
    const h = (this.showNotes && this.mode === 'asm') ? line + note : line;
    root.style.setProperty('--row-h', h + 'px');
    this.rowH = h;
    this._recomputeWindow(true);
  }

  _recomputeWindow(keepPosition) {
    const maxWindowRows = Math.max(1, Math.floor(WINDOW_PX / this.rowH));
    const anchorAddress = keepPosition ? this.topAddress() : null;
    const anchorRow = keepPosition && !this.isVariableAsm() ? this.topRow() : 0;
    this.windowRows = Math.min(this.totalRows, maxWindowRows);
    this.maxBase = Math.max(0, this.totalRows - this.windowRows);
    this.baseRow = Math.min(this.baseRow, this.maxBase);
    this.rowsEl.style.height = (this.windowRows * this.rowH) + 'px';
    if (keepPosition && this.totalRows) {
      if (this.isVariableAsm() && anchorAddress != null) this._goToKnownVariableAddress(anchorAddress, 'top');
      else this.goToRow(anchorRow, 'top');
    } else this.invalidate();
  }

  visibleRows() { return Math.max(1, Math.floor(this.vp.clientHeight / this.rowH)); }

  topRow() {
    if (!this.totalRows) return 0;
    return Math.min(Math.max(0, this.totalRows - 1), this.baseRow + Math.floor(this.vp.scrollTop / this.rowH));
  }

  rowOfAddress(addr) {
    if (!this.region || addr == null) return null;
    const address = BigInt(addr);
    const rel = address - this.region.vmAddr;
    if (rel < 0n || rel >= this.region.size) return null;
    if (this.isVariableAsm()) {
      const exact = this.variableRows.findIndex((entry) => entry.address === address);
      if (exact >= 0) return exact;
      const containing = this.variableRows.findIndex((entry) => entry.address < address && address < entry.address + BigInt(entry.length));
      if (containing >= 0) return containing;
      return this.variableRows.length === 0 && this.variableError?.address === address ? 0 : null;
    }
    const fixed = this.fixedInstructionSize();
    const width = this.mode === 'hex' && fixed == null ? HEX_ROW_BYTES : fixed;
    if (!width) return null;
    const w = BigInt(width);
    if (fixed != null && rel % w !== 0n) return null;
    return Number(rel / w);
  }

  topAddress() {
    if (!this.region) return null;
    return this.rowAddress(this.topRow());
  }

  rowAddress(row) {
    if (!this.region) return null;
    if (this.isVariableAsm()) return this.variableRows[row]?.address ?? (row === 0 ? this.variableError?.address ?? null : null);
    const width = this.mode === 'hex' ? HEX_ROW_BYTES : this.fixedInstructionSize();
    if (!width) return null;
    return this.region.vmAddr + BigInt(row) * BigInt(width);
  }

  setRegion(region) {
    const architecture = String(region?.capability?.architecture
      || this.backend?.platformInfo?.capability?.architecture
      || this.backend?.legacyInfo?.capability?.architecture
      || 'arm64').toLowerCase();
    this.variableNavigation++;
    this.variableIndex.configureRegion(region, { architecture });
    this.region = region;
    this.modeAddressAnchor = null;
    this.variableRows = Object.freeze([]);
    this.variableError = null;
    this.totalRows = region ? (this.mode === 'hex' ? Number((region.size + 3n) / 4n)
      : (this.fixedInstructionSize() ? Number((region.size + BigInt(this.fixedInstructionSize() - 1)) / BigInt(this.fixedInstructionSize())) : 0)) : 0;
    this.baseRow = 0;
    this.selAnchor = -1;
    this.selFocus = -1;
    this.rangeMode = false;
    this.markedRow = -1;
    if (this.blockRegionId && (!region || this.blockRegionId !== region.id)) {
      this.blockOverlay = null;
      this.blockRegionId = null;
    }
    this.lastTopRow = -1;
    this.vp.scrollTop = 0;
    this._recomputeWindow(false);
    this.invalidate();
    this.onRangeChange();
    if (region && this.mode === 'asm' && this.fixedInstructionSize() == null && region.disasm !== false) {
      this._navigateVariable(region.vmAddr, { trusted:true, where:'top' });
    }
  }

  setMode(mode) {
    if (this.mode === mode) return;
    const previousMode = this.mode;
    const visibleAnchor = this.topAddress() ?? this.rowAddress(this.selectedRow);
    let anchor = visibleAnchor;
    const leavingVariableAsm = previousMode === 'asm' && this.isVariableAsm();
    if (previousMode === 'hex' && mode === 'asm' && this.modeAddressAnchor != null && visibleAnchor != null) {
      const rowStart = BigInt(visibleAnchor);
      const saved = BigInt(this.modeAddressAnchor);
      if (saved >= rowStart && saved < rowStart + BigInt(HEX_ROW_BYTES)) anchor = saved;
    }
    if (leavingVariableAsm && mode === 'hex') this.modeAddressAnchor = visibleAnchor;
    else if (previousMode !== 'hex' || mode !== 'asm') this.modeAddressAnchor = null;
    if (leavingVariableAsm) this.variableIndex.cancelAll('mode-changed');
    this.variableNavigation++;
    this.mode = mode;
    this.vp.classList.toggle('mode-asm', mode === 'asm');
    this.vp.classList.toggle('mode-hex', mode === 'hex');
    for (const el of this.pool) { el._hex = null; el._ops = null; el._mn = null; el._note = null; }
    if (this.region) {
      if (mode === 'hex') {
        this.totalRows = Number((this.region.size + 3n) / 4n);
        this.baseRow = 0;
        this._recomputeWindow(false);
        if (anchor != null) {
          const rel = BigInt(anchor) - this.region.vmAddr;
          if (rel >= 0n && rel < this.region.size) this.goToRow(Number(rel / 4n), 'top');
        }
      } else if (this.fixedInstructionSize()) {
        const width = this.fixedInstructionSize();
        this.totalRows = Number((this.region.size + BigInt(width - 1)) / BigInt(width));
        this.baseRow = 0;
        this._recomputeWindow(false);
        if (anchor != null) this.goToAddress(anchor);
      } else {
        this.totalRows = this.variableRows.length;
        this.baseRow = 0;
        this._recomputeWindow(false);
        if (anchor != null) this._navigateVariable(anchor, { trusted:this.variableIndex.knownEntry(anchor) != null, where:'top' });
        else this._navigateVariable(this.region.vmAddr, { trusted:true, where:'top' });
      }
    }
    if (mode === 'asm') this.modeAddressAnchor = null;
    if (this.showNotes) this.measure();
    else this.invalidate();
  }

  setHexJoined(on) { this.hexJoined = !!on; for (const el of this.pool) el._hex = null; this.invalidate(); }

  setNotes(on, style) {
    const changed = this.showNotes !== !!on;
    this.showNotes = !!on;
    if (style) this.noteStyle = style;
    uiRoot()?.classList.toggle('with-notes', this.showNotes);
    for (const el of this.pool) el._note = null;
    if (changed) this.measure(); else this.invalidate();
  }

  setBlockOverlay(regionId, map) {
    this.blockOverlay = map && map.size ? map : null;
    this.blockRegionId = this.blockOverlay ? regionId : null;
    for (const el of this.pool) { el._sblk = null; el._sblkName = null; }
    this.invalidate();
  }
  clearBlockOverlay() { this.setBlockOverlay(null, null); }
  blockAt(row) {
    if (this.isVariableAsm()) return null;
    if (!this.blockOverlay || !this.region || this.blockRegionId !== this.region.id) return null;
    return this.blockOverlay.get(row) || null;
  }
  setSymbols(index) {
    this.symbols = index || EMPTY_INDEX;
    this._ctx = null;
    for (const el of this.pool) { el._note = null; el._fn = null; }
    this.invalidate();
  }

  _noteFor(row, idx, mn, ops, asmEntry) {
    const arch = this.architectureId();
    if (!supportsBeginnerInstructionNotes(arch)) return '';
    const previous = idx > 0 && asmEntry?.mn ? { mnemonic:asmEntry.mn[idx - 1], operands:asmEntry.ops[idx - 1] || '' } : null;
    return instructionNote(arch, { mnemonic:mn, operands:ops, address:this.rowAddress(row), style:this.noteStyle, context:this._explainCtx(), previous });
  }
  _explainCtx() {
    if (!this._ctx || this._ctx.gen !== this.symbols.gen || this._ctx.lang !== lang()) {
      const sym = this.symbols;
      this._ctx = { gen:sym.gen, lang:lang(), symbolFor:(addr) => sym.nameAt(addr) };
    }
    return this._ctx;
  }
  wantAsm() { return this.mode === 'asm' && !!(this.region && this.region.disasm !== false); }

  clampRow(row) { if (!this.totalRows) return 0; return Math.max(0, Math.min(this.totalRows - 1, row)); }

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
    } else this.baseRow = 0;
    const local = row - this.baseRow;
    this.vp.scrollTop = Math.max(0, Math.min(Math.max(0, windowPx - vpH), local * this.rowH - lead));
    this.invalidate();
  }

  _goToKnownVariableAddress(address, where = 'third') {
    const target = BigInt(address);
    let row = this.variableRows.findIndex((entry) => entry.address === target);
    if (row < 0) row = this.variableRows.findIndex((entry) => entry.address < target && target < entry.address + BigInt(entry.length));
    if (row < 0) return false;
    this.goToRow(row, where);
    return true;
  }

  goToAddress(addr) {
    if (!this.region || addr == null) return false;
    const target = BigInt(addr);
    const rel = target - this.region.vmAddr;
    if (rel < 0n || rel >= this.region.size) return false;
    if (this.isVariableAsm()) {
      if (this._goToKnownVariableAddress(target, 'third')) return true;
      this._navigateVariable(target, { trusted:this.symbols?.isFunctionStart?.(target) === true, where:'third' });
      return true;
    }
    const row = this.rowOfAddress(target);
    if (row == null) return false;
    this.goToRow(row, 'third');
    return true;
  }

  _navigateVariable(address, { trusted = false, where = 'third' } = {}) {
    if (!this.region || this.mode !== 'asm' || this.fixedInstructionSize() != null) return;
    const requestGeneration = ++this.variableNavigation;
    this.variableError = null;
    this.variableIndex.navigate(address, { trusted }).then((result) => {
      if (requestGeneration !== this.variableNavigation || this.disposed || !this.region) return;
      if (result.status === 'ambiguous' || result.status === 'unknown' || result.status === 'undecodable') {
        this.variableError = { address:BigInt(address), status:result.status, bytes:null };
        this._loadVariableErrorByte(this.variableError, requestGeneration);
      } else this.variableError = null;
      this._syncVariableRows(result.address ?? address);
      if (!this._goToKnownVariableAddress(result.address ?? address, where)) this.invalidate();
    }).catch((error) => {
      if (isAbort(error) || requestGeneration !== this.variableNavigation) return;
      this.variableError = { address:BigInt(address), status:'decode-error', bytes:null, error:String(error?.message || error) };
      this._loadVariableErrorByte(this.variableError, requestGeneration);
      this._syncVariableRows(address);
    });
  }

  _loadVariableErrorByte(marker, generation) {
    if (!marker || typeof this.backend?.readAt !== 'function') return;
    Promise.resolve(this.backend.readAt(marker.address, 1, false)).then((result) => {
      if (generation !== this.variableNavigation || this.variableError !== marker) return;
      const raw = result?.bytes ?? result;
      const bytes = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? Uint8Array.from(raw) : null;
      if (bytes?.length) marker.bytes = bytes.slice(0, 1);
      this.invalidate();
    }).catch(() => {});
  }

  _variablePublished() {
    if (!this.region || this.mode !== 'asm' || this.fixedInstructionSize() != null) return;
    this._syncVariableRows(this.variableIndex.currentAddress ?? this.region.vmAddr);
  }

  _syncVariableRows(anchor) {
    if (!this.region || this.mode !== 'asm' || this.fixedInstructionSize() != null) return;
    const oldAddress = this.topAddress();
    const rows = this.variableIndex.localRows(anchor);
    const errorIsUnresolved = this.variableError
      && !this.variableIndex.knownEntry(this.variableError.address)
      && !this.variableIndex.containingEntry(this.variableError.address);
    this.variableRows = errorIsUnresolved ? Object.freeze([]) : rows;
    this.totalRows = this.variableRows.length + (this.variableRows.length === 0 && this.variableError ? 1 : 0);
    this.baseRow = 0;
    this._recomputeWindow(false);
    if (oldAddress != null) this._goToKnownVariableAddress(oldAddress, 'top');
    this.invalidate();
  }

  _requestVariableForward() {
    if (!this.isVariableAsm() || !this.variableRows.length) return;
    const last = this.variableRows.at(-1);
    const page = this.variableIndex._pageContaining(last.address);
    if (!page || page.status !== 'ok') return;
    this.variableIndex.ensurePage(page.nextAddress, { priority:'current', protect:false }).catch(() => {});
  }

  scrollByRows(n) {
    if (this.isVariableAsm() && this.totalRows) {
      const target = this.topRow() + n;
      if (target >= this.totalRows) { this._requestVariableForward(); return; }
      if (target < 0 && this.variableRows.length) {
        const first = this.variableRows[0];
        this.variableIndex.previousBoundary(first.address).then((result) => {
          if (result.status !== 'proven') { this.variableError = { address:first.address, status:result.status, bytes:null }; this.invalidate(); return; }
          return this.variableIndex.ensurePage(result.address, { priority:'current', protect:false });
        }).catch(() => {});
        return;
      }
    }
    this.goToRow(this.topRow() + n, 'top');
  }
  scrollByPages(n) { this.scrollByRows(n * Math.max(1, this.visibleRows() - 2)); }
  revealRow(row) {
    if (!this.totalRows) return;
    row = this.clampRow(row);
    const top = this.topRow(), visible = this.visibleRows();
    if (row <= top) this.goToRow(row, 'top');
    else if (row >= top + visible - 1) this.goToRow(Math.max(0, row - visible + 2), 'top');
  }
  mark(row) { this.markedRow = row; this.invalidate(); }

  selectionRange() {
    if (!this.totalRows || this.selAnchor < 0 || this.selFocus < 0) return null;
    const start = Math.min(this.selAnchor, this.selFocus), end = Math.max(this.selAnchor, this.selFocus);
    const out = { start, end, count:end - start + 1 };
    if (this.isVariableAsm()) {
      const first = this.variableRows[start], last = this.variableRows[end];
      if (!first || !last) return null;
      out.startAddress = first.address;
      out.endAddress = last.address;
      out.endLength = last.length;
      out.endExclusive = last.address + BigInt(last.length);
    }
    return out;
  }
  get selectedRow() { return this.selAnchor >= 0 && this.selAnchor === this.selFocus ? this.selAnchor : -1; }
  select(row, notify = true) {
    row = this.clampRow(row);
    const wasRange = this.rangeMode; this.rangeMode = false;
    if (row !== this.selAnchor || row !== this.selFocus) { this.selAnchor = row; this.selFocus = row; this.invalidate(); }
    if (wasRange) this.onRangeChange();
    if (notify) this.onSelect(row);
  }
  deselect() {
    const wasRange = this.rangeMode;
    if (this.selAnchor < 0 && !wasRange) return;
    this.selAnchor = -1; this.selFocus = -1; this.rangeMode = false; this.invalidate();
    if (wasRange) this.onRangeChange();
  }
  beginRange(row) { if (!this.totalRows) return; row=this.clampRow(row); this.selAnchor=row; this.selFocus=row; this.rangeMode=true; this.invalidate(); this.onRangeChange(); }
  extendTo(row) { if (!this.totalRows) return; row=this.clampRow(row); if (this.selAnchor<0) this.selAnchor=row; this.selFocus=row; this.rangeMode=true; this.invalidate(); this.onRangeChange(); }
  extendByRows(n) { if (!this.totalRows) return; const from=this.selFocus>=0?this.selFocus:this.topRow(); const row=this.clampRow(from+n); this.extendTo(row); this.revealRow(row); }
  extendByPages(n) { this.extendByRows(n * Math.max(1, this.visibleRows() - 2)); }
  extendToRow(row) { this.extendTo(row); this.revealRow(this.selFocus); }
  selectAllRows() { if (!this.totalRows || this.isVariableAsm()) return; this.selAnchor=0; this.selFocus=this.totalRows-1; this.rangeMode=true; this.invalidate(); this.onRangeChange(); }
  clearRange() { this.deselect(); }

  rowData(row) {
    if (!this.region || row < 0 || row >= this.totalRows) return null;
    if (this.isVariableAsm()) {
      const entry = this.variableRows[row];
      if (!entry) {
        if (!this.variableError) return null;
        return { row, address:this.variableError.address, bytes:this.variableError.bytes ? bytesHex(this.variableError.bytes, 0, this.variableError.bytes.length, true) : null, mnemonic:'???', operands:'', length:this.variableError.bytes?.length ?? 0, status:this.variableError.status };
      }
      return { row, address:entry.address, bytes:bytesHex(entry.bytes, 0, entry.length, true), mnemonic:entry.mnemonic, operands:entry.opStr, length:entry.length, decoded:entry.decoded };
    }
    const chunk=Math.floor(row/CHUNK_ROWS), idx=row-chunk*CHUNK_ROWS, entry=this.backend.peek(this.region.id,chunk,false);
    const out={ row, address:this.rowAddress(row), bytes:null, mnemonic:null, operands:null };
    if (entry?.bytes) { const off=idx*4, n=Math.min(4,entry.bytes.length-off); if(n>0) out.bytes=bytesHex(entry.bytes,off,n,true); }
    const asm=this.backend.peek(this.region.id,chunk,true);
    if (asm?.mn) { out.mnemonic=asm.mn[idx]||''; out.operands=asm.ops[idx]||''; }
    return out;
  }

  invalidate() { if (!this.frame) this.frame=requestAnimationFrame(this._render); }
  _onScroll() { this.invalidate(); clearTimeout(this.idleTimer); this.idleTimer=setTimeout(() => this._rebase(), IDLE_MS); }
  _rebase() {
    if (!this.maxBase || !this.totalRows || this.isVariableAsm()) return;
    const windowPx=this.windowRows*this.rowH, vpH=this.vp.clientHeight, st=this.vp.scrollTop, lo=windowPx*0.25, hi=windowPx*0.75-vpH;
    if(st>lo&&st<hi)return;
    const target=Math.max(0,(windowPx-vpH)/2); let delta=Math.round((st-target)/this.rowH);
    const newBase=Math.max(0,Math.min(this.maxBase,this.baseRow+delta)); delta=newBase-this.baseRow; if(!delta)return;
    this.baseRow=newBase; this.vp.scrollTop=st-delta*this.rowH; this.invalidate();
  }

  _render() {
    this.frame=0;
    if(!this.region||!this.totalRows){ for(const el of this.pool)el.style.display='none'; return; }
    const rowH=this.rowH, vpH=this.vp.clientHeight;
    this._selLo=this.selAnchor<0?-1:Math.min(this.selAnchor,this.selFocus); this._selHi=this.selAnchor<0?-1:Math.max(this.selAnchor,this.selFocus);
    const firstLocal=Math.max(0,Math.floor(this.vp.scrollTop/rowH)-OVERSCAN);
    const count=Math.min(this.windowRows-firstLocal,Math.ceil(vpH/rowH)+OVERSCAN*2);
    const startRow=this.baseRow+firstLocal, endRow=Math.min(this.totalRows,startRow+Math.max(0,count));
    this._ensurePool(endRow-startRow);
    if(this.isVariableAsm()) this._renderVariable(startRow,endRow);
    else this._renderFixed(startRow,endRow);
    for(let i=endRow-startRow;i<this.pool.length;i++) if(this.pool[i].style.display!=='none')this.pool[i].style.display='none';
    const top=this.topRow();
    if(top!==this.lastTopRow){this.lastTopRow=top;this.onTopChange(top,this.rowAddress(top));}
    this._updateScrubber();
  }

  _renderVariable(startRow,endRow) {
    for(let r=startRow,i=0;r<endRow;r++,i++) this._paintVariableRow(this.pool[i],r,(r-this.baseRow)*this.rowH);
    if(endRow >= this.totalRows - Math.max(2, OVERSCAN) && this.variableRows.length) this._requestVariableForward();
  }

  _renderFixed(startRow,endRow) {
    const wantAsm=this.wantAsm(); let chunkIdx=-1,entry=null,asmEntry=null;
    for(let r=startRow,i=0;r<endRow;r++,i++){
      const el=this.pool[i],c=Math.floor(r/CHUNK_ROWS);
      if(c!==chunkIdx){chunkIdx=c;entry=this.backend.peek(this.region.id,c,false);asmEntry=wantAsm?this.backend.peek(this.region.id,c,true):null;if(!entry||(wantAsm&&!asmEntry))this.backend.request(this.region.id,c,wantAsm);}
      this._paintFixedRow(el,r,entry,asmEntry,(r-this.baseRow)*this.rowH);
    }
    const firstChunk=Math.floor(startRow/CHUNK_ROWS),lastChunk=Math.floor((endRow-1)/CHUNK_ROWS),maxChunk=Math.floor((this.totalRows-1)/CHUNK_ROWS);
    for(let c=Math.max(0,firstChunk-PREFETCH_CHUNKS);c<=Math.min(maxChunk,lastChunk+PREFETCH_CHUNKS);c++){if(c>=firstChunk&&c<=lastChunk)continue;this.backend.request(this.region.id,c,wantAsm);}
  }

  _ensurePool(n) {
    while(this.pool.length<n){
      const el=document.createElement('div');el.className='row';
      const a=document.createElement('span');a.className='c-addr';const h=document.createElement('span');h.className='c-hex';const m=document.createElement('span');m.className='c-mn';const o=document.createElement('span');o.className='c-ops';const s=document.createElement('span');s.className='c-ascii';
      const note=document.createElement('span');note.className='c-note';const f=document.createElement('i');f.className='fnname';const bt=document.createElement('i');bt.className='sblkname';const nt=document.createTextNode('');note.append(f,bt,nt);el.append(a,h,m,o,s,note);
      el._a=a;el._h=h;el._m=m;el._o=o;el._s=s;el._n=note;el._f=f;el._nt=nt;el._bt=bt;el._row=-1;el._addr=null;el._hex=null;el._mn=null;el._ops=null;el._ascii=null;el._top=-1;el._cls='';el._note=null;el._fn=null;el._sblk=null;el._sblkName=null;
      this.rowsEl.appendChild(el);this.pool.push(el);
    }
  }

  _paintVariableRow(el,row,top) {
    const entry=this.variableRows[row]||null, marker=!entry?this.variableError:null;
    this._paintBase(el,row,top,entry?.address??marker?.address??null,entry?.bytes??marker?.bytes??null,entry?.mnemonic??(marker?'???':''),entry?.opStr??'',null);
  }

  _paintFixedRow(el,row,entry,asmEntry,top) {
    const idx=row-Math.floor(row/CHUNK_ROWS)*CHUNK_ROWS,off=idx*4,avail=entry?.bytes?Math.min(4,entry.bytes.length-off):0;
    const bytes=avail>0?entry.bytes.subarray(off,off+avail):null;
    let mn='',ops='';if(this.mode==='asm'){if(asmEntry?.mn){mn=asmEntry.mn[idx]||'';ops=asmEntry.ops[idx]||'';}else if(entry?.error)mn='???';else mn='…';}
    this._paintBase(el,row,top,this.rowAddress(row),bytes,mn,ops,{idx,asmEntry});
  }

  _paintBase(el,row,top,address,bytes,mn,ops,fixedCtx) {
    if(el.style.display==='none')el.style.display='';if(el._top!==top){el.style.top=top+'px';el._top=top;}el._row=row;
    const addr=address==null?'':addrText(address);if(el._addr!==addr){el._a.textContent=addr;el._addr=addr;}
    let hex=null,ascii=null;if(bytes?.length){hex=bytesHex(bytes,0,bytes.length,!this.hexJoined);if(this.mode==='hex')ascii=bytesAscii(bytes,0,bytes.length);}
    const placeholder=this.isVariableAsm()?'··':'·· ·· ·· ··',hexText=hex===null?placeholder:hex;if(el._hex!==hexText){el._h.textContent=hexText;el._hex=hexText;}
    if(this.mode==='hex'){const t=ascii===null?'':ascii;if(el._ascii!==t){el._s.textContent=t;el._ascii=t;}}
    if(this.mode==='asm'){if(el._mn!==mn){el._m.textContent=mn;el._mn=mn;}this._setOps(el,ops);}else if(el._mn!==''){el._m.textContent='';el._mn='';this._setOps(el,'');}
    const isFnStart=address!=null&&this.symbols.functionCount>0&&this.symbols.isFunctionStart(address);const blk=this.mode==='asm'?this.blockAt(row):null;
    if(this.showNotes&&this.mode==='asm'){
      const fnName=isFnStart?(this.symbols.nameAt(address)||''):'';if(el._fn!==fnName){el._f.textContent=fnName?'▼ '+fnName:'';el._fn=fnName;}
      const blkName=blk?.title||'';if(el._sblkName!==blkName){el._bt.textContent=blkName?'▼ '+blkName:'';el._sblkName=blkName;}
      let note='';if(mn&&mn!=='…'&&mn!=='???'&&fixedCtx)note=this._noteFor(row,fixedCtx.idx,mn,ops,fixedCtx.asmEntry);if(el._note!==note){el._nt.nodeValue=note;el._note=note;}
    }else if(el._note!==''){el._nt.nodeValue='';el._note='';el._f.textContent='';el._fn='';el._bt.textContent='';el._sblkName='';}
    let cls='row';if(this.mode==='asm'){const k=mnemonicClass(mn);if(k)cls+=' '+k;if(!mn||mn==='…')cls+=' pending';const cg=instructionCategory(this.architectureId(),mn);if(cg)cls+=' cat-'+cg;if(isFnStart)cls+=' fnstart';if(blk)cls+=' sblk sblk-'+blk.pos+' sblk-lv-'+blk.level;}else if(!bytes?.length)cls+=' pending';
    if(row>=this._selLo&&row<=this._selHi){cls+=' sel';if(this._selLo!==this._selHi){if(row===this._selLo)cls+=' sel-first';if(row===this._selHi)cls+=' sel-last';}}if(row===this.markedRow)cls+=' hit';if(el._cls!==cls){el.className=cls;el._cls=cls;}
  }

  _setOps(el,str) {
    if(el._ops===str)return;el._ops=str;const target=el._o;if(!str){target.textContent='';return;}IMM_RE.lastIndex=0;if(!IMM_RE.test(str)){target.textContent=str;return;}target.textContent='';const parts=str.split(IMM_RE);for(let i=0;i<parts.length;i++){const p=parts[i];if(!p)continue;if(i%2===1){const s=document.createElement('span');s.className='tok-imm';s.textContent=p;target.appendChild(s);}else target.appendChild(document.createTextNode(p));}
  }

  attachScrubber(track,thumb) {
    this.track=track;this.thumb=thumb;let dragging=false;
    const navigate=(clientY)=>{const rect=track.getBoundingClientRect(),thumbH=this._thumbHeight(rect.height),usable=Math.max(1,rect.height-thumbH),y=Math.max(0,Math.min(usable,clientY-rect.top-thumbH/2)),frac=y/usable;
      if(this.isVariableAsm()&&this.region){const span=this.region.size>0n?this.region.size-1n:0n;const scaled=BigInt(Math.floor(frac*1_000_000));const target=this.region.vmAddr+(span*scaled)/1_000_000n;this.goToAddress(target);}
      else {const span=Math.max(0,this.totalRows-this.visibleRows());this.goToRow(Math.round(frac*span),'top');}}
    track.addEventListener('pointerdown',(e)=>{if(!this.region)return;dragging=true;track.classList.add('dragging');track.setPointerCapture(e.pointerId);navigate(e.clientY);e.preventDefault();});
    track.addEventListener('pointermove',(e)=>{if(!dragging)return;navigate(e.clientY);e.preventDefault();});const end=()=>{dragging=false;track.classList.remove('dragging');};track.addEventListener('pointerup',end);track.addEventListener('pointercancel',end);
  }
  _thumbHeight(trackH) { if(this.isVariableAsm())return Math.max(28,Math.round(trackH*0.08));if(!this.totalRows)return 28;const frac=Math.min(1,this.visibleRows()/this.totalRows);return Math.max(28,Math.round(trackH*frac)); }
  _updateScrubber() {
    if(!this.track||!this.region)return;const trackH=this.track.clientHeight;if(!trackH)return;const thumbH=this._thumbHeight(trackH);let frac=0;
    if(this.isVariableAsm()){const address=this.topAddress()??this.region.vmAddr;frac=this.region.size>0n?Number(((address-this.region.vmAddr)*1_000_000n)/this.region.size)/1_000_000:0;}
    else if(this.totalRows){const span=Math.max(1,this.totalRows-this.visibleRows());frac=Math.max(0,Math.min(1,this.topRow()/span));}
    const y=Math.round(Math.max(0,Math.min(1,frac))*(trackH-thumbH)),style=this.thumb.style,h=thumbH+'px',t=y+'px';if(style.height!==h)style.height=h;if(style.top!==t)style.top=t;
  }

  _bindPointer() {
    const LONG_PRESS_MS = 500;
    const MOVE_TOLERANCE = 10;
    const CONTEXT_SUPPRESS_MS = 800;
    let gesture = null;
    let suppressContextUntil = 0;

    const rowFrom = (target) => {
      const el = target?.closest ? target.closest('.row') : null;
      return !el || el._row == null ? -1 : el._row;
    };
    const clearTimer = () => {
      if (!gesture?.timer) return;
      clearTimeout(gesture.timer);
      gesture.timer = 0;
    };
    const reset = () => {
      clearTimer();
      gesture = null;
    };
    const focus = (row) => {
      if (this.rangeMode) this.extendTo(row);
      else this.select(row, false);
    };
    const activate = (row) => {
      if (this.rangeMode) this.extendTo(row);
      else this.select(row, true);
    };
    const openContext = (row, x, y) => {
      focus(row);
      this.onLongPress(row, x, y);
    };

    this.vp.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const row = rowFrom(e.target);
      if (row < 0) return;
      reset();
      gesture = {
        pointerId: e.pointerId,
        row,
        x: e.clientX,
        y: e.clientY,
        longFired: false,
        timer: 0,
      };
      gesture.timer = setTimeout(() => {
        if (!gesture || gesture.pointerId !== e.pointerId) return;
        gesture.timer = 0;
        gesture.longFired = true;
        suppressContextUntil = Date.now() + CONTEXT_SUPPRESS_MS;
        openContext(gesture.row, gesture.x, gesture.y);
      }, LONG_PRESS_MS);
    }, { passive: true });

    this.vp.addEventListener('pointermove', (e) => {
      if (!gesture || e.pointerId !== gesture.pointerId || !gesture.timer) return;
      if (Math.abs(e.clientX - gesture.x) > MOVE_TOLERANCE ||
          Math.abs(e.clientY - gesture.y) > MOVE_TOLERANCE) clearTimer();
    }, { passive: true });

    this.vp.addEventListener('pointerup', (e) => {
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      const active = gesture;
      clearTimer();
      gesture = null;
      if (active.longFired) return;
      const row = rowFrom(e.target);
      if (row >= 0 && row === active.row &&
          Math.abs(e.clientX - active.x) < MOVE_TOLERANCE &&
          Math.abs(e.clientY - active.y) < MOVE_TOLERANCE) activate(row);
    }, { passive: true });

    this.vp.addEventListener('pointercancel', reset);
    this.vp.addEventListener('contextmenu', (e) => {
      const row = rowFrom(e.target);
      if (row < 0) return;
      e.preventDefault();
      if (Date.now() < suppressContextUntil) return;
      reset();
      openContext(row, e.clientX, e.clientY);
    });
  }
}