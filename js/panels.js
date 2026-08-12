/*
 * シート（下から出てくる画面）とダイアログ。
 *
 *   ファイル情報 / セクション / 構造 / 関数 / 文字列 / ジャンプ / 検索 /
 *   命令の詳細 / 関数の要約 / 参照元 / 設定 / ヘルプ / 学習 / 用語集
 *
 * どれも store を読んで app を呼び返すだけで、worker や Capstone には触らない。
 */
import {
  Sheet, el, button, list, groupRow, kvRow, tapRow, toast, copyText, alertDialog, menu,
  heading, para, codeBlock, noteBox, bullets, termChips, block, bigValue, disclosure,
} from './ui.js';
import { addrHex, addrText, sizeText, parseAddress, parseHexPattern } from './format.js';
import { rangeCopyMenu } from './rangecopy.js';
import { t, isJa, pick } from './i18n.js';
import { explain, operandNotes, categoryLabel, isBranch, isCall } from './arm64.js';
import { GLOSSARY, searchGlossary } from './glossary.js';
import { CHAPTERS, loadProgress, saveProgress } from './learn.js';
import { analyzeFunctionCached, describeFunction } from './analyze.js';
import { levelOf } from './blocks.js';
import {
  functionStory, blockTitle, blockHeading, blockSummary, roleTag, buildOverlay,
  confidenceText, evidenceText, describeValue,
} from './narrate.js';
import { groupByFeature, detectEngine } from './features.js';
import { SAMPLE_GUIDE } from './sample.js';
import { GOALS, goalFromPreset, parseGoal, goalLabel } from './goals.js';
import { rankCandidates, breakdown, reasonKind } from './rank.js';
import { buildFunctionReport } from './report.js';
import { outline } from './cfg.js';
import { traceForward, regKeyOf } from './dataflow.js';
import {
  starsText, reasonText, certaintyWord, factText, inferenceText, unknownText,
  nextStepText, updateLines, useText, shapeText, roleLabel,
  findingTitle, findingWhy, notableReasonText, autoStepText,
  typeWord, placeName, oneLiner, whatItDoes, changeVerb,
  verdictText, verdictLead, missingText, proofText, factorText, probabilityText,
  fnRoleTitle, fnRoleShort, fnRoleLead, fnRoleTargetLine, fnRoleAlternative, fnRoleTopicLine,
  roleProofText, roleMissingText,
} from './narrate.js';
import { autoAnalyze, autoNextSteps } from './auto.js';
import { plainFieldName } from './fields.js';
import { pinpointField, pinpointLocation } from './pinpoint.js';
import { columnToOffset } from './schema.js';
import { VERDICT } from './evidence.js';
import { roleFromReport, sketchRole, changesValue } from './role.js';

/* ── ファイル情報 ────────────────────────────────────────── */

export function showFileInfo(app) {
  const info = app.store.get('fileInfo');
  if (!info) return;
  const sheet = new Sheet(t('file.title'));
  const ul = list();

  ul.append(groupRow(t('file.group.file')));
  ul.append(kvRow(t('file.name'), info.name));
  ul.append(kvRow(t('file.size'), sizeText(info.size) + ' (' + info.size.toString() + ' bytes)'));
  ul.append(kvRow(t('file.format'), info.format));

  const slice = app.currentSlice();
  if (slice && slice.info) {
    const m = slice.info;
    ul.append(groupRow(t('file.group.macho')));
    ul.append(kvRow(t('file.type'), m.filetypeName + (m.filetypeName === 'MH_EXECUTE'
      ? pick('（アプリ本体）', ' (an application)')
      : m.filetypeName === 'MH_DYLIB' ? pick('（ライブラリ）', ' (a library)') : '')));
    ul.append(kvRow(t('file.cpu'), m.cpu));
    ul.append(kvRow(t('file.cpuSub'), m.cpuSub));
    ul.append(kvRow(t('file.magic'), m.magic));
    ul.append(kvRow(t('file.flags'), '0x' + (m.flags >>> 0).toString(16).toUpperCase()));
    if (m.platform) ul.append(kvRow(t('file.platform'), m.platform + (m.minos ? ' ' + m.minos : ''), m.sdk ? 'SDK ' + m.sdk : null));
    if (m.uuid) ul.append(kvRow(t('file.uuid'), m.uuid));
    ul.append(kvRow(t('file.loadCommands'), String(m.ncmds) + ' (' + sizeText(m.sizeofcmds) + ')'));
    ul.append(kvRow(t('file.codeSignature'), m.hasCodeSignature ? t('file.present') : t('file.none')));
    if (slice.offset > 0n) ul.append(kvRow(t('file.sliceOffset'), addrHex(slice.offset)));

    if (m.entry != null) {
      ul.append(tapRow(t('file.entry'), {
        sub: pick('プログラムが最初に実行する場所です', 'where execution begins'),
        right: addrHex(m.entry),
        onTap: () => { sheet.close(); app.goToAddress(m.entry, { announce: true }); },
      }));
    }
    if (m.encryption) {
      ul.append(kvRow(t('file.encryption'),
        m.encrypted ? 'cryptid ' + m.encryption.cryptid + pick('（暗号化されている）', ' (encrypted)') : 'cryptid 0'));
      if (m.encrypted) {
        const li = el('li');
        li.append(el('span', 'sub warn', pick(
          'この範囲（ファイル内 ' + addrHex(m.encryption.cryptoff) + ' 〜 ' +
            addrHex(m.encryption.cryptoff + m.encryption.cryptsize) + '）は暗号化されたままです。' +
            '復号するまで、意味のある命令にはなりません。',
          'This range is still encrypted and will not disassemble into meaningful code.')));
        ul.append(li);
      }
    }

    /* 名前の情報 */
    const sym = app.symbols;
    ul.append(groupRow(t('file.group.symbols')));
    ul.append(kvRow(t('file.symbolCount'), sym.symbolCount.toLocaleString()));
    ul.append(kvRow(t('file.functionCount'),
      sym.functionCount.toLocaleString() + (sym.guessed ? pick('（推測）', ' (inferred)') : '')));
    if (!sym.symbolCount) {
      const li = el('li');
      li.append(el('span', 'sub', t('functions.hintNoSymbols')));
      ul.append(li);
    }

    /* リンクしているライブラリ */
    if (m.dylibs && m.dylibs.length) {
      ul.append(groupRow(t('file.dylibs') + '  (' + m.dylibs.length + ')'));
      const li0 = el('li');
      li0.append(el('span', 'sub', pick(
        'このアプリが借りている外部の部品です。何を使っているか（通信・暗号・位置情報…）の手がかりになります。',
        'The external components this binary borrows.')));
      ul.append(li0);
      for (const d of m.dylibs) {
        const short = d.split('/').pop();
        ul.append(kvRow(short, '', d));
      }
    }

    const codeRegions = app.store.get('regions').filter((r) => r.exec && r.size > 0n);
    if (codeRegions.length) {
      ul.append(groupRow(t('file.group.code')));
      for (const r of codeRegions) {
        ul.append(tapRow(r.name, {
          sub: addrHex(r.vmAddr) + ' – ' + addrHex(r.vmAddr + r.size) + '  ·  ' + sizeText(r.size),
          onTap: () => { sheet.close(); app.selectRegion(r); },
        }));
      }
    }
  } else {
    const li = el('li');
    li.append(el('span', 'sub', t('file.rawOnly')));
    ul.append(li);
  }

  if (info.warnings && info.warnings.length) {
    ul.append(groupRow(t('file.group.notes')));
    for (const w of info.warnings) {
      const li = el('li');
      li.append(el('span', 'sub warn', w));
      ul.append(li);
    }
  }

  sheet.body.append(ul);
}

/* ── セクション ──────────────────────────────────────────── */

/** よく出るセクションに、日本語の一言を添える。 */
const SECTION_HINTS = {
  __text: ['機械語そのもの。ここが本体です', 'the machine code itself'],
  __stubs: ['外部ライブラリの関数へ中継する場所', 'jump pads into external libraries'],
  __auth_stubs: ['外部ライブラリへの中継（署名つき）', 'authenticated jump pads'],
  __cstring: ['文字列（"Hello" など）', 'string literals'],
  __const: ['書き換わらない定数', 'read-only constants'],
  __data: ['書き換わる変数', 'writable variables'],
  __bss: ['0 で始まる変数（ファイルには入っていない）', 'zero-initialised variables'],
  __common: ['0 で始まる共有変数', 'zero-initialised common variables'],
  __got: ['外部関数のアドレスを入れる箱', 'addresses of external functions'],
  __la_symbol_ptr: ['外部関数のアドレス（遅延解決）', 'lazily bound external addresses'],
  __nl_symbol_ptr: ['外部関数のアドレス（起動時に解決）', 'eagerly bound external addresses'],
  __objc_methname: ['Objective-C のメソッド名', 'Objective-C method names'],
  __objc_classname: ['Objective-C のクラス名', 'Objective-C class names'],
  __objc_selrefs: ['呼ばれるメソッド名への参照', 'references to selectors'],
  __objc_classlist: ['クラスの一覧', 'the list of classes'],
  __objc_const: ['Objective-C のクラス定義', 'Objective-C class definitions'],
  __swift5_types: ['Swift の型情報', 'Swift type metadata'],
  __cfstring: ['NSString / CFString の文字列', 'Foundation string objects'],
  __unwind_info: ['例外処理のための表', 'exception unwinding tables'],
  __eh_frame: ['例外処理のための表', 'exception handling frames'],
};

function sectionHint(name) {
  const h = SECTION_HINTS[name];
  return h ? pick(h[0], h[1]) : '';
}

export function showSections(app) {
  const info = app.store.get('fileInfo');
  if (!info) return;
  const sheet = new Sheet(t('sections.title'));
  const ul = list();
  const current = app.store.get('currentRegion');

  const hint = el('li');
  hint.append(el('span', 'sub', t('sections.hint')));
  ul.append(hint);

  if (info.slices.length > 1) {
    ul.append(groupRow(t('sections.arch')));
    info.slices.forEach((s, i) => {
      ul.append(tapRow(s.name, {
        sub: s.error ? s.error : sizeText(s.size) + ' at ' + addrHex(s.offset),
        right: i === app.store.get('sliceIndex') ? '✓' : '',
        disabled: !!s.error,
        onTap: () => { sheet.close(); app.selectSlice(i); },
      }));
    });
  }

  const slice = app.currentSlice();
  if (slice && slice.info) {
    for (const seg of slice.info.segments) {
      ul.append(groupRow(seg.name + '   ' + addrHex(seg.vmaddr) + ' · ' + sizeText(seg.vmsize)));
      if (!seg.sections.length) {
        ul.append(tapRow(t('sections.noSections'), { disabled: true, indent: true }));
      }
      for (const sec of seg.sections) {
        const region = app.store.get('regions').find(
          (r) => r.segment === sec.segment && r.section === sec.name && r.vmAddr === sec.addr);
        const disabled = !region || region.size === 0n;
        const extra = [
          addrHex(sec.addr) + ' – ' + addrHex(sec.addr + sec.size),
          sizeText(sec.size),
        ];
        if (sec.zerofill) extra.push(t('sections.zerofill'));
        if (region && region.truncated) extra.push(t('sections.truncated'));
        const hintText = sectionHint(sec.name);
        ul.append(tapRow(sec.name, {
          indent: true,
          sub: (hintText ? hintText + '\n' : '') + extra.join('  ·  '),
          tag: sec.exec ? t('sections.tagCode') : (sec.zerofill ? 'bss' : ''),
          tagClass: sec.exec ? 'exec' : '',
          right: current && region && current.id === region.id ? '✓' : '',
          disabled,
          onTap: () => { sheet.close(); app.selectRegion(region); },
        }));
      }
    }
  }

  ul.append(groupRow(t('sections.raw')));
  ul.append(tapRow(t('sections.wholeFile'), {
    sub: pick('ファイルの先頭から末尾まで、そのままのバイト列', 'every byte of the file, unstructured') +
      '\n0 – ' + addrHex(info.size) + '  ·  ' + sizeText(info.size),
    right: current && current.id === 'raw' ? '✓' : '',
    onTap: () => { sheet.close(); app.selectRegion(info.raw); },
  }));

  sheet.body.append(ul);
}

/* ── ファイルの構造 ──────────────────────────────────────── */

export function showStructure(app) {
  const info = app.store.get('fileInfo');
  if (!info) { toast(t('err.openFirst')); return; }
  const slice = app.currentSlice();
  const sheet = new Sheet(t('struct.title'));
  const body = sheet.body;

  body.append(para(t('struct.hint')));

  if (!slice || !slice.info) {
    body.append(noteBox(t('file.rawOnly')));
    return;
  }
  const m = slice.info;
  const base = slice.offset;
  const ul = list();

  /* ヘッダ */
  ul.append(groupRow('1. ' + t('struct.header')));
  const headLi = el('li');
  headLi.append(el('span', 'sub', t('struct.headerSub')));
  ul.append(headLi);
  const fields = [
    ['magic', 0, 4, m.magic, t('struct.field.magic')],
    ['cputype', 4, 4, m.cpu, t('struct.field.cputype')],
    ['filetype', 12, 4, m.filetypeName, t('struct.field.filetype')],
    ['ncmds', 16, 4, String(m.ncmds), t('struct.field.ncmds')],
    ['sizeofcmds', 20, 4, sizeText(m.sizeofcmds), t('struct.field.sizeofcmds')],
    ['flags', 24, 4, '0x' + (m.flags >>> 0).toString(16).toUpperCase(), t('struct.field.flags')],
  ];
  for (const [name, off, len, value, note] of fields) {
    ul.append(tapRow(name, {
      indent: true,
      sub: note + '\n' + t('struct.at', { offset: addrHex(base + BigInt(off)) }) +
           '  ·  ' + t('struct.bytes', { n: len }),
      right: value,
      onTap: () => { sheet.close(); app.goToFileOffset(base + BigInt(off)); },
    }));
  }

  /* ロードコマンド */
  ul.append(groupRow('2. ' + t('struct.commands')));
  const cmdLi = el('li');
  cmdLi.append(el('span', 'sub', t('struct.commandsSub', { n: m.ncmds })));
  ul.append(cmdLi);
  const counts = new Map();
  for (const c of m.commands) counts.set(c.name, (counts.get(c.name) || 0) + 1);
  for (const [name, n] of counts) {
    ul.append(kvRow(name, n > 1 ? '× ' + n : '1', commandHint(name)));
  }

  /* セグメント */
  ul.append(groupRow('3. ' + t('struct.segments')));
  for (const seg of m.segments) {
    const prot = protText(seg.initprot);
    ul.append(tapRow(seg.name, {
      sub: prot + '\n' + addrHex(seg.vmaddr) + ' – ' + addrHex(seg.vmaddr + seg.vmsize) +
        '  ·  ' + sizeText(seg.vmsize) +
        pick('  ·  ファイル内 ', '  ·  file ') + addrHex(base + seg.fileoff),
      right: seg.sections.length ? seg.sections.length + (isJa() ? ' 区画' : ' sections') : '',
      onTap: () => { sheet.close(); app.goToAddress(seg.vmaddr, { announce: true }); },
    }));
  }

  sheet.body.append(ul);
}

function protText(p) {
  const parts = [];
  if (p & 1) parts.push(pick('読める', 'read'));
  if (p & 2) parts.push(pick('書ける', 'write'));
  if (p & 4) parts.push(pick('実行できる', 'execute'));
  if (!parts.length) return pick('何もできない（わざと空けてある）', 'no access (deliberately empty)');
  return parts.join(pick('・', ' / '));
}

const CMD_HINTS = {
  LC_SEGMENT_64: ['メモリにこの塊を載せる', 'map this block into memory'],
  LC_SYMTAB: ['名前の一覧の場所', 'where the symbol table lives'],
  LC_DYSYMTAB: ['外部の名前の管理表', 'dynamic symbol bookkeeping'],
  LC_LOAD_DYLIB: ['このライブラリを繋ぐ', 'link against this library'],
  LC_LOAD_DYLINKER: ['起動を担当するプログラム', 'which program sets everything up'],
  LC_MAIN: ['ここから実行を始める', 'start executing here'],
  LC_UUID: ['このビルドを識別する番号', 'a unique id for this build'],
  LC_CODE_SIGNATURE: ['改ざんされていないことの証明', 'proof the file was not tampered with'],
  LC_FUNCTION_STARTS: ['関数の切れ目の一覧', 'where each function begins'],
  LC_BUILD_VERSION: ['どの OS 向けに作られたか', 'which OS this was built for'],
  LC_ENCRYPTION_INFO_64: ['暗号化されている範囲', 'which part is encrypted'],
  LC_DYLD_CHAINED_FIXUPS: ['起動時に埋めるアドレスの表', 'addresses dyld fills in at launch'],
  LC_DYLD_EXPORTS_TRIE: ['外部に公開する名前の表', 'names this image exports'],
  LC_RPATH: ['ライブラリを探す場所', 'where to look for libraries'],
};
function commandHint(name) {
  const h = CMD_HINTS[name];
  return h ? pick(h[0], h[1]) : null;
}

/* ── 関数の一覧 ──────────────────────────────────────────── */

export function showFunctions(app) {
  const region = app.store.get('currentRegion');
  if (!region) { toast(t('err.openFirst')); return; }
  const sheet = new Sheet(t('functions.title'), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onScanProgress = null; },
  });

  const status = el('div', 'hint', '');
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill);
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.placeholder = t('functions.search');
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(input);
  const results = list();
  sheet.body.append(field, bar, status, results);

  let all = [];

  const render = () => {
    const q = input.value.trim().toLowerCase();
    const items = q
      ? all.filter((f) => (f.name || '').toLowerCase().includes(q) ||
                          f.addr.toString(16).includes(q.replace(/^0x/, '')))
      : all;
    results.replaceChildren();
    let shown = 0;
    const PAGE = 120;
    const more = tapRow(t('search.more'), { onTap: () => page() });
    const page = () => {
      more.remove();
      const frag = document.createDocumentFragment();
      const end = Math.min(items.length, shown + PAGE);
      for (; shown < end; shown++) {
        const f = items[shown];
        const sub = [addrHex(f.addr)];
        if (f.size != null && f.size > 0n) {
          sub.push(Number(f.size / 4n).toLocaleString() + pick(' 命令', ' instructions'));
        }
        frag.append(tapRow(f.name || t('functions.unnamed'), {
          sub: sub.join('  ·  '),
          onTap: () => { sheet.close(); app.goToFunction(f.addr); },
        }));
      }
      results.append(frag);
      if (shown < items.length) {
        more.replaceChildren();
        more.append(el('div', null, t('search.showMore', { n: Math.min(PAGE, items.length - shown) })));
        results.append(more);
      }
    };
    if (items.length) page();
    else results.append(tapRow(t('functions.none'), { disabled: true }));
  };

  input.addEventListener('input', render);

  const start = async () => {
    const sym = app.symbols;
    if (sym.functionCount > 0) {
      all = sym.functionList(region);
      fill.style.width = '100%';
      status.textContent = sym.guessed
        ? t('functions.hintNoSymbols')
        : t('functions.hintSymbols', { n: all.length.toLocaleString() });
      render();
      return;
    }
    // LC_FUNCTION_STARTS がない → 命令の並びから推測する（推測は app 側に一本化）
    status.textContent = t('functions.analyzing');
    try {
      const guessed = await app.ensureFunctions(region, (p) => {
        if (!p.all) return;
        fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
      });
      fill.style.width = '100%';
      all = guessed.functionList(region);
      status.textContent = all.length ? t('functions.hintNoSymbols') : t('functions.none');
      render();
    } catch (err) {
      status.textContent = '';
      alertDialog(t('search.failed'), err.message || String(err));
    }
  };
  start();
}

/* ── 関数の要約 ──────────────────────────────────────────── */

export function showFunctionSummary(app, row) {
  const region = app.store.get('currentRegion');
  if (!region) return;
  const sym = app.symbols;
  const addr = region.vmAddr + BigInt(row) * 4n;

  let startRow = row, endRow = row;
  let name = null;
  const fn = sym.functionCount ? sym.functionAt(addr) : null;
  if (fn && fn.start >= region.vmAddr) {
    startRow = Number((fn.start - region.vmAddr) / 4n);
    endRow = fn.end != null
      ? Math.min(app.viewer.totalRows - 1, Number((fn.end - region.vmAddr) / 4n) - 1)
      : app.viewer.totalRows - 1;
    name = sym.nameAt(fn.start);
  } else {
    // 関数の情報がないときは、前後の ret を目印に、ゆるく範囲を決める
    endRow = Math.min(app.viewer.totalRows - 1, row + 512);
  }

  const sheet = new Sheet(t('functions.summaryTitle'));
  const status = el('div', 'hint', t('functions.analyzing'));
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill);
  sheet.body.append(bar, status);

  analyzeFunctionCached(app.backend, region, startRow, endRow, sym,
    (p) => { fill.style.width = Math.round(p * 100) + '%'; })
    .then((res) => {
      status.remove();
      bar.remove();
      applySemantic(app, region, res);
      renderFunctionSummary(app, sheet, res, name, region);
    })
    .catch((err) => {
      status.textContent = '';
      alertDialog(t('search.failed'), err.message || String(err));
    });
}

/**
 * 解析済みモデルをビューアの表示（帯と見出し）に反映する。
 * ビューアは表を引くだけで、解析は一切しない。
 */
export function applySemantic(app, region, res) {
  if (!res || !res.model) return;
  app.semantic = { regionId: region.id, model: res.model, result: res };
  app.viewer.setBlockOverlay(region.id, buildOverlay(res.model));
}

/** いま表示している行に対応する Semantic Block（なければ null）。 */
function semanticBlockAt(app, row) {
  const s = app.semantic;
  const region = app.store.get('currentRegion');
  if (!s || !region || s.regionId !== region.id) return null;
  return s.model.blockOfRow(row);
}

/* ── 関数を開いたら、まず日本語。次に処理。最後に ARM64。 ── */

function renderFunctionSummary(app, sheet, res, name, region) {
  const body = sheet.body;
  const model = res.model;

  const head = el('div', 'fn-head');
  head.append(el('div', 'fn-name', name || t('functions.unnamed')));
  head.append(el('div', 'fn-range mono',
    addrHex(res.startAddr) + ' – ' + addrHex(res.endAddr)));
  body.append(head);

  /*
   * 0. この関数の名前。`sub_100A3C0` のままでは何も分からないので、
   *    アプリの言葉で名指しし直す（役割）。ここだけ読めば用が足りるように。
   */
  try {
    const report = buildFunctionReport({
      model, region, symbols: app.symbols, name,
      fields: app.fields, owner: app.ownerOf(res.startAddr),
    });
    const role = roleFromReport(report, { apis: model.facts.apis });
    if (role) body.append(roleSection(app, role, sheet, region));
  } catch { /* 名指しに失敗しても、下の説明は出す */ }

  /* 1. 日本語 — 命令を一切見せずに「何をしているか」 */
  body.append(storySection(app, model, name, sheet));

  /* 2. 処理のまとまり */
  body.append(disclosure(pick('詳細を見る（処理のまとまり）', 'Show the steps in detail'), {
    build: (into) => into.append(blockListSection(app, model, sheet, region)),
  }));

  /* 3. ARM64 と数字 */
  body.append(disclosure(pick('ARM64 を見る（命令と数字）', 'Show the ARM64 details'), {
    build: (into) => into.append(rawSection(app, sheet, res, name, region)),
  }));

  const actions = el('div', 'detail-actions');
  actions.append(button(t('fn.goto'), 'chip', () => {
    sheet.close();
    app.goToAddress(res.startAddr, { announce: true });
  }));
  actions.append(button(pick('この関数を呼んでいる場所', 'Find who calls this'), 'chip', () => {
    sheet.close();
    showXrefs(app, res.startAddr);
  }));
  body.append(actions);
}

/** 「この処理では、A → B → C しています」。最初に見せるのはこれ。 */
function storySection(app, model, name, sheet) {
  const wrap = el('div', 'story');
  const story = functionStory(model, name);

  wrap.append(el('div', 'story-head', story.headline));

  const lead = el('p', 'doc-p');
  lead.textContent = pick('この処理では、次のことをしています。', 'This routine does the following.');
  wrap.append(lead);

  const ol = el('ul', 'story-steps');
  story.steps.forEach((s, i) => {
    const li = el('li');
    li.append(el('i', null, String(i + 1) + '.'));
    li.append(el('span', null, s));
    ol.append(li);
  });
  wrap.append(ol);

  for (const line of story.purpose) wrap.append(para(line));

  const conf = el('span', 'conf lv-' + levelOf(story.confidence), confidenceText(story.confidence));
  wrap.append(conf);

  if (story.evidence.length) {
    wrap.append(el('div', 'blk-title', pick('この判断の根拠', 'What this is based on')));
    wrap.append(bullets(story.evidence));
  }
  wrap.append(para(pick(
    '※ ここに書いてあるのは、命令の並びから読み取れた範囲のことだけです。' +
    '根拠のない決めつけはしていません。分からないものは「分かりません」と書いています。',
    'Everything above comes from the instructions themselves. Nothing is asserted without evidence.'), 'sub'));
  void sheet;
  void app;
  return wrap;
}

/** 処理のまとまり一覧。タップでその行へ飛べる（処理 → ARM64 の道筋）。 */
function blockListSection(app, model, sheet, region) {
  const ul = list();
  if (!model.semantic.length) {
    ul.append(tapRow(pick('処理のまとまりを取り出せませんでした。', 'No steps could be extracted.'),
      { disabled: true }));
    return ul;
  }
  ul.append(groupRow(pick('処理のまとまり  (' + model.semantic.length + ')',
    'Steps  (' + model.semantic.length + ')')));
  for (const b of model.semantic) {
    const lines = blockSummary(b, model);
    const rowEl = tapRow(blockHeading(b), {
      sub: (lines[0] || '') + '\n' +
        addrHex(region.vmAddr + BigInt(b.startRow) * 4n) +
        '  ·  ' + pick(b.instructions.length + ' 命令', b.instructions.length + ' instructions'),
      onTap: () => { sheet.close(); showBlockDetail(app, model, b, region); },
    });
    ul.append(rowEl);
  }
  if (model.truncated) {
    ul.append(tapRow(pick('※ 大きすぎるため、途中までを解析しています。',
      'Note: too large — only the first part was analysed.'), { disabled: true }));
  }
  return ul;
}

/** ひとつの「処理」の詳細。ここで初めて ARM64 が出てくる。 */
export function showBlockDetail(app, model, b, region) {
  const sheet = new Sheet(blockTitle(b));
  const body = sheet.body;
  const addrOf = (row) => region.vmAddr + BigInt(row) * 4n;

  const head = el('div', 'det-head');
  head.append(el('div', 'det-addr mono', addrHex(addrOf(b.startRow)) + ' – ' + addrHex(addrOf(b.endRow))));
  head.append(el('div', 'sb-role', roleTag(b.role)));
  body.append(head);

  const what = block(t('detail.what'));
  what.append(el('div', 'det-title', blockTitle(b)));
  for (const line of blockSummary(b, model)) what.append(para(line));
  what.append(el('span', 'conf lv-' + b.level, confidenceText(b.confidence)));
  body.append(what);

  /* この処理が受け取っている値（Phase 6: レジスタの意味） */
  const known = (b.inputs || []).filter((i) => i.value && i.value.kind !== 'unknown');
  if (known.length) {
    const bi = block(pick('この処理が使っている値', 'Values this step uses'));
    const ul = list();
    for (const i of known.slice(0, 6)) ul.append(kvRow(i.reg, '', describeValue(i.value)));
    bi.append(ul);
    body.append(bi);
  }

  /* 根拠 */
  const evs = [];
  for (const e of b.evidence) {
    const text = evidenceText(e);
    if (text && !evs.includes(text)) evs.push(text);
  }
  if (evs.length) {
    const be = block(pick('根拠', 'Evidence'));
    be.append(bullets(evs.slice(0, 8)));
    body.append(be);
  }

  /* 呼び出し先へ辿る */
  if (b.calls.length) {
    const bc = list();
    bc.append(groupRow(pick('この中で呼んでいる処理', 'What it calls here')));
    for (const c of b.calls) {
      bc.append(tapRow(c.name || (c.target != null ? addrHex(c.target) : pick('行き先は実行時に決まります', 'resolved at run time')), {
        sub: c.target != null ? addrHex(c.target) : '',
        disabled: c.target == null,
        onTap: () => { sheet.close(); app.goToAddress(c.target, { announce: true }); },
      }));
    }
    body.append(bc);
  }

  /* 最後に ARM64 */
  body.append(disclosure(pick('ARM64 を見る', 'Show the ARM64'), {
    build: (into) => {
      const lines = b.instructions.map((i) =>
        addrText(addrOf(i.row)) + '  ' + i.mnemonic + (i.operands ? ' ' + i.operands : ''));
      into.append(codeBlock(lines));
    },
  }));

  const actions = el('div', 'detail-actions');
  actions.append(button(pick('この処理の先頭へ移動', 'Go to this step'), 'chip', () => {
    sheet.close();
    app.viewer.goToRow(b.startRow, 'third');
    app.viewer.select(b.startRow, false);
    app.viewer.mark(b.startRow);
  }));
  body.append(actions);
}

/** 既存の数字・呼び出し・ループ・文字列。いちばん奥に置く。 */
function rawSection(app, sheet, res, name, region) {
  const wrap = el('div');

  const story = block(t('fn.story'));
  for (const line of describeFunction(res, name)) story.append(para(line));
  wrap.append(story);

  /* 数字 */
  const ul = list();
  ul.append(kvRow(t('fn.instructions'), res.instructions.toLocaleString()));
  ul.append(kvRow(t('fn.size'), sizeText(Number(res.endAddr - res.startAddr) + 4)));
  ul.append(kvRow(t('fn.frame'), res.frameBytes > 0
    ? res.frameBytes + pick(' バイト', ' bytes') : t('fn.frameNone')));
  ul.append(kvRow(t('fn.memory'), t('fn.memoryN', { load: res.loads, store: res.stores })));
  ul.append(kvRow(t('fn.branches'), res.condBranches
    ? t('fn.branchesN', { n: res.condBranches }) : pick('なし', 'none')));
  ul.append(kvRow(t('fn.loops'), res.loops.length
    ? t('fn.loopsN', { n: res.loops.length }) : t('fn.loopsNone')));
  ul.append(kvRow(t('fn.returns'), String(res.returns)));
  wrap.append(ul);

  /* 呼び出している関数 */
  if (res.calls.length) {
    const seen = new Map();
    for (const c of res.calls) {
      const key = c.name || (c.target != null ? addrHex(c.target) : '?');
      if (!seen.has(key)) seen.set(key, { ...c, count: 0 });
      seen.get(key).count++;
    }
    const cul = list();
    cul.append(groupRow(t('fn.calls') + '  (' + seen.size + ')'));
    for (const [key, c] of seen) {
      cul.append(tapRow(key, {
        sub: c.target != null ? addrHex(c.target) : '',
        right: c.count > 1 ? '× ' + c.count : '',
        onTap: () => {
          if (c.target == null) return;
          sheet.close();
          app.goToAddress(c.target, { announce: true });
        },
      }));
    }
    wrap.append(cul);
  }

  /* ループの位置 */
  if (res.loops.length) {
    const lul = list();
    lul.append(groupRow(t('fn.loops')));
    for (const l of res.loops.slice(0, 20)) {
      lul.append(tapRow(addrHex(l.to) + ' ← ' + addrHex(l.from), {
        sub: pick('ここへ戻って繰り返しています', 'jumps back here to repeat'),
        onTap: () => { sheet.close(); app.goToAddress(l.to, { announce: true }); },
      }));
    }
    wrap.append(lul);
  }

  /* 指している文字列 */
  if (res.stringRefs.length) {
    const sul = list();
    sul.append(groupRow(pick('この関数が指しているデータ', 'Data this function points at')));
    wrap.append(sul);
    const seen = new Set();
    let shown = 0;
    for (const r of res.stringRefs) {
      if (shown >= 24) break;
      const key = r.addr.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      shown++;
      const rowEl = tapRow(addrHex(r.addr), {
        sub: pick('読み込み中…', 'loading…'),
        onTap: () => { sheet.close(); app.goToAddress(r.addr, { announce: true }); },
      });
      sul.append(rowEl);
      app.backend.readAt(r.addr, 120, true).then((got) => {
        const subEl = rowEl.querySelector('.sub');
        if (!subEl) return;
        if (got.found && got.text) subEl.textContent = '"' + got.text + '"';
        else if (got.found) subEl.textContent = got.region;
        else subEl.textContent = pick('（このファイルの外）', '(outside the file)');
      }).catch(() => {});
    }
  }

  void region;
  return wrap;
}

/* ── 機能から探す ────────────────────────────────────────────
   関数が 1 万個あるファイルで「この関数は何をしているか」だけ分かっても、
   ゲームのどこの処理かは分からない。逆から辿るための入口をここに置く。

     機能 → その機能の言葉（文字列）→ 使っている場所 → 関数 → 意味 */

export function showFeatures(app) {
  const info = app.store.get('fileInfo');
  if (!info) { toast(t('err.openFirst')); return; }
  const sheet = new Sheet(pick('機能から探す', 'Find by feature'), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onScanProgress = null; },
  });

  const status = el('div', 'hint', pick(
    'アプリの中の言葉を集めて、機能ごとに束ねます。少し待ってください。',
    'Collecting the words inside the app and grouping them by feature…'));
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill);
  const body = el('div');
  sheet.body.append(bar, status, body);

  const render = (index) => {
    bar.remove();
    body.replaceChildren();

    if (index.engine) {
      const nb = noteBox(index.engine.note);
      body.append(nb);
    }
    status.textContent = pick(
      '知りたい機能を選ぶと、その機能に関係のありそうな言葉が並びます。' +
      '言葉を選ぶと、それを使っている場所＝その機能を担当している関数にたどり着けます。',
      'Pick a feature, then a word, then the code that uses it.');

    const ul = list();
    if (!index.features.length) {
      ul.append(tapRow(pick(
        '手がかりになる言葉が見つかりませんでした。文字列が暗号化・難読化されているか、' +
        'ゲームの中身が別のファイル（il2cpp など）にある可能性があります。',
        'No usable words were found — the strings may be obfuscated, or the game logic may live in another file.'),
        { disabled: true }));
    }
    for (const f of index.features) {
      ul.append(tapRow(f.label, {
        right: String(f.items.length),
        sub: f.items.slice(0, 2).map((i) => '「' + trimText(i.text, 28) + '」').join('  '),
        onTap: () => { sheet.close(); showFeatureWords(app, f); },
      }));
    }
    body.append(ul);
    body.append(para(pick(
      '※ 言葉が近くにあるからといって、その関数がその機能そのものだとは限りません。' +
      'あくまで「探し始める場所」として使ってください。',
      'A nearby word does not prove what the function is for — treat this as a place to start looking.'), 'sub'));
  };

  if (app.featureIndex) { render(app.featureIndex); return; }

  app.backend.onScanProgress = (p) => {
    if (!p.all) return;
    fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
  };
  collectStrings(app).then((strings) => {
    app.backend.onScanProgress = null;
    const index = {
      features: groupByFeature(strings),
      engine: detectEngine(strings),
      count: strings.length,
    };
    app.featureIndex = index;
    render(index);
  }).catch((err) => {
    app.backend.onScanProgress = null;
    bar.remove();
    status.textContent = '';
    alertDialog(t('search.failed'), err.message || String(err));
  });
}

/** 文字列を集める。収集とキャッシュは app 側に置いてある（何度も走査しないため）。 */
function collectStrings(app) { return app.ensureStrings(); }

/** ある機能に属する言葉の一覧。 */
function showFeatureWords(app, feature) {
  const sheet = new Sheet(feature.label);
  sheet.body.append(el('div', 'hint', pick(
    'この機能に関係のありそうな言葉です。上にあるものほど手がかりとして濃いものです。\n' +
    '言葉を選ぶと、それを使っている場所を探します。',
    'Words that look related to this feature, strongest first. Pick one to find the code that uses it.')));
  const ul = list();
  for (const item of feature.items.slice(0, 150)) {
    ul.append(tapRow(trimText(item.text, 60), {
      sub: addrHex(item.addr),
      right: item.score >= 0.75 ? '●' : item.score >= 0.5 ? '◐' : '○',
      onTap: () => { sheet.close(); showXrefs(app, item.addr); },
    }));
  }
  sheet.body.append(ul);
}

function trimText(s, n) {
  const text = String(s || '').replace(/\s+/g, ' ');
  return text.length > n ? text.slice(0, n) + '…' : text;
}

/* ── 文字列の一覧 ────────────────────────────────────────── */

export function showStrings(app) {
  const info = app.store.get('fileInfo');
  if (!info) { toast(t('err.openFirst')); return; }
  const sheet = new Sheet(t('strings.title'), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onScanProgress = null; },
  });

  /* 文字列は __cstring などにまとまっている。なければ今のセクションを見る。 */
  const regions = app.store.get('regions') || [];
  const candidates = regions.filter((r) => r.size > 0n &&
    (r.cstrings || /string|cstring|objc_method|objc_class|__const/i.test(r.section || '')));
  const current = app.store.get('currentRegion');
  const targets = candidates.length ? candidates : (current ? [current] : []);

  const chips = el('div', 'chips');
  const status = el('div', 'hint', t('strings.hint'));
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill);
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.placeholder = t('strings.filter');
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(input);
  const results = list();
  sheet.body.append(chips, field, bar, status, results);

  let all = [];
  let active = targets[0] || null;

  const render = () => {
    const q = input.value.trim().toLowerCase();
    const items = q ? all.filter((s) => s.text.toLowerCase().includes(q)) : all;
    results.replaceChildren();
    let shown = 0;
    const PAGE = 120;
    const more = tapRow(t('search.more'), { onTap: () => page() });
    const page = () => {
      more.remove();
      const frag = document.createDocumentFragment();
      const end = Math.min(items.length, shown + PAGE);
      for (; shown < end; shown++) {
        const s = items[shown];
        frag.append(tapRow(s.text, {
          sub: addrHex(s.addr),
          onTap: () => { sheet.close(); app.goToStringAddress(active, s.addr); },
        }));
      }
      results.append(frag);
      if (shown < items.length) {
        more.replaceChildren();
        more.append(el('div', null, t('search.showMore', { n: Math.min(PAGE, items.length - shown) })));
        results.append(more);
      }
    };
    if (items.length) page();
    else results.append(tapRow(t('strings.none'), { disabled: true }));
  };
  input.addEventListener('input', render);

  const scan = async (region) => {
    active = region;
    for (const c of chips.children) c.setAttribute('aria-pressed', String(c._region === region));
    results.replaceChildren();
    all = [];
    status.textContent = t('strings.scanning');
    fill.style.width = '0%';
    app.backend.onScanProgress = (p) => {
      if (!p.all) return;
      fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
    };
    try {
      const res = await app.backend.strings({ regionId: region.id, min: 4 });
      app.backend.onScanProgress = null;
      fill.style.width = '100%';
      all = res.results;
      status.textContent = t('strings.count', { n: all.length.toLocaleString() }) +
        (res.capped ? t('strings.capped', { n: all.length.toLocaleString() }) : '') +
        '\n' + t('strings.hint');
      render();
    } catch (err) {
      app.backend.onScanProgress = null;
      status.textContent = '';
      alertDialog(t('search.failed'), err.message || String(err));
    }
  };

  for (const r of targets) {
    const c = button(r.section || r.name, 'chip', () => scan(r));
    c._region = r;
    chips.append(c);
  }
  if (active) scan(active);
  else status.textContent = t('strings.none');
}

/* ── アドレスへジャンプ ──────────────────────────────────── */

export function showJump(app) {
  const region = app.store.get('currentRegion');
  if (!region) return;
  const sheet = new Sheet(t('jump.title'));

  const field = el('div', 'field');
  const input = el('input');
  input.type = 'text';
  input.inputMode = 'text';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = '0x' + addrText(region.vmAddr);
  field.append(input, button(t('btn.go'), 'chip', go));
  sheet.body.append(field);

  sheet.body.append(el('div', 'hint', t('jump.hint', {
    from: addrHex(region.vmAddr),
    to: addrHex(region.vmAddr + region.size),
  })));

  const quick = list();
  quick.append(groupRow(t('jump.group')));
  quick.append(tapRow(t('jump.sectionStart'), {
    right: addrHex(region.vmAddr),
    onTap: () => { sheet.close(); app.goToAddress(region.vmAddr); },
  }));
  quick.append(tapRow(t('jump.sectionEnd'), {
    right: addrHex(region.vmAddr + region.size),
    onTap: () => { sheet.close(); app.viewer.goToRow(app.viewer.totalRows - 1, 'top'); },
  }));
  const slice = app.currentSlice();
  if (slice && slice.info && slice.info.entry != null) {
    quick.append(tapRow(t('jump.entry'), {
      right: addrHex(slice.info.entry),
      onTap: () => { sheet.close(); app.goToAddress(slice.info.entry, { announce: true }); },
    }));
  }
  sheet.body.append(quick);

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  setTimeout(() => input.focus(), 50);

  function go() {
    const v = parseAddress(input.value);
    if (v == null) { toast(t('jump.invalid')); return; }
    sheet.close();
    app.goToAddress(v, { announce: true });
  }
}

/* ── 検索 ────────────────────────────────────────────────── */

export function showSearch(app) {
  const region = app.store.get('currentRegion');
  if (!region) return;
  const sheet = new Sheet(t('search.title'), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onSearchProgress = null; },
  });

  let kind = app.store.get('searchKind') || 'asm';

  const chips = el('div', 'chips');
  const defs = [
    ['asm', t('search.kind.asm')],
    ['text', t('search.kind.text')],
    ['hex', t('search.kind.hex')],
    ['addr', t('search.kind.addr')],
  ];
  const chipEls = new Map();
  for (const [k, label] of defs) {
    const c = button(label, 'chip', () => setKind(k));
    c.setAttribute('aria-pressed', String(k === kind));
    chipEls.set(k, c);
    chips.append(c);
  }

  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = app.store.get('searchQuery') || '';
  const goBtn = button(t('btn.find'), 'chip', () => (running ? stop() : run()));
  field.append(input, goBtn);

  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill);

  const status = el('div', 'hint', '');
  const results = list();

  sheet.body.append(chips, field, bar, status, results);
  setKind(kind);
  setTimeout(() => input.focus(), 50);

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  let running = false;

  function setKind(k) {
    kind = k;
    app.store.set({ searchKind: k });
    for (const [key, c] of chipEls) c.setAttribute('aria-pressed', String(key === k));
    input.placeholder = t('search.ph.' + k);
    status.textContent = t('search.help.' + k, { region: region.name });
  }

  function run() {
    const q = input.value.trim();
    app.store.set({ searchQuery: q });
    if (!q) { toast(t('search.needQuery')); return; }

    if (kind === 'addr') {
      const v = parseAddress(q);
      if (v == null) { toast(t('search.badAddr')); return; }
      sheet.close();
      app.goToAddress(v, { announce: true });
      return;
    }
    if (running) app.backend.cancelSearch();

    results.replaceChildren();
    fill.style.width = '0%';
    status.textContent = t('search.searching');
    running = true;
    goBtn.textContent = t('btn.stop');

    const params = { regionId: region.id, kind, from: 0 };
    if (kind === 'hex') {
      const pat = parseHexPattern(q);
      if (!pat) { toast(t('search.badHex')); running = false; goBtn.textContent = t('btn.find'); return; }
      params.hex = pat;
    } else {
      params.query = q;
    }

    app.backend.onSearchProgress = (p) => {
      if (!p.all) return;
      fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
      status.textContent = t('search.searchingN', { n: p.hits });
    };

    app.backend.search(params).then((res) => {
      running = false;
      goBtn.textContent = t('btn.find');
      app.backend.onSearchProgress = null;
      fill.style.width = '100%';
      if (res.cancelled) status.textContent = t('search.stopped', { n: res.results.length });
      else if (!res.results.length) status.textContent = t('search.none', { region: region.name });
      else {
        status.textContent = t('search.count', { n: res.results.length }) +
          (res.capped ? t('search.capped', { n: res.results.length }) : '');
      }
      render(res.results);
    }).catch((err) => {
      running = false;
      goBtn.textContent = t('btn.find');
      app.backend.onSearchProgress = null;
      status.textContent = '';
      alertDialog(t('search.failed'), err.message || String(err));
    });
  }

  function stop() {
    app.backend.cancelSearch();
    running = false;
    goBtn.textContent = t('btn.find');
    status.textContent = t('search.stopped', { n: 0 });
  }

  const PAGE = 150;

  function render(items) {
    results.replaceChildren();
    let shown = 0;
    const more = tapRow(t('search.more'), { onTap: () => page() });

    const page = () => {
      more.remove();
      const frag = document.createDocumentFragment();
      const end = Math.min(items.length, shown + PAGE);
      for (; shown < end; shown++) {
        const it = items[shown];
        frag.append(tapRow(addrText(it.addr), {
          sub: it.text,
          onTap: () => {
            sheet.close();
            app.viewer.goToRow(it.row, 'third');
            app.viewer.mark(it.row);
            app.viewer.select(it.row, false);
            app.store.set({ selectedRow: it.row });
          },
        }));
      }
      results.append(frag);
      if (shown < items.length) {
        more.replaceChildren();
        more.append(el('div', null, t('search.showMore', { n: Math.min(PAGE, items.length - shown) })));
        results.append(more);
      }
    };
    if (items.length) page();
  }
}

/* ── 参照元（ここを使っている場所） ──────────────────────── */

export function showXrefs(app, target) {
  const region = app.store.get('currentRegion');
  if (!region) return;
  const codeRegion = pickCodeRegion(app) || region;
  const sheet = new Sheet(t('xref.title'), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onScanProgress = null; },
  });

  sheet.body.append(el('div', 'hint',
    addrHex(target) + '\n' + t('xref.hint') + '\n' + pick(
      'ここに出てくる関数が、この言葉を扱っている＝その機能を担当している候補です。',
      'The functions listed here are the ones that touch this — your candidates for the feature.')));
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill);
  const status = el('div', 'hint', t('xref.scanning'));
  const results = list();
  sheet.body.append(bar, status, results);

  app.backend.onScanProgress = (p) => {
    if (!p.all) return;
    fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
  };

  app.backend.xrefs({ regionId: codeRegion.id, target }).then((res) => {
    app.backend.onScanProgress = null;
    fill.style.width = '100%';
    if (!res.results.length) { status.textContent = t('xref.none'); return; }
    status.textContent = t('xref.count', { n: res.results.length });
    const sym = app.symbols;
    for (const r of res.results.slice(0, 400)) {
      const fn = sym.functionCount ? sym.functionAt(r.addr) : null;
      const owner = fn ? (sym.nameAt(fn.start) || addrHex(fn.start)) : null;
      results.append(tapRow(owner || addrHex(r.addr), {
        sub: (owner ? addrHex(r.addr) + '  ·  ' : '') + xrefKind(r.kind) +
          (fn ? pick('\nタップすると、この関数が何をしているかまで解析します',
            '\nTap to jump here and analyse the surrounding function') : ''),
        onTap: () => {
          sheet.close();
          if (codeRegion !== region) app.selectRegion(codeRegion, { silent: true });
          app.viewer.goToRow(r.row, 'third');
          app.viewer.mark(r.row);
          app.viewer.select(r.row, false);
          // その場所を含む関数まで解析して、処理の区切りを出す（機能 → 関数 → 処理）
          app.analyzeFunctionAt(app.viewer.rowAddress(r.row));
        },
      }));
    }
  }).catch((err) => {
    app.backend.onScanProgress = null;
    status.textContent = '';
    alertDialog(t('search.failed'), err.message || String(err));
  });
}

function xrefKind(k) {
  if (k === 'branch') return pick('ここへ飛んでいる', 'branches here');
  if (k === 'load') return pick('ここの中身を読んでいる', 'loads from here');
  return pick('ここのアドレスを作っている', 'builds this address');
}

function pickCodeRegion(app) {
  const regions = app.store.get('regions') || [];
  return regions.find((r) => r.section === '__text' && r.size > 0n) ||
         regions.find((r) => r.exec && r.size > 0n) || null;
}

/* ── 命令の詳細（このアプリの主役） ──────────────────────── */

export function showDetail(app, row) {
  const sheet = new Sheet(t('detail.title'), {
    anchor: 'bottom', dim: 'light',
    onClose: () => { app.detailRefresh = null; },
  });
  const body = sheet.body;
  const region = app.store.get('currentRegion');

  const container = el('div', 'detail');
  body.append(container);

  const refresh = () => {
    const d = app.viewer.rowData(row);
    if (!d) return null;
    container.replaceChildren();
    renderDetail(app, sheet, container, d, row, region);
    return d;
  };
  refresh();
  // チャンクが遅れて届いたら、命令名が埋まった時点で描き直す
  app.detailRefresh = () => {
    const d = app.viewer.rowData(row);
    if (d && d.mnemonic != null && !container.dataset.filled) refresh();
  };
}

function renderDetail(app, sheet, root, d, row, region) {
  const canAsm = app.store.get('canDisassemble') && app.store.get('displayMode') === 'asm';
  const mn = d.mnemonic;
  const ops = d.operands || '';
  const sym = app.symbols;

  if (mn == null) {
    root.append(para(t('detail.notLoaded')));
    return;
  }
  root.dataset.filled = '1';

  const ctx = {
    symbolFor: (a) => sym.nameAt(a),
    gen: sym.gen,
    prev: prevRow(app, row),
    next: null,
  };
  const e = canAsm ? explain(mn, ops, d.address, ctx) : null;

  /* 見出し: アドレスと、関数の中の位置 */
  const head = el('div', 'det-head');
  head.append(el('div', 'det-addr mono', addrHex(d.address)));
  const label = sym.functionCount ? sym.label(d.address) : null;
  if (label) head.append(el('div', 'det-fn', label));
  root.append(head);

  /* 命令そのもの */
  const insn = el('div', 'det-insn mono');
  insn.append(el('b', null, mn));
  if (ops) insn.append(document.createTextNode(' ' + ops));
  root.append(insn);

  /*
   * ARM64 → 処理 → 関数 → 機能 と、逆向きに辿れるようにする。
   * 解析済みの関数を見ているときだけ出る（ここで解析は始めない）。
   */
  const sb = region ? semanticBlockAt(app, row) : null;
  if (sb) {
    const bb = block(pick('この行が属する処理', 'The step this line belongs to'));
    bb.append(el('div', 'det-title', blockHeading(sb)));
    const first = blockSummary(sb, app.semantic.model)[0];
    if (first) bb.append(para(first));
    const bul = list();
    bul.append(tapRow(pick('この処理をくわしく見る', 'Open this step'), {
      sub: pick('処理 → 関数 → 呼び出し元、と辿れます', 'step → function → callers'),
      onTap: () => { sheet.close(); showBlockDetail(app, app.semantic.model, sb, region); },
    }));
    bb.append(bul);
    root.append(bb);
  }

  if (e) {
    /* ひとことで */
    const b1 = block(t('detail.what'));
    b1.append(el('div', 'det-title', e.title));
    if (e.summary) b1.append(para(e.summary));
    if (e.category) {
      const badge = el('span', 'cat-badge cat-' + e.category, categoryLabel(e.category));
      b1.append(badge);
    }
    root.append(b1);

    /* 式で書くと */
    if (e.pseudo) {
      const b2 = block(t('detail.pseudo'));
      b2.append(codeBlock(e.pseudo));
      root.append(b2);
    }

    /* くわしく */
    if (e.detail && e.detail.length) {
      const b3 = block(t('detail.detail'));
      for (const line of e.detail) b3.append(para(line));
      root.append(b3);
    }

    /* 部品の意味 */
    const notes = operandNotes(mn, ops);
    if (notes.length) {
      const b4 = block(t('detail.operands'));
      const ul = list();
      for (const n of notes) {
        if (!n.text) continue;
        ul.append(kvRow(n.name, '', n.text));
      }
      b4.append(ul);
      root.append(b4);
    }

    /* 飛び先・指し先 */
    if (e.target != null) {
      const b5 = block(isBranch(mn) || isCall(mn) ? t('detail.target') : pick('指しているアドレス', 'Address built'));
      const name = sym.nameAt(e.target);
      const btn = tapRow(name || addrHex(e.target), {
        sub: (name ? addrHex(e.target) + '  ·  ' : '') + t('detail.targetTap'),
        onTap: () => { sheet.close(); app.goToAddress(e.target, { announce: true }); },
      });
      const ul = list();
      ul.append(btn);
      b5.append(ul);
      root.append(b5);

      // その先に文字列があれば見せる（初心者にいちばん効く）
      if (!isBranch(mn) && !isCall(mn)) {
        app.backend.readAt(e.target, 160, true).then((got) => {
          if (!got.found || !got.text) return;
          const b6 = block(t('detail.string'));
          b6.append(el('div', 'det-string', '"' + got.text + '"'));
          b6.append(para(pick(
            'このアドレスには、読める文字列が置かれています。この命令は、その文字列の場所を用意しているところです。',
            'A readable string sits at that address; this instruction is setting up a pointer to it.')));
          root.insertBefore(b6, b5.nextSibling);
        }).catch(() => {});
      }
    }
  }

  /* バイトの中身 */
  if (d.bytes) {
    const b = block(t('detail.bytes'));
    b.append(bigValue(d.bytes, () => copyText(d.bytes, t('toast.copyHex'))));
    const word = wordValue(d.bytes);
    if (word != null) {
      b.append(para(t('detail.bytesHelp', {
        stored: d.bytes,
        value: '0x' + word.toString(16).toUpperCase().padStart(8, '0'),
      })));
      const bits = word.toString(2).padStart(32, '0');
      const grouped = bits.replace(/(.{8})(?=.)/g, '$1 ');
      const b7 = block(t('detail.binary'));
      b7.append(codeBlock(grouped));
      b7.append(para(pick(
        'この 32 個の 0 と 1 が、命令の種類・使うレジスタ・数値に区切られています。' +
        'どのビットが何を意味するかは命令ごとに決まっていて、CPU はそれを読み取って動きます。',
        'These 32 bits encode the operation, the registers and the immediate value.')));
      b.append(b7);
    }
    root.append(b);
  }

  /* 場所 */
  if (region) {
    const off = region.fileOffset + BigInt(row) * 4n;
    const b = block(t('detail.where'));
    b.append(para(t('detail.whereText', {
      region: region.name,
      offset: addrHex(off),
      row: (row + 1).toLocaleString(),
    })));
    root.append(b);
  }

  /* 用語 */
  if (e && e.terms && e.terms.length) {
    const uniq = [];
    for (const id of e.terms) if (GLOSSARY[id] && !uniq.includes(id)) uniq.push(id);
    if (uniq.length) {
      const b = block(t('detail.terms'));
      const chips = termChips(uniq, (id) => GLOSSARY[id].term, (id) => showTerm(app, id));
      if (chips) b.append(chips);
      root.append(b);
    }
  }

  /* できること */
  const actions = el('div', 'detail-actions');
  const asmText = ((mn || '') + ' ' + (ops || '')).trim();
  actions.append(
    button(t('detail.copyAddress'), 'chip', () => copyText(addrHex(d.address), t('toast.copyAddress'))),
    button(t('detail.copyHex'), 'chip', () => copyText(d.bytes || '', t('toast.copyHex'))),
    button(t('detail.copyAsm'), 'chip', () => copyText(asmText, t('toast.copyAsm'))));
  if (e) {
    actions.append(button(t('detail.copyExplain'), 'chip', () => {
      const text = [addrHex(d.address), asmText, e.title, e.summary, e.pseudo, ...(e.detail || [])]
        .filter(Boolean).join('\n');
      copyText(text, t('toast.copyExplain'));
    }));
  }
  actions.append(
    button(t('detail.findRefs'), 'chip', () => { sheet.close(); showXrefs(app, d.address); }),
    button(t('detail.selectRows'), 'chip', () => { sheet.close(); app.startSelection(row); }));
  if (canAsm) {
    actions.append(button(t('detail.showFunction'), 'chip', () => {
      sheet.close(); showFunctionSummary(app, row);
    }));
    actions.append(button(pick('この関数を調べる', 'Investigate this function'), 'chip', () => {
      sheet.close(); showFunctionReport(app, d.address, app.lastGoal);
    }));
    // 解析済みの関数の中の行なら、その値がこのあとどこへ行くかまで辿れる
    if (app.semantic && app.semantic.regionId === (region && region.id) &&
        app.semantic.model.blockOfRow(row)) {
      actions.append(button(pick('この値の行き先を追う', 'Follow this value'), 'chip', () => {
        sheet.close(); showValueFlow(app, app.semantic.model, row, region);
      }));
    }
  }
  actions.append(button(pick('アドレスの対応', 'Address mapping'), 'chip', () => {
    showAddressInfo(app, d.address);
  }));
  root.append(actions);
}

function prevRow(app, row) {
  if (row <= 0) return null;
  const d = app.viewer.rowData(row - 1);
  if (!d || d.mnemonic == null) return null;
  return { mn: d.mnemonic, ops: d.operands || '' };
}

/** "FD 7B BF A9" → CPU から見た 1 個の 32 ビット値。 */
function wordValue(hex) {
  const parts = String(hex).replace(/\s+/g, '').match(/.{2}/g);
  if (!parts || parts.length !== 4) return null;
  let v = 0;
  for (let i = 3; i >= 0; i--) v = (v * 256) + parseInt(parts[i], 16);
  return v >>> 0;
}

export function instructionMenu(app, row, x, y) {
  const sel = app.viewer.rangeMode ? app.viewer.selectionRange() : null;
  if (sel) { rangeCopyMenu(app, x, y); return; }

  const d = app.viewer.rowData(row) || {};
  const asm = ((d.mnemonic || '') + ' ' + (d.operands || '')).trim();
  const sb = semanticBlockAt(app, row);
  menu([
    { label: t('detail.title') + '…', action: () => showDetail(app, row) },
    ...(sb ? [{
      label: pick('この処理を見る', 'Show this step') + '（' + blockTitle(sb) + '）',
      action: () => showBlockDetail(app, app.semantic.model, sb, app.store.get('currentRegion')),
    }] : []),
    { label: t('detail.showFunction'), action: () => showFunctionSummary(app, row) },
    { label: pick('この関数を調べる（事実と推測）', 'Investigate this function'),
      action: () => showFunctionReport(app, d.address, app.lastGoal) },
    ...(sb ? [{
      label: pick('この値の行き先を追う', 'Follow this value'),
      action: () => showValueFlow(app, app.semantic.model, row, app.store.get('currentRegion')),
    }] : []),
    { label: t('detail.findRefs'), action: () => showXrefs(app, d.address) },
    { label: pick('アドレスの対応を見る', 'Show address mapping'), action: () => showAddressInfo(app, d.address) },
    '-',
    { label: t('detail.copyAddress'), action: () => copyText(addrHex(d.address), t('toast.copyAddress')) },
    { label: t('detail.copyHex'), action: () => copyText(d.bytes || '', t('toast.copyHex')) },
    { label: t('detail.copyAsm'), action: () => copyText(asm, t('toast.copyAsm')) },
    '-',
    { label: t('detail.selectRows'), action: () => app.startSelection(row) },
  ], x, y);
}

/* ────────────────────────────────────────────────────────────
   目的から探す — このツールの入口
   ────────────────────────────────────────────────────────────

   初心者は関数名を知らない。知っているのは「攻撃力を増やしたい」だけ。
   だからここは「何を調べたいですか？」から始めて、

     目的 → 文字列 → その文字列を参照している命令 → 関数 → 呼び出し関係
          → 根拠つきの候補 → 関数レポート → 処理 → 命令 → アドレス → バイト

   まで一本の道でつなぐ。途中で「なぜそう言えるのか」を必ず出す。   */

/** 関数の見出し。名前がなければアドレスで。 */
function fnLabel(app, addr) {
  if (addr == null) return t('functions.unnamed');
  const name = app.symbols ? app.symbols.nameAt(addr) : null;
  return name || 'sub_' + addr.toString(16).toUpperCase();
}

/** ずらし幅は短い 16 進で。アドレスと違って桁をそろえない（読みにくいので）。 */
function offsetHex(v) {
  const n = v < 0n ? -v : v;
  return (v < 0n ? '-0x' : '0x') + n.toString(16).toUpperCase();
}

/** 進み具合の表示。走査は worker で走るので、UI は止まらない。 */
function progressBox(parent, text) {
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill);
  const status = el('div', 'hint', text || '');
  parent.append(bar, status);
  return {
    bar, status, fill,
    set(p) {
      if (!p || !p.all) return;
      fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
    },
    say(s) { status.textContent = s; },
    done() { bar.remove(); status.remove(); },
  };
}

/**
 * 解析の材料（文字列とプログラム索引）をそろえる。
 * どちらも 1 ファイルにつき 1 回で済み、2 回目からはすぐ返る。
 */
async function prepare(app, box) {
  // クラスとフィールドの名前がいちばん効くので、まずこれを読む
  if (box) box.say(pick('クラスと、その中の値の名前を読んでいます…', 'Reading classes and their fields…'));
  await app.ensureObjc();
  const strings = await app.ensureStrings((p) => {
    if (box) { box.set(p); box.say(pick('アプリの中の言葉を集めています…', 'Collecting text…')); }
  });
  const program = await app.ensureProgram((p) => {
    if (box) {
      box.set(p);
      box.say(p.phase === 'functions'
        ? pick('関数の切れ目を調べています…', 'Finding function boundaries…')
        : pick('呼び出し関係とデータ参照を調べています…', 'Mapping calls and data references…'));
    }
  });
  /*
   * 値のふるまい。名前も文字列も残っていないアプリ（ゲーム本体が C++ のもの）では、
   * ここだけが「その値がその目的のものだ」と言える手がかりになる。
   */
  const shapes = await app.ensureShapes((p) => {
    if (box) {
      box.set(p);
      box.say(pick('値の増減のしかたを調べています…', 'Watching how values change…'));
    }
  });
  return { strings, program, shapes };
}

/** 目的を選ぶボタンの並び。概要画面と「調べる」画面の両方で使う。 */
function goalChips(app, onPick) {
  const wrap = el('div', 'goalchips');
  for (const g of GOALS) {
    const b = button((g.icon ? g.icon + ' ' : '') + pick(g.ja, g.en), 'goalchip', () => {
      onPick(goalFromPreset(g.id));
    });
    wrap.append(b);
  }
  return wrap;
}

/** 自由入力。「敵にダメージを与える処理」のような文でも受け取る。 */
function goalInput(app, onPick) {
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.placeholder = pick('例: 敵にダメージを与える処理 / コインの増減 / ログイン',
    'e.g. damage dealt to enemies, coin balance, login');
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const go = () => {
    const goal = parseGoal(input.value);
    if (!goal) { toast(pick('調べたいことを入力してください。', 'Type what you want to look for.')); return; }
    onPick(goal);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  field.append(input, button(pick('探す', 'Search'), 'chip', go));
  return field;
}

/* ── 概要（ファイルを開いて最初に出る画面） ─────────────── */

export function showOverview(app) {
  const info = app.store.get('fileInfo');
  if (!info) { toast(t('err.openFirst')); return; }
  const sheet = new Sheet(pick('自動解析', 'Automatic analysis'), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onScanProgress = null; },
  });
  const body = sheet.body;

  /* 1. 何のファイルか（ここは全部 FACT） */
  const head = list();
  const slice = app.currentSlice();
  head.append(kvRow(pick('形式', 'Format'), info.format +
    (app.store.get('architecture') ? ' · ' + app.store.get('architecture') : '')));
  head.append(kvRow(pick('大きさ', 'Size'), sizeText(info.size)));
  if (slice && slice.info) {
    head.append(kvRow(pick('種類', 'Type'), slice.info.filetypeName));
    if (slice.info.encrypted) {
      head.append(kvRow(pick('暗号化', 'Encrypted'), pick('されています（読めません）', 'yes — cannot be read')));
    }
  }
  const region = app.codeRegion();
  if (region) head.append(kvRow(pick('コードの区画', 'Code section'), region.name + ' · ' + sizeText(region.size)));
  body.append(head);

  /*
   * 2. 目的から探す入口は、1 行だけ置いておく。
   *    まず見せたいのは「このアプリが何でできているか」なので、
   *    選択肢を先に並べて画面を埋めない。
   */
  const openGoal = (goal) => { sheet.close(); showCandidates(app, goal); };
  const entry = list();
  entry.append(tapRow(pick('調べたいものが決まっている', 'I know what I am looking for'), {
    sub: pick('HP・攻撃力・コイン・ガチャ・通信… から選ぶ／自由に入力する',
      'Pick HP, attack, coins, gacha, network… or type it yourself'),
    right: '›',
    onTap: () => { sheet.close(); showInvestigate(app); },
  }));
  body.append(entry);

  /* 3. 裏で走査して、分かったことを足していく */
  const later = el('div');
  body.append(later);

  /*
   * 走査はセクション 1 周ぶん。ふつうの大きさなら一瞬だが、
   * 数十 MB のコードでは待たせることになるので、そのときは自分で始めてもらう。
   */
  const BIG = 24 * 1024 * 1024;
  if (region && region.size > BigInt(BIG) && !app.program) {
    const ul = list();
    ul.append(tapRow(pick('このファイルを詳しく調べる', 'Analyse this file in depth'), {
      sub: pick('コードが ' + sizeText(region.size) + ' あります。' +
        '呼び出し関係とデータ参照を索引するので、少し時間がかかります。',
      'The code is ' + sizeText(region.size) + '; indexing calls and references will take a moment.'),
      onTap: () => { ul.remove(); run(); },
    }));
    later.append(ul);
  } else {
    run();
  }

  function run() {
    // 一度出した結果は取っておく。開き直すたびに走らせ直さない。
    const cached = app.autoReport;
    if (cached && region && cached.key === region.id && cached.gen === app.symbols.gen) {
      renderAutoReport(app, sheet, later, cached.report, region);
      return;
    }
    const box = progressBox(later, pick('中身を調べています…', 'Looking inside…'));
    let cancelled = false;
    sheet.onClose = () => { cancelled = true; app.backend.cancelSearch(); app.backend.onScanProgress = null; };

    prepare(app, box).then(async ({ strings, program, shapes }) => {
      if (cancelled || !sheet.root.isConnected) return;
      const report = await autoAnalyze({
        strings, program, symbols: app.symbols, region, fields: app.fields,
        shapes,
        analyze: makeAnalyzer(app, region),
        scanAccess: makeAccessScanner(app, region),
        isCancelled: () => cancelled || !sheet.root.isConnected,
        onProgress: (p) => {
          box.set({ done: p.done, all: p.all });
          box.say(autoPhaseText(p.phase));
        },
      });
      box.done();
      if (cancelled || !sheet.root.isConnected) return;
      app.autoReport = { report, key: region ? region.id : null, gen: app.symbols.gen };
      renderAutoReport(app, sheet, later, report, region);
    }).catch((err) => {
      box.done();
      later.append(para(pick('調べているうちに問題が起きました: ', 'Something went wrong: ') +
        (err && err.message ? err.message : String(err))));
    });
  }
}

function autoPhaseText(phase) {
  switch (phase) {
    case 'features': return pick('言葉を機能ごとに分けています…', 'Sorting the text by feature…');
    case 'map': return pick('アプリを部品に分けています…', 'Splitting the app into parts…');
    case 'goals': return pick('目的ごとに、関係のありそうな関数を採点しています…', 'Scoring candidates for every goal…');
    case 'pinpoint': return pick('値を 1 つに絞り込んでいます…', 'Narrowing each goal down to one value…');
    case 'verify': return pick('候補を逆アセンブルして、本当にその値かを確かめています…',
      'Disassembling the candidates to confirm…');
    case 'pinpoint-fn': return pick('その値を書き換えている処理を確かめています…',
      'Confirming which routine changes it…');
    case 'notable': return pick('よく使われている処理を選んでいます…', 'Picking the routines that matter…');
    case 'deep': return pick('有力な関数の中身を読んでいます…', 'Reading the strongest candidates…');
    default: return pick('まとめています…', 'Wrapping up…');
  }
}

/**
 * 自動解析の特定用。位置をまとめて渡して、1 回の走査で全部の読み書きを取る。
 * 候補ごとにセクションを舐め直すと、数十 MB × 候補数になってしまうため。
 */
function makeAccessScanner(app, region) {
  if (!region) return null;
  return async (list) => {
    const offsets = (list || []).map((x) => ({ offset: x.offset, size: x.size || 0 }));
    if (!offsets.length) return new Map();
    return app.backend.fieldAccessMany(region.id, offsets);
  };
}

/**
 * その目的の「これです」を用意する。
 *
 * 自動解析ですでに決着していればそれを使い、なければその場で決めにいく。
 * 同じ目的を開き直すたびに逆アセンブルし直さないよう、結果は取っておく。
 */
async function pinnedFor(app, goal, ctx) {
  if (!goal) return null;
  const report = app.autoReport && app.autoReport.report ? app.autoReport.report : null;
  const fromAuto = report && report.pinned
    ? report.pinned.find((p) => p.goal && p.goal.id === goal.id && p.goal.text === goal.text)
    : null;
  if (fromAuto) return fromAuto;

  if (!app.pinnedCache) app.pinnedCache = new Map();
  const key = goal.id + ' ' + goal.text + ' ' + app.symbols.gen;
  if (app.pinnedCache.has(key)) return app.pinnedCache.get(key);

  const region = ctx.region;
  if (ctx.box) ctx.box.say(pick('値を 1 つに絞り込んでいます…', 'Narrowing down to one value…'));
  const common = {
    goal,
    fields: app.fields,
    shapes: ctx.shapes || app.shapes || null,
    program: ctx.program,
    symbols: app.symbols,
    strings: ctx.strings || [],
    region,
    map: report ? report.map : null,
    analyze: makeAnalyzer(app, region),
    scanAccess: makeAccessScanner(app, region),
    // 1 つの目的だけを見にきているので、ここでは予算を広く取る
    budget: { left: 48 },
    limit: 12,
    onProgress: (x) => { if (ctx.box) ctx.box.set(x); },
  };
  const p = (async () => {
    let pin = null;
    if (app.fields && app.fields.classCount) {
      pin = await pinpointField(common).catch(() => null);
    }
    // クラス表がない（Swift だけ・名前を潰したアプリ）なら、形から場所を決めにいく
    if ((!pin || !pin.top) && ctx.ranked && ctx.ranked.length) {
      const loc = await pinpointLocation(Object.assign({}, common, { ranked: ctx.ranked }))
        .catch(() => null);
      if (loc && loc.top) pin = loc;
    }
    return pin;
  })();
  app.pinnedCache.set(key, p);
  return p;
}

/** 自動解析の深掘り用。関数 1 つを解析してモデルだけ返す。 */
function makeAnalyzer(app, region) {
  if (!region || !app.store.get('canDisassemble')) return null;
  const totalRows = Number(region.size / 4n);
  return async (addr, end) => {
    const startRow = Number((addr - region.vmAddr) / 4n);
    if (!(startRow >= 0) || startRow >= totalRows) return null;
    const endRow = end != null
      ? Math.min(totalRows - 1, Number((end - region.vmAddr) / 4n) - 1)
      : Math.min(totalRows - 1, startRow + 512);
    if (endRow < startRow) return null;
    // 速さのために文字列は読まない。あとで開いたときに読み足される。
    const res = await analyzeFunctionCached(app.backend, region, startRow, endRow,
      app.symbols, null, { texts: false });
    return res.model;
  };
}

/* ────────────────────────────────────────────────────────────
   アプリの地図 — 上から降りていくための画面
   ────────────────────────────────────────────────────────────

   部品 → クラス → 値（フィールド）→ 触っている場所 → 命令。
   1 画面に出るのは常に十数個までにする。数万の関数を一覧にしない。 */

/** 地図の 1 行（部品）。 */
function subsystemRow(app, sub, onTap) {
  const parts = [];
  if (sub.classCount) parts.push(pick(sub.classCount + ' クラス', sub.classCount + ' classes'));
  if (sub.methods) parts.push(pick(sub.methods + ' メソッド', sub.methods + ' methods'));
  if (sub.fields) parts.push(pick(sub.fields + ' 個の値', sub.fields + ' fields'));
  const sample = (sub.classes || []).slice(0, 3).map((c) => c.name).join('、') ||
    (sub.functions || []).slice(0, 2).map((f) => f.name || fnLabel(app, f.addr)).join('、');
  return tapRow(sub.icon + ' ' + sub.label, {
    sub: parts.join('  ·  ') + (sample ? '\n' + trimText(sample, 60) : ''),
    right: '›',
    onTap,
  });
}

export function showAppMap(app, map) {
  const m = map || (app.autoReport && app.autoReport.report ? app.autoReport.report.map : null);
  if (!m || !m.subsystems.length) {
    toast(pick('地図を作れませんでした。', 'No map could be built.'));
    return;
  }
  const sheet = new Sheet(pick('アプリの地図', 'Map of this app'));
  const body = sheet.body;

  body.append(para(m.byStrings
    ? pick('このファイルには Objective-C のクラス表がないため、' +
      '「どんな言葉を使っているか」だけで大まかに分けています。粗い地図です。',
    'This binary has no Objective-C class table, so the grouping is based on text alone — a rough map.')
    : pick('このアプリを、担当ごとの部品に分けました。' +
      'まず部品を選び、次にクラス、そのクラスが持っている値、と降りていけます。',
    'The app grouped into parts. Pick a part, then a class, then the values it holds.')));

  const ul = list();
  for (const sub of m.subsystems) {
    ul.append(subsystemRow(app, sub, () => { sheet.close(); showSubsystem(app, sub); }));
  }
  body.append(ul);

  if (m.unclassified) {
    const rest = list();
    rest.append(tapRow(pick('分類できなかったクラス', 'Classes that could not be grouped'), {
      right: String(m.unclassified),
      sub: pick('名前からも、使っている言葉からも、担当が読み取れなかったものです',
        'Nothing in the name, text or calls said what these are for'),
      onTap: () => {
        sheet.close();
        showSubsystem(app, {
          id: 'unknown', icon: '❓',
          label: pick('分類できなかったクラス', 'Unclassified'),
          classes: m.unclassifiedClasses || [], classCount: m.unclassified,
        });
      },
    }));
    body.append(rest);
  }

  body.append(para(pick(
    '※ 部品の分け方は、クラス名・参照している文字列・呼んでいる API の 3 つを足して決めています。' +
    'どれも実際にバイナリにあるものですが、分類そのものは推測です。',
    'Grouping combines class names, referenced text and called APIs. All are real, but the grouping itself is a guess.'), 'sub'));
}

/** 部品 1 つの中身（クラスの一覧）。 */
export function showSubsystem(app, sub) {
  const sheet = new Sheet(sub.icon + ' ' + sub.label);
  const body = sheet.body;
  const classes = sub.classes || [];

  if (classes.length) {
    body.append(para(pick(
      'この部品を担当しているクラスです。上にあるものほど、担当がはっきりしていて、よく使われています。',
      'The classes in this part, clearest and most-used first.')));
    const ul = list();
    for (const c of classes.slice(0, 60)) {
      const parts = [];
      if (c.methods) parts.push(pick(c.methods + ' メソッド', c.methods + ' methods'));
      if (c.fields) parts.push(pick(c.fields + ' 個の値', c.fields + ' fields'));
      if (c.calls) parts.push(pick('呼ばれた回数 ' + c.calls, 'called ' + c.calls + '×'));
      if (c.superName) parts.push(pick(c.superName + ' の仲間', 'extends ' + c.superName));
      ul.append(tapRow(c.name, {
        sub: parts.join('  ·  '),
        right: '›',
        onTap: () => { sheet.close(); showClass(app, c.name); },
      }));
    }
    body.append(ul);
    if (classes.length > 60) {
      body.append(para(pick('※ 上位 60 クラスだけ出しています。', 'Showing the top 60 classes only.'), 'sub'));
    }
  }

  // クラスがないファイルでは、関数を直接並べる
  if (sub.functions && sub.functions.length) {
    body.append(para(pick(
      'この部品に関係する言葉を使っている関数です。',
      'Functions that use text belonging to this part.')));
    const ul = list();
    for (const f of sub.functions.slice(0, 40)) {
      ul.append(tapRow(f.name || fnLabel(app, f.addr), {
        sub: addrHex(f.addr) + (f.samples && f.samples.length
          ? '\n' + f.samples.map((s) => '「' + trimText(s, 22) + '」').join(' ') : ''),
        onTap: () => { sheet.close(); showFunctionReport(app, f.addr); },
      }));
    }
    body.append(ul);
  }

  if (!classes.length && !(sub.functions || []).length) {
    body.append(para(pick('中身を取り出せませんでした。', 'Nothing could be listed here.')));
  }
}

/** クラス 1 つ。ここが「どれがどの処理か」のいちばん分かりやすい単位。 */
export function showClass(app, className) {
  const info = app.fields ? app.fields.classInfo(className) : null;
  if (!info) { toast(pick('このクラスの情報がありません。', 'No information for this class.')); return; }
  const sheet = new Sheet(className);
  const body = sheet.body;

  const head = el('div', 'fn-head');
  head.append(el('div', 'fn-name', className));
  const meta = [];
  if (info.superName) meta.push(pick(info.superName + ' を継承', 'extends ' + info.superName));
  if (info.instanceSize) meta.push(pick('1 個あたり ' + info.instanceSize + ' バイト', info.instanceSize + ' bytes each'));
  head.append(el('div', 'fn-range', meta.join('  ·  ')));
  body.append(head);

  /* 1. このクラスが持っている値 — 改造したい人が本当に見たいのはここ */
  if (info.ivars.length) {
    body.append(el('div', 'sec-title', pick('このクラスが持っている値', 'The values this class holds')));
    body.append(para(pick(
      'クラスの中にある変数です。名前も型も、アプリを作った人が書いたものがそのまま残っています。' +
      '選ぶと、その値を読み書きしている場所を探せます。',
      'The variables inside this class — names and types as written by the developers. Pick one to find where it is read and written.')));
    const ul = list();
    for (const iv of info.ivars) {
      const type = typeWord(iv.type);
      ul.append(tapRow(plainFieldName(iv.name), {
        sub: (type ? type + '  ·  ' : '') +
          pick('先頭から ' + offsetHex(BigInt(iv.offset)) + ' の位置', 'at ' + offsetHex(BigInt(iv.offset))),
        right: '›',
        onTap: () => { sheet.close(); showField(app, className, iv); },
      }));
    }
    body.append(ul);
  } else {
    body.append(para(pick(
      'このクラスは値（メンバ変数）を持っていないか、表から読み取れませんでした。',
      'This class holds no fields, or they could not be read.')));
  }

  /* 2. メソッド */
  const methods = (info.methods || []).concat(info.classMethods || []);
  if (methods.length) {
    body.append(el('div', 'sec-title',
      pick('このクラスの処理  (' + methods.length + ')', 'Methods  (' + methods.length + ')')));
    const ul = list();
    for (const m of methods.slice(0, 80)) {
      ul.append(tapRow((m.kind || '-') + ' ' + (m.sel || '?'), {
        sub: addrHex(m.addr),
        onTap: () => { sheet.close(); showFunctionReport(app, m.addr); },
      }));
    }
    body.append(ul);
    if (methods.length > 80) {
      body.append(para(pick('※ 先頭 80 個だけ出しています。', 'Showing the first 80 only.'), 'sub'));
    }
  }
}

/** 値 1 つ。「HP はどこで書き換えられているのか」に答える画面。 */
export function showField(app, className, field) {
  const sheet = new Sheet(className + '.' + plainFieldName(field.name), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onScanProgress = null; },
  });
  const body = sheet.body;

  const type = typeWord(field.type);
  body.append(bigValue(plainFieldName(field.name)));
  const ul = list();
  ul.append(kvRow(pick('持ち主', 'Belongs to'), className));
  if (type) ul.append(kvRow(pick('種類', 'Type'), type));
  ul.append(kvRow(pick('置かれている位置', 'Position'),
    offsetHex(BigInt(field.offset)) + pick('（オブジェクトの先頭から）', ' from the start of the object')));
  if (field.size) ul.append(kvRow(pick('大きさ', 'Size'), field.size + pick(' バイト', ' bytes')));
  body.append(ul);

  body.append(para(pick(
    'この値を読み書きしている命令を、コード全体から探します。' +
    '書き込んでいる場所が、その値を変えている場所です。',
    'Searching the whole binary for instructions that read or write this value. The writes are where it changes.')));

  const box = progressBox(body, pick('探しています…', 'Searching…'));
  const results = el('div');
  body.append(results);

  Promise.all([
    app.ensureProgram(),
    app.backend.fieldAccess({
      regionId: (app.codeRegion() || {}).id,
      offset: field.offset,
      size: field.size || 0,
    }),
  ]).then(([program, res]) => {
    box.done();
    if (!sheet.root.isConnected) return;
    const sites = res.results || [];
    if (!sites.length) {
      results.append(para(pick(
        'この値を直接読み書きしている命令は見つかりませんでした。' +
        'プロパティ（setter / getter）ごしにだけ使われている可能性があります。',
        'No instruction reads or writes this position directly; it may only be used through accessors.')));
      return;
    }

    /* 関数ごとにまとめる。同じクラスのメソッドの中にあるものが本命。 */
    const byFunc = new Map();
    for (const s of sites) {
      const fn = program ? program.functionStartOf(s.addr) : null;
      const key = fn != null ? fn.toString() : 's' + s.addr.toString();
      if (!byFunc.has(key)) {
        const owner = fn != null && app.fields ? app.fields.ownerOf(fn) : null;
        byFunc.set(key, {
          addr: fn, owner, loads: 0, stores: 0, first: s.addr,
          sameClass: !!(owner && owner.className === className),
        });
      }
      const e = byFunc.get(key);
      if (s.kind === 'load') e.loads++; else e.stores++;
    }
    const list2 = Array.from(byFunc.values());
    // 同じクラスの中で、書き込んでいるものを先頭に
    list2.sort((a, b) => (b.sameClass - a.sameClass) || (b.stores - a.stores) || (b.loads - a.loads));

    const writes = list2.filter((e) => e.stores).length;
    const sure = list2.filter((e) => e.sameClass).length;
    results.append(para(pick(
      sites.length + ' か所で使われていました。うち書き込みは ' +
        list2.reduce((n, e) => n + e.stores, 0) + ' か所です。',
      'Used in ' + sites.length + ' places; ' +
        list2.reduce((n, e) => n + e.stores, 0) + ' of them write to it.')));
    if (sure) {
      results.append(para(pick(
        'このうち ' + sure + ' か所は ' + className + ' 自身のメソッドの中なので、' +
        'この値のことでほぼ間違いありません。',
        sure + ' of them are inside ' + className + '’s own methods, so those are almost certainly this value.'), 'sub'));
    }

    const ul2 = list();
    for (const e of list2.slice(0, 60)) {
      const what = [];
      if (e.stores) what.push(pick('書き込み ' + e.stores + ' か所', e.stores + ' writes'));
      if (e.loads) what.push(pick('読み出し ' + e.loads + ' か所', e.loads + ' reads'));
      ul2.append(tapRow(
        e.owner ? e.owner.kind + '[' + e.owner.className + ' ' + e.owner.sel + ']'
          : (e.addr != null ? fnLabel(app, e.addr) : addrHex(e.first)),
        {
          sub: what.join('  ·  ') + '  ·  ' + addrHex(e.first),
          tag: e.sameClass ? pick('このクラス', 'this class')
            : (e.owner ? pick('別のクラス', 'another class') : pick('クラス不明', 'unknown class')),
          tagClass: e.sameClass ? 'tag-fact' : 'tag-infer',
          right: e.stores ? '✎' : '',
          onTap: () => {
            sheet.close();
            if (e.addr != null) showFunctionReport(app, e.addr);
            else app.goToAddress(e.first, { announce: true });
          },
        }));
    }
    results.append(ul2);
    results.append(para(pick(
      '※ 同じ位置（' + offsetHex(BigInt(field.offset)) + '）を触っている命令をすべて拾っています。' +
      '別のクラスの、たまたま同じ位置にある値が混ざることがあります。' +
      '「このクラス」の札が付いているものが確実です。',
      'Every instruction touching this offset is listed. Other classes may use the same offset for something else — the ones tagged as this class are the certain ones.'), 'sub'));
    void writes;
  }).catch((err) => {
    box.done();
    results.append(para(pick('探せませんでした: ', 'Search failed: ') +
      (err && err.message ? err.message : String(err))));
  });
}

/* ────────────────────────────────────────────────────────────
   「これです」— 目的 1 つに対する、決着した答え
   ────────────────────────────────────────────────────────────

   このツールで、いちばん見せたい画面。
   候補を並べるのではなく、1 個を出して、なぜそれで確定なのかを全部見せる。
   確定できなかったときは、確定できなかったと言って、何が足りないかを書く。 */

/** 決着の見出し（確定 / ほぼ確実 / 絞りきれていません）。 */
function verdictBadge(verdict) {
  const box = el('div', 'verdict verdict-' + verdict);
  box.append(el('div', 'verdict-word', verdictText(verdict)));
  box.append(el('div', 'verdict-lead', verdictLead(verdict)));
  return box;
}

/**
 * 特定したものの名前。
 * クラス表があれば `BattleManager.hp`、無ければ `オブジェクトの +0x20 の値`。
 * 名前が無いことを、名前があるかのように見せない。
 */
function pinnedName(c) {
  if (!c) return '';
  if (c.kind === 'location') {
    return pick('オブジェクトの ' + offsetHex(BigInt(c.offset)) + ' にある値',
      'the value at ' + offsetHex(BigInt(c.offset)));
  }
  return c.className + '.' + c.plain;
}

/** 特定した値 1 個ぶんの見出し行。 */
function pinnedHeadline(pin) {
  const c = pin.top;
  const box = el('div', 'pinned-head');
  box.append(el('div', 'pinned-name', pinnedName(c)));
  const bits = [];
  const type = typeWord(c.type);
  if (type) bits.push(type);
  bits.push(c.kind === 'location'
    ? pick('その場所の先頭から ' + offsetHex(BigInt(c.offset)), 'at ' + offsetHex(BigInt(c.offset)))
    : pick('先頭から ' + offsetHex(BigInt(c.offset)), 'at ' + offsetHex(BigInt(c.offset))));
  if (c.size) bits.push(c.size + pick(' バイト', ' bytes'));
  box.append(el('div', 'pinned-sub', bits.join('  ·  ')));
  return box;
}

export function showPinned(app, pin) {
  if (!pin || !pin.top) return;
  const goal = pin.goal;
  const sheet = new Sheet(goalLabel(goal));
  const body = sheet.body;
  const c = pin.top;

  body.append(verdictBadge(pin.verdict));
  body.append(pinnedHeadline(pin));

  /* 1. 確からしさ。掛け算の出発点と結果を、隠さずに出す。 */
  const ul = list();
  ul.append(kvRow(pick('確からしさ', 'Confidence'), probabilityText(c.fusion.probability)));
  ul.append(kvRow(pick('調べた値の数', 'Values considered'),
    pin.universe.toLocaleString() + pick(' 個の中から', '')));
  if (pin.runnerUp) {
    ul.append(kvRow(pick('2 番目の候補との差', 'Lead over runner-up'),
      Number.isFinite(pin.marginRatio)
        ? pick(Math.round(pin.marginRatio).toLocaleString() + ' 倍',
          Math.round(pin.marginRatio).toLocaleString() + '×')
        : pick('比べるものがありません', 'nothing to compare')));
    ul.append(kvRow(pick('2 番目の候補', 'Runner-up'), pinnedName(pin.runnerUp)));
  }
  if (pin.checked) {
    ul.append(kvRow(pick('実際に読んだ処理', 'Routines disassembled'),
      pin.checked + pick(' 個', '')));
  }
  body.append(ul);

  /* 2. なぜそう言えるか。ここがこの画面の本体。 */
  body.append(el('div', 'sec-title', pick('なぜ、これだと言えるのか',
    'Why this is the answer')));
  body.append(para(pick(
    '下の 1 行ずつが独立した根拠です。右の数字は「その根拠があると、' +
    'どれだけ確からしさが上がるか」の倍率です。掛け合わせた結果が上の確からしさになります。',
    'Each line below is an independent piece of evidence; the number is how much it multiplies the odds.')));
  const wl = list();
  for (const w of c.why) {
    const text = proofText(w);
    if (!text) continue;
    const kind = w.kind === 'verified' ? pick('検証済', 'verified')
      : w.kind === 'fact' ? pick('事実', 'fact') : pick('推測', 'inference');
    wl.append(tapRow(text, {
      right: factorText(w.factor),
      tag: kind,
      tagClass: w.kind === 'inference' ? 'tag-infer' : 'tag-fact',
      sub: w.count > 1 ? pick(w.count + ' 件', w.count + ' items') : null,
    }));
  }
  body.append(wl);
  body.append(para(pick(
    '「検証済」は、実際にその処理を逆アセンブルして命令を確かめたものです。' +
    'クラス表にそう書いてあるだけの「事実」より、一段強い根拠になります。',
    '“Verified” means the instructions were actually disassembled and checked.'), 'sub'));

  /* 3. 確定でないなら、何が足りないのかを必ず書く。 */
  if (pin.verdict !== VERDICT.CONFIRMED && pin.missing.length) {
    const nb = block(pick('確定と言えない理由', 'Why this is not confirmed'));
    const ol = el('ul', 'story-steps');
    for (const m of pin.missing) {
      const text = missingText(m);
      if (!text) continue;
      const li = el('li');
      li.append(el('i', null, '•'));
      li.append(el('span', null, text));
      ol.append(li);
    }
    nb.append(ol);
    body.append(nb);
  }

  /* 4. 検証の記録。何を読んで、何が確かめられたか。 */
  if (c.verifications && c.verifications.length) {
    body.append(el('div', 'sec-title', pick('実際に読んだ処理', 'What was disassembled')));
    const vl = list();
    for (const v of c.verifications) {
      if (!v.sel) continue;
      const r = v.result || {};
      const ok = (v.what === 'getter' && r.getter) || (v.what === 'setter' && r.setter);
      vl.append(tapRow('-[' + c.className + ' ' + v.sel + ']', {
        sub: addrHex(v.addr) + '  ·  ' + (ok
          ? pick('この位置を' + (v.what === 'getter' ? '読んで' : '書いて') + 'いました',
            'really ' + (v.what === 'getter' ? 'reads' : 'writes') + ' this offset')
          : pick('この位置は触っていませんでした', 'does not touch this offset')),
        tag: ok ? pick('一致', 'match') : pick('不一致', 'no match'),
        tagClass: ok ? 'tag-fact' : 'tag-infer',
        onTap: () => { sheet.close(); showFunctionReport(app, v.addr, goal); },
      }));
    }
    body.append(vl);
  }

  /* 5. どこを変えればいいか。値が決まっただけでは終わらない。 */
  const sites = (pin.changeSites && pin.changeSites.length) ? pin.changeSites : c.sites;
  if (sites && sites.length) {
    const writes = sites.filter((s) => s.stores);
    body.append(el('div', 'sec-title', pick('この値を書き換えている場所',
      'Where this value is changed')));
    body.append(para(pick(
      writes.length
        ? '書き込んでいる場所が、この値を変えている場所です。ここを開けば、' +
          '何をどれだけ増減させているかまで 1 行ずつ日本語で読めます。'
        : '書き込んでいる場所は見つかりませんでした。読み出しだけの一覧です。',
      writes.length ? 'The writes are where the value changes.' : 'Only reads were found.')));
    const sl = list();
    for (const s of sites.slice(0, 20)) {
      const what = [];
      if (s.stores) what.push(pick('書き込み ' + s.stores + ' か所', s.stores + ' writes'));
      if (s.loads) what.push(pick('読み出し ' + s.loads + ' か所', s.loads + ' reads'));
      const title = s.owner
        ? s.owner.kind + '[' + s.owner.className + ' ' + s.owner.sel + ']'
        : (s.sel ? '-[' + (s.className || c.className) + ' ' + s.sel + ']'
          : (s.addr != null ? fnLabel(app, s.addr) : addrHex(s.first)));
      sl.append(tapRow(title, {
        sub: what.join('  ·  ') + '  ·  ' + addrHex(s.first != null ? s.first : s.addr),
        tag: s.sameClass || s.className === c.className
          ? pick('このクラス', 'this class')
          : (s.subclass ? pick('親子クラス', 'related class')
            : (s.owner ? pick('別のクラス', 'another class') : pick('クラス不明', 'unknown'))),
        tagClass: (s.sameClass || s.className === c.className) ? 'tag-fact' : 'tag-infer',
        right: s.stores ? '✎' : '',
        onTap: () => {
          sheet.close();
          if (s.addr != null) showFunctionReport(app, s.addr, goal);
          else app.goToAddress(s.first, { announce: true });
        },
      }));
    }
    body.append(sl);
  }

  /* 6. ほかの候補も、隠さずに出す。 */
  if (pin.candidates.length > 1) {
    const dis = disclosure(pick('ほかの候補も見る（' + (pin.candidates.length - 1) + ' 個）',
      'See the other candidates (' + (pin.candidates.length - 1) + ')'));
    const ol = list();
    for (const other of pin.candidates.slice(1)) {
      ol.append(tapRow(pinnedName(other), {
        sub: (typeWord(other.type) || '') + '  ·  ' + offsetHex(BigInt(other.offset)) +
          '\n' + (proofText(other.why[0]) || ''),
        right: probabilityText(other.probability),
        onTap: () => {
          sheet.close();
          if (other.kind === 'location') {
            const at = other.updates && other.updates[0] ? other.updates[0].store.address : null;
            if (at != null) app.goToAddress(at, { announce: true });
          } else {
            showField(app, other.className, other.field);
          }
        },
      }));
    }
    dis.body.append(ol);
    body.append(dis);
  }

  const actions = el('div', 'detail-actions');
  if (c.kind === 'field') {
    actions.append(button(pick('この値の使われ方をすべて見る', 'See every use of this value'), 'chip', () => {
      sheet.close();
      showField(app, c.className, c.field);
    }));
    actions.append(button(pick('このクラスを開く', 'Open this class'), 'chip', () => {
      sheet.close();
      showClass(app, c.className);
    }));
  } else if (c.functions && c.functions.length) {
    actions.append(button(pick('この値を扱っている処理を開く', 'Open the routine that uses it'), 'chip', () => {
      sheet.close();
      showFunctionReport(app, c.functions[0].addr, goal);
    }));
    const at = c.updates && c.updates[0] ? c.updates[0].store.address : null;
    if (at != null) {
      actions.append(button(pick('書き換えている命令へ移動', 'Go to the writing instruction'), 'chip', () => {
        sheet.close();
        app.goToAddress(at, { announce: true });
      }));
    }
  }
  body.append(actions);

  body.append(para(pick(
    '※ 静的解析なので、実際に動かして確かめるまでが一手です。' +
    '値を書き換えたら、狙ったところが変わるかどうかを必ず確認してください。',
    'This is static analysis — always confirm at runtime.'), 'sub'));
}

/** 決着した目的を 1 行で。地図と同じ調子で並べられる形にする。 */
function pinnedRow(app, pin, onTap) {
  const c = pin.top;
  const icon = pin.goal.icon ? pin.goal.icon + ' ' : '';
  return tapRow(icon + pin.goal.text + ' → ' + pinnedName(c), {
    sub: (typeWord(c.type) || '') + '  ·  ' + offsetHex(BigInt(c.offset)) +
      '\n' + (proofText(c.why[0]) || ''),
    right: pin.verdict === VERDICT.CONFIRMED ? pick('確定', 'confirmed')
      : probabilityText(c.fusion.probability),
    tag: pin.verdict === VERDICT.CONFIRMED ? pick('検証済', 'verified') : null,
    tagClass: 'tag-fact',
    onTap,
  });
}

/* ── 自動解析の結果を並べる ─────────────────────────────── */

function renderAutoReport(app, sheet, body, report, region) {
  const openGoal = (goal) => { sheet.close(); showCandidates(app, goal); };

  /*
   * 0. まず、決着が付いたもの。
   *    「候補が 40 個あります」ではなく「HP は BattleManager.hp です」から始める。
   *    これが出せたときは、利用者はもう何も探さなくていい。
   */
  /* 0. 決着が付いたもの。ここに出せたなら、利用者はもう何も探さなくていい。 */
  const confirmed = report.confirmed || [];
  const pinned = report.pinned || [];
  if (confirmed.length) {
    body.append(el('div', 'sec-title', pick('特定できました', 'Identified')));
    body.append(para(pick(
      '名前・型・持ち主のクラスに加えて、実際に逆アセンブルして命令まで確かめた結果です。' +
      '選ぶだけで、そのまま書き換える場所まで開けます。',
      'Confirmed by disassembling the accessors and checking the instructions themselves.')));
    const ul = list();
    for (const p of confirmed.slice(0, 8)) {
      ul.append(pinnedRow(app, p, () => { sheet.close(); showPinned(app, p); }));
    }
    body.append(ul);
  }
  const nearly = pinned.filter((p) => p.verdict !== VERDICT.CONFIRMED && p.top);
  if (nearly.length) {
    body.append(el('div', 'sec-title', pick('ここまで絞れました（確定はしていません）',
      'Narrowed down (not confirmed)')));
    const ul = list();
    for (const p of nearly.slice(0, 6)) {
      ul.append(pinnedRow(app, p, () => { sheet.close(); showPinned(app, p); }));
    }
    body.append(ul);
    body.append(para(pick(
      '確定と言うには根拠が 1 つ足りないものです。開けば、何が足りないかが書いてあります。',
      'One piece of evidence short of confirmed — open each to see what is missing.'), 'sub'));
  }

  /*
   * 1. 次に地図。「このアプリはこういう部品でできている」。
   *    決着が付かなかった目的は、ここから自分で降りていくことになる。
   *    数万の関数をいきなり見せない、というのがこの部分の役目。
   */
  const map = report.map;
  if (map && map.subsystems.length) {
    body.append(el('div', 'sec-title', pick('このアプリは、こういう部品でできています',
      'What this app is made of')));
    const ul = list();
    for (const sub of map.subsystems.slice(0, 6)) {
      ul.append(subsystemRow(app, sub, () => { sheet.close(); showSubsystem(app, sub); }));
    }
    if (map.subsystems.length > 6) {
      ul.append(tapRow(pick('部品をすべて見る（' + map.subsystems.length + ' 個）',
        'See all ' + map.subsystems.length + ' parts'), {
        onTap: () => { sheet.close(); showAppMap(app, map); },
      }));
    }
    body.append(ul);
    if (map.byStrings) {
      body.append(para(pick(
        '※ Objective-C のクラス表がないため、使っている言葉だけで分けた粗い地図です。',
        'No class table here, so this grouping comes from text alone — a rough map.'), 'sub'));
    } else {
      body.append(para(pick(
        'クラス ' + (report.stats.classes || 0).toLocaleString() + ' 個、' +
        'その中の値 ' + (report.stats.fields || 0).toLocaleString() + ' 個の名前が読めました。' +
        'クラスを開くと、そのクラスが持っている値（HP や所持数）まで名前で分かります。',
        (report.stats.classes || 0).toLocaleString() + ' classes and ' +
        (report.stats.fields || 0).toLocaleString() + ' of their fields have readable names.'), 'sub'));
    }
  }

  /* 2. 値を書き換えている場所。目的が決まっていない人には、ここがいちばん効く。 */
  const withUpdates = report.deep.filter((d) => d.updates.length);
  if (withUpdates.length) {
    body.append(el('div', 'sec-title', pick('値を書き換えている場所（自動で見つけたもの）',
      'Places that change a value (found automatically)')));
    body.append(para(pick(
      '値を読み込み → 計算 → 同じ場所へ書き戻している処理です。' +
      'ゲームの数値を増やす／減らす処理は、この形をしています。',
      'These read a value, change it and write it back — the shape a game value change takes.')));
    const ul = list();
    for (const d of withUpdates.slice(0, 8)) {
      const u = d.updates[0];
      const where = placeName(u.field, u.location.base, u.location.disp);
      const verb = changeVerb(u.steps && u.steps.length ? u.steps[u.steps.length - 1] : null);
      /*
       * 見出しは「x0 + 0x20 を 1 増やす」ではなく「アイテムを 1 増やす処理」。
       * どこを触っているかは、その下に事実として残す（消さない）。
       */
      const title = d.role && d.role.action !== 'unknown'
        ? fnRoleTitle(d.role) : (where + ' を' + verb);
      ul.append(tapRow(title, {
        sub: [
          where + ' を' + verb,
          (d.owner ? d.owner.kind + '[' + d.owner.className + ' ' + d.owner.sel + ']'
            : (d.name || fnLabel(app, d.addr))) + '  ·  ' + addrHex(u.store.address),
          d.goalLabel ? pick('「' + d.goalLabel + '」の候補として見つかりました',
            'found while looking for “' + d.goalLabel + '”') : null,
        ].filter(Boolean).join('\n'),
        right: d.role ? verdictText(d.role.verdict) : '',
        tag: pick('事実', 'fact'), tagClass: 'tag-fact',
        onTap: () => { sheet.close(); showFunctionReport(app, d.addr); },
      }));
    }
    body.append(ul);
    body.append(para(pick(
      '※ 太字は「アプリの何の処理か」の名指しです。その下の 1 行が、実際に触っている場所' +
      '（こちらは命令から直接読めた事実）。名指しの根拠は、開いた先で 1 つずつ確かめられます。',
      'The heading names what the routine is for; the line under it is the location it really touches.'), 'sub'));
  }

  /* 3. 目的ごとの最有力候補（決着まで行かなかったもの） */
  if (report.goals.length) {
    body.append(el('div', 'sec-title', pick('目的ごとの最有力候補', 'Strongest candidate per goal')));
    body.append(para(pick(
      '16 個の目的すべてを自動で採点しました。★ が多いものほど根拠がそろっています。',
      'All 16 goals were scored automatically; more stars means more evidence.')));
    const ul = list();
    for (const g of report.goals) {
      const tag = roleTagline(app, g.best.addr);
      ul.append(tapRow((g.goal.icon ? g.goal.icon + ' ' : '') + g.goal.text, {
        sub: fnLabel(app, g.best.addr) + '  ·  ' + addrHex(g.best.addr) + '\n' +
          (tag ? tag + '\n' : '') + (reasonText(g.best.reasons[0]) || ''),
        right: starsText(g.best.stars),
        onTap: () => openGoal(g.goal),
      }));
    }
    body.append(ul);
  }

  /* 4. 気づいたこと（通信先・反解析・暗号…） */
  if (report.findings.length) {
    body.append(el('div', 'sec-title', pick('気づいたこと', 'What stood out')));
    const byId = new Map();
    for (const f of report.findings) {
      if (!byId.has(f.id)) byId.set(f.id, []);
      byId.get(f.id).push(f);
    }
    for (const [id, items] of byId) {
      const ul = list();
      ul.append(groupRow(findingTitle(id) + '  (' + items.length + ')'));
      const why = findingWhy(id);
      for (const f of items.slice(0, 6)) {
        const users = f.users.filter((u) => u.addr != null);
        ul.append(tapRow(trimText(f.text, 56), {
          sub: addrHex(f.addr) + (users.length
            ? '  ·  ' + pick(users.length + ' か所から使われています', 'used from ' + users.length + ' places')
            : '  ·  ' + pick('使っている場所は見つかりませんでした', 'no user found')),
          right: users.length ? '›' : '',
          onTap: users.length
            ? () => { sheet.close(); showFunctionReport(app, users[0].addr); }
            : () => { sheet.close(); showXrefs(app, f.addr); },
        }));
      }
      body.append(ul);
      if (why) body.append(para(why, 'sub'));
    }
  }

  /* 5. 目的とは無関係に「よく効く」関数 */
  if (report.notable.length) {
    body.append(el('div', 'sec-title', pick('注目すべき処理（回数と命令から）',
      'Routines worth a look (by counts, not names)')));
    const ul = list();
    for (const n of report.notable.slice(0, 8)) {
      const tag = roleTagline(app, n.addr);
      ul.append(tapRow(n.name || fnLabel(app, n.addr), {
        sub: (tag ? tag + '\n' : '') + addrHex(n.addr) + '\n' +
          n.reasons.slice(0, 2).map(notableReasonText).filter(Boolean).join('  ·  '),
        right: String(Math.round(n.score)),
        onTap: () => { sheet.close(); showFunctionReport(app, n.addr); },
      }));
    }
    body.append(ul);
  }

  /* 6. 言葉から分かった機能 */
  if (report.engine) body.append(noteBox(report.engine.note));
  if (report.features.length) {
    body.append(el('div', 'sec-title', pick('見つかった手がかり（言葉から）', 'Clues found (from text)')));
    const ul = list();
    for (const f of report.features.slice(0, 8)) {
      ul.append(tapRow(f.label, {
        right: String(f.items.length),
        sub: f.items.slice(0, 2).map((i) => '「' + trimText(i.text, 24) + '」').join('  '),
        onTap: () => { sheet.close(); showFeatureWords(app, f); },
      }));
    }
    body.append(ul);
  }

  /* 7. 目的から探す（ここまで見て、まだ見つからない人向け） */
  body.append(el('div', 'sec-title', pick('目的から探す', 'Search by goal')));
  body.append(goalChips(app, openGoal));
  body.append(goalInput(app, openGoal));

  /* 8. 次の一手 */
  const steps = autoNextSteps(report);
  if (steps.length) {
    const nb = block(pick('次にすること', 'What to do next'));
    const ol = el('ul', 'story-steps');
    steps.forEach((s, i) => {
      const text = autoStepText(s);
      if (!text) return;
      const li = el('li');
      li.append(el('i', null, String(i + 1) + '.'));
      li.append(el('span', null, text));
      ol.append(li);
    });
    nb.append(ol);
    body.append(nb);
  }

  /* 9. 何をどれだけ見たか（自動解析の範囲を隠さない） */
  body.append(para(pick(
    '自動解析の範囲: 文字列 ' + report.stats.strings.toLocaleString() + ' 本、' +
    '呼び出しの辺 ' + report.stats.calls.toLocaleString() + ' 本、' +
    'データ参照 ' + report.stats.refs.toLocaleString() + ' 件、' +
    '関数 ' + report.stats.functions.toLocaleString() + ' 個。' +
    'このうち ' + report.deep.length + ' 個の関数は、実際に命令まで読んでいます。' +
    (report.stats.statsComplete ? '' : ' ※ セクションが大きいため、命令の統計は一部だけです。') +
    (report.stats.capped ? ' ※ 索引が上限に達したため、後半の呼び出し・参照は入っていません。' : ''),
    'Scope: ' + report.stats.strings.toLocaleString() + ' strings, ' +
    report.stats.calls.toLocaleString() + ' call edges, ' +
    report.stats.refs.toLocaleString() + ' data references, ' +
    report.stats.functions.toLocaleString() + ' functions; ' +
    report.deep.length + ' of them were read instruction by instruction.'), 'sub'));
  body.append(para(pick(
    '※ ここに出ているのは候補です。★ や点数は「関連度」であって、正解の証明ではありません。' +
    'それぞれを開けば、なぜそう言えるのかを 1 点ずつ確認できます。',
    'These are candidates. Stars are relevance, not proof — open each one to see the evidence.'), 'sub'));
  void region;
}

/* ── 「何を調べたいですか？」 ───────────────────────────── */

export function showInvestigate(app) {
  const info = app.store.get('fileInfo');
  if (!info) { toast(t('err.openFirst')); return; }
  const sheet = new Sheet(pick('何を調べたいですか？', 'What do you want to find?'));
  const body = sheet.body;

  body.append(para(pick(
    'アセンブリの知識は要りません。調べたいものを選ぶか、ふつうの言葉で書いてください。',
    'No assembly knowledge needed. Pick something, or just describe it in your own words.')));

  const openGoal = (goal) => { sheet.close(); showCandidates(app, goal); };
  body.append(goalInput(app, openGoal));
  body.append(goalChips(app, openGoal));

  /*
   * ゲームの数値は、たいていアプリの中ではなく CSV や JSON に入っている。
   * その場合、名前で探しても当たらない代わりに「何列目か」から確実に降りられる。
   * 目的から探して駄目だったときの逃げ道ではなく、むしろ本道なので上に置く。
   */
  const tables = list();
  tables.append(groupRow(pick('数値の出どころから探す', 'Start from where the numbers come from')));
  tables.append(tapRow(pick('データの表（CSV・JSON）を見る', 'Look at the data tables (CSV / JSON)'), {
    sub: pick('「攻撃力は CSV の 4 列目」から、メモリ上の位置を出す',
      'turn “attack is the 4th column” into an offset'),
    right: '›',
    onTap: () => { sheet.close(); showDataTables(app); },
  }));
  body.append(tables);

  if (app.lastGoal) {
    const ul = list();
    ul.append(groupRow(pick('前回の続き', 'Where you left off')));
    ul.append(tapRow(goalLabel(app.lastGoal), {
      sub: pick('もう一度この目的で探す', 'search for this again'),
      onTap: () => openGoal(app.lastGoal),
    }));
    body.append(ul);
  }

  body.append(para(pick(
    '※ 見つかるのは「候補」です。言葉が一致しただけのものは上位に来ないよう、' +
    '実際の参照関係・呼び出し関係・命令の中身を合わせて点を付けています。',
    'These are candidates. Text matches alone do not rank highly — real references, call edges and instructions are weighed too.'), 'sub'));
}

/* ────────────────────────────────────────────────────────────
   データの表 — 「攻撃力は CSV の何列目か」から答えに降りる
   ────────────────────────────────────────────────────────────

   現代のモバイルゲームは、数値をコードに書かない。CSV や JSON に持っていて
   起動時に読む。だからバイナリの中に「攻撃力」という言葉は 1 つも無い。
   名前で探すやり方は、そこで行き止まりになる。

   ところが **何列目がどこに入るか** は、読み込みの命令にはっきり書いてある。

       str w0, [x28, x21, lsl #2]   ← i 列目を +i*4 に置く
       cmp x21, #0x75               ← 117 列

   ここまで読めれば、あとは手元の CSV を開いて「4 列目が攻撃力」と分かるだけで
   答えが出る。推測が 1 つも要らないので、このツールでいちばん確かな道になる。 */

export function showDataTables(app) {
  const info = app.store.get('fileInfo');
  if (!info) { toast(t('err.openFirst')); return; }
  const sheet = new Sheet(pick('データの表', 'Data tables'));
  const body = sheet.body;

  body.append(para(pick(
    'ゲームの数値は、アプリの中ではなく CSV や JSON に入っています。' +
    'その読み込み処理を読んで、「何列目がどこに置かれるか」を取り出しました。',
    'Game numbers live in CSV/JSON files, not in the code. ' +
    'These tables were recovered by reading the loader instructions.')));

  const box = progressBox(body, pick('読み込み処理を調べています…', 'Reading the loaders…'));
  const out = el('div');
  body.append(out);

  app.ensureSchemas((p) => box.set(p)).then((schemas) => {
    box.done();
    if (!sheet.root.isConnected) return;
    if (!schemas || !schemas.length) {
      out.append(para(pick(
        'データファイルを読み込んでいるところが見つかりませんでした。',
        'No data-file loader was found.'), 'sub'));
      return;
    }
    /*
     * つじつまの合った表を先に出す。
     * 「列数 × 1 列の大きさ ＝ 1 レコードの大きさ」が合っているものは、
     * 読み違いがまず無い。合っていないものも隠さないが、後ろに置く。
     */
    const sure = schemas.filter((s) => s.best.consistent === true);
    const rest = schemas.filter((s) => s.best.consistent !== true);

    if (sure.length) {
      const ul = list();
      ul.append(groupRow(pick('形まで確かめられた表', 'Tables whose shape checks out')));
      for (const s of sure) ul.append(schemaRow(app, sheet, s));
      out.append(ul);
    }
    if (rest.length) {
      out.append(disclosure(pick(
        'そこまで確かめられなかった表（' + rest.length + ' 件）',
        rest.length + ' tables that could not be fully checked'), {
        build: (holder) => {
          const ul = list();
          for (const s of rest.slice(0, 60)) ul.append(schemaRow(app, sheet, s));
          holder.append(ul);
        },
      }));
    }
  }).catch((err) => {
    box.done();
    out.append(para(pick('調べているうちに問題が起きました: ', 'Something went wrong: ') +
      (err && err.message ? err.message : String(err))));
  });
}

function schemaShapeText(b) {
  const parts = [];
  if (b.columns != null) parts.push(pick(b.columns + ' 列', b.columns + ' columns'));
  if (b.columnStride) parts.push(pick('1 列 ' + b.columnStride + ' バイト', b.columnStride + ' bytes each'));
  if (b.recordStride != null) {
    parts.push(pick('1 件 ' + addrHex(BigInt(b.recordStride)) + ' バイト',
      addrHex(BigInt(b.recordStride)) + ' per record'));
  }
  if (b.records != null) parts.push(pick(b.records + ' 件', b.records + ' records'));
  return parts.join('  ·  ');
}

function schemaRow(app, sheet, s) {
  const files = s.files.slice(0, 3).join(', ') + (s.files.length > 3 ? ' …' : '');
  return tapRow(files, {
    sub: schemaShapeText(s.best),
    right: '›',
    onTap: () => { sheet.close(); showDataTable(app, s); },
  });
}

/** 表 1 つぶん。ここで「何列目 → どのずらし幅」を引く。 */
export function showDataTable(app, schema) {
  const b = schema.best;
  const sheet = new Sheet(schema.files[0] || pick('データの表', 'Data table'));
  const body = sheet.body;

  if (schema.files.length > 1) {
    body.append(para(pick(
      'この処理は ' + schema.files.length + ' 個のファイルを読み込んでいます: ',
      'This loader reads ' + schema.files.length + ' files: ') + schema.files.join(', '), 'sub'));
  }

  const facts = list();
  facts.append(groupRow(pick('表の形', 'Shape of the table')));
  if (b.columns != null) facts.append(kvRow(pick('列の数', 'Columns'), String(b.columns)));
  if (b.columnStride) {
    facts.append(kvRow(pick('1 列の大きさ', 'Bytes per column'), b.columnStride + pick(' バイト', ' bytes')));
  }
  if (b.recordStride != null) {
    facts.append(kvRow(pick('1 件の大きさ', 'Bytes per record'), addrHex(BigInt(b.recordStride))));
  }
  if (b.records != null) facts.append(kvRow(pick('件数', 'Records'), String(b.records)));
  facts.append(tapRow(pick('置き場所を決めている命令', 'The instruction that places each column'), {
    sub: addrHex(b.storeAddr),
    right: '›',
    onTap: () => { sheet.close(); app.goToAddress(b.storeAddr, { announce: true }); },
  }));
  facts.append(tapRow(pick('読み込み処理', 'The loader'), {
    sub: addrHex(schema.loader),
    right: '›',
    onTap: () => { sheet.close(); showFunctionReport(app, schema.loader, app.lastGoal || null); },
  }));
  body.append(facts);

  if (b.consistent === true) {
    body.append(noteBox(pick(
      '列の数 × 1 列の大きさが、1 件の大きさとぴったり合っています。' +
      'この表の読み取りは、まず間違っていません。',
      'columns × bytes-per-column exactly equals the record size, so this reading is sound.')));
  } else if (b.consistent === false) {
    body.append(noteBox(pick(
      '列の数と 1 件の大きさが合っていません。どちらかを読み違えている可能性があります。',
      'The column count and the record size do not agree — one of them may be misread.')));
  }

  if (b.scaled && b.scaled.length) {
    body.append(para(pick(
      '読み込んだあと、' + b.scaled.map((x) => '×' + x.factor).join('・') +
      ' の倍率が掛かっている列があります（％の値を整数で持つときの書き方）。',
      'Some columns are multiplied by ' + b.scaled.map((x) => '×' + x.factor).join(', ') +
      ' after loading — the usual way of keeping a percentage as an integer.'), 'sub'));
  }

  /* ── 列 ↔ ずらし幅 ─────────────────────────────────────
     ここがこの画面の本体。手元の CSV を開いて数えた列番号を入れると、
     メモリ上のずらし幅が出る。逆も引ける。 */
  body.append(heading(pick('何列目が、どこにあるか', 'Which column sits where')));
  body.append(para(pick(
    '手元の ' + (schema.files[0] || 'CSV') + ' を開いて、変えたい数値が左から何番目かを数えてください。',
    'Open your copy of ' + (schema.files[0] || 'the CSV') +
    ' and count which column holds the number you want.'), 'sub'));

  const answer = el('div', 'hint');
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'number';
  input.min = '1';
  input.placeholder = pick('例: 4（左から 4 番目）', 'e.g. 4 (the 4th column)');
  const go = () => {
    const nth = Number(input.value);
    if (!(nth >= 1)) {
      answer.textContent = pick('1 以上の数を入れてください。', 'Enter a number of 1 or more.');
      return;
    }
    const off = columnToOffset(schema, nth - 1);
    if (off == null) {
      answer.textContent = pick(
        'この表は ' + (b.columns != null ? b.columns + ' 列までです。' : '列の数が読み取れていません。'),
        b.columns != null ? 'This table only has ' + b.columns + ' columns.' : 'The column count could not be read.');
      return;
    }
    answer.textContent = pick(
      nth + ' 列目は、1 件の先頭から +' + addrHex(BigInt(off)) + ' にあります。',
      'Column ' + nth + ' sits at +' + addrHex(BigInt(off)) + ' from the start of a record.');
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  field.append(input, button(pick('どこにあるか', 'Where is it'), 'chip', go));
  body.append(field, answer);

  /* 先頭の何列かは、そのまま並べて見せる（入力しなくても分かるように） */
  if (b.columns != null) {
    const ul = list();
    ul.append(groupRow(pick('はじめの方の列', 'The first few columns')));
    for (let i = 0; i < Math.min(12, b.columns); i++) {
      const off = columnToOffset(schema, i);
      if (off == null) continue;
      ul.append(kvRow(pick((i + 1) + ' 列目', 'Column ' + (i + 1)), '+' + addrHex(BigInt(off))));
    }
    body.append(ul);
  }

  body.append(noteBox(pick(
    'ここで出るのは「1 件の先頭からのずらし幅」です。' +
    '表そのものの置き場所は、読み込み処理の中で作られています。',
    'These are offsets from the start of one record. ' +
    'Where the table itself lives is set up inside the loader.')));
}

/* ── 候補のランキング ───────────────────────────────────── */

export function showCandidates(app, goal) {
  if (!goal) return;
  app.lastGoal = goal;
  const sheet = new Sheet(goalLabel(goal), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onScanProgress = null; },
  });
  const body = sheet.body;
  const box = progressBox(body, pick('調べています…', 'Working…'));
  const results = el('div');
  body.append(results);

  prepare(app, box).then(async ({ strings, program, shapes }) => {
    if (!sheet.root.isConnected) { box.done(); return; }
    const region = app.codeRegion();

    /*
     * まず「これです」を出しにいく。候補一覧はその下。
     * 選んだ人がやりたいのは候補を吟味することではなく、値を見つけることなので。
     * 候補一覧は、クラス表のないバイナリで「場所」を決めるときの材料にもなるので先に作る。
     */
    const ranked = rankCandidates({
      goal, strings, program, symbols: app.symbols, region, limit: 40,
    });
    const pin = await pinnedFor(app, goal, {
      strings, program, shapes, region, box, ranked: ranked.candidates,
    });
    box.done();
    if (!sheet.root.isConnected) return;
    if (pin && pin.top) {
      results.append(verdictBadge(pin.verdict));
      results.append(pinnedHeadline(pin));
      const top = list();
      top.append(tapRow(pick('なぜこれだと言えるのか、根拠をすべて見る',
        'See every piece of evidence'), {
        sub: pick('確からしさ ' + probabilityText(pin.top.fusion.probability) +
          '  ·  ' + pin.universe.toLocaleString() + ' 個の値の中から',
        probabilityText(pin.top.fusion.probability) + ' confident, out of ' +
          pin.universe.toLocaleString() + ' values'),
        right: '›',
        onTap: () => { sheet.close(); showPinned(app, pin); },
      }));
      const write = (pin.changeSites || []).find((s) => s.stores);
      if (write) {
        top.append(tapRow(pick('この値を書き換えている場所を開く', 'Open the place that changes it'), {
          sub: (write.owner ? write.owner.kind + '[' + write.owner.className + ' ' + write.owner.sel + ']  ·  ' : '') +
            addrHex(write.first),
          right: '✎',
          onTap: () => {
            sheet.close();
            if (write.addr != null) showFunctionReport(app, write.addr, goal);
            else app.goToAddress(write.first, { announce: true });
          },
        }));
      }
      results.append(top);
      results.append(el('div', 'sec-title', pick('関係のありそうな処理', 'Routines that may be involved')));
    }

    if (!ranked.candidates.length) {
      if (pin && pin.top) return;   // 値は特定できている。処理が無いだけ。
      results.append(para(pick(
        '手がかりが見つかりませんでした。', 'Nothing was found.')));
      const why = [];
      if (!ranked.matchedStrings.length) {
        why.push(pick('この目的に関係のある文字列が 1 つもありませんでした。',
          'No text in this binary matches what you are looking for.'));
      } else if (ranked.notes.includes('strings-unreferenced')) {
        why.push(pick('関係のありそうな文字列は ' + ranked.matchedStrings.length +
          ' 本ありましたが、それを参照している命令が見つかりませんでした。' +
          '文字列が別の実行ファイル（Unity の il2cpp など）から使われている可能性があります。',
        'Matching text exists but nothing in this section references it — the code may live in another binary.'));
      }
      if (ranked.notes.includes('no-program-index')) {
        why.push(pick('呼び出し関係の索引が作れていないため、参照からは探せていません。',
          'The call/reference index could not be built, so references were not used.'));
      }
      for (const line of why) results.append(para(line, 'sub'));
      if (ranked.matchedStrings.length) {
        const ul = list();
        ul.append(groupRow(pick('一致した言葉（参照元は不明）', 'Matching text (no references found)')));
        for (const s of ranked.matchedStrings.slice(0, 30)) {
          ul.append(tapRow(trimText(s.text, 48), {
            sub: addrHex(s.addr),
            onTap: () => { sheet.close(); showXrefs(app, s.addr); },
          }));
        }
        results.append(ul);
      }
      return;
    }

    results.append(para(pick(
      ranked.total + ' 個の候補が見つかりました。上から順に、根拠の強いものです。',
      'Found ' + ranked.total + ' candidates, strongest evidence first.')));
    results.append(para(pick(
      '★ は「今見るべき順」です。名前が一致しただけでは星は増えません。',
      'Stars mean “look here first”. A name match alone does not earn stars.'), 'sub'));

    const ul = list();
    for (const c of ranked.candidates) {
      const top = c.reasons.slice(0, 2).map(reasonText).filter(Boolean);
      // 名前だけでは何の処理か分からないので、役割の下見を 1 行目に置く
      const tag = roleTagline(app, c.addr);
      const row = tapRow(fnLabel(app, c.addr), {
        sub: (tag ? tag + '\n' : '') + addrHex(c.addr) + '\n' + top.join('\n'),
        right: starsText(c.stars),
        onTap: () => { sheet.close(); showCandidateWhy(app, c, goal); },
      });
      row.classList.add('cand');
      row.append(el('span', 'cand-score', Math.round(c.confidence * 100) + '%'));
      ul.append(row);
    }
    results.append(ul);
    results.append(para(pick(
      '※ この点数は「関連度」であって、正解であることの証明ではありません。' +
      'それぞれの候補で「なぜこの点になったか」を必ず確認してください。',
      'The score is relevance, not proof. Always check why each candidate scored what it did.'), 'sub'));
  }).catch((err) => {
    box.done();
    alertDialog(t('search.failed'), err && err.message ? err.message : String(err));
  });
}

/** 「なぜこの候補なのか」— 点数の内訳をそのまま見せる。 */
export function showCandidateWhy(app, cand, goal) {
  const sheet = new Sheet(fnLabel(app, cand.addr));
  const body = sheet.body;

  const head = el('div', 'fn-head');
  head.append(el('div', 'fn-name', fnLabel(app, cand.addr)));
  head.append(el('div', 'fn-range mono', addrHex(cand.addr)));
  body.append(head);

  const score = el('div', 'scorebox');
  score.append(el('div', 'score-stars', starsText(cand.stars)));
  score.append(el('div', 'score-pct', pick('関連度 ' + Math.round(cand.confidence * 100) + '%',
    Math.round(cand.confidence * 100) + '% related')));
  score.append(el('div', 'score-sub', pick('合計 ' + Math.round(cand.score) + ' 点',
    Math.round(cand.score) + ' points')));
  body.append(score);

  body.append(el('div', 'sec-title', pick('この点数の内訳', 'How this score was built')));
  const ul = list();
  for (const r of breakdown(cand)) {
    const text = reasonText(r);
    if (!text) continue;
    const row = tapRow(text, {
      right: (r.points >= 0 ? '+' : '') + Math.round(r.points),
      tag: certaintyWord(reasonKind(r.code)),
      tagClass: reasonKind(r.code) === 'fact' ? 'tag-fact' : 'tag-infer',
      sub: r.count > 1 ? pick(r.count + ' 件', r.count + ' items') : null,
    });
    ul.append(row);
  }
  body.append(ul);
  body.append(para(pick(
    '「事実」はバイナリから直接読めたこと、「推測」はそこから組み立てた解釈です。' +
    '事実だけを根拠に、推測は分けて表示しています。',
    '“Fact” means read directly from the binary; “inference” is what was built on top of it.'), 'sub'));

  /* 参照している、目的に関係する文字列 */
  if (cand.strings && cand.strings.length) {
    body.append(el('div', 'sec-title', pick('この関数が参照している言葉', 'Text this function references')));
    const sul = list();
    for (const s of cand.strings.slice(0, 10)) {
      sul.append(tapRow(trimText(s.text, 48), {
        sub: pick('文字列 ' + addrHex(s.addr) + ' を、' + addrHex(s.site) + ' の命令が参照',
          'text at ' + addrHex(s.addr) + ', referenced by the instruction at ' + addrHex(s.site)),
        onTap: () => {
          sheet.close();
          app.goToAddress(s.site, { announce: true });
          app.analyzeFunctionAt(s.site);
        },
      }));
    }
    body.append(sul);
  }

  const actions = el('div', 'detail-actions');
  actions.append(button(pick('この関数を詳しく調べる', 'Investigate this function'), 'chip', () => {
    sheet.close();
    showFunctionReport(app, cand.addr, goal);
  }));
  actions.append(button(pick('コードへ移動', 'Go to the code'), 'chip', () => {
    sheet.close();
    app.goToFunction(cand.addr);
  }));
  body.append(actions);
}

/* ────────────────────────────────────────────────────────────
   関数の役割 — 「sub_100A3C0」に、アプリの言葉で名前を付ける
   ────────────────────────────────────────────────────────────

   `sub_100A3C0` と出た瞬間に読む人は止まる。命令の説明をいくら足しても
   「で、これは何の処理なの？」には答えていないため。関数を出すところには
   必ずこの 1 行を添える。言い切れないところは言い切らない（role.js）。   */

/**
 * 一覧に添える役割の下見。逆アセンブルしないので、行が何十個あっても重くならない。
 * 索引ができていなければ静かに諦める（一覧が出ないより、札が無い方がまし）。
 */
function roleSketchFor(app, addr) {
  const program = app.program;
  if (!program || addr == null) return null;
  if (!program.roleCache) program.roleCache = new Map();
  const key = addr.toString();
  if (program.roleCache.has(key)) return program.roleCache.get(key);
  let role = null;
  try {
    role = sketchRole({
      start: addr, program, symbols: app.symbols,
      fields: app.fields, strings: app.stringIndex || [],
    });
  } catch { role = null; }        // 下見でつまずいても、一覧そのものは出す
  program.roleCache.set(key, role);
  return role;
}

/**
 * 一覧の行に出す役割の 1 行。名指しできなければ空文字を返す（埋めない）。
 *
 * 下見には必ず「たぶん」を付ける。下見は値の書き換えまで見えていないので、
 * 開いたときの結論と食い違うことがある（一覧では「判定」、開くと「HP を減らす」）。
 * このとき一覧の方が自信ありげに見えるのが、いちばん困る。だから
 * 中身を読んでいない札は、必ず中身を読んだ札より弱く見えるようにしておく。
 */
function roleTagline(app, addr) {
  const role = roleSketchFor(app, addr);
  if (!role || role.action === 'unknown') return '';
  /*
   * 中身の無い札は出さない。
   *
   * 機能が決まらず、触っている値も見えていないと、残るのは命令の形だけ
   * （「しきい値と比べて判定する処理」）。それは、どの関数にも当てはまる。
   * 一覧の全行に同じ文が並ぶだけで、読む人の手がかりは 1 つも増えない。
   * 言うことが無いときは黙る。
   */
  const hasTopic = role.topic && role.topicSettled !== false;
  const hasSubject = role.subject && role.subject.kind !== 'none';
  if (!hasTopic && !hasSubject) return '';
  const title = fnRoleTitle(role);
  if (!title) return '';
  return role.depth === 'sketch' || role.verdict === VERDICT.AMBIGUOUS ||
    role.verdict === VERDICT.NONE
    ? pick('たぶん ' + title, 'probably ' + title)
    : title;
}

/**
 * 関数の画面のいちばん上に置く見出し。
 * 「何の処理か」→「どれくらい確かか」→「変えているのはどの値か」の順。
 * 読む人がいちばん最初に知りたい順に並べてある。
 */
function roleHeadline(app, role, sheet, region) {
  const wrap = el('div', 'rolebox verdict-' + role.verdict);
  wrap.append(el('div', 'role-title', fnRoleTitle(role)));

  const badge = el('div', 'role-verdict');
  badge.append(el('span', 'role-word', verdictText(role.verdict)));
  if (role.probability > 0) {
    // 裸の「2%」は、見出しと矛盾しているように読める。何の数字かを必ず添える。
    badge.append(el('span', 'role-pct', pick('確からしさ ', 'confidence ') +
      probabilityText(role.probability)));
  }
  wrap.append(badge);
  wrap.append(el('div', 'role-lead', fnRoleLead(role)));

  const target = fnRoleTargetLine(role);
  if (target) wrap.append(el('div', 'role-target', target));

  const topicLine = fnRoleTopicLine(role);
  if (topicLine) wrap.append(el('div', 'role-topic', topicLine));

  const alt = fnRoleAlternative(role);
  if (alt) wrap.append(el('div', 'role-alt', alt));

  /* 値を書き換えている処理なら、その命令まで 1 タップで降りられるようにする。 */
  if (changesValue(role.action) && role.row != null && region) {
    wrap.append(button(pick('書き換えている命令へ移動', 'Go to the instruction that changes it'),
      'chip', () => {
        if (sheet) sheet.close();
        app.viewer.goToRow(role.row, 'third');
        app.viewer.select(role.row, false);
        app.viewer.mark(role.row);
      }));
  }
  return wrap;
}

/**
 * 「なぜ、この名前だと言えるのか」。
 * 倍率つきの証拠と、言い切れない理由を、隠さずに並べる。
 */
function roleWhySection(role) {
  const wrap = el('div');
  wrap.append(el('div', 'sec-title', pick('なぜ、この処理だと言えるのか',
    'Why it can be named this')));
  wrap.append(para(pick(
    '下の 1 行ずつが独立した根拠です。右の数字は「その根拠があると、確からしさが' +
    '何倍になるか」です。「検証済」は、実際に命令を読んで確かめたものです。',
    'Each line is an independent piece of evidence; the number is how much it multiplies the odds.')));

  const wl = list();
  let shown = 0;
  for (const e of role.evidence) {
    const text = roleProofText(e);
    if (!text) continue;
    shown++;
    const kind = e.kind === 'verified' ? pick('検証済', 'verified')
      : e.kind === 'fact' ? pick('事実', 'fact') : pick('推測', 'inference');
    wl.append(tapRow(text, {
      right: factorText(e.factor),
      tag: kind,
      tagClass: e.kind === 'inference' ? 'tag-infer' : 'tag-fact',
      sub: e.count > 1 ? pick(e.count + ' 件', e.count + ' items') : null,
    }));
  }
  if (!shown) {
    wl.append(tapRow(pick('根拠になるものが見つかりませんでした。', 'No evidence was found.'),
      { disabled: true }));
  }
  wrap.append(wl);

  if (role.verdict !== VERDICT.CONFIRMED && role.missing.length) {
    const nb = block(pick('言い切れない理由', 'Why this is not confirmed'));
    const ol = el('ul', 'story-steps');
    for (const m of role.missing) {
      const text = roleMissingText(m);
      if (!text) continue;
      const li = el('li');
      li.append(el('i', null, '•'));
      li.append(el('span', null, text));
      ol.append(li);
    }
    nb.append(ol);
    wrap.append(nb);
  }
  return wrap;
}

/** 役割の見出しと、その根拠。関数を出す画面から使い回す。 */
function roleSection(app, role, sheet, region) {
  const wrap = el('div');
  if (!role) return wrap;
  wrap.append(roleHeadline(app, role, sheet, region));
  wrap.append(disclosure(pick('この名前の根拠を見る（証拠と、言い切れない理由）',
    'Show why it is named this'), { build: (into) => into.append(roleWhySection(role)) }));
  return wrap;
}

/* ── 関数レポート（事実 / 推測 / 不明を分けて出す） ─────── */

export function showFunctionReport(app, addr, goal) {
  const region = app.codeRegion() || app.store.get('currentRegion');
  if (!region) { toast(t('err.openFirst')); return; }
  if (app.store.get('currentRegion') !== region) app.selectRegion(region, { silent: true });

  const sym = app.symbols;
  const fn = sym.functionCount ? sym.functionAt(addr) : null;
  const start = fn ? fn.start : addr;
  const startRow = Number((start - region.vmAddr) / 4n);
  const endRow = fn && fn.end != null
    ? Math.min(app.viewer.totalRows - 1, Number((fn.end - region.vmAddr) / 4n) - 1)
    : Math.min(app.viewer.totalRows - 1, startRow + 2048);
  if (!(startRow >= 0) || endRow < startRow) {
    toast(pick('この場所は関数として読めませんでした。', 'This place could not be read as a function.'));
    return;
  }

  const name = sym.nameAt(start);
  const sheet = new Sheet(pick('この関数について', 'About this function'));
  const body = sheet.body;
  const box = progressBox(body, t('functions.analyzing'));
  const later = el('div');
  body.append(later);

  Promise.all([
    analyzeFunctionCached(app.backend, region, startRow, endRow, sym, (p) => box.set({ done: p, all: 1 })),
    app.ensureProgram(),
  ]).then(([res, program]) => {
    box.done();
    if (!sheet.root.isConnected) return;
    applySemantic(app, region, res);
    const report = buildFunctionReport({
      model: res.model, region, symbols: sym, program, goal, name,
      // クラスとフィールドが読めていれば、x0+0x20 は self.hp として説明される
      fields: app.fields, owner: app.ownerOf(start),
    });
    report.role = roleFromReport(report, { apis: res.model.facts.apis });
    renderFunctionReport(app, sheet, later, report, res, region, goal);
  }).catch((err) => {
    box.done();
    alertDialog(t('search.failed'), err && err.message ? err.message : String(err));
  });
}

function renderFunctionReport(app, sheet, body, report, res, region, goal) {
  const id = report.identity;

  const head = el('div', 'fn-head');
  head.append(el('div', 'fn-name', id.name || fnLabel(app, id.startAddr)));
  head.append(el('div', 'fn-range mono', addrHex(id.startAddr) + ' – ' + addrHex(id.endAddr)));
  body.append(head);

  /*
   * 説明は 3 段。既定で見えるのは 1 段目と 2 段目だけにする。
   *
   *   1. ひとこと      … 「BattleManager の hp を 10 減らす処理です」
   *   2. どういうこと  … 受け取る値 / 変えるもの / 返すもの / 呼ばれ方（4 行まで）
   *   3. 詳しく        … 事実・推測・分からないこと（畳んでおく）
   *
   * 説明は具体的すぎると、かえって「で、何がしたい処理なの？」が消えてしまう。
   * だから詳細は、降りたい人だけが降りられる場所に置く。
   */
  if (report.owner) {
    body.append(el('div', 'owner-line', pick(
      report.owner.className + ' のメソッド', 'a method of ' + report.owner.className)));
  }
  /*
   * 0 段目 — この関数の名前。`sub_100A3C0` のままでは何も分からないので、
   * アプリの言葉で名指しし直す。命令の説明より先に、ここを読んでもらう。
   */
  if (report.role) body.append(roleSection(app, report.role, sheet, region));
  body.append(el('div', 'lead', oneLiner(report, id.name)));
  const what = whatItDoes(report);
  if (what.length) {
    const ul0 = el('ul', 'story-steps');
    for (const line of what) {
      const li = el('li');
      li.append(el('i', null, '・'));
      li.append(el('span', null, line));
      ul0.append(li);
    }
    body.append(ul0);
  }

  /* 3. 詳しく — 事実 / 推測 / 分からないこと。既定では畳んでおく。 */
  body.append(disclosure(pick('詳しく見る（事実・推測・分からないこと）',
    'Show the detail (facts, inferences, unknowns)'), {
    build: (into) => {
      into.append(storySection(app, res.model, id.name, sheet));

      const factBlk = block(pick('確かなこと（バイナリから直接読めたこと）',
        'Facts — read directly from the binary'));
      const ful = list();
      let shown = 0;
      for (const f of report.facts) {
        const text = factText(f);
        if (!text) continue;
        shown++;
        ful.append(tapRow(text, {
          tag: certaintyWord('fact'), tagClass: 'tag-fact',
          sub: f.row >= 0 ? addrHex(region.vmAddr + BigInt(f.row) * 4n) : null,
          disabled: f.row < 0,
          onTap: f.row >= 0 ? () => {
            sheet.close();
            app.viewer.goToRow(f.row, 'third');
            app.viewer.select(f.row, false);
            app.viewer.mark(f.row);
          } : null,
        }));
      }
      if (!shown) {
        ful.append(tapRow(pick('数えられる事実がありませんでした。', 'Nothing countable was found.'),
          { disabled: true }));
      }
      factBlk.append(ful);
      into.append(factBlk);

      const infBlk = block(pick('ここから推測できること', 'What can be inferred from that'));
      const iul = list();
      let inferred = 0;
      for (const i of report.inferences) {
        const text = inferenceText(i);
        if (!text) continue;
        inferred++;
        iul.append(tapRow(text, {
          tag: certaintyWord('inference'), tagClass: 'tag-infer',
          right: Math.round(i.confidence * 100) + '%',
          sub: pick('根拠 ' + i.evidence.length + ' 件', i.evidence.length + ' pieces of evidence'),
          onTap: () => showEvidence(app, text, i),
        }));
      }
      if (!inferred) {
        iul.append(tapRow(pick('推測できることはありませんでした（手がかり不足）。',
          'Nothing could be inferred — not enough clues.'), { disabled: true }));
      }
      infBlk.append(iul);
      into.append(infBlk);

      const unkBlk = block(pick('このツールでは分からないこと', 'What this tool cannot tell you'));
      const uul = list();
      for (const u of report.unknowns) {
        const text = unknownText(u);
        if (text) {
          uul.append(tapRow(text, {
            tag: certaintyWord('unknown'), tagClass: 'tag-unknown', disabled: true,
          }));
        }
      }
      unkBlk.append(uul);
      into.append(unkBlk);
    },
  }));

  /* 5. 変更候補 — このツールの目的地のひとつ */
  if (report.editTargets.length) {
    const eb = block(pick('値を書き換えている場所（変更候補）', 'Where a value is changed'));
    eb.append(para(pick(
      'ここで値を読んで、計算して、同じ場所へ書き戻しています。' +
      '「その値を増やしたい」なら、まずここを見てください。',
      'Here a value is read, changed and written back — the first place to look if you want to change it.')));
    const eul = list();
    for (const e of report.editTargets) {
      eul.append(tapRow(addrHex(e.address), {
        sub: updateLines(e).join('\n'),
        tag: certaintyWord(e.level === 'confirmed' ? 'fact' : 'inference'),
        tagClass: e.level === 'confirmed' ? 'tag-fact' : 'tag-infer',
        onTap: () => { sheet.close(); showValueFlow(app, res.model, e.row, region); },
      }));
    }
    eb.append(eul);
    eb.append(noteBox(pick(
      'ただし、この解析だけでは「ここを変えれば狙った値が変わる」ことまでは保証できません。' +
      'その場所が実行時に何を表しているかは、動かして確かめる必要があります。',
      'This analysis cannot prove that changing this will change what you want. Only running the app can confirm that.')));
    body.append(eb);
  }

  /* 6. 呼び出し関係 */
  const callBlk = block(pick('呼び出し関係', 'Call relationships'));
  const cul = list();
  cul.append(groupRow(pick('この関数を呼んでいる (' + report.callers.length + ')',
    'Callers (' + report.callers.length + ')')));
  if (!report.callers.length) {
    cul.append(tapRow(pick('見つかりませんでした。実行時に呼ばれる形かもしれません。',
      'None found — it may only be reached at run time.'), { disabled: true }));
  }
  for (const c of report.callers.slice(0, 12)) {
    const cRole = c.addr != null ? roleTagline(app, c.addr) : '';
    cul.append(tapRow(c.name || (c.addr != null ? 'sub_' + c.addr.toString(16).toUpperCase() : addrHex(c.site)), {
      sub: (cRole ? cRole + '\n' : '') + addrHex(c.site) + pick(' から呼び出し', ' calls here'),
      right: c.count > 1 ? '× ' + c.count : '',
      onTap: () => { sheet.close(); showFunctionReport(app, c.addr != null ? c.addr : c.site, goal); },
    }));
  }
  cul.append(groupRow(pick('この関数が呼んでいる (' + report.callees.length + ')',
    'Callees (' + report.callees.length + ')')));
  if (!report.callees.length) {
    cul.append(tapRow(pick('ほかの処理は呼んでいません。', 'It calls nothing else.'), { disabled: true }));
  }
  for (const c of report.callees.slice(0, 12)) {
    const eRole = roleTagline(app, c.addr);
    cul.append(tapRow(c.name || 'sub_' + c.addr.toString(16).toUpperCase(), {
      sub: (eRole ? eRole + '\n' : '') + addrHex(c.addr),
      right: c.count > 1 ? '× ' + c.count : '',
      onTap: () => { sheet.close(); showFunctionReport(app, c.addr, goal); },
    }));
  }
  callBlk.append(cul);
  callBlk.append(para(pick(
    '※ 各行の 1 行目は「その関数が何の処理か」です。「たぶん」と書いてあるものは、' +
    '索引だけで見た下見です。その関数を開くと、命令まで降りて言い直します。',
    'The first line of each row says what that function is for. Lines marked “probably” are index-only previews.'), 'sub'));
  callBlk.append(button(pick('呼び出しの流れを図で見る', 'Show the call graph'), 'chip', () => {
    sheet.close();
    showCallGraph(app, id.startAddr);
  }));
  body.append(callBlk);

  /* 7. 処理の流れ（制御フロー） */
  body.append(disclosure(pick('処理の流れを見る（条件分岐とループ）', 'Show the flow (branches and loops)'), {
    build: (into) => into.append(cfgSection(app, report, region, sheet)),
  }));

  /* 8. 処理のまとまり → ARM64（従来の道筋をそのまま残す） */
  body.append(disclosure(pick('処理のまとまりを見る', 'Show the steps'), {
    build: (into) => into.append(blockListSection(app, res.model, sheet, region)),
  }));
  body.append(disclosure(pick('ARM64 を見る（命令と数字）', 'Show the ARM64 details'), {
    build: (into) => into.append(rawSection(app, sheet, res, id.name, region)),
  }));

  /* 9. 次に何をすればいいか */
  const nb = block(pick('次に確認すること', 'What to check next'));
  const nl = el('ul', 'story-steps');
  report.nextSteps.forEach((s, i) => {
    const text = nextStepText(s);
    if (!text) return;
    const li = el('li');
    li.append(el('i', null, String(i + 1) + '.'));
    li.append(el('span', null, text));
    nl.append(li);
  });
  nb.append(nl);
  body.append(nb);

  /* 10. どこからでも降りられるようにする */
  const actions = el('div', 'detail-actions');
  actions.append(button(pick('コードへ移動', 'Go to the code'), 'chip', () => {
    sheet.close();
    app.goToFunction(id.startAddr);
  }));
  actions.append(button(pick('アドレスの対応を見る', 'Show address mapping'), 'chip', () => {
    showAddressInfo(app, id.startAddr);
  }));
  actions.append(button(pick('16 進で見る', 'Show the raw bytes'), 'chip', () => {
    sheet.close();
    app.goToAddress(id.startAddr, { announce: true });
    app.setMode('hex');
  }));
  body.append(actions);
}

/** 推測 1 つぶんの根拠を並べる。 */
function showEvidence(app, title, inf) {
  const sheet = new Sheet(pick('この推測の根拠', 'Evidence for this'));
  sheet.body.append(para(title));
  sheet.body.append(el('span', 'conf lv-' + levelOf(inf.confidence), confidenceText(inf.confidence)));
  const ul = list();
  for (const e of inf.evidence) {
    const text = evidenceText(e) || factText({ code: e.code, detail: e.detail });
    ul.append(tapRow(text || e.code, { disabled: true, tag: certaintyWord('fact'), tagClass: 'tag-fact' }));
  }
  sheet.body.append(ul);
  sheet.body.append(para(pick(
    '根拠はすべてバイナリから読み取った事実です。そこから先の解釈は、この確度つきで示しています。',
    'Every item above is a fact read from the binary; the interpretation carries the confidence shown.'), 'sub'));
  void app;
}

/** 制御フローを、初心者に読める形の道順で出す。 */
function cfgSection(app, report, region, sheet) {
  const wrap = el('div');
  const cfg = report.cfg;
  if (!cfg || !cfg.nodes.length) {
    wrap.append(para(pick('処理の流れを取り出せませんでした。', 'The flow could not be extracted.')));
    return wrap;
  }
  const shapes = cfg.shapes || [];
  if (shapes.length) {
    const sul = list();
    sul.append(groupRow(pick('この関数の形', 'The shape of this routine')));
    const seen = new Set();
    for (const s of shapes) {
      const text = shapeText(s);
      if (!text || seen.has(text + s.at)) continue;
      seen.add(text + s.at);
      const node = cfg.nodes[s.at != null ? s.at : s.header];
      sul.append(tapRow(text, {
        sub: node ? addrHex(region.vmAddr + BigInt(node.startRow) * 4n) : null,
        onTap: node ? () => {
          sheet.close();
          app.viewer.goToRow(node.startRow, 'third');
          app.viewer.mark(node.startRow);
        } : null,
      }));
    }
    wrap.append(sul);
  } else {
    wrap.append(para(pick('枝分かれのない、上から下へ流れるだけの関数です。',
      'A straight-line routine: no branches at all.')));
  }

  const lines = [];
  for (const o of outline(cfg)) {
    const indent = '  '.repeat(o.depth);
    const addr = addrHex(region.vmAddr + BigInt(o.startRow) * 4n);
    const label = o.role ? roleLabel(o.role) : pick('処理', 'block');
    const mark = o.marker === 'loop-start' ? pick('↻ 繰り返しの入口', '↻ loop starts')
      : o.marker === 'loop-end' ? pick('↺ ここで戻る', '↺ jumps back')
        : o.marker === 'if' || o.marker === 'if-else' ? pick('◆ 条件で分かれる', '◆ branches')
          : o.marker === 'early-return' ? pick('⤴ 条件によっては、ここで帰る', '⤴ may return here')
            : o.marker === 'exit' ? pick('■ 終わり', '■ end')
              : o.marker === 'join' ? pick('▼ 合流', '▼ join') : '';
    lines.push(indent + addr + '  ' + label + (mark ? '   ' + mark : ''));
    if (lines.length >= 60) { lines.push('  …'); break; }
  }
  wrap.append(codeBlock(lines));
  wrap.append(para(pick(
    '上から順に流れます。字下げは分岐やループの中に入ったことを表しています。',
    'Read top to bottom; indentation means you are inside a branch or a loop.'), 'sub'));
  return wrap;
}

/* ── 呼び出しグラフ（上へも下へも辿れる） ───────────────── */

export function showCallGraph(app, addr) {
  const sheet = new Sheet(pick('呼び出しの流れ', 'Call graph'));
  const body = sheet.body;
  const box = progressBox(body, pick('呼び出し関係を調べています…', 'Mapping calls…'));

  app.ensureProgram((p) => box.set(p)).then((program) => {
    box.done();
    if (!sheet.root.isConnected) return;
    if (!program) {
      body.append(para(pick('呼び出し関係を取り出せませんでした。', 'No call relationships could be extracted.')));
      return;
    }

    body.append(el('div', 'sec-title', pick('ここへ来るまで（呼び出し元）', 'How you get here (callers)')));
    const up = el('div', 'calltree');
    const seenUp = new Set([addr.toString()]);
    const addUp = (target, depth) => {
      if (depth > 2) return;
      for (const c of program.callersOf(target, 6)) {
        if (c.addr == null) continue;
        const key = c.addr.toString();
        up.append(treeRow(app, c.addr, depth, '↑', () => {
          sheet.close(); showFunctionReport(app, c.addr);
        }));
        if (seenUp.has(key)) continue;
        seenUp.add(key);
        addUp(c.addr, depth + 1);
      }
    };
    addUp(addr, 0);
    if (!up.childElementCount) {
      up.append(para(pick('呼び出し元は見つかりませんでした。', 'No callers found.'), 'sub'));
    }
    body.append(up);

    const me = el('div', 'calltree-self');
    me.append(el('div', 'fn-name', fnLabel(app, addr)));
    me.append(el('div', 'fn-range mono', addrHex(addr)));
    body.append(me);

    body.append(el('div', 'sec-title', pick('ここから先（呼び出し先）', 'Where it goes (callees)')));
    const down = el('div', 'calltree');
    const seenDown = new Set([addr.toString()]);
    const addDown = (start, depth) => {
      if (depth > 2) return;
      const range = program.functionRange(start);
      for (const c of program.calleesOf(start, range ? range.end : null, 8)) {
        const key = c.addr.toString();
        down.append(treeRow(app, c.addr, depth, '↓', () => {
          sheet.close(); showFunctionReport(app, c.addr);
        }));
        if (seenDown.has(key)) continue;
        seenDown.add(key);
        addDown(c.addr, depth + 1);
      }
    };
    addDown(addr, 0);
    if (!down.childElementCount) {
      down.append(para(pick('ほかの処理は呼んでいません。', 'It calls nothing else.'), 'sub'));
    }
    body.append(down);

    body.append(para(pick(
      'この図は bl 命令（呼び出し）の飛び先を数えたものです。推測ではありません。' +
      'ただし、行き先が実行時に決まる呼び出し（メソッド呼び出しなど）はここには出てきません。',
      'This graph is built from real call instructions. Calls resolved at run time do not appear here.'), 'sub'));
  }).catch(() => {
    box.done();
    body.append(para(pick('呼び出し関係を調べられませんでした。', 'The call graph could not be built.')));
  });
}

function treeRow(app, addr, depth, arrow, onTap) {
  const row = tapRow('　'.repeat(depth) + arrow + ' ' + fnLabel(app, addr), {
    sub: addrHex(addr),
    onTap,
  });
  return row;
}

/* ── 値の流れ（この値は次にどこで使われるか） ───────────── */

export function showValueFlow(app, model, row, region) {
  const insn = (model.instructions || []).find((i) => i.row === row);
  if (!insn) { toast(pick('この行は解析できていません。', 'This line has not been analysed.')); return; }
  const sheet = new Sheet(pick('この値の流れ', 'Where this value goes'));
  const body = sheet.body;
  const addrOf = (r) => region.vmAddr + BigInt(r) * 4n;

  body.append(codeBlock([addrHex(insn.address) + '  ' + insn.mnemonic +
    (insn.operands ? ' ' + insn.operands : '')]));

  if (insn.memory) {
    const where = insn.memory.base + (insn.memory.disp != null
      ? ' + 0x' + insn.memory.disp.toString(16).toUpperCase() : '');
    body.append(para(insn.memory.kind === 'load'
      ? pick(where + ' にある値を読み込んでいます。', 'It reads the value at ' + where + '.')
      : pick(where + ' へ値を書き込んでいます。', 'It writes a value to ' + where + '.')));
    body.append(para(pick(
      insn.memory.size + ' バイトぶんを扱っています。',
      'It handles ' + insn.memory.size + ' bytes.'), 'sub'));
  }

  const reg = insn.writes && insn.writes.length ? insn.writes[0] : regKeyOf(insn.ops[0]);
  if (!reg) {
    body.append(para(pick('この命令が作る値は特定できませんでした。',
      'The value produced here could not be identified.')));
    return;
  }
  const uses = traceForward(model, row, reg, 24);
  body.append(el('div', 'sec-title', pick('この値（' + reg + '）が、このあとどうなるか',
    'What happens to this value (' + reg + ')')));
  const ul = list();
  if (!uses.length) {
    ul.append(tapRow(pick('この先で使われている場所は見つかりませんでした。',
      'No later use was found.'), { disabled: true }));
  }
  for (const u of uses) {
    ul.append(tapRow(useText(u), {
      sub: addrHex(addrOf(u.row)),
      onTap: () => {
        sheet.close();
        app.viewer.goToRow(u.row, 'third');
        app.viewer.select(u.row, false);
        app.viewer.mark(u.row);
      },
    }));
  }
  body.append(ul);
  body.append(para(pick(
    '追跡は、その値が別の値で上書きされたところか、別の場所から飛んでくる合流点で終わります。' +
    'そこから先は前提が保てないため、推測で続けません。',
    'Tracking stops when the value is overwritten, or at a point that can be reached from elsewhere.'), 'sub'));
}

/* ── アドレスの対応（初心者がいちばん混乱するところ） ───── */

export function showAddressInfo(app, addr) {
  const sheet = new Sheet(pick('このアドレスについて', 'About this address'));
  const body = sheet.body;
  const regions = app.store.get('regions') || [];
  const info = app.store.get('fileInfo');
  const hit = regions.find((r) => r.size > 0n && addr >= r.vmAddr && addr < r.vmAddr + r.size);

  body.append(bigValue(addrHex(addr), () => copyText(addrHex(addr), t('toast.copyAddress'))));
  const ul = list();
  ul.append(kvRow(pick('メモリ上のアドレス (VM address)', 'VM address'), addrHex(addr),
    pick('アプリが動いているときに、この処理が置かれる場所', 'where this sits while the app runs')));
  if (hit) {
    const off = hit.fileOffset + (addr - hit.vmAddr);
    ul.append(kvRow(pick('ファイルの中の位置 (file offset)', 'File offset'), addrHex(off),
      pick('このファイルの先頭から数えた位置', 'counted from the start of this file')));
    ul.append(kvRow(pick('区画 (section)', 'Section'), hit.name));
    ul.append(kvRow(pick('区画の先頭からの差', 'Offset inside the section'),
      addrHex(addr - hit.vmAddr)));
    ul.append(kvRow(pick('区画の範囲', 'Section range'),
      addrHex(hit.vmAddr) + ' – ' + addrHex(hit.vmAddr + hit.size)));
  } else {
    ul.append(kvRow(pick('区画 (section)', 'Section'),
      pick('このファイルの中には見つかりませんでした', 'not found in this file')));
  }
  if (info) ul.append(kvRow(pick('ファイルの大きさ', 'File size'), sizeText(info.size)));
  body.append(ul);

  body.append(para(pick(
    'iOS では、アプリを起動するたびに全体が同じ幅だけずらして置かれます（ASLR）。' +
    'そのため実機で見えるアドレスは、ここに出ている値に「ずれ幅」を足したものになります。' +
    'ファイルの中の位置は、いつでも変わりません。',
    'On iOS the whole image is shifted by a random amount at launch (ASLR), so addresses seen on a device are these values plus that slide. File offsets never change.')));

  const actions = el('div', 'detail-actions');
  actions.append(button(pick('この場所へ移動', 'Go there'), 'chip', () => {
    sheet.close();
    app.goToAddress(addr, { announce: true });
  }));
  if (hit) {
    actions.append(button(pick('16 進で見る', 'Show the bytes'), 'chip', () => {
      sheet.close();
      app.goToFileOffset(hit.fileOffset + (addr - hit.vmAddr));
    }));
  }
  body.append(actions);
}

/* ── 設定 ────────────────────────────────────────────────── */

export function showSettings(app) {
  const sheet = new Sheet(t('settings.title'));
  const ul = list();
  const again = () => { sheet.close(); showSettings(app); };

  ul.append(groupRow(t('settings.group.explain')));
  ul.append(tapRow(t('settings.explainOn'), {
    sub: t('settings.explainOnSub'),
    right: app.prefs.explain ? '✓' : '',
    onTap: () => { app.setExplain(!app.prefs.explain); again(); },
  }));
  if (app.prefs.explain) {
    for (const [key, label, sub] of [
      ['ja', t('settings.note.ja'), t('settings.note.jaSub')],
      ['pseudo', t('settings.note.pseudo'), t('settings.note.pseudoSub')],
      ['both', t('settings.note.both'), t('settings.note.bothSub')],
    ]) {
      ul.append(tapRow(label, {
        indent: true, sub,
        right: (app.prefs.noteStyle || 'ja') === key ? '✓' : '',
        onTap: () => { app.setNoteStyle(key); again(); },
      }));
    }
  }

  ul.append(groupRow(t('settings.group.appearance')));
  for (const [key, label] of [
    ['system', t('settings.theme.system')],
    ['light', t('settings.theme.light')],
    ['dark', t('settings.theme.dark')],
  ]) {
    ul.append(tapRow(label, {
      right: app.store.get('theme') === key ? '✓' : '',
      onTap: () => { app.setTheme(key); again(); },
    }));
  }
  const sizes = [['s', t('settings.size.s')], ['m', t('settings.size.m')],
                 ['l', t('settings.size.l')], ['xl', t('settings.size.xl')]];
  const sizeRow = el('li');
  sizeRow.append(el('span', 'k', t('settings.textSize')));
  const sizeChips = el('div', 'chips inline');
  for (const [key, label] of sizes) {
    const c = button(label, 'chip', () => { app.setTextSize(key); again(); });
    c.setAttribute('aria-pressed', String((app.prefs.textSize || 'm') === key));
    sizeChips.append(c);
  }
  sizeRow.append(sizeChips);
  ul.append(sizeRow);

  ul.append(groupRow(t('settings.group.hex')));
  ul.append(tapRow(t('settings.hexSpaced'), {
    sub: 'F6 57 BD A9',
    right: app.store.get('hexJoined') ? '' : '✓',
    onTap: () => { app.setHexJoined(false); again(); },
  }));
  ul.append(tapRow(t('settings.hexJoined'), {
    sub: 'F657BDA9',
    right: app.store.get('hexJoined') ? '✓' : '',
    onTap: () => { app.setHexJoined(true); again(); },
  }));

  ul.append(groupRow(t('settings.group.lang')));
  for (const [key, label] of [['ja', t('settings.lang.ja')], ['en', t('settings.lang.en')]]) {
    ul.append(tapRow(label, {
      right: (app.prefs.lang || 'ja') === key ? '✓' : '',
      onTap: () => { app.setLanguage(key); sheet.close(); showSettings(app); },
    }));
  }

  ul.append(groupRow(t('settings.group.about')));
  const li = el('li');
  li.append(el('span', 'sub', t('settings.about', { version: app.capstoneVersion || '5' })));
  ul.append(li);
  ul.append(tapRow(t('settings.resetGuide'), {
    onTap: () => { sheet.close(); showWelcome(app, true); },
  }));

  sheet.body.append(ul);
}

/* ── ヘルプ ──────────────────────────────────────────────── */

export function showHelp(app) {
  const sheet = new Sheet(t('help.title'));
  const ul = list();

  ul.append(tapRow(t('help.learn'), {
    sub: t('help.learnSub'),
    onTap: () => { sheet.close(); showLearn(app); },
  }));
  ul.append(tapRow(t('help.glossary'), {
    sub: t('help.glossarySub'),
    onTap: () => { sheet.close(); showGlossary(app); },
  }));
  ul.append(tapRow(t('help.sample'), {
    sub: t('help.sampleSub'),
    onTap: () => { sheet.close(); app.openSample(); },
  }));
  ul.append(tapRow(t('help.tour'), {
    onTap: () => { sheet.close(); showWelcome(app, true); },
  }));
  sheet.body.append(ul);

  const faq = el('div', 'doc');
  faq.append(heading(t('help.faq')));
  for (const [q, a] of FAQ) {
    faq.append(el('div', 'faq-q', pick(q[0], q[1])));
    faq.append(para(pick(a[0], a[1])));
  }
  sheet.body.append(faq);
}

const FAQ = [
  [['命令のところが「…」のままです', 'Rows show “…”'],
   ['そこのデータをまだ読み込んでいる途中です。少し待つか、一度スクロールし直してください。',
    'That chunk is still loading. Wait a moment or scroll again.']],
  [['「.byte」ばかり並んでいます', 'Everything shows “.byte”'],
   ['そこは命令ではなくデータです。文字列や定数、飛び先の表などが置かれています。' +
    'ファイル全体がそうなっている場合は、App Store の暗号化がかかったアプリか、ARM64 以外のコードの可能性があります。',
    'That area is data, not code. If the whole file looks like this, it may be App Store encrypted.']],
  [['関数の名前が出てきません', 'No function names'],
   ['配布用のアプリは、自作の関数名が削除されています。外部ライブラリの関数名（_printf など）は残るので、' +
    '「何を呼んでいるか」から中身を推測していきます。',
    'Released apps have their own symbols stripped. Library names survive, so read the calls.']],
  [['どこから読み始めればいいですか', 'Where do I start?'],
   ['まず「文字列」を開いて、意味の分かる言葉を探してください。次に、その文字列を使っている場所を' +
    '「ここを使っている場所」で探すのが、いちばん近道です。',
    'Open Strings, find a meaningful one, then use “find references” to reach the code that uses it.']],
  [['ファイルはどこかに送られますか', 'Is my file uploaded?'],
   ['いいえ。開いたファイルはこの端末のブラウザの中だけで読み込まれ、変更も送信もされません。',
    'No. The file is read in this browser only — never modified, never uploaded.']],
  [['大きいファイルでも大丈夫ですか', 'Can it handle large files?'],
   ['はい。画面に映っている数十行ぶんだけを、その都度読み込んで表示しています。' +
    '数百 MB のファイルでもスクロールは軽いままです。',
    'Yes. Only the visible rows are ever decoded, so hundreds of megabytes scroll smoothly.']],
];

/* ── はじめてのご案内 ────────────────────────────────────── */

const GUIDE_PAGES = [
  {
    title: ['アプリの中身を、日本語で読む', 'Read a binary in plain language'],
    body: [
      'iPhone や Mac のアプリは、人間の書いたコードが「機械語」という数字の列に翻訳されたものです。',
      'このツールは、その数字を 1 行ずつ日本語に訳して見せます。アセンブリを触ったことがなくても大丈夫です。',
    ],
    bodyEn: [
      'An app is human-written code translated into machine numbers.',
      'This tool translates those numbers back, one line at a time.',
    ],
  },
  {
    title: ['まずは「解説」をオンに', 'Turn on “Explain”'],
    body: [
      '画面上の「解説」ボタンを押すと、命令 1 行ごとに日本語の意味が下に付きます。',
      '行をタップすれば、その 1 行を部品ごとに分解して、全部説明します。',
      '分からない言葉が出てきたら、その場で用語集を引けます。',
    ],
    bodyEn: [
      'The “Explain” button adds a plain-language line under every instruction.',
      'Tap any row to break that single line down completely.',
    ],
  },
  {
    title: ['迷ったら「？」から学習コースへ', 'The course is behind “?”'],
    body: [
      '右上の「？」に、ゼロから読めるようになるための 10 章の学習コースが入っています。',
      '2 進数の話から、実際のアプリを読む手順まで、順番に進めます。',
      'まずは「サンプルで練習する」で、小さな練習用アプリを開いてみてください。',
    ],
    bodyEn: [
      'The “?” button holds a ten-chapter course, from binary numbers to reading a real app.',
      'Start with “Try the sample”.',
    ],
  },
];

export function showWelcome(app, force) {
  if (!force && app.prefs.guideSeen) return;
  let page = 0;
  const sheet = new Sheet(t('guide.title'), {
    onClose: () => { app.prefs.guideSeen = true; app.saveSettings(); },
  });
  const holder = el('div', 'guide');
  const nav = el('div', 'guide-nav');
  sheet.body.append(holder, nav);

  const render = () => {
    const p = GUIDE_PAGES[page];
    holder.replaceChildren();
    holder.append(el('div', 'guide-step', (page + 1) + ' / ' + GUIDE_PAGES.length));
    holder.append(el('h3', 'guide-title', pick(p.title[0], p.title[1])));
    for (const line of (isJa() ? p.body : p.bodyEn)) holder.append(para(line));

    nav.replaceChildren();
    if (page > 0) nav.append(button(t('btn.prev'), 'chip', () => { page--; render(); }));
    nav.append(el('div', 'tb-spacer'));
    if (page < GUIDE_PAGES.length - 1) {
      nav.append(button(t('btn.next'), 'chip strong', () => { page++; render(); }));
    } else {
      nav.append(button(t('help.sample'), 'chip strong', () => { sheet.close(); app.openSample(); }));
    }
  };
  render();
}

/* ── 学習コース ──────────────────────────────────────────── */

export function showLearn(app) {
  const sheet = new Sheet(t('learn.title'));
  const progress = loadProgress();
  const done = CHAPTERS.filter((c) => progress[c.id]).length;

  sheet.body.append(el('div', 'hint',
    t('learn.progress', { done, total: CHAPTERS.length })));

  const ul = list();
  CHAPTERS.forEach((c, i) => {
    ul.append(tapRow(t('learn.chapter', { n: i + 1 }) + '　' + c.title, {
      sub: c.subtitle,
      right: progress[c.id] ? '✓' : '',
      onTap: () => { sheet.close(); showChapter(app, i); },
    }));
  });
  ul.append(groupRow(''));
  ul.append(tapRow(t('learn.reset'), {
    onTap: () => { saveProgress({}); sheet.close(); showLearn(app); },
  }));
  sheet.body.append(ul);
}

export function showChapter(app, index) {
  const c = CHAPTERS[index];
  if (!c) return;
  const sheet = new Sheet(t('learn.chapter', { n: index + 1 }));
  const doc = el('div', 'doc');
  doc.append(el('h3', 'doc-title', c.title));
  if (c.subtitle) doc.append(el('div', 'doc-sub', c.subtitle));

  for (const b of c.blocks) {
    switch (b.t) {
      case 'p': doc.append(para(b.text)); break;
      case 'h': doc.append(heading(b.text)); break;
      case 'code': doc.append(codeBlock(b.lines)); break;
      case 'note': doc.append(noteBox(b.text)); break;
      case 'list': doc.append(bullets(b.items)); break;
      case 'term': {
        const chips = termChips(b.ids, (id) => GLOSSARY[id] && GLOSSARY[id].term,
          (id) => showTerm(app, id));
        if (chips) doc.append(chips);
        break;
      }
      case 'try': {
        const btn = button(b.text, 'trybtn', () => { sheet.close(); runTryAction(app, b.action); });
        doc.append(btn);
        break;
      }
      default: break;
    }
  }
  sheet.body.append(doc);

  const progress = loadProgress();
  const nav = el('div', 'guide-nav');
  if (index > 0) nav.append(button(t('btn.prev'), 'chip', () => { sheet.close(); showChapter(app, index - 1); }));
  nav.append(button(progress[c.id] ? t('learn.markUnread') : t('learn.markRead'), 'chip', () => {
    const p = loadProgress();
    if (p[c.id]) delete p[c.id]; else p[c.id] = true;
    saveProgress(p);
    sheet.close();
    showChapter(app, index);
  }));
  nav.append(el('div', 'tb-spacer'));
  if (index < CHAPTERS.length - 1) {
    nav.append(button(t('btn.next'), 'chip strong', () => {
      const p = loadProgress();
      p[c.id] = true;
      saveProgress(p);
      sheet.close();
      showChapter(app, index + 1);
    }));
  } else {
    nav.append(button(t('learn.title'), 'chip strong', () => { sheet.close(); showLearn(app); }));
  }
  sheet.body.append(nav);
}

function runTryAction(app, action) {
  switch (action) {
    case 'sample': app.openSample(); break;
    case 'strings': showStrings(app); break;
    case 'functions': showFunctions(app); break;
    case 'sections': showSections(app); break;
    case 'struct': showStructure(app); break;
    case 'explain':
      app.setExplain(true);
      toast(pick('解説の表示をオンにしました。', 'Explanations are on.'));
      break;
    default: break;
  }
}

/* ── 用語集 ──────────────────────────────────────────────── */

export function showGlossary(app, query) {
  const sheet = new Sheet(t('glossary.title'));
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.placeholder = t('glossary.filter');
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (query) input.value = query;
  field.append(input);
  const results = list();
  sheet.body.append(field, results);

  const render = () => {
    const ids = searchGlossary(input.value);
    results.replaceChildren();
    if (!ids.length) { results.append(tapRow(t('glossary.none'), { disabled: true })); return; }
    for (const id of ids) {
      const e = GLOSSARY[id];
      results.append(tapRow(e.term, {
        sub: e.short,
        onTap: () => { sheet.close(); showTerm(app, id); },
      }));
    }
  };
  input.addEventListener('input', render);
  render();
}

export function showTerm(app, id) {
  const e = GLOSSARY[id];
  if (!e) return;
  const sheet = new Sheet(e.term);
  const doc = el('div', 'doc');
  doc.append(el('h3', 'doc-title', e.term));
  if (e.read && e.read !== e.term) doc.append(el('div', 'doc-sub', e.read));
  doc.append(el('div', 'doc-short', e.short));
  for (const p of e.body.split('\n\n')) {
    if (/^[ 　]*[0-9A-Za-z_]/.test(p) && /\n/.test(p) && /[ 　]{2}|…|→/.test(p)) doc.append(codeBlock(p));
    else doc.append(para(p));
  }
  sheet.body.append(doc);

  if (e.related && e.related.length) {
    const b = block(t('glossary.related'));
    const chips = termChips(e.related, (r) => GLOSSARY[r] && GLOSSARY[r].term,
      (r) => { sheet.close(); showTerm(app, r); });
    if (chips) b.append(chips);
    sheet.body.append(b);
  }
  const nav = el('div', 'guide-nav');
  nav.append(button(t('glossary.title'), 'chip', () => { sheet.close(); showGlossary(app); }));
  sheet.body.append(nav);
}

/* ── サンプルの案内 ──────────────────────────────────────── */

export function showSampleGuide(app) {
  const sheet = new Sheet(pick('サンプルの中身', 'About the sample'));
  const doc = el('div', 'doc');
  doc.append(para(pick(
    '練習用に、小さな ARM64 の Mach-O をこの場で組み立てて開きました。本物と同じ形をしています。' +
    '下の関数から読んでみてください。',
    'A small ARM64 Mach-O was built and opened for practice. It has the same shape as a real binary.')));
  sheet.body.append(doc);

  const ul = list();
  ul.append(groupRow(pick('入っている関数', 'Functions inside')));
  for (const [name, note] of SAMPLE_GUIDE.functions) {
    ul.append(tapRow(name, {
      sub: note,
      onTap: () => { sheet.close(); app.goToSymbol(name); },
    }));
  }
  sheet.body.append(ul);

  const nav = el('div', 'guide-nav');
  nav.append(button(pick('_main から読む', 'Start at _main'), 'chip strong', () => {
    sheet.close();
    app.goToSymbol('_main');
  }));
  sheet.body.append(nav);
}
