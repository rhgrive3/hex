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

/** 場所を表す鍵。ベースレジスタ＋ずらし幅。どちらか欠けたら null（＝特定できない）。 */
export function locationKey(mem) {
  if (!mem || !mem.base || mem.disp == null || mem.indexed) return null;
  return mem.base + '@' + mem.disp.toString();
}

const ARITH_OPS = new Set([
  'add', 'adds', 'sub', 'subs', 'mul', 'madd', 'msub', 'smull', 'umull', 'sdiv', 'udiv',
  'and', 'orr', 'eor', 'bic', 'lsl', 'lsr', 'asr', 'neg', 'mvn',
  'fadd', 'fsub', 'fmul', 'fdiv', 'fmadd', 'fmsub', 'fneg', 'fmov',
  'movz', 'mov', 'movk', 'sxtw', 'uxtw', 'sxth', 'uxth', 'sxtb', 'uxtb', 'csel', 'csinc',
]);

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
      kind: sameLocation ? 'read-modify-write' : (loadInsn ? 'move' : 'compute-store'),
      location: {
        base: store.memory.base,
        disp: store.memory.disp,
        size: store.memory.size,
        stack: !!store.memory.stack,
        key: loc,
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

  // 同じ場所を何度も更新している場合は、いちばん確からしいものを先に
  out.sort((a, b) => b.confidence - a.confidence || a.store.row - b.store.row);
  void byRow;
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
