from pathlib import Path
import json


def rep(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing patch anchor {label} in {path}")
    p.write_text(s.replace(old, new, 1))


# #406 compound assignment only when the final stored value is the direct binary update.
rep('js/decompiler/semantic.js', """function rmwOperand(rmw, ctx) {
  const loadValue = rmw.load?.dst;
  for (const inst of rmw.chain || []) {
    if (inst.op !== OP.BIN || !['add', 'sub', 'mul', 'sdiv', 'udiv'].includes(inst.sub)) continue;
    const a = valueOf(inst.args?.[0]), b = valueOf(inst.args?.[1]);
    if (sameValue(a, loadValue)) return { op: inst.sub, other: b, reversed: false };
    if (sameValue(b, loadValue)) return { op: inst.sub, other: a, reversed: true };
  }
  return null;
}""", """function rmwOperand(rmw, ctx) {
  void ctx;
  const loadValue = rmw.load?.dst;
  const written = valueOf(rmw.store?.args?.[0]);
  const inst = written?.def;
  if (!loadValue || !inst || inst.op !== OP.BIN || !['add', 'sub', 'mul', 'sdiv', 'udiv'].includes(inst.sub)) return null;
  const a = valueOf(inst.args?.[0]), b = valueOf(inst.args?.[1]);
  if (sameValue(a, loadValue)) return { op: inst.sub, other: b, reversed: false };
  if (sameValue(b, loadValue)) return { op: inst.sub, other: a, reversed: true };
  return null;
}""", '#406')

# #409 ABI argument uses at unknown-arity calls.
rep('js/ir-core.js', """    const result = callResultLocation(insn, opts);
    push({
      op: OP.CALL,
      target: insn.callTarget != null ? insn.callTarget : null,
      indirect: insn.callTarget == null,
      srcs: (insn.callTarget == null && ops[0] && ops[0].k === 'reg')
        ? [{ t: 'reg', reg: regKeyOf(ops[0]), bits: 64 }] : [],
      dstReg: result?.reg || null, dstBits: result?.bits || 64,""", """    const result = callResultLocation(insn, opts);
    const callSrcs = Array.from({ length: 8 }, (_, i) => ({ t: 'reg', reg: `x${i}`, bits: 64, abiArgument: true }));
    if (insn.callTarget == null && ops[0] && ops[0].k === 'reg') {
      const targetReg = regKeyOf(ops[0]);
      if (targetReg && !callSrcs.some((x) => x.reg === targetReg)) callSrcs.unshift({ t: 'reg', reg: targetReg, bits: 64, callTarget: true });
    }
    push({
      op: OP.CALL,
      target: insn.callTarget != null ? insn.callTarget : null,
      indirect: insn.callTarget == null,
      srcs: callSrcs,
      dstReg: result?.reg || null, dstBits: result?.bits || 64,""", '#409')

# #410 AAPCS64 SIMD/FP caller-saved clobbers.
rep('js/ir-core.js', """const CALL_CLOBBERS = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8',
  'x9', 'x10', 'x11', 'x12', 'x13', 'x14', 'x15', 'x16', 'x17', 'x30', 'nzcv'];""", """const CALL_CLOBBERS = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8',
  'x9', 'x10', 'x11', 'x12', 'x13', 'x14', 'x15', 'x16', 'x17', 'x30', 'nzcv',
  ...Array.from({ length: 8 }, (_, i) => `v${i}`),
  ...Array.from({ length: 16 }, (_, i) => `v${i + 16}`)];""", '#410')

# #408 typed floating immediate IR constants.
rep('js/ir-core.js', """  if (base === 'mov' || base === 'movz' || base === 'movn' || base === 'fmov') {
    const src = opnd(ops[1]);
    if (!src) { push({ op: OP.UNKNOWN, dstReg: dstReg(), dstBits: dstBits(), srcs: [] }); return out; }
    if (base === 'movn' && src.t === 'imm' && src.value != null) {""", """  if (base === 'mov' || base === 'movz' || base === 'movn' || base === 'fmov') {
    const src = opnd(ops[1]);
    if (!src) { push({ op: OP.UNKNOWN, dstReg: dstReg(), dstBits: dstBits(), srcs: [] }); return out; }
    if (base === 'fmov' && src.t === 'imm' && src.float != null) {
      push({ op: OP.CONST, dstReg: dstReg(), dstBits: dstBits(), value: null,
        floatValue: Number(src.float), constKind: 'float', srcs: [] });
      return out;
    }
    if (base === 'movn' && src.t === 'imm' && src.value != null) {""", '#408 lift')
rep('js/ir-core.js', """      case OP.CONST: setConst(inst.dst, inst.extra ? inst.extra.value : null); break;""", """      case OP.CONST:
        if (inst.extra?.constKind === 'float' && Number.isFinite(Number(inst.extra?.floatValue))) {
          inst.dst.floatConst = Number(inst.extra.floatValue);
          inst.dst.constKind = 'float';
          for (const u of inst.dst.uses || []) queue.push(u);
        } else setConst(inst.dst, inst.extra ? inst.extra.value : null);
        break;""", '#408 const propagation')
rep('js/ir-core.js', """      case OP.MOV: setConst(inst.dst, argConst(inst.args[0], bits)); break;""", """      case OP.MOV: {
        const sourceValue = inst.args?.[0]?.value;
        if (sourceValue?.floatConst != null) {
          inst.dst.floatConst = sourceValue.floatConst;
          inst.dst.constKind = 'float';
          for (const u of inst.dst.uses || []) queue.push(u);
        } else setConst(inst.dst, argConst(inst.args[0], bits));
        break;
      }""", '#408 mov propagation')

# #414 MOVN placement before complement.
rep('js/ir-core.js', """    if (base === 'movn' && src.t === 'imm' && src.value != null) {
      push({ op: OP.CONST, dstReg: dstReg(), dstBits: dstBits(),
        value: mask(~src.value, dstBits()), srcs: [] });
      return out;
    }""", """    if (base === 'movn' && src.t === 'imm' && src.value != null) {
      let v = src.value;
      if (src.shift?.op === 'lsl') v <<= BigInt(src.shift.amount || 0);
      push({ op: OP.CONST, dstReg: dstReg(), dstBits: dstBits(),
        value: mask(~v, dstBits()), srcs: [] });
      return out;
    }""", '#414')

# #416 MOVK shift represented once.
rep('js/ir-core.js', """  if (base === 'movk') {
    const src = opnd(ops[1]);
    push({ op: OP.BFI, dstReg: dstReg(), dstBits: dstBits(),
      lsb: src && src.shift && src.shift.op === 'lsl' ? (src.shift.amount || 0) : 0, width: 16,
      srcs: [{ t: 'reg', reg: dstReg(), bits: dstBits() }, src || { t: 'imm', value: 0n }] });
    return out;
  }""", """  if (base === 'movk') {
    const src = opnd(ops[1]);
    const lsb = src?.shift?.op === 'lsl' ? (src.shift.amount || 0) : 0;
    const insertSrc = src ? { ...src, shift: null } : { t: 'imm', value: 0n };
    push({ op: OP.BFI, dstReg: dstReg(), dstBits: dstBits(), kind: 'movk',
      lsb, width: 16, srcs: [{ t: 'reg', reg: dstReg(), bits: dstBits() }, insertSrc] });
    return out;
  }""", '#416')

# #418 keep original BFI/BFXIL semantic identity.
rep('js/ir-core.js', """      push({ op: OP.BFI, dstReg: dstReg(), dstBits: dstBits(), lsb, width,
        srcs: [{ t: 'reg', reg: dstReg(), bits: dstBits() }, opnd(ops[1])].filter(Boolean) });""", """      push({ op: OP.BFI, dstReg: dstReg(), dstBits: dstBits(), kind: base, lsb, width,
        srcs: [{ t: 'reg', reg: dstReg(), bits: dstBits() }, opnd(ops[1])].filter(Boolean) });""", '#418 lift')

# #413 extend then post-extend LSL.
rep('js/ir-core.js', """function applyShift(v, shift, bits) {
  if (v == null || !shift) return v;
  const n = BigInt(shift.amount || 0);
  switch (shift.op) {""", """function applyShift(v, shift, bits) {
  if (v == null || !shift) return v;
  const n = BigInt(shift.amount || 0);
  const extShift = (x) => mask(n ? (x << n) : x, bits);
  switch (shift.op) {""", '#413 helper')
for old, new, label in [
    ("    case 'uxtb': return mask(v & 0xffn, bits);", "    case 'uxtb': return extShift(v & 0xffn);", 'uxtb'),
    ("    case 'uxth': return mask(v & 0xffffn, bits);", "    case 'uxth': return extShift(v & 0xffffn);", 'uxth'),
    ("    case 'uxtw': return mask(v & 0xffffffffn, bits);", "    case 'uxtw': return extShift(v & 0xffffffffn);", 'uxtw'),
    ("    case 'sxtb': return mask(BigInt.asIntN(8, v), bits);", "    case 'sxtb': return extShift(BigInt.asIntN(8, v));", 'sxtb'),
    ("    case 'sxth': return mask(BigInt.asIntN(16, v), bits);", "    case 'sxth': return extShift(BigInt.asIntN(16, v));", 'sxth'),
    ("    case 'sxtw': return mask(BigInt.asIntN(32, v), bits);", "    case 'sxtw': return extShift(BigInt.asIntN(32, v));", 'sxtw'),
]: rep('js/ir-core.js', old, new, '#413 '+label)

# #412 unsigned load width semantics.
rep('js/ir-core.js', """          if (!inst.extra || !inst.extra.signed) setConst(inst.dst, store.args[0].value.const);
          else setConst(inst.dst, mask(signedOf(mask(store.args[0].value.const, (inst.extra.size || 8) * 8), (inst.extra.size || 8) * 8), bits));""", """          const loadBits = Math.max(1, Number(inst.extra?.size || 8) * 8);
          if (!inst.extra || !inst.extra.signed) setConst(inst.dst, mask(store.args[0].value.const, loadBits));
          else setConst(inst.dst, mask(signedOf(mask(store.args[0].value.const, loadBits), loadBits), bits));""", '#412')

# #407 exact Memory-SSA version requirement.
rep('js/ir-core.js', """    if (!load) continue;
    out.push({ load, store, chain, location: store.loc, kind: 'rmw' });""", """    if (!load) continue;
    if (!store.memDef || !load.memUse || load.memUse !== store.memDef.prev) continue;
    out.push({ load, store, chain, location: store.loc, kind: 'rmw' });""", '#407')

# #408 AST + pretty printer.
rep('js/decompiler/ast/nodes.js', """  constant(value, bits = 64, signed = null, source = null) { return node('const', { value: BigInt(value), bits: Number(bits || 64), signed, effect: 'pure' }, source); },""", """  constant(value, bits = 64, signed = null, source = null) { return node('const', { value: BigInt(value), bits: Number(bits || 64), signed, effect: 'pure' }, source); },
  floatConstant(value, bits = 64, source = null) { return node('float-const', { value: Number(value), bits: Number(bits || 64), signed: null, effect: 'pure' }, source); },""", '#408 AST')
rep('js/decompiler/ast/nodes.js', """      case 'const': value = `c:${semanticTag(n)}:${n.value}`; break;""", """      case 'const': value = `c:${semanticTag(n)}:${n.value}`; break;
      case 'float-const': value = `fc:${semanticTag(n)}:${Object.is(n.value, -0) ? '-0' : String(n.value)}`; break;""", '#408 key')
rep('js/decompiler/pretty/c.js', """    case 'const': return integerText(n.value, n.bits, n.signed);""", """    case 'const': return integerText(n.value, n.bits, n.signed);
    case 'float-const': {
      if (Number.isNaN(n.value)) return 'NAN';
      if (n.value === Infinity) return 'INFINITY';
      if (n.value === -Infinity) return '-INFINITY';
      if (Object.is(n.value, -0)) return '-0.0';
      const text = String(n.value);
      return /[.eE]/.test(text) ? text : text + '.0';
    }""", '#408 pretty')
rep('js/decompiler/pipeline-core.js', """function constNode(v, value = v?.const ?? 0n) { return expr.constant(value, v?.bits || 64, v?.signed ?? null, origin(v?.def, v)); }""", """function constNode(v, value = v?.const ?? 0n) {
  if (v?.constKind === 'float' || v?.floatConst != null) return expr.floatConstant(v.floatConst, v?.bits || 64, origin(v?.def, v));
  return expr.constant(value, v?.bits || 64, v?.signed ?? null, origin(v?.def, v));
}""", '#408 constNode')
rep('js/decompiler/pipeline-core.js', """    if (d.op === 'const') out = constNode(v, v.const ?? d.extra?.value ?? 0n);""", """    if (d.op === 'const') {
      if (d.extra?.constKind === 'float' && v.floatConst == null) { v.floatConst = Number(d.extra.floatValue); v.constKind = 'float'; }
      out = constNode(v, v.const ?? d.extra?.value ?? 0n);
    }""", '#408 buildValue')

# #413 decompiler extend + shift.
rep('js/decompiler/pipeline-core.js', """function applyShift(base, shift) {
  if (!base || !shift?.op) return base;
  const bits = Number(base.bits || 64);
  const amount = expr.constant(BigInt(shift.amount || 0), bits, false, base.source);
  switch (shift.op) {""", """function applyShift(base, shift) {
  if (!base || !shift?.op) return base;
  const bits = Number(base.bits || 64);
  const amount = expr.constant(BigInt(shift.amount || 0), bits, false, base.source);
  const shiftedExtend = (x) => Number(shift.amount || 0) ? expr.binary('shl', x, amount, bits, x.signed, base.source) : x;
  switch (shift.op) {""", '#413 pipeline helper')
for old, new, label in [
    ("    case 'uxtb': return expr.unary('zext', expr.unary('trunc', base, 8, false, base.source), bits, false, base.source, { fromBits: 8 });", "    case 'uxtb': return shiftedExtend(expr.unary('zext', expr.unary('trunc', base, 8, false, base.source), bits, false, base.source, { fromBits: 8 }));", 'uxtb'),
    ("    case 'uxth': return expr.unary('zext', expr.unary('trunc', base, 16, false, base.source), bits, false, base.source, { fromBits: 16 });", "    case 'uxth': return shiftedExtend(expr.unary('zext', expr.unary('trunc', base, 16, false, base.source), bits, false, base.source, { fromBits: 16 }));", 'uxth'),
    ("    case 'uxtw': return expr.unary('zext', expr.unary('trunc', base, 32, false, base.source), bits, false, base.source, { fromBits: 32 });", "    case 'uxtw': return shiftedExtend(expr.unary('zext', expr.unary('trunc', base, 32, false, base.source), bits, false, base.source, { fromBits: 32 }));", 'uxtw'),
    ("    case 'sxtb': return expr.unary('sext', expr.unary('trunc', base, 8, true, base.source), bits, true, base.source, { fromBits: 8 });", "    case 'sxtb': return shiftedExtend(expr.unary('sext', expr.unary('trunc', base, 8, true, base.source), bits, true, base.source, { fromBits: 8 }));", 'sxtb'),
    ("    case 'sxth': return expr.unary('sext', expr.unary('trunc', base, 16, true, base.source), bits, true, base.source, { fromBits: 16 });", "    case 'sxth': return shiftedExtend(expr.unary('sext', expr.unary('trunc', base, 16, true, base.source), bits, true, base.source, { fromBits: 16 }));", 'sxth'),
    ("    case 'sxtw': return expr.unary('sext', expr.unary('trunc', base, 32, true, base.source), bits, true, base.source, { fromBits: 32 });", "    case 'sxtw': return shiftedExtend(expr.unary('sext', expr.unary('trunc', base, 32, true, base.source), bits, true, base.source, { fromBits: 32 }));", 'sxtw'),
]: rep('js/decompiler/pipeline-core.js', old, new, '#413 pipeline '+label)

# #417/#418 distinct bitfield semantics.
rep('js/decompiler/pipeline-core.js', """    } else if (d.op === 'bfx') {
      out = expr.intrinsic('bit_extract', [buildArg(d.args?.[0], state), expr.constant(d.extra?.lsb ?? 0, 64), expr.constant(d.extra?.width ?? v.bits ?? 64, 64)], v.bits || 64, d.extra?.signed ?? d.signed ?? false, origin(d, v));
    } else if (d.op === 'bfi') {
      out = expr.intrinsic('bit_insert', [buildArg(d.args?.[0], state), buildArg(d.args?.[1], state), expr.constant(d.extra?.lsb ?? 0, 64), expr.constant(d.extra?.width ?? 16, 64)], v.bits || 64, signedFor(state, v), origin(d, v));""", """    } else if (d.op === 'bfx') {
      const source = buildArg(d.args?.[0], state), lsb = Number(d.extra?.lsb ?? 0), width = Number(d.extra?.width ?? v.bits ?? 64);
      if (d.extra?.toward === 'left') {
        const low = expr.unary('trunc', source, width, !!d.extra?.signed, origin(d, v), { fromBits: source.bits || v.bits || 64 });
        const extended = expr.unary(d.extra?.signed ? 'sext' : 'zext', low, v.bits || 64, !!d.extra?.signed, origin(d, v), { fromBits: width });
        out = lsb ? expr.binary('shl', extended, expr.constant(lsb, v.bits || 64), v.bits || 64, !!d.extra?.signed, origin(d, v)) : extended;
      } else out = expr.intrinsic('bit_extract', [source, expr.constant(lsb, 64), expr.constant(width, 64)], v.bits || 64, d.extra?.signed ?? d.signed ?? false, origin(d, v));
    } else if (d.op === 'bfi') {
      const oldDst = buildArg(d.args?.[0], state), source = buildArg(d.args?.[1], state);
      const lsb = Number(d.extra?.lsb ?? 0), width = Number(d.extra?.width ?? 16);
      if (d.extra?.kind === 'bfxil') {
        const extracted = expr.intrinsic('bit_extract', [source, expr.constant(lsb, 64), expr.constant(width, 64)], v.bits || 64, false, origin(d, v));
        out = expr.intrinsic('bit_insert', [oldDst, extracted, expr.constant(0, 64), expr.constant(width, 64)], v.bits || 64, signedFor(state, v), origin(d, v));
      } else out = expr.intrinsic('bit_insert', [oldDst, source, expr.constant(lsb, 64), expr.constant(width, 64)], v.bits || 64, signedFor(state, v), origin(d, v));""", '#417/#418')

# #419 FP unordered-aware conditions.
rep('js/decompiler/pipeline-core.js', """  if (d.sub !== 'add' && info) normal = expr.compare(info[0], a, b, info[1], origin(d));""", """  if (d.sub === 'fsub' && ['hs','cs','hi','lt','le'].includes(cond)) normal = expr.intrinsic('fcmp_' + cond, [a, b], 1, false, origin(d), { fpCondition:true, unorderedAware:true });
  else if (d.sub !== 'add' && info) normal = expr.compare(info[0], a, b, info[1], origin(d));""", '#419')

# #411 decompiler return value follows recovered ABI return location.
rep('js/decompiler/pipeline-core.js', """function expressionFor(v, state) { return state.expressions?.get(v?.id) || walkIdiom(buildValue(v, state)); }

function semanticFacts(state, result) {""", """function expressionFor(v, state) { return state.expressions?.get(v?.id) || walkIdiom(buildValue(v, state)); }

function returnValueFor(inst, state) {
  const direct = valueOf(inst?.args?.[0]);
  if (direct) return direct;
  const proto = state.prototype;
  const locs = proto?.returnLocationKnown ? (proto.returnLocations || []) : [];
  if (locs.length !== 1 || locs[0]?.kind !== 'register' || !locs[0]?.reg) return null;
  return reachingRegisterValue(state.ir, inst, locs[0].reg);
}

function semanticFacts(state, result) {""", '#411 helper')
rep('js/decompiler/pipeline-core.js', """      const rv = valueOf(inst.args?.[0]) || reachingRegisterValue(state.ir, inst, 'x0');""", """      const rv = returnValueFor(inst, state);""", '#411 facts')
rep('js/decompiler/pipeline-core.js', """    const rv = valueOf(ret.args?.[0]) || reachingRegisterValue(state.ir, ret, 'x0');""", """    const rv = returnValueFor(ret, state);""", '#411 line')

# #422/#423 fail closed on confidence/completion.
rep('js/semantic-evidence.js', """function boundedStrength(v) {
  if (v == null || !Number.isFinite(Number(v))) return 1;
  return Math.max(0, Math.min(1, Number(v)));
}""", """function boundedStrength(v) {
  if (v == null || !Number.isFinite(Number(v))) return 0;
  return Math.max(0, Math.min(1, Number(v)));
}

function semanticProofVerified(f, e) {
  return f?.verified === true || f?.proofGrade === 'verified' || e?.verified === true || e?.proofGrade === 'verified';
}

function runtimeComplete(r) {
  if (!r || r.ok === false || r.success === false) return false;
  if (['failed','error','timeout','cancelled','aborted'].includes(String(r.status || '').toLowerCase())) return false;
  if (r.truncated === true || r.complete === false || r.timedOut === true || r.timeout === true || r.budgetExceeded === true || r.exception) return false;
  return r.ok === true || r.success === true || r.complete === true || String(r.status || '').toLowerCase() === 'success';
}""", '#422 helper')
rep('js/semantic-evidence.js', """        family: FAMILY.VERIFIED,
        kind: 'verified',""", """        family: semanticProofVerified(f, e) ? FAMILY.VERIFIED : FAMILY.USAGE,
        kind: semanticProofVerified(f, e) ? 'verified' : 'semantic',""", '#422 family')
rep('js/semantic-evidence.js', """export function runtimeEvidenceItems(runtimeResult, opts) {
  if (!runtimeResult) return [];""", """export function runtimeEvidenceItems(runtimeResult, opts) {
  if (!runtimeComplete(runtimeResult)) return [];""", '#423')

# Focused behavioral regressions.
Path('tests/issues-406-423-unlinked.mjs').write_text(r'''import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP, readModifyWrite } from '../js/ir.js';
import { semanticEvidenceItems, runtimeEvidenceItems } from '../js/semantic-evidence.js';
import { FAMILY } from '../js/evidence.js';

const BASE=0x100000000n;
function asm(lines){return lines.map((line,i)=>{const s=String(line).trim(),sp=s.indexOf(' ');return{row:i,address:BASE+BigInt(i)*4n,mn:sp<0?s:s.slice(0,sp),ops:sp<0?'':s.slice(sp+1).trim()};});}
function build(lines,opts={}){const rowOfAddress=(addr)=>{const rel=addr-BASE;return rel<0n||rel>=BigInt(lines.length)*4n?null:Number(rel/4n)};const model=buildSemanticModel(asm(lines),{startRow:0,endRow:lines.length-1,rowOfAddress});return{model,ir:buildIR(model,{rowOfAddress,...opts})};}

let x=build(['ldr w8, [x0,#0x20]','mov w9,#100','str w9, [x0,#0x20]','add w8,w8,#1','str w8, [x0,#0x20]','ret']);
assert.equal(readModifyWrite(x.ir).some(r=>r.store.row===4),false);
x=build(['ldr w8, [x0,#0x20]','add w8,w8,#1','str w8, [x0,#0x20]','ret']);
assert.equal(readModifyWrite(x.ir).some(r=>r.store.row===2),true);

x=build(['mov x0,#1','mov x1,#2','bl 0x100000020','ret']);
const call=x.ir.instructions.find(i=>i.op===OP.CALL); assert.ok(call);
for(let i=0;i<8;i++) assert.ok(call.args.some(a=>a.value?.reg===`x${i}`),`missing x${i} call use`);
for(const r of ['v0','v7','v16','v31']) assert.ok(call.extra.clobbers.includes(r),`missing ${r}`);
for(const r of ['v8','v15']) assert.ok(!call.extra.clobbers.includes(r),`callee-saved ${r}`);

x=build(['mov w8,#0x1234','strb w8,[x0]','ldrb w9,[x0]','ret']);
assert.equal(x.ir.instructions.find(i=>i.op===OP.LOAD).dst.const,0x34n);

x=build(['mov x0,#0x1000','mov w1,#0xffffffff','add x2,x0,w1,sxtw #2','ret']);
assert.equal(x.ir.instructions.find(i=>i.op===OP.BIN&&i.dst?.reg==='x2').dst.const,0xffcn);
x=build(['movn x0,#1,lsl #16','ret']);
assert.equal(x.ir.instructions.find(i=>i.op===OP.CONST).dst.const,BigInt.asUintN(64,~(1n<<16n)));

x=build(['movz x0,#0','movk x0,#0x1234,lsl #16','ret']);
const bfi=x.ir.instructions.find(i=>i.op===OP.BFI); assert.equal(bfi.extra.lsb,16); assert.equal(bfi.args[1].shift,null);
x=build(['bfxil x0,x1,#8,#8','ret']); assert.equal(x.ir.instructions.find(i=>i.op===OP.BFI).extra.kind,'bfxil');

x=build(['fmov d0,#1.5','ret']); const fc=x.ir.instructions.find(i=>i.op===OP.CONST); assert.equal(fc.dst.constKind,'float'); assert.equal(fc.dst.floatConst,1.5);

let items=semanticEvidenceItems([{kind:'read',evidence:[{id:'x',row:1}]}]); assert.equal(items[0].strength,0); assert.notEqual(items[0].family,FAMILY.VERIFIED);
items=semanticEvidenceItems([{kind:'read',confidence:0.8,verified:true,evidence:[{id:'y',row:1}]}]); assert.equal(items[0].family,FAMILY.VERIFIED);
assert.deepEqual(runtimeEvidenceItems({status:'timeout',touchedFields:[{offset:1}]}),[]);
assert.deepEqual(runtimeEvidenceItems({success:true,truncated:true,touchedFields:[{offset:1}]}),[]);
assert.equal(runtimeEvidenceItems({success:true,complete:true,touchedFields:[{offset:1}]}).length,1);
console.log('issues #406-#423 focused regressions passed');
''')

p=Path('package.json'); data=json.loads(p.read_text()); token='node tests/issues-406-423-unlinked.mjs'
parts=data['scripts']['decompiler:test'].split(' && ')
if token not in parts: data['scripts']['decompiler:test']=' && '.join([token]+parts)
p.write_text(json.dumps(data,indent=2)+"\n")
