/*
 * slice.js — 「その値は、どこから来て、どこへ行くのか」だけを残す。
 *
 * 初心者に見せるべきものは、1 万個の関数がつながった巨大な図ではない。
 *
 *     報酬 100
 *        ↓
 *     addCoins(amount)
 *        ↓
 *     いまの値 1,200 に足す
 *        ↓
 *     PlayerData.coins へ書き戻す
 *
 * この 4 段だけ。ここは IR / SSA / Memory SSA の上で、
 * 「答えに関係のある命令」だけを取り出す層。
 *
 *   backwardSlice … その値を作るのに関わった命令すべて（由来）
 *   forwardSlice  … その値がその後どこへ流れたか（行き先）
 *   valueChain    … 由来を「読む → 計算する → 書く」の段に畳んだもの
 *   causalChain   … 段数の上限を守って畳んだもの（畳んだ数は正直に持つ）
 *
 * きまり: 日本語は作らない。段の種類と材料だけを返す。文は narrate.js の仕事。
 */

import { OP, VK } from './ir.js';

const DEFAULT_LIMIT = 400;      // これ以上は追わない（巨大関数での暴走を止める）

/* ── 後ろ向き ───────────────────────────────────────────────── */

/**
 * その命令（またはその値）にたどり着くまでに関わった命令を集める。
 *
 * @param {object} ir     buildIR の結果
 * @param {object} seed   IR 命令、または SSA 値
 * @param {object} [opts] { limit, throughMemory=true, throughCalls=false }
 * @returns {{instructions, values, truncated}}
 */
export function backwardSlice(ir, seed, opts) {
  const o = opts || {};
  const limit = o.limit || DEFAULT_LIMIT;
  const throughMemory = o.throughMemory !== false;

  const seenInst = new Set();
  const seenValue = new Set();
  const instructions = [];
  const values = [];
  const stack = [];
  let truncated = false;

  const pushValue = (v) => { if (v && !seenValue.has(v.id)) stack.push({ v }); };
  const pushInst = (i) => { if (i && !seenInst.has(i.id)) stack.push({ i }); };

  if (seed && seed.op) pushInst(seed);
  else if (seed) pushValue(seed);

  while (stack.length) {
    if (instructions.length >= limit) { truncated = true; break; }
    const job = stack.pop();

    if (job.v) {
      const v = job.v;
      if (seenValue.has(v.id)) continue;
      seenValue.add(v.id);
      values.push(v);
      if (v.def) pushInst(v.def);
      continue;
    }

    const inst = job.i;
    if (seenInst.has(inst.id)) continue;
    seenInst.add(inst.id);
    instructions.push(inst);

    for (const a of inst.args || []) if (a && a.value) pushValue(a.value);
    if (inst.addr) {
      if (inst.addr.base) pushValue(inst.addr.base);
      if (inst.addr.index) pushValue(inst.addr.index);
    }
    // load は「その場所を最後に書いた命令」までさかのぼる。ここが Memory SSA の効き目。
    if (throughMemory && inst.op === OP.LOAD && inst.reachingStore) pushInst(inst.reachingStore);
    if (throughMemory && inst.op === OP.LOAD && inst.memUse && inst.memUse.kind === 'phi') {
      for (const inc of inst.memUse.incoming || []) {
        if (inc.node && inc.node.kind === 'store') pushInst(inc.node.inst);
      }
    }
    // φ は、来た道それぞれの値をさかのぼる
    if (inst.op === OP.PHI) for (const inc of inst.incoming || []) pushValue(inc.value);
  }

  instructions.sort(byPosition);
  return { instructions, values, truncated, seed };
}

/* ── 前向き ─────────────────────────────────────────────────── */

/**
 * その値がその後どこへ流れたか。
 * store まで届いたら、同じ場所を読む load へも渡す（Memory SSA を通る）。
 */
export function forwardSlice(ir, seed, opts) {
  const o = opts || {};
  const limit = o.limit || DEFAULT_LIMIT;

  const seenInst = new Set();
  const instructions = [];
  const stack = [];
  let truncated = false;

  const start = seed && seed.op ? (seed.dst ? [seed.dst] : []) : (seed ? [seed] : []);
  for (const v of start) for (const u of v.uses || []) stack.push(u);
  if (seed && seed.op) { seenInst.add(seed.id); instructions.push(seed); }

  // 場所 → その場所を読む load（store から先へ進むため）
  const readersByLoc = new Map();
  for (const inst of ir.instructions) {
    if (inst.op !== OP.LOAD || !inst.loc) continue;
    let list = readersByLoc.get(inst.loc.key);
    if (!list) { list = []; readersByLoc.set(inst.loc.key, list); }
    list.push(inst);
  }

  while (stack.length) {
    if (instructions.length >= limit) { truncated = true; break; }
    const inst = stack.pop();
    if (!inst || seenInst.has(inst.id)) continue;
    seenInst.add(inst.id);
    instructions.push(inst);

    if (inst.dst) for (const u of inst.dst.uses || []) stack.push(u);
    if (inst.op === OP.STORE && inst.loc) {
      for (const r of readersByLoc.get(inst.loc.key) || []) {
        if (r.reachingStore === inst) stack.push(r);
      }
    }
  }

  instructions.sort(byPosition);
  return { instructions, truncated, seed };
}

function byPosition(a, b) {
  if (a.block !== b.block) return a.block - b.block;
  return (a.row || 0) - (b.row || 0);
}

/* ── 値の流れ（人に見せる段） ───────────────────────────────── */

/*
 * 段の種類:
 *   'arg'      関数に入ってきた値（引数）
 *   'const'    その場に書かれた数
 *   'read'     どこかから読み出した値（フィールド / ローカル / グローバル）
 *   'call'     呼び出しの戻り値
 *   'compute'  足す・引く・掛ける・割る・ずらす
 *   'clamp'    上限 / 下限で丸める（csel）
 *   'choose'   条件で選ぶ
 *   'merge'    分かれた道の合流（φ）
 *   'write'    どこかへ書き込む
 *   'unknown'  意味を付けられなかった
 */

const COMPUTE_SUB = {
  add: 'add', sub: 'sub', mul: 'mul', sdiv: 'div', udiv: 'div',
  and: 'mask', or: 'mask', xor: 'mask', bic: 'mask',
  shl: 'scale', lshr: 'scale', ashr: 'scale', ror: 'rotate',
  fadd: 'add', fsub: 'sub', fmul: 'mul', fdiv: 'div',
  smull: 'mul', umull: 'mul', smulh: 'mul', umulh: 'mul',
};

function stepOf(inst) {
  switch (inst.op) {
    case OP.LOAD:
      return {
        kind: 'read', row: inst.row, address: inst.address,
        location: inst.loc || null,
        slot: inst.slot ? inst.slot.name : null,
        size: inst.extra ? inst.extra.size : null,
        value: inst.dst,
      };
    case OP.STORE:
      return {
        kind: 'write', row: inst.row, address: inst.address,
        location: inst.loc || null,
        slot: inst.slot ? inst.slot.name : null,
        size: inst.extra ? inst.extra.size : null,
        value: inst.args[0] ? inst.args[0].value : null,
      };
    case OP.CALL:
      return {
        kind: 'call', row: inst.row, address: inst.address,
        target: inst.extra ? inst.extra.target : null,
        indirect: !!(inst.extra && inst.extra.indirect),
        value: inst.dst,
      };
    case OP.BIN:
      return {
        kind: 'compute', row: inst.row, address: inst.address,
        op: COMPUTE_SUB[inst.sub] || inst.sub, sub: inst.sub,
        operands: inst.args.map((a) => a.value),
        value: inst.dst,
      };
    case OP.MAC:
      return { kind: 'compute', row: inst.row, address: inst.address, op: 'mac', sub: inst.sub,
        operands: inst.args.map((a) => a.value), value: inst.dst };
    case OP.UN:
      if (/^[su]xt/.test(inst.sub || '')) return null;   // 型の合わせ込みは段として見せない
      return { kind: 'compute', row: inst.row, address: inst.address, op: inst.sub, sub: inst.sub,
        operands: inst.args.map((a) => a.value), value: inst.dst };
    case OP.SEL:
      return {
        kind: clampLike(inst) ? 'clamp' : 'choose', row: inst.row, address: inst.address,
        cond: inst.cond, operands: inst.args.slice(0, 2).map((a) => a.value), value: inst.dst,
      };
    case OP.PHI:
      return { kind: 'merge', row: inst.row, from: (inst.incoming || []).map((i) => i.from), value: inst.dst };
    case OP.CONST:
      return { kind: 'const', row: inst.row, address: inst.address, value: inst.dst };
    case OP.ADDR:
      return null;
    case OP.UNKNOWN:
      return { kind: 'unknown', row: inst.row, address: inst.address,
        mnemonic: inst.extra ? inst.extra.mnemonic : null, value: inst.dst };
    default:
      return null;
  }
}

/*
 * csel が「上限で丸めている」形かどうか。
 *
 *   cmp w8, w22
 *   csel w8, w22, w8, gt      ← w8 が w22 を超えていたら w22 にする
 *
 * 選ぶ 2 つのうち片方が、直前の比較の相手そのものなら、丸めと見てよい。
 * ここを取り違えると「上限 999999 で止めている」を「条件で分けている」と
 * 言ってしまい、初心者にとっていちばん知りたい情報が消える。
 */
function clampLike(inst) {
  const flags = inst.args[2] && inst.args[2].value;
  const cmp = flags && flags.def;
  if (!cmp || cmp.op !== OP.CMP) return false;
  const cmpIds = new Set(cmp.args.map((a) => (a.value ? a.value.id : -1)));
  const picked = inst.args.slice(0, 2).map((a) => (a.value ? a.value.id : -2));
  return picked.filter((id) => cmpIds.has(id)).length === 2;
}

/**
 * 「値の流れ」1 本。store（または任意の命令）を終点として、由来を段に畳む。
 *
 * @returns {{steps, truncated, source, sink}}
 */
export function valueChain(ir, seed, opts) {
  const o = opts || {};
  const slice = backwardSlice(ir, seed, o);
  const steps = [];
  for (const inst of slice.instructions) {
    const step = stepOf(inst);
    if (step) steps.push(step);
  }
  /*
   * 引数そのもの（定義を持たない値）も出どころとして立てる。
   *
   * ただし番地の置き場になっているだけのレジスタは外す。
   * `str w8, [x19,#0x20]` の x19 は「self がここに入っている」というだけで、
   * 値の流れの一段ではない。ここを入れると、どの流れも
   * 「self が来ました」から始まってしまい、いちばん見たい数が 2 段目に落ちる。
   */
  const addressOnly = new Set();
  for (const inst of slice.instructions) {
    if (!inst.addr) continue;
    if (inst.addr.base) addressOnly.add(inst.addr.base.id);
    if (inst.addr.index) addressOnly.add(inst.addr.index.id);
  }
  for (const inst of slice.instructions) {
    for (const a of inst.args || []) if (a && a.value) addressOnly.delete(a.value.id);
  }
  const argValues = slice.values.filter((v) => v.kind === VK.ARG && v.reg &&
    v.reg !== 'sp' && v.reg !== 'nzcv' && v.reg !== 'x29' && !addressOnly.has(v.id));
  for (const v of argValues) {
    if (steps.some((s) => s.value === v)) continue;
    steps.unshift({ kind: 'arg', reg: v.reg, value: v, row: ir.blocks[0] ? ir.blocks[0].startRow : 0 });
  }

  // 終点を最後に持ってくる（store が seed のとき、行番号だけだと途中に紛れる）
  if (seed && seed.op === OP.STORE) {
    const i = steps.findIndex((s) => s.kind === 'write' && s.row === seed.row);
    if (i >= 0 && i !== steps.length - 1) steps.push(steps.splice(i, 1)[0]);
  }

  return {
    steps,
    truncated: slice.truncated,
    source: steps.length ? steps[0] : null,
    sink: steps.length ? steps[steps.length - 1] : null,
  };
}

/* 段の大切さ。畳むときはここが小さいものから捨てる。 */
const WEIGHT = {
  write: 100, read: 90, call: 80, clamp: 70, choose: 55,
  compute: 50, merge: 30, arg: 45, const: 20, unknown: 60,
};

/**
 * 段数の上限を守って畳む。捨てた数は elided に残す（黙って消さない）。
 *
 * @param {object} ir
 * @param {object} seed
 * @param {object} [opts] { limit = 8 }
 */
export function causalChain(ir, seed, opts) {
  const o = opts || {};
  const limit = Math.max(2, o.limit || 8);
  /*
   * 段数の上限を、スライスの上限として渡してはいけない。
   * 渡していたころは「6 段に畳む」が「命令を 6 個だけ見る」になり、
   * 途中を畳んだのではなく**由来の大半を見ていない**まま
   * 「これで全部です」という顔をしていた。
   */
  const chain = valueChain(ir, seed, Object.assign({}, o, { limit: o.sliceLimit || DEFAULT_LIMIT }));
  const steps = chain.steps;
  if (steps.length <= limit) return { steps, elided: 0, truncated: chain.truncated };

  const first = steps[0];
  const last = steps[steps.length - 1];
  const middle = steps.slice(1, -1)
    .map((s, i) => ({ s, i, w: WEIGHT[s.kind] || 10 }))
    .sort((a, b) => (b.w - a.w) || (a.i - b.i))
    .slice(0, limit - 2)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);

  return {
    steps: [first, ...middle, last],
    elided: steps.length - (middle.length + 2),
    truncated: chain.truncated,
  };
}

/* ── 関数をまたぐ因果の道 ──────────────────────────────────── */

/**
 * 呼び出しグラフの上で、始点から終点までの道を探す。
 *
 * 「コインはどこで増える？」に答えるには、文字列 → その文字列を使う関数 →
 * … → 実際に書き戻す関数、という数段の道が要る。ここはその探索だけを担う。
 * 中身の解析はしない（関数の中は valueChain の仕事）。
 *
 * @param {object} graph { callersOf(addr) -> [addr], calleesOf(addr) -> [addr] }
 * @param {BigInt} from
 * @param {BigInt} to
 * @param {object} [opts] { maxDepth = 6, maxPaths = 8, maxVisited = 20000 }
 * @returns {Array<Array<BigInt>>} 見つかった道（短い順）
 */
export function findPaths(graph, from, to, opts) {
  const o = opts || {};
  const maxDepth = Math.max(1, Math.min(12, Number(o.maxDepth) || 6));
  const maxPaths = Math.max(1, Math.min(32, Number(o.maxPaths) || 8));
  const maxVisited = Math.max(16, Math.min(20000, Number(o.maxVisited) || 20000));
  if (from == null || to == null) return [];

  const paths = [];
  const queue = [[from]];
  let seen = 0;

  while (queue.length && paths.length < maxPaths && seen < maxVisited) {
    const path = queue.shift();
    const head = path[path.length - 1];
    seen++;
    if (head === to) { paths.push(path); continue; }
    if (path.length >= maxDepth) continue;
    let next = [];
    try { next = graph.calleesOf(head) || []; } catch { next = []; }
    for (const item of next) {
      const n = item && item.addr != null ? item.addr : item;
      if (n == null || path.some((p) => p === n)) continue;
      queue.push(path.concat([n]));
    }
  }
  return paths.sort((a, b) => a.length - b.length);
}
