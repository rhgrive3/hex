/*
 * ARM64 命令を「日本語の文」に翻訳するエンジン。
 *
 * 入力は Capstone が出した mnemonic と operand 文字列だけ。
 * 出力は、初心者がそのまま読める説明・擬似コード・部品ごとの意味。
 *
 * 方針:
 *  - 専門用語をいきなり使わない。使うときは用語集 (glossary.js) の id を terms に入れ、
 *    UI 側でタップできるようにする。
 *  - 16進の値には必ず 10進を添える。初心者は 0x20 を見て 32 だと分からない。
 *  - 「レジスタ」には役割がある（x0 は引数、x30 は戻り先…）。それを毎回教える。
 */
import { isJa, pick } from './i18n.js';
// immShort / absHex / memExpr は擬似コードと注釈で使います。以前は
// arm64-operands.js の中に閉じたままで、こちらからは import されていません
// でした。呼び出しは残っていたので、メモリ系や即値系の説明はすべて例外で
// 落ち、空の説明として表示されていました。ここで正規の 1 つの実装を
// 取り込みます（別実装を作り直すと 2 つの真実ができてしまいます）。
import { parseOperands, immText, immShort, absHex, memExpr, opShort, condInfo } from './ui/explain/arm64-operands.js';
import { registerRole } from './abi/aapcs64/presentation.js';

export { parseOperands, immText, opShort, condInfo, registerRole };

function shiftText(sh) {
  if (!sh) return '';
  const n = sh.amount;
  const times = n ? (isJa() ? '、さらに ' + (2 ** n) + ' 倍して' : ' then ×' + (2 ** n)) : '';
  switch (sh.op) {
    case 'lsl': return isJa()
      ? '（左へ ' + n + ' ビットずらす＝ ' + (2 ** n) + ' 倍してから）'
      : ' (shifted left by ' + n + ', i.e. ×' + (2 ** n) + ')';
    case 'lsr': return isJa() ? '（右へ ' + n + ' ビットずらしてから）' : ' (shifted right by ' + n + ')';
    case 'asr': return isJa() ? '（符号を保ったまま右へ ' + n + ' ビットずらしてから）' : ' (arithmetic-shifted right by ' + n + ')';
    case 'ror': return isJa() ? '（' + n + ' ビット回転させてから）' : ' (rotated by ' + n + ')';
    case 'uxtb': case 'uxth': case 'uxtw': case 'uxtx':
      return isJa()
        ? '（下半分だけ取り出して上を 0 で埋め' + times + '）'
        : ' (zero-extended' + times + ')';
    case 'sxtb': case 'sxth': case 'sxtw': case 'sxtx':
      return isJa()
        ? '（下半分だけ取り出して符号を伸ばし' + times + '）'
        : ' (sign-extended' + times + ')';
    default: return '';
  }
}

/** メモリオペランドを日本語で。 */
function memText(m) {
  const base = m.base.text;
  let where;
  // 後置インデックスでは、アクセスするアドレスは base そのもの。
  // 即値はアクセス「後」に base を進めるための値なので、住所には足さない。
  const disp = m.mode === 'post' ? null : m.disp;
  if (m.index) {
    where = isJa()
      ? base + ' と ' + m.index.text + shiftText(m.shift) + ' を足したアドレス'
      : base + ' + ' + m.index.text;
  } else if (disp && disp.value != null && disp.value !== 0n) {
    const v = disp.value;
    const a = v < 0n ? -v : v;
    where = isJa()
      ? base + ' から ' + a.toString(10) + ' バイト' + (v < 0n ? '手前' : '先') + 'のアドレス'
      : base + (v < 0n ? ' − ' : ' + ') + a.toString(10);
  } else {
    where = isJa() ? base + ' が指しているアドレス' : 'the address in ' + base;
  }
  if (m.mode === 'pre') {
    where += isJa()
      ? '（アクセスの前に ' + base + ' 自体もそのアドレスに書き換える）'
      : ' (and ' + base + ' is updated to it first)';
  } else if (m.mode === 'post') {
    const v = m.disp && m.disp.value != null ? m.disp.value : 0n;
    const a = v < 0n ? -v : v;
    where += isJa()
      ? '（アクセスの後で ' + base + ' を ' + a.toString(10) + ' バイト' + (v < 0n ? '戻す' : '進める') + '）'
      : ' (then ' + base + (v < 0n ? ' moves back ' : ' advances ') + a.toString(10) + ' bytes)';
  }
  return where;
}

/* ────────────────────────────────────────────────────────────
   分岐先 / 参照先
   ──────────────────────────────────────────────────────────── */

const BRANCH_IMM = new Set(['b', 'bl', 'cbz', 'cbnz', 'tbz', 'tbnz']);

/**
 * 同じ 64bit 汎用レジスタか。
 *
 * adrp+add のような「2 行で 1 つの意味」を組み立てるときに、本当に値が
 * つながっているかを確かめるために使います。名前の文字列比較ではなく
 * クラス・番号・幅で見るので、lr / fp のような別名でも取り違えません。
 */
function sameGeneralRegister(a, b) {
  if (!a || !b || a.k !== 'reg' || b.k !== 'reg') return false;
  if (a.cls !== 'gp' || b.cls !== 'gp') return false;
  if (a.bits !== 64 || b.bits !== 64) return false;
  return a.num === b.num;
}

/** 命令が指しているアドレス（BigInt）。ないときは null。 */
export function referenceTarget(mn, opsStr) {
  if (!mn) return null;
  const base = mn.toLowerCase();
  const ops = parseOperands(opsStr);
  const isCond = /^b\.[a-z]{2}$/.test(base);
  // アドレス 0 は「参照なし」の合図ではなく、実在しうる番地です。
  // 存在判定に正の値であることを使うと、0 番地の分岐先/参照先が消えます (#1288)。
  if (BRANCH_IMM.has(base) || isCond || base === 'adr' || base === 'adrp') {
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].k === 'imm' && ops[i].value != null && ops[i].value >= 0n) return ops[i].value;
    }
    return null;
  }
  if (base === 'ldr' && ops.length === 2 && ops[1].k === 'imm' && ops[1].value != null && ops[1].value >= 0n) {
    return ops[1].value;   // リテラルプール読み込み
  }
  return null;
}

/** 分岐命令か。 */
export function isBranch(mn) {
  const b = (mn || '').toLowerCase();
  return BRANCH_IMM.has(b) || /^b\.[a-z]{2}$/.test(b) ||
    b === 'br' || b === 'blr' || b === 'ret' ||
    /^(braa|brab|blraa|blrab|retaa|retab)$/.test(b);
}

export function isCall(mn) {
  const b = (mn || '').toLowerCase();
  return b === 'bl' || b === 'blr' || b === 'blraa' || b === 'blrab';
}

export function isReturn(mn) {
  const b = (mn || '').toLowerCase();
  return b === 'ret' || b === 'retaa' || b === 'retab';
}

/* ────────────────────────────────────────────────────────────
   命令の分類（行の色分けにも使う）
   ──────────────────────────────────────────────────────────── */

const CATEGORY = new Map();
function cat(names, c) { for (const n of names.split(' ')) CATEGORY.set(n, c); }

cat('mov movz movn movk mvn fmov dup ins umov smov', 'move');
cat('add adds sub subs adc adcs sbc sbcs neg negs mul madd msub mneg smull umull smaddl umaddl smsubl umsubl smulh umulh sdiv udiv', 'arith');
cat('and ands orr orn eor eon bic bics lsl lsr asr ror lslv lsrv asrv rorv extr ubfm sbfm bfm ubfx sbfx ubfiz sbfiz bfi bfxil bfc rev rev16 rev32 rev64 clz cls rbit sxtb sxth sxtw uxtb uxth', 'logic');
cat('cmp cmn tst ccmp ccmn fcmp fcmpe', 'compare');
cat('csel csinc csinv csneg cset csetm cinc cinv cneg', 'select');
cat('ldr ldrb ldrh ldrsb ldrsh ldrsw ldur ldurb ldurh ldursb ldursh ldursw ldp ldpsw ldnp ldtr ldxr ldaxr ldar ldarb ldarh ld1 ld2 ld3 ld4 prfm', 'load');
cat('str strb strh stur sturb sturh stp stnp sttr stxr stlxr stlr stlrb stlrh st1 st2 st3 st4', 'store');
cat('b bl br blr ret cbz cbnz tbz tbnz braa brab blraa blrab retaa retab', 'flow');
cat('adr adrp', 'address');
cat('nop hint bti svc hvc smc brk hlt dmb dsb isb yield wfe wfi sev sevl mrs msr sys eret clrex paciasp pacibsp autiasp autibsp pacia pacib autia autib xpaclri pacia1716 dc ic tlbi', 'system');
cat('fadd fsub fmul fdiv fneg fabs fsqrt fmadd fmsub fnmadd fcvt fcvtzs fcvtzu fcvtas fcvtau fcvtms fcvtns fcvtps scvtf ucvtf frinta frintm frintn frintp frintz fmax fmin fmaxnm fminnm', 'float');
cat('movi mvni orr_v addv uaddlv tbl tbx zip1 zip2 uzp1 uzp2 trn1 trn2 ext rev64_v cmeq cmgt xtn sqxtn', 'simd');
cat('casal cas casa casl swp swpa swpl swpal ldadd ldadda ldaddl ldaddal ldset ldclr ldeor', 'atomic');
cat('udf .byte', 'data');

export function categoryOf(mn) {
  if (!mn) return '';
  const b = mn.toLowerCase();
  if (b.charCodeAt(0) === 46) return 'data';
  const direct = CATEGORY.get(b);
  if (direct) return direct;
  if (/^b\./.test(b)) return 'flow';
  if (/^f/.test(b)) return 'float';
  return '';
}

/** カテゴリの日本語名（行の左に出すラベル）。 */
export function categoryLabel(c) {
  const T = {
    move: ['代入', 'move'],
    arith: ['計算', 'maths'],
    logic: ['ビット演算', 'bits'],
    compare: ['比較', 'compare'],
    select: ['条件で選ぶ', 'select'],
    load: ['読み込み', 'load'],
    store: ['書き込み', 'store'],
    flow: ['流れを変える', 'flow'],
    address: ['アドレス作り', 'address'],
    system: ['CPU/OS', 'system'],
    float: ['小数の計算', 'float'],
    simd: ['まとめて計算', 'simd'],
    atomic: ['排他アクセス', 'atomic'],
    data: ['データ', 'data'],
  };
  const e = T[c];
  return e ? pick(e[0], e[1]) : '';
}

/* ────────────────────────────────────────────────────────────
   説明の組み立て
   ──────────────────────────────────────────────────────────── */

const LOAD_SIZES = {
  ldrb: [1, false], ldrsb: [1, true], ldrh: [2, false], ldrsh: [2, true], ldrsw: [4, true],
  ldurb: [1, false], ldursb: [1, true], ldurh: [2, false], ldursh: [2, true], ldursw: [4, true],
  strb: [1, false], strh: [2, false], sturb: [1, false], sturh: [2, false],
};

function sizeOfReg(r) {
  if (!r || r.k !== 'reg') return 8;
  return Math.max(1, r.bits / 8);
}

function sizeWord(bytes) {
  if (!isJa()) return bytes + ' bytes';
  const names = { 1: '1 バイト', 2: '2 バイト（16 ビット）', 4: '4 バイト（32 ビット）', 8: '8 バイト（64 ビット）', 16: '16 バイト（128 ビット）' };
  return names[bytes] || bytes + ' バイト';
}

function J(ja, en) { return pick(ja, en); }

/**
 * 1 命令の説明を作る。
 *
 * @param {string} mn        ニーモニック
 * @param {string} opsStr    オペランド文字列
 * @param {BigInt} address   この命令のアドレス
 * @param {object} ctx       { symbolFor(addr), stringAt(addr), prev, next }
 */
export function explain(mn, opsStr, address, ctx) {
  const c = ctx || {};
  const base = (mn || '').toLowerCase();
  const ops = parseOperands(opsStr || '');
  const out = {
    mnemonic: mn || '',
    operands: opsStr || '',
    category: categoryOf(base),
    title: '',
    summary: '',
    pseudo: '',
    detail: [],
    terms: [],
    target: null,
    parsed: ops,
  };

  const h = HANDLERS[base] || familyHandler(base);
  if (h) {
    // 壊れた行でも表示は続けます。ただし黙って握りつぶすと、handler 側の
    // 実装バグ（未定義ヘルパーの呼び出しなど）が「説明がない命令」に見えて
    // しまい、長期間気付けません。失敗したことを出力に残し、テストが機械的に
    // 検出できるようにします。
    try { h(out, ops, base, address, c); } catch (err) { out.handlerError = (err && err.message) || String(err); }
  }
  if (!out.title) {
    out.title = J('この命令', 'Instruction');
    out.summary = J(
      mn ? mn + ' 命令です。この viewer にはまだ日本語の解説が入っていません。' : '',
      mn ? 'The ' + mn + ' instruction. No plain-language description yet.' : '');
    out.pseudo = (mn || '') + (opsStr ? ' ' + opsStr : '');
  }
  if (out.target == null) out.target = referenceTarget(base, opsStr);
  return out;
}

/** 名前解決つきで「ジャンプ先」を文にする。 */
function targetName(addr, c) {
  if (addr == null) return null;
  const sym = c && c.symbolFor ? c.symbolFor(addr) : null;
  const hex = '0x' + addr.toString(16).toUpperCase();
  return sym ? sym + '（' + hex + '）' : hex;
}

function targetNameEn(addr, c) {
  if (addr == null) return null;
  const sym = c && c.symbolFor ? c.symbolFor(addr) : null;
  const hex = '0x' + addr.toString(16).toUpperCase();
  return sym ? sym + ' (' + hex + ')' : hex;
}

function tgt(addr, c) { return isJa() ? targetName(addr, c) : targetNameEn(addr, c); }

/* ── 汎用ビルダー ─────────────────────────────────────────── */

/** Rd = Rn OP Op2 型 */
function arith(sym, titleJa, titleEn, verbJa, verbEn, terms) {
  return (o, ops) => {
    const [d, n, m] = ops;
    o.title = J(titleJa, titleEn);
    o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ' + sym + ' ' + opShort(m);
    o.summary = J(
      opShort(n) + ' と ' + opShort(m) + (m && m.shift ? shiftText(m.shift) : '') + ' を' + verbJa + '、結果を ' + opShort(d) + ' に入れる。',
      verbEn + ' ' + opShort(n) + ' and ' + opShort(m) + ', put the result in ' + opShort(d) + '.');
    o.terms = terms || ['register'];
  };
}

/** フラグも立てる版（adds/subs/ands…）に一言足す。 */
function withFlags(fn) {
  return (o, ops, base, addr, c) => {
    fn(o, ops, base, addr, c);
    o.detail.push(J(
      '末尾の s は「計算結果でフラグも更新する」という意味です。フラグは直後の条件分岐（b.eq など）が見ます。',
      'The trailing “s” also updates the condition flags, which the next conditional branch reads.'));
    o.terms.push('flags');
  };
}

function regList(ops) { return ops.filter((x) => x.k === 'reg').map((x) => x.text); }

/* ── ハンドラ表 ───────────────────────────────────────────── */

const HANDLERS = Object.create(null);

/* 代入 ------------------------------------------------------- */

HANDLERS.mov = (o, ops) => {
  const [d, s] = ops;
  o.title = J('代入', 'Move');
  o.pseudo = opShort(d) + ' = ' + opShort(s);
  if (s && s.k === 'elem') {
    o.summary = J(
      'ベクタレジスタ v' + s.num + ' の ' + s.index + ' 番目の枠だけを取り出して ' + opShort(d) + ' に入れる。',
      'Take lane ' + s.index + ' of v' + s.num + ' into ' + opShort(d) + '.');
    o.detail.push(J(
      'ベクタレジスタは 16 バイトを何個かの「枠」に区切って使います。その中の 1 枠だけを普通のレジスタへ移す命令です。',
      'A vector register is divided into lanes; this moves one lane into a general-purpose register.'));
    o.terms = ['simd'];
    return;
  }
  if (d && d.k === 'elem') {
    o.summary = J(
      opShort(s) + ' を、ベクタレジスタ v' + d.num + ' の ' + d.index + ' 番目の枠に入れる。',
      'Put ' + opShort(s) + ' into lane ' + d.index + ' of v' + d.num + '.');
    o.terms = ['simd'];
    return;
  }
  if (s && s.k === 'imm') {
    o.summary = J(
      opShort(d) + ' に ' + immText(s) + ' を入れる。',
      'Put ' + immText(s) + ' into ' + opShort(d) + '.');
    o.detail.push(J(
      'アセンブリでは「変数に代入する」がこの形になります。# が付いている値は、命令そのものに埋め込まれた定数です。',
      'This is what “assign a constant to a variable” looks like. The # value is baked into the instruction itself.'));
    o.terms = ['register', 'immediate'];
  } else if (d && s && d.cls === 'gp' && d.num === 29 && s.cls === 'sp') {
    o.title = J('この関数の基準点を決める', 'Set up the frame pointer');
    o.summary = J(
      '今のスタックの位置を x29 に控える。ここから先、ローカル変数の場所は x29 を基準に数えられます。',
      'Record the current stack position in x29 — locals are addressed relative to it from here on.');
    o.detail.push(J(
      '関数の入り口で stp のすぐ後にこれが来るのが定番です。この 2 行が見えたら「新しい関数が始まった」と読めます。' +
      'x29 をたどると「どの関数がどの関数を呼んだか」が分かるので、クラッシュログの呼び出し履歴はこれで作られます。',
      'The standard second line of a prologue. Chained x29 values are what a crash log’s backtrace walks.'));
    o.terms = ['framepointer', 'prologue', 'stack'];
  } else {
    o.summary = J(
      opShort(s) + ' の中身を ' + opShort(d) + ' へコピーする。' + opShort(s) + ' は変わらない。',
      'Copy ' + opShort(s) + ' into ' + opShort(d) + '. ' + opShort(s) + ' is unchanged.');
    o.terms = ['register'];
  }
  addRegRoles(o, ops);
};

HANDLERS.movz = (o, ops) => {
  const [d, s] = ops;
  o.title = J('代入（上を 0 で埋める）', 'Move with zero');
  o.pseudo = opShort(d) + ' = ' + opShort(s);
  o.summary = J(
    opShort(d) + ' に ' + immText(s) + ' を入れ、残りのビットは全部 0 にする。',
    'Set ' + opShort(d) + ' to ' + immText(s) + ', zeroing every other bit.');
  o.detail.push(J(
    'ARM64 の命令は 4 バイトしかないので、64 ビットの大きな定数は一度に書き込めません。' +
    'そこで movz で下 16 ビットを置き、movk で 16 ビットずつ足していきます。',
    'An ARM64 instruction is only 4 bytes, so a 64-bit constant is built 16 bits at a time: movz then movk.'));
  o.terms = ['immediate', 'register'];
};

HANDLERS.movk = (o, ops) => {
  const [d, s] = ops;
  const sh = s && s.shift ? s.shift.amount : 0;
  o.title = J('定数を 16 ビットだけ差し替える', 'Move keeping other bits');
  o.pseudo = opShort(d) + '[' + (sh + 15) + ':' + sh + '] = ' + immShort(s);
  o.summary = J(
    opShort(d) + ' の ' + sh + ' ビット目から 16 ビット分だけを ' + immText(s) + ' に書き換える。他のビットはそのまま。',
    'Replace 16 bits of ' + opShort(d) + ' starting at bit ' + sh + ' with ' + immText(s) + '; the rest is kept.');
  o.detail.push(J(
    '大きな定数（アドレスなど）を movz → movk → movk … と 16 ビットずつ組み立てている途中です。' +
    '数行まとめて 1 つの数だと思って読んでください。',
    'Part of building a large constant 16 bits at a time. Read the movz/movk run as one value.'));
  o.terms = ['immediate'];
};

HANDLERS.movn = (o, ops) => {
  const [d, s] = ops;
  o.title = J('ビットを反転して代入', 'Move NOT');
  o.pseudo = opShort(d) + ' = ~' + opShort(s);
  o.summary = J(
    immText(s) + ' の 0 と 1 をすべてひっくり返した値を ' + opShort(d) + ' に入れる。−1 などの負の数を作るのに使います。',
    'Put the bitwise inverse of ' + immText(s) + ' into ' + opShort(d) + ' — how small negative constants are made.');
  o.terms = ['immediate', 'twoscomplement'];
};

HANDLERS.mvn = (o, ops) => {
  const [d, s] = ops;
  o.title = J('ビット反転', 'Bitwise NOT');
  o.pseudo = opShort(d) + ' = ~' + opShort(s);
  o.summary = J(
    opShort(s) + ' の 0 と 1 をすべて入れ替えて ' + opShort(d) + ' に入れる。',
    'Flip every bit of ' + opShort(s) + ' into ' + opShort(d) + '.');
  o.terms = ['bitwise'];
};

/* 計算 ------------------------------------------------------- */

HANDLERS.add = (o, ops, base, addr, c) => {
  const [d, n, m] = ops;
  o.title = J('足し算', 'Add');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' + ' + opShort(m);
  o.summary = J(
    opShort(n) + ' に ' + (m && m.k === 'imm' ? immText(m) : opShort(m)) + (m && m.shift ? shiftText(m.shift) : '') +
      ' を足して ' + opShort(d) + ' に入れる。',
    'Add ' + opShort(m) + ' to ' + opShort(n) + ', result in ' + opShort(d) + '.');
  o.terms = ['register'];
  if (n && n.cls === 'sp' && d && d.cls === 'gp' && d.num === 29) {
    o.detail.push(J(
      'x29（フレームポインタ）にスタックの位置を控えています。関数の入り口でよく見る形です。',
      'Recording the stack position in x29 (the frame pointer) — a standard function prologue step.'));
    o.terms.push('framepointer');
  }
  if (d && n && d.text === n.text && m && m.k === 'imm') {
    o.detail.push(J(
      '同じレジスタに足し戻しているので、C 言語で書けば ' + opShort(d) + ' += ' + immShort(m) + '; です。',
      'Same register on both sides — in C this is ' + opShort(d) + ' += ' + immShort(m) + ';'));
  }
  // adrp の直後の add はアドレス組み立て。
  // ただし「直前が adrp」だけでは足りません。この add が adrp の書き込み先
  // レジスタを読んでいることまで確かめないと、無関係な 2 行から実在しない
  // 参照先を作ってしまいます (#1289)。
  if (c && c.prev && /^adrp$/i.test(c.prev.mn) && m && m.k === 'imm'
    && sameGeneralRegister(n, parseOperands(c.prev.ops)[0])) {
    const page = referenceTarget('adrp', c.prev.ops);
    if (page != null) {
      const full = page + (m.value || 0n);
      o.target = full;
      o.detail.push(J(
        '1 行上の adrp と組で、' + tgt(full, c) + ' というアドレスを作っています。ARM64 で遠くのデータを指すときの定番の 2 行です。',
        'Together with the adrp above, this builds the address ' + tgt(full, c) + ' — the standard ARM64 pair for reaching distant data.'));
      o.terms.push('adrp');
    }
  }
  addRegRoles(o, ops);
};

HANDLERS.adds = withFlags(HANDLERS.add);

HANDLERS.sub = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('引き算', 'Subtract');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' − ' + opShort(m);
  o.summary = J(
    opShort(n) + ' から ' + (m && m.k === 'imm' ? immText(m) : opShort(m)) + ' を引いて ' + opShort(d) + ' に入れる。',
    'Subtract ' + opShort(m) + ' from ' + opShort(n) + ', result in ' + opShort(d) + '.');
  o.terms = ['register'];
  if (d && n && d.cls === 'sp' && n.cls === 'sp' && m && m.k === 'imm') {
    o.title = J('スタックの場所を確保する', 'Reserve stack space');
    o.summary = J(
      'スタックポインタを ' + (m.value || 0n).toString(10) + ' バイト下げて、その分の作業スペースを確保する。',
      'Lower the stack pointer by ' + m.value + ' bytes to make room for local variables.');
    o.detail.push(J(
      'スタックはアドレスが小さい方へ伸びるので、「引く」＝「場所を取る」です。' +
      '関数の終わりでは同じ量を add sp, sp, #… で返します。',
      'The stack grows downwards, so subtracting reserves space. The epilogue adds the same amount back.'));
    o.terms = ['stack', 'sp'];
  }
  addRegRoles(o, ops);
};

HANDLERS.subs = withFlags(HANDLERS.sub);
HANDLERS.adc = arith('+', '足し算（繰り上がり込み）', 'Add with carry', '繰り上がりも含めて足し', 'Add with carry');
HANDLERS.sbc = arith('−', '引き算（借り込み）', 'Subtract with carry', '借りも含めて引き', 'Subtract with borrow');

HANDLERS.neg = (o, ops) => {
  const [d, s] = ops;
  o.title = J('符号を反転', 'Negate');
  o.pseudo = opShort(d) + ' = −' + opShort(s);
  o.summary = J(
    opShort(s) + ' のプラスマイナスを反転して ' + opShort(d) + ' に入れる。',
    'Flip the sign of ' + opShort(s) + ' into ' + opShort(d) + '.');
  o.terms = ['twoscomplement'];
};

HANDLERS.mul = arith('×', '掛け算', 'Multiply', 'かけ', 'Multiply');
HANDLERS.sdiv = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('割り算（符号あり）', 'Signed divide');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ÷ ' + opShort(m);
  o.summary = J(
    opShort(n) + ' を ' + opShort(m) + ' で割った商（小数は切り捨て）を ' + opShort(d) + ' に入れる。マイナスも扱えます。',
    'Divide ' + opShort(n) + ' by ' + opShort(m) + ' (truncating), signed.');
  o.detail.push(J('0 で割っても例外にはならず、結果は 0 になります。', 'Dividing by zero yields 0 rather than trapping.'));
};
HANDLERS.udiv = (o, ops) => {
  HANDLERS.sdiv(o, ops);
  o.title = J('割り算（符号なし）', 'Unsigned divide');
  o.summary = o.summary.replace(J('マイナスも扱えます。', ''), J('マイナスは扱いません（全部プラスとして計算）。', ''));
};

HANDLERS.madd = (o, ops) => {
  const [d, n, m, a] = ops;
  o.title = J('掛けて足す', 'Multiply-add');
  o.pseudo = opShort(d) + ' = ' + opShort(a) + ' + ' + opShort(n) + ' × ' + opShort(m);
  o.summary = J(
    opShort(n) + ' × ' + opShort(m) + ' を計算し、それに ' + opShort(a) + ' を足して ' + opShort(d) + ' に入れる。',
    'Multiply then add, all in one instruction.');
  o.detail.push(J('配列の添字計算（base + index × サイズ）でよく出てきます。', 'Common in array index arithmetic.'));
};
HANDLERS.msub = (o, ops) => {
  const [d, n, m, a] = ops;
  o.title = J('掛けて引く', 'Multiply-subtract');
  o.pseudo = opShort(d) + ' = ' + opShort(a) + ' − ' + opShort(n) + ' × ' + opShort(m);
  o.summary = J(
    opShort(a) + ' から ' + opShort(n) + ' × ' + opShort(m) + ' を引いて ' + opShort(d) + ' に入れる。',
    'Multiply then subtract.');
  o.detail.push(J('割り算のあとに「余り」を求める形（a − (a÷b)×b）でよく出ます。', 'Often computes a remainder after a division.'));
};
HANDLERS.smull = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('32ビット同士を掛けて64ビットに', 'Signed long multiply');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' × ' + opShort(m);
  o.summary = J(
    '32 ビットの ' + opShort(n) + ' と ' + opShort(m) + ' を掛け、あふれないように 64 ビットの ' + opShort(d) + ' に入れる。',
    'Multiply two 32-bit values into a 64-bit result.');
};
HANDLERS.umull = HANDLERS.smull;

/* ビット演算 ------------------------------------------------- */

HANDLERS.and = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('ビットの AND', 'Bitwise AND');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' & ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' の両方で 1 のビットだけを残して ' + opShort(d) + ' に入れる。',
    'Keep only the bits set in both, into ' + opShort(d) + '.');
  if (m && m.k === 'imm') {
    o.detail.push(J(
      '定数との AND は「必要な部分だけ取り出す」ためのマスクです。例えば & 0xFF なら下 1 バイトだけを残します。',
      'ANDing with a constant masks out everything but the bits you want.'));
  }
  o.terms = ['bitwise', 'mask'];
};
HANDLERS.ands = withFlags(HANDLERS.and);

HANDLERS.orr = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('ビットの OR', 'Bitwise OR');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' | ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' のどちらかで 1 のビットを 1 にして ' + opShort(d) + ' に入れる。',
    'Set the bits present in either operand.');
  o.detail.push(J('「フラグを立てる」ときの定番です。', 'The usual way to turn flag bits on.'));
  o.terms = ['bitwise'];
};

HANDLERS.eor = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('ビットの XOR', 'Bitwise XOR');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ^ ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' で「片方だけ 1」のビットを 1 にして ' + opShort(d) + ' に入れる。',
    'Set the bits that differ between the two.');
  if (n && m && n.text === m.text) {
    o.detail.push(J(
      '同じ値どうしの XOR は必ず 0 です。つまりこれは ' + opShort(d) + ' を 0 にする書き方です。',
      'XOR with itself is always zero — this is a way of writing ' + opShort(d) + ' = 0.'));
  }
  o.detail.push(J('暗号やハッシュの処理でも頻繁に出てきます。', 'Very common in crypto and hashing code.'));
  o.terms = ['bitwise'];
};

HANDLERS.bic = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('ビットを落とす', 'Bit clear');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' & ~' + opShort(m);
  o.summary = J(
    opShort(m) + ' で 1 になっているビットを ' + opShort(n) + ' から消して ' + opShort(d) + ' に入れる。',
    'Clear the bits of ' + opShort(n) + ' that are set in ' + opShort(m) + '.');
  o.terms = ['bitwise'];
};
HANDLERS.orn = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('反転して OR', 'OR NOT');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' | ~' + opShort(m);
  o.summary = J(opShort(m) + ' を反転してから ' + opShort(n) + ' と OR する。', 'OR with the inverse.');
};
HANDLERS.eon = (o, ops) => {
  const [d, n, m] = ops;
  o.title = J('反転して XOR', 'XOR NOT');
  o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ^ ~' + opShort(m);
  o.summary = J(opShort(m) + ' を反転してから XOR する。', 'XOR with the inverse.');
};

function shifter(titleJa, titleEn, verbJa, verbEn, symbol, note) {
  return (o, ops) => {
    const [d, n, m] = ops;
    o.title = J(titleJa, titleEn);
    o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ' + symbol + ' ' + opShort(m);
    const amount = m && m.k === 'imm' ? (m.value == null ? null : m.value) : null;
    const howMany = amount != null ? amount.toString(10) + ' ビット' : opShort(m) + ' ビット';
    o.summary = J(
      opShort(n) + ' のビット全体を ' + howMany + verbJa + '、結果を ' + opShort(d) + ' に入れる。',
      verbEn + ' ' + opShort(n) + ' by ' + opShort(m) + ' into ' + opShort(d) + '.');
    if (amount != null && amount > 0n && amount < 64n && note) o.detail.push(note(amount));
    o.terms = ['bitwise', 'shift'];
  };
}

HANDLERS.lsl = shifter('ビットを左へずらす', 'Shift left', '左へずらして', 'Shift left', '<<', (n) => J(
  '左に ' + n + ' ビットずらすのは、2 の ' + n + ' 乗（' + (2n ** n).toString(10) + '）を掛けるのと同じです。' +
  '掛け算より速いので、コンパイラは「× 2」「× 8」をこの形に置き換えます。',
  'Shifting left by ' + n + ' multiplies by ' + (2n ** n) + ' — cheaper than a multiply, so the compiler prefers it.'));
HANDLERS.lsr = shifter('ビットを右へずらす', 'Shift right', '右へずらして', 'Shift right', '>>', (n) => J(
  '右に ' + n + ' ビットずらすのは、2 の ' + n + ' 乗（' + (2n ** n).toString(10) + '）で割るのと同じです（余りは切り捨て）。' +
  '空いた上位ビットには 0 が入ります。',
  'Shifting right by ' + n + ' divides by ' + (2n ** n) + ', discarding the remainder; zeros fill in at the top.'));
HANDLERS.asr = shifter('ビットを右へずらす（符号を保つ）', 'Arithmetic shift right', '符号を保ったまま右へずらして', 'Arithmetic-shift right', '>>', () => J(
  '空いた上位ビットに、元の符号ビット（一番上のビット）と同じ値を詰めます。' +
  'こうするとマイナスの数もマイナスのまま割り算できます。',
  'The vacated top bits are filled with the sign bit, so negative values divide correctly.'));
HANDLERS.ror = shifter('ビットを回転させる', 'Rotate right', '回転させて', 'Rotate', 'ror', () => J(
  '端からこぼれたビットが反対側から戻ってくる「回転」です。値のビットは 1 つも失われません。' +
  'ハッシュや暗号の計算でよく使われます。',
  'Bits that fall off one end reappear at the other — nothing is lost. Common in hashing and crypto.'));

HANDLERS.ubfx = (o, ops) => {
  const [d, n, lsb, width] = ops;
  o.title = J('ビットを切り出す', 'Extract bit field');
  o.pseudo = opShort(d) + ' = (' + opShort(n) + ' >> ' + immShort(lsb) + ') & ' + (width && width.value != null ? '0x' + ((1n << width.value) - 1n).toString(16).toUpperCase() : '…');
  o.summary = J(
    opShort(n) + ' の ' + immShort(lsb) + ' ビット目から ' + immShort(width) + ' ビット分を抜き出して ' + opShort(d) + ' に入れる。上は 0 で埋める。',
    'Take ' + immShort(width) + ' bits starting at bit ' + immShort(lsb) + ' of ' + opShort(n) + '.');
  o.detail.push(J('1 個の数の中に複数の情報を詰め込んでいるときの取り出しです。', 'Unpacking several fields stored in one word.'));
  o.terms = ['bitfield'];
};
HANDLERS.sbfx = (o, ops) => { HANDLERS.ubfx(o, ops); o.title = J('ビットを切り出す（符号つき）', 'Extract signed bit field'); };
HANDLERS.ubfiz = (o, ops) => {
  const [d, n, lsb, width] = ops;
  o.title = J('切り出して左に置く', 'Insert bit field');
  o.pseudo = opShort(d) + ' = (' + opShort(n) + ' & mask) << ' + immShort(lsb);
  o.summary = J(
    opShort(n) + ' の下 ' + immShort(width) + ' ビットを取り、' + immShort(lsb) + ' ビット目の位置に置いて ' + opShort(d) + ' に入れる。',
    'Take the low bits and place them at bit ' + immShort(lsb) + '.');
  o.terms = ['bitfield'];
};
HANDLERS.sbfiz = HANDLERS.ubfiz;
HANDLERS.bfi = (o, ops) => {
  const [d, n, lsb, width] = ops;
  o.title = J('ビットを差し込む', 'Bit field insert');
  o.pseudo = opShort(d) + '[' + immShort(lsb) + '…] = ' + opShort(n);
  o.summary = J(
    opShort(n) + ' の下 ' + immShort(width) + ' ビットを、' + opShort(d) + ' の ' + immShort(lsb) + ' ビット目に埋め込む。他はそのまま。',
    'Insert bits of ' + opShort(n) + ' into ' + opShort(d) + ' without touching the rest.');
  o.terms = ['bitfield'];
};
HANDLERS.bfxil = HANDLERS.bfi;

HANDLERS.extr = (o, ops) => {
  const [d, n, m, lsb] = ops;
  o.title = J('2 つをつないで切り出す', 'Extract from pair');
  o.pseudo = opShort(d) + ' = concat(' + opShort(n) + ', ' + opShort(m) + ') >> ' + immShort(lsb);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' を横に並べた長いビット列から、' + immShort(lsb) + ' ビット目以降を切り出す。',
    'Concatenate the two registers and take a window out of the middle.');
};

HANDLERS.rev = (o, ops) => {
  const [d, s] = ops;
  o.title = J('バイトの順番を逆に', 'Reverse bytes');
  o.pseudo = opShort(d) + ' = byteswap(' + opShort(s) + ')';
  o.summary = J(
    opShort(s) + ' のバイトの並びを前後ひっくり返して ' + opShort(d) + ' に入れる。',
    'Reverse the byte order of ' + opShort(s) + '.');
  o.detail.push(J(
    'ネットワークのデータは「大きい桁が先」（ビッグエンディアン）、ARM は「小さい桁が先」（リトルエンディアン）なので、変換にこれを使います。',
    'Network data is big-endian while ARM is little-endian, so byte swapping converts between them.'));
  o.terms = ['endian'];
};
HANDLERS.rev16 = HANDLERS.rev;
HANDLERS.rev32 = HANDLERS.rev;

HANDLERS.clz = (o, ops) => {
  const [d, s] = ops;
  o.title = J('先頭に並ぶ 0 を数える', 'Count leading zeros');
  o.pseudo = opShort(d) + ' = clz(' + opShort(s) + ')';
  o.summary = J(
    opShort(s) + ' を 2 進数で書いたとき、頭にいくつ 0 が続くかを数えて ' + opShort(d) + ' に入れる。',
    'Count the zero bits before the first 1.');
  o.detail.push(J('「この数は何桁必要か」を高速に求めるのに使われます。', 'A fast way to ask how many bits a value needs.'));
};
HANDLERS.rbit = (o, ops) => {
  const [d, s] = ops;
  o.title = J('ビットの並びを逆に', 'Reverse bits');
  o.pseudo = opShort(d) + ' = bitreverse(' + opShort(s) + ')';
  o.summary = J(opShort(s) + ' のビットを前後ひっくり返して ' + opShort(d) + ' に入れる。', 'Reverse the bit order.');
};

function extend(bytes, signed) {
  return (o, ops) => {
    const [d, s] = ops;
    o.title = signed ? J('符号を伸ばして拡張', 'Sign extend') : J('0 を詰めて拡張', 'Zero extend');
    o.pseudo = opShort(d) + ' = ' + (signed ? '(signed)' : '(unsigned)') + opShort(s);
    o.summary = signed
      ? J(opShort(s) + ' の下 ' + bytes * 8 + ' ビットを取り出し、マイナスならマイナスのまま大きい幅にして ' + opShort(d) + ' に入れる。',
          'Take the low ' + bytes * 8 + ' bits and widen them, keeping the sign.')
      : J(opShort(s) + ' の下 ' + bytes * 8 + ' ビットを取り出し、上を 0 で埋めて ' + opShort(d) + ' に入れる。',
          'Take the low ' + bytes * 8 + ' bits and zero the rest.');
    o.detail.push(J(
      'C 言語で char や short を int に代入したときに、コンパイラがここを入れます。',
      'What the compiler emits when a char or short is assigned to an int.'));
    o.terms = ['signedness'];
  };
}
HANDLERS.sxtb = extend(1, true);
HANDLERS.sxth = extend(2, true);
HANDLERS.sxtw = extend(4, true);
HANDLERS.uxtb = extend(1, false);
HANDLERS.uxth = extend(2, false);

/* 比較 ------------------------------------------------------- */

HANDLERS.cmp = (o, ops) => {
  const [n, m] = ops;
  o.title = J('比べる', 'Compare');
  o.pseudo = 'flags = ' + opShort(n) + ' − ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + (m && m.k === 'imm' ? immText(m) : opShort(m)) + ' を比べる。結果はレジスタには残らず、フラグにだけ残る。',
    'Compare ' + opShort(n) + ' with ' + opShort(m) + '. The result only updates the flags.');
  o.detail.push(J(
    '実際には引き算をして、答えは捨て、「0 だったか」「マイナスだったか」だけを覚えます。' +
    'その直後の b.eq / b.lt などが、その覚えた結果を見て進む先を決めます。つまり cmp と分岐は必ずセットで読みます。',
    'It subtracts, throws the result away and keeps only the flags. The following b.eq / b.lt reads them — always read the pair together.'));
  o.terms = ['flags', 'branch'];
};
HANDLERS.cmn = (o, ops) => {
  const [n, m] = ops;
  o.title = J('足した結果で比べる', 'Compare negative');
  o.pseudo = 'flags = ' + opShort(n) + ' + ' + opShort(m);
  o.summary = J(
    opShort(n) + ' に ' + opShort(m) + ' を足した結果でフラグを立てる。「−N と比べる」ときに使われます。',
    'Adds instead of subtracting; used to compare against a negative number.');
  o.terms = ['flags'];
};
HANDLERS.tst = (o, ops) => {
  const [n, m] = ops;
  o.title = J('ビットが立っているか調べる', 'Test bits');
  o.pseudo = 'flags = ' + opShort(n) + ' & ' + opShort(m);
  o.summary = J(
    opShort(n) + ' の中で ' + opShort(m) + ' が示すビットが 1 かどうかを調べる。結果はフラグにだけ残る。',
    'AND the two and keep only the flags — “is this bit set?”.');
  o.detail.push(J(
    '直後が b.eq なら「そのビットが 0 だったら飛ぶ」、b.ne なら「1 だったら飛ぶ」です。',
    'A following b.eq means “the bit was clear”; b.ne means “it was set”.'));
  o.terms = ['flags', 'mask'];
};
HANDLERS.ccmp = (o, ops) => {
  const [n, m, nzcv, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件つきで比べる', 'Conditional compare');
  o.pseudo = 'if (' + (cond ? cond.text : '?') + ') flags = ' + opShort(n) + ' − ' + opShort(m) + ' else flags = ' + immShort(nzcv);
  o.summary = J(
    '前の比較が「' + (ci ? ci.ja : '条件を満たしたとき') + '」に当てはまる場合だけ、' +
      opShort(n) + ' と ' + opShort(m) + ' をもう一度比べる。当てはまらなければフラグを ' + immShort(nzcv) + ' に決め打ちする。',
    'Compare again only if the previous condition held; otherwise force the flags to ' + immShort(nzcv) + '.');
  o.detail.push(J(
    'C 言語の && や || を、分岐を増やさずに 1 本にまとめた形です（if (a == 1 && b == 2) など）。',
    'How && and || are compiled without extra branches.'));
  o.terms = ['flags'];
};
HANDLERS.ccmn = HANDLERS.ccmp;

/* 条件で選ぶ ------------------------------------------------- */

HANDLERS.csel = (o, ops) => {
  const [d, n, m, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件で選ぶ', 'Conditional select');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? ' + opShort(n) + ' : ' + opShort(m);
  o.summary = J(
    '直前の比較が「' + (ci ? ci.ja : cond && cond.text) + '」なら ' + opShort(n) + '、そうでなければ ' + opShort(m) + ' を ' + opShort(d) + ' に入れる。',
    'Put ' + opShort(n) + ' in ' + opShort(d) + ' if ' + (ci ? ci.en : '') + ', otherwise ' + opShort(m) + '.');
  o.detail.push(J(
    'C 言語の三項演算子 a = cond ? b : c と同じです。分岐しないので速く、条件によって実行時間が変わらないため暗号処理でも好まれます。',
    'The ternary operator, without a branch.'));
  o.terms = ['flags'];
};
HANDLERS.csinc = (o, ops) => {
  const [d, n, m, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件で選ぶ（片方は +1）', 'Conditional select increment');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? ' + opShort(n) + ' : ' + opShort(m) + ' + 1';
  o.summary = J(
    '「' + (ci ? ci.ja : '') + '」なら ' + opShort(n) + '、違えば ' + opShort(m) + ' に 1 を足した値を ' + opShort(d) + ' に入れる。',
    'Select, adding one to the second choice.');
  o.terms = ['flags'];
};
HANDLERS.csinv = HANDLERS.csinc;
HANDLERS.csneg = HANDLERS.csinc;

HANDLERS.cset = (o, ops) => {
  const [d, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件を 0 か 1 にする', 'Set to 0 or 1');
  o.pseudo = opShort(d) + ' = (' + (ci ? ci.expr : cond && cond.text) + ') ? 1 : 0';
  o.summary = J(
    '直前の比較が「' + (ci ? ci.ja : '') + '」なら ' + opShort(d) + ' に 1、そうでなければ 0 を入れる。',
    'Set ' + opShort(d) + ' to 1 when ' + (ci ? ci.en : '') + ', else 0.');
  o.detail.push(J(
    'C 言語で bool result = (a == b); と書いたときの形です。',
    'What “bool r = (a == b);” compiles to.'));
  o.terms = ['flags'];
};
HANDLERS.csetm = (o, ops) => {
  const [d, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件を 0 か「全ビット 1」にする', 'Set to 0 or all-ones');
  o.pseudo = opShort(d) + ' = (' + (ci ? ci.expr : cond && cond.text) + ') ? -1 : 0';
  o.summary = J(
    '直前の比較が「' + (ci ? ci.ja : '') + '」なら ' + opShort(d) + ' を全ビット 1（＝ −1）に、そうでなければ 0 にする。',
    'Set ' + opShort(d) + ' to all-ones (−1) when ' + (ci ? ci.en : '') + ', else 0.');
  o.detail.push(J(
    '全ビット 1 は、そのあと AND で使う「マスク」として便利なので、分岐なしで値を選ぶ書き方に使われます。',
    'All-ones makes a handy mask for a following AND — a branch-free way to select a value.'));
  o.terms = ['flags', 'mask'];
};
HANDLERS.cinc = (o, ops) => {
  const [d, n, cond] = ops;
  const ci = cond ? condInfo(cond.text) : null;
  o.title = J('条件が合えば +1', 'Conditional increment');
  o.pseudo = opShort(d) + ' = ' + (cond ? cond.text : '?') + ' ? ' + opShort(n) + ' + 1 : ' + opShort(n);
  o.summary = J(
    '「' + (ci ? ci.ja : '') + '」なら ' + opShort(n) + ' に 1 を足して、違えばそのまま ' + opShort(d) + ' に入れる。',
    'Add one only if the condition holds.');
  o.terms = ['flags'];
};
HANDLERS.cinv = HANDLERS.cinc;
HANDLERS.cneg = HANDLERS.cinc;

/* メモリ ----------------------------------------------------- */

function loadStore(isLoad) {
  return (o, ops, base, addr, c) => {
    const dst = ops[0];
    const mem = ops.find((x) => x.k === 'mem');
    const size = LOAD_SIZES[base] ? LOAD_SIZES[base][0] : sizeOfReg(dst);
    const signed = LOAD_SIZES[base] ? LOAD_SIZES[base][1] : false;
    o.title = isLoad ? J('メモリから読む', 'Load from memory') : J('メモリへ書く', 'Store to memory');
    if (!mem) { o.pseudo = (mn2(base) || base) + ' ' + (o.operands || ''); return; }
    o.pseudo = isLoad
      ? opShort(dst) + ' = *(' + cType(size, signed) + '*)(' + memExpr(mem) + ')'
      : '*(' + cType(size, signed) + '*)(' + memExpr(mem) + ') = ' + opShort(dst);
    o.summary = isLoad
      ? J(memText(mem) + 'から ' + sizeWord(size) + ' 読み込み、' + opShort(dst) + ' に入れる。',
          'Read ' + sizeWord(size) + ' from ' + memText(mem) + ' into ' + opShort(dst) + '.')
      : J(opShort(dst) + ' の値（' + sizeWord(size) + '）を、' + memText(mem) + 'へ書き込む。',
          'Write ' + sizeWord(size) + ' from ' + opShort(dst) + ' to ' + memText(mem) + '.');
    o.detail.push(J(
      'レジスタは 31 本しかないので、それより多くのデータはメモリに置きます。' +
      'メモリを使うにはこのように「アドレスを作って、読む／書く」の 2 段構えになります。',
      'There are only 31 registers, so everything else lives in memory: build an address, then load or store.'));
    if (signed) {
      o.detail.push(J(
        's が付いているので、読んだ値がマイナスならマイナスのまま大きい幅に伸ばします。',
        'The “s” means the value is sign-extended as it is widened.'));
      o.terms.push('signedness');
    }
    if (mem.base && mem.base.cls === 'sp') {
      o.detail.push(isLoad
        ? J('sp からの読み込みなので、この関数のローカル変数（一時的な変数）を読んでいます。',
            'Reading from sp — this is a local variable of the current function.')
        : J('sp への書き込みなので、この関数のローカル変数に値をしまっています。',
            'Writing to sp — storing into a local variable.'));
      o.terms.push('stack');
    }
    if (mem.mode === 'pre' || mem.mode === 'post') {
      o.detail.push(J(
        'アドレスを計算するついでに ' + mem.base.text + ' 自体も進める書き方です。配列を 1 つずつ舐めるループでよく出ます。',
        'The base register is updated as a side effect — typical of a loop walking an array.'));
    }
    o.terms.push('memory', 'address');
    addRegRoles(o, ops);
  };
}
function mn2(x) { return x; }
function cType(size, signed) {
  const t = { 1: 'int8', 2: 'int16', 4: 'int32', 8: 'int64', 16: 'int128' }[size] || 'int' + size * 8;
  return (signed ? '' : 'u') + t;
}

for (const n of ['ldr', 'ldrb', 'ldrh', 'ldrsb', 'ldrsh', 'ldrsw', 'ldur', 'ldurb', 'ldurh', 'ldursb', 'ldursh', 'ldursw', 'ldtr', 'ldar', 'ldarb', 'ldarh', 'ldxr', 'ldaxr']) {
  HANDLERS[n] = loadStore(true);
}
for (const n of ['str', 'strb', 'strh', 'stur', 'sturb', 'sturh', 'sttr', 'stlr', 'stlrb', 'stlrh']) {
  HANDLERS[n] = loadStore(false);
}

/* ldr のリテラル形式（ldr x0, #0x…）は別扱い */
const plainLdr = HANDLERS.ldr;
HANDLERS.ldr = (o, ops, base, addr, c) => {
  if (ops.length === 2 && ops[1].k === 'imm' && ops[1].value != null) {
    const at = ops[1].value;
    o.title = J('近くに置かれた定数を読む', 'Load from a literal pool');
    o.pseudo = opShort(ops[0]) + ' = *(uint64*)0x' + at.toString(16).toUpperCase();
    o.summary = J(
      'この命令の近くに埋め込まれている値（' + tgt(at, c) + ' の場所）を読み込んで ' + opShort(ops[0]) + ' に入れる。',
      'Read the constant stored at ' + tgt(at, c) + ' into ' + opShort(ops[0]) + '.');
    o.detail.push(J(
      '命令には大きな数をそのまま書けないので、コンパイラはコードのすぐ近くに数を置いて、こうして読み出します。' +
      'そこは命令ではなくデータなので、逆アセンブルすると意味不明な行に見えます。',
      'Large constants cannot fit in an instruction, so they are parked next to the code and loaded from there. ' +
      'That area is data, not code, and looks like nonsense when disassembled.'));
    o.target = at;
    o.terms = ['literalpool', 'memory'];
    return;
  }
  plainLdr(o, ops, base, addr, c);
};

function pairLoadStore(isLoad) {
  return (o, ops, base, addr, c) => {
    const [a, b] = ops;
    const mem = ops.find((x) => x.k === 'mem');
    const size = sizeOfReg(a);
    o.title = isLoad ? J('2 本まとめて読む', 'Load a pair') : J('2 本まとめて書く', 'Store a pair');
    if (!mem) return;
    o.pseudo = isLoad
      ? opShort(a) + ', ' + opShort(b) + ' = *(pair*)(' + memExpr(mem) + ')'
      : '*(pair*)(' + memExpr(mem) + ') = ' + opShort(a) + ', ' + opShort(b);
    o.summary = isLoad
      ? J(memText(mem) + 'から ' + sizeWord(size) + ' ずつ 2 個読み、' + opShort(a) + ' と ' + opShort(b) + ' に入れる。',
          'Read two values into ' + opShort(a) + ' and ' + opShort(b) + '.')
      : J(opShort(a) + ' と ' + opShort(b) + ' を、' + memText(mem) + 'から順に 2 個ぶん書き込む。',
          'Write ' + opShort(a) + ' and ' + opShort(b) + ' side by side.');
    o.detail.push(J(
      '2 本を 1 命令で扱えるので、関数の入口と出口でレジスタを退避／復元するときの定番です。',
      'Two registers in one instruction — the standard way to save and restore around a function.'));
    // 典型的なプロローグ / エピローグ
    const isFpLr = a && b && a.num === 29 && b.num === 30;
    const onStack = mem.base && mem.base.cls === 'sp';
    const dispVal = mem.disp && mem.disp.value != null ? mem.disp.value : 0n;
    if (onStack && mem.mode === 'pre' && dispVal < 0n && !isLoad) {
      o.title = J('スタックへ積む（push）', 'Push onto the stack');
      o.summary = J(
        'スタックを ' + (-dispVal).toString(10) + ' バイト広げて、その先頭に ' + opShort(a) + ' と ' + opShort(b) + ' を置く。',
        'Grow the stack by ' + (-dispVal) + ' bytes and put ' + opShort(a) + ' and ' + opShort(b) + ' there.');
    } else if (onStack && mem.mode === 'post' && dispVal > 0n && isLoad) {
      o.title = J('スタックから降ろす（pop）', 'Pop from the stack');
      o.summary = J(
        'スタックの先頭から ' + opShort(a) + ' と ' + opShort(b) + ' を取り戻し、スタックを ' + dispVal.toString(10) + ' バイト縮める。',
        'Take ' + opShort(a) + ' and ' + opShort(b) + ' back off the stack and shrink it by ' + dispVal + ' bytes.');
    }
    if (isFpLr && !isLoad) {
      o.title = J('関数の入り口（今の場所を保存）', 'Function prologue');
      o.summary = J(
        '戻り先アドレス (x30) と、呼び出し元のフレーム位置 (x29) をスタックに保存する。関数の始まりの合図です。',
        'Save the return address and the caller’s frame pointer — the start of a function.');
      o.detail.push(J(
        'これをやらないと、別の関数を呼んだ瞬間に「どこへ帰ればいいか」を忘れてしまいます。' +
        '関数の終わりでは ldp で逆に取り出します。',
        'Without this, calling another function would destroy the return address. The epilogue restores it with ldp.'));
      o.terms.push('prologue', 'lr', 'stack');
    } else if (isFpLr && isLoad) {
      o.title = J('関数の出口（元に戻す）', 'Function epilogue');
      o.summary = J(
        'スタックに預けておいた戻り先アドレス (x30) とフレーム位置 (x29) を取り戻す。もうすぐ ret で帰ります。',
        'Restore the saved return address and frame pointer — a ret is coming.');
      o.terms.push('epilogue', 'lr', 'stack');
    } else if (a && a.num >= 19 && a.num <= 28) {
      o.detail.push(isLoad
        ? J('x19〜x28 は「呼ばれた側が元に戻す約束」のレジスタです。ここで戻しています。',
            'x19–x28 are callee-saved; this restores them.')
        : J('x19〜x28 は「呼ばれた側が元に戻す約束」のレジスタなので、使う前に預けています。',
            'x19–x28 are callee-saved, so they are stashed before use.'));
      o.terms.push('calleesaved');
    }
    o.terms.push('stack', 'memory');
  };
}
HANDLERS.stp = pairLoadStore(false);
HANDLERS.stnp = pairLoadStore(false);
HANDLERS.ldp = pairLoadStore(true);
HANDLERS.ldnp = pairLoadStore(true);
HANDLERS.ldpsw = pairLoadStore(true);

HANDLERS.prfm = (o, ops) => {
  const mem = ops.find((x) => x.k === 'mem');
  o.title = J('先に読み込ませておく', 'Prefetch');
  o.pseudo = 'prefetch(' + (mem ? memExpr(mem) : '') + ')';
  o.summary = J(
    'あとで使うデータを、CPU に「そろそろ用意しておいて」と伝える。値は何も変わりません。',
    'Hint to the CPU to fetch this memory early. Nothing changes.');
  o.detail.push(J('速度のためだけの命令なので、動きを読むときは無視して構いません。', 'Purely a performance hint — safe to ignore when reading logic.'));
};

/* アドレス作り ----------------------------------------------- */

HANDLERS.adr = (o, ops, base, addr, c) => {
  const [d, imm] = ops;
  const at = imm && imm.value;
  o.title = J('近くのアドレスを作る', 'Address of nearby');
  o.pseudo = opShort(d) + ' = 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
  o.summary = J(
    opShort(d) + ' に ' + tgt(at, c) + ' というアドレスそのものを入れる（中身は読まない）。',
    'Put the address ' + tgt(at, c) + ' itself into ' + opShort(d) + ' (no memory is read).');
  o.target = at;
  o.terms = ['address', 'pcrelative'];
};

HANDLERS.adrp = (o, ops, base, addr, c) => {
  const [d, imm] = ops;
  const at = imm && imm.value;
  o.title = J('遠くのアドレスの「ページ」を作る', 'Address of a 4 KB page');
  o.pseudo = opShort(d) + ' = 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
  o.summary = J(
    opShort(d) + ' に ' + tgt(at, c) + ' を入れる。これは 4096 バイト単位に切り下げた「おおまかな住所」です。',
    'Put ' + tgt(at, c) + ' — a 4 KB-aligned page address — into ' + opShort(d) + '.');
  o.detail.push(J(
    '4 バイトの命令 1 つでは遠い場所を指せないので、まず adrp でおおまかな位置を作り、' +
    '次の行の add または ldr で細かい位置を足します。この 2 行はセットで 1 つのアドレスだと思ってください。',
    'One 4-byte instruction cannot hold a far address, so adrp gives the page and the next add/ldr adds the offset. ' +
    'Read the two lines as one address.'));
  o.target = at;
  o.terms = ['address', 'adrp', 'pcrelative'];
};

/* 分岐 ------------------------------------------------------- */

HANDLERS.b = (o, ops, base, addr, c) => {
  const at = ops[0] && ops[0].value;
  o.title = J('ジャンプ', 'Branch');
  o.pseudo = 'goto 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
  const dir = at != null && addr != null ? (at < addr ? J('前（上）', 'backwards') : J('後ろ（下）', 'forwards')) : '';
  o.summary = J(
    '無条件で ' + tgt(at, c) + ' へ飛ぶ。ここから下の行は（飛んでこない限り）実行されません。',
    'Jump to ' + tgt(at, c) + ' unconditionally.');
  if (at != null && addr != null && at < addr) {
    // 「飛び先が前にある」だけではループの証拠になりません。自然な逆辺は
    // 飛び先がこの行を支配し、両端が同じ強連結成分にあるときだけです
    // (js/controlflow.js analyzeGraph)。1 行だけを見るこの説明器には
    // その情報がないので、向きだけを事実として述べます (#1293)。
    o.detail.push(J(
      '飛び先が今より前（上）です。ループの終わりのこともありますが、'
      + '前に置かれた別のブロックへ飛ぶだけのこともあります。'
      + 'ループかどうかは、関数全体の流れ（制御フローグラフ）を見ないと決まりません。',
      'The target is earlier (above) than this line. That can be the bottom of a loop, '
      + 'but it can also be a jump into an earlier block. Only the function-wide control-flow '
      + 'graph can tell which.'));
  } else {
    o.detail.push(J(
      '飛び先が今より後ろなので、if 文の「else を飛ばす」ような使い方でしょう。',
      'The target is later — typically skipping over an else block.'));
  }
  o.target = at;
  o.terms.push('branch');
};

HANDLERS.bl = (o, ops, base, addr, c) => {
  const at = ops[0] && ops[0].value;
  const sym = at != null && c && c.symbolFor ? c.symbolFor(at) : null;
  o.title = J('関数を呼ぶ', 'Call a function');
  o.pseudo = (sym ? sym : '0x' + (at != null ? at.toString(16).toUpperCase() : '?')) + '()';
  o.summary = sym
    ? J(sym + ' を呼び出す。終わったらこの次の行に戻ってきます。',
        'Call ' + sym + '; execution returns to the next line.')
    : J(tgt(at, c) + ' にある関数を呼び出す。終わったらこの次の行に戻ってきます。',
        'Call the function at ' + tgt(at, c) + '; execution returns to the next line.');
  o.detail.push(J(
    'bl は「飛ぶ前に、次の行のアドレスを x30 (lr) にメモしてから飛ぶ」命令です。' +
    '呼ばれた側は最後に ret でその x30 へ帰ってきます。これが関数呼び出しの正体です。',
    'bl records the address of the following instruction in x30 (lr) before jumping; the callee returns to it with ret. ' +
    'That is all a function call is.'));
  o.detail.push(J(
    '引数は x0、x1、x2… の順に入れて渡し、戻り値は x0 で受け取ります。' +
    'この行の少し上を見ると、x0 などに値を入れている行があるはずです。それが引数です。',
    'Arguments go in x0, x1, x2 … and the result comes back in x0. Look just above for the lines that set them.'));
  o.target = at;
  o.terms = ['call', 'lr', 'abi'];
};

HANDLERS.blr = (o, ops) => {
  const r = ops[0];
  o.title = J('レジスタの指す関数を呼ぶ', 'Call through a register');
  o.pseudo = '(*' + opShort(r) + ')()';
  o.summary = J(
    opShort(r) + ' に入っているアドレスの関数を呼ぶ。どこへ行くかは実行してみないと分かりません。',
    'Call whatever address is in ' + opShort(r) + '. The target is only known at run time.');
  o.detail.push(J(
    '関数ポインタ、Objective-C のメソッド呼び出し、仮想関数などがこの形になります。' +
    '「どの関数か」を知るには、少し上で ' + opShort(r) + ' に何を入れているかを追いかけます。',
    'Function pointers, Objective-C message sends and C++ virtual calls all look like this. Trace what fills ' + opShort(r) + '.'));
  o.terms = ['call', 'indirect'];
};

HANDLERS.br = (o, ops) => {
  const r = ops[0];
  o.title = J('レジスタの指す先へ飛ぶ', 'Jump through a register');
  o.pseudo = 'goto *' + opShort(r);
  o.summary = J(
    opShort(r) + ' の中のアドレスへ飛ぶ。戻ってきません。',
    'Jump to the address in ' + opShort(r) + ' and do not come back.');
  o.detail.push(J(
    'switch 文の飛び先表や、ライブラリ関数への中継（スタブ）でよく出ます。',
    'Common in switch jump tables and in stubs that forward to library functions.'));
  o.terms = ['indirect'];
};

HANDLERS.ret = (o, ops) => {
  const r = ops && ops[0] && ops[0].k === 'reg' ? ops[0].text : 'x30';
  o.title = J('関数から帰る', 'Return');
  o.pseudo = 'return';
  o.summary = J(
    r + (r === 'x30' ? ' (lr)' : '') + ' に入っている「戻り先アドレス」へジャンプして、呼び出し元に帰る。ここでこの関数は終わりです。',
    'Jump to the return address held in ' + r + '. This is the end of the function.');
  o.detail.push(J(
    '戻り値があるなら x0（32 ビットなら w0）に入っています。この行の少し上で x0 に何を入れたかを見てください。',
    'A return value, if any, is already in x0 / w0 — look at the lines just above.'));
  o.terms = ['lr', 'abi', 'epilogue'];
};
HANDLERS.retaa = HANDLERS.ret;
HANDLERS.retab = HANDLERS.ret;

function condBranch(o, ops, base, addr, c) {
  const cond = base.slice(2);
  const ci = condInfo(cond);
  const at = ops[0] && ops[0].value;
  o.title = J('条件つきジャンプ', 'Conditional branch');
  o.pseudo = 'if (' + (ci ? ci.expr : cond) + ') goto 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
  o.summary = J(
    '直前の比較（cmp / tst など）が「' + (ci ? ci.ja : cond) + '」なら ' + tgt(at, c) + ' へ飛ぶ。違えばそのまま次の行へ進む。',
    'If the previous compare was ' + (ci ? ci.en : cond) + ', jump to ' + tgt(at, c) + '; otherwise fall through.');
  o.detail.push(J(
    'これが if 文の正体です。「飛ぶ」「飛ばない」の 2 択で、飛ばなかった場合はすぐ下の行が実行されます。',
    'This is what an if statement becomes: take the jump, or fall through to the next line.'));
  if (at != null && addr != null && at < addr) {
    // 逆向きの条件分岐も、それだけではループの証明になりません (#1293)。
    o.detail.push(J('飛び先が今より前（上）です。while / for の底であることも多いですが、'
      + 'ループかどうかは関数全体の流れ（制御フローグラフ）を見て決まります。',
      'The target is earlier (above). This is often the bottom of a while/for loop, but only the '
      + 'function-wide control-flow graph proves it.'));
  }
  o.target = at;
  o.terms.push('branch', 'flags');
}

function cbzHandler(zero) {
  return (o, ops, base, addr, c) => {
    const [r, immOp] = ops;
    const at = immOp && immOp.value;
    o.title = zero ? J('0 なら飛ぶ', 'Branch if zero') : J('0 でなければ飛ぶ', 'Branch if not zero');
    o.pseudo = 'if (' + opShort(r) + (zero ? ' == 0' : ' != 0') + ') goto 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
    o.summary = J(
      opShort(r) + ' が ' + (zero ? '0 なら' : '0 以外なら') + ' ' + tgt(at, c) + ' へ飛ぶ。違えば次の行へ。',
      'Jump to ' + tgt(at, c) + ' when ' + opShort(r) + (zero ? ' is zero' : ' is not zero') + '.');
    o.detail.push(J(
      'cmp を書かずに、レジスタが 0 かどうかだけをその場で見る短縮形です。' +
      'C 言語の if (p == NULL) や if (n) がよくこの形になります。',
      'A shortcut that tests for zero without a separate compare — “if (p == NULL)” and “if (n)” compile to this.'));
    // cbz/cbnz も、アドレスの前後関係だけでループと断定しません (#1293)。
    o.target = at;
    o.terms.push('branch');
  };
}
HANDLERS.cbz = cbzHandler(true);
HANDLERS.cbnz = cbzHandler(false);

function tbzHandler(zero) {
  return (o, ops, base, addr, c) => {
    const [r, bit, immOp] = ops;
    const at = immOp && immOp.value;
    const n = bit && bit.value != null ? bit.value.toString(10) : '?';
    const nth = bit && bit.value != null ? '（一番下を 0 として数えて ' + (bit.value + 1n).toString(10) + ' 個目）' : '';
    o.title = zero ? J('そのビットが 0 なら飛ぶ', 'Branch if bit clear') : J('そのビットが 1 なら飛ぶ', 'Branch if bit set');
    o.pseudo = 'if ((' + opShort(r) + ' >> ' + n + ' & 1)' + (zero ? ' == 0' : ' == 1') + ') goto 0x' + (at != null ? at.toString(16).toUpperCase() : '?');
    o.summary = J(
      opShort(r) + ' のビット ' + n + nth + ' が ' + (zero ? '0' : '1') + ' なら ' + tgt(at, c) + ' へ飛ぶ。',
      'Jump when bit ' + n + ' of ' + opShort(r) + ' is ' + (zero ? 'clear' : 'set') + '.');
    if (bit && bit.value != null && (bit.value === 63n || bit.value === 31n)) {
      o.detail.push(J(
        '一番上のビットは符号ビットなので、これは実質「マイナスかどうか」の判定です。',
        'The top bit is the sign bit, so this is really a “is it negative?” test.'));
    }
    o.detail.push(J('フラグ（設定のオンオフ）を 1 ビットずつ詰めた値の判定でよく出ます。',
      'Common when several boolean flags are packed into one value.'));
    o.target = at;
    o.terms.push('branch', 'bitwise');
  };
}
HANDLERS.tbz = tbzHandler(true);
HANDLERS.tbnz = tbzHandler(false);

/* システム --------------------------------------------------- */

HANDLERS.nop = (o) => {
  o.title = J('何もしない', 'No operation');
  o.pseudo = '/* 何もしない */';
  o.summary = J(
    '文字どおり何もしません。位置合わせや、後で書き換えるための場所取りに使われます。',
    'Does nothing. Used for alignment or as a placeholder to patch later.');
};

HANDLERS.svc = (o, ops) => {
  o.title = J('OS に仕事を頼む', 'System call');
  o.pseudo = 'syscall()';
  o.summary = J(
    'CPU から OS（カーネル）へ切り替えて、ファイルを開くなどの処理を頼む。',
    'Switch to the kernel and ask the OS to do something — open a file, and so on.');
  o.detail.push(J(
    'アプリが自分だけでできない仕事（ファイル、ネットワーク、画面）は、必ずここを通って OS に頼みます。' +
    'どの仕事を頼むかは x16 に入っている番号で決まります。',
    'Anything an app cannot do alone goes through here; the request number is in x16.'));
  o.terms = ['syscall'];
};

HANDLERS.brk = (o) => {
  o.title = J('わざと止める', 'Breakpoint / trap');
  o.pseudo = 'trap()';
  o.summary = J(
    'その場でプログラムを停止させます。デバッガ用、または「ここには来ないはず」という保険です。',
    'Halts the program — used by debuggers, or as an “unreachable” guard.');
  o.detail.push(J(
    'Swift の配列範囲外アクセスや、整数のあふれ検出で、この命令に飛ばされてクラッシュします。',
    'Swift traps such as array-out-of-bounds land here.'));
};
HANDLERS.udf = HANDLERS.brk;

HANDLERS.bti = (o) => {
  o.title = J('ここへの飛び込みを許可する目印', 'Branch target marker');
  o.pseudo = '/* 飛び込み可 */';
  o.summary = J(
    '「ここは正規のジャンプ先です」という目印。攻撃者が変な場所へ飛ぶのを防ぐ仕組みです。',
    'Marks a legitimate branch target, so an attacker cannot jump into the middle of code.');
  o.terms = ['security'];
};
HANDLERS.hint = HANDLERS.bti;

for (const n of ['paciasp', 'pacibsp', 'pacia', 'pacib']) {
  HANDLERS[n] = (o) => {
    o.title = J('戻り先アドレスに封をする', 'Sign the return address');
    o.pseudo = 'lr = sign(lr)';
    o.summary = J(
      '戻り先アドレス (x30) に、書き換えを検出するための「封印」を付ける。',
      'Add a cryptographic signature to the return address in x30.');
    o.detail.push(J(
      'スタックを壊して戻り先を書き換える攻撃（ROP）を防ぐ仕組みです。関数の入口で封をし、出口で autiasp が確認します。' +
      '書き換えられていたらクラッシュします。arm64e（新しい iPhone）でよく見ます。',
      'Pointer authentication: the prologue signs the return address and the epilogue checks it, defeating ROP attacks.'));
    o.terms = ['pac', 'security', 'lr'];
  };
}
for (const n of ['autiasp', 'autibsp', 'autia', 'autib', 'xpaclri']) {
  HANDLERS[n] = (o) => {
    o.title = J('戻り先アドレスの封を確かめる', 'Verify the return address');
    o.pseudo = 'lr = verify(lr)';
    o.summary = J(
      '入口で付けた封印を確認して外す。壊されていればここでクラッシュします。',
      'Check and strip the signature added in the prologue; a tampered value crashes here.');
    o.terms = ['pac', 'security', 'lr'];
  };
}

for (const n of ['dmb', 'dsb', 'isb']) {
  HANDLERS[n] = (o) => {
    o.title = J('順番を守らせる', 'Memory barrier');
    o.pseudo = 'barrier()';
    o.summary = J(
      'CPU が勝手に順番を入れ替えないよう、ここで一度そろえる。',
      'Stop the CPU from reordering memory operations across this point.');
    o.detail.push(J(
      'CPU は速度のために命令の順番を入れ替えます。複数のスレッドが同じデータを触るときは、それが困るのでここで止めます。',
      'CPUs reorder for speed; with multiple threads that is unsafe, so this pins the order.'));
    o.terms = ['thread'];
  };
}
HANDLERS.mrs = (o, ops) => {
  o.title = J('CPU の特別なレジスタを読む', 'Read a system register');
  o.pseudo = opShort(ops[0]) + ' = ' + (ops[1] ? ops[1].text : '');
  o.summary = J(
    'CPU 内部の特別な値（スレッド固有の領域、時刻など）を読み出して ' + opShort(ops[0]) + ' に入れる。',
    'Read a special CPU register into ' + opShort(ops[0]) + '.');
};
HANDLERS.msr = (o, ops) => {
  o.title = J('CPU の特別なレジスタに書く', 'Write a system register');
  o.pseudo = (ops[0] ? ops[0].text : '') + ' = ' + opShort(ops[1]);
  o.summary = J('CPU 内部の特別な設定を書き換える。', 'Write a special CPU register.');
};

/* 小数 ------------------------------------------------------- */

HANDLERS.fmov = (o, ops) => {
  const [d, s] = ops;
  o.title = J('小数レジスタへの代入', 'Move (floating point)');
  o.pseudo = opShort(d) + ' = ' + opShort(s);
  o.summary = J(
    opShort(s) + ' を ' + opShort(d) + ' へそのままコピーする（値の形は変えない）。',
    'Copy the bits from ' + opShort(s) + ' to ' + opShort(d) + ' unchanged.');
  o.detail.push(J(
    'd0〜d31 や s0〜s31 は、小数（浮動小数点数）専用のレジスタです。x0 などとは別に用意されています。',
    'd0–d31 and s0–s31 are separate registers used for floating-point values.'));
  o.terms = ['float'];
};
function fbin(sym, ja, en) {
  return (o, ops) => {
    const [d, n, m] = ops;
    o.title = J('小数の' + ja, en);
    o.pseudo = opShort(d) + ' = ' + opShort(n) + ' ' + sym + ' ' + opShort(m);
    o.summary = J(
      opShort(n) + ' と ' + opShort(m) + ' を小数として' + ja + '、' + opShort(d) + ' に入れる。',
      en + ' as floating point.');
    o.terms = ['float'];
  };
}
HANDLERS.fadd = fbin('+', '足し算', 'Float add');
HANDLERS.fsub = fbin('−', '引き算', 'Float subtract');
HANDLERS.fmul = fbin('×', '掛け算', 'Float multiply');
HANDLERS.fdiv = fbin('÷', '割り算', 'Float divide');
HANDLERS.fcmp = (o, ops) => {
  const [n, m] = ops;
  o.title = J('小数を比べる', 'Float compare');
  o.pseudo = 'flags = ' + opShort(n) + ' ⋛ ' + opShort(m);
  o.summary = J(
    opShort(n) + ' と ' + opShort(m) + ' を小数として比べ、結果をフラグに残す。',
    'Compare two floating-point values, updating the flags.');
  o.terms = ['float', 'flags'];
};
for (const n of ['fcvtzs', 'fcvtzu', 'fcvtas', 'fcvtau', 'fcvtms', 'fcvtns', 'fcvtps']) {
  HANDLERS[n] = (o, ops) => {
    o.title = J('小数を整数にする', 'Float to integer');
    o.pseudo = opShort(ops[0]) + ' = (int)' + opShort(ops[1]);
    o.summary = J(
      opShort(ops[1]) + ' の小数を整数に変換して ' + opShort(ops[0]) + ' に入れる（小数点以下は切り捨て）。',
      'Convert the float in ' + opShort(ops[1]) + ' to an integer.');
    o.terms = ['float'];
  };
}
for (const n of ['scvtf', 'ucvtf']) {
  HANDLERS[n] = (o, ops) => {
    o.title = J('整数を小数にする', 'Integer to float');
    o.pseudo = opShort(ops[0]) + ' = (double)' + opShort(ops[1]);
    o.summary = J(
      opShort(ops[1]) + ' の整数を小数の形に変換して ' + opShort(ops[0]) + ' に入れる。',
      'Convert the integer in ' + opShort(ops[1]) + ' to floating point.');
    o.terms = ['float'];
  };
}
HANDLERS.fcvt = (o, ops) => {
  o.title = J('小数の精度を変える', 'Convert float precision');
  o.pseudo = opShort(ops[0]) + ' = (' + (ops[0] && ops[0].bits === 64 ? 'double' : 'float') + ')' + opShort(ops[1]);
  o.summary = J('小数の桁数（精度）を変換する。', 'Change between float and double precision.');
  o.terms = ['float'];
};

/* SIMD ------------------------------------------------------- */

HANDLERS.movi = (o, ops) => {
  o.title = J('まとめて同じ値を入れる', 'Fill a vector');
  o.pseudo = opShort(ops[0]) + ' = { ' + immShort(ops[1]) + ', … }';
  o.summary = J(
    'ベクタレジスタ ' + opShort(ops[0]) + ' の全部の枠に ' + immText(ops[1]) + ' を入れる。',
    'Set every lane of ' + opShort(ops[0]) + ' to ' + immText(ops[1]) + '.');
  o.detail.push(J(
    'v0〜v31 は 16 バイトを一度に扱えるレジスタです。memset や画像処理でまとめて処理するのに使われます。',
    'v0–v31 hold 16 bytes at once; used for memset, image and audio work.'));
  o.terms = ['simd'];
};
HANDLERS.dup = (o, ops) => {
  o.title = J('同じ値を並べる', 'Duplicate into all lanes');
  o.pseudo = opShort(ops[0]) + ' = { ' + opShort(ops[1]) + ' × n }';
  o.summary = J(
    opShort(ops[1]) + ' の値を ' + opShort(ops[0]) + ' の全部の枠にコピーする。',
    'Copy ' + opShort(ops[1]) + ' into every lane.');
  o.terms = ['simd'];
};
/**
 * ベクタレジスタの並び（16b / 8h / 4s / 2d …）が何バイト分かを返す。
 * 分からないときは null。
 */
function arrangementBytes(arr) {
  const m = /^(\d+)([bhsd])$/i.exec(String(arr || ''));
  if (!m) return null;
  const lanes = Number(m[1]);
  const elem = { b: 1, h: 2, s: 4, d: 8 }[m[2].toLowerCase()];
  if (!Number.isSafeInteger(lanes) || lanes <= 0 || !elem) return null;
  return lanes * elem;
}

/**
 * `{v0.16b, v1.16b, v2.16b, v3.16b}` のようなレジスタリストが運ぶ総バイト数。
 *
 * ld2/ld3/ld4 と st2/st3/st4 は複数のベクタを一度に埋めます。
 * これを常に「16 バイト」と言ってしまうと、扱うデータ量を実際より
 * 小さく説明してしまいます (#1294)。総量が確定できないときは null を返し、
 * 呼び出し側はバイト数を言わない説明にします。
 */
function registerListBytes(ops) {
  const list = ops.find((x) => x && x.k === 'list');
  if (!list || !Array.isArray(list.regs) || !list.regs.length) return null;
  let total = 0;
  for (const reg of list.regs) {
    if (!reg || reg.k !== 'reg') return null;
    const bytes = reg.cls === 'vec'
      ? arrangementBytes(reg.arr)
      : (Number.isSafeInteger(reg.bits) && reg.bits > 0 ? reg.bits / 8 : null);
    if (bytes == null) return null;
    total += bytes;
  }
  return { total, count: list.regs.length, text: list.text };
}

function vectorListTitle(load, info) {
  if (!info) return load ? J('まとめて読む', 'Vector load') : J('まとめて書く', 'Vector store');
  const unit = info.count === 1 ? '' : '（' + info.count + ' 本のベクタ）';
  const unitEn = info.count === 1 ? '' : ' (' + info.count + ' vectors)';
  return load
    ? J('まとめて読む' + unit, 'Vector load' + unitEn)
    : J('まとめて書く' + unit, 'Vector store' + unitEn);
}

for (const n of ['ld1', 'ld2', 'ld3', 'ld4']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    const info = registerListBytes(ops);
    o.title = vectorListTitle(true, info);
    o.pseudo = (ops[0] ? ops[0].text : '') + ' = *(vector*)(' + (mem ? memExpr(mem) : '') + ')';
    const amountJa = info ? '合計 ' + info.total + ' バイト（' + info.count + ' 本のベクタ）' : '複数のベクタ';
    const amountEn = info ? info.total + ' bytes in total across ' + info.count + ' vector register(s)' : 'the listed vector registers';
    o.summary = J(
      (mem ? memText(mem) + 'から' : '') + amountJa + 'をまとめて読み込む。',
      'Load ' + amountEn + ' at once' + (mem ? ' from ' + memExpr(mem) : '') + '.');
    if (info && info.count > 1) {
      o.detail.push(J(
        n + ' は ' + info.count + ' 本のレジスタを同時に埋めます。'
        + 'メモリ上で交互に並んだデータを、レジスタごとに分けて取り出す命令です。',
        n + ' fills ' + info.count + ' registers at once, de-interleaving structures held in memory.'));
    }
    o.terms = ['simd', 'memory'];
  };
}
for (const n of ['st1', 'st2', 'st3', 'st4']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    const info = registerListBytes(ops);
    o.title = vectorListTitle(false, info);
    o.pseudo = '*(vector*)(' + (mem ? memExpr(mem) : '') + ') = ' + (ops[0] ? ops[0].text : '');
    const amountJa = info ? '合計 ' + info.total + ' バイト（' + info.count + ' 本のベクタ）' : '複数のベクタ';
    const amountEn = info ? info.total + ' bytes in total across ' + info.count + ' vector register(s)' : 'the listed vector registers';
    o.summary = J(
      (mem ? memText(mem) + 'へ' : '') + amountJa + 'をまとめて書き込む。',
      'Store ' + amountEn + ' at once' + (mem ? ' to ' + memExpr(mem) : '') + '.');
    if (info && info.count > 1) {
      o.detail.push(J(
        n + ' は ' + info.count + ' 本のレジスタを同時に書き出します。'
        + 'レジスタごとの値を、メモリ上で交互に並べ直して置く命令です。',
        n + ' writes ' + info.count + ' registers at once, interleaving them into memory.'));
    }
    o.terms = ['simd', 'memory'];
  };
}

/* 排他アクセス ----------------------------------------------- */

for (const n of ['ldxr', 'ldaxr']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    o.title = J('横取りされないように読む', 'Exclusive load');
    o.pseudo = opShort(ops[0]) + ' = *(' + (mem ? memExpr(mem) : '') + ') /* 監視開始 */';
    o.summary = J(
      'メモリを読むと同時に「ここを見張る」と CPU に宣言する。他のスレッドが書き換えたら、次の stxr が失敗します。',
      'Load and start watching the address; a matching stxr fails if anyone else writes it.');
    o.detail.push(J(
      '複数のスレッドが同じ値を同時に増やそうとしても壊れないように、read → 変更 → write を「誰にも割り込まれずに」行うための仕組みです。',
      'The building block of atomic read-modify-write across threads.'));
    o.terms = ['thread', 'atomic'];
  };
}
for (const n of ['stxr', 'stlxr']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    o.title = J('横取りされていなければ書く', 'Exclusive store');
    o.pseudo = opShort(ops[0]) + ' = try_store(' + (mem ? memExpr(mem) : '') + ', ' + opShort(ops[1]) + ')';
    o.summary = J(
      '見張っていた間に誰も書き換えていなければ書き込み、' + opShort(ops[0]) + ' に 0（成功）を入れる。失敗なら 1 が入り、ふつうは上に戻ってやり直します。',
      'Store only if nothing else wrote the address; ' + opShort(ops[0]) + ' gets 0 on success, 1 on failure.');
    o.terms = ['thread', 'atomic'];
  };
}
for (const n of ['casal', 'cas', 'casa', 'casl']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    o.title = J('比べて、合っていれば入れ替える', 'Compare and swap');
    o.pseudo = 'if (*' + (mem ? memExpr(mem) : '') + ' == ' + opShort(ops[0]) + ') *… = ' + opShort(ops[1]);
    o.summary = J(
      'メモリの中身が期待どおりならすげ替える。1 命令で安全に行える「読んで書く」です。',
      'Atomically swap the value only if it still matches what was expected.');
    o.terms = ['thread', 'atomic'];
  };
}
for (const n of ['ldadd', 'ldadda', 'ldaddl', 'ldaddal', 'ldset', 'ldclr', 'ldeor', 'swp', 'swpa', 'swpl', 'swpal']) {
  HANDLERS[n] = (o, ops) => {
    const mem = ops.find((x) => x.k === 'mem');
    o.title = J('割り込まれずに読み書きする', 'Atomic read-modify-write');
    o.pseudo = opShort(ops[1]) + ' = atomic(' + (mem ? memExpr(mem) : '') + ', ' + opShort(ops[0]) + ')';
    o.summary = J(
      '他のスレッドに邪魔されずに、メモリの値を読んで書き換える。参照カウントの増減などで使われます。',
      'Read and update memory without another thread getting in between — reference counting, for example.');
    o.terms = ['thread', 'atomic'];
  };
}

/* データ ----------------------------------------------------- */

HANDLERS['.byte'] = (o, ops, base, addr, c) => {
  o.title = J('命令ではなくデータ', 'Data, not code');
  o.pseudo = '/* ' + (o.operands || '') + ' */';
  o.summary = J(
    'この 4 バイトは CPU の命令として意味を持ちません。文字列、数値、アドレスなどのデータが置かれている場所です。',
    'These 4 bytes are not a valid instruction — this is data: a string, a number or an address.');
  o.detail.push(J(
    'プログラムの中には、コードとデータが混ざって置かれています。ここを「16進」タブで見ると、' +
    '右側に文字として読める部分があるかもしれません。',
    'Code and data are interleaved. Switch to the Hex tab — the ASCII column may show readable text.'));
  o.category = 'data';
  o.terms = ['data'];
};

/* ── 名前で拾いきれないものを、接頭辞で拾う ─────────────── */

function familyHandler(base) {
  if (/^b\.[a-z]{2}$/.test(base)) return condBranch;
  if (/^(braa|brab)$/.test(base)) return HANDLERS.br;
  if (/^(blraa|blrab)$/.test(base)) return HANDLERS.blr;
  if (/^ld/.test(base)) return loadStore(true);
  if (/^st/.test(base)) return loadStore(false);
  if (/^f/.test(base)) {
    return (o, ops) => {
      o.title = J('小数の計算', 'Floating-point operation');
      o.pseudo = opShort(ops[0]) + ' = ' + base + '(' + ops.slice(1).map(opShort).join(', ') + ')';
      o.summary = J(
        '浮動小数点（小数）を扱う計算です。d/s/q で始まるレジスタは小数専用です。',
        'A floating-point operation; d/s/q registers hold floating-point values.');
      o.terms = ['float'];
    };
  }
  return null;
}

/* ── レジスタの役割を detail に足す ─────────────────────── */

function addRegRoles(o, ops) {
  const seen = new Set();
  for (const op of ops) {
    const regs = op.k === 'reg' ? [op] : (op.k === 'mem' ? [op.base, op.index].filter(Boolean) : []);
    for (const r of regs) {
      if (!r || r.cls === 'fp' || r.cls === 'vec') continue;
      if (seen.has(r.text)) continue;
      seen.add(r.text);
      const role = registerRole(r.num, r.cls === 'sp', r.cls === 'zr');
      if (role.id === 'lr') o.terms.push('lr');
      if (role.id === 'fp') o.terms.push('framepointer');
      if (role.id === 'sp') o.terms.push('sp');
    }
  }
}

/* ────────────────────────────────────────────────────────────
   部品ごとの意味（詳細画面で使う）
   ──────────────────────────────────────────────────────────── */

export function operandNotes(mn, opsStr) {
  const ops = parseOperands(opsStr || '');
  const notes = [];
  const seen = new Set();
  for (const op of ops) {
    // 同じレジスタが読み書き両方に出ることは多い。説明は 1 回で足りる。
    if (op.k === 'reg') {
      if (seen.has(op.text)) continue;
      seen.add(op.text);
    }
    if (op.k === 'reg') {
      const role = registerRole(op.num, op.cls === 'sp', op.cls === 'zr');
      const width = op.cls === 'fp' || op.cls === 'vec'
        ? J(op.bits + ' ビットの小数／ベクタ用', op.bits + '-bit vector/float register')
        : J(op.bits + ' ビット分を使う', op.bits + ' bits wide');
      notes.push({
        name: op.text,
        text: pick(role.ja, role.en) + '。' + width + (op.shift ? shiftText(op.shift) : ''),
        kind: 'reg',
      });
    } else if (op.k === 'imm') {
      if (op.float != null) {
        notes.push({ name: op.text, text: J('小数の定数 ' + op.float, 'the constant ' + op.float), kind: 'imm' });
      } else if (op.value != null) {
        const v = op.value;
        const extra = [];
        extra.push(J('10進で ' + v.toString(10), 'decimal ' + v.toString(10)));
        extra.push(J('16進で 0x' + absHex(v), 'hex 0x' + absHex(v)));
        if (v >= 0n && v <= 0xffffn) extra.push(J('2進で ' + v.toString(2), 'binary ' + v.toString(2)));
        if (v >= 0x20n && v < 0x7fn) extra.push(J('文字なら "' + String.fromCharCode(Number(v)) + '"', 'as a character "' + String.fromCharCode(Number(v)) + '"'));
        notes.push({ name: op.text, text: extra.join(' / '), kind: 'imm', value: v });
      }
    } else if (op.k === 'mem') {
      notes.push({ name: op.text, text: memText(op), kind: 'mem' });
    } else if (op.k === 'cond') {
      const ci = condInfo(op.text);
      notes.push({ name: op.text, text: ci ? J(ci.ja + '（フラグを見て決める）', ci.en) : op.text, kind: 'cond' });
    } else if (op.k === 'list') {
      notes.push({ name: op.text, text: J('ベクタレジスタのまとまり', 'a set of vector registers'), kind: 'list' });
    } else {
      notes.push({ name: op.text, text: '', kind: 'other' });
    }
  }
  return notes;
}

/* ────────────────────────────────────────────────────────────
   行に添える短い一言（一覧表示用・キャッシュあり）
   ──────────────────────────────────────────────────────────── */

const briefCache = new Map();
const BRIEF_CACHE_MAX = 4000;

/**
 * @param {string} style 'ja' | 'pseudo' | 'both'
 */
export function brief(mn, ops, style, ctx) {
  if (!mn) return '';
  const gen = (ctx && ctx.gen) || 0;
  const key = gen + ' ' + style + ' ' + (ctx && ctx.lang ? ctx.lang : '') + ' ' + mn + ' ' + (ops || '');
  const hit = briefCache.get(key);
  if (hit !== undefined) return hit;

  const e = explain(mn, ops, null, ctx);
  let text;
  if (style === 'pseudo') text = e.pseudo;
  else if (style === 'both') text = e.pseudo + (e.title ? '   — ' + e.title : '');
  else text = e.summary || e.title;
  text = (text || '').replace(/\s+/g, ' ').trim();

  if (briefCache.size > BRIEF_CACHE_MAX) briefCache.clear();
  briefCache.set(key, text);
  return text;
}

export function clearBriefCache() { briefCache.clear(); }
