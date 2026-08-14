import { ProductRouter } from './router.js';
import {
  ROUTES, PRIMARY_NAV, EXPLORER_SCOPES, FUNCTION_TABS, createActionRegistry,
} from './registry.js';
import {
  h, uiButton, screen, card, emptyState, loadingState, errorState, evidenceBadge,
  tabs, sectionTitle, listRow, VirtualList,
} from './primitives.js';
import { addrHex, parseAddress } from '../format.js';
import { pick } from '../i18n.js';
import { menu, copyText, toast } from '../ui.js';
import {
  showSettings, showHelp, showLearn, showFileInfo, showSections, showStructure,
} from '../panels.js';
import {
  currentFunctionAddr, showTools, showRename, showComment, showDebugger,
} from '../tools.js';
import { decompile, decompiledText } from '../decompile.js';
import { cfgGraph, callGraph, renderGraph, graphLegend } from '../graphview.js';

const ja = () => (document.documentElement.lang || navigator.language || 'ja').toLowerCase().startsWith('ja');
const text = (j, e) => ja() ? j : e;

function addressText(value) {
  try { return addrHex(typeof value === 'bigint' ? value : BigInt(value)); } catch { return String(value || '—'); }
}

function functionName(app, addr) {
  if (addr == null) return text('関数', 'Function');
  const sym = app.symbols;
  const raw = sym && (sym.nameAt?.(addr) || sym.label?.(addr));
  return raw || ('sub_' + BigInt(addr).toString(16).toUpperCase());
}

function currentAddress(app) {
  const stored = app.store.get('currentAddress');
  if (stored != null) return stored;
  const region = app.store.get('currentRegion');
  if (!region) return null;
  return region.vmAddr;
}

function requireFile(app, action) {
  if (app.store.get('fileInfo')) return action();
  toast(text('先にファイルを開いてください。', 'Open a file first.'));
  return null;
}

function installViewportBridge() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const sync = () => {
    const height = viewport ? viewport.height : window.innerHeight;
    const offset = viewport ? viewport.offsetTop : 0;
    const keyboard = Math.max(0, window.innerHeight - height - offset);
    root.style.setProperty('--ui-visual-height', height + 'px');
    root.style.setProperty('--ui-keyboard-inset', keyboard + 'px');
    root.classList.toggle('ui-keyboard-open', keyboard > 120);
  };
  sync();
  window.addEventListener('resize', sync, { passive: true });
  window.addEventListener('orientationchange', sync, { passive: true });
  viewport?.addEventListener('resize', sync, { passive: true });
  viewport?.addEventListener('scroll', sync, { passive: true });
  const focus = (event) => {
    const target = event.target;
    if (!target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    setTimeout(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120);
  };
  document.addEventListener('focusin', focus);
  return () => {
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
    viewport?.removeEventListener('resize', sync);
    viewport?.removeEventListener('scroll', sync);
    document.removeEventListener('focusin', focus);
  };
}

function recentQueries() {
  try { return JSON.parse(sessionStorage.getItem('hex.ui.recentQueries') || '[]'); } catch { return []; }
}

function rememberQuery(query) {
  const q = String(query || '').trim();
  if (!q) return;
  const next = [q, ...recentQueries().filter((x) => x !== q)].slice(0, 6);
  try { sessionStorage.setItem('hex.ui.recentQueries', JSON.stringify(next)); } catch { /* private mode */ }
}

function triggerLegacyInvestigation(app, query) {
  requireFile(app, () => {
    app.openInvestigate();
    if (!query) return;
    requestAnimationFrame(() => {
      const input = document.querySelector('#overlays .sheet:not(.parked) input[type="search"]');
      if (!input) return;
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  });
}

function renderInvestigate(app, router) {
  const s = screen(text('何を知りたい？', 'What do you want to know?'), {
    id: 'investigate',
    subtitle: text('ツール名ではなく、知りたいことをそのまま入力してください。必要な探索方法はHexが選びます。',
      'Describe the answer you need. Hex chooses the search strategy.'),
  });
  const hero = card(null, { className: 'ui-investigate-hero' });
  const form = h('form', 'ui-goal-form');
  const input = h('input', 'ui-command-input');
  input.type = 'search';
  input.placeholder = text('例: 戦闘終了時に経験値が増える場所', 'e.g. where experience increases after a battle');
  input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
  const submit = uiButton(text('調べる', 'Investigate'), { cls: 'ui-primary-action' });
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    rememberQuery(q);
    triggerLegacyInvestigation(app, q);
  });
  hero.body.append(form);
  const suggestions = h('div', 'ui-goal-suggestions');
  for (const q of [
    text('経験値が増える場所', 'where experience increases'),
    text('HPを書き換える処理', 'where HP is written'),
    text('通信している場所', 'network communication'),
    text('ガチャの結果を決める処理', 'where gacha results are decided'),
  ]) suggestions.append(uiButton(q, { cls: 'ui-suggestion', onClick: () => { input.value = q; rememberQuery(q); triggerLegacyInvestigation(app, q); } }));
  hero.body.append(suggestions);
  s.body.append(hero.root);

  const overview = card(text('自動で分かったこと', 'Automatic overview'), {
    subtitle: text('ファイル全体の地図を作り、候補・根拠・未確認点をまとめます。',
      'Build a map of the binary and summarize candidates, evidence and unknowns.'),
  });
  overview.body.append(uiButton(text('概要を更新する', 'Refresh overview'), {
    cls: 'ui-secondary-action', onClick: () => requireFile(app, () => app.openOverview()),
  }));
  s.body.append(overview.root);

  const recent = recentQueries();
  if (recent.length) {
    s.body.append(sectionTitle(text('最近の調査', 'Recent investigations')));
    const list = h('div', 'ui-list');
    for (const q of recent) list.append(listRow({ title: q, onClick: () => { input.value = q; triggerLegacyInvestigation(app, q); } }));
    s.body.append(list);
  }
  return { root: s.root, focus: () => input.focus() };
}

function functionItems(app, query) {
  const q = String(query || '').trim().toLowerCase();
  const sym = app.symbols;
  if (!sym) return [];
  const out = [];
  const names = Array.isArray(sym.names) ? sym.names : [];
  const addrs = Array.isArray(sym.addrs) ? sym.addrs : [];
  const max = Math.min(names.length, addrs.length);
  for (let i = 0; i < max && out.length < 1000; i++) {
    const name = String(names[i] || '');
    if (q && !name.toLowerCase().includes(q) && !String(addrs[i]).includes(q)) continue;
    out.push({ addr: addrs[i], name: name || functionName(app, addrs[i]) });
  }
  if (!out.length && sym.functionList && app.codeRegion()) {
    const list = sym.functionList(app.codeRegion(), 600) || [];
    for (const item of list) {
      const name = item.name || functionName(app, item.addr);
      if (!q || name.toLowerCase().includes(q) || addressText(item.addr).toLowerCase().includes(q)) out.push({ addr: item.addr, name });
      if (out.length >= 600) break;
    }
  }
  return out;
}

function sectionItems(app, query) {
  const q = String(query || '').trim().toLowerCase();
  return (app.store.get('regions') || []).filter((r) => !q || String(r.name || r.section || '').toLowerCase().includes(q)).map((r) => ({
    name: r.section || r.name, addr: r.vmAddr, size: r.size, region: r,
  }));
}

async function stringItems(app, query) {
  const rows = await app.ensureStrings();
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  for (const row of rows || []) {
    if (q && !String(row.text || '').toLowerCase().includes(q)) continue;
    out.push(row);
    if (out.length >= 1000) break;
  }
  return out;
}

function externalItems(app, query) {
  const slice = app.currentSlice();
  const q = String(query || '').trim().toLowerCase();
  return ((slice && slice.info && slice.info.dylibs) || []).filter((name) => !q || name.toLowerCase().includes(q)).map((name) => ({ name }));
}

function renderExplorer(app, router, route) {
  const scope = EXPLORER_SCOPES.some((x) => x.id === route.params.scope) ? route.params.scope : 'functions';
  const s = screen(text('索引', 'Explorer'), {
    id: 'explorer',
    subtitle: text('関数・文字列・型・データ・外部API・セクションを一つの検索体験で見ます。',
      'Browse functions, strings, types, data, external APIs and sections with one search.'),
  });
  const controls = h('div', 'ui-explorer-controls');
  const scopes = h('div', 'ui-scope-tabs');
  scopes.setAttribute('role', 'tablist');
  for (const item of EXPLORER_SCOPES) {
    const b = uiButton(item.label, { cls: 'ui-scope' + (item.id === scope ? ' active' : ''), onClick: () => router.navigate('/explorer/' + item.id) });
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(item.id === scope));
    scopes.append(b);
  }
  const search = h('input', 'ui-search-field');
  search.type = 'search'; search.placeholder = text('名前・文字列・アドレスで検索', 'Search names, strings or addresses');
  search.value = route.query.get('q') || '';
  controls.append(scopes, search);
  s.body.append(controls);
  const content = h('div', 'ui-explorer-content');
  s.body.append(content);
  let disposed = false;
  let virtual = null;
  let timer = 0;

  const showRows = (items, renderRow, emptyText) => {
    virtual?.dispose(); virtual = null;
    content.replaceChildren();
    if (!items.length) { content.append(emptyState(text('見つかりません', 'Nothing found'), emptyText)); return; }
    virtual = new VirtualList({ items, rowHeight: 64, ariaLabel: text('索引の結果', 'Explorer results'), renderRow });
    content.append(virtual.root);
  };

  const update = async () => {
    if (disposed) return;
    const q = search.value.trim();
    const parsed = parseAddress(q);
    if (parsed != null && q) {
      showRows([{ addr: parsed }], (item) => listRow({ title: addressText(item.addr), subtitle: text('このアドレスへ移動', 'Jump to this address'), onClick: () => router.navigate('/code/' + item.addr.toString()) }), '');
      return;
    }
    if (scope === 'functions') {
      const items = functionItems(app, q);
      showRows(items, (item) => listRow({ title: item.name, subtitle: addressText(item.addr), onClick: () => router.navigate('/function/' + BigInt(item.addr).toString() + '/overview') }), text('関数名がまだ復元されていない可能性があります。', 'Function names may not be recovered yet.'));
      return;
    }
    if (scope === 'sections') {
      const items = sectionItems(app, q);
      showRows(items, (item) => listRow({ title: item.name, subtitle: addressText(item.addr), meta: String(item.size) + ' bytes', onClick: () => { app.selectRegion(item.region, { silent: true }); router.navigate('/code/' + BigInt(item.addr).toString()); } }), text('表示できるセクションがありません。', 'No sections are available.'));
      return;
    }
    if (scope === 'external') {
      const items = externalItems(app, q);
      showRows(items, (item) => listRow({ title: item.name }), text('外部ライブラリ情報がありません。', 'No external library information is available.'));
      return;
    }
    if (scope === 'strings') {
      content.replaceChildren(loadingState(text('文字列を集めています…', 'Collecting strings…')));
      try {
        const items = await stringItems(app, q);
        if (disposed) return;
        showRows(items, (item) => listRow({ title: item.text, subtitle: addressText(item.addr), onClick: () => { app.goToStringAddress(item.region, item.addr); router.navigate('/code/' + BigInt(item.addr).toString()); } }), text('文字列が見つかりません。', 'No strings were found.'));
      } catch (err) {
        if (!disposed) content.replaceChildren(errorState(text('文字列を表示できません', 'Could not show strings'), String(err && err.message || err)));
      }
      return;
    }
    if (scope === 'classes') {
      const c = card(text('型 / クラス', 'Types / Classes'), { subtitle: text('Objective-C / Swift / C++ の型情報を、同じ索引の一部として扱います。', 'Runtime and recovered types live in this explorer scope.') });
      const count = app.fields && app.fields.classCount ? app.fields.classCount : 0;
      c.body.append(h('p', 'ui-metric', text(`${count.toLocaleString()} クラスを認識`, `${count.toLocaleString()} classes recognized`)));
      c.body.append(uiButton(text('クラスと構造を見る', 'Open class/structure index'), { cls: 'ui-secondary-action', onClick: () => requireFile(app, () => showStructure(app)) }));
      content.replaceChildren(c.root);
      return;
    }
    const c = card(text('データ', 'Data'), { subtitle: text('グローバル・構造体・復元したデータ表をまとめます。', 'Globals, structures and recovered data tables are grouped here.') });
    c.body.append(uiButton(text('データ構造を開く', 'Open data structures'), { cls: 'ui-secondary-action', onClick: () => requireFile(app, () => showStructure(app)) }));
    content.replaceChildren(c.root);
  };

  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 120); });
  update();
  return {
    root: s.root,
    getState: () => ({ query: search.value, virtual: virtual?.getState() || null }),
    restoreState: (state) => { if (state?.query != null) search.value = state.query; setTimeout(() => virtual?.restoreState(state?.virtual), 0); },
    dispose: () => { disposed = true; clearTimeout(timer); virtual?.dispose(); },
  };
}

function codeViewState(app) {
  return {
    getState: () => ({
      topRow: app.viewer.topRow(), selectedRow: app.viewer.selectedRow,
      mode: app.store.get('displayMode'), regionId: app.store.get('currentRegion')?.id || null,
    }),
    restoreState: (state) => {
      if (!state) return;
      if (state.mode) app.setMode(state.mode);
      if (Number.isFinite(state.topRow)) app.viewer.goToRow(state.topRow, 'top');
      if (Number.isFinite(state.selectedRow) && state.selectedRow >= 0) app.viewer.select(state.selectedRow, false);
    },
  };
}

function renderFunctionWorkspace(app, router, route) {
  let addr;
  try { addr = BigInt(route.params.address); } catch { addr = currentFunctionAddr(app); }
  if (addr == null) {
    const s = screen(text('関数', 'Function'), { id: 'function' });
    s.body.append(emptyState(text('関数が選択されていません', 'No function selected'), text('コードまたは索引から関数を開いてください。', 'Open a function from Code or Explorer.')));
    return { root: s.root };
  }
  const tab = FUNCTION_TABS.some((x) => x.id === route.params.tab) ? route.params.tab : 'overview';
  const actions = h('div', 'ui-screen-actions');
  actions.append(uiButton('•••', { cls: 'ui-icon-action', ariaLabel: text('関数の操作', 'Function actions'), onClick: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu([
      { label: text('名前を付ける', 'Rename'), action: () => showRename(app, addr) },
      { label: text('メモを書く', 'Comment'), action: () => showComment(app, addr) },
      { label: text('アセンブリへ', 'Open assembly'), action: () => router.navigate('/code/' + addr.toString()) },
    ], r.left + r.width / 2, r.bottom + 4);
  } }));
  const s = screen(functionName(app, addr), { id: 'function', subtitle: addressText(addr), actions });
  const tabbar = tabs(FUNCTION_TABS, tab, (next) => router.navigate('/function/' + addr.toString() + '/' + next));
  s.body.append(tabbar);
  const content = h('div', 'ui-workspace-content');
  content.append(loadingState(text('関数を解析しています…', 'Analysing function…')));
  s.body.append(content);
  let disposed = false;

  const rowMapper = () => {
    const region = app.store.get('currentRegion');
    return {
      rowOfAddress: (a) => !region || a == null ? null : Number((a - region.vmAddr) / 4n),
      addrOfRow: (row) => region ? region.vmAddr + BigInt(row) * 4n : null,
    };
  };

  const renderOverview = (res) => {
    const owner = app.ownerOf?.(addr);
    const grid = h('div', 'ui-card-grid');
    const summary = card(text('何をしている？', 'What does it do?'));
    summary.body.append(h('p', 'ui-lead', owner && owner.className
      ? text(`${owner.className} の ${owner.sel || 'メソッド'} として認識されています。`, `Recognized as ${owner.sel || 'a method'} on ${owner.className}.`)
      : text('命令列と参照関係から、この関数の役割を確認できます。', 'Use the instructions and references below to determine this function’s role.')));
    summary.body.append(evidenceBadge(owner ? 'confirmed' : 'unverified'));
    grid.append(summary.root);
    const facts = card(text('基本情報', 'Basic facts'));
    facts.body.append(listRow({ title: text('命令数', 'Instructions'), meta: String(res.instructions || res.model?.instructions?.length || 0) }));
    facts.body.append(listRow({ title: text('ブロック数', 'Basic blocks'), meta: String(res.model?.blocks?.length || 0) }));
    facts.body.append(listRow({ title: text('アドレス', 'Address'), meta: addressText(addr), mono: true }));
    grid.append(facts.root);
    const next = card(text('次に見る', 'Next steps'));
    for (const item of [
      ['pseudocode', text('疑似Cで読む', 'Read pseudocode')],
      ['flow', text('分岐とループを見る', 'Inspect branches and loops')],
      ['evidence', text('なぜそう言えるか', 'Review evidence')],
    ]) next.body.append(listRow({ title: item[1], onClick: () => router.navigate('/function/' + addr.toString() + '/' + item[0]) }));
    grid.append(next.root);
    content.replaceChildren(grid);
  };

  const renderPseudocode = (res) => {
    const map = rowMapper();
    const out = decompile(res.model, {
      name: app.symbols?.nameAt?.(addr), addr,
      rowOfAddress: map.rowOfAddress, addrOfRow: map.addrOfRow,
      symbolFor: (a) => app.symbols?.nameAt?.(a) || null,
      notes: app.notes,
    });
    const toolbar = h('div', 'ui-code-toolbar');
    const code = h('pre', 'ui-pseudocode mono');
    code.tabIndex = 0;
    code.textContent = decompiledText(out);
    let wrap = false;
    toolbar.append(
      uiButton(text('コピー', 'Copy'), { cls: 'ui-secondary-action', onClick: () => copyText(code.textContent, text('疑似C', 'Pseudocode')) }),
      uiButton(text('折り返し', 'Wrap'), { cls: 'ui-secondary-action', onClick: (e) => { wrap = !wrap; code.classList.toggle('wrap', wrap); e.currentTarget.setAttribute('aria-pressed', String(wrap)); } }),
      uiButton(text('アセンブリへ', 'Assembly'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/code/' + addr.toString()) }),
    );
    content.replaceChildren(toolbar, code);
  };

  const renderFlow = (res) => {
    const map = rowMapper();
    const graph = cfgGraph(res.model, {
      rowOfAddress: map.rowOfAddress,
      text: (insn) => insn.mnemonic + ' ' + insn.operands,
      onNode: (_block, target) => router.navigate('/code/' + BigInt(target).toString()),
    });
    if (!graph.nodes.length) { content.replaceChildren(emptyState(text('フローを作れませんでした', 'No control flow available'), text('この関数には図にできるブロック情報がありません。', 'This function has no graphable block information.'))); return; }
    const mode = h('div', 'ui-graph-shell');
    const graphHost = h('div', 'ui-graph-host');
    graphHost.append(renderGraph(graph.nodes, graph.edges, {}));
    const list = h('details', 'ui-graph-text');
    list.append(h('summary', null, text('テキスト一覧でも見る', 'View as text list')));
    const rows = h('div', 'ui-list');
    graph.nodes.forEach((node, index) => rows.append(listRow({ title: String(node.label || node.title || node.id || `Block ${index + 1}`), subtitle: node.addr != null ? addressText(node.addr) : '' })));
    list.append(rows);
    mode.append(graphHost, graphLegend('cfg'), list);
    content.replaceChildren(mode);
  };

  const renderCalls = async () => {
    content.replaceChildren(loadingState(text('呼び出し関係を集めています…', 'Mapping calls…')));
    await app.ensureProgram();
    if (disposed) return;
    if (!app.program) { content.replaceChildren(emptyState(text('呼び出し関係がありません', 'No call graph available'), text('このバイナリでは呼び出し索引を作れませんでした。', 'A call index could not be built for this binary.'))); return; }
    const graph = callGraph(app.program, app.symbols, addr, {
      depth: 2, limit: 8, label: (a) => functionName(app, a),
      onNode: (a) => router.navigate('/function/' + BigInt(a).toString() + '/overview'),
    });
    const shell = h('div', 'ui-graph-shell');
    shell.append(renderGraph(graph.nodes, graph.edges, {}), graphLegend('call'));
    content.replaceChildren(shell);
  };

  const renderEvidence = (res) => {
    const facts = h('div', 'ui-evidence-stack');
    const name = app.symbols?.nameAt?.(addr);
    facts.append(listRow({ title: text('関数境界', 'Function boundary'), subtitle: addressText(addr), badge: evidenceBadge('confirmed') }));
    facts.append(listRow({ title: text('関数名', 'Function name'), subtitle: name || text('シンボル名なし', 'No symbol name'), badge: evidenceBadge(name ? 'confirmed' : 'unverified') }));
    facts.append(listRow({ title: text('制御フロー復元', 'Control-flow recovery'), subtitle: text(`${res.model?.blocks?.length || 0} ブロック`, `${res.model?.blocks?.length || 0} blocks`), badge: evidenceBadge((res.model?.blocks?.length || 0) > 0 ? 'likely' : 'unverified') }));
    const note = card(text('表示の意味', 'How to read this'), { subtitle: text('確認済み=バイナリに直接ある事実。可能性が高い=解析からの推論。ランキング点とは別物です。', 'Confirmed means directly observed in the binary; Likely is an inference. Neither is a ranking score.') });
    content.replaceChildren(note.root, facts);
  };

  const renderRuntime = () => {
    const c = card(text('実行時に確かめる', 'Verify at runtime'), { subtitle: text('静的解析だけで断定できない仮説を、実行結果で確認します。', 'Verify hypotheses that static analysis alone cannot prove.') });
    c.body.append(uiButton(text('Runtime / Debuggerを開く', 'Open Runtime / Debugger'), { cls: 'ui-primary-action', onClick: () => showDebugger(app, addr) }));
    content.replaceChildren(c.root);
  };

  (async () => {
    try {
      const res = await app.analyzeFunctionAt(addr);
      if (disposed) return;
      if (!res || !res.model) { content.replaceChildren(errorState(text('関数を解析できません', 'Could not analyse function'), text('このアドレスは現在のコード領域の関数として解析できませんでした。', 'This address could not be analysed as a function in the current code region.'))); return; }
      if (tab === 'overview') renderOverview(res);
      else if (tab === 'pseudocode') renderPseudocode(res);
      else if (tab === 'flow') renderFlow(res);
      else if (tab === 'calls') await renderCalls(res);
      else if (tab === 'evidence') renderEvidence(res);
      else renderRuntime(res);
    } catch (err) {
      if (!disposed) content.replaceChildren(errorState(text('表示できませんでした', 'Could not render this view'), String(err && err.message || err)));
    }
  })();

  return { root: s.root, getState: () => ({ scrollTop: s.body.scrollTop }), restoreState: (state) => { if (state) s.body.scrollTop = Number(state.scrollTop) || 0; }, dispose: () => { disposed = true; } };
}

function renderResults(app, router) {
  const s = screen(text('結果', 'Results'), { id: 'results', subtitle: text('確認した答え、根拠、履歴、ピンをここへ集めます。', 'Confirmed answers, evidence, history and pins live here.') });
  const report = app.autoReport && app.autoReport.report;
  const findings = report && (report.findings || report.results || report.goals);
  if (Array.isArray(findings) && findings.length) {
    const list = h('div', 'ui-list');
    for (const item of findings.slice(0, 100)) {
      const title = item.title || item.label || item.goal?.text || item.goal || text('解析結果', 'Finding');
      const address = item.addr ?? item.address ?? item.functionAddr ?? item.function;
      list.append(listRow({ title: String(title), subtitle: address != null ? addressText(address) : '', badge: evidenceBadge(item.confirmed ? 'confirmed' : item.confidence > 0.7 ? 'likely' : 'unverified'), onClick: address != null ? () => router.navigate('/function/' + BigInt(address).toString() + '/overview') : null }));
    }
    s.body.append(list);
  } else {
    s.body.append(emptyState(text('まだ確定した結果がありません', 'No confirmed results yet'), text('「調べる」で目的を入力すると、答えと根拠をここから辿れるようになります。', 'Investigate a goal to create results you can revisit.'), uiButton(text('調べるへ', 'Go to Investigate'), { cls: 'ui-primary-action', onClick: () => router.navigate('/investigate') })));
  }
  return { root: s.root };
}

function renderSecondary(app, router, kind) {
  const config = {
    settings: [text('設定', 'Settings'), text('表示・言語・解析表示を調整します。', 'Adjust appearance, language and analysis presentation.'), () => showSettings(app)],
    help: [text('ヘルプ', 'Help'), text('困ったときの入口です。', 'Help and troubleshooting.'), () => showHelp(app)],
    learn: [text('学ぶ', 'Learn'), text('ARM64や解析の読み方を段階的に学びます。', 'Learn how to read ARM64 and analysis results.'), () => showLearn(app)],
  }[kind];
  const s = screen(config[0], { id: kind, subtitle: config[1] });
  s.body.append(uiButton(text('開く', 'Open'), { cls: 'ui-primary-action', onClick: config[2] }));
  return { root: s.root };
}

function renderAdvanced(app) {
  const s = screen(text('高度な機能', 'Advanced / Lab'), { id: 'advanced', subtitle: text('通常の調査では不要な低レベル機能だけをまとめています。', 'Low-level tools that are not required for the normal question-to-answer flow.') });
  const list = h('div', 'ui-list');
  list.append(listRow({ title: text('ファイル情報', 'File information'), onClick: () => requireFile(app, () => showFileInfo(app)) }));
  list.append(listRow({ title: text('セクション詳細', 'Section details'), onClick: () => requireFile(app, () => showSections(app)) }));
  list.append(listRow({ title: text('構造 / 生データ', 'Structure / raw data'), onClick: () => requireFile(app, () => showStructure(app)) }));
  list.append(listRow({ title: text('解析ツール一覧', 'Analysis tools'), subtitle: text('パッチ・スクリプト・プラグイン等', 'Patching, scripting, plugins, etc.'), onClick: () => requireFile(app, () => showTools(app)) }));
  s.body.append(list);
  return { root: s.root };
}

function installCommandCenter(app, router, actions, host) {
  const form = h('form', 'ui-command-center');
  const input = h('input', 'ui-global-command');
  input.type = 'search';
  input.placeholder = text('検索、アドレス、コマンド…', 'Search, address, command…');
  input.setAttribute('aria-label', text('検索と移動', 'Search and navigate'));
  input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
  const go = uiButton(text('移動', 'Go'), { cls: 'ui-command-go' });
  form.append(input, go);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = input.value.trim(); if (!q) return;
    const addr = parseAddress(q);
    if (addr != null) { app.goToAddress(addr, { announce: true }); router.navigate('/code/' + addr.toString()); input.blur(); return; }
    const command = q.replace(/^>\s*/, '').toLowerCase();
    if (/^(settings|setting|設定)$/.test(command)) { router.navigate('/settings'); input.blur(); return; }
    if (/^(help|ヘルプ|help)$/.test(command)) { router.navigate('/help'); input.blur(); return; }
    if (/^(code|コード)$/.test(command)) { router.navigate('/code'); input.blur(); return; }
    router.navigate('/explorer/functions?q=' + encodeURIComponent(q)); input.blur();
  });
  host.append(form);
  actions.register('command.focus', () => input.focus());
  return input;
}

export function installProductUI(app) {
  if (!app || document.documentElement.classList.contains('product-ui-ready')) return null;
  const appRoot = document.getElementById('app');
  if (!appRoot) return null;
  const actions = createActionRegistry();
  const routeHost = h('main', 'ui-route-host');
  routeHost.id = 'ui-route-host'; routeHost.tabIndex = -1;
  const chrome = h('div', 'ui-product-chrome');
  const nav = h('nav', 'ui-bottom-nav');
  nav.setAttribute('aria-label', text('主要ナビゲーション', 'Primary navigation'));
  const titlebar = appRoot.querySelector('.titlebar');
  titlebar?.after(chrome);
  const addrbar = appRoot.querySelector('.addrbar');
  if (addrbar) appRoot.insertBefore(routeHost, addrbar); else appRoot.append(routeHost);
  appRoot.append(nav);

  const router = new ProductRouter(ROUTES, {
    defaultPath: '/investigate',
    onRoute: (route) => {
      appRoot.classList.toggle('ui-code-route', route.route.id === 'code');
      appRoot.classList.toggle('ui-screen-route', route.route.id !== 'code');
      for (const b of nav.querySelectorAll('[data-route-id]')) b.setAttribute('aria-current', b.dataset.routeId === route.route.id ? 'page' : 'false');
      if (route.route.id === 'code') {
        routeHost.hidden = true;
        const raw = route.params.address;
        if (raw) { try { app.goToAddress(BigInt(raw), { announce: false, history: false }); } catch { /* invalid deep link */ } }
        return codeViewState(app);
      }
      routeHost.hidden = false;
      routeHost.replaceChildren();
      let view;
      if (route.route.id === 'investigate') view = renderInvestigate(app, router);
      else if (route.route.id === 'explorer') view = renderExplorer(app, router, route);
      else if (route.route.id === 'function') view = renderFunctionWorkspace(app, router, route);
      else if (route.route.id === 'results' || route.route.id === 'finding') view = renderResults(app, router);
      else if (route.route.id === 'advanced') view = renderAdvanced(app);
      else view = renderSecondary(app, router, route.route.id);
      routeHost.append(view.root);
      requestAnimationFrame(() => routeHost.focus({ preventScroll: true }));
      const originalGet = view.getState;
      return {
        ...view,
        getState: () => ({ ...(originalGet ? originalGet() : {}), routeScroll: routeHost.scrollTop }),
        restoreState: (state) => { view.restoreState?.(state); routeHost.scrollTop = Number(state?.routeScroll) || 0; },
      };
    },
  });

  installCommandCenter(app, router, actions, chrome);
  const more = uiButton('•••', { cls: 'ui-more-button', ariaLabel: text('その他', 'More'), onClick: (event) => {
    const r = event.currentTarget.getBoundingClientRect();
    menu([
      { label: text('設定', 'Settings'), action: () => router.navigate('/settings') },
      { label: text('学ぶ', 'Learn'), action: () => router.navigate('/learn') },
      { label: text('ヘルプ', 'Help'), action: () => router.navigate('/help') },
      '-',
      { label: text('高度な機能', 'Advanced / Lab'), action: () => router.navigate('/advanced') },
    ], r.left + r.width / 2, r.bottom + 4);
  } });
  chrome.append(more);

  for (const item of PRIMARY_NAV) {
    const b = uiButton(item.icon + '\n' + item.label, { cls: 'ui-nav-item', onClick: () => router.navigate(item.route) });
    b.dataset.routeId = item.routeId;
    nav.append(b);
  }
  actions.register('navigate.investigate', () => router.navigate('/investigate'));
  actions.register('navigate.code', () => router.navigate('/code/' + (currentAddress(app)?.toString() || '')));
  actions.register('navigate.explorer', () => router.navigate('/explorer/functions'));
  actions.register('navigate.results', () => router.navigate('/results'));
  actions.register('function.open', (addr, tab = 'overview') => router.navigate('/function/' + BigInt(addr).toString() + '/' + tab));

  const cleanupViewport = installViewportBridge();
  const shortcut = (event) => {
    const target = event.target;
    const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); actions.run('command.focus'); return; }
    if (!typing && event.key === '/') { event.preventDefault(); actions.run('command.focus'); }
  };
  document.addEventListener('keydown', shortcut, true);

  document.documentElement.classList.add('product-ui-ready');
  router.start();
  const destroy = () => { router.stop(); cleanupViewport(); document.removeEventListener('keydown', shortcut, true); chrome.remove(); nav.remove(); routeHost.remove(); document.documentElement.classList.remove('product-ui-ready'); };
  window.addEventListener('pagehide', () => router.capture(), { passive: true });
  window.__hexUi = { router, actions, destroy, routes: ROUTES };
  return window.__hexUi;
}
