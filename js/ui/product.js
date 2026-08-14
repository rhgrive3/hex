import { ProductRouter } from './router.js';
import {
  ROUTES, PRIMARY_NAV, EXPLORER_SCOPES, FUNCTION_TABS, createActionRegistry,
} from './registry.js';
import {
  h, uiButton, screen, card, emptyState, loadingState, errorState, evidenceBadge,
  tabs, sectionTitle, listRow, VirtualList,
} from './primitives.js';
import { renderSecondaryRoute } from './secondary.js';
import { addrHex, parseAddress } from '../format.js';
import { pick } from '../i18n.js';
import { menu, copyText, toast } from '../ui.js';
import {
  showFileInfo, showSections, showStructure, showCandidates,
} from '../panels.js';
import {
  currentFunctionAddr, showTools, showRename, showComment, showDebugger,
} from '../tools.js';
import { compileGoal } from '../goalc.js';
import { decompile, decompiledText } from '../decompile.js';
import { cfgGraph, callGraph, renderGraph, graphLegend } from '../graphview.js';
import { classifyFunction, discoverSubsystems } from '../recognition/classifier.js';
import { traceAppFunction, runtimeEvidenceForApp } from '../runtime/app-runtime.js';

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

function architectureOf(app) {
  const info = app?.store?.get?.('fileInfo') || {};
  const value = app?.capabilities?.architecture || app?.backend?.capabilities?.architecture || info.architecture || info.arch || info.cpu || 'arm64';
  return String(value).toLowerCase();
}

function fixedArm64Rows(app) {
  return /arm64|aarch64/.test(architectureOf(app));
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

/*
 * Canonical Investigate no longer opens the legacy question sheet and then
 * searches its DOM for an input to fake an Enter key. The Goal Compiler is the
 * domain boundary; only the candidate presentation remains a compatibility Sheet.
 */
function runInvestigation(app, query) {
  return requireFile(app, () => {
    try {
      const compiled = compileGoal(String(query || '').trim());
      const goal = compiled?.goal;
      if (!goal) {
        const missing = Array.isArray(compiled?.missing) && compiled.missing.length ? ' ' + compiled.missing.join(' / ') : '';
        toast(text('質問を解析できませんでした。対象や動作をもう少し具体的に書いてください。', 'Could not compile that question. Describe the target or action more specifically.') + missing);
        return null;
      }
      return showCandidates(app, { ...goal, query: compiled });
    } catch (error) {
      toast(text('質問の解析に失敗しました。', 'Question compilation failed.') + ' ' + String(error?.message || error));
      return null;
    }
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
    runInvestigation(app, q);
  });
  hero.body.append(form);
  const suggestions = h('div', 'ui-goal-suggestions');
  for (const q of [
    text('経験値が増える場所', 'where experience increases'),
    text('HPを書き換える処理', 'where HP is written'),
    text('通信している場所', 'network communication'),
    text('ガチャの結果を決める処理', 'where gacha results are decided'),
  ]) suggestions.append(uiButton(q, { cls: 'ui-suggestion', onClick: () => { input.value = q; rememberQuery(q); runInvestigation(app, q); } }));
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
    for (const q of recent) list.append(listRow({ title: q, onClick: () => { input.value = q; runInvestigation(app, q); } }));
    s.body.append(list);
  }
  return { root: s.root, focus: () => input.focus() };
}

function lowerBoundBigInt(array, value) {
  let lo = 0, hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (array[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function functionSource(app) {
  const sym = app.symbols;
  const funcs = sym?.funcs || [];
  const region = app.codeRegion?.() || app.store.get('currentRegion');
  const lo = region?.vmAddr ?? 0n;
  const hi = region ? region.vmAddr + region.size : null;
  const start = funcs.length ? lowerBoundBigInt(funcs, lo) : 0;
  const end = hi == null ? funcs.length : lowerBoundBigInt(funcs, hi);
  return {
    length: Math.max(0, end - start),
    itemAt(index) {
      const absolute = start + index;
      const addr = funcs[absolute];
      const next = absolute + 1 < end ? funcs[absolute + 1] : hi;
      const exact = sym?.exact?.(addr);
      return {
        addr,
        name: exact?.name || functionName(app, addr),
        size: next != null && next > addr ? next - addr : null,
      };
    },
  };
}

function matchingFunctionItems(app, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return functionSource(app);
  const sym = app.symbols;
  if (!sym) return [];
  const region = app.codeRegion?.() || app.store.get('currentRegion');
  const lo = region?.vmAddr ?? 0n;
  const hi = region ? region.vmAddr + region.size : null;
  const out = [];
  const seen = new Set();
  const add = (addr, name) => {
    if (addr == null || addr < lo || (hi != null && addr >= hi) || !sym.isFunctionStart?.(addr)) return;
    const key = addr.toString();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ addr, name: name || functionName(app, addr) });
  };
  const names = Array.isArray(sym.names) ? sym.names : [];
  const addrs = sym.addrs || [];
  for (let i = 0; i < names.length && i < addrs.length; i++) {
    const name = String(names[i] || '');
    if (name.toLowerCase().includes(q)) add(addrs[i], name);
  }
  for (const [rawAddr, name] of sym.renames || []) {
    if (String(name || '').toLowerCase().includes(q)) {
      try { add(BigInt(rawAddr), name); } catch { /* ignore malformed rename */ }
    }
  }
  const sub = /^sub_?([0-9a-f]+)$/i.exec(q);
  if (sub) {
    try { add(BigInt('0x' + sub[1]), null); } catch { /* ignore */ }
  }
  out.sort((a, b) => a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0);
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
  if (!q) return rows || [];
  return (rows || []).filter((row) => String(row.text || '').toLowerCase().includes(q));
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
    if (!items || !Number(items.length)) { content.append(emptyState(text('見つかりません', 'Nothing found'), emptyText)); return; }
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
      const items = matchingFunctionItems(app, q);
      showRows(items, (item) => listRow({ title: item.name, subtitle: addressText(item.addr), meta: item.size != null ? String(item.size) + ' B' : '', onClick: () => router.navigate('/function/' + BigInt(item.addr).toString() + '/overview') }), text('関数名がまだ復元されていない可能性があります。', 'Function names may not be recovered yet.'));
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

function summaryText(res) {
  const value = res?.summary;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(Boolean).join(' ');
  if (value && typeof value === 'object') return value.text || value.summary || value.what || '';
  return '';
}

function recognitionInput(app, addr, res) {
  const owner = app.ownerOf?.(addr);
  const model = res?.model || {};
  const semantic = res?.semanticFacts || {};
  const fn = app.symbols?.functionAt?.(addr);
  const instructions = (model.instructions || []).map((item) => ({ mnemonic: item.mnemonic || item.mn || '', operands: item.operands || item.ops || '' }));
  const blocks = model.blocks || [];
  const edges = blocks.reduce((sum, block) => sum + (block.succ?.length || block.successors?.length || 0), 0);
  const writes = (semantic.stores || []).map((store) => store.location?.key || store.location?.text || store.lhsText).filter(Boolean);
  const calls = (semantic.calls || []).map((call) => call.name).filter(Boolean);
  const operations = [];
  for (const store of semantic.stores || []) {
    const op = store.readModifyWrite?.kind || store.expression?.op || store.expression?.name;
    if (op) operations.push(op);
  }
  return {
    address: addr,
    name: app.symbols?.nameAt?.(addr) || null,
    architecture: architectureOf(app),
    size: fn?.end != null && fn.end > fn.start ? Number(fn.end - fn.start) : 0,
    instructions,
    cfg: { blocks: blocks.length, edges, exits: blocks.filter((block) => !(block.succ?.length || block.successors?.length)).length, calls: calls.length },
    semantic: { writes, calls, operations, reads: [], thresholds: [] },
    calls,
    objcClass: owner?.className || null,
    objcSelector: owner?.sel || null,
  };
}

function evidenceStatus(item) {
  const verdict = String(item?.verdict || item?.status || '').toLowerCase();
  if (verdict === 'contradicted') return 'contradicted';
  if (verdict === 'confirmed' || item?.confirmed === true) return 'confirmed';
  const confidence = Number(item?.confidence);
  if (verdict === 'supported' || (Number.isFinite(confidence) && confidence >= 0.75)) return 'likely';
  return 'unverified';
}

function evidenceTitle(item, index) {
  return String(item?.reason || item?.kind || item?.type || item?.source || item?.family || text(`根拠 ${index + 1}`, `Evidence ${index + 1}`));
}

function evidenceSubtitle(item) {
  const bits = [];
  if (item?.address != null) bits.push(addressText(item.address));
  else if (item?.addr != null) bits.push(addressText(item.addr));
  if (item?.row != null) bits.push('row ' + item.row);
  if (item?.provenance?.group) bits.push(String(item.provenance.group));
  else if (item?.group) bits.push(String(item.group));
  if (item?.detail) bits.push(String(item.detail));
  return bits.join(' · ');
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
    if (!fixedArm64Rows(app)) return { supported: false, rowOfAddress: () => null, addrOfRow: () => null };
    return {
      supported: true,
      rowOfAddress: (a) => !region || a == null ? null : Number((a - region.vmAddr) / 4n),
      addrOfRow: (row) => region ? region.vmAddr + BigInt(row) * 4n : null,
    };
  };

  const renderOverview = (res) => {
    const owner = app.ownerOf?.(addr);
    const recognition = classifyFunction(recognitionInput(app, addr, res));
    const subsystems = discoverSubsystems(recognitionInput(app, addr, res));
    const grid = h('div', 'ui-card-grid');
    const summary = card(text('何をしている？', 'What does it do?'));
    const recovered = summaryText(res);
    summary.body.append(h('p', 'ui-lead', recovered || (owner && owner.className
      ? text(`${owner.className} の ${owner.sel || 'メソッド'} として認識されています。`, `Recognized as ${owner.sel || 'a method'} on ${owner.className}.`)
      : text('命令列と参照関係から、この関数の役割を確認できます。', 'Use the instructions and references below to determine this function’s role.'))));
    summary.body.append(evidenceBadge(owner ? 'confirmed' : recovered ? 'likely' : 'unverified'));
    grid.append(summary.root);

    const identity = card(text('コードの分類', 'Code identity'));
    identity.body.append(listRow({
      title: recognition.classification,
      subtitle: (recognition.evidence || []).join(' · ') || text('まだ十分な識別根拠がありません', 'Not enough identity evidence yet'),
      meta: 'score ' + Number(recognition.confidence || 0).toFixed(2),
      badge: evidenceBadge(recognition.classification === 'UNKNOWN' ? 'unverified' : 'likely'),
    }));
    for (const subsystem of subsystems.slice(0, 3)) identity.body.append(listRow({
      title: subsystem.subsystem,
      subtitle: (subsystem.evidence || []).join(' · '),
      meta: 'score ' + Number(subsystem.confidence || 0).toFixed(2),
      badge: evidenceBadge(subsystem.confidence >= 0.72 ? 'likely' : 'unverified'),
    }));
    grid.append(identity.root);

    const facts = card(text('基本情報', 'Basic facts'));
    facts.body.append(listRow({ title: text('命令数', 'Instructions'), meta: String(res.instructions || res.model?.instructions?.length || 0) }));
    facts.body.append(listRow({ title: text('ブロック数', 'Basic blocks'), meta: String(res.model?.blocks?.length || 0) }));
    facts.body.append(listRow({ title: text('アドレス', 'Address'), meta: addressText(addr), mono: true }));
    facts.body.append(listRow({ title: text('アーキテクチャ', 'Architecture'), meta: architectureOf(app) }));
    grid.append(facts.root);
    const next = card(text('次に見る', 'Next steps'));
    for (const item of [
      ['pseudocode', text('疑似Cで読む', 'Read pseudocode')],
      ['flow', text('分岐とループを見る', 'Inspect branches and loops')],
      ['evidence', text('なぜそう言えるか', 'Review evidence')],
      ['runtime', text('実行して確かめる', 'Verify at runtime')],
    ]) next.body.append(listRow({ title: item[1], onClick: () => router.navigate('/function/' + addr.toString() + '/' + item[0]) }));
    grid.append(next.root);
    content.replaceChildren(grid);
  };

  const renderPseudocode = (res) => {
    const map = rowMapper();
    if (!map.supported) {
      content.replaceChildren(emptyState(text('このアーキテクチャの疑似Cは未対応です', 'Pseudocode is unavailable for this architecture'), text('現在のSemantic DecompilerはARM64を対象にしています。未対応のCPUをARM64として表示することはしません。', 'The Semantic Decompiler currently targets ARM64; Hex will not reinterpret another CPU as ARM64.')));
      return;
    }
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
    if (!map.supported) {
      content.replaceChildren(emptyState(text('このアーキテクチャのCFG表示は未対応です', 'CFG view is unavailable for this architecture'), text('固定4バイト行を前提にせず、安全側で表示を止めています。', 'This view is disabled rather than assuming fixed four-byte instruction rows.')));
      return;
    }
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
    const stack = h('div', 'ui-evidence-stack');
    const name = app.symbols?.nameAt?.(addr);
    stack.append(listRow({ title: text('関数境界', 'Function boundary'), subtitle: addressText(addr), badge: evidenceBadge('confirmed') }));
    stack.append(listRow({ title: text('関数名', 'Function name'), subtitle: name || text('シンボル名なし', 'No symbol name'), badge: evidenceBadge(name ? 'confirmed' : 'unverified') }));

    const deterministic = Array.isArray(res.evidence) ? res.evidence : [];
    deterministic.slice(0, 80).forEach((item, index) => stack.append(listRow({
      title: evidenceTitle(item, index),
      subtitle: evidenceSubtitle(item),
      badge: evidenceBadge(evidenceStatus(item)),
    })));

    const runtime = runtimeEvidenceForApp(app, addr);
    runtime.slice(-20).forEach((item, index) => stack.append(listRow({
      title: text('実行時観測: ', 'Runtime observation: ') + evidenceTitle(item, index),
      subtitle: evidenceSubtitle(item),
      badge: evidenceBadge(evidenceStatus(item)),
    })));

    const proof = Array.isArray(res.rewriteProof) ? res.rewriteProof : [];
    proof.slice(0, 30).forEach((item) => stack.append(listRow({
      title: text('逆コンパイル変換: ', 'Decompiler rewrite: ') + String(item.rule || item.name || item.proof?.kind || 'rewrite'),
      subtitle: item.proof?.detail || item.detail || '',
      badge: evidenceBadge('confirmed'),
    })));

    const note = card(text('表示の意味', 'How to read this'), { subtitle: text('「確認済み」はバイナリまたは実行観測に直接結び付いた事実です。推論は「可能性が高い」「未確認」のまま分離します。ランキング点を確率として表示しません。', 'Confirmed is reserved for facts tied directly to binary/runtime evidence. Inference remains Likely or Unverified; ranking scores are not presented as probabilities.') });
    const nodes = [note.root, stack];
    if (Array.isArray(res.warnings) && res.warnings.length) {
      const warnings = card(text('未解決 / 注意', 'Unresolved / warnings'));
      for (const warning of res.warnings.slice(0, 20)) warnings.body.append(listRow({ title: String(warning), badge: evidenceBadge('unverified') }));
      nodes.push(warnings.root);
    }
    content.replaceChildren(...nodes);
  };

  const renderRuntime = (res) => {
    const root = h('div', 'ui-card-grid');
    const c = card(text('実行時に確かめる', 'Verify at runtime'), { subtitle: text('新しいRuntime Analysis Platformで、この関数だけを安全なローカルsandbox上で実行・観測します。', 'Run this function in the Runtime Analysis Platform local sandbox and record evidence.') });
    const resultHost = h('div', 'ui-runtime-result');
    const run = uiButton(text('ローカル実行で観測する', 'Run local observation'), { cls: 'ui-primary-action' });
    run.addEventListener('click', async () => {
      run.disabled = true;
      resultHost.replaceChildren(loadingState(text('実行して観測しています…', 'Running and collecting observations…')));
      try {
        const result = await traceAppFunction(app, addr, { maxSteps: 12000, timeoutMs: 1500, limit: 4096 });
        if (disposed) return;
        const obs = result.observation || {};
        const stop = obs.stop?.kind || 'unknown';
        const direct = stop === 'return' ? 'confirmed' : 'unverified';
        const list = h('div', 'ui-list');
        list.append(listRow({ title: text('停止理由', 'Stop reason'), meta: stop, badge: evidenceBadge(direct) }));
        list.append(listRow({ title: text('実行命令数', 'Executed instructions'), meta: String(obs.steps ?? '—') }));
        list.append(listRow({ title: text('戻り値', 'Return value'), meta: obs.returnValue != null ? addressText(obs.returnValue) : '—', mono: true }));
        list.append(listRow({ title: text('分岐観測', 'Observed branches'), meta: String(obs.branches?.length || 0) }));
        list.append(listRow({ title: text('メモリ書き込み', 'Memory writes'), meta: String(obs.stores?.length || obs.memoryDelta?.length || 0) }));
        list.append(listRow({ title: text('Runtime evidence', 'Runtime evidence'), meta: String(result.evidence?.length || 0), badge: evidenceBadge(result.evidence?.length ? 'confirmed' : 'unverified') }));
        resultHost.replaceChildren(list);
      } catch (error) {
        if (!disposed) resultHost.replaceChildren(errorState(text('ローカル実行を完了できませんでした', 'Local runtime observation could not complete'), String(error?.message || error)));
      } finally {
        if (!disposed) run.disabled = false;
      }
    });
    c.body.append(run, resultHost);
    root.append(c.root);

    const capability = card(text('Live Debugger', 'Live Debugger'), { subtitle: text('Safari単体ではiOSプロセスへ任意attachできません。LLDB/Frida互換のlive観測は外部Hex bridge接続時のみ有効です。', 'Safari cannot arbitrarily attach to an iOS process. LLDB/Frida-compatible live observation requires an external Hex bridge.') });
    capability.body.append(uiButton(text('高度なDebuggerを開く', 'Open advanced debugger'), { cls: 'ui-secondary-action', onClick: () => showDebugger(app, addr) }));
    root.append(capability.root);
    content.replaceChildren(root);
    void res;
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
    const renderFinding = (item) => {
      const title = item.title || item.label || item.goal?.text || item.goal || text('解析結果', 'Finding');
      const address = item.addr ?? item.address ?? item.functionAddr ?? item.function;
      return listRow({ title: String(title), subtitle: address != null ? addressText(address) : '', badge: evidenceBadge(item.confirmed ? 'confirmed' : item.confidence > 0.7 ? 'likely' : 'unverified'), onClick: address != null ? () => router.navigate('/function/' + BigInt(address).toString() + '/overview') : null });
    };
    if (findings.length > 80) s.body.append(new VirtualList({ items: findings, rowHeight: 64, ariaLabel: text('解析結果', 'Analysis results'), renderRow: renderFinding }).root);
    else {
      const list = h('div', 'ui-list');
      for (const item of findings) list.append(renderFinding(item));
      s.body.append(list);
    }
  } else {
    s.body.append(emptyState(text('まだ確定した結果がありません', 'No confirmed results yet'), text('「調べる」で目的を入力すると、答えと根拠をここから辿れるようになります。', 'Investigate a goal to create results you can revisit.'), uiButton(text('調べるへ', 'Go to Investigate'), { cls: 'ui-primary-action', onClick: () => router.navigate('/investigate') })));
  }
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
    if (/^(help|ヘルプ)$/.test(command)) { router.navigate('/help'); input.blur(); return; }
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
      else view = renderSecondaryRoute(app, router, route);
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