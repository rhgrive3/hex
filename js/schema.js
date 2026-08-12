/*
 * データファイルの表を、命令から読み取る層。
 *
 * ここがこのツールでいちばん「確定」に近づける場所。
 *
 * 現代のモバイルゲームは、数値をコードに書かない。CSV や JSON で持っていて、
 * 起動時に読み込む。だからバイナリの中に「攻撃力」という言葉は 1 つも無いのに、
 * **どこに何番目の数値が入るか** は命令にはっきり書いてある。
 *
 *     bl   0x10027c37c              ; 1 列ぶんを整数にする
 *     str  w0, [x28, x21, lsl #2]   ; ← i 列目を +i*4 に置く
 *     add  x21, x21, #0x1
 *     cmp  x21, #0x75               ; 117 列
 *
 * この 4 行が読めれば「unit%03d.csv の i 列目は、この表の +i*4 にある」と
 * **言い切れる**。推測が 1 つも要らない。名前が消してあっても、文字列が
 * 1 つも残っていなくても、読み込む以上この形は消せない。
 *
 * さらに 1 レコードの大きさ（0x1d4）とレコード数（4）も同じ場所に書いてあるので、
 * 表の形がまるごと復元できる。あとは利用者が手元の CSV を開いて
 * 「4 列目が攻撃力」と分かれば、+0xC という答えがそのまま出る。
 *
 * 逆アセンブラは通さない。命令語のビットを直接読む（words.js と同じ流儀）。
 * 日本語は作らない。返すのは構造と、その根拠になった命令の位置だけ。
 */
import './words.js';

const W = globalThis.Words;

/* ── 命令のビットを読む小道具 ───────────────────────────────── */

const rd = (w) => w & 31;
const rn = (w) => (w >>> 5) & 31;
const rm = (w) => (w >>> 16) & 31;

/** add/sub Xd, Xn, #imm（シフトつき）。違えば null。 */
function addSubImm(w) {
  if (W.masked(w, 0x1f000000) !== 0x11000000) return null;
  if (((w >>> 29) & 1) === 1 && rd(w) === 31) return null;      // cmp
  const imm = ((w >>> 10) & 0xfff) << (((w >>> 22) & 1) ? 12 : 0);
  return { d: rd(w), n: rn(w), imm, sub: ((w >>> 30) & 1) === 1 };
}

/** movz / movk。定数を組み立てている途中も追えるようにする。 */
function moveWide(w) {
  if (!W.isMoveWide(w)) return null;
  const opc = (w >>> 29) & 3;                 // 00 movn / 10 movz / 11 movk
  const shift = ((w >>> 21) & 3) * 16;
  const imm16 = (w >>> 5) & 0xffff;
  if (opc === 2) return { d: rd(w), kind: 'movz', value: imm16 * 2 ** shift };
  if (opc === 3) return { d: rd(w), kind: 'movk', imm16, shift };
  return null;
}

/**
 * 添字つきの読み書き — `str w0, [x28, x21, lsl #2]`。
 *
 * ここが表の要。ずらし幅が **列番号 × 何バイト** で決まっていることが、
 * この 1 命令から読み取れる。
 */
function indexedAccess(w) {
  if (W.masked(w, 0x3b200c00) !== 0x38200800) return null;
  const size = 1 << ((w >>> 30) & 3);
  const scaled = ((w >>> 12) & 1) === 1;      // S ビット。立っていれば大きさぶん左シフト
  return {
    load: ((w >>> 22) & 1) === 1,
    size,
    base: rn(w),
    index: rm(w),
    reg: rd(w),
    // lsl #2 の 2 は「その転送の大きさの log2」。S が 0 なら添字はバイト単位。
    stride: scaled ? size : 1,
  };
}

/** 素の（添字なし）読み書き。 */
function plainAccess(w) {
  const m = W.memoryAccess(w);
  if (!m || m.indexed || m.pair || m.disp == null) return null;
  return { load: m.load, size: m.size, base: m.base, disp: Number(m.disp), reg: m.reg };
}

/* ── 表の形を組み立てる ─────────────────────────────────────── */

const MAX_COLUMNS = 4096;        // これを超える「列数」は読み違い
const MAX_RECORD = 1 << 20;      // 1 レコードがこれより大きいのも読み違い

/**
 * 関数 1 つぶんの命令語から、データファイルの表の形を読み取る。
 *
 * @param {Uint32Array} words  その関数の命令語（先頭から順に）
 * @param {BigInt} base        先頭の仮想アドレス
 * @returns {object|null} 読み取れた形。読み取れなければ null（作り話はしない）
 */
export function decodeSchema(words, base) {
  const konst = new Int32Array(32).fill(0);
  const known = new Uint8Array(32);            // その定数が信用できるか
  const bumped = new Map();                    // レジスタ → 加算されている量（レコード送り）
  const loops = [];                            // 添字つき書き込みの候補
  const fixed = [];                            // 展開されている固定ずらしの書き込み
  const scales = [];                           // 読み込みのあとに掛かる倍率
  const cmps = new Map();                      // レジスタ → 比べている定数

  let lastCall = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];

    /* 定数の組み立て */
    const mw = moveWide(w);
    if (mw) {
      if (mw.kind === 'movz') { konst[mw.d] = mw.value; known[mw.d] = 1; }
      else if (known[mw.d]) konst[mw.d] |= mw.imm16 * 2 ** mw.shift;
      continue;
    }

    /* cmp Xn, #imm — 列数・レコード数はここに出る */
    const ci = W.compareImmediate(w);
    if (ci != null) { cmps.set(rn(w), { value: Number(ci), row: i }); continue; }

    if (W.isCallImm(w) || W.isIndirectCall(w)) {
      lastCall = i;
      // 呼び出しで壊れるレジスタの定数は捨てる（x0-x18）
      for (let r = 0; r <= 18; r++) known[r] = 0;
      continue;
    }

    /* add Xd, Xn, #imm — 同じレジスタへの加算はレコード送り */
    const as = addSubImm(w);
    if (as) {
      if (as.d === as.n && as.imm > 0) {
        const prev = bumped.get(as.d);
        if (!prev || prev.imm !== as.imm) bumped.set(as.d, { imm: as.imm, row: i });
      }
      konst[as.d] = 0; known[as.d] = 0;
      continue;
    }

    /* 添字つきの書き込み — 表の 1 列ぶん */
    const ix = indexedAccess(w);
    if (ix) {
      if (ix.load) {
        // 読み込み → 掛け算 → 同じ場所へ書き戻す（読み込んだあとの倍率）
        scales.push({ row: i, base: ix.base, index: ix.index, stride: ix.stride, mul: null });
      } else {
        loops.push({
          row: i, addr: base + BigInt(i * 4),
          base: ix.base, index: ix.index, stride: ix.stride, size: ix.size,
          // 直前が呼び出しなら、その戻り値をそのまま置いている＝1 列ぶんの値
          fromCall: lastCall >= 0 && i - lastCall <= 3 && ix.reg === 0,
        });
      }
      continue;
    }

    /* 固定ずらしの書き込みが、呼び出しの直後に並んでいる形（展開されている表） */
    const pa = plainAccess(w);
    if (pa && !pa.load && pa.reg === 0 && lastCall >= 0 && i - lastCall <= 3 && !pa.base !== 31) {
      fixed.push({ row: i, addr: base + BigInt(i * 4), base: pa.base, disp: pa.disp, size: pa.size });
      continue;
    }

    /* mul Wd, Wn, Wm — 読み込んだ列に掛かる倍率 */
    if (W.isMultiply(w) && scales.length) {
      const last = scales[scales.length - 1];
      if (last.mul == null && i - last.row <= 6) {
        const k = known[rm(w)] ? konst[rm(w)] : (known[rn(w)] ? konst[rn(w)] : null);
        if (k) last.mul = k;
      }
      continue;
    }
  }

  return buildSchema({ loops, fixed, scales, cmps, bumped, base, words });
}

/**
 * 拾った断片から、表としてつじつまの合うものを組み立てる。
 *
 * 1 つの関数が何本ものファイルを読むことがある（unitlevel / unitbuy / unitexp が
 * 同じ関数の中にある）。表も 1 つとは限らないので、見つかったぶんだけ全部返す。
 * つじつまが合わないものも隠さないが、合ったものを先に置く。
 */
function buildSchema({ loops, fixed, scales, cmps, bumped, base }) {
  const tables = [];

  /* いちばん確かなのは「呼び出しの戻り値を、添字つきで並べて置いている」形 */
  const seen = new Set();
  for (const l of loops) {
    const key = l.base + ':' + l.index + ':' + l.stride;
    if (seen.has(key)) continue;
    seen.add(key);

    /*
     * 列数は、添字レジスタの比較から取る。ただし
     * **その添字が 1 ずつ増えていること** を確かめてから使う。
     * ここを見ないと、たまたま同じレジスタを使っていた別の比較を列数にしてしまう。
     */
    const step = bumped.get(l.index);
    const bound = cmps.get(l.index);
    const columns = (step && step.imm === 1 && bound && bound.value > 1 &&
      bound.value <= MAX_COLUMNS) ? bound.value : null;

    const rec = bumped.get(l.base) || null;
    const recordStride = rec && rec.imm > l.stride && rec.imm <= MAX_RECORD ? rec.imm : null;

    /*
     * つじつま合わせ。1 レコードの大きさが、列数 × 1 列の大きさと合っているか。
     * ここが合えば、読み違いはまず無い。合わなければ、合わないと言う。
     */
    const consistent = columns != null && recordStride != null
      ? recordStride === columns * l.stride
      : null;

    tables.push(makeIndexedTable({
      columns, stride: l.stride, size: l.size, recordStride, consistent,
      storeAddr: l.addr,
      records: recordCountOf(cmps, bumped, l.base, l.index),
      scaled: scaledColumns(scales, l.stride),
      fromCall: l.fromCall,
    }));
  }

  /* 展開されている形 — 呼び出しの直後の固定ずらしが、そのまま列の並びになる */
  const byBase = new Map();
  for (const f of fixed) {
    if (!byBase.has(f.base)) byBase.set(f.base, []);
    byBase.get(f.base).push(f);
  }
  for (const list of byBase.values()) {
    if (list.length < 3) continue;
    const sorted = list.slice().sort((a, b) => a.row - b.row);
    const offsets = sorted.map((f) => f.disp);
    tables.push({
      kind: 'unrolled',
      columns: offsets.length,
      columnStride: null,
      columnSize: sorted[0].size,
      recordStride: null,
      records: null,
      consistent: null,
      storeAddr: sorted[0].addr,
      offsets,
      scaled: [],
      offsetOf(i) { return i >= 0 && i < offsets.length ? offsets[i] : null; },
    });
  }

  if (!tables.length) return null;
  // つじつまの合ったもの、列の多いものから
  tables.sort((a, b) => (b.consistent === true) - (a.consistent === true) ||
    (b.fromCall === true) - (a.fromCall === true) ||
    (b.columns || 0) - (a.columns || 0));
  void base;
  return { tables, best: tables[0] };
}

function makeIndexedTable(t) {
  return {
    kind: 'indexed',
    columns: t.columns,
    columnStride: t.stride,
    columnSize: t.size,
    recordStride: t.recordStride,
    records: t.records,
    consistent: t.consistent,
    storeAddr: t.storeAddr,
    scaled: t.scaled,
    fromCall: t.fromCall,
    /** i 列目のずらし幅。表の外の列には答えない。 */
    offsetOf(i) {
      if (!(i >= 0) || (t.columns != null && i >= t.columns)) return null;
      return i * t.stride;
    },
  };
}

/**
 * レコード数。表の基点を送っているレジスタとは別に、1 ずつ増えて
 * 小さな数と比べられているレジスタがあれば、それがレコードの回し。
 *
 * 列の添字そのものを数えないよう、必ず除いておく
 * （そうしないと「117 レコード」のような答えになる）。
 */
function recordCountOf(cmps, bumped, baseReg, indexReg) {
  for (const [reg, c] of cmps) {
    if (reg === baseReg || reg === indexReg) continue;
    const step = bumped.get(reg);
    if (step && step.imm === 1 && c.value > 1 && c.value <= 4096) return c.value;
  }
  return null;
}

/** 読み込んだあとに倍率が掛かる列（「％の値を 100 倍して持つ」など）。 */
function scaledColumns(scales, stride) {
  const out = [];
  for (const s of scales) {
    if (s.mul == null) continue;
    out.push({ factor: s.mul, columnStride: s.stride || stride });
  }
  return out;
}

/* ── バイナリ全体から、データファイルの表を集める ──────────── */

/** データファイルらしい名前か。拡張子だけで見る（中身は読まない）。 */
export function looksLikeDataFile(text) {
  return /\.(csv|tsv|json|plist|dat|txt)$/i.test(String(text || ''));
}

/**
 * バイナリの中のデータファイル名から、その読み込み処理と表の形を集める。
 *
 * @param {object} opts
 *   strings  [{addr, text}]
 *   program  ProgramIndex
 *   read     async (addr:BigInt, len:number) => Uint8Array|null
 *   limit    いくつまで調べるか
 * @returns {Promise<Array<object>>} 表の形（読み取れたものだけ）
 */
export async function recoverSchemas(opts) {
  const o = opts || {};
  const { strings, program, read } = o;
  if (!strings || !program || !read) return [];
  /*
   * 読み込み処理は 1 つ 1 つが小さいので、上限は広めでよい。
   * ここを絞ると「1 本のファイルしか読まないが、いちばん大事な表」
   * （unit%03d.csv がまさにそれ）を取り逃がす。
   */
  const limit = o.limit || 300;
  const cancelled = o.isCancelled || (() => false);
  const progress = o.onProgress || (() => {});

  /* 1. データファイル名 → それを参照している関数 */
  const byFunction = new Map();
  for (const s of strings) {
    if (!looksLikeDataFile(s.text)) continue;
    const fns = program.functionsReferencing(s.addr, BigInt(Math.max(1, s.text.length)), 8);
    for (const f of fns) {
      if (f.addr == null) continue;
      const key = f.addr.toString();
      if (!byFunction.has(key)) byFunction.set(key, { addr: f.addr, files: [] });
      const e = byFunction.get(key);
      if (e.files.length < 40 && !e.files.includes(s.text)) e.files.push(s.text);
    }
  }
  if (!byFunction.size) return [];

  /*
   * 読む順番。ファイル名を多く抱えている関数ほど、まとめ読みの本体である公算が高い。
   * ただし大きすぎる関数は読まない（表の復元より先に時間が尽きる）。
   */
  const targets = Array.from(byFunction.values())
    .map((e) => {
      const r = program.functionRange(e.addr);
      return Object.assign({}, e, { range: r, size: r ? Number(r.end - r.start) : 0 });
    })
    .filter((e) => e.range && e.size > 16 && e.size <= 64 * 1024)
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, limit);

  const out = [];
  for (let i = 0; i < targets.length; i++) {
    if (cancelled()) break;
    progress({ phase: 'schema', done: i, all: targets.length });
    const t = targets[i];
    let bytes = null;
    try { bytes = await read(t.range.start, t.size); } catch { bytes = null; }
    if (!bytes || bytes.length < 16) continue;
    const n = bytes.length >> 2;
    const words = new Uint32Array(n);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
    for (let k = 0; k < n; k++) words[k] = dv.getUint32(k * 4, true);

    let schema = null;
    try { schema = decodeSchema(words, t.range.start); } catch { schema = null; }
    if (!schema) continue;
    out.push({
      loader: t.addr,
      files: t.files,
      loaderSize: t.size,
      tables: schema.tables,
      // いちばん確かな 1 本。画面はまずこれを見せればよい。
      best: schema.best,
    });
  }
  progress({ phase: 'schema', done: targets.length, all: targets.length });

  /* つじつまの合ったものから見せる。合っていないものも残すが、後ろに置く。 */
  out.sort((a, b) => (b.best.consistent === true) - (a.best.consistent === true) ||
    (b.best.columns || 0) - (a.best.columns || 0));
  return out;
}

/** そのファイル名を読み込んでいる表を引く。 */
export function schemaForFile(schemas, filename) {
  for (const s of schemas || []) {
    if ((s.files || []).includes(filename)) return s;
  }
  return null;
}

/**
 * 「その値は何列目か」から「どのずらし幅か」へ。逆も引ける。
 *
 * 利用者が手元の CSV を開いて「4 列目が攻撃力」と分かったとき、
 * ここが答えを出す入口になる。
 */
/** 表そのものでも、recoverSchemas が返した 1 件でも受け取れるようにする。 */
function tableOf(x) {
  if (!x) return null;
  if (typeof x.offsetOf === 'function') return x;
  return x.best || null;
}

export function columnToOffset(schema, column) {
  const t = tableOf(schema);
  return t ? t.offsetOf(column) : null;
}

export function offsetToColumn(schema, offset) {
  const t = tableOf(schema);
  if (!t) return null;
  if (t.kind === 'unrolled') {
    const i = (t.offsets || []).indexOf(offset);
    return i < 0 ? null : i;
  }
  const stride = t.columnStride;
  if (!stride || offset % stride !== 0) return null;
  const i = offset / stride;
  if (t.columns != null && i >= t.columns) return null;
  return i;
}
