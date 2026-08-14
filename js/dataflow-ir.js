/*
 * dataflow-ir.js — adapt Semantic IR / SSA / Memory SSA facts to the stable
 * dataflow.js public shape.
 *
 * This layer is intentionally narrow. It only emits a value update when ir.js can
 * prove that a load contributes to a store of the same Memory-SSA location. It does
 * not guess setters/moves and it never upgrades unknown memory to a concrete field.
 */

import { SCORE, ev, levelOf } from './blocks.js';
import { irFor, readModifyWrite, OP, MK } from './ir.js';

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
  // Prefer an input that is not part of the carried value. That is the amount,
  // cap, mask, etc. in `old + amount` / `min(old, cap)` patterns.
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

function stepFrom(inst, loadValue) {
  const op = operationName(inst);
  if (!op) return null;
  const otherValue = otherInput(inst, loadValue);
  return {
    op,
    imm: otherValue && otherValue.const != null ? otherValue.const : null,
    immFloat: null,
    other: otherValue && otherValue.reg ? otherValue.reg : null,
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
    self: false,
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

/*
 * The legacy and SSA adapters often describe the exact same machine observation.
 * `load@12` from two engines is one fact, not two independent facts. Keep one
 * evidence item per (code,row), preferring the SSA-enriched detail when present.
 */
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

/**
 * Return only updates proven by SSA + Memory SSA.
 * The result deliberately matches the historical findValueUpdates() structure.
 */
export function findIrValueUpdates(model, opts) {
  if (!model || !model.instructions || !model.instructions.length) return [];
  const ir = irFor(model, opts && opts.ir);
  if (!ir) return [];

  const out = [];
  for (const rmw of readModifyWrite(ir)) {
    const location = locationShape(rmw);
    if (!location) continue; // never turn an unknown alias into a field claim
    const load = rmw.load;
    const store = rmw.store;
    if (!load || !store || !load.dst) continue;

    const steps = (rmw.chain || [])
      .slice()
      .sort((a, b) => (a.row || 0) - (b.row || 0))
      .map((inst) => stepFrom(inst, load.dst))
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

/**
 * Overlay proven IR updates on top of legacy results. Same-store results are
 * merged instead of duplicated so ranking does not accidentally count two engines
 * as two independent observations of the same machine instructions.
 */
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
    out[pos] = {
      ...old,
      ...ir,
      location: { ...(old.location || {}), ...(ir.location || {}) },
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
