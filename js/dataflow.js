/*
 * データフロー — 「その値はどこから来て、何をされて、どこへ行くのか」。
 *
 * 初心者がいちばん知りたいのは結局これ:
 *
 *     ldr  w8, [x0, #0x20]      ← 値を読み込む
 *     add  w8, w8, #10          ← 10 を足す
 *     str  w8, [x0, #0x20]      ← 同じ場所へ書き戻す
 *
 * この 3 行が「x0 が指す場所の +0x20 にある数を 10 増やしている」と分かれば、
 * 「じゃあどのアドレスを見ればいいの？」に答えが出る。
 *
 * ここは blocks.js が作った Semantic Model（命令の事実）だけを材料にする。
 * 日本語は作らない。作るのは構造と根拠だけ。
 *
 * きまり:
 *   - つながりが確認できたものだけを返す。「たぶん同じ場所だろう」は返さない。
 *   - 分岐で飛び込まれる行をまたいだら、そこで追跡をやめる（前提が崩れるため）。
 */
import { SCORE, ev, levelOf } from './blocks.js';

/** レジスタを 1 つの鍵にする。zr は値を持たないので追跡しない。 */
export function regKeyOf(op) {
  if (!op || op.k !== 'reg') return null;
  if (op.cls === 'zr') return null;
  if (op.cls === 'sp') return 'sp';
  if (op.cls === 'gp') return 'x' + op.num;
  if (op.cls === 'fp' || op.cls === 'vec') return 'v' + op.num;
  return null;
}

/**
 * 場所を表す鍵。ベースレジスタ＋ずらし幅。どちらか欠けたら null（＝特定できない）。
 *
 * ずらし幅が命令に無く、位置変数（_OBJC_IVAR_$_…）から読んだ添字で触っている形も
 * 1 つの場所として扱う。いまの Objective-C ではこちらが普通の書き方で、
 * 「添字つきは分からない」で捨てると、アクセサがまるごと読めなくなる。
 */
export function locationKey(mem) {
  if (!mem || !mem.base) return null;
  if (mem.indexAddr != null) return mem.base + '@iv' + mem.indexAddr.toString();
  if (mem.disp == null || mem.indexed) return null;
  return mem.base + '@' + mem.disp.toString();
}

/* 引数レジスタ。Objective-C のメソッドは x0=self, x1=_cmd, x2 以降が引数。 */
const ARG0 = 'x0';

/** 受け取ったものをそのまま返す ARC の下働き。x0 の中身は変わらない。 */
const IDENTITY_HELPER =
  /objc_(retain|autorelease|retainAutorelease|retainAutoreleaseReturnValue|retainAutoreleasedReturnValue|autoreleaseReturnValue|unsafeClaimAutoreleasedReturnValue|retainBlock)$/;

/**
 * self（＝ x0 で渡されたオブジェクト）を持ち回っているレジスタを求める。
 *
 * -[C hp] のように 2 命令で終わる関数なら x0 のままだが、少し長い関数では
 *
 *     mov  x19, x0        ← ここから x19 が self
 *     ...
 *     ldr  w8, [x19, #0x20]
 *
 * という形になる。x19 を self と認めないと、ほとんどの読み書きを取りこぼす。
 * 逆に、self でないものを self と数えると、よそのクラスの値が混ざる。
 * だからコピーの連鎖だけを追い、上書きされたら即座に外す。
 *
 * 大事なのは「いつからいつまで self だったか」。関数の終わりでは
 *
 *     ldp x20, x19, [sp]      ← 退避したものを戻す＝ x19 はもう self ではない
 *
 * が必ず出るので、最後の状態だけを見ると、途中の `str w20, [x19, #0x10]` が
 * 「self ではない何か」への書き込みに見えてしまう。行ごとに答えられるようにする。
 *
 * @returns {{set, at, isSelf(reg,row)}} set は「一度でも self だった」レジスタ
 */
export function selfRegisters(model) {
  const set = new Set([ARG0]);
  const at = new Map([[ARG0, -1]]);
  const live = new Map([[ARG0, -1]]);          // いま self のレジスタ → いつから
  const spans = new Map();                     // レジスタ → [[from, to], …]
  const open = (reg, row) => { if (!live.has(reg)) live.set(reg, row); };
  const close = (reg, row) => {
    if (!live.has(reg)) return;
    if (!spans.has(reg)) spans.set(reg, []);
    spans.get(reg).push([live.get(reg), row]);
    live.delete(reg);
  };
  const insns = (model && model.instructions) || [];
  /*
   * ARC の下働きは、渡されたものをそのまま返す。
   *
   *     mov x0, self ; bl _objc_retain ; mov x19, x0   ← x19 はまだ self
   *
   * ここで追跡をやめると、ARC が入った関数（＝アプリのほとんど）で
   * self を見失い、フィールドの読み書きが 1 件も名指しできなくなる。
   */
  const identityCalls = new Set();
  for (const c of (model && model.calls) || []) {
    if (c.name && IDENTITY_HELPER.test(c.name)) identityCalls.add(c.row);
  }

  for (const insn of insns) {
    const mn = String(insn.mnemonic || '').toLowerCase();

    if (identityCalls.has(insn.row)) {
      for (const w of insn.writes) if (w !== ARG0) close(w, insn.row);
      continue;                                    // x0 の中身はそのまま
    }

    // mov xd, xs / orr xd, xzr, xs — 素直なコピー
    if ((mn === 'mov' || mn === 'orr') && insn.writes.length === 1) {
      const dst = insn.writes[0];
      const src = insn.reads.find((r) => live.has(r));
      if (src && dst) {
        // 64 ビット幅のコピーだけを認める（w レジスタへのコピーは値の切り出し）
        const wide = /^x\d+$/.test(dst) || dst === 'sp';
        if (wide) {
          close(dst, insn.row);
          open(dst, insn.row); set.add(dst); at.set(dst, insn.row);
          continue;
        }
      }
    }

    // str x0, [sp, #N] → あとで ldr x19, [sp, #N] で戻す形も追う
    if (insn.memory && insn.memory.kind === 'store' && insn.memory.stack) {
      const src = regKeyOf(insn.ops[0]);
      const key = locationKey(insn.memory);
      if (src && live.has(src) && key) { open('@' + key, insn.row); set.add('@' + key); }
    }
    if (insn.memory && insn.memory.kind === 'load' && insn.memory.stack) {
      const key = locationKey(insn.memory);
      const dst = regKeyOf(insn.ops[0]);
      if (dst && key && live.has('@' + key)) {
        close(dst, insn.row);
        open(dst, insn.row); set.add(dst); at.set(dst, insn.row);
        continue;
      }
    }

    // 上書きされたら self ではなくなる
    for (const w of insn.writes) close(w, insn.row);
  }
  const last = insns.length ? insns[insns.length - 1].row + 1 : 0;
  for (const reg of Array.from(live.keys())) close(reg, last);
  // x0 は関数の入口では必ず self。上書きされても「入口では self だった」は残す。
  set.add(ARG0);
  if (!at.has(ARG0)) at.set(ARG0, -1);

  const isSelf = (reg, row) => {
    if (reg == null) return false;
    const list = spans.get(reg);
    if (!list) return false;
    if (row == null) return true;
    /* 上書きする命令そのものは、書く前に読む。だから終わりの行は含める。 */
    for (const [from, to] of list) if (row > from && row <= to) return true;
    return false;
  };
  return { set, at, isSelf, spans };
}


const ARITH_OPS = new Set([
  'add', 'adds', 'sub', 'subs', 'mul', 'madd', 'msub', 'smull', 'umull', 'sdiv', 'udiv',
  'and', 'orr', 'eor', 'bic', 'lsl', 'lsr', 'asr', 'neg', 'mvn',
  'fadd', 'fsub', 'fmul', 'fdiv', 'fmadd', 'fmsub', 'fneg', 'fmov',
  'movz', 'mov', 'movk', 'sxtw', 'uxtw', 'sxth', 'uxth', 'sxtb', 'uxtb', 'csel', 'csinc',
]);

/** 集めた連鎖が、どういう更新だったか。 */
function updateKind(sameLocation, loadInsn, steps) {
  if (sameLocation) return 'read-modify-write';
  if (loadInsn) return 'move';
  /*
   * 読み出しはないが、途中が写しているだけなら「そのまま入れた」。
   * setter の本体（引数を 1 か所へ入れるだけ）がこの形で、数はいちばん多い。
   */
  if (steps.length && steps.every((s) => COPY_OPS.has(s.op))) return 'write';
  return 'compute-store';
}
const COPY_OPS = new Set(['mov', 'fmov', 'movz', 'sxtw', 'uxtw', 'sxtb', 'uxtb', 'sxth', 'uxth']);

/** その命令が「値をいじっている」なら、何をどうしたか。 */
function operationOf(insn) {
  const base = insn.mnemonic.toLowerCase();
  if (!ARITH_OPS.has(base)) return null;
  const imm = insn.ops.find((o) => o.k === 'imm' && (o.value != null || o.float != null));
  return {
    op: base,
    imm: imm ? (imm.value != null ? imm.value : null) : null,
    immFloat: imm && imm.float != null ? imm.float : null,
    row: insn.row,
    address: insn.address,
  };
}

/**
 * 「読んで → 計算して → 同じ場所へ書き戻す」の連鎖を探す。
 *
 * これが見つかった場所は、値の増減がそこで起きているという意味で、
 * 「変更するならここ」の最有力候補になる。
 * ただし、それが目的の値かどうかまでは、この解析だけでは決められない。
 *
 * @param {object} model buildSemanticModel の結果
 * @param {object} [opts] { window: 何行さかのぼるか }
 * @returns {Array<object>} 変更の連鎖
 */
export function findValueUpdates(model, opts) {
  const o = opts || {};
  const window = o.window || 24;
  const insns = model.instructions || [];
  const byRow = new Map();
  for (const i of insns) byRow.set(i.row, i);
  const joins = new Set((model.basicBlocks || []).filter((b) => b.isJoin).map((b) => b.startRow));
  const self = selfRegisters(model);

  const out = [];
  for (let idx = 0; idx < insns.length; idx++) {
    const store = insns[idx];
    if (!store.memory || store.memory.kind !== 'store') continue;
    const loc = locationKey(store.memory);
    const srcReg = regKeyOf(store.ops[0]);
    if (!srcReg) continue;

    // 書き込む値を作った命令まで、後ろ向きにたどる
    const steps = [];
    let want = srcReg;
    let loadInsn = null;
    let crossedJoin = false;
    for (let k = idx - 1; k >= 0 && idx - k <= window; k--) {
      const insn = insns[k];
      if (joins.has(insn.row)) { crossedJoin = true; break; }
      if (!insn.writes.includes(want)) continue;

      if (insn.memory && insn.memory.kind === 'load') {
        const from = locationKey(insn.memory);
        loadInsn = { insn, location: from };
        break;                                   // 読み出しまで届いた。ここで打ち止め。
      }
      const op = operationOf(insn);
      if (!op) break;                            // 何をしたか分からない命令 → 追跡終了
      steps.unshift(op);
      /*
       * 次にたどる先。
       * add w8, w8, #10 や mul w8, w8, w9 のように、書き込み先と同じレジスタを
       * 読んでいるなら、そちらが「持ち回っている値」。そこを優先して遡る。
       */
      const next = insn.reads.includes(want) ? want : (insn.reads[0] || null);
      if (!next) break;
      want = next;
    }

    const sameLocation = loadInsn && loc && loadInsn.location === loc;
    if (!loadInsn && !steps.length) {
      // 値をそのまま書いているだけ（定数の保存など）。連鎖ではないので候補にしない。
      continue;
    }

    const evidence = [];
    if (loadInsn) evidence.push(ev('load', loadInsn.insn.row, { base: loadInsn.insn.memory.base, disp: loadInsn.insn.memory.disp }));
    for (const s of steps) evidence.push(ev('compute', s.row, { op: s.op, imm: s.imm }));
    evidence.push(ev('store', store.row, { base: store.memory.base, disp: store.memory.disp }));

    /*
     * 確からしさ:
     *   同じ場所を読んで書き戻している … いちばん確か（読み書きの往復が閉じている）
     *   読み出しはあるが場所が違う     … 値の移動。確度は落とす
     *   計算だけで読み出しがない       … 参考程度
     */
    let score = SCORE.inferred;
    if (sameLocation && steps.length) score = SCORE.confirmed;
    else if (sameLocation) score = SCORE.high;
    else if (loadInsn) score = SCORE.high - 0.1;
    if (crossedJoin) score = Math.min(score, SCORE.inferred);

    out.push({
      kind: updateKind(sameLocation, loadInsn, steps),
      location: {
        base: store.memory.base,
        disp: store.memory.disp,
        size: store.memory.size,
        stack: !!store.memory.stack,
        key: loc,
        indexAddr: store.memory.indexAddr,
        self: self.isSelf(store.memory.base, store.row),
      },
      from: loadInsn ? {
        row: loadInsn.insn.row, address: loadInsn.insn.address,
        base: loadInsn.insn.memory.base, disp: loadInsn.insn.memory.disp,
        size: loadInsn.insn.memory.size, key: loadInsn.location,
      } : null,
      steps,
      store: { row: store.row, address: store.address, reg: srcReg },
      register: srcReg,
      confidence: score,
      level: levelOf(score),
      evidence,
    });
  }

  for (const u of plainAccessors(model, insns, out, self)) out.push(u);

  // 同じ場所を何度も更新している場合は、いちばん確からしいものを先に
  out.sort((a, b) => b.confidence - a.confidence || a.store.row - b.store.row);
  void byRow;
  return out;
}

/**
 * 読み書きの往復が閉じていない「素の」読み・書きを拾う。
 *
 * アプリの関数のうち、いちばん数が多いのはこの形:
 *
 *     -[X window]      ldr x0, [x0, x8] ; ret          … 読んで返すだけ
 *     -[X setWindow:]  str x1, [x0, x8] ; ret          … 引数をそのまま入れるだけ
 *
 * 「読んで → 足して → 書き戻す」だけを見ていたころは、これが 1 件も拾えず、
 * 何万本もあるアクセサについて「何をしているか分かりません」と答えていた。
 * 増減ではないので確度は下げるが、**何をしているかは命令から確実に言える**。
 */
/*
 * ARC が用意する property の代行関数。
 *
 *   objc_getProperty(self, _cmd, offset, atomic)                  … 位置は x2
 *   objc_setProperty*(self, _cmd, value, offset, …)               … 位置は x3
 *
 * この形のとき、フィールドの位置は命令の中の即値としてそのまま書いてある。
 */
const PROPERTY_HELPERS = [
  { re: /objc_getProperty/, kind: 'read', reg: 'x2' },
  { re: /objc_setProperty/, kind: 'write', reg: 'x3' },
];

/*
 * もう 1 つの形。フィールドの**場所**を作って、その番地を代行関数へ渡す。
 *
 *   -[ADJActivityHandler logger]:
 *       add x0, x0, #0x90            ← self の +0x90 の番地
 *       bl  _objc_loadWeakRetained   ← そこから読む
 *       b   _objc_autoreleaseReturnValue
 *
 * weak な参照や ARC の代入はすべてこの形になる。x0 に何を作ったかを見れば、
 * 触っているフィールドがそのまま分かる。
 */
const POINTER_HELPERS = [
  { re: /objc_loadWeakRetained|objc_loadWeak\b/, kind: 'read' },
  { re: /objc_storeStrong|objc_storeWeak|objc_initWeak|objc_copyWeak|objc_moveWeak/, kind: 'write' },
  { re: /objc_destroyWeak/, kind: 'write' },
];

/** 代行関数に渡している位置（直前の mov で作られた即値）。 */
function immediateArg(insns, at, reg) {
  const num = reg.slice(1);
  for (let k = at - 1; k >= 0 && at - k <= 10; k--) {
    const insn = insns[k];
    if (!insn.writes.includes(reg) && !insn.writes.includes('w' + num)) continue;
    const base = insn.mnemonic.toLowerCase();
    if (base !== 'mov' && base !== 'movz') return null;
    const imm = insn.ops.find((o) => o.k === 'imm' && o.value != null);
    return imm ? imm.value : null;
  }
  return null;
}

/**
 * x0 に組み立てた「self のどこか」の番地。self そのものなら 0。
 * self でないもの（別のオブジェクトや局所変数）なら null（＝分からない、と言う）。
 */
function selfOffsetIn(model, insns, at, self, reg) {
  let want = reg;
  let from = at;
  for (let guard = 0; guard < 4; guard++) {
    let found = null;
    for (let k = from - 1; k >= 0 && from - k <= 32; k--) {
      if (insns[k].writes.includes(want)) { found = k; break; }
    }
    if (found == null) return self.isSelf(want, at) ? { disp: 0n } : null;
    const insn = insns[found];
    const base = insn.mnemonic.toLowerCase();
    if (base === 'add' && insn.ops.length >= 3 && insn.ops[1] && insn.ops[1].k === 'reg') {
      const src = regKeyOf(insn.ops[1]);
      if (!src || !self.isSelf(src, insn.row)) return null;
      // add x0, self, #0x90 — ずらし幅が命令に書いてある
      if (insn.ops[2].k === 'imm' && insn.ops[2].value != null) return { disp: insn.ops[2].value };
      /*
       * add x0, self, x8 — ずらし幅は位置変数（_OBJC_IVAR_$_…）から読んだ値。
       * いまの Objective-C ではこちらが普通で、これを読めないと
       * weak なプロパティのアクセサが 1 本も名指しできない。
       */
      if (insn.ops[2].k === 'reg') {
        const off = regKeyOf(insn.ops[2]);
        const addr = off ? loadedAddrOf(model, insns, found, off) : null;
        return addr == null ? null : { indexAddr: addr };
      }
      return null;
    }
    if (base === 'mov' && insn.ops[1] && insn.ops[1].k === 'reg') {
      const src = regKeyOf(insn.ops[1]);
      if (!src) return null;
      if (self.isSelf(src, insn.row)) return { disp: 0n };
      want = src; from = found; continue;
    }
    return null;
  }
  return null;
}

/** そのレジスタが、どのアドレスから読み込まれた値か。分からなければ null。 */
function loadedAddrOf(model, insns, at, reg) {
  for (let k = at - 1; k >= 0 && at - k <= 32; k--) {
    if (!insns[k].writes.includes(reg)) continue;
    const flows = (model.flowByRow && model.flowByRow.get(insns[k].row)) || [];
    for (const f of flows) {
      if (f.to === reg && f.value && f.value.kind === 'loaded' && f.value.addr != null) {
        return f.value.addr;
      }
    }
    return null;
  }
  return null;
}

function propertyHelperUpdates(model, insns, self) {
  const out = [];
  for (const c of model.calls || []) {
    if (!c.name) continue;
    const ptr = POINTER_HELPERS.find((h) => h.re.test(c.name));
    if (ptr) {
      const at2 = insns.findIndex((i) => i.row === c.row);
      const where = at2 < 0 ? null : selfOffsetIn(model, insns, at2, self, 'x0');
      if (where) out.push(helperUpdate(ptr.kind, where, c));
      continue;
    }
    const hit = PROPERTY_HELPERS.find((h) => h.re.test(c.name));
    if (!hit) continue;
    const at = insns.findIndex((i) => i.row === c.row);
    if (at < 0) continue;
    const disp = immediateArg(insns, at, hit.reg);
    if (disp == null) continue;
    out.push(helperUpdate(hit.kind, { disp }, c));
  }
  return out;
}

/** 代行関数ごしのフィールド操作を、ふつうの読み書きと同じ形にそろえる。 */
function helperUpdate(kind, where, call) {
  const reg = kind === 'read' ? 'x0' : 'x2';
  const disp = where.disp != null ? where.disp : null;
  const indexAddr = where.indexAddr != null ? where.indexAddr : null;
  const key = 'x0@' + (indexAddr != null ? 'iv' + indexAddr.toString() : String(disp));
  return {
    kind,
    location: { base: 'x0', disp, size: 8, stack: false, key, indexAddr, self: true },
    from: kind === 'read' ? { row: call.row, address: call.address, base: 'x0', disp, size: 8 } : null,
    steps: [],
    store: { row: call.row, address: call.address, reg },
    register: reg,
    helper: call.name,
    confidence: SCORE.confirmed,
    level: levelOf(SCORE.confirmed),
    evidence: [ev(kind === 'read' ? 'load' : 'store', call.row, { base: 'x0', disp, helper: call.name })],
  };
}

/**
 * 「位置を取り出して、あとは共通の処理へ丸投げする」だけの関数。
 *
 *     -[FBAdDSLViewController eventQueue]:
 *         adrp x8, _OBJC_IVAR_$_FBAdDSLViewController._eventQueue@PAGE
 *         ldrsw x8, [x8, …]
 *         b   <共通のアクセサ>
 *
 * 触っているフィールドは位置変数がそのまま名乗っているので確実に分かる。
 * 読みか書きかは、引数を受け取っているかで決まる（setter だけが x2 を読む）。
 * 飛び先を追わないと分からないのは「共通処理が何をするか」だけなので、
 * ここまでは推測ではなく、命令から言える。
 */
function delegatedAccessor(model, insns) {
  if (!insns.length || insns.length > 12) return null;
  const tail = insns[insns.length - 1];
  if (!tail.isCall && !tail.isReturn) return null;
  let addr = null;
  for (const insn of insns) {
    if (!insn.memory) continue;
    if (insn.memory.stack) return null;                 // 局所変数を触るなら別の形
    if (insn.memory.kind !== 'load') return null;
    const flows = (model.flowByRow && model.flowByRow.get(insn.row)) || [];
    const hit = flows.find((f) => f.value && f.value.kind === 'loaded' && f.value.addr != null);
    if (!hit) return null;
    if (addr != null) return null;                      // 2 か所以上なら「1 個」ではない
    addr = hit.value.addr;
  }
  if (addr == null) return null;
  const args = model.argRegs || new Set();
  const takesValue = args.has ? args.has(2) : Array.from(args || []).includes(2);
  return {
    kind: takesValue ? 'write' : 'read',
    location: {
      base: 'x0', disp: null, size: 8, stack: false,
      key: 'x0@iv' + addr.toString(), indexAddr: addr, self: true,
    },
    from: null,
    steps: [],
    store: { row: tail.row, address: tail.address, reg: takesValue ? 'x2' : 'x0' },
    register: takesValue ? 'x2' : 'x0',
    delegated: true,
    confidence: SCORE.high,
    level: levelOf(SCORE.high),
    evidence: [ev(takesValue ? 'store' : 'load', tail.row, { base: 'x0', disp: null })],
  };
}

function plainAccessors(model, insns, already, self) {
  const out = propertyHelperUpdates(model, insns, self);
  if (!out.length && !already.length) {
    const d = delegatedAccessor(model, insns);
    if (d) out.push(d);
  }
  const covered = new Set();
  for (const u of already.concat(out)) if (u.location && u.location.key) covered.add(u.location.key);

  /* 書き込み: 引数か定数を、そのまま 1 か所へ入れている。 */
  for (const insn of insns) {
    if (!insn.memory || insn.memory.kind !== 'store') continue;
    const loc = locationKey(insn.memory);
    if (!loc || covered.has(loc) || insn.memory.stack) continue;
    const src = regKeyOf(insn.ops[0]);
    covered.add(loc);
    out.push({
      kind: 'write',
      location: {
        base: insn.memory.base, disp: insn.memory.disp, size: insn.memory.size,
        stack: false, key: loc, indexAddr: insn.memory.indexAddr,
        self: self.isSelf(insn.memory.base, insn.row),
      },
      from: null,
      steps: [],
      store: { row: insn.row, address: insn.address, reg: src },
      register: src,
      confidence: SCORE.high,
      level: levelOf(SCORE.high),
      evidence: [ev('store', insn.row, { base: insn.memory.base, disp: insn.memory.disp })],
    });
  }

  /* 読み出し: 読んだ値がそのまま戻り値（x0）になっている。 */
  const returns = insns.filter((i) => i.isReturn ||
    (i.isBranch && !i.isConditional && i.mnemonic.toLowerCase() === 'b'));
  for (const r of returns) {
    const at = insns.indexOf(r);
    let want = 'x0';
    for (let k = at - 1; k >= 0 && at - k <= 12; k--) {
      const insn = insns[k];
      if (!insn.writes.includes(want)) continue;
      if (insn.memory && insn.memory.kind === 'load') {
        const loc = locationKey(insn.memory);
        if (!loc || covered.has(loc) || insn.memory.stack) break;
        covered.add(loc);
        out.push({
          kind: 'read',
          location: {
            base: insn.memory.base, disp: insn.memory.disp, size: insn.memory.size,
            stack: false, key: loc, indexAddr: insn.memory.indexAddr,
            self: self.isSelf(insn.memory.base, insn.row),
          },
          from: {
            row: insn.row, address: insn.address,
            base: insn.memory.base, disp: insn.memory.disp, size: insn.memory.size, key: loc,
          },
          steps: [],
          store: { row: insn.row, address: insn.address, reg: 'x0' },
          register: 'x0',
          confidence: SCORE.high,
          level: levelOf(SCORE.high),
          evidence: [ev('load', insn.row, { base: insn.memory.base, disp: insn.memory.disp })],
        });
        break;
      }
      // mov x0, xN のような橋渡しは追う。それ以外は「返り値の出どころ不明」。
      const next = insn.reads.length === 1 ? insn.reads[0] : null;
      if (!next) break;
      want = next;
    }
  }
  return out;
}

/**
 * 1 つの命令が、メモリに対して何をしているかを構造で返す。
 * 「変更対象 / 変更前 / 演算 / 変更後」の表示に使う。
 */
export function memoryEffect(insn) {
  if (!insn || !insn.memory) return null;
  const m = insn.memory;
  return {
    kind: m.kind,                 // 'load' | 'store'
    base: m.base,
    disp: m.disp,
    size: m.size,
    stack: !!m.stack,
    indexed: !!m.indexed,
    mode: m.mode || 'offset',
    register: regKeyOf(insn.ops[0]),
    row: insn.row,
    address: insn.address,
  };
}

/**
 * その行で作られた値が、このあとどこで使われるか。
 *
 * 「この w8 は次に何に使われるの？」に答えるための前向きの追跡。
 * 上書きされた時点で追跡は終わる（そこから先は別の値なので）。
 *
 * @returns {Array<{row:number, address:BigInt, use:string, detail:object}>}
 */
export function traceForward(model, row, reg, limit = 40) {
  const insns = model.instructions || [];
  const start = insns.findIndex((i) => i.row === row);
  if (start < 0 || !reg) return [];
  const joins = new Set((model.basicBlocks || []).filter((b) => b.isJoin).map((b) => b.startRow));
  const uses = [];
  let cur = reg;

  for (let i = start + 1; i < insns.length && uses.length < limit; i++) {
    const insn = insns[i];
    if (joins.has(insn.row)) {
      uses.push({ row: insn.row, address: insn.address, use: 'join', detail: null });
      break;                                    // 合流点。ここから先は前提が保てない
    }
    const reads = insn.reads.includes(cur);
    if (reads) {
      let use = 'read';
      const detail = {};
      if (insn.isCall) {
        use = 'argument';
        detail.index = /^x([0-7])$/.test(cur) ? Number(cur.slice(1)) : null;
        detail.name = insn.callTarget != null ? insn.callTarget : null;
      } else if (insn.memory && insn.memory.kind === 'store' && regKeyOf(insn.ops[0]) === cur) {
        use = 'store';
        detail.base = insn.memory.base;
        detail.disp = insn.memory.disp;
      } else if (insn.memory) {
        use = 'address';
      } else if (insn.isConditional || /^(cmp|cmn|tst|subs|adds)$/.test(insn.mnemonic.toLowerCase())) {
        use = 'compare';
      } else if (insn.writes.length) {
        use = 'compute';
        detail.op = insn.mnemonic.toLowerCase();
      }
      uses.push({ row: insn.row, address: insn.address, use, detail });
      // 計算結果が別のレジスタへ移ったら、そちらを追い続ける
      if ((use === 'compute' || insn.mnemonic.toLowerCase() === 'mov') && insn.writes.length) {
        const dst = insn.writes[0];
        if (dst !== cur) { cur = dst; continue; }
      }
    }
    if (insn.writes.includes(cur) && !reads) {
      uses.push({ row: insn.row, address: insn.address, use: 'overwritten', detail: null });
      break;
    }
    if (insn.isReturn) {
      if (cur === 'x0') uses.push({ row: insn.row, address: insn.address, use: 'returned', detail: null });
      break;
    }
  }
  return uses;
}

/**
 * その行が読んでいる値が、どこで作られたか（後ろ向き）。
 * 見つからなければ空。作り主が分からないことを「分からない」と言うために使う。
 */
export function traceBackward(model, row, reg, limit = 12) {
  const insns = model.instructions || [];
  const at = insns.findIndex((i) => i.row === row);
  if (at < 0 || !reg) return [];
  const joins = new Set((model.basicBlocks || []).filter((b) => b.isJoin).map((b) => b.startRow));
  const chain = [];
  let want = reg;
  for (let i = at - 1; i >= 0 && chain.length < limit; i--) {
    const insn = insns[i];
    if (joins.has(insn.row)) { chain.push({ row: insn.row, address: insn.address, kind: 'join' }); break; }
    if (!insn.writes.includes(want)) continue;
    const kind = insn.memory ? 'load' : insn.isCall ? 'call' : 'compute';
    chain.push({
      row: insn.row, address: insn.address, kind,
      mnemonic: insn.mnemonic, operands: insn.operands,
      memory: insn.memory || null,
    });
    if (kind !== 'compute') break;
    const next = insn.reads.includes(want) ? want : insn.reads[0];
    if (!next) break;
    want = next;
  }
  return chain;
}

/**
 * 定数との比較。しきい値（残高が足りるか、上限に達したか）の判定を見つける。
 * 「この数を変えれば通る」を探すときの手がかりになる。
 */
export function constantComparisons(model) {
  const out = [];
  for (const insn of model.instructions || []) {
    const base = insn.mnemonic.toLowerCase();
    if (!/^(cmp|cmn|subs|adds|ccmp|fcmp)$/.test(base)) continue;
    const imm = insn.ops.find((o) => o.k === 'imm' && (o.value != null || o.float != null));
    if (!imm) continue;
    out.push({
      row: insn.row,
      address: insn.address,
      register: regKeyOf(insn.ops[0]),
      value: imm.value != null ? imm.value : null,
      float: imm.float != null ? imm.float : null,
      mnemonic: base,
    });
  }
  return out;
}

/**
 * 関数が扱っている「同じ場所」をまとめる。
 * 何度も読み書きされている場所は、その関数が持っている値そのものであることが多い。
 */
export function hotLocations(model, limit = 12) {
  const map = new Map();
  for (const insn of model.instructions || []) {
    if (!insn.memory) continue;
    const key = locationKey(insn.memory);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        key, base: insn.memory.base, disp: insn.memory.disp,
        size: insn.memory.size, stack: !!insn.memory.stack,
        loads: 0, stores: 0, rows: [],
      });
    }
    const e = map.get(key);
    if (insn.memory.kind === 'load') e.loads++; else e.stores++;
    if (e.rows.length < 16) e.rows.push(insn.row);
  }
  const out = Array.from(map.values());
  // 読み書きの両方があるものを優先する（＝持ち回っている値）
  out.sort((a, b) => (b.loads + b.stores) - (a.loads + a.stores));
  return out.filter((e) => e.loads + e.stores >= 2).slice(0, limit);
}
