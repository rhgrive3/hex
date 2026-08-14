/*
 * ARM64 の 4 バイト語を、Capstone を通さずに直接読む層。
 *
 * ここが「テキストを見て推測する」から「バイナリ上の事実を読む」への転換点。
 * 逆アセンブル結果の文字列を正規表現で見るのではなく、命令語のビットそのものから
 *
 *   - この命令は関数を呼んでいるか（そしてどこを）
 *   - この命令はメモリを読んでいるか、書いているか
 *   - この命令は掛け算をしているか
 *   - この命令はどのアドレスを組み立てているか
 *
 * を判定する。文字列より速く（逆アセンブルの数十倍）、しかも根拠が明確になる。
 *
 * このファイルは worker（classic worker / importScripts）からも
 * node のテスト（ESM）からも読める形にしてある。import も export も書かず、
 * グローバルへ 1 つだけ生やす（macho.js と同じやり方）。
 *
 * 大原則: 分からない命令は KIND.OTHER のままにする。無理に分類しない。
 */
(function (global) {
  'use strict';

  /* ── 命令の種類 ─────────────────────────────────────────────
     1 語 = 1 バイトで持てるように、値は 0〜255 に収める。
     「関数ごとに掛け算が何回あるか」のような統計を、
     セクション全体ぶん持ち歩くために使う。 */

  const KIND = {
    OTHER: 0,        // 分類できなかった（＝分からない。埋めない）
    NOP: 1,          // nop / hint / bti / pac …
    ADRP: 2,         // アドレスの土台づくり (adrp / adr)
    MOVIMM: 3,       // 定数をレジスタへ (mov #imm / movz / movk / movn)
    MOVREG: 4,       // レジスタ間のコピー
    ARITH: 5,        // 足し算・引き算
    MUL: 6,          // 掛け算（madd / mul / smull …）
    DIV: 7,          // 割り算
    LOGIC: 8,        // and / orr / eor
    SHIFT: 9,        // シフト・ビット操作
    FARITH: 10,      // 小数の足し引き
    FMUL: 11,        // 小数の掛け算・割り算
    FCONV: 12,       // 整数 ⇄ 小数の変換
    SIMD: 13,        // まとめて計算する命令
    LOAD: 14,        // メモリから読む
    STORE: 15,       // メモリへ書く
    CMP: 16,         // 比較
    CONDBR: 17,      // 条件つき分岐
    BRANCH: 18,      // 無条件分岐
    CALL: 19,        // 関数呼び出し（行き先が分かる）
    INDCALL: 20,     // 関数呼び出し（行き先はレジスタ＝実行時に決まる）
    RET: 21,         // 呼び出し元へ戻る
    CSEL: 22,        // 条件で値を選ぶ
    ATOMIC: 23,      // 排他アクセス
    SYS: 24,         // システム命令
    TRAP: 25,        // brk / udf（ここには来ないはず、の印）
    LITERAL: 26,     // ldr literal（すぐ近くの定数を読む）
  };

  const KIND_NAME = Object.keys(KIND);

  /* ── ビット操作 ──────────────────────────────────────────────
     JS の & は符号つき 32 ビットを返す。bit31 が立つ命令（bl / ret など）を
     素朴に比較するといつまでも一致しないので、必ずここを通す。 */

  function masked(w, mask) { return (w & mask) >>> 0; }

  function signExtend(value, bits) {
    const sign = 1n << BigInt(bits - 1);
    return (value & (sign - 1n)) - (value & sign);
  }

  const rd = (w) => w & 0x1f;
  const rn = (w) => (w >>> 5) & 0x1f;
  const rm = (w) => (w >>> 16) & 0x1f;

  /* ── 分岐 ───────────────────────────────────────────────── */

  /** b / bl の飛び先。違う命令なら null。 */
  function branchImm26(w, pc) {
    if (masked(w, 0x7c000000) !== 0x14000000) return null;
    return pc + (signExtend(BigInt(w >>> 0) & 0x3ffffffn, 26) << 2n);
  }

  function isCallImm(w) { return masked(w, 0xfc000000) === 0x94000000; }
  function isBranchImm(w) { return masked(w, 0xfc000000) === 0x14000000; }
  function isRet(w) { return masked(w, 0xfffffc1f) === 0xd65f0000; }
  function isBr(w) { return masked(w, 0xfffffc1f) === 0xd61f0000; }

  /** blr / blraa / blrab — 行き先が実行時に決まる呼び出し。 */
  function isIndirectCall(w) {
    if (masked(w, 0xfffffc1f) === 0xd63f0000) return true;         // blr
    if (masked(w, 0xfffff800) === 0xd63f0800) return true;         // blraaz / blrabz
    if (masked(w, 0xffe0f800) === 0xd73f0800) return true;         // blraa / blrab
    return false;
  }

  function isCondBranch(w) {
    if (masked(w, 0xff000010) === 0x54000000) return true;          // b.cond
    if (masked(w, 0x7e000000) === 0x34000000) return true;          // cbz / cbnz
    if (masked(w, 0x7e000000) === 0x36000000) return true;          // tbz / tbnz
    return false;
  }

  /** 条件つき分岐の飛び先。 */
  function condBranchTarget(w, pc) {
    const bw = BigInt(w >>> 0);
    if (masked(w, 0xff000010) === 0x54000000) return pc + (signExtend((bw >> 5n) & 0x7ffffn, 19) << 2n);
    if (masked(w, 0x7e000000) === 0x34000000) return pc + (signExtend((bw >> 5n) & 0x7ffffn, 19) << 2n);
    if (masked(w, 0x7e000000) === 0x36000000) return pc + (signExtend((bw >> 5n) & 0x3fffn, 14) << 2n);
    return null;
  }

  /** ldr (literal) — 手近に置かれた定数を読む形。 */
  function literalTarget(w, pc) {
    if (masked(w, 0x3b000000) !== 0x18000000) return null;
    return pc + (signExtend((BigInt(w >>> 0) >> 5n) & 0x7ffffn, 19) << 2n);
  }

  /** この語が「どこかのアドレスを指している」なら、その先。分からなければ null。 */
  function wordTarget(w, pc) {
    const b = branchImm26(w, pc);
    if (b !== null) return b;
    const c = condBranchTarget(w, pc);
    if (c !== null) return c;
    return literalTarget(w, pc);
  }

  /* ── アドレスの組み立て ─────────────────────────────────── */

  /** adr / adrp をほどく。{reg, value, page} か null。 */
  function pcRelTarget(w, pc) {
    if (masked(w, 0x1f000000) !== 0x10000000) return null;
    const bw = BigInt(w >>> 0);
    const immlo = (bw >> 29n) & 0x3n;
    const immhi = (bw >> 5n) & 0x7ffffn;
    const imm = signExtend((immhi << 2n) | immlo, 21);
    if (w & 0x80000000) return { reg: rd(w), value: (pc & ~0xfffn) + (imm << 12n), page: true };
    return { reg: rd(w), value: pc + imm, page: false };
  }

  /**
   * adrp の後ろに続いて、ページ内の位置を足す（あるいは読む）命令。
   *
   *   adrp x0, #page  →  add x0, x0, #off      … 場所そのもの
   *   adrp x8, #page  →  ldr x1, [x8, #off]    … その場所の中身
   *
   * 返すのは {rn, rd, imm, load}。組でないものは null。
   */
  function pairedOffset(w) {
    // ADD (immediate, 64-bit, shift 0)
    if (((w >>> 23) & 0x1ff) === 0x122 && !((w >>> 22) & 1)) {
      return { rn: rn(w), rd: rd(w), imm: BigInt((w >>> 10) & 0xfff), load: false };
    }
    // LDR/LDRB/LDRH/STR… (immediate, unsigned offset) — 倍率は転送サイズで決まる
    if (masked(w, 0x3b000000) === 0x39000000) {
      const scale = transferScale(w);
      const isLoad = transferIsLoad(w);
      return {
        rn: rn(w), rd: rd(w),
        imm: BigInt((w >>> 10) & 0xfff) << BigInt(scale),
        load: isLoad, store: !isLoad,
      };
    }
    return null;
  }

  /**
   * 転送 1 回ぶんの大きさ（2 の何乗バイトか）。
   *
   * SIMD/浮動小数の 128 ビット転送 (str q0) は size ビットだけでは分からず、
   * opc の上位ビットも見る必要がある。ここを間違えると、
   * adrp + ldr で組み立てるアドレスがずれて、まったく別の場所を指してしまう。
   */
  function transferScale(w) {
    const size = (w >>> 30) & 3;
    const vector = ((w >>> 26) & 1) === 1;
    const opcHigh = (w >>> 23) & 1;
    return vector && opcHigh ? size + 4 : size;
  }

  /**
   * その転送命令は読み出しか。
   *
   * 「bit 22 が 1 なら読み出し」は半分しか合っていない。整数の転送では
   * bit 23-22（opc）が 00 のときだけ書き込みで、01 / 10 / 11 はすべて読み出しになる。
   *
   *     ldrsw x8, [sp, #0xc]   … opc = 10 → 読み出し
   *
   * bit 22 だけを見ていると、これが**書き込みに見える**。符号つきの読み出しは
   * 配列の添字を取り出すところに山ほど出るので、ここを取り違えると
   * 「この関数はメモリに書いている」という説明が丸ごと逆になる。
   */
  function transferIsLoad(w) {
    if (((w >>> 26) & 1) === 1) return ((w >>> 22) & 1) === 1;   // SIMD は bit 22 のみ
    return ((w >>> 22) & 3) !== 0;
  }

  /* ── メモリアクセス ─────────────────────────────────────── */

  /**
   * メモリを触る命令か。触るなら {load, size, pair, base, reg, disp}。
   * disp は分かるときだけ（レジスタ添字つきなら null）。
   */
  function memoryAccess(w) {
    // 排他・acquire/release 系
    if (masked(w, 0x3f000000) === 0x08000000) {
      const load = ((w >>> 22) & 1) === 1;
      return { load, store: !load, size: 1 << ((w >>> 30) & 3), base: rn(w), reg: rd(w), disp: 0n, atomic: true };
    }
    // ペア (ldp / stp / ldnp / stnp) — 添字なし、7 ビットの符号つき
    if (masked(w, 0x3a000000) === 0x28000000) {
      const load = ((w >>> 22) & 1) === 1;
      const opc = (w >>> 30) & 3;
      const vector = ((w >>> 26) & 1) === 1;
      // 整数は 32/64 ビット、SIMD は 32/64/128 ビットの組
      const scale = vector ? (4 << opc) : (opc === 0 ? 4 : 8);
      const imm7 = Number(signExtend(BigInt((w >>> 15) & 0x7f), 7));
      return {
        load, store: !load, size: scale * 2, pair: true,
        base: rn(w), reg: rd(w), disp: BigInt(imm7 * scale),
      };
    }
    // 符号なし即値つき (いちばん多い形)
    if (masked(w, 0x3b000000) === 0x39000000) {
      const scale = transferScale(w);
      const load = transferIsLoad(w);
      return {
        load, store: !load, size: 1 << scale, base: rn(w), reg: rd(w),
        disp: BigInt((w >>> 10) & 0xfff) << BigInt(scale),
      };
    }
    // 前後変化つき / 符号つき即値（こちらは倍率なしの生バイト数）
    if (masked(w, 0x3b200000) === 0x38000000) {
      const load = transferIsLoad(w);
      const kind = (w >>> 10) & 3;                            // 00 unscaled, 01 post, 11 pre
      const imm9 = Number(signExtend(BigInt((w >>> 12) & 0x1ff), 9));
      return {
        load, store: !load, size: 1 << transferScale(w), base: rn(w), reg: rd(w),
        disp: BigInt(imm9), mode: kind === 1 ? 'post' : kind === 3 ? 'pre' : 'offset',
      };
    }
    if (masked(w, 0x3b200c00) === 0x38200800) {
      const load = transferIsLoad(w);
      return {
        load, store: !load, size: 1 << transferScale(w),
        base: rn(w), reg: rd(w), disp: null, indexed: true,
      };
    }
    return null;
  }

  /* ── 計算 ───────────────────────────────────────────────── */

  function isAddSubImm(w) { return masked(w, 0x1f000000) === 0x11000000; }
  function isAddSubShifted(w) { return masked(w, 0x1f200000) === 0x0b000000; }
  function isAddSubExtended(w) { return masked(w, 0x1f200000) === 0x0b200000; }
  function isLogicImm(w) { return masked(w, 0x1f800000) === 0x12000000; }
  function isLogicShifted(w) { return masked(w, 0x1f000000) === 0x0a000000; }
  function isMoveWide(w) { return masked(w, 0x1f800000) === 0x12800000; }
  function isBitfield(w) { return masked(w, 0x1f800000) === 0x13000000; }
  function isDp3(w) { return masked(w, 0x1f000000) === 0x1b000000; }      // madd / msub / smull …
  function isDp2(w) { return masked(w, 0x5fe00000) === 0x1ac00000; }      // udiv / sdiv / lslv …
  function isCondSelect(w) { return masked(w, 0x1fe00000) === 0x1a800000; }
  function isCondCompare(w) { return masked(w, 0x1fe00000) === 0x1a400000; }
  function isFpDp2(w) { return masked(w, 0x5f200c00) === 0x1e200800; }
  function isFpDp3(w) { return masked(w, 0x5f200000) === 0x1f000000; }
  function isFpDp1(w) { return masked(w, 0x5f207c00) === 0x1e204000; }
  function isFpCompare(w) { return masked(w, 0x5f203c00) === 0x1e202000; }
  function isFpToInt(w) { return masked(w, 0x5f20fc00) === 0x1e200000; }
  function isFpImm(w) { return masked(w, 0x5f201c00) === 0x1e201000; }

  /** cmp / cmn / tst — 「比較して、そのあと分岐する」形。 */
  function isCompare(w) {
    if (isAddSubImm(w) && ((w >>> 29) & 1) === 1 && rd(w) === 31) return true;      // cmp/cmn imm
    if (isAddSubShifted(w) && ((w >>> 29) & 1) === 1 && rd(w) === 31) return true;  // cmp/cmn reg
    if (isAddSubExtended(w) && ((w >>> 29) & 1) === 1 && rd(w) === 31) return true;
    if (isLogicShifted(w) && ((w >>> 29) & 3) === 3 && rd(w) === 31) return true;   // tst
    if (isLogicImm(w) && ((w >>> 29) & 3) === 3 && rd(w) === 31) return true;
    if (isCondCompare(w)) return true;                                             // ccmp / ccmn
    if (isFpCompare(w)) return true;                                               // fcmp
    return false;
  }

  /** cmp xN, #imm の即値。比較でなければ null。 */
  function compareImmediate(w) {
    if (!isAddSubImm(w) || ((w >>> 29) & 1) !== 1 || rd(w) !== 31) return null;
    const shift = ((w >>> 22) & 1) ? 12n : 0n;
    return BigInt((w >>> 10) & 0xfff) << shift;
  }

  /** mul / madd / msub。掛け算は「値の計算」を示す強い手がかり。 */
  function isMultiply(w) {
    if (!isDp3(w)) return false;
    const op31 = (w >>> 21) & 7;
    // 000 = madd/msub, 001/010 = smaddl/smsubl, 101/110 = umaddl/umsubl,
    // 011 = smulh, 111 = umulh
    return op31 === 0 || op31 === 1 || op31 === 2 || op31 === 3 ||
           op31 === 5 || op31 === 6 || op31 === 7;
  }

  function isDivide(w) {
    if (!isDp2(w)) return false;
    const opcode = (w >>> 10) & 0x3f;
    return opcode === 2 || opcode === 3;     // udiv / sdiv
  }

  function isShiftOp(w) {
    if (isBitfield(w)) return true;
    if (!isDp2(w)) return false;
    const opcode = (w >>> 10) & 0x3f;
    return opcode >= 8 && opcode <= 11;      // lslv / lsrv / asrv / rorv
  }

  /** 小数の掛け算・割り算（ダメージ計算などで出やすい）。 */
  function isFpMulDiv(w) {
    if (!isFpDp2(w)) return isFpDp3(w);      // fmadd / fmsub もここに入れる
    const opcode = (w >>> 12) & 0xf;
    return opcode === 0 || opcode === 1 || opcode === 8;   // fmul / fdiv / fnmul
  }

  function isFpAddSub(w) {
    if (!isFpDp2(w)) return false;
    const opcode = (w >>> 12) & 0xf;
    return opcode === 2 || opcode === 3 || opcode === 4 || opcode === 5;  // fadd/fsub/fmax/fmin
  }

  function isSimd(w) {
    if (masked(w, 0x9f000000) === 0x0e000000) return true;   // advanced SIMD (3 same など)
    if (masked(w, 0x9f000000) === 0x0f000000) return true;
    if (masked(w, 0xbf000000) === 0x0c000000) return true;   // SIMD の load/store multiple
    if (masked(w, 0xbf000000) === 0x0d000000) return true;
    return false;
  }

  function isNop(w) {
    if (w === 0xd503201f) return true;                       // nop
    if (masked(w, 0xffffff1f) === 0xd503241f) return true;   // bti
    if (masked(w, 0xfffff01f) === 0xd503201f) return true;   // hint 全般
    if (w === 0xd503233f || w === 0xd503237f) return true;   // paciasp / pacibsp
    if (w === 0xd50323bf || w === 0xd50323ff) return true;   // autiasp / autibsp
    return false;
  }

  /** brk / udf — 「ここには来ないはず」の印。0 埋めは命令ではないので除く。 */
  function isTrap(w) {
    if (masked(w, 0xffe0001f) === 0xd4200000) return true;          // brk #imm
    if (masked(w, 0xffff0000) === 0x00000000 && w !== 0) return true; // udf #imm
    return false;
  }

  function isSystem(w) { return masked(w, 0xffc00000) === 0xd5000000; }

  /**
   * 語 1 つを分類する。分からなければ KIND.OTHER。
   *
   * 判定の順番には意味がある。比較 (cmp) は足し算 (subs) の一種なので先に見る、
   * のように「より具体的なもの」から確かめていく。
   */
  function classifyWord(w) {
    if (w === 0) return KIND.OTHER;                    // 埋め草。命令として数えない
    if (isNop(w)) return KIND.NOP;
    if (isTrap(w)) return KIND.TRAP;

    if (isCallImm(w)) return KIND.CALL;
    if (isIndirectCall(w)) return KIND.INDCALL;
    if (isRet(w)) return KIND.RET;
    if (isBranchImm(w) || isBr(w)) return KIND.BRANCH;
    if (isCondBranch(w)) return KIND.CONDBR;

    if (masked(w, 0x1f000000) === 0x10000000) return KIND.ADRP;
    if (masked(w, 0x3b000000) === 0x18000000) return KIND.LITERAL;

    if (isCompare(w)) return KIND.CMP;

    const mem = memoryAccess(w);
    if (mem) {
      if (mem.atomic) return KIND.ATOMIC;
      return mem.load ? KIND.LOAD : KIND.STORE;
    }

    if (isMultiply(w)) return KIND.MUL;
    if (isDivide(w)) return KIND.DIV;
    if (isFpMulDiv(w)) return KIND.FMUL;
    if (isFpAddSub(w)) return KIND.FARITH;
    if (isFpToInt(w)) return KIND.FCONV;
    if (isFpDp1(w)) {
      /* FP one-source shares one encoding family. fabs/fneg/fsqrt are
         arithmetic; fcvt and the remaining conversion forms are conversions. */
      const op = (w >>> 15) & 0x3f;
      if (op === 1 || op === 2 || op === 3) return KIND.FARITH;
      return KIND.FCONV;
    }
    if (isFpImm(w)) return KIND.MOVIMM;
    if (isCondSelect(w)) return KIND.CSEL;
    if (isMoveWide(w)) return KIND.MOVIMM;
    if (isShiftOp(w)) return KIND.SHIFT;

    if (isAddSubImm(w) || isAddSubShifted(w) || isAddSubExtended(w)) {
      /* orr xD, xzr, xM は mov の別名。add xD, xN, #0 も実質コピー。
         ただし S ビットが立っていれば（adds / subs）旗を立てる計算なので、
         コピーとは呼べない — `subs x8, x8, #0` は実際には比較として使われる。 */
      if (isAddSubImm(w) && ((w >>> 10) & 0xfff) === 0 && !((w >>> 29) & 1) &&
          (rn(w) === 31 || rd(w) === 31)) return KIND.MOVREG;
      return KIND.ARITH;
    }
    if (isLogicShifted(w)) {
      if (((w >>> 29) & 3) === 1 && rn(w) === 31 && ((w >>> 21) & 1) === 0 &&
          ((w >>> 22) & 3) === 0 && ((w >>> 10) & 0x3f) === 0) return KIND.MOVREG; // mov = orr xD,xzr,xM
      return KIND.LOGIC;
    }
    if (isLogicImm(w)) return KIND.LOGIC;
    if (isBitfield(w)) return KIND.SHIFT;
    if (isSimd(w)) return KIND.SIMD;
    if (isSystem(w)) return KIND.SYS;
    return KIND.OTHER;
  }

  /**
   * 詳しく読む版。UI から 1 命令だけ調べるときや、テストで使う。
   *
   * @param {number} w  4 バイトの語（リトルエンディアンで読んだもの）
   * @param {BigInt} pc その命令のアドレス
   */
  function decodeWord(w, pc) {
    const kind = classifyWord(w);
    const out = {
      kind,
      kindName: KIND_NAME[kind] || 'OTHER',
      target: null,       // 分岐・呼び出しの飛び先
      pcRel: null,        // adrp / adr が作るアドレス
      memory: null,       // メモリアクセスの詳細
      compareWith: null,  // cmp の相手が定数ならその値
      rd: rd(w), rn: rn(w), rm: rm(w),
    };
    if (kind === KIND.CALL || kind === KIND.BRANCH) out.target = branchImm26(w, pc);
    else if (kind === KIND.CONDBR) out.target = condBranchTarget(w, pc);
    else if (kind === KIND.LITERAL) out.target = literalTarget(w, pc);
    if (kind === KIND.ADRP) out.pcRel = pcRelTarget(w, pc);
    if (kind === KIND.LOAD || kind === KIND.STORE || kind === KIND.ATOMIC) out.memory = memoryAccess(w);
    if (kind === KIND.CMP) out.compareWith = compareImmediate(w);
    return out;
  }

  /* ── 関数の切れ目の手がかり ─────────────────────────────── */

  /** stp xN, xM, [sp, …] — スタックへの 2 本組の書き込み。プロローグの目印。 */
  /*
   * stp xN, xM, [sp, …] — 関数の入口でレジスタを退避する形。
   *
   * bit 25 を見落とすと `mov x20, x0`（orr x20, xzr, x0）まで当てはまってしまう。
   * これは例外処理の合流点によく出る命令なので、関数の先頭を推測するときに
   * 2 万か所以上の嘘の「関数の始まり」を生んでいた。
   */
  function isStpToSp(w) {
    return ((w >>> 30) & 3) === 2 &&        // 64 ビットの組
           ((w >>> 27) & 7) === 5 &&        // 組の読み書き
           ((w >>> 26) & 1) === 0 &&        // 整数（SIMD ではない）
           ((w >>> 25) & 1) === 0 &&        // ここが 1 なら別の命令
           ((w >>> 22) & 1) === 0 &&        // 書き込み
           rn(w) === 31;                    // 土台が sp
  }

  /** sub sp, sp, #imm — スタックの確保。 */
  function isSubSp(w) {
    return ((w >>> 23) & 0x1ff) === 0x1a2 && rn(w) === 31 && rd(w) === 31;
  }

  function looksLikePrologue(w) {
    return isStpToSp(w) || isSubSp(w) ||
           masked(w, 0xffffff1f) === 0xd503241f ||     // bti
           w === 0xd503233f || w === 0xd503237f;        // paciasp / pacibsp
  }

  /** 関数の終わりになりうる語（ret / 無条件 b）。 */
  function looksLikeEnd(w) {
    return isRet(w) || masked(w, 0xfc000000) === 0x14000000;
  }

  global.Words = {
    KIND, KIND_NAME,
    masked, signExtend,
    branchImm26, condBranchTarget, literalTarget, wordTarget, pcRelTarget, pairedOffset,
    memoryAccess, compareImmediate,
    isCallImm, isBranchImm, isCondBranch, isIndirectCall, isRet, isBr,
    isCompare, isMultiply, isDivide, isShiftOp, isFpMulDiv, isFpAddSub, isSimd, isMoveWide,
    isNop,
    isStpToSp, isSubSp, looksLikePrologue, looksLikeEnd,
    classifyWord, decodeWord,
  };
})(typeof self !== 'undefined' ? self : globalThis);
