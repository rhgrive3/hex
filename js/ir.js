/*
 * ir.js — public facade for the Semantic IR engine.
 *
 * ir-core.js contains the current lifter/SSA/Memory-SSA implementation. This
 * facade supplies the address->row resolver that CFG reconstruction requires and
 * applies conservative safety/alias hardening before consumers see the IR.
 */

export * from './ir-core.js';

import {
  buildIR as buildCoreIR,
  readModifyWrite as coreReadModifyWrite,
  OP, MK,
} from './ir-core.js';

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
  if (ir._canReachBlock) return ir._canReachBlock;
  const cache = new Map();
  const canReach = (from, to) => {
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
  // Unknown-store safety and canonical RMW recovery may ask the same reachability
  // question hundreds of times in giant functions. Keep one cache per immutable IR.
  ir._canReachBlock = canReach;
  return canReach;
}

function orderedBefore(a, b, canReach) {
  if (!a || !b) return false;
  if (a.block === b.block) return (a.row == null ? -1 : a.row) < (b.row == null ? -1 : b.row);
  return canReach(a.block, b.block);
}

function unknownStores(ir) {
  if (ir._unknownStoreBarriers) return ir._unknownStoreBarriers;
  const list = (ir.instructions || []).filter((inst) =>
    inst.op === OP.STORE && (!inst.loc || inst.loc.kind === MK.UNKNOWN));
  ir._unknownStoreBarriers = list;
  return list;
}

function unknownStoreBetween(ir, from, to) {
  const barriers = unknownStores(ir);
  if (!barriers.length || !from || !to) return null;
  const canReach = blockReachability(ir);
  for (const candidate of barriers) {
    if (orderedBefore(from, candidate, canReach) && orderedBefore(candidate, to, canReach)) return candidate;
  }
  return null;
}

/**
 * Public safety query for migration adapters. A legacy heuristic may only be
 * retained as a read/modify/write proof when no unknown indexed store can sit
 * between its read and write in the reconstructed CFG.
 */
export function hasUnknownStoreBarrier(ir, from, to) {
  return !!unknownStoreBetween(ir, from, to);
}

/**
 * Memory SSA must never let a concrete field/store flow through an indexed store
 * whose alias cannot be known. The core builder already treats calls/unknown
 * instructions as clobbers; this pass applies the same safety rule to
 * STORE(MK.UNKNOWN).
 */
function hardenUnknownStores(ir) {
  if (!ir || !ir.instructions) return ir;
  const barriers = unknownStores(ir);
  if (!barriers.length) {
    ir.memorySafety = { unknownStores: 0, blockedLoads: 0 };
    return ir;
  }

  let blocked = 0;
  for (const load of ir.instructions) {
    if (load.op !== OP.LOAD || !load.reachingStore) continue;
    const barrier = unknownStoreBetween(ir, load.reachingStore, load);
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

/* ── conservative pointer canonicalization ────────────────────── */

function canonicalPointer(value, memo = new Map(), active = new Set()) {
  if (!value) return null;
  if (memo.has(value.id)) return memo.get(value.id);
  if (active.has(value.id)) return value;
  active.add(value.id);

  let root = value;
  const def = value.def;
  if (def && def.op === OP.MOV && def.args && def.args[0] && def.args[0].value) {
    root = canonicalPointer(def.args[0].value, memo, active) || value;
  } else if (def && def.op === OP.PHI && def.args && def.args.length) {
    const roots = def.args
      .map((a) => a && a.value ? canonicalPointer(a.value, memo, active) : null)
      .filter(Boolean);
    if (roots.length === def.args.length && roots.every((r) => r.id === roots[0].id)) root = roots[0];
  } else if (def && def.op === OP.BIN && def.sub === 'add' && def.args && def.args.length === 2) {
    const a = def.args[0] && def.args[0].value;
    const b = def.args[1] && def.args[1].value;
    if (a && b && b.const === 0n) root = canonicalPointer(a, memo, active) || value;
    else if (a && b && a.const === 0n) root = canonicalPointer(b, memo, active) || value;
  }

  active.delete(value.id);
  memo.set(value.id, root);
  return root;
}

function sameCanonicalLocation(a, b, memo) {
  if (!a || !b || a.kind === MK.UNKNOWN || b.kind === MK.UNKNOWN) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === MK.STACK) return a.disp != null && b.disp != null && a.disp === b.disp && sizeCompatible(a, b);
  if (a.kind === MK.GLOBAL) return a.address != null && b.address != null && a.address === b.address && sizeCompatible(a, b);
  if (a.kind !== MK.FIELD || a.disp == null || b.disp == null || a.disp !== b.disp) return false;
  const ar = canonicalPointer(a.base, memo);
  const br = canonicalPointer(b.base, memo);
  return !!ar && !!br && ar.id === br.id && sizeCompatible(a, b);
}

function sizeCompatible(a, b) {
  if (a.size == null || b.size == null) return true;
  return a.size === b.size;
}

function classifyUpdate(chain) {
  const ops = chain.map((c) => (c.op === OP.BIN ? c.sub : c.op));
  if (ops.includes('add')) return 'add';
  if (ops.includes('sub')) return 'sub';
  if (ops.includes('mul')) return 'mul';
  if (ops.includes('sdiv') || ops.includes('udiv')) return 'div';
  if (ops.includes(OP.SEL)) return 'clamp';
  if (!ops.length) return 'copy';
  return 'other';
}

/**
 * RMW query with two guarantees missing from the first IR implementation:
 *  - simple pointer copies / identical phi merges are treated as the same base;
 *  - an unknown indexed store between the read and write invalidates the proof.
 */
export function readModifyWrite(ir) {
  if (!ir || !ir.instructions) return [];
  const memo = new Map();
  const out = [];
  const seen = new Set();

  for (const r of coreReadModifyWrite(ir)) {
    if (!r || !r.load || !r.store || unknownStoreBetween(ir, r.load, r.store)) continue;
    const key = r.load.id + '>' + r.store.id;
    seen.add(key);
    out.push(r);
  }

  for (const store of ir.instructions) {
    if (store.op !== OP.STORE || !store.loc) continue;
    const written = store.args && store.args[0] && store.args[0].value;
    if (!written) continue;

    const chain = [];
    const visited = new Set();
    const work = [written];
    let load = null;
    while (work.length && chain.length < 32) {
      const v = work.pop();
      if (!v || visited.has(v.id)) continue;
      visited.add(v.id);
      const def = v.def;
      if (!def) continue;
      chain.push(def);
      if (def.op === OP.LOAD) {
        if (sameCanonicalLocation(def.loc, store.loc, memo) && !unknownStoreBetween(ir, def, store)) load = def;
        continue;
      }
      for (const a of def.args || []) if (a && a.value) work.push(a.value);
    }
    if (!load) continue;
    const key = load.id + '>' + store.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      load,
      store,
      location: store.loc,
      chain: chain.filter((c) => c !== load && c.op !== OP.STORE),
      kind: classifyUpdate(chain),
      canonicalAlias: load.loc && store.loc && load.loc.key !== store.loc.key,
    });
  }

  return out;
}
