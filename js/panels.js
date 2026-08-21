/*
 * Design philosophy: 「証拠の地図帳」。結果の根拠・関係・次の行動を
 * 一画面の中で接続し、同じ機能への入口を重複させない。
 *
 * シート（下から出てくる画面）とダイアログ。
 *
 *   ファイル情報 / セクション / 構造 / 関数 / 文字列 / ジャンプ / 検索 /
 *   命令の詳細 / 関数の要約 / 参照元 / 設定 / ヘルプ / 学習 / 用語集
 *
 * どれも store を読んで app を呼び返すだけで、worker や Capstone には触らない。
 */
import {
  Sheet, el, button, list, groupRow, kvRow, tapRow, toast, copyText, alertDialog, menu,
  heading, para, codeBlock, noteBox, bullets, termChips, block, bigValue, disclosure, userError,
} from './ui.js';
import { addrHex, addrText, sizeText, parseAddress, parseHexPattern } from './format.js';
import { rangeCopyMenu } from './rangecopy.js';
import { askAiMenuItem, instructionAiItems, stringAiItems } from './ai/interaction/contextual.js';
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
import { vendorsOf, vendorOf } from './vendors.js';
import { buildFunctionReport } from './report.js';
import { outline } from './cfg.js';
import { traceForward, regKeyOf, findValueUpdates } from './dataflow.js';
import { irFor, readModifyWrite, OP as IR_OP } from './ir.js';
import { causalChain } from './slice.js';
import { flowStepText, flowElidedText } from './narrate.js';
import { compileGoal, describeQuery } from './goalc.js';
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
import { pinpointField, pinpointLocation, pinpointFunction } from './pinpoint.js';
import { columnToOffset } from './schema.js';
import { VERDICT, verdictRank } from './evidence.js';
import { roleFromReport, sketchRole, changesValue, stringLookup } from './role.js';
import { describePurpose } from './purpose.js';
import {
  showDecompiler, showCfg, showCallGraphPanel, showTypes, showDebugger,
  showRename, showComment, showPatchEditor, showStructRecover, prettyName,
} from './tools.js';
import { purposeText, changeText } from './narrate.js';
import { comprehensionHeadline, stepNote, sinkText } from './narrate.js';
import { stepText } from './comprehend.js';
import { render as renderExpr } from './expr.js';
import { callGraph, graphLegend, renderGraph } from './graphview.js';
import { functionViews, openFunctionView } from './ui/next-views.js';
import { buildGeminiPayload, streamGemini } from './gemini.js';
import { productDescriptor } from './platform/product-descriptor.js';

export { showFileInfo, showSections, showStructure } from './ui/panels/file.js';
export { showJump, showSearch } from './ui/panels/navigation.js';
export { showSettings } from './ui/panels/settings.js';

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
      alertDialog(t('search.failed'), userError(err));
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
      alertDialog(t('search.failed'), userError(err));
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

  const views = nextViewsRow(app, res.startAddr, { sheet, exclude: ['report'], primary: 'pseudocode' });
  if (views) body.append(views);

  const actions = el('div', 'detail-actions');
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

  const progress = (p) => {
    if (!p.all) return;
    fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
  };
  collectStrings(app, progress).then((strings) => {
    const index = {
      features: groupByFeature(strings),
      engine: detectEngine(strings),
      count: strings.length,
    };
    app.featureIndex = index;
    render(index);
  }).catch((err) => {
    bar.remove();
    status.textContent = '';
    alertDialog(t('search.failed'), userError(err));
  });
}

/** 文字列を集める。収集とキャッシュは app 側に置いてある（何度も走査しないため）。 */
function collectStrings(app, onProgress) { return app.ensureStrings(onProgress); }

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
        const row = tapRow(s.text, {
          sub: addrHex(s.addr),
          onTap: () => { sheet.close(); app.goToStringAddress(active, s.addr); },
        });
        /* 長押しで「この文字列を使っているのはどこか」を AI に回せる。
           一覧の見た目は変えない。 */
        row.addEventListener('contextmenu', (event) => {
          const assistant = typeof window !== 'undefined' ? window.__hexAi : null;
          if (!assistant) return;
          event.preventDefault();
          menu(stringAiItems(assistant, { text: s.text, address: s.addr }), event.clientX, event.clientY);
        });
        frag.append(row);
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
    const progress = (p) => {
      if (!p.all) return;
      fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
    };
    try {
      const res = await app.backend.strings({ regionId: region.id, min: 4 }, progress);
      fill.style.width = '100%';
      all = res.results;
      status.textContent = t('strings.count', { n: all.length.toLocaleString() }) +
        (res.capped ? t('strings.capped', { n: all.length.toLocaleString() }) : '') +
        '\n' + t('strings.hint');
      render();
    } catch (err) {
      status.textContent = '';
      alertDialog(t('search.failed'), userError(err));
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

  const progress = (p) => {
    if (!p.all) return;
    fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
  };

  const request = app.backend.xrefs({ regionId: codeRegion.id, target }, progress);
  sheet.onClose = () => request.cancel();
  request.then((res) => {
    fill.style.width = '100%';
    if (!res.results.length) { status.textContent = t('xref.none'); return; }
    status.textContent = t('xref.count', { n: res.results.length });
    const sym = app.symbols;
    for (const r of res.results.slice(0, 400)) {
      const fn = sym.functionCount ? sym.functionAt(r.addr) : null;
      const owner = fn ? (sym.nameAt(fn.start) || addrHex(fn.start)) : null;
      results.append(tapRow(owner || addrHex(r.addr), {
        sub: (owner ? addrHex(r.addr) + '  ·  ' : '') + xrefKind(r.kind) +
          (fn ? pick('\nタップすると、この参照を含む関数を直接開きます',
            '\nTap to open the function containing this reference') : ''),
        onTap: () => {
          if (fn && openFunctionSurface(app, fn.start, 'report')) {
            sheet.close();
            return;
          }
          sheet.close();
          if (codeRegion !== region) app.selectRegion(codeRegion, { silent: true });
          app.viewer.goToRow(r.row, 'third');
          app.viewer.mark(r.row);
          app.viewer.select(r.row, false);
          // 関数境界が不明な参照だけ、従来どおり現在地から解析する。
          app.analyzeFunctionAt(app.viewer.rowAddress(r.row));
        },
      }));
    }
  }).catch((err) => {
    status.textContent = '';
    alertDialog(t('search.failed'), userError(err));
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

  /* 自分で書いたメモ。書いたものが見えないと、書く意味がない。 */
  const memo = app.notes ? app.notes.comment(d.address) : null;
  if (memo) {
    const mb = block(pick('あなたのメモ', 'Your note'));
    mb.append(para(memo));
    root.append(mb);
  }
  {
    const l = list();
    l.append(tapRow(memo ? pick('メモを書き直す', 'Edit note') : pick('この行にメモを書く', 'Add a note'), {
      sub: pick('あとで見返したときに、思い出せるようにしておきます',
        'So you can remember what you worked out'),
      onTap: () => showComment(app, d.address),
    }));
    l.append(tapRow(pick('この命令を書き換える（パッチ）', 'Patch this instruction'), {
      sub: pick('元のファイルには書き込みません', 'The original file is never modified'),
      onTap: () => showPatchEditor(app, d.address, { mnemonic: mn, operands: ops, address: d.address }),
    }));
    root.append(l);
  }

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
  /* AI は 1 行だけ足す。動詞は「AI に聞く…」の下に置いて、このメニューを太らせない。 */
  const assistant = typeof window !== 'undefined' ? window.__hexAi : null;
  menu([
    ...(assistant ? [askAiMenuItem(assistant, instructionAiItems(assistant, { address: d.address, text: asm }), { x, y })] : []),
    { label: t('detail.title') + '…', action: () => showDetail(app, row) },
    { label: pick('逆コンパイルして読む（C 風）', 'Decompile to C'),
      action: () => openFunctionSurfaceOrToast(app, d.address, 'pseudocode') },
    ...(sb ? [{
      label: pick('この処理を見る', 'Show this step') + '（' + blockTitle(sb) + '）',
      action: () => showBlockDetail(app, app.semantic.model, sb, app.store.get('currentRegion')),
    }] : []),
    { label: pick('関数の概要を開く', 'Open function overview'),
      action: () => openFunctionSurfaceOrToast(app, d.address, 'report') },
    { label: pick('この関数を調べる（事実と推測）', 'Investigate this function'),
      action: () => showFunctionReport(app, d.address, app.lastGoal) },
    ...(sb ? [{
      label: pick('この値の行き先を追う', 'Follow this value'),
      action: () => showValueFlow(app, app.semantic.model, row, app.store.get('currentRegion')),
    }] : []),
    { label: t('detail.findRefs'), action: () => showXrefs(app, d.address) },
    { label: pick('制御フロー図を見る', 'Show control-flow graph'),
      action: () => openFunctionSurfaceOrToast(app, d.address, 'flow') },
    { label: pick('呼び出し図を見る', 'Show call graph'),
      action: () => openFunctionSurfaceOrToast(app, d.address, 'calls') },
    { label: pick('引数と戻り値を調べる', 'Show arguments and return value'),
      action: () => showTypes(app, functionStartOf(app, d.address)) },
    { label: pick('アドレスの対応を見る', 'Show address mapping'), action: () => showAddressInfo(app, d.address) },
    '-',
    { label: pick('ここから実行してみる', 'Run from here'),
      action: () => showDebugger(app, functionStartOf(app, d.address)) },
    { label: pick('名前を付ける', 'Rename'),
      action: () => showRename(app, functionStartOf(app, d.address)) },
    { label: pick('この行にメモを書く', 'Add a comment'), action: () => showComment(app, d.address) },
    { label: pick('この命令を書き換える（パッチ）', 'Patch this instruction'),
      action: () => showPatchEditor(app, d.address, { mnemonic: d.mnemonic, operands: d.operands, address: d.address }) },
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

/** そのアドレスを含む関数の先頭。分からなければそのアドレス自身。 */
function functionStartOf(app, addr) {
  const fn = app.symbols && app.symbols.functionCount ? app.symbols.functionAt(addr) : null;
  return fn ? fn.start : addr;
}

/** 関数の見出し。名前がなければアドレスで。 */
function fnLabel(app, addr) {
  if (addr == null) return t('functions.unnamed');
  const name = app.symbols ? app.symbols.nameAt(addr) : null;
  // C++ / Swift のマングル名は、読める形に直して見せる（元の名前は詳細画面に出す）
  return name ? prettyName(name) : 'sub_' + addr.toString(16).toUpperCase();
}

/** ずらし幅は短い 16 進で。アドレスと違って桁をそろえない（読みにくいので）。 */
function offsetHex(v) {
  const n = v < 0n ? -v : v;
  return (v < 0n ? '-0x' : '0x') + n.toString(16).toUpperCase();
}

/* ── 次に見る形 ────────────────────────────────────────────
   解析の結果は「どの関数か」までは言う。そこから先の「疑似Cで読む」
   「流れを図で見る」へ、結果の画面から直接行けるようにする。以前は
   関数一覧まで戻って、いま見せられたアドレスを自分で探し直す必要が
   あった。行き先は正規の作業画面（/function/:address/:tab）で、
   router が無いときだけ従来のシートに落とす。
   ──────────────────────────────────────────────────────── */

function productRouter() {
  return (typeof window !== 'undefined' && window.__hexUi && window.__hexUi.router) || null;
}

function legacyViewOpeners(app, goal) {
  const big = (addr) => BigInt(addr);
  return {
    report: (addr) => showFunctionReport(app, big(addr), goal),
    decompiler: (addr) => showDecompiler(app, big(addr)),
    cfg: (addr) => showCfg(app, big(addr)),
    callGraph: (addr) => showCallGraphPanel(app, big(addr)),
    code: (addr) => app.goToFunction(big(addr)),
  };
}

function openFunctionSurface(app, address, view = 'report', goal = app.lastGoal) {
  if (address == null) return false;
  const start = functionStartOf(app, BigInt(address));
  const [target] = functionViews({ address: start, include: [view], ja: isJa() });
  return !!target && openFunctionView(target, {
    router: productRouter(),
    legacy: legacyViewOpeners(app, goal),
  });
}

function openFunctionSurfaceOrToast(app, address, view = 'report', goal = app.lastGoal) {
  const opened = openFunctionSurface(app, address, view, goal);
  if (!opened) toast(pick('この形では開けませんでした。', 'That view could not be opened.'));
  return opened;
}

/**
 * 結果の画面に置く「次に見る形」の一段。
 *
 * ボタンには短い説明を添える。「フロー」「CFG」だけでは、押す前に何が
 * 出るのか分からないため。出せないものは消さずに、押せない理由を書く。
 */
function nextViewsRow(app, addr, { sheet, goal = null, exclude = [], primary = 'report', title } = {}) {
  /* 関数が特定できていない結果に、押せないボタンの列を出しても仕方がない。 */
  if (addr == null) return null;
  const views = functionViews({
    address: addr,
    capability: { canDisassemble: app.store ? app.store.get('canDisassemble') !== false : true },
    exclude, primary, ja: isJa(),
  });
  if (!views.length) return null;
  const root = el('section', 'next-views');
  root.append(el('h4', 'sec-title', title || pick('この関数を別の形で見る', 'See this routine another way')));
  const bar = el('div', 'action-bar');
  for (const view of views) {
    const b = button('', 'action-btn' + (view.primary ? ' strong' : ''), () => {
      const opened = openFunctionView(view, { router: productRouter(), legacy: legacyViewOpeners(app, goal) });
      if (opened) { if (sheet) sheet.close(); }
      else toast(pick('この形では開けませんでした。', 'That view could not be opened.'));
    });
    b.replaceChildren(el('span', 'action-label', view.label), el('span', 'action-hint', view.hint));
    if (!view.available) {
      b.disabled = true;
      b.classList.add('is-disabled');
      b.title = view.reason;
      b.querySelector('.action-hint').textContent = view.reason;
    }
    bar.append(b);
  }
  root.append(bar);
  return root;
}

/** 進み具合の表示。走査は worker で走るので、UI は止まらない。 */
function progressBox(parent, text) {
  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill);
  const status = el('div', 'hint', text || '');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  parent.append(bar, status);
  return {
    bar, status, fill,
    set(p) {
      if (!p || !p.all) return;
      const value = Math.min(100, Math.round((p.done / p.all) * 100));
      fill.style.width = value + '%';
      bar.setAttribute('aria-valuenow', String(value));
    },
    say(s) { status.textContent = s; },
    done() { bar.remove(); status.remove(); },
  };
}

function beginnerFailure(parent, err, { actionLabel, onAction } = {}) {
  console.error('[hex] analysis view failed', err);
  const box = el('div', 'beginner-empty');
  box.append(el('h4', null, pick('解析結果を表示できませんでした', 'The analysis result could not be shown')));
  box.append(para(pick(
    'ファイルは開いたままです。別の表示から中身を確認できます。',
    'The file is still open. You can inspect it with another view.')));
  if (onAction) box.append(button(actionLabel || pick('逆アセンブリを見る', 'Show disassembly'), 'chip', onAction));
  parent.append(box);
  return box;
}

function beginnerEmpty(parent, title, text, { actionLabel, onAction } = {}) {
  const box = el('div', 'beginner-empty');
  box.append(el('h4', null, title), para(text));
  if (onAction) box.append(button(actionLabel, 'chip', onAction));
  parent.append(box);
  return box;
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
function goalChips(app, onPick, { recommended = false } = {}) {
  const wrap = el('div', 'goalchips');
  const shown = recommended
    ? GOALS.filter((g) => ['hp', 'money', 'gacha', 'level', 'network', 'anticheat'].includes(g.id))
    : GOALS;
  for (const g of shown) {
    const b = button(pick(g.ja, g.en), 'goalchip', () => {
      onPick(goalFromPreset(g.id));
    });
    wrap.append(b);
  }
  return wrap;
}

/* 足りない材料を、言い直せる言葉にする。 */
function queryMissingText(what) {
  switch (what) {
    case 'entity':
      return pick('何について知りたいのか（コイン・HP・経験値など）が読み取れませんでした',
        'What to look for (coins, HP, experience…) could not be read from this');
    case 'action':
      return pick('どうなる場所を探すのか（増える・減る・決まる など）が書かれていません',
        'What should happen (increases, decreases, is decided…) is not stated');
    case 'text':
      return pick('調べたいことを、もう少し書いてください', 'Please write a little more');
    default:
      return '';
  }
}

/**
 * 自由入力。「敵にダメージを与える処理」のような文でも受け取る。
 *
 * ここは Goal Compiler の入口。打ち込まれた文を
 *
 *     実体 / できごと / 動き / 期待されるデータフロー / 文脈 / 行き先
 *
 * に分解してから探しにいく。分解の結果はそのまま画面に出す。
 * 「そう受け取りました」を見せないと、外したときに利用者が言い直せない。
 */
function goalInput(app, onPick) {
  const wrap = el('div', 'goal-input');
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.placeholder = pick('例: 戦闘終了時に経験値が増える場所 / コインの増減 / ガチャでレア度を決めているところ',
    'e.g. where experience increases after a battle, coin balance, where gacha rarity is decided');
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const reading = el('div', 'goal-reading');
  reading.hidden = true;

  const showReading = (query) => {
    reading.replaceChildren();
    if (!query || !query.text) { reading.hidden = true; return; }
    reading.hidden = false;
    reading.append(el('b', null, pick('こう受け取りました', 'Understood as')));
    reading.append(el('span', null, describeQuery(query)));
    const bits = [];
    if (query.entity.terms.length) {
      bits.push(pick('探す言葉: ', 'Terms: ') + query.entity.terms.slice(0, 6).join(' / '));
    }
    if (query.dataflow.steps.length) {
      bits.push(pick('期待する形: ', 'Expected shape: ') + query.dataflow.steps.join(' → '));
    }
    if (bits.length) reading.append(el('span', 'goal-reading-detail', bits.join('　·　')));
    for (const m of query.missing) {
      const text = queryMissingText(m);
      if (text) reading.append(el('span', 'goal-reading-missing', '• ' + text));
    }
  };

  const go = () => {
    const query = compileGoal(input.value);
    const goal = query.goal;
    if (!goal) { toast(pick('調べたいことを入力してください。', 'Type what you want to look for.')); return; }
    showReading(query);
    /* 分解した結果を目的に添えて渡す。探索側はこれを使って形まで確かめられる。 */
    onPick(Object.assign({}, goal, { query }));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  input.addEventListener('input', () => {
    if (!input.value.trim()) { reading.hidden = true; return; }
    showReading(compileGoal(input.value));
  });
  field.append(input, button(pick('探す', 'Search'), 'chip', go));
  wrap.append(field, reading);
  return wrap;
}

/* ── 概要（ファイルを開いて最初に出る画面） ─────────────── */

export function showOverview(app) {
  const info = app.store.get('fileInfo');
  if (!info) { toast(t('err.openFirst')); return; }
  const sheet = new Sheet(pick('このアプリを解析しました', 'This app has been analysed'), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onScanProgress = null; },
  });
  const body = sheet.body;

  const openGoal = (goal) => { sheet.close(); showCandidates(app, goal); };
  const hero = el('section', 'purpose-hero');
  hero.append(el('p', 'purpose-kicker', pick('このアプリを解析しました', 'This app has been analysed')));
  hero.append(el('h2', 'purpose-question', pick('何を知りたいですか？', 'What do you want to know?')));
  hero.append(goalInput(app, openGoal));
  body.append(hero, el('div', 'purpose-recommended', pick('おすすめ', 'Recommended')),
    goalChips(app, openGoal, { recommended: true }));

  /* ファイルの専門情報は残すが、目的より先には見せない。 */
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
  body.append(disclosure(pick('ファイルの基本情報', 'Basic file information'), {
    build: (into) => into.append(head),
  }));

  /* 裏で走査し、結果は要求されたときに開ける。 */
  const findings = disclosure(pick('このアプリについて分かったこと', 'What was found in this app'));
  const later = el('div');
  findings.body.append(later);
  body.append(findings);

  const expert = disclosure(pick('専門家向けツール', 'Expert tools'), {
    build: (into) => {
      const tools = list();
      tools.append(tapRow(pick('関数・逆コンパイル・CFG', 'Functions, decompiler, and CFG'), {
        sub: pick('ARM64や制御フローを直接確認します', 'Inspect ARM64 and control flow directly'),
        right: '›',
        onTap: () => { sheet.close(); showTools(app); },
      }));
      tools.append(tapRow(pick('関数の一覧', 'Function list'), {
        right: '›', onTap: () => { sheet.close(); showFunctions(app); },
      }));
      tools.append(tapRow(pick('文字列・セクション・構造', 'Strings, sections, and structure'), {
        right: '›', onTap: () => { sheet.close(); showStructure(app); },
      }));
      into.append(tools);
    },
  });
  expert.classList.add('expert-entry');
  body.append(expert);

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
      let recognition=null;
      try { recognition=await app.ensureRecognition?.({maxFunctions:350000,knowledgeLimit:512}); } catch { recognition=null; }
      const report = await autoAnalyze({
        strings, program, symbols: app.symbols, region, fields: app.fields,
        shapes, recognition,
        analyze: makeAnalyzer(app, region),
        scanAccess: makeAccessScanner(app, region),
        isCancelled: () => cancelled || !sheet.root.isConnected,
        onProgress: (p) => {
          box.set({ done: p.done, all: p.all });
          /*
           * 何個目まで進んだかを文にも出す。目的 16 個を 1 つずつ絞る間は
           * 10 秒ほど同じ文言のままになるので、棒だけだと止まったように見える。
           */
          box.say(autoPhaseText(p.phase) +
            (p.all > 1 ? pick('（' + (p.done + 1) + ' / ' + p.all + '）',
              ' (' + (p.done + 1) + ' / ' + p.all + ')') : ''));
        },
      });
      box.done();
      if (cancelled || !sheet.root.isConnected) return;
      app.autoReport = { report, key: region ? region.id : null, gen: app.symbols.gen };
      renderAutoReport(app, sheet, later, report, region);
    }).catch((err) => {
      box.done();
      if (!cancelled && sheet.root.isConnected) {
        beginnerFailure(later, err, {
          actionLabel: pick('関数の一覧を見る', 'Show the function list'),
          onAction: () => { sheet.close(); showFunctions(app); },
        });
      }
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
  const key = goal.id + '\u0000' + goal.text + '\u0000' + app.symbols.gen;
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
    // 形から立てた候補を開いて確かめるとき、参照している文言もそこで読む
    textAt: stringLookup(ctx.strings || []),
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
    /*
     * クラス表から決まらなかったなら、形と命令から「場所」を決めにいく。
     *
     * ここは長いあいだ `!pin.top` のときしか走っていなかった。ところが
     * クラス表がある C++ ゲームでは、pinpointField は必ず何かを 1 位に立てる
     * （中身は広告 SDK の名前で、判定は「見つかりませんでした」）。top が
     * ある以上ここが素通りされ、**命令から降りる道が 1 度も試されないまま**
     * 「見つかりませんでした」と出ていた。battlecats の HP がまさにこれ。
     * 決着していないなら、必ずもう一方も試して、良かったほうを採る。
     */
    const undecided = (p) => !p || !p.top ||
      verdictRank(p.verdict) <= verdictRank(VERDICT.AMBIGUOUS);
    if (undecided(pin) && ((ctx.ranked && ctx.ranked.length) || (common.shapes && common.shapes.size))) {
      const loc = await pinpointLocation(Object.assign({}, common, { ranked: ctx.ranked || [] }))
        .catch(() => null);
      if (beats(loc, pin)) pin = loc;
    }
    /*
     * 値としては決まらなかった。それでも「その処理がどれか」は決まることがある。
     *
     * ゲーム本体が C++ のアプリでは、値の名前はどこにも残っていない代わりに、
     * 「攻撃力アップ:%d 基ダ×(100+%d)÷100」のような、開発者が書いた計算式が残る。
     * その文言を参照している関数が 1 個だけで、しかもその式の定数が命令の中に
     * 実在するなら、処理としては確定できる。ここを呼んでいなかったので、
     * 画面には「見つかりませんでした」しか出ていなかった。
     */
    if (undecided(pin) && ctx.ranked && ctx.ranked.length) {
      const fn = await pinpointFunction(Object.assign({}, common, { ranked: ctx.ranked }))
        .catch(() => null);
      if (beats(fn, pin)) pin = fn;
    }
    return pin;
  })();
  app.pinnedCache.set(key, p);
  return p;
}

/**
 * 3 通りの決め方（値の名前・場所・処理）のうち、どちらの答えを採るか。
 *
 * 判定（確定 > ほぼ確実 > 絞りきれていません）が先。**同じ判定なら確からしさで比べる**。
 * ここを判定だけで比べていたころ、「絞りきれていません 52%」の場所が
 * 「絞りきれていません 99.9%」の処理を押しのけて見出しに出ていた。
 * どちらも決着していないときこそ、材料の多いほうを見せないと意味がない。
 */
function beats(next, cur) {
  if (!next || !next.top) return false;
  if (!cur || !cur.top) return true;
  const rank = verdictRank(next.verdict) - verdictRank(cur.verdict);
  if (rank !== 0) return rank > 0;
  const pn = next.top.fusion ? next.top.fusion.probability : 0;
  const pc = cur.top.fusion ? cur.top.fusion.probability : 0;
  return pn > pc;
}

/*
 * 一覧に並んだ処理を、実際に開いて「何をしているか」に書き換える。
 *
 * ここが無かったころ、一覧はこう出ていた:
 *
 *     sub_100036588
 *     0x100036588
 *     中で数値の計算をしている（45 回の掛け算）
 *
 * 掛け算をしている関数は 10 万個ある。読む人は結局、自分で開いて
 * 1339 命令を読むしかない。それでは半分手作業のままになる。
 *
 * 開くのは重い（1 個で数百ミリ秒かかることもある）ので、一覧を出したあとに
 * 走らせて、言えたものから順に差し替える。シートが閉じたらそこでやめる。
 */
const PURPOSE_ROWS = 10;

/** 答えに選ばれた処理 1 個ぶんの「何をしているか」を、見出しの下に足す。 */
async function describeAnswer(app, region, program, strings, addr, into) {
  const analyze = makeAnalyzer(app, region);
  if (!analyze || !into) return;
  const range = program ? program.functionRange(addr) : null;
  let model = null;
  try { model = await analyze(addr, range ? range.end : null); } catch { model = null; }
  if (!model || !into.isConnected) return;
  let text = '';
  try {
    text = purposeText(describePurpose({
      model, addr, fields: app.fields,
      owner: app.fields ? app.fields.ownerOf(addr) : null,
      textAt: stringLookup(strings || []),
    }));
  } catch { text = ''; }
  if (text) into.append(para(pick('この処理がしていること: ' + text,
    'What this routine does: ' + text), 'sub'));
}

async function fillPurpose(app, region, program, strings, rows) {
  const analyze = makeAnalyzer(app, region);
  if (!analyze || !rows || !rows.length) return;
  const lookup = stringLookup(strings || []);
  for (const r of rows.slice(0, PURPOSE_ROWS)) {
    if (!r.row.isConnected) return;                 // 閉じられた。追いかけない。
    const range = program ? program.functionRange(r.addr) : null;
    let model = null;
    try { model = await analyze(r.addr, range ? range.end : null); } catch { model = null; }
    if (!model) continue;
    let text = '';
    try {
      const owner = app.fields ? app.fields.ownerOf(r.addr) : null;
      text = purposeText(describePurpose({
        model, addr: r.addr, fields: app.fields, owner, textAt: lookup,
      }));
    } catch { text = ''; }
    if (!text) continue;
    const sub = r.row.querySelector('.sub');
    if (!sub) continue;
    /*
     * 「たぶん 🎒 アイテムに関わる処理（判定）」のような下見は、ここで消す。
     * 命令から確かめた文と、名前から当てた推測を並べると、読む人は
     * どちらを信じればいいのか分からなくなる。確かめたほうだけを残す。
     */
    sub.textContent = text + '\n' + r.rest;
  }
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
    results.append(para(userError(err, pick(
      'この値を使っている場所を表示できませんでした。別の処理から確認できます。',
      'The uses of this value could not be shown. Try opening another routine.'))));
  });
}

/* ────────────────────────────────────────────────────────────
   「これです」— 目的 1 つに対する、決着した答え
   ────────────────────────────────────────────────────────────

   このツールで、いちばん見せたい画面。
   候補を並べるのではなく、1 個を出して、なぜそれで確定なのかを全部見せる。
   確定できなかったときは、確定できなかったと言って、何が足りないかを書く。 */

/** 決着の見出し（確定 / ほぼ確実 / 絞りきれていません）。 */
function verdictBadge(verdict, lead) {
  const box = el('div', 'verdict verdict-' + verdict);
  box.append(el('div', 'verdict-word', verdictText(verdict)));
  box.append(el('div', 'verdict-lead', lead || verdictLead(verdict)));
  return box;
}

/*
 * 「絞りきれていません」の説明は 2 通り要る。
 * 決め手が無くて並んでいるのか、担当している処理が本当に複数あるのか。
 * 後者に「決めつけるより両方を見てもらった方が確実です」と書くと、
 * 出せた答えを引っ込めたように読める。
 */
function verdictLeadFor(pin) {
  if (pin && pin.verdict === VERDICT.AMBIGUOUS && pin.tiedVerified >= 2) {
    return pick('この目的を担当している処理は ' + pin.tiedVerified + ' つあります。' +
      'どれも命令まで降りて確かめました。絞り込めなかったのではなく、' +
      'アプリの側で処理が分かれています。',
    'This goal is handled by ' + pin.tiedVerified + ' routines, each confirmed at the ' +
      'instruction level. The work really is split up in this app.');
  }
  return null;
}

/**
 * 特定したものの名前。
 * クラス表があれば `BattleManager.hp`、無ければ `オブジェクトの +0x20 の値`。
 * 名前が無いことを、名前があるかのように見せない。
 */
function pinnedName(c, app) {
  if (!c) return '';
  if (c.kind === 'function') {
    return (app ? fnLabel(app, c.addr) : null) || c.name || addrHex(c.addr);
  }
  if (c.kind === 'location') {
    return pick('オブジェクトの ' + offsetHex(BigInt(c.offset)) + ' にある値',
      'the value at ' + offsetHex(BigInt(c.offset)));
  }
  return c.className + '.' + c.plain;
}

/** 特定した答え 1 個ぶんの見出し行。値のことも、処理のこともある。 */
function pinnedHeadline(pin, app, { technical = false } = {}) {
  const c = pin.top;
  const box = el('div', 'pinned-head');
  box.append(el('div', 'pinned-name', pinnedName(c, app)));
  const bits = [];
  /*
   * 答えが「処理」のときは、位置や大きさが無い。
   * 値の見出しをそのまま使うと `undefined バイト` が出るので、別に組む。
   */
  if (c.kind === 'function') {
    bits.push(technical ? addrHex(c.addr) : pick('目的に関係する処理', 'routine related to this goal'));
    if (technical && c.instructions) bits.push(c.instructions.toLocaleString() + pick(' 命令', ' instructions'));
    box.append(el('div', 'pinned-sub', bits.join('  ·  ')));
    return box;
  }
  if (technical) {
    const type = typeWord(c.type);
    if (type) bits.push(type);
    bits.push(pick('オブジェクトの先頭から ' + offsetHex(BigInt(c.offset)),
      'at ' + offsetHex(BigInt(c.offset))));
    if (c.size) bits.push(c.size + pick(' バイト', ' bytes'));
  } else {
    bits.push(c.kind === 'field'
      ? pick('名前が残っている値', 'named value')
      : pick('命令から見つけた値', 'value found from instructions'));
  }
  box.append(el('div', 'pinned-sub', bits.join('  ·  ')));
  return box;
}

function pinnedPlainSummary(pin) {
  const c = pin.top;
  const updates = c.updates || [];
  if (updates.some((u) => u.kind === 'read-modify-write')) {
    return pick(
      'この値を読み、計算し、同じ場所へ書き戻している処理が見つかりました。',
      'A routine reads this value, calculates with it, and writes it back to the same place.');
  }
  const sites = (pin.changeSites || []).filter((s) => s.stores);
  if (sites.length) {
    return pick('この値へ実際に書き込んでいる処理が見つかりました。',
      'A routine that writes to this value was found.');
  }
  if (c.kind === 'function') {
    return pick('目的に関係する言葉と処理のつながりを持つ関数を、命令まで読んで確認しました。',
      'This routine has goal-related text and call relationships, and its instructions were checked.');
  }
  return pick('名前・型・使われ方を組み合わせて、この値を選びました。',
    'This value was selected from its name, type, and how it is used.');
}

function valueFlowView(update) {
  const wrap = el('div', 'flow-view');
  wrap.tabIndex = -1;
  const lines = updateLines(update);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const split = line.indexOf(': ');
    const node = el('div', 'flow-node');
    if (split >= 0) node.append(el('b', null, line.slice(0, split)), document.createTextNode(line.slice(split + 2)));
    else node.textContent = line;
    wrap.append(node);
    if (i < lines.length - 1) wrap.append(el('div', 'flow-arrow', '↓'));
  }
  return wrap;
}

/* ── 数の流れ（IR / SSA から作る） ────────────────────────────
 *
 * updateLines() は「更新 1 件」を 4 行に要約する。読みやすいが、
 * 「上限で 999,999 に丸めている」「途中で別の処理を呼んでいる」といった、
 * 初心者がいちばん知りたい途中経過が落ちる。
 *
 * こちらは SSA と Memory SSA でつないだ因果の道を、そのまま段にする。
 * 段の数は 8 までに畳み、畳んだ数は必ず画面に出す（黙って消さない）。
 */

const FLOW_KIND_ICON = {
  arg: '→', const: '#', read: '↑', call: '⤴', compute: '＋',
  clamp: '⊓', choose: '⑂', merge: '⋔', write: '↓', unknown: '?',
};

function irFlowView(ir, seed, opts) {
  const chain = causalChain(ir, seed, { limit: (opts && opts.limit) || 8 });
  if (!chain.steps.length) return null;
  const wrap = el('div', 'flow-view flow-rail');
  wrap.tabIndex = -1;
  const written = new Set();
  chain.steps.forEach((step, i) => {
    const text = flowStepText(step);
    if (!text) return;
    const node = el('div', 'flow-node flow-' + text.kind);
    const mark = el('span', 'flow-mark', FLOW_KIND_ICON[text.kind] || '·');
    mark.setAttribute('aria-hidden', 'true');
    const bodyEl = el('div', 'flow-body');
    bodyEl.append(el('b', null, text.label), el('span', null, text.text));
    node.append(mark, bodyEl);
    if (step.address != null && !written.has(step.address)) {
      written.add(step.address);
      node.append(el('span', 'flow-addr mono', addrHex(step.address)));
    }
    wrap.append(node);
    if (i < chain.steps.length - 1) wrap.append(el('div', 'flow-arrow', '↓'));
  });
  if (chain.elided) {
    const note = el('div', 'flow-elided', flowElidedText(chain.elided));
    wrap.append(note);
  }
  if (chain.truncated) {
    wrap.append(el('div', 'flow-elided', pick(
      'この関数は大きいため、途中までしかたどれていません。',
      'This routine is large, so the trail was cut short.')));
  }
  return wrap;
}

/** その場所へ書き込んでいる store のうち、目的の値にいちばん近いものを選ぶ。 */
function pickFlowSeed(ir, offset) {
  const stores = ir.instructions.filter((i) => i.op === IR_OP.STORE && i.loc);
  if (!stores.length) return null;
  if (offset != null) {
    const want = BigInt(offset);
    const exact = stores.find((s) => s.loc.kind === 'field' && s.loc.disp === want);
    if (exact) return exact;
  }
  const rmw = readModifyWrite(ir);
  if (offset != null) {
    const want = BigInt(offset);
    const hit = rmw.find((r) => r.location.kind === 'field' && r.location.disp === want);
    if (hit) return hit.store;
  }
  if (rmw.length) return rmw[0].store;
  return stores.find((s) => s.loc.kind === 'field') || stores[stores.length - 1];
}

/**
 * 答えの画面に「数の流れ」を後から差し込む。
 *
 * 解析は非同期なので、まず今まで通りの表示を出し、IR が組めたら置き換える。
 * 組めなければ何もしない（＝今までの表示のまま）。壊れても画面は壊さない。
 */
/**
 * 「数の流れ」の一区画を、そのまま親へ足す。
 *
 * 答えの画面（目的から入ったとき）と、根拠の画面の両方で同じものを出す。
 * どちらか一方にしか無いと、「さっき見えていた図がどこへ行った」になる。
 */
function appendNumberFlow(app, parent, addr, offset, fallback) {
  parent.append(el('div', 'sec-title', pick('数の流れ', 'How the number moves')));
  const host = el('div', 'flow-host');
  host.tabIndex = -1;
  if (fallback) host.append(fallback);
  else {
    host.append(el('div', 'flow-pending', pick(
      '値の流れを組み立てています…', 'Reconstructing the value flow…')));
  }
  parent.append(host);
  attachIrFlow(app, host, addr, offset)
    .catch(() => { /* 画面は壊さない */ })
    .finally(() => {
      if (!host.querySelector('.flow-pending')) return;
      host.replaceChildren();
      beginnerEmpty(host, pick('数の流れ', 'How the number moves'), pick(
        'この関数では値の流れを十分に復元できませんでした。推測で補わず、確認できた情報だけを表示しています。',
        'The value flow could not be reconstructed well enough in this routine. Nothing has been guessed.'));
    });
  return host;
}

async function attachIrFlow(app, host, addr, offset) {
  if (!host || addr == null) return;
  const region = app.codeRegion ? app.codeRegion() : null;
  if (!region || !app.store.get('canDisassemble')) return;
  const analyze = makeAnalyzer(app, region);
  if (!analyze) return;
  let model = null;
  try {
    const fn = app.symbols ? app.symbols.functionAt(BigInt(addr)) : null;
    model = await analyze(BigInt(addr), fn && fn.end != null ? fn.end : null);
  } catch { return; }
  if (!model || !host.isConnected) return;
  const rowOfAddress = (a) => {
    const rel = BigInt(a) - region.vmAddr;
    if (rel < 0n || rel >= region.size) return null;
    return Number(rel / 4n);
  };
  const ir = irFor(model, { rowOfAddress });
  if (!ir) return;
  const seed = pickFlowSeed(ir, offset);
  if (!seed) return;
  let view = null;
  try { view = irFlowView(ir, seed); } catch { view = null; }
  if (!view || !host.isConnected) return;
  host.replaceChildren(view);
}

export function showPinned(app, pin) {
  if (!pin || !pin.top) return;
  const goal = pin.goal;
  const sheet = new Sheet(goalLabel(goal));
  const body = sheet.body;
  const c = pin.top;

  body.append(verdictBadge(pin.verdict, verdictLeadFor(pin)));
  body.append(pinnedHeadline(pin, app));
  body.append(el('div', 'answer-confidence', pick('確からしさ ', 'Confidence ') +
    probabilityText(c.fusion.probability)));
  const summary = el('section', 'answer-summary');
  summary.append(el('h4', null, pick('何をしている？', 'What does it do?')),
    para(pinnedPlainSummary(pin)));
  body.append(summary);

  body.append(el('div', 'sec-title', pick('なぜ分かる？', 'Why do we know?')));
  const beginnerWhy = el('ul', 'answer-evidence');
  for (const w of c.why.slice(0, 5)) {
    const text = proofText(w);
    if (!text) continue;
    const li = el('li');
    li.append(el('i', null, w.kind === 'inference' ? '•' : '✓'), el('span', null, text));
    beginnerWhy.append(li);
  }
  body.append(beginnerWhy);

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

  const sites = (pin.changeSites && pin.changeSites.length) ? pin.changeSites : c.sites;
  const actions = el('div', 'detail-actions answer-primary-actions');
  const process = c.kind === 'function' ? c.addr
    : (sites || []).find((s) => s.stores && s.addr != null)?.addr
      || (c.functions && c.functions[0] ? c.functions[0].addr : null);
  if (process != null) {
    const primaryRoute = el('div', 'detail-actions answer-primary-route-actions');
    primaryRoute.append(button(pick('この関数を開く', 'Open this function'),
      'chip strong answer-primary-route', () => {
        if (openFunctionSurface(app, process, 'report', goal)) sheet.close();
        else toast(pick('この関数を開けませんでした。', 'This function could not be opened.'));
      }));
    body.append(primaryRoute);
  }
  const update = c.updates && c.updates[0];
  let flow = null;
  let flowHost = null;
  /*
   * 「数の流れ」は、更新が見つかっていなくても IR から組めることがある。
   * ボタンを update があるときだけ出していたころ、いちばん見せたい画面へ
   * 行く道が、材料の有無で消えていた。
   */
  actions.append(button(pick('数の流れを見る', 'Show the number flow'), 'chip', () => {
    const target = flow || flowHost;
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
  }));
  actions.append(button(pick('根拠をひらく', 'Open the evidence'), 'chip', () => {
    const details = body.querySelector('.answer-expert');
    if (details) { details.open = true; details.scrollIntoView({ block: 'start' }); }
  }));

  /*
   * 行き先は 2 種類あり、混ぜると読めなくなる。
   *   ・別の画面へ行く（疑似C・図・アセンブリ）
   *   ・この画面の中で下へ動く（数の流れ・根拠）
   * 先に別画面への一段を置き、そのあとに画面内の移動を小さく置く。
   */
  const views = nextViewsRow(app, process, { sheet, goal, exclude: ['report'], primary: 'pseudocode' });
  if (views) body.append(views);
  const inSheet = el('section', 'in-sheet-actions');
  inSheet.append(el('h4', 'sec-title', pick('この画面の中で確かめる', 'Check inside this result')));
  inSheet.append(actions);
  body.append(inSheet);

  /*
   * 値の流れ。
   *
   * まず今まで通り dataflow.js の要約を出し、そのうしろで IR / SSA を組む。
   * 組めたら、途中の丸めや呼び出しまで入った段に置き換える。
   * 組めなければ今までの表示のまま — 待たせないし、推測でも埋めない。
   */
  if (update) flow = valueFlowView(update);
  flowHost = appendNumberFlow(app, body, process,
    c.kind === 'field' || c.kind === 'location' ? c.offset : null, flow);

  const expert = disclosure(pick('専門家向け詳細', 'Expert details'), {
    build: (into) => {
      into.append(pinnedHeadline(pin, app, { technical: true }));
      const ul = list();
      ul.append(kvRow(pick('確からしさ', 'Confidence'), probabilityText(c.fusion.probability)));
      ul.append(kvRow(pick('調べた値の数', 'Values considered'), pin.universe.toLocaleString()));
      if (pin.runnerUp) {
        ul.append(kvRow(pick('2番目との差', 'Lead over runner-up'), Number.isFinite(pin.marginRatio)
          ? Math.round(pin.marginRatio).toLocaleString() + pick(' 倍', '×')
          : pick('比較対象なし', 'nothing to compare')));
        ul.append(kvRow(pick('2番目の候補', 'Runner-up'), pinnedName(pin.runnerUp, app)));
      }
      if (pin.checked) ul.append(kvRow(pick('実際に読んだ処理', 'Routines disassembled'), String(pin.checked)));
      into.append(ul, el('div', 'sec-title', pick('根拠の内訳', 'Evidence breakdown')));
      const wl = list();
      for (const w of c.why) {
        const text = proofText(w);
        if (!text) continue;
        wl.append(tapRow(text, {
          right: factorText(w.factor),
          tag: w.kind === 'inference' ? pick('推測', 'inference') : pick('検証済', 'verified'),
          tagClass: w.kind === 'inference' ? 'tag-infer' : 'tag-fact',
        }));
      }
      into.append(wl);
      if (c.verifications && c.verifications.length) {
        into.append(el('div', 'sec-title', pick('検証した処理', 'Checked routines')));
        const vl = list();
        for (const v of c.verifications) {
          if (!v.sel) continue;
          const r = v.result || {};
          const ok = (v.what === 'getter' && r.getter) || (v.what === 'setter' && r.setter);
          vl.append(tapRow('-[' + c.className + ' ' + v.sel + ']', {
            sub: addrHex(v.addr),
            tag: ok ? pick('一致', 'match') : pick('不一致', 'no match'),
            tagClass: ok ? 'tag-fact' : 'tag-infer',
            onTap: () => { sheet.close(); showFunctionReport(app, v.addr, goal); },
          }));
        }
        into.append(vl);
      }
      if (sites && sites.length) {
        into.append(el('div', 'sec-title', pick('読み書きしている場所', 'Read and write sites')));
        const sl = list();
        for (const s of sites.slice(0, 20)) {
          const addr = s.first != null ? s.first : s.addr;
          sl.append(tapRow(s.addr != null ? fnLabel(app, s.addr) : addrHex(addr), {
            sub: [s.stores ? pick('書き込み ' + s.stores, s.stores + ' writes') : '',
              s.loads ? pick('読み出し ' + s.loads, s.loads + ' reads') : '', addrHex(addr)].filter(Boolean).join('  ·  '),
            onTap: () => { sheet.close(); s.addr != null ? showFunctionReport(app, s.addr, goal) : app.goToAddress(addr, { announce: true }); },
          }));
        }
        into.append(sl);
      }
      if (pin.candidates.length > 1) {
        into.append(el('div', 'sec-title', pick('ほかの候補', 'Other candidates')));
        const ol = list();
        for (const other of pin.candidates.slice(1)) {
          ol.append(tapRow(pinnedName(other, app), {
            right: probabilityText(other.probability),
            onTap: () => {
              sheet.close();
              if (other.kind === 'function') showFunctionReport(app, other.addr, goal);
              else if (other.kind === 'field') showField(app, other.className, other.field);
              else if (other.updates && other.updates[0]) app.goToAddress(other.updates[0].store.address, { announce: true });
            },
          }));
        }
        into.append(ol);
      }
    },
  });
  expert.classList.add('answer-expert');
  body.append(expert);

  const extraActions = el('div', 'detail-actions');
  if (c.kind === 'function') {
    if (pin.value && pin.value.top) {
      extraActions.append(button(pick('対応する値の候補を見る', 'See the related value candidate'), 'chip', () => {
        sheet.close();
        showPinned(app, pin.value);
      }));
    }
  } else if (c.kind === 'field') {
    extraActions.append(button(pick('この値の使われ方をすべて見る', 'See every use of this value'), 'chip', () => {
      sheet.close();
      showField(app, c.className, c.field);
    }));
    extraActions.append(button(pick('このクラスを開く', 'Open this class'), 'chip', () => {
      sheet.close();
      showClass(app, c.className);
    }));
  } else if (c.functions && c.functions.length) {
    extraActions.append(button(pick('この値を扱っている処理を開く', 'Open the routine that uses it'), 'chip', () => {
      sheet.close();
      showFunctionReport(app, c.functions[0].addr, goal);
    }));
    const at = c.updates && c.updates[0] ? c.updates[0].store.address : null;
    if (at != null) {
      extraActions.append(button(pick('書き換えている命令へ移動', 'Go to the writing instruction'), 'chip', () => {
        sheet.close();
        app.goToAddress(at, { announce: true });
      }));
    }
  }
  if (extraActions.childElementCount) body.append(extraActions);

  body.append(para(pick(
    '※ 静的解析なので、実際に動かして確かめるまでが一手です。' +
    '値を書き換えたら、狙ったところが変わるかどうかを必ず確認してください。',
    'This is static analysis — always confirm at runtime.'), 'sub'));
}

/**
 * その答えは、アプリ自身のものか、組み込んだ SDK のものか。
 *
 * 広告・課金・分析の SDK は Objective-C で書かれているので、C++ のゲームでも
 * その部分だけは名前が残る。結果として「所持金を探したら Adjust の値が出る」。
 * 判定としては間違っていないが、探している人の答えではない。必ずそう言う。
 */
function vendorNoteFor(app, pin) {
  const c = pin && pin.top;
  const cls = c && c.className;
  if (!cls) return null;
  const v = vendorOf(cls, app.fields ? vendorsOf(app.fields) : null);
  if (!v) return null;
  return v.vendor || v.name || null;
}

/** 決着した目的を 1 行で。地図と同じ調子で並べられる形にする。 */
function pinnedRow(app, pin, onTap) {
  const c = pin.top;
  const icon = pin.goal.icon ? pin.goal.icon + ' ' : '';
  const vendor = vendorNoteFor(app, pin);
  const sub = c.kind === 'function'
    ? addrHex(c.addr) + '\n' + (proofText(c.why[0]) || '')
    : (typeWord(c.type) || '') + '  ·  ' + offsetHex(BigInt(c.offset)) +
      (vendor ? '\n' + pick('これは ' + vendor + ' の中の値です（アプリ自身のものではありません）',
        'this lives inside ' + vendor + ', not the app itself') : '') +
      '\n' + (proofText(c.why[0]) || '');
  return tapRow(icon + pin.goal.text + ' → ' + pinnedName(c, app), {
    sub,
    right: pin.verdict === VERDICT.CONFIRMED ? pick('確定', 'confirmed')
      : pin.resolution === 'multiple' ? pick('複数確定', 'multiple')
        : probabilityText(c.fusion.probability),
    tag: vendor ? 'SDK' : (pin.verdict === VERDICT.CONFIRMED ? pick('検証済', 'verified')
      : pin.resolution === 'multiple' ? pick('複数検証済', 'multiple verified') : null),
    tagClass: vendor ? 'tag-infer' : 'tag-fact',
    onTap,
  });
}

/**
 * 自動解析の総括。いちばん上に置く 1 かたまり。
 *
 * 「16 個中いくつ決まったか」「決まらなかったのはなぜか」を先に言う。
 * これが無いと、下に並ぶ候補の一覧が答えのように読まれてしまう。
 */
function autoSummary(app, report) {
  const wrap = el('div', 'autosum');
  const settled = report.settled || report.confirmed || [];
  const all = (report.goals || []).length || 16;
  const vendorOnly = settled.length > 0 && settled.every((p) => vendorNoteFor(app, p));

  const head = settled.length
    ? pick(all + ' 個の目的のうち、' + settled.length + ' 個が決まりました',
      settled.length + ' of ' + all + ' goals settled')
    : pick(all + ' 個の目的を調べましたが、答えと呼べるものは 1 つも決まりませんでした',
      'None of the ' + all + ' goals could be settled');
  wrap.append(el('div', 'autosum-head', head));

  const why = [];
  if (!report.stats.classes) {
    why.push(pick(
      'このアプリには Objective-C のクラス表がありません。値に名前が残っていないので、' +
      '名前から探す方法は使えません。',
      'There is no Objective-C class table here, so values have no names to search by.'));
  } else if (vendorOnly || !settled.length) {
    why.push(pick(
      '名前が読めるのは、組み込んである他社の SDK（広告・課金・分析）だけでした。' +
      'ゲーム本体が C++ や Unity で書かれていると、本体側の値には名前が残りません。' +
      'ゲームの数値は「値のふるまい（増える・減る・0 で止まる）」から探すことになります。',
      'Only the bundled SDKs keep their names. If the game itself is C++ or Unity, its own ' +
      'values have none — they have to be found by how they behave.'));
  }
  if ((report.unexamined || []).length) {
    why.push(pick(
      '逆アセンブルの回数が上限に達したため、' + report.unexamined.length +
      ' 個の目的は命令まで確かめられていません。',
      report.unexamined.length + ' goals were not checked down to the instructions.'));
  }
  for (const line of why) wrap.append(el('div', 'autosum-why', line));

  const stats = report.stats || {};
  wrap.append(el('div', 'autosum-stats', [
    pick('関数 ' + (stats.functions || 0).toLocaleString() + ' 本',
      (stats.functions || 0).toLocaleString() + ' functions'),
    pick('文字列 ' + (stats.strings || 0).toLocaleString() + ' 本',
      (stats.strings || 0).toLocaleString() + ' strings'),
    stats.classes ? pick('クラス ' + stats.classes.toLocaleString() + ' 個',
      stats.classes.toLocaleString() + ' classes') : null,
    stats.pinpointUsed != null ? pick('中身を読んだ関数 ' + stats.pinpointUsed + ' 本',
      stats.pinpointUsed + ' functions read') : null,
  ].filter(Boolean).join('  ·  ')));

  const chips = el('div', 'chips');
  chips.append(button(pick('この結果はどこまで信用できるか', 'How far can this be trusted'), 'chip',
    () => showAccuracyNotes(app, report)));
  wrap.append(chips);
  return wrap;
}

/* ────────────────────────────────────────────────────────────
   この道具は、どこまで信用できるのか
   ────────────────────────────────────────────────────────────

   解析の部品が増えるほど、「どれが事実で、どれが当てずっぽうか」が
   利用者から見えなくなる。ここに 1 枚にまとめて置く。

   段階は 3 つだけにする:

     事実  … バイナリに書いてあることを、そのまま読んだもの。
             読み違いが無ければ必ず正しい（Mach-O の区画、命令、呼び出し先）。
     推定  … 事実から組み立てた解釈。根拠と確からしさが必ず付く。
     参考  … 順番を決めるためだけの点数。当たっている保証はない。
   ──────────────────────────────────────────────────────────── */

export const RELIABILITY = {
  FACT: 'fact',
  INFERRED: 'inferred',
  HINT: 'hint',
};

export function reliabilityWord(level) {
  switch (level) {
    case RELIABILITY.FACT: return pick('事実', 'fact');
    case RELIABILITY.INFERRED: return pick('推定', 'inferred');
    default: return pick('参考', 'hint');
  }
}

export function reliabilityClass(level) {
  return level === RELIABILITY.FACT ? 'tag-fact'
    : level === RELIABILITY.INFERRED ? 'tag-infer' : 'tag-hint';
}

/* 実測してある機能は、その数字をそのまま書く（tests/accuracy.mjs の結果）。 */
const ACCURACY_NOTES = [
  { level: RELIABILITY.FACT, name: 'Mach-O の区画を読む', measured: '100%',
    note: 'ヘッダに書いてあるとおりに読んでいます。' },
  { level: RELIABILITY.FACT, name: '命令を逆アセンブルする', measured: '100%',
    note: 'Capstone（IDA と同じ系統の部品）を使っています。' },
  { level: RELIABILITY.FACT, name: '呼び出し関係をたどる', measured: '100%',
    note: 'bl 命令の飛び先をそのまま集めています。' },
  { level: RELIABILITY.FACT, name: '外部 API の名前を出す', measured: '100%',
    note: 'リンカが残した表を読んでいます。' },
  { level: RELIABILITY.FACT, name: 'クラスとフィールドの表を読む', measured: '99.2%',
    note: 'Objective-C の表がある場合のみ。C++ や Unity のアプリには、この表がありません。' },
  { level: RELIABILITY.FACT, name: 'データの参照先を解く', measured: '99.1%',
    note: 'adrp + add の組を追っています。' },
  { level: RELIABILITY.FACT, name: '関数の切れ目を見つける', measured: '100%',
    note: 'シンボル表がある場合。無い場合は推測になり、再現 83.9% まで落ちます。' },
  { level: RELIABILITY.INFERRED, name: '関数が何をしているかを言う', measured: '91.3%',
    note: '命令の並びから読み取っています。名前が残っていない関数では、当たりにくくなります。' },
  { level: RELIABILITY.INFERRED, name: '引数・戻り値・変数の型', measured: null,
    note: '使われ方からの推定です。「4 バイトで比較されている」以上のことは言えません。' },
  { level: RELIABILITY.INFERRED, name: '構造体を組み立てる', measured: null,
    note: '触っている位置から並びを起こしています。触られていない場所は空白のままです。' },
  { level: RELIABILITY.INFERRED, name: '逆コンパイル', measured: null,
    note: '訳であって、元のソースではありません。訳せない命令は __asm や goto のまま残します。' },
  { level: RELIABILITY.INFERRED, name: '目的から値を 1 個に決める', measured: null,
    note: '名前・型・命令の 3 方向から確かめて、そろったものだけ「確定」と言います。' +
      'クラス表のないアプリでは、そもそも決まりません。' },
  { level: RELIABILITY.HINT, name: '目的ごとの候補と ★', measured: null,
    note: '「今どこから見るべきか」の順番です。★ 4 個でも、外れていることはふつうにあります。' },
  { level: RELIABILITY.HINT, name: 'アプリの地図・注目すべき処理', measured: null,
    note: '呼ばれた回数や言葉の集まりで分けたものです。分け方に正解はありません。' },
];

export function showAccuracyNotes(app, report) {
  const sheet = new Sheet(pick('この結果はどこまで信用できるか', 'How far can this be trusted'));
  const body = sheet.body;

  body.append(para(pick(
    'この道具の中には、性格の違う解析が混ざっています。' +
    'バイナリに書いてあることを読んだだけのものと、そこから組み立てた推測は、' +
    '同じ画面に出ていても信用できる度合いがまったく違います。3 段階に分けてあります。',
    'Different kinds of analysis live in here. Reading what the binary states is not the same ' +
    'as inferring from it. Three levels.')));

  const legend = list();
  legend.append(groupRow(pick('3 つの段階', 'The three levels')));
  legend.append(tapRow(pick('事実', 'Fact'), {
    sub: pick('バイナリに書いてあることを、そのまま読んだもの。読み違いが無ければ必ず正しい。',
      'Read straight out of the binary.'),
    tag: reliabilityWord(RELIABILITY.FACT), tagClass: 'tag-fact',
  }));
  legend.append(tapRow(pick('推定', 'Inferred'), {
    sub: pick('事実から組み立てた解釈。必ず根拠と確からしさが付きます。外れることがあります。',
      'Built on top of facts. Always carries its evidence and a probability.'),
    tag: reliabilityWord(RELIABILITY.INFERRED), tagClass: 'tag-infer',
  }));
  legend.append(tapRow(pick('参考', 'Hint'), {
    sub: pick('見る順を決めるための点数（★）。当たっている保証はありません。',
      'A ranking score. No guarantee at all.'),
    tag: reliabilityWord(RELIABILITY.HINT), tagClass: 'tag-hint',
  }));
  body.append(legend);

  body.append(el('div', 'sec-title', pick('機能ごとの段階と、測った精度',
    'Level and measured accuracy, feature by feature')));
  body.append(para(pick(
    '数字は、正解の分かっている実物のアプリ 1 本で測った結果です（tests/accuracy.mjs）。' +
    'ほかのアプリで同じ数字が出るとは限りません。',
    'Measured against one real app with known answers. Other apps will differ.'), 'sub'));

  let current = null;
  const ul = list();
  for (const item of ACCURACY_NOTES) {
    if (item.level !== current) {
      current = item.level;
      ul.append(groupRow(reliabilityWord(item.level)));
    }
    ul.append(tapRow(item.name, {
      sub: item.note,
      right: item.measured || '',
      tag: reliabilityWord(item.level),
      tagClass: reliabilityClass(item.level),
    }));
  }
  body.append(ul);

  /* いま開いているファイルで、実際にどうだったか。 */
  if (report) {
    body.append(el('div', 'sec-title', pick('いま開いているファイルでは', 'On the file you have open')));
    const stats = report.stats || {};
    const settled = report.settled || report.confirmed || [];
    const sl = list();
    sl.append(kvRow(pick('決まった目的', 'Goals settled'),
      settled.length + ' / ' + ((report.goals || []).length || 16)));
    sl.append(kvRow(pick('名前の読める値', 'Values with names'),
      stats.classes
        ? pick((stats.fields || 0).toLocaleString() + ' 個（クラス ' + stats.classes.toLocaleString() + ' 個）',
          (stats.fields || 0).toLocaleString() + ' fields')
        : pick('0 個（クラス表がありません）', 'none — no class table')));
    sl.append(kvRow(pick('中身まで読んだ関数', 'Functions read in full'),
      String(stats.pinpointUsed || 0)));
    body.append(sl);
    if (!stats.classes) {
      body.append(noteBox(pick(
        'このファイルには Objective-C のクラス表がありません。' +
        'つまり「名前から探す」系の機能は、ここでは当たりません。' +
        '値のふるまい（増える・減る・0 で止まる）から探す方へ回ってください。',
        'No class table here, so anything name-based will not work on this file.')));
    }
  }

  body.append(para(pick(
    '※ 静的解析なので、最後は実際に動かして確かめてください。' +
    'ここで「確定」と出たものも、動かして初めて確かめられます。',
    'This is static analysis. Confirm at runtime.'), 'sub'));
}

/* ── 自動解析の結果を並べる ─────────────────────────────── */

function renderAutoReport(app, sheet, body, report, region) {
  const openGoal = (goal) => { sheet.close(); showCandidates(app, goal); };

  /*
   * 0. まず、決着が付いたもの。
   *    「候補が 40 個あります」ではなく「HP は BattleManager.hp です」から始める。
   *    これが出せたときは、利用者はもう何も探さなくていい。
   */
  /* 0. まず、この解析でどこまで言えたのかを 1 行で言う。
   *    ここを出さずに一覧だけ並べていたころ、決着 0 件でも画面は
   *    「絞れました」から始まり、15% の広告 SDK の値が答えに見えていた。 */
  const pinned = report.pinned || [];
  const settled = report.settled || (report.confirmed || []);
  const unsettled = report.unsettled ||
    pinned.filter((p) => p.verdict !== VERDICT.CONFIRMED && p.top);
  body.append(autoSummary(app, report));

  /* 0.1 決着が付いたもの。ここに出せたなら、利用者はもう何も探さなくていい。 */
  if (settled.length) {
    body.append(el('div', 'sec-title', pick('決まりました', 'Settled')));
    body.append(para(pick(
      '名前・型・持ち主のクラスに加えて、実際に逆アセンブルして命令まで確かめた結果です。' +
      '選ぶだけで、そのまま書き換える場所まで開けます。',
      'Confirmed by disassembling the accessors and checking the instructions themselves.')));
    const ul = list();
    for (const p of settled.slice(0, 8)) {
      ul.append(pinnedRow(app, p, () => { sheet.close(); showPinned(app, p); }));
    }
    body.append(ul);
    if (settled.some((p) => vendorNoteFor(app, p))) {
      body.append(para(pick(
        '※「SDK」と付いたものは、アプリが組み込んでいる他社の部品（広告・課金・分析）の中の値です。' +
        'ゲーム本体の数値ではありません。',
        'Rows marked “SDK” live inside a bundled third-party component, not the app’s own code.'), 'sub'));
    }
  }

  /*
   * 0.2 決まらなかったもの。
   *
   * ここを「ここまで絞れました」として上に並べていたのが、
   * 15% の値が 4 件並ぶ画面の正体だった。畳んでおいて、
   * 開いた人にだけ「何が足りないのか」と一緒に見せる。
   */
  if (unsettled.length) {
    body.append(disclosure(pick(
      '決められなかった目的（' + unsettled.length + ' 件）を見る',
      'See the ' + unsettled.length + ' goals that did not settle'), {
      build: (host) => {
        host.append(para(pick(
          '候補は挙がりましたが、答えと呼べるところまでは絞れませんでした。' +
          '名前が似ているだけの値が上位に来ている場合が多いので、そのつもりで見てください。',
          'Candidates exist but none is an answer — usually just a similar-looking name.')));
        const ul = list();
        for (const p of unsettled.slice(0, 8)) {
          ul.append(pinnedRow(app, p, () => { sheet.close(); showPinned(app, p); }));
        }
        host.append(ul);
      },
    }));
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
    out.append(para(userError(err, pick(
      'データの表を解析できませんでした。文字列や関数の一覧は引き続き利用できます。',
      'The data tables could not be analysed. Strings and functions are still available.'))));
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
      vendors: vendorsOf(app.fields),
    });
    const pin = await pinnedFor(app, goal, {
      strings, program, shapes, region, box, ranked: ranked.candidates,
    });
    box.done();
    if (!sheet.root.isConnected) return;
    /*
     * 「見つかりませんでした」と言いながら、その下に値の名前を大きく出してはいけない。
     * 読む人は見出しではなく名前を答えだと受け取る（`ISBaseAdUnitManager.
     * waterfallLifeCycleHolder` を「確からしさ 0%」付きで HP として出していた）。
     * 決着していないときは、名前を出さずに理由だけ言って、下の候補一覧に譲る。
     */
    const decided = pin && pin.top && pin.verdict !== VERDICT.NONE;
    let candidateHost = results;
    if (pin && pin.top && !decided) {
      results.append(verdictBadge(pin.verdict));
      results.append(para(pick(
        'クラス表の中には、この目的に結びつく値がありませんでした。' +
        'ゲーム本体が C++ で書かれていると、名前が残るのは組み込んだ SDK だけになります。' +
        '下の「関係のありそうな処理」から、命令で確かめられる方へ降りてください。',
        'Nothing in the class table ties to this goal — if the game itself is written in C++, ' +
        'only the bundled SDKs keep their names. Start from the routines listed below instead.')));
    }
    if (decided) {
      results.append(verdictBadge(pin.verdict, verdictLeadFor(pin)));
      results.append(pinnedHeadline(pin, app));
      results.append(el('div', 'answer-confidence', pick('確からしさ ', 'Confidence ') +
        probabilityText(pin.top.fusion.probability)));
      const answerSummary = el('section', 'answer-summary');
      answerSummary.append(el('h4', null, pick('何をしている？', 'What does it do?')),
        para(pinnedPlainSummary(pin)));
      results.append(answerSummary);
      const isFn = pin.top.kind === 'function';
      /*
       * 答えが「処理」のときは、その処理が何をしているかも一緒に言う。
       *
       * 「⚔️ 攻撃力 → sub_100036588（99.9%）」だけを出していたころ、
       * その関数は実は **攻撃力の説明文を組み立てる処理** だった。
       * 判定としては正しい（攻撃力の計算式を書いた文言を、この関数だけが
       * 参照している）が、計算そのものを探しに来た人はそこで必ず迷う。
       * 何をしている処理なのかは命令から言えるのだから、隠さずに出す。
       */
      const answerNote = el('div', 'pinned-work');
      if (isFn) {
        results.append(answerNote);
        describeAnswer(app, region, program, strings, pin.top.addr, answerNote);
      }
      const top = list();
      top.append(tapRow(pick('なぜこれだと言えるのか、根拠をすべて見る',
        'See every piece of evidence'), {
        sub: pick('検証した根拠を平易な説明から順に表示します',
          'Shows checked evidence before technical details'),
        right: '›',
        onTap: () => { sheet.close(); showPinned(app, pin); },
      }));
      if (isFn) {
        top.append(tapRow(pick('処理を見る', 'Show the routine'), {
          sub: pick('何をしている処理か、値の変更、呼び出し元を見る',
            'See what it does, what it changes, and who calls it'),
          right: '›',
          onTap: () => {
            if (openFunctionSurface(app, pin.top.addr, 'report', goal)) sheet.close();
            else toast(pick('この関数を開けませんでした。', 'This function could not be opened.'));
          },
        }));
      }
      const write = (pin.changeSites || []).find((s) => s.stores);
      if (write) {
        top.append(tapRow(pick('この値を書き換えている場所を開く', 'Open the place that changes it'), {
          sub: pick('値を読んで計算し、書き戻す流れを確認します',
            'Check how the value is read, calculated, and written back'),
          right: '›',
          onTap: () => {
            sheet.close();
            if (write.addr != null) showFunctionReport(app, write.addr, goal);
            else app.goToAddress(write.first, { announce: true });
          },
        }));
      }
      results.append(top);

      /*
       * 数の流れ。
       *
       * ここが目的から入った人の着地点なので、命令へ降りる前にこれを見せる。
       * アセンブリを 1 行も読まずに「どこから来た数が、どう変わって、どこへ入るか」
       * だけを追えるようにするのが、このツールがいちばん強くあるべきところ。
       */
      const flowAddr = isFn ? pin.top.addr
        : (write && write.addr != null ? write.addr : null);
      /*
       * 読む相手の処理が無いときも、区画ごと黙って消さない。
       * 消していたころ、目的によって出たり出なかったりする理由が
       * 利用者からはまったく分からなかった。無いなら無いと書く。
       */
      let flowFallback = null;
      if (flowAddr == null) {
        flowFallback = el('div', 'flow-note', pick(
          'この値を書き換えている処理が見つかっていないため、数の流れをたどれません。'
          + '下の候補から処理を開くと、そこでの流れを見られます。',
          'No routine that changes this value was found, so the number flow cannot be traced. '
          + 'Open one of the routines below to see the flow there.'));
      }
      appendNumberFlow(app, results, flowAddr,
        pin.top.kind === 'field' || pin.top.kind === 'location' ? pin.top.offset : null,
        flowFallback);

      /*
       * 実際に開いて確かめた命令。
       *
       * 名前の 1 つも残っていないアプリでは、答えは「+0x30 の 4 バイト」という
       * 住所でしかない。それだけ出されても、読む人には確かめようがない。
       * 「0x10003E318 を開けば、そこでこの値を減らしています」まで出して初めて、
       * 自分の目で見て納得できる。ここがこのツールの答えの終点になる。
       */
      const proof = (pin.top.proof || []).slice(0, 3);
      if (proof.length) {
        results.append(disclosure(pick('詳しく見る（確認した命令）', 'Details (checked instructions)'), {
          build: (into) => {
            const pl = list();
            for (const p of proof) {
              pl.append(tapRow(changeText(p.change), {
                sub: addrHex(p.change.address) + '  ·  ' + fnLabel(app, p.fn),
                right: '›',
                onTap: () => { sheet.close(); showFunctionReport(app, p.fn, goal); },
              }));
            }
            into.append(pl);
          },
        }));
      }
      const more = disclosure(pick('ほかの候補を見る', 'See other candidates'));
      results.append(more);
      candidateHost = more.body;
    }

    if (!ranked.candidates.length) {
      if (decided) return;   // 値は特定できている。処理が無いだけ。
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

    candidateHost.append(para(pick(
      ranked.total + ' 個の候補が見つかりました。上から順に、根拠の強いものです。',
      'Found ' + ranked.total + ' candidates, strongest evidence first.')));
    /*
     * ここには確率を出さない。
     *
     * 以前は点数を 1 - exp(-点/45) で 0〜100% に写して「81%」と出していたが、
     * これは確率ではなく、点数の付け替えでしかなかった。同じ候補を開くと、
     * 命令まで確かめる本物の計算が「確からしさ 0%」と出す。同じ画面の中で
     * 81% と 0% が並ぶことになり、どちらも信じられなくなる。
     *
     * 順番を示すものは順番として出す（★ = 見る順）。確からしさを名乗るのは、
     * 根拠を積み上げて計算した所（evidence.js）だけにする。
     */
    candidateHost.append(para(pick(
      '★ は「今見るべき順」であって、当たっている確からしさではありません。' +
      '確からしさは、開いて命令まで確かめたときに初めて出せます。',
      'Stars mean “look here first” — not a probability. Confidence only exists once ' +
      'the instructions have been checked.'), 'sub'));

    const ul = list();
    const rows = [];
    for (const c of ranked.candidates) {
      const top = c.reasons.slice(0, 2).map(reasonText).filter(Boolean);
      // 名前だけでは何の処理か分からないので、役割の下見を 1 行目に置く
      const tag = roleTagline(app, c.addr);
      const rest = addrHex(c.addr) + '\n' + top.join('\n');
      const row = tapRow(fnLabel(app, c.addr), {
        sub: (tag ? tag + '\n' : '') + rest,
        right: starsText(c.stars),
        onTap: () => { sheet.close(); showCandidateWhy(app, c, goal); },
      });
      row.classList.add('cand');
      ul.append(row);
      rows.push({ addr: c.addr, row, rest });
    }
    candidateHost.append(ul);
    candidateHost.append(para(pick(
      '※ この点数は「関連度」であって、正解であることの証明ではありません。' +
      'それぞれの候補で「なぜこの点になったか」を必ず確認してください。',
      'The score is relevance, not proof. Always check why each candidate scored what it did.'), 'sub'));

    /*
     * ここから先が、一覧を「候補の羅列」から「何をしている処理か」に変える所。
     *
     * 上の行に出ているのは名前・住所・当たった文字列で、どれも
     * 「関係あるかもしれない」までしか言っていない。読む人が本当に知りたい
     * 「で、これは何をしているの？」は、実際に逆アセンブルしないと言えない。
     * 一覧を出したあとに 1 個ずつ開いて、言えたものから差し替えていく
     * （待たせないために、描画のあとで走らせる）。
     */
    fillPurpose(app, region, program, strings, rows);
  }).catch((err) => {
    box.done();
    if (sheet.root.isConnected) {
      beginnerFailure(results, err, {
        actionLabel: pick('逆アセンブリを見る', 'Show disassembly'),
        onAction: () => { sheet.close(); app.goToAddress(app.codeRegion().vmAddr, { announce: true }); },
      });
    }
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
  /*
   * ここは「見る順」を決めるための点数で、確からしさではない。
   * % に直して出すと確率に見えてしまうので、点数のまま出す。
   */
  score.append(el('div', 'score-pct', pick('合計 ' + Math.round(cand.score) + ' 点',
    Math.round(cand.score) + ' points')));
  score.append(el('div', 'score-sub', pick('見る順を決めるための点数です（確からしさではありません）',
    'a ranking score — not a probability')));
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

  const views = nextViewsRow(app, cand.addr, { sheet, goal, primary: 'report' });
  if (views) body.append(views);
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
  /*
   * 数字を出すのは、見出しと同じことを言えるときだけ。
   *
   * 「見つかりませんでした」の横に「確からしさ 4%」を出していたころ、
   * これが自動解析の一覧に出ていた「確定」と並んで読まれて、
   * 「確定と言ったのに 4% とはどういうことだ」になっていた。
   * 決着していない見立ての確率は、見出しの裏づけにならないので出さない。
   * （出すのは、下の「なぜそう言えるのか」の中だけ。）
   */
  if (role.probability > 0 && verdictRank(role.verdict) >= verdictRank(VERDICT.AMBIGUOUS)) {
    badge.append(el('span', 'role-pct',
      role.verdict === VERDICT.AMBIGUOUS
        ? pick('いちばん有力なもので ' + probabilityText(role.probability),
          'best candidate at ' + probabilityText(role.probability))
        : pick('この見立ての確からしさ ' + probabilityText(role.probability),
          probabilityText(role.probability) + ' confident')));
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

/* ────────────────────────────────────────────────────────────
   復元した計算を出す
   ────────────────────────────────────────────────────────────

   ここは「情報を増やして見せる」場所ではない。逆で、1339 命令のうち
   **意味のある 19 行だけ**を残して、あとは全部たたむ場所になる。

   1 行 1 行は式そのもの（`result = result * (x + 100) / 100;`）で、
   その左に開発者が書き残した文言、右にアドレス。押せばその命令へ飛ぶ。
   読む人がやることは、上から順に 19 行を読むことだけ。 */

function comprehensionSection(app, c, sheet, region) {
  if (!c || (!c.steps.length && !c.ret)) return null;
  const wrap = block(pick('この関数が組み立てている計算', 'The calculation this function builds'));

  const head = comprehensionHeadline(c);
  if (head) wrap.append(para(head));

  const symbolFor = (a) => (app.symbols ? app.symbols.nameAt(a) : null);
  /* 置き場の呼び名は、逆コンパイル画面と同じものを使う。
     ここを別々にしていたころ、片方は `&var_88`、もう片方は `sp - 264` と出ていた。 */
  const opts = Object.assign({ symbolFor, maxLen: 200 }, c.naming || {});

  /* 出発点 */
  if (c.seed) {
    const seed = el('div', 'calc-seed');
    seed.append(el('div', 'sub', pick('出発点', 'starts from')));
    seed.append(el('code', 'mono', 'result = ' + renderExpr(c.seed.expr, opts) + ';'));
    wrap.append(seed);
  }

  /* 工程 */
  if (c.steps.length) {
    const ul = list();
    for (const s of c.steps) {
      const note = stepNote(s);
      const sub = [s.label ? '「' + s.label.text + '」' : null, note].filter(Boolean).join('\n');
      ul.append(tapRow(stepText(s, opts), {
        sub: sub || null,
        right: addrHex(s.address),
        mono: true,
        onTap: () => {
          sheet.close();
          const row = Number((s.address - region.vmAddr) / 4n);
          app.viewer.goToRow(row, 'third');
          app.viewer.select(row, false);
          app.viewer.mark(row);
        },
      }));
    }
    wrap.append(ul);
  }

  /* 行き先 */
  const sink = sinkText(c.sink);
  if (sink) wrap.append(para(sink, 'sub'));

  /*
   * 文言との突き合わせ。ここがこのツールの「確定」の中身なので、
   * 何と何が一致したのかを 1 件ずつ出して、読む人が自分で確かめられるようにする。
   */
  if (c.formula && c.formula.distinct >= 2) {
    wrap.append(disclosure(pick(
      '開発者が書いた計算式との一致を見る（' + c.formula.distinct + ' 種類）',
      'Show the agreement with the developer’s own formulas (' + c.formula.distinct + ')'), {
      build: (into) => {
        into.append(para(pick(
          '左が開発者の書き残した文言、右がその数を実際に使っている命令の場所です。' +
          '出どころがまったく違う 2 つが一致しているので、ここがその計算をしていることは' +
          '推測ではありません。',
          'On the left is what the developer wrote; on the right is where that number is actually used.')));
        const ful = list();
        for (const h of c.formula.hits) {
          ful.append(tapRow(h.op + ' ' + h.value.toString(), {
            sub: '「' + h.text + '」',
            right: addrHex(h.address),
            onTap: () => {
              sheet.close();
              const row = Number((h.address - region.vmAddr) / 4n);
              app.viewer.goToRow(row, 'third');
              app.viewer.select(row, false);
              app.viewer.mark(row);
            },
          }));
        }
        into.append(ful);
      },
    }));
  }

  /* 戻り値の式（積算値と別に出す） */
  if (c.ret && c.ret.expr) {
    const r = el('div', 'calc-seed');
    r.append(el('div', 'sub', pick('返している値', 'returns')));
    r.append(el('code', 'mono', 'return ' + renderExpr(c.ret.expr, opts) + ';'));
    wrap.append(r);
  }
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
  const sheet = new Sheet(pick('この関数について', 'About this function'), { size: 'wide' });
  sheet.root.classList.add('function-report-sheet');
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
    if (sheet.root.isConnected) {
      beginnerFailure(later, err, {
        actionLabel: pick('逆アセンブリを見る', 'Show disassembly'),
        onAction: () => { sheet.close(); app.goToAddress(start, { announce: true }); },
      });
    }
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
  /*
   * 1 段目 — 復元した計算そのもの。
   *
   * 大きな関数について、これまでいちばん多かった不満は
   * 「数え上げは読んだが、結局この関数が何を計算しているのか分からない」だった。
   * 命令をまたいで式に戻したものは、数え上げとはまるで別の情報量を持つので、
   * 事実・推測より **先に** 出す。
   */
  if (report.comprehension) {
    const cs = comprehensionSection(app, report.comprehension, sheet, region);
    if (cs) body.append(cs);
  }
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

  body.append(geminiAnalysisSection(report, res));

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
  const views = nextViewsRow(app, id.startAddr, { sheet, goal, exclude: ['report'], primary: 'pseudocode' });
  if (views) body.append(views);

  const actions = el('div', 'detail-actions');
  actions.append(button(pick('アドレスの対応を見る', 'Show address mapping'), 'chip', () => {
    showAddressInfo(app, id.startAddr);
  }));
  actions.append(button(pick('16 進で見る', 'Show the raw bytes'), 'chip', () => {
    sheet.close();
    app.goToAddress(id.startAddr, { announce: true });
    app.setMode('hex');
  }));
  actions.append(button(pick('レポートをコピー', 'Copy report'), 'chip', () => {
    copyText(body.innerText, pick('関数レポート', 'function report'));
  }));
  body.append(actions);
}

/** GeminiのMarkdownを、HTML文字列を使わず安全なDOMとして組み立てる。 */
function appendGeminiInline(parent, text) {
  const src = String(text || '');
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  for (const match of src.matchAll(re)) {
    if (match.index > last) parent.append(document.createTextNode(src.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      parent.append(el('code', 'mono', token.slice(1, -1)));
    } else if (token.startsWith('**')) {
      parent.append(el('strong', null, token.slice(2, -2)));
    } else {
      parent.append(el('em', null, token.slice(1, -1)));
    }
    last = match.index + token.length;
  }
  if (last < src.length) parent.append(document.createTextNode(src.slice(last)));
}

function renderGeminiMarkdown(target, source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  target.replaceChildren();
  let listNode = null;
  let listKind = '';
  let paragraph = [];
  let inCode = false;
  let codeLines = [];

  const closeList = () => { listNode = null; listKind = ''; };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = el('p');
    paragraph.forEach((line, i) => {
      if (i) p.append(document.createElement('br'));
      appendGeminiInline(p, line);
    });
    target.append(p);
    paragraph = [];
  };
  const flushCode = () => {
    const pre = el('pre', 'gemini-code');
    const code = el('code', 'mono');
    code.textContent = codeLines.join('\n');
    pre.append(code);
    target.append(pre);
    codeLines = [];
    inCode = false;
  };
  const appendListItem = (kind, value) => {
    flushParagraph();
    if (!listNode || listKind !== kind) {
      listNode = document.createElement(kind);
      listNode.className = 'gemini-list';
      target.append(listNode);
      listKind = kind;
    }
    const li = document.createElement('li');
    appendGeminiInline(li, value);
    listNode.append(li);
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      flushParagraph();
      closeList();
      if (inCode) flushCode();
      else inCode = true;
      continue;
    }
    if (inCode) { codeLines.push(raw); continue; }
    if (!trimmed) { flushParagraph(); closeList(); continue; }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(); closeList();
      const h = document.createElement('h' + heading[1].length);
      appendGeminiInline(h, heading[2]);
      target.append(h);
      continue;
    }
    if (/^([-*_])(?:\s*\1){2,}$/.test(trimmed)) {
      flushParagraph(); closeList();
      target.append(document.createElement('hr'));
      continue;
    }
    const unordered = trimmed.match(/^[-+*]\s+(.+)$/);
    if (unordered) { appendListItem('ul', unordered[1]); continue; }
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) { appendListItem('ol', ordered[1]); continue; }
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph(); closeList();
      const q = document.createElement('blockquote');
      appendGeminiInline(q, quote[1]);
      target.append(q);
      continue;
    }
    closeList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  closeList();
  if (inCode) flushCode();
}

/** Geminiへ送るのは、この関数に関係する上限付きの根拠だけにする。 */
function geminiAnalysisSection(report, res) {
  const section = block(pick('AIにこの関数を聞く', 'Ask AI about this function'));
  section.classList.add('gemini-analysis');
  section.append(para(pick(
    'この関数の命令・参照・呼び出し関係だけを送って、根拠つきの見立てを得ます。ファイル全体は送信しません。',
    'Only this function’s instructions, references, and call relationships are sent. The full file is not uploaded.'), 'sub'));

  const label = el('label', 'gemini-question-label', pick('質問', 'Question'));
  const question = document.createElement('textarea');
  question.className = 'gemini-question';
  question.rows = 3;
  question.maxLength = 6000;
  question.placeholder = pick(
    '例：この関数の役割と、値が書き込まれる経路を根拠つきで説明してください。',
    'Example: Explain this function’s role and the evidence for how a value is written.');
  question.value = pick(
    'この関数の役割と、値が書き込まれる経路を根拠となるARM64命令とともに説明してください。',
    'Explain this function’s role and the path by which it writes values, citing the relevant ARM64 instructions.');
  label.htmlFor = 'gemini-question-' + String(report.identity.startAddr);
  question.id = label.htmlFor;
  section.append(label, question);

  const controls = el('div', 'gemini-controls');
  const thinkingLabel = el('label', 'gemini-thinking-label', pick('考える深さ', 'Thinking level'));
  const thinking = document.createElement('select');
  thinking.className = 'gemini-thinking';
  thinking.setAttribute('aria-label', pick('考える深さ', 'Thinking level'));
  for (const level of ['minimal', 'low', 'medium', 'high']) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = level;
    option.selected = level === 'high';
    thinking.append(option);
  }
  thinkingLabel.append(thinking);
  const send = button(pick('解析する', 'Analyze'), 'chip strong');
  const cancel = button(pick('キャンセル', 'Cancel'), 'chip');
  const copy = button(pick('回答をコピー', 'Copy answer'), 'chip', () => {
    if (markdownText) copyText(markdownText, pick('Geminiの回答', 'Gemini answer'));
  });
  cancel.disabled = true;
  copy.disabled = true;
  controls.append(thinkingLabel, send, cancel, copy);
  section.append(controls);

  const status = el('p', 'gemini-status sub', '');
  status.setAttribute('aria-live', 'polite');
  const output = el('div', 'gemini-output');
  output.hidden = true;
  output.setAttribute('aria-live', 'polite');
  output.setAttribute('role', 'document');
  section.append(status, output);

  let controller = null;
  let markdownText = '';
  let renderFrame = 0;
  const renderOutput = () => {
    renderFrame = 0;
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 72;
    renderGeminiMarkdown(output, markdownText);
    if (follow) output.scrollTop = output.scrollHeight;
  };
  const scheduleRender = () => {
    if (!renderFrame) renderFrame = requestAnimationFrame(renderOutput);
  };
  const flushRender = () => {
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    renderOutput();
  };
  const setRunning = (running) => {
    send.disabled = running;
    cancel.disabled = !running;
    thinking.disabled = running;
    question.disabled = running;
  };

  send.addEventListener('click', async () => {
    const text = question.value.trim();
    if (!text) {
      status.textContent = pick('質問を入力してください。', 'Enter a question first.');
      question.focus();
      return;
    }
    let payload;
    try {
      payload = buildGeminiPayload(report, res.model, text, thinking.value);
    } catch (err) {
      console.error('[hex] could not prepare Gemini context', err);
      status.textContent = pick('解析対象を準備できませんでした。逆コンパイル結果は引き続き確認できます。',
        'Could not prepare the analysis context. The decompiled result is still available.');
      return;
    }

    controller = new AbortController();
    markdownText = '';
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    output.hidden = false;
    output.replaceChildren();
    copy.disabled = true;
    status.textContent = pick('解析中… 回答を受信し次第、ここへ表示します。', 'Analyzing… the response will appear here as it arrives.');
    setRunning(true);
    try {
      await streamGemini(payload, {
        onText: (chunk) => {
          markdownText += chunk;
          copy.disabled = !markdownText;
          scheduleRender();
        },
      }, controller.signal);
      flushRender();
      if (controller && !controller.signal.aborted) {
        status.textContent = markdownText
          ? pick('解析が完了しました。', 'Analysis complete.')
          : pick('回答本文を受信できませんでした。もう一度お試しください。', 'No response text was received. Please try again.');
      }
    } catch (err) {
      if (markdownText) flushRender();
      if (err && err.name === 'AbortError') {
        status.textContent = pick('解析をキャンセルしました。', 'Analysis cancelled.');
      } else {
        console.error('[hex] Gemini request failed', err);
        status.textContent = pick(
          'AI解析を完了できませんでした。設定を確認するか、下のローカル解析結果を利用してください。',
          'AI analysis could not be completed. Check settings or use the local analysis below.');
      }
    } finally {
      controller = null;
      setRunning(false);
    }
  });

  cancel.addEventListener('click', () => {
    if (controller) controller.abort();
  });
  return section;
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
  const sheet = new Sheet(pick('呼び出しの流れ', 'Call graph'), { size: 'wide' });
  const body = sheet.body;
  const box = progressBox(body, pick('呼び出し関係を調べています…', 'Mapping calls…'));

  app.ensureProgram((p) => box.set(p)).then((program) => {
    box.done();
    if (!sheet.root.isConnected) return;
    if (!program) {
      body.append(para(pick('呼び出し関係を取り出せませんでした。', 'No call relationships could be extracted.')));
      return;
    }

    const { nodes, edges } = callGraph(program, app.symbols, addr, {
      depth: 2,
      limit: 6,
      label: (a) => fnLabel(app, a),
      onNode: (a) => { sheet.close(); showFunctionReport(app, a); },
    });
    const head = el('div', 'graph-head');
    head.append(el('span', null, pick(
      '上が呼ぶ側、中央がこの処理、下が呼ばれる側です。箱を押すと詳細を開けます。',
      'Callers are above, this routine is in the middle, and callees are below. Select a box for details.')));
    head.append(button(pick('広げて見る', 'Expand'), 'chip', () => {
      sheet.close(); showCallGraphPanel(app, addr);
    }));
    body.append(el('div', 'sec-title', pick('この処理のつながり', 'Relationship map')), head);

    if (nodes.length <= 1 || !edges.length) {
      body.append(para(pick('静的に確認できる呼び出しは見つかりませんでした。',
        'No statically resolvable calls were found.'), 'hint'));
    } else {
      body.append(renderGraph(nodes, edges, {}), graphLegend('call'));
    }

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
  if (!insn) {
    const sheet = new Sheet(pick('値の流れ', 'Value flow'));
    beginnerEmpty(sheet.body, pick('値の流れを復元できませんでした', 'The value flow could not be reconstructed'), pick(
      'この関数では十分な解析結果がありません。推測で流れを作ることはしていません。',
      'There is not enough analysis data in this routine. No flow has been guessed.'));
    return;
  }
  const sheet = new Sheet(pick('値の流れ', 'Value flow'));
  const body = sheet.body;
  const addrOf = (r) => region.vmAddr + BigInt(r) * 4n;

  let update = null;
  try {
    const updates = findValueUpdates(model);
    update = updates.find((u) => u.store.row === row || (u.from && u.from.row === row) ||
      (u.steps || []).some((s) => s.row === row)) || null;
  } catch (err) {
    console.error('[hex] value flow failed', err);
  }
  if (update) {
    body.append(para(pick(
      '確認できた命令だけを、上から下へ並べています。',
      'Only confirmed instructions are shown, from top to bottom.')));
    body.append(valueFlowView(update));
  }

  const reg = insn.writes && insn.writes.length ? insn.writes[0] : regKeyOf(insn.ops[0]);
  if (!reg) {
    if (!update) beginnerEmpty(body, pick('この先の流れは分かりませんでした', 'The later flow is unknown'), pick(
      'この命令が作る値を特定できなかったため、ここで追跡を止めました。',
      'The value produced by this instruction could not be identified, so tracking stops here.'));
    return;
  }
  const uses = traceForward(model, row, reg, 24);
  if (!update && !uses.length) {
    beginnerEmpty(body, pick('この先の流れは分かりませんでした', 'The later flow is unknown'), pick(
      'この先で使われている場所を確認できませんでした。別の経路を推測して補うことはしていません。',
      'No later use could be confirmed. Other paths have not been guessed.'));
  }
  const technical = disclosure(pick('専門家向け（命令とアドレス）', 'Expert details (instructions and addresses)'), {
    build: (into) => {
      into.append(codeBlock([addrHex(insn.address) + '  ' + insn.mnemonic +
        (insn.operands ? ' ' + insn.operands : '')]));
      const ul = list();
      if (!uses.length) ul.append(tapRow(pick('この先の使用箇所なし', 'No later use found'), { disabled: true }));
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
      into.append(ul);
    },
  });
  body.append(technical);
  const next = block(pick('次に見るなら', 'What to look at next'));
  next.append(para(pick(
    '書き戻し先を選び、その命令を含む処理全体と、呼び出している場所を確認してください。',
    'Open the write-back location, then inspect its routine and callers.')));
  body.append(next);
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
    title: ['答えに近づく道筋を、根拠つきで読む', 'Follow the evidence, not just the code'],
    body: [
      'iPhone や Mac のアプリは、人間の書いたコードが「機械語」という数字の列に翻訳されたものです。',
      'Hex は、その数字を日本語に訳すだけでなく、「何を調べたいか」から関係する値・処理・根拠まで案内します。',
    ],
    bodyEn: [
      'An app is human-written code translated into machine numbers.',
      'Hex guides you from a question to the related value, routine, and supporting evidence.',
    ],
  },
  {
    title: ['まずは、調べたいことから入る', 'Start with a question'],
    body: [
      'ファイルを開いたら、最初に「調べる」を選んでください。HP・課金・通信のような目的から、関係する処理を絞り込みます。',
      '見つかった結果には、検証済みの事実・推測・まだ決められないことが別々に表示されます。',
    ],
    bodyEn: [
      'After opening a file, start with Find. Pick a goal such as HP, payment, or network to narrow the relevant routines.',
      'Results distinguish verified facts, inferences, and what is still unknown.',
    ],
  },
  {
    title: ['関係図から、命令まで降りる', 'Use the map, then inspect the instruction'],
    body: [
      '関数の詳細では、誰が呼び、何を呼ぶかを関係図で見渡せます。箱を選ぶと、その処理の根拠と命令へ進めます。',
      '命令の意味が気になったら「解説」をオンにしてください。右上の「？」には、ゼロから読める学習コースがあります。',
      'まずはサンプルで、この流れを試してみましょう。',
    ],
    bodyEn: [
      'Function details show a relationship map of callers and callees. Select a box to move into its evidence and instructions.',
      'Turn on Explain for a plain-language line under each instruction. The ? button holds a course from first principles.',
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
    if (page === 0) {
      /* 挿絵は外の置き場を見に行っていて、そのぶん 404 が出ていた。
         ここは端末の中だけで動くので、絵も画面の中で描く。 */
      const visual = el('div', 'guide-visual');
      visual.innerHTML =
        '<svg viewBox="0 0 320 120" role="img" aria-label="' +
        pick('命令から根拠、答えへ進む図', 'From instructions through evidence to an answer') +
        '"><g fill="none" stroke="currentColor" stroke-width="2">' +
        '<rect x="8" y="20" width="78" height="80" rx="6" opacity=".45"/>' +
        '<rect x="121" y="34" width="78" height="52" rx="6" opacity=".7"/>' +
        '<rect x="234" y="44" width="78" height="32" rx="6"/>' +
        '<path d="M90 60h27M203 60h27" stroke-linecap="round"/>' +
        '</g><g fill="currentColor" opacity=".55">' +
        '<rect x="18" y="32" width="52" height="4" rx="2"/><rect x="18" y="44" width="44" height="4" rx="2"/>' +
        '<rect x="18" y="56" width="58" height="4" rx="2"/><rect x="18" y="68" width="38" height="4" rx="2"/>' +
        '<rect x="18" y="80" width="50" height="4" rx="2"/>' +
        '<rect x="133" y="48" width="54" height="4" rx="2"/><rect x="133" y="62" width="40" height="4" rx="2"/>' +
        '<rect x="246" y="58" width="54" height="4" rx="2"/></g></svg>';
      holder.append(visual);
    }
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
