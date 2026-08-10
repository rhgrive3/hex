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
    // LC_FUNCTION_STARTS がない → 命令の並びから推測する
    status.textContent = t('functions.analyzing');
    app.backend.onScanProgress = (p) => {
      if (!p.all) return;
      fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
    };
    try {
      const res = await app.backend.guessFunctions(region.id);
      app.backend.onScanProgress = null;
      fill.style.width = '100%';
      if (res.cancelled) { status.textContent = ''; return; }
      sym.setGuessedFunctions(res.starts);
      app.viewer.setSymbols(sym);
      all = sym.functionList(region);
      status.textContent = t('functions.hintNoSymbols');
      render();
    } catch (err) {
      app.backend.onScanProgress = null;
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

/** 文字列を集める。__cstring などが第一候補で、なければ今のセクション。 */
async function collectStrings(app) {
  const regions = app.store.get('regions') || [];
  const targets = regions.filter((r) => r.size > 0n &&
    (r.cstrings || /string|cstring|objc_method|objc_class|const/i.test(r.section || '')));
  const current = app.store.get('currentRegion');
  const use = targets.length ? targets.slice(0, 6) : (current ? [current] : []);
  const out = [];
  for (const r of use) {
    const res = await app.backend.strings({ regionId: r.id, min: 4 });
    for (const s of res.results) out.push({ addr: s.addr, text: s.text, region: r });
  }
  return out;
}

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
  }
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
    { label: t('detail.findRefs'), action: () => showXrefs(app, d.address) },
    '-',
    { label: t('detail.copyAddress'), action: () => copyText(addrHex(d.address), t('toast.copyAddress')) },
    { label: t('detail.copyHex'), action: () => copyText(d.bytes || '', t('toast.copyHex')) },
    { label: t('detail.copyAsm'), action: () => copyText(asm, t('toast.copyAsm')) },
    '-',
    { label: t('detail.selectRows'), action: () => app.startSelection(row) },
  ], x, y);
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
