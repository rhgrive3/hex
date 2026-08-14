/*
 * ir.js — public facade for the Semantic IR engine.
 *
 * ir-core.js contains lifting / SSA / Memory-SSA. This facade is the semantic
 * boundary seen by the rest of Hex: it supplies CFG address resolution,
 * conservative memory safety, pointer provenance, value/range queries and
 * canonical alias checks. Consumers must not reinterpret ARM64 to recover these
 * facts a second time.
 */

export * from './ir-core.js';

import {
  buildIR as buildCoreIR,
  readModifyWrite as coreReadModifyWrite,
  OP, MK, VK, COND,
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

/** A legacy proof is unsafe when an unknown indexed store can occur in-between. */
export function hasUnknownStoreBarrier(ir, from, to) {
  return !!unknownStoreBetween(ir, from, to);
}

/**
 * STORE(MK.UNKNOWN) is a may-alias write to every non-stack object/global state.
 * Never let a concrete reaching-store proof pass through it.
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

/** Reclassify addresses proved absolute only after constant propagation. */
function promoteResolvedGlobals(ir) {
  if (!ir || !ir.instructions) return ir;
  const globals = new Map();
  for (const inst of ir.instructions) {
    if ((inst.op !== OP.LOAD && inst.op !== OP.STORE) || !inst.addr) continue;
    const a = inst.addr;
    if (a.stack || a.index || !a.base || a.base.const == null || a.disp == null) continue;

    const address = a.base.const + a.disp;
    const size = (inst.loc && inst.loc.size) || a.size || (inst.extra && inst.extra.size) || null;
    const key = 'global:' + address.toString(16);
    let loc = globals.get(key);
    if (!loc) {
      loc = { key, kind: MK.GLOBAL, address, size };
      globals.set(key, loc);
    } else if (loc.size == null && size != null) {
      loc.size = size;
    }

    const oldKey = inst.loc && inst.loc.key;
    inst.loc = loc;
    inst.globalAddress = address;
    if (inst.memUse && oldKey != null && inst.memUse.key === oldKey) inst.memUse.key = key;
    if (inst.memDef && oldKey != null && inst.memDef.key === oldKey) inst.memDef.key = key;
  }
  if (ir.locations && ir.locations.set) {
    for (const [key, loc] of globals) ir.locations.set(key, loc);
  }
  delete ir._unknownStoreBarriers;
  return ir;
}

/* ── Pointer provenance ─────────────────────────────────────── */

function shiftedConst(arg) {
  if (!arg || !arg.value || arg.value.const == null) return null;
  let v = arg.value.const;
  const s = arg.shift;
  if (!s) return v;
  const n = BigInt(s.amount || 0);
  if (s.op === 'lsl') return v << n;
  if (s.op === 'lsr') return v >> n;
  return null;
}

function provenanceKey(p) {
  if (!p) return null;
  return [p.kind, p.root, String(p.offset || 0n), p.address == null ? '' : String(p.address)].join(':');
}

const provenanceMemo = new WeakMap();

/**
 * Conservative pointer provenance for an SSA value.
 * `must` means every represented path has the same root+offset. Unknown values
 * retain their SSA identity; two unrelated arguments are never asserted equal.
 */
export function pointerProvenance(value, active) {
  if (!value) return null;
  if (provenanceMemo.has(value)) return provenanceMemo.get(value);
  const visiting = active || new Set();
  if (visiting.has(value)) return { kind: 'unknown', root: 'value:' + value.id, offset: 0n, must: false };
  visiting.add(value);

  let out = null;
  const def = value.def;
  const reg = String(value.reg || '');

  if (value.kind === VK.ARG && (reg === 'sp' || reg === 'x29')) {
    out = { kind: 'stack', root: 'stack', offset: 0n, must: true, valueId: value.id };
  } else if (value.kind === VK.ARG && /^x[0-7]$/.test(reg)) {
    out = { kind: 'arg', root: 'arg:' + reg, offset: 0n, arg: reg, must: true, valueId: value.id };
  } else if (def && def.op === OP.ADDR && value.const != null) {
    out = { kind: 'global', root: 'global', offset: 0n, address: value.const, must: true, valueId: value.id };
  } else if (def && def.op === OP.CALL) {
    out = { kind: 'return', root: 'return:' + def.id, offset: 0n,
      target: def.extra && def.extra.target != null ? def.extra.target : null, must: true, valueId: value.id };
  } else if (def && def.op === OP.LOAD) {
    out = { kind: 'field', root: 'loaded:' + value.id, offset: 0n,
      location: def.loc || null, must: true, valueId: value.id };
  } else if (def && def.op === OP.MOV && def.args && def.args[0] && def.args[0].value) {
    const p = pointerProvenance(def.args[0].value, visiting);
    if (p) out = { ...p, valueId: value.id, via: 'mov' };
  } else if (def && def.op === OP.PHI && def.args && def.args.length) {
    const ps = def.args.map((a) => a && a.value ? pointerProvenance(a.value, visiting) : null);
    const keys = ps.map(provenanceKey);
    if (keys[0] && keys.every((k) => k === keys[0])) {
      out = { ...ps[0], valueId: value.id, via: 'phi', must: ps.every((p) => p && p.must !== false) };
    } else {
      out = { kind: 'phi', root: 'phi:' + value.id, offset: 0n, must: false,
        alternatives: ps.filter(Boolean), valueId: value.id };
    }
  } else if (def && def.op === OP.BIN && (def.sub === 'add' || def.sub === 'sub') && def.args && def.args.length >= 2) {
    const a = def.args[0], b = def.args[1];
    const ac = shiftedConst(a), bc = shiftedConst(b);
    if (bc != null && a && a.value) {
      const p = pointerProvenance(a.value, visiting);
      if (p && p.kind !== 'unknown' && p.kind !== 'phi') {
        const delta = def.sub === 'sub' ? -bc : bc;
        out = { ...p, offset: (p.offset || 0n) + delta, valueId: value.id, via: def.sub + '-constant' };
      }
    } else if (def.sub === 'add' && ac != null && b && b.value) {
      const p = pointerProvenance(b.value, visiting);
      if (p && p.kind !== 'unknown' && p.kind !== 'phi') {
        out = { ...p, offset: (p.offset || 0n) + ac, valueId: value.id, via: 'add-constant' };
      }
    }
  }

  if (!out) out = { kind: 'unknown', root: 'value:' + value.id, offset: 0n, must: true, valueId: value.id };
  visiting.delete(value);
  provenanceMemo.set(value, out);
  return out;
}

function effectiveLocation(loc) {
  if (!loc) return null;
  if (loc.kind === MK.UNKNOWN) return { kind: MK.UNKNOWN, key: 'unknown', size: loc.size || null, must: false };
  if (loc.kind === MK.STACK) return { kind: MK.STACK, root: 'stack', disp: loc.disp || 0n, size: loc.size || null, must: true };
  if (loc.kind === MK.GLOBAL) return { kind: MK.GLOBAL, root: 'global', address: loc.address, size: loc.size || null, must: true };
  if (loc.kind !== MK.FIELD || !loc.base || loc.disp == null) return { kind: loc.kind, must: false, size: loc.size || null };

  const p = pointerProvenance(loc.base);
  if (!p || p.must === false || p.kind === 'phi') {
    return { kind: MK.FIELD, root: p ? p.root : null, disp: loc.disp, size: loc.size || null, must: false };
  }
  const off = (p.offset || 0n) + loc.disp;
  if (p.kind === 'stack') return { kind: MK.STACK, root: 'stack', disp: off, size: loc.size || null, must: true };
  if (p.kind === 'global' && p.address != null) {
    return { kind: MK.GLOBAL, root: 'global', address: p.address + off, size: loc.size || null, must: true };
  }
  return { kind: MK.FIELD, root: p.root, disp: off, size: loc.size || null, must: p.must !== false, provenance: p };
}

function sizeCompatible(a, b) {
  if (a.size == null || b.size == null) return true;
  return a.size === b.size;
}

/** True only when the two locations are proved identical. */
export function mustAlias(a, b) {
  if (!a || !b || a.kind === MK.UNKNOWN || b.kind === MK.UNKNOWN) return false;
  const x = effectiveLocation(a), y = effectiveLocation(b);
  if (!x || !y || x.must === false || y.must === false || x.kind !== y.kind) return false;
  if (!sizeCompatible(x, y)) return false;
  if (x.kind === MK.STACK) return x.disp != null && x.disp === y.disp;
  if (x.kind === MK.GLOBAL) return x.address != null && x.address === y.address;
  return x.kind === MK.FIELD && x.root != null && x.root === y.root && x.disp != null && x.disp === y.disp;
}

/** Conservative may-alias query that understands pointer+constant provenance. */
export function mayAliasProvenance(a, b) {
  if (!a || !b) return true;
  if (mustAlias(a, b)) return true;
  const x = effectiveLocation(a), y = effectiveLocation(b);
  if (!x || !y || x.kind === MK.UNKNOWN || y.kind === MK.UNKNOWN) return true;
  if (x.kind !== y.kind) {
    if (x.kind === MK.FIELD || y.kind === MK.FIELD) return true;
    return false;
  }
  if (x.kind === MK.STACK || x.kind === MK.GLOBAL) {
    const pa = x.kind === MK.STACK ? x.disp : x.address;
    const pb = y.kind === MK.STACK ? y.disp : y.address;
    if (pa == null || pb == null) return true;
    const sa = BigInt(x.size || 8), sb = BigInt(y.size || 8);
    return !(pa + sa <= pb || pb + sb <= pa);
  }
  if (x.kind === MK.FIELD && x.root && y.root && x.root === y.root && x.disp != null && y.disp != null) {
    const sa = BigInt(x.size || 8), sb = BigInt(y.size || 8);
    return !(x.disp + sa <= y.disp || y.disp + sb <= x.disp);
  }
  return true;
}

/* ── Value range / signedness / nullability ─────────────────── */

function typeBounds(bits, signed) {
  const n = BigInt(Math.max(1, Math.min(64, bits || 64)));
  if (signed === true) return { min: -(1n << (n - 1n)), max: (1n << (n - 1n)) - 1n };
  return { min: 0n, max: (1n << n) - 1n };
}

function mergeRange(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return { min: a.min < b.min ? a.min : b.min, max: a.max > b.max ? a.max : b.max };
}

function rangeEq(a, b) {
  return !!a === !!b && (!a || (a.min === b.min && a.max === b.max));
}

function argumentRange(arg) {
  return arg && arg.value ? arg.value.range : null;
}

function annotateValueRanges(ir) {
  if (!ir || !ir.values) return ir;
  for (const v of ir.values) {
    if (v.const != null) v.range = { min: v.const, max: v.const };
  }

  const maxRounds = 6;
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    for (const inst of ir.instructions || []) {
      if (!inst.dst || inst.dst.const != null) continue;
      const bits = inst.dst.bits || 64;
      let next = null;
      if (inst.op === OP.MOV && inst.args[0]) next = argumentRange(inst.args[0]);
      else if (inst.op === OP.UN && inst.args[0] && /^(uxt8|uxt16|uxt32)$/.test(inst.sub || '')) {
        const b = Number((inst.sub.match(/\d+/) || ['64'])[0]);
        next = { min: 0n, max: (1n << BigInt(b)) - 1n };
      } else if (inst.op === OP.BIN && inst.args.length >= 2) {
        const a = argumentRange(inst.args[0]);
        const b = argumentRange(inst.args[1]);
        const ac = shiftedConst(inst.args[0]);
        const bc = shiftedConst(inst.args[1]);
        const bounds = typeBounds(bits, inst.dst.signed);
        if (inst.sub === 'and') {
          const mask = bc != null ? bc : ac;
          if (mask != null && mask >= 0n) next = { min: 0n, max: mask < bounds.max ? mask : bounds.max };
        } else if ((inst.sub === 'lshr' || inst.sub === 'ashr') && a && bc != null && bc >= 0n && bc < BigInt(bits)) {
          if (inst.sub === 'lshr' && a.min >= 0n) next = { min: a.min >> bc, max: a.max >> bc };
        } else if (inst.sub === 'shl' && a && bc != null && bc >= 0n && bc < BigInt(bits)) {
          const min = a.min << bc, max = a.max << bc;
          if (min >= bounds.min && max <= bounds.max) next = { min, max };
        } else if (inst.sub === 'add') {
          if (a && bc != null) {
            const min = a.min + bc, max = a.max + bc;
            if (min >= bounds.min && max <= bounds.max) next = { min, max };
          } else if (b && ac != null) {
            const min = b.min + ac, max = b.max + ac;
            if (min >= bounds.min && max <= bounds.max) next = { min, max };
          }
        } else if (inst.sub === 'sub' && a && bc != null) {
          const min = a.min - bc, max = a.max - bc;
          if (min >= bounds.min && max <= bounds.max) next = { min, max };
        }
      } else if (inst.op === OP.PHI && inst.args.length) {
        let merged = null, complete = true;
        for (const a of inst.args) {
          const r = argumentRange(a);
          if (!r) { complete = false; break; }
          merged = mergeRange(merged, r);
        }
        if (complete) next = merged;
      } else if (inst.op === OP.SEL && inst.args.length >= 2) {
        const a = argumentRange(inst.args[0]), b = argumentRange(inst.args[1]);
        if (a && b) next = mergeRange(a, b);
      }
      if (next && !rangeEq(inst.dst.range, next)) { inst.dst.range = { ...next }; changed = true; }
    }
    if (!changed) break;
  }
  return ir;
}

export function valueRange(value) {
  if (!value) return null;
  if (value.const != null) return { min: value.const, max: value.const };
  return value.range ? { min: value.range.min, max: value.range.max } : null;
}

export function valueInfo(value) {
  if (!value) return {
    constant: null, min: null, max: null, signedness: 'unknown', zero: 'unknown', nullability: 'unknown', provenance: null,
  };
  const range = valueRange(value);
  let zero = 'unknown';
  if (value.const != null) zero = value.const === 0n ? 'zero' : 'non-zero';
  else if (range && range.min === 0n && range.max === 0n) zero = 'zero';
  else if (range && (range.min > 0n || range.max < 0n)) zero = 'non-zero';
  return {
    constant: value.const == null ? null : value.const,
    min: range ? range.min : null,
    max: range ? range.max : null,
    signedness: value.signed === true ? 'signed' : value.signed === false ? 'unsigned' : 'unknown',
    zero,
    nullability: value.nullable === true ? 'maybe-null' : value.nullable === false ? 'non-null' : 'unknown',
    provenance: pointerProvenance(value),
  };
}

function comparisonOfBranch(branch) {
  if (!branch || branch.op !== OP.CBR) return null;
  const kind = branch.extra && branch.extra.kind;
  if ((kind === 'cbz' || kind === 'cbnz') && branch.args[0] && branch.args[0].value) {
    return { lhs: branch.args[0].value, rhs: 0n, cond: kind === 'cbz' ? 'eq' : 'ne', cmp: null };
  }
  const flags = branch.args[0] && branch.args[0].value;
  const cmp = flags && flags.def && flags.def.op === OP.CMP ? flags.def : null;
  if (!cmp || !cmp.args[0] || !cmp.args[0].value || !cmp.args[1] || !cmp.args[1].value) return null;
  const rhs = shiftedConst(cmp.args[1]);
  if (rhs == null) return null;
  return { lhs: cmp.args[0].value, rhs, cond: branch.cond || null, cmp };
}

function invertRel(op) {
  return ({ '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<' })[op] || null;
}

function constrainedRange(value, op, constant, signed) {
  const bounds = typeBounds(value && value.bits || 64, signed);
  let min = bounds.min, max = bounds.max;
  if (op === '==') min = max = constant;
  else if (op === '<') max = constant - 1n;
  else if (op === '<=') max = constant;
  else if (op === '>') min = constant + 1n;
  else if (op === '>=') min = constant;
  else return null;
  const existing = valueRange(value);
  if (existing) { if (existing.min > min) min = existing.min; if (existing.max < max) max = existing.max; }
  if (min > max) return { min, max, impossible: true };
  return { min, max };
}

/** Range that is true on one edge of a conditional branch. Does not mutate SSA globally. */
export function rangeOnBranch(ir, branch, taken = true) {
  void ir;
  const c = comparisonOfBranch(branch);
  if (!c || !c.cond) return null;
  const info = c.cond === 'eq' || c.cond === 'ne' ? { op: c.cond === 'eq' ? '==' : '!=', signed: null } : COND[c.cond];
  if (!info || !info.op) return null;
  const op = taken ? info.op : invertRel(info.op);
  const signed = info.signed == null ? (c.lhs.signed === true) : info.signed;
  const range = constrainedRange(c.lhs, op, c.rhs, signed);
  return {
    value: c.lhs,
    condition: op,
    constant: c.rhs,
    signedness: signed ? 'signed' : 'unsigned',
    range,
    taken: !!taken,
    branch,
    compare: c.cmp,
  };
}

export function branchConstraints(ir) {
  if (!ir) return [];
  if (ir._branchConstraints) return ir._branchConstraints;
  const out = [];
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.CBR) continue;
    const yes = rangeOnBranch(ir, inst, true);
    const no = rangeOnBranch(ir, inst, false);
    if (yes || no) out.push({ branch: inst, taken: yes, fallthrough: no });
  }
  ir._branchConstraints = out;
  return out;
}

/* ── Stable value origin ────────────────────────────────────── */

function originIdentity(o) {
  if (!o) return null;
  if (o.kind === 'field' || o.kind === 'stack') return o.kind + ':' + (o.location && o.location.key || '');
  if (o.kind === 'global') return 'global:' + String(o.address);
  if (o.kind === 'argument') return 'arg:' + o.reg;
  if (o.kind === 'constant') return 'const:' + String(o.value);
  if (o.kind === 'call') return 'call:' + String(o.instructionId);
  return null;
}

const originMemo = new WeakMap();
export function originOf(value, active) {
  if (!value) return null;
  if (originMemo.has(value)) return originMemo.get(value);
  const visiting = active || new Set();
  if (visiting.has(value)) return null;
  visiting.add(value);
  const def = value.def;
  let out = null;
  if (def && def.op === OP.LOAD && def.loc) {
    if (def.loc.kind === MK.GLOBAL) out = { kind: 'global', address: def.loc.address, location: def.loc, row: def.row, addressOfInstruction: def.address };
    else out = { kind: def.loc.kind === MK.STACK ? 'stack' : 'field', location: def.loc, row: def.row, address: def.address };
  } else if (def && def.op === OP.CALL) {
    out = { kind: 'call', target: def.extra && def.extra.target != null ? def.extra.target : null,
      instructionId: def.id, row: def.row, address: def.address };
  } else if (def && (def.op === OP.MOV || (def.op === OP.UN && /^(sxt|uxt|fmov)/.test(def.sub || ''))) && def.args[0]) {
    out = originOf(def.args[0].value, visiting);
  } else if (def && def.op === OP.PHI && def.args && def.args.length) {
    const os = def.args.map((a) => originOf(a && a.value, visiting));
    const keys = os.map(originIdentity);
    if (keys[0] && keys.every((k) => k === keys[0])) out = os[0];
  } else if (value.kind === VK.ARG && /^x[0-7]$/.test(String(value.reg || ''))) {
    out = { kind: 'argument', reg: value.reg };
  } else if (value.const != null) {
    out = { kind: 'constant', value: value.const };
  } else if (def) {
    out = { kind: 'computed', op: def.op, sub: def.sub || null, row: def.row, address: def.address };
  }
  visiting.delete(value);
  originMemo.set(value, out);
  return out;
}

/** Build Semantic IR with all public safety/value annotations. */
export function buildIR(model, opts) {
  const ir = buildCoreIR(model, normalizedOptions(model, opts));
  if (!ir) return null;
  promoteResolvedGlobals(ir);
  hardenUnknownStores(ir);
  annotateValueRanges(ir);
  branchConstraints(ir);
  return ir;
}

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

/* ── RMW query using canonical pointer provenance ───────────── */

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
 * Read/modify/write proof. MOV/PHI/pointer+constant aliases are accepted only
 * when provenance proves must-alias; unknown indexed stores invalidate the path.
 */
export function readModifyWrite(ir) {
  if (!ir || !ir.instructions) return [];
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
    while (work.length && chain.length < 40) {
      const v = work.pop();
      if (!v || visited.has(v.id)) continue;
      visited.add(v.id);
      const def = v.def;
      if (!def) continue;
      chain.push(def);
      if (def.op === OP.LOAD) {
        if (mustAlias(def.loc, store.loc) && !unknownStoreBetween(ir, def, store)) load = def;
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
