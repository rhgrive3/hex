/*
 * 関数の理解 — 低レベルの事実を 1 つにまとめて「この関数は何をしているか」に答える層。
 *
 * これまでの流れはこうだった。
 *
 *   命令の説明 … 1 行ずつは完璧。1339 行あると誰も読めない。
 *   数え上げ   … 「呼び出し 195・ループ 3・条件分岐 101」。何も言っていない。
 *   役割       … 値の書き換えが 1 つも取れず「名指しできませんでした」。
 *
 * 足りなかったのは **横断** だった。1 つの命令、1 つのブロック、1 つの書き込みを
 * 見ているかぎり、大きな関数については何も言えない。人が読むときにやっているのは
 * そこではなく、
 *
 *   「この関数はある値を持ち回っていて、それを何度も作り変えて、最後に返している。
 *     作り変え方はこれとこれとこれ。作り変えの直前に、開発者はこう書き残している」
 *
 * という、値 1 本を軸にした読み方になる。ここはそれを機械にやらせる。
 *
 *   1. 持ち回っている値（積算値）を見つける
 *   2. その値が作り変えられるたびに、前の値を `result` と置いた式に直す
 *   3. 作り変えの近くで参照している文言を、その工程の名札として結びつける
 *   4. 開発者が文言に書いた計算式と、命令から復元した計算式を突き合わせる
 *   5. 最後に何を返し、どこへ書き込むかを言う
 *
 * 4 が決め手になる。「基ダ×(100+%d)÷100」は開発者の主張、`x * (100 + y) / 100`
 * は命令から復元した事実で、出どころがまったく違う。この 2 つが一致したとき、
 * 「この関数はその計算をしている」は推測ではなく **確かめた話** になる。
 * クラス表も関数名も残っていない C++ のアプリで、確定に届く道はここしかない。
 *
 * 日本語は 1 文字も作らない。返すのはコードと式と数字だけ。
 */
import {
  buildValues, render, same, walk, constOf, sizeOf, regNode, constantsIn, callsIn, memsIn,
} from './expr.js';

/* ────────────────────────────────────────────────────────────
   1. 持ち回っている値を見つける
   ──────────────────────────────────────────────────────────── */

/* 関数をまたいでも残るレジスタ。「持ち回る」のはほぼここか、スタックの置き場。 */
const CARRIED = /^x(19|2[0-8])$/;

/**
 * その関数が「作り変えながら持ち回っている値」を探す。
 *
 * 見分け方は 1 つだけ ——「新しい値の中に、前の値がそのまま入っている」。
 *
 *     x25 = x25 * f(...) / 100      ← 前の x25 が右辺にいる
 *     x25 = x25 * 2                 ← いる
 *     x20 = f(...)                  ← いない。これは持ち回りではなく作り直し
 *
 * これは形の話なので、命令から確かめられる。名前も型も要らない。
 */
export function findAccumulators(model, vg) {
  const insns = model.instructions || [];
  /*
   * レジスタは使い回される。同じ x25 が、前半では damage を持ち回り、
   * 後半では配列を走る添字になっている、ということが普通に起きる。
   * だから「作り変えの連なり」を **ひとつながりの区間** として切る。
   * 前の値を含まない代入が来たら、そこで区間は終わり。
   */
  const runs = [];
  const open = new Map();          // reg → いま伸びている区間
  const RESULT = regNode('result', -1);
  const close = (reg) => {
    const run = open.get(reg);
    open.delete(reg);
    if (run && run.steps.length) runs.push(run);
  };

  for (const insn of insns) {
    const defs = vg.defs.get(insn.row);
    if (!defs) continue;
    for (const reg of Object.keys(defs)) {
      if (!CARRIED.test(reg)) continue;
      const now = defs[reg];
      const before = vg.at(insn.row, reg);
      if (!now || !before || same(now, before)) continue;

      /*
       * 1 つの工程が、2 命令に分かれて同じレジスタへ書かれることがある。
       *
       *   asr x25, x23, #7                 ← 途中の値
       *   …（別の後片付けの呼び出し）…
       *   add x25, x25, x23, lsr #63       ← ここで割り算が完成する
       *
       * これを 2 工程として並べると、読む人には「上位を取って 7 ずらす」という
       * 意味のない行が見える。しかも割り算に戻った時点で、途中の値は式の中から
       * 消える（それが「戻す」ということなので）ので、前の値をそのまま含む、
       * という条件では拾えない。直前の工程の**結果を土台にしている**なら、
       * 別の工程ではなく、同じ工程の続きとして書き直す。
       */
      const run = open.get(reg);
      const last = run && run.steps.length ? run.steps[run.steps.length - 1] : null;
      if (last && same(last.after, before) && contains(now, last.before)) {
        last.after = now;
        last.expr = substitute(now, last.before, RESULT);
        last.row = insn.row;
        last.address = insn.address;
        last.merged = (last.merged || 1) + 1;
        continue;
      }

      if (!contains(now, before)) {
        /* A definition independent of the reaching value may be a sibling CFG arm.
         * Linear row order cannot prove continuity, so fail closed: terminate the
         * current accumulator interval. A later dependent update may start a new one. */
        close(reg);
        continue;
      }
      if (!open.has(reg)) open.set(reg, { reg, steps: [], ops: new Set() });
      open.get(reg).steps.push({
        row: insn.row, address: insn.address, reg,
        before, after: now, reseed: false,
        /* 前の値を `result` と置いた式。これが「工程」そのもの。 */
        expr: substitute(now, before, RESULT),
      });
    }
  }
  for (const reg of Array.from(open.keys())) close(reg);

  for (const a of runs) {
    for (const st of a.steps) for (const op of arithOpsOf(st.expr)) a.ops.add(op);
    /* 入れ直しは「作り変え」ではないので、区間の重みには数えない。 */
    a.steps = a.steps.filter((s, i) => !s.reseed || i === 0 ||
      a.steps.slice(i + 1).some((x) => !x.reseed));
    a.count = a.steps.filter((s) => !s.reseed).length;
    a.ops = Array.from(a.ops);
    a.startRow = a.steps[0].row;
    a.endRow = a.steps[a.steps.length - 1].row;
    const first = a.steps.find((s) => !s.reseed);
    a.seed = first ? first.before : a.steps[0].after;
    /*
     * 何回作り変えられたかが、そのまま「その関数の主題である度合い」になる。
     * 1 回だけの持ち回りは、ただの受け渡しかもしれない。
     */
    a.weight = a.count * 10 + a.ops.length * 3;
  }
  runs.sort((a, b) => b.weight - a.weight);
  return runs.filter((a) => a.count > 0);
}

/** 木 haystack の中に、ノード needle がそのまま入っているか。 */
function contains(haystack, needle) {
  let hit = false;
  walk(haystack, (n) => { if (n === needle || same(n, needle)) hit = true; });
  return hit;
}

/** from にあたる部分木を to に差し替えた木を返す。 */
function substitute(n, from, to, depth) {
  const d = depth || 0;
  if (!n || d > 24) return n;
  if (n === from || same(n, from)) return to;
  switch (n.k) {
    case 'bin': {
      const a = substitute(n.a, from, to, d + 1), b = substitute(n.b, from, to, d + 1);
      return (a === n.a && b === n.b) ? n : { k: 'bin', op: n.op, a, b };
    }
    case 'un': {
      const a = substitute(n.a, from, to, d + 1);
      return a === n.a ? n : { k: 'un', op: n.op, a };
    }
    case 'sel': {
      const a = substitute(n.a, from, to, d + 1), b = substitute(n.b, from, to, d + 1);
      return (a === n.a && b === n.b) ? n : { k: 'sel', cc: n.cc, a, b, cmp: n.cmp };
    }
    case 'call': {
      const args = (n.args || []).map((x) => ({ index: x.index, value: substitute(x.value, from, to, d + 1) }));
      return Object.assign({}, n, { args });
    }
    case 'mem': {
      const base = n.base ? substitute(n.base, from, to, d + 1) : null;
      const index = n.index ? substitute(n.index, from, to, d + 1) : null;
      return (base === n.base && index === n.index) ? n : Object.assign({}, n, { base, index });
    }
    default: return n;
  }
}

/** その式が使っている算術の種類（照合と要約に使う）。 */
function arithOpsOf(n) {
  const out = new Set();
  walk(n, (x) => {
    if (x.k === 'bin' && /^(add|sub|mul|sdiv|udiv|smod|umod|shl|shr|sar|and|or|xor)$/.test(x.op)) {
      out.add(x.op);
    }
  });
  return out;
}

/* ────────────────────────────────────────────────────────────
   2. 工程を、掛け率と割り率で言い表す
   ──────────────────────────────────────────────────────────── */

/*
 * 工程の形をそろえる。ゲームの計算はほぼこの 3 つに落ちる。
 *
 *   scale     result = result * A / B      （倍率をかける）
 *   offset    result = result ± A          （加減する）
 *   replace   result = 何か（result を含むが、掛け率としては読めない）
 */
export const STEP = { SCALE: 'scale', OFFSET: 'offset', CLAMP: 'clamp', REPLACE: 'replace' };

const isResult = (n) => !!n && n.k === 'reg' && n.reg === 'result';

/** その式の中に result が入っているか。 */
function holdsResult(n) {
  let hit = false;
  walk(n, (x) => { if (isResult(x)) hit = true; });
  return hit;
}

/**
 * 1 つの工程を「掛けた数」「割った数」に分解する。読めなければ replace。
 *
 *     result * A / B * C / D
 *
 * のように何段にも重なるので、外側から順に剥がしていく。
 * 剥がした先が result そのものになったら成功、途中で別の形になったら諦める。
 */
export function shapeOfStep(expr) {
  const muls = [], divs = [];
  let cur = expr;
  for (let guard = 0; guard < 12; guard++) {
    if (isResult(cur)) {
      if (!muls.length && !divs.length) break;
      return { kind: STEP.SCALE, muls, divs, mul: muls[0] || null, div: divs[0] || null };
    }
    if (!cur || cur.k !== 'bin') break;
    if ((cur.op === 'sdiv' || cur.op === 'udiv') && holdsResult(cur.a)) {
      divs.push(cur.b); cur = cur.a; continue;
    }
    if (cur.op === 'mul') {
      if (holdsResult(cur.a) && !holdsResult(cur.b)) { muls.push(cur.b); cur = cur.a; continue; }
      if (holdsResult(cur.b) && !holdsResult(cur.a)) { muls.push(cur.a); cur = cur.b; continue; }
    }
    if ((cur.op === 'sar' || cur.op === 'shr') && holdsResult(cur.a) && constOf(cur.b) != null) {
      divs.push({ k: 'const', v: 1n << constOf(cur.b) }); cur = cur.a; continue;
    }
    break;
  }

  // result ± A
  if (expr && expr.k === 'bin' && (expr.op === 'add' || expr.op === 'sub')) {
    if (isResult(expr.a)) return { kind: STEP.OFFSET, sign: expr.op === 'add' ? 1 : -1, amount: expr.b };
    if (isResult(expr.b) && expr.op === 'add') return { kind: STEP.OFFSET, sign: 1, amount: expr.a };
  }
  /* 条件で入れ替えている＝上限・下限で止めている形 */
  if (expr && expr.k === 'sel' && (isResult(expr.a) || isResult(expr.b))) {
    return { kind: STEP.CLAMP, other: isResult(expr.a) ? expr.b : expr.a, cc: expr.cc };
  }
  return { kind: STEP.REPLACE };
}

/* ────────────────────────────────────────────────────────────
   3. 文言を工程に結びつける
   ──────────────────────────────────────────────────────────── */

/*
 * 開発者が書き残した文言は、たいてい **その処理をする直前** に組み立てられる。
 *
 *     adrp/add x1, "撃破時攻撃力アップ:%d 基ダ×(100+%d)÷100"
 *     bl   <文字列を作る>
 *     …
 *     <その計算>
 *
 * だから「その工程のいちばん近くにある、手前の文言」を名札にする。
 * 遠すぎるものは結びつけない（別の工程の名札を横取りしてしまうため）。
 */
const LABEL_WINDOW = 64;      // 何行手前までを名札の候補にするか

function labelStrings(model) {
  const out = [];
  for (const r of model.addressRefs || []) {
    if (!r.text) continue;
    out.push({ row: r.row, addr: r.addr, text: r.text });
  }
  out.sort((a, b) => a.row - b.row);
  return out;
}

function labelFor(labels, row) {
  let best = null;
  for (const l of labels) {
    if (l.row > row) break;
    if (row - l.row <= LABEL_WINDOW) best = l;
  }
  return best;
}

/* ────────────────────────────────────────────────────────────
   4. 文言の計算式と、復元した計算式を突き合わせる
   ──────────────────────────────────────────────────────────── */

/*
 * 文言に書かれた計算式を読む。
 *
 *   「めっぽう強い:%d 基ダ×(1500+[宝:%d]+[本能玉:%d])÷1000×(100+[コンボ:%d])÷100」
 *      → 掛ける: 1500, 100   割る: 1000, 100
 *   「クリティカル:%d 基ダ×2」
 *      → 掛ける: 2
 *
 * ×÷ の記号と、その直後の数（括弧の中の先頭の数も含む）だけを見る。
 * 「:%d」のような書式指定の数は式ではないので拾わない。
 */
const MUL_RE = /[×*]\s*(\d+)/g;
const DIV_RE = /[÷/]\s*(\d+)/g;
/* A coefficient immediately multiplied by a placeholder and then divided by a
 * constant is commonly folded by the compiler (4*x/400 -> x/100,
 * 400*x/400 -> x). Normalize that rational factor before matching machine
 * arithmetic so equivalent optimized code still verifies the developer text. */
const RATIO_TERM_RE = /(\d+)\s*[×*]\s*(?:\[[^\]]+\]|%[-+ #0-9.]*[diufFgGeEsxX@])\s*[÷/]\s*(\d+)/g;

function gcdBig(a, b) {
  let x = a < 0n ? -a : a, y = b < 0n ? -b : b;
  while (y) { const t = x % y; x = y; y = t; }
  return x || 1n;
}
function removeOne(list, value) {
  const i = list.findIndex((x) => x === value);
  if (i >= 0) list.splice(i, 1);
}

/*
 * ASCII の `*` と `/` だけで「式だ」と言ってはいけない。
 *
 * この 1 行を `if (!/[×÷]/.test(s) && !/[*\/]\s*\d/.test(s)) return null;` と
 * 書いていたころ、このアプリの中で式として拾えた 88 本のうち、本物は 25 本だった。
 * 残りの 63 本はこういうものだった:
 *
 *   "v40@0:8@16@24*32"        Objective-C の型エンコード      → ×32
 *   "video/3gpp"              MIME 型                         → ÷3
 *   "/openrtb/2.5"            URL の道                        → ÷2
 *   "MIGHAoGBAMgt6PK9…D/4Pt"  RSA 秘密鍵（base64）            → ÷4
 *   "key_bytes == 128 / 8"    C の表明文                       → ÷8
 *
 * ここは role-formula-verified（尤度比 260 ＝ このツールで最強の証拠）の
 * 入口なので、外すと「型エンコードの ×16 と、構造体の +16 が一致したから確定」
 * という嘘が通る。×16 も ×24 も ×32 も、命令の側にはいくらでもある。
 *
 * 全角の × ÷ は、人が読む文の中の掛け算・割り算にしか出てこない。
 * ASCII だけで書かれているものは、
 *   ・書式指定（%d / %@ …）があって、人に見せる文であることがはっきりしていて
 *   ・演算子の前後に区切り（空白や閉じ括弧）がある
 * ものだけを受ける。`v40@0:8*16` も `video/3gpp` も、この 2 つを満たさない。
 */
const FULLWIDTH_OP = /[×÷]/;
const ASCII_FORMAT = /%[-+ #0-9.]*[diufFgGeEsxX@]/;
const ASCII_OP = /(?:^|[\s)\]])[*/]\s*\(?\s*\d/;

export function formulaOf(text) {
  const s = String(text == null ? '' : text);
  if (!s) return null;
  if (!FULLWIDTH_OP.test(s)) {
    if (!ASCII_FORMAT.test(s) || !ASCII_OP.test(s)) return null;
  }
  const mul = [], div = [];
  for (const m of s.matchAll(MUL_RE)) mul.push(BigInt(m[1]));
  for (const m of s.matchAll(DIV_RE)) div.push(BigInt(m[1]));
  for (const m of s.matchAll(RATIO_TERM_RE)) {
    const numerator = BigInt(m[1]), denominator = BigInt(m[2]);
    if (denominator === 0n) continue;
    // The raw denominator was already collected by DIV_RE. Replace that one
    // occurrence with the reduced ratio that an optimizer is free to emit.
    removeOne(div, denominator);
    const g = gcdBig(numerator, denominator);
    const n = numerator / g, d = denominator / g;
    if (n > 1n) mul.push(n);
    if (d > 1n) div.push(d);
  }
  if (!mul.length && !div.length) return null;
  return { text: s, mul, div };
}

/**
 * 文言が書いている数と、命令から復元した計算の数を突き合わせる。
 *
 * ここで数えるのは **復元した式の中の掛け算・割り算の定数** だけ。
 * 「関数のどこかに即値 100 がある」では弱すぎる（`cmp w8, #100` でも当たる）。
 * 「その値を 100 で割っている命令が実在する」まで来て、初めて裏取りになる。
 */
export function matchFormulas(steps, labels, vg) {
  const claimed = new Map();          // 演算 + 数 → その計算を書いている文言
  const formulaKey = (kind, value) => `${kind}:${value.toString()}`;
  for (const l of labels) {
    const f = formulaOf(l.text);
    if (!f) continue;
    for (const v of f.mul) {
      const key = formulaKey('mul', v);
      if (!claimed.has(key)) claimed.set(key, { op: '×', kind: 'mul', v, text: l.text });
    }
    for (const v of f.div) {
      const key = formulaKey('div', v);
      if (!claimed.has(key)) claimed.set(key, { op: '÷', kind: 'div', v, text: l.text });
    }
  }
  if (!claimed.size) return null;

  /*
   * 突き合わせは **数そのもの** で行う。
   *
   * 「基ダ×(100+%d)÷100」の 100 は、命令の側では割る数としても、
   * 括弧の中の足す数としても現れる。どちらの位置に出たかは文言の書き方
   * しだいなので、そこまで一致を求めると本物を落とす。大事なのは
   * 「その数を使った **計算** が実在する」ことのほうで、
   * `cmp w8, #100` のような比較しか無いものとは、そこで区別できている。
   */
  const found = new Map();
  for (const st of steps) {
    for (const use of arithConstants(st.expr)) {
      if (use.kind !== 'mul' && use.kind !== 'div') continue;
      const key = formulaKey(use.kind, use.v);
      if (!claimed.has(key) || found.has(key)) continue;
      found.set(key, { use, step: st });
    }
  }
  /*
   * 積算の連なりだけを見ていたころ、「ふっとばす:%d %d×(100-[耐性:%d])÷100」の
   * ような、1 段しかない計算や、別の変数で持ち回っている計算が全部こぼれていた。
   * 文言が名指ししているのは関数の中の計算であって、こちらが選んだ 1 本の
   * 積算値の中の計算とは限らない。復元できた式は全部見る。
   */
  if (vg) {
    for (const [row, made] of vg.defs) {
      for (const reg of Object.keys(made)) {
        for (const use of arithConstants(made[reg])) {
          if (use.kind !== 'mul' && use.kind !== 'div') continue;
          const key = formulaKey(use.kind, use.v);
          if (!claimed.has(key) || found.has(key)) continue;
          found.set(key, { use, step: { row, address: addressOfRow(vg, row) } });
        }
      }
    }
  }
  if (!found.size) return null;

  const hits = Array.from(found.entries()).map(([key, hit]) => ({
    op: claimed.get(key).op,
    used: hit.use.kind,
    value: claimed.get(key).v,
    text: claimed.get(key).text,
    address: hit.step.address,
    row: hit.step.row,
  }));
  /*
   * 一致の強さ。
   *
   * 1 個だけの一致（÷100 など）は、たまたまでも起こりうる。何種類もの数が
   * そろって一致することは、まず起こらない。だから種類の数で効かせる。
   */
  const distinct = new Set(hits.map((h) => `${h.used}:${h.value.toString()}`)).size;
  const texts = Array.from(new Set(hits.map((h) => h.text)));
  return {
    hits: hits.sort((a, b) => a.row - b.row),
    texts,
    claimed: claimed.size,
    matched: found.size,
    distinct,
    strength: Math.max(0, Math.min(1, (distinct - 1) / 4)),
    ratio: found.size / claimed.size,
  };
}

/** 行番号からアドレスを引く（値グラフは行しか持っていない）。 */
function addressOfRow(vg, row) {
  const hit = vg.rowAddress ? vg.rowAddress.get(row) : null;
  return hit == null ? null : hit;
}

/** その式は住所の計算か（sp / x29 を土台にしている）。 */
function isAddressMath(n) {
  let hit = false;
  walk(n, (x) => { if (x.k === 'reg' && (x.reg === 'sp' || x.reg === 'x29')) hit = true; });
  return hit;
}

/** 復元した式が「計算に使っている定数」。比較や添字の定数は入らない。 */
function arithConstants(n) {
  const out = [];
  walk(n, (x) => {
    if (!x || x.k !== 'bin') return;
    const c = constOf(x.b);
    if (c == null || c <= 1n) return;
    /*
     * スタックの取り方（`sub sp, sp, #0x190` の 400）は計算ではなく場所の話。
     * ここを数えていたころ、「魔女キラー … ÷400」がフレームの大きさと
     * たまたま一致して、一致の証拠に混ざっていた。
     */
    if ((x.op === 'add' || x.op === 'sub') && isAddressMath(x)) return;
    if (x.op === 'mul') out.push({ kind: 'mul', v: c });
    else if (x.op === 'sdiv' || x.op === 'udiv') out.push({ kind: 'div', v: c });
    else if (x.op === 'add' || x.op === 'sub') {
      /*
       * 「(100+%d)」の 100 は足し算として現れる。式の骨組みの一部なので数える。
       * 小さい数（1〜9）は何にでも出るので、ここでは数えない。
       */
      if (c >= 10n) out.push({ kind: x.op === 'add' ? 'plus' : 'minus', v: c });
    }
  });
  return out;
}

/* ────────────────────────────────────────────────────────────
   4.5 積算値の行き先
   ────────────────────────────────────────────────────────────

   工程を並べただけでは、まだ半分しか言えていない。
   「作った値をどうしたのか」まで言えて、はじめて処理として閉じる。

       …14 回作り変えて、1 未満なら 1 に切り上げて、
         その値を sub_100420580 に渡している

   ここまで来れば、名前が 1 つも残っていなくても、読む人は
   「これは最終的な値を計算して、使う側へ渡す処理だ」と判断できる。 */

/**
 * 最後の工程で作った値が、そのあとどこへ行くか。
 * 追えなくなったところで止める（「たぶんここ」は返さない）。
 */
export function findSink(model, vg, acc) {
  if (!acc || !acc.steps.length) return null;
  const last = acc.steps[acc.steps.length - 1];
  const insns = model.instructions || [];
  const byRow = new Map(insns.map((i) => [i.row, i]));
  const rows = insns.map((i) => i.row).sort((a, b) => a - b);
  const nextRow = new Map();
  for (let i = 0; i + 1 < rows.length; i++) nextRow.set(rows[i], rows[i + 1]);
  const rowAtAddress = new Map();
  for (const i of insns) if (i.address != null) rowAtAddress.set(i.address.toString(), i.row);

  const callByRow = new Map();
  for (const c of model.calls || []) callByRow.set(c.row, c);
  const writesByRow = new Map();
  for (const w of vg.memWrites || []) {
    if (!writesByRow.has(w.row)) writesByRow.set(w.row, []);
    writesByRow.get(w.row).push(w);
  }

  const successors = (insn) => {
    if (!insn || insn.isReturn) return [];
    const fallthrough = nextRow.get(insn.row);
    if (insn.isBranch && !insn.isCall) {
      const target = insn.branchTarget == null ? null : rowAtAddress.get(insn.branchTarget.toString());
      if (insn.isConditional) return [target, fallthrough].filter((x, i, a) => x != null && a.indexOf(x) === i);
      return target == null ? [] : [target];
    }
    return fallthrough == null ? [] : [fallthrough];
  };

  const lastInsn = byRow.get(last.row);
  const initialRows = lastInsn ? successors(lastInsn) : rows.filter((r) => r > last.row).slice(0, 1);
  const queue = initialRows.map((row) => ({ row, cur: last.after, clamps: [] }));
  const seen = new Set();
  const sinks = [];
  const clampOnly = [];
  let budget = 0;

  while (queue.length && budget++ < 8192) {
    const state = queue.shift();
    const insn = byRow.get(state.row);
    if (!insn) continue;
    const identity = `${state.row}:${render(state.cur, { maxLen: 640 })}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    let cur = state.cur;
    let clamps = state.clamps;

    for (const w of writesByRow.get(insn.row) || []) {
      if (contains(w.value, cur)) sinks.push({ kind: 'store', row: insn.row, address: insn.address, write: w, clamps });
    }
    const call = callByRow.get(insn.row);
    if (call) {
      for (let a = 0; a <= 7; a++) {
        const v = vg.at(insn.row, 'x' + a);
        if (!v || !contains(v, cur)) continue;
        sinks.push({
          kind: 'argument', row: insn.row, address: insn.address,
          name: call.name || null, target: call.target != null ? call.target : null,
          index: a, clamps,
        });
      }
    }
    if (insn.isReturn) {
      const v = vg.at(insn.row, 'x0');
      if (v && contains(v, cur)) sinks.push({ kind: 'return', row: insn.row, address: insn.address, clamps });
    }
    if (sinks.length) continue;

    const defs = vg.defs.get(insn.row);
    if (defs) {
      for (const reg of Object.keys(defs)) {
        const v = defs[reg];
        if (!v || !contains(v, cur)) continue;
        if (v.k === 'sel') clamps = clamps.concat([{ row: insn.row, address: insn.address, cc: v.cc, expr: v }]);
        cur = v;
        break;
      }
    }
    const next = successors(insn);
    if (!next.length && clamps.length) clampOnly.push({ kind: 'clamped', clamps, certain: true });
    for (const row of next) queue.push({ row, cur, clamps });
  }

  if (sinks.length) {
    const keyOf = (x) => [x.kind, x.row, x.index ?? '', x.write?.baseReg ?? '', x.write?.disp ?? '', x.target ?? ''].join(':');
    const unique = new Map(sinks.map((x) => [keyOf(x), x]));
    // Divergent branches reaching different consumers are not one certain sink.
    if (unique.size === 1) return unique.values().next().value;
    return { kind: 'ambiguous', certain: false, candidates: [...unique.values()].slice(0, 8) };
  }
  if (clampOnly.length === 1) return clampOnly[0];

  // Weak proximity fallback remains explicitly uncertain and is restricted to
  // CFG-reachable rows rather than a sibling branch with a larger row number.
  const reachable = new Set();
  const q = initialRows.slice();
  while (q.length && reachable.size < 4096) {
    const row = q.shift();
    if (reachable.has(row)) continue;
    reachable.add(row);
    for (const n of successors(byRow.get(row))) q.push(n);
  }
  for (const row of [...reachable].sort((a, b) => a - b)) {
    const insn = byRow.get(row);
    if (!insn || row - last.row > 96) continue;
    if (!/^(csel|csinc|csinv|csneg|smax|smin|umax|umin)$/.test(String(insn.mnemonic).toLowerCase())) continue;
    if (!insn.reads.includes(acc.reg)) continue;
    return { kind: 'clamped', certain: false, clamps: [{ row, address: insn.address, cc: null, expr: null }] };
  }
  return null;
}

/* ────────────────────────────────────────────────────────────
   5. 出口 — 何を返し、どこへ書くか
   ──────────────────────────────────────────────────────────── */

function returnValue(model, vg) {
  const list = (vg.returns || []).filter((r) => r.value);
  if (!list.length) return null;
  const groups = [];
  for (const r of list) {
    const hit = groups.find((g) => same(g.value, r.value));
    if (hit) { hit.n++; continue; }
    groups.push({ value: r.value, n: 1, row: r.row, address: r.address });
  }
  const semanticRank = (v) => {
    if (!v) return -1;
    if (v.k === 'call') return 6;
    if (v.k === 'sel' || v.k === 'bin') return 5;
    if (v.k === 'un' || v.k === 'mem') return 4;
    if (v.k === 'str' || v.k === 'addr') return 3;
    if (v.k === 'arg' || v.k === 'reg') return 2;
    if (v.k === 'const') return v.v === 0n ? 0 : 1;
    return 1;
  };
  // Exit frequency is not semantic importance: error/guard exits often return
  // 0 many times while the success path returns one computed value once.
  groups.sort((a, b) => semanticRank(b.value) - semanticRank(a.value) ||
    sizeOf(b.value) - sizeOf(a.value) || b.n - a.n || a.row - b.row);
  void model;
  return groups[0];
}

/** 外（自分のスタック以外）へ書き込んでいる場所。 */
function externalWrites(vg) {
  const out = [];
  for (const w of vg.memWrites || []) {
    if (w.stack) continue;
    out.push(w);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────
   まとめ
   ──────────────────────────────────────────────────────────── */

const MAX_STEPS = 24;

/**
 * 関数 1 つを「読める処理」に畳む。
 *
 * @param {object} o
 *   model      buildSemanticModel の結果（文字列が入っているほど強い）
 *   symbolFor  (addr) => 名前
 *   fieldFor   (baseReg, disp) => {name} 名前が読めるなら
 * @returns {object|null}
 */
export function comprehend(o) {
  const model = o && o.model;
  if (!model || !(model.instructions || []).length) return null;

  const vg = buildValues(model, { symbolFor: o.symbolFor });
  const labels = labelStrings(model);
  const accs = findAccumulators(model, vg);
  const acc = accs[0] || null;

  const steps = [];
  if (acc) {
    for (const st of acc.steps.slice(0, MAX_STEPS)) {
      const shape = shapeOfStep(st.expr);
      const label = labelFor(labels, st.row);
      steps.push({
        row: st.row, address: st.address, reg: st.reg,
        expr: st.expr, shape, label: label ? { text: label.text, addr: label.addr } : null,
      });
    }
  }

  const formula = labels.length ? matchFormulas(steps, labels, vg) : null;
  const ret = returnValue(model, vg);
  const writes = externalWrites(vg);

  /*
   * 積算値が見つからなくても、言えることはある。
   * 戻り値の式、外へ書いた値、参照した文言 — どれも命令から確かめられる。
   */
  const out = {
    accumulator: acc ? { reg: acc.reg, count: acc.count, ops: acc.ops } : null,
    /* 積算の出発点。「何から計算しはじめたのか」。 */
    seed: acc && acc.seed ? {
      expr: acc.seed, row: acc.steps[0].row, address: acc.steps[0].address,
    } : null,
    sink: acc ? findSink(model, vg, acc) : null,
    steps,
    formula,
    ret: ret ? { expr: ret.value, row: ret.row, address: ret.address, exits: ret.n } : null,
    writes: writes.slice(0, 12).map((w) => ({
      row: w.row, address: w.address, baseReg: w.baseReg, disp: w.disp,
      size: w.size, expr: w.value,
    })),
    labels: labels.slice(0, 40),
    values: vg,
    headline: null,
  };
  out.headline = headlineOf(out, model);
  return out;
}

/**
 * 1 行で言うなら何か。書けることが無ければ null（埋めない）。
 *
 * ここで返すのはコードだけ。文にするのは narrate.js。
 */
function headlineOf(c, model) {
  if (c.formula && c.formula.distinct >= 2) {
    return {
      code: 'cm-formula',
      steps: c.steps.length,
      distinct: c.formula.distinct,
      texts: c.formula.hits.slice(0, 3).map((h) => h.text),
    };
  }
  if (c.accumulator && c.steps.length >= 2) {
    const scales = c.steps.filter((s) => s.shape.kind === STEP.SCALE).length;
    return {
      code: scales >= 2 ? 'cm-pipeline' : 'cm-carry',
      reg: c.accumulator.reg, steps: c.steps.length, scales,
      labelled: c.steps.filter((s) => s.label).length,
    };
  }
  if (c.ret && c.ret.expr && sizeOf(c.ret.expr) >= 3) {
    return { code: 'cm-returns', size: sizeOf(c.ret.expr) };
  }
  if (c.writes.length === 1 && !c.steps.length) {
    return { code: 'cm-store', disp: c.writes[0].disp };
  }
  void model;
  return null;
}

/* ────────────────────────────────────────────────────────────
   文字にするための下ごしらえ（言葉は narrate.js が付ける）
   ──────────────────────────────────────────────────────────── */

/**
 * 工程を「読める 1 行」にする。
 * @param {object} step comprehend().steps の 1 件
 * @param {object} opts render のオプション
 */
export function stepText(step, opts) {
  return 'result = ' + render(step.expr, opts) + ';';
}

/** 呼んでいる相手・触っている場所を、式から数え上げる（要約用）。 */
export function ingredientsOf(expr) {
  return {
    calls: callsIn(expr).map((c) => ({ name: c.name, target: c.target, row: c.row })),
    mems: memsIn(expr).map((m) => ({ baseReg: m.baseReg, disp: m.disp, size: m.size })),
    consts: constantsIn(expr),
  };
}
