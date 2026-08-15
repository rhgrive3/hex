/*
 * Design philosophy: 「証拠の地図帳」。日本語を主軸に、現在地・根拠・次の行動を接続する。
 *
 * アプリの骨組み。
 * store・worker・ビューアと、画面の枠（タイトルバー、ツールバー、状態表示）、
 * それに panels.js のシート群をつなぐ。
 */
import { Store, loadPrefs, savePrefs } from './state.js';
import { Backend } from './backend.js';
import { CodeViewer } from './viewer.js';
import { addrHex, addrText, sizeText } from './format.js';
import { alertDialog, toast, closeTopSheet, closeAllSheets, closeMenu, menu } from './ui.js';
import {
  showFileInfo, showSections, showJump, showSearch, showDetail, showSettings,
  instructionMenu, showFunctions, showStrings, showStructure, showHelp,
  showLearn, showGlossary, showWelcome, showSampleGuide, showFunctionSummary,
  showFeatures, showInvestigate, showOverview, showFunctionReport, showAccuracyNotes,
} from './panels.js';
import { rangeCopyMenu, copyRange } from './rangecopy.js';
import { t, setLang, detectLang, lang, isJa, pick } from './i18n.js';
import { SymbolIndex, EMPTY_INDEX } from './symbols.js';
import { clearBriefCache } from './arm64.js';
import { clearAnalysisCache, analyzeFunctionCached } from './analyze.js';
import { buildOverlay } from './narrate.js';
import { buildObjcModel } from './objc.js';
import { FieldIndex, EMPTY_FIELDS } from './fields.js';
import { makeSampleFile } from './sample.js';
import { ProgramIndex } from './program.js';
import { foldShapes } from './shapes.js';
import { recoverSchemas } from './schema.js';
import { NoteStore, noteKeyFor, legacyNoteKeyFor, EMPTY_NOTES } from './names.js';
import { PatchSet } from './patch.js';
import { PluginHost } from './plugins.js';
import { showTools, prettyName } from './tools.js';
import { NavigationHistory } from './navigation.js';

const $ = (id) => document.getElementById(id);

class App {
  get analysisEpoch() { return this.backend ? this.backend.analysisEpoch : -1; }

  constructor() {
    this.store = new Store();
    this.prefs = loadPrefs();
    this.detailRefresh = null;
    this.capstoneVersion = '5';
    this.preferredMode = 'asm';
    this.symbols = EMPTY_INDEX;
    this.sampleOpen = false;
    // 直近に解析した関数の Semantic Model。ビューアはここから作った表を引くだけ。
    this.semantic = null;
    this.featureIndex = null;   // 機能から探すための文字列の索引（ファイル単位）
    this.stringIndex = null;    // 収集済みの文字列（ファイル単位でキャッシュ）
    this.program = null;        // ProgramIndex — 呼び出し関係とデータ参照
    this.programScan = null;    // worker から受け取った生の走査結果
    this.programKey = null;     // 索引がどのセクションのものか
    this.programBusy = null;    // 走査中の Promise（二重に走らせない）
    this.programBusyEpoch = -1;
    this.shapes = null;         // 値のふるまい（shapes.js）。名前のないアプリ向けの土台。
    this.shapesBusy = null;
    this.shapesBusyEpoch = -1;
    this.schemas = null;        // データファイルの表（schema.js）
    this.schemasBusy = null;
    this.schemasBusyEpoch = -1;
    this.stringsBusy = null;
    this.stringsBusyEpoch = -1;
    this.lastGoal = null;       // 直近に調べた目的
    // Objective-C のクラスとフィールド。x0+0x20 を self.hp と言えるようにする索引。
    this.fields = EMPTY_FIELDS;
    this.objcBusy = null;
    this.objcBusyEpoch = -1;
    this.symbolsReadyEpoch = -1;
    /* 自分で付けた名前・メモ・型（names.js）。ファイルごとに保存される。 */
    this.notes = EMPTY_NOTES;
    /* 命令の書き換え（patch.js）。保存を選ぶまでファイルには触らない。 */
    this.patches = new PatchSet();
    /* 追加した機能（plugins.js）。 */
    this.plugins = new PluginHost(this);

    /* 端末の言語に合わせる。ここを 'ja' 決め打ちにしていたころ、
       英語の端末でもツールバーが日本語のままだった。 */
    setLang(this.prefs.lang || detectLang());

    this.dom = {
      app: $('app'),
      name: $('tb-name'),
      sub: $('tb-sub'),
      open: $('btn-open'),
      /* Welcome-screen open button. The titlebar's own Open is re-bound by the
         canonical UI bootstrap, so this one keeps its own id. */
      open2: $('btn-open-welcome'),
      sample: $('btn-sample'),
      learn: $('btn-learn-2'),
      help: $('btn-help'),
      more: $('btn-more'),
      modeSwitch: $('mode-switch'),
      explain: $('btn-explain'),
      sections: $('btn-sections'),
      investigate: $('btn-investigate'),
      tools: $('btn-tools'),
      functions: $('btn-functions'),
      strings: $('btn-strings'),
      struct: $('btn-struct'),
      jump: $('btn-jump'),
      overflow: $('btn-overflow'),
      search: $('btn-search'),
      select: $('btn-select'),
      selbar: $('selbar'),
      selCount: $('sel-count'),
      selRange: $('sel-range'),
      selAll: $('btn-sel-all'),
      selCopy: $('btn-sel-copy'),
      selDone: $('btn-sel-done'),
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
      navHistory: $('nav-history'),
      navBack: $('nav-back'),
      navForward: $('nav-forward'),
      navCrumbs: $('nav-crumbs'),
      fileInput: $('file-input'),
    };

    this.navigation = new NavigationHistory({
      onChange: (state) => this.renderNavigation(state),
      onNavigate: (entry) => this.restoreNavigation(entry),
    });

    this.backend = new Backend();
    this.backend.onChunk = (regionId, chunk) => {
      this.viewer.chunkArrived(regionId, chunk);
      if (this.detailRefresh) this.detailRefresh();
    };
    this.backend.onFatal = (message) => {
      this.setBusy(false);
      alertDialog(t('err.engineTitle'), friendly(message));
    };

    this.viewer = new CodeViewer({
      viewport: this.dom.viewport,
      rows: this.dom.rows,
      backend: this.backend,
      onTopChange: (row, addr) => this.onTopChange(row, addr),
      onSelect: (row) => this.onSelectRow(row),
      onLongPress: (row, x, y) => instructionMenu(this, row, x, y),
      onRangeChange: () => this.updateSelectionBar(),
    });
    this.viewer.attachScrubber(this.dom.scrubber, this.dom.thumb);

    this.applyTheme(this.prefs.theme || 'system');
    this.applyTextSize(this.prefs.textSize || 'm');
    this.store.set({ hexJoined: !!this.prefs.hexJoined });
    this.viewer.setHexJoined(!!this.prefs.hexJoined);
    if (this.prefs.explain == null) this.prefs.explain = true;   // 初心者向けなので既定でオン
    this.viewer.setNotes(this.prefs.explain, this.prefs.noteStyle || 'ja');

    this.bind();
    this.applyLabels();
    this.layout();
    this.updateChrome();

    if (!this.prefs.guideSeen) setTimeout(() => showWelcome(this), 300);
  }

  /* ── 文言 ─────────────────────────────────────────────────── */

  /** data-i18n が付いた要素の文言を、今の言語で入れ直す。 */
  applyLabels() {
    for (const node of document.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of document.querySelectorAll('[data-i18n-aria]')) {
      node.setAttribute('aria-label', t(node.dataset.i18nAria));
    }
    for (const node of document.querySelectorAll('[data-i18n-html]')) {
      node.replaceChildren();
      const lines = t(node.dataset.i18nHtml).split('\n');
      lines.forEach((line, i) => {
        if (i) node.append(document.createElement('br'));
        node.append(document.createTextNode(line));
      });
    }
    document.title = t('app.title');
    this.dom.explain.setAttribute('aria-pressed', String(!!this.prefs.explain));
    this.updateChrome();
  }

  /* ── 配線 ─────────────────────────────────────────────────── */

  bind() {
    const pick2 = () => this.dom.fileInput.click();
    this.dom.open.addEventListener('click', pick2);
    if (this.dom.open2) this.dom.open2.addEventListener('click', pick2);
    this.dom.sample.addEventListener('click', () => this.openSample());
    this.dom.learn.addEventListener('click', () => showLearn(this));
    this.dom.fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) this.openFile(f);
    });

    this.dom.modeSwitch.addEventListener('click', (e) => {
      const b = e.target.closest('.seg');
      if (b) this.setMode(b.dataset.mode);
    });

    this.dom.explain.addEventListener('click', () => this.setExplain(!this.prefs.explain));
    this.dom.sections.addEventListener('click', () => showSections(this));
    this.dom.investigate.addEventListener('click', () => showInvestigate(this));
    this.dom.tools.addEventListener('click', () => showTools(this));
    this.dom.functions.addEventListener('click', () => showFunctions(this));
    this.dom.strings.addEventListener('click', () => showStrings(this));
    this.dom.struct.addEventListener('click', () => showStructure(this));
    this.dom.jump.addEventListener('click', () => showJump(this));
    this.dom.search.addEventListener('click', () => showSearch(this));
    this.dom.help.addEventListener('click', () => showHelp(this));
    /*
     * 「その他」。ツールバーに収まりきらない 4 つを、浮かせたメニューで出す。
     * 中身は同じボタンをそのまま押すので、有効・無効の扱いは 1 か所のままになる。
     */
    this.dom.overflow.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const item = (el2) => ({
        label: el2.textContent,
        disabled: el2.disabled,
        action: () => el2.click(),
      });
      menu([
        item(this.dom.strings), item(this.dom.sections),
        item(this.dom.struct), item(this.dom.select),
      ], r.left + r.width / 2, r.bottom + 4);
    });
    this.dom.select.addEventListener('click', () => {
      if (this.viewer.rangeMode) this.viewer.clearRange();
      else this.startSelection();
    });

    this.dom.selAll.addEventListener('click', () => this.viewer.selectAllRows());
    this.dom.selDone.addEventListener('click', () => this.viewer.clearRange());
    this.dom.selCopy.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      rangeCopyMenu(this, r.left + r.width / 2, r.top);
    });
    this.dom.more.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const needFile = (fn) => () => (this.store.get('fileInfo') ? fn() : toast(t('err.openFirst')));
      menu([
        { label: t('file.title') + '…', action: needFile(() => showFileInfo(this)) },
        { label: t('struct.title') + '…', action: needFile(() => showStructure(this)) },
        { label: t('sections.title') + '…', action: needFile(() => showSections(this)) },
        '-',
        { label: t('help.learn'), action: () => showLearn(this) },
        { label: t('glossary.title'), action: () => showGlossary(this) },
        { label: t('help.title'), action: () => showHelp(this) },
        '-',
        { label: t('settings.title') + '…', action: () => showSettings(this) },
        { label: t('btn.openFile'), action: () => this.dom.fileInput.click() },
      ], r.left + r.width / 2, r.bottom - 4);
    });
    this.dom.navBack.addEventListener('click', () => this.navigation.back());
    this.dom.navForward.addEventListener('click', () => this.navigation.forward());

    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { this.layout(); this.viewer.measure(); }, 80);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    document.addEventListener('keydown', (e) => this.onKey(e));

    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.openFile(f);
    });
  }

  onKey(e) {
    const target = e.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (e.key === 'Escape') {
      if (closeMenu() || closeTopSheet()) { e.preventDefault(); return; }
      if (this.viewer.rangeMode) { this.viewer.clearRange(); e.preventDefault(); }
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
    if (e.key === '?') { e.preventDefault(); showHelp(this); return; }
    if (!this.store.get('currentRegion')) return;

    if (meta && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault(); this.viewer.selectAllRows(); return;
    }
    if (meta && (e.key === 'c' || e.key === 'C')) {
      if (!this.viewer.selectionRange()) return;
      e.preventDefault(); copyRange(this, 'all'); return;
    }

    const shift = e.shiftKey;
    const v = this.viewer;
    switch (e.key) {
      case 'g': case 'G': e.preventDefault(); showJump(this); break;
      case '/': e.preventDefault(); showSearch(this); break;
      case 'e': case 'E': e.preventDefault(); this.setExplain(!this.prefs.explain); break;
      case 'ArrowDown': e.preventDefault(); shift ? v.extendByRows(1) : v.scrollByRows(1); break;
      case 'ArrowUp': e.preventDefault(); shift ? v.extendByRows(-1) : v.scrollByRows(-1); break;
      case 'PageDown': case ' ': e.preventDefault(); shift ? v.extendByPages(1) : v.scrollByPages(1); break;
      case 'PageUp': e.preventDefault(); shift ? v.extendByPages(-1) : v.scrollByPages(-1); break;
      case 'Home': e.preventDefault(); shift ? v.extendToRow(0) : v.goToRow(0, 'top'); break;
      case 'End': e.preventDefault();
        shift ? v.extendToRow(v.totalRows - 1) : v.goToRow(v.totalRows - 1, 'top'); break;
      default: break;
    }
  }

  /* ── 画面の枠 ─────────────────────────────────────────────── */

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
    this.dom.struct.disabled = !has;
    this.dom.strings.disabled = !has;
    this.dom.investigate.disabled = !has;
    this.dom.tools.disabled = !has;
    this.dom.functions.disabled = !region;
    this.dom.jump.disabled = !region;
    this.dom.overflow.disabled = !has;
    this.dom.search.disabled = !region;
    this.dom.select.disabled = !region;
    this.dom.empty.hidden = has;
    this.dom.navHistory.hidden = !has;
    this.dom.scrubber.classList.toggle('on', !!region);
    this.updateSelectionBar();

    if (!info) {
      this.dom.name.textContent = t('app.noFile');
      this.dom.sub.textContent = t('app.noFileSub');
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
        (this.store.get('canDisassemble') ? 'ARM64' : (arch || t('status.data'))) + ' · ' +
        sizeText(region.size) + ' · ' + t('status.rows', { n: this.viewer.totalRows.toLocaleString() });
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
    this.dom.explain.disabled = mode !== 'asm';
  }

  onTopChange(row, addr) {
    this.dom.addrCur.textContent = addrHex(addr);
    const total = this.viewer.totalRows;
    this.dom.stRight.textContent = total
      ? t('status.rowOf', { cur: (row + 1).toLocaleString(), total: total.toLocaleString() })
      : '';
    this.store.set({ currentAddress: addr });
  }

  onSelectRow(row) {
    this.store.set({ selectedRow: row });
    showDetail(this, row);
  }

  /* ── 範囲選択 ─────────────────────────────────────────────── */

  startSelection(row) {
    if (!this.store.get('currentRegion')) return;
    closeTopSheet();
    if (row == null) {
      const sel = this.viewer.selectedRow;
      const top = this.viewer.topRow();
      const visible = sel >= top && sel < top + this.viewer.visibleRows();
      row = visible ? sel : top;
    }
    this.viewer.beginRange(row);
    toast(t('sel.hint'));
  }

  updateSelectionBar() {
    const sel = this.viewer.rangeMode ? this.viewer.selectionRange() : null;
    this.dom.selbar.hidden = !sel;
    this.dom.select.setAttribute('aria-pressed', String(!!sel));
    this.store.set({
      selectionStart: sel ? sel.start : -1,
      selectionEnd: sel ? sel.end : -1,
    });
    if (!sel) return;
    this.dom.selCount.textContent = t('sel.rows', { n: sel.count.toLocaleString() });
    this.dom.selRange.textContent =
      addrText(this.viewer.rowAddress(sel.start)) + '–' + addrText(this.viewer.rowAddress(sel.end));
  }

  /* ── 設定 ─────────────────────────────────────────────────── */

  saveSettings() { savePrefs(this.prefs); }

  setTheme(theme) {
    this.applyTheme(theme);
    this.prefs.theme = theme;
    this.saveSettings();
  }

  applyTheme(theme) {
    this.store.set({ theme });
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }

  setTextSize(size) {
    this.applyTextSize(size);
    this.prefs.textSize = size;
    this.saveSettings();
  }

  applyTextSize(size) {
    const root = document.documentElement;
    for (const s of ['s', 'm', 'l', 'xl']) root.classList.toggle('size-' + s, s === size);
    if (this.viewer) this.viewer.measure();
  }

  setHexJoined(on) {
    this.store.set({ hexJoined: on });
    this.viewer.setHexJoined(on);
    this.prefs.hexJoined = on;
    this.saveSettings();
  }

  setExplain(on) {
    this.prefs.explain = !!on;
    this.viewer.setNotes(!!on, this.prefs.noteStyle || 'ja');
    this.dom.explain.setAttribute('aria-pressed', String(!!on));
    this.saveSettings();
  }

  setNoteStyle(style) {
    this.prefs.noteStyle = style;
    this.viewer.setNotes(this.prefs.explain, style);
    this.saveSettings();
  }

  setLanguage(l) {
    this.prefs.lang = l;
    setLang(l);
    clearBriefCache();
    this.saveSettings();
    this.applyLabels();
    this.viewer.setSymbols(this.symbols);   // 解説を作り直させる
    // Semantic Model は言語に依存しないので、見出しだけ作り直せばよい
    if (this.semantic) {
      this.viewer.setBlockOverlay(this.semantic.regionId, buildOverlay(this.semantic.model));
    }
  }

  /* ── 意味の層 ─────────────────────────────────────────────── */

  /**
   * 表示中の解析結果を手放す。
   *
   * @param {boolean} dropCache 解析キャッシュごと捨てるか。
   *   別のファイル・スライスに移ったときだけ true。セクションを移っただけなら
   *   キャッシュ（鍵にセクション id を含む）はそのまま残して、戻ってきたとき速くする。
   */
  forgetSemantics(dropCache) {
    this.semantic = null;
    if (dropCache) {
      this.featureIndex = null;
      this.stringIndex = null;
      this.autoReport = null;
      this.pinnedCache = null;
      this.fields = EMPTY_FIELDS;
      this.objcModel = null;
      this.program = null;
      this.programScan = null;
      this.programKey = null;
      this.programBusy = null;
      this.programBusyEpoch = -1;
      this.shapes = null;
      this.shapesBusy = null;
      this.shapesBusyEpoch = -1;
      this.schemas = null;
      this.schemasBusy = null;
      this.schemasBusyEpoch = -1;
      this.stringsBusy = null;
      this.stringsBusyEpoch = -1;
      this.objcBusy = null;
      this.objcBusyEpoch = -1;
      this.symbolsReady = null;
      this.symbolsReadyEpoch = -1;
      this.lastGoal = null;
      clearAnalysisCache();
    }
    if (this.viewer) this.viewer.clearBlockOverlay();
  }

  /* ── プログラム全体の索引 ─────────────────────────────────
     「誰が誰を呼び、誰が何を見ているか」を 1 回だけ走査して作る。
     これがないと、このツールは名前と文字列を眺めるだけの道具に戻ってしまう。 */

  /** コードのセクション（__text 優先）。 */
  codeRegion() {
    const regions = this.store.get('regions') || [];
    return regions.find((r) => r.section === '__text' && r.size > 0n) ||
           regions.find((r) => r.exec && r.size > 0n) ||
           this.store.get('currentRegion') || null;
  }

  /**
   * 関数の切れ目をそろえる。LC_FUNCTION_STARTS がないファイルでは推測に頼る。
   * 呼び出しグラフは「その命令がどの関数の中にあるか」を必要とするので、ここが要る。
   */
  async ensureFunctions(region, onProgress) {
    const epoch = this.backend.gen;
    // 名前の読み込みが終わるのを待つ。先に走らせると、無駄に推測してしまう。
    if (this.symbolsReady) { try { await this.symbolsReady; } catch { /* 名前がなくても続ける */ } }
    if (epoch !== this.backend.gen) return null;
    // EMPTY_INDEX は全体で共有している空の索引なので、絶対に書き換えない
    if (this.symbols === EMPTY_INDEX) {
      this.symbols = new SymbolIndex({ regions: this.store.get('regions') || [] });
      this.viewer.setSymbols(this.symbols);
    }
    const sym = this.symbols;
    if (!sym || sym.functionStartsExact) return sym;
    if (!region) return sym;
    try {
      const res = await this.backend.guessFunctions(region.id, null,
        onProgress && ((p) => onProgress({ phase: 'functions', done: p.done, all: p.all })));
      if (epoch === this.backend.gen && res && res.starts && res.starts.length) {
        /* Keep exact starts recovered from ObjC/metadata and merge inferred C/C++/
           Swift starts around them. Replacing the list here used to throw away
           the strongest evidence as soon as partial metadata existed. */
        sym.addFunctions(res.starts);
        sym.guessed = true;
        sym.functionDiscovery = res.completeness || { complete: res.complete !== false, capped: !!res.capped };
        sym.functionStartsComplete = res.complete !== false;
        sym.functionStartsCapped = !!res.capped;
        this.viewer.setSymbols(sym);
      }
    } catch { /* 推測できなくても、ほかの解析は続ける */ }
    return sym;
  }

  /**
   * プログラム全体の索引を用意する。すでにあれば作り直さない。
   * シンボルだけが増えたとき（Objective-C の名前復元など）は、走査結果を使い回す。
   */
  async ensureProgram(onProgress) {
    const region = this.codeRegion();
    if (!region) return null;
    const key = region.id;
    if (this.program && this.programKey === key && this.program.gen === this.symbols.gen) {
      return this.program;
    }
    if (this.programScan && this.programKey === key) {
      this.program = new ProgramIndex(this.programScan, this.symbols, region);
      return this.program;
    }
    const epoch = this.backend.gen;
    if (this.programBusy && this.programBusyEpoch === epoch) return this.programBusy;

    this.programBusyEpoch = epoch;
    this.programBusy = (async () => {
      await this.ensureFunctions(region, onProgress);
      if (epoch !== this.backend.gen) return null;
      try {
        const scan = await this.backend.scanProgram(region.id,
          onProgress && ((p) => onProgress({ phase: 'scan', done: p.done, all: p.all })));
        if (epoch === this.backend.gen && scan && !scan.cancelled) {
          this.programScan = scan;
          this.programKey = key;
          this.program = new ProgramIndex(scan, this.symbols, region);
        }
      } catch {
        if (epoch === this.backend.gen) this.program = null;
      } finally {
        if (this.programBusyEpoch === epoch) {
          this.programBusy = null;
          this.programBusyEpoch = -1;
        }
      }
      return epoch === this.backend.gen ? this.program : null;
    })();
    return this.programBusy;
  }

  /**
   * 値の「ふるまい」をコード全体から集める。
   *
   * 名前も文字列も残っていないアプリ（ゲーム本体が C++ のもの）で、値を見分ける
   * ための土台。セクションを 1 回舐めるだけなので、18 MB でも 1 秒かからない。
   * ファイル単位でキャッシュする。
   */
  async ensureShapes(onProgress) {
    if (this.shapes) return this.shapes;
    const epoch = this.backend.gen;
    if (this.shapesBusy && this.shapesBusyEpoch === epoch) return this.shapesBusy;
    const region = this.codeRegion();
    if (!region) return null;
    this.shapesBusyEpoch = epoch;
    this.shapesBusy = (async () => {
      try {
        const scan = await this.backend.valueShapes(region.id,
          onProgress && ((p) => onProgress({ phase: 'shapes', done: p.done, all: p.all })));
        if (epoch === this.backend.gen && scan && !scan.cancelled) this.shapes = foldShapes(scan);
      } catch {
        if (epoch === this.backend.gen) this.shapes = null;
      } finally {
        if (this.shapesBusyEpoch === epoch) {
          this.shapesBusy = null;
          this.shapesBusyEpoch = -1;
        }
      }
      return epoch === this.backend.gen ? this.shapes : null;
    })();
    return this.shapesBusy;
  }

  /**
   * データファイル（CSV / JSON）の表の形を、読み込み処理の命令から取り戻す。
   *
   * ゲームの数値はコードではなくデータファイルにある。バイナリに「攻撃力」の
   * 文字は無くても、「何列目がどこに入るか」は命令に書いてある。ここがその入口。
   * 文字列と呼び出し関係が要るので、先にそちらを用意してから走る。
   */
  async ensureSchemas(onProgress) {
    if (this.schemas) return this.schemas;
    const epoch = this.backend.gen;
    if (this.schemasBusy && this.schemasBusyEpoch === epoch) return this.schemasBusy;
    this.schemasBusyEpoch = epoch;
    this.schemasBusy = (async () => {
      try {
        const strings = await this.ensureStrings(onProgress);
        const program = await this.ensureProgram(onProgress);
        if (epoch !== this.backend.gen) return null;
        if (!program) { this.schemas = []; return this.schemas; }
        const read = (addr, len) => this.backend.readAt(addr, len)
          .then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
        const schemas = await recoverSchemas({ strings, program, read, onProgress,
          isCancelled: () => epoch !== this.backend.gen });
        if (epoch === this.backend.gen) this.schemas = schemas;
      } catch {
        if (epoch === this.backend.gen) this.schemas = [];
      } finally {
        if (this.schemasBusyEpoch === epoch) {
          this.schemasBusy = null;
          this.schemasBusyEpoch = -1;
        }
      }
      return epoch === this.backend.gen ? this.schemas : null;
    })();
    return this.schemasBusy;
  }

  /**
   * 文字列を集める。__cstring などが第一候補で、なければ今のセクション。
   * ファイル単位でキャッシュする（何度も走査しない）。
   */
  async ensureStrings(onProgress) {
    if (this.stringIndex) return this.stringIndex;
    const epoch = this.backend.gen;
    if (this.stringsBusy && this.stringsBusyEpoch === epoch) return this.stringsBusy;
    this.stringsBusyEpoch = epoch;
    this.stringsBusy = (async () => {
    const regions = this.store.get('regions') || [];
    /*
     * 文字列の置き場は 6 か所とはかぎらない。上から 6 つだけ見ていたころは
     * __oslogstring のような後ろのほうの区画がまるごと抜けていた。
     * 走査は速いので、文字列が入りうる区画は全部見る（合計のバイト数だけ見張る）。
     */
    const priority = (r) => {
      const s = r.section || '';
      if (r.cstrings || /^__(cstring|objc_methname|objc_classname|swift5_reflstr|oslogstring)$/.test(s)) return 0;
      if (/string|objc_method|objc_class|ustring/i.test(s)) return 1;
      return 2; // general __const comes last
    };
    const targets = regions.filter((r) => r.size > 0n &&
      (r.cstrings || /string|cstring|objc_methname|objc_method|objc_classname|objc_class|oslogstring|const|ustring|swift5_reflstr/i.test(r.section || '')))
      .sort((a, b) => priority(a) - priority(b));
    const current = this.store.get('currentRegion');
    let budget = 64 * 1024 * 1024;
    const use = [];
    const skipped = [];
    for (const r of targets) {
      if (budget <= 0) { skipped.push(r); continue; }
      const bytes = Math.min(budget, Number(r.size));
      use.push({ region: r, bytes });
      budget -= bytes;
      if (bytes < Number(r.size)) skipped.push(r);
    }
    if (!use.length && current) use.push({ region: current, bytes: Math.min(64 * 1024 * 1024, Number(current.size)) });
    const out = [];
    let scannedBytes = 0;
    try {
      for (const item of use) {
        if (epoch !== this.backend.gen) return null;
        const r = item.region;
        const res = await this.backend.strings({ regionId: r.id, min: 4, maxBytes: item.bytes },
          onProgress && ((p) => onProgress({ phase: 'strings', done: p.done, all: p.all, region: r.id })));
        scannedBytes += res.scannedBytes || 0;
        if (!res.complete && !skipped.includes(r)) skipped.push(r);
        for (const s of res.results) out.push({ addr: s.addr, text: s.text, region: r });
      }
    } finally {
      if (this.stringsBusyEpoch === epoch) {
        this.stringsBusy = null;
        this.stringsBusyEpoch = -1;
      }
    }
    out.complete = skipped.length === 0;
    out.skippedRegions = skipped.map((r) => ({ id: r.id, name: r.name, section: r.section, size: r.size }));
    out.scannedBytes = scannedBytes;
    if (epoch === this.backend.gen) this.stringIndex = out;
    return epoch === this.backend.gen ? out : null;
    })();
    return this.stringsBusy;
  }

  /** 関数レポートを開く（候補一覧・XREF・ビューアのどこからでも呼べる入口）。 */
  openFunctionReport(addr, goal) {
    showFunctionReport(this, addr, goal || this.lastGoal || null);
  }

  /*
   * 解析の各画面への入口。
   *
   * 「解析」シートの中から呼べるように、app 側に口を作っておく。
   * tools.js が panels.js を直に読むと、両方が互いを読み合う形になるため。
   */
  openOverview() { showOverview(this); }
  openInvestigate() { showInvestigate(this); }
  openFeatures() { showFeatures(this); }
  openAccuracyNotes() { showAccuracyNotes(this, this.autoReport ? this.autoReport.report : null); }

  /**
   * 関数 1 つぶんの意味解析を走らせて、ビューアに処理の区切りを出す。
   *
   * 呼ばれるのは「利用者が関数を開いたとき」だけ。スクロールや描画からは絶対に呼ばない。
   * 同じ関数は analyze.js 側のキャッシュに載るので、二度目はすぐ返る。
   */
  async analyzeFunctionAt(addr) {
    const region = this.store.get('currentRegion');
    const sym = this.symbols;
    if (!region || !this.store.get('canDisassemble') || !sym.functionCount) return null;
    const fn = sym.functionAt(addr);
    if (!fn || fn.start < region.vmAddr) return null;
    const startRow = Number((fn.start - region.vmAddr) / 4n);
    const endRow = fn.end != null
      ? Math.min(this.viewer.totalRows - 1, Number((fn.end - region.vmAddr) / 4n) - 1)
      : Math.min(this.viewer.totalRows - 1, startRow + 2048);
    if (endRow < startRow) return null;
    try {
      const res = await analyzeFunctionCached(this.backend, region, startRow, endRow, sym);
      if (this.store.get('currentRegion') !== region) return null;
      this.semantic = { regionId: region.id, model: res.model, result: res };
      this.viewer.setBlockOverlay(region.id, buildOverlay(res.model));
      return res;
    } catch {
      return null;   // 解析できなくても、命令の表示はそのまま続く
    }
  }

  /* ── ファイルを開く ───────────────────────────────────────── */

  async openFile(file, opts) {
    if (!file) return;
    if (file.size === 0) {
      alertDialog(t('err.emptyTitle'), t('err.emptyText'));
      return;
    }
    this.sampleOpen = !!(opts && opts.sample);
    /* 前のファイルについて開いていたシートは、重なりごと片付ける。
       1 枚だけ閉じると、下に前のファイルの画面が残って戻れてしまう。 */
    closeAllSheets();
    this.setBusy(true, t('status.reading', { name: file.name }));
    this.backend.resetCache();
    this.detailRefresh = null;
    this.symbols = EMPTY_INDEX;
    this.symbolsReady = null;
    this.viewer.setSymbols(EMPTY_INDEX);
    this.forgetSemantics(true);

    let info;
    let openEpoch;
    try {
      const opening = this.backend.open(file);
      openEpoch = this.backend.gen;
      info = await opening;
    } catch (err) {
      if (err && err.stale) return;
      this.setBusy(false);
      alertDialog(t('err.openTitle'), friendly(err.message));
      return;
    }
    if (openEpoch !== this.backend.gen) return;

    this.store.set({ file, fileInfo: info, selectedRow: -1 });

    let sliceIndex = -1;
    if (info.slices.length) {
      sliceIndex = info.slices.findIndex((s) => s.info && s.info.isArm64);
      if (sliceIndex < 0) sliceIndex = info.slices.findIndex((s) => s.info);
    }
    /* fingerprint + active sliceで、同名・同サイズやFat内の別sliceを混同しない。 */
    const notes = new NoteStore(await noteKeyFor(file, info, sliceIndex), [legacyNoteKeyFor(file, info)]);
    if (openEpoch !== this.backend.gen) return;
    this.notes = notes;
    this.patches = new PatchSet();
    this.setBusy(false);
    this.applySlice(sliceIndex, info);

    if (info.warnings && info.warnings.length) toast(info.warnings[0]);
    const slice = this.currentSlice();
    if (slice && slice.info && slice.info.encrypted) {
      alertDialog(t('err.encryptedTitle'), t('err.encryptedText'));
    }
    /*
     * ファイルを開いた直後に主役になるのはコード。
     * ここで概要シートを自動で開いていたころ、開いた瞬間に全画面のシートが
     * かぶさって、命令が 1 行も見えないまま「閉じる」を押させていた。
     * 概要は「解析」から自分で開く（openOverview）ものにして、
     * ここでは画面をコードへ移すことだけを知らせる。
     */
    document.dispatchEvent(new CustomEvent('hex:file-opened', {
      detail: { name: info.name, sample: this.sampleOpen },
    }));
    if (this.sampleOpen) setTimeout(() => showSampleGuide(this), 250);
  }

  /** 練習用のサンプルをその場で組み立てて開く。 */
  async openSample() {
    try {
      const file = makeSampleFile();
      await this.openFile(file, { sample: true });
    } catch (err) {
      alertDialog(t('err.openTitle'), friendly(err && err.message));
    }
  }

  applySlice(sliceIndex, infoArg) {
    const epoch = this.backend.gen;
    const info = infoArg || this.store.get('fileInfo');
    const slice = sliceIndex >= 0 ? info.slices[sliceIndex] : null;
    const regions = slice ? slice.regions : [];
    const arch = slice && slice.info
      ? slice.info.cpu + (slice.info.cpuSub && slice.info.cpuSub !== 'all' ? ' (' + slice.info.cpuSub + ')' : '')
      : null;
    const canDisassemble = slice && slice.info ? !!slice.info.isArm64 : true;

    this.store.set({ sliceIndex, regions, architecture: arch, canDisassemble });

    const mode = canDisassemble ? this.preferredMode : 'hex';
    this.store.set({ displayMode: mode });
    this.viewer.setMode(mode);
    this.updateModeUI();

    const region = this.pickDefaultRegion(regions, info);
    this.selectRegion(region, { silent: true });
    this.navigation.reset(region ? this.navigationEntry(region.vmAddr, pick('解析の開始', 'Analysis start')) : null);

    if (canDisassemble) {
      this.backend.probe().catch((err) => {
        if (epoch !== this.backend.gen || (err && err.stale)) return;
        this.store.set({ canDisassemble: false, displayMode: 'hex' });
        this.viewer.setMode('hex');
        this.updateChrome();
        alertDialog(t('err.engineTitle'), friendly(err.message));
      });
    } else if (slice && slice.info) {
      toast(t('err.notArm64', { arch }));
    }

    // 名前と関数の一覧はここで作る。失敗しても表示自体は続けられる。
    if (sliceIndex >= 0) {
      this.symbolsReadyEpoch = epoch;
      this.symbolsReady = this.backend.analyze(sliceIndex).then((res) => {
        if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return;
        this.symbols = new SymbolIndex({ ...res, regions: this.store.get('regions') || [] });
        // 前回このファイルに付けた名前を戻す（元の名前より優先される）
        for (const e of this.notes.nameEntries()) this.symbols.rename(e.addr, e.name);
        this.viewer.setSymbols(this.symbols);
        this.updateChrome();
        return this.ensureObjc(sliceIndex);
      }).catch(() => { /* シンボルがなくても読める */ });
    }
  }

  /**
   * Objective-C のクラス表を読む。このツールでいちばん効く一手。
   *
   * 配布用のアプリは自作の関数名が削ってあるが、Objective-C のクラスだけは
   *
   *   - クラス名とメソッド名（実装アドレスつき）
   *   - **メンバ変数の名前・型・位置**
   *
   * がバイナリに必ず残っている。前者で sub_100123456 が
   * -[LoginViewController loginButtonTapped:] に戻り、後者で
   * [x0, #0x20] が self.hp に戻る。「どれがどの処理か」に答えられるのはここ。
   *
   * 裏で走らせて、できたところで画面を差し替える。失敗しても表示は続く。
   */
  async ensureObjc(sliceIndex) {
    const epoch = this.backend.gen;
    if (this.fields && this.fields.classCount) return this.fields;
    if (this.objcBusy && this.objcBusyEpoch === epoch) return this.objcBusy;
    const regions = this.store.get('regions') || [];
    const list = regions.find((r) => r.section === '__objc_classlist' && r.size > 0n);
    if (!list) { this.fields = EMPTY_FIELDS; return this.fields; }
    const slice = sliceIndex != null ? sliceIndex : this.store.get('sliceIndex');

    this.objcBusyEpoch = epoch;
    this.objcBusy = (async () => {
      const read = (addr, len) => this.backend.readAt(addr, len)
        .then((r) => (r && r.found ? r.bytes : null))
        .catch(() => null);
      try {
        // chained fixups のポインタは「イメージの先頭からの距離」なので、先頭が要る
        const info = this.store.get('fileInfo');
        const sl = info && info.slices ? info.slices[slice] : null;
        const imageBase = sl && sl.info ? sl.info.textVM : null;
        const model = await buildObjcModel(read, list, null, imageBase);
        if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== slice) return this.fields;
        this.objcModel = model;
        this.fields = new FieldIndex(model);
        if (model.names.length) {
          const added = this.symbols.addNames(model.names);
          this.symbols.addFunctions(model.names.map((n) => n.addr));
          this.viewer.setSymbols(this.symbols);
          this.updateChrome();
          if (added) {
            toast(pick(
              model.count + ' 個のクラスから、' + added + ' 個の関数の名前と ' +
                this.fields.fieldCount + ' 個の値の名前を復元しました',
              'Recovered ' + added + ' function names and ' + this.fields.fieldCount +
                ' field names from ' + model.count + ' classes'));
          }
        }
      } catch { /* 読めなくても、ほかの表示には影響させない */
      } finally {
        if (this.objcBusyEpoch === epoch) {
          this.objcBusy = null;
          this.objcBusyEpoch = -1;
        }
      }
      return epoch === this.backend.gen ? this.fields : EMPTY_FIELDS;
    })();
    return this.objcBusy;
  }

  /** その関数がどのクラスのメソッドか。分からなければ null。 */
  ownerOf(addr) {
    return this.fields ? this.fields.ownerOf(addr) : null;
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

  async selectSlice(index) {
    const info = this.store.get('fileInfo');
    if (!info || !info.slices[index] || info.slices[index].error) return;
    this.backend.advanceEpoch();
    this.forgetSemantics(true);
    this.symbols = EMPTY_INDEX;
    this.viewer.setSymbols(EMPTY_INDEX);
    const file = this.store.get('file');
    const epoch = this.backend.gen;
    const notes = new NoteStore(await noteKeyFor(file, info, index), [legacyNoteKeyFor(file, info)]);
    if (epoch !== this.backend.gen) return;
    this.notes = notes;
    this.applySlice(index, info);
  }

  selectRegion(region, { silent } = {}) {
    if (!region) return;
    if (region.zerofill || region.size === 0n) {
      alertDialog(t('err.nothingTitle'), t('err.nothingText', {
        name: region.name,
        zero: region.zerofill ? t('err.zerofill') : '',
      }));
      return;
    }
    this.backend.dropQueued();
    if (this.semantic && this.semantic.regionId !== region.id) this.forgetSemantics();
    region.disasm = this.store.get('canDisassemble');
    this.store.set({ currentRegion: region, selectedRow: -1 });
    this.viewer.setRegion(region);
    this.updateChrome();
    if (!silent) toast(region.name);
  }

  setMode(mode) {
    if (mode !== 'asm' && mode !== 'hex') return;
    if (mode === 'asm' && !this.store.get('canDisassemble')) {
      const arch = this.store.get('architecture') || pick('このファイル', 'This binary');
      alertDialog(t('err.disasmTitle'), t('err.arm64Only', { arch }));
      return;
    }
    this.preferredMode = mode;
    this.store.set({ displayMode: mode });
    this.viewer.setMode(mode);
    this.updateModeUI();
  }

  /* ── 移動 ─────────────────────────────────────────────────── */

  navigationEntry(addr, label) {
    const region = this.store.get('currentRegion');
    if (!region || addr == null) return null;
    return {
      key: region.id + ':' + addr.toString() + ':' + this.store.get('displayMode'),
      regionId: region.id,
      addr,
      mode: this.store.get('displayMode'),
      label: label || null,
    };
  }

  restoreNavigation(entry) {
    if (!entry) return;
    const regions = this.store.get('regions') || [];
    const region = regions.find((r) => r.id === entry.regionId);
    if (!region) return;
    if (this.store.get('currentRegion') !== region) this.selectRegion(region, { silent: true });
    if (entry.mode) this.setMode(entry.mode);
    this.viewer.goToAddress(entry.addr);
    this.flash(entry.addr);
  }

  renderNavigation(state = this.navigation.snapshot()) {
    if (!this.dom.navBack) return;
    this.dom.navBack.disabled = !state.canBack;
    this.dom.navForward.disabled = !state.canForward;
    const entry = state.current;
    this.dom.navCrumbs.replaceChildren();
    if (!entry) return;
    const parts = [];
    if (this.lastGoal && this.lastGoal.text) parts.push(this.lastGoal.text);
    const owner = this.ownerOf(entry.addr);
    if (owner && owner.className) parts.push(owner.className);
    if (owner && owner.sel) parts.push(owner.sel);
    if (entry.label) parts.push(entry.label);
    parts.push(addrHex(entry.addr));
    const seen = new Set();
    for (const part of parts.filter(Boolean)) {
      if (seen.has(part)) continue;
      seen.add(part);
      if (this.dom.navCrumbs.childNodes.length) {
        const sep = document.createElement('span');
        sep.className = 'nav-sep';
        sep.textContent = '›';
        sep.setAttribute('aria-hidden', 'true');
        this.dom.navCrumbs.append(sep);
      }
      const node = document.createElement('span');
      node.textContent = part;
      this.dom.navCrumbs.append(node);
    }
  }

  goToAddress(addr, { announce, history = true, label } = {}) {
    const region = this.store.get('currentRegion');
    if (region && addr >= region.vmAddr && addr < region.vmAddr + region.size) {
      if (!this.viewer.goToAddress(addr)) return false;
      if (announce) this.flash(addr);
      if (history) this.navigation.visit(this.navigationEntry(addr, label));
      return true;
    }
    const regions = this.store.get('regions') || [];
    const target = regions.find((r) => r.size > 0n && addr >= r.vmAddr && addr < r.vmAddr + r.size);
    if (target) {
      this.selectRegion(target, { silent: true });
      if (!this.viewer.goToAddress(addr)) return false;
      toast(t('toast.jumped', { name: target.name }));
      if (announce) this.flash(addr);
      if (history) this.navigation.visit(this.navigationEntry(addr, label));
      return true;
    }
    const info = this.store.get('fileInfo');
    if (info && region && region.id === 'raw') {
      alertDialog(t('err.outsideTitle'), t('err.outsideText', {
        addr: addrHex(addr), size: addrHex(info.size),
      }));
      return false;
    }
    alertDialog(t('err.unmappedTitle'), t('err.unmappedText', {
      addr: addrHex(addr), range: describeRange(regions),
    }));
    return false;
  }

  /** 関数の先頭へ移動して、そこを選んだ状態にする。 */
  goToFunction(addr) {
    const name = this.symbols && this.symbols.nameAt(addr);
    if (!this.goToAddress(addr, {
      announce: true,
      label: name ? prettyName(name) : pick('関数', 'Function'),
    })) return;
    const region = this.store.get('currentRegion');
    if (!region) return;
    const row = this.viewer.rowOfAddress(addr);
    if (row == null) return;
    this.viewer.select(row, false);
    this.store.set({ selectedRow: row });
    // 関数を開いた「そのとき」だけ意味解析を走らせる（描画とは別の流れ）
    this.analyzeFunctionAt(addr);
  }

  /** 名前から探して移動する（サンプルの案内などで使う）。 */
  goToSymbol(name) {
    const idx = this.symbols;
    for (let i = 0; i < idx.names.length; i++) {
      if (idx.names[i] === name) { this.goToFunction(idx.addrs[i]); return true; }
    }
    toast(pick('見つかりませんでした。', 'Not found.'));
    return false;
  }

  /** ファイル内の位置で移動する（構造ビューから）。 */
  goToFileOffset(offset) {
    const info = this.store.get('fileInfo');
    if (!info) return;
    this.selectRegion(info.raw, { silent: true });
    this.setMode('hex');
    this.goToAddress(offset, { announce: true, label: pick('ファイル内の位置', 'File offset') });
  }

  /** 文字列の場所へ移動する。文字列はコードではないので 16 進で見せる。 */
  goToStringAddress(region, addr) {
    if (region && (!this.store.get('currentRegion') || this.store.get('currentRegion').id !== region.id)) {
      this.selectRegion(region, { silent: true });
    }
    if (!region || !region.exec) this.setMode('hex');
    this.goToAddress(addr, { announce: true, label: pick('文字列', 'String') });
  }

  flash(addr) {
    const region = this.store.get('currentRegion');
    if (!region) return;
    const row = this.viewer.rowOfAddress(addr);
    if (row != null) this.viewer.mark(row);
  }
}

function describeRange(regions) {
  const live = regions.filter((r) => r.size > 0n);
  if (!live.length) return pick('なし', 'nothing');
  let lo = live[0].vmAddr, hi = live[0].vmAddr + live[0].size;
  for (const r of live) {
    if (r.vmAddr < lo) lo = r.vmAddr;
    if (r.vmAddr + r.size > hi) hi = r.vmAddr + r.size;
  }
  return addrHex(lo) + ' – ' + addrHex(hi);
}

/** エンジンやブラウザのエラーを、人が次にどうすればいいか分かる文にする。 */
function friendly(message) {
  const m = String(message || '');
  if (/capstone\.wasm|WebAssembly|wasm/i.test(m)) return t('err.engineWasm');
  if (/NotReadableError|permission/i.test(m)) return t('err.notReadable');
  if (/out of memory|allocation/i.test(m)) return t('err.memory');
  if (/TypeError|ReferenceError|SyntaxError|Cannot read|\bundefined\b|\bnull\b/i.test(m)) {
    console.error('[hex] internal error', m);
    return t('err.unknown');
  }
  return m || t('err.unknown');
}

/* ── 起動 ───────────────────────────────────────────────────── */

window.addEventListener('error', (e) => {
  if (e && e.message && /ResizeObserver/.test(e.message)) return;
});

const app = new App();
window.__app = app;   // Safari の Web インスペクタ用。UI からは使っていない。
