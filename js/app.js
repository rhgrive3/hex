/*
 * App shell: wires the store, the backend worker and the virtualized viewer to
 * the chrome (title bar, mode switch, address bar, status bar) and to the
 * sheets in panels.js.
 */
import { Store, loadPrefs, savePrefs } from './state.js';
import { Backend } from './backend.js';
import { CodeViewer } from './viewer.js';
import { addrHex, addrText, sizeText } from './format.js';
import { alertDialog, toast, closeTopSheet, closeMenu, menu } from './ui.js';
import { showFileInfo, showSections, showJump, showSearch, showDetail, showSettings, instructionMenu } from './panels.js';

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.store = new Store();
    this.prefs = loadPrefs();
    this.detailRefresh = null;
    this.capstoneVersion = '5';
    this.preferredMode = 'asm';   // what the user last chose; hex can be forced

    this.dom = {
      app: $('app'),
      name: $('tb-name'),
      sub: $('tb-sub'),
      open: $('btn-open'),
      open2: $('btn-open-2'),
      more: $('btn-more'),
      modeSwitch: $('mode-switch'),
      sections: $('btn-sections'),
      jump: $('btn-jump'),
      search: $('btn-search'),
      addrCur: $('addr-cur'),
      addrRegion: $('addr-region'),
      addrRange: $('addr-range'),
      colhead: $('colhead'),
      viewport: $('viewport'),
      rows: $('rows'),
      scrubber: $('scrubber'),
      thumb: $('scrub-thumb'),
      empty: $('empty'),
      loading: $('loading'),
      loadingText: $('loading-text'),
      stLeft: $('st-left'),
      stRight: $('st-right'),
      fileInput: $('file-input'),
    };

    this.backend = new Backend();
    this.backend.onChunk = (regionId, chunk) => {
      this.viewer.chunkArrived(regionId, chunk);
      if (this.detailRefresh) this.detailRefresh();
    };
    this.backend.onFatal = (message) => {
      this.setBusy(false);
      alertDialog('Analysis engine stopped', friendly(message));
    };

    this.viewer = new CodeViewer({
      viewport: this.dom.viewport,
      rows: this.dom.rows,
      backend: this.backend,
      onTopChange: (row, addr) => this.onTopChange(row, addr),
      onSelect: (row) => this.onSelectRow(row),
      onLongPress: (row, x, y) => instructionMenu(this, row, x, y),
    });
    this.viewer.attachScrubber(this.dom.scrubber, this.dom.thumb);

    this.applyTheme(this.prefs.theme || 'system');
    this.store.set({ hexJoined: !!this.prefs.hexJoined });
    this.viewer.setHexJoined(!!this.prefs.hexJoined);

    this.bind();
    this.layout();
    this.updateChrome();
  }

  /* ── wiring ───────────────────────────────────────────────── */

  bind() {
    const pick = () => this.dom.fileInput.click();
    this.dom.open.addEventListener('click', pick);
    this.dom.open2.addEventListener('click', pick);
    this.dom.fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';                   // allow re-opening the same file
      if (f) this.openFile(f);
    });

    this.dom.modeSwitch.addEventListener('click', (e) => {
      const b = e.target.closest('.seg');
      if (b) this.setMode(b.dataset.mode);
    });

    this.dom.sections.addEventListener('click', () => showSections(this));
    this.dom.jump.addEventListener('click', () => showJump(this));
    this.dom.search.addEventListener('click', () => showSearch(this));
    this.dom.more.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      menu([
        { label: 'File Info…', action: () => this.store.get('fileInfo') ? showFileInfo(this) : toast('Open a file first.') },
        { label: 'Sections…', action: () => this.store.get('fileInfo') ? showSections(this) : toast('Open a file first.') },
        '-',
        { label: 'Settings…', action: () => showSettings(this) },
        { label: 'Open File…', action: () => this.dom.fileInput.click() },
      ], r.left + r.width / 2, r.bottom - 4);
    });

    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { this.layout(); this.viewer.measure(); }, 80);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    document.addEventListener('keydown', (e) => this.onKey(e));

    // Dropping a file onto the page is handy with a Mac/keyboard setup.
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.openFile(f);
    });
  }

  onKey(e) {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Escape') {
      if (closeMenu() || closeTopSheet()) e.preventDefault();
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === 'f' || e.key === 'F')) {
      if (!this.store.get('currentRegion')) return;
      e.preventDefault(); showSearch(this); return;
    }
    if (meta && (e.key === 'g' || e.key === 'G')) {
      if (!this.store.get('currentRegion')) return;
      e.preventDefault(); showJump(this); return;
    }
    if (typing) return;
    if (!this.store.get('currentRegion')) return;

    switch (e.key) {
      case 'g': case 'G': e.preventDefault(); showJump(this); break;
      case '/': e.preventDefault(); showSearch(this); break;
      case 'ArrowDown': e.preventDefault(); this.viewer.scrollByRows(1); break;
      case 'ArrowUp': e.preventDefault(); this.viewer.scrollByRows(-1); break;
      case 'PageDown': case ' ': e.preventDefault(); this.viewer.scrollByPages(1); break;
      case 'PageUp': e.preventDefault(); this.viewer.scrollByPages(-1); break;
      case 'Home': e.preventDefault(); this.viewer.goToRow(0, 'top'); break;
      case 'End': e.preventDefault(); this.viewer.goToRow(this.viewer.totalRows - 1, 'top'); break;
      default: break;
    }
  }

  /* ── layout & chrome ──────────────────────────────────────── */

  layout() {
    const wide = window.innerWidth >= 820;
    this.dom.app.classList.toggle('wide', wide);
  }

  setBusy(on, text) {
    this.dom.loading.hidden = !on;
    if (text) this.dom.loadingText.textContent = text;
  }

  updateChrome() {
    const info = this.store.get('fileInfo');
    const region = this.store.get('currentRegion');
    const has = !!info;
    this.dom.sections.disabled = !has;
    this.dom.jump.disabled = !region;
    this.dom.search.disabled = !region;
    this.dom.empty.hidden = has;
    this.dom.scrubber.classList.toggle('on', !!region);

    if (!info) {
      this.dom.name.textContent = 'No File';
      this.dom.sub.textContent = 'Select a Mach-O or raw binary';
      this.dom.stLeft.textContent = '';
      this.dom.stRight.textContent = '';
      this.dom.addrCur.textContent = '—';
      this.dom.addrRegion.textContent = '';
      this.dom.addrRange.textContent = '';
      return;
    }

    this.dom.name.textContent = info.name;
    const arch = this.store.get('architecture');
    this.dom.sub.textContent = [info.format, arch, sizeText(info.size)].filter(Boolean).join(' · ');

    if (region) {
      this.dom.addrRegion.textContent = region.name;
      this.dom.addrRange.textContent =
        addrText(region.vmAddr) + '–' + addrText(region.vmAddr + region.size);
      this.dom.stLeft.textContent =
        (this.store.get('canDisassemble') ? 'ARM64' : (arch || 'data')) + ' · ' +
        sizeText(region.size) + ' · ' + this.viewer.totalRows.toLocaleString() + ' rows';
    }
    this.updateModeUI();
  }

  updateModeUI() {
    const mode = this.store.get('displayMode');
    for (const b of this.dom.modeSwitch.querySelectorAll('.seg')) {
      b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    }
    this.dom.colhead.classList.toggle('mode-asm-head', mode === 'asm');
    this.dom.colhead.classList.toggle('mode-hex-head', mode === 'hex');
  }

  onTopChange(row, addr) {
    this.dom.addrCur.textContent = addrHex(addr);
    const total = this.viewer.totalRows;
    this.dom.stRight.textContent = total
      ? (row + 1).toLocaleString() + ' / ' + total.toLocaleString()
      : '';
    this.store.set({ currentAddress: addr });
  }

  onSelectRow(row) {
    this.store.set({ selectedRow: row });
    showDetail(this, row);
  }

  /* ── theme ────────────────────────────────────────────────── */

  setTheme(theme) {
    this.applyTheme(theme);
    this.prefs.theme = theme;
    savePrefs(this.prefs);
  }

  applyTheme(theme) {
    this.store.set({ theme });
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }

  setHexJoined(on) {
    this.store.set({ hexJoined: on });
    this.viewer.setHexJoined(on);
    this.prefs.hexJoined = on;
    savePrefs(this.prefs);
  }

  /* ── file lifecycle ───────────────────────────────────────── */

  async openFile(file) {
    if (!file) return;
    if (file.size === 0) {
      alertDialog('Empty file', 'This file contains no data.');
      return;
    }
    this.setBusy(true, 'Reading ' + file.name + '…');
    this.backend.resetCache();
    this.detailRefresh = null;

    let info;
    try {
      info = await this.backend.open(file);
    } catch (err) {
      this.setBusy(false);
      alertDialog('Could not open this file', friendly(err.message));
      return;
    }

    this.store.set({ file, fileInfo: info, selectedRow: -1 });

    let sliceIndex = -1;
    if (info.slices.length) {
      sliceIndex = info.slices.findIndex((s) => s.info && s.info.isArm64);
      if (sliceIndex < 0) sliceIndex = info.slices.findIndex((s) => s.info);
    }
    this.setBusy(false);
    this.applySlice(sliceIndex, info);

    if (info.warnings && info.warnings.length) toast(info.warnings[0]);
    const slice = this.currentSlice();
    if (slice && slice.info && slice.info.encrypted) {
      alertDialog('Encrypted binary',
        'This Mach-O still has cryptid = 1, so __TEXT is App Store encrypted. ' +
        'The bytes are shown exactly as stored, but they will not disassemble into meaningful code ' +
        'until the image is decrypted (e.g. dumped from a device).');
    }
  }

  applySlice(sliceIndex, infoArg) {
    const info = infoArg || this.store.get('fileInfo');
    const slice = sliceIndex >= 0 ? info.slices[sliceIndex] : null;
    const regions = slice ? slice.regions : [];
    const arch = slice && slice.info
      ? slice.info.cpu + (slice.info.cpuSub && slice.info.cpuSub !== 'all' ? ' (' + slice.info.cpuSub + ')' : '')
      : null;
    const canDisassemble = slice && slice.info ? !!slice.info.isArm64 : true;   // raw files: assume ARM64

    this.store.set({ sliceIndex, regions, architecture: arch, canDisassemble });

    // Hex is forced for non-ARM64 images; the user's own choice comes back as
    // soon as an ARM64 image is opened again.
    const mode = canDisassemble ? this.preferredMode : 'hex';
    this.store.set({ displayMode: mode });
    this.viewer.setMode(mode);
    this.updateModeUI();

    const region = this.pickDefaultRegion(regions, info);
    this.selectRegion(region, { silent: true });

    if (canDisassemble) {
      this.backend.probe().catch((err) => {
        this.store.set({ canDisassemble: false, displayMode: 'hex' });
        this.viewer.setMode('hex');
        this.updateChrome();
        alertDialog('Disassembler unavailable', friendly(err.message));
      });
    } else if (slice && slice.info) {
      toast(arch + ' is not ARM64 — showing bytes only.');
    }
  }

  pickDefaultRegion(regions, info) {
    const text = regions.find((r) => r.section === '__text' && r.size > 0n);
    if (text) return text;
    const exec = regions.find((r) => r.exec && r.size > 0n);
    if (exec) return exec;
    const any = regions.find((r) => r.size > 0n);
    return any || info.raw;
  }

  currentSlice() {
    const info = this.store.get('fileInfo');
    const i = this.store.get('sliceIndex');
    if (!info || i < 0 || !info.slices[i]) return null;
    return info.slices[i];
  }

  selectSlice(index) {
    const info = this.store.get('fileInfo');
    if (!info || !info.slices[index] || info.slices[index].error) return;
    this.backend.resetCache();
    this.applySlice(index, info);
  }

  selectRegion(region, { silent } = {}) {
    if (!region) return;
    if (region.zerofill || region.size === 0n) {
      alertDialog('Nothing to show',
        region.name + ' has no bytes in the file' +
        (region.zerofill ? ' (it is zero-filled at load time).' : '.'));
      return;
    }
    this.backend.dropQueued();
    region.disasm = this.store.get('canDisassemble');
    this.store.set({ currentRegion: region, selectedRow: -1 });
    this.viewer.setRegion(region);
    this.updateChrome();
    if (!silent) toast(region.name);
  }

  setMode(mode) {
    if (mode !== 'asm' && mode !== 'hex') return;
    if (mode === 'asm' && !this.store.get('canDisassemble')) {
      const arch = this.store.get('architecture') || 'This binary';
      alertDialog('ARM64 only',
        arch + ' cannot be disassembled here. This viewer decodes ARM64 (AArch64) only; ' +
        'the Hex tab still shows the bytes.');
      return;
    }
    this.preferredMode = mode;
    this.store.set({ displayMode: mode });
    this.viewer.setMode(mode);
    this.updateModeUI();
  }

  /** Jump anywhere in the active slice; switches section when needed. */
  goToAddress(addr, { announce } = {}) {
    const region = this.store.get('currentRegion');
    if (region && addr >= region.vmAddr && addr < region.vmAddr + region.size) {
      this.viewer.goToAddress(addr);
      if (announce) this.flash(addr);
      return true;
    }
    const regions = this.store.get('regions') || [];
    const target = regions.find((r) => r.size > 0n && addr >= r.vmAddr && addr < r.vmAddr + r.size);
    if (target) {
      this.selectRegion(target, { silent: true });
      this.viewer.goToAddress(addr);
      toast(target.name);
      if (announce) this.flash(addr);
      return true;
    }
    const info = this.store.get('fileInfo');
    if (info && region && region.id === 'raw') {
      alertDialog('Outside the file',
        addrHex(addr) + ' is past the end of this file (' + addrHex(info.size) + ').');
      return false;
    }
    alertDialog('Address not mapped',
      addrHex(addr) + ' is not inside any section of this image.\n\n' +
      'Sections cover ' + describeRange(regions) + '.');
    return false;
  }

  flash(addr) {
    const region = this.store.get('currentRegion');
    if (!region) return;
    const row = Number((addr - region.vmAddr) / 4n);
    this.viewer.mark(row);
  }
}

function describeRange(regions) {
  const live = regions.filter((r) => r.size > 0n);
  if (!live.length) return 'nothing';
  let lo = live[0].vmAddr, hi = live[0].vmAddr + live[0].size;
  for (const r of live) {
    if (r.vmAddr < lo) lo = r.vmAddr;
    if (r.vmAddr + r.size > hi) hi = r.vmAddr + r.size;
  }
  return addrHex(lo) + ' – ' + addrHex(hi);
}

/** Turn engine/browser errors into something a person can act on. */
function friendly(message) {
  const m = String(message || '');
  if (/capstone\.wasm|WebAssembly|wasm/i.test(m)) {
    return 'The disassembler engine could not be loaded.\n\n' +
      'capstone.js and capstone.wasm must both be present next to index.html, ' +
      'and the page must be served over http(s) — opening index.html from the file system will not work.';
  }
  if (/NotReadableError|permission/i.test(m)) {
    return 'The file could not be read. If it came from iCloud Drive, open the Files app and download it first.';
  }
  if (/out of memory|allocation/i.test(m)) {
    return 'The browser ran out of memory while analysing this file. Close other tabs and try again.';
  }
  return m || 'Unknown error.';
}

/* ── boot ───────────────────────────────────────────────────── */

window.addEventListener('error', (e) => {
  if (e && e.message && /ResizeObserver/.test(e.message)) return;
});

const app = new App();
window.__app = app;   // handy in Safari's Web Inspector; not used by the UI
