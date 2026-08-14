/*
 * slice.js — SSA / Memory SSA に基づく program slicing。
 *
 * 「命令を前後 N 行見る」のではなく、値の def-use と Memory SSA の reaching
 * definition だけを辿る。巨大関数では必ず budget で止まり、結果には
 * truncated を残す。
 */

import { OP, MK } from './ir.js';

const DEFAULT_LIMIT = 800;

function pushInst(inst, out, seen, work) {
  if (!inst || seen.has(inst.id)) return;
  seen.add(inst.id);
  out.push(inst);
  work.push(inst);
}

function pushValueDef(value, out, seen, work) {
  if (!value || !value.def) return;
  pushInst(value.def, out, seen, work);
}

/**
 * 後ろ向きスライス。seed が使う値の定義、および load が読む Memory SSA の定義を辿る。
 *
 * @param {object} ir
 * @param {object} seed IR instruction
 * @param {object} [opts] { limit, includeControl }
 */
export function backwardSlice(ir, seed, opts) {
  const o = opts || {};
  const limit = Math.max(1, o.limit || DEFAULT_LIMIT);
  if (!ir || !seed) return { instructions: [], truncated: false };
  const out = [], seen = new Set(), work = [];
  pushInst(seed, out, seen, work);
  let truncated = false;

  while (work.length) {
    if (out.length >= limit) { truncated = true; break; }
    const inst = work.pop();
    for (const a of inst.args || []) pushValueDef(a && a.value, out, seen, work);
    if (inst.op === OP.LOAD) {
      if (inst.reachingStore) pushInst(inst.reachingStore, out, seen, work);
      else if (inst.memUse && inst.memUse.inst) pushInst(inst.memUse.inst, out, seen, work);
    }
    if (inst.op === OP.STORE && inst.args && inst.args[0]) pushValueDef(inst.args[0].value, out, seen, work);
    if (o.includeControl && inst.block != null) {
      for (const pred of (ir.blocks[inst.block] && ir.blocks[inst.block].pred) || []) {
        const block = ir.blocks[pred];
        const term = block && block.insts && block.insts[block.insts.length - 1];
        if (term && term.op === OP.CBR) pushInst(term, out, seen, work);
      }
    }
  }
  out.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { instructions: out.slice(0, limit), truncated, direction: 'backward', seed: seed.id };
}

function memoryUsesOf(ir, store) {
  if (!store || !store.loc || store.loc.kind === MK.UNKNOWN) return [];
  const out = [];
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.LOAD) continue;
    if (inst.reachingStore === store || (inst.memUse && inst.memUse.inst === store)) out.push(inst);
  }
  return out;
}

/** SSA use-def と Memory SSA store→load を辿る前向きスライス。 */
export function forwardSlice(ir, seed, opts) {
  const o = opts || {};
  const limit = Math.max(1, o.limit || DEFAULT_LIMIT);
  if (!ir || !seed) return { instructions: [], truncated: false };
  const out = [], seen = new Set(), work = [];
  pushInst(seed, out, seen, work);
  let truncated = false;

  while (work.length) {
    if (out.length >= limit) { truncated = true; break; }
    const inst = work.pop();
    for (const v of inst.defs || []) {
      for (const use of v.uses || []) pushInst(use, out, seen, work);
    }
    if (inst.op === OP.STORE) for (const load of memoryUsesOf(ir, inst)) pushInst(load, out, seen, work);
  }
  out.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { instructions: out.slice(0, limit), truncated, direction: 'forward', seed: seed.id };
}

function describeInst(inst) {
  if (!inst) return null;
  if (inst.op === OP.LOAD) return { kind: 'read', row: inst.row, address: inst.address, location: inst.loc };
  if (inst.op === OP.STORE) return { kind: 'write', row: inst.row, address: inst.address, location: inst.loc };
  if (inst.op === OP.BIN || inst.op === OP.MAC || inst.op === OP.UN) return { kind: 'compute', row: inst.row, address: inst.address, op: inst.sub || inst.op };
  if (inst.op === OP.CALL) return { kind: 'call', row: inst.row, address: inst.address, target: inst.extra && inst.extra.target };
  if (inst.op === OP.SEL) return { kind: 'choose', row: inst.row, address: inst.address, condition: inst.cond };
  if (inst.op === OP.PHI) return { kind: 'merge', row: inst.row, address: inst.address };
  return { kind: 'unknown', row: inst.row, address: inst.address, op: inst.op };
}

/**
 * スライスを人向けの最小な value chain に落とす。
 * 同種の中間計算は連続していても最大 maxCompute 個だけ残す。
 */
export function valueChain(ir, seed, opts) {
  const o = opts || {};
  const back = backwardSlice(ir, seed, { limit: o.limit || DEFAULT_LIMIT, includeControl: !!o.includeControl });
  const ordered = back.instructions;
  const steps = [];
  let computeRun = 0;
  const maxCompute = Math.max(1, o.maxCompute || 4);
  for (const inst of ordered) {
    const d = describeInst(inst);
    if (!d) continue;
    if (d.kind === 'compute') {
      if (computeRun >= maxCompute) continue;
      computeRun++;
    } else computeRun = 0;
    steps.push(d);
  }
  return { steps, truncated: back.truncated, seed: seed.id };
}

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
      if (n == null || path.some((p) => p === n)) continue; // path-local cycle protection
      queue.push(path.concat([n]));
    }
  }
  return paths.sort((a, b) => a.length - b.length);
}
