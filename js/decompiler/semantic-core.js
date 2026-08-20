/*
 * Semantic IR first decompiler.
 *
 * The decompiler never reparses an ARM64 instruction when Semantic IR already
 * represents it. Unsupported IR/control-flow falls back to explicit labels and
 * gotos rather than manufacturing source structure.
 */

import { irFor, readModifyWrite, OP, VK, MK, COND, inverseCondition } from '../ir.js';
import { analyzeGraph } from '../controlflow.js';
import { inferSemanticTypes, semanticSignature, typeNameOf } from './type-recovery.js';
import { buildAppleRuntimeIndex, resolveAppleCall, shouldFoldRuntimeCall, runtimeOriginForSymbol } from '../apple/runtime.js';
import { callArgumentIndices, knownCallPrototype } from './call-prototypes.js';
import { sourceOf, mergeSource } from './ast/nodes.js';
import { isNZCVCondition, renderNZCVCondition } from './flag-semantics.js';
import { renderIndexedMemory } from './address-semantics.js';
import { integerText } from './pretty/c.js';

const MAX_EXPR_DEPTH = 48;
const MAX_EXPR_NODES = 512;
const MAX_BLOCKS = 6000;

function line(kind, indent, text, row = null, addr = null, extra = null) {
  return { kind, indent, text, row, addr, note: null, ...(extra || {}) };
}

function valueOf(a) { return a && a.value ? a.value : null; }
function hex(v) { return BigInt(v).toString(16).toUpperCase(); }
function safeIdent(s, fallback = 'value') {
  const x = String(s || '').replace(/^_+/, '').replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1');
  return x || fallback;
}
function paren(s) { return /^[-+]?\w+(?:->\w+|\.\w+|\[[^\]]+\])*$/.test(s) || /^0x[0-9A-F]+$/.test(s) ? s : `(${s})`; }
function isZeroVal(v) {
  return !!v && (v.const === 0n || v.const === 0 || v.reg === 'xzr' || v.reg === 'wzr' || v.reg === 'zr');
}
function unwrapValue(v) {
  let cur = v;
  while (cur && cur.def && cur.def.op === OP.MOV && cur.def.args?.length === 1 && cur.def.args[0]?.value) {
    cur = cur.def.args[0].value;
  }
  return cur || v;
}
function sameValue(a, b) {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (isZeroVal(a) && isZeroVal(b)) return true;
  const ua = unwrapValue(a), ub = unwrapValue(b);
  if (ua && ub && ua.id === ub.id) return true;
  if (isZeroVal(ua) && isZeroVal(ub)) return true;
  return false;
}

function sourceForInst(inst, reason = null) {
  if (!inst) return sourceOf();
  return sourceOf({
    address: inst.address ?? null, row: inst.row ?? null, ir: inst.id ?? null,
    evidence: reason ? [{ reason }] : [],
  });
}

function dependencySource(value, ctx, seen = new Set(), depth = 0) {
  if (!value || depth > MAX_EXPR_DEPTH || seen.has(value.id)) return sourceOf();
  seen.add(value.id);
  const d = value.def;
  if (!d) return sourceOf({ ssaUse: value.id });
  const parts = [sourceForInst(d), sourceOf({ ssaDef: value.id })];
  if (d.op === OP.PHI) {
    for (const incoming of d.incoming || []) parts.push(dependencySource(incoming.value, ctx, seen, depth + 1));
  } else if (d.op === OP.LOAD) {
    // A fixed stack slot's SP/FP arithmetic is frame-construction provenance,
    // not source provenance for the value loaded from that slot. Including it
    // makes unrelated prologue instructions (for example 0x...490 STP) appear
    // to own later C statements. Keep the load itself, but stop at the stack
    // memory boundary. Non-stack addressing still retains its base/index defs.
    if (d.loc?.kind !== MK.STACK) {
      parts.push(dependencySource(d.addr?.base, ctx, seen, depth + 1));
      parts.push(dependencySource(d.addr?.index, ctx, seen, depth + 1));
    }
  } else {
    for (const arg of d.args || []) parts.push(dependencySource(valueOf(arg), ctx, seen, depth + 1));
  }
  return mergeSource(...parts);
}

function controlSource(inst) {
  if (!inst) return sourceOf();
  const flags = valueOf(inst.args?.[inst.args.length - 1]);
  const cmp = cmpFromFlags(flags);
  return mergeSource(sourceForInst(cmp, cmp ? 'condition compare' : null), sourceForInst(inst, 'control transfer'));
}

function storeSource(inst, ctx) {
  return mergeSource(
    dependencySource(valueOf(inst.args?.[0]), ctx),
    dependencySource(inst.addr?.base, ctx),
    dependencySource(inst.addr?.index, ctx),
    sourceForInst(inst, 'memory store'),
  );
}

function callSource(inst, call, ctx) {
  const parts = [sourceForInst(inst, 'call')];
  for (const index of call?.sourceArgIndices || []) {
    parts.push(dependencySource(reachingRegisterValue(ctx.ir, inst, `x${index}`), ctx));
  }
  return mergeSource(...parts);
}

function buildStoredValueAliases(ir) {
  const out = new Map();
  for (const inst of ir?.instructions || []) {
    if (inst.op !== OP.STORE) continue;
    const value = valueOf(inst.args?.[0]);
    if (!value) continue;
    if (!out.has(value.id)) out.set(value.id, []);
    out.get(value.id).push(inst);
  }
  return out;
}

/*
 * Once `v = old_field - damage` has been committed by a STORE, a following CMP
 * of v is a comparison of the new field value. Re-expanding v as
 * `field - damage` after emitting `field -= damage` would apply the subtraction
 * twice in the source program. Alias it back to the committed lvalue only when
 * same-basic-block ordering and the absence of an intervening memory/call
 * barrier prove that substitution safe.
 */
function storedValueAlias(value, atInst, ctx) {
  if (!value || !atInst) return null;
  const stores = ctx.storedValueAliases?.get(value.id) || [];
  for (let n = stores.length - 1; n >= 0; n--) {
    const store = stores[n];
    if (store.block !== atInst.block || store.row == null || atInst.row == null || store.row >= atInst.row) continue;
    const blocked = (ctx.ir.blocks?.[atInst.block]?.insts || []).some((inst) =>
      inst.row > store.row && inst.row < atInst.row && (inst.op === OP.STORE || inst.op === OP.CALL || inst.op === OP.UNKNOWN));
    if (blocked) continue;
    return renderMemoryLocation(store.loc, store, ctx);
  }
  return null;
}

function renderValueAt(value, atInst, ctx) {
  return storedValueAlias(value, atInst, ctx) || renderValue(value, ctx);
}

function canonicalRegister(reg) {
  const text = String(reg || '').toLowerCase();
  const m = /^[wx](\d+)$/.exec(text);
  return m ? `r${m[1]}` : text;
}

function loadReachedByStore(load, store, ctx) {
  if (load?.op !== OP.LOAD || load.loc?.key !== store.loc?.key || load.row <= store.row) return false;
  if (load.reachingStore) return load.reachingStore === store;
  // Conservative linear fallback for older IR producers without a reachingStore
  // annotation. Cross-block cases require Memory SSA proof.
  if (load.block !== store.block) return false;
  return !(ctx.ir.blocks?.[load.block]?.insts || []).some((x) =>
    x.op === OP.STORE && x.loc?.key === store.loc?.key && x.row > store.row && x.row < load.row);
}

function returnRegisterForContext(ctx) {
  const type=String(ctx.opts?.returnType || ctx.opts?.functionPrototype?.returnType || ctx.opts?.prototype?.returnType || ctx.types?.ret?.type || '').toLowerCase();
  if (!type || type === 'void') return null;
  // The calling convention owns this, not the decompiler. Assuming `x0` is the
  // result register is an AArch64 fact; on RISC-V `x0` is hardwired zero, so a
  // hardcoded name would read the wrong location entirely. Callers that supply
  // no ABI adapter are the legacy AArch64 IR facade, whose behaviour is kept.
  const fromAbi = ctx.opts?.abiAdapter?.returnRegister?.({ returnType: type });
  if (fromAbi) return String(fromAbi);
  if (ctx.opts?.abiAdapter) return null;
  return /^(float|double|__fp16)/.test(type) || /vector|simd/.test(type) ? 'v0' : 'x0';
}

/*
 * Registers whose spill/restore is call-frame bookkeeping rather than program
 * data. The ABI names them; `r29`/`r30` are AArch64's frame pointer and link
 * register and mean nothing on another target.
 */
function frameBookkeepingRegisters(ctx) {
  const declared = ctx.opts?.abiAdapter?.frameBookkeepingRegisters?.();
  if (Array.isArray(declared)) return new Set(declared.map(canonicalRegister));
  if (ctx.opts?.abiAdapter) return new Set();
  return new Set(['r29', 'r30']);
}
function returnValueAt(ret, ctx) {
  const explicit=valueOf(ret?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForContext(ctx);
  return reg ? reachingRegisterValue(ctx.ir, ret, reg) : null;
}

function feedsReturn(value, ctx) {
  if (!value) return false;
  for (const ret of ctx.returnInsts || []) {
    const rv = returnValueAt(ret, ctx);
    if (sameValue(value, rv)) return true;
  }
  return false;
}

/* Hide only stack stores whose loads prove register preservation/return spill. */
function isMechanicalStackSpill(inst, ctx) {
  if (inst?.op !== OP.STORE || inst.loc?.kind !== MK.STACK) return false;
  const stored = valueOf(inst.args?.[0]);
  const reg = canonicalRegister(stored?.reg);
  if (reg && frameBookkeepingRegisters(ctx).has(reg)) return true; // frame pointer / return address save
  const loads = (ctx.ir.instructions || []).filter((x) => loadReachedByStore(x, inst, ctx));
  if (!loads.length) return false;
  return loads.every((load) =>
    (reg && canonicalRegister(load.dst?.reg) === reg) || feedsReturn(load.dst, ctx));
}

function stringLiteralAt(addr, ctx) {
  if (addr == null) return null;
  try {
    const direct = ctx.opts.stringFor?.(BigInt(addr));
    if (typeof direct === 'string') return JSON.stringify(direct);
  } catch { /* optional resolver */ }
  for (const ref of ctx.model.addressRefs || []) {
    if (ref?.addr == null || typeof ref.text !== 'string') continue;
    try { if (BigInt(ref.addr) === BigInt(addr)) return JSON.stringify(ref.text); } catch { /* malformed ref */ }
  }
  return null;
}

function stringLiteralForValue(value, ctx) {
  if (value?.const == null) return null;
  const defRow = value.def?.row;
  for (const ref of ctx.model.addressRefs || []) {
    if (ref?.row !== defRow || ref?.addr == null || typeof ref.text !== 'string') continue;
    try { if (BigInt(ref.addr) === BigInt(value.const)) return JSON.stringify(ref.text); } catch { /* malformed ref */ }
  }
  // A direct ADR/ADRP value is intrinsically address-like. For arithmetic
  // constants require the exact row+addressRef proof above.
  return value.def?.op === OP.ADDR ? stringLiteralAt(value.const, ctx) : null;
}

function formatFloatConst(v, bits = 64) {
  const n=Number(v);
  if (Number.isNaN(n)) return 'NAN';
  if (n === Infinity) return 'INFINITY';
  if (n === -Infinity) return '-INFINITY';
  let text=Object.is(n,-0) ? '-0.0' : String(n);
  if (!/[.eE]/.test(text)) text += '.0';
  return Number(bits || 64) <= 32 ? text + 'f' : text;
}

function formatConst(v, bits = 64, signed = null) {
  if (v == null) return 'unknown';
  return integerText(v, bits, signed);
}

function dominatorDepth(ir, block) {
  let d = 0, b = block, guard = 0;
  while (b != null && b >= 0 && guard++ < ir.blocks.length + 2) { d++; b = ir.idom?.[b] ?? ir.blocks[b]?.idom ?? -1; }
  return d;
}

/** SSA value reaching a call/block point, based only on dominance/version facts. */
export function reachingRegisterValue(ir, atInst, reg) {
  if (!ir || !atInst || !reg) return null;
  let best = ir.args?.get?.(reg) || null;
  let bestDepth = -1, bestRow = -Infinity;
  for (const v of ir.values || []) {
    if (v.reg !== reg || !v.def) continue;
    const d = v.def;
    if (d === atInst) continue;
    if (d.block === atInst.block) {
      if (d.row == null || atInst.row == null || d.row >= atInst.row) continue;
      const depth = 100000 + d.row;
      if (depth > bestDepth) { best = v; bestDepth = depth; bestRow = d.row; }
      continue;
    }
    const dom = ir.dominators?.[atInst.block];
    if (!dom || !dom.has(d.block)) continue;
    const depth = dominatorDepth(ir, d.block);
    if (depth > bestDepth || (depth === bestDepth && (d.row ?? -Infinity) > bestRow)) {
      best = v; bestDepth = depth; bestRow = d.row ?? -Infinity;
    }
  }
  return best?.clobbered ? null : best;
}

function objcIvar(ctx, base, offset) {
  const index = ctx.runtime?.objc;
  const t = ctx.types?.values?.get(base?.id);
  const className = t?.className || t?.semanticType?.className || ctx.opts.receiverType || null;
  if (!index || !className) return null;
  let name = String(className).replace(/\s*\*$/, '');
  const seen = new Set();
  while (name && !seen.has(name)) {
    seen.add(name);
    const c = index.classes.get(name);
    if (!c) break;
    for (const iv of c.ivars || []) {
      if (Number(iv.offset) === Number(offset)) return { name: iv.name || `field_${hex(offset)}`, type: iv.type || null, className: name };
    }
    name = c.superName || null;
  }
  return null;
}

function stackName(ctx, loc) {
  const hit = (ctx.ir.stackSlots || []).find((s) => s.key === loc.key || String(s.offset ?? s.disp) === String(loc.disp));
  return hit?.name || `var_${loc.disp < 0n ? 'm' : ''}${hex(loc.disp < 0n ? -loc.disp : loc.disp)}`;
}

export function renderMemoryLocation(loc, inst, ctx) {
  if (!loc) return 'memory_unknown';
  if (loc.kind === MK.STACK) return stackName(ctx, loc);
  if (loc.kind === MK.GLOBAL) {
    const name = ctx.opts.symbolFor?.(loc.address);
    return name ? safeIdent(name, `global_${hex(loc.address)}`) : `global_${hex(loc.address)}`;
  }
  const addr = inst?.addr || {};
  if (loc.kind === MK.UNKNOWN) {
    if (addr.base && addr.index) {
      const base = renderValue(addr.base, ctx);
      const index = renderValue(addr.index, ctx);
      return renderIndexedMemory(base, index, {
        extend: addr.extend || null,
        scale: addr.scale || 0,
        size: Number(addr.size || 0),
      });
    }
    return 'memory_unknown';
  }
  if (loc.kind === MK.FIELD) {
    const base = loc.base || addr.base;
    const off = loc.disp ?? 0n;
    const baseText = renderValue(base, ctx, { asBase: true });
    let known = null;
    try { known = ctx.opts.fieldFor?.(addr.baseReg || base?.reg || null, off, inst?.row); } catch { known = null; }
    if (!known) known = objcIvar(ctx, base, off);
    const field = safeIdent(known?.name || `field_${hex(off)}`, `field_${hex(off)}`);
    return `${baseText}->${field}`;
  }
  return 'memory_unknown';
}

function argName(v, ctx) {
  if (!v?.reg) return `v${v?.id ?? 0}`;
  const m = /^x([0-7])$/.exec(v.reg);
  if (!m) return safeIdent(v.label || v.reg);
  const n = Number(m[1]);
  if (n === 0 && (ctx.opts.receiverType || ctx.opts.methodKind === 'objc')) return 'self';
  return ctx.opts.argNames?.[n] || `a${n + 1}`;
}

function cmpFromFlags(flagValue) {
  const d = flagValue?.def;
  return d && d.op === OP.CMP ? d : null;
}

function renderCmp(cmp, cond, ctx, atInst = cmp) {
  if (!cmp) return cond ? `condition_${cond}` : 'condition';
  const aValue = valueOf(cmp.args?.[0]);
  const bValue = valueOf(cmp.args?.[1]);
  const a = renderValueAt(aValue, atInst, ctx);
  const b = renderValueAt(bValue, atInst, ctx);
  const bits = Number(cmp.bits || aValue?.bits || bValue?.bits || 64);
  const rendered = renderNZCVCondition(cmp.sub || 'sub', cond, a, b, bits, {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    evidence: [{ reason: `AArch64 ${cmp.sub || 'unknown'} NZCV semantics` }],
  });
  return rendered || `${a} /* ${cond || 'flags'} */`;
}

export function renderBranchCondition(inst, ctx, invert = false) {
  if (!inst || inst.op !== OP.CBR) return 'condition';
  const kind = inst.extra?.kind || inst.sub || '';
  let s;
  if (kind === 'cbz' || kind === 'cbnz') {
    s = `${renderValueAt(valueOf(inst.args?.[0]), inst, ctx)} ${kind === 'cbz' ? '==' : '!='} 0`;
  } else if (kind === 'tbz' || kind === 'tbnz') {
    const bit = inst.extra?.bit ?? 0;
    s = `((${renderValueAt(valueOf(inst.args?.[0]), inst, ctx)} >> ${bit}) & 1) ${kind === 'tbz' ? '==' : '!='} 0`;
  } else {
    let cond = inst.cond || inst.extra?.cond || null;
    if (!cond || !isNZCVCondition(cond)) {
      return `__arm64_condition_${safeIdent(cond || 'unknown')}(/* NZCV */)`;
    }
    if (invert) {
      const inverse = inverseCondition(cond);
      if (!inverse || !isNZCVCondition(inverse)) {
        return `!(__arm64_condition_${safeIdent(cond)}(/* NZCV */))`;
      }
      cond = inverse;
    }
    const flags = valueOf(inst.args?.[inst.args.length - 1]);
    return renderCmp(cmpFromFlags(flags), cond, ctx, inst);
  }
  return invert ? `!(${s})` : s;
}

function selectAsMinMax(inst, ctx) {
  if (!inst || inst.op !== OP.SEL || inst.args.length < 3) return null;
  const t = valueOf(inst.args[0]), f = valueOf(inst.args[1]), flags = valueOf(inst.args[2]);
  const cmp = cmpFromFlags(flags);
  if (!cmp || cmp.args.length < 2 || cmp.sub !== 'sub' || cmp.extra?.conditional) return null;
  const a = valueOf(cmp.args[0]), b = valueOf(cmp.args[1]);
  const cond = inst.cond;
  const tt = renderValue(t, ctx), ff = renderValue(f, ctx), aa = renderValue(a, ctx), bb = renderValue(b, ctx);
  if (cond === 'gt' || cond === 'hi') {
    if (sameValue(t, b) && sameValue(f, a)) return `min(${aa}, ${bb})`;
    if (sameValue(t, a) && sameValue(f, b)) return `max(${aa}, ${bb})`;
  }
  if (cond === 'lt' || cond === 'lo') {
    if (sameValue(t, b) && sameValue(f, a)) return `max(${aa}, ${bb})`;
    if (sameValue(t, a) && sameValue(f, b)) return `min(${aa}, ${bb})`;
  }
  return null;
}

function binText(inst, ctx) {
  const a = renderValue(valueOf(inst.args?.[0]), ctx);
  const b = renderValue(valueOf(inst.args?.[1]), ctx);
  const op = {
    add: '+', sub: '-', mul: '*', smull: '*', umull: '*', sdiv: '/', udiv: '/',
    and: '&', or: '|', xor: '^', bic: '& ~', shl: '<<', lshr: '>>', ashr: '>>', ror: 'ror',
    fadd: '+', fsub: '-', fmul: '*', fdiv: '/',
  }[inst.sub];
  if (inst.sub === 'ror') return `ror(${a}, ${b})`;
  if (!op) return `unknown_${safeIdent(inst.sub || 'bin')}(${a}${inst.args?.length > 1 ? ', ' + b : ''})`;
  return `${paren(a)} ${op} ${paren(b)}`;
}

function unaryText(inst, ctx) {
  const a = renderValue(valueOf(inst.args?.[0]), ctx);
  if (inst.sub === 'neg' || inst.sub === 'fneg') return `-${paren(a)}`;
  if (inst.sub === 'not') return `~${paren(a)}`;
  if (inst.sub === 'abs' || inst.sub === 'fabs') return `abs(${a})`;
  if (inst.sub === 'sqrt' || inst.sub === 'fsqrt') return `sqrt(${a})`;
  if (/^sxt/.test(inst.sub || '')) return `(${inst.sub.replace('sxt', 'int')})${paren(a)}`;
  if (/^uxt/.test(inst.sub || '')) return `(${inst.sub.replace('uxt', 'uint')})${paren(a)}`;
  return `${safeIdent(inst.sub || 'un')}(${a})`;
}

function callRecord(inst, ctx) {
  if (ctx.callCache.has(inst.id)) return ctx.callCache.get(inst.id);
  const target = inst.extra?.target ?? null;
  const modelCall = (ctx.model.calls || []).find((c) => c.row === inst.row) || null;
  const name = modelCall?.name || (target != null ? ctx.opts.symbolFor?.(target) : null) || inst.extra?.name || '';
  const values = [];
  for (let i = 0; i < 8; i++) values.push(reachingRegisterValue(ctx.ir, inst, 'x' + i));
  const argText = values.map((v) => v ? renderValue(v, ctx) : null);
  const origin = runtimeOriginForSymbol(name);
  const objc = origin === 'objc' || /objc_msgSend/.test(name);
  let selector = modelCall?.selector || null;
  let receiverType = null;
  if (objc) {
    const selValue = values[1];
    const selAddr = selValue?.const ?? (selValue?.def?.op === OP.ADDR ? selValue.const : null);
    if (!selector && selAddr != null) selector = ctx.opts.selectorFor?.(selAddr) || ctx.runtime?.selectors?.byAddress?.get(selAddr.toString())?.[0]?.selector || null;
    receiverType = typeNameOf(ctx.types.values.get(values[0]?.id));
    if (receiverType === 'unknown' || receiverType === 'id' || receiverType === 'void *') receiverType = ctx.opts.receiverType || null;
  }

  let logicalArgs = [];
  let sourceArgIndices = [];
  let arityKnown = true;
  let variadicPrefixOnly = false;
  if (objc) {
    const selectorArity = selector ? (selector.match(/:/g) || []).length : null;
    if (selectorArity == null) {
      arityKnown = false;
      sourceArgIndices = [0, 1].filter((i) => values[i]);
    } else {
      const indexes = Array.from({ length: selectorArity }, (_, i) => i + 2).filter((i) => i < 8);
      logicalArgs = indexes.map((i) => argText[i]).filter((x) => x != null);
      sourceArgIndices = [0, 1, ...indexes].filter((i) => values[i]);
    }
  } else {
    let override = null;
    try { override = ctx.opts.callPrototypeFor?.(target, name, inst) || null; } catch { override = null; }
    const indexes = callArgumentIndices({ name, modelCall, override, defaultCallArgs: ctx.opts.defaultCallArgs });
    if (indexes == null) {
      arityKnown = false;
      ctx.unknownCallArities++;
    } else {
      logicalArgs = indexes.map((i) => argText[i] ?? 'unknown');
      sourceArgIndices = indexes.filter((i) => values[i]);
      variadicPrefixOnly = !!knownCallPrototype(name)?.variadic && !override;
    }
  }

  const info = {
    name, target, runtime: origin, args: logicalArgs, arityKnown, variadicPrefixOnly, sourceArgIndices,
    receiver: argText[0] || 'receiver', receiverType, selector,
    stubAddress: target, callingConvention: ctx.opts.swiftCallingConventionFor?.(target, name) || null,
    kind: ctx.opts.swiftDispatchFor?.(inst)?.kind || (inst.extra?.indirect ? 'indirect' : 'direct'),
    ...(ctx.opts.swiftDispatchFor?.(inst) || {}),
  };
  const resolved = resolveAppleCall(ctx.runtime, info);
  const rec = { ...info, resolved };
  ctx.callCache.set(inst.id, rec);
  return rec;
}

function renderCall(inst, ctx) {
  const c = callRecord(inst, ctx);
  if (c.resolved.runtime === 'objc' && c.resolved.message) return c.resolved.message.text;
  if (c.resolved.runtime === 'swift' && c.resolved.text) return c.resolved.text;
  const name = c.name ? safeIdent(c.name, 'unknown_call') : null;
  if (name) {
    const args = !c.arityKnown ? '/* arguments unknown */'
      : c.args.join(', ') + (c.variadicPrefixOnly ? `${c.args.length ? ', ' : ''}/* varargs unknown */` : '');
    return `${name}(${args})`;
  }
  const targetValue = valueOf(inst.args?.[0]);
  return `unknown_call(${targetValue ? renderValue(targetValue, ctx) : '/* target unknown */'})`;
}

/** Reconstruct one SSA value as an expression with memoization and hard budgets. */
export function renderValue(value, ctx, flags = {}) {
  if (!value) return 'unknown';
  if (ctx.materialNames?.has(value.id) && !flags.ignoreMaterial) return ctx.materialNames.get(value.id);
  const key = `${value.id}:${flags.asBase ? 'b' : 'v'}`;
  if (ctx.exprCache.has(key)) return ctx.exprCache.get(key);
  if (ctx.exprActive.has(value.id) || ctx.exprNodes++ > MAX_EXPR_NODES) return value.reg ? safeIdent(value.reg) : `v${value.id}`;
  ctx.exprActive.add(value.id);
  let out = null;
  if (value.constKind === 'float' || value.floatConst != null || (value.float != null && value.const == null)) out = formatFloatConst(value.floatConst ?? value.float, value.bits);
  if (!out && value.const != null && value.def?.op !== OP.ADDR) out = stringLiteralForValue(value, ctx) || formatConst(value.const, value.bits);
  if (!out && value.kind === VK.ARG) out = argName(value, ctx);
  const d = value.def;
  if (!out && d) {
    if (d.op === OP.CONST) out = (value.constKind === 'float' || value.floatConst != null || value.float != null)
      ? formatFloatConst(value.floatConst ?? value.float, value.bits)
      : formatConst(value.const ?? d.extra?.value ?? 0n, value.bits, value.signed ?? null);
    else if (d.op === OP.MOV) out = renderValue(valueOf(d.args?.[0]), ctx);
    else if (d.op === OP.BIN) out = binText(d, ctx);
    else if (d.op === OP.UN) out = unaryText(d, ctx);
    else if (d.op === OP.MAC) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), b0 = renderValue(valueOf(d.args?.[1]), ctx), c0 = renderValue(valueOf(d.args?.[2]), ctx);
      const widen=d.extra?.widen;
      const b=widen==='signed'?`(int64_t)(int32_t)${paren(b0)}`:widen==='unsigned'?`(uint64_t)(uint32_t)${paren(b0)}`:b0;
      const c=widen==='signed'?`(int64_t)(int32_t)${paren(c0)}`:widen==='unsigned'?`(uint64_t)(uint32_t)${paren(c0)}`:c0;
      out = d.sub === 'msub' ? `${paren(a)} - ${paren(b)} * ${paren(c)}` : `${paren(a)} + ${paren(b)} * ${paren(c)}`;
    } else if (d.op === OP.BFX) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), l=d.extra?.lsb ?? 0, w=d.extra?.width ?? '?';
      if (d.extra?.toward === 'left') out = `${d.extra?.signed?'__arm64_sbfiz':'__arm64_ubfiz'}(${a}, ${l}, ${w})`;
      else out = `${d.extra?.signed?'__arm64_sbfx':'bit_extract'}(${a}, ${l}, ${w})`;
    } else if (d.op === OP.BFI) {
      const a = renderValue(valueOf(d.args?.[0]), ctx), b = renderValue(valueOf(d.args?.[1]), ctx), l=d.extra?.lsb ?? 0, w=d.extra?.width ?? '?';
      out = d.extra?.bitfieldKind === 'bfxil' ? `bit_insert(${a}, bit_extract(${b}, ${l}, ${w}), 0, ${w})` : `bit_insert(${a}, ${b}, ${l}, ${w})`;
    } else if (d.op === OP.LOAD) {
      if (d.reachingStore && !flags.noMemoryFold && d.reachingStore !== d) out = renderValue(valueOf(d.reachingStore.args?.[0]), ctx);
      else out = renderMemoryLocation(d.loc, d, ctx);
    } else if (d.op === OP.SEL) {
      out = selectAsMinMax(d, ctx);
      if (!out) {
        const t = renderValue(valueOf(d.args?.[0]), ctx), f = renderValue(valueOf(d.args?.[1]), ctx);
        const cond = renderCmp(cmpFromFlags(valueOf(d.args?.[2])), d.cond, ctx);
        out = `(${cond} ? ${t} : ${f})`;
      }
    } else if (d.op === OP.ADDR) {
      const addr = value.const ?? d.extra?.value ?? d.extra?.target;
      const literal = stringLiteralForValue(value, ctx) || stringLiteralAt(addr, ctx);
      out = literal || (addr != null ? (ctx.opts.symbolFor?.(addr) ? safeIdent(ctx.opts.symbolFor(addr)) : `&global_${hex(addr)}`) : 'address_unknown');
    } else if (d.op === OP.CALL) out = renderCall(d, ctx);
    else if (d.op === OP.PHI) {
      const parts = (d.incoming || []).map((x) => renderValue(x.value, ctx)).filter(Boolean);
      const uniq = [...new Set(parts)];
      out = uniq.length === 1 ? uniq[0] : `phi(${uniq.join(', ')})`;
    }
  }
  if (!out) out = value.reg ? safeIdent(value.reg) : `v${value.id}`;
  ctx.exprActive.delete(value.id);
  ctx.exprCache.set(key, out);
  return out;
}

function targetBlock(ir, cbr, rowOfAddress) {
  // Prefer the taken-edge block the semantic projection already proved. The
  // v2->v1 projection resolves conditional-branch targets from Semantic IR
  // control targets, so the block index is direct evidence and needs no
  // address round-trip. Callers that build IR from a linear listing (the legacy
  // js/ir.js facade) have no such evidence and still resolve by address.
  const provenBlock = cbr?.extra?.targetBlock;
  if (Number.isInteger(provenBlock) && ir.blocks?.[provenBlock] != null) return provenBlock;
  const addr = cbr?.extra?.target;
  if (addr == null) return null;
  const row = rowOfAddress?.(addr);
  if (row == null) return null;
  return ir.blocks.find((b) => row >= b.startRow && row <= b.endRow)?.index ?? null;
}

function branchSucc(ir, block, term, ctx) {
  const succ = block.succ || [];
  if (term?.op !== OP.CBR || succ.length < 2) return { yes: succ[0] ?? null, no: succ[1] ?? null, exact: term?.op !== OP.CBR };
  const yes = targetBlock(ir, term, ctx.opts.rowOfAddress);
  if (yes == null || !succ.includes(yes)) return { yes: null, no: null, exact: false };
  return { yes, no: succ.find((x) => x !== yes) ?? null, exact: true };
}

function blockTerm(block) {
  const xs = block.insts || [];
  for (let i = xs.length - 1; i >= 0; i--) if ([OP.CBR, OP.BR, OP.RET].includes(xs[i].op)) return xs[i];
  return null;
}

function materialization(ctx) {
  const names = new Map();
  for (const v of ctx.ir.values || []) {
    if (!v.def || v.def.op !== OP.CALL) continue;
    const meaningfulUses = (v.uses || []).filter((u) => u !== v.def && !u.clobbered);
    if (meaningfulUses.length) names.set(v.id, `call_${v.id}`);
  }
  return names;
}

function rmwOperand(rmw, ctx) {
  void ctx;
  const loadValue=rmw.load?.dst;
  const written=valueOf(rmw.store?.args?.[0]);
  const inst=written?.def;
  if (!inst || inst.op !== OP.BIN || !['add','sub','mul','sdiv','udiv'].includes(inst.sub)) return null;
  const a=valueOf(inst.args?.[0]), b=valueOf(inst.args?.[1]);
  if (sameValue(a,loadValue)) return { op:inst.sub, other:b, reversed:false };
  if (sameValue(b,loadValue)) return { op:inst.sub, other:a, reversed:true };
  return null;
}

function statementForStore(inst, ctx) {
  const lhs = renderMemoryLocation(inst.loc, inst, ctx);
  const rmw = ctx.rmwByStore.get(inst.id);
  if (rmw) {
    const hasSelect = (rmw.chain || []).some((x) => x.op === OP.SEL);
    const upd = rmwOperand(rmw, ctx);
    if (upd && !hasSelect && !upd.reversed) {
      const rhs = renderValue(upd.other, ctx);
      const op = { add: '+=', sub: '-=', mul: '*=', sdiv: '/=', udiv: '/=' }[upd.op];
      if (upd.op === 'add' && upd.other?.const === 1n) return `${lhs}++;`;
      if (upd.op === 'sub' && upd.other?.const === 1n) return `${lhs}--;`;
      if (op) return `${lhs} ${op} ${rhs};`;
    }
  }
  const rhs = renderValue(valueOf(inst.args?.[0]), ctx, { noMemoryFold: true });
  return `${lhs} = ${rhs};`;
}

function evidenceOf(inst, reason) {
  return { row: inst.row, address: inst.address ?? null, ir: inst.id, op: inst.op, text: inst.text || null, reason };
}

function emitBlockStatements(block, out, ctx, indent) {
  const term = blockTerm(block);
  for (const inst of block.insts || []) {
    if (inst === term || inst.op === OP.CMP || inst.op === OP.PHI || inst.op === OP.LOAD || inst.op === OP.CONST || inst.op === OP.MOV || inst.op === OP.BIN || inst.op === OP.UN || inst.op === OP.SEL || inst.op === OP.ADDR || inst.op === OP.MAC || inst.op === OP.BFX || inst.op === OP.BFI || inst.op === OP.CLOBBER) continue;
    if (inst.op === OP.STORE) {
      if (isMechanicalStackSpill(inst, ctx)) {
        ctx.suppressed.push(evidenceOf(inst, 'compiler-only stack spill'));
        continue;
      }
      const text = statementForStore(inst, ctx);
      out.push(line('stmt', indent, text, inst.row, inst.address, { source: storeSource(inst, ctx) }));
      ctx.evidence.push(evidenceOf(inst, 'Memory SSA store'));
    } else if (inst.op === OP.CALL) {
      const c = callRecord(inst, ctx);
      if (shouldFoldRuntimeCall(c.name, { expert: ctx.opts.expert })) { ctx.suppressed.push(evidenceOf(inst, `folded runtime noise: ${c.name}`)); continue; }
      const call = renderCall(inst, ctx);
      const extra = { source: callSource(inst, c, ctx) };
      if (inst.dst && ctx.materialNames.has(inst.dst.id)) out.push(line('stmt', indent, `${ctx.materialNames.get(inst.dst.id)} = ${call};`, inst.row, inst.address, extra));
      else out.push(line('stmt', indent, `${call};`, inst.row, inst.address, extra));
      ctx.evidence.push(evidenceOf(inst, c.resolved.runtime === 'objc' ? 'Objective-C dispatch' : c.resolved.runtime === 'swift' ? 'Swift dispatch' : 'call'));
    } else if (inst.op === OP.UNKNOWN) {
      out.push(line('stmt', indent, `__asm(${JSON.stringify(inst.text || 'unknown')});`, inst.row, inst.address, { source: sourceForInst(inst, 'unsupported instruction') })); ctx.unknown++;
      ctx.evidence.push(evidenceOf(inst, 'unsupported IR instruction retained faithfully'));
    }
  }
  return term;
}

/** Recover canonical SSA induction variables. */
export function recoverInductionVariables(ir, ctx = null) {
  const out = [];
  for (const loop of ir.loops || []) {
    const block = ir.blocks[loop.header];
    for (const phi of block?.phis || []) {
      if (!phi.dst || (phi.incoming || []).length !== 2) continue;
      const outside = phi.incoming.find((x) => !loop.nodes.has(x.from));
      const inside = phi.incoming.find((x) => loop.nodes.has(x.from));
      if (!outside || !inside) continue;
      const stepDef = inside.value?.def;
      if (!stepDef || stepDef.op !== OP.BIN || !['add', 'sub'].includes(stepDef.sub)) continue;
      const a = valueOf(stepDef.args?.[0]), b = valueOf(stepDef.args?.[1]);
      let step = null;
      if (sameValue(a, phi.dst) && b?.const != null) step = stepDef.sub === 'add' ? b.const : -b.const;
      else if (stepDef.sub === 'add' && sameValue(b, phi.dst) && a?.const != null) step = a.const;
      if (step == null) continue;
      const term = blockTerm(block);
      if (!term || term.op !== OP.CBR) continue;
      const name = `i${out.length || ''}`;
      out.push({ loop, phi, value: phi.dst, name, init: outside.value, step, conditionInst: term,
        initText: ctx ? renderValue(outside.value, ctx) : null,
        conditionText: ctx ? renderBranchCondition(term, ctx) : null });
    }
  }
  return out;
}

function loopRender(loop, block, term, ctx, state, indent, stop) {
  if (!term || term.op !== OP.CBR || loop.exits.size !== 1 || block.succ.length !== 2) return null;
  const { yes, no } = branchSucc(ctx.ir, block, term, ctx);
  const yesInside = loop.nodes.has(yes), noInside = loop.nodes.has(no);
  if (yesInside === noInside) return null;
  const bodyStart = yesInside ? yes : no;
  const exit = yesInside ? no : yes;
  const invert = !yesInside;
  const iv = ctx.inductions.find((x) => x.loop.header === loop.header);
  let head;
  if (iv && iv.init && iv.conditionInst === term) {
    ctx.materialNames.set(iv.value.id, iv.name);
    const init = renderValue(iv.init, ctx, { ignoreMaterial: true });
    let cond = renderBranchCondition(term, ctx, invert);
    const step = iv.step === 1n ? `${iv.name}++` : iv.step === -1n ? `${iv.name}--` : `${iv.name} += ${iv.step}`;
    head = `for (${typeNameOf(ctx.types.values.get(iv.value.id)) === 'unknown' ? 'int64' : typeNameOf(ctx.types.values.get(iv.value.id))} ${iv.name} = ${init}; ${cond}; ${step})`;
  } else head = `while (${renderBranchCondition(term, ctx, invert)})`;
  const lines = [line('ctrl', indent, `${head} {`, term.row, term.address, { source: controlSource(term) })];
  const local = { ...state, activeLoop: loop, loopHeader: loop.header, loopExit: exit };
  emitRegion(bodyStart, loop.header, lines, ctx, local, indent + 1, loop.nodes);
  lines.push(line('ctrl', indent, '}'));
  return { lines, next: exit === stop ? stop : exit };
}

function emitRegion(start, stop, out, ctx, state, indent, allowed = null) {
  let bi = start, guard = 0;
  while (bi != null && bi !== stop && guard++ < MAX_BLOCKS) {
    if (allowed && !allowed.has(bi)) return;
    if (state.activeLoop && bi === state.loopHeader) return;
    if (state.visited.has(bi)) { out.push(line('stmt', indent, `goto loc_${hex(ctx.blockAddress(bi))};`)); state.gotos++; return; }
    state.visited.add(bi);
    const block = ctx.ir.blocks[bi];
    if (!block) return;

    const loop = ctx.graph.loopByHeader.get(bi);
    const term = blockTerm(block);
    if (loop && !state.activeLoop) {
      emitBlockStatements(block, out, ctx, indent);
      const lr = loopRender(loop, block, term, ctx, state, indent, stop);
      if (lr) { out.push(...lr.lines); bi = lr.next; continue; }
    }

    const term2 = emitBlockStatements(block, out, ctx, indent);
    if (!term2) { bi = block.succ.length === 1 ? block.succ[0] : null; continue; }
    if (term2.op === OP.RET) {
      const rv = returnValueAt(term2, ctx);
      const text = rv && ((rv.uses || []).length || rv.const != null || rv.def) ? `return ${renderValue(rv, ctx)};` : 'return;';
      out.push(line('stmt', indent, text, term2.row, term2.address, { source: mergeSource(dependencySource(rv, ctx), sourceForInst(term2, 'return')) })); ctx.evidence.push(evidenceOf(term2, 'return')); return;
    }
    if (term2.op === OP.BR) {
      const next = block.succ[0] ?? null;
      if (state.activeLoop && next === state.loopHeader) { out.push(line('ctrl', indent, 'continue;', term2.row, term2.address)); return; }
      if (state.activeLoop && next === state.loopExit) { out.push(line('ctrl', indent, 'break;', term2.row, term2.address)); return; }
      if (next === stop) return;
      if (next != null && !state.visited.has(next) && (!allowed || allowed.has(next))) { bi = next; continue; }
      if (next != null) { out.push(line('stmt', indent, `goto loc_${hex(ctx.blockAddress(next))};`, term2.row, term2.address)); state.gotos++; }
      return;
    }
    if (term2.op === OP.CBR) {
      const sw = ctx.switchByRow.get(term2.row);
      if (sw) {
        const expr = sw.expr || renderValue(reachingRegisterValue(ctx.ir, term2, sw.reg || 'x0'), ctx);
        out.push(line('ctrl', indent, `switch (${expr}) {`, term2.row, term2.address, { source: controlSource(term2) }));
        for (const c of sw.cases || []) out.push(line('ctrl', indent + 1, `case ${c.value}: goto loc_${hex(ctx.blockAddress(c.block))};`));
        if (sw.defaultBlock != null) out.push(line('ctrl', indent + 1, `default: goto loc_${hex(ctx.blockAddress(sw.defaultBlock))};`));
        out.push(line('ctrl', indent, '}')); state.gotos += (sw.cases || []).length + (sw.defaultBlock != null ? 1 : 0); return;
      }
      const { yes, no } = branchSucc(ctx.ir, block, term2, ctx);
      const join = ctx.graph.immediatePostDominators?.[bi];
      const structural = join != null && join !== bi && yes != null && no != null && (!allowed || (allowed.has(yes) && allowed.has(no)));
      if (structural) {
        const yesEmpty = yes === join;
        const noEmpty = no === join;
        if (yesEmpty !== noEmpty) {
          const invert = yesEmpty;
          const bodyStart = yesEmpty ? no : yes;
          const cond = renderBranchCondition(term2, ctx, invert);
          out.push(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source: controlSource(term2) }));
          emitRegion(bodyStart, join, out, ctx, state, indent + 1, allowed);
          out.push(line('ctrl', indent, '}'));
        } else {
          const cond = renderBranchCondition(term2, ctx);
          out.push(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source: controlSource(term2) }));
          emitRegion(yes, join, out, ctx, state, indent + 1, allowed);
          out.push(line('ctrl', indent, '} else {'));
          emitRegion(no, join, out, ctx, state, indent + 1, allowed);
          out.push(line('ctrl', indent, '}'));
        }
        bi = join; continue;
      }
      const cond = renderBranchCondition(term2, ctx);
      if (yes != null) out.push(line('ctrl', indent, `if (${cond}) goto loc_${hex(ctx.blockAddress(yes))};`, term2.row, term2.address, { source: controlSource(term2) }));
      if (no != null) out.push(line('stmt', indent, `goto loc_${hex(ctx.blockAddress(no))};`, term2.row, term2.address));
      state.gotos += (yes != null ? 1 : 0) + (no != null ? 1 : 0); return;
    }
  }
}

function faithfulCfg(ctx, indent = 1) {
  const out = [];
  const reachable = ctx.graph.reachable || new Set(ctx.ir.blocks.map((b) => b.index));
  for (const bi of [...reachable].sort((a, b) => ctx.ir.blocks[a].startRow - ctx.ir.blocks[b].startRow)) {
    const block = ctx.ir.blocks[bi];
    out.push(line('label', indent, `loc_${hex(ctx.blockAddress(bi))}:`, block.startRow, ctx.blockAddress(bi)));
    const term = emitBlockStatements(block, out, ctx, indent + 1);
    if (!term) continue;
    if (term.op === OP.RET) {
      const rv = returnValueAt(term, ctx);
      out.push(line('stmt', indent + 1, rv ? `return ${renderValue(rv, ctx)};` : 'return;', term.row, term.address, { source: mergeSource(dependencySource(rv, ctx), sourceForInst(term, 'return')) }));
    } else if (term.op === OP.CBR) {
      const { yes, no } = branchSucc(ctx.ir, block, term, ctx);
      if (yes != null) out.push(line('ctrl', indent + 1, `if (${renderBranchCondition(term, ctx)}) goto loc_${hex(ctx.blockAddress(yes))};`, term.row, term.address, { source: controlSource(term) }));
      if (no != null) out.push(line('stmt', indent + 1, `goto loc_${hex(ctx.blockAddress(no))};`, term.row, term.address));
    } else if (term.op === OP.BR && block.succ[0] != null) out.push(line('stmt', indent + 1, `goto loc_${hex(ctx.blockAddress(block.succ[0]))};`, term.row, term.address));
  }
  return out;
}

function summarize(lines, ctx) {
  const text = lines.map((l) => l.text).join('\n');
  const rmw = text.match(/(self->\w+)\s*=\s*max\(\1\s*-\s*([^,]+),\s*0\)/);
  if (rmw) return `${rmw[1].replace('self->', '')}から${rmw[2].trim()}を引き、0未満にならないよう制限して保存しています。`;
  const add = text.match(/(self->\w+)\s*\+=\s*([^;]+)/);
  if (add) return `${add[1].replace('self->', '')}に${add[2].trim()}を加えて保存しています。`;
  if (ctx.evidence.some((e) => e.reason === 'Objective-C dispatch')) return 'Objective-C のメッセージ送信を型・selector情報付きで実行しています。';
  if (ctx.evidence.some((e) => e.reason === 'Swift dispatch')) return 'Swift の呼び出しをABI情報付きで実行しています。';
  if (ctx.rmw.length) return '同じメモリ位置を読み、計算結果を書き戻す更新処理を行っています。';
  return 'Semantic IR から復元できた処理を、確認できる範囲でC風に表示しています。';
}

function pseudocode(lines) {
  return lines.map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text}`).join('\n');
}

function runtimeFromOpts(opts) {
  if (opts.appleRuntime?.runtime === 'mixed') return opts.appleRuntime;
  return buildAppleRuntimeIndex({
    objc: opts.objcRuntimeIndex || opts.objcModel || opts.appleRuntime?.objc || null,
    swift: opts.swiftModel || opts.appleRuntime?.swift || null,
    selectorRefs: opts.selectorRefs || [], selectorStubs: opts.selectorStubs || [], fixups: opts.fixups || [],
  });
}

/** Main IR-first entry point. */
export function decompileSemantic(model, opts = {}) {
  const ir = opts.ir || irFor(model, { rowOfAddress: opts.rowOfAddress });
  if (!ir || !ir.instructions?.length) return null;
  const runtime = runtimeFromOpts(opts);
  const types = inferSemanticTypes(ir, model, { runtime, abiAdapter: opts.abiAdapter ?? null });
  const graph = analyzeGraph(ir.blocks.map((b) => b.succ), ir.entry || 0);
  ir.loops = graph.loops;
  // Post-dominance is already computed by analyzeGraph. Attaching it here is
  // what lets P8-5 read the join point of a conditional from the canonical
  // control-flow analysis instead of deriving a second opinion about it.
  ir.postDominators = graph.postDominators;
  ir.ipdom = graph.immediatePostDominators;
  const rmw = readModifyWrite(ir);
  const firstAddr = model.instructions?.[0]?.address ?? opts.addr ?? 0n;
  const ctx = {
    ir, model, opts, runtime, types, graph, rmw,
    rmwByStore: new Map(rmw.map((r) => [r.store.id, r])),
    storedValueAliases: buildStoredValueAliases(ir),
    returnInsts: (ir.instructions || []).filter((i) => i.op === OP.RET),
    exprCache: new Map(), exprActive: new Set(), exprNodes: 0,
    callCache: new Map(), evidence: [], suppressed: [], unknown: 0, unknownCallArities: 0,
    materialNames: new Map(), switchByRow: new Map((opts.switches || model.switches || []).map((s) => [s.row, s])),
    blockAddress: (bi) => model.instructions?.find((x) => x.row === ir.blocks[bi]?.startRow)?.address ?? firstAddr + BigInt(ir.blocks[bi]?.startRow || 0) * 4n,
  };
  ctx.materialNames = materialization(ctx);
  ctx.inductions = recoverInductionVariables(ir, ctx);

  const name = safeIdent(opts.notes?.nameOf?.(opts.addr) || opts.name || model.name || `sub_${hex(opts.addr ?? firstAddr)}`, 'sub');
  const signature = semanticSignature(name, types, opts.notes, opts.addr ?? firstAddr);
  const body = [];
  const state = { visited: new Set(), gotos: 0, activeLoop: null, loopHeader: null, loopExit: null };
  emitRegion(ir.entry || 0, null, body, ctx, state, 1);

  const reachable = graph.reachable || new Set();
  const missing = [...reachable].filter((b) => !state.visited.has(b));
  let coverage = { mode: 'structured', reachable: reachable.size, emitted: state.visited.size, missing: missing.length, recovered: 0, structuredMissing: missing.length };
  if (missing.length) {
    body.length = 0; state.visited.clear(); state.gotos = 0;
    body.push(...faithfulCfg(ctx, 1));
    coverage = { mode: 'linear', reachable: reachable.size, emitted: reachable.size, missing: 0, recovered: missing.length, structuredMissing: missing.length };
  }

  const lines = [
    line('sig', 0, signature, model.instructions?.[0]?.row ?? null, firstAddr, { source: sourceOf({ address: firstAddr, row: model.instructions?.[0]?.row ?? null, evidence: [{ reason: 'function entry' }] }) }),
    line('ctrl', 0, '{'),
  ];
  for (const l of body) lines.push(l);
  lines.push(line('ctrl', 0, '}'));

  const warnings = [...(types.warnings || [])];
  if (state.gotos) warnings.push(`${state.gotos} control-flow edge(s) remain explicit because a safe source structure was not proven.`);
  if (coverage.mode === 'linear') warnings.push('Structured CFG proof was incomplete; faithful address/edge mode was used.');
  if (ctx.unknown) warnings.push(`${ctx.unknown} unsupported IR instruction(s) remain as __asm.`);
  if (ctx.unknownCallArities) warnings.push(`${ctx.unknownCallArities} call site(s) have unknown arity; live argument registers were intentionally not guessed.`);
  if (ir.truncated) warnings.push('Semantic IR budget truncated this function; the result is partial.');

  const summary = summarize(body, ctx);
  return {
    lines, signature, types, summary, pseudocode: pseudocode(lines),
    evidence: ctx.evidence, warnings, labels: new Set(body.filter((l) => l.kind === 'label').map((l) => l.text.replace(/:$/, ''))),
    coverage, ir, ctx: { runtime, suppressed: ctx.suppressed, inductions: ctx.inductions, irPrimary: true, unknownInstructions: ctx.unknown },
    semantic: true,
  };
}
