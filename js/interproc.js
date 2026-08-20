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
  if (value.const != null) return { kind: 'constant', value: value.const, bits: value.bits || null, signed: value.signed ?? null };
  const origin = originOf(value);
  if (!origin) return { kind: 'unknown' };
  if (origin.kind === 'argument') return { kind: 'argument', reg: origin.reg, index: Number(origin.reg.slice(1)), bits: value.bits || null, signed: value.signed ?? null };
  if (origin.kind === 'field' || origin.kind === 'stack') return { kind: origin.kind, location: origin.location || null, bits: value.bits || null, signed: value.signed ?? null };
  if (origin.kind === 'global') return { kind: 'global', address: origin.address, bits: value.bits || null, signed: value.signed ?? null };
  if (origin.kind === 'call') return { kind: 'call', target: origin.target, instructionId: origin.instructionId, bits: value.bits || null, signed: value.signed ?? null };
  return { kind: 'computed', op: origin.op || null, sub: origin.sub || null, bits: value.bits || null, signed: value.signed ?? null };
}

function weakTerminalCallReturn(ir, ret, calls) {
  if (ret?.row == null) return null;
  const candidates = (ir.instructions || []).filter((inst) => inst.op === OP.CALL
    && inst.row != null && inst.row < ret.row
    && (inst.block == null || ret.block == null || inst.block === ret.block));
  const call = candidates.sort((a, b) => (b.row - a.row) || (b.id - a.id))[0] || null;
  if (!call) return null;
  const clobbers = call.clobbers || call.extra?.clobbers || [];
  if (!clobbers.includes('x0')) return null;
  const overwritten = (ir.instructions || []).some((inst) => inst !== call && inst !== ret
    && inst.row != null && inst.row > call.row && inst.row < ret.row
    && (inst.block == null || ret.block == null || inst.block === ret.block)
    && (inst.dst?.reg === 'x0' || inst.extra?.publicStateIdentity === 'x0'));
  if (overwritten) return null;
  const metadata = (calls || []).find((item) => item.row === call.row) || null;
  return {
    kind: 'call',
    target: metadata?.target ?? call.extra?.target ?? null,
    instructionId: call.instructionId ?? call.id,
    bits: call.returnBits || 64,
    signed: null,
  };
}

function passiveIncomingStateRead(value) {
  if (!value?.def || value.def.op !== OP.MOV || !value.def.extra?.stateRead) return false;
  const origin = originOf(value);
  return origin?.kind === 'argument' || value.def.extra?.entryStateRead === true;
}

function summaryReturnCandidate(ir, ret, calls) {
  const explicit = ret?.args?.[0]?.value || null;
  if (explicit) return { value: explicit, descriptor: null, inferred: false };

  // Untyped RET carries no x0 SSA use. A terminal x0 definition is useful as a
  // local hint, but it is not an ABI return contract by itself. Compatibility
  // may retain the legacy weak call-result view when the ABI marks x0 clobbered,
  // without promoting an unknown call result to trusted semantic truth.
  const value = valueBefore(ir, ret, 'x0');
  if (!value || value.kind === VK.ARG || !value.def || passiveIncomingStateRead(value)) {
    const descriptor = weakTerminalCallReturn(ir, ret, calls);
    return descriptor ? { value: null, descriptor, inferred: true }
      : { value: null, descriptor: null, inferred: false };
  }
  if (value.def.row == null || ret.row == null || value.def.row >= ret.row) return { value: null, descriptor: null, inferred: false };
  const laterUse = (value.uses || []).some((use) => use !== ret && use.row != null && use.row > value.def.row && use.row < ret.row);
  if (laterUse) return { value: null, descriptor: null, inferred: false };
  return { value, descriptor: null, inferred: true };
}

function transparentMoveSource(value) {
  let current = value;
  for (let guard = 0; guard < 8 && current?.def?.op === OP.MOV; guard++) {
    const def = current.def;
    const source = def.args?.[0]?.value ?? null;
    if (!source) break;
    // Only same-width, semantics-preserving copies are transparent here. Width
    // conversions such as trunc/zext remain explicit and cannot turn an
    // arbitrary value into a source-language argument.
    if (def.sub != null || Number(source.bits || 0) !== Number(current.bits || 0)) break;
    current = source;
  }
  return current;
}

function summaryArithmeticSource(value) {
  let current = value;
  for (let guard = 0; guard < 8 && current?.def?.op === OP.MOV; guard++) {
    const def = current.def;
    const source = def.args?.[0]?.value ?? null;
    if (!source) break;
    const fromBits = Number(source.bits || 0), toBits = Number(current.bits || 0);
    if (def.sub == null) {
      if (fromBits === toBits) { current = source; continue; }
      const sameInstructionView = fromBits === 32 && toBits === 64 &&
        def.row != null && source.def?.row != null && Number(def.row) === Number(source.def.row) &&
        def.address != null && source.def?.address != null && BigInt(def.address) === BigInt(source.def.address);
      if (sameInstructionView) { current = source; continue; }
      break;
    }
    const op = String(def.sub || '').toLowerCase();
    const sameInstructionView = ['zext','uxt32'].includes(op) && fromBits === 32 && toBits === 64 &&
      def.row != null && source.def?.row != null && Number(def.row) === Number(source.def.row) &&
      def.address != null && source.def?.address != null && BigInt(def.address) === BigInt(source.def.address);
    if (sameInstructionView) { current = source; continue; }
    break;
  }
  return current;
}

function returnArgumentIndex(value) {
  const source = transparentMoveSource(value);
  if (!source) return null;
  const origin = originOf(source);
  const reg = source.kind === VK.ARG ? source.reg : origin?.kind === 'argument' ? origin.reg : null;
  return /^x[0-7]$/.test(String(reg || '')) ? Number(String(reg).slice(1)) : null;
}

function simpleReturnExpression(value) {
  if (!value) return null;
  const v = summaryArithmeticSource(value);
  if (!v || !v.def || v.def.op !== OP.BIN || (v.def.sub !== 'add' && v.def.sub !== 'sub')) return null;
  const aArg = v.def.args[0] || null;
  const bArg = v.def.args[1] || null;
  const a = transparentMoveSource(aArg && aArg.value);
  const b = transparentMoveSource(bArg && bArg.value);
  if (!a || !b) return null;
  const aArgument = returnArgumentIndex(a);
  const bArgument = returnArgumentIndex(b);
  const bits = Number(v.bits || v.def.extra?.dstBits || aArg?.bits || 64);
  const signed = v.signed ?? null;
  if (aArgument != null && b.const != null) {
    return { kind: 'argument-arithmetic', argument: aArgument, op: v.def.sub, constant: b.const, bits, signed };
  }
  if (v.def.sub === 'add' && bArgument != null && a.const != null) {
    return { kind: 'argument-arithmetic', argument: bArgument, op: 'add', constant: a.const, bits, signed };
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
      args.push({ index: i, constant: v.const == null ? null : v.const, origin: originOf(v), bits: v.bits || null, signed: v.signed ?? null });
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

function trustedExternalReturnEvidence(opts) {
  const evidence = opts && opts.returnEvidence;
  return evidence === true || !!(evidence && typeof evidence === 'object' && evidence.trusted === true) || opts?.returnsValue === true;
}

const FUNCTION_LOCAL_SUMMARY_OPTION_KEYS = Object.freeze([
  'returnEvidence', 'returnsValue', 'returnType', 'returnClass', 'returnBits',
  'functionPrototype', 'prototype', 'ir',
]);
const IR_RETURN_OPTION_KEYS = Object.freeze([
  'returnsValue', 'returnType', 'returnClass', 'returnBits', 'functionPrototype', 'prototype',
]);

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function functionLocalSummaryOptions(opts) {
  const out = {};
  for (const key of FUNCTION_LOCAL_SUMMARY_OPTION_KEYS) if (own(opts, key)) out[key] = opts[key];
  return out;
}

function summaryIrOptions(opts) {
  const out = opts?.ir && typeof opts.ir === 'object' ? { ...opts.ir } : {};
  for (const key of IR_RETURN_OPTION_KEYS) if (own(opts, key)) out[key] = opts[key];
  return Object.keys(out).length ? out : undefined;
}

export function summarizeFunction(model, opts) {
  const ir = irFor(model, summaryIrOptions(opts));
  if (!ir) return null;
  const facts = semanticFacts(ir);
  const calls = callsOf(model, ir);
  const hasExternalReturnEvidence = trustedExternalReturnEvidence(opts);
  const returns = [];
  for (const ret of ir.instructions || []) {
    if (ret.op !== OP.RET) continue;
    const candidate = summaryReturnCandidate(ir, ret, calls);
    const descriptor = candidate.descriptor || returnDescriptor(candidate.value);
    const expr = simpleReturnExpression(candidate.value);
    const summary = expr || descriptor;
    returns.push(candidate.inferred
      ? { ...summary, inferred: true, trusted: hasExternalReturnEvidence, evidence: hasExternalReturnEvidence ? 'external-return-evidence' : 'terminal-x0-definition' }
      : { ...summary, trusted: true });
  }

  const reads = uniqueLocations(facts, FACT.READ);
  const writes = uniqueLocations(facts, FACT.WRITE);
  const rmw = facts.filter((f) => f.kind === FACT.RMW);
  const branches = facts.filter((f) => f.kind === FACT.BRANCH);
  const unknownPointerStores = facts.filter((f) => f.kind === FACT.POINTER_STORE);
  const nonStackWrites = writes.filter((l) => l.kind !== 'stack');
  const nonStackReads = reads.filter((l) => l.kind !== 'stack');
  void nonStackReads;
  const oneReturn = returns.length === 1 ? returns[0] : null;
  const trustedReturn = oneReturn && oneReturn.trusted ? oneReturn : null;

  const getter = !!(trustedReturn && trustedReturn.kind === 'field' && nonStackWrites.length === 0);
  const setterFact = facts.find((f) => f.kind === FACT.WRITE && f.location && f.location.kind === 'field' &&
    f.value && f.value.origin && f.value.origin.kind === 'argument');
  const setter = !!(setterFact && nonStackWrites.length === 1);
  const wrapper = !!(
    calls.length === 1 && nonStackWrites.length === 0 && branches.length === 0 && unknownPointerStores.length === 0 &&
    trustedReturn && (trustedReturn.kind === 'call' || trustedReturn.kind === 'argument' || trustedReturn.kind === 'constant')
  );
  const forwarding = !!(
    calls.length === 1 && nonStackWrites.length === 0 && rmw.length === 0 &&
    branches.length === 0 && unknownPointerStores.length === 0 && trustedReturn
  );

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
      simpleArithmeticWrapper: !!(trustedReturn && trustedReturn.kind === 'argument-arithmetic'),
      returnEvidence: !oneReturn ? 'none'
        : !oneReturn.inferred ? 'explicit'
          : oneReturn.trusted ? 'external'
            : 'inferred-terminal-x0',
    },
    engine: 'semantic-ir',
    truncated: !!ir.truncated,
  };
}

function actualForArgument(call, index) {
  const a = call && call.arguments && call.arguments.find((x) => x.index === index);
  if (!a) return { kind: 'unknown' };
  if (a.constant != null) return { kind: 'constant', value: a.constant, bits: a.bits || null, signed: a.signed ?? null };
  return a.origin || { kind: 'unknown' };
}

function normalizeBitvector(value, bits, signed) {
  const width = Number(bits || 64);
  if (!Number.isSafeInteger(width) || width < 1 || width > 64) return value;
  return signed === true ? BigInt.asIntN(width, value) : BigInt.asUintN(width, value);
}

function composeReturn(wrapper, callee) {
  if (!wrapper || !callee || wrapper.calls.length !== 1 || callee.returns.length !== 1) return null;
  const r = callee.returns[0];
  if (!r || !r.trusted) return null;
  const call = wrapper.calls[0];
  if (r.kind === 'constant') return r;
  if (r.kind === 'argument') return actualForArgument(call, r.index);
  if (r.kind === 'argument-arithmetic') {
    const actual = actualForArgument(call, r.argument);
    if (actual.kind === 'constant') {
      const raw = r.op === 'sub' ? actual.value - r.constant : actual.value + r.constant;
      return { kind: 'constant', value: normalizeBitvector(raw, r.bits, r.signed), bits: r.bits || null, signed: r.signed ?? null, trusted: true, via: 'callee-summary' };
    }
    return { ...r, input: actual, via: 'callee-summary' };
  }
  if (r.kind === 'field' || r.kind === 'global') return { ...r, via: 'callee-summary' };
  return null;
}

function cacheScopeOf(context) {
  const generation=context?.analysisGeneration ?? context?.generation ?? context?.epoch ?? '';
  const session=context?.sessionId ?? context?.binaryHash ?? context?.binaryIdentity ?? '';
  return String(session)+'@'+String(generation);
}
function hasFunctionLocalSummaryOptions(opts) {
  return FUNCTION_LOCAL_SUMMARY_OPTION_KEYS.some((key) => own(opts, key));
}
function hasContextSensitiveSummaryInputs(context, opts) {
  return hasFunctionLocalSummaryOptions(opts) || typeof context?.returnEvidenceFor === 'function';
}
function calleeOptions(opts, depth) {
  const next={...(opts||{}),depth};
  // All function-local evidence must be re-resolved for the callee identity.
  for (const key of FUNCTION_LOCAL_SUMMARY_OPTION_KEYS) delete next[key];
  return next;
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
    const addressKey = address.toString();
    const cacheable = !hasContextSensitiveSummaryInputs(this.context, opts);
    const key = cacheScopeOf(this.context) + ':' + addressKey;
    if (cacheable && this.cache.has(key)) {
      const hit = this.cache.get(key);
      this._touch(key, hit);
      return hit;
    }
    if (this.active.has(addressKey)) return { address, cycle: true, engine: 'semantic-ir', reads: [], writes: [], returns: [], calls: [], effects: {}, argumentRoles: [], classification: {} };
    const depth = opts && opts.depth != null ? opts.depth : 0;
    const cancelled = opts && opts.isCancelled || (() => false);
    if (cancelled()) return null;
    this.active.add(addressKey);
    try {
      let range = null;
      try { range = this.context.program && this.context.program.functionRange ? this.context.program.functionRange(address) : null; } catch { range = null; }
      const analyze = this.context.analyze;
      if (typeof analyze !== 'function') return null;
      const model = await analyze(address, range ? range.end : null);
      if (!model) return null;
      let returnEvidence = opts && opts.returnEvidence;
      if (returnEvidence == null && typeof this.context.returnEvidenceFor === 'function') {
        try { returnEvidence = await this.context.returnEvidenceFor(address, model); } catch { returnEvidence = null; }
      }
      const summaryOpts = { ...functionLocalSummaryOptions(opts), address };
      if (returnEvidence != null) summaryOpts.returnEvidence = returnEvidence;
      const summary = summarizeFunction(model, summaryOpts);
      if (!summary) return null;

      if (depth < this.maxDepth && summary.calls.length === 1 && summary.classification.forwarding) {
        const target = summary.calls[0].target;
        if (target != null && !cancelled()) {
          const callee = await this.summaryFor(target, calleeOptions(opts, depth + 1));
          const propagated = composeReturn(summary, callee);
          if (propagated) {
            summary.propagatedReturn = propagated;
            summary.returns = [propagated];
          }
          if (callee && !callee.cycle) summary.forwardedEffects = callee.effects;
        }
      }
      if (cacheable) this._touch(key, summary);
      return summary;
    } finally {
      this.active.delete(addressKey);
    }
  }
}

export function createFunctionSummaryCache(context, opts) {
  return new FunctionSummaryCache(context, opts);
}
