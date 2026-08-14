/*
 * ir.js — public facade for the Semantic IR engine.
 *
 * ir-core.js contains the current lifter/SSA/Memory-SSA implementation. This
 * facade supplies the address->row resolver that CFG reconstruction requires and
 * applies conservative safety hardening before consumers see the IR.
 */

export * from './ir-core.js';

import { buildIR as buildCoreIR, OP, MK } from './ir-core.js';

function inferredRowResolver(model) {
  const byAddress = new Map();
  for (const insn of (model && model.instructions) || []) {
    if (insn && insn.address != null && insn.row != null) {
      byAddress.set(insn.address.toString(), insn.row);
    }
  }
  if (!byAddress.size) return () => null;
  return (addr) => {
    if (addr == null) return null;
    const row = byAddress.get(addr.toString());
    return row == null ? null : row;
  };
}

function normalizedOptions(model, opts) {
  const o = opts ? { ...opts } : {};
  if (!o.cfg && !o.rowOfAddress) o.rowOfAddress = inferredRowResolver(model);
  return o;
}

function blockReachability(ir) {
  const cache = new Map();
  return (from, to) => {
    if (from == null || to == null || from < 0 || to < 0) return false;
    if (from === to) return true;
    const key = from + '>' + to;
    if (cache.has(key)) return cache.get(key);
    const seen = new Set([from]);
    const work = [from];
    let yes = false;
    while (work.length && !yes) {
      const b = work.pop();
      for (const s of (ir.blocks[b] && ir.blocks[b].succ) || []) {
        if (s === to) { yes = true; break; }
        if (!seen.has(s)) { seen.add(s); work.push(s); }
      }
    }
    cache.set(key, yes);
    return yes;
  };
}

function orderedBefore(a, b, canReach) {
  if (!a || !b) return false;
  if (a.block === b.block) return (a.row == null ? -1 : a.row) < (b.row == null ? -1 : b.row);
  return canReach(a.block, b.block);
}

/**
 * Memory SSA must never let a concrete field/store flow through an indexed store
 * whose alias cannot be known. The core builder already treats calls/unknown
 * instructions as clobbers; this pass applies the same safety rule to
 * STORE(MK.UNKNOWN).
 */
function hardenUnknownStores(ir) {
  if (!ir || !ir.instructions) return ir;
  const barriers = ir.instructions.filter((inst) =>
    inst.op === OP.STORE && (!inst.loc || inst.loc.kind === MK.UNKNOWN));
  if (!barriers.length) {
    ir.memorySafety = { unknownStores: 0, blockedLoads: 0 };
    return ir;
  }

  const canReach = blockReachability(ir);
  let blocked = 0;
  for (const load of ir.instructions) {
    if (load.op !== OP.LOAD || !load.reachingStore) continue;
    const origin = load.reachingStore;
    let barrier = null;
    for (const candidate of barriers) {
      if (!orderedBefore(origin, candidate, canReach)) continue;
      if (!orderedBefore(candidate, load, canReach)) continue;
      barrier = candidate;
      break;
    }
    if (!barrier) continue;

    load.reachingStore = null;
    load.memUse = {
      kind: 'clobber',
      key: load.loc ? load.loc.key : 'unknown',
      inst: barrier,
      block: barrier.block,
      unknownAlias: true,
    };
    load.unknownAliasBarrier = barrier;
    blocked++;
  }
  ir.memorySafety = { unknownStores: barriers.length, blockedLoads: blocked };
  return ir;
}

/** Build IR with a usable CFG even when callers only have the Semantic Model. */
export function buildIR(model, opts) {
  const ir = buildCoreIR(model, normalizedOptions(model, opts));
  return hardenUnknownStores(ir);
}

/*
 * Keep the normal UI path cached by model identity. Custom CFG/resolver calls are
 * not cached because callers may intentionally be testing a different graph.
 */
const irCache = new WeakMap();

export function irFor(model, opts) {
  if (!model || !model.instructions || !model.instructions.length) return null;
  const custom = !!(opts && (opts.cfg || opts.rowOfAddress));
  if (!custom && irCache.has(model)) return irCache.get(model);
  let ir = null;
  try { ir = buildIR(model, opts); } catch { ir = null; }
  if (!custom) irCache.set(model, ir);
  return ir;
}
