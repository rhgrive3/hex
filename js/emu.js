/*
 * 実行してみる（エミュレータ / デバッガ）。
 *
 * 読むだけでは分からないことがあります。「この関数に 100 を渡したら何が返るのか」
 * 「この分岐はどちらへ行くのか」——それは動かしてみるのが早い。
 *
 * ここは ARM64 の命令を **このブラウザの中だけで** 1 命令ずつ実行する仕組みです。
 * 実機に接続するデバッガではありません（アプリを起動したりはしません）。
 * その代わり、危険なことは何も起きず、どこでも止められて、
 * レジスタもメモリも自由に覗けます。IDA でいうトレース実行に近いものです。
 *
 * できること:
 *   - 1 命令ずつ進む（ステップ実行）
 *   - ブレークポイントを置いて、そこまで一気に走らせる
 *   - レジスタ x0〜x30 / sp / pc / フラグ を見る・書き換える
 *   - メモリを読む（ファイルの中身がそのまま見える）・書き換える
 *   - 呼び出しの積み重なり（コールスタック）を見る
 *
 * できないこと（正直に）:
 *   - システムコール（svc）と、実機の OS が用意する値
 *   - 小数・SIMD 命令のほとんど
 *   - 外部ライブラリの中身（_malloc などは「それらしい値」を返す真似だけ）
 * 対応していない命令に出会ったら、黙って進まずにそこで止まります。
 */

import { parseOperands } from './arm64.js';

const MASK64 = (1n << 64n) - 1n;
const MASK32 = 0xFFFFFFFFn;
const PAGE = 4096;

/* 練習用のスタック。実機のアドレスとは関係のない、このエミュレータ専用の場所。 */
export const STACK_TOP = 0x0000700000000000n;
const STACK_SIZE = 1 << 20;          // 1 MiB

/* 外部関数を呼んだときに「それらしく」振る舞わせるもの。 */
const HEAP_BASE = 0x0000600000000000n;

export class Emulator {
  /**
   * @param {object} io
   *   read(addr, len) → Promise<Uint8Array|null>   ファイルの中身を読む
   *   fetch(addr)     → Promise<{mn, ops}|null>    その場所の命令
   *   symbolFor(addr) → 名前 | null
   */
  constructor(io) {
    this.io = io || {};
    this.reset();
  }

  reset() {
    this.x = new Array(31).fill(0n);       // x0〜x30
    this.sp = STACK_TOP;
    this.pc = 0n;
    this.nzcv = { n: false, z: false, c: false, v: false };
    this.v = new Array(32).fill(0);        // 小数/SIMD はJS Numberとして保持
    this.exclusive = null;                  // ARM64 local exclusive monitor
    this.mem = new Map();                  // ページ番号 → Uint8Array（書き換えた分）
    this.loaded = new Map();               // ページ番号 → Uint8Array（ファイルから読んだ分）
    this.steps = 0;
    this.stopped = null;                   // 止まった理由
    this.callStack = [];
    this.trace = [];                       // 通った道（最大 TRACE_MAX）
    this.heap = HEAP_BASE;
    this.log = [];
    this.breakpoints = new Set();
  }

  /* ── レジスタ ─────────────────────────────────────────── */

  get(reg) {
    if (reg === 'sp') return this.sp;
    if (reg === 'pc') return this.pc;
    if (/^[xw]zr$/.test(reg)) return 0n;
    const m = /^([xw])(\d+)$/.exec(reg);
    if (!m) return 0n;
    const n = Number(m[2]);
    if (n === 31) return 0n;
    const v = this.x[n] || 0n;
    return m[1] === 'w' ? v & MASK32 : v;
  }

  set(reg, value) {
    const v = BigInt.asUintN(64, value);
    if (reg === 'sp') { this.sp = v; return; }
    if (/^[xw]zr$/.test(reg)) return;
    const m = /^([xw])(\d+)$/.exec(reg);
    if (!m) return;
    const n = Number(m[2]);
    if (n === 31) return;
    // w レジスタへ書くと、上の 32 ビットは 0 になる（ARM64 の決まり）
    this.x[n] = m[1] === 'w' ? (v & MASK32) : v;
  }

  /* ── メモリ ───────────────────────────────────────────── */

  /** そのアドレスのページを手元に用意する。 */
  async ensure(addr) {
    const page = (addr / BigInt(PAGE)) * BigInt(PAGE);
    const key = page.toString();
    if (this.mem.has(key) || this.loaded.has(key)) return;
    if (page >= STACK_TOP - BigInt(STACK_SIZE) && page < STACK_TOP + BigInt(PAGE)) {
      this.loaded.set(key, new Uint8Array(PAGE));      // スタックは 0 で初期化
      return;
    }
    if (page >= HEAP_BASE && page < HEAP_BASE + 0x100000n) {
      this.loaded.set(key, new Uint8Array(PAGE));
      return;
    }
    let bytes = null;
    try { bytes = this.io.read ? await this.io.read(page, PAGE) : null; } catch { bytes = null; }
    this.loaded.set(key, bytes && bytes.length ? padTo(bytes, PAGE) : new Uint8Array(PAGE));
  }

  byteAt(addr) {
    const page = (addr / BigInt(PAGE)) * BigInt(PAGE);
    const key = page.toString();
    const off = Number(addr - page);
    const w = this.mem.get(key);
    if (w && w.mask[off]) return w.data[off];
    const l = this.loaded.get(key);
    return l ? l[off] : 0;
  }

  writeByte(addr, value) {
    const page = (addr / BigInt(PAGE)) * BigInt(PAGE);
    const key = page.toString();
    let w = this.mem.get(key);
    if (!w) { w = { data: new Uint8Array(PAGE), mask: new Uint8Array(PAGE) }; this.mem.set(key, w); }
    const off = Number(addr - page);
    w.data[off] = value & 0xff;
    w.mask[off] = 1;
  }

  async load(addr, size) {
    await this.ensure(addr);
    if (Number((addr + BigInt(size - 1)) / BigInt(PAGE)) !== Number(addr / BigInt(PAGE))) {
      await this.ensure(addr + BigInt(size - 1));
    }
    let v = 0n;
    for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.byteAt(addr + BigInt(i)));
    return v;
  }

  async store(addr, size, value) {
    if (this.exclusive) {
      const a0=BigInt(addr), a1=a0+BigInt(size), e0=this.exclusive.addr, e1=e0+BigInt(this.exclusive.size);
      if (!(a1 <= e0 || e1 <= a0)) this.exclusive = null;
    }
    await this.ensure(addr);
    if (Number((addr + BigInt(size - 1)) / BigInt(PAGE)) !== Number(addr / BigInt(PAGE))) {
      await this.ensure(addr + BigInt(size - 1));
    }
    let v = BigInt.asUintN(64, value);
    for (let i = 0; i < size; i++) { this.writeByte(addr + BigInt(i), Number(v & 0xffn)); v >>= 8n; }
  }

  /** 画面に見せる用: そのアドレスから len バイト。 */
  async dump(addr, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += PAGE) await this.ensure(addr + BigInt(i));
    await this.ensure(addr + BigInt(Math.max(0, len - 1)));
    for (let i = 0; i < len; i++) out[i] = this.byteAt(addr + BigInt(i));
    return out;
  }

  /* ── 実行 ─────────────────────────────────────────────── */

  /** 関数を呼ぶ形に整える。引数は x0〜x7 に入れる。 */
  setup(addr, args) {
    this.pc = addr;
    this.sp = STACK_TOP - 0x400n;
    this.x[30] = 0n;                       // 戻り先 0 = ここまで来たら終わり
    (args || []).forEach((a, i) => { if (i <= 7) this.x[i] = BigInt.asUintN(64, BigInt(a)); });
    this.stopped = null;
    this.callStack = [{ addr, ret: 0n }];
  }

  /**
   * 1 命令進める。
   * @returns {Promise<{ok:boolean, text:string, reason:string|null}>}
   */
  async step() {
    if (this.stopped) return { ok: false, text: '', reason: this.stopped };
    const at = this.pc;
    const insn = this.io.fetch ? await this.io.fetch(at) : null;
    if (!insn || !insn.mn) {
      this.stopped = '0x' + at.toString(16).toUpperCase() + ' の命令が読めませんでした。';
      return { ok: false, text: '', reason: this.stopped };
    }
    const text = (insn.mn + ' ' + (insn.ops || '')).trim();
    if (this.trace.length < 4000) this.trace.push({ addr: at, text });
    this.steps++;

    let next = at + 4n;
    try {
      const jumped = await this.execute(insn.mn.toLowerCase(), insn.ops || '', at);
      if (jumped != null) next = jumped;
    } catch (err) {
      this.stopped = (err && err.message) || String(err);
      return { ok: false, text, reason: this.stopped };
    }
    this.pc = next;
    if (this.pc === 0n) this.stopped = '最初の呼び出し元まで戻ってきました（実行おわり）。';
    return { ok: !this.stopped, text, reason: this.stopped };
  }

  /**
   * ブレークポイントか上限まで走らせる。
   * @param {number} maxSteps
   */
  async run(maxSteps = 20000, onProgress) {
    let n = 0;
    while (n < maxSteps && !this.stopped) {
      const r = await this.step();
      n++;
      if (!r.ok) break;
      if (this.breakpoints.has(this.pc.toString())) {
        this.stopped = null;
        return { hitBreakpoint: true, steps: n };
      }
      if (onProgress && (n % 500) === 0) { onProgress(n); await new Promise((res) => setTimeout(res, 0)); }
    }
    if (n >= maxSteps && !this.stopped) this.stopped = maxSteps.toLocaleString() + ' 命令ぶん進んだので、いったん止めました。';
    return { hitBreakpoint: false, steps: n };
  }

  /* ── 命令ごとの動き ───────────────────────────────────── */

  async execute(mn, opsStr, at) {
    const ops = parseOperands(opsStr);
    const R = (op) => this.valueOf(op);

    /* 何もしない命令 */
    if (/^(nop|hint|bti|paciasp|pacibsp|autiasp|autibsp|xpaclri|dmb|dsb|isb|prfm|pacia|autia|pacibz)$/.test(mn)) return null;

    /* 分岐 */
    if (mn === 'b') return this.branchTarget(ops);
    if (/^b\.(\w+)$/.test(mn)) {
      const cc = /^b\.(\w+)$/.exec(mn)[1];
      return this.cond(cc) ? this.branchTarget(ops) : null;
    }
    if (mn === 'cbz' || mn === 'cbnz') {
      const v = R(ops[0]);
      const zero = v === 0n;
      return (mn === 'cbz' ? zero : !zero) ? this.branchTarget(ops) : null;
    }
    if (mn === 'tbz' || mn === 'tbnz') {
      const v = R(ops[0]);
      const bit = ops[1] && ops[1].value != null ? ops[1].value : 0n;
      const set = ((v >> bit) & 1n) === 1n;
      return (mn === 'tbnz' ? set : !set) ? this.branchTarget(ops) : null;
    }
    if (mn === 'bl' || mn === 'blr') {
      const target = mn === 'bl' ? this.branchTarget(ops) : R(ops[0]);
      this.x[30] = at + 4n;
      if (target == null) throw new Error('呼び出し先が分かりませんでした。');
      const hooked = await this.hookedCall(target);
      if (hooked) return at + 4n;
      if (!this.mapped(target)) return this.externalReturn(at, target);
      this.callStack.push({ addr: target, ret: at + 4n });
      if (this.callStack.length > 256) throw new Error('呼び出しが深くなりすぎました（無限に呼び合っている可能性）。');
      return target;
    }
    if (mn === 'br') {
      const target = R(ops[0]);
      if (!this.mapped(target)) return this.externalReturn(at, target);
      return target;
    }
    if (/^(ret|retaa|retab)$/.test(mn)) {
      const target = ops.length ? R(ops[0]) : this.x[30];
      this.callStack.pop();
      return target;
    }

    /* アドレス */
    if (mn === 'adrp' || mn === 'adr') {
      const t = ops[1] && ops[1].value != null ? ops[1].value : 0n;
      this.set(ops[0].text, t);
      return null;
    }

    /* 代入 */
    if (mn === 'mov' || mn === 'movz') { this.set(ops[0].text, R(ops[1])); return null; }
    if (mn === 'movn') { this.set(ops[0].text, ~R(ops[1])); return null; }
    if (mn === 'movk') {
      const cur = this.get(ops[0].text);
      const sh = BigInt(ops[1] && ops[1].shift && ops[1].shift.amount ? ops[1].shift.amount : 0);
      const imm = (ops[1].value || 0n) & 0xffffn;
      this.set(ops[0].text, (cur & ~(0xffffn << sh)) | (imm << sh));
      return null;
    }

    /* 計算 */
    const arith = {
      add: (a, b) => a + b, adds: (a, b) => a + b,
      sub: (a, b) => a - b, subs: (a, b) => a - b,
      and: (a, b) => a & b, ands: (a, b) => a & b,
      orr: (a, b) => a | b, orn: (a, b) => a | ~b,
      eor: (a, b) => a ^ b, eon: (a, b) => a ^ ~b,
      bic: (a, b) => a & ~b, bics: (a, b) => a & ~b,
      mul: (a, b) => a * b,
      lsl: (a, b) => a << (b & 63n), lsr: null, asr: null, ror: null,
      udiv: null, sdiv: null,
      smull: null, umull: null,
    };
    if (Object.prototype.hasOwnProperty.call(arith, mn)) {
      const wide = isWide(ops[0]);
      const a = R(ops[1]);
      const b = R(ops[2]);
      let r;
      if (mn === 'lsr') r = (wide ? a : a & MASK32) >> (b & 63n);
      else if (mn === 'asr') r = BigInt.asIntN(wide ? 64 : 32, a) >> (b & 63n);
      else if (mn === 'ror') { const w = wide ? 64n : 32n; const s = b % w; r = (a >> s) | (a << (w - s)); }
      else if (mn === 'udiv') r = b === 0n ? 0n : a / b;
      else if (mn === 'sdiv') {
        const sa = BigInt.asIntN(wide ? 64 : 32, a), sb = BigInt.asIntN(wide ? 64 : 32, b);
        r = sb === 0n ? 0n : sa / sb;
      } else if (mn === 'smull') r = BigInt.asIntN(32, a) * BigInt.asIntN(32, b);
      else if (mn === 'umull') r = (a & MASK32) * (b & MASK32);
      else r = arith[mn](a, b);
      const out = wide ? BigInt.asUintN(64, r) : BigInt.asUintN(32, r);
      this.set(ops[0].text, out);
      if (/s$/.test(mn) && mn !== 'bics') this.setFlags(mn, a, b, out, wide);
      if (mn === 'bics' || mn === 'ands') this.setLogicFlags(out, wide);
      return null;
    }
    if (mn === 'cmp' || mn === 'cmn' || mn === 'tst') {
      const wide = isWide(ops[0]);
      const a = R(ops[0]);
      const b = R(ops[1]);
      if (mn === 'tst') this.setLogicFlags(BigInt.asUintN(wide ? 64 : 32, a & b), wide);
      else this.setFlags(mn === 'cmp' ? 'subs' : 'adds', a, b,
        BigInt.asUintN(wide ? 64 : 32, mn === 'cmp' ? a - b : a + b), wide);
      return null;
    }
    if (mn === 'neg' || mn === 'negs') { this.set(ops[0].text, -R(ops[1])); return null; }
    if (mn === 'mvn') { this.set(ops[0].text, ~R(ops[1])); return null; }
    if (mn === 'madd' || mn === 'msub') {
      const a = R(ops[1]), b = R(ops[2]), c = R(ops[3]);
      this.set(ops[0].text, mn === 'madd' ? c + a * b : c - a * b);
      return null;
    }
    if (/^(sxtb|sxth|sxtw|uxtb|uxth|uxtw)$/.test(mn)) {
      const bits = { b: 8, h: 16, w: 32 }[mn[3]];
      const v = R(ops[1]);
      this.set(ops[0].text, mn[0] === 's' ? BigInt.asUintN(64, BigInt.asIntN(bits, v)) : BigInt.asUintN(64, v & ((1n << BigInt(bits)) - 1n)));
      return null;
    }
    if (/^(csel|csinc|csinv|csneg|cset|csetm|cinc|cinv|cneg)$/.test(mn)) return this.conditionalSelect(mn, ops);

    /* 条件つきの比較（ccmp）。条件が成り立てば比較し、外れたら決め打ちのフラグを置く */
    if (mn === 'ccmp' || mn === 'ccmn') {
      const ccOp = ops[ops.length - 1];
      const cc = ccOp && ccOp.k === 'cond' ? ccOp.text : 'al';
      if (this.cond(cc)) {
        const wide = isWide(ops[0]);
        const a = R(ops[0]), b = R(ops[1]);
        this.setFlags(mn === 'ccmp' ? 'subs' : 'adds', a, b,
          BigInt.asUintN(wide ? 64 : 32, mn === 'ccmp' ? a - b : a + b), wide);
      } else {
        const f = ops[2] && ops[2].value != null ? Number(ops[2].value) : 0;
        this.nzcv = { n: !!(f & 8), z: !!(f & 4), c: !!(f & 2), v: !!(f & 1) };
      }
      return null;
    }

    /* 長い掛け算 */
    if (/^(smaddl|umaddl|smsubl|umsubl)$/.test(mn)) {
      const a = mn[0] === 's' ? BigInt.asIntN(32, R(ops[1])) : (R(ops[1]) & MASK32);
      const b = mn[0] === 's' ? BigInt.asIntN(32, R(ops[2])) : (R(ops[2]) & MASK32);
      const c = R(ops[3]);
      this.set(ops[0].text, /sub/.test(mn) ? c - a * b : c + a * b);
      return null;
    }
    if (mn === 'smulh' || mn === 'umulh') {
      const a = mn === 'smulh' ? BigInt.asIntN(64, R(ops[1])) : R(ops[1]);
      const b = mn === 'smulh' ? BigInt.asIntN(64, R(ops[2])) : R(ops[2]);
      this.set(ops[0].text, (a * b) >> 64n);
      return null;
    }

    /* ビットの取り出し・差し込み */
    if (/^(ubfx|sbfx|ubfiz|sbfiz|bfi|bfxil|lsl|lsr)$/.test(mn) && ops.length >= 4) {
      const src = R(ops[1]);
      const lsb = BigInt(ops[2].value || 0n);
      const width = BigInt(ops[3].value || 1n);
      const mask = (1n << width) - 1n;
      const wide = isWide(ops[0]);
      let r;
      if (mn === 'ubfx') r = (src >> lsb) & mask;
      else if (mn === 'sbfx') r = BigInt.asUintN(64, BigInt.asIntN(Number(width), (src >> lsb) & mask));
      else if (mn === 'ubfiz') r = (src & mask) << lsb;
      else if (mn === 'sbfiz') r = BigInt.asUintN(wide ? 64 : 32, BigInt.asIntN(Number(lsb + width), (src & mask) << lsb));
      else if (mn === 'bfi') r = (this.get(ops[0].text) & ~(mask << lsb)) | ((src & mask) << lsb);
      else r = (this.get(ops[0].text) & ~mask) | ((src >> lsb) & mask);
      this.set(ops[0].text, wide ? r : r & MASK32);
      return null;
    }

    /* 数え上げ・並べ替え */
    if (mn === 'clz' || mn === 'rbit' || /^rev/.test(mn)) {
      const wide = isWide(ops[0]);
      const bits = wide ? 64 : 32;
      const v = BigInt.asUintN(bits, R(ops[1]));
      let r = 0n;
      if (mn === 'clz') { let n = 0n; for (let i = BigInt(bits) - 1n; i >= 0n; i--) { if ((v >> i) & 1n) break; n++; } r = n; }
      else if (mn === 'rbit') { for (let i = 0n; i < BigInt(bits); i++) if ((v >> i) & 1n) r |= 1n << (BigInt(bits) - 1n - i); }
      else {
        const n = bits / 8;
        const elementBytes = mn === 'rev16' ? 2 : mn === 'rev32' ? 4 : n;
        for (let base = 0; base < n; base += elementBytes) {
          for (let i = 0; i < elementBytes; i++) {
            r |= ((v >> BigInt((base + i) * 8)) & 0xffn) << BigInt((base + elementBytes - 1 - i) * 8);
          }
        }
      }
      this.set(ops[0].text, r);
      return null;
    }

    /* 小数（下位 64 ビットぶんだけ、JS の数として扱う） */
    if (/^f/.test(mn) || /^[su]cvtf$/.test(mn)) return this.floatInsn(mn, ops);

    /* メモリ */
    if (/^(ldr|ldrb|ldrh|ldrsb|ldrsh|ldrsw|ldur|ldurb|ldurh|ldursb|ldursh|ldursw|ldp|ldnp|ldxr|ldaxr|ldar)/.test(mn)) {
      return this.loadInsn(mn, ops);
    }
    if (/^(str|strb|strh|stur|sturb|sturh|stp|stnp|stxr|stlxr|stlr)/.test(mn)) {
      return this.storeInsn(mn, ops);
    }

    /* まだ動かせない命令。黙って進むと嘘になるので、必ず止める */
    throw new Error('この命令はまだ実行できません: ' + mn + ' ' + opsStr);
  }

  /** その番地に命令があるか（このファイルの中か）。 */
  mapped(addr) {
    if (addr == null) return false;
    if (!this.io.isExecutable) return true;
    return !!this.io.isExecutable(addr);
  }

  /**
   * このファイルの外（システムのライブラリ）へ出てしまったときの扱い。
   *
   * iOS アプリの実行ファイルには、UIKit や libSystem の中身は入っていません。
   * 呼び出しは __stubs から「起動時に埋められるアドレス」を経由するので、
   * ファイルを読んだだけでは行き先が決まりません。
   * ここでは止まらずに「戻り値 0 で帰ってきた」ことにして先へ進めます。
   * どの関数をそう扱ったかは log に残ります。
   */
  externalReturn(at, target) {
    const label = (this.io.labelFor && this.io.labelFor(at)) ||
      (target != null ? '0x' + target.toString(16).toUpperCase() : '不明');
    this.log.push({
      call: label,
      note: 'このファイルの外にある関数です。中身は動かせないので、戻り値 0 として先へ進みました。',
    });
    this.x[0] = 0n;
    return this.x[30];
  }

  branchTarget(ops) {
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].k === 'imm' && ops[i].value != null) return BigInt.asUintN(64, ops[i].value);
      if (ops[i].k === 'reg') return this.get(ops[i].text);
    }
    return null;
  }

  /** オペランド 1 つの「今の値」。 */
  valueOf(op) {
    if (!op) return 0n;
    if (op.k === 'imm') {
      let v = op.value != null ? op.value : 0n;
      if (op.shift && op.shift.amount) {
        const s = BigInt(op.shift.amount);
        v = op.shift.op === 'lsr' ? v >> s : v << s;
      }
      return BigInt.asUintN(64, v);
    }
    if (op.k === 'reg') {
      let v = this.get(op.text);
      if (op.shift && op.shift.amount != null) {
        const s = BigInt(op.shift.amount);
        const o = op.shift.op;
        if (o === 'lsl') v = v << s;
        else if (o === 'lsr') v = v >> s;
        else if (o === 'asr') v = BigInt.asIntN(64, v) >> s;
        else if (o === 'sxtw') v = BigInt.asUintN(64, BigInt.asIntN(32, v) << s);
        else if (o === 'uxtw') v = (v & MASK32) << s;
        else if (o === 'sxtb') v = BigInt.asUintN(64, BigInt.asIntN(8, v) << s);
        else if (o === 'uxtb') v = (v & 0xffn) << s;
      } else if (op.shift && op.shift.op) {
        const o = op.shift.op;
        if (o === 'sxtw') v = BigInt.asUintN(64, BigInt.asIntN(32, v));
        else if (o === 'uxtw') v = v & MASK32;
        else if (o === 'sxtb') v = BigInt.asUintN(64, BigInt.asIntN(8, v));
        else if (o === 'uxtb') v = v & 0xffn;
        else if (o === 'sxth') v = BigInt.asUintN(64, BigInt.asIntN(16, v));
        else if (o === 'uxth') v = v & 0xffffn;
      }
      return BigInt.asUintN(64, v);
    }
    return 0n;
  }

  /** メモリの実効アドレス。書き戻し（pre/post）もここで面倒を見る。 */
  effectiveAddress(mem, after) {
    const base = mem.base ? this.get(mem.base.text) : 0n;
    const disp = mem.disp && mem.disp.value != null ? mem.disp.value : 0n;
    let index = 0n;
    if (mem.index) {
      index = this.valueOf(Object.assign({}, mem.index, { shift: mem.shift }));
    }
    if (mem.mode === 'post') {
      if (after && mem.base) this.set(mem.base.text, base + disp);
      return base + index;
    }
    const addr = base + disp + index;
    if (mem.mode === 'pre' && after && mem.base) this.set(mem.base.text, addr);
    return addr;
  }

  async loadInsn(mn, ops) {
    const mem = ops.find((o) => o.k === 'mem');
    if (!mem) throw new Error('読み出し先が分かりませんでした: ' + mn);
    const addr = this.effectiveAddress(mem, false);
    const pair = /^(ldp|ldnp)/.test(mn);
    const size = loadSize(mn, ops[0]);
    const signed = /^ldrs|^ldurs/.test(mn);

    if (pair) {
      const each = isWide(ops[0]) ? 8 : 4;
      const a = await this.load(addr, each);
      const b = await this.load(addr + BigInt(each), each);
      this.set(ops[0].text, a);
      this.set(ops[1].text, b);
    } else {
      let v = await this.load(addr, size);
      if (signed) v = BigInt.asUintN(64, BigInt.asIntN(size * 8, v));
      if (isFloatReg(ops[0])) this.v[ops[0].num] = bitsToFloat(v, size);
      else this.set(ops[0].text, v);
    }
    if (/^(ldxr|ldaxr)/.test(mn) && !pair) this.exclusive = { addr:BigInt(addr), size };
    this.effectiveAddress(mem, true);
    return null;
  }

  async storeInsn(mn, ops) {
    const mem = ops.find((o) => o.k === 'mem');
    if (!mem) throw new Error('書き込み先が分かりませんでした: ' + mn);
    const exclusive = /^(stxr|stlxr)/.test(mn);
    const first = exclusive ? 1 : 0;
    const addr = this.effectiveAddress(mem, false);
    const pair = /^(stp|stnp)/.test(mn);
    const size = storeSize(mn, ops[first]);
    if (exclusive) {
      const monitor = this.exclusive;
      const success = !!monitor && monitor.addr === BigInt(addr) && monitor.size === size;
      this.exclusive = null;
      if (success) {
        if (isFloatReg(ops[first])) await this.store(addr, size, floatToBits(this.fget(ops[first]), size));
        else await this.store(addr, size, this.get(ops[first].text));
      }
      this.set(ops[0].text, success ? 0n : 1n);
      this.effectiveAddress(mem, true);
      return null;
    }
    if (pair) {
      const each = isWide(ops[0]) ? 8 : 4;
      await this.store(addr, each, this.get(ops[0].text));
      await this.store(addr + BigInt(each), each, this.get(ops[1].text));
    } else if (isFloatReg(ops[first])) {
      await this.store(addr, size, floatToBits(this.fget(ops[first]), size));
    } else await this.store(addr, size, this.get(ops[first].text));
    this.effectiveAddress(mem, true);
    return null;
  }

  /* ── 小数 ─────────────────────────────────────────────
     s0 / d0 は「JS の数」として持ちます。ビット単位の再現ではないので、
     極端な値では実機と細かく違うことがあります（その旨は画面にも出します）。 */

  fget(op) {
    if (!op || op.k !== 'reg') return 0;
    if (op.cls === 'gp' || op.cls === 'sp') {
      const bits = op.bits === 32 ? 32 : 64;
      return Number(BigInt.asIntN(bits, this.get(op.text)));
    }
    const value = this.v[op.num];
    return value === undefined ? 0 : value;
  }

  fset(op, value) {
    if (!op || op.k !== 'reg') return;
    if (op.cls === 'gp') { this.set(op.text, BigInt(Math.trunc(value))); return; }
    this.v[op.num] = op.bits === 32 || /^s\d+$/i.test(op.text || '') ? Math.fround(value) : value;
  }

  floatInsn(mn, ops) {
    if (mn === 'fcmp' || mn === 'fcmpe') {
      const lhs = this.fget(ops[0]);
      const rhs = ops[1]?.k === 'imm'
        ? (ops[1].float != null ? Number(ops[1].float) : Number(ops[1].value ?? 0n))
        : this.fget(ops[1]);
      if (Number.isNaN(lhs) || Number.isNaN(rhs)) this.nzcv = { n:false, z:false, c:true, v:true };
      else if (lhs < rhs) this.nzcv = { n:true, z:false, c:false, v:false };
      else if (lhs === rhs) this.nzcv = { n:false, z:true, c:true, v:false };
      else this.nzcv = { n:false, z:false, c:true, v:false };
      return null;
    }
    const a = this.fget(ops[1]);
    const b = ops[2] ? this.fget(ops[2]) : 0;
    if (mn === 'fmov') {
      if (ops[1] && ops[1].k === 'imm') this.fset(ops[0], ops[1].float != null ? ops[1].float : Number(ops[1].value || 0n));
      else this.fset(ops[0], a);
      return null;
    }
    if (mn === 'fadd') { this.fset(ops[0], a + b); return null; }
    if (mn === 'fsub') { this.fset(ops[0], a - b); return null; }
    if (mn === 'fmul') { this.fset(ops[0], a * b); return null; }
    if (mn === 'fdiv') { this.fset(ops[0], a / b); return null; }
    if (mn === 'fneg') { this.fset(ops[0], -a); return null; }
    if (mn === 'fabs') { this.fset(ops[0], Math.abs(a)); return null; }
    if (mn === 'fsqrt') { this.fset(ops[0], Math.sqrt(a)); return null; }
    if (mn === 'fmadd') { this.fset(ops[0], this.fget(ops[3]) + a * b); return null; }
    if (mn === 'fmsub') { this.fset(ops[0], this.fget(ops[3]) - a * b); return null; }
    if (mn === 'fcvt' || mn === 'fcvtd' || mn === 'fcvts') { this.fset(ops[0], a); return null; }
    if (/^(scvtf|ucvtf)$/.test(mn)) {
      const bits = ops[1]?.bits === 32 ? 32 : 64;
      const raw = this.get(ops[1].text);
      const integer = mn === 'scvtf' ? BigInt.asIntN(bits, raw) : BigInt.asUintN(bits, raw);
      this.fset(ops[0], Number(integer));
      return null;
    }
    if (/^fcvtz[su]$/.test(mn)) {
      const bits = ops[0]?.bits === 32 || /^w/.test(ops[0]?.text || '') ? 32 : 64;
      const unsigned = mn === 'fcvtzu';
      let result = 0n;
      if (!Number.isNaN(a)) {
        const t = Math.trunc(a);
        if (unsigned) {
          const max = (1n << BigInt(bits)) - 1n;
          if (t <= 0) result = 0n;
          else if (!Number.isFinite(t)) result = max;
          else { const integer=BigInt(t); result=integer>max?max:integer; }
        } else {
          const min = -(1n << BigInt(bits - 1)), max = (1n << BigInt(bits - 1)) - 1n;
          if (!Number.isFinite(t)) result = t < 0 ? min : max;
          else { const integer=BigInt(t); result=integer<min?min:integer>max?max:integer; }
        }
      }
      this.set(ops[0].text, result);
      return null;
    }
    if (/^(fmin|fmax|fminnm|fmaxnm)$/.test(mn)) {
      let value;
      if (/nm$/.test(mn)) {
        if (Number.isNaN(a) && !Number.isNaN(b)) value = b;
        else if (!Number.isNaN(a) && Number.isNaN(b)) value = a;
        else value = /min/.test(mn) ? Math.min(a,b) : Math.max(a,b);
      } else value = /min/.test(mn) ? Math.min(a,b) : Math.max(a,b);
      this.fset(ops[0], value);
      return null;
    }
    throw new Error('この小数命令はまだ実行できません: ' + mn);
  }

  conditionalSelect(mn, ops) {
    const ccOp = ops[ops.length - 1];
    const cc = ccOp && ccOp.k === 'cond' ? ccOp.text : 'al';
    const taken = this.cond(cc);
    if (mn === 'cset' || mn === 'csetm') {
      this.set(ops[0].text, taken ? (mn === 'csetm' ? MASK64 : 1n) : 0n);
      return null;
    }
    const a = this.valueOf(ops[1]);
    const b = ops[2] && ops[2].k !== 'cond' ? this.valueOf(ops[2]) : a;
    let alt = b;
    if (mn === 'csinc' || mn === 'cinc') alt = b + 1n;
    if (mn === 'csinv' || mn === 'cinv') alt = ~b;
    if (mn === 'csneg' || mn === 'cneg') alt = -b;
    // cinc / cinv / cneg は「条件が成り立ったら」加工する形（条件が逆）
    const inverted = /^c(inc|inv|neg)$/.test(mn);
    this.set(ops[0].text, (inverted ? !taken : taken) ? a : alt);
    return null;
  }

  /* ── フラグ ───────────────────────────────────────────── */

  setFlags(mn, a, b, result, wide) {
    const bits = wide ? 64 : 32;
    const sub = /^sub/.test(mn) || mn === 'cmp';
    const sa = BigInt.asIntN(bits, a), sb = BigInt.asIntN(bits, b), sr = BigInt.asIntN(bits, result);
    this.nzcv.n = sr < 0n;
    this.nzcv.z = BigInt.asUintN(bits, result) === 0n;
    const ua = BigInt.asUintN(bits, a), ub = BigInt.asUintN(bits, b);
    this.nzcv.c = sub ? ua >= ub : (ua + ub) > BigInt.asUintN(bits, -1n);
    this.nzcv.v = sub ? ((sa < 0n) !== (sb < 0n)) && ((sr < 0n) !== (sa < 0n))
                      : ((sa < 0n) === (sb < 0n)) && ((sr < 0n) !== (sa < 0n));
  }

  setLogicFlags(result, wide) {
    const bits = wide ? 64 : 32;
    this.nzcv.n = BigInt.asIntN(bits, result) < 0n;
    this.nzcv.z = BigInt.asUintN(bits, result) === 0n;
    this.nzcv.c = false;
    this.nzcv.v = false;
  }

  cond(cc) {
    const { n, z, c, v } = this.nzcv;
    switch (cc) {
      case 'eq': return z;
      case 'ne': return !z;
      case 'cs': case 'hs': return c;
      case 'cc': case 'lo': return !c;
      case 'mi': return n;
      case 'pl': return !n;
      case 'vs': return v;
      case 'vc': return !v;
      case 'hi': return c && !z;
      case 'ls': return !c || z;
      case 'ge': return n === v;
      case 'lt': return n !== v;
      case 'gt': return !z && n === v;
      case 'le': return z || n !== v;
      case 'al': case 'nv': return true;
      default: return false;
    }
  }

  /* ── よく呼ばれる外部関数の代役 ─────────────────────────
     malloc の中身まで実行しても意味がないので、それらしい値を返して先へ進めます。
     代役を使ったことは log に残すので、結果を読むときに区別できます。 */

  async hookedCall(target) {
    const name = this.io.symbolFor ? this.io.symbolFor(target) : null;
    if (!name) return false;
    const plain = name.replace(/^_+/, '');
    const MAX_HOOK_BYTES = 65536n;
    const allocate = async (size, zero = false) => {
      if (size < 0n || size > 0x100000n) throw new Error('外部メモリ確保が安全上限を超えました: ' + size);
      const addr = this.heap;
      this.heap += (size + 15n) & ~15n;
      if (zero) for (let i=0n;i<size;i++) { await this.ensure(addr+i); this.writeByte(addr+i,0); }
      return addr;
    };
    if (/^(malloc|operator new|Znwm|Znam)$/.test(plain)) {
      const size = this.x[0] || 16n;
      const addr = await allocate(size, false);
      this.x[0] = addr;
      this.log.push({ call: plain, note: 'メモリを ' + size + ' バイト確保したことにしました → 0x' + addr.toString(16) });
      return true;
    }
    if (plain === 'calloc') {
      const count=this.x[0], each=this.x[1];
      if (count !== 0n && each > MASK64 / count) throw new Error('calloc のサイズがオーバーフローしました');
      const size=count*each;
      const addr=await allocate(size,true);
      this.x[0]=addr;
      this.log.push({call:'calloc',note:size+' バイトをゼロ初期化して確保しました'});
      return true;
    }
    if (/^(free|operator delete|ZdlPv|ZdaPv)$/.test(plain)) {
      this.log.push({ call: plain, note: '解放は何もしません' });
      return true;
    }
    if (plain === 'strlen') {
      const p=this.x[0]; let n=0n;
      while (n < 4096n) { await this.ensure(p+n); if (this.byteAt(p+n) === 0) { this.x[0]=n; this.log.push({call:'strlen',note:'長さ '+n+' を返しました'}); return true; } n++; }
      throw new Error('strlen: 4096 バイト以内に終端NULがありません');
    }
    if (/^(memcpy|memmove)$/.test(plain)) {
      const d=this.x[0], src=this.x[1], n=this.x[2];
      if (n > MAX_HOOK_BYTES) throw new Error(plain + ': コピー長が安全上限65536バイトを超えました');
      const snapshot = plain === 'memmove' ? new Uint8Array(Number(n)) : null;
      if (snapshot) for (let i=0;i<snapshot.length;i++) { await this.ensure(src+BigInt(i)); snapshot[i]=this.byteAt(src+BigInt(i)); }
      for (let i=0n;i<n;i++) {
        await this.ensure(src+i); await this.ensure(d+i);
        this.writeByte(d+i, snapshot ? snapshot[Number(i)] : this.byteAt(src+i));
      }
      this.x[0]=d;
      this.log.push({call:plain,note:n+' バイトをコピーしました'});
      return true;
    }
    if (/^(memset|bzero)$/.test(plain)) {
      const d=this.x[0], c=plain==='bzero'?0n:this.x[1], n=plain==='bzero'?this.x[1]:this.x[2];
      if (n > MAX_HOOK_BYTES) throw new Error(plain + ': 書込長が安全上限65536バイトを超えました');
      for (let i=0n;i<n;i++) { await this.ensure(d+i); this.writeByte(d+i,Number(c&0xffn)); }
      this.x[0]=d;
      this.log.push({call:plain,note:n+' バイトを埋めました'});
      return true;
    }
    if (/^(arc4random|rand|random)$/.test(plain)) {
      this.x[0]=4n; this.log.push({call:plain,note:'乱数は毎回 4 を返します（結果を比べられるように）'}); return true;
    }
    if (plain === 'objc_storeStrong') {
      await this.store(this.x[0], 8, this.x[1]);
      this.log.push({call:plain,note:'strong参照先へ新しいobject pointerを書き込みました'});
      return true;
    }
    if (/^objc_(retain|release|autorelease|retainAutoreleasedReturnValue)$/.test(plain)) {
      this.log.push({call:plain,note:'参照カウントの操作は素通りします'}); return true;
    }
    return false;
  }

  /* ── 見せるための小道具 ─────────────────────────────── */

  registerList() {
    const out = [];
    for (let i = 0; i <= 30; i++) out.push({ name: 'x' + i, value: this.x[i] || 0n });
    out.push({ name: 'sp', value: this.sp });
    out.push({ name: 'pc', value: this.pc });
    return out;
  }

  flagText() {
    const f = this.nzcv;
    return (f.n ? 'N' : '-') + (f.z ? 'Z' : '-') + (f.c ? 'C' : '-') + (f.v ? 'V' : '-');
  }
}

/* ── 小道具 ─────────────────────────────────────────────── */

function isWide(op) {
  if (!op || op.k !== 'reg') return true;
  return op.bits !== 32;
}

function loadSize(mn, dst) {
  if (/^(ldrb|ldrsb|ldurb|ldursb|ldxrb|ldaxrb|ldarb)$/.test(mn)) return 1;
  if (/^(ldrh|ldrsh|ldurh|ldursh|ldxrh|ldaxrh|ldarh)$/.test(mn)) return 2;
  if (/^(ldrsw|ldursw)$/.test(mn)) return 4;
  return isWide(dst) ? 8 : 4;
}

function storeSize(mn, src) {
  if (/^(strb|sturb|stxrb|stlxrb|stlrb)$/.test(mn)) return 1;
  if (/^(strh|sturh|stxrh|stlxrh|stlrh)$/.test(mn)) return 2;
  return isWide(src) ? 8 : 4;
}

function isFloatReg(op) { return !!op && op.k === 'reg' && (op.cls === 'fp' || op.cls === 'vec'); }

/** メモリのビット列を小数として読む（s は 4 バイト、d は 8 バイト）。 */
function bitsToFloat(bits, size) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setBigUint64(0, BigInt.asUintN(64, bits), true);
  return size === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
}

function floatToBits(value, size) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  if (size === 4) { dv.setFloat32(0, value, true); return BigInt(dv.getUint32(0, true)); }
  dv.setFloat64(0, value, true);
  return dv.getBigUint64(0, true);
}

function padTo(bytes, len) {
  if (bytes.length >= len) return bytes.subarray(0, len);
  const out = new Uint8Array(len);
  out.set(bytes);
  return out;
}
