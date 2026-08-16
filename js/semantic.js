/*
 * semantic.js — Semantic IR から得られる高水準 fact の唯一の共通層。
 *
 * consumer は ARM64 命令列を再解釈しない。IR / SSA / Memory SSA が証明した
 * 事実だけをここから読む。fact.evidence は元になった IR 命令 ID を保持し、
 * 同じ命令を dataflow/controlflow/semantic と名前だけ変えて二重計上しない。
 */
import {
  irFor, readModifyWrite, OP, MK, VK,
  valueInfo, originOf, pointerProvenance,
} from './ir.js';

export const FACT = Object.freeze({
  READ: 'read', WRITE: 'write', RMW: 'read-modify-write',
  INCREMENT: 'increment', DECREMENT: 'decrement', CLAMP: 'clamp',
  THRESHOLD: 'threshold-comparison', ZERO_NULL: 'zero-null-comparison',
  RETURN: 'return-derived-value', ARGUMENT: 'argument-derived-value',
  GLOBAL: 'global-access', STACK: 'stack-slot', CALL_RESULT: 'call-result',
  BRANCH: 'branch-condition', TRANSFER: 'field-to-field-transfer',
  POINTER_STORE: 'store-through-pointer', SOURCE: 'source', SINK: 'sink',
});

const factCache = new WeakMap();

function instructionEvidence(inst, relation = null) {
  if (!inst) return null;
  return {
    id: 'ir:' + String(inst.id), instructionId: inst.id,
    row: inst.row == null ? null : inst.row,
    address: inst.address == null ? null : inst.address,
    relation, group: 'semantic-ir:' + String(inst.id),
  };
}

function uniqueEvidence(items) {
  const out = [], seen = new Set();
  for (const item of items || []) {
    if (!item) continue;
    const key = item.group || item.id || (String(item.address) + ':' + String(item.row));
    if (seen.has(key)) continue;
    seen.add(key); out.push(item);
  }
  return out;
}

function locationShape(loc) {
  if (!loc) return null;
  return {
    key: loc.key || null, kind: loc.kind || MK.UNKNOWN,
    disp: loc.disp == null ? null : loc.disp,
    size: loc.size == null ? null : loc.size,
    address: loc.address == null ? null : loc.address,
    base: loc.base || null,
  };
}

function valueShape(value) {
  if (!value) return null;
  const info = valueInfo(value);
  return {
    id: value.id, reg: value.reg || null, bits: value.bits || 64,
    kind: value.kind || null, constant: info.constant,
    min: info.min, max: info.max, signedness: info.signedness,
    zero: info.zero, nullability: info.nullability,
    origin: originOf(value), provenance: pointerProvenance(value),
  };
}

function fact(kind, inst, extra = {}) {
  const evidence = uniqueEvidence(extra.evidence || [instructionEvidence(inst)]);
  return {
    id: extra.id || ('fact:' + kind + ':' + (inst ? inst.id : 'none')),
    kind,
    row: inst && inst.row != null ? inst.row : null,
    address: inst && inst.address != null ? inst.address : null,
    function: extra.function == null ? null : extra.function,
    relation: extra.relation || null,
    confidence: extra.confidence == null ? 1 : extra.confidence,
    confidenceSource: extra.confidenceSource || 'semantic-ir',
    ...extra, evidence,
  };
}

function sameSemanticValue(a, b, seen = new Set()) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.id != null && b.id != null && a.id === b.id) return true;
  if (a.const != null || b.const != null) {
    return a.const != null && b.const != null
      && a.const === b.const
      && Number(a.bits || 64) === Number(b.bits || 64);
  }
  const bitsA = Number(a.bits || 64), bitsB = Number(b.bits || 64);
  if (bitsA !== bitsB) return false;
  const pairKey = String(a.id ?? '?') + ':' + String(b.id ?? '?');
  if (seen.has(pairKey)) return false;
  const next = new Set(seen).add(pairKey);
  const ad = a.def, bd = b.def;
  const as = ad?.op === OP.MOV ? ad.args?.[0]?.value ?? null : null;
  const bs = bd?.op === OP.MOV ? bd.args?.[0]?.value ?? null : null;

  // Equal exact casts of equal sources are equal. This is a compatibility-shape
  // proof, not a new semantic engine: the casts are already explicit IR nodes.
  if (as && bs && ad.sub === bd.sub) {
    const sourceBitsA = Number(as.bits || bitsA), sourceBitsB = Number(bs.bits || bitsB);
    if (sourceBitsA === sourceBitsB && sameSemanticValue(as, bs, next)) return true;
  }
  // Plain same-width MOVs are transparent and may appear on only one side when
  // state reads are materialized at different consumer rows.
  if (as && ad.sub == null && Number(as.bits || bitsA) === bitsA && sameSemanticValue(as, b, next)) return true;
  if (bs && bd.sub == null && Number(bs.bits || bitsB) === bitsB && sameSemanticValue(a, bs, next)) return true;
  return false;
}

const GREATER_CONDITIONS = new Set(['gt', 'ge', 'hi', 'hs', 'cs']);
const LESSER_CONDITIONS = new Set(['lt', 'le', 'lo', 'cc', 'ls']);

/** Prove that a plain CSEL is exactly min/max of the values compared by NZCV. */
export function proveClampSelect(sel) {
  if (!sel || sel.op !== OP.SEL || sel.sub !== 'sel') return null;
  const whenTrue = sel.args?.[0]?.value || null;
  const whenFalse = sel.args?.[1]?.value || null;
  const flags = sel.args?.[2]?.value || sel.args?.[sel.args.length - 1]?.value || null;
  const cmp = flags?.def?.op === OP.CMP ? flags.def : null;
  if (!whenTrue || !whenFalse || !cmp || cmp.sub !== 'sub') return null;
  const lhs = cmp.args?.[0]?.value || null;
  const rhs = cmp.args?.[1]?.value || null;
  if (!lhs || !rhs) return null;
  const direct = sameSemanticValue(whenTrue, lhs) && sameSemanticValue(whenFalse, rhs);
  const reversed = sameSemanticValue(whenTrue, rhs) && sameSemanticValue(whenFalse, lhs);
  if (!direct && !reversed) return null;

  const cond = String(sel.cond || '').toLowerCase();
  let kind = null;
  if (GREATER_CONDITIONS.has(cond)) kind = direct ? 'max' : 'min';
  else if (LESSER_CONDITIONS.has(cond)) kind = direct ? 'min' : 'max';
  else return null;

  const constantLhs = lhs.const != null;
  const constantRhs = rhs.const != null;
  let bound = null, candidate = null;
  if (constantLhs !== constantRhs) {
    bound = constantLhs ? lhs : rhs;
    candidate = constantLhs ? rhs : lhs;
  } else {
    // Dynamic min/max is still proven; retain explicit operand identity rather
    // than inventing which side is the semantic bound.
    candidate = lhs;
  }
  return { kind, condition:cond, lhs, rhs, bound, candidate, compare:cmp };
}

const THRESHOLD_OPERATOR = Object.freeze({
  eq:'==', ne:'!=',
  lt:'<', le:'<=', gt:'>', ge:'>=',
  lo:'<', cc:'<', hi:'>', ls:'<=', hs:'>=', cs:'>=',
});
const SWAPPED_CONDITION = Object.freeze({
  eq:'eq', ne:'ne', lt:'gt', gt:'lt', le:'ge', ge:'le',
  lo:'hi', cc:'hi', hi:'lo', ls:'hs', hs:'ls', cs:'ls',
});
const SWAPPED_OPERATOR = Object.freeze({ '<':'>', '<=':'>=', '>':'<', '>=':'<=', '==':'==', '!=':'!=' });

/** Canonicalize a constant comparison to `subject operator threshold`. */
export function canonicalThresholdComparison(c) {
  if (!c) return null;
  const left = c.value || null, right = c.other || null;
  const leftConst = left?.const != null, rightConst = right?.const != null;
  if (leftConst === rightConst) return null;
  const originalCondition = String(c.cond || '').toLowerCase();
  const rawOperator = THRESHOLD_OPERATOR[originalCondition];
  if (!rawOperator) return null;
  const swapped = leftConst;
  const subject = swapped ? right : left;
  const thresholdValue = swapped ? left : right;
  const condition = swapped ? SWAPPED_CONDITION[originalCondition] : originalCondition;
  const operator = swapped ? SWAPPED_OPERATOR[rawOperator] : rawOperator;
  if (!subject || thresholdValue?.const == null || !condition || !operator) return null;
  return {
    subject,
    thresholdValue,
    threshold: thresholdValue.const,
    condition,
    operator,
    originalCondition,
    swapped,
    operands: { left, right },
  };
}

function comparisonForBranch(branch) {
  if (!branch || branch.op !== OP.CBR || !branch.args || !branch.args.length) return null;
  if (branch.extra && (branch.extra.kind === 'cbz' || branch.extra.kind === 'cbnz')) {
    return { cmp: null, value: branch.args[0].value || null, other: null, cond: branch.extra.kind };
  }
  const flags = branch.args[0] && branch.args[0].value;
  const cmp = flags && flags.def && flags.def.op === OP.CMP ? flags.def : null;
  if (!cmp) return null;
  return {
    cmp,
    value: cmp.args[0] && cmp.args[0].value || null,
    other: cmp.args[1] && cmp.args[1].value || null,
    cond: branch.cond || null,
  };
}

function rmwFacts(ir, out) {
  for (const r of readModifyWrite(ir)) {
    const chain = r.chain || [];
    const evidence = uniqueEvidence([
      instructionEvidence(r.load, 'read'),
      ...chain.map((i) => instructionEvidence(i, 'compute')),
      instructionEvidence(r.store, 'write'),
    ]);
    const written = r.store.args && r.store.args[0] && r.store.args[0].value || null;
    const base = {
      id: 'fact:rmw:' + r.load.id + ':' + r.store.id,
      location: locationShape(r.location), source: valueShape(r.load.dst),
      sink: valueShape(written), value: valueShape(written), operation: r.kind,
      chain: chain.map((i) => ({ id: i.id, op: i.op, sub: i.sub, row: i.row, address: i.address })),
      load: { id: r.load.id, row: r.load.row, address: r.load.address },
      store: { id: r.store.id, row: r.store.row, address: r.store.address },
      evidence, relation: 'read→compute→write',
    };
    out.push(fact(FACT.RMW, r.store, base));
    if (r.kind === 'add') out.push(fact(FACT.INCREMENT, r.store, { ...base, id: base.id + ':inc', relation: 'increase' }));
    if (r.kind === 'sub') out.push(fact(FACT.DECREMENT, r.store, { ...base, id: base.id + ':dec', relation: 'decrease' }));
    const sel = chain.find((i) => i.op === OP.SEL && i.sub === 'sel');
    const clamp = sel ? proveClampSelect(sel) : null;
    if (clamp) out.push(fact(FACT.CLAMP, sel, {
      id: base.id + ':clamp',
      location: base.location,
      value: valueShape(sel.dst),
      condition: clamp.condition,
      clampKind: clamp.kind,
      bound: valueShape(clamp.bound),
      candidate: valueShape(clamp.candidate),
      compare: {
        left: valueShape(clamp.lhs),
        right: valueShape(clamp.rhs),
        instructionId: clamp.compare.id,
      },
      evidence,
      relation: clamp.kind === 'min' ? 'upper-clamp-before-write' : 'lower-clamp-before-write',
    }));
  }
}

/**
 * Memory sources that deterministically contribute to an SSA value. This walks
 * def-use edges only; it never scans source instructions heuristically.
 */
function sourceMemoryLoads(value, opts = {}) {
  const maxNodes = Math.max(8, opts.maxNodes || 128);
  const work = value ? [value] : [];
  const seenValues = new Set(), seenInsts = new Set(), out = [];
  let visited = 0;
  while (work.length && visited++ < maxNodes) {
    const v = work.pop();
    if (!v || seenValues.has(v.id)) continue;
    seenValues.add(v.id);
    const d = v.def;
    if (!d) continue;
    if (d.op === OP.LOAD && d.loc) {
      if (!seenInsts.has(d.id)) { seenInsts.add(d.id); out.push(d); }
      continue;
    }
    for (const a of d.args || []) if (a && a.value) work.push(a.value);
  }
  return out;
}

function memoryFacts(ir, out) {
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.LOAD && inst.op !== OP.STORE) continue;
    const loc = locationShape(inst.loc);
    const isLoad = inst.op === OP.LOAD;
    const v = isLoad ? inst.dst : (inst.args[0] && inst.args[0].value || null);
    const base = {
      location: loc, value: valueShape(v),
      source: isLoad ? loc : valueShape(v),
      sink: isLoad ? valueShape(v) : loc,
      relation: isLoad ? 'memory→value' : 'value→memory',
    };
    out.push(fact(isLoad ? FACT.READ : FACT.WRITE, inst, base));
    if (loc && loc.kind === MK.GLOBAL) out.push(fact(FACT.GLOBAL, inst, { ...base, id: 'fact:global:' + inst.id }));
    if (loc && loc.kind === MK.STACK) out.push(fact(FACT.STACK, inst, { ...base, id: 'fact:stack:' + inst.id }));
    if (!isLoad && (!loc || loc.kind === MK.UNKNOWN)) {
      out.push(fact(FACT.POINTER_STORE, inst, {
        ...base, id: 'fact:pointer-store:' + inst.id,
        confidence: 1, relation: 'unknown-alias-store',
      }));
    }

    if (!isLoad && loc && loc.kind === MK.FIELD) {
      for (const load of sourceMemoryLoads(v)) {
        if (!load.loc || load.loc.kind !== MK.FIELD || load.loc.key === inst.loc.key) continue;
        out.push(fact(FACT.TRANSFER, inst, {
          id: 'fact:transfer:' + load.id + ':' + inst.id,
          source: { kind: 'field', location: locationShape(load.loc), value: valueShape(load.dst) },
          sink: loc,
          value: valueShape(v),
          relation: 'field→compute→field',
          evidence: uniqueEvidence([
            instructionEvidence(load, 'source-read'),
            instructionEvidence(inst, 'destination-write'),
          ]),
        }));
      }
    }
  }
}

function controlFacts(ir, out) {
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.CBR) continue;
    const c = comparisonForBranch(inst);
    if (!c) continue;
    const cmpEvidence = c.cmp ? instructionEvidence(c.cmp, 'compare') : null;
    const evidence = uniqueEvidence([cmpEvidence, instructionEvidence(inst, 'branch')]);
    const base = {
      condition: c.cond, value: valueShape(c.value), other: valueShape(c.other),
      target: inst.extra && inst.extra.target != null ? inst.extra.target : null,
      evidence, relation: 'compare→branch',
    };
    out.push(fact(FACT.BRANCH, inst, base));

    // CBZ/CBNZ always compare against zero. A propagated constant on the tested
    // value is the input, never the threshold.
    if (c.cond === 'cbz' || c.cond === 'cbnz') {
      const subject = valueShape(c.value);
      const canonical = {
        ...base,
        value: subject,
        subject,
        other: { kind:'constant', constant:0n, bits:c.value?.bits || 64 },
        threshold: 0n,
        operator: c.cond === 'cbz' ? '==' : '!=',
        originalCondition: c.cond,
        swapped: false,
        operands: { left: subject, right:{ kind:'constant', constant:0n, bits:c.value?.bits || 64 } },
      };
      out.push(fact(FACT.THRESHOLD, inst, {
        ...canonical, id: 'fact:threshold:' + inst.id,
        comparisonRow: inst.row, branchRow: inst.row,
      }));
      out.push(fact(FACT.ZERO_NULL, inst, {
        ...canonical, id: 'fact:zero:' + inst.id,
      }));
      continue;
    }

    const canonical = canonicalThresholdComparison(c);
    if (canonical) {
      const normalized = {
        ...base,
        condition: canonical.condition,
        originalCondition: canonical.originalCondition,
        operator: canonical.operator,
        swapped: canonical.swapped,
        threshold: canonical.threshold,
        subject: valueShape(canonical.subject),
        value: valueShape(canonical.subject),
        other: valueShape(canonical.thresholdValue),
        operands: {
          left: valueShape(canonical.operands.left),
          right: valueShape(canonical.operands.right),
        },
      };
      out.push(fact(FACT.THRESHOLD, c.cmp || inst, {
        ...normalized, id: 'fact:threshold:' + inst.id,
        comparisonRow: c.cmp ? c.cmp.row : inst.row, branchRow: inst.row,
      }));
      if (canonical.threshold === 0n) out.push(fact(FACT.ZERO_NULL, c.cmp || inst, {
        ...normalized, id: 'fact:zero:' + inst.id,
      }));
    }
  }
}

function sourceSinkFacts(ir, out) {
  for (const inst of ir.instructions || []) {
    if (inst.op === OP.CALL && inst.dst) {
      const base = {
        value: valueShape(inst.dst),
        target: inst.extra && inst.extra.target != null ? inst.extra.target : null,
        relation: 'call→return-value',
      };
      out.push(fact(FACT.CALL_RESULT, inst, base));
      out.push(fact(FACT.SOURCE, inst, { ...base, id: 'fact:source:call:' + inst.id, sourceType: 'call-result' }));
    }
    if (inst.op === OP.RET) {
      const v = inst.args && inst.args[0] && inst.args[0].value || null;
      const origin = originOf(v);
      out.push(fact(FACT.RETURN, inst, {
        value: valueShape(v), source: origin, sink: { kind: 'return' }, relation: 'value→return',
      }));
      out.push(fact(FACT.SINK, inst, {
        id: 'fact:sink:return:' + inst.id, value: valueShape(v), sinkType: 'return', relation: 'return',
      }));
    }
  }

  for (const value of ir.values || []) {
    if (value.kind !== VK.ARG || !/^x[0-7]$/.test(String(value.reg || ''))) continue;
    out.push({
      id: 'fact:arg:' + value.id, kind: FACT.ARGUMENT,
      row: ir.blocks && ir.blocks[0] ? ir.blocks[0].startRow : 0,
      address: ir.startAddress || null, function: ir.startAddress || null,
      value: valueShape(value), relation: 'argument→value', confidence: 1,
      confidenceSource: 'semantic-ir', evidence: [],
    });
  }
}

export function semanticFacts(ir) {
  if (!ir || !ir.instructions) return [];
  if (factCache.has(ir)) return factCache.get(ir);
  const out = [];
  memoryFacts(ir, out); rmwFacts(ir, out); controlFacts(ir, out); sourceSinkFacts(ir, out);
  out.sort((a, b) => (a.row == null ? -1 : a.row) - (b.row == null ? -1 : b.row) || String(a.kind).localeCompare(String(b.kind)));
  factCache.set(ir, out);
  return out;
}

export function semanticFactsFor(model, opts) {
  const ir = irFor(model, opts && opts.ir ? opts.ir : opts);
  return ir ? semanticFacts(ir) : [];
}

export function factsOfKind(irOrFacts, kind) {
  const facts = Array.isArray(irOrFacts) ? irOrFacts : semanticFacts(irOrFacts);
  return facts.filter((f) => f.kind === kind);
}

export function factsForLocation(irOrFacts, keyOrOffset) {
  const facts = Array.isArray(irOrFacts) ? irOrFacts : semanticFacts(irOrFacts);
  return facts.filter((f) => {
    const loc = f.location || ((f.sink && f.sink.key) ? f.sink : null);
    if (!loc) return false;
    if (typeof keyOrOffset === 'string') return loc.key === keyOrOffset;
    if (keyOrOffset == null) return false;
    try { return loc.disp != null && loc.disp === BigInt(keyOrOffset); } catch { return false; }
  });
}

export function semanticEvidenceIds(facts) {
  const ids = new Set();
  for (const f of facts || []) for (const e of f.evidence || []) if (e && e.id) ids.add(e.id);
  return Array.from(ids);
}