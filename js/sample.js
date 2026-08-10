/*
 * 練習用のサンプルバイナリを、その場で組み立てる。
 *
 * 「読んでみたいけど、手元にファイルがない」人が最初の一歩を踏み出せるように、
 * 本物と同じ形の Mach-O（ARM64）を JavaScript で作って開く。
 *
 * わざと、初心者が最初に出会うべきものを全部入れてある:
 *   - 引数を足して返すだけの、いちばん小さい関数
 *   - ループのある関数
 *   - 文字列を指して外部関数を呼ぶ関数（adrp + add → __stubs → __got）
 *   - ローカル変数をスタックに置く main
 *   - シンボル（関数名）、LC_FUNCTION_STARTS、__cstring
 *
 * 実行するためのものではなく、読むためのものです。
 */

const PAGE = 0x4000n;             // arm64 のページ
const TEXT_VM = 0x100000000n;     // iOS/macOS のアプリが置かれる定番の位置

/* ────────────────────────────────────────────────────────────
   ごく小さな ARM64 エンコーダ
   （ここで作った 4 バイトが、そのまま画面に出る 16 進になります）
   ──────────────────────────────────────────────────────────── */

const SP = 31, XZR = 31;

const u = (n) => n >>> 0;

/** movz Wd/Xd, #imm16 */
const movz = (rd, imm, bits = 32, shift = 0) =>
  u((bits === 64 ? 0xd2800000 : 0x52800000) | ((shift / 16) << 21) | ((imm & 0xffff) << 5) | rd);

/** mov Xd, Xm  （実体は orr Xd, xzr, Xm） */
const movReg = (rd, rm, bits = 64) =>
  u((bits === 64 ? 0xaa0003e0 : 0x2a0003e0) | (rm << 16) | rd);

/* orr の 31 番は sp ではなく xzr なので、mov Xd, sp は add Xd, sp, #0 で書く。 */
const movFromSp = (rd) => addImm(rd, SP, 0);

/** add/sub Rd, Rn, #imm12 */
const addImm = (rd, rn, imm, bits = 64) =>
  u((bits === 64 ? 0x91000000 : 0x11000000) | ((imm & 0xfff) << 10) | (rn << 5) | rd);
const subImm = (rd, rn, imm, bits = 64) =>
  u((bits === 64 ? 0xd1000000 : 0x51000000) | ((imm & 0xfff) << 10) | (rn << 5) | rd);

/** add Rd, Rn, Rm */
const addReg = (rd, rn, rm, bits = 64) =>
  u((bits === 64 ? 0x8b000000 : 0x0b000000) | (rm << 16) | (rn << 5) | rd);

/** cmp Rn, Rm  （subs xzr, Rn, Rm） */
const cmpReg = (rn, rm, bits = 32) =>
  u((bits === 64 ? 0xeb000000 : 0x6b000000) | (rm << 16) | (rn << 5) | XZR);

/** cmp Rn, #imm */
const cmpImm = (rn, imm, bits = 32) =>
  u((bits === 64 ? 0xf1000000 : 0x71000000) | ((imm & 0xfff) << 10) | (rn << 5) | XZR);

/** mul Rd, Rn, Rm  （madd Rd, Rn, Rm, xzr） */
const mul = (rd, rn, rm, bits = 32) =>
  u((bits === 64 ? 0x9b007c00 : 0x1b007c00) | (rm << 16) | (rn << 5) | rd);

/** stp/ldp Rt, Rt2, [Rn, #imm]! / [Rn], #imm / [Rn, #imm] */
function pair(load, rt, rt2, rn, imm, mode) {
  const base = 0xa8000000 | (load ? 0x00400000 : 0);
  const kind = mode === 'pre' ? 0x01800000 : mode === 'post' ? 0x00800000 : 0x01000000;
  const imm7 = (imm / 8) & 0x7f;
  return u(base | kind | (imm7 << 15) | (rt2 << 10) | (rn << 5) | rt);
}
const stp = (rt, rt2, rn, imm, mode) => pair(false, rt, rt2, rn, imm, mode);
const ldp = (rt, rt2, rn, imm, mode) => pair(true, rt, rt2, rn, imm, mode);

/** str/ldr Rt, [Rn, #imm] （符号なしオフセット） */
const strImm = (rt, rn, imm, bits = 64) =>
  u((bits === 64 ? 0xf9000000 : 0xb9000000) | (((imm / (bits / 8)) & 0xfff) << 10) | (rn << 5) | rt);
const ldrImm = (rt, rn, imm, bits = 64) =>
  u((bits === 64 ? 0xf9400000 : 0xb9400000) | (((imm / (bits / 8)) & 0xfff) << 10) | (rn << 5) | rt);

const RET = 0xd65f03c0;
const NOP = 0xd503201f;

/** b / bl （飛び先との差を 26 ビットに詰める） */
const branch = (link, delta) => u((link ? 0x94000000 : 0x14000000) | (Number(delta / 4n) & 0x3ffffff));
/** b.cond */
const bcond = (cond, delta) => u(0x54000000 | ((Number(delta / 4n) & 0x7ffff) << 5) | cond);
const COND = { eq: 0, ne: 1, lt: 11, gt: 12, le: 13, ge: 10 };

/** br Xn */
const br = (rn) => u(0xd61f0000 | (rn << 5));

/** adrp Rd, page  — 差はページ単位（4096 バイト） */
function adrp(rd, pc, target) {
  const imm = ((target & ~0xfffn) - (pc & ~0xfffn)) >> 12n;
  const v = Number(imm) & 0x1fffff;
  return u(0x90000000 | ((v & 3) << 29) | (((v >> 2) & 0x7ffff) << 5) | rd);
}

/* ────────────────────────────────────────────────────────────
   プログラム本体
   ──────────────────────────────────────────────────────────── */

const STRINGS = [
  'Hello from the sample binary!',
  'sum_to(10) = %d\n',
  '/tmp/sample-practice.log',
  'practice mode: nothing here is real',
];

/**
 * 命令列を組み立てる。
 * ラベルの位置が決まってから分岐先を埋めたいので、2 回まわす。
 */
function assemble(textAddr, stubsAddr, cstringAddr) {
  const label = {};
  let out = [];

  const build = () => {
    out = [];
    const here = () => textAddr + BigInt(out.length * 4);
    const put = (w) => out.push(w);

    /* ── int add(int a, int b) { return a + b; } ─────────────
       いちばん小さい関数。スタックも使わず、他の関数も呼ばない。 */
    label._add = here();
    put(addReg(0, 0, 1, 32));            // add w0, w0, w1
    put(RET);                            // ret

    /* ── int square(int n) { return n * n; } ──────────────── */
    label._square = here();
    put(mul(0, 0, 0, 32));               // mul w0, w0, w0
    put(RET);

    /* ── int sum_to(int n) — ループのある関数 ────────────────
         int s = 0;
         for (int i = 1; i <= n; i++) s += i;
         return s;                                            */
    label._sum_to = here();
    put(movz(2, 0, 32));                 // mov w2, #0      … 合計 s
    put(movz(1, 1, 32));                 // mov w1, #1      … カウンタ i
    label.loop = here();
    put(cmpReg(1, 0, 32));               // cmp w1, w0      … i と n を比べる
    const bGt = out.length; put(0);      // b.gt done       （あとで埋める）
    put(addReg(2, 2, 1, 32));            // add w2, w2, w1  … s += i
    put(addImm(1, 1, 1, 32));            // add w1, w1, #1  … i++
    const bLoop = out.length; put(0);    // b loop
    label.done = here();
    put(movReg(0, 2, 32));               // mov w0, w2      … 戻り値へ
    put(RET);

    /* ── void greet(void) — 文字列を渡して外部関数を呼ぶ ──── */
    label._greet = here();
    put(stp(29, 30, SP, -16, 'pre'));    // stp x29, x30, [sp, #-16]!
    put(movFromSp(29));                  // mov x29, sp
    const adrpAt = here();
    put(adrp(0, adrpAt, cstringAddr));   // adrp x0, "Hello…" のページ
    put(addImm(0, 0, Number(cstringAddr & 0xfffn))); // add x0, x0, #ページ内の位置
    const bPuts = out.length; put(0);    // bl _puts（スタブ経由）
    put(ldp(29, 30, SP, 16, 'post'));    // ldp x29, x30, [sp], #16
    put(RET);

    /* ── int main(void) — ローカル変数と、3 回の呼び出し ──── */
    label._main = here();
    put(stp(29, 30, SP, -32, 'pre'));    // stp x29, x30, [sp, #-32]!
    put(movFromSp(29));                  // mov x29, sp
    put(movz(0, 3, 32));                 // mov w0, #3      … 第 1 引数
    put(movz(1, 4, 32));                 // mov w1, #4      … 第 2 引数
    const bAdd = out.length; put(0);     // bl _add
    put(strImm(0, SP, 28, 32));          // str w0, [sp, #28]  … ローカル変数へ
    put(movz(0, 10, 32));                // mov w0, #10
    const bSum = out.length; put(0);     // bl _sum_to
    put(ldrImm(1, SP, 28, 32));          // ldr w1, [sp, #28]  … さっきの値を戻す
    put(addReg(0, 0, 1, 32));            // add w0, w0, w1
    put(strImm(0, SP, 24, 32));          // str w0, [sp, #24]
    const bGreet = out.length; put(0);   // bl _greet
    put(ldrImm(0, SP, 24, 32));          // ldr w0, [sp, #24]  … 戻り値
    put(ldp(29, 30, SP, 32, 'post'));
    put(RET);

    // 4 バイトの位置合わせ（本物のバイナリでも関数の間に入っています）
    put(NOP);

    return { bGt, bLoop, bPuts, bAdd, bSum, bGreet };
  };

  // 1 回目でラベルの位置を確定させ、2 回目で分岐先を埋める。
  const slots = build();
  const at = (i) => textAddr + BigInt(i * 4);
  out[slots.bGt] = bcond(COND.gt, label.done - at(slots.bGt));
  out[slots.bLoop] = branch(false, label.loop - at(slots.bLoop));
  out[slots.bPuts] = branch(true, stubsAddr - at(slots.bPuts));
  out[slots.bAdd] = branch(true, label._add - at(slots.bAdd));
  out[slots.bSum] = branch(true, label._sum_to - at(slots.bSum));
  out[slots.bGreet] = branch(true, label._greet - at(slots.bGreet));

  return { words: out, label };
}

/** __stubs の 1 エントリ: __got を読んで、そこへ飛ぶ 3 命令。 */
function buildStub(stubAddr, gotAddr) {
  return [
    adrp(16, stubAddr, gotAddr),
    ldrImm(16, 16, Number(gotAddr & 0xfffn), 64),
    br(16),
  ];
}

/* ────────────────────────────────────────────────────────────
   Mach-O の組み立て
   ──────────────────────────────────────────────────────────── */

class Writer {
  constructor(size) {
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
  }
  u8(o, v) { this.buf[o] = v; }
  u32(o, v) { this.dv.setUint32(o, v >>> 0, true); }
  i32(o, v) { this.dv.setInt32(o, v | 0, true); }
  u64(o, v) { this.dv.setBigUint64(o, BigInt(v), true); }
  str(o, s, len) {
    for (let i = 0; i < len; i++) this.buf[o + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0;
  }
  bytes(o, arr) { this.buf.set(arr, o); }
  words(o, ws) { for (let i = 0; i < ws.length; i++) this.u32(o + i * 4, ws[i]); }
}

/** ULEB128（LC_FUNCTION_STARTS はこの形式で差分を並べます） */
function uleb(value) {
  const out = [];
  let v = BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return out;
}

const LC_SEGMENT_64 = 0x19, LC_SYMTAB = 0x2, LC_DYSYMTAB = 0xb;
const LC_LOAD_DYLINKER = 0xe, LC_UUID = 0x1b, LC_BUILD_VERSION = 0x32;
const LC_MAIN = 0x80000028, LC_FUNCTION_STARTS = 0x26, LC_LOAD_DYLIB = 0xc;

const S_REGULAR = 0, S_CSTRING_LITERALS = 2, S_SYMBOL_STUBS = 8, S_NON_LAZY_SYMBOL_POINTERS = 6;
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000, S_ATTR_SOME_INSTRUCTIONS = 0x400;

const N_EXT = 0x01, N_SECT = 0x0e, N_UNDF = 0x00;

/** 練習用の Mach-O を 1 本、まるごと組み立てて返す。 */
export function buildSampleBinary() {
  const dylinker = '/usr/lib/dyld';
  const dylib = '/usr/lib/libSystem.B.dylib';

  /* ── ロードコマンドの大きさを先に計算する ── */
  const segCmd = (nsects) => 72 + nsects * 80;
  const align8 = (n) => (n + 7) & ~7;
  const cmdSizes = [
    segCmd(0),                          // __PAGEZERO
    segCmd(3),                          // __TEXT: __text, __stubs, __cstring
    segCmd(1),                          // __DATA_CONST: __got
    segCmd(0),                          // __LINKEDIT
    align8(12 + dylinker.length + 1),   // LC_LOAD_DYLINKER
    24,                                 // LC_UUID
    24,                                 // LC_BUILD_VERSION
    24,                                 // LC_MAIN
    16,                                 // LC_FUNCTION_STARTS
    24,                                 // LC_SYMTAB
    80,                                 // LC_DYSYMTAB
    align8(24 + dylib.length + 1),      // LC_LOAD_DYLIB
  ];
  const sizeofcmds = cmdSizes.reduce((a, b) => a + b, 0);
  const ncmds = cmdSizes.length;
  const headerEnd = 32 + sizeofcmds;

  /* ── __TEXT の中身を配置する ── */
  const textOff = (headerEnd + 15) & ~15;
  const textAddr = TEXT_VM + BigInt(textOff);

  // まず仮の位置で組み立てて大きさを知り、そのあと本番の位置で組み直す。
  let probe = assemble(textAddr, textAddr, textAddr);
  const textBytes = probe.words.length * 4;

  const stubsOff = textOff + textBytes;
  const stubsAddr = TEXT_VM + BigInt(stubsOff);
  const stubBytes = 12;

  const cstringOff = stubsOff + stubBytes;
  const cstringAddr = TEXT_VM + BigInt(cstringOff);
  const cstringData = [];
  const stringAddrs = [];
  for (const s of STRINGS) {
    stringAddrs.push(cstringAddr + BigInt(cstringData.length));
    for (let i = 0; i < s.length; i++) cstringData.push(s.charCodeAt(i) & 0x7f);
    cstringData.push(0);
  }

  const gotAddr = TEXT_VM + PAGE;              // __DATA_CONST の先頭
  const gotOff = Number(PAGE);

  // 本番の位置で組み直す（文字列の位置が決まったので adrp が正しくなる）
  const text = assemble(textAddr, stubsAddr, stringAddrs[0]);
  const stub = buildStub(stubsAddr, gotAddr);

  /* ── __LINKEDIT の中身 ── */
  const funcOrder = ['_add', '_square', '_sum_to', '_greet', '_main'];
  const funcAddrs = funcOrder.map((n) => text.label[n]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const funcStarts = [];
  let prev = TEXT_VM;
  for (const a of funcAddrs) { funcStarts.push(...uleb(a - prev)); prev = a; }
  funcStarts.push(0);                                   // 終端
  while (funcStarts.length % 8) funcStarts.push(0);     // 8 バイト境界へ

  // シンボル: 先に「定義されているもの」、そのあと「外部から借りるもの」
  const defined = funcOrder
    .map((n) => ({ name: n, addr: text.label[n] }))
    .sort((a, b) => (a.addr < b.addr ? -1 : 1));
  const symbols = [
    ...defined.map((d) => ({ name: d.name, type: N_SECT | N_EXT, sect: 1, value: d.addr })),
    { name: '_puts', type: N_UNDF | N_EXT, sect: 0, value: 0n },
  ];

  const strtab = [0];                                   // 先頭は必ず空文字列
  const strx = [];
  for (const s of symbols) {
    strx.push(strtab.length);
    for (let i = 0; i < s.name.length; i++) strtab.push(s.name.charCodeAt(i) & 0x7f);
    strtab.push(0);
  }
  while (strtab.length % 8) strtab.push(0);

  const indirect = [symbols.length - 1, symbols.length - 1];   // __stubs と __got、どちらも _puts

  const linkeditOff = Number(PAGE) * 2;
  const funcStartsOff = linkeditOff;
  const symtabOff = funcStartsOff + funcStarts.length;
  const indirectOff = symtabOff + symbols.length * 16;
  const strtabOff = indirectOff + indirect.length * 4;
  const linkeditEnd = strtabOff + strtab.length;
  const linkeditSize = linkeditEnd - linkeditOff;

  const fileSize = linkeditEnd;
  const w = new Writer(fileSize);

  /* ── ヘッダ ── */
  w.u32(0, 0xfeedfacf);                 // magic: 64 ビットの Mach-O
  w.i32(4, 0x0100000c);                 // cputype: ARM64
  w.i32(8, 0);                          // cpusubtype: all
  w.u32(12, 2);                         // filetype: MH_EXECUTE
  w.u32(16, ncmds);
  w.u32(20, sizeofcmds);
  w.u32(24, 0x00200085);                // flags: NOUNDEFS | DYLDLINK | TWOLEVEL | PIE
  w.u32(28, 0);                         // reserved

  let o = 32;

  /** LC_SEGMENT_64 を 1 つ書く。 */
  const segment = (name, vmaddr, vmsize, fileoff, filesize, prot, sections) => {
    const start = o;
    w.u32(o, LC_SEGMENT_64);
    w.u32(o + 4, segCmd(sections.length));
    w.str(o + 8, name, 16);
    w.u64(o + 24, vmaddr);
    w.u64(o + 32, vmsize);
    w.u64(o + 40, fileoff);
    w.u64(o + 48, filesize);
    w.u32(o + 56, prot);                // maxprot
    w.u32(o + 60, prot);                // initprot
    w.u32(o + 64, sections.length);
    w.u32(o + 68, 0);                   // flags
    let s = o + 72;
    for (const sec of sections) {
      w.str(s, sec.name, 16);
      w.str(s + 16, name, 16);
      w.u64(s + 32, sec.addr);
      w.u64(s + 40, sec.size);
      w.u32(s + 48, sec.offset);
      w.u32(s + 52, sec.align == null ? 2 : sec.align);
      w.u32(s + 56, 0);                 // reloff
      w.u32(s + 60, 0);                 // nreloc
      w.u32(s + 64, sec.flags || 0);
      w.u32(s + 68, sec.reserved1 || 0);
      w.u32(s + 72, sec.reserved2 || 0);
      w.u32(s + 76, 0);                 // reserved3
      s += 80;
    }
    o = start + segCmd(sections.length);
  };

  segment('__PAGEZERO', 0n, TEXT_VM, 0n, 0n, 0, []);
  segment('__TEXT', TEXT_VM, PAGE, 0n, PAGE, 5 /* r-x */, [
    { name: '__text', addr: textAddr, size: BigInt(textBytes), offset: textOff,
      flags: S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS, align: 2 },
    { name: '__stubs', addr: stubsAddr, size: BigInt(stubBytes), offset: stubsOff,
      flags: S_SYMBOL_STUBS | S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS,
      align: 2, reserved1: 0, reserved2: 12 },
    { name: '__cstring', addr: cstringAddr, size: BigInt(cstringData.length), offset: cstringOff,
      flags: S_CSTRING_LITERALS, align: 0 },
  ]);
  segment('__DATA_CONST', TEXT_VM + PAGE, PAGE, PAGE, PAGE, 3 /* rw- */, [
    { name: '__got', addr: gotAddr, size: 8n, offset: gotOff,
      flags: S_NON_LAZY_SYMBOL_POINTERS, align: 3, reserved1: 1 },
  ]);
  segment('__LINKEDIT', TEXT_VM + PAGE * 2n, PAGE, BigInt(linkeditOff), BigInt(linkeditSize), 1 /* r-- */, []);

  /* LC_LOAD_DYLINKER */
  {
    const size = align8(12 + dylinker.length + 1);
    w.u32(o, LC_LOAD_DYLINKER); w.u32(o + 4, size); w.u32(o + 8, 12);
    w.str(o + 12, dylinker, dylinker.length);
    o += size;
  }
  /* LC_UUID — 中身は固定（毎回同じファイルになるように） */
  {
    w.u32(o, LC_UUID); w.u32(o + 4, 24);
    const uuid = [0x48, 0x45, 0x58, 0x53, 0x41, 0x4d, 0x50, 0x4c, 0x45, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31];
    w.bytes(o + 8, uuid);
    o += 24;
  }
  /* LC_BUILD_VERSION: iOS 17.0, SDK 17.0 */
  {
    w.u32(o, LC_BUILD_VERSION); w.u32(o + 4, 24);
    w.u32(o + 8, 2);                    // platform: iOS
    w.u32(o + 12, (17 << 16));          // minos 17.0.0
    w.u32(o + 16, (17 << 16));          // sdk 17.0.0
    w.u32(o + 20, 0);                   // ntools
    o += 24;
  }
  /* LC_MAIN: entryoff はファイル先頭からの位置 */
  {
    w.u32(o, LC_MAIN); w.u32(o + 4, 24);
    w.u64(o + 8, text.label._main - TEXT_VM);
    w.u64(o + 16, 0n);                  // stacksize
    o += 24;
  }
  /* LC_FUNCTION_STARTS */
  {
    w.u32(o, LC_FUNCTION_STARTS); w.u32(o + 4, 16);
    w.u32(o + 8, funcStartsOff); w.u32(o + 12, funcStarts.length);
    o += 16;
  }
  /* LC_SYMTAB */
  {
    w.u32(o, LC_SYMTAB); w.u32(o + 4, 24);
    w.u32(o + 8, symtabOff); w.u32(o + 12, symbols.length);
    w.u32(o + 16, strtabOff); w.u32(o + 20, strtab.length);
    o += 24;
  }
  /* LC_DYSYMTAB */
  {
    w.u32(o, LC_DYSYMTAB); w.u32(o + 4, 80);
    w.u32(o + 8, 0); w.u32(o + 12, 0);                       // local
    w.u32(o + 16, 0); w.u32(o + 20, symbols.length - 1);     // 定義済み
    w.u32(o + 24, symbols.length - 1); w.u32(o + 28, 1);     // 未定義
    for (let i = 32; i < 56; i += 4) w.u32(o + i, 0);
    w.u32(o + 56, indirectOff); w.u32(o + 60, indirect.length);
    for (let i = 64; i < 80; i += 4) w.u32(o + i, 0);
    o += 80;
  }
  /* LC_LOAD_DYLIB */
  {
    const size = align8(24 + dylib.length + 1);
    w.u32(o, LC_LOAD_DYLIB); w.u32(o + 4, size);
    w.u32(o + 8, 24);                   // name offset
    w.u32(o + 12, 2);                   // timestamp
    w.u32(o + 16, 0x05f40000);          // current version
    w.u32(o + 20, 0x00010000);          // compatibility version
    w.str(o + 24, dylib, dylib.length);
    o += size;
  }

  /* ── 本体 ── */
  w.words(textOff, text.words);
  w.words(stubsOff, stub);
  w.bytes(cstringOff, cstringData);
  w.u64(gotOff, 0n);                    // __got: 起動時に dyld が埋める場所

  /* ── __LINKEDIT ── */
  w.bytes(funcStartsOff, funcStarts);
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    const p = symtabOff + i * 16;
    w.u32(p, strx[i]);
    w.u8(p + 4, s.type);
    w.u8(p + 5, s.sect);
    w.dv.setUint16(p + 6, 0, true);     // n_desc
    w.u64(p + 8, s.value);
  }
  for (let i = 0; i < indirect.length; i++) w.u32(indirectOff + i * 4, indirect[i]);
  w.bytes(strtabOff, strtab);

  return w.buf;
}

/** そのまま openFile() に渡せる File を作る。 */
export function makeSampleFile() {
  const bytes = buildSampleBinary();
  return new File([bytes], 'sample-arm64', { type: 'application/octet-stream' });
}

/** 学習コースから参照する、サンプルの中身の案内。 */
export const SAMPLE_GUIDE = {
  name: 'sample-arm64',
  functions: [
    ['_add', '引数 2 つを足して返すだけ。いちばん小さい関数です。スタックも使いません。'],
    ['_square', '受け取った値を掛け算して返します。mul 命令が見られます。'],
    ['_sum_to', '1 から n までを足すループ。cmp と b.gt、そして上に戻る b が見どころです。'],
    ['_greet', '文字列のアドレスを adrp + add で作り、外部の _puts をスタック経由で呼びます。'],
    ['_main', 'ローカル変数をスタックに置きながら、上の関数を順に呼びます。ここから読み始めるとよいです。'],
  ],
};
