/*
 * dataflow-semantic.js — non-RMW Semantic Facts -> stable dataflow API.
 *
 * RMW stays in dataflow-ir.js. This adapter covers direct reads/writes/transfers
 * so the compatibility API no longer needs legacy ARM64 scanning when IR exists.
 */
import { SCORE, ev, levelOf } from './blocks.js';
import { irFor, OP, MK, VK, originOf, pointerProvenance } from './ir.js';
import { semanticFacts, FACT } from './semantic.js';

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

function originKind(value) {
  const o = originOf(value);
  return o ? o.kind : null;
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
    const kind = transferRows.has(inst.row) ? 'move' : 'write';
    const reg = value ? value.reg || null : null;
    out.push({
      kind,
      operationKind: kind === 'move' ? 'copy' : null,
      engine: 'ir-semantic',
      location,
      from: null,
      steps: [],
      store: { row: inst.row, address: inst.address, reg },
      register: reg,
      origin: originOf(value),
      confidence: SCORE.high,
      level: levelOf(SCORE.high),
      evidence: updateEvidence('write', inst),
      ir: { location: inst.loc, store: inst },
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
  if ((def.op === OP.MOV || (def.op === OP.UN && /^(sxt|uxt|fmov)/.test(def.sub || ''))) && def.args[0]) {
    return rootLoad(def.args[0].value, active);
  }
  if (def.op === OP.PHI && def.args && def.args.length) {
    const loads = def.args.map((a) => rootLoad(a && a.value, new Set(active))).filter(Boolean);
    if (loads.length === def.args.length && loads.every((l) => l.loc && loads[0].loc && l.loc.key === loads[0].loc.key)) return loads[0];
  }
  return null;
}

function returnedReads(ir) {
  const out = [];
  const covered = new Set();
  for (const ret of ir.instructions || []) {
    if (ret.op !== OP.RET || !ret.args[0] || !ret.args[0].value) continue;
    const load = rootLoad(ret.args[0].value);
    if (!load || !load.loc || load.loc.kind !== MK.FIELD) continue;
    const location = locationShape(load, load.loc);
    if (!location || location.key == null || covered.has(location.key)) continue;
    covered.add(location.key);
    const reg = ret.args[0].value.reg || 'x0';
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
      confidence: SCORE.high,
      level: levelOf(SCORE.high),
      evidence: updateEvidence('read', load),
      ir: { location: load.loc, load, ret },
    });
  }
  return out;
}

/* Find the SSA value of one register immediately before an instruction. */
export function valueBefore(ir, inst, reg) {
  if (!ir || !inst || !reg) return null;
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
      // CALL clobber definitions other than x0 are not attached as inst.dst; those
      // values have def===i and the same register in ir.values.
      for (const v of ir.values || []) {
        if (v.reg === reg && v.def === i) best = v;
      }
    }
    if (best) return best;
    b = block.idom;
    beforeRow = Number.MAX_SAFE_INTEGER;
  }
  return ir.args && ir.args.get ? ir.args.get(reg) || null : null;
}

function propertyHelperUpdates(model, ir) {
  const out = [];
  const callMeta = new Map((model.calls || []).map((c) => [c.row, c]));
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.CALL) continue;
    const meta = callMeta.get(inst.row);
    const name = meta && meta.name || null;
    if (!name || !/objc_(getProperty|setProperty)/.test(name)) continue;
    const read = /objc_getProperty/.test(name);
    const offsetReg = read ? 'x2' : 'x3';
    const offsetValue = valueBefore(ir, inst, offsetReg);
    if (!offsetValue || offsetValue.const == null) continue;
    const disp = offsetValue.const;
    const location = {
      base: 'x0', disp, size: 8, stack: false,
      key: 'x0@' + disp.toString(), indexAddr: null, self: true,
      irKey: null, irKind: MK.FIELD,
    };
    out.push({
      kind: read ? 'read' : 'write',
      engine: 'ir-semantic',
      location,
      from: read ? { row: inst.row, address: inst.address, base: 'x0', disp, size: 8, key: location.key } : null,
      steps: [],
      store: { row: inst.row, address: inst.address, reg: read ? 'x0' : 'x2' },
      register: read ? 'x0' : 'x2',
      helper: name,
      confidence: SCORE.confirmed,
      level: levelOf(SCORE.confirmed),
      evidence: [ev(read ? 'load' : 'store', inst.row, { base: 'x0', disp, helper: name, engine: 'ir-semantic' })],
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
