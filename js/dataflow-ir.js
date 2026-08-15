/*
 * dataflow-ir.js — adapt Semantic IR / SSA / Memory SSA facts to the stable
 * dataflow.js public shape.
 *
 * This layer is intentionally narrow. It only emits a value update when ir.js can
 * prove that a load contributes to a store of the same Memory-SSA location. It does
 * not guess setters/moves and it never upgrades unknown memory to a concrete field.
 */

import { SCORE, ev, levelOf } from './blocks.js';
import { irFor, readModifyWrite, OP, MK, VK } from './ir.js';

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

const PASS_UN = new Set(['sxt8', 'sxt16', 'sxt32', 'uxt8', 'uxt16', 'uxt32', 'fmov']);

function valueDependsOn(value, targetId, memo = new Map(), active = new Set()) {
  if (!value) return false;
  if (value.id === targetId) return true;
  if (memo.has(value.id)) return memo.get(value.id);
  if (active.has(value.id)) return false;
  active.add(value.id);
  const def = value.def;
  let yes = false;
  if (def) {
    for (const a of def.args || []) {
      if (a && a.value && valueDependsOn(a.value, targetId, memo, active)) {
        yes = true;
        break;
      }
    }
  }
  active.delete(value.id);
  memo.set(value.id, yes);
  return yes;
}

function otherInput(inst, loadValue) {
  const args = (inst.args || []).filter((a) => a && a.value);
  if (!args.length || !loadValue) return null;
  const memo = new Map();
  const dep = args.map((a) => valueDependsOn(a.value, loadValue.id, memo));
  for (let i = 0; i < args.length; i++) if (!dep[i]) return args[i].value;
  return null;
}

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

function originKey(o) {
  if (!o) return null;
  if (o.kind === 'field' || o.kind === 'stack') {
    // A physical register name is not an object identity. Include the SSA base
    // value and Memory-SSA location so PHI arms that merely reuse x19/x20 do not
    // collapse Player.field_20 and Enemy.field_20 into one origin.
    return [o.kind, o.base || '', o.baseValueId ?? '', o.locationKey ?? '', o.disp ?? '', o.size ?? ''].map(String).join(':');
  }
  if (o.kind === 'global') return 'global:' + String(o.address ?? '');
  if (o.kind === 'imm') return 'imm:' + String(o.value);
  if (o.kind === 'arg') return 'arg:' + String(o.reg || '');
  if (o.kind === 'call') return 'call:' + String(o.row ?? '') + ':' + String(o.target ?? '');
  return null;
}

/**
 * Convert an SSA value into the small, acyclic origin shape used by legacy
 * amountOf()/role logic. This follows only proof-preserving copies and identical
 * phi inputs; conflicting phi origins remain unknown.
 */
function stableOrigin(value, callByRow, memo = new Map(), active = new Set()) {
  if (!value) return null;
  if (memo.has(value.id)) return memo.get(value.id);
  if (active.has(value.id)) return null;
  active.add(value.id);

  const def = value.def;
  let out = null;
  if (def && def.op === OP.LOAD && def.loc) {
    if (def.loc.kind === MK.FIELD) {
      out = {
        kind: 'field',
        base: (def.addr && def.addr.baseReg) || null,
        baseValueId: def.addr?.base?.id ?? null,
        locationKey: def.loc.key ?? null,
        disp: def.loc.disp,
        size: def.loc.size || (def.extra && def.extra.size) || null,
        indexAddr: null,
        row: def.row,
        address: def.address,
        engine: 'ir-ssa',
      };
    } else if (def.loc.kind === MK.STACK) {
      out = {
        kind: 'stack',
        base: (def.addr && def.addr.baseReg) || 'sp',
        baseValueId: def.addr?.base?.id ?? null,
        locationKey: def.loc.key ?? null,
        disp: def.loc.disp,
        size: def.loc.size || (def.extra && def.extra.size) || null,
        row: def.row,
        address: def.address,
        engine: 'ir-ssa',
      };
    } else if (def.loc.kind === MK.GLOBAL) {
      out = { kind: 'global', address: def.loc.address, size: def.loc.size || null, row: def.row, engine: 'ir-ssa' };
    }
  } else if (def && def.op === OP.CALL) {
    const call = callByRow.get(def.row) || null;
    out = {
      kind: 'call',
      name: call ? call.name || null : null,
      selector: call ? call.selector || null : null,
      target: call && call.target != null ? call.target : (def.extra ? def.extra.target : null),
      row: def.row,
      engine: 'ir-ssa',
    };
  } else if (def && def.op === OP.MOV && def.args && def.args[0]) {
    out = stableOrigin(def.args[0].value, callByRow, memo, active);
  } else if (def && def.op === OP.UN && PASS_UN.has(def.sub) && def.args && def.args[0]) {
    out = stableOrigin(def.args[0].value, callByRow, memo, active);
  } else if (def && def.op === OP.PHI && def.args && def.args.length) {
    const origins = def.args.map((a) => stableOrigin(a && a.value, callByRow, memo, active));
    const keys = origins.map(originKey);
    if (keys.length && keys[0] && keys.every((k) => k === keys[0])) out = origins[0];
  } else if (value.kind === VK.ARG && value.reg) {
    out = { kind: 'arg', reg: value.reg, engine: 'ir-ssa' };
  } else if (value.const != null) {
    out = { kind: 'imm', value: value.const, row: def ? def.row : null, engine: 'ir-ssa' };
  } else if (def) {
    const op = operationName(def);
    if (op) out = { kind: 'computed', op, row: def.row, address: def.address, engine: 'ir-ssa' };
  }

  active.delete(value.id);
  memo.set(value.id, out);
  return out;
}

function stepFrom(inst, loadValue, callByRow, originMemo) {
  const op = operationName(inst);
  if (!op) return null;
  const otherValue = otherInput(inst, loadValue);
  const otherOrigin = stableOrigin(otherValue, callByRow, originMemo);
  return {
    op,
    imm: otherValue && otherValue.const != null ? otherValue.const : null,
    immFloat: null,
    other: otherValue && otherValue.reg ? otherValue.reg : null,
    otherOrigin,
    row: inst.row,
    address: inst.address,
    engine: 'ir-ssa',
  };
}

function locationShape(rmw) {
  const loc = rmw.location;
  const store = rmw.store;
  const load = rmw.load;
  if (!loc || loc.kind === MK.UNKNOWN) return null;

  const base = (store.addr && store.addr.baseReg) || (load.addr && load.addr.baseReg) || null;
  const disp = loc.disp != null ? loc.disp : 0n;
  let key = null;
  if (loc.kind === MK.GLOBAL && loc.address != null) key = 'global@' + loc.address.toString(16);
  else if (base && loc.kind === MK.STACK) key = base + '@' + disp.toString();
  else if (base && loc.kind === MK.FIELD) key = base + '@' + disp.toString();

  return {
    base,
    disp,
    size: loc.size || (store.extra && store.extra.size) || null,
    stack: loc.kind === MK.STACK,
    key,
    indexAddr: null,
    // IR can prove a location without proving that the base is Objective-C
    // `self`. Unknown must remain null rather than overwriting legacy true.
    self: null,
    irKey: loc.key,
    irKind: loc.kind,
  };
}

function rowIdentity(u) {
  const row = u && u.store && u.store.row != null ? u.store.row : -1;
  const disp = u && u.location && u.location.disp != null ? String(u.location.disp) : '?';
  const stack = u && u.location && u.location.stack ? 's' : 'm';
  return row + ':' + disp + ':' + stack;
}

function mergeEvidence(legacy, proven) {
  const byFact = new Map();
  for (const item of [...(legacy || []), ...(proven || [])]) {
    if (!item) continue;
    const key = String(item.code || '') + ':' + String(item.row == null ? -1 : item.row);
    const prev = byFact.get(key);
    const isSsa = !!(item.detail && item.detail.engine === 'ir-ssa');
    const prevSsa = !!(prev && prev.detail && prev.detail.engine === 'ir-ssa');
    if (!prev || (isSsa && !prevSsa)) byFact.set(key, item);
  }
  return Array.from(byFact.values()).sort((a, b) =>
    (a.row == null ? -1 : a.row) - (b.row == null ? -1 : b.row));
}

export function findIrValueUpdates(model, opts) {
  if (!model || !model.instructions || !model.instructions.length) return [];
  const ir = irFor(model, opts && opts.ir);
  if (!ir) return [];

  const callByRow = new Map((model.calls || []).map((c) => [c.row, c]));
  const originMemo = new Map();
  const out = [];
  for (const rmw of readModifyWrite(ir)) {
    const location = locationShape(rmw);
    if (!location) continue;
    const load = rmw.load;
    const store = rmw.store;
    if (!load || !store || !load.dst) continue;

    const steps = (rmw.chain || [])
      .slice()
      .sort((a, b) => (a.row || 0) - (b.row || 0))
      .map((inst) => stepFrom(inst, load.dst, callByRow, originMemo))
      .filter(Boolean);

    const evidence = [
      ev('load', load.row, { base: location.base, disp: location.disp, engine: 'ir-ssa' }),
      ...steps.map((s) => ev('compute', s.row, { op: s.op, imm: s.imm, engine: 'ir-ssa' })),
      ev('store', store.row, { base: location.base, disp: location.disp, engine: 'ir-ssa' }),
    ];

    const reg = store.args && store.args[0] && store.args[0].value
      ? store.args[0].value.reg || null : null;
    out.push({
      kind: 'read-modify-write',
      operationKind: rmw.kind,
      engine: 'ir-ssa',
      location,
      from: {
        row: load.row,
        address: load.address,
        base: (load.addr && load.addr.baseReg) || location.base,
        disp: location.disp,
        size: location.size,
        key: location.key,
      },
      steps,
      store: { row: store.row, address: store.address, reg },
      register: reg,
      confidence: steps.length ? SCORE.confirmed : SCORE.high,
      level: levelOf(steps.length ? SCORE.confirmed : SCORE.high),
      evidence,
      ir: { location: rmw.location, load, store },
    });
  }
  out.sort((a, b) => b.confidence - a.confidence || a.store.row - b.store.row);
  return out;
}

export function mergeValueUpdates(legacy, proven) {
  const out = (legacy || []).slice();
  const at = new Map(out.map((u, i) => [rowIdentity(u), i]));
  for (const ir of proven || []) {
    const key = rowIdentity(ir);
    const pos = at.get(key);
    if (pos == null) {
      at.set(key, out.length);
      out.push(ir);
      continue;
    }
    const old = out[pos];
    const irLocation = { ...(ir.location || {}) };
    if (irLocation.self == null) delete irLocation.self;
    out[pos] = {
      ...old,
      ...ir,
      location: { ...(old.location || {}), ...irLocation },
      from: { ...(old.from || {}), ...(ir.from || {}) },
      evidence: mergeEvidence(old.evidence, ir.evidence),
      legacyConfidence: old.confidence,
      engine: 'ir-ssa',
    };
  }
  out.sort((a, b) => b.confidence - a.confidence ||
    ((a.store && a.store.row) || 0) - ((b.store && b.store.row) || 0));
  return out;
}
