/*
 * 逆コンパイル。
 *
 * アセンブリは「CPU への指示」がそのまま並んだもので、人間が読む形ではありません。
 * ここでは同じ内容を C 風の書き方に直します。IDA の Hex-Rays や Ghidra の
 * Decompiler と同じ考え方です。
 *
 *   ldr  x8, [x0, #0x20]        →   x8 = obj->hp;
 *   subs w8, w8, w1             →   x8 = x8 - w1;
 *   b.le loc_100A400            →   if (x8 <= 0) { … }
 *   bl   _objc_release          →   objc_release(x0);
 *   ret                         →   return x0;
 *
 * 大事な前提が 2 つあります。
 *
 *   1. これは「訳」であって、元のソースコードではありません。
 *      変数名も、型も、命令の並びから推測したものです。
 *   2. 分からないところは分からないと書きます（__asm や goto が残る）。
 *      きれいに見せるために嘘を書かないことを優先しています。
 *
 * 作りは 2 段階です。
 *   A. 制御フローの復元 — basic block のつながりから if / while / for を組み立てる
 *   B. 式の復元       — 命令 1 つ 1 つを式に直し、使い捨ての一時変数をたたむ
 */

import { typeFromAccess, inferTypes, signatureOf } from './types.js';
import { shortName } from './rtti.js';
import { buildValues, render as renderExpr, sizeOf as exprSize, constOf as exprConst } from './expr.js';
import { findAccumulators } from './comprehend.js';
import { analyzeGraph } from './controlflow.js';

/* ── 出力の 1 行 ────────────────────────────────────────────
   kind: 'sig' 見出し / 'decl' 変数宣言 / 'stmt' 文 / 'ctrl' 制御 /
         'label' ラベル / 'comment' 注釈 / 'blank' 空行 */
function line(kind, indent, text, row, addr) {
  return { kind, indent, text, row: row == null ? null : row, addr: addr || null, note: null };
}

/* ── 条件の言い換え ────────────────────────────────────── */

const COND_OPS = {
  eq: '==', ne: '!=',
  lt: '<', le: '<=', gt: '>', ge: '>=',
  lo: '<', ls: '<=', hi: '>', hs: '>=',
  cc: '<', cs: '>=',
  mi: '< 0', pl: '>= 0', vs: 'overflow', vc: '!overflow',
  al: 'true', nv: 'false',
};

/** 条件を反対にする（if の中身と外側を入れ替えるときに使う）。 */
const COND_INVERSE = {
  eq: 'ne', ne: 'eq', lt: 'ge', ge: 'lt', gt: 'le', le: 'gt',
  lo: 'hs', hs: 'lo', hi: 'ls', ls: 'hi', cc: 'cs', cs: 'cc',
  mi: 'pl', pl: 'mi', vs: 'vc', vc: 'vs',
};

const COND_JA = {
  eq: '等しい', ne: '等しくない', lt: '小さい', le: '以下', gt: '大きい', ge: '以上',
  lo: '小さい（符号なし）', ls: '以下（符号なし）', hi: '大きい（符号なし）', hs: '以上（符号なし）',
  cc: '桁上がりなし', cs: '桁上がりあり', mi: 'マイナス', pl: 'プラス以上',
  vs: 'あふれた', vc: 'あふれていない', al: 'いつでも', nv: '決してない',
};

/* ── メイン ─────────────────────────────────────────────── */

/**
 * @param {object} model  blocks.js の Semantic Model
 * @param {object} opts
 *   name          関数名
 *   addr          関数の先頭アドレス（BigInt）
 *   rowOfAddress(addr) → 行番号 | null
 *   addrOfRow(row)     → BigInt
 *   symbolFor(addr)    → 名前 | null
 *   fieldFor(baseReg, offset, row) → {name, type} | null   （self->hp のような名前）
 *   notes         NoteStore（自分で付けた名前）
 *   beginner      true なら日本語の注釈を厚めに付ける
 * @returns {{lines:Array, signature:string, types:object, warnings:Array, labels:Set}}
 */
export function decompile(model, opts) {
  const o = opts || {};
  const insns = model && model.instructions ? model.instructions : [];
  const out = [];
  const warnings = [];
  if (!insns.length) {
    return { lines: [line('comment', 0, '// 命令が読み取れませんでした。', null)], signature: '', types: null, warnings: ['命令なし'], labels: new Set() };
  }

  const ctx = buildContext(model, o);
  const cfg = buildFlow(model, ctx);
  const types = inferTypes(model);
  ctx.types = types;

  /* どのラベルが本当に要るかは、構造化してみないと分からない。
     まず本体を組み立て、そのあとで使われたラベルだけを差し込む。 */
  const body = [];
  let state = newEmitState();
  emitRange(cfg, 0, cfg.nodes.length - 1, 1, body, ctx, state, null);

  /*
   * A structured rendering is only trustworthy if it consumed the complete
   * function.  Mixing a pretty prefix with hundreds of recovered blocks at
   * the end is technically complete but visually lies about address order.
   * If even one Basic Block was left behind, restart in faithful linear-CFG
   * mode: physical addresses stay monotonic and every control edge is explicit.
   */
  const structuredMissing = cfg.nodes.length - state.emitted.size;
  let coverage;
  if (structuredMissing > 0) {
    body.length = 0;
    state = newEmitState();
    if (ctx.usedVars && ctx.usedVars.clear) ctx.usedVars.clear();
    emitLinearCfg(cfg, body, ctx, state);
    coverage = recoverUnemittedBlocks(cfg, body, ctx, state);
    coverage.mode = 'linear';
    coverage.structuredMissing = structuredMissing;
  } else {
    coverage = recoverUnemittedBlocks(cfg, body, ctx, state);
    coverage.mode = 'structured';
    coverage.structuredMissing = 0;
  }

  /* 見出し（シグネチャ） */
  const name = (o.notes && o.notes.nameOf(o.addr)) ||
    (o.name ? shortName(o.name) : null) ||
    ('sub_' + (o.addr != null ? o.addr.toString(16).toUpperCase() : '0'));
  const signature = signatureOf(name, types, o.notes, o.addr);
  out.push(line('sig', 0, signature, insns[0].row, insns[0].address));
  out.push(line('ctrl', 0, '{', insns[0].row));

  /* 変数の宣言。どこに何があるかを先に見せる（本文に出てくるものだけ） */
  const decls = declarations(ctx, types, o, body);
  for (const d of decls) out.push(d);
  if (decls.length) out.push(line('blank', 0, ''));

  for (const l of body) {
    if (l.kind === 'label' && !state.labels.has(l.text.replace(/:$/, ''))) continue;
    out.push(l);
  }
  out.push(line('ctrl', 0, '}', insns[insns.length - 1].row));

  dedupeNotes(out);
  breatheOut(out);

  if (state.gotos) {
    warnings.push('制御の流れが複雑で、' + state.gotos + ' か所は goto のまま残しました（コンパイラの最適化でよくあります）。');
  }
  if (coverage.mode === 'linear') {
    warnings.push('制御フローが高度に最適化されているため、アドレス順の正確モードで表示しています（関数内の処理は省略していません）。');
  }
  if (coverage.recovered) {
    warnings.push('構造化できなかった共有・間接経路 ' + coverage.recovered + ' ブロックを goto で安全に補完しました（関数内の処理は省略していません）。');
  }
  if (coverage.missing) warnings.push('内部エラー: 到達可能な ' + coverage.missing + ' ブロックを出力できませんでした。');
  if (model.truncated) warnings.push('関数が大きいため、途中までを訳しています。');
  if (ctx.unknown.size) {
    warnings.push('訳せなかった命令が ' + ctx.unknown.size + ' 種類あります（__asm として残しています）。');
  }

  return { lines: out, signature, types, warnings, labels: state.labels, ctx, coverage };
}

/* ────────────────────────────────────────────────────────────
   下ごしらえ
   ──────────────────────────────────────────────────────────── */

/** シンボルを引く関数を、短い名前を返す関数に包む。 */
function nameReader(fn) {
  const raw = fn || (() => null);
  return (addr) => {
    const n = raw(addr);
    return n ? shortName(n) : null;
  };
}

function buildContext(model, o) {
  const byRow = new Map();
  for (const i of model.instructions) byRow.set(i.row, i);

  const textOf = new Map();       // row -> 文字列リテラル
  const refOf = new Map();        // row -> {addr, load} 命令が指している絶対アドレス
  for (const r of model.addressRefs || []) {
    if (r.text) textOf.set(r.row, r.text);
    if (r.addr != null && !refOf.has(r.row)) refOf.set(r.row, { addr: r.addr, load: !!r.load });
  }
  const callOf = new Map();       // row -> call 情報
  for (const c of model.calls || []) callOf.set(c.row, c);

  /*
   * 関数の入口で x19〜x30 を預けたスタックの場所を覚えておく。
   *
   * 出口の `ldp x26, x25, [sp, #0x140]` は、その預けたものを取り戻しているだけ。
   * 「関数の終わりの近く」で判定していたころ、例外処理の後始末がうしろに付く
   * 関数では窓から外れて、`x26 = var_140;   result = var_140_2;` が
   * return の直前に 5 行そのまま出ていた。預けた場所と突き合わせれば確実に分かる。
   */
  const savedSlots = new Set();
  const calleeSavedOnly = (insn) => {
    const regs = insn.ops.filter((x) => x.k === 'reg');
    return regs.length > 0 && regs.every((x) => x.cls === 'gp' && x.num >= 19 && x.num <= 30);
  };
  for (const insn of model.instructions) {
    const m = insn.memory;
    if (!m || !m.stack || m.kind !== 'store' || m.disp == null) continue;
    if (!/^(stp|str|stur)$/.test((insn.mnemonic || '').toLowerCase())) continue;
    if (calleeSavedOnly(insn)) savedSlots.add((m.baseReg || 'sp') + ':' + m.disp.toString());
  }

  /*
   * 値グラフ。ここが入って、逆コンパイル結果はようやく「訳」になった。
   *
   * それまでは 1 命令 ＝ 1 行で、5 行に散らばった 1 つの割り算は
   * 5 行のまま（しかも 2 行は __asm）出ていた。値グラフを持つと、
   * その 5 行が作っている値が 1 つの式として手に入るので、
   *
   *   ・意味を持たない中間の行は消せる（誰も変数として使っていないので）
   *   ・残った行には、命令ではなく **計算** が書ける
   *
   * どの値を変数として残し、どの値を式に埋め込むかは decideMaterial が決める。
   */
  let values = null;
  try { values = buildValues(model, { symbolFor: o.symbolFor }); } catch { values = null; }

  /*
   * 持ち回っている値には `result` という名前を付ける。
   *
   *   x25 = x25 * (int32)(x0 + 100) / 100;      ← どの x25 の話か、読む人には分からない
   *   result = result * (int32)(x0 + 100) / 100;
   *
   * 同じレジスタを 19 回作り変えている関数で、これが「1 本の値を組み立てている」と
   * 見えるかどうかは、名前ひとつで決まる。持ち回りが 3 段以上あるときだけ名乗らせる
   * （1〜2 回なら、ただの受け渡しかもしれないので、レジスタ名のほうが正直）。
   */
  let carry = null;
  if (values) {
    try {
      const best = (findAccumulators(model, values) || [])[0];
      if (best && best.count >= 3) carry = { reg: best.reg, steps: best.count };
    } catch { carry = null; }
  }

  const aliases = values ? argAliases(model, values) : new Map();

  const material = values ? decideMaterial(model, values) : null;
  if (carry && material) {
    const head = carry.reg + '_';
    for (const [v, n] of material.names) {
      if (n === carry.reg || n.startsWith(head)) material.names.set(v, 'result');
    }
  }

  return {
    model,
    byRow,
    textOf,
    refOf,
    callOf,
    savedSlots,
    frame: frameOf(model),
    values,
    material,
    carry,
    aliases,
    rowOfAddress: o.rowOfAddress || (() => null),
    addrOfRow: o.addrOfRow || (() => null),
    /*
     * 名前は、必ずここを通してから行に置く。
     *
     * リンカが残す C++ の名前は
     *   __ZNSt3__1plIcNS_11char_traitsIcEENS_9allocatorIcEEEENS_12basic_stringI…
     * のような記号の列で、そのまま逆コンパイル結果に出すと 1 行が読めなくなる。
     * ここで std::operator+ / std::string::append まで短くしてから渡す。
     * 元の名前は、その行を押したときに出す（消してしまわない）。
     */
    symbolFor: nameReader(o.symbolFor),
    rawSymbolFor: o.symbolFor || (() => null),
    fieldFor: o.fieldFor || (() => null),
    notes: o.notes || null,
    funcAddr: o.addr != null ? o.addr : null,
    beginner: o.beginner !== false,
    firstRow: model.instructions.length ? model.instructions[0].row : 0,
    lastRow: model.instructions.length ? model.instructions[model.instructions.length - 1].row : 0,
    unknown: new Set(),
    stackNames: new Map(),
    usedVars: new Set(),
  };
}

/**
 * 「関数の頭で引数を預けたきり、最後まで触っていないレジスタ」を見つける。
 *
 * ARM64 の呼び出し規約では、引数は x0〜x7 で来る。ところが x0〜x7 は
 * 呼び出しで壊れるので、コンパイラはまず x19〜x28 へ写す。その結果、
 * 逆コンパイル結果の頭にはいつもこれが並ぶ:
 *
 *     x19 = a1; x20 = a2; x21 = a3; x24 = a4; x27 = a6; x22 = a7; x26 = a8;
 *
 * そのあと本文は x19 や x24 で書かれるので、読む人は 8 行ぶんの対応表を
 * 覚えながら読むことになる。関数の中で **一度しか代入されていない** なら、
 * そのレジスタは最後まで引数そのものなので、名前ごと a1, a4 … に直してよい。
 * 一度しか代入されていないことは値グラフから確かめられる（推測ではない）。
 *
 * @returns Map<レジスタ, 'aN'>
 */
function argAliases(model, vg) {
  const out = new Map();
  const defCount = new Map();
  const firstValue = new Map();
  for (const insn of model.instructions || []) {
    const made = vg.defs.get(insn.row);
    if (!made) continue;
    /*
     * 関数の終わりで x19〜x28 を取り戻す ldp は「代入」に数えない。
     * 数えてしまうと、どの引数も「2 回代入されている」ことになって、
     * この見分けは 1 つも当たらない（実際そうなっていた）。
     */
    const m = insn.memory;
    if (m && m.stack && m.kind === 'load' &&
        insn.writes.every((w) => /^x(19|2[0-9]|30)$/.test(w))) continue;
    for (const reg of Object.keys(made)) {
      defCount.set(reg, (defCount.get(reg) || 0) + 1);
      if (!firstValue.has(reg)) firstValue.set(reg, made[reg]);
    }
  }
  for (const [reg, n] of defCount) {
    if (n !== 1) continue;
    if (!/^x(19|2[0-8])$/.test(reg)) continue;   // 呼び出しをまたいで残るレジスタだけ
    const v = firstValue.get(reg);
    if (v && v.k === 'arg') out.set(reg, 'a' + (v.n + 1));
  }
  return out;
}

/* ────────────────────────────────────────────────────────────
   どの値を「変数」として残すか
   ────────────────────────────────────────────────────────────

   命令 1 つに 1 行を割り当てると、逆コンパイル結果は代入だらけになって読めない。
   かといって全部を埋め込むと、1 行が 400 文字の式になって、これも読めない。

   人が書く C との違いはここで、人は「2 回以上使う値」と「名前を付けたい値」
   だけに変数を作る。同じ規則を使う。

     ・2 か所以上から使われている        → 変数として残す（でないと計算が二重に出る）
     ・別のブロックから使われている      → 変数として残す（式が飛び越えられない）
     ・式が大きい                        → 変数として残す（読めなくなるので）
     ・呼び出しの結果                    → 原則は残す（順序が意味を持つため）
     ・それ以外                          → 使う側へ埋め込む（行ごと消える）

   これで、意味を持たない中間の行は 1 行も出なくなる。 */

const INLINE_MAX = 14;      // 埋め込みを許す式の大きさ

function decideMaterial(model, vg) {
  const insns = model.instructions || [];
  const blocks = model.basicBlocks || [];
  const blockOf = new Map();
  blocks.forEach((b, i) => { for (const r of b.rows) blockOf.set(r, i); });
  const liveOut = liveOutSets(model, blocks, blockOf);

  const uses = new Map();          // ノード → 使われた回数
  const crossed = new Set();       // 別ブロックから使われたノード
  const firstUse = new Map();      // ノード → いちばん早く使われた行
  const bump = (nodeValue, atRow) => {
    if (!nodeValue) return;
    const def = vg.nodeDef.get(nodeValue);
    if (!def) return;
    uses.set(nodeValue, (uses.get(nodeValue) || 0) + 1);
    if (!firstUse.has(nodeValue) || atRow < firstUse.get(nodeValue)) firstUse.set(nodeValue, atRow);
    if (blockOf.get(def.row) !== blockOf.get(atRow)) crossed.add(nodeValue);
  };

  for (const insn of insns) {
    for (const r of insn.reads) bump(vg.at(insn.row, r), insn.row);
  }
  for (const w of vg.memWrites || []) bump(w.value, w.row);
  for (const r of vg.returns || []) bump(r.value, r.row);
  /*
   * 引数は数に入れない。呼び出しの行が中身をそのまま書き出すので、
   * `x1 = a4;` という行を別に立てる必要がない。
   * （消えてしまわないよう、あとの掃除では「使われている」として数える。）
   */

  /*
   * そのブロックの中で、そのレジスタへの **最後の** 代入だけが外へ出ていける。
   * ここを見ずに「外へ出るレジスタなら全部残す」にしていたころ、
   * `x8 = 2; x8 = 4; x8 = 8; …` という、次の行で上書きされるだけの代入が
   * 12 行並んでいた。
   */
  const lastInBlock = new Map();
  const lastCallRow = new Map();
  const defRows = new Map();       // ノード → そのノードを置いた行の一覧
  for (const insn of insns) {
    const bi = blockOf.get(insn.row);
    const made = vg.defs.get(insn.row) || {};
    for (const reg of Object.keys(made)) {
      lastInBlock.set(bi + ':' + reg, made[reg]);
      const list = defRows.get(made[reg]) || [];
      list.push({ row: insn.row, reg });
      defRows.set(made[reg], list);
    }
    if (insn.isCall) lastCallRow.set(bi, insn.row);
  }

  /*
   * 1 つの値が、2 つのレジスタに置かれることがある。
   *
   *   asr x8, x8, #0x25            ← ここで「÷100」が完成する
   *   add x25, x8, x8, lsr #63     ← 符号を直して x25 へ。値としては同じもの
   *
   * 値グラフから見ると同じ 1 つのノードなので、行を出すのは 1 回でよい。
   * 問題はどちらの行に出すか ——「最後に置いた行」に出すのが読みやすい
   * （x8 という使い捨てではなく、result という持ち回りの名前で出るため）。
   * ただし、途中でその値が使われているなら、使われるより前に出さないといけない。
   */
  const canonical = new Map();
  for (const [nodeValue, list] of defRows) {
    /*
     * 呼び出しだけは動かせない。呼んだ行がそのまま処理なので、
     * あとの `mov x26, x0` を「置いた行」にすると、呼び出しが 2 行に見える
     * （実際 `x26 = f(...)` が 2 回続けて出ていた）。
     */
    if (nodeValue.k === 'call') { canonical.set(nodeValue, list[0]); continue; }
    const limit = firstUse.has(nodeValue) ? firstUse.get(nodeValue) : Infinity;
    let pick = list[0];
    for (const d of list) if (d.row <= limit) pick = d;
    canonical.set(nodeValue, pick);
  }
  /*
   * 呼び出しは x0〜x17 を壊す（AAPCS64）。だから同じブロックの中で
   * 呼び出しより手前にある x0〜x17 への代入は、そのブロックの外へは出ていけない。
   * 引数を用意する `mov x1, x24` が「外へ出るから残す」と判定されて、
   * すぐ下の呼び出しの行に同じ中身が書いてある、という重複はここで消える。
   */
  const killedByCall = (def) => {
    if (!/^x([0-9]|1[0-7])$/.test(def.reg)) return false;
    const bi = blockOf.get(def.row);
    const call = lastCallRow.get(bi);
    return call != null && call > def.row;
  };

  /*
   * 「あとで名前として出てくるのに、その行を消してしまった」を絶対に起こさない。
   *
   * 値グラフは分岐の合流で追跡をやめる。やめた先で同じレジスタが読まれると、
   * そこには式ではなく `x25` という名前が出る。名前が出るなら、その名前へ
   * 値を入れる行が残っていなければならない。
   *
   * 判定は素直に生存区間で行う。ブロックの中では値を見失うことはないので、
   * **そのブロックの外へ生きて出るレジスタ** への代入は必ず行として残す。
   * ここを「直前の代入と同じ値か」で近似していたころ、分岐の反対側で
   * 同じレジスタに代入があるだけで判定がすり抜けて、
   * `x25 = …` の行だけが消えるという壊れ方をしていた。
   */
  const material = new Set();
  for (const [nodeValue, first] of vg.nodeDef) {
    /*
     * 生存の判定は「行として出す側」で行う。
     *
     * vg.nodeDef が覚えているのは、その値を **最初に** 置いた行で、
     * たいてい使い捨ての x8 のほう。x8 の生存を見て「誰も使わない」と判定し、
     * 実際には x25（＝ result）として最後まで持ち回る値の行を、
     * まるごと消していた。÷100 の段が 8 か所そろって消えたのはこれ。
     */
    const def = canonical.get(nodeValue) || first;
    const n = uses.get(nodeValue) || 0;
    const big = visibleSize(nodeValue, material) > INLINE_MAX;
    const bi = blockOf.get(def.row);
    const live = bi != null && liveOut[bi] && liveOut[bi].has(def.reg) &&
      lastInBlock.get(bi + ':' + def.reg) === nodeValue && !killedByCall(def);
    /* 呼び出しは、結果を使っていなくても必ず行として残す（呼んだこと自体が処理）。 */
    if (nodeValue.k === 'call') { material.add(nodeValue); continue; }
    if (live) { material.add(nodeValue); continue; }
    if (n === 0) continue;                       // 誰も使わない値。行ごと消える。
    if (n > 1 || crossed.has(nodeValue) || big) material.add(nodeValue);
  }
  /*
   * 大きさの判定は、変数として残すと決めたところで止まる。
   * 最初の 1 巡では止め先がまだ決まっていないので、決まったぶんを踏まえて数え直す。
   */
  for (let round = 0; round < 2; round++) {
    for (const [nodeValue] of vg.nodeDef) {
      if (material.has(nodeValue) || !(uses.get(nodeValue) > 0)) continue;
      if (visibleSize(nodeValue, material) > INLINE_MAX) material.add(nodeValue);
    }
  }

  /*
   * ここまでの「使われた回数」は、命令がそのレジスタを読んでいるかで数えている。
   * ところが式に戻す過程で、読んでいた値そのものが消えることがある。
   *
   *   smulh x8, x8, x9        ← 割り算の途中。数え上げでは 2 回読まれている
   *   asr   x9, x8, #6
   *   add   x25, x9, x8, lsr #63   →  x25 = … / 100;   ← smulh は式から消えた
   *
   * 消えた値の行を残すと、誰も使わない中間結果が 1 行だけ取り残される。
   * 最後に、実際に書き出す式の中に出てくるかどうかで数え直して落とす。
   */
  for (let round = 0; round < 3; round++) {
    const seen = new Set();
    const mark = (n, self) => {
      if (!n) return;
      const stack = [n];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur) continue;
        if (cur !== self && material.has(cur)) { seen.add(cur); continue; }
        const kids = cur.k === 'bin' ? [cur.a, cur.b]
          : cur.k === 'un' ? [cur.a]
            : cur.k === 'sel' ? [cur.a, cur.b]
              : cur.k === 'mem' ? [cur.base, cur.index]
                : cur.k === 'call' ? (cur.args || []).map((a) => a.value) : [];
        for (const c of kids) if (c) stack.push(c);
      }
    };
    for (const nodeValue of material) mark(nodeValue, nodeValue);
    for (const w of vg.memWrites || []) mark(w.value, null);
    for (const r of vg.returns || []) mark(r.value, null);
    for (const insn of insns) {
      if (!insn.isCall) continue;
      for (let a = 0; a <= 7; a++) mark(vg.at(insn.row, 'x' + a), null);
    }
    let dropped = 0;
    for (const nodeValue of Array.from(material)) {
      if (nodeValue.k === 'call') continue;                 // 呼び出しは残す（副作用）
      const def = canonical.get(nodeValue) || vg.nodeDef.get(nodeValue);
      const bi = def ? blockOf.get(def.row) : null;
      /*
       * 「掛け算の上位だけ」は、割り算に戻すためだけに作られる中間値。
       *
       *   x23 = result * (int32)x26 *hi 0x20C49BA5E353F7CF;
       *
       * 割り算に戻した時点で誰も見ていないのに、レジスタとしては生きているので
       * 生存の判定に引っかかって、意味のないこの 1 行だけが残っていた。
       * 誰の式にも出てこないなら、落としてよい。
       */
      const magicOnly = nodeValue.k === 'bin' && (nodeValue.op === 'smulh' || nodeValue.op === 'umulh');
      if (!magicOnly && bi != null && liveOut[bi] && liveOut[bi].has(def.reg) &&
          lastInBlock.get(bi + ':' + def.reg) === nodeValue && !killedByCall(def)) continue;
      if (seen.has(nodeValue)) continue;
      material.delete(nodeValue);
      dropped++;
    }
    if (!dropped) break;
  }

  /*
   * 最後に「1 か所からしか参照されない中間値」を畳む。
   *
   *   x8_2   = result * (int32)(x27 + x28 + 100);
   *   result = x8_2 / 100;
   *        ↓
   *   result = result * (int32)(x27 + x28 + 100) / 100;
   *
   * 割り算に戻す前は x8 が 2 回読まれていた（積を smulh へ、そのあと補正へ）ので
   * 「2 回使われている ＝ 変数として残す」に当たっていた。割り算に戻した時点で
   * 読む側は 1 つになっているのに、数え直していなかったので 2 行のまま出ていた。
   * 1 か所からしか参照されず、ブロックをまたがず、外へも出ていかない値だけを畳む。
   */
  const MERGE_MAX = 26;
  for (let round = 0; round < 3; round++) {
    const refs = new Map();
    const tally = (n, self) => {
      if (!n) return;
      const stack = [n];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur) continue;
        if (cur !== self && material.has(cur)) { refs.set(cur, (refs.get(cur) || 0) + 1); continue; }
        const kids = cur.k === 'bin' ? [cur.a, cur.b]
          : cur.k === 'un' ? [cur.a]
            : cur.k === 'sel' ? [cur.a, cur.b]
              : cur.k === 'mem' ? [cur.base, cur.index]
                : cur.k === 'call' ? (cur.args || []).map((a) => a.value) : [];
        for (const c of kids) if (c) stack.push(c);
      }
    };
    for (const nodeValue of material) tally(nodeValue, nodeValue);
    for (const w of vg.memWrites || []) tally(w.value, null);
    for (const r of vg.returns || []) tally(r.value, null);
    for (const insn of insns) {
      if (!insn.isCall) continue;
      for (let a = 0; a <= 7; a++) tally(vg.at(insn.row, 'x' + a), null);
    }
    let merged = 0;
    for (const nodeValue of Array.from(material)) {
      if (nodeValue.k === 'call') continue;             // 呼び出しは順序が意味を持つ
      if (crossed.has(nodeValue)) continue;             // 別のブロックから使われている
      if ((refs.get(nodeValue) || 0) !== 1) continue;
      const def = canonical.get(nodeValue) || vg.nodeDef.get(nodeValue);
      const bi = def ? blockOf.get(def.row) : null;
      if (bi != null && liveOut[bi] && liveOut[bi].has(def.reg) &&
          lastInBlock.get(bi + ':' + def.reg) === nodeValue && !killedByCall(def)) continue;
      if (visibleSize(nodeValue, material) > MERGE_MAX) continue;
      material.delete(nodeValue);
      merged++;
    }
    if (!merged) break;
  }

  /*
   * 変数として残した値に、名前を付ける。
   *
   * レジスタ名をそのまま使うと、同じ x0 に 40 回別の値が入るので、
   * 式の中の `x0` がどの x0 なのか決まらない（そして必ず間違って読まれる）。
   * かといって v1, v2 … にすると、アセンブリと突き合わせられなくなる。
   *
   * だから「そのレジスタに入った何番目の値か」を名前にする。
   *   x0 に 1 個しか入らない関数なら  → x0
   *   x0 に何度も入る関数なら         → x0_1, x0_2, …
   * これならアセンブリの側から追えるし、どの値かも 1 つに決まる。
   */
  /*
   * ただし、値を見失ったレジスタは番号を振らない。
   *
   * 分岐の合流で追跡が切れると、そこから先の式には `x25` という素の名前が出る。
   * その状態で代入の側だけ `x25_4` と名乗ると、`x25` に値を入れる行が
   * どこにも無いことになる — いちばんまずい壊れ方をする。
   * 見失うレジスタについては、素直にレジスタ名を変数名として使う
   * （アセンブリと同じ読み方になるので、突き合わせもしやすい）。
   */
  const lost = new Set();
  for (const insn of insns) {
    for (const r of insn.reads) {
      const at = vg.at(insn.row, r);
      if (at && at.k === 'reg' && at.reg === r) lost.add(r);
    }
  }

  const names = new Map();
  const perReg = new Map();
  for (const insn of insns) {
    const made = vg.defs.get(insn.row) || {};
    for (const reg of Object.keys(made)) {
      const v = made[reg];
      if (!material.has(v) || names.has(v)) continue;
      /* 同じ値を 2 か所に置いているときは、行を出す側の名前だけを使う。 */
      const can = canonical.get(v);
      if (can && (can.row !== insn.row || can.reg !== reg)) continue;
      /*
       * 見失うレジスタは、そのブロックの **最後の** 代入だけが素の名前を名乗る。
       * 合流の先で `x0` と書かれたときに指しているのは、どの道を通っても
       * 「その道の最後に入れた値」だから。同じブロックの途中の代入まで
       * 素の名前にすると、1 つの式の中に `x0 + x0` が出て意味が壊れる。
       */
      if (lost.has(reg) && lastInBlock.get(blockOf.get(insn.row) + ':' + reg) === v) {
        names.set(v, reg);
        continue;
      }
      const list = perReg.get(reg) || [];
      list.push(v);
      perReg.set(reg, list);
      names.set(v, reg + '_' + list.length);
    }
  }
  for (const [reg, list] of perReg) {
    if (list.length === 1 && !lost.has(reg)) names.set(list[0], reg);
  }
  return { material, uses, crossed, blockOf, names, lost, canonical };
}

/** 変数として残したところで止めた、見た目の大きさ。 */
function visibleSize(n, material, depth) {
  if (!n || (depth || 0) > 24) return 1;
  let total = 1;
  const kids = n.k === 'bin' ? [n.a, n.b]
    : n.k === 'un' ? [n.a]
      : n.k === 'sel' ? [n.a, n.b]
        : n.k === 'mem' ? [n.base, n.index].filter(Boolean)
          : n.k === 'call' ? (n.args || []).map((a) => a.value) : [];
  for (const c of kids) {
    if (!c) continue;
    total += material.has(c) ? 1 : visibleSize(c, material, (depth || 0) + 1);
  }
  return total;
}

/**
 * ブロックごとの「外へ生きて出るレジスタ」。教科書どおりの後ろ向き解析。
 * 飛び先が読めない分岐があるブロックは、安全側に全部生きているものとして扱う。
 */
function liveOutSets(model, blocks, blockOf) {
  const n = blocks.length;
  const use = [], def = [], succ = [];
  const rowAt = new Map();
  for (const insn of model.instructions || []) {
    if (insn.address != null) rowAt.set(insn.address.toString(), insn.row);
  }
  const byRow = new Map();
  for (const insn of model.instructions || []) byRow.set(insn.row, insn);

  for (let i = 0; i < n; i++) {
    const u = new Set(), d = new Set(), s = new Set();
    for (const row of blocks[i].rows) {
      const insn = byRow.get(row);
      if (!insn) continue;
      for (const r of insn.reads) if (!d.has(r)) u.add(r);
      if (insn.isCall) for (let a = 0; a <= 7; a++) if (!d.has('x' + a)) u.add('x' + a);
      for (const w of insn.writes) d.add(w);
      if (insn.isCall) for (let a = 0; a <= 17; a++) d.add('x' + a);
    }
    const last = byRow.get(blocks[i].endRow);
    if (last && last.isBranch && !last.isCall && !last.isReturn) {
      if (last.branchTarget != null) {
        const t = rowAt.get(last.branchTarget.toString());
        if (t != null && blockOf.has(t)) s.add(blockOf.get(t));
      }
      if (last.isConditional && i + 1 < n) s.add(i + 1);
    } else if (i + 1 < n && !(last && last.isReturn)) s.add(i + 1);
    use.push(u); def.push(d); succ.push(Array.from(s));
  }

  const out = blocks.map(() => new Set());
  const inSet = blocks.map(() => new Set());
  for (let round = 0; round < 40; round++) {
    let changed = false;
    for (let i = n - 1; i >= 0; i--) {
      const o = new Set();
      for (const s of succ[i]) for (const r of inSet[s]) o.add(r);
      const ni = new Set(use[i]);
      for (const r of o) if (!def[i].has(r)) ni.add(r);
      if (ni.size !== inSet[i].size || o.size !== out[i].size) changed = true;
      inSet[i] = ni; out[i] = o;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * 式を C の文にする。ほかの行で変数として残した値は、その名前で止める。
 * 止めないと、同じ計算が何行にも重複して出てしまう。
 */
function exprText(ctx, nodeValue, self) {
  if (!nodeValue) return null;
  const mat = ctx.material;
  const opts = {
    symbolFor: ctx.symbolFor,
    maxLen: 400,
    nameOf: (n) => {
      /*
       * 置き場の番地は、番地ではなく置き場の名前で書く。
       * `sub_10000477C(sp - 264, …)` では、それが var_88 のことだと誰にも分からない。
       * 自分自身より先に見る — `x26 = sp - 368;` も `x26 = &var_20;` のほうがよい。
       */
      if (n.k === 'bin' || n.k === 'reg') {
        const d = stackDispOf(n, ctx);
        if (inFrame(d, ctx)) return '&' + slotName('sp', d, ctx);
      }
      if (n === self) return null;               // 自分自身は展開する
      if (n.k === 'reg') return varOf(n.reg, ctx);
      if (n.k === 'arg') return argName(n.n, ctx);
      if (mat && mat.names.has(n)) {
        ctx.usedVars.add(mat.names.get(n));
        return mat.names.get(n);
      }
      return null;
    },
    memName: (m) => memNodeName(m, ctx),
    callName: (c) => callLabel(c, ctx),
  };
  return renderExpr(nodeValue, opts);
}

/**
 * その行がその レジスタ に入れた値の呼び名。
 * 値グラフが名前を持っていればそれを使う（式の中の名前とそろえるため）。
 */
function nameForDef(ctx, row, reg) {
  if (ctx.values && ctx.material) {
    const v = ctx.values.defAt(row, reg);
    const n = v ? ctx.material.names.get(v) : null;
    if (n) { ctx.usedVars.add(n); return n; }
  }
  return varOf(reg, ctx);
}

/** 引数の呼び名。types.js が付けた a1, a2 … にそろえる。 */
function argName(n, ctx) {
  const custom = ctx.notes && ctx.funcAddr != null ? ctx.notes.varName(ctx.funcAddr, 'x' + n) : null;
  return custom || ('a' + (n + 1));
}

/** メモリ参照の呼び名。スタックなら var_XX、名前が読めるなら self->hp。 */
function memNodeName(m, ctx) {
  if (m.stack && m.disp != null) {
    return slotName(m.baseReg === 'x29' ? 'x29' : 'sp', m.disp, ctx);
  }
  /*
   * オペランドが `[sp, #N]` の形をしていなくても、番地の式が置き場を指していれば
   * 同じ置き場。`*(uint32 *)(sp - 372)` と `var_1C` が同じものだと分かる。
   */
  if (!m.index && m.base) {
    const d = stackDispOf(m.base, ctx);
    if (d != null) {
      const at = d + (m.disp != null ? m.disp : 0n);
      if (inFrame(at, ctx)) return slotName('sp', at, ctx);
    }
  }
  if (m.baseReg && m.disp != null && !m.index && ctx.fieldFor) {
    const named = ctx.fieldFor(m.baseReg, Number(m.disp), m.row);
    if (named && named.name) return varOf(m.baseReg, ctx) + '->' + named.name;
  }
  return null;
}

function callLabel(c, ctx) {
  const custom = ctx.notes && c.target != null ? ctx.notes.nameOf(c.target) : null;
  if (custom) return custom;
  if (c.sel) return '[' + (c.sel) + ']';
  if (c.name) return shortName(c.name);
  return c.target != null ? 'sub_' + c.target.toString(16).toUpperCase() : '(*func)';
}

/**
 * 制御フローの図。basic block を、行番号順の節点にならしたもの。
 * succ[i] は「次に来る可能性のある節点」。cond は分岐の条件。
 */
function buildFlow(model, ctx) {
  const blocks = model.basicBlocks || [];
  const nodes = blocks.map((b, i) => ({
    index: i, startRow: b.startRow, endRow: b.endRow, rows: b.rows,
    succ: [], condTarget: null, cond: null, fall: null,
    isLoopHeader: b.isLoopHeader, terminator: null,
  }));
  const nodeOfRow = (row) => {
    for (let i = 0; i < nodes.length; i++) if (row >= nodes[i].startRow && row <= nodes[i].endRow) return i;
    return -1;
  };

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const last = lastRealInstruction(n, ctx);
    n.terminator = last;
    const next = i + 1 < nodes.length ? i + 1 : null;
    if (!last) { n.fall = next; if (next != null) n.succ.push(next); continue; }
    const base = (last.mnemonic || '').toLowerCase();

    if (last.isReturn) continue;                      // 出口
    if (last.isTailCall) { n.tail = true; continue; } // 最後に別の関数へ跳んで終わる
    if (last.isCall) { n.fall = next; if (next != null) n.succ.push(next); continue; }

    if (last.isConditional || /^b\./.test(base) || /^(cbz|cbnz|tbz|tbnz)$/.test(base)) {
      const trow = last.branchTarget != null ? ctx.rowOfAddress(last.branchTarget) : null;
      const ti = trow != null ? nodeOfRow(trow) : -1;
      n.cond = conditionOf(last, ctx);
      n.condTarget = ti >= 0 ? ti : null;
      n.fall = next;
      if (ti >= 0) n.succ.push(ti);
      if (next != null) n.succ.push(next);
      continue;
    }
    if (base === 'b') {
      const trow = last.branchTarget != null ? ctx.rowOfAddress(last.branchTarget) : null;
      const ti = trow != null ? nodeOfRow(trow) : -1;
      if (ti >= 0) { n.succ.push(ti); n.jump = ti; }
      else n.tail = true;                              // 関数の外へ跳ぶ（末尾呼び出し）
      continue;
    }
    if (base === 'br') { n.tail = true; continue; }    // レジスタ経由の飛び先
    n.fall = next;
    if (next != null) n.succ.push(next);
  }

  const preds = nodes.map(() => []);
  for (const n of nodes) for (const s of n.succ) preds[s].push(n.index);
  nodes.forEach((n, i) => { n.pred = preds[i]; });

  const graph = analyzeGraph(nodes.map((n) => n.succ), nodes.length ? 0 : -1);
  const loopByHeader = new Map();
  for (const loop of graph.loops) {
    const sorted = Array.from(loop.nodes).sort((a, b) => a - b);
    const min = sorted.length ? sorted[0] : loop.header;
    const max = sorted.length ? sorted[sorted.length - 1] : loop.header;
    const contiguous = min === loop.header && sorted.length === max - min + 1 &&
      sorted.every((x, k) => x === min + k);
    const exits = Array.from(loop.exits);
    const singleNaturalExit = exits.length === 0 || (exits.length === 1 && exits[0] === max + 1);
    const tailIsLatch = loop.latches.has(max);
    loopByHeader.set(loop.header, Object.assign({}, loop, {
      min, max, contiguous,
      structurable: contiguous && singleNaturalExit && tailIsLatch,
      exit: exits.length === 1 ? exits[0] : null,
    }));
  }
  return { nodes, nodeOfRow, graph, reachable: graph.reachable,
    loopByHeader, ipdom: graph.immediatePostDominators };

}

/** ブロックの最後の「本物の」命令（nop や pac は飛ばす）。 */
function lastRealInstruction(node, ctx) {
  for (let r = node.endRow; r >= node.startRow; r--) {
    const insn = ctx.byRow.get(r);
    if (!insn || insn.data) continue;
    return insn;
  }
  return null;
}

/* ────────────────────────────────────────────────────────────
   A. 制御フローの復元
   ──────────────────────────────────────────────────────────── */

function newEmitState() {
  return { labels: new Set(), gotos: 0, depth: 0, openLoops: new Set(), emitted: new Set(), recovered: 0 };
}

/**
 * [from, to] の節点を順に訳す。
 *
 * ここは「素直な形から順に当てはめる」方式です。
 *   1. 後ろへ戻る辺があれば   → ループ（while / do-while）
 *   2. 前へ飛ぶ条件分岐なら    → if （合流点があれば if/else）
 *   3. どれにも当てはまらない  → goto とラベル（正直に残す）
 *
 * clang が吐く普通のコードはほぼ 1 と 2 で片づきます。
 */
function emitRange(cfg, from, to, indent, out, ctx, state, loop) {
  let i = from;
  let guard = 0;
  if (state.depth > 60) {                    // 入れ子が深すぎる = 素直な形ではない
    out.push(line('comment', indent, '// ここから先は入れ子が深すぎるため、アセンブリを直接ご覧ください', null));
    state.gotos++;
    return -1;
  }
  state.depth++;
  try {
  while (i >= 0 && i <= to && guard++ < 20000) {
    const n = cfg.nodes[i];
    if (state.emitted.has(i)) return -1;

    /* ループ: natural loop と証明できるものだけ構造化する。 */
    const back = state.openLoops.has(i) ? -1 : backEdgeInto(cfg, i, to);
    if (back >= i) {
      i = emitLoop(cfg, i, back, to, indent, out, ctx, state);
      continue;
    }

    /* 条件分岐。構造化できなければ、taken/fall の両方を明示して絶対に捨てない。 */
    if (n.cond && n.condTarget != null) {
      const nextI = emitIf(cfg, i, to, indent, out, ctx, state, loop);
      if (nextI != null) { i = nextI; continue; }
      emitBlockBody(n, indent, out, ctx, state, { skipTerminator: true });
      const targetLabel = labelOf(cfg.nodes[n.condTarget], ctx);
      if (loop && n.condTarget === loop.header) {
        out.push(line('ctrl', indent, 'if (' + condText(n.cond, ctx) + ') continue;', n.endRow, addrOf(ctx, n.endRow)));
      } else if (loop && loop.exit != null && n.condTarget === loop.exit) {
        out.push(line('ctrl', indent, 'if (' + condText(n.cond, ctx) + ') break;', n.endRow, addrOf(ctx, n.endRow)));
      } else {
        out.push(line('ctrl', indent, 'if (' + condText(n.cond, ctx) + ') goto ' + targetLabel + ';', n.endRow, addrOf(ctx, n.endRow)));
        state.labels.add(targetLabel); state.gotos++;
      }
      if (n.fall == null) return -1;
      i = n.fall;
      continue;
    }

    /* ふつうの並び */
    emitBlockBody(n, indent, out, ctx, state);

    if (n.jump != null) {
      const target = n.jump;
      if (loop && target === loop.header) { out.push(line('ctrl', indent, 'continue;', n.endRow)); return -1; }
      if (loop && loop.exit != null && target === loop.exit) { out.push(line('ctrl', indent, 'break;', n.endRow)); return -1; }
      if (target === i + 1) { i = i + 1; continue; }
      const label = labelOf(cfg.nodes[target], ctx);
      out.push(line('ctrl', indent, 'goto ' + label + ';', n.endRow, addrOf(ctx, n.endRow)));
      state.labels.add(label); state.gotos++;
      // A non-fallthrough jump ends this linear path. Other reachable blocks are
      // emitted by their owning branch or by the final coverage recovery pass.
      return -1;
    }
    if (n.tail || !n.succ.length) return -1;             // ret / 末尾呼び出し
    i = n.fall != null ? n.fall : i + 1;
  }
  return i;
  } finally { state.depth--; }
}

/** natural loop と証明でき、今の範囲で安全に構造化できる場合だけ返す。 */
function backEdgeInto(cfg, i, to) {
  const loop = cfg.loopByHeader && cfg.loopByHeader.get(i);
  if (!loop || !loop.structurable || loop.max > to) return -1;
  return loop.max;
}

/** natural loop を訳す。証明できない後方ジャンプはここへ来ない。 */
function emitLoop(cfg, header, last, to, indent, out, ctx, state) {
  const info = cfg.loopByHeader.get(header);
  if (!info || !info.structurable) return header;
  const node = cfg.nodes[header];
  const exit = info.exit != null ? info.exit : (last + 1 <= to ? last + 1 : null);
  const loop = { header, exit, last, members: info.nodes };
  state.openLoops.add(header);
  try {
    const headCond = node.cond && node.condTarget != null && !info.nodes.has(node.condTarget);
    if (headCond) {
      const cond = negate(node.cond);
      emitBlockBody(node, indent, out, ctx, state, { skipTerminator: true });
      out.push(line('ctrl', indent, 'while (' + condText(cond, ctx) + ')  {', node.endRow, addrOf(ctx, node.endRow)));
      if (ctx.beginner) out[out.length - 1].note = condNote(cond) + 'あいだ、下を繰り返します。';
      if (last >= header + 1) emitRange(cfg, header + 1, last, indent + 1, out, ctx, state, loop);
      out.push(line('ctrl', indent, '}', cfg.nodes[last].endRow));
      return exit == null ? -1 : exit;
    }

    const tail = cfg.nodes[last];
    const tailCond = tail.cond && tail.condTarget === header ? tail.cond : null;
    if (tailCond) {
      out.push(line('ctrl', indent, 'do  {', node.startRow, addrOf(ctx, node.startRow)));
      if (ctx.beginner) out[out.length - 1].note = '同じ処理を、条件が続くあいだ繰り返します。';
      emitBlockBody(node, indent + 1, out, ctx, state, { skipTerminator: true });
      if (last > header + 1) emitRange(cfg, header + 1, last - 1, indent + 1, out, ctx, state, loop);
      if (last !== header) emitBlockBody(tail, indent + 1, out, ctx, state, { skipTerminator: true });
      out.push(line('ctrl', indent, '} while (' + condText(tailCond, ctx) + ');', tail.endRow, addrOf(ctx, tail.endRow)));
      return exit == null ? -1 : exit;
    }

    // Unconditional latch: a real infinite loop. Never invent an unreadable condition.
    if (tail.jump === header) {
      out.push(line('ctrl', indent, 'while (1)  {', node.startRow, addrOf(ctx, node.startRow)));
      emitRange(cfg, header, last, indent + 1, out, ctx, state, loop);
      out.push(line('ctrl', indent, '}', tail.endRow));
      return exit == null ? -1 : exit;
    }
    return header;
  } finally {
    state.openLoops.delete(header);
  }
}

/**
 * if を訳す。戻り値は次に処理する節点。当てはまらなければ null。
 *
 * よくある形:
 *      b.ne  loc_X       ← 条件が成り立たなければ飛ぶ
 *      …then…            ← 飛ばなかったときの中身
 *      b     loc_Y
 *   loc_X:
 *      …else…
 *   loc_Y:
 */
function branchRegion(cfg, start, merge, to) {
  if (start === merge) return new Set();
  const seen = new Set(), stack = [start];
  while (stack.length) {
    const x = stack.pop();
    if (x === merge || seen.has(x)) continue;
    if (!(x >= 0 && x <= to) || !cfg.reachable.has(x)) return null;
    seen.add(x);
    for (const y of cfg.nodes[x].succ) if (y !== merge) stack.push(y);
  }
  return seen;
}

function contiguousRange(set) {
  if (!set || !set.size) return null;
  const xs = Array.from(set).sort((a, b) => a - b);
  for (let k = 1; k < xs.length; k++) if (xs[k] !== xs[k - 1] + 1) return null;
  return { from: xs[0], to: xs[xs.length - 1] };
}

function disjoint(a, b) {
  for (const x of a || []) if (b && b.has(x)) return false;
  return true;
}

function emitIf(cfg, i, to, indent, out, ctx, state, loop) {
  const n = cfg.nodes[i];
  const taken = n.condTarget, fall = n.fall;
  if (taken == null || fall == null || taken <= i) return null;
  const merge = cfg.ipdom && cfg.ipdom[i] != null ? cfg.ipdom[i] : null;
  if (merge == null || merge <= i || merge > to) return null;

  const takenSet = branchRegion(cfg, taken, merge, to);
  const fallSet = branchRegion(cfg, fall, merge, to);
  if (!takenSet || !fallSet || !disjoint(takenSet, fallSet)) return null;
  const tr = contiguousRange(takenSet), fr = contiguousRange(fallSet);
  if (takenSet.size && !tr) return null;
  if (fallSet.size && !fr) return null;
  if ([...takenSet, ...fallSet].some((x) => state.emitted.has(x))) return null;

  emitBlockBody(n, indent, out, ctx, state, { skipTerminator: true });
  if (!takenSet.size && !fallSet.size) return merge;

  if (!takenSet.size) {
    const cond = negate(n.cond);
    out.push(line('ctrl', indent, 'if (' + condText(cond, ctx) + ')  {', n.endRow, addrOf(ctx, n.endRow)));
    emitRange(cfg, fr.from, fr.to, indent + 1, out, ctx, state, loop);
    out.push(line('ctrl', indent, '}', null));
    return merge;
  }
  if (!fallSet.size) {
    out.push(line('ctrl', indent, 'if (' + condText(n.cond, ctx) + ')  {', n.endRow, addrOf(ctx, n.endRow)));
    emitRange(cfg, tr.from, tr.to, indent + 1, out, ctx, state, loop);
    out.push(line('ctrl', indent, '}', null));
    return merge;
  }

  const cond = negate(n.cond); // fall-through path is the source-level "then" arm
  out.push(line('ctrl', indent, 'if (' + condText(cond, ctx) + ')  {', n.endRow, addrOf(ctx, n.endRow)));
  emitRange(cfg, fr.from, fr.to, indent + 1, out, ctx, state, loop);
  out.push(line('ctrl', indent, '} else {', cfg.nodes[taken].startRow));
  emitRange(cfg, tr.from, tr.to, indent + 1, out, ctx, state, loop);
  out.push(line('ctrl', indent, '}', null));
  return merge;
}

/**
 * Exact fallback for optimized/irreducible/disconnected layouts.
 * Blocks are emitted once in physical address order.  Internal control-flow is
 * represented with explicit gotos, so this mode never has to guess a source
 * language structure and never moves a hidden cleanup block somewhere else.
 */
function emitLinearCfg(cfg, out, ctx, state) {
  for (let i = 0; i < cfg.nodes.length; i++) {
    const n = cfg.nodes[i];
    emitBlockBody(n, 1, out, ctx, state, { skipTerminator: true });

    if (n.cond && n.condTarget != null) {
      // If both outcomes are literally the next block, the branch has no
      // observable control-flow effect and can be omitted from pseudocode.
      if (n.condTarget === n.fall) continue;
      const t = labelOf(cfg.nodes[n.condTarget], ctx);
      state.labels.add(t);
      out.push(line('ctrl', 1, 'if (' + condText(n.cond, ctx) + ') goto ' + t + ';',
        n.endRow, addrOf(ctx, n.endRow)));
      state.gotos++;
      if (n.fall != null && n.fall !== i + 1) {
        const f = labelOf(cfg.nodes[n.fall], ctx);
        state.labels.add(f);
        out.push(line('ctrl', 1, 'goto ' + f + ';', n.endRow));
        state.gotos++;
      }
      continue;
    }

    if (n.jump != null && n.jump !== i + 1) {
      const t = labelOf(cfg.nodes[n.jump], ctx);
      state.labels.add(t);
      out.push(line('ctrl', 1, 'goto ' + t + ';', n.endRow, addrOf(ctx, n.endRow)));
      state.gotos++;
    }
    // Unknown-target `br`/conditional branches are deliberately left in the
    // block as __asm by emitBlockBody; pretending to know their target is worse.
  }
}

/** Final correctness net: every Basic Block in the function must appear at least once. */
function recoverUnemittedBlocks(cfg, out, ctx, state) {
  const all = cfg.nodes.map((_, i) => i);
  const before = all.filter((i) => !state.emitted.has(i));
  for (const i of before) {
    if (state.emitted.has(i)) continue;
    const n = cfg.nodes[i];
    const own = labelOf(n, ctx);
    state.labels.add(own);
    emitBlockBody(n, 1, out, ctx, state, { skipTerminator: true });
    state.recovered++;
    if (n.cond && n.condTarget != null) {
      const t = labelOf(cfg.nodes[n.condTarget], ctx);
      state.labels.add(t);
      out.push(line('ctrl', 1, 'if (' + condText(n.cond, ctx) + ') goto ' + t + ';', n.endRow, addrOf(ctx, n.endRow)));
      state.gotos++;
      if (n.fall != null) {
        const f = labelOf(cfg.nodes[n.fall], ctx);
        state.labels.add(f);
        out.push(line('ctrl', 1, 'goto ' + f + ';', n.endRow)); state.gotos++;
      }
    } else if (n.jump != null) {
      const t = labelOf(cfg.nodes[n.jump], ctx);
      state.labels.add(t);
      out.push(line('ctrl', 1, 'goto ' + t + ';', n.endRow, addrOf(ctx, n.endRow))); state.gotos++;
    } else if (n.fall != null && n.succ.length) {
      const f = labelOf(cfg.nodes[n.fall], ctx);
      state.labels.add(f);
      out.push(line('ctrl', 1, 'goto ' + f + ';', n.endRow)); state.gotos++;
    }
  }
  const missing = all.filter((i) => !state.emitted.has(i)).length;
  const reachableMissing = Array.from(cfg.reachable).filter((i) => !state.emitted.has(i)).length;
  return { total: cfg.nodes.length, reachable: cfg.reachable.size, emitted: state.emitted.size,
    recovered: state.recovered, missing, reachableMissing };
}

function labelOf(node, ctx) {
  const a = addrOf(ctx, node.startRow);
  return 'loc_' + (a != null ? a.toString(16).toUpperCase() : node.startRow);
}

function addrOf(ctx, row) {
  const insn = ctx.byRow.get(row);
  return insn ? insn.address : ctx.addrOfRow(row);
}

/* ── 条件 ───────────────────────────────────────────────── */

/**
 * 分岐命令から条件を作る。
 * cmp / subs で作られたフラグは、直前をさかのぼって左右の値を拾う。
 */
function conditionOf(insn, ctx) {
  const base = (insn.mnemonic || '').toLowerCase();
  if (base === 'cbz' || base === 'cbnz') {
    const r = insn.ops[0];
    return { kind: 'zero', reg: r ? varOf(regOf(r), ctx) : '?', neg: base === 'cbnz' };
  }
  if (base === 'tbz' || base === 'tbnz') {
    const r = insn.ops[0];
    const bit = insn.ops[1] && insn.ops[1].value != null ? Number(insn.ops[1].value) : 0;
    return { kind: 'bit', reg: r ? varOf(regOf(r), ctx) : '?', bit, neg: base === 'tbnz' };
  }
  const m = /^b\.(\w+)$/.exec(base);
  if (m) {
    const cmp = findCompare(insn, ctx);
    return { kind: 'flag', cc: m[1], cmp };
  }
  return { kind: 'unknown', text: insn.mnemonic + ' ' + insn.operands };
}

/** フラグを作った直前の cmp / subs / tst を探す。 */
function findCompare(insn, ctx) {
  for (let r = insn.row - 1; r >= insn.row - 12; r--) {
    const p = ctx.byRow.get(r);
    if (!p) continue;
    const b = (p.mnemonic || '').toLowerCase();
    if (/^(cmp|cmn|tst|subs|adds|ands|fcmp|fcmpe|ccmp)$/.test(b)) {
      const a = p.ops[b === 'cmp' || b === 'cmn' || b === 'tst' || b === 'fcmp' ? 0 : 1];
      const c = p.ops[b === 'cmp' || b === 'cmn' || b === 'tst' || b === 'fcmp' ? 1 : 2];
      return { op: b, left: a ? operandText(a, ctx, p) : '?', right: c ? operandText(c, ctx, p) : '0', row: p.row };
    }
    if (p.isCall) break;         // 呼び出しをまたぐとフラグは壊れる
  }
  return null;
}

function negate(cond) {
  if (!cond) return cond;
  if (cond.kind === 'flag') return Object.assign({}, cond, { cc: COND_INVERSE[cond.cc] || cond.cc });
  if (cond.kind === 'zero' || cond.kind === 'bit') return Object.assign({}, cond, { neg: !cond.neg });
  return cond;
}

function condText(cond, ctx) {
  if (!cond) return '1';
  if (cond.kind === 'zero') return cond.reg + (cond.neg ? ' != 0' : ' == 0');
  if (cond.kind === 'bit') return '(' + cond.reg + ' & (1 << ' + cond.bit + '))' + (cond.neg ? ' != 0' : ' == 0');
  if (cond.kind === 'flag') {
    const op = COND_OPS[cond.cc] || cond.cc;
    if (!cond.cmp) return 'flag_' + cond.cc;
    if (cond.cmp.op === 'tst' || cond.cmp.op === 'ands') {
      return '(' + cond.cmp.left + ' & ' + cond.cmp.right + ')' + (cond.cc === 'eq' ? ' == 0' : ' != 0');
    }
    if (/^(< 0|>= 0)$/.test(op)) return cond.cmp.left + ' ' + op;
    return cond.cmp.left + ' ' + op + ' ' + cond.cmp.right;
  }
  void ctx;
  return '/* ' + (cond.text || '?') + ' */ 1';
}

function condNote(cond) {
  if (!cond) return '条件が成り立つ';
  if (cond.kind === 'zero') return cond.reg + ' が 0 ' + (cond.neg ? 'でない' : 'の');
  if (cond.kind === 'bit') return cond.reg + ' の ' + cond.bit + ' ビット目が ' + (cond.neg ? '立っている' : '寝ている');
  if (cond.kind === 'flag') {
    const ja = COND_JA[cond.cc] || cond.cc;
    if (cond.cmp) return cond.cmp.left + ' が ' + cond.cmp.right + ' より ' + ja;
    return ja;
  }
  return '条件が成り立つ';
}

/* ────────────────────────────────────────────────────────────
   B. 式の復元
   ──────────────────────────────────────────────────────────── */

function regOf(op) {
  if (!op || op.k !== 'reg') return null;
  if (op.cls === 'zr') return 'zr';
  if (op.cls === 'sp') return 'sp';
  if (op.cls === 'gp') return 'x' + op.num;
  if (op.cls === 'fp' || op.cls === 'vec') return 'v' + op.num;
  return null;
}

/** レジスタの変数名。引数は a1, a2 … に、それ以外はレジスタ名のまま。 */
function varOf(reg, ctx) {
  if (!reg) return '?';
  if (reg === 'zr') return '0';
  if (reg === 'sp') return 'sp';
  const custom = ctx.notes && ctx.funcAddr != null ? ctx.notes.varName(ctx.funcAddr, reg) : null;
  if (custom) return custom;
  if (ctx.carry && reg === ctx.carry.reg) { ctx.usedVars.add('result'); return 'result'; }
  const alias = ctx.aliases ? ctx.aliases.get(reg) : null;
  if (alias) return alias;
  ctx.usedVars.add(reg);
  return reg;
}

function hexImm(v) {
  if (v == null) return '0';
  const neg = v < 0n;
  const a = neg ? -v : v;
  if (a < 10n) return (neg ? '-' : '') + a.toString();
  return (neg ? '-' : '') + '0x' + a.toString(16).toUpperCase();
}

/** オペランド 1 つを C の式にする。 */
function operandText(op, ctx, insn) {
  if (!op) return '?';
  if (op.k === 'reg') {
    const base = varOf(regOf(op), ctx);
    return op.bits === 32 && op.cls === 'gp' ? '(int32)' + base : base;
  }
  if (op.k === 'imm') {
    if (op.value == null && op.float != null) return String(op.float);
    let s = hexImm(op.value);
    if (op.shift && op.shift.amount) s = '(' + s + ' << ' + op.shift.amount + ')';
    return s;
  }
  if (op.k === 'mem') return memText(op, ctx, insn);
  if (op.k === 'cond') return op.text;
  return op.text || '?';
}

/** [x0, #0x20] を *(型 *)(x0 + 0x20) に。名前が分かっていれば x0->hp に。 */
function memText(op, ctx, insn) {
  const base = regOf(op.base);
  const disp = op.disp && op.disp.value != null ? op.disp.value : 0n;
  const size = insn && insn.memory ? (insn.memory.size || 8) : 8;
  const float = insn && insn.ops[0] && insn.ops[0].k === 'reg' && (insn.ops[0].cls === 'fp' || insn.ops[0].cls === 'vec');

  if (base === 'sp' || base === 'x29') return slotName(base, disp, ctx);

  /* 行き先が 1 つに決まっているなら、レジスタ経由ではなくその場所を書く */
  const ref = insn ? ctx.refOf.get(insn.row) : null;
  if (ref && ref.load && !op.index) {
    const sym = ctx.symbolFor(ref.addr);
    if (sym) return sym;
    return '*(' + typeFromAccess(size, { float }) + ' *)0x' + ref.addr.toString(16).toUpperCase();
  }

  const named = ctx.fieldFor ? ctx.fieldFor(base, Number(disp), insn ? insn.row : null) : null;
  if (named && named.name) return varOf(base, ctx) + '->' + named.name;

  const type = typeFromAccess(size, { float });
  const inner = op.index
    ? varOf(base, ctx) + ' + ' + varOf(regOf(op.index), ctx) + (op.shift && op.shift.amount ? ' * ' + (1 << op.shift.amount) : '')
    : (disp ? varOf(base, ctx) + ' + ' + hexImm(disp) : varOf(base, ctx));
  return '*(' + type + ' *)(' + inner + ')';
}

/*
 * この関数のスタックの形を読む。
 *
 *   sub sp, sp, #0x190      ← 置き場のぶんだけ sp を下げる（adjust = 0x190）
 *   add x29, sp, #0x180     ← フレームポインタは、そこから 0x180 上（fpOffset = 0x180）
 *
 * これが分かると、同じ 1 つの置き場を指す 3 通りの書き方を 1 つに揃えられる。
 *
 *   [sp, #0x1c]        ← 命令のオペランド（下げたあとの sp から）
 *   [x29, #-0x60]      ← フレームポインタから
 *   sp - 372           ← 値グラフの式（sp は関数に入った時点のもの）
 *
 * 揃えないと、同じ置き場に var_1C と var_60 と `sp - 372` の 3 つの名前が付く。
 * 実際そうなっていて、逆コンパイル結果の中で同じ変数が別物に見えていた。
 * sp を定数で動かしていない関数（可変長スタック）では null を返し、
 * これまでどおりの書き方に任せる（分からないものを揃えたことにはしない）。
 */
function frameOf(model) {
  let depth = 0n;          // いま sp がどれだけ下がっているか
  let adjust = 0n;         // 本体で使う深さ（＝いちばん深いところ）
  let fpOffset = null;
  const insns = model.instructions || [];
  for (const insn of insns) {
    const base = (insn.mnemonic || '').toLowerCase();
    const ops = insn.ops || [];
    const dst = ops[0];
    /* sub sp, sp, #N */
    if ((base === 'sub' || base === 'add') && dst && dst.k === 'reg' && dst.cls === 'sp') {
      const src = ops[1], imm = ops[2];
      if (!src || src.k !== 'reg' || src.cls !== 'sp') return null;
      if (!imm || imm.k !== 'imm' || imm.value == null) return null;   // sub sp, sp, x8
      /*
       * 出口の `add sp, sp, #0x190` まで足し引きすると 0 に戻ってしまう。
       * 欲しいのは本体を実行しているあいだの深さなので、いちばん深いところを取る。
       */
      depth += base === 'sub' ? imm.value : -imm.value;
      if (depth > adjust) adjust = depth;
      continue;
    }
    /* stp x29, x30, [sp, #-0x10]! — 前置きで sp も下がる */
    const m = insn.memory;
    if (m && m.mode === 'pre' && m.baseReg === 'sp' && m.disp != null) {
      depth -= m.disp;
      if (depth > adjust) adjust = depth;
    }
    /* add x29, sp, #K / mov x29, sp */
    if (dst && dst.k === 'reg' && dst.cls === 'gp' && dst.num === 29 && fpOffset == null) {
      const src = ops[1];
      if (base === 'mov' && src && src.k === 'reg' && src.cls === 'sp') fpOffset = 0n;
      else if (base === 'add' && src && src.k === 'reg' && src.cls === 'sp' &&
               ops[2] && ops[2].k === 'imm' && ops[2].value != null) fpOffset = ops[2].value;
    }
  }
  if (adjust <= 0n) return null;
  return { adjust, fpOffset };
}

/**
 * スタック上の場所につける名前。var_20 のように、IDA と同じ書き方にする。
 *
 * 呼び名は「下げたあとの sp から何バイト上か」で 1 つに決める。
 * どの書き方で来ても、ここを通れば同じ置き場は同じ名前になる。
 */
function slotName(base, disp, ctx) {
  let d = disp;
  let b = base;
  const f = ctx.frame;
  if (f && b === 'x29' && f.fpOffset != null) { d = disp + f.fpOffset; b = 'sp'; }
  const key = b + ':' + d.toString();
  if (ctx.stackNames.has(key)) return ctx.stackNames.get(key);
  const custom = ctx.notes && ctx.funcAddr != null ? ctx.notes.varName(ctx.funcAddr, base + disp) : null;
  const abs = d < 0n ? -d : d;
  const n = custom || ('var_' + abs.toString(16).toUpperCase());
  ctx.stackNames.set(key, n);
  return n;
}

/**
 * 値グラフの式が「スタックの置き場の番地」なら、その置き場のずれを返す。
 *
 * 値グラフの sp は **関数に入った時点** の sp なので、
 * `sp - 372` は「下げたあとの sp + 28」、つまり `[sp, #0x1c]` と同じ場所を指す。
 */
function stackDispOf(n, ctx) {
  const f = ctx.frame;
  if (!f || !n) return null;
  /* 返すのは「下げたあとの sp から何バイト上か」。
     値グラフの sp は入った時点のものなので adjust、x29 はそこから fpOffset。 */
  const fromReg = (r) => (r === 'sp' ? f.adjust : (r === 'x29' && f.fpOffset != null ? f.fpOffset : null));
  if (n.k === 'reg') {
    /*
     * 関数の入口の sp だけを「入った時点の sp」と読む。
     * 途中で作り直された reg('sp') は、いまの sp かもしれないし、
     * 例外の後始末のように別の流れから来たものかもしれない。
     * 決められないものに名前を付けると、別の置き場を同じ名前で呼ぶことになる。
     */
    if (n.reg === 'sp' && n.row !== ctx.firstRow) return null;
    const at = fromReg(n.reg);
    return at == null ? null : at;
  }
  if (n.k === 'bin' && (n.op === 'add' || n.op === 'sub')) {
    const c = exprConst(n.b);
    if (c == null) return null;
    const inner = stackDispOf(n.a, ctx);
    if (inner == null) return null;
    return n.op === 'add' ? inner + c : inner - c;
  }
  return null;
}

/** 置き場の中に入っているずれかどうか。外れていれば名前を付けない。 */
function inFrame(d, ctx) {
  return ctx.frame && d != null && d >= 0n && d < ctx.frame.adjust;
}

/**
 * 置き場の呼び名だけを付ける小道具。
 *
 * 逆コンパイル画面の外 —— レポートの「この関数が組み立てている計算」など ——
 * でも、同じ置き場が同じ名前で出るようにする。ここを分けていたころ、
 * 逆コンパイル画面では `&var_88`、レポートでは `sp - 264` と出ていて、
 * 2 つの画面を並べた人が同じものだと気づけなかった。
 *
 * @returns render() にそのまま混ぜられる {memName, nameOf}（読めなければ空）
 */
export function stackNaming(model) {
  const insns = (model && model.instructions) || [];
  const ctx = {
    frame: frameOf(model || {}),
    stackNames: new Map(),
    notes: null,
    funcAddr: null,
    firstRow: insns.length ? insns[0].row : 0,
  };
  if (!ctx.frame) return {};
  return {
    memName: (m) => {
      if (!m || m.index) return null;
      if (m.stack && m.disp != null) return slotName(m.baseReg === 'x29' ? 'x29' : 'sp', m.disp, ctx);
      const d = m.base ? stackDispOf(m.base, ctx) : null;
      if (d == null) return null;
      const at = d + (m.disp != null ? m.disp : 0n);
      return inFrame(at, ctx) ? slotName('sp', at, ctx) : null;
    },
    nameOf: (n) => {
      if (!n || (n.k !== 'bin' && n.k !== 'reg')) return null;
      const d = stackDispOf(n, ctx);
      return inFrame(d, ctx) ? '&' + slotName('sp', d, ctx) : null;
    },
  };
}

/* ── 1 ブロックぶんの文 ─────────────────────────────────── */

const SKIP_MN = /^(nop|hint|bti|paciasp|pacibsp|autiasp|autibsp|xpaclri|dmb|dsb|isb|prfm|pacibz|pacia|autia)$/;

function emitBlockBody(node, indent, out, ctx, state, opts) {
  if (state && state.emitted) state.emitted.add(node.index);
  void opts;
  const stmts = [];
  for (const row of node.rows) {
    const insn = ctx.byRow.get(row);
    if (!insn) continue;
    /* 分岐そのものは if / while / goto として書くので、ここでは出さない */
    if (insn === node.terminator && insn.isBranch && !insn.isCall && !insn.isReturn &&
        (node.jump != null || node.condTarget != null)) continue;
    const st = statementFor(insn, ctx, node);
    if (st) stmts.push(st);
  }

  /* 使い捨ての一時変数をたたむ（x8 = a + b; f(x8) → f(a + b)） */
  inlineTemporaries(stmts, ctx);
  removeDeadStores(stmts);

  /* ラベル。goto で使われたときだけ、あとから残る */
  out.push(line('label', Math.max(0, indent - 1), labelOf(node, ctx) + ':', node.startRow, addrOf(ctx, node.startRow)));

  for (const st of stmts) {
    if (st.dropped) continue;
    const l = line(st.kind || 'stmt', indent, st.text, st.row, st.addr);
    l.note = st.note || null;
    out.push(l);
  }
}

/**
 * 命令 1 つを文にする。
 * @returns {{text, row, addr, dst, reads, note, kind, pure}|null}
 */
function statementFor(insn, ctx, node) {
  const base = (insn.mnemonic || '').toLowerCase();
  const row = insn.row, addr = insn.address;
  const mk = (text, extra) => Object.assign({ text, row, addr, dst: null, reads: insn.reads.slice(), pure: false }, extra || {});

  if (insn.data) return mk('__data(' + insn.operands + ');', { kind: 'comment', note: '命令ではなくデータです。' });
  if (SKIP_MN.test(base)) return null;                     // 意味を持たない命令は出さない

  /*
   * 値グラフから作った文。ここが当たれば、命令の形ではなく **計算** が出る。
   *
   *   mov w9, #0x851f ; movk w9, #0x51eb, lsl #16
   *   smull x8, w8, w9 ; lsr x9, x8, #0x3f ; asr x8, x8, #0x25 ; add w8, w8, w9
   *       ↓
   *   x8 = x8 / 100;          （ほかの 5 行は、誰も使わない中間値なので消える）
   */
  const fromValues = valueStatement(insn, ctx, mk);
  if (fromValues !== undefined) return fromValues;
  if (base === 'ret' || base === 'retab' || base === 'retaa') {
    const ret = ctx.types && ctx.types.ret && ctx.types.ret.type !== 'void';
    return mk(ret ? 'return ' + varOf('x0', ctx) + ';' : 'return;', { kind: 'ctrl' });
  }

  /* 呼び出し */
  if (insn.isCall || insn.tailCall) return callStatement(insn, ctx, mk);

  /* スタックへの退避・復帰は「後片付け」なので隠す（読みやすさ優先） */
  if (isFrameHousekeeping(insn, ctx)) return null;

  /* メモリ */
  if (insn.memory) return memoryStatement(insn, ctx, mk, base);

  /* アドレス計算 (adrp / adr / adrp+add)。行き先が決まっていれば名前で書く */
  const ref = ctx.refOf.get(row);
  if (base === 'adrp' || base === 'adr' ||
      (base === 'add' && ref && !ref.load && insn.ops.length >= 3 && insn.ops[2] && insn.ops[2].k === 'imm')) {
    const dst = insn.writes[0];
    const text = ctx.textOf.get(row);
    if (text != null) return mk(varOf(dst, ctx) + ' = "' + escapeText(text) + '";', { dst, pure: true });
    const t = ref ? ref.addr : insn.pcRelTarget;
    if (base === 'adrp' && !ref) {
      /* ページの先頭だけを作る途中。次の add / ldr と組で 1 つのアドレスになる */
      return mk(varOf(dst, ctx) + ' = 0x' + (t != null ? t.toString(16).toUpperCase() : '?') + ';',
        { dst, pure: true, note: 'アドレスの上半分を作っています（次の行と組で 1 つの場所になります）。' });
    }
    const sym = t != null ? ctx.symbolFor(t) : null;
    return mk(varOf(dst, ctx) + ' = ' + (sym ? '&' + sym : '0x' + (t != null ? t.toString(16).toUpperCase() : '?')) + ';',
      // 場所が 1 つに決まったので、もう手前のレジスタには依存していない
      { dst, pure: true, reads: [] });
  }

  const dst = insn.writes.length === 1 ? insn.writes[0] : null;

  /* mov / movz / movk */
  if (base === 'mov' || base === 'fmov' || base === 'movz') {
    const src = insn.ops[1];
    const text = ctx.textOf.get(row);
    if (text != null) return mk(varOf(dst, ctx) + ' = "' + escapeText(text) + '";', { dst, pure: true });
    return mk(varOf(dst, ctx) + ' = ' + operandText(src, ctx, insn) + ';', { dst, pure: true });
  }
  if (base === 'movn') {
    return mk(varOf(dst, ctx) + ' = ~' + operandText(insn.ops[1], ctx, insn) + ';', { dst, pure: true });
  }
  if (base === 'movk') {
    const imm = insn.ops[1];
    const sh = imm && imm.shift && imm.shift.amount ? imm.shift.amount : 0;
    return mk(varOf(dst, ctx) + ' |= ' + hexImm(imm && imm.value != null ? imm.value : 0n) + (sh ? ' << ' + sh : '') + ';',
      { dst, pure: true, note: '大きな定数を 16 ビットずつ組み立てています。' });
  }

  /* 比較。単体では文にしないが、条件の材料として残す */
  if (/^(cmp|cmn|tst|fcmp|fcmpe|ccmp|ccmn)$/.test(base)) {
    return mk('/* ' + insn.mnemonic + ' ' + insn.operands + ' — 次の分岐のための比較 */',
      { kind: 'comment', pure: true, compare: true });
  }

  /* 条件つき代入 */
  const csel = /^(csel|csinc|csinv|csneg|cset|csetm|cinc|cinv|cneg)$/.exec(base);
  if (csel) return conditionalSelect(insn, ctx, mk, base, dst);

  /* 二項演算 */
  const BIN = {
    add: '+', adds: '+', sub: '-', subs: '-', mul: '*', udiv: '/', sdiv: '/',
    and: '&', ands: '&', orr: '|', eor: '^', bic: '& ~', lsl: '<<', lsr: '>>', asr: '>>',
    ror: '>>>', fadd: '+', fsub: '-', fmul: '*', fdiv: '/', smull: '*', umull: '*',
  };
  if (BIN[base] && insn.ops.length >= 3 && dst) {
    const a = operandText(insn.ops[1], ctx, insn);
    const b = operandText(insn.ops[2], ctx, insn);
    const shift = insn.ops[2] && insn.ops[2].shift && insn.ops[2].shift.amount
      ? ' ' + shiftOp(insn.ops[2].shift.op) + ' ' + insn.ops[2].shift.amount : '';
    const expr = shift ? '(' + b + shift + ')' : b;
    return mk(varOf(dst, ctx) + ' = ' + a + ' ' + BIN[base] + ' ' + expr + ';', { dst, pure: true });
  }
  if ((base === 'neg' || base === 'negs' || base === 'fneg') && dst) {
    return mk(varOf(dst, ctx) + ' = -' + operandText(insn.ops[1], ctx, insn) + ';', { dst, pure: true });
  }
  if (base === 'mvn' && dst) {
    return mk(varOf(dst, ctx) + ' = ~' + operandText(insn.ops[1], ctx, insn) + ';', { dst, pure: true });
  }
  if ((base === 'madd' || base === 'msub') && dst && insn.ops.length >= 4) {
    const sign = base === 'madd' ? '+' : '-';
    return mk(varOf(dst, ctx) + ' = ' + operandText(insn.ops[3], ctx, insn) + ' ' + sign + ' ' +
      operandText(insn.ops[1], ctx, insn) + ' * ' + operandText(insn.ops[2], ctx, insn) + ';', { dst, pure: true });
  }
  /* 型変換 */
  const cast = /^(sxtb|sxth|sxtw|uxtb|uxth|uxtw|scvtf|ucvtf|fcvtzs|fcvtzu|fcvt)$/.exec(base);
  if (cast && dst) {
    const to = {
      sxtb: 'int8', sxth: 'int16', sxtw: 'int32', uxtb: 'uint8', uxth: 'uint16', uxtw: 'uint32',
      scvtf: 'double', ucvtf: 'double', fcvtzs: 'int64', fcvtzu: 'uint64', fcvt: 'double',
    }[base];
    return mk(varOf(dst, ctx) + ' = (' + to + ')' + operandText(insn.ops[1], ctx, insn) + ';',
      { dst, pure: true });
  }
  if (base === 'bfi' || base === 'bfxil' || base === 'ubfx' || base === 'sbfx' || base === 'ubfiz') {
    return mk(varOf(dst, ctx) + ' = ' + base + '(' + insn.operands + ');',
      { dst, pure: true, note: 'ビットの一部を取り出す / 差し込む処理です。' });
  }
  if (base === 'brk' || base === 'udf') {
    return mk('__builtin_trap();   // ここに来たら異常', { kind: 'ctrl', note: '通らないはずの場所です。来たら止まります。' });
  }
  if (base === 'svc') {
    return mk('__syscall(' + insn.operands + ');', { note: 'OS を直接呼びます（システムコール）。' });
  }

  /* 訳せなかったもの。嘘を書かず、そのまま残す */
  ctx.unknown.add(base);
  void node;
  return mk('__asm("' + insn.mnemonic + ' ' + insn.operands + '");',
    { dst, note: 'この命令は逆コンパイルできませんでした。アセンブリのまま置いています。' });
}

function shiftOp(op) {
  return { lsl: '<<', lsr: '>>', asr: '>>', ror: '>>>' }[op] || '<<';
}

/*
 * 値グラフから 1 命令ぶんの文を作る。
 *
 * 戻り値:
 *   undefined … この命令はここでは扱えない（従来の道に任せる）
 *   null      … 行は出さない（中間の値なので、使う側に埋め込まれる）
 *   文        … その行
 */
function valueStatement(insn, ctx, mk) {
  const vg = ctx.values;
  if (!vg || !ctx.material) return undefined;
  const base = (insn.mnemonic || '').toLowerCase();

  /*
   * 読み込みだけは、ここで「行として残すか」を決める。
   *
   *   ldr x8, [x9] ; add x8, x8, #1 ; str x8, [x9]
   *
   * 3 行それぞれに名前を付けると読めないが、読み込みには副作用がないので、
   * 誰も変数として使わないなら、使う側の式に埋め込んでしまってよい。
   * 行として残すと決まったものは、これまでどおり memoryStatement が書く
   * （self->hp や var_20 という呼び名は、あちらのほうが上手い）。
   */
  if (insn.memory && insn.memory.kind === 'load' && insn.writes.length === 1) {
    const v = vg.defAt(insn.row, insn.writes[0]);
    if (v && v.k !== 'reg' && !ctx.material.material.has(v)) return null;
    return undefined;
  }

  /* 呼び出し・メモリ・分岐・比較は、これまでどおり専用の道で書く。 */
  if (insn.isCall || insn.memory || insn.isBranch || insn.isReturn) return undefined;
  if (/^(cmp|cmn|tst|fcmp|fcmpe|ccmp|ccmn)$/.test(base)) return undefined;
  if (isFrameHousekeeping(insn, ctx)) return undefined;
  if (insn.writes.length !== 1) return undefined;

  const dst = insn.writes[0];
  const value = vg.defAt(insn.row, dst);
  if (!value) return undefined;
  /* 出どころが読めなかった値は、命令のまま出したほうが正直。 */
  if (value.k === 'reg') return undefined;

  /*
   * 引数をレジスタへ写しているだけの行。
   *
   *   mov x19, x0 ; mov x20, x1 ; …        →  x19 = a1; x20 = a2; …
   *
   * 呼び出し元から渡された値の呼び名は、この関数のどこでも a1, a2 … になる。
   * 写しの行を残すと、同じものに a1 と x19 の 2 つの名前が付き、
   * 関数の頭に意味のない 8 行が並ぶ。値を見失うレジスタだけは残す
   * （合流の先で素の `x19` が出るなら、そこへ入れる行が要るため）。
   */
  if (value.k === 'arg' && (ctx.aliases.has(dst) || !ctx.material.lost.has(dst))) return null;

  if (!ctx.material.material.has(value)) {
    /*
     * 誰も変数として使っていない中間の値。行ごと落とす。
     * これが「5 行の割り算が 1 行になる」の中身。
     */
    return null;
  }
  /*
   * すでに別の行で名前を持っている値を、別のレジスタへ写しているだけ。
   *
   *   bl f ; mov x24, x0        →  x0 = f(); だけでよい
   *
   * 名前は値に付いているので、以後 x24 を使う式にも同じ名前が出る。
   * 写しの行を残すと、同じ値に 2 つの名前が付いて、必ず読み間違いのもとになる。
   */
  const can = ctx.material.canonical.get(value);
  if (can) {
    if (can.row !== insn.row || can.reg !== dst) return null;
  } else {
    const def = vg.nodeDef.get(value);
    if (def && def.row !== insn.row) return null;
  }
  const text = exprText(ctx, value, value);
  if (text == null) return undefined;
  const name = ctx.material.names.get(value);
  if (name) {
    ctx.usedVars.add(name);
    return mk(name + ' = ' + text + ';', { dst, pure: false, fromValues: true });
  }
  /*
   * pure を立てない。どの値を変数に残すかは、もう値グラフの側で決めてある。
   * そのうえで文字列としてもう一度たたむと、二重に消して辻褄が合わなくなる。
   */
  return mk(varOf(dst, ctx) + ' = ' + text + ';', { dst, pure: false, fromValues: true });
}

/**
 * 「後片付け」の命令かどうか。
 *
 * 関数の入口と出口には、x19〜x30 を守るための決まりきった出し入れが並びます。
 * 処理の中身とは関係がないので、逆コンパイル結果からは省きます
 * （アセンブリ側にはもちろん残っています）。
 */
function isFrameHousekeeping(insn, ctx) {
  const base = (insn.mnemonic || '').toLowerCase();
  const m = insn.memory;
  if (m && m.stack && /^(stp|ldp|str|ldr|stur|ldur)$/.test(base)) {
    const regs = insn.ops.filter((o) => o.k === 'reg');
    const calleeSaved = regs.length && regs.every((o) => o.cls === 'gp' && o.num >= 19 && o.num <= 30);
    // 入口と出口の近く、あるいは sp を動かす形（＝定型の出し入れ）だけを隠す。
    // 途中のふつうの退避は「値を覚えている」意味があるので残す。
    const atEdge = ctx && (insn.row <= ctx.firstRow + 8 || insn.row >= ctx.lastRow - 8);
    const frameish = m.mode === 'pre' || m.mode === 'post' ||
      regs.some((o) => o.cls === 'gp' && (o.num === 29 || o.num === 30));
    /* 入口で預けた場所から取り戻しているなら、それは後片付け（場所で確かめる）。 */
    const restoring = m.kind === 'load' && m.disp != null && ctx && ctx.savedSlots &&
      ctx.savedSlots.has((m.baseReg || 'sp') + ':' + m.disp.toString());
    if (calleeSaved && (atEdge || frameish || restoring)) return true;
  }
  // フレームポインタの設定 (add x29, sp, #N / mov x29, sp) と sp の増減
  if ((base === 'add' || base === 'sub' || base === 'mov') && insn.ops[0] && insn.ops[0].k === 'reg') {
    const d = insn.ops[0];
    const isFp = d.cls === 'gp' && d.num === 29;
    const isSp = d.cls === 'sp';
    if (isFp || isSp) return true;
  }
  return false;
}

function conditionalSelect(insn, ctx, mk, base, dst) {
  const ops = insn.ops;
  const cc = ops.length ? ops[ops.length - 1] : null;
  const cond = cc && cc.k === 'cond' ? { kind: 'flag', cc: cc.text, cmp: findCompare(insn, ctx) } : null;
  const c = cond ? condText(cond, ctx) : 'cond';
  if (base === 'cset' || base === 'csetm') {
    return mk(varOf(dst, ctx) + ' = (' + c + ') ? ' + (base === 'csetm' ? '-1' : '1') + ' : 0;',
      { dst, pure: true });
  }
  const a = ops[1] ? operandText(ops[1], ctx, insn) : '?';
  const b = ops[2] && ops[2].k !== 'cond' ? operandText(ops[2], ctx, insn) : a;
  const alt = base === 'csinc' ? b + ' + 1' : base === 'csinv' ? '~' + b : base === 'csneg' ? '-' + b : b;
  return mk(varOf(dst, ctx) + ' = (' + c + ') ? ' + a + ' : ' + alt + ';',
    { dst, pure: true });
}

function memoryStatement(insn, ctx, mk, base) {
  const m = insn.memory;
  const mem = insn.ops.find((x) => x.k === 'mem');
  const place = mem ? memText(mem, ctx, insn) : '*(?)';
  const pair = base === 'ldp' || base === 'stp' || base === 'ldnp' || base === 'stnp';

  /* 排他アクセス（スレッドどうしがぶつからないようにする読み書き） */
  if (/^(ldxr|ldaxr|ldxrb|ldaxrb|ldxrh|ldaxrh)/.test(base)) {
    const d = insn.ops[0] ? varOf(regOf(insn.ops[0]), ctx) : '?';
    return mk(d + ' = __atomic_load(' + addressExpr(place) + ');',
      { dst: insn.writes[0], note: '他のスレッドと取り合わないように読み出しています。' });
  }
  if (/^(stxr|stlxr|stxrb|stlxrb|stxrh|stlxrh)/.test(base)) {
    const status = insn.ops[0] ? varOf(regOf(insn.ops[0]), ctx) : '?';
    const src = insn.ops[1] ? varOf(regOf(insn.ops[1]), ctx) : '?';
    return mk(status + ' = __atomic_store(' + addressExpr(place) + ', ' + src + ');',
      { dst: insn.writes[0], note: '書き込めたら 0、他に取られていたら 1 が返ります。' });
  }

  if (m.kind === 'load') {
    const d0 = insn.ops[0] ? nameForDef(ctx, insn.row, regOf(insn.ops[0])) : '?';
    if (pair) {
      const d1 = insn.ops[1] ? nameForDef(ctx, insn.row, regOf(insn.ops[1])) : '?';
      return mk(d0 + ' = ' + place + ';   ' + d1 + ' = ' + nextSlot(place, m) + ';',
        { dst: insn.writes[0] });
    }
    const text = ctx.textOf.get(insn.row);
    if (text != null) {
      return mk(d0 + ' = "' + escapeText(text) + '";', { dst: insn.writes[0], pure: true });
    }
    /*
     * 住所は、値グラフが持っている式のほうが正しい。
     * `*(uint64 *)(x8)` の x8 が、埋め込まれて消えた行のものだったりするので、
     * レジスタ名ではなく中身で書く。
     */
    const node = ctx.values ? ctx.values.defAt(insn.row, insn.writes[0]) : null;
    const viaExpr = node && node.k === 'mem' ? exprText(ctx, node, node) : null;
    return mk(d0 + ' = ' + (viaExpr || place) + ';', { dst: insn.writes[0], pure: true });
  }
  /*
   * 書き込む値は、レジスタ名ではなく **その中身** で書く。
   *
   *   mov w8, #2 ; str w8, [sp, #0xc8]      →   var_C8 = 2;
   *
   * レジスタ名のまま出していたころ、値を作った行（誰も変数として使わないので
   * 消える行）と食い違って、`var_C8 = x8;` の x8 がどこにも無い、という
   * いちばんまずい形になっていた。
   */
  const stored = storedValues(insn, ctx);
  const s0 = stored[0] || (insn.ops[0] ? varOf(regOf(insn.ops[0]), ctx) : '?');
  if (pair) {
    const s1 = stored[1] || (insn.ops[1] ? varOf(regOf(insn.ops[1]), ctx) : '?');
    return mk(place + ' = ' + s0 + ';   ' + nextSlot(place, m) + ' = ' + s1 + ';', {});
  }
  return mk(place + ' = ' + s0 + ';');
}

/** その書き込み命令が置いている値を、式として。読めなければ空。 */
function storedValues(insn, ctx) {
  const vg = ctx.values;
  if (!vg) return [];
  const out = [];
  for (const w of vg.memWrites || []) {
    if (w.row !== insn.row) continue;
    const text = w.value ? exprText(ctx, w.value, null) : null;
    out.push(text || null);
  }
  return out;
}

/** *(型 *)(x8) → (型 *)(x8) 。「その場所そのもの」を表す式にする。 */
function addressExpr(place) {
  const m = /^\*(\(.*)$/.exec(place);
  return m ? m[1] : '&' + place;
}

function nextSlot(place, m) {
  const step = (m && m.size ? m.size / 2 : 8) || 8;
  return place.replace(/\)$/, ' + ' + step + ')').replace(/^([A-Za-z_]\w*)$/, '$1_2');
}

/* ── 呼び出し ───────────────────────────────────────────── */

function callStatement(insn, ctx, mk) {
  const call = ctx.callOf.get(insn.row);
  const target = insn.callTarget;
  let name = call && call.name ? shortName(call.name) : (target != null ? ctx.symbolFor(target) : null);
  const custom = ctx.notes && target != null ? ctx.notes.nameOf(target) : null;
  if (custom) name = custom;

  /* Objective-C のメソッド呼び出しは [obj method:…] で書く */
  const sel = call && call.selector ? call.selector : (name ? (/objc_msgSend(?:Super2?)?\$(.+)$/.exec(name) || [])[1] : null);
  if (sel) {
    const parts = sel.split(':').filter(Boolean);
    const argv = [];
    for (let i = 0; i < Math.max(1, parts.length); i++) argv.push(varOf('x' + (i + 2), ctx));
    const body = parts.length
      ? parts.map((p, i) => p + ':' + argv[i]).join(' ')
      : sel;
    return mk(varOf('x0', ctx) + ' = [' + varOf('x0', ctx) + ' ' + body + '];',
      { dst: 'x0', call: true, reads: ['x0'].concat(parts.map((_, i) => 'x' + (i + 2))),
        note: 'Objective-C のメソッド「' + sel + '」を呼びます。' });
  }

  const args = callArguments(call, ctx);
  const label = name || (target != null ? 'sub_' + target.toString(16).toUpperCase() : indirectName(insn, ctx));
  const callExpr = label + '(' + args.join(', ') + ')';
  /* 値が分かっている引数（"文字列" や 0x50）は、そのまま書けているので
     「x0 を読んだ」ことにしない。手前の準備の行を消せるようにするため。 */
  const reads = insn.reads.slice();          // blr x8 の x8 など、命令自身が読むもの
  args.forEach((text, i) => { if (text === varOf('x' + i, ctx)) reads.push('x' + i); });
  /* 末尾呼び出し（b で別の関数へ跳んで終わる）は、そのまま return になる */
  const text = insn.isTailCall
    ? 'return ' + callExpr + ';'
    : nameForDef(ctx, insn.row, 'x0') + ' = ' + callExpr + ';';
  return mk(text, {
    dst: insn.isTailCall ? null : 'x0', call: true, target, reads,
    kind: insn.isTailCall ? 'ctrl' : 'stmt',
    note: name ? null : '行き先が固定でない呼び出しです（関数ポインタ）。',
  });
}

function indirectName(insn, ctx) {
  const r = insn.ops && insn.ops[0] ? regOf(insn.ops[0]) : null;
  return r ? '(*' + varOf(r, ctx) + ')' : '(*func)';
}

/**
 * 引数。呼ぶ直前に用意された x0〜x7 のうち、実際に値が入っているものだけ。
 * 数が分からないときに 8 個並べても嘘になるので、途切れたところで止める。
 */
function callArguments(call, ctx) {
  const out = [];
  if (!call || !call.args) return out;
  const known = new Map(call.args.map((a) => [a.index, a]));
  for (let i = 0; i <= 7; i++) {
    const a = known.get(i);
    if (!a) break;
    /*
     * 引数も、レジスタ名ではなく中身で書く。
     * `sub_10041A334(1, a4, …)` と `sub_10041A334(x0, x1, …)` では、
     * 読む人が受け取るものがまったく違う。
     */
    const node = ctx.values ? ctx.values.at(call.row, 'x' + i) : null;
    const text = node ? exprText(ctx, node, null) : null;
    out.push(text || valueText(a.value, ctx, i));
  }
  return out;
}

function valueText(v, ctx, index) {
  if (!v) return varOf('x' + index, ctx);
  if (v.kind === 'string' && v.text != null) return '"' + escapeText(v.text) + '"';
  if (v.kind === 'imm' && v.value != null) return hexImm(v.value);
  if (v.kind === 'address' && v.addr != null) {
    const sym = ctx.symbolFor(v.addr);
    return sym ? '&' + sym : '0x' + v.addr.toString(16).toUpperCase();
  }
  return varOf('x' + index, ctx);
}

function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    .slice(0, 120);
}

/* ── 一時変数をたたむ ──────────────────────────────────── */

/**
 * `x8 = a + b;` の x8 がそのブロックの中で 1 回しか使われず、
 * そのあと上書きされる（＝あとに残らない）なら、使う側に埋め込む。
 * これをやらないと、逆コンパイル結果が代入だらけで読めません。
 */
function inlineTemporaries(stmts, ctx) {
  const uses = new Map();       // reg -> [文の位置]
  const defs = new Map();
  stmts.forEach((st, i) => {
    if (st.dst) {
      if (!defs.has(st.dst)) defs.set(st.dst, []);
      defs.get(st.dst).push(i);
    }
    for (const r of st.reads || []) {
      if (!uses.has(r)) uses.set(r, []);
      uses.get(r).push(i);
    }
  });

  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i];
    if (!st.dst || st.dropped) continue;
    if (!st.pure && !st.call) continue;
    const reg = st.dst;
    /*
     * 呼び出しの結果は、レジスタではなく **呼び名** で数える。
     *
     * x0 は関数の中で何十回も使い回されるので、レジスタで数えると
     * 「x0 を読む行が 14 個ある」となって、1 つも埋め込めない。
     * 実際に指しているのは `x0_1` という 1 つの値で、それを読む行は 1 つしかない。
     */
    const lhs = /^([A-Za-z_]\w*)\s*=\s*/.exec(st.text.trim());
    const name = lhs ? lhs[1] : varOf(reg, ctx);
    const readers = st.call
      ? stmts.map((s, k) => k).filter((k) => k > i && !stmts[k].dropped && hasWholeWord(stmts[k].text, name))
      : (uses.get(reg) || []).filter((j) => j > i);
    if (readers.length !== 1) continue;
    const j = readers[0];
    const target = stmts[j];
    if (!target || target.dropped) continue;
    if (target.call) continue;                   // 呼び出しの行に埋め込むと左辺まで書き換えてしまう
    if (st.call) {
      /*
       * 呼び出しは順番そのものが処理なので、動かせるのは「すぐ次の行」まで。
       *
       *   x0_1 = getAttackUp(1, a4);
       *   var_C4 = x0_1;              →   var_C4 = getAttackUp(1, a4);
       *
       * こういう組が 12 個続いている関数があり、24 行が 12 行になる。
       * 1 つ飛ばして埋め込むと、間の呼び出しと順番が入れ替わってしまうので、
       * 直後でなければ諦める。
       */
      if (!/^[A-Za-z_]\w*\s*=\s*/.test(target.text)) continue;
      /*
       * 間に別の呼び出しがあれば、順番が入れ替わってしまうので諦める。
       * 定数を置くだけの行なら、またいでよい（実際この形が並ぶ）。
       *
       *   x0_1 = getAttackUp(1, a4);
       *   var_C0 = 1;                     ← またぐ
       *   var_C4 = x0_1;            →     var_C0 = 1; var_C4 = getAttackUp(1, a4);
       *
       * ただし、この関数の置き場そのものを呼び先へ渡している呼び出しは動かさない
       * （呼び先がその置き場を書き換えるかもしれない）。
       */
      if (/\bsp\b|\bx29\b|var_/.test(st.text)) continue;
      let blocked = false;
      for (let k = i + 1; k < j; k++) {
        const mid = stmts[k];
        if (mid.dropped) continue;
        if (mid.call || !/^[A-Za-z_][\w>.\-[\]*() ]*\s*=\s*/.test(mid.text)) { blocked = true; break; }
      }
      if (blocked) continue;
    } else {
      const later = (defs.get(reg) || []).filter((k) => k > j);
      const isTemp = /^x(8|9|1[0-7])$/.test(reg);
      if (!later.length && !isTemp) continue;    // あとで使われるかもしれない変数は残す
    }
    const value = rightHandSide(st.text, reg);
    if (value == null) continue;
    /* 左辺が「その変数そのもの」なら、そこは書き込み先なので触らない。
       x8 = *(x8 + 8);  の左の x8 まで置き換えると、意味が変わってしまう。 */
    const eq = target.text.indexOf(' = ');
    let head = '';
    let rest = target.text;
    if (eq > 0 && /^[A-Za-z_]\w*$/.test(target.text.slice(0, eq))) {
      head = target.text.slice(0, eq + 3);
      rest = target.text.slice(eq + 3);
    }
    if (!hasWholeWord(rest, name)) continue;
    target.text = head + replaceWholeWord(rest, name, needsParens(value) ? '(' + value + ')' : value);
    st.dropped = true;
  }
}

/**
 * 誰にも読まれないまま上書きされる代入を消す。
 *
 * adrp と add の組は 2 行に分かれますが、まとまった 1 つのアドレスが
 * 分かってしまえば前半は要りません。そういう「消えても意味の変わらない行」を落とします。
 * 同じブロックの中で上書きされることが確かめられた場合だけ消します。
 */
function removeDeadStores(stmts) {
  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i];
    if (!st.dst || !st.pure || st.dropped || st.call) continue;
    let redefined = false;
    let read = false;
    for (let j = i + 1; j < stmts.length; j++) {
      const other = stmts[j];
      if (other.dropped) continue;
      if ((other.reads || []).includes(st.dst)) { read = true; break; }
      if (other.dst === st.dst) { redefined = true; break; }
    }
    if (redefined && !read) st.dropped = true;
  }
}

function rightHandSide(text, reg) {
  const m = new RegExp('^' + escapeRe(reg) + '\\s*=\\s*(.*);$').exec(text.trim());
  if (!m) {
    const m2 = /^[A-Za-z_]\w*\s*=\s*(.*);$/.exec(text.trim());
    if (m2) return m2[1];
    return null;
  }
  return m[1];
}

function needsParens(expr) {
  return /[+\-*/&|^<>?]/.test(expr) && !/^\(.*\)$/.test(expr) && !/^\*\(/.test(expr) && !/^"/.test(expr);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function hasWholeWord(text, word) {
  return new RegExp('(^|[^\\w>])' + escapeRe(word) + '($|[^\\w])').test(text);
}

function replaceWholeWord(text, word, value) {
  return text.replace(new RegExp('(^|[^\\w>])' + escapeRe(word) + '($|[^\\w])', 'g'),
    (m, a, b) => a + value + b);
}

/* ── 変数の宣言 ─────────────────────────────────────────── */

/*
 * 変数の宣言。
 *
 * 1 行に 1 個ずつ並べていたころ、この関数の頭には
 *
 *     uint32 var_C8;
 *     // スタック（この関数のためのメモ帳）にある置き場です。
 *     uint8 var_CC;
 *     // スタック（この関数のためのメモ帳）にある置き場です。   … × 30
 *
 * が続いていて、処理が始まるまでに 60 行あった。同じ型のものは 1 行にまとめ、
 * 説明は宣言のまとまりに 1 回だけ書く。読む人が知りたいのは
 * 「どんな置き場がいくつあるか」であって、1 つずつの行ではない。
 */
function declarations(ctx, types, o, body) {
  const out = [];
  const seen = new Set();
  const text = body.map((l) => l.text).join('\n');
  const byType = new Map();
  let hidden = 0;
  let shown = 0;
  for (const l of types.locals) {
    const disp = BigInt(l.offset);
    const name = slotName(l.slot.startsWith('x29') ? 'x29' : 'sp', disp, ctx);
    if (seen.has(name)) continue;
    seen.add(name);
    // 本文に出てこない置き場（入口と出口の退避だけに使うもの）は並べない
    if (!hasWholeWord(text, name)) { hidden++; continue; }
    if (shown >= 48) { hidden++; continue; }
    shown++;
    const raw = (ctx.notes && ctx.funcAddr != null ? ctx.notes.typeOf(ctx.funcAddr, l.slot) : null) || l.type;
    const type = raw === 'unknown' ? 'int64' : raw;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(name);
  }
  /* 同じ型はまとめて、1 行が長くなりすぎない範囲で折り返す。 */
  for (const [type, names] of byType) {
    for (let i = 0; i < names.length; i += 8) {
      out.push(line('decl', 1, type + ' ' + names.slice(i, i + 8).join(', ') + ';', null));
    }
  }
  if (out.length && ctx.beginner) {
    out[0].note = 'スタック（この関数のためのメモ帳）にある置き場です' +
      (hidden ? '。ほかに ' + hidden + ' 個、退避だけに使う置き場があります。' : '。');
  } else if (hidden) {
    out.push(line('comment', 1, '// … ほかに ' + hidden + ' 個の置き場（退避用など）があります', null));
  }
  if (ctx.carry) {
    out.unshift(line('decl', 1, 'int64 result;   // ' + ctx.carry.reg +
      '。この関数が ' + ctx.carry.steps + ' 段にわたって作り変えている値', null));
  }
  void o;
  return out;
}

/*
 * 同じ注釈を 2 度書かない。
 *
 * 注釈は「はじめて見る人がその行で詰まらないため」に付けている。
 * ところが同じ形の命令は 1 つの関数に何十回も出るので、そのまま出すと
 * 「メモリへ値を書き込みます。」が 40 行並ぶ。1 回目だけ残せば役目は果たす。
 */
function dedupeNotes(lines) {
  const seen = new Set();
  for (const l of lines) {
    if (!l.note) continue;
    if (seen.has(l.note)) { l.note = null; continue; }
    seen.add(l.note);
  }
}

/*
 * 段落を作る。
 *
 * 人が書いた C には、意味のまとまりごとに空行が入っている。命令を 1 行ずつ
 * 訳しただけの出力にはそれが無いので、200 行が 1 つのかたまりに見える。
 * 分岐とループの前後 —— つまり「話が変わるところ」に空行を入れる。
 */
function breatheOut(lines) {
  const isOpen = (l) => l.kind === 'ctrl' && /^(if|while|for|do|switch)\b/.test(l.text);
  const isClose = (l) => l.kind === 'ctrl' && /^[}]/.test(l.text.trim());
  for (let i = lines.length - 1; i > 0; i--) {
    const cur = lines[i], prev = lines[i - 1];
    if (prev.kind === 'blank' || cur.kind === 'blank') continue;
    if (prev.kind === 'sig' || prev.text === '{') continue;
    const wanted = (isOpen(cur) && prev.kind !== 'label') ||
      (isClose(prev) && !isClose(cur) && cur.indent >= prev.indent);
    if (wanted) lines.splice(i, 0, line('blank', cur.indent, ''));
  }
}

/* ── 文字列にする（コピー用） ──────────────────────────── */

export function decompiledText(result) {
  if (!result || !result.lines) return '';
  const out = [];
  for (const l of result.lines) {
    if (l.kind === 'blank') { out.push(''); continue; }
    out.push('    '.repeat(Math.max(0, l.indent)) + l.text);
  }
  return out.join('\n');
}
