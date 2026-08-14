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

const DEFAULT_LIMIT = 400;

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
  if (seed && seed.op) pushInst(seed); else if (seed) pushValue(seed);
  while (stack.length) {
    if (instructions.length >= limit) { truncated = true; break; }
    const job = stack.pop();
    if (job.v) {
      const v = job.v;
      if (seenValue.has(v.id)) continue;
      seenValue.add(v.id); values.push(v); if (v.def) pushInst(v.def); continue;
    }
    const inst = job.i;
    if (seenInst.has(inst.id)) continue;
    seenInst.add(inst.id); instructions.push(inst);
    for (const a of inst.args || []) if (a && a.value) pushValue(a.value);
    if (inst.addr) { if (inst.addr.base) pushValue(inst.addr.base); if (inst.addr.index) pushValue(inst.addr.index); }
    if (throughMemory && inst.op === OP.LOAD && inst.reachingStore) pushInst(inst.reachingStore);
    if (throughMemory && inst.op === OP.LOAD && inst.memUse && inst.memUse.kind === 'phi') {
      for (const inc of inst.memUse.incoming || []) if (inc.node && inc.node.kind === 'store') pushInst(inc.node.inst);
    }
    if (inst.op === OP.PHI) for (const inc of inst.incoming || []) pushValue(inc.value);
  }
  instructions.sort(byPosition);
  return { instructions, values, truncated, seed };
}

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
  const readersByLoc = new Map();
  for (const inst of ir.instructions) {
    if (inst.op !== OP.LOAD || !inst.loc) continue;
    let list = readersByLoc.get(inst.loc.key); if (!list) { list = []; readersByLoc.set(inst.loc.key, list); } list.push(inst);
  }
  while (stack.length) {
    if (instructions.length >= limit) { truncated = true; break; }
    const inst = stack.pop();
    if (!inst || seenInst.has(inst.id)) continue;
    seenInst.add(inst.id); instructions.push(inst);
    if (inst.dst) for (const u of inst.dst.uses || []) stack.push(u);
    if (inst.op === OP.STORE && inst.loc) for (const r of readersByLoc.get(inst.loc.key) || []) if (r.reachingStore === inst) stack.push(r);
  }
  instructions.sort(byPosition);
  return { instructions, truncated, seed };
}

function byPosition(a, b) { if (a.block !== b.block) return a.block - b.block; return (a.row || 0) - (b.row || 0); }

const COMPUTE_SUB = {
  add: 'add', sub: 'sub', mul: 'mul', sdiv: 'div', udiv: 'div', and: 'mask', or: 'mask', xor: 'mask', bic: 'mask',
  shl: 'scale', lshr: 'scale', ashr: 'scale', ror: 'rotate', fadd: 'add', fsub: 'sub', fmul: 'mul', fdiv: 'div',
  smull: 'mul', umull: 'mul', smulh: 'mul', umulh: 'mul',
};

function stepOf(inst) {
  switch (inst.op) {
    case OP.LOAD: return { kind: 'read', row: inst.row, address: inst.address, location: inst.loc || null, slot: inst.slot ? inst.slot.name : null, size: inst.extra ? inst.extra.size : null, value: inst.dst };
    case OP.STORE: return { kind: 'write', row: inst.row, address: inst.address, location: inst.loc || null, slot: inst.slot ? inst.slot.name : null, size: inst.extra ? inst.extra.size : null, value: inst.args[0] ? inst.args[0].value : null };
    case OP.CALL: return { kind: 'call', row: inst.row, address: inst.address, target: inst.extra ? inst.extra.target : null, indirect: !!(inst.extra && inst.extra.indirect), value: inst.dst };
    case OP.BIN: return { kind: 'compute', row: inst.row, address: inst.address, op: COMPUTE_SUB[inst.sub] || inst.sub, sub: inst.sub, operands: inst.args.map((a) => a.value), value: inst.dst };
    case OP.MAC: return { kind: 'compute', row: inst.row, address: inst.address, op: 'mac', sub: inst.sub, operands: inst.args.map((a) => a.value), value: inst.dst };
    case OP.UN: if (/^[su]xt/.test(inst.sub || '')) return null; return { kind: 'compute', row: inst.row, address: inst.address, op: inst.sub, sub: inst.sub, operands: inst.args.map((a) => a.value), value: inst.dst };
    case OP.SEL: return { kind: clampLike(inst) ? 'clamp' : 'choose', row: inst.row, address: inst.address, cond: inst.cond, operands: inst.args.slice(0, 2).map((a) => a.value), value: inst.dst };
    case OP.PHI: return { kind: 'merge', row: inst.row, from: (inst.incoming || []).map((i) => i.from), value: inst.dst };
    case OP.CONST: return { kind: 'const', row: inst.row, address: inst.address, value: inst.dst };
    case OP.ADDR: return null;
    case OP.UNKNOWN: return { kind: 'unknown', row: inst.row, address: inst.address, mnemonic: inst.extra ? inst.extra.mnemonic : null, value: inst.dst };
    default: return null;
  }
}

function clampLike(inst) {
  const flags = inst.args[2] && inst.args[2].value; const cmp = flags && flags.def;
  if (!cmp || cmp.op !== OP.CMP) return false;
  const cmpIds = new Set(cmp.args.map((a) => (a.value ? a.value.id : -1)));
  const picked = inst.args.slice(0, 2).map((a) => (a.value ? a.value.id : -2));
  return picked.filter((id) => cmpIds.has(id)).length === 2;
}

export function valueChain(ir, seed, opts) {
  const o = opts || {}; const slice = backwardSlice(ir, seed, o); const steps = [];
  for (const inst of slice.instructions) { const step = stepOf(inst); if (step) steps.push(step); }
  const addressOnly = new Set();
  for (const inst of slice.instructions) { if (!inst.addr) continue; if (inst.addr.base) addressOnly.add(inst.addr.base.id); if (inst.addr.index) addressOnly.add(inst.addr.index.id); }
  for (const inst of slice.instructions) for (const a of inst.args || []) if (a && a.value) addressOnly.delete(a.value.id);
  const argValues = slice.values.filter((v) => v.kind === VK.ARG && v.reg && v.reg !== 'sp' && v.reg !== 'nzcv' && v.reg !== 'x29' && !addressOnly.has(v.id));
  for (const v of argValues) { if (steps.some((s) => s.value === v)) continue; steps.unshift({ kind: 'arg', reg: v.reg, value: v, row: ir.blocks[0] ? ir.blocks[0].startRow : 0 }); }
  if (seed && seed.op === OP.STORE) { const i = steps.findIndex((s) => s.kind === 'write' && s.row === seed.row); if (i >= 0 && i !== steps.length - 1) steps.push(steps.splice(i, 1)[0]); }
  return { steps, truncated: slice.truncated, source: steps.length ? steps[0] : null, sink: steps.length ? steps[steps.length - 1] : null };
}

const WEIGHT = { write: 100, read: 90, call: 80, clamp: 70, choose: 55, compute: 50, merge: 30, arg: 45, const: 20, unknown: 60 };

export function causalChain(ir, seed, opts) {
  const o = opts || {}; const limit = Math.max(2, o.limit || 8);
  const chain = valueChain(ir, seed, Object.assign({}, o, { limit: o.sliceLimit || DEFAULT_LIMIT }));
  const steps = chain.steps;
  if (steps.length <= limit) return { steps, elided: 0, truncated: chain.truncated };
  const first = steps[0], last = steps[steps.length - 1];
  const middle = steps.slice(1, -1).map((s, i) => ({ s, i, w: WEIGHT[s.kind] || 10 })).sort((a, b) => (b.w - a.w) || (a.i - b.i)).slice(0, limit - 2).sort((a, b) => a.i - b.i).map((x) => x.s);
  return { steps: [first, ...middle, last], elided: steps.length - (middle.length + 2), truncated: chain.truncated };
}

export function findPaths(graph, from, to, opts) {
  const o = opts || {};
  const maxDepth = Math.max(1, Math.min(12, Number(o.maxDepth) || 6));
  const maxPaths = Math.max(1, Math.min(32, Number(o.maxPaths) || 8));
  const maxVisited = Math.max(16, Math.min(20000, Number(o.maxVisited) || 20000));
  if (from == null || to == null) return [];
  const paths = []; const queue = [[from]]; let seen = 0;
  while (queue.length && paths.length < maxPaths && seen < maxVisited) {
    const path = queue.shift(); const head = path[path.length - 1]; seen++;
    if (head === to) { paths.push(path); continue; }
    if (path.length >= maxDepth) continue;
    let next = []; try { next = graph.calleesOf(head) || []; } catch { next = []; }
    for (const item of next) {
      const n = item && item.addr != null ? item.addr : item;
      if (n == null || path.some((p) => p === n)) continue;
      queue.push(path.concat([n]));
    }
  }
  return paths.sort((a, b) => a.length - b.length);
}
