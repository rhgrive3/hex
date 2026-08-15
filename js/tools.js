/*
 * 解析ツール一式の画面。
 *
 * IDA や Ghidra にある道具を、初心者にも分かる言葉で並べたところです。
 * どれも「何のための道具か」を最初に 1 行で説明してから中身を出します。
 *
 *   逆コンパイル    … アセンブリを C 風に読み直す
 *   制御フロー図    … 分かれ道と合流を絵にする
 *   呼び出し図      … 誰が誰を呼ぶかを絵にする
 *   型と変数        … 引数・戻り値・ローカル変数の見当をつける
 *   構造体          … オブジェクトの中身の並びを組み立てる
 *   C++ クラス      … vtable と RTTI からクラスを取り出す
 *   名前とメモ      … 自分で名前を付けて覚えておく
 *   外とのつながり  … インポート・エクスポート・ライブラリ
 *   グローバル変数  … どこからでも触れる置き場
 *   パッチ          … 命令を書き換えて試す
 *   実行してみる    … 1 命令ずつ動かす（エミュレータ）
 *   スクリプト      … 同じ作業をまとめて自動化する
 *   プラグイン      … 自分で機能を足す
 *   Unity           … global-metadata.dat から C# の名前を戻す
 */

import {
  Sheet, el, button, list, groupRow, kvRow, tapRow, para, heading, noteBox,
  codeBlock, block, disclosure, toast, alertDialog, copyText, menu, userError,
} from './ui.js';
import { addrHex } from './format.js';
import { decompile, decompiledText } from './decompile.js';
import { decompilerSourceRows, formatDecompilerSource, fullDecompilerSourceText, hasSingleDecompilerInstruction, primaryDecompilerAddress } from './decompiler/provenance.js';
import { cfgGraph, callGraph, renderGraph, graphLegend } from './graphview.js';
import { inferTypes, recoverStruct, TypeStore, structToC, BASIC_TYPES, typeJa } from './types.js';
import { readableName, shortName, isMangled, findCxxClasses, readVtable } from './rtti.js';
import { importList, importsByFramework, exportList, findGlobals } from './linkage.js';
import { assemble, suggestPatches, parseHexBytes, hexOf, validatePatchRange } from './patch.js';
import { runScript, SAMPLES, makeEmulator } from './script.js';
import { EXAMPLE_PLUGIN, MAX_PLUGIN_SOURCE_BYTES } from './plugins.js';
import { parseMetadataAuto, looksLikeUnity, bindMethodAddresses, MAX_IL2CPP_METADATA_BYTES } from './il2cpp.js';
import { brief } from './arm64.js';

/* ── 小道具 ─────────────────────────────────────────────── */

function input(placeholder, value) {
  const n = el('input');
  n.type = 'text';
  n.autocapitalize = 'off';
  n.autocomplete = 'off';
  n.spellcheck = false;
  if (placeholder) n.placeholder = placeholder;
  if (value != null) n.value = value;
  return n;
}

function field(node, label, onGo) {
  const f = el('div', 'field');
  f.append(node);
  if (label) f.append(button(label, 'chip', onGo));
  return f;
}

function textArea(value, rows) {
  const n = el('textarea', 'code-input');
  n.rows = rows || 8;
  n.spellcheck = false;
  n.autocapitalize = 'off';
  if (value) n.value = value;
  return n;
}

/** いま見ている関数の先頭アドレス。分からなければ null。 */
export function currentFunctionAddr(app) {
  const sym = app.symbols;
  const row = app.viewer ? app.viewer.selectedRow : -1;
  const region = app.store.get('currentRegion');
  if (region && row >= 0) {
    const addr = app.viewer?.rowAddress ? app.viewer.rowAddress(row) : null;
    if (addr == null) return null;
    const fn = sym && sym.functionCount ? sym.functionAt(addr) : null;
    if (fn) return fn.start;
    return addr;
  }
  if (app.semantic && app.semantic.result) return app.semantic.result.startAddr;
  const list2 = sym && sym.functionCount ? sym.functionList(app.codeRegion(), 1) : [];
  return list2.length ? list2[0].addr : null;
}

function fnName(app, addr) {
  if (addr == null) return '—';
  const n = app.symbols ? (app.symbols.nameAt(addr) || app.symbols.label(addr)) : null;
  return n ? shortName(n) : 'sub_' + addr.toString(16).toUpperCase();
}

function needFunction(app) {
  const addr = currentFunctionAddr(app);
  if (addr == null) {
    toast('先に関数を選んでください（「関数」から選ぶか、命令をタップします）。');
    return null;
  }
  return addr;
}

/** 関数を解析して model を得る。 */
async function modelOf(app, addr) {
  const region = app.store.get('currentRegion');
  if (!region) return null;
  const code = app.codeRegion();
  if (code && region !== code && addr >= code.vmAddr && addr < code.vmAddr + code.size) {
    app.selectRegion(code, { silent: true });
  }
  await app.ensureFunctions(app.codeRegion());
  const res = await app.analyzeFunctionAt(addr);
  return res;
}

function rowMapper(app) {
  const region = app.store.get('currentRegion');
  return {
    rowOfAddress: (a) => (a == null || !region || !app.viewer?.rowOfAddress ? null : app.viewer.rowOfAddress(a)),
    addrOfRow: (row) => (region && app.viewer?.rowAddress ? app.viewer.rowAddress(row) : null),
  };
}


export function parseDebuggerArgument(value) {
  const raw = String(value ?? '');
  if (!raw || raw !== raw.trim() || !/^-?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(raw)) {
    return { ok: false, value: null, error: '10進整数か0x付き16進整数を入力してください。' };
  }
  try { return { ok: true, value: BigInt(raw), error: null }; }
  catch { return { ok: false, value: null, error: '整数として読み取れません。' }; }
}

/* ══════════════════════════════════════════════════════════
   入口: 道具箱
   ══════════════════════════════════════════════════════════ */

/*
 * 解析の入口は、ここ 1 つ。
 *
 * 以前は「自動解析」「解析ツール」「機能」がツールバーに別々に並んでいて、
 * どれが何をする物なのか、どれが当てにならない物なのかが分からなくなっていた。
 * ここでは
 *   1. まず何をすればいいか   （自動解析 → 目的から探す）
 *   2. いま見ている関数を調べる
 *   3. ファイル全体を調べる
 *   4. 書き換える・自動化する
 * の順に置き、1 行ごとに「事実 / 推定 / 参考」の札を付ける。
 * 札の意味は「この結果はどこまで信用できるか」に 1 枚でまとめてある。
 */

/* この道具は、バイナリを読んだだけか、そこから推し量ったものか。 */
const FACT = 'fact';
const INFER = 'infer';
const HINT = 'hint';

const LEVEL_WORD = { fact: '事実', infer: '推定', hint: '参考' };
const LEVEL_CLASS = { fact: 'tag-fact', infer: 'tag-infer', hint: 'tag-hint' };

export function showTools(app) {
  const sheet = new Sheet('解析');
  const addr = currentFunctionAddr(app);

  if (addr != null) {
    const b = block('いま見ている関数');
    b.append(el('div', 'bigval mono', fnName(app, addr)));
    b.append(el('div', 'hint', addrHex(addr)));
    sheet.body.append(b);
  }

  /** 1 行。level は「その結果をどこまで信じていいか」。 */
  const rowIn = (ul) => (level, label, sub, fn) => ul.append(tapRow(label, {
    sub,
    tag: LEVEL_WORD[level],
    tagClass: LEVEL_CLASS[level],
    right: '›',
    onTap: () => { sheet.close(); fn(); },
  }));

  /* ── 1. まず何をすればいいか ── */
  const first = list();
  first.append(groupRow('まず、ここから'));
  const item0 = rowIn(first);
  item0(INFER, '自動解析（ぜんぶ自動で調べる）',
    '開いてから終わるまで待つだけ。何が分かって、何が分からなかったかを最後にまとめて言います。',
    () => app.openOverview());
  item0(INFER, '目的から探す（HP・所持金・攻撃力…）',
    '探したいものを選ぶか、ふつうの言葉で書きます。名前・参照・命令の 3 方向から絞ります。',
    () => app.openInvestigate());
  item0(HINT, '使っている言葉から見る（機能一覧）',
    '文字列を機能ごとに分けたものです。ここに出るのは手がかりで、答えではありません。',
    () => app.openFeatures());
  sheet.body.append(first);

  /* ── 2. いま見ている関数 ── */
  const perFunction = list();
  perFunction.append(groupRow('いま見ている関数を調べる'));
  const item = rowIn(perFunction);
  const withFn = (fn) => () => { const a = needFunction(app); if (a != null) fn(a); };

  item(INFER, '逆コンパイル（C 風に読む）',
    'アセンブリを if / while / 代入の形に直します。いちばん読みやすい形です。訳なので、元のソースそのものではありません。',
    withFn((a) => showDecompiler(app, a)));
  item(FACT, '制御フロー図（分かれ道を絵にする）',
    '命令の並びをそのまま絵にしたものです。ループの位置がひと目で分かります。',
    withFn((a) => showCfg(app, a)));
  item(FACT, '呼び出し図（誰が誰を呼ぶか）',
    'この関数を呼ぶ側・この関数が呼ぶ相手を、上下に広げて描きます。',
    withFn((a) => showCallGraphPanel(app, a)));
  item(INFER, '引数・戻り値・変数の型',
    '使われ方からの推定です。「4 バイトで比較されている」以上のことは言えません。',
    withFn((a) => showTypes(app, a)));
  item(INFER, '構造体を組み立てる',
    '[x0, #0x20] のような使い方から、オブジェクトの中身の並びを起こします。触られていない場所は空きのままです。',
    withFn((a) => showStructRecover(app, a)));
  item(FACT, '実行してみる（1 命令ずつ・デバッガ）',
    '命令のとおりに動かして、レジスタとメモリの変化を見ます。実機は使いません。',
    withFn((a) => showDebugger(app, a)));
  item(FACT, '名前を付ける / メモを書く',
    '分かったことにその場で名前を付けます。次に見たときに思い出せます。',
    withFn((a) => showRename(app, a)));
  sheet.body.append(perFunction);

  /* ── 3. ファイル全体 ── */
  const whole = list();
  whole.append(groupRow('ファイル全体を調べる'));
  const item2 = rowIn(whole);
  item2(FACT, '外とのつながり（インポート / ライブラリ）',
    'リンカの表をそのまま読んだものです。借りている関数から、アプリの性格が見えます。',
    () => showLinkage(app));
  item2(FACT, 'グローバル変数',
    'どこからでも触れる置き場。所持金やログイン状態はここにあります。', () => showGlobals(app));
  item2(FACT, 'C++ のクラス（RTTI / vtable）',
    'バイナリに残っている型情報から、クラス名と仮想関数の並びを取り出します。', () => showCxxClasses(app));
  item2(FACT, 'Unity（IL2CPP）の名前を戻す',
    'global-metadata.dat を読み込むと、C# のクラス名とメソッド名が戻ります。', () => showIl2cpp(app));
  sheet.body.append(whole);

  /* ── 4. 書き換える・ためる・自動化する ── */
  const work = list();
  work.append(groupRow('書き換える・自動化する'));
  const item3 = rowIn(work);
  item3(FACT, 'パッチ（命令の書き換え）',
    '命令を書き換えて、結果を新しいファイルとして保存します。', () => showPatches(app));
  item3(FACT, '自分で付けた名前とメモ',
    '書き溜めたものの一覧・書き出し・読み込み。', () => showNotes(app));
  item3(FACT, '構造体（自分で作ったもの）',
    '作った型の一覧と、C のヘッダとしての書き出し。', () => showStructs(app));
  item3(FACT, 'スクリプト（自動化）',
    '同じ作業を何百回も繰り返すときに。IDAPython にあたるものです。', () => showScript(app));
  item3(FACT, 'プラグイン', '自分で書いた機能を足します。', () => showPlugins(app));
  sheet.body.append(work);

  /* ── 5. 札の意味 ── */
  const about = list();
  about.append(groupRow('札の意味'));
  about.append(tapRow('この結果はどこまで信用できるか', {
    sub: '「事実」「推定」「参考」の違いと、機能ごとに測った精度。',
    right: '›',
    onTap: () => { sheet.close(); app.openAccuracyNotes(); },
  }));
  sheet.body.append(about);
}

/* ══════════════════════════════════════════════════════════
   逆コンパイル

   アセンブリを C 風に読み直した結果を出す面。

   ここは「読む」ための面なので、画面の広さを全部使う。
   以前は狭いシートの中に、1 命令 1 行の訳と、行ごとに同じ注釈が
   並んでいて、200 行の関数が 600 行になっていた。
   ══════════════════════════════════════════════════════════ */

export async function showDecompiler(app, addr) {
  const sheet = new Sheet('逆コンパイル', { size: 'full' });
  const status = el('div', 'hint', '解析しています…');
  sheet.body.append(status);

  const res = await modelOf(app, addr);
  if (!res || !res.model) {
    status.textContent = 'この場所は関数として解析できませんでした。';
    return;
  }
  const map = rowMapper(app);
  let showAsm = false;
  let showNotes = false;
  try { await app.ensureObjc?.(); } catch { /* ObjC metadata is optional */ }

  const out = decompile(res.model, {
    name: app.symbols.nameAt(addr),
    addr,
    rowOfAddress: map.rowOfAddress,
    addrOfRow: map.addrOfRow,
    symbolFor: (a) => {
      const n = app.symbols.nameAt(a);
      return n ? n : null;
    },
    fieldFor: (baseReg, offset) => fieldNameFor(app, addr, baseReg, offset),
    objcModel: app.objcModel || null,
    objcRuntimeIndex: app.objcRuntime || null,
    notes: app.notes,
  });

  status.remove();
  sheet.body.classList.add('nogrow');

  /* 見出し。関数の名前と形は、下までスクロールしても見えるように貼り付ける。 */
  const head = el('div', 'code-head');
  head.append(el('div', 'code-sig mono', out.signature));
  const meta = el('div', 'code-meta');
  meta.append(el('span', null, addrHex(addr)));
  meta.append(el('span', null, res.instructions + ' 命令 → ' +
    out.lines.filter((l) => l.kind === 'stmt' || l.kind === 'ctrl').length + ' 行'));
  if (out.ctx && out.ctx.carry) {
    meta.append(el('span', 'code-carry',
      'result ＝ ' + out.ctx.carry.reg + '（' + out.ctx.carry.steps + ' 段で組み立てている値）'));
  }
  head.append(meta);

  /* 表示の切り替え。押せる状態が見て分かるように、入れたものは色を付ける。 */
  const chips = el('div', 'chips code-chips');
  const asmChip = button('アセンブリを併記', 'chip', () => {
    showAsm = !showAsm;
    asmChip.classList.toggle('on', showAsm);
    render();
  });
  const noteChip = button('日本語の注釈', 'chip', () => {
    showNotes = !showNotes;
    noteChip.classList.toggle('on', showNotes);
    render();
  });
  chips.append(asmChip, noteChip);
  chips.append(button('コピー', 'chip', () => copyText(decompiledText(out), '逆コンパイル結果')));
  chips.append(button('図で見る', 'chip', () => { sheet.close(); showCfg(app, addr); }));
  head.append(chips);
  sheet.body.append(head);
  sheet.body.append(para(
    'これは命令から組み立てた読みやすい訳であり、元のソースコードではありません。',
    'sub'));

  for (const w of out.warnings) sheet.body.append(el('div', 'hint warn', '⚠ ' + w));

  const codeWrap = el('div', 'codeview code-full');
  sheet.body.append(codeWrap);

  const byRow = new Map();
  for (const i of res.model.instructions) byRow.set(i.row, i);

  function render() {
    codeWrap.replaceChildren();
    for (const l of out.lines) {
      if (l.kind === 'blank') { codeWrap.append(el('div', 'cl blank', ' ')); continue; }
      const sourceRows = decompilerSourceRows(l);
      const sourceInsns = sourceRows.map((r) => byRow.get(r)).filter(Boolean);
      const primary = primaryDecompilerAddress(l);
      const row = el('div', 'cl ' + l.kind);
      const gutter = el('span', 'cl-addr mono', formatDecompilerSource(l, { maxGroups: 1 }));
      const text = el('span', 'cl-text mono');
      paintCode(text, '    '.repeat(Math.max(0, l.indent)) + l.text);
      row.append(gutter, text);
      if (primary != null) {
        row.classList.add('tappable');
        row.title = fullDecompilerSourceText(l);
        row.addEventListener('click', () => lineMenu(app, sheet, l, sourceInsns));
      }
      codeWrap.append(row);
      if (showNotes && l.note) {
        const n = el('div', 'cl note');
        n.append(el('span', 'cl-addr'), el('span', 'cl-text', '// ' + l.note));
        codeWrap.append(n);
      }
      if (showAsm) {
        for (const insn of sourceInsns) {
          const a = el('div', 'cl asm');
          const asmAddr = insn.address != null ? insn.address.toString(16).toUpperCase().slice(-6).padStart(6, '0') : '';
          a.append(el('span', 'cl-addr mono', asmAddr), el('span', 'cl-text mono', '; ' + insn.mnemonic + ' ' + insn.operands));
          codeWrap.append(a);
        }
      }
    }
  }
  render();
}

/*
 * 1 行に色を付ける。
 *
 * 全部が同じ黒で並んでいると、どこが呼び出しでどこが数か、
 * 目で追うところから始めることになる。C を読むときと同じ色分けにする。
 * innerHTML は使わない（名前に < > が入ることがあるため）。
 */
const CODE_TOKENS = new RegExp([
  '("(?:[^"\\\\]|\\\\.)*")',                                  // 文字列
  '\\b(if|else|while|for|do|return|goto|switch|case|break|continue)\\b',
  '\\b(int8|int16|int32|int64|uint8|uint16|uint32|uint64|void|double|float|char|bool|result)\\b',
  '(\\b0x[0-9A-Fa-f]+\\b|\\b\\d+\\b)',                            // 数
  '([A-Za-z_][\\w:.$]*)(?=\\s*\\()',                                // 呼び出し
  '(//.*$|/\\*.*?\\*/)',                                          // 注釈
].join('|'), 'g');

function paintCode(node, text) {
  node.replaceChildren();
  let last = 0;
  text.replace(CODE_TOKENS, (m, str, kw, type, num, call, cmt, at) => {
    if (at > last) node.append(document.createTextNode(text.slice(last, at)));
    const cls = str ? 'c-str' : kw ? 'c-kw' : type ? 'c-type'
      : num ? 'c-num' : call ? 'c-call' : 'c-cmt';
    node.append(el('span', cls, m));
    last = at + m.length;
    return m;
  });
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
}

/** その行に対してできること。 */
function lineMenu(app, sheet, line, sourceInsns = []) {
  const primary = primaryDecompilerAddress(line);
  if (primary == null) return;
  const items = [
    { label: '対応する先頭命令へ移動', action: () => { sheet.close(); app.goToAddress(primary, { announce: true }); } },
    { label: '対応する命令アドレスをコピー', action: () => copyText(fullDecompilerSourceText(line), '命令アドレス') },
  ];
  const callInsn = sourceInsns.find((x) => x?.isCall || x?.callTarget != null) || null;
  const callTarget = callInsn?.callTarget ?? null;
  const raw = callTarget != null && app.symbols ? app.symbols.nameAt(callTarget) : null;
  if (raw && isMangled(raw)) {
    items.push({ label: 'この名前の元の形を見る', action: () => showRealName(raw) });
  }
  if (hasSingleDecompilerInstruction(line) && sourceInsns.length === 1) {
    items.push({ label: 'この命令を書き換える（パッチ）', action: () => showPatchEditor(app, primary, sourceInsns[0]) });
    items.push({ label: 'メモを書く', action: () => showComment(app, primary) });
  } else if (sourceInsns.length) {
    items.push({ label: '先頭命令にメモを書く', action: () => showComment(app, primary) });
  }
  if (callTarget != null) {
    items.push({
      label: '呼んでいる相手を調べる',
      action: () => { sheet.close(); app.openFunctionReport(callTarget); },
    });
  }
  menu(items, window.innerWidth / 2, window.innerHeight / 2);
}

/**
 * 名前の「元の形」を見せる。
 *
 * 行に出しているのは短くした形なので、テンプレート引数や引数の型まで
 * 確かめたいときのために、3 つの段階をぜんぶ並べる。
 */
function showRealName(raw) {
  const sheet = new Sheet('この名前について');
  const ul = list();
  ul.append(groupRow('3 つの段階'));
  ul.append(kvRow('行に出している形', shortName(raw)));
  ul.append(kvRow('読める形に戻したもの', readableName(raw)));
  sheet.body.append(ul);
  sheet.body.append(el('div', 'sec-title', 'リンカが残した、そのままの名前'));
  sheet.body.append(codeBlock(raw));
  const chips = el('div', 'chips');
  chips.append(button('コピー', 'chip', () => copyText(raw, '名前')));
  sheet.body.append(chips);
  sheet.body.append(el('div', 'hint',
    'C++ は、同じ名前の関数を引数の型で見分けます。そのため引数の型まで名前に' +
    '埋め込まれていて（マングリング）、そのままでは記号の列に見えます。'));
}

/** [x0, #0x20] に名前が付けられるか（Objective-C のクラス表から）。 */
function fieldNameFor(app, funcAddr, baseReg, offset) {
  if (!app.fields || !app.fields.classCount) return null;
  const owner = app.ownerOf(funcAddr);
  if (!owner) return null;
  const f = app.fields.fieldAt(owner.className || owner.name || owner, offset);
  return f ? { name: f.name, type: f.type } : null;
}

/* ══════════════════════════════════════════════════════════
   図（CFG / コールグラフ）
   ══════════════════════════════════════════════════════════ */

export async function showCfg(app, addr) {
  /* 図は画面いっぱいで見せる。小さい窓に押し込むと、結局そのたびに広げることになる。 */
  const sheet = new Sheet('制御フロー図', { size: 'full' });
  const status = el('div', 'hint', '解析しています…');
  sheet.body.append(status);
  const res = await modelOf(app, addr);
  if (!res || !res.model) { status.textContent = 'この場所は関数として解析できませんでした。'; return; }
  status.remove();
  sheet.setTitle('制御フロー図 — ' + fnName(app, addr));

  const map = rowMapper(app);
  const { nodes, edges } = cfgGraph(res.model, {
    rowOfAddress: map.rowOfAddress,
    text: (insn) => insn.mnemonic + ' ' + insn.operands,
    onNode: (b, a) => { sheet.close(); app.goToAddress(a, { announce: true }); },
  });
  if (!nodes.length) { sheet.body.append(el('div', 'hint', '図にできる情報がありませんでした。')); return; }

  const head = el('div', 'graph-head');
  head.append(el('span', null,
    nodes.length + ' 個のかたまり · ' + edges.length + ' 本の道 · 箱を押すとその場所へ移動します'));
  head.append(button('この図の読み方', 'chip', () => showGraphHelp('cfg')));
  sheet.body.classList.add('nogrow');
  sheet.body.append(head, renderGraph(nodes, edges, {}), graphLegend('cfg'));
}

export async function showCallGraphPanel(app, addr) {
  const sheet = new Sheet('呼び出し図', { size: 'full' });
  const status = el('div', 'hint', '呼び出し関係を集めています…');
  sheet.body.append(status);
  await app.ensureProgram();
  if (!app.program) { status.textContent = '呼び出し関係を作れませんでした。'; return; }
  status.remove();
  sheet.setTitle('呼び出し図 — ' + fnName(app, addr));

  let depth = 1;
  const head = el('div', 'graph-head');
  const count = el('span', null, '');
  head.append(count);
  const chips = el('div', 'chips inline');
  for (const d of [1, 2, 3]) {
    chips.append(button(d + ' 段', 'chip' + (d === depth ? ' on' : ''), (e) => {
      depth = d;
      for (const c of chips.children) c.classList.remove('on');
      e.currentTarget.classList.add('on');
      draw();
    }));
  }
  head.append(chips, button('この図の読み方', 'chip', () => showGraphHelp('call')));

  const wrap = el('div', 'graph-host');
  sheet.body.classList.add('nogrow');
  sheet.body.append(head, wrap, graphLegend('call'));

  function draw() {
    const { nodes, edges } = callGraph(app.program, app.symbols, addr, {
      depth, limit: depth >= 3 ? 4 : 8,
      label: (a) => fnName(app, a),
      onNode: (a) => { sheet.close(); app.openFunctionReport(a); },
    });
    count.textContent = '上が呼ぶ側・下が呼ばれる側 · ' + nodes.length + ' 個の関数 · ' +
      '箱を押すとその関数を開きます';
    wrap.replaceChildren(renderGraph(nodes, edges, {}));
  }
  draw();
}

/** 図の読み方。凡例だけでは足りない人のために、言葉でも置いておく。 */
function showGraphHelp(kind) {
  const sheet = new Sheet('この図の読み方');
  const ul = list();
  if (kind === 'call') {
    ul.append(groupRow('呼び出し図'));
    ul.append(kvRow('まん中の太枠', 'いま見ている関数'));
    ul.append(kvRow('上の箱', 'この関数を呼んでいる側'));
    ul.append(kvRow('下の破線の箱', 'この関数が呼んでいる相手'));
    ul.append(kvRow('段', '何段まで辿るか。増やすほど広く、遅くなります'));
  } else {
    ul.append(groupRow('制御フロー図'));
    ul.append(kvRow('四角', 'ひとかたまりの命令（basic block）。上から下へ順に実行されます'));
    ul.append(kvRow('緑の線', '条件が成り立ったときに進む道'));
    ul.append(kvRow('赤の線', '成り立たなかったときに進む道'));
    ul.append(kvRow('破線で戻る', 'ループ。同じところを繰り返します'));
    ul.append(kvRow('太枠', '入口。ここから始まります'));
  }
  sheet.body.append(ul);
  const ops = list();
  ops.append(groupRow('動かし方'));
  ops.append(kvRow('押したまま動かす', '図をつかんで動かします'));
  ops.append(kvRow('2 本指でつまむ', '拡大・縮小します'));
  ops.append(kvRow('全体', '全部が入る大きさに戻します'));
  ops.append(kvRow('箱を押す', 'その場所・その関数へ移動します'));
  sheet.body.append(ops);
}

/* ══════════════════════════════════════════════════════════
   型・変数
   ══════════════════════════════════════════════════════════ */

export async function showTypes(app, addr) {
  const sheet = new Sheet('引数・戻り値・変数');
  const status = el('div', 'hint', '解析しています…');
  sheet.body.append(status);
  const res = await modelOf(app, addr);
  if (!res || !res.model) { status.textContent = 'この場所は関数として解析できませんでした。'; return; }
  status.remove();

  const types = inferTypes(res.model);
  sheet.body.append(el('div', 'hint',
    fnName(app, addr) + '\n' +
    '型は「そのバイトを何として扱っているか」です。バイナリには書かれていないので、\n' +
    '命令の使い方（何バイト読んだか・何に渡したか）から推測しています。'));

  const render = () => {
    body.replaceChildren();

    const args = list();
    args.append(groupRow('受け取っているもの（引数）'));
    if (!types.args.length) args.append(tapRow('引数はなさそうです', { disabled: true, sub: 'x0〜x7 を、自分で値を入れる前に読んでいません。' }));
    for (const a of types.args) {
      const custom = app.notes.typeOf(addr, 'a' + a.index);
      args.append(tapRow((custom || a.type) + '  a' + (a.index + 1), {
        sub: 'レジスタ ' + a.reg + '  ·  ' + typeJa(custom || a.type) +
          (a.why.length ? '\n根拠: ' + a.why.map((w) => w.why).join(' / ') : '') +
          (custom ? '\n（自分で決めた型）' : ''),
        right: confidenceMark(a.conf),
        onTap: () => pickType(app, addr, 'a' + a.index, custom || a.type, render),
      }));
    }
    body.append(args);

    const ret = list();
    ret.append(groupRow('返しているもの（戻り値）'));
    const rt = app.notes.typeOf(addr, 'ret') || types.ret.type;
    ret.append(tapRow(rt, {
      sub: typeJa(rt) + (types.ret.why.length ? '\n根拠: ' + types.ret.why.map((w) => w.why).join(' / ') : ''),
      right: confidenceMark(types.ret.conf),
      onTap: () => pickType(app, addr, 'ret', rt, render),
    }));
    body.append(ret);

    const locals = list();
    locals.append(groupRow('スタックに置いているもの（ローカル変数）'));
    if (!types.locals.length) locals.append(tapRow('スタックは使っていません', { disabled: true }));
    for (const l of types.locals.slice(0, 60)) {
      const custom = app.notes.typeOf(addr, l.slot);
      locals.append(tapRow((custom || l.type) + '  var_' + Math.abs(l.offset).toString(16).toUpperCase(), {
        sub: l.slot + '  ·  ' + typeJa(custom || l.type) +
          (l.why.length ? '\n' + l.why.map((w) => w.why).join(' / ') : ''),
        right: confidenceMark(l.conf),
        onTap: () => pickType(app, addr, l.slot, custom || l.type, render),
      }));
    }
    body.append(locals);

    body.append(noteBox('★ の数は「どれくらい確からしいか」です。タップすると自分で型を決められます。'));
  };

  const body = el('div');
  sheet.body.append(body);
  render();
}

function confidenceMark(conf) {
  const n = conf >= 0.85 ? 3 : conf >= 0.6 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function pickType(app, funcAddr, key, current, onDone) {
  const items = BASIC_TYPES.map((t) => ({
    label: t.name + ' — ' + t.ja,
    action: () => {
      if (!app.notes.setType(funcAddr, key, t.name)) { notePersistenceFailure(app, '型'); onDone(); return; }
      toast('型を ' + t.name + ' にしました'); onDone();
    },
  }));
  items.push('-');
  items.push({ label: '推測にもどす', action: () => {
    if (!app.notes.setType(funcAddr, key, '')) notePersistenceFailure(app, '型');
    onDone();
  } });
  void current;
  menu(items, window.innerWidth / 2, 120);
}

/* ══════════════════════════════════════════════════════════
   構造体
   ══════════════════════════════════════════════════════════ */

export async function showStructRecover(app, addr) {
  const sheet = new Sheet('構造体を組み立てる');
  const status = el('div', 'hint', '解析しています…');
  sheet.body.append(status);
  const res = await modelOf(app, addr);
  if (!res || !res.model) { status.textContent = '解析できませんでした。'; return; }
  status.remove();

  sheet.body.append(el('div', 'hint',
    'ひとつのレジスタが [x19, #0x10] / [x19, #0x18] のように使われていたら、\n' +
    'x19 は「0x10 と 0x18 に何かが入っている箱」を指しています。\n' +
    'その並びをまとめたものが構造体（struct）です。'));

  const rec = recoverStruct(res.model, null);
  if (!rec) {
    sheet.body.append(noteBox('この関数では、まとまった箱の使い方が見つかりませんでした。'));
    return;
  }

  const head = block(rec.base + ' が指している箱');
  head.append(el('div', 'hint', '全体で ' + rec.size + ' バイト、' + rec.members.length + ' か所を使っています。'));
  sheet.body.append(head);

  const members = list();
  for (const m of rec.members) {
    members.append(tapRow('+0x' + m.offset.toString(16).toUpperCase() + '  ' + m.type + ' ' + m.name, {
      sub: m.size + ' バイト  ·  読み ' + m.reads + ' 回 / 書き ' + m.writes + ' 回',
      onTap: () => toast(typeJa(m.type)),
    }));
  }
  sheet.body.append(members);

  sheet.body.append(codeBlock(structToC(rec)));

  const actions = el('div', 'chips');
  actions.append(button('この形を保存する', 'chip', () => {
    const store = new TypeStore(app.notes);
    const name = 'struct_' + addr.toString(16).toUpperCase();
    try {
      store.adopt(rec, name);
      toast(name + ' として保存しました');
    } catch (error) {
      if (error?.name !== 'PersistenceError') throw error;
      notePersistenceFailure(app, '構造体');
    }
  }));
  actions.append(button('C としてコピー', 'chip', () => copyText(structToC(rec), '構造体')));
  sheet.body.append(actions);
}

export function showStructs(app) {
  const sheet = new Sheet('構造体');
  const store = new TypeStore(app.notes);
  sheet.body.append(el('div', 'hint',
    '自分で作った型の一覧です。関数の画面から「構造体を組み立てる」で作れます。'));

  const render = () => {
    body.replaceChildren();
    const l = list();
    if (!store.list().length) l.append(tapRow('まだ 1 つもありません', { disabled: true }));
    for (const s of store.list()) {
      l.append(tapRow(s.name, {
        sub: s.members.length + ' 項目  ·  ' + s.size + ' バイト',
        onTap: () => showStructDetail(app, store, s, render),
      }));
    }
    body.append(l);
  };
  const body = el('div');
  sheet.body.append(body);
  render();
}

function showStructDetail(app, store, s, onChange) {
  const sheet = new Sheet(s.name);
  sheet.body.append(codeBlock(store.toC(s.name)));
  const l = list();
  for (const m of s.members) {
    l.append(tapRow('+0x' + m.offset.toString(16).toUpperCase() + '  ' + m.type + ' ' + m.name, {
      sub: (m.size || 8) + ' バイト',
      onTap: () => {
        const nameIn = input('項目の名前', m.name);
        const d = el('div');
        d.append(para('この項目に名前を付けます。'), field(nameIn, '決定', () => {
          try {
            store.setMember(s.name, m.offset, { name: nameIn.value.trim() || m.name });
          } catch (error) {
            if (error?.name !== 'PersistenceError') throw error;
            onChange(); notePersistenceFailure(app, '構造体'); return;
          }
          sheet.close();
          onChange();
          toast('名前を付けました');
        }));
        const sh = new Sheet('項目の名前');
        sh.body.append(d);
      },
    }));
  }
  sheet.body.append(l);
  const chips = el('div', 'chips');
  chips.append(button('C としてコピー', 'chip', () => copyText(store.toC(s.name), '構造体')));
  chips.append(button('削除', 'chip danger', () => {
    try { store.remove(s.name); }
    catch (error) {
      if (error?.name !== 'PersistenceError') throw error;
      onChange(); notePersistenceFailure(app, '構造体の削除'); return;
    }
    sheet.close();
    onChange();
    toast('削除しました');
  }));
  sheet.body.append(chips);
}

/* ══════════════════════════════════════════════════════════
   C++ のクラス（RTTI / vtable）
   ══════════════════════════════════════════════════════════ */

export function showCxxClasses(app) {
  const sheet = new Sheet('C++ のクラス');
  sheet.body.append(el('div', 'hint',
    'C++ は、クラスごとに「仮想関数の一覧表（vtable）」と「型の名札（RTTI）」を\n' +
    'バイナリの中に残します。ここからクラス名と、その持ちものが分かります。'));

  const classes = findCxxClasses(app.symbols);
  if (!classes.length) {
    sheet.body.append(noteBox(
      'このファイルには C++ のクラス情報が見当たりませんでした。\n' +
      'Objective-C や Swift で書かれているか、情報が削られている可能性があります。\n' +
      'Objective-C のクラスは「構造」の画面で見られます。'));
    return;
  }

  const search = input('クラス名で絞り込む');
  sheet.body.append(field(search, '探す', () => render()));
  const status = el('div', 'hint', classes.length + ' 個のクラスが見つかりました。');
  const l = list();
  sheet.body.append(status, l);

  function render() {
    const q = search.value.trim().toLowerCase();
    const hits = q ? classes.filter((c) => c.name.toLowerCase().includes(q)) : classes;
    l.replaceChildren();
    for (const c of hits.slice(0, 300)) {
      l.append(tapRow(c.name, {
        sub: (c.vtable != null ? 'vtable ' + addrHex(c.vtable) : '仮想関数なし') +
          (c.typeinfo != null ? '  ·  RTTI あり' : ''),
        onTap: () => showVtable(app, c),
      }));
    }
    status.textContent = hits.length + ' 個' + (hits.length > 300 ? '（先頭 300 個を表示）' : '');
  }
  render();
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') render(); });
}

async function showVtable(app, cls) {
  const sheet = new Sheet(cls.name);
  if (cls.vtable == null) {
    sheet.body.append(noteBox('このクラスには仮想関数の表がありません。'));
    return;
  }
  const status = el('div', 'hint', '読み込んでいます…');
  sheet.body.append(status);
  const read = (a, len) => app.backend.readAt(a, len).then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
  const vt = await readVtable(read, cls.vtable, app.symbols);
  if (!vt || !vt.slots.length) { status.textContent = '仮想関数の表を読めませんでした。'; return; }
  status.remove();

  sheet.body.append(el('div', 'hint',
    '仮想関数の一覧です。番号が「何番目のスロットか」で、\n' +
    'コードの中で `ldr x8, [x0]` → `ldr x8, [x8, #0x10]` → `blr x8` と呼ばれていたら、\n' +
    'それは 0x10 ÷ 8 = 2 番のスロット、つまり下の 2 番の関数です。'));

  const l = list();
  for (const s of vt.slots) {
    l.append(tapRow('#' + s.index + '  ' + (s.readable || s.name || 'sub_' + s.addr.toString(16).toUpperCase()), {
      sub: addrHex(s.addr) + (s.name && s.readable !== s.name ? '\n' + s.name : ''),
      onTap: () => { sheet.close(); app.openFunctionReport(s.addr); },
    }));
  }
  sheet.body.append(l);
}

/* ══════════════════════════════════════════════════════════
   外とのつながり
   ══════════════════════════════════════════════════════════ */

export async function showLinkage(app) {
  const sheet = new Sheet('外とのつながり');
  sheet.body.append(el('div', 'hint',
    'アプリ単体では画面も出せません。iOS が用意したライブラリを借りて動いています。\n' +
    '何を借りているかを見るだけで、アプリが何をするものかが半分わかります。'));

  await app.ensureProgram().catch(() => null);
  const imports = importList(app.symbols, app.program);
  const groups = importsByFramework(imports);
  const slice = app.currentSlice();
  const dylibs = slice && slice.info ? slice.info.dylibs || [] : [];

  const tabs = el('div', 'chips');
  const body = el('div');
  const views = {
    imports: () => {
      body.replaceChildren();
      body.append(el('div', 'hint', '借りている関数 ' + imports.length + ' 個。呼ばれている回数の多い順です。'));
      for (const g of groups) {
        const d = disclosure(g.name + '（' + g.items.length + '）', {
          build: (into) => {
            const l = list();
            for (const i of g.items.slice(0, 200)) {
              l.append(tapRow(i.readable || i.name, {
                sub: addrHex(i.addr) + (i.calls ? '  ·  ' + i.calls + ' 回呼ばれています' : '') +
                  (i.readable !== i.name ? '\n' + i.name : ''),
                onTap: () => { sheet.close(); app.goToAddress(i.addr, { announce: true }); },
              }));
            }
            into.append(l);
          },
        });
        body.append(d);
      }
      body.append(noteBox('どの framework のものかは、名前からの推測です（バイナリには対応表が残っていません）。'));
    },
    exports: () => {
      body.replaceChildren();
      const ex = exportList(app.symbols);
      body.append(el('div', 'hint',
        '外へ公開している名前 ' + ex.length + ' 個。\n' +
        'アプリ本体では少なめですが、.framework を開いたときは「使える API の一覧」になります。'));
      const l = list();
      for (const e of ex.slice(0, 400)) {
        l.append(tapRow(e.readable, {
          sub: addrHex(e.addr) + (e.readable !== e.name ? '\n' + e.name : ''),
          onTap: () => { sheet.close(); app.openFunctionReport(e.addr); },
        }));
      }
      body.append(l);
    },
    dylibs: () => {
      body.replaceChildren();
      body.append(el('div', 'hint',
        '起動時に読み込むライブラリの一覧（LC_LOAD_DYLIB）。これは推測ではなく、\n' +
        'ファイルにそのまま書いてある事実です。'));
      const l = list();
      for (const d of dylibs) {
        const short = d.split('/').pop();
        l.append(tapRow(short, { sub: d, onTap: () => copyText(d, 'パス') }));
      }
      if (!dylibs.length) l.append(tapRow('ありません', { disabled: true }));
      body.append(l);
    },
  };

  let current = 'imports';
  for (const [key, label] of [['imports', '借りている関数'], ['exports', '公開している名前'], ['dylibs', 'ライブラリ']]) {
    tabs.append(button(label, 'chip' + (key === current ? ' on' : ''), (e) => {
      current = key;
      for (const c of tabs.children) c.classList.remove('on');
      e.currentTarget.classList.add('on');
      views[key]();
    }));
  }
  sheet.body.append(tabs, body);
  views.imports();
}

/* ══════════════════════════════════════════════════════════
   グローバル変数
   ══════════════════════════════════════════════════════════ */

export async function showGlobals(app) {
  const sheet = new Sheet('グローバル変数');
  const status = el('div', 'hint', '参照関係を調べています…');
  sheet.body.append(status);
  await app.ensureProgram().catch(() => null);

  const globals = findGlobals(app.symbols, app.program, app.store.get('regions') || [], { limit: 400 });
  status.remove();
  sheet.body.append(el('div', 'hint',
    'どこからでも触れる置き場です。所持金・ログイン状態・設定などは、\n' +
    'たいていここに置かれています。よく参照されているものほど上に出ます。'));

  if (!globals.length) {
    sheet.body.append(noteBox('見つかりませんでした（データのセクションが無いか、参照が拾えていません）。'));
    return;
  }

  const l = list();
  for (const g of globals.slice(0, 300)) {
    l.append(tapRow(g.readable, {
      sub: addrHex(g.addr) + '  ·  ' + g.region + '  ·  ' + g.refs + ' か所から参照' +
        (g.named ? '' : '\n（名前は残っていません。参照の多さから見つけました）'),
      onTap: () => { sheet.close(); app.goToAddress(g.addr, { announce: true }); },
    }));
  }
  sheet.body.append(l);
}

/* ══════════════════════════════════════════════════════════
   名前とメモ
   ══════════════════════════════════════════════════════════ */

function notePersistenceFailure(app, action = '変更') {
  const code = app.notes?.lastSaveError?.code || 'STORAGE_ERROR';
  alertDialog('保存できませんでした',
    `${action}はこの画面には残っていますが、端末へ保存できていません（${code}）。\n` +
    '「自分で付けた名前とメモ」を開くと保存の再試行と書き出しができます。ページを閉じる前にバックアップしてください。');
}

export function showRename(app, addr) {
  const sheet = new Sheet('名前を付ける');
  const cur = app.symbols.nameAt(addr);
  sheet.body.append(el('div', 'hint',
    addrHex(addr) + '\n' +
    '分かったことに、その場で名前を付けておきます。\n' +
    '命令一覧・関数一覧・呼び出し元まで、いっぺんに新しい名前になります。'));
  if (cur) sheet.body.append(kvRow('いまの名前', readableName(cur)));

  const nameIn = input('例: ダメージ計算', app.notes.nameOf(addr) || '');
  sheet.body.append(field(nameIn, '決定', apply));
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  setTimeout(() => nameIn.focus(), 50);

  const memo = textArea(app.notes.comment(addr) || '', 4);
  sheet.body.append(heading('メモ（覚えておきたいこと）'), memo);
  sheet.body.append(field(el('span'), 'メモを保存', () => {
    if (!app.notes.setComment(addr, memo.value)) { notePersistenceFailure(app, 'メモ'); return; }
    toast('メモを保存しました');
  }));

  if (app.notes.nameOf(addr)) {
    sheet.body.append(button('付けた名前を消す', 'tb-btn danger', () => {
      const saved = app.notes.setName(addr, '');
      app.symbols.rename(addr, '');
      app.viewer.setSymbols(app.symbols);
      if (!saved) { notePersistenceFailure(app, '名前の削除'); return; }
      sheet.close();
      toast('元の名前に戻しました');
    }));
  }

  function apply() {
    const v = nameIn.value.trim();
    const saved = app.notes.setName(addr, v);
    app.symbols.rename(addr, v);
    app.viewer.setSymbols(app.symbols);
    app.updateChrome();
    if (!saved) { notePersistenceFailure(app, '名前'); return; }
    sheet.close();
    toast(v ? '「' + v + '」にしました' : '元の名前に戻しました');
  }
}

export function showComment(app, addr) {
  const sheet = new Sheet('メモ');
  sheet.body.append(el('div', 'hint', addrHex(addr) + '\nこの行についてのメモを残します。'));
  const memo = textArea(app.notes.comment(addr) || '', 5);
  sheet.body.append(memo);
  sheet.body.append(field(el('span'), '保存', () => {
    if (!app.notes.setComment(addr, memo.value)) { notePersistenceFailure(app, 'メモ'); return; }
    sheet.close();
    toast('保存しました');
  }));
}

export function showNotes(app) {
  const sheet = new Sheet('自分で付けた名前とメモ');
  const render = () => {
    body.replaceChildren();
    if (app.notes.dirty) {
      const warning = noteBox('まだ端末へ保存できていない変更があります。ページを閉じる前に再試行するか、下の「書き出す」でバックアップしてください。', 'warn');
      const retry = el('div', 'chips');
      retry.append(button('保存を再試行', 'chip', () => {
        if (app.notes.save()) { toast('保存しました'); render(); }
        else notePersistenceFailure(app, '変更');
      }));
      warning.append(retry);
      body.append(warning);
    }
    const names = app.notes.nameEntries();
    body.append(el('div', 'hint',
      '名前 ' + names.length + ' 個、メモ ' + app.notes.commentCount() + ' 個。\n' +
      'この端末のブラウザに保存されています（どこにも送信されません）。'));

    const l = list();
    l.append(groupRow('名前'));
    if (!names.length) l.append(tapRow('まだありません', { disabled: true }));
    for (const n of names.slice(0, 300)) {
      l.append(tapRow(n.name, {
        sub: addrHex(n.addr),
        onTap: () => { sheet.close(); app.goToAddress(n.addr, { announce: true }); },
      }));
    }
    body.append(l);

    const chips = el('div', 'chips');
    chips.append(button('書き出す（バックアップ）', 'chip', () => {
      copyText(app.notes.toJSON(), 'メモ');
    }));
    chips.append(button('読み込む', 'chip', () => {
      const sh = new Sheet('読み込む');
      sh.body.append(para('書き出した内容を貼り付けてください。いまの内容と合わさります。'));
      const ta = textArea('', 8);
      sh.body.append(ta, field(el('span'), '取り込む', () => {
        try {
          const n = app.notes.fromJSON(ta.value);
          for (const e of app.notes.nameEntries()) app.symbols.rename(e.addr, e.name);
          app.viewer.setSymbols(app.symbols);
          sh.close();
          render();
          if (!app.notes.lastMutationSaved) { notePersistenceFailure(app, '取り込み'); return; }
          toast(n + ' 件を取り込みました');
        } catch (err) { alertDialog('読み込めません', userError(err, 'メモの形式を確認してください。')); }
      }));
    }));
    chips.append(button('全部消す', 'chip danger', () => {
      alertDialog('全部消しますか', 'このファイルに付けた名前とメモを消します。元に戻せません。', {
        confirmLabel: '消す',
        onConfirm: () => {
          for (const e of app.notes.nameEntries()) app.symbols.rename(e.addr, '');
          const saved = app.notes.clear();
          app.viewer.setSymbols(app.symbols);
          render();
          if (!saved) { notePersistenceFailure(app, '全消去'); return; }
          toast('消しました');
        },
      });
    }));
    body.append(chips);
  };
  const body = el('div');
  sheet.body.append(body);
  render();
}

/* ══════════════════════════════════════════════════════════
   パッチ
   ══════════════════════════════════════════════════════════ */

export function showPatches(app) {
  const sheet = new Sheet('パッチ');
  sheet.body.append(el('div', 'hint',
    '命令を書き換えて「こうしたらどうなるか」を試す道具です。\n' +
    '元のファイルには書き込みません。保存を選んだときだけ、新しいファイルを作ります。'));
  sheet.body.append(noteBox(
    'iOS の実行ファイルは署名されています。書き換えたものをそのまま実機で動かすことはできません。\n' +
    '（このツールは解析と実験のためのものです。）'));

  const render = () => {
    body.replaceChildren();
    const items = app.patches.list();
    const l = list();
    l.append(groupRow('書き換えの一覧（' + items.length + '）'));
    if (!items.length) l.append(tapRow('まだありません', { disabled: true, sub: '命令を長押しして「書き換える」から作れます。' }));
    for (const it of items) {
      l.append(tapRow((it.addr != null ? addrHex(it.addr) : '+' + it.offset) + '  ' + (it.text || ''), {
        sub: hexOf(it.before) + '  →  ' + hexOf(it.after),
        onTap: () => {
          menu([
            { label: 'この場所へ移動', action: () => { sheet.close(); if (it.addr != null) app.goToAddress(it.addr, { announce: true }); } },
            { label: 'この書き換えを取り消す', action: () => { app.patches.remove(it.offset); render(); toast('取り消しました'); } },
          ], window.innerWidth / 2, 200);
        },
      }));
    }
    body.append(l);

    const chips = el('div', 'chips');
    chips.append(button('アドレスを指定して書き換える', 'chip', () => {
      const sh = new Sheet('場所を指定');
      const a = input('0x100004000');
      sh.body.append(para('書き換えたい命令のアドレスを入れてください。'), field(a, '進む', async () => {
        let addr;
        try { addr = BigInt(a.value.trim()); } catch { toast('アドレスの形が違います'); return; }
        sh.close();
        const insn = await instructionAt(app, addr);
        showPatchEditor(app, addr, insn);
      }));
    }));
    if (items.length) {
      chips.append(button('書き換えたファイルを保存', 'chip strong', () => savePatched(app)));
      chips.append(button('全部取り消す', 'chip danger', () => { app.patches.clear(); render(); }));
    }
    body.append(chips);
  };
  const body = el('div');
  sheet.body.append(body);
  render();
}

async function instructionAt(app, addr) {
  const region = app.codeRegion();
  if (!region) return null;
  const file = app.store.get('file');
  if (validatePatchRange(region, addr, 4, file && file.size, true).error) return null;
  const row = app.viewer?.rowOfAddress ? app.viewer.rowOfAddress(addr) : null;
  if (row == null) {
    // Variable-length ISA: ask the architecture backend for an instruction at
    // this exact address rather than manufacturing a 4-byte row.
    const decoded = await app.backend.disassembleAt(addr, { length: 32 });
    const hit = decoded?.instructions?.find((i) => i.address === addr || BigInt(i.address ?? -1) === addr);
    return hit ? { mnemonic: hit.mnemonic || hit.mn || '', operands: hit.operands || hit.opStr || '', address: addr } : null;
  }
  const chunk = Math.floor(row / 1024);
  try {
    const e = await app.backend.fetchChunk(region.id, chunk, true);
    const k = row - chunk * 1024;
    return { mnemonic: e.mn ? e.mn[k] : '', operands: e.ops ? e.ops[k] : '', address: addr };
  } catch { return null; }
}

export async function showPatchEditor(app, addr, insnArg) {
  const insn = insnArg || await instructionAt(app, addr);
  const sheet = new Sheet('命令を書き換える');
  const region = app.codeRegion();
  if (!region) { sheet.body.append(noteBox('コードのセクションが見つかりません。')); return; }
  const file = app.store.get('file');
  const range = validatePatchRange(region, addr, 4, file && file.size, true);
  if (range.error) { sheet.body.append(noteBox(range.error)); return; }
  const fileOffset = range.fileOffset;

  sheet.body.append(el('div', 'hint', addrHex(addr) + '  ·  ファイルの中では +0x' + fileOffset.toString(16)));
  if (insn) {
    const b = block('いまの命令');
    b.append(el('div', 'bigval mono', (insn.mnemonic + ' ' + insn.operands).trim()));
    try {
      b.append(el('div', 'hint', brief(insn.mnemonic, insn.operands, 'ja', { address: addr })));
    } catch { /* 説明が作れなくても続ける */ }
    sheet.body.append(b);
  }

  const suggestions = suggestPatches(insn ? insn.mnemonic : '', insn ? insn.operands : '', addr);
  const l = list();
  l.append(groupRow('よく使う書き換え'));
  for (const s of suggestions) {
    l.append(tapRow(s.label, { sub: s.why + '\n→ ' + s.text, onTap: () => apply(s.text) }));
  }
  sheet.body.append(l);

  sheet.body.append(heading('自分で書く'));
  const asm = input('例: mov w0, #1');
  sheet.body.append(field(asm, '書き換える', () => apply(asm.value)));
  sheet.body.append(el('div', 'hint',
    '使えるのは nop / ret / brk / mov / b / bl / b.条件 です。\n' +
    'それ以外は 16 進で直接どうぞ（例: 1F 20 03 D5）。'));

  const hex = input('1F 20 03 D5');
  sheet.body.append(field(hex, '16 進で書き換える', () => {
    const bytes = parseHexBytes(hex.value);
    if (!bytes || bytes.length !== 4) { toast('4 バイト（8 桁）で指定してください'); return; }
    commit(bytes, hex.value);
  }));

  async function apply(text) {
    const built = assemble(text, addr);
    if (built.error) { alertDialog('組み立てられません', built.error); return; }
    commit(built.bytes, text);
  }

  async function commit(bytes, text) {
    const valid = validatePatchRange(region, addr, bytes.length, file && file.size, true);
    if (valid.error) { alertDialog('登録できません', valid.error); return; }
    const before = await app.backend.readAt(addr, bytes.length)
      .then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
    if (!before || before.length !== bytes.length) {
      alertDialog('登録できません', '元のバイトを読み取れませんでした。');
      return;
    }
    app.patches.add(valid.fileOffset, before, bytes, { addr, text });
    sheet.close();
    toast('書き換えを登録しました（保存するまでファイルは変わりません）');
  }
}

async function savePatched(app) {
  const file = app.store.get('file');
  if (!file) { toast('ファイルが開かれていません'); return; }
  toast('書き出しています…');
  try {
    const blob = await app.patches.apply(file);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (file.name || 'patched') + '.patched';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('保存しました');
  } catch (err) {
    alertDialog('保存できません', userError(err, 'ブラウザの保存設定を確認して、もう一度お試しください。'));
  }
}

/* ══════════════════════════════════════════════════════════
   実行してみる（デバッガ）
   ══════════════════════════════════════════════════════════ */

export function showDebugger(app, addr) {
  const sheet = new Sheet('実行してみる');
  const emu = makeEmulator(app);
  let args = [0n, 0n, 0n, 0n];

  sheet.body.append(el('div', 'hint',
    fnName(app, addr) + '\n' +
    'この関数を、ブラウザの中で 1 命令ずつ動かします。実機のアプリは起動しません。\n' +
    '危ないことは何も起きないので、安心して何度でも試せます。'));
  sheet.body.append(noteBox(
    'iOS のライブラリ（UIKit など）の中身はこのファイルに入っていないので、\n' +
    'そこへ出たら「戻り値 0 で帰ってきた」ことにして先へ進みます。\n' +
    '何をそう扱ったかは、下の「メモ」に出ます。'));

  /* 引数 */
  const argWrap = el('div', 'field wrap');
  const argInputs = [];
  for (let i = 0; i < 4; i++) {
    const n = input('x' + i, '0');
    n.style.maxWidth = '80px';
    argInputs.push(n);
    argWrap.append(n);
  }
  sheet.body.append(heading('引数（x0〜x3）'), argWrap);

  const chips = el('div', 'chips');
  const status = el('div', 'hint', 'まだ動かしていません。');
  const regTable = el('div', 'regs mono');
  const traceBox = el('div', 'codeview small');
  const logBox = el('div');
  const bpBox = el('div');

  const start = () => {
    const parsed = argInputs.map((n) => parseDebuggerArgument(n.value));
    let invalid = false;
    parsed.forEach((result, i) => {
      const inputNode = argInputs[i];
      inputNode.setAttribute('aria-invalid', String(!result.ok));
      inputNode.classList.toggle('invalid', !result.ok);
      if (!result.ok) invalid = true;
    });
    if (invalid) {
      status.textContent = '引数に読み取れない値があります。赤く示した欄を直してください。';
      return false;
    }
    args = parsed.map((result) => result.value);
    const keep = new Set(emu.breakpoints);   // 置いた目印は、やり直しても残す
    emu.reset();
    emu.breakpoints = keep;
    emu.setup(addr, args);
    status.textContent = '準備しました。「1 命令進む」か「最後まで走らせる」を押してください。';
    render();
  };

  chips.append(button('はじめから', 'chip', start));
  chips.append(button('1 命令進む', 'chip', async () => {
    const r = await emu.step();
    status.textContent = r.text ? ('実行: ' + r.text) : (r.reason || '');
    if (r.reason) status.textContent += '\n' + r.reason;
    render();
  }));
  chips.append(button('10 命令進む', 'chip', async () => {
    for (let i = 0; i < 10 && !emu.stopped; i++) await emu.step();
    status.textContent = emu.stopped || (emu.steps + ' 命令まで進みました。');
    render();
  }));
  chips.append(button('最後まで走らせる', 'chip strong', async () => {
    status.textContent = '走らせています…';
    const r = await emu.run(50000, (n) => { status.textContent = n + ' 命令…'; });
    status.textContent = (emu.stopped || 'ブレークポイントで止まりました。') +
      '\n合計 ' + emu.steps + ' 命令、戻り値 x0 = ' + hexBig(emu.x[0]) + '（10 進で ' + emu.x[0].toString() + '）';
    void r;
    render();
  }));
  sheet.body.append(chips, status);

  /* ブレークポイント: そこへ来たら止まる目印 */
  const bpInput = input('0x… 止めたい場所', '');
  sheet.body.append(heading('ブレークポイント'), el('div', 'hint',
    'そこへ来たら止まる目印です。「最後まで走らせる」で、ここに着いた時点で止まります。'));
  sheet.body.append(field(bpInput, '置く', () => {
    let a;
    try { a = BigInt(bpInput.value.trim()); } catch { toast('アドレスの形が違います'); return; }
    emu.breakpoints.add(a.toString());
    bpInput.value = '';
    renderBreakpoints();
    toast(addrHex(a) + ' に置きました');
  }));
  sheet.body.append(bpBox);

  function renderBreakpoints() {
    bpBox.replaceChildren();
    const l = list();
    if (!emu.breakpoints.size) l.append(tapRow('まだありません', { disabled: true }));
    for (const key of emu.breakpoints) {
      const a = BigInt(key);
      l.append(tapRow(addrHex(a), {
        sub: 'タップすると外します',
        onTap: () => { emu.breakpoints.delete(key); renderBreakpoints(); },
      }));
    }
    bpBox.append(l);
  }
  renderBreakpoints();

  sheet.body.append(heading('レジスタ'), regTable);
  sheet.body.append(heading('通った道（最後の 40 命令）'), traceBox);
  sheet.body.append(heading('メモ'), logBox);

  const memWrap = el('div');
  sheet.body.append(heading('メモリを覗く'), memWrap);
  const memAddr = input('0x… または x0', '');
  memWrap.append(field(memAddr, '見る', async () => {
    let a;
    const v = memAddr.value.trim();
    if (/^x\d+$/.test(v)) a = emu.get(v);
    else { try { a = BigInt(v); } catch { toast('アドレスの形が違います'); return; } }
    const bytes = await emu.dump(a, 64);
    memOut.replaceChildren(codeBlock(dumpText(a, bytes)));
  }));
  const memOut = el('div');
  memWrap.append(memOut);

  function render() {
    regTable.replaceChildren();
    const regs = emu.registerList();
    for (const r of regs) {
      if (r.value === 0n && /^x(1[1-9]|2\d|30)$/.test(r.name)) continue;   // 0 のままの退避用は隠す
      const row = el('div', 'reg');
      row.append(el('span', 'reg-name', r.name), el('span', 'reg-val', hexBig(r.value)));
      regTable.append(row);
    }
    const f = el('div', 'reg');
    f.append(el('span', 'reg-name', 'flags'), el('span', 'reg-val', emu.flagText()));
    regTable.append(f);

    traceBox.replaceChildren();
    for (const t of emu.trace.slice(-40)) {
      const row = el('div', 'cl');
      row.append(el('span', 'cl-addr mono', t.addr.toString(16).toUpperCase().slice(-6)),
        el('span', 'cl-text mono', t.text));
      traceBox.append(row);
    }

    logBox.replaceChildren();
    if (!emu.log.length) logBox.append(el('div', 'hint', '（まだありません）'));
    for (const l of emu.log.slice(-20)) {
      logBox.append(el('div', 'hint', '· ' + l.call + ' — ' + l.note));
    }
  }

  start();
}

function hexBig(v) {
  return '0x' + BigInt.asUintN(64, v).toString(16).toUpperCase().padStart(16, '0');
}

function dumpText(addr, bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = Array.from(bytes.slice(i, i + 16));
    const hex = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push((addr + BigInt(i)).toString(16).toUpperCase().padStart(12, '0') + '  ' + hex.padEnd(48) + '  ' + ascii);
  }
  return lines.join('\n');
}

/* ══════════════════════════════════════════════════════════
   スクリプト
   ══════════════════════════════════════════════════════════ */

export function showScript(app) {
  const sheet = new Sheet('スクリプト');
  sheet.body.append(el('div', 'hint',
    '同じ作業を何百回も繰り返すときの道具です（IDAPython にあたります）。\n' +
    '言語は JavaScript。hex.〜 で解析結果に触れて、print(…) で下に出します。'));

  const ta = textArea(SAMPLES[0].code, 10);
  sheet.body.append(ta);

  const chips = el('div', 'chips');
  chips.append(button('実行', 'chip strong', run));
  chips.append(button('消す', 'chip', () => { ta.value = ''; }));
  chips.append(button('お手本', 'chip', () => {
    menu(SAMPLES.map((s) => ({
      label: s.title,
      action: () => { ta.value = s.code; toast(s.why); },
    })), window.innerWidth / 2, 160);
  }));
  chips.append(button('使える命令', 'chip', showScriptHelp));
  sheet.body.append(chips);

  const out = el('div', 'codeview small');
  sheet.body.append(heading('結果'), out);

  async function run() {
    out.replaceChildren();
    const write = (line) => {
      const row = el('div', 'cl');
      row.append(el('span', 'cl-text mono', line));
      out.append(row);
      out.scrollTop = out.scrollHeight;
    };
    write('— 実行しています —');
    const res = await runScript(ta.value, app, write);
    if (res.error) {
      const row = el('div', 'cl warn');
      row.append(el('span', 'cl-text mono', '⚠ ' + res.error));
      out.append(row);
    } else {
      write('— おわり —');
    }
  }
}

function showScriptHelp() {
  const sheet = new Sheet('スクリプトで使える命令');
  sheet.body.append(para('よく使うものだけ並べます。すべて hex. から始めます。'));
  const groups = [
    ['調べる', [
      'hex.functions()            関数の一覧',
      'hex.name(addr)             名前を引く',
      'hex.disasm(addr, 20)       逆アセンブル',
      'await hex.decompile(addr)  逆コンパイル',
      'await hex.types(addr)      引数と戻り値の推定',
      'await hex.struct(addr)     構造体の復元',
      'hex.xrefsTo(addr)          呼んでいる場所',
      'hex.xrefsFrom(addr)        呼んでいる相手',
      'hex.mostCalled(20)         よく呼ばれる関数',
    ]],
    ['読む', [
      'await hex.bytes(addr, 16)  生バイト',
      'await hex.string(addr)     文字列として読む',
      'await hex.loadStrings()    文字列を集める',
      'hex.findStrings("error")   文字列を探す',
    ]],
    ['書く・動かす', [
      'hex.rename(addr, "名前")   名前を付ける',
      'hex.comment(addr, "メモ")  メモを書く',
      'await hex.patch(addr, "nop")  書き換え',
      'await hex.run(addr, [1, 2])   動かしてみる',
      'hex.goto(addr) / hex.open(addr)  画面を動かす',
    ]],
    ['その他', [
      'hex.file()                 開いているファイルの情報',
      'hex.classes()              Objective-C のクラス',
      'hex.hex(v)                 0x… の文字列にする',
      'print(…)                   結果を下に出す',
    ]],
  ];
  for (const [title, lines] of groups) {
    sheet.body.append(heading(title));
    sheet.body.append(codeBlock(lines));
  }
}

/* ══════════════════════════════════════════════════════════
   プラグイン
   ══════════════════════════════════════════════════════════ */

export function showPlugins(app) {
  const sheet = new Sheet('プラグイン');
  sheet.body.append(el('div', 'hint',
    'このツールに無い調べ方は、JavaScript を 1 ファイル書いて足せます。\n' +
    '読み込んだプラグインは、この画面から実行できます。'));
  sheet.body.append(noteBox(
    'プラグインは、あなたが選んだものだけが動きます。中身は必ず自分で確かめてください。\n' +
    '解析中のファイルが外へ送られることはありません（通信の道具は渡していません）。'));

  const render = () => {
    body.replaceChildren();
    const l = list();
    l.append(groupRow('入っているプラグイン（' + app.plugins.plugins.length + '）'));
    if (!app.plugins.plugins.length) l.append(tapRow('まだありません', { disabled: true }));
    for (const p of app.plugins.plugins) {
      l.append(tapRow(p.name, {
        sub: (p.description || '') + '\n出どころ: ' + p.origin,
        onTap: () => {
          menu([
            { label: '実行する', action: () => runPlugin(p) },
            { label: '中身を見る', action: () => { const s = new Sheet(p.name); s.body.append(codeBlock(p.source)); } },
            { label: '外す', action: () => { app.plugins.remove(p.id); render(); toast('外しました'); } },
          ], window.innerWidth / 2, 200);
        },
      }));
    }
    body.append(l);

    const chips = el('div', 'chips');
    chips.append(button('ファイルから読み込む', 'chip', () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.js,text/javascript';
      picker.addEventListener('change', async () => {
        const f = picker.files && picker.files[0];
        if (!f) return;
        if (f.size > MAX_PLUGIN_SOURCE_BYTES) {
          toast('プラグインが大きすぎます（512 KB まで）。');
          return;
        }
        const text = await f.text();
        confirmInstall(text, f.name);
      });
      picker.click();
    }));
    chips.append(button('URL から読み込む', 'chip', () => {
      const sh = new Sheet('URL から読み込む');
      const u = input('https://…');
      sh.body.append(para('プラグインの JavaScript ファイルの URL を入れてください。'), field(u, '取り寄せる', async () => {
        sh.close();
        toast('取り寄せています…');
        const res = await app.plugins.installFromUrl(u.value.trim());
        if (res.error) alertDialog('読み込めません', res.error);
        else confirmInstall(res.source, res.origin);
      }));
    }));
    chips.append(button('お手本を見る', 'chip', () => {
      const s = new Sheet('プラグインの書き方');
      s.body.append(para('この形で書いて、.js として保存し、上の「ファイルから読み込む」で入れてください。'));
      s.body.append(codeBlock(EXAMPLE_PLUGIN));
      s.body.append(button('このお手本を入れる', 'tb-btn strong', async () => {
        const res = await app.plugins.install(EXAMPLE_PLUGIN, 'お手本');
        s.close();
        if (res.error) alertDialog('入れられません', res.error);
        else { render(); toast('入れました'); }
      }));
    }));
    body.append(chips);
  };

  function confirmInstall(text, origin) {
    const s = new Sheet('中身を確かめる');
    s.body.append(para('入れる前に、中身を確かめてください。'));
    s.body.append(para('全 ' + text.length.toLocaleString() + ' 文字です。以下が全文です。'));
    s.body.append(codeBlock(text));
    s.body.append(button('全文を確認して入れる', 'tb-btn strong', async () => {
      const res = await app.plugins.install(text, origin);
      s.close();
      if (res.error) alertDialog('入れられません', res.error);
      else { render(); toast(res.added.length + ' 個入りました'); }
    }));
  }

  function runPlugin(p) {
    const s = new Sheet(p.name);
    const out = el('div', 'codeview small');
    s.body.append(el('div', 'hint', '実行しています…'), out);
    const write = (line) => {
      const row = el('div', 'cl');
      row.append(el('span', 'cl-text mono', line));
      out.append(row);
    };
    app.plugins.run(p.id, write).then((res) => {
      if (res.error) write('⚠ ' + res.error);
      else write('— おわり —');
    });
  }

  const body = el('div');
  sheet.body.append(body);
  render();
}

/* ══════════════════════════════════════════════════════════
   Unity（IL2CPP）
   ══════════════════════════════════════════════════════════ */

export function showIl2cpp(app) {
  const sheet = new Sheet('Unity（IL2CPP）');
  sheet.body.append(el('div', 'hint',
    'Unity のアプリは C# で書かれていますが、出荷時にはクラス名やメソッド名が\n' +
    '実行ファイルから消え、global-metadata.dat という別ファイルに移ります。\n' +
    'そのファイルを読み込むと、名前の一覧が戻ります。'));

  sheet.body.append(codeBlock([
    'YourApp.app/',
    '  YourApp                                    ← いま開いているファイル',
    '  Data/Managed/Metadata/global-metadata.dat  ← これを読み込みます',
  ]));

  const unity = looksLikeUnity(app.stringIndex, app.currentSlice());
  sheet.body.append(el('div', 'hint',
    unity ? '✓ このファイルは Unity 製のようです。' :
      'このファイルが Unity 製かどうかは、まだ分かりません（文字列を集めると精度が上がります）。'));

  const body = el('div');
  const pick = button('global-metadata.dat を読み込む', 'tb-btn strong', () => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.addEventListener('change', async () => {
      const f = picker.files && picker.files[0];
      if (!f) return;
      if (f.size > MAX_IL2CPP_METADATA_BYTES) {
        body.replaceChildren(el('div', 'hint', `global-metadata.dat が大きすぎます (${Math.ceil(f.size/1024/1024)} MiB)。安全上 ${MAX_IL2CPP_METADATA_BYTES/1024/1024} MiB までです。`));
        return;
      }
      const controller = new AbortController();
      body.replaceChildren(el('div', 'hint', '読み込んでいます…'));
      try {
        const meta = parseMetadataAuto(await f.arrayBuffer(), { signal:controller.signal });
        await bindMethodAddresses(meta, {
          regions: app.store.get('regions') || [], signal:controller.signal,
          read: (addr, len) => app.backend.readAt(addr, len)
            .then((r) => (r && r.found ? r.bytes : null)),
        });
        const named = meta.methods.filter((m) => m.address != null)
          .map((m) => ({ addr: m.address, name: m.full }));
        if (named.length) {
          app.symbols.addNames(named);
          app.symbols.addFunctions(named.map((n) => n.addr));
          app.viewer.setSymbols(app.symbols);
        }
        show(meta);
      } catch (err) {
        body.replaceChildren(el('div', 'hint warn', userError(err,
          'IL2CPPメタデータを解析できませんでした。別の解析ツールは引き続き利用できます。')));
      }
    });
    picker.click();
  });
  sheet.body.append(pick, body);

  function show(meta) {
    body.replaceChildren();
    body.append(el('div', 'hint',
      'version ' + meta.version + '  ·  クラス ' + meta.classes.length +
      ' 個  ·  メソッド ' + meta.methods.length + ' 個  ·  文字列 ' + meta.literals.length + ' 個'));
    for (const w of meta.warnings) body.append(el('div', 'hint warn', '⚠ ' + w));
    body.append(noteBox(meta.methodBinding && meta.methodBinding.bound
      ? meta.methodBinding.bound + ' 個のメソッドを、検証済みのCodeRegistration表から機械語addressへ対応づけました。'
      : 'Method→address表を検証できなかったため、名前だけを表示します。推測addressは作りません。'));

    const search = input('クラス名・メソッド名で絞り込む');
    const results = list();
    body.append(field(search, '探す', run), results);

    function run() {
      const q = search.value.trim().toLowerCase();
      results.replaceChildren();
      if (!q) {
        results.append(groupRow('クラス（先頭 100 個）'));
        for (const c of meta.classes.slice(0, 100)) {
          results.append(tapRow(c.full, { sub: 'クラス', onTap: () => copyText(c.full, '名前') }));
        }
        return;
      }
      const cs = meta.classes.filter((c) => c.full.toLowerCase().includes(q)).slice(0, 60);
      const ms = meta.methods.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 100);
      const ls = meta.literals.filter((x) => x.text.toLowerCase().includes(q)).slice(0, 60);
      if (cs.length) results.append(groupRow('クラス'));
      for (const c of cs) results.append(tapRow(c.full, { sub: 'クラス', onTap: () => copyText(c.full, '名前') }));
      if (ms.length) results.append(groupRow('メソッド'));
      for (const m of ms) {
        results.append(tapRow(m.name, {
          sub: (m.className || '（所属不明）') + (m.address != null ? '\n' + addrHex(m.address) : ''),
          onTap: () => m.address != null ? app.goToAddress(m.address) : copyText(m.full, '名前'),
        }));
      }
      if (ls.length) results.append(groupRow('プログラムの中の文字列'));
      for (const x of ls) {
        results.append(tapRow(x.text.slice(0, 80), {
          sub: 'この文字列で「検索」すると、使っている場所が見つかることがあります',
          onTap: () => copyText(x.text, '文字列'),
        }));
      }
      if (!cs.length && !ms.length && !ls.length) results.append(tapRow('見つかりませんでした', { disabled: true }));
    }
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    run();
  }
}

/* ══════════════════════════════════════════════════════════
   そのほか（ほかの画面から呼ぶ小さな入口）
   ══════════════════════════════════════════════════════════ */

/** 名前が読み直せるものなら、読める形にして返す。 */
export function prettyName(name) {
  if (!name) return name;
  /*
   * 一覧や図の中では、短い形で出す。
   * 完全に戻した形は 150 字を超えることがあり、行からあふれて
   * 「どのクラスの何か」がかえって読めなくなる。
   * 完全な形は、関数の詳細（名前を付ける画面）に出している。
   */
  return isMangled(name) ? shortName(name) : name;
}

/** 完全に戻した形。詳細画面で「本当の名前」を見せるときだけ使う。 */
export function fullName(name) {
  if (!name) return name;
  return isMangled(name) ? readableName(name) : name;
}
