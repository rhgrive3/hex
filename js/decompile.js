/*
 * 擬似コード（デコンパイル）。
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
  const state = { labels: new Set(), gotos: 0, depth: 0, openLoops: new Set() };
  emitRange(cfg, 0, cfg.nodes.length - 1, 1, body, ctx, state, null);

  /* 見出し（シグネチャ） */
  const name = (o.notes && o.notes.nameOf(o.addr)) || o.name || ('sub_' + (o.addr != null ? o.addr.toString(16).toUpperCase() : '0'));
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

  if (state.gotos) {
    warnings.push('制御の流れが複雑で、' + state.gotos + ' か所は goto のまま残しました（コンパイラの最適化でよくあります）。');
  }
  if (model.truncated) warnings.push('関数が大きいため、途中までを訳しています。');
  if (ctx.unknown.size) {
    warnings.push('訳せなかった命令が ' + ctx.unknown.size + ' 種類あります（__asm として残しています）。');
  }

  return { lines: out, signature, types, warnings, labels: state.labels, ctx };
}

/* ────────────────────────────────────────────────────────────
   下ごしらえ
   ──────────────────────────────────────────────────────────── */

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

  return {
    model,
    byRow,
    textOf,
    refOf,
    callOf,
    rowOfAddress: o.rowOfAddress || (() => null),
    addrOfRow: o.addrOfRow || (() => null),
    symbolFor: o.symbolFor || (() => null),
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

  return { nodes, nodeOfRow };
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

    /* ループ: 自分に戻ってくる辺があるか（同じループを二重に開かない） */
    const back = state.openLoops.has(i) ? -1 : backEdgeInto(cfg, i, to);
    if (back >= i) {
      i = emitLoop(cfg, i, back, to, indent, out, ctx, state);
      continue;
    }

    /* 条件分岐 */
    if (n.cond && n.condTarget != null) {
      const nextI = emitIf(cfg, i, to, indent, out, ctx, state, loop);
      if (nextI != null) { i = nextI; continue; }
    }

    /* ふつうの並び */
    emitBlockBody(n, indent, out, ctx, state);

    if (n.jump != null) {
      const target = n.jump;
      if (loop && target === loop.header) { out.push(line('ctrl', indent, 'continue;', n.endRow)); return -1; }
      if (loop && target === loop.exit) { out.push(line('ctrl', indent, 'break;', n.endRow)); return -1; }
      if (target === i + 1) { i = i + 1; continue; }      // ただの次へ
      if (target > to || target < from) {
        out.push(line('ctrl', indent, 'goto ' + labelOf(cfg.nodes[target], ctx) + ';', n.endRow));
        state.labels.add(labelOf(cfg.nodes[target], ctx));
        state.gotos++;
        return -1;
      }
      i = target;
      continue;
    }
    if (n.tail || !n.succ.length) return -1;             // ret / 末尾呼び出し
    i = n.fall != null ? n.fall : i + 1;
  }
  return i;
  } finally { state.depth--; }
}

/** i に戻ってくる後ろ向きの辺のうち、いちばん後ろの節点。なければ -1。 */
function backEdgeInto(cfg, i, to) {
  let last = -1;
  for (const p of cfg.nodes[i].pred) {
    if (p >= i && p <= to) last = Math.max(last, p);
  }
  return last;
}

/** ループを訳す。header..last がループの中身。 */
function emitLoop(cfg, header, last, to, indent, out, ctx, state) {
  const node = cfg.nodes[header];
  const exit = last + 1 <= to ? last + 1 : null;
  const loop = { header, exit, last };
  state.openLoops.add(header);
  try {
    /* 先頭で条件を見て抜けるなら while、最後で見るなら do-while */
    const headCond = node.cond && node.condTarget != null && node.condTarget > last;
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
    out.push(line('ctrl', indent, 'do  {', node.startRow, addrOf(ctx, node.startRow)));
    if (ctx.beginner) out[out.length - 1].note = '同じ処理を、条件が続くあいだ繰り返します。';
    emitRange(cfg, header, last, indent + 1, out, ctx, state, loop);
    const cond = tail.cond && tail.condTarget === header ? tail.cond : null;
    out.push(line('ctrl', indent, '} while (' + (cond ? condText(cond, ctx) : '/* 条件は読み取れません */ 1') + ');', tail.endRow));
    return exit == null ? -1 : exit;
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
function emitIf(cfg, i, to, indent, out, ctx, state, loop) {
  const n = cfg.nodes[i];
  const t = n.condTarget;
  const fall = n.fall;
  if (t == null || fall == null) return null;
  if (t <= i) return null;                 // 後ろ向き = ループの一部。ここでは扱わない
  if (t > to + 1) return null;

  emitBlockBody(n, indent, out, ctx, state, { skipTerminator: true });

  /* 条件は「飛ぶ条件」なので、then を書くには裏返す */
  const cond = negate(n.cond);
  const thenFrom = fall, thenTo = t - 1;

  /* then の最後が無条件ジャンプなら、その先が合流点＝else の終わり */
  let elseFrom = null, elseTo = null, after = t;
  const thenLast = thenTo >= thenFrom ? cfg.nodes[thenTo] : null;
  if (thenLast && thenLast.jump != null && thenLast.jump > t && thenLast.jump <= to + 1) {
    elseFrom = t; elseTo = thenLast.jump - 1; after = thenLast.jump;
  }

  out.push(line('ctrl', indent, 'if (' + condText(cond, ctx) + ')  {', n.endRow, addrOf(ctx, n.endRow)));
  if (ctx.beginner) out[out.length - 1].note = condNote(cond) + 'ときだけ、中を実行します。';
  if (thenTo >= thenFrom) emitRange(cfg, thenFrom, thenTo, indent + 1, out, ctx, state, loop);
  if (elseFrom != null && elseTo >= elseFrom) {
    out.push(line('ctrl', indent, '} else {', cfg.nodes[elseFrom].startRow));
    emitRange(cfg, elseFrom, elseTo, indent + 1, out, ctx, state, loop);
  }
  out.push(line('ctrl', indent, '}', null));
  return after <= to ? after : -1;
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

/** スタック上の場所につける名前。var_20 のように、IDA と同じ書き方にする。 */
function slotName(base, disp, ctx) {
  const key = base + ':' + disp.toString();
  if (ctx.stackNames.has(key)) return ctx.stackNames.get(key);
  const custom = ctx.notes && ctx.funcAddr != null ? ctx.notes.varName(ctx.funcAddr, base + disp) : null;
  const abs = disp < 0n ? -disp : disp;
  const n = custom || ('var_' + abs.toString(16).toUpperCase());
  ctx.stackNames.set(key, n);
  return n;
}

/* ── 1 ブロックぶんの文 ─────────────────────────────────── */

const SKIP_MN = /^(nop|hint|bti|paciasp|pacibsp|autiasp|autibsp|xpaclri|dmb|dsb|isb|prfm|pacibz|pacia|autia)$/;

function emitBlockBody(node, indent, out, ctx, state, opts) {
  void opts;
  const stmts = [];
  for (const row of node.rows) {
    const insn = ctx.byRow.get(row);
    if (!insn) continue;
    /* 分岐そのものは if / while / goto として書くので、ここでは出さない */
    if (insn === node.terminator && insn.isBranch && !insn.isCall && !insn.isReturn) continue;
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
  if (base === 'ret' || base === 'retab' || base === 'retaa') {
    const ret = ctx.types && ctx.types.ret && ctx.types.ret.type !== 'void';
    return mk(ret ? 'return ' + varOf('x0', ctx) + ';' : 'return;', { kind: 'ctrl', note: ret ? '呼び出し元へ x0 の値を返します。' : '呼び出し元へ戻ります。' });
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
    if (text != null) return mk(varOf(dst, ctx) + ' = "' + escapeText(text) + '";', { dst, pure: true, note: '文字列の場所を用意します。' });
    const t = ref ? ref.addr : insn.pcRelTarget;
    if (base === 'adrp' && !ref) {
      /* ページの先頭だけを作る途中。次の add / ldr と組で 1 つのアドレスになる */
      return mk(varOf(dst, ctx) + ' = 0x' + (t != null ? t.toString(16).toUpperCase() : '?') + ';',
        { dst, pure: true, note: 'アドレスの上半分を作っています（次の行と組で 1 つの場所になります）。' });
    }
    const sym = t != null ? ctx.symbolFor(t) : null;
    return mk(varOf(dst, ctx) + ' = ' + (sym ? '&' + sym : '0x' + (t != null ? t.toString(16).toUpperCase() : '?')) + ';',
      // 場所が 1 つに決まったので、もう手前のレジスタには依存していない
      { dst, pure: true, reads: [], note: 'データのある場所（アドレス）を作ります。' });
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
      { dst, pure: true, note: '型（値の見方）を ' + to + ' に変えます。' });
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
    { dst, note: 'この命令は擬似コードに直せませんでした。アセンブリのまま置いています。' });
}

function shiftOp(op) {
  return { lsl: '<<', lsr: '>>', asr: '>>', ror: '>>>' }[op] || '<<';
}

/**
 * 「後片付け」の命令かどうか。
 *
 * 関数の入口と出口には、x19〜x30 を守るための決まりきった出し入れが並びます。
 * 処理の中身とは関係がないので、擬似コードからは省きます
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
    if (calleeSaved && (atEdge || frameish)) return true;
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
      { dst, pure: true, note: '条件が成り立てば 1、そうでなければ 0 を入れます。' });
  }
  const a = ops[1] ? operandText(ops[1], ctx, insn) : '?';
  const b = ops[2] && ops[2].k !== 'cond' ? operandText(ops[2], ctx, insn) : a;
  const alt = base === 'csinc' ? b + ' + 1' : base === 'csinv' ? '~' + b : base === 'csneg' ? '-' + b : b;
  return mk(varOf(dst, ctx) + ' = (' + c + ') ? ' + a + ' : ' + alt + ';',
    { dst, pure: true, note: '条件によって、入れる値を選びます。' });
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
    const d0 = insn.ops[0] ? varOf(regOf(insn.ops[0]), ctx) : '?';
    if (pair) {
      const d1 = insn.ops[1] ? varOf(regOf(insn.ops[1]), ctx) : '?';
      return mk(d0 + ' = ' + place + ';   ' + d1 + ' = ' + nextSlot(place, m) + ';',
        { dst: insn.writes[0], note: '2 つ続けて読み出しています。' });
    }
    const text = ctx.textOf.get(insn.row);
    if (text != null) {
      return mk(d0 + ' = "' + escapeText(text) + '";', { dst: insn.writes[0], pure: true, note: '文字列を読み出しています。' });
    }
    return mk(d0 + ' = ' + place + ';', { dst: insn.writes[0], pure: true, note: 'メモリから値を読み出します。' });
  }
  const s0 = insn.ops[0] ? varOf(regOf(insn.ops[0]), ctx) : '?';
  if (pair) {
    const s1 = insn.ops[1] ? varOf(regOf(insn.ops[1]), ctx) : '?';
    return mk(place + ' = ' + s0 + ';   ' + nextSlot(place, m) + ' = ' + s1 + ';', { note: '2 つ続けて書き込んでいます。' });
  }
  return mk(place + ' = ' + s0 + ';', { note: 'メモリへ値を書き込みます。' });
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
  let name = call && call.name ? call.name : (target != null ? ctx.symbolFor(target) : null);
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
    : varOf('x0', ctx) + ' = ' + callExpr + ';';
  return mk(text, {
    dst: insn.isTailCall ? null : 'x0', call: true, target, reads,
    kind: insn.isTailCall ? 'ctrl' : 'stmt',
    note: name ? '「' + name + '」を呼びます。' : '行き先が固定でない呼び出しです（関数ポインタ）。',
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
    out.push(valueText(a.value, ctx, i));
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
 * これをやらないと、擬似コードが代入だらけで読めません。
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
    if (!st.dst || !st.pure || st.dropped) continue;
    if (st.call) continue;
    const reg = st.dst;
    const readers = (uses.get(reg) || []).filter((j) => j > i);
    if (readers.length !== 1) continue;
    const j = readers[0];
    const later = (defs.get(reg) || []).filter((k) => k > j);
    const isTemp = /^x(8|9|1[0-7])$/.test(reg);
    if (!later.length && !isTemp) continue;      // あとで使われるかもしれない変数は残す
    const target = stmts[j];
    if (!target || target.dropped) continue;
    if (target.call) continue;                   // 呼び出しの行に埋め込むと左辺まで書き換えてしまう
    const value = rightHandSide(st.text, reg);
    if (value == null) continue;
    const name = varOf(reg, ctx);
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

function declarations(ctx, types, o, body) {
  const out = [];
  const seen = new Set();
  const text = body.map((l) => l.text).join('\n');
  let hidden = 0;
  for (const l of types.locals) {
    const disp = BigInt(l.offset);
    const name = slotName(l.slot.startsWith('x29') ? 'x29' : 'sp', disp, ctx);
    if (seen.has(name)) continue;
    seen.add(name);
    // 本文に出てこない置き場（入口と出口の退避だけに使うもの）は並べない
    if (!hasWholeWord(text, name)) { hidden++; continue; }
    if (out.length >= 40) { hidden++; continue; }
    const type = (ctx.notes && ctx.funcAddr != null ? ctx.notes.typeOf(ctx.funcAddr, l.slot) : null) || l.type;
    const l2 = line('decl', 1, (type === 'unknown' ? 'int64' : type) + ' ' + name + ';', null);
    l2.note = ctx.beginner ? 'スタック（この関数のためのメモ帳）にある置き場です。' : null;
    out.push(l2);
  }
  if (hidden) {
    out.push(line('comment', 1, '// … ほかに ' + hidden + ' 個の置き場（退避用など）があります', null));
  }
  void o;
  return out;
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
