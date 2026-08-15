/*
 * ir.js — 解析エンジンの中心にある中間表現（IR）と SSA。
 *
 * これまで arm64.js / blocks.js / expr.js / dataflow.js / decompile.js は、
 * それぞれが命令列を自分なりに読み直して意味を拾っていた。同じ「加算」を
 * 5 か所が別々に見つけ、別々に間違える。ここはその共通の土台になる。
 *
 *     ARM64 命令
 *        ↓  lift        1 命令 → 1 つ以上の IR 命令（推測を入れない）
 *     Instruction IR
 *        ↓  SSA         レジスタに版番号を振り、合流点に φ を置く
 *     SSA
 *        ↓  Memory SSA  メモリの場所ごとに版番号を振る（store → load の辺）
 *     Typed Semantic IR
 *
 * ここで得られるもの:
 *
 *   use-def / def-use   … その値はどこで作られ、どこで使われたか
 *   φ                   … 「if の両方の道から来た値」を 1 つの名前で扱える
 *   Memory SSA          … `self->coins` を読んだ load が、どの store の値かを指す
 *   stack variable      … sp/fp からの固定オフセットをローカル変数として畳む
 *   alias               … 「別の場所」と言い切れるときだけ言い切る
 *   const / range / 符号 … 分かる範囲だけ。分からないものは unknown のまま残す
 *
 * これがあると、
 *
 *     ldr w8, [x19,#0x20]
 *     add w8, w8, w21
 *     cmp w8, w22
 *     csel w8, w22, w8, gt
 *     str w8, [x19,#0x20]
 *
 * を「命令が 5 つ」ではなく
 *
 *     [x19+0x20] = min([x19+0x20] + w21, w22)
 *
 * という 1 つの意味単位として扱える。
 *
 * きまり:
 *   1. 分からないものは unknown にする。埋めない。
 *   2. 名前を作らない。ここは形と辺だけを返す。日本語は narrate.js の仕事。
 *   3. 「たぶん別の場所」は alias 無しとして扱わない。危険側に倒さない。
 */

import { buildCfg } from './cfg.js';
import { analyzeGraph } from './controlflow.js';

/* ── IR の語彙 ──────────────────────────────────────────────── */

export const OP = {
  CONST: 'const',       // dst = imm
  MOV: 'mov',           // dst = a
  BIN: 'bin',           // dst = a ⊕ b
  UN: 'un',             // dst = ⊖ a
  MAC: 'mac',           // dst = a ± b*c
  BFX: 'bfx',           // dst = ビット取り出し
  BFI: 'bfi',           // dst = ビット埋め込み
  CMP: 'cmp',           // flags = compare(a, b)
  SEL: 'sel',           // dst = cond ? a : b
  LOAD: 'load',         // dst = *(addr)
  STORE: 'store',       // *(addr) = a
  ADDR: 'addr',         // dst = 定数アドレス（adrp / adr / リテラルプール）
  CALL: 'call',
  RET: 'ret',
  BR: 'br',             // 無条件
  CBR: 'cbr',           // 条件つき
  PHI: 'phi',
  CLOBBER: 'clobber',   // メモリを壊す目印（呼び出しなど）
  UNKNOWN: 'unknown',   // 意味を持たせられなかった命令。dst は ⊥ になる
};

/* 値の出どころ。 */
export const VK = {
  ARG: 'arg',           // 関数に入ってきた時点の値（x0..x7 は引数）
  CONST: 'const',
  DEF: 'def',           // IR 命令が作った値
  PHI: 'phi',
  UNDEF: 'undef',       // 定義に届かなかった（到達不能・解析打ち切り）
};

/* メモリの場所の種類。 */
export const MK = {
  STACK: 'stack',       // sp / fp からの固定オフセット
  FIELD: 'field',       // ある値 + 固定オフセット（オブジェクトのフィールド）
  GLOBAL: 'global',     // 固定アドレス
  UNKNOWN: 'unknown',   // 添字が実行時に決まるなど
};

const MAX_INSTRUCTIONS = 6000;        // これ以上は IR を作らない（表示は続く）
const MAX_PHI_ROUNDS = 64;

/* ── 小道具 ────────────────────────────────────────────────── */

const M64 = (1n << 64n) - 1n;

function mask(v, bits) {
  if (v == null) return null;
  const m = bits >= 64 ? M64 : (1n << BigInt(bits)) - 1n;
  return BigInt.asUintN(64, v) & m;
}

/** 符号つきとして読む。 */
function signedOf(v, bits) {
  if (v == null) return null;
  return BigInt.asIntN(bits, v);
}

function regKeyOf(op) {
  if (!op || op.k !== 'reg') return null;
  if (op.cls === 'zr') return null;                 // zr は値を持たない
  if (op.cls === 'sp') return 'sp';
  if (op.cls === 'gp') return 'x' + op.num;
  if (op.cls === 'fp' || op.cls === 'vec') return 'v' + op.num;
  return null;
}

function regBits(op) {
  if (!op || op.k !== 'reg') return 64;
  return op.bits || 64;
}

/* ── 命令 1 つを IR に持ち上げる ──────────────────────────────
 *
 * 出てくるのは「まだレジスタ名のままの IR」。SSA 化はこのあとの工程。
 * オペランドは次の形にそろえる:
 *
 *   { t:'reg',  reg:'x8', bits:32, shift:{op,amount} }
 *   { t:'imm',  value: BigInt }
 *   { t:'cond', cond:'gt' }
 *   { t:'zero' }                       ← zr。値としては定数 0
 */

const BIN_OF = {
  add: 'add', adds: 'add', sub: 'sub', subs: 'sub',
  mul: 'mul', mneg: 'mul', smull: 'smull', umull: 'umull',
  smulh: 'smulh', umulh: 'umulh', sdiv: 'sdiv', udiv: 'udiv',
  and: 'and', ands: 'and', orr: 'or', eor: 'xor', bic: 'bic', orn: 'orn', eon: 'eon',
  lsl: 'shl', lslv: 'shl', lsr: 'lshr', lsrv: 'lshr', asr: 'ashr', asrv: 'ashr',
  ror: 'ror', rorv: 'ror',
  fadd: 'fadd', fsub: 'fsub', fmul: 'fmul', fdiv: 'fdiv',
};

const UN_OF = {
  neg: 'neg', negs: 'neg', mvn: 'not', fneg: 'fneg', fabs: 'fabs', fsqrt: 'fsqrt',
  sxtb: 'sxt8', sxth: 'sxt16', sxtw: 'sxt32',
  uxtb: 'uxt8', uxth: 'uxt16', uxtw: 'uxt32',
  clz: 'clz', rbit: 'rbit', rev: 'rev', rev16: 'rev16', rev32: 'rev32',
  scvtf: 'i2f', ucvtf: 'u2f', fcvtzs: 'f2i', fcvtzu: 'f2u',
  fmov: 'fmov', abs: 'abs',
};

const SEL_OF = { csel: 'sel', csinc: 'inc', csinv: 'inv', csneg: 'neg', cset: 'set', csetm: 'setm', cinc: 'cinc', cneg: 'cneg', cinv: 'cinv' };

/* 条件コード → 比較の意味。signed が null のものは符号に関係しない。 */
export const COND = {
  eq: { op: '==', signed: null }, ne: { op: '!=', signed: null },
  hs: { op: '>=', signed: false }, cs: { op: '>=', signed: false },
  lo: { op: '<', signed: false }, cc: { op: '<', signed: false },
  hi: { op: '>', signed: false }, ls: { op: '<=', signed: false },
  ge: { op: '>=', signed: true }, lt: { op: '<', signed: true },
  gt: { op: '>', signed: true }, le: { op: '<=', signed: true },
  mi: { op: '<', signed: true, vsZero: true }, pl: { op: '>=', signed: true, vsZero: true },
  vs: null, vc: null, al: null, nv: null,
};

const INVERSE_COND = {
  eq: 'ne', ne: 'eq', hs: 'lo', lo: 'hs', cs: 'cc', cc: 'cs',
  hi: 'ls', ls: 'hi', ge: 'lt', lt: 'ge', gt: 'le', le: 'gt',
  mi: 'pl', pl: 'mi', vs: 'vc', vc: 'vs',
};

export function inverseCondition(c) { return INVERSE_COND[c] || null; }

function opnd(op) {
  if (!op) return null;
  if (op.k === 'reg') {
    if (op.cls === 'zr') return { t: 'imm', value: 0n, zero: true };
    return { t: 'reg', reg: regKeyOf(op), bits: regBits(op), shift: op.shift || null };
  }
  if (op.k === 'imm') {
    if (op.value == null) return op.float != null ? { t: 'imm', value: null, float: op.float } : null;
    return { t: 'imm', value: op.value, shift: op.shift || null };
  }
  if (op.k === 'cond') return { t: 'cond', cond: op.text };
  return null;
}

/**
 * 1 命令 → IR 命令の配列（ふつうは 1 つ、ldp/stp は 2 つ）。
 * 意味を付けられない命令は OP.UNKNOWN を返す。ここで嘘を作らない。
 */
function callResultLocation(insn, opts) {
  let proto = insn?.callPrototype || null;
  if (!proto) {
    try { proto = opts?.callPrototypeFor?.(insn.callTarget ?? null, insn) || null; } catch { proto = null; }
  }
  if (!proto) return null;
  const type = String(proto.returnType || proto.ret || proto.result || '').toLowerCase();
  const cls = String(proto.returnClass || proto.abiClass || proto.resultClass || '').toLowerCase();
  if (proto.void === true || type === 'void' || cls === 'void') return null;
  if (proto.indirectResult === true || cls === 'indirect') return null;
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:Number(proto.returnBits || proto.bits || 64) || 64 };
  }
  if (type || cls || proto.returnsValue === true) return { reg:'x0', bits:Number(proto.returnBits || proto.bits || 64) || 64 };
  return null;
}

function lift(insn, opts = {}) {
  const base = (insn.mnemonic || '').toLowerCase();
  const ops = insn.ops || [];
  const at = { row: insn.row, address: insn.address, text: base + ' ' + (insn.operands || '') };
  const out = [];
  const push = (o) => { out.push(Object.assign({}, at, o)); return out[out.length - 1]; };

  const dstReg = () => (ops[0] && ops[0].k === 'reg' && ops[0].cls !== 'zr') ? regKeyOf(ops[0]) : null;
  const dstBits = () => regBits(ops[0]);
  const flags = () => ({ dstReg: 'nzcv', dstBits: 4 });

  /* ── 分岐と呼び出し ── */
  // AAPCS64 does not define a universal return register. Without prototype
  // evidence RET carries only control-flow semantics; consumers may recover a
  // return value from typed reaching definitions separately.
  if (insn.isReturn) { push({ op: OP.RET, srcs: [] }); return out; }
  if (insn.isCall) {
    const result = callResultLocation(insn, opts);
    push({
      op: OP.CALL,
      target: insn.callTarget != null ? insn.callTarget : null,
      indirect: insn.callTarget == null,
      srcs: (insn.callTarget == null && ops[0] && ops[0].k === 'reg')
        ? [{ t: 'reg', reg: regKeyOf(ops[0]), bits: 64 }] : [],
      dstReg: result?.reg || null, dstBits: result?.bits || 64,
      returnEvidence: result ? 'prototype' : null,
      clobbers: CALL_CLOBBERS,
    });
    return out;
  }
  if (base === 'cbz' || base === 'cbnz') {
    push({ op: OP.CBR, kind: base, target: insn.branchTarget,
      srcs: [opnd(ops[0])].filter(Boolean) });
    return out;
  }
  if (base === 'tbz' || base === 'tbnz') {
    push({ op: OP.CBR, kind: base, target: insn.branchTarget,
      bit: ops[1] && ops[1].value != null ? Number(ops[1].value) : null,
      srcs: [opnd(ops[0])].filter(Boolean) });
    return out;
  }
  if (/^b\.[a-z]{2}$/.test(base)) {
    push({ op: OP.CBR, kind: 'cond', cond: base.slice(2), target: insn.branchTarget,
      srcs: [{ t: 'reg', reg: 'nzcv', bits: 4 }] });
    return out;
  }
  if (base === 'b' || base === 'br') {
    push({ op: OP.BR, target: insn.branchTarget,
      indirect: base === 'br',
      srcs: base === 'br' && ops[0] ? [opnd(ops[0])].filter(Boolean) : [] });
    return out;
  }

  /* ── メモリ ── */
  if (insn.memory) {
    const mem = ops.find((o) => o.k === 'mem');
    const addr = {
      base: mem ? regKeyOf(mem.base) : null,
      disp: mem && mem.disp && mem.disp.value != null ? mem.disp.value : null,
      index: mem && mem.index ? regKeyOf(mem.index) : null,
      scale: mem && mem.shift ? (mem.shift.amount || 0) : 0,
      extend: mem && mem.shift && mem.shift.op !== 'lsl' ? mem.shift.op : null,
      mode: mem ? mem.mode : 'offset',
      stack: !!insn.memory.stack,
      size: insn.memory.size,
    };
    const pair = base === 'ldp' || base === 'stp' || base === 'ldnp' || base === 'stnp' || base === 'ldpsw';
    const each = insn.memory.size && pair ? insn.memory.size / 2 : insn.memory.size;
    const signedLoad = /^(ldrs|ldurs|ldpsw)/.test(base);
    if (insn.memory.kind === 'load') {
      const regs = pair ? [ops[0], ops[1]] : [ops[0]];
      regs.forEach((r, i) => {
        push({
          op: OP.LOAD, dstReg: r && r.k === 'reg' && r.cls !== 'zr' ? regKeyOf(r) : null,
          dstBits: regBits(r),
          addr: Object.assign({}, addr, { disp: addr.disp == null ? null : addr.disp + BigInt(i * (each || 0)), size: each }),
          size: each, signed: signedLoad, srcs: [],
        });
      });
    } else {
      const regs = pair ? [ops[0], ops[1]] : [ops[0]];
      regs.forEach((r, i) => {
        push({
          op: OP.STORE,
          addr: Object.assign({}, addr, { disp: addr.disp == null ? null : addr.disp + BigInt(i * (each || 0)), size: each }),
          size: each, srcs: [opnd(r)].filter(Boolean),
        });
      });
    }
    // 事前 / 事後インデックス付きは、ベースレジスタ自身も書き換わる
    if (mem && (mem.mode === 'pre' || mem.mode === 'post') && addr.base && addr.disp != null) {
      push({ op: OP.BIN, sub: 'add', dstReg: addr.base, dstBits: 64,
        srcs: [{ t: 'reg', reg: addr.base, bits: 64 }, { t: 'imm', value: addr.disp }] });
    }
    return out;
  }

  /* ── アドレス生成 ── */
  if (base === 'adrp' || base === 'adr') {
    push({ op: OP.ADDR, sub: base, dstReg: dstReg(), dstBits: 64,
      value: insn.pcRelTarget != null ? insn.pcRelTarget : null, srcs: [] });
    return out;
  }

  /* ── 比較 ── */
  if (base === 'cmp' || base === 'cmn' || base === 'tst') {
    push(Object.assign(flags(), {
      op: OP.CMP, sub: base === 'cmp' ? 'sub' : base === 'cmn' ? 'add' : 'and',
      bits: regBits(ops[0]),
      srcs: [opnd(ops[0]), opnd(ops[1])].filter(Boolean),
    }));
    return out;
  }
  if (base === 'ccmp' || base === 'ccmn') {
    const cond = ops.find((o) => o.k === 'cond');
    const fallback = ops.find((o, index) => index >= 2 && o.k === 'imm' && o.value != null);
    push(Object.assign(flags(), {
      op: OP.CMP, sub: base === 'ccmp' ? 'sub' : 'add', conditional: true,
      cond: cond ? cond.text : null, bits: regBits(ops[0]),
      fallbackNzcv: fallback ? Number(fallback.value & 0xfn) : null,
      srcs: [opnd(ops[0]), opnd(ops[1]), { t: 'reg', reg: 'nzcv', bits: 4 }].filter(Boolean),
    }));
    return out;
  }
  if (base === 'fcmp' || base === 'fcmpe') {
    push(Object.assign(flags(), {
      op: OP.CMP, sub: 'fsub', float: true, bits: regBits(ops[0]),
      srcs: [opnd(ops[0]), opnd(ops[1])].filter(Boolean),
    }));
    return out;
  }

  /* ── 条件つき選択 ── */
  if (SEL_OF[base]) {
    const cond = ops.find((o) => o.k === 'cond');
    const regOps = ops.filter((o) => o.k === 'reg' || o.k === 'imm');
    const srcs = [];
    if (base === 'cset' || base === 'csetm') {
      srcs.push({ t: 'imm', value: base === 'cset' ? 1n : -1n }, { t: 'imm', value: 0n });
    } else {
      srcs.push(opnd(regOps[1]) || { t: 'imm', value: 0n });
      srcs.push(opnd(regOps[2]) || opnd(regOps[1]) || { t: 'imm', value: 0n });
    }
    srcs.push({ t: 'reg', reg: 'nzcv', bits: 4 });
    push({ op: OP.SEL, sub: SEL_OF[base], cond: cond ? cond.text : null,
      dstReg: dstReg(), dstBits: dstBits(), srcs });
    return out;
  }

  /* ── mov 系 ── */
  if (base === 'mov' || base === 'movz' || base === 'movn' || base === 'fmov') {
    const src = opnd(ops[1]);
    if (!src) { push({ op: OP.UNKNOWN, dstReg: dstReg(), dstBits: dstBits(), srcs: [] }); return out; }
    if (base === 'movn' && src.t === 'imm' && src.value != null) {
      push({ op: OP.CONST, dstReg: dstReg(), dstBits: dstBits(),
        value: mask(~src.value, dstBits()), srcs: [] });
      return out;
    }
    if (src.t === 'imm' && src.value != null) {
      let v = src.value;
      if (src.shift && src.shift.op === 'lsl') v = v << BigInt(src.shift.amount || 0);
      push({ op: OP.CONST, dstReg: dstReg(), dstBits: dstBits(), value: mask(v, dstBits()), srcs: [] });
      return out;
    }
    push({ op: OP.MOV, dstReg: dstReg(), dstBits: dstBits(), srcs: [src] });
    return out;
  }
  if (base === 'movk') {
    const src = opnd(ops[1]);
    push({ op: OP.BFI, dstReg: dstReg(), dstBits: dstBits(),
      lsb: src && src.shift && src.shift.op === 'lsl' ? (src.shift.amount || 0) : 0, width: 16,
      srcs: [{ t: 'reg', reg: dstReg(), bits: dstBits() }, src || { t: 'imm', value: 0n }] });
    return out;
  }

  /* ── 掛けて足す ── */
  if (base === 'madd' || base === 'msub' || base === 'smaddl' || base === 'smsubl' ||
      base === 'umaddl' || base === 'umsubl') {
    push({ op: OP.MAC, sub: /sub/.test(base) ? 'msub' : 'madd',
      widen: /l$/.test(base) ? (base[0] === 's' ? 'signed' : 'unsigned') : null,
      dstReg: dstReg(), dstBits: dstBits(),
      srcs: [opnd(ops[3]), opnd(ops[1]), opnd(ops[2])].filter(Boolean) });
    return out;
  }

  /* ── ビット取り出し / 埋め込み ── */
  if (/^[su]bfx$/.test(base) || /^[su]bfiz$/.test(base) || base === 'bfxil' || base === 'bfi') {
    const lsb = ops[2] && ops[2].value != null ? Number(ops[2].value) : null;
    const width = ops[3] && ops[3].value != null ? Number(ops[3].value) : null;
    if (base === 'bfi' || base === 'bfxil') {
      push({ op: OP.BFI, dstReg: dstReg(), dstBits: dstBits(), lsb, width,
        srcs: [{ t: 'reg', reg: dstReg(), bits: dstBits() }, opnd(ops[1])].filter(Boolean) });
    } else {
      push({ op: OP.BFX, dstReg: dstReg(), dstBits: dstBits(), lsb, width,
        signed: base[0] === 's', toward: /iz$/.test(base) ? 'left' : 'right',
        srcs: [opnd(ops[1])].filter(Boolean) });
    }
    return out;
  }

  /* ── 単項 ── */
  if (UN_OF[base]) {
    push({ op: OP.UN, sub: UN_OF[base], dstReg: dstReg(), dstBits: dstBits(),
      srcs: [opnd(ops[1])].filter(Boolean) });
    if (/s$/.test(base) && base !== 'fabs') push(Object.assign(flags(), { op: OP.CMP, sub: 'sub', bits: dstBits(), srcs: [{ t: 'imm', value: 0n }, opnd(ops[1])].filter(Boolean) }));
    return out;
  }

  /* ── 二項 ── */
  if (BIN_OF[base]) {
    const a = opnd(ops[1]);
    const b = opnd(ops[2]);
    if (!a) { push({ op: OP.UNKNOWN, dstReg: dstReg(), dstBits: dstBits(), srcs: [] }); return out; }
    const inst = push({ op: OP.BIN, sub: BIN_OF[base], dstReg: dstReg(), dstBits: dstBits(),
      negate: base === 'mneg', srcs: b ? [a, b] : [a] });
    if (/s$/.test(base) && /^(adds|subs|ands)$/.test(base)) {
      push(Object.assign(flags(), { op: OP.CMP, sub: BIN_OF[base] === 'add' ? 'add' : BIN_OF[base] === 'and' ? 'and' : 'sub',
        bits: dstBits(), srcs: inst.srcs.slice() }));
    }
    return out;
  }

  /* ── 何も起きない命令 ── */
  if (/^(nop|hint|bti|paciasp|pacibsp|autiasp|autibsp|xpaclri|dmb|dsb|isb|prfm|yield|wfe|wfi|sev)$/.test(base)) {
    return out;
  }

  /* ── ここへ来たものは「分からない」。書き込み先だけ壊す。 ── */
  push({ op: OP.UNKNOWN, mnemonic: base,
    dstReg: (insn.writes && insn.writes.length) ? insn.writes[0] : null,
    dstBits: dstBits(),
    extraWrites: (insn.writes || []).slice(1),
    srcs: (insn.reads || []).map((r) => ({ t: 'reg', reg: r, bits: 64 })) });
  return out;
}

/* 呼び出しで壊れるレジスタ（AAPCS64）。 */
const CALL_CLOBBERS = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8',
  'x9', 'x10', 'x11', 'x12', 'x13', 'x14', 'x15', 'x16', 'x17', 'x30', 'nzcv'];

/* ── SSA ────────────────────────────────────────────────────── */

function immediateDominators(dominators, entry, count) {
  const idom = new Array(count).fill(-1);
  for (let b = 0; b < count; b++) {
    if (b === entry) continue;
    const dom = dominators[b];
    if (!dom || dom.size <= 1) continue;
    let best = -1, bestSize = -1;
    for (const d of dom) {
      if (d === b) continue;
      const size = dominators[d] ? dominators[d].size : 0;
      if (size > bestSize) { bestSize = size; best = d; }
    }
    idom[b] = best;
  }
  return idom;
}

function dominanceFrontiers(pred, idom, count) {
  const df = Array.from({ length: count }, () => new Set());
  for (let b = 0; b < count; b++) {
    const ps = pred[b] || [];
    if (ps.length < 2) continue;
    for (const p of ps) {
      let runner = p;
      let guard = 0;
      while (runner >= 0 && runner !== idom[b] && guard++ < count + 4) {
        df[runner].add(b);
        runner = idom[runner];
      }
    }
  }
  return df;
}

/* ── 本体 ───────────────────────────────────────────────────── */

let nextIrId = 1;

/**
 * 関数 1 つぶんの SSA 形式 IR を作る。
 *
 * @param {object} model buildSemanticModel の結果
 * @param {object} opts  { rowOfAddress(addr), cfg }
 * @returns {object|null} IR（命令が無ければ null）
 */
export function buildIR(model, opts) {
  const o = opts || {};
  if (!model || !model.instructions || !model.instructions.length) return null;
  const truncatedByBudget = model.instructions.length > MAX_INSTRUCTIONS;
  const insns = truncatedByBudget ? model.instructions.slice(0, MAX_INSTRUCTIONS) : model.instructions;

  // The CFG and lifted instruction universe must be identical. A full-function
  // CFG paired with a 6000-instruction IR creates successors/PHIs whose defining
  // instructions do not exist. Clip block metadata to the same final row and
  // deliberately ignore a caller-supplied full CFG when the IR budget truncates.
  const maxRow = insns.length ? insns[insns.length - 1].row : -1;
  const cfgModel = truncatedByBudget ? {
    ...model,
    instructions: insns,
    basicBlocks: (model.basicBlocks || []).filter((b) => b.startRow <= maxRow).map((b) => ({
      ...b, endRow: Math.min(b.endRow, maxRow),
      rows: Array.isArray(b.rows) ? b.rows.filter((r) => r <= maxRow) : b.rows,
    })),
    semantic: (model.semantic || []).filter((b) => b.startRow <= maxRow).map((b) => ({ ...b, endRow: Math.min(b.endRow, maxRow) })),
  } : model;
  const cfg = truncatedByBudget ? buildCfg(cfgModel, o) : (o.cfg || buildCfg(cfgModel, o));
  const nodes = cfg.nodes || [];
  if (!nodes.length) return null;

  const succ = nodes.map((n) => n.succ.filter((s) => s.to >= 0).map((s) => s.to));
  // buildCfg が既に計算していれば、それを使う（2 乗の計算を 2 回しない）
  const graph = cfg.graph && cfg.graph.predecessors && cfg.graph.dominators
    ? cfg.graph
    : analyzeGraph(succ, 0);
  const pred = graph.predecessors;
  const idom = immediateDominators(graph.dominators, 0, nodes.length);
  const df = dominanceFrontiers(pred, idom, nodes.length);

  const ir = {
    name: model.name || null,
    startAddress: model.startAddress || null,
    truncated: model.instructions.length > MAX_INSTRUCTIONS || !!model.truncated,
    values: [],
    instructions: [],
    blocks: nodes.map((n, i) => ({
      index: i, startRow: n.startRow, endRow: n.endRow,
      succ: succ[i], pred: pred[i] || [],
      idom: idom[i], insts: [], phis: [], memPhis: [],
      isEntry: i === 0, isExit: !!n.isExit, isLoopHeader: !!n.isLoopHeader,
    })),
    entry: 0,
    locations: new Map(),      // key → 場所の説明
    byRow: new Map(),          // row → IR 命令の配列
    args: new Map(),           // レジスタ名 → 入口の値
    reachable: graph.reachable,
    loops: graph.loops,
    idom,
    dominators: graph.dominators,
  };

  const newValue = (kind, extra) => {
    const v = Object.assign({
      id: ir.values.length, vid: nextIrId++, kind,
      reg: null, version: 0, bits: 64,
      def: null, uses: [],
      const: null, range: null, signed: null, nullable: null,
      type: null, label: null,
    }, extra || {});
    ir.values.push(v);
    return v;
  };
  ir.newValue = newValue;

  /* ── 1. 素の IR に持ち上げる ── */
  const rowToBlock = new Map();
  for (const b of ir.blocks) for (let r = b.startRow; r <= b.endRow; r++) rowToBlock.set(r, b.index);

  const lifted = ir.blocks.map(() => []);
  for (const insn of insns) {
    if (insn.data) continue;
    const bi = rowToBlock.get(insn.row);
    if (bi == null) continue;
    let parts;
    try { parts = lift(insn, o); } catch { parts = []; }
    for (const p of parts) {
      p.block = bi;
      p.insn = insn;
      lifted[bi].push(p);
    }
  }

  /* ── 2. どのレジスタがどのブロックで定義されるか ── */
  const defBlocks = new Map();     // reg → Set(block)
  const allRegs = new Set();
  const noteDef = (reg, bi) => {
    if (!reg) return;
    allRegs.add(reg);
    let s = defBlocks.get(reg);
    if (!s) { s = new Set(); defBlocks.set(reg, s); }
    s.add(bi);
  };
  for (let bi = 0; bi < lifted.length; bi++) {
    for (const p of lifted[bi]) {
      noteDef(p.dstReg, bi);
      for (const w of p.extraWrites || []) noteDef(w, bi);
      for (const c of p.clobbers || []) noteDef(c, bi);
      for (const s of p.srcs || []) if (s && s.t === 'reg') allRegs.add(s.reg);
    }
  }

  /* ── 3. 生きているレジスタだけに φ を置く（φ の爆発を防ぐ） ── */
  const liveIn = livenessOf(ir, lifted, allRegs);

  const phiSites = new Map();      // block → Map(reg → phi 命令)
  for (const [reg, blocks] of defBlocks) {
    const worklist = Array.from(blocks);
    const placed = new Set();
    let guard = 0;
    while (worklist.length && guard++ < nodes.length * MAX_PHI_ROUNDS) {
      const b = worklist.pop();
      for (const y of df[b] || []) {
        if (placed.has(y)) continue;
        placed.add(y);
        if (!graph.reachable.has(y)) continue;
        if (!liveIn[y] || !liveIn[y].has(reg)) continue;
        let m = phiSites.get(y);
        if (!m) { m = new Map(); phiSites.set(y, m); }
        /*
         * φ の**命令そのもの**をここで作っておく。
         *
         * 名前の付け替えは dominator tree を降りながら行うので、
         * 合流ブロックより先に、そこへ流れ込むブロックを通ることがある
         * （if の両側は、合流点より前に訪れる）。命令を訪問時に作っていたころ、
         * 先に通った側は「まだ φ が無い」と言って値を捨てていた。
         * その結果 φ の来た道が 1 本しか無く、合流した値が定数に潰れていた。
         */
        if (!m.has(reg)) {
          const inst = {
            id: ir.instructions.length, op: OP.PHI, block: y,
            row: ir.blocks[y].startRow, address: null, args: [], incoming: [], reg,
            text: 'phi ' + reg,
          };
          ir.instructions.push(inst);
          m.set(reg, { op: OP.PHI, block: y, reg, inst });
        }
        if (!blocks.has(y)) worklist.push(y);
      }
    }
  }

  /* ── 4. 名前を付け替える（dominator tree を降りながら） ── */
  const stacks = new Map();        // reg → 値のスタック
  const counter = new Map();
  const children = ir.blocks.map(() => []);
  for (let b = 0; b < ir.blocks.length; b++) if (idom[b] >= 0) children[idom[b]].push(b);

  for (const reg of allRegs) {
    const entryValue = newValue(VK.ARG, { reg, version: 0, label: reg, bits: reg === 'nzcv' ? 4 : 64 });
    ir.args.set(reg, entryValue);
    stacks.set(reg, [entryValue]);
    counter.set(reg, 0);
  }

  const topOf = (reg) => {
    const st = stacks.get(reg);
    if (st && st.length) return st[st.length - 1];
    const v = newValue(VK.UNDEF, { reg, label: reg });
    if (st) st.push(v); else stacks.set(reg, [v]);
    return v;
  };
  const pushDef = (reg, value) => {
    const n = (counter.get(reg) || 0) + 1;
    counter.set(reg, n);
    value.reg = reg;
    value.version = n;
    let st = stacks.get(reg);
    if (!st) { st = []; stacks.set(reg, st); }
    st.push(value);
    return value;
  };

  const resolve = (src) => {
    if (!src) return null;
    if (src.t === 'imm') {
      const v = newValue(VK.CONST, { const: src.value, bits: 64 });
      if (src.float != null) v.float = src.float;
      return { value: v, shift: src.shift || null, bits: src.bits || 64 };
    }
    if (src.t === 'cond') return { cond: src.cond };
    if (src.t === 'reg') return { value: topOf(src.reg), shift: src.shift || null, bits: src.bits || 64 };
    return null;
  };

  const emit = (p) => {
    const inst = {
      id: ir.instructions.length,
      op: p.op, sub: p.sub || null, block: p.block,
      row: p.row, address: p.address, text: p.text,
      args: [], dst: null, extra: p,
    };
    for (const s of p.srcs || []) {
      const r = resolve(s);
      if (!r) continue;
      if (r.cond) { inst.cond = r.cond; continue; }
      r.value.uses.push(inst);
      inst.args.push(r);
    }
    if (p.cond && !inst.cond) inst.cond = p.cond;
    // メモリ参照はここでベースと添字を解決する
    if (p.addr) {
      inst.addr = {
        base: p.addr.base ? topOf(p.addr.base) : null,
        baseReg: p.addr.base,
        disp: p.addr.disp,
        index: p.addr.index ? topOf(p.addr.index) : null,
        scale: p.addr.scale || 0,
        extend: p.addr.extend || null,
        size: p.addr.size,
        stack: !!p.addr.stack,
      };
      if (inst.addr.base) inst.addr.base.uses.push(inst);
      if (inst.addr.index) inst.addr.index.uses.push(inst);
    }
    if (p.dstReg) {
      const v = newValue(VK.DEF, { def: inst, bits: p.dstBits || 64 });
      inst.dst = v;
      pushDef(p.dstReg, v);
    }
    for (const w of p.extraWrites || []) {
      const v = newValue(VK.DEF, { def: inst, bits: 64 });
      pushDef(w, v);
    }
    for (const c of p.clobbers || []) {
      if (c === p.dstReg) continue;
      const v = newValue(VK.DEF, { def: inst, bits: 64, clobbered: true });
      pushDef(c, v);
    }
    ir.instructions.push(inst);
    ir.blocks[p.block].insts.push(inst);
    let list = ir.byRow.get(p.row);
    if (!list) { list = []; ir.byRow.set(p.row, list); }
    list.push(inst);
    return inst;
  };

  /*
   * 名前の付け替えは dominator tree を降りながら行う。
   * 再帰にするとブロックが 1500 を超える関数（The Battle Cats の巨大な更新処理）で
   * 呼び出し段数が足りなくなるので、明示スタックで回す。
   */
  renameIterative(ir, children, phiSites, lifted, stacks, emit, topOf, pushDef, newValue);

  /* ── 5. メモリ SSA ── */
  buildMemorySSA(ir, df, idom, children);

  /* ── 6. 値の性質（定数 / 範囲 / 符号 / null） ── */
  propagateValues(ir);
  inferSignedness(ir);
  recoverStackVariables(ir);

  ir.defUse = () => ir.values;
  return ir;
}

/* 名前の付け替え本体。dominator tree の行きと帰りで、値のスタックを積み下ろす。 */
function renameIterative(ir, children, phiSites, lifted, stacks, emit, topOf, pushDef, newValue) {
  const ENTER = 0, LEAVE = 1;
  const stack = [{ kind: ENTER, block: ir.entry }];
  const markStack = new Map();

  while (stack.length) {
    const job = stack.pop();
    if (job.kind === LEAVE) {
      for (const reg of markStack.get(job.block) || []) {
        const st = stacks.get(reg);
        if (st && st.length > 1) st.pop();
      }
      markStack.delete(job.block);
      continue;
    }
    const bi = job.block;
    const block = ir.blocks[bi];
    const marks = [];
    markStack.set(bi, marks);

    const phis = phiSites.get(bi);
    if (phis) {
      for (const [reg, phi] of phis) {
        const inst = phi.inst;
        const v = newValue(VK.PHI, { def: inst, bits: reg === 'nzcv' ? 4 : 64 });
        inst.dst = v;
        block.phis.push(inst);
        pushDef(reg, v);
        marks.push(reg);
      }
    }

    for (const p of lifted[bi]) {
      emit(p);
      if (p.dstReg) marks.push(p.dstReg);
      for (const w of p.extraWrites || []) marks.push(w);
      for (const c of p.clobbers || []) if (c !== p.dstReg) marks.push(c);
    }

    for (const s of block.succ) {
      const sphis = phiSites.get(s);
      if (!sphis) continue;
      for (const [reg, phi] of sphis) {
        if (!phi.inst) continue;
        const value = topOf(reg);
        phi.inst.incoming.push({ from: bi, value });
        phi.inst.args.push({ value });
        value.uses.push(phi.inst);
      }
    }

    stack.push({ kind: LEAVE, block: bi });
    const kids = children[bi] || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ kind: ENTER, block: kids[i] });
  }
}

/* ── 生存解析（φ を置く場所を絞るため） ────────────────────── */

function livenessOf(ir, lifted, allRegs) {
  const n = ir.blocks.length;
  const use = Array.from({ length: n }, () => new Set());
  const def = Array.from({ length: n }, () => new Set());
  for (let b = 0; b < n; b++) {
    for (const p of lifted[b]) {
      for (const s of p.srcs || []) {
        if (s && s.t === 'reg' && s.reg && !def[b].has(s.reg)) use[b].add(s.reg);
      }
      if (p.addr) {
        if (p.addr.base && !def[b].has(p.addr.base)) use[b].add(p.addr.base);
        if (p.addr.index && !def[b].has(p.addr.index)) use[b].add(p.addr.index);
      }
      if (p.dstReg) def[b].add(p.dstReg);
      for (const w of p.extraWrites || []) def[b].add(w);
      for (const c of p.clobbers || []) def[b].add(c);
    }
  }
  const liveIn = Array.from({ length: n }, () => new Set());
  const liveOut = Array.from({ length: n }, () => new Set());
  for (let round = 0; round < n * 2 + 8; round++) {
    let changed = false;
    for (let b = n - 1; b >= 0; b--) {
      const out = new Set();
      for (const s of ir.blocks[b].succ) for (const r of liveIn[s]) out.add(r);
      const inn = new Set(use[b]);
      for (const r of out) if (!def[b].has(r)) inn.add(r);
      if (inn.size !== liveIn[b].size || out.size !== liveOut[b].size) changed = true;
      liveIn[b] = inn; liveOut[b] = out;
    }
    if (!changed) break;
  }
  void allRegs;
  return liveIn;
}

/* ── Memory SSA ─────────────────────────────────────────────────
 *
 * メモリを 1 本の大きな配列として扱うと、`self->hp` の store と
 * `other->coins` の load が同じ版を見ることになり、何も言えなくなる。
 * ここでは「場所」に分けて版を振る。
 *
 *   stack:-0x18        sp / fp から固定オフセット      → ローカル変数
 *   field:<値id>+0x20  ある SSA 値 + 固定オフセット    → オブジェクトのフィールド
 *   global:0x1009...   固定アドレス
 *   unknown            添字が実行時に決まるなど        → ここは触ると全部壊れる
 */

function locationOf(inst) {
  const a = inst.addr;
  if (!a) return null;
  const size = Number(a.size || inst.extra?.size || 0) || 0;
  // Unknown/indexed addresses are may-alias locations, never one shared
  // must-alias bucket. A unique key prevents unrelated unknown loads/stores
  // from fabricating a reaching-store edge (#358).
  if (a.index || a.disp == null || !a.base) return { key: `unknown:${inst.id}`, kind: MK.UNKNOWN, size };
  if (a.stack) {
    const baseReg = a.baseReg || a.base?.reg || 'stack';
    const frameEpoch = a.base?.id ?? -1;
    return {
      key: `stack:${baseReg}:e${frameEpoch}:${a.disp.toString()}:s${size}`,
      kind: MK.STACK, baseReg, frameEpoch, disp: a.disp, size,
    };
  }
  const base = a.base;
  if (base.const != null) {
    const addr = base.const + a.disp;
    return { key: 'global:' + addr.toString(16) + ':s' + size, kind: MK.GLOBAL, address: addr, size };
  }
  return {
    key: 'field:' + base.id + '+' + a.disp.toString() + ':s' + size,
    kind: MK.FIELD, base, disp: a.disp, size,
  };
}

/** 2 つの場所が同じ番地を指しうるか。「別」と言い切れるときだけ false。 */
export function mayAlias(a, b) {
  if (!a || !b) return true;
  if (a.key === b.key) return true;
  if (a.kind === MK.UNKNOWN || b.kind === MK.UNKNOWN) return true;
  if (a.kind !== b.kind) {
    // stack と global は決して重ならない。field は何にでも化けうる。
    if (a.kind === MK.FIELD || b.kind === MK.FIELD) return true;
    return false;
  }
  if (a.kind === MK.STACK || a.kind === MK.GLOBAL) {
    if (a.kind === MK.STACK && (a.baseReg !== b.baseReg || a.frameEpoch !== b.frameEpoch)) return true;
    const pa = a.kind === MK.STACK ? a.disp : a.address;
    const pb = b.kind === MK.STACK ? b.disp : b.address;
    if (pa == null || pb == null) return true;
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(pa + sa <= pb || pb + sb <= pa);
  }
  // field 同士: ベースが同じ SSA 値なら、オフセットの重なりだけで判定できる
  if (a.base && b.base && a.base.id === b.base.id) {
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(a.disp + sa <= b.disp || b.disp + sb <= a.disp);
  }
  return true;
}

/**
 * A concrete store may *define/clobber* another Memory-SSA range only when
 * overlap is established, not merely possible. mayAlias() intentionally answers
 * conservatively for query safety (e.g. an object pointer could theoretically
 * point at a stack slot); using that predicate for every store destroys stack
 * promotion. Unknown-address stores remain conservative and clobber all ranges.
 */
function storeOverlapsRange(storeLoc, otherLoc) {
  if (!storeLoc || !otherLoc) return true;
  if (storeLoc.kind === MK.UNKNOWN) return true;
  if (otherLoc.kind === MK.UNKNOWN) return false;
  if (storeLoc.kind !== otherLoc.kind) return false;
  const overlap = (pa, sa, pb, sb) => !(pa + sa <= pb || pb + sb <= pa);
  const sa=BigInt(storeLoc.size || 8), sb=BigInt(otherLoc.size || 8);
  if (storeLoc.kind === MK.GLOBAL) {
    if (storeLoc.address == null || otherLoc.address == null) return false;
    return overlap(storeLoc.address,sa,otherLoc.address,sb);
  }
  if (storeLoc.kind === MK.STACK) {
    if (storeLoc.baseReg !== otherLoc.baseReg || storeLoc.frameEpoch !== otherLoc.frameEpoch) return false;
    if (storeLoc.disp == null || otherLoc.disp == null) return false;
    return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
  }
  if (storeLoc.kind === MK.FIELD) {
    if (!storeLoc.base || !otherLoc.base || storeLoc.base.id !== otherLoc.base.id) return false;
    if (storeLoc.disp == null || otherLoc.disp == null) return false;
    return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
  }
  return false;
}

function buildMemorySSA(ir, df, idom, children) {
  const locs = new Map();
  const defSites = new Map();      // key → Set(block)
  const clobberInsts = [];

  const register = (loc) => {
    if (!locs.has(loc.key)) locs.set(loc.key, loc);
    return locs.get(loc.key);
  };

  for (const inst of ir.instructions) {
    if (inst.op === OP.LOAD || inst.op === OP.STORE) {
      const loc = locationOf(inst);
      if (!loc) continue;
      inst.loc = register(loc);
    } else if (inst.op === OP.CALL || inst.op === OP.UNKNOWN) {
      clobberInsts.push(inst);
    }
  }
  // Every store defines its exact range and clobbers every registered range it
  // may overlap. This is what makes byte/halfword stores kill wider reaching
  // loads without pretending the partial store supplied the entire value (#359).
  for (const inst of ir.instructions) {
    if (inst.op !== OP.STORE || !inst.loc) continue;
    for (const [key, loc] of locs) {
      if (!storeOverlapsRange(inst.loc, loc)) continue;
      let defs = defSites.get(key);
      if (!defs) { defs = new Set(); defSites.set(key, defs); }
      defs.add(inst.block);
    }
  }

  ir.locations = locs;

  /*
   * スタックのうち「アドレスを外へ渡していない」ものは、呼び出しで壊れない。
   * add x0, sp, #0x18 のように番地そのものを作って渡していたら、そこは壊れる。
   */
  const escapedStack = new Set();
  for (const inst of ir.instructions) {
    if (inst.op !== OP.BIN || inst.sub !== 'add') continue;
    const baseArg = inst.args[0];
    if (!baseArg || !baseArg.value) continue;
    if (baseArg.value.reg !== 'sp' && baseArg.value.reg !== 'x29') continue;
    const uses = inst.dst ? inst.dst.uses : [];
    if (uses.some((u) => u.op === OP.CALL || u.op === OP.STORE || u.op === OP.UNKNOWN)) {
      escapedStack.add('*');
    }
  }

  // 呼び出しは、スタック以外のすべてと、番地が漏れたスタックを壊す
  for (const inst of clobberInsts) {
    for (const [key, loc] of locs) {
      if (loc.kind === MK.STACK && !escapedStack.has('*')) continue;
      let s = defSites.get(key);
      if (!s) { s = new Set(); defSites.set(key, s); }
      s.add(inst.block);
      if (!inst.memKills) inst.memKills = [];
      inst.memKills.push(loc);
    }
  }

  // 場所ごとに φ を置いて版を振る
  const phiFor = new Map();        // block → Map(key → phi)
  for (const [key, blocks] of defSites) {
    const worklist = Array.from(blocks);
    const placed = new Set();
    let guard = 0;
    while (worklist.length && guard++ < ir.blocks.length * 8 + 32) {
      const b = worklist.pop();
      for (const y of df[b] || []) {
        if (placed.has(y)) continue;
        placed.add(y);
        let m = phiFor.get(y);
        if (!m) { m = new Map(); phiFor.set(y, m); }
        if (!m.has(key)) m.set(key, { key, block: y, incoming: [] });
        if (!blocks.has(y)) worklist.push(y);
      }
    }
  }

  const stacks = new Map();
  for (const key of locs.keys()) stacks.set(key, [{ kind: 'entry', key }]);
  const top = (key) => {
    const st = stacks.get(key);
    return st && st.length ? st[st.length - 1] : { kind: 'entry', key };
  };

  const ENTER = 0, LEAVE = 1;
  const stack = [{ kind: ENTER, block: ir.entry }];
  const marks = new Map();
  while (stack.length) {
    const job = stack.pop();
    if (job.kind === LEAVE) {
      for (const key of marks.get(job.block) || []) {
        const st = stacks.get(key);
        if (st && st.length > 1) st.pop();
      }
      marks.delete(job.block);
      continue;
    }
    const bi = job.block;
    const mark = [];
    marks.set(bi, mark);

    const phis = phiFor.get(bi);
    if (phis) {
      for (const [key, phi] of phis) {
        const node = { kind: 'phi', key, block: bi, incoming: phi.incoming };
        ir.blocks[bi].memPhis.push(node);
        stacks.get(key).push(node);
        mark.push(key);
        phi.node = node;
      }
    }

    for (const inst of ir.blocks[bi].insts) {
      if (inst.op === OP.LOAD && inst.loc) {
        inst.memUse = top(inst.loc.key);
        // 「その場所を最後に書いたのは誰か」— これが store → load の辺
        if (inst.memUse && inst.memUse.kind === 'store') inst.reachingStore = inst.memUse.inst;
      } else if (inst.op === OP.STORE && inst.loc) {
        for (const [key, loc] of locs) {
          if (!storeOverlapsRange(inst.loc, loc)) continue;
          const exact = inst.loc.kind !== MK.UNKNOWN && key === inst.loc.key;
          const node = exact
            ? { kind: 'store', key, inst, block: bi, prev: top(key) }
            : { kind: 'clobber', key, inst, block: bi, reason: 'overlap-store', unknownAlias: inst.loc.kind === MK.UNKNOWN };
          if (exact) inst.memDef = node;
          stacks.get(key).push(node);
          mark.push(key);
        }
      } else if (inst.memKills) {
        for (const loc of inst.memKills) {
          const node = { kind: 'clobber', key: loc.key, inst, block: bi };
          stacks.get(loc.key).push(node);
          mark.push(loc.key);
        }
      }
    }

    for (const s of ir.blocks[bi].succ) {
      const sphis = phiFor.get(s);
      if (!sphis) continue;
      for (const [key, phi] of sphis) {
        if (phi.node) phi.node.incoming.push({ from: bi, node: top(key) });
      }
    }

    stack.push({ kind: LEAVE, block: bi });
    const kids = children[bi] || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ kind: ENTER, block: kids[i] });
  }
  void idom;
}

/* ── 定数の伝播と範囲 ────────────────────────────────────────── */

function applyShift(v, shift, bits) {
  if (v == null || !shift) return v;
  const n = BigInt(shift.amount || 0);
  switch (shift.op) {
    case 'lsl': return mask(v << n, bits);
    case 'lsr': return mask(mask(v, bits) >> n, bits);
    case 'asr': return mask(signedOf(mask(v, bits), bits) >> n, bits);
    case 'uxtb': return mask(v & 0xffn, bits);
    case 'uxth': return mask(v & 0xffffn, bits);
    case 'uxtw': return mask(v & 0xffffffffn, bits);
    case 'sxtb': return mask(BigInt.asIntN(8, v), bits);
    case 'sxth': return mask(BigInt.asIntN(16, v), bits);
    case 'sxtw': return mask(BigInt.asIntN(32, v), bits);
    default: return null;
  }
}

function argConst(a, bits) {
  if (!a || !a.value) return null;
  let v = a.value.const;
  if (v == null) return null;
  if (a.shift) v = applyShift(v, a.shift, bits || 64);
  return v;
}

function foldBin(sub, a, b, bits) {
  if (a == null || b == null) return null;
  const sa = signedOf(mask(a, bits), bits);
  const sb = signedOf(mask(b, bits), bits);
  switch (sub) {
    case 'add': return mask(a + b, bits);
    case 'sub': return mask(a - b, bits);
    case 'mul': return mask(a * b, bits);
    case 'sdiv': return sb === 0n ? 0n : mask(sa / sb, bits);
    case 'udiv': return mask(b, bits) === 0n ? 0n : mask(mask(a, bits) / mask(b, bits), bits);
    case 'and': return mask(a & b, bits);
    case 'or': return mask(a | b, bits);
    case 'xor': return mask(a ^ b, bits);
    case 'bic': return mask(a & ~b, bits);
    case 'orn': return mask(a | ~b, bits);
    case 'eon': return mask(~(a ^ b), bits);
    case 'shl': { const sh = mask(b, bits) & BigInt(bits === 32 ? 31 : 63); return mask(a << sh, bits); }
    case 'lshr': { const sh = mask(b, bits) & BigInt(bits === 32 ? 31 : 63); return mask(mask(a, bits) >> sh, bits); }
    case 'ashr': { const sh = mask(b, bits) & BigInt(bits === 32 ? 31 : 63); return mask(sa >> sh, bits); }
    case 'smull': return mask(BigInt.asIntN(32, a) * BigInt.asIntN(32, b), 64);
    case 'umull': return mask((a & 0xffffffffn) * (b & 0xffffffffn), 64);
    default: return null;
  }
}

function foldUn(sub, a, bits) {
  if (a == null) return null;
  switch (sub) {
    case 'neg': return mask(-a, bits);
    case 'not': return mask(~a, bits);
    case 'sxt8': return mask(BigInt.asIntN(8, a), bits);
    case 'sxt16': return mask(BigInt.asIntN(16, a), bits);
    case 'sxt32': return mask(BigInt.asIntN(32, a), bits);
    case 'uxt8': return mask(a & 0xffn, bits);
    case 'uxt16': return mask(a & 0xffffn, bits);
    case 'uxt32': return mask(a & 0xffffffffn, bits);
    case 'fmov': return a;
    default: return null;
  }
}

/**
 * SSA 全体に定数を流す。ワークリスト方式。
 * load は「届いている store が定数を書いていた」ときだけ値を受け取る。
 */
function propagateValues(ir) {
  /*
   * ワークリストは先頭から読むが、shift() は使わない。
   * 配列の shift() は 1 回ごとに全体をずらすので、1 万命令の関数で
   * 2 乗の時間になる（実測で 1 関数に 1 秒かかっていた）。
   * 読み取り位置を進めるだけにして、伸びきったら前を捨てる。
   */
  const queue = ir.instructions.slice();
  let head = 0;
  let guard = ir.instructions.length * 6 + 64;

  const setConst = (value, c) => {
    if (!value || c == null) return false;
    const v = mask(c, value.bits || 64);
    if (value.const != null && value.const === v) return false;
    value.const = v;
    value.kind = value.kind === VK.PHI ? VK.PHI : value.kind;
    for (const u of value.uses) queue.push(u);
    return true;
  };

  while (head < queue.length && guard-- > 0) {
    const inst = queue[head++];
    if (head > 4096 && head * 2 > queue.length) { queue.splice(0, head); head = 0; }
    if (!inst || !inst.dst) continue;
    const bits = inst.dst.bits || 64;
    switch (inst.op) {
      case OP.CONST: setConst(inst.dst, inst.extra ? inst.extra.value : null); break;
      case OP.ADDR: setConst(inst.dst, inst.extra ? inst.extra.value : null); break;
      case OP.MOV: setConst(inst.dst, argConst(inst.args[0], bits)); break;
      case OP.BIN: {
        const a = argConst(inst.args[0], bits);
        const b = inst.args.length > 1 ? argConst(inst.args[1], bits) : 0n;
        const folded = foldBin(inst.sub, a, b, bits);
        if (folded != null) setConst(inst.dst, inst.extra && inst.extra.negate ? mask(-folded, bits) : folded);
        break;
      }
      case OP.UN: setConst(inst.dst, foldUn(inst.sub, argConst(inst.args[0], bits), bits)); break;
      case OP.MAC: {
        const addend = argConst(inst.args[0], bits);
        let a = argConst(inst.args[1], bits);
        let b = argConst(inst.args[2], bits);
        if (addend != null && a != null && b != null) {
          if (inst.extra?.widen === 'signed') { a = BigInt.asIntN(32, a); b = BigInt.asIntN(32, b); }
          else if (inst.extra?.widen === 'unsigned') { a = BigInt.asUintN(32, a); b = BigInt.asUintN(32, b); }
          setConst(inst.dst, mask(inst.sub === 'msub' ? addend - a * b : addend + a * b, bits));
        }
        break;
      }
      case OP.LOAD: {
        const store = inst.reachingStore;
        if (store && store.args[0] && store.args[0].value && store.args[0].value.const != null) {
          if (!inst.extra || !inst.extra.signed) setConst(inst.dst, store.args[0].value.const);
          else setConst(inst.dst, mask(signedOf(mask(store.args[0].value.const, (inst.extra.size || 8) * 8), (inst.extra.size || 8) * 8), bits));
        }
        break;
      }
      case OP.PHI: {
        let c = null, same = true;
        for (const a of inst.args) {
          const v = a.value ? a.value.const : null;
          if (v == null) { same = false; break; }
          if (c == null) c = v; else if (c !== v) { same = false; break; }
        }
        if (same && c != null && inst.args.length) setConst(inst.dst, c);
        break;
      }
      case OP.SEL: {
        const a = argConst(inst.args[0], bits);
        const b = argConst(inst.args[1], bits);
        if (a != null && b != null && a === b && inst.sub === 'sel') setConst(inst.dst, a);
        break;
      }
      default: break;
    }
  }

  // ベースが定数になった load / store は、場所を global として読み直す
  for (const inst of ir.instructions) {
    if (!inst.addr || !inst.addr.base) continue;
    if (inst.addr.base.const == null || inst.addr.disp == null) continue;
    inst.globalAddress = inst.addr.base.const + inst.addr.disp;
  }
}

/* ── 符号と null の伝播 ─────────────────────────────────────── */

function inferSignedness(ir) {
  for (const inst of ir.instructions) {
    if (!inst.dst) continue;
    if (inst.op === OP.LOAD) {
      // Plain LDR has no signedness evidence. Only sign-extending load opcodes
      // may positively mark the SSA value signed; absence of that flag is unknown.
      if (inst.extra && inst.extra.signed === true) inst.dst.signed = true;
    }
    else if (inst.op === OP.BIN) {
      if (inst.sub === 'sdiv' || inst.sub === 'ashr' || inst.sub === 'smull' || inst.sub === 'smulh') inst.dst.signed = true;
      else if (inst.sub === 'udiv' || inst.sub === 'lshr' || inst.sub === 'umull' || inst.sub === 'umulh') inst.dst.signed = false;
    } else if (inst.op === OP.UN) {
      if (/^sxt/.test(inst.sub || '')) inst.dst.signed = true;
      else if (/^uxt/.test(inst.sub || '')) inst.dst.signed = false;
    } else if (inst.op === OP.BFX) inst.dst.signed = !!(inst.extra && inst.extra.signed);
  }
  // 比較の条件コードからも符号が分かる
  for (const inst of ir.instructions) {
    if (inst.op !== OP.CBR || inst.extra.kind !== 'cond') continue;
    const info = COND[inst.cond];
    if (!info || info.signed == null) continue;
    const flagsValue = inst.args[0] && inst.args[0].value;
    const cmp = flagsValue && flagsValue.def;
    if (!cmp || cmp.op !== OP.CMP) continue;
    for (const a of cmp.args) {
      if (a.value && a.value.signed == null && a.value.kind !== VK.CONST) a.value.signed = info.signed;
    }
  }
  // cbz / cbnz は「null かもしれない値」を教えてくれる
  for (const inst of ir.instructions) {
    if (inst.op !== OP.CBR) continue;
    if (inst.extra.kind !== 'cbz' && inst.extra.kind !== 'cbnz') continue;
    const v = inst.args[0] && inst.args[0].value;
    if (v) v.nullable = true;
  }
}

/* ── スタック変数の復元 ─────────────────────────────────────── */

/**
 * sp / fp からの固定オフセットに、番号付きの名前を与える。
 * ここで名前を作るが、これは人に見せる名前ではなく識別子（var_18 など）。
 */
function recoverStackVariables(ir) {
  const slots = new Map();
  for (const [key, loc] of ir.locations) {
    if (loc.kind !== MK.STACK) continue;
    slots.set(key, {
      key, baseReg: loc.baseReg || 'stack', frameEpoch: loc.frameEpoch ?? -1, disp: loc.disp, size: loc.size || 8,
      reads: 0, writes: 0, name: null, escapes: false,
    });
  }
  for (const inst of ir.instructions) {
    if (!inst.loc) continue;
    const slot = slots.get(inst.loc.key);
    if (!slot) continue;
    if (inst.op === OP.LOAD) slot.reads++;
    else if (inst.op === OP.STORE) slot.writes++;
  }
  const ordered = Array.from(slots.values()).sort((a, b) => {
    const da = a.disp == null ? 0n : a.disp;
    const db = b.disp == null ? 0n : b.disp;
    return da < db ? -1 : da > db ? 1 : 0;
  });
  // Keep the long-standing compact name when it is unambiguous. Identity is
  // still the full base+epoch+signed-displacement key; only collisions need the
  // disambiguating display suffix. This preserves existing UI/API names without
  // reintroducing the +/- displacement collision fixed by #137.
  const displayGroups = new Map();
  for (const s of ordered) {
    const disp = s.disp == null ? 0n : s.disp;
    const d = disp < 0n ? -disp : disp;
    const legacy = `var_${d.toString(16)}`;
    if (!displayGroups.has(legacy)) displayGroups.set(legacy, []);
    displayGroups.get(legacy).push(s);
  }
  for (const [legacy, group] of displayGroups) {
    if (group.length === 1) { group[0].name = legacy; continue; }
    for (const s of group) {
      const disp = s.disp == null ? 0n : s.disp;
      const d = disp < 0n ? -disp : disp;
      const sign = disp < 0n ? 'm' : 'p';
      const base = String(s.baseReg || 'stack').replace(/[^A-Za-z0-9_]/g, '_');
      s.name = `var_${base}_e${s.frameEpoch}_${sign}${d.toString(16)}`;
    }
  }
  ir.stackSlots = ordered;
  for (const inst of ir.instructions) {
    if (inst.loc && slots.has(inst.loc.key)) inst.slot = slots.get(inst.loc.key);
  }
}

/* ── 使う側のための入口 ─────────────────────────────────────── */

/*
 * 同じ関数の IR を、画面のあちこちが何度も組み直さないようにする。
 * モデルは解析ごとに作り直されるので、WeakMap で持てば勝手に消える。
 */
const irCache = new WeakMap();

/**
 * モデルから IR を得る（作れなければ null）。落ちない。
 * ここが panels.js / role.js / pinpoint.js から呼ぶ唯一の入口。
 */
export function irFor(model, opts) {
  if (!model || !model.instructions || !model.instructions.length) return null;
  if (irCache.has(model)) return irCache.get(model);
  let ir = null;
  try { ir = buildIR(model, opts); } catch { ir = null; }
  irCache.set(model, ir);
  return ir;
}

/* ── 使う側のための問い合わせ ───────────────────────────────── */

/** その値を作った命令をたどって、根っこ（引数・定数・load）まで戻る。 */
export function definitionChain(value, limit = 32) {
  const out = [];
  const seen = new Set();
  let cur = value;
  while (cur && out.length < limit && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    const def = cur.def;
    if (!def) break;
    if (def.op === OP.MOV && def.args[0]) { cur = def.args[0].value; continue; }
    break;
  }
  return out;
}

/** 「この場所を書いている命令」を全部返す。Memory SSA の版から拾う。 */
export function writersOf(ir, locKey) {
  const out = [];
  for (const inst of ir.instructions) {
    if (inst.op === OP.STORE && inst.loc && inst.loc.key === locKey) out.push(inst);
  }
  return out;
}

/** 「この場所を読んでいる命令」。 */
export function readersOf(ir, locKey) {
  const out = [];
  for (const inst of ir.instructions) {
    if (inst.op === OP.LOAD && inst.loc && inst.loc.key === locKey) out.push(inst);
  }
  return out;
}

/**
 * 「読んで、計算して、同じ場所へ書き戻す」を見つける。
 * これは `self->coins += n` の形そのもので、role.js / pinpoint.js の要になる。
 *
 * @returns [{ load, store, chain, location, kind }]
 */
export function readModifyWrite(ir) {
  const out = [];
  for (const store of ir.instructions) {
    if (store.op !== OP.STORE || !store.loc) continue;
    const written = store.args[0] && store.args[0].value;
    if (!written) continue;
    const chain = [];
    const seen = new Set();
    const stack = [written];
    let load = null;
    while (stack.length && chain.length < 24) {
      const v = stack.pop();
      if (!v || seen.has(v.id)) continue;
      seen.add(v.id);
      const def = v.def;
      if (!def) continue;
      chain.push(def);
      if (def.op === OP.LOAD && def.loc && !mayAliasStrict(def.loc, store.loc)) continue;
      if (def.op === OP.LOAD && def.loc && def.loc.key === store.loc.key) { load = def; continue; }
      for (const a of def.args) if (a.value) stack.push(a.value);
    }
    if (!load) continue;
    out.push({
      load, store, location: store.loc,
      chain: chain.filter((c) => c !== load && c.op !== OP.STORE),
      kind: classifyUpdate(chain),
    });
  }
  return out;
}

function mayAliasStrict(a, b) { return a.key === b.key; }

function classifyUpdate(chain) {
  const ops = chain.map((c) => (c.op === OP.BIN ? c.sub : c.op));
  if (ops.includes('add')) return 'add';
  if (ops.includes('sub')) return 'sub';
  if (ops.includes('mul')) return 'mul';
  if (ops.includes('sdiv') || ops.includes('udiv')) return 'div';
  if (ops.includes(OP.SEL)) return 'clamp';
  if (ops.length === 0) return 'copy';
  return 'other';
}

/* ── 表示（テストと目視のため） ─────────────────────────────── */

function valueName(v) {
  if (!v) return '?';
  if (v.const != null) return '0x' + v.const.toString(16);
  if (v.kind === VK.ARG) return v.reg;
  if (v.kind === VK.UNDEF) return '⊥';
  return '%' + (v.reg || 'v') + '.' + v.version;
}

export function irText(ir, opts) {
  const o = opts || {};
  const lines = [];
  for (const b of ir.blocks) {
    lines.push('b' + b.index + ':' + (b.pred.length ? '  ; preds ' + b.pred.map((p) => 'b' + p).join(',') : ''));
    for (const phi of b.phis) {
      lines.push('  ' + valueName(phi.dst) + ' = phi ' +
        phi.incoming.map((i) => 'b' + i.from + ':' + valueName(i.value)).join(', '));
    }
    for (const inst of b.insts) {
      lines.push('  ' + instText(inst));
    }
  }
  if (o.slots && ir.stackSlots && ir.stackSlots.length) {
    lines.push('; stack: ' + ir.stackSlots.map((s) => s.name + '(' + s.reads + 'r/' + s.writes + 'w)').join(' '));
  }
  return lines.join('\n');
}

export function instText(inst) {
  const a = (i) => {
    const arg = inst.args[i];
    if (!arg) return '?';
    const base = valueName(arg.value);
    return arg.shift ? base + ' ' + arg.shift.op + ' ' + (arg.shift.amount || 0) : base;
  };
  const dst = inst.dst ? valueName(inst.dst) + ' = ' : '';
  switch (inst.op) {
    case OP.CONST: return dst + '0x' + (inst.extra.value == null ? '?' : inst.extra.value.toString(16));
    case OP.ADDR: return dst + 'addr 0x' + (inst.extra.value == null ? '?' : inst.extra.value.toString(16));
    case OP.MOV: return dst + a(0);
    case OP.BIN: return dst + a(0) + ' ' + inst.sub + ' ' + a(1);
    case OP.UN: return dst + inst.sub + '(' + a(0) + ')';
    case OP.MAC: return dst + a(0) + (inst.sub === 'msub' ? ' - ' : ' + ') + a(1) + '*' + a(2);
    case OP.CMP: return dst + 'cmp.' + inst.sub + ' ' + a(0) + ', ' + a(1);
    case OP.SEL: return dst + 'sel.' + inst.cond + ' ' + a(0) + ', ' + a(1);
    case OP.LOAD: return dst + 'load ' + (inst.loc ? inst.loc.key : '?') +
      (inst.reachingStore ? ' <- store@' + inst.reachingStore.row : '');
    case OP.STORE: return 'store ' + (inst.loc ? inst.loc.key : '?') + ' <- ' + a(0);
    case OP.CALL: return dst + 'call ' + (inst.extra.target != null ? '0x' + inst.extra.target.toString(16) : 'indirect');
    case OP.CBR: return 'cbr.' + (inst.cond || inst.extra.kind) + ' ' + (inst.args.length ? a(0) : '') +
      (inst.extra.target != null ? ' -> 0x' + inst.extra.target.toString(16) : '');
    case OP.BR: return 'br' + (inst.extra.target != null ? ' 0x' + inst.extra.target.toString(16) : ' indirect');
    case OP.RET: return 'ret';
    case OP.PHI: return dst + 'phi';
    case OP.UNKNOWN: return dst + 'unknown(' + (inst.extra.mnemonic || '') + ')';
    default: return inst.op;
  }
}

export { valueName };
