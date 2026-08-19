/*
 * High-level semantic decompiler pipeline.
 * It consumes the existing Semantic IR/SSA/Memory-SSA and deliberately does not
 * re-interpret ARM64 instruction text. The legacy decompiler remains an isolated
 * fallback at the public facade.
 */
import { expr, mergeSource, sourceOf, mapChildren, structuralKey, sameExpr } from './ast/nodes.js';
import { RewriteEngine } from './rewrite/engine.js';
import { DEFAULT_RULES } from './rewrite/rules.js';
import { recoverArm64ClangIdiom, recognizeClamp, recognizeDivisionByConstant } from './idioms/arm64-clang.js';
import { recoverHighVariables } from './types/high-variables.js';
import { recoverFunctionPrototype } from './types/prototype.js';
import { recoverAggregateLayouts } from './types/layout.js';
import { PassManager } from './passes/manager.js';
import { INTERACTIVE_STAGES as PHASE8_INTERACTIVE_STAGES, PASS_STAGES as PHASE8_ALL_STAGES, runPhase8Stage } from './phase8/index.js';
import { printExpression, printProgram, expressionReadability } from './pretty/c.js';
import { explainSemanticFacts } from './explain.js';
import { buildNZCVConditionExpression } from './flag-semantics.js';

function valueOf(a) { return a?.value || null; }
function safeIdent(s, fallback = 'value') {
  const x = String(s || '').replace(/^_+/, '').replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1');
  return x || fallback;
}
function constNode(v, value = v?.const ?? 0n) { return expr.constant(value, v?.bits || 64, v?.signed ?? null, origin(v?.def, v)); }
function typeFor(state, v) { return state.types?.values?.get?.(v?.id) || null; }
function signedFor(state, v) { const t = typeFor(state, v); return t?.signed ?? v?.signed ?? null; }
function origin(inst, v = null, reason = null) {
  return sourceOf({ address: inst?.address ?? null, row: inst?.row ?? null, ir: inst?.id ?? null, ssaDef: v?.id ?? inst?.dst?.id ?? null,
    ssaUses: (inst?.args || []).map(valueOf).filter(Boolean).map((x) => x.id), evidence: reason ? [{ reason }] : [] });
}

function abiArgumentLocationsForState(state) {
  const functionPrototype = state.opts?.functionPrototype || state.opts?.prototype || state.prototype || null;
  try {
    const locations = state.opts?.abiAdapter?.argumentLocations?.({ functionPrototype });
    if (Array.isArray(locations)) return locations
      .filter((location) => location && typeof location.reg === 'string')
      .map((location, ordinal) => ({
        index:Number.isInteger(Number(location.index)) ? Number(location.index) : ordinal,
        reg:String(location.reg),
        abiClass:location.abiClass ?? null,
      }));
    const registers = state.opts?.abiAdapter?.argumentRegisters?.({ functionPrototype });
    return Array.isArray(registers) ? registers.map((reg, index) => ({ index, reg:String(reg), abiClass:null })) : [];
  } catch { return []; }
}

function abiArgumentLocationForRegister(state, reg) {
  const name = String(reg || '');
  return abiArgumentLocationsForState(state).find((location) => location.reg === name) || null;
}

function argumentName(v, state) {
  const groupId = state.highVariables?.valueToGroup?.get(v?.id);
  const group = state.highVariables?.groups?.find((g) => g.id === groupId);
  if (group?.name) return group.name;
  const reg = String(v?.reg || '');
  const location = abiArgumentLocationForRegister(state, reg);
  if (!location) return safeIdent(reg || `value_${v?.id}`);
  const index = location.index;
  if (index === 0 && (state.opts?.receiverType || state.opts?.methodKind === 'objc')) return 'self';
  return state.opts?.argNames?.[index] || `a${index + 1}`;
}

function encodedLocationIdentity(value) {
  return [...String(value ?? '')].map((char) => /[A-Za-z0-9]/.test(char)
    ? char
    : `_${char.codePointAt(0).toString(16).toUpperCase()}_`).join('');
}

function stackLocationName(loc, addr) {
  const key = typeof loc?.key === 'string' ? loc.key : '';
  const canonical = /^stack:([+-]?\d+)$/.exec(key);
  if (canonical) {
    const coordinate = BigInt(canonical[1]);
    if (coordinate === 0n) return 'local_0';
    const magnitude = (coordinate < 0n ? -coordinate : coordinate).toString(16).toUpperCase();
    return coordinate < 0n ? `local_m${magnitude}` : `local_p${magnitude}`;
  }
  // A malformed/noncanonical key must not collapse onto another slot merely
  // because their local displacements have the same absolute value. Encode the
  // full available identity losslessly enough for a stable C identifier.
  const fallbackIdentity = key || `disp:${String(loc?.disp ?? addr?.disp ?? 'unknown')}`;
  return `local_slot_${encodedLocationIdentity(fallbackIdentity) || 'unknown'}`;
}

function memoryLocation(inst, state) {
  const loc = inst?.loc || {};
  const addr = inst?.addr || {};
  if (loc.kind === 'stack') {
    const name = stackLocationName(loc, addr);
    return { kind: 'stack', key: loc.key, name, text: name };
  }
  if (loc.kind === 'global') {
    const name = state.opts?.symbolFor?.(loc.address);
    return { kind: 'global', key: loc.key, address: loc.address, name: name ? safeIdent(name) : `global_${BigInt(loc.address || 0).toString(16).toUpperCase()}`, text: name ? safeIdent(name) : `global_${BigInt(loc.address || 0).toString(16).toUpperCase()}` };
  }
  if (loc.kind === 'field') {
    const off = BigInt(loc.disp ?? addr.disp ?? 0);
    let known = null;
    try { known = state.opts?.fieldFor?.(addr.baseReg || loc.base?.reg || null, off, inst?.row) || null; } catch { known = null; }
    const base = buildValue(loc.base || addr.base, state, { forAddress: true });
    const name = safeIdent(known?.name || `field_${off.toString(16).toUpperCase()}`);
    const access = expr.field(base, name, off, Number(loc.size || inst?.size || 64), origin(inst));
    return { kind: 'field', key: loc.key, offset: off, base, name, expression: access, text: printExpression(access) };
  }
  if (addr.base && addr.index) {
    const base = buildValue(addr.base, state, { forAddress: true });
    const index = buildValue(addr.index, state, { forAddress: true });
    const scale = 1 << Number(addr.scale || 0);
    if (Number(addr.size || inst?.size || 0) === scale) {
      const access = expr.index(base, index, scale, Number(addr.size || inst?.size || 64), origin(inst));
      return { kind: 'index', key: loc.key, base, index, scale, expression: access, text: printExpression(access) };
    }
  }
  return { kind: 'unknown', key: loc.key || `memory:${inst?.id || '?'}`, name: 'memory_unknown', text: 'memory_unknown' };
}

function nzcvCondition(value, cond) {
  if (value == null) return null;
  const f = Number(value) & 15;
  const n=!!(f&8), z=!!(f&4), c=!!(f&2), v=!!(f&1);
  switch (cond) {
    case 'eq': return z; case 'ne': return !z;
    case 'cs': case 'hs': return c; case 'cc': case 'lo': return !c;
    case 'mi': return n; case 'pl': return !n; case 'vs': return v; case 'vc': return !v;
    case 'hi': return c && !z; case 'ls': return !c || z;
    case 'ge': return n === v; case 'lt': return n !== v;
    case 'gt': return !z && n === v; case 'le': return z || n !== v;
    case 'al': case 'nv': return true; default: return null;
  }
}

function compareFromFlags(flagValue, cond, state) {
  const d = flagValue?.def;
  if (!d || d.op !== 'cmp') return expr.variable('condition_' + (cond || 'flags'), 1, false);
  const a = buildArg(d.args?.[0], state);
  let b = buildArg(d.args?.[1], state);
  // ARM compare immediates inherit the register operand width. The IR wrapper
  // does not need to duplicate that width on the immediate itself, so canonicalize
  // the constant here before structural min/max matching (#356).
  if (b?.kind === 'const' && a?.bits && b.bits !== a.bits) b = expr.constant(BigInt.asUintN(Number(a.bits), b.value), Number(a.bits), false, b.source);
  let normal;
  if (cond === 'al' || cond === 'nv') normal = expr.constant(1, 1, false, origin(d));
  else normal = buildNZCVConditionExpression(d.sub || 'sub', cond, a, b, Number(d.bits || a.bits || b.bits || 64), origin(d))
    || expr.intrinsic(`__arm64_nzcv_${d.sub || 'unknown'}_${cond || 'flags'}`, [a,b], 1, false, origin(d), { nzcvCondition:true });
  if (!d.extra?.conditional) return normal;
  const previousFlags = valueOf(d.args?.[2]);
  const gate = compareFromFlags(previousFlags, d.extra?.cond, state);
  const fallbackTruth = nzcvCondition(d.extra?.fallbackNzcv, cond);
  const fallback = fallbackTruth == null ? expr.variable('fallback_' + (cond || 'flags'), 1, false, origin(d))
    : expr.constant(fallbackTruth ? 1 : 0, 1, false, origin(d));
  return expr.select(gate, normal, fallback, 1, false, origin(d));
}

function applyShift(base, shift) {
  if (!base || !shift?.op) return base;
  const bits = Number(base.bits || 64);
  const amount = expr.constant(BigInt(shift.amount || 0), bits, false, base.source);
  switch (shift.op) {
    case 'lsl': return expr.binary('shl', base, amount, bits, base.signed, base.source);
    case 'lsr': return expr.binary('lshr', base, amount, bits, false, base.source);
    case 'asr': return expr.binary('ashr', base, amount, bits, true, base.source);
    case 'uxtb': { const e=expr.unary('zext', expr.unary('trunc', base, 8, false, base.source), bits, false, base.source, { fromBits:8 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, false, base.source) : e; }
    case 'uxth': { const e=expr.unary('zext', expr.unary('trunc', base, 16, false, base.source), bits, false, base.source, { fromBits:16 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, false, base.source) : e; }
    case 'uxtw': { const e=expr.unary('zext', expr.unary('trunc', base, 32, false, base.source), bits, false, base.source, { fromBits:32 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, false, base.source) : e; }
    case 'sxtb': { const e=expr.unary('sext', expr.unary('trunc', base, 8, true, base.source), bits, true, base.source, { fromBits:8 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, true, base.source) : e; }
    case 'sxth': { const e=expr.unary('sext', expr.unary('trunc', base, 16, true, base.source), bits, true, base.source, { fromBits:16 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, true, base.source) : e; }
    case 'sxtw': { const e=expr.unary('sext', expr.unary('trunc', base, 32, true, base.source), bits, true, base.source, { fromBits:32 }); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, true, base.source) : e; }
    default: return base;
  }
}

function buildArg(arg, state, flags = {}) {
  if (!arg) return expr.unknown('missing-arg');
  let out = buildValue(valueOf(arg), state, flags);
  const operandBits = Number(arg.bits || 0);
  const valueBits = Number(out?.bits || valueOf(arg)?.bits || 0);
  if (operandBits > 0 && out?.kind === 'const') {
    // Constants have no inherent signedness at the machine level. Canonicalize
    // every operand-width constant, even when the SSA constant already happens
    // to have that width, so cmp #0 and wzr are structurally identical.
    out = expr.constant(BigInt.asUintN(operandBits, out.value), operandBits, false, out.source);
  } else if (operandBits > 0 && valueBits > operandBits) {
    out = expr.unary('trunc', out, operandBits, false, sourceOf(out), { fromBits:valueBits });
  }
  return applyShift(out, arg.shift);
}

function selectExpression(d, state) {
  const t = buildArg(d.args?.[0], state), f = buildArg(d.args?.[1], state), flags = valueOf(d.args?.[2]);
  const condition = compareFromFlags(flags, d.cond, state);
  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits), f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'inv') return expr.select(condition, t, expr.unary('not', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'neg') return expr.select(condition, t, expr.unary('neg', f, f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  // CINC/CINV/CNEG aliases carry one source. The operation applies when the
  // alias condition is true; treating them as ordinary CS* false arms reverses semantics.
  if (d.sub === 'cinc') return expr.select(condition, expr.binary('add', t, expr.constant(1, t.bits), t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'cinv') return expr.select(condition, expr.unary('not', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'cneg') return expr.select(condition, expr.unary('neg', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
  if (d.sub === 'set' || d.sub === 'setm') return expr.select(condition, t, f, d.dst?.bits || 1, false, origin(d, d.dst));
  return expr.select(condition, t, f, d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));
}

function targetBlock(ir, cbr, rowOfAddress) {
  const addr = cbr?.extra?.target;
  if (addr == null) return null;
  const row = rowOfAddress?.(addr);
  if (row == null) return null;
  return ir.blocks.find((b) => row >= b.startRow && row <= b.endRow)?.index ?? null;
}

function blockTerm(block) {
  const xs = block?.insts || [];
  for (let i = xs.length - 1; i >= 0; i--) if (['cbr','br','ret'].includes(xs[i].op)) return xs[i];
  return null;
}

function branchSucc(ir, block, term, state) {
  const succ = block?.succ || [];
  if (term?.op !== 'cbr' || succ.length !== 2) return { yes: null, no: null };
  const yes = targetBlock(ir, term, state.opts?.rowOfAddress);
  if (yes == null || !succ.includes(yes)) return { yes: null, no: null };
  const no = succ.find((x) => x !== yes) ?? null;
  return no == null ? { yes: null, no: null } : { yes, no };
}

function branchCondition(inst, state) {
  const kind = inst?.extra?.kind || inst?.sub || '';
  const v = valueOf(inst?.args?.[0]);
  if (kind === 'cbz' || kind === 'cbnz') return expr.compare(kind === 'cbz' ? 'eq' : 'ne', expressionFor(v, state), expr.constant(0, v?.bits || 64), null, origin(inst));
  if (kind === 'tbz' || kind === 'tbnz') {
    const value = expressionFor(v, state);
    const bit = Number(inst.extra?.bit ?? 0);
    if (bit === Number(v?.bits || value.bits || 64) - 1) return expr.compare(kind === 'tbz' ? 'ge' : 'lt', value, expr.constant(0, v?.bits || value.bits || 64, true), true, origin(inst));
    const tested = expr.binary('and', expr.binary('lshr', value, expr.constant(bit, value.bits || 64), value.bits || 64, false), expr.constant(1, value.bits || 64), value.bits || 64, false);
    return expr.compare(kind === 'tbz' ? 'eq' : 'ne', tested, expr.constant(0, value.bits || 64), false, origin(inst));
  }
  return compareFromFlags(valueOf(inst?.args?.at?.(-1)), inst?.cond || inst?.extra?.cond, state);
}

function canReach(ir, start, target, blocked, cap = 256) {
  if (start == null || target == null) return false;
  const q = [start], seen = new Set();
  while (q.length && cap-- > 0) {
    const b = q.shift();
    if (b === target) return true;
    if (b === blocked || seen.has(b)) continue;
    seen.add(b);
    for (const s of ir.blocks?.[b]?.succ || []) if (!seen.has(s)) q.push(s);
  }
  return false;
}

function controllingBranchForMemoryPhi(phi, state) {
  const incoming = phi?.incoming || [];
  if (incoming.length !== 2 || phi?.block == null) return null;
  const candidates = [];
  for (const block of state.ir.blocks || []) {
    const term = blockTerm(block);
    if (term?.op !== 'cbr' || block.succ.length !== 2) continue;
    const { yes, no } = branchSucc(state.ir, block, term, state);
    if (yes == null || no == null) continue;
    const phiDom = state.ir.dominators?.[phi.block];
    if (phiDom && !phiDom.has(block.index)) continue;
    const yr = incoming.map((x) => canReach(state.ir, yes, x.from, phi.block));
    const nr = incoming.map((x) => canReach(state.ir, no, x.from, phi.block));
    const yesIndex = yr.findIndex(Boolean), noIndex = nr.findIndex(Boolean);
    if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) continue;
    if (yr.filter(Boolean).length !== 1 || nr.filter(Boolean).length !== 1) continue;
    if (yr[noIndex] || nr[yesIndex]) continue;
    candidates.push({ term, yesIndex, noIndex, block:block.index });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function memoryNodeExpression(node, loadInst, state, seen = new Set()) {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.kind === 'store' && node.inst) return buildArg(node.inst.args?.[0], state);
  if (node.kind !== 'phi') return null;
  const incoming = (node.incoming || []).filter((x) => x?.node);
  if (!incoming.length) return null;
  const values = incoming.map((x) => memoryNodeExpression(x.node, loadInst, state, new Set(seen)));
  if (values.some((x) => !x)) return null;
  const unique = new Map(values.map((x) => [structuralKey(x), x]));
  if (unique.size === 1) return values[0];
  if (incoming.length !== 2) return null;
  const control = controllingBranchForMemoryPhi(node, state);
  if (!control) return null;
  return expr.select(branchCondition(control.term, state), values[control.yesIndex], values[control.noIndex], loadInst?.dst?.bits || values[0].bits || 64, loadInst?.dst?.signed ?? null, origin(loadInst, loadInst?.dst, 'Memory SSA phi'));
}

function buildValue(v, state, flags = {}) {
  if (!v) return expr.variable('unknown', 64, null);
  const memoKey = `${v.id}:${flags.forAddress ? 'a' : 'v'}`;
  if (state.expressionMemo.has(memoKey)) return state.expressionMemo.get(memoKey);
  if (state.expressionActive.has(v.id)) return expr.variable(argumentName(v, state), v.bits || 64, signedFor(state, v), origin(v.def, v), { ssaId: v.id, range: v.range ? { ...v.range } : null });
  state.expressionActive.add(v.id);
  let out = null;
  const d = v.def;
  if (v.constKind === 'float' || v.floatConst != null || (v.float != null && v.const == null)) out = expr.floatConstant(v.floatConst ?? v.float, v.bits || 64, origin(d, v));
  if (!out && v.const != null && d?.op !== 'addr') out = constNode(v);
  if (!out && (v.kind === 'arg' || !d)) out = expr.variable(argumentName(v, state), v.bits || 64, signedFor(state, v), origin(d, v), { ssaId: v.id, range: v.range ? { ...v.range } : null });
  if (!out && d) {
    if (d.op === 'const') out = (v.constKind === 'float' || v.floatConst != null || v.float != null)
      ? expr.floatConstant(v.floatConst ?? v.float, v.bits || 64, origin(d, v))
      : constNode(v, v.const ?? d.extra?.value ?? 0n);
    else if (d.op === 'mov') out = buildArg(d.args?.[0], state, flags);
    else if (d.op === 'bin') {
      const a = buildArg(d.args?.[0], state), b = d.args?.[1] ? buildArg(d.args[1], state) : expr.constant(0, v.bits || 64);
      if (d.sub === 'bic') out = expr.binary('and', a, expr.unary('not', b, v.bits || b.bits || 64, b.signed), v.bits || 64, signedFor(state, v), origin(d, v));
      else if (d.sub === 'orn') out = expr.binary('or', a, expr.unary('not', b, v.bits || b.bits || 64, b.signed), v.bits || 64, signedFor(state, v), origin(d, v));
      else if (d.sub === 'eon') out = expr.unary('not', expr.binary('xor', a, b, v.bits || 64, signedFor(state, v)), v.bits || 64, signedFor(state, v), origin(d, v));
      else out = expr.binary(d.sub, a, b, v.bits || 64, signedFor(state, v), origin(d, v));
      if (d.extra?.negate) out = expr.unary('neg', out, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'un') {
      const a = buildArg(d.args?.[0], state);
      const sub = String(d.sub || '');
      if (/^sxt/.test(sub)) out = expr.unary('sext', a, v.bits || 64, true, origin(d, v), { fromBits: Number(sub.slice(3)) || a.bits });
      else if (/^uxt/.test(sub)) out = expr.unary('zext', a, v.bits || 64, false, origin(d, v), { fromBits: Number(sub.slice(3)) || a.bits });
      else out = expr.unary(sub, a, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'mac') {
      const addend = buildArg(d.args?.[0], state);
      let a = buildArg(d.args?.[1], state), b = buildArg(d.args?.[2], state);
      if (d.extra?.widen === 'signed' || d.extra?.widen === 'unsigned') {
        const signed = d.extra.widen === 'signed';
        const op = signed ? 'sext' : 'zext';
        a = expr.unary(op, a, v.bits || 64, signed, origin(d, v), { fromBits:32 });
        b = expr.unary(op, b, v.bits || 64, signed, origin(d, v), { fromBits:32 });
      }
      const mult = expr.binary('mul', a, b, v.bits || 64, d.extra?.widen === 'unsigned' ? false : d.extra?.widen === 'signed' ? true : signedFor(state, v), origin(d, v));
      out = expr.binary(d.sub === 'msub' ? 'sub' : 'add', addend, mult, v.bits || 64, signedFor(state, v), origin(d, v));
    } else if (d.op === 'bfx') {
      const src=buildArg(d.args?.[0], state), lsb=Number(d.extra?.lsb ?? 0), width=Math.max(1, Number(d.extra?.width ?? v.bits ?? 64)), bits=Number(v.bits || 64);
      if (d.extra?.toward === 'left') {
        const maskValue=(1n << BigInt(Math.min(width, bits))) - 1n;
        let inserted=expr.binary('shl', expr.binary('and', src, expr.constant(maskValue, bits, false), bits, false), expr.constant(lsb, bits, false), bits, false, origin(d,v));
        if (d.extra?.signed) { const fieldBits=Math.min(bits, lsb + width); inserted=expr.unary('sext', expr.unary('trunc', inserted, fieldBits, true, origin(d,v)), bits, true, origin(d,v), { fromBits:fieldBits }); }
        out=inserted;
      } else out=expr.intrinsic('bit_extract', [src, expr.constant(lsb,64), expr.constant(width,64)], bits, d.extra?.signed ?? d.signed ?? false, origin(d,v));
    } else if (d.op === 'bfi') {
      const old=buildArg(d.args?.[0], state), src=buildArg(d.args?.[1], state), lsb=Number(d.extra?.lsb ?? 0), width=Math.max(1,Number(d.extra?.width ?? 16)), bits=Number(v.bits || 64);
      if (d.extra?.bitfieldKind === 'bfxil') {
        const maskValue=(1n << BigInt(Math.min(width,bits))) - 1n;
        const extracted=expr.binary('and', expr.binary('lshr', src, expr.constant(lsb,bits,false), bits, false), expr.constant(maskValue,bits,false), bits, false);
        const cleared=expr.binary('and', old, expr.constant(BigInt.asUintN(bits, ~maskValue),bits,false), bits, false);
        out=expr.binary('or', cleared, extracted, bits, signedFor(state,v), origin(d,v));
      } else out=expr.intrinsic('bit_insert', [old,src,expr.constant(lsb,64),expr.constant(width,64)], bits, signedFor(state,v), origin(d,v));
    } else if (d.op === 'sel') out = selectExpression(d, state);
    else if (d.op === 'addr') {
      const address = v.const ?? d.extra?.value ?? d.extra?.target;
      const name = address != null ? state.opts?.symbolFor?.(address) : null;
      out = expr.variable(name ? safeIdent(name) : `global_${BigInt(address || 0).toString(16).toUpperCase()}`, 64, false, origin(d, v), { address });
    } else if (d.op === 'load') {
      const loc = memoryLocation(d, state);
      // Memory SSA itself is the alias proof. If a reaching store survives to this
      // load, unrelated intervening stores/calls did not kill this location version.
      if (d.reachingStore && d.reachingStore !== d) out = buildArg(d.reachingStore.args?.[0], state);
      else out = memoryNodeExpression(d.memUse, d, state) || expr.load(loc, v.bits || Number((d.size || 8) * 8), origin(d, v), { signed: d.signed ?? signedFor(state, v), volatile: !!d.volatile });
    } else if (d.op === 'call') {
      out = expr.variable(`call_${d.id}`, v.bits || 64, signedFor(state, v), origin(d, v), { materializedCall: true });
    } else if (d.op === 'phi') {
      const incoming = (d.incoming || []).map((x) => buildValue(x.value, state));
      const unique = new Map(incoming.map((x) => [structuralKey(x), x]));
      out = unique.size === 1 ? incoming[0] : expr.variable(`local_phi_${v.id}`, v.bits || 64, signedFor(state, v), origin(d, v), { phi: true, incoming });
    }
  }
  if (!out) out = expr.variable(argumentName(v, state), v.bits || 64, signedFor(state, v), origin(d, v), { ssaId: v.id, range: v.range ? { ...v.range } : null });
  state.expressionActive.delete(v.id);
  state.expressionMemo.set(memoKey, out);
  return out;
}

function rewriteAll(state, budget) {
  const engine = new RewriteEngine(DEFAULT_RULES, { timeBudgetMs: Math.max(4, Math.min(22, budget.timeBudgetMs / 2)), nodeBudget: Math.min(4096, budget.nodeBudget) });
  state.expressions = new Map();
  state.rewriteProof = [];
  state.rewriteStats = { applications: 0, budgetExceeded: false, byRule: {} };
  for (const v of state.ir.values || []) {
    let root = buildValue(v, state);
    root = walkIdiom(root);
    // `deterministicTransforms` is an opt-in measurement mode: it removes the
    // rewrite engine's wall-clock cutoff so the fixed point depends only on the
    // input and the rules. Work bounds still apply. Production leaves it unset.
    const r = engine.rewrite(root, { state, deterministicTransforms: state.opts?.deterministicTransforms === true });
    state.expressions.set(v.id, r.root);
    state.rewriteProof.push(...r.proof.map((p) => ({ ...p, valueId: v.id })));
    state.rewriteStats.applications += r.stats.applications;
    state.rewriteStats.budgetExceeded ||= r.stats.budgetExceeded;
    for (const [k, n] of Object.entries(r.stats.byRule)) state.rewriteStats.byRule[k] = (state.rewriteStats.byRule[k] || 0) + n;
  }
  // A truncated rewrite is a truncated result. Before this, `rewriteStats.budgetExceeded`
  // could be true while the pipeline still reported `degraded: false`, so a consumer
  // reading the pipeline's own completeness flag was told the output was complete
  // when it was not. Budget truncation is a completeness state, and it has to
  // propagate to the one place consumers look.
  if (state.rewriteStats.budgetExceeded) state.degraded = true;
  return state;
}

function walkIdiom(n) {
  if (!n) return n;
  const mapped = mapChildren(n, walkIdiom);
  return recoverArm64ClangIdiom(mapped);
}

function reachingRegisterValue(ir, atInst, reg) {
  let best = ir.args?.get?.(reg) || null;
  let bestRow = -Infinity;
  for (const v of ir.values || []) {
    if (v.reg !== reg || !v.def || v.clobbered) continue;
    const d = v.def;
    if (d.block === atInst.block && d.row < atInst.row && d.row > bestRow) { best = v; bestRow = d.row; }
  }
  return best;
}

function expressionFor(v, state) { return state.expressions?.get(v?.id) || walkIdiom(buildValue(v, state)); }
function returnRegisterForState(state) {
  const type=String(state.opts?.returnType || state.opts?.functionPrototype?.returnType || state.opts?.prototype?.returnType || state.prototype?.returnType || '').toLowerCase();
  if (!type || type === 'void') return null;
  try {
    return state.opts?.abiAdapter?.returnRegister?.({
      returnType:type,
      functionPrototype:state.opts?.functionPrototype || state.opts?.prototype || state.prototype || null,
    }) ?? null;
  } catch { return null; }
}
function returnValueAt(inst, state) {
  const explicit=valueOf(inst?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForState(state);
  return reg ? reachingRegisterValue(state.ir, inst, reg) : null;
}

function semanticFacts(state, result) {
  const facts = { inputs: [], outputs: [], stores: [], calls: [], conditions: [], evidence: [], warnings: [] };
  const abiArgumentRegisters = new Set(abiArgumentLocationsForState(state).map((location) => location.reg));
  for (const [reg, v] of state.ir.args || []) {
    if (abiArgumentRegisters.has(String(reg)) && (v.uses || []).length) facts.inputs.push({ name: argumentName(v, state), reg, type: typeFor(state, v), valueId: v.id });
  }
  for (const inst of state.ir.instructions || []) {
    if (inst.op === 'store') {
      const location = memoryLocation(inst, state), value = valueOf(inst.args?.[0]), expression = expressionFor(value, state);
      const store = { location, lhsText: location.text, expression, source: origin(inst, inst.dst, 'Memory SSA store') };
      if (expression?.kind === 'intrinsic' && expression.name === 'max' && expression.args?.[1]?.kind === 'const' && expression.args[1].value === 0n && expression.args[0]?.kind === 'binary' && expression.args[0].op === 'sub') {
        store.readModifyWrite = { kind: 'clamp-zero-sub', operand: printExpression(expression.args[0].right) };
      } else if (expression?.kind === 'binary' && expression.op === 'add') store.readModifyWrite = { kind: 'add', operand: printExpression(expression.right) };
      facts.stores.push(store); facts.outputs.push({ name: location.text, type: state.types?.locations?.get?.(inst.loc?.key) || null });
      facts.evidence.push({ row: inst.row, address: inst.address, ir: inst.id, reason: 'Memory SSA store' });
    } else if (inst.op === 'call') {
      const modelCall = (state.model.calls || []).find((c) => c.row === inst.row) || null;
      const name = modelCall?.name || inst.extra?.name || (inst.extra?.target != null ? state.opts?.symbolFor?.(inst.extra.target) : null) || 'unknown_call';
      const runtime = /objc_msgSend/.test(name) ? 'objc' : /^_?swift_/.test(name) ? 'swift' : null;
      facts.calls.push({ name, runtime, row: inst.row, address: inst.address, ir: inst.id });
    } else if (inst.op === 'cbr') {
      const e = branchCondition(inst, state);
      facts.conditions.push({ expression: e, text: printExpression(e), row: inst.row, address: inst.address, ir: inst.id });
    } else if (inst.op === 'ret') {
      const rv = returnValueAt(inst, state);
      if (rv) facts.outputs.push({ name: 'return', type: typeFor(state, rv), expression: expressionFor(rv, state) });
    }
  }
  facts.warnings.push(...(result.warnings || []));
  return facts;
}

function valueDependsOnAny(value, targetValueIds, active = new Set()) {
  if (!value || active.has(value.id)) return false;
  if (targetValueIds.has(value.id)) return true;
  active.add(value.id);
  const def = value.def;
  if (!def) { active.delete(value.id); return false; }
  const inputs = [
    ...(def.args || []).map((arg) => arg?.value).filter(Boolean),
    ...(def.incoming || []).map((item) => item?.value).filter(Boolean),
  ];
  const result = inputs.some((input) => valueDependsOnAny(input, targetValueIds, active));
  active.delete(value.id);
  return result;
}

/*
 * Hide only a stack slot proven to be machine-level return preservation across
 * a call. MemorySSA must identify one exact store and one exact reaching load;
 * that load must feed the function return, and no call argument may depend on
 * the spill address base. This keeps ordinary locals/address-taken slots
 * visible while avoiding an invalid duplicate `var_* = expr; return expr;`.
 */
function isElidableReturnSpillStore(store, state) {
  if (!store || store.op !== 'store' || store.loc?.kind !== 'stack' || !store.loc?.key) return false;
  const instructions = state.ir?.instructions || [];
  const sameLocationMemory = instructions.filter((inst) =>
    (inst.op === 'load' || inst.op === 'store') && inst.loc?.key === store.loc.key);
  const loads = sameLocationMemory.filter((inst) => inst.op === 'load' && inst.reachingStore === store);
  if (loads.length !== 1 || sameLocationMemory.some((inst) => inst.op === 'store' && inst !== store)) return false;
  const load = loads[0];
  if (store.row == null || load.row == null || Number(load.row) <= Number(store.row) || !load.dst) return false;

  const calls = instructions.filter((inst) => inst.op === 'call' && inst.row != null
    && Number(inst.row) > Number(store.row) && Number(inst.row) < Number(load.row));
  if (!calls.length) return false;

  const addressBaseId = store.addr?.base?.id ?? null;
  if (addressBaseId != null) {
    const addressBase = new Set([addressBaseId]);
    if (calls.some((call) => (call.args || []).some((arg) => valueDependsOnAny(arg?.value, addressBase)))) return false;
  }

  const loadIds = new Set([load.dst.id]);
  const storedValue = valueOf(store.args?.[0]);
  if (!storedValue) return false;
  const storedKey = structuralKey(expressionFor(storedValue, state));
  if (!storedKey) return false;

  for (const ret of instructions) {
    if (ret.op !== 'ret' || ret.row == null || Number(ret.row) <= Number(load.row)) continue;
    const returned = returnValueAt(ret, state);
    if (!returned || !valueDependsOnAny(returned, loadIds)) continue;
    if (structuralKey(expressionFor(returned, state)) === storedKey) return true;
  }
  return false;
}

function knownStatementForLine(line, state) {
  if (line?.row == null || line.kind !== 'stmt') return null;
  const insts = (state.ir.instructions || []).filter((i) => i.row === line.row);
  const store = insts.find((i) => i.op === 'store');
  if (store) {
    if (isElidableReturnSpillStore(store, state)) {
      return {
        text:'',
        semantic:{ op:'elided-return-spill', ir:store.id },
        source:sourceOf({ ir:store.id, value:valueOf(store.args?.[0]), reason:'memoryssa-return-spill' }),
      };
    }
    const location = memoryLocation(store, state), value = valueOf(store.args?.[0]), e = expressionFor(value, state);
    let text = `${location.text} = ${printExpression(e)};`;
    if (e?.kind === 'binary' && ['add','sub','mul'].includes(e.op) && e.left?.kind === 'load' && e.left.location?.key === location.key) {
      const rhs = printExpression(e.right);
      if (e.op === 'add' && e.right?.kind === 'const' && e.right.value === 1n) text = `${location.text}++;`;
      else if (e.op === 'sub' && e.right?.kind === 'const' && e.right.value === 1n) text = `${location.text}--;`;
      else text = `${location.text} ${{add:'+=',sub:'-=',mul:'*='}[e.op]} ${rhs};`;
    }
    return { text, semantic: { op: 'store', location, expression: e, ir: store.id }, source: mergeSource(line.source, e?.source, origin(store, store.dst)) };
  }
  const ret = insts.find((i) => i.op === 'ret');
  if (ret && /^return\b/.test(String(line.text || ''))) {
    const rv = returnValueAt(ret, state);
    if (rv) { const e = expressionFor(rv, state); return { text: `return ${printExpression(e)};`, semantic: { op: 'return', expression: e, ir: ret.id }, source: mergeSource(line.source, e?.source, origin(ret, rv)) }; }
  }
  return null;
}

function cAstFromLines(result, state) {
  const body = [];
  for (const line of result.lines || []) {
    const known = knownStatementForLine(line, state);
    const carried = line.source || { address: line.addr, row: line.row };
    const source = known?.source || sourceOf({
      ...carried,
      evidence: [...(carried.evidence || []), ...(line.note ? [{ reason: line.note }] : [])],
    });
    body.push({ kind: line.kind || 'raw', indent: line.indent || 0, text: known?.text ?? line.text ?? '', source, semantic: known?.semantic || null });
  }
  return { kind: 'CProgram', body, source: mergeSource(...body.map((x) => x.source)) };
}

function semanticAstOf(state, facts) {
  return {
    kind: 'SemanticFunction',
    values: [...state.expressions.entries()].map(([valueId, expression]) => ({ kind: 'SemanticValue', valueId, expression, type: state.types?.values?.get?.(valueId) || null, source: expression.source })),
    stores: facts.stores.map((s) => ({ kind: 'SemanticStore', ...s })),
    calls: facts.calls.map((c) => ({ kind: 'SemanticCall', ...c })),
    conditions: facts.conditions.map((c) => ({ kind: 'SemanticCondition', ...c })),
    inputs: facts.inputs,
    outputs: facts.outputs,
  };
}

function metricsOf(result, state, printed) {
  const text = printed.text;
  const exprMetrics = [...state.expressions.values()].map(expressionReadability);
  return {
    rawAssemblyFallbacks: (text.match(/__asm\(/g) || []).length,
    gotos: (text.match(/\bgoto\b/g) || []).length,
    temporaries: (text.match(/\b(?:v|tmp|call_)\d+\b/g) || []).length,
    redundantCasts: exprMetrics.reduce((a, x) => a + x.casts, 0),
    rewrittenExpressions: state.rewriteStats?.applications || 0,
    rewriteBudgetExceeded: !!state.rewriteStats?.budgetExceeded,
    structured: result.coverage?.mode === 'structured',
    sourceMappedNodes: printed.mapping.length,
    passElapsedMs: state.passElapsedMs || 0,
  };
}

/**
 * The weakest completeness any stage of the pipeline reached.
 *
 * `complete` here means every stage ran to its own fixed point. `partial` means
 * at least one stage stopped early — the output is still valid, but it is not
 * the canonical output for this input and must not be compared as if it were.
 */
function pipelineCompleteness(state) {
  if (state.degraded) return 'partial';
  if (state.rewriteStats?.budgetExceeded) return 'partial';
  if (state.passDeadlineExceeded) return 'partial';
  const ledger = state.phase8;
  if (ledger && (!ledger.published || ledger.completeness !== 'complete')) return 'partial';
  return 'complete';
}

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  if (!result?.semantic || !result.ir) return result;
  const state = {
    ir: result.ir, model, opts, types: result.types || null,
    expressionMemo: new Map(), expressionActive: new Set(),
    warnings: [],
  };
  // Phase 8 runs as its own stage with its own declared budget, before the
  // representation passes. It observes canonical semantic facts and publishes a
  // frozen ledger or publishes nothing; it never mutates `state` beyond
  // attaching that ledger. Keeping it out of the PassManager deadline is not a
  // detail: sharing the rewrite allowance measurably changed the rewrite fixed
  // point on budget-saturated functions, which would make a no-op stage a
  // quality regression (P8-1 substrate contract).
  // Optimizer stages are opt-in. The interactive path publishes canonical facts
  // only; a caller that wants constants, ranges and the rest asks for them and
  // gets a budget sized for the work rather than an interactive allowance that
  // would make publication depend on how fast the machine is that day.
  const phase8Optimize = opts.phase8Optimize === true;
  const phase8 = runPhase8Stage(
    { ir: state.ir, types: state.types, opts },
    {
      stages: phase8Optimize ? PHASE8_ALL_STAGES : PHASE8_INTERACTIVE_STAGES,
      timeBudgetMs: Number(opts.phase8TimeBudgetMs ?? (phase8Optimize ? 250 : 15)),
      shouldAbort: opts.shouldAbort,
    },
  );
  state.phase8 = phase8.ledger;
  state.phase8Timings = phase8.timings;
  state.phase8ElapsedMs = phase8.elapsedMs;

  const manager = new PassManager([
    { name: 'high-variable-recovery', run(s) { s.highVariables = recoverHighVariables(s.ir, s.types, opts); return s; } },
    { name: 'prototype-recovery', run(s) { s.prototype = recoverFunctionPrototype(s.ir, s.types, opts); return s; } },
    { name: 'aggregate-layout-recovery', run(s) { s.aggregateLayouts = recoverAggregateLayouts(s.ir, s.types, opts); return s; } },
    { name: 'canonical-expression-build', run(s) { for (const v of s.ir.values || []) buildValue(v, s); return s; } },
    { name: 'semantic-rewrite', run: rewriteAll },
    { name: 'semantic-facts', run(s) { s.facts = semanticFacts(s, result); return s; } },
    { name: 'typed-semantic-ast', run(s) { s.semanticAst = semanticAstOf(s, s.facts); return s; } },
    { name: 'c-ast', run(s) { s.cAst = cAstFromLines(result, s); return s; } },
    { name: 'pretty-print', run(s) { s.printed = printProgram(s.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 }); return s; } },
  ], { timeBudgetMs: Number(opts.decompilerTimeBudgetMs || 50), nodeBudget: Number(opts.decompilerNodeBudget || 12000), maxIterations: Number(opts.decompilerIterationCap || 16) });
  const advanced = manager.run(state);
  // Budgets are a degradation boundary, not a validity boundary. If a large function
  // exhausts the optional pass budget, finish the mandatory representation layers
  // once without additional fixed-point work so callers always receive a coherent AST.
  advanced.expressions ||= new Map([...advanced.expressionMemo.entries()]
    .filter(([key]) => String(key).endsWith(':v'))
    .map(([key, value]) => [Number(String(key).split(':')[0]), value]));
  advanced.rewriteProof ||= [];
  advanced.rewriteStats ||= { iterations: 0, applications: 0, budgetExceeded: true, elapsedMs: 0, byRule: {} };
  advanced.highVariables ||= recoverHighVariables(advanced.ir, advanced.types, opts);
  advanced.prototype ||= recoverFunctionPrototype(advanced.ir, advanced.types, opts);
  advanced.aggregateLayouts ||= recoverAggregateLayouts(advanced.ir, advanced.types, opts);
  advanced.facts ||= semanticFacts(advanced, result);
  advanced.semanticAst ||= semanticAstOf(advanced, advanced.facts);
  advanced.cAst ||= cAstFromLines(result, advanced);
  advanced.printed ||= printProgram(advanced.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 });
  const explanation = explainSemanticFacts(advanced.facts, result.summary);
  const lines = advanced.cAst.body.map((n) => ({ kind: n.kind, indent: n.indent, text: n.text, row: n.source.rows[0] ?? null, addr: n.source.addresses[0] ?? null, note: null, source: n.source }));
  return {
    ...result,
    lines,
    pseudocode: advanced.printed.text,
    semanticAst: advanced.semanticAst,
    cAst: advanced.cAst,
    semanticFacts: advanced.facts,
    sourceMap: advanced.printed.mapping,
    highVariables: advanced.highVariables,
    prototype: advanced.prototype,
    aggregateLayouts: advanced.aggregateLayouts,
    rewriteProof: advanced.rewriteProof,
    rewriteStats: advanced.rewriteStats,
    passMetrics: advanced.passMetrics,
    // Phase 8's frozen ledger. It is published or withheld as a whole; a missing
    // ledger is an explicit unknown, never an implied "nothing to optimize".
    phase8: advanced.phase8 ?? null,
    summary: explanation.summary,
    importantInputs: explanation.importantInputs,
    importantOutputs: explanation.importantOutputs,
    sideEffects: explanation.sideEffects,
    conditions: explanation.conditions,
    evidence: [...(result.evidence || []), ...(advanced.facts?.evidence || [])],
    warnings: [...new Set([...(result.warnings || []), ...(advanced.warnings || []), ...(advanced.rewriteStats?.budgetExceeded ? ['Decompiler rewrite budget reached; output was conservatively degraded.'] : [])])],
    metrics: metricsOf(result, advanced, advanced.printed),
    ctx: { ...(result.ctx || {}), decompilerPipeline: {
      phases: advanced.passMetrics,
      degraded: !!advanced.degraded,
      // One completeness answer, weakest-wins across every source that can
      // truncate: the pass deadline, the rewrite budget, and Phase 8's own
      // ledger. Separate flags that disagree are how a consumer ends up
      // trusting an incomplete result.
      completeness: pipelineCompleteness(advanced),
      rewriteStats: advanced.rewriteStats,
      phase8: advanced.phase8 ?? null,
      phase8Timings: advanced.phase8Timings ?? null,
      phase8ElapsedMs: advanced.phase8ElapsedMs ?? null,
    } },
  };
}

export function buildExpressionForTesting(value, state) {
  const s = { expressionMemo: new Map(), expressionActive: new Set(), opts: {}, types: { values: new Map() }, highVariables: null, ...state };
  return buildValue(value, s);
}
