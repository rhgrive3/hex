/*
 * 式の復元 — 命令の列を、1 本の「計算」に戻す層。
 *
 * これまでこのツールは、命令を 1 行ずつ正確に説明できた。できなかったのは
 * **数行をまとめて 1 つの意味にする**ことで、そのせいで画面にはこう出ていた。
 *
 *     x8 = (int32)x25 * (int32)x0;
 *     x9 |= 0xA3D7 << 48;
 *     __asm("smulh x8, x8, x9");
 *     __asm("smaddl x8, w25, w0, x8");
 *     x25 = (x8 >> 6) + (x8 >> 63);
 *
 * 5 行のうち 4 行が意味を持たない中間結果で、読む人は何も受け取れない。
 * この 5 行が言っているのは、たった 1 つのことでしかない。
 *
 *     x25 = x25 * x0 / 100;
 *
 * ここはその変換を担う。やることは 3 つ。
 *
 *   1. 値の出どころをレジスタではなく **値そのもの** で持つ（SSA 風の値グラフ）。
 *      x8 が何回上書きされようと、「この行の x8」は 1 つの値に決まる。
 *   2. その値を式の木にして、代数と **コンパイラの定型** で畳む。
 *      定数の掛け算、シフトでの掛け算、魔法数による割り算、余り、飽和…
 *   3. 読める形の文字列にする。
 *
 * 2 の「コンパイラの定型」がこの層の肝になる。割り算は遅いので、コンパイラは
 * `n / 100` を「魔法数を掛けて上位を取って右へずらす」に置き換える。元が割り算
 * だったことは、掛けている数と、ずらし幅から **逆算で確かめられる** — 推測ではない。
 * ここを知らないと、割り算をしている関数はすべて「よく分からない掛け算」に見える。
 *
 * きまりは他のファイルと同じ。日本語は 1 文字も作らない。作るのは構造と式だけ。
 * 分からないものは opaque なノード（レジスタ名のまま）で残す。埋めない。
 */

/* ────────────────────────────────────────────────────────────
   ノード
   ──────────────────────────────────────────────────────────── */

/*
 * k:
 *   const   定数            v: BigInt
 *   arg     関数の引数      n: 0..7
 *   reg     出どころ不明    reg, row  ← いちばん大事。埋めないための逃げ場
 *   mem     メモリの中身    baseReg, base(ノード), disp, index, scale, size, signed, stack
 *   call    呼び出しの戻り値 row, name, target, args, sel
 *   addr    アドレス        addr, sym
 *   str     文字列          addr, text
 *   bin     二項演算        op, a, b
 *   un      単項演算        op, a
 *   sel     条件で選ぶ      cc, a, b, cmp
 */

const MAX_DEPTH = 22;      // これより深い木は読めないので、途中で切って reg に戻す
const MAX_NODES = 160;     // 1 つの式が抱えてよいノード数

function node(k, extra) { return Object.assign({ k }, extra); }

export function constNode(v) { return node('const', { v: BigInt(v) }); }
export function floatNode(v, bits = 64) {
  const value = Number(v);
  return Number.isFinite(value) ? node('float', { v: value, bits: Number(bits || 64) }) : null;
}
export function regNode(reg, row) { return node('reg', { reg, row: row == null ? -1 : row }); }

const ZERO = constNode(0n);

export function isConst(n) { return !!n && n.k === 'const'; }
export function constOf(n) { return n && n.k === 'const' ? n.v : null; }

/** 木の大きさ。深すぎる式を切り捨てるのに使う。 */
export function sizeOf(n, seen) {
  if (!n) return 0;
  const s = seen || new Set();
  if (s.has(n)) return 0;
  s.add(n);
  let total = 1;
  for (const c of childrenOf(n)) total += sizeOf(c, s);
  return total;
}

function childrenOf(n) {
  if (!n) return [];
  switch (n.k) {
    case 'bin': return [n.a, n.b];
    case 'un': return [n.a];
    case 'sel': return [n.a, n.b].concat(n.predicate ? [n.predicate] : [], n.cmp ? [n.cmp.a, n.cmp.b].filter(Boolean) : []);
    case 'flagcond': return [n.a, n.b].filter(Boolean);
    case 'mem': return [n.base, n.index].filter(Boolean);
    case 'call': return (n.args || []).map((a) => a.value).filter(Boolean);
    default: return [];
  }
}

function depthOf(n, d) {
  if (!n || d > MAX_DEPTH) return d;
  let max = d;
  for (const c of childrenOf(n)) max = Math.max(max, depthOf(c, d + 1));
  return max;
}

/** 深すぎる／大きすぎる式は、そのレジスタの名前に戻す（嘘をつくよりよい）。 */
function bounded(n, reg, row) {
  if (!n) return regNode(reg, row);
  if (depthOf(n, 0) > MAX_DEPTH || sizeOf(n) > MAX_NODES) return regNode(reg, row);
  return n;
}

/* ────────────────────────────────────────────────────────────
   組み立て（ここで畳む）
   ──────────────────────────────────────────────────────────── */

const MASK = { 8: 0xffn, 16: 0xffffn, 32: 0xffffffffn, 64: (1n << 64n) - 1n };

function wrap(v, bits) {
  const m = MASK[bits] || MASK[64];
  let x = v & m;
  const sign = 1n << BigInt(bits - 1);
  if (x >= sign) x -= (m + 1n);
  return x;
}

/** a と b が同じ値か（構造で比べる）。 */
export function same(a, b) {
  if (a === b) return true;
  if (!a || !b || a.k !== b.k) return false;
  switch (a.k) {
    case 'const': return a.v === b.v;
    case 'float': return Object.is(a.v, b.v) && a.bits === b.bits;
    case 'arg': return a.n === b.n;
    case 'reg': return a.reg === b.reg && a.row === b.row;
    case 'addr': return a.addr === b.addr;
    case 'str': return a.addr === b.addr;
    case 'un': return a.op === b.op && same(a.a, b.a);
    case 'bin': return a.op === b.op && same(a.a, b.a) && same(a.b, b.b);
    case 'call': return a.row === b.row;
    case 'mem':
      return a.baseReg === b.baseReg && a.disp === b.disp && a.size === b.size &&
        a.signed === b.signed && a.resultBits === b.resultBits && a.extension === b.extension &&
        a.memoryVersion === b.memoryVersion &&
        a.scale === b.scale && JSON.stringify(a.indexShift || null) === JSON.stringify(b.indexShift || null) &&
        (!!a.base === !!b.base) && (!a.base || same(a.base, b.base)) &&
        (!!a.index === !!b.index) && (!a.index || same(a.index, b.index));
    default: return false;
  }
}

const COMMUTATIVE = new Set(['add', 'mul', 'and', 'or', 'xor']);

/** 二項演算を 1 つ作る。ここで定数畳みと定型の畳み込みをすべて済ませる。 */
export function bin(op, a, b, bits) {
  if (!a || !b) return null;
  const w = bits || 64;
  const ca = constOf(a), cb = constOf(b);

  /* ── 定数どうし ── */
  if (ca != null && cb != null) {
    const v = foldConst(op, ca, cb, w);
    if (v != null) return constNode(wrap(v, w));
  }

  /* ── 交換法則: 定数は右へ寄せる（後の照合を素直にするため） ── */
  if (COMMUTATIVE.has(op) && ca != null && cb == null) return bin(op, b, a, bits);

  /* ── 単位元・吸収元 ── */
  if (cb != null) {
    if ((op === 'add' || op === 'sub' || op === 'or' || op === 'xor' ||
         op === 'shl' || op === 'shr' || op === 'sar' || op === 'ror') && cb === 0n) return a;
    if ((op === 'mul' || op === 'sdiv' || op === 'udiv') && cb === 1n) return a;
    if (op === 'mul' && cb === 0n) return ZERO;
    if (op === 'and' && cb === 0n) return ZERO;
    if ((op === 'sdiv' || op === 'udiv') && cb === 0n) return ZERO;
    if ((op === 'smod' || op === 'umod') && cb === 0n) return null;
  }
  if (op === 'sub' && same(a, b)) return ZERO;
  if (op === 'xor' && same(a, b)) return ZERO;
  if ((op === 'and' || op === 'or') && same(a, b)) return a;

  /* ── シフトは掛け算・割り算に直す ──
     `x << 1` のままだと、開発者が書き残した「基ダ×2」と照合できない。
     ビット演算として意味があるのは幅の広いずらしだけなので、
     小さいものだけを算術に寄せる。 */
  if (op === 'shl' && cb != null && cb > 0n && cb <= 16n) {
    return bin('mul', a, constNode(1n << cb), bits);
  }

  /* ── x + (x << k) → x * (2^k + 1) ──
     コンパイラは「× 5」を掛け算では書かない。この 1 行を知らないと、
     `x * 5` が全部「よく分からないずらしと足し算」になる。 */
  const sa = asShiftedSelf(a, b);
  if (sa && (op === 'add' || op === 'sub')) {
    const f = op === 'add' ? sa.fa + sa.fb : sa.fa - sa.fb;
    if (f !== 0n) return bin('mul', sa.base, constNode(f), bits);
    return ZERO;
  }

  /* ── (x * c1) * c2 → x * (c1*c2) ── */
  if (op === 'mul' && cb != null && a.k === 'bin' && a.op === 'mul') {
    const inner = constOf(a.b);
    if (inner != null) return bin('mul', a.a, constNode(wrap(inner * cb, w)), bits);
  }
  /* ── (x + c1) + c2 → x + (c1+c2) ── */
  if ((op === 'add' || op === 'sub') && cb != null && a.k === 'bin' &&
      (a.op === 'add' || a.op === 'sub')) {
    const inner = constOf(a.b);
    if (inner != null) {
      const lhs = a.op === 'add' ? inner : -inner;
      const rhs = op === 'add' ? cb : -cb;
      const sum = lhs + rhs;
      if (sum === 0n) return a.a;
      return sum > 0n ? node('bin', { op: 'add', a: a.a, b: constNode(sum) })
        : node('bin', { op: 'sub', a: a.a, b: constNode(-sum) });
    }
  }
  /* ── x - (x / d) * d → x % d ── */
  if (op === 'sub' && b && b.k === 'bin' && b.op === 'mul') {
    const q = b.a, d = constOf(b.b);
    if (d != null && q && q.k === 'bin' && (q.op === 'sdiv' || q.op === 'udiv') &&
        constOf(q.b) === d && same(q.a, a)) {
      return node('bin', { op: q.op === 'sdiv' ? 'smod' : 'umod', a, b: constNode(d) });
    }
  }
  /* Nested fixed-width division is deliberately not reassociated: the first
     division's rounding/wrap is architectural state (notably INT_MIN / -1). */

  return node('bin', { op, a, b });
}

/** `x + (x << k)` の形か。基になっている値と、両辺の倍率を返す。 */
function asShiftedSelf(a, b) {
  const fa = selfFactor(a), fb = selfFactor(b);
  if (!fa || !fb) return null;
  if (!same(fa.base, fb.base)) return null;
  return { base: fa.base, fa: fa.f, fb: fb.f };
}

/** 「ある値の定数倍」なら、その値と倍率。 */
function selfFactor(n) {
  if (!n) return null;
  if (n.k === 'bin' && n.op === 'mul') {
    const c = constOf(n.b);
    if (c != null) return { base: n.a, f: c };
  }
  if (n.k === 'bin' && n.op === 'shl') {
    const c = constOf(n.b);
    if (c != null && c >= 0n && c < 64n) return { base: n.a, f: 1n << c };
  }
  if (n.k === 'const') return null;
  return { base: n, f: 1n };
}

function foldConst(op, a, b, w) {
  switch (op) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'mul': return a * b;
    case 'and': return a & b;
    case 'or': return a | b;
    case 'xor': return a ^ b;
    case 'shl': return b >= 0n && b < 64n ? a << b : null;
    case 'sar': return b >= 0n && b < 64n ? a >> b : null;
    case 'shr': {
      if (!(b >= 0n && b < 64n)) return null;
      const m = MASK[w] || MASK[64];
      return (a & m) >> b;
    }
    case 'sdiv': {
      const lhs = BigInt.asIntN(w, a), rhs = BigInt.asIntN(w, b);
      return rhs === 0n ? 0n : truncDiv(lhs, rhs);
    }
    case 'udiv': {
      const lhs = BigInt.asUintN(w, a), rhs = BigInt.asUintN(w, b);
      return rhs === 0n ? 0n : lhs / rhs;
    }
    case 'smod': return b === 0n ? null : a - truncDiv(a, b) * b;
    default: return null;
  }
}

/** C と同じ「0 へ向かって切り捨てる」割り算。 */
function truncDiv(a, b) {
  const q = a / b;
  return q;                     // BigInt の / はすでに 0 方向へ切り捨てる
}

export function un(op, a) {
  if (!a) return null;
  const c = constOf(a);
  if (c != null) {
    switch (op) {
      case 'neg': return constNode(-c);
      case 'not': return constNode(~c);
      case 'sxt8': return constNode(wrap(c, 8));
      case 'sxt16': return constNode(wrap(c, 16));
      case 'sxt32': return constNode(wrap(c, 32));
      case 'uxt8': return constNode(c & 0xffn);
      case 'uxt16': return constNode(c & 0xffffn);
      case 'uxt32': return constNode(c & 0xffffffffn);
      default: break;
    }
  }
  // 同じ幅への変換を重ねても意味は増えない
  if (a.k === 'un' && a.op === op) return a;
  if (op === 'sxt32' && a.k === 'un' && (a.op === 'sxt32' || a.op === 'sxt16' || a.op === 'sxt8')) return a;
  if (op === 'neg' && a.k === 'un' && a.op === 'neg') return a.a;
  if (op === 'not' && a.k === 'un' && a.op === 'not') return a.a;
  return node('un', { op, a });
}

/* ────────────────────────────────────────────────────────────
   コンパイラの定型: 魔法数による割り算
   ────────────────────────────────────────────────────────────

   割り算は掛け算の 20 倍以上遅いので、割る数が決まっているとき
   コンパイラは必ずこう書き換える。

       n / 100   →   M = 0x51EB851F を掛けて、上位を取り、37 ビット右へずらす

   逆にたどるには、掛けた数 M とずらし幅 s から

       d = ceil(2^(w+s) / M)   の逆

   を求めればよい。求めた d から M を作り直して一致すれば、
   それは「d で割っていた」ことの証明になる（偶然そうなることはない）。 */

/** 積の上位を取って s だけずらしている形から、割る数を逆算する。 */
export function divisorFromMagic(magic, shift, width) {
  if (magic == null || shift == null) return null;
  const w = BigInt(width);
  const s = BigInt(shift);
  if (s < 0n || s > 63n) return null;
  const m = BigInt(magic);
  if (m <= 1n) return null;
  const p = 1n << (w + s);
  if (m > p) return null;
  // いちばん近い整数の割る数
  const d = (p + m / 2n) / m;
  /*
   * 割る数は「人が書いた数」でしかありえない。ここを 32 ビットいっぱいまで
   * 認めていると、`(a * 17) >> 3` のような、割り算ではないただのずらしまで
   * 「20 億で割っている」と読んでしまう。実際のプログラムに出てくる割る数は
   * せいぜい数万なので、そこで切る。
   */
  if (d < 2n || d > 0x100000n) return null;
  // 作り直して一致するか。ここが「確かめた」の中身。
  const back = (p + d - 1n) / d;          // ceil(2^(w+s) / d)
  if (back !== m) return null;
  return d;
}

/* ────────────────────────────────────────────────────────────
   値グラフ
   ──────────────────────────────────────────────────────────── */

/* 呼び出しで壊れるレジスタ（AAPCS64）。 */
const CALL_CLOBBER = /^(x([0-9]|1[0-7])|v[0-7])$/;

function regKeyOf(op) {
  if (!op || op.k !== 'reg') return null;
  if (op.cls === 'zr') return 'zr';
  if (op.cls === 'sp') return 'sp';
  if (op.cls === 'gp') return 'x' + op.num;
  if (op.cls === 'fp' || op.cls === 'vec') return 'v' + op.num;
  return null;
}

function regBits(op) { return op && op.bits ? op.bits : 64; }

/** オペランドに掛かっている shift/extend を式に反映する。 */
function applyShift(n, sh, bits) {
  if (!n || !sh) return n;
  const amount = sh.amount == null ? 0 : BigInt(sh.amount);
  switch (sh.op) {
    case 'lsl': return bin('shl', n, constNode(amount), bits);
    case 'lsr': return bin('shr', n, constNode(amount), bits);
    case 'asr': return bin('sar', n, constNode(amount), bits);
    case 'ror': return bin('ror', n, constNode(amount), bits);
    case 'uxtb': return amount ? bin('shl', un('uxt8', n), constNode(amount), bits) : un('uxt8', n);
    case 'uxth': return amount ? bin('shl', un('uxt16', n), constNode(amount), bits) : un('uxt16', n);
    case 'uxtw': return amount ? bin('shl', un('uxt32', n), constNode(amount), bits) : un('uxt32', n);
    case 'sxtb': return amount ? bin('shl', un('sxt8', n), constNode(amount), bits) : un('sxt8', n);
    case 'sxth': return amount ? bin('shl', un('sxt16', n), constNode(amount), bits) : un('sxt16', n);
    case 'sxtw': return amount ? bin('shl', un('sxt32', n), constNode(amount), bits) : un('sxt32', n);
    case 'uxtx': case 'sxtx': return amount ? bin('shl', n, constNode(amount), bits) : n;
    default: return n;
  }
}

function signExtendExtractedField(n, width, bits) {
  const fieldBits = Number(width), destinationBits = Number(bits);
  if (!Number.isSafeInteger(fieldBits) || !Number.isSafeInteger(destinationBits) || fieldBits < 1 || fieldBits > destinationBits) return null;
  const c = constOf(n);
  if (c != null) return constNode(BigInt.asIntN(fieldBits, BigInt.asUintN(fieldBits, c)));
  if (fieldBits === destinationBits) return n;
  const sign = bin('shr', n, constNode(BigInt(fieldBits - 1)), destinationBits);
  const correction = bin('mul', sign, constNode(1n << BigInt(fieldBits)), destinationBits);
  return bin('sub', n, correction, destinationBits);
}

const BIN_MN = {
  add: 'add', adds: 'add', sub: 'sub', subs: 'sub',
  mul: 'mul', sdiv: 'sdiv', udiv: 'udiv',
  and: 'and', ands: 'and', orr: 'or', eor: 'xor',
  lsl: 'shl', lslv: 'shl', lsr: 'shr', lsrv: 'shr', asr: 'sar', asrv: 'sar',
  ror: 'ror', rorv: 'ror',
  fadd: 'fadd', fsub: 'fsub', fmul: 'fmul', fdiv: 'fdiv',
};

/**
 * 関数 1 つぶんの値グラフを組み立てる。
 *
 * @param {object} model buildSemanticModel の結果
 * @param {object} [opts] { symbolFor(addr), textAt(addr) }
 * @returns {{at, defAt, rows, memWrites, returns}}
 *   at(row, reg)    その行に入る時点で reg が持っていた値（ノード）
 *   defAt(row, reg) その行が作った値
 */
export function buildValues(model, opts) {
  const o = opts || {};
  const insns = (model && model.instructions) || [];
  const joins = joinInfo(model, insns);
  const callRows = new Map();
  for (const c of (model && model.calls) || []) callRows.set(c.row, c);
  const textOf = new Map();
  for (const r of (model && model.addressRefs) || []) {
    if (r.text != null) textOf.set(r.row, { text: r.text, addr: r.addr });
  }

  const regs = new Map();          // regKey -> ノード
  const stack = new Map();         // 'x29+16' -> ノード
  const reads = new Map();         // row -> {reg: ノード}
  const defs = new Map();          // row -> {reg: ノード}
  const nodeDef = new Map();       // ノード -> {row, reg} どの命令が作った値か
  const memWrites = [];            // 場所への書き込み（あとで「何を保存したか」に使う）
  const returns = [];              // ret 時点の x0

  /*
   * 一度でも自分で書いたレジスタかどうか。合流点で値を忘れたあとに
   * 「引数だ」と言い直してしまわないために持つ。x0 は self でも引数でもあるが、
   * 関数の途中で作り直されたあとの x0 を「引数」と呼ぶのは、はっきり嘘になる。
   */
  /*
   * 直前にフラグを立てた比較。条件つき代入（csel）を式にするのに要る。
   * 合流点で捨てる（どちらの道の比較か分からなくなるため）。
   */
  let flags = null;
  // Non-stack memory value identity changes at every possible clobber.
  let memoryEpoch = 0;

  /*
   * sp は本体の途中では動かないか。
   *
   * 動かないなら、合流点でも sp だけは忘れてよい理由がない。忘れていたころ、
   * 同じ置き場の番地が 2 通りの式で出ていた。
   *
   *   sub_10000477C(sp - 264, …)   ← sp を追えている側（関数に入った時点の sp から）
   *   sub_10000477C(sp + 192, …)   ← 合流で忘れた側（いまの sp から）
   *
   * どちらも同じ 1 つの置き場を指しているのに、名前を付けようがなくなる。
   * `sub sp, sp, x8` のように可変長で動かす関数だけ、これまでどおり忘れる。
   */
  const spStable = insns.every((insn) => {
    const d = insn.ops && insn.ops[0];
    if (!d || d.k !== 'reg' || d.cls !== 'sp') return true;
    const imm = insn.ops[2];
    return !!(imm && imm.k === 'imm' && imm.value != null);
  });

  const everWritten = new Set();
  const get = (key, row) => {
    if (!key || key === 'zr') return ZERO;
    const v = regs.get(key);
    if (v) return v;
    // 誰も書いていない x0〜x7 は、呼び出し元から渡された値
    const m = /^x([0-7])$/.exec(key);
    const fresh = (m && !everWritten.has(key)) ? node('arg', { n: Number(m[1]) }) : regNode(key, row);
    regs.set(key, fresh);
    return fresh;
  };
  const set = (key, v, row) => {
    if (!key || key === 'zr') return;
    /*
     * 割り算の定型は 3〜5 命令にまたがるので、値を置く直前にたたむ。
     * ここでたたんでおくと、その先の式にも割り算の形のまま伝わる。
     */
    regs.set(key, bounded(foldMagic(v, 0), key, row));
  };

  /** オペランド 1 つを式にする。 */
  const valueOf = (op, row, bits) => {
    if (!op) return null;
    if (op.k === 'imm') {
      if (op.value == null) return op.float != null ? floatNode(op.float, bits) : null;
      return applyShift(constNode(op.value), op.shift, bits);
    }
    if (op.k === 'reg') {
      const key = regKeyOf(op);
      let v = get(key, row);
      // w レジスタとして読むときは下 32 ビットだけ
      if (op.bits === 32 && op.cls === 'gp') v = narrow32(v);
      return applyShift(v, op.shift, bits);
    }
    return null;
  };

  const stackSlotEligible = (m) => !!(m && m.stack && m.disp != null && !m.indexed);
  const stackSlotKey = (base, disp, size) => `${base}+${BigInt(disp).toString()}:s${Number(size)}`;
  const stackRead = (m, disp, size) => {
    if (!stackSlotEligible(m)) return null;
    const entry = stack.get(stackSlotKey(m.base, disp, size));
    return entry ? entry.value : null;
  };
  const stackWrite = (m, disp, size, value) => {
    if (!stackSlotEligible(m)) return;
    const start = BigInt(disp), end = start + BigInt(size);
    for (const [key, entry] of Array.from(stack.entries())) {
      if (entry.base !== m.base) continue;
      if (start < entry.end && entry.start < end) stack.delete(key);
    }
    stack.set(stackSlotKey(m.base, start, size), { base:m.base, start, end, size:Number(size), value });
  };

  for (let i = 0; i < insns.length; i++) {
    const insn = insns[i];
    const base = String(insn.mnemonic || '').toLowerCase();
    const row = insn.row;

    /*
     * 合流点。ここから先は、手前のどの道を通って来たか分からない。
     * 値を持ち越すと「片方の道でだけ正しい式」を事実として出すことになる。
     * スタックの置き場は関数の中で意味が変わらないので残す。
     */
    const join = joins.get(row);
    if (join) {
      stack.clear();
      flags = null;               // どの道を通って来たか分からない ＝ 比較の結果も分からない
      const keepSp = spStable ? regs.get('sp') : null;
      if (join.all) regs.clear();
      else for (const k of Array.from(regs.keys())) if (join.killed.has(k)) regs.delete(k);
      if (keepSp) regs.set('sp', keepSp);
    }

    /*
     * その行に入る時点での値を記録する。読んだレジスタだけでなく、
     * **書き換えるレジスタの「前の値」** も残す。
     *
     *   add x25, x9, x8, lsr #63
     *
     * この行は x25 を読んでいない。それでも「この行の直前の x25」が言えないと、
     * 持ち回っている値（＝関数がずっと作り変えている値）を 1 本も追えない。
     * 実際、ここを読んだレジスタだけにしていたころ、積算値の検出は常に空だった。
     */
    const snapshot = {};
    for (const r of insn.reads) snapshot[r] = get(r, row);
    for (const w of insn.writes) if (!(w in snapshot)) snapshot[w] = get(w, row);
    /*
     * 呼び出しはオペランドを持たない（`bl` の 1 語だけ）。それでも実際には
     * x0〜x7 を読む。ここで記録しておかないと、「この呼び出しに何を渡したか」に
     * 誰も答えられない — 擬似 C の引数がレジスタ名のままになる。
     */
    if (insn.isCall) for (let a = 0; a <= 7; a++) snapshot['x' + a] = get('x' + a, row);
    reads.set(row, snapshot);
    for (const w of insn.writes) everWritten.add(w);
    if (insn.isCall) for (let a = 0; a <= 17; a++) everWritten.add('x' + a);

    if (insn.data) { for (const w of insn.writes) regs.delete(w); continue; }

    const made = {};
    const emit = (key, v) => {
      if (!key || key === 'zr' || !v) return;
      // A write to Wn architecturally clears Xn[63:32]. Keep that fact in the
      // value graph instead of letting stale upper bits survive.
      const writtenOp = insn.ops && insn.ops[0];
      if (writtenOp && writtenOp.k === 'reg' && writtenOp.cls === 'gp' && writtenOp.bits === 32 && key === regKeyOf(writtenOp)) {
        v = un('uxt32', v);
      }
      set(key, v, row);
      made[key] = regs.get(key);
      // どの命令がこの値を作ったか。擬似 C が「変数として残すか、埋め込むか」を決めるのに要る。
      if (!nodeDef.has(made[key])) nodeDef.set(made[key], { row, reg: key });
    };

    /* ── 呼び出し ── */
    if (insn.isCall) {
      memoryEpoch++;
      flags = null; // NZCV is caller-clobbered and cannot be reused after a call.
      const call = callRows.get(row);
      const args = [];
      for (let a = 0; a <= 7; a++) {
        const v = regs.get('x' + a);
        if (v) args.push({ index: a, value: v });
      }
      /*
       * うしろに付いている「触っていないレジスタ」は、引数ではない。
       *
       *   sub_10041B644(0, a3, *(uint32 *)(sp - 372), x3, x4, x5, x6, x7)
       *                                               ^^^^^^^^^^^^^^^^^^
       * x3〜x7 はこの関数が受け取ったものが入ったままで、この呼び出しのために
       * 用意されたものではない。引数の数は分からないが、「用意していないもの」は
       * 引数でないと言い切れる。分からないものを並べるより、出さないほうが正しい。
       */
      while (args.length) {
        const last = args[args.length - 1];
        const v = last.value;
        const untouched = (v.k === 'arg' && v.n === last.index) ||
          (v.k === 'reg' && v.reg === 'x' + last.index);
        if (!untouched) break;
        args.pop();
      }
      const name = call ? call.name : null;
      const ret = node('call', {
        row, name: name || null,
        target: insn.callTarget != null ? insn.callTarget : null,
        sel: call ? call.selector || null : null,
        args,
      });
      /*
       * 呼び出し先にスタックの番地を渡していたら、その先で書き換えられている。
       *
       *   add x0, sp, #0xc0 ; bl <std::string の組み立て>
       *
       * ここで置き場の中身を覚えたままにしていると、あとの `ldr x0, [sp, #0xc0]`
       * に、呼び出しの **前** に入っていた値が出る。まるで違うことを言うので、
       * 番地が外へ出た時点で置き場の記憶は捨てる。
       */
      if (args.some((a) => escapesStack(a.value))) stack.clear();
      for (const k of Array.from(regs.keys())) if (CALL_CLOBBER.test(k)) regs.delete(k);
      emit('x0', ret);
      defs.set(row, made);
      continue;
    }

    /* ── アドレス ── */
    if (base === 'adrp' || base === 'adr') {
      const t = insn.pcRelTarget;
      const dst = insn.writes[0];
      if (dst && t != null) {
        emit(dst, node('addr', { addr: t, partial: base === 'adrp' }));
      } else if (dst) regs.delete(dst);
      defs.set(row, made);
      continue;
    }

    /* ── メモリ ── */
    if (insn.memory) {
      const m = insn.memory;
      const memOp = insn.ops.find((x) => x.k === 'mem');
      const slot = stackSlotEligible(m);
      if (m.kind === 'load') {
        const txt = textOf.get(row);
        const dstOps = insn.ops.filter((x) => x.k === 'reg');
        const pair = base === 'ldp' || base === 'ldpsw' || base === 'ldnp';
        const list = pair ? dstOps.slice(0, 2) : dstOps.slice(0, 1);
        const elemSize = pair ? m.size / 2 : m.size;
        list.forEach((dop, k) => {
          const key = regKeyOf(dop);
          if (!key || key === m.base && memOp && (memOp.mode === 'pre' || memOp.mode === 'post')) return;
          let v = null;
          if (txt && k === 0) v = node('str', { addr: txt.addr, text: txt.text });
          else if (slot) {
            const stackDisp = m.disp + BigInt(k * elemSize);
            v = stackRead(m, stackDisp, elemSize);
          }
          if (!v) {
            const baseVal = m.base ? regs.get(m.base) : null;
            const absolute = baseVal && baseVal.k === 'addr' && m.disp != null
              ? baseVal.addr + m.disp : null;
            v = node('mem', {
              baseReg: m.base,
              /*
               * 置き場（[sp, #N] / [x29, #N]）は、番地の式を持たない。
               *
               * sp を合流点でも忘れないようにしたとき、置き場の読み書きが
               * どれも `*(uint32 *)((sp - 400) + 28)` という **木** を抱えるようになり、
               * 1 つの式が大きくなりすぎて（MAX_NODES）レジスタ名に潰れた。
               * ÷100 の段が式として出なくなり、文言との一致が 93% → 78% に落ちた。
               * 置き場は baseReg と disp だけで 1 つに決まるので、木は要らない。
               */
              base: (m.stack || baseVal == null || baseVal.k === 'reg') ? null : baseVal,
              disp: m.disp != null ? m.disp + BigInt(k * (m.size / (pair ? 2 : 1))) : null,
              index: m.index ? applyShift(regs.get(m.index) || regNode(m.index, row), memOp && memOp.shift, 64) : null,
              indexShift: memOp && memOp.shift ? { ...memOp.shift } : null,
              scale: m.scale ?? null,
              size: pair ? m.size / 2 : m.size,
              resultBits: regBits(dop),
              extension: /^(ldrs|ldurs|ldpsw)/.test(base) ? 'sign' : (regBits(dop) === 32 ? 'zero' : null),
              signed: /^(ldrs|ldurs|ldpsw)/.test(base),
              memoryVersion: (m.volatile || m.atomic || /^(ldar|ldaxr|ldxr)/.test(base)) ? `ordered:${row}` : memoryEpoch,
              stack: !!m.stack, addr: absolute, row,
            });
          }
          emit(key, v);
        });
        // 後置・前置インデックスはベースも進む
        if (memOp && (memOp.mode === 'pre' || memOp.mode === 'post') && m.base && m.writebackDisp != null) {
          emit(m.base, bin('add', get(m.base, row), constNode(m.writebackDisp), 64));
        }
      } else {
        memoryEpoch++;
        const srcs = insn.ops.filter((x) => x.k === 'reg');
        const pair = base === 'stp' || base === 'stnp';
        const list = pair ? srcs.slice(0, 2) : srcs.slice(0, 1);
        const elemSize = pair ? m.size / 2 : m.size;
        list.forEach((sop, k) => {
          const v = valueOf(sop, row, regBits(sop));
          const step = pair ? BigInt(k * elemSize) : 0n;
          if (slot && m.disp != null) stackWrite(m, m.disp + step, elemSize, v);
          memWrites.push({
            row, address: insn.address, baseReg: m.base,
            disp: m.disp != null ? m.disp + step : null,
            size: elemSize, stack: !!m.stack,
            index: m.index || null, value: v,
          });
        });
        if (memOp && (memOp.mode === 'pre' || memOp.mode === 'post') && m.base && m.writebackDisp != null) {
          emit(m.base, bin('add', get(m.base, row), constNode(m.writebackDisp), 64));
        }
      }
      defs.set(row, made);
      continue;
    }

    if (insn.isReturn) {
      returns.push({ row, address: insn.address, value: regs.get('x0') || null });
      defs.set(row, made);
      continue;
    }

    /* ── 演算 ── */
    const dst = insn.writes.length ? insn.writes[0] : null;
    const dstOp = insn.ops[0];
    const bits = regBits(dstOp);
    const A = () => valueOf(insn.ops[1], row, bits);
    const B = () => valueOf(insn.ops[2], row, bits);
    /* 末尾に s の付く演算（subs / adds / ands …）もフラグを立てる。 */
    const knownFlagWriter = /^(subs|adds|ands|bics|negs|cmp|cmn|tst|fcmp|fcmpe|ccmp|ccmn)$/.test(base);
    const unsupportedFlagWriter = /^(adcs|sbcs|ngcs|rmif|setf8|setf16)$/.test(base);
    if (unsupportedFlagWriter) flags = null;
    if (/^(subs|adds|ands|bics|negs)$/.test(base)) {
      flags = base === 'negs' ? { op: base, a: ZERO, b: A(), bits } : { op: base, a: A(), b: B(), bits };
    }
    // Unknown instructions explicitly reported as writing NZCV must invalidate
    // the remembered predicate even when their mnemonic is not in our table.
    if (!knownFlagWriter && (insn.writes || []).includes('nzcv')) flags = null;

    if (base === 'mov' || base === 'fmov' || base === 'movz') {
      const txt = textOf.get(row);
      emit(dst, txt ? node('str', { addr: txt.addr, text: txt.text }) : valueOf(insn.ops[1], row, bits));
    } else if (base === 'movn') {
      emit(dst, un('not', valueOf(insn.ops[1], row, bits)));
    } else if (base === 'movk') {
      /*
       * 16 ビットずつ定数を組み立てている途中。
       * 手前が定数のままなら、その場で合成して 1 つの数にする。
       * ここを「不明」にしていたころ、魔法数（＝割り算の証拠）が
       * 1 つ残らず読めなかった。
       */
      const prev = regs.get(dst);
      const imm = insn.ops[1];
      const sh = imm && imm.shift && imm.shift.amount ? BigInt(imm.shift.amount) : 0n;
      if (prev && prev.k === 'const' && imm && imm.value != null) {
        const cleared = prev.v & ~(0xffffn << sh);
        emit(dst, constNode(wrap(cleared | ((imm.value & 0xffffn) << sh), 64)));
      } else regs.delete(dst);
    } else if (base === 'add' && insn.ops[2] && insn.ops[2].k === 'imm') {
      // adrp と組でアドレスを完成させる形
      const src = regs.get(regKeyOf(insn.ops[1]));
      if (src && src.k === 'addr' && src.partial && insn.ops[2].value != null) {
        const full = src.addr + insn.ops[2].value;
        const txt = textOf.get(row);
        emit(dst, txt ? node('str', { addr: full, text: txt.text })
          : node('addr', { addr: full, partial: false, sym: o.symbolFor ? o.symbolFor(full) : null }));
      } else emit(dst, bin('add', A(), B(), bits));
    } else if (BIN_MN[base]) {
      const variableShift = /^(lslv|lsrv|asrv|rorv)$/.test(base);
      const rhs = variableShift ? bin('and', B(), constNode(BigInt(bits - 1)), bits) : B();
      emit(dst, bin(BIN_MN[base], A(), rhs, bits));
    } else if (base === 'bic' || base === 'bics') {
      emit(dst, bin('and', A(), un('not', B()), bits));
    } else if (base === 'orn') {
      emit(dst, bin('or', A(), un('not', B()), bits));
    } else if (base === 'eon') {
      emit(dst, bin('xor', A(), un('not', B()), bits));
    } else if (base === 'neg' || base === 'negs') {
      emit(dst, un('neg', A()));
    } else if (base === 'fneg') {
      emit(dst, node('un', { op: 'fneg', a: A() }));
    } else if (base === 'mvn') {
      emit(dst, un('not', A()));
    } else if (base === 'madd') {
      emit(dst, bin('add', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits));
    } else if (base === 'fmadd') {
      emit(dst, bin('fadd', valueOf(insn.ops[3], row, bits), bin('fmul', A(), B(), bits), bits));
    } else if (base === 'msub') {
      emit(dst, bin('sub', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits));
    } else if (base === 'fmsub') {
      emit(dst, bin('fsub', valueOf(insn.ops[3], row, bits), bin('fmul', A(), B(), bits), bits));
    } else if (base === 'mneg') {
      emit(dst, un('neg', bin('mul', A(), B(), bits)));
    } else if (base === 'smull' || base === 'umull') {
      const ext = base === 'smull' ? 'sxt32' : 'uxt32';
      emit(dst, bin('mul', un(ext, valueOf(insn.ops[1], row, 32)), un(ext, valueOf(insn.ops[2], row, 32)), 64));
    } else if (base === 'smaddl' || base === 'umaddl') {
      const ext = base === 'smaddl' ? 'sxt32' : 'uxt32';
      emit(dst, bin('add', valueOf(insn.ops[3], row, 64),
        bin('mul', un(ext, valueOf(insn.ops[1], row, 32)), un(ext, valueOf(insn.ops[2], row, 32)), 64), 64));
    } else if (base === 'smsubl' || base === 'umsubl') {
      const ext = base === 'smsubl' ? 'sxt32' : 'uxt32';
      emit(dst, bin('sub', valueOf(insn.ops[3], row, 64),
        bin('mul', un(ext, valueOf(insn.ops[1], row, 32)), un(ext, valueOf(insn.ops[2], row, 32)), 64), 64));
    } else if (base === 'smulh' || base === 'umulh') {
      // 積の上位 64 ビット。単体では意味を持たないので、印を付けて持ち回る。
      emit(dst, node('bin', { op: base === 'smulh' ? 'smulh' : 'umulh', a: A(), b: B() }));
    } else if (base === 'sxtb' || base === 'sxth' || base === 'sxtw' ||
               base === 'uxtb' || base === 'uxth' || base === 'uxtw') {
      const map = { sxtb: 'sxt8', sxth: 'sxt16', sxtw: 'sxt32', uxtb: 'uxt8', uxth: 'uxt16', uxtw: 'uxt32' };
      emit(dst, un(map[base], valueOf(insn.ops[1], row, 64)));
    } else if (base === 'ubfx' || base === 'sbfx') {
      const lsb = insn.ops[2] && insn.ops[2].value != null ? insn.ops[2].value : 0n;
      const width = insn.ops[3] && insn.ops[3].value != null ? insn.ops[3].value : 0n;
      const destinationWidth = BigInt(bits);
      if (lsb < 0n || width <= 0n || lsb >= destinationWidth || width > destinationWidth - lsb) {
        if (dst) regs.delete(dst);
      } else {
        const shifted = bin('shr', A(), constNode(lsb), bits);
        const extracted = width === destinationWidth ? shifted : bin('and', shifted, constNode((1n << width) - 1n), bits);
        emit(dst, base === 'sbfx' ? signExtendExtractedField(extracted, width, bits) : extracted);
      }
    } else if (base === 'csel' || base === 'csinc' || base === 'csinv' || base === 'csneg' ||
               base === 'cset' || base === 'csetm' || base === 'cinc') {
      emit(dst, selectNode(insn, row, valueOf, bits, flags));
    } else if (base === 'ccmp' || base === 'ccmn') {
      // CCMP/CCMN writes compare flags only when its condition is true and an
      // encoded NZCV literal otherwise. Treating it as CMP invents a predicate.
      // Until the flag state is represented as a conditional value, forget it.
      flags = null;
    } else if (base === 'cmp' || base === 'cmn' || base === 'tst' || base === 'fcmp' ||
               base === 'fcmpe') {
      /*
       * フラグだけで、値は作らない。ただし **何と何を比べたか** は覚えておく。
       *
       * ここを捨てていたころ、csel から作った式の条件は `flag_ne` としか
       * 書けなかった。`x22 = flag_ne ? flag_ne ? result : flag_lt ? result : 1 : result;`
       * のような行になり、条件つきの代入はどれも読めなかった。
       * 比べた 2 つを持っておけば `x22 = (result < 1) ? 1 : result;` と書ける。
       */
      const cbits = regBits(insn.ops[0]);
      flags = {
        op: base,
        a: valueOf(insn.ops[0], row, cbits),
        b: insn.ops[1] ? valueOf(insn.ops[1], row, cbits) : ZERO,
        bits: cbits,
      };
    } else if (insn.writes.length) {
      for (const w of insn.writes) regs.delete(w);
    }

    defs.set(row, made);
  }

  const rowAddress = new Map();
  for (const insn of insns) if (insn.address != null) rowAddress.set(insn.row, insn.address);

  return {
    reads, defs, memWrites, returns, nodeDef, rowAddress,
    /** その行に入る時点での reg の値。 */
    at(row, reg) {
      const s = reads.get(row);
      return (s && s[reg]) || null;
    },
    /** その行が作った値。 */
    defAt(row, reg) {
      const d = defs.get(row);
      return (d && d[reg]) || null;
    },
    finalRegs: regs,
  };
}

/*
 * 合流点で、何を忘れなければいけないか。
 *
 * ここを「全部忘れる」にしていたころ、いちばん多い形でつまずいていた。
 *
 *     asr  x25, x23, #7
 *     ldrsb w8, [sp, #0x6f]
 *     tbz  w8, #0x1f, +3          ← 後片付けを飛ばすだけの分岐
 *     ldr  x0, [sp, #0x58]
 *     bl   _ZdlPv
 *     add  x25, x25, x23, lsr #63 ← ここが合流点。割り算はここで完成する
 *
 * 飛ばされる 2 行は x25 も x23 も触らない。つまり **どちらの道を通っても
 * x25 と x23 は同じ**で、忘れる理由がない。それでも全部忘れていたので、
 * 割り算が 1 つに戻らず「上位を取って 7 ずらす」という無意味な行が残っていた。
 *
 * 飛ばされうる範囲を求めて、そこで書き換えられるレジスタだけを忘れる。
 * 後ろへ戻る分岐（ループ）や、飛び先を追えない分岐が混ざっていたら、
 * 分からないので全部忘れる（安全側）。
 */
function joinInfo(model, insns) {
  const out = new Map();
  const blocks = (model && model.basicBlocks) || [];
  const joinRows = blocks.filter((b) => b.isJoin).map((b) => b.startRow);
  if (!joinRows.length) return out;

  const rowOf = new Map();          // 行番号 → insns の添字
  const rowAt = new Map();          // アドレス → 行番号
  insns.forEach((insn, i) => {
    rowOf.set(insn.row, i);
    if (insn.address != null) rowAt.set(insn.address.toString(), insn.row);
  });

  /* どの行から、どの行へ跳んでいるか。 */
  const sources = new Map();
  let hasIndirect = false;
  for (const insn of insns) {
    if (!insn.isBranch || insn.isCall || insn.isReturn) continue;
    if (insn.branchTarget == null) { hasIndirect = true; continue; }
    const target = rowAt.get(insn.branchTarget.toString());
    if (target == null) continue;                 // 関数の外へ跳んでいる
    if (!sources.has(target)) sources.set(target, []);
    sources.get(target).push(insn.row);
  }

  /* 各行が書き換えるレジスタ（呼び出しは壊すレジスタも含める）。 */
  const kills = insns.map((insn) => {
    const set = new Set(insn.writes);
    if (insn.isCall) for (let a = 0; a <= 17; a++) { set.add('x' + a); set.add('v' + (a < 8 ? a : 0)); }
    return set;
  });

  for (const row of joinRows) {
    const from = sources.get(row) || [];
    if (!from.length || hasIndirect) { out.set(row, { all: true }); continue; }
    let lo = row;
    let backwards = false;
    for (const s of from) {
      if (s >= row) { backwards = true; break; }
      lo = Math.min(lo, s);
    }
    if (backwards) { out.set(row, { all: true }); continue; }
    const a = rowOf.get(lo), b = rowOf.get(row);
    if (a == null || b == null || b - a > 400) { out.set(row, { all: true }); continue; }
    const killed = new Set();
    for (let i = a; i < b; i++) for (const k of kills[i]) killed.add(k);
    out.set(row, { all: false, killed });
  }
  return out;
}

/** その式は「スタックの番地そのもの」を含んでいるか。 */
function escapesStack(n) {
  let hit = false;
  walk(n, (x) => {
    if (x.k === 'reg' && (x.reg === 'sp' || x.reg === 'x29')) hit = true;
  });
  return hit;
}

/** w レジスタとして読む＝下 32 ビットだけ。 */
function narrow32(v) {
  if (!v) return v;
  if (v.k === 'const') return constNode(v.v & 0xffffffffn);
  if (v.k === 'un' && v.op === 'uxt32') return v;
  return un('uxt32', v);
}

function nzcvForConstants(flags) {
  if (!flags || !flags.a || !flags.b) return null;
  const av = constOf(flags.a), bv = constOf(flags.b);
  if (av == null || bv == null) return null;
  const bits = Math.max(1, Math.min(64, Number(flags.bits) || 64));
  const width = BigInt(bits), mask = (1n << width) - 1n, sign = 1n << (width - 1n);
  const a = BigInt.asUintN(bits, av), b = BigInt.asUintN(bits, bv);
  let result = 0n, c = false, v = false;
  if (flags.op === 'adds' || flags.op === 'cmn') {
    const full = a + b; result = full & mask; c = full > mask; v = ((~(a ^ b) & (a ^ result) & sign) !== 0n);
  } else if (flags.op === 'subs' || flags.op === 'cmp' || flags.op === 'negs') {
    result = (a - b) & mask; c = a >= b; v = (((a ^ b) & (a ^ result) & sign) !== 0n);
  } else if (flags.op === 'ands' || flags.op === 'tst') {
    result = a & b;
  } else if (flags.op === 'bics') {
    result = a & ((~b) & mask);
  } else return null;
  return { n:(result & sign) !== 0n, z:result === 0n, c, v };
}

function conditionFromNzcv(f, cc) {
  if (!f || !cc) return null;
  const { n,z,c,v } = f;
  switch (cc) {
    case 'eq': return z; case 'ne': return !z;
    case 'cs': case 'hs': return c; case 'cc': case 'lo': return !c;
    case 'mi': return n; case 'pl': return !n; case 'vs': return v; case 'vc': return !v;
    case 'hi': return c && !z; case 'ls': return !c || z;
    case 'ge': return n === v; case 'lt': return n !== v;
    case 'gt': return !z && n === v; case 'le': return z || n !== v;
    case 'al': return true; case 'nv': return false; default: return null;
  }
}

function compareCompatible(flags) {
  if (!flags || !flags.a || !flags.b) return null;
  if (['cmp','subs','negs','fcmp','fcmpe'].includes(flags.op)) return { a:flags.a, b:flags.b };
  return null;
}

function flagConditionNode(flags, cc) {
  if (!flags || !flags.a || !flags.b || !cc) return null;
  if (!['adds','cmn','ands','tst','bics'].includes(flags.op)) return null;
  return node('flagcond', { cc, producer:flags.op, bits:Math.max(1, Math.min(64, Number(flags.bits) || 64)), a:flags.a, b:flags.b, semantics:'aarch64-nzcv-exact' });
}

function selectNode(insn, row, valueOf, bits, flags) {
  const ops = insn.ops;
  const ccOp = ops.length ? ops[ops.length - 1] : null;
  const cond = ccOp && ccOp.k === 'cond' ? ccOp.text : null;
  const base = String(insn.mnemonic).toLowerCase();
  const cmp = compareCompatible(flags);
  const predicate = cmp ? null : flagConditionNode(flags, cond);
  const known = conditionFromNzcv(nzcvForConstants(flags), cond);
  if (base === 'cset' || base === 'csetm') {
    const on = constNode(base === 'csetm' ? -1n : 1n);
    if (known != null) return known ? on : ZERO;
    return node('sel', { cc:cond, cmp, predicate, a:on, b:ZERO });
  }
  const a = valueOf(ops[1], row, bits);
  const b = ops[2] && ops[2].k !== 'cond' ? valueOf(ops[2], row, bits) : a;
  if (base === 'cinc') {
    const inc = bin('add', a, constNode(1n), bits);
    if (known != null) return known ? inc : a;
    return node('sel', { cc:cond, cmp, predicate, a:inc, b:a });
  }
  let alt = b;
  if (base === 'csinc') alt = bin('add', b, constNode(1n), bits);
  else if (base === 'csinv') alt = un('not', b);
  else if (base === 'csneg') alt = un('neg', b);
  if (known != null) return known ? a : alt;
  if (same(a, alt)) return a;
  const mm = minMaxOf(cond, cmp, a, alt);
  if (mm) return mm;
  return node('sel', { cc:cond, cmp, predicate, a, b:alt });
}

/** cond ? a : b が min / max の形になっていれば、その 1 つのノードにする。 */
function minMaxOf(cc, cmp, a, b) {
  if (!cc || !cmp || !cmp.a || !cmp.b) return null;
  const LOW = { lt: 'min', le: 'min', gt: 'max', ge: 'max', lo: 'umin', ls: 'umin', hi: 'umax', hs: 'umax' };
  const op = LOW[cc];
  if (!op) return null;
  const flip = { min: 'max', max: 'min', umin: 'umax', umax: 'umin' };
  /* 「小さければ左」なら min、「小さければ右」なら max（大小が入れ替わる）。 */
  if (same(cmp.a, a) && same(cmp.b, b)) return node('bin', { op, a, b });
  if (same(cmp.a, b) && same(cmp.b, a)) return node('bin', { op: flip[op], a: b, b: a });
  return null;
}

/* ────────────────────────────────────────────────────────────
   仕上げ: 魔法数の割り算をたたむ
   ────────────────────────────────────────────────────────────

   ここは値グラフを作ったあとに、木の形として当てる。
   3 命令にまたがるうえ、途中の形が何通りもあるので、
   組み立ての最中に当てるより、できあがった木を見た方が確実。 */

/**
 * 式の中の「魔法数による割り算」を、ふつうの割り算に戻す。
 * 当てはまらなければ元の木をそのまま返す（無理に当てない）。
 */
export function foldMagic(n, depth) {
  if (!n || (depth || 0) > MAX_DEPTH) return n;
  const d = (depth || 0) + 1;

  if (n.k === 'bin') {
    /*
     * 符号を直す足し算。割った値がマイナスのときだけ 1 を足す形。
     *
     *   asr x9, x8, #6 ; add x25, x9, x8, lsr #63     ← 2 つの項が同じ x8
     *
     * これが付いていることが「符号つきの割り算だった」ことの証になる。
     * 中をたたむ前に見る（たたむと、照合に使う 2 つの項の形が変わるため）。
     */
    if (n.op === 'add') {
      const fixed = signFix(n.a, n.b) || signFix(n.b, n.a);
      if (fixed) return fixed;
    }
    const a = foldMagic(n.a, d), b = foldMagic(n.b, d);
    /*
     * 符号直しが取り残される形。
     *
     * 値を置くたびに foldMagic を通しているので、`asr` の側が先に割り算へ
     * 戻ってしまうことがある。そのあとで足し算を見ると、片方はもう `/ 100` で、
     * signFix の当てにしている `sar` の形をしていない。
     *
     *   x8  = x25 * f(...) *hi M          ← 別の行として残っている
     *   x25 = x25 * f(...) / 100 + (x8 >> 63)
     *                                ^^^^^^^^^ これだけが取り残される
     *
     * 割り算はもう出ているので、この項は「マイナスなら 1 足す」の名残でしかない。
     * 同じ値を割っている割り算が隣にあることを確かめてから落とす。
     */
    if (n.op === 'add') {
      const kept = dropSignFix(a, b) || dropSignFix(b, a);
      if (kept) return kept;
    }
    const cur = (a === n.a && b === n.b) ? n : node('bin', { op: n.op, a, b });
    /*
     * 符号直しの付かない割り算。値がマイナスにならないと分かっているとき
     * （符号なし、あるいは直前でマスクしているとき）はこの形になる。
     *   ubfx w8, w8, ... ; mul w8, w8, w9 ; lsr w8, w8, #10
     */
    const solo = soloMagic(cur);
    if (solo) return solo;
    return cur;
  }
  if (n.k === 'un') {
    const a = foldMagic(n.a, d);
    return a === n.a ? n : un(n.op, a);
  }
  if (n.k === 'sel') {
    const a = foldMagic(n.a, d), b = foldMagic(n.b, d);
    return (a === n.a && b === n.b) ? n : node('sel', { cc: n.cc, a, b, cmp: n.cmp, predicate: n.predicate });
  }
  if (n.k === 'mem' && n.index) {
    const idx = foldMagic(n.index, d);
    return idx === n.index ? n : Object.assign({}, n, { index: idx });
  }
  return n;
}

/** 右へずらす連なりを 1 つにまとめる。`(X >> 32) >> 5` は `X >> 37`。 */
function unwrapShift(n) {
  let inner = n, shift = 0n;
  while (inner && inner.k === 'bin' && (inner.op === 'shr' || inner.op === 'sar')) {
    const k = constOf(inner.b);
    if (k == null || k <= 0n) break;
    shift += k;
    inner = inner.a;
    if (shift > 96n) return null;
  }
  return shift > 0n ? { inner, shift } : null;
}

/** 符号直しの付かない、素の「掛けてずらす」割り算。 */
function soloMagic(n) {
  if (!n || n.k !== 'bin') return null;
  if (n.op !== 'shr' && n.op !== 'sar') return null;
  const u = unwrapShift(n);
  if (!u) return null;
  return asMagicDivision(u.inner, u.shift, n.op === 'shr' ? 'udiv' : 'sdiv');
}

function stripPatternUxt32(n) {
  let cur = n;
  while (cur && cur.k === 'un' && cur.op === 'uxt32') cur = cur.a;
  return cur;
}

/** `(X >> s) + (X >>> 63)` の形なら、X を割り算として読み直す。 */
function signFix(shifted, signBit) {
  shifted = stripPatternUxt32(shifted);
  signBit = stripPatternUxt32(signBit);
  if (!shifted || !signBit) return null;
  if (shifted.k !== 'bin' || (shifted.op !== 'sar' && shifted.op !== 'mul')) return null;
  if (signBit.k !== 'bin' || signBit.op !== 'shr') return null;
  const w = constOf(signBit.b);
  if (w !== 63n && w !== 31n) return null;

  // 右へずらしている側の中身と、ずらし幅
  let inner = shifted, shift = 0n;
  if (shifted.op === 'sar') {
    const s = constOf(shifted.b);
    if (s == null) return null;
    inner = stripPatternUxt32(shifted.a); shift = s;
  } else {
    // shl → mul に直したあとに sar が消えている形は扱わない
    return null;
  }
  /*
   * ずらしが 2 命令に割れている形。こちらのほうがよく出る。
   *
   *   smull x8, w8, w23        ; 64 ビットの積
   *   lsr   x10, x8, #0x20     ; 上位 32 ビットを取り出す
   *   add   w1, w8, w10, asr #5 ; そこからさらに 5 ずらす
   *
   * 合わせて 37 ずらしたのと同じ。ここをつなげないと、
   * いちばん普通の「100 で割る」が 1 つも戻せない。
   */
  const chain = unwrapShift(inner);
  if (chain) { inner = chain.inner; shift += chain.shift; }
  if (!same(dropSignExt(inner), dropSignExt(signBit.a))) return null;

  const div = asMagicDivision(inner, shift);
  if (div) return div;
  /*
   * 魔法数ではなく、素直に 2 の冪で割っている形。
   *   asr x9, x8, #3 ; add x0, x9, x8, lsr #63   →   x8 / 8
   */
  if (shift > 0n && shift < 63n) return bin('sdiv', inner, constNode(1n << shift), 64);
  return null;
}

/**
 * 割り算に戻したあとに残った符号直しの項を落とす。
 *
 * @param kept     残す側（すでに割り算になっている式）
 * @param signTerm `X >> 63` の形をしているはずの項
 * @returns kept（落としてよいとき） | null
 */
function dropSignFix(kept, signTerm) {
  if (!kept || !signTerm) return null;
  if (signTerm.k !== 'bin' || signTerm.op !== 'shr') return null;
  const w = constOf(signTerm.b);
  if (w !== 63n && w !== 31n) return null;
  /* 符号を見ている相手は、魔法数を掛けた積でなければならない。 */
  const src = magicSource(signTerm.a);
  if (!src) return null;
  /* その同じ値を割っている割り算が、残す側に本当にあることを確かめる。 */
  let hit = false;
  const want = dropSignExt(src.n);
  walk(kept, (x) => {
    if (x.k === 'bin' && (x.op === 'sdiv' || x.op === 'udiv') &&
        same(dropSignExt(x.a), want)) hit = true;
  });
  return hit ? kept : null;
}

/**
 * 「魔法数を掛けた積」の 3 つの形を、どれでも受ける。
 *
 *   smulh(n, M)              64 ビットの上位だけを取る形
 *   n * M                    smull で 64 ビットの積を作る形
 *   smulh(n, M) + n          M が 2^63 以上のときの補正つき
 *
 * 3 つめを取りこぼしていたころ、÷100 の段が 8 か所そろって
 * `result = x8_3 / 100 + (x8_4 >> 63);` のまま出ていた。
 */
function magicSource(n) {
  if (!n) return null;
  const hi = magicHigh(n);
  if (hi) return hi;
  const prod = magicProduct(n);
  if (prod) return prod;
  if (n.k === 'bin' && n.op === 'add') {
    const a = magicHigh(n.a);
    if (a && same(dropSignExt(a.n), dropSignExt(n.b))) return a;
    const b = magicHigh(n.b);
    if (b && same(dropSignExt(b.n), dropSignExt(n.a))) return b;
  }
  return null;
}

/** smull で作った 64 ビットの積（`n * 大きな定数`）なら、掛けられた値。 */
function magicProduct(n) {
  if (!n || n.k !== 'bin' || n.op !== 'mul') return null;
  /*
   * 魔法数はいつも 2^30 級とは限らない。÷1000 の 32 ビット形は 0x10624DD3
   * （2^28 くらい）で、2^30 で切っていたころ、この形の符号直しだけが
   * `+ ((int32)x8 * 0x10624DD3 >> 63)` として行に残っていた。
   * どのみち「同じ値を割っている割り算が隣にある」ことを確かめてから落とすので、
   * ここは広めに取ってよい。
   */
  const big = (v) => v != null && (v > 0x1000000n || v < -0x1000000n);
  const cb = constOf(n.b), ca = constOf(n.a);
  if (big(cb)) return { m: cb, n: n.a };
  if (big(ca)) return { m: ca, n: n.b };
  return null;
}

function dropSignExt(n) {
  let cur = n;
  while (cur && cur.k === 'un' && /^(sxt|uxt)/.test(cur.op)) cur = cur.a;
  return cur;
}

/**
 * 「魔法数を掛けて上位を取った値」を、割り算に戻す。
 *
 * 形は 3 通りある。
 *   smulh(n, M)                    → 上位 64。 幅 64
 *   smulh(n, M) + n                → M が 2^63 以上のときの補正つき
 *   n * M（64 ビットの積） >> 32   → smull で作った 64 ビットの積
 */
function asMagicDivision(inner, shift, op) {
  const kind = op || 'sdiv';
  if (!inner) return null;

  // smulh(n, M) [+ n]
  let core = inner, plusSelf = false;
  if (core.k === 'bin' && core.op === 'add') {
    const hi = magicHigh(core.a), other = core.b;
    if (hi && same(dropSignExt(hi.n), dropSignExt(other))) { core = core.a; plusSelf = true; }
    else {
      const hi2 = magicHigh(core.b);
      if (hi2 && same(dropSignExt(hi2.n), dropSignExt(core.a))) { core = core.b; plusSelf = true; }
    }
  }
  const hi = magicHigh(core);
  if (hi) {
    let m = hi.m;
    if (plusSelf) {
      // 補正つき ＝ 魔法数は符号なしで読む
      if (m < 0n) m += 1n << 64n;
    } else if (m < 0n) return null;
    const d = divisorFromMagic(m, shift, 64);
    return d ? bin(kind, hi.n, constNode(d), 64) : null;
  }

  // 64 ビットの積を s だけずらしている（smull の結果）
  if (core.k === 'bin' && core.op === 'mul' && shift >= 32n) {
    const c = constOf(core.b);
    const n = core.a;
    if (c != null && c > 0n) {
      const d = divisorFromMagic(c, shift - 32n, 32);
      if (d) return bin(kind, n, constNode(d), 64);
    }
    const c2 = constOf(core.a);
    if (c2 != null && c2 > 0n) {
      const d = divisorFromMagic(c2, shift - 32n, 32);
      if (d) return bin(kind, core.b, constNode(d), 64);
    }
  }
  return null;
}

/** smulh / umulh の形なら、掛けた相手（魔法数）と掛けられた値。 */
function magicHigh(n) {
  if (!n || n.k !== 'bin') return null;
  if (n.op !== 'smulh' && n.op !== 'umulh') return null;
  const cb = constOf(n.b), ca = constOf(n.a);
  if (cb != null) return { m: cb, n: n.a };
  if (ca != null) return { m: ca, n: n.b };
  return null;
}

/* ────────────────────────────────────────────────────────────
   文字にする
   ──────────────────────────────────────────────────────────── */

const PREC = {
  min: 14, max: 14, umin: 14, umax: 14,
  or: 4, xor: 5, and: 6, shl: 8, shr: 8, sar: 8, ror: 8,
  add: 9, sub: 9, fadd: 9, fsub: 9, mul: 10, fmul: 10, fdiv: 10, sdiv: 10, udiv: 10, smod: 10, umod: 10,
  smulh: 10, umulh: 10,
};
const SYM = {
  add: '+', sub: '-', fadd: '+', fsub: '-', mul: '*', fmul: '*', fdiv: '/', sdiv: '/', udiv: '/', smod: '%', umod: '%',
  and: '&', or: '|', xor: '^', shl: '<<', shr: '>>', sar: '>>', ror: '>>>',
  smulh: '*hi', umulh: '*hi',
};

function hexOf(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  if (a < 4096n) return (neg ? '-' : '') + a.toString(10);
  return (neg ? '-0x' : '0x') + a.toString(16).toUpperCase();
}

/**
 * 式を C 風の文字列にする。
 *
 * @param {object} n
 * @param {object} [opts]
 *   nameOf(node)  そのノードに人が付けた名前があれば返す（フィールド名など）
 *   symbolFor(addr)
 *   maxLen        これを超えたら「…」で止める
 */
export function render(n, opts) {
  const o = opts || {};
  const out = emit(n, 0, o, 0);
  const max = o.maxLen || 220;
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

function emit(n, prec, o, depth) {
  if (!n) return '?';
  if (depth > MAX_DEPTH) return '…';
  if (o.nameOf) {
    const custom = o.nameOf(n);
    if (custom) return custom;
  }
  switch (n.k) {
    case 'const': return hexOf(n.v);
    case 'float': return Number.isInteger(n.v) ? n.v.toFixed(1) : String(n.v);
    case 'arg': return 'a' + (n.n + 1);
    case 'reg': return n.reg;
    case 'str': return '"' + escapeText(n.text) + '"';
    case 'addr': {
      const sym = n.sym || (o.symbolFor ? o.symbolFor(n.addr) : null);
      return sym ? '&' + sym : '0x' + n.addr.toString(16).toUpperCase();
    }
    case 'mem': return emitMem(n, o, depth);
    case 'call': return emitCall(n, o, depth);
    case 'un': return emitUn(n, prec, o, depth);
    case 'sel': {
      const s = emit(n.a, 3, o, depth + 1) + ' : ' + emit(n.b, 3, o, depth + 1);
      const c = n.cmp ? condSymbol(n.cc, n.cmp, o, depth) : (n.predicate ? emitFlagCondition(n.predicate, o, depth) : (n.cc ? condSymbol(n.cc, null, o, depth) : 'cond'));
      const t = c + ' ? ' + s;
      return prec > 3 ? '(' + t + ')' : t;
    }
    case 'bin': {
      /* min / max は中置きでは書けないので、関数の形で出す。 */
      if (n.op === 'min' || n.op === 'max' || n.op === 'umin' || n.op === 'umax') {
        return n.op + '(' + emit(n.a, 0, o, depth + 1) + ', ' + emit(n.b, 0, o, depth + 1) + ')';
      }
      const p = PREC[n.op] || 9;
      const t = emit(n.a, p, o, depth + 1) + ' ' + (SYM[n.op] || n.op) + ' ' +
        emit(n.b, p + 1, o, depth + 1);
      return p < prec ? '(' + t + ')' : t;
    }
    default: return '?';
  }
}

function emitUn(n, prec, o, depth) {
  const inner = emit(n.a, 11, o, depth + 1);
  switch (n.op) {
    case 'neg': return '-' + inner;
    case 'fneg': return '-' + inner;
    case 'not': return '~' + inner;
    case 'sxt8': return '(int8)' + inner;
    case 'sxt16': return '(int16)' + inner;
    case 'sxt32': return '(int32)' + inner;
    case 'uxt8': return '(uint8)' + inner;
    case 'uxt16': return '(uint16)' + inner;
    case 'uxt32': return '(uint32)' + inner;
    default: void prec; return n.op + '(' + inner + ')';
  }
}

function emitMem(n, o, depth) {
  if (o.memName) {
    const custom = o.memName(n);
    if (custom) return custom;
  }
  const type = typeName(n.size, n.signed);
  if (n.addr != null) {
    const sym = o.symbolFor ? o.symbolFor(n.addr) : null;
    if (sym) return sym;
    return '*(' + type + ' *)0x' + n.addr.toString(16).toUpperCase();
  }
  /*
   * 住所は式として組み立ててから文字にする。そうしないと
   * `*(uint32 *)((sp - 400) + 28)` のように、足し算がほどけないまま出てしまう。
   */
  let addr = n.base || regNode(n.baseReg || '?', n.row);
  if (n.index) addr = bin('add', addr, n.index, 64);
  if (n.disp != null && n.disp !== 0n) addr = bin('add', addr, constNode(n.disp), 64);
  return '*(' + type + ' *)(' + emit(addr, 0, o, depth + 1) + ')';
}

function emitCall(n, o, depth) {
  const label = (o.callName && o.callName(n)) || n.name ||
    (n.target != null ? 'sub_' + n.target.toString(16).toUpperCase() : '(*func)');
  const args = (n.args || []).map((a) => emit(a.value, 0, o, depth + 1));
  return label + '(' + args.join(', ') + ')';
}

function emitFlagCondition(predicate, o, depth) {
  if (!predicate || predicate.k !== 'flagcond') return 'flag_unknown';
  const producer = String(predicate.producer || 'unknown'), bits = Number(predicate.bits || 64);
  const a = emit(predicate.a, 0, o, depth + 1), b = emit(predicate.b, 0, o, depth + 1);
  const stem = `${producer}${bits}(${a}, ${b})`;
  const n=`N_${stem}`, z=`Z_${stem}`, c=`C_${stem}`, v=`V_${stem}`;
  switch (predicate.cc) {
    case 'eq': return z; case 'ne': return `!${z}`;
    case 'cs': case 'hs': return c; case 'cc': case 'lo': return `!${c}`;
    case 'mi': return n; case 'pl': return `!${n}`; case 'vs': return v; case 'vc': return `!${v}`;
    case 'hi': return `${c} && !${z}`; case 'ls': return `!${c} || ${z}`;
    case 'ge': return `${n} == ${v}`; case 'lt': return `${n} != ${v}`;
    case 'gt': return `!${z} && ${n} == ${v}`; case 'le': return `${z} || ${n} != ${v}`;
    default: return `nzcv_${stem}.${predicate.cc || 'unknown'}`;
  }
}

function condSymbol(cc, cmp, o, depth) {
  const ops = {
    eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=',
    lo: '<', ls: '<=', hi: '>', hs: '>=', cc: '<', cs: '>=',
    mi: '< 0', pl: '>= 0',
  };
  if (cmp && cmp.a) {
    return emit(cmp.a, 7, o, depth + 1) + ' ' + (ops[cc] || cc) + ' ' +
      (cmp.b ? emit(cmp.b, 8, o, depth + 1) : '0');
  }
  return 'flag_' + cc;
}

export function typeName(size, signed) {
  const t = { 1: 'int8', 2: 'int16', 4: 'int32', 8: 'int64', 16: 'int128' }[size] || 'int64';
  return signed === false ? t.replace('int', 'uint') : t;
}

function escapeText(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 90);
}

/* ────────────────────────────────────────────────────────────
   式を歩く
   ──────────────────────────────────────────────────────────── */

/** 式の中の全ノードを訪ねる（同じノードは 1 回だけ）。 */
export function walk(n, fn, seen) {
  if (!n) return;
  const s = seen || new Set();
  if (s.has(n)) return;
  s.add(n);
  fn(n);
  for (const c of childrenOf(n)) walk(c, fn, s);
}

/** 式に含まれる定数を集める（照合に使う）。 */
export function constantsIn(n) {
  const out = [];
  walk(n, (x) => { if (x.k === 'const') out.push(x.v); });
  return out;
}

/** 式に含まれる呼び出しを集める。 */
export function callsIn(n) {
  const out = [];
  walk(n, (x) => { if (x.k === 'call') out.push(x); });
  return out;
}

/** 式に含まれるメモリ参照を集める。 */
export function memsIn(n) {
  const out = [];
  walk(n, (x) => { if (x.k === 'mem') out.push(x); });
  return out;
}
