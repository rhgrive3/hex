/*
 * interproc.js — lazy, bounded interprocedural Semantic IR summaries.
 *
 * No whole-program fixed point. A function is disassembled only when requested;
 * wrappers may recursively consult one callee under an explicit depth/budget.
 */
import { irFor, OP, VK, originOf } from './ir.js';
import { semanticFacts, FACT } from './semantic.js';
import { valueBefore } from './dataflow-semantic.js';

function locKey(loc) {
  return loc && (loc.key || (loc.address != null ? 'g:' + loc.address : null));
}

function uniqueLocations(facts, kind) {
  const out = [];
  const seen = new Set();
  for (const f of facts) {
    if (f.kind !== kind || !f.location) continue;
    const k = locKey(f.location);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(f.location);
  }
  return out;
}

function callNameByRow(model) {
  return new Map((model && model.calls || []).map((c) => [c.row, c]));
}

function returnDescriptor(value) {
  if (!value) return { kind: 'void' };
  if (value.const != null) return { kind: 'constant', value: value.const };
  const origin = originOf(value);
  if (!origin) return { kind: 'unknown' };
  if (origin.kind === 'argument') return { kind: 'argument', reg: origin.reg, index: Number(origin.reg.slice(1)) };
  if (origin.kind === 'field' || origin.kind === 'stack') return { kind: origin.kind, location: origin.location || null };
  if (origin.kind === 'global') return { kind: 'global', address: origin.address };
  if (origin.kind === 'call') return { kind: 'call', target: origin.target, instructionId: origin.instructionId };
  return { kind: 'computed', op: origin.op || null, sub: origin.sub || null };
}

function summaryReturnCandidate(ir, ret) {
  const explicit = ret?.args?.[0]?.value || null;
  if (explicit) return { value: explicit, inferred: false };

  // #130 deliberately makes an untyped RET carry no x0 SSA use. Interprocedural
  // summaries may still recognize a *locally defined, terminal* x0 value as a
  // return-shaped heuristic, without mutating RET or promoting it to ABI truth.
  // Entry x0 (VK.ARG) is intentionally rejected so setters/void-like functions
  // do not become synthetic `return arg0` summaries merely because x0 survived.
  const value = valueBefore(ir, ret, 'x0');
  if (!value || value.kind === VK.ARG || !value.def) return { value: null, inferred: false };
  if (value.def.row == null || ret.row == null || value.def.row >= ret.row) return { value: null, inferred: false };
  const laterUse = (value.uses || []).some((use) => use !== ret && use.row != null && use.row > value.def.row && use.row < ret.row);
  if (laterUse) return { value: null, inferred: false };
  return { value, inferred: true };
}

function simpleReturnExpression(value) {
  if (!value) return null;
  let v = value;
  const pass = new Set([OP.MOV]);
  for (let guard = 0; guard < 6 && v && v.def && pass.has(v.def.op); guard++) v = v.def.args[0] && v.def.args[0].value;
  if (!v || !v.def || v.def.op !== OP.BIN || (v.def.sub !== 'add' && v.def.sub !== 'sub')) return null;
  const a = v.def.args[0] && v.def.args[0].value;
  const b = v.def.args[1] && v.def.args[1].value;
  if (!a || !b) return null;
  if (a.kind === VK.ARG && /^x[0-7]$/.test(String(a.reg || '')) && b.const != null) {
    return { kind: 'argument-arithmetic', argument: Number(a.reg.slice(1)), op: v.def.sub, constant: b.const };
  }
  if (v.def.sub === 'add' && b.kind === VK.ARG && /^x[0-7]$/.test(String(b.reg || '')) && a.const != null) {
    return { kind: 'argument-arithmetic', argument: Number(b.reg.slice(1)), op: 'add', constant: a.const };
  }
  return null;
}

function argumentRoles(ir) {
  const out = [];
  for (let index = 0; index <= 7; index++) {
    const reg = 'x' + index;
    const v = ir.args && ir.args.get ? ir.args.get(reg) : null;
    if (!v) continue;
    const roles = new Set();
    for (const use of v.uses || []) {
      if (use.op === OP.STORE && use.args[0] && use.args[0].value === v) roles.add('stored-value');
      else if (use.op === OP.LOAD || use.op === OP.STORE) roles.add('pointer');
      else if (use.op === OP.BIN || use.op === OP.MAC) roles.add('arithmetic');
      else if (use.op === OP.CMP || use.op === OP.CBR) roles.add('condition');
      else if (use.op === OP.RET) roles.add('return');
    }
    if (roles.size) out.push({ index, reg, roles: Array.from(roles) });
  }
  return out;
}

function callsOf(model, ir) {
  const meta = callNameByRow(model);
  const out = [];
  for (const call of ir.instructions || []) {
    if (call.op !== OP.CALL) continue;
    const m = meta.get(call.row) || {};
    const args = [];
    for (let i = 0; i <= 7; i++) {
      const v = valueBefore(ir, call, 'x' + i);
      if (!v) continue;
      args.push({ index: i, constant: v.const == null ? null : v.const, origin: originOf(v) });
    }
    out.push({
      row: call.row,
      address: call.address,
      target: call.extra && call.extra.target != null ? call.extra.target : (m.target != null ? m.target : null),
      name: m.name || null,
      selector: m.selector || null,
      indirect: !!(call.extra && call.extra.indirect),
      arguments: args,
    });
  }
  return out;
}

export function summarizeFunction(model, opts) {
  const ir = irFor(model, opts && opts.ir);
  if (!ir) return null;
  const facts = semanticFacts(ir);
  const calls = callsOf(model, ir);
  const returns = [];
  for (const ret of ir.instructions || []) {
    if (ret.op !== OP.RET) continue;
    const candidate = summaryReturnCandidate(ir, ret);
    const descriptor = returnDescriptor(candidate.value);
    const expr = simpleReturnExpression(candidate.value);
    const summary = expr || descriptor;
    returns.push(candidate.inferred ? { ...summary, inferred: true, evidence: 'terminal-x0-definition' } : summary);
  }

  const reads = uniqueLocations(facts, FACT.READ);
  const writes = uniqueLocations(facts, FACT.WRITE);
  const rmw = facts.filter((f) => f.kind === FACT.RMW);
  const branches = facts.filter((f) => f.kind === FACT.BRANCH);
  const unknownPointerStores = facts.filter((f) => f.kind === FACT.POINTER_STORE);
  const nonStackWrites = writes.filter((l) => l.kind !== 'stack');
  const nonStackReads = reads.filter((l) => l.kind !== 'stack');
  const oneReturn = returns.length === 1 ? returns[0] : null;

  const getter = !!(oneReturn && oneReturn.kind === 'field' && nonStackWrites.length === 0);
  const setterFact = facts.find((f) => f.kind === FACT.WRITE && f.location && f.location.kind === 'field' &&
    f.value && f.value.origin && f.value.origin.kind === 'argument');
  const setter = !!(setterFact && nonStackWrites.length === 1);
  const wrapper = calls.length === 1 && nonStackWrites.length === 0 && branches.length === 0 && unknownPointerStores.length === 0 &&
    (oneReturn && (oneReturn.kind === 'call' || oneReturn.kind === 'argument' || oneReturn.kind === 'constant'));
  const forwarding = calls.length === 1 && nonStackWrites.length === 0 && rmw.length === 0 &&
    branches.length === 0 && unknownPointerStores.length === 0 && !!oneReturn;

  return {
    address: opts && opts.address != null ? opts.address : (model.startAddress != null ? model.startAddress : ir.startAddress),
    reads,
    writes,
    returns,
    calls,
    effects: {
      readModifyWrite: rmw.map((f) => ({ location: f.location, operation: f.operation, row: f.row, address: f.address })),
      thresholds: facts.filter((f) => f.kind === FACT.THRESHOLD).map((f) => ({ threshold: f.threshold, condition: f.condition, row: f.row, address: f.address })),
      branches: branches.length,
      unknownPointerStores: unknownPointerStores.length,
    },
    argumentRoles: argumentRoles(ir),
    classification: {
      getter,
      setter,
      wrapper,
      forwarding,
      simpleArithmeticWrapper: !!(oneReturn && oneReturn.kind === 'argument-arithmetic'),
    },
    engine: 'semantic-ir',
    truncated: !!ir.truncated,
  };
}

function actualForArgument(call, index) {
  const a = call && call.arguments && call.arguments.find((x) => x.index === index);
  if (!a) return { kind: 'unknown' };
  if (a.constant != null) return { kind: 'constant', value: a.constant };
  return a.origin || { kind: 'unknown' };
}

function composeReturn(wrapper, callee) {
  if (!wrapper || !callee || wrapper.calls.length !== 1 || callee.returns.length !== 1) return null;
  const r = callee.returns[0];
  const call = wrapper.calls[0];
  if (r.kind === 'constant') return r;
  if (r.kind === 'argument') return actualForArgument(call, r.index);
  if (r.kind === 'argument-arithmetic') {
    const actual = actualForArgument(call, r.argument);
    if (actual.kind === 'constant') {
      return { kind: 'constant', value: r.op === 'sub' ? actual.value - r.constant : actual.value + r.constant, via: 'callee-summary' };
    }
    return { ...r, input: actual, via: 'callee-summary' };
  }
  if (r.kind === 'field' || r.kind === 'global') return { ...r, via: 'callee-summary' };
  return null;
}

export class FunctionSummaryCache {
  constructor(context, opts) {
    this.context = context || {};
    this.maxEntries = Math.max(16, (opts && opts.maxEntries) || 256);
    this.maxDepth = Math.max(0, (opts && opts.maxDepth) == null ? 3 : opts.maxDepth);
    this.cache = new Map();
    this.active = new Set();
  }

  _touch(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
  }

  clear() { this.cache.clear(); this.active.clear(); }

  async summaryFor(address, opts) {
    if (address == null) return null;
    const key = address.toString();
    if (this.cache.has(key)) {
      const hit = this.cache.get(key);
      this._touch(key, hit);
      return hit;
    }
    if (this.active.has(key)) return { address, cycle: true, engine: 'semantic-ir', reads: [], writes: [], returns: [], calls: [], effects: {}, argumentRoles: [], classification: {} };
    const depth = opts && opts.depth != null ? opts.depth : 0;
    const cancelled = opts && opts.isCancelled || (() => false);
    if (cancelled()) return null;
    this.active.add(key);
    try {
      let range = null;
      try { range = this.context.program && this.context.program.functionRange ? this.context.program.functionRange(address) : null; } catch { range = null; }
      const analyze = this.context.analyze;
      if (typeof analyze !== 'function') return null;
      const model = await analyze(address, range ? range.end : null);
      if (!model) return null;
      const summary = summarizeFunction(model, { address });
      if (!summary) return null;

      if (depth < this.maxDepth && summary.calls.length === 1 && summary.classification.forwarding) {
        const target = summary.calls[0].target;
        if (target != null && !cancelled()) {
          const callee = await this.summaryFor(target, { ...(opts || {}), depth: depth + 1 });
          const propagated = composeReturn(summary, callee);
          if (propagated) {
            summary.propagatedReturn = propagated;
            summary.returns = [propagated];
          }
          if (callee && !callee.cycle) summary.forwardedEffects = callee.effects;
        }
      }
      this._touch(key, summary);
      return summary;
    } finally {
      this.active.delete(key);
    }
  }
}

export function createFunctionSummaryCache(context, opts) {
  return new FunctionSummaryCache(context, opts);
}
