/*
 * dataflow-semantic.js — non-RMW Semantic Facts -> stable dataflow API.
 *
 * RMW stays in dataflow-ir.js. This adapter covers direct reads/writes/transfers
 * so the compatibility API no longer needs legacy ARM64 scanning when IR exists.
 */
import { SCORE, ev, levelOf } from './blocks.js';
import { irFor, OP, MK, originOf, pointerProvenance, mustAlias } from './ir.js';
import { semanticFacts, FACT } from './semantic.js';

const BIN_NAME = {
  add: 'add', sub: 'sub', mul: 'mul', sdiv: 'sdiv', udiv: 'udiv',
  smull: 'smull', umull: 'umull', smulh: 'smulh', umulh: 'umulh',
  and: 'and', or: 'orr', xor: 'eor', bic: 'bic', orn: 'orn', eon: 'eon',
  shl: 'lsl', lshr: 'lsr', ashr: 'asr', ror: 'ror',
  fadd: 'fadd', fsub: 'fsub', fmul: 'fmul', fdiv: 'fdiv',
};
const UN_NAME = {
  neg: 'neg', not: 'mvn', fneg: 'fneg', fmov: 'fmov',
  sxt8: 'sxtb', sxt16: 'sxth', sxt32: 'sxtw',
  uxt8: 'uxtb', uxt16: 'uxth', uxt32: 'uxtw',
};
const PASS_UN = new Set([
  'sxt8', 'sxt16', 'sxt32', 'uxt8', 'uxt16', 'uxt32', 'fmov',
  'sext', 'zext', 'trunc', 'bitcast',
]);

function operationName(inst) {
  if (!inst) return null;
  if (inst.op === OP.BIN) return BIN_NAME[inst.sub] || inst.sub || null;
  if (inst.op === OP.MAC) return inst.sub === 'msub' ? 'msub' : 'madd';
  if (inst.op === OP.UN) return UN_NAME[inst.sub] || inst.sub || null;
  if (inst.op === OP.SEL) {
    if (inst.sub === 'inc') return 'csinc';
    if (inst.sub === 'inv') return 'csinv';
    if (inst.sub === 'neg') return 'csneg';
    return 'csel';
  }
  if (inst.op === OP.MOV) return 'mov';
  return null;
}

function locationShape(inst, loc) {
  if (!loc || loc.kind === MK.UNKNOWN) return null;
  const p = loc.kind === MK.FIELD && loc.base ? pointerProvenance(loc.base) : null;
  let disp = loc.disp != null ? loc.disp : 0n;
  let base = inst && inst.addr ? inst.addr.baseReg : null;
  if (loc.kind === MK.FIELD && p && p.must !== false && p.kind !== 'phi') {
    disp += p.offset || 0n;
    if (p.arg) base = p.arg;
  }
  return {
    base,
    disp,
    size: loc.size || (inst && inst.extra && inst.extra.size) || null,
    stack: loc.kind === MK.STACK,
    key: loc.kind === MK.GLOBAL && loc.address != null
      ? 'global@' + loc.address.toString(16)
      : (base ? base + '@' + disp.toString() : loc.key || null),
    indexAddr: null,
    self: false,
    irKey: loc.key,
    irKind: loc.kind,
  };
}

function updateEvidence(kind, inst, extra) {
  return [ev(kind === 'read' ? 'load' : 'store', inst.row, {
    base: inst.addr ? inst.addr.baseReg : null,
    disp: inst.loc && inst.loc.disp,
    engine: 'ir-semantic',
    ...(extra || {}),
  })];
}

function compatOrigin(value) {
  if (!value) return null;
  if (value.const != null) return { kind: 'imm', value: value.const, engine: 'ir-semantic' };
  const def = value.def;
  if (def && def.op === OP.LOAD && def.loc) {
    if (def.loc.kind === MK.FIELD) return {
      kind: 'field', base: def.addr && def.addr.baseReg || null, disp: def.loc.disp,
      size: def.loc.size || null, row: def.row, address: def.address, engine: 'ir-semantic',
    };
    if (def.loc.kind === MK.GLOBAL) return {
      kind: 'global', address: def.loc.address, size: def.loc.size || null,
      row: def.row, engine: 'ir-semantic',
    };
    if (def.loc.kind === MK.STACK) return {
      kind: 'stack', base: def.addr && def.addr.baseReg || 'sp', disp: def.loc.disp,
      size: def.loc.size || null, row: def.row, address: def.address, engine: 'ir-semantic',
    };
  }
  const origin = originOf(value);
  if (!origin) return null;
  if (origin.kind === 'argument') return { kind: 'arg', reg: origin.reg, engine: 'ir-semantic' };
  if (origin.kind === 'call') return { kind: 'call', target: origin.target, row: origin.row, engine: 'ir-semantic' };
  if (origin.kind === 'constant') return { kind: 'imm', value: origin.value, engine: 'ir-semantic' };
  if (origin.kind === 'global') return { kind: 'global', address: origin.address, engine: 'ir-semantic' };
  if ((origin.kind === 'field' || origin.kind === 'stack') && origin.location) {
    return {
      kind: origin.kind,
      base: origin.location.base && origin.location.base.reg || null,
      disp: origin.location.disp,
      size: origin.location.size || null,
      row: origin.row,
      address: origin.address,
      engine: 'ir-semantic',
    };
  }
  return { kind: 'computed', op: origin.op || null, row: origin.row, address: origin.address, engine: 'ir-semantic' };
}

function sameLoadLocation(a, b) {
  return !!(a && b && a.loc && b.loc && a.loc.key && a.loc.key === b.loc.key);
}

function originFingerprint(origin) {
  if (!origin) return 'none';
  const value = origin.value != null ? String(origin.value) : '';
  const address = origin.address != null ? String(origin.address) : '';
  const location = origin.location ? String(origin.location.key || origin.location.address || origin.location.disp || '') : '';
  return [origin.kind || '', origin.reg || '', origin.op || '', origin.sub || '', value, address, location].join('|');
}

function sameSemanticStep(a, b) {
  if (!a || !b) return a === b;
  return a.op === b.op && a.imm === b.imm && a.immFloat === b.immFloat &&
    (a.sourceOperandIndex ?? null) === (b.sourceOperandIndex ?? null) &&
    (a.other || null) === (b.other || null) && originFingerprint(a.otherOrigin) === originFingerprint(b.otherOrigin);
}

function sameComputationPath(a, b) {
  return !!(a && b && sameLoadLocation(a.load, b.load) && a.steps.length === b.steps.length &&
    a.steps.every((step, index) => sameSemanticStep(step, b.steps[index])));
}

/**
 * Follow the stored SSA value back to a memory source while preserving the
 * computation chain. This is def-use traversal, not a second ARM64 scanner.
 */
function computationPath(value, active = new Set()) {
  if (!value || active.has(value.id)) return null;
  active.add(value.id);
  const def = value.def;
  let out = null;
  if (def && def.op === OP.LOAD && def.loc && def.loc.kind !== MK.UNKNOWN) {
    out = { load: def, steps: [] };
  } else if (def && def.op === OP.MOV && def.args[0]) {
    out = computationPath(def.args[0].value, active);
  } else if (def && def.op === OP.UN && PASS_UN.has(def.sub) && def.args[0]) {
    out = computationPath(def.args[0].value, active);
    if (out && !out.ambiguous) out = { load: out.load, steps: out.steps.concat([{
      op: operationName(def), imm: null, immFloat: null, other: null, otherOrigin: null,
      row: def.row, address: def.address, engine: 'ir-semantic',
    }]) };
  } else if (def && def.op === OP.PHI && def.args && def.args.length) {
    const paths = def.args.map((a) => computationPath(a && a.value, new Set(active))).filter(Boolean);
    if (paths.length === def.args.length && paths.length && paths.every((p) => sameLoadLocation(paths[0].load, p.load))) {
      if (paths.every((p) => sameComputationPath(paths[0], p))) out = paths[0];
      else out = { load: paths[0].load, steps: [], ambiguous: true, alternatives: paths };
    }
  } else if (def && [OP.BIN, OP.MAC, OP.UN, OP.SEL].includes(def.op)) {
    const args = (def.args || []).filter((a) => a && a.value);
    let chosen = -1;
    let path = null;
    for (let i = 0; i < args.length; i++) {
      const p = computationPath(args[i].value, new Set(active));
      if (p) { chosen = i; path = p; break; }
    }
    if (path) {
      if (path.ambiguous) out = path;
      else {
        const other = args.find((_, i) => i !== chosen);
        const ov = other && other.value || null;
        const opname = operationName(def);
        const step = opname ? {
          op: opname,
          imm: ov && ov.const != null ? ov.const : null,
          immFloat: null,
          other: ov && ov.reg || null,
          otherOrigin: compatOrigin(ov),
          sourceOperandIndex: chosen,
          sourceOnLeft: chosen === 0,
          row: def.row,
          address: def.address,
          engine: 'ir-semantic',
        } : null;
        out = { load: path.load, steps: step ? path.steps.concat([step]) : path.steps.slice() };
      }
    }
  }
  active.delete(value.id);
  return out;
}

function directWrites(ir, facts, rmwRows) {
  const out = [];
  const transferRows = new Set(facts.filter((f) => f.kind === FACT.TRANSFER).map((f) => f.row));
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.STORE || rmwRows.has(inst.row) || !inst.loc) continue;
    if (inst.loc.kind === MK.UNKNOWN || inst.loc.kind === MK.STACK || inst.loc.kind === MK.GLOBAL) continue;
    const location = locationShape(inst, inst.loc);
    if (!location || location.key == null) continue;
    const value = inst.args[0] && inst.args[0].value || null;
    const path = computationPath(value);
    const sourceLocation = path && path.load ? locationShape(path.load, path.load.loc) : null;
    const isTransfer = !!(path && path.load && !mustAlias(path.load.loc, inst.loc));
    const kind = transferRows.has(inst.row) || isTransfer ? 'move' : 'write';
    const reg = value ? value.reg || null : null;
    const ambiguous = !!path?.ambiguous;
    const confidence = ambiguous ? SCORE.inferred : SCORE.high;
    const alternatives = ambiguous ? (path.alternatives || []).map((candidate) => ({
      from: candidate.load ? { row: candidate.load.row, address: candidate.load.address } : null,
      steps: candidate.steps.map((s) => ({ op: s.op, imm: s.imm, immFloat: s.immFloat, otherOrigin: s.otherOrigin || null,
        sourceOperandIndex: s.sourceOperandIndex ?? null, sourceOnLeft: s.sourceOnLeft ?? null, row: s.row, address: s.address })),
    })) : null;
    out.push({
      kind,
      operationKind: kind === 'move' ? (ambiguous ? 'branch-transfer' : (path && path.steps.length ? 'computed-transfer' : 'copy')) : null,
      engine: 'ir-semantic',
      location,
      from: path && path.load && sourceLocation ? {
        row: path.load.row,
        address: path.load.address,
        base: sourceLocation.base,
        disp: sourceLocation.disp,
        size: sourceLocation.size,
        key: sourceLocation.key,
      } : null,
      steps: path && !ambiguous ? path.steps : [],
      alternatives,
      branchDependent: ambiguous,
      store: { row: inst.row, address: inst.address, reg },
      register: reg,
      origin: compatOrigin(value),
      confidence,
      level: levelOf(confidence),
      evidence: [
        ...(path && path.load ? updateEvidence('read', path.load) : []),
        ...(path && !ambiguous ? path.steps.map((s) => ev('compute', s.row, { op: s.op, imm: s.imm, engine: 'ir-semantic' })) : []),
        ...(ambiguous ? [ev('phi-alternatives', inst.row, { alternatives: alternatives.length, engine: 'ir-semantic' })] : []),
        ...updateEvidence('write', inst),
      ],
      ir: { location: inst.loc, load: path && path.load || null, store: inst },
    });
  }
  return out;
}

function rootLoad(value, active = new Set()) {
  if (!value || active.has(value.id)) return null;
  active.add(value.id);
  const def = value.def;
  if (!def) return null;
  if (def.op === OP.LOAD) return def;
  if ((def.op === OP.MOV || (def.op === OP.UN && PASS_UN.has(def.sub))) && def.args[0]) {
    return rootLoad(def.args[0].value, active);
  }
  if (def.op === OP.PHI && def.args && def.args.length) {
    const loads = def.args.map((a) => rootLoad(a && a.value, new Set(active))).filter(Boolean);
    if (loads.length === def.args.length && loads.every((l) => sameLoadLocation(loads[0], l))) return loads[0];
  }
  return null;
}

function returnedReads(ir) {
  const out = [];
  const covered = new Set();
  for (const ret of ir.instructions || []) {
    if (ret.op !== OP.RET) continue;
    const explicit = ret.args?.[0]?.value || null;
    const candidate = explicit || valueBefore(ir, ret, 'x0');
    if (!candidate) continue;
    const load = rootLoad(candidate);
    if (!load || !load.loc || load.loc.kind !== MK.FIELD) continue;
    const location = locationShape(load, load.loc);
    if (!location || location.key == null || covered.has(location.key)) continue;
    covered.add(location.key);
    const reg = candidate.reg || 'x0';
    const confidence = explicit ? SCORE.high : SCORE.inferred;
    out.push({
      kind: 'read',
      engine: 'ir-semantic',
      location,
      from: {
        row: load.row, address: load.address,
        base: load.addr ? load.addr.baseReg : location.base,
        disp: location.disp, size: location.size, key: location.key,
      },
      steps: [],
      store: { row: load.row, address: load.address, reg },
      register: reg,
      confidence,
      level: levelOf(confidence),
      evidence: [
        ...updateEvidence('read', load),
        ...(explicit ? [] : [ev('return-candidate', ret.row, { reg:'x0', reason:'terminal-field-load', engine:'ir-semantic' })]),
      ],
      ir: { location: load.loc, load, ret, returnCandidate: !explicit },
    });
  }
  return out;
}

const defsByInstructionCache = new WeakMap();
function defsByInstruction(ir) {
  if (defsByInstructionCache.has(ir)) return defsByInstructionCache.get(ir);
  const map = new Map();
  for (const v of ir.values || []) {
    if (!v || !v.def) continue;
    let list = map.get(v.def.id);
    if (!list) { list = []; map.set(v.def.id, list); }
    list.push(v);
  }
  defsByInstructionCache.set(ir, map);
  return map;
}

/* Find the SSA value of one register immediately before an instruction. */
export function valueBefore(ir, inst, reg) {
  if (!ir || !inst || !reg) return null;
  const defs = defsByInstruction(ir);
  let b = inst.block;
  let beforeRow = inst.row;
  const seen = new Set();
  while (b != null && b >= 0 && !seen.has(b)) {
    seen.add(b);
    const block = ir.blocks[b];
    if (!block) break;
    let best = null;
    for (const p of block.phis || []) {
      if (p.dst && p.dst.reg === reg && (b !== inst.block || p.row == null || p.row < beforeRow)) best = p.dst;
    }
    for (const i of block.insts || []) {
      if (b === inst.block && i.row >= beforeRow) break;
      if (i.dst && i.dst.reg === reg) best = i.dst;
      for (const v of defs.get(i.id) || []) if (v.reg === reg) best = v;
    }
    if (best) return best;
    b = block.idom;
    beforeRow = Number.MAX_SAFE_INTEGER;
  }
  return ir.args && ir.args.get ? ir.args.get(reg) || null : null;
}

function helperLocation(offsetValue) {
  if (!offsetValue) return null;
  if (offsetValue.const != null) {
    const disp = offsetValue.const;
    return {
      base: 'x0', disp, size: 8, stack: false,
      key: 'x0@' + disp.toString(), indexAddr: null, self: true,
      irKey: null, irKind: MK.FIELD,
    };
  }
  const load = rootLoad(offsetValue);
  if (load?.loc?.kind === MK.GLOBAL && load.loc.address != null) {
    return {
      base: 'x0', disp: null, size: 8, stack: false,
      key: 'x0@iv' + load.loc.address.toString(), indexAddr: load.loc.address, self: true,
      irKey: null, irKind: MK.FIELD,
    };
  }
  const origin = originOf(offsetValue);
  if (origin && origin.kind === 'global' && origin.address != null) {
    return {
      base: 'x0', disp: null, size: 8, stack: false,
      key: 'x0@iv' + origin.address.toString(), indexAddr: origin.address, self: true,
      irKey: null, irKind: MK.FIELD,
    };
  }
  return null;
}

const PROPERTY_HELPER_ABI = Object.freeze({
  getProperty: Object.freeze({ kind: 'read', offsetReg: 'x2', valueReg: 'x0' }),
  setProperty: Object.freeze({ kind: 'write', offsetReg: 'x2', valueReg: 'x3' }),
});

function propertyHelperUpdates(model, ir) {
  const out = [];
  const callMeta = new Map((model.calls || []).map((c) => [c.row, c]));
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.CALL && inst.op !== OP.BR) continue;
    const meta = callMeta.get(inst.row);
    const name = meta && meta.name || null;
    if (!name || !/objc_(getProperty|setProperty)/.test(name)) continue;
    const family = /objc_getProperty/.test(name) ? 'getProperty' : 'setProperty';
    const abi = PROPERTY_HELPER_ABI[family];
    const read = abi.kind === 'read';
    const offsetValue = valueBefore(ir, inst, abi.offsetReg);
    const location = helperLocation(offsetValue);
    if (!location) continue;
    const detail = {
      base: 'x0', disp: location.disp, indexAddr: location.indexAddr,
      helper: name, engine: 'ir-semantic',
    };
    out.push({
      kind: read ? 'read' : 'write',
      engine: 'ir-semantic',
      location,
      from: read ? { row: inst.row, address: inst.address, base: 'x0', disp: location.disp, size: 8, key: location.key } : null,
      steps: [],
      store: { row: inst.row, address: inst.address, reg: abi.valueReg },
      register: abi.valueReg,
      helper: name,
      confidence: SCORE.confirmed,
      level: levelOf(SCORE.confirmed),
      evidence: [ev(read ? 'load' : 'store', inst.row, detail)],
      ir: { call: inst },
    });
  }
  return out;
}

export function findIrSemanticUpdates(model, opts, rmwUpdates) {
  const ir = irFor(model, opts && opts.ir);
  if (!ir) return [];
  const facts = semanticFacts(ir);
  const rmwRows = new Set((rmwUpdates || []).filter((u) => u.store).map((u) => u.store.row));
  const out = [
    ...directWrites(ir, facts, rmwRows),
    ...returnedReads(ir),
    ...propertyHelperUpdates(model, ir),
  ];

  const seen = new Set();
  return out.filter((u) => {
    const k = u.kind + ':' + String(u.store && u.store.row) + ':' + String(u.location && u.location.key);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => b.confidence - a.confidence || (a.store.row - b.store.row));
}