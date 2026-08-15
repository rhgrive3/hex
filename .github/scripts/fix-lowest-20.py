from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]

def read(path):
    return (ROOT / path).read_text()

def write(path, text):
    (ROOT / path).write_text(text)

def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    if text.count(old) != 1:
        raise SystemExit(f"non-unique patch anchor: {label} ({text.count(old)})")
    return text.replace(old, new, 1)

def regex_once(text, pattern, repl, label, flags=0):
    out, n = re.subn(pattern, repl, text, count=1, flags=flags)
    if n != 1:
        raise SystemExit(f"regex patch failed: {label} ({n})")
    return out

# #194 — ambiguity must be symmetric across before/after candidate distributions.
p = 'js/recognition/matcher.js'
s = read(p)
s = replace_once(s,
"""  const eligibleByBefore = new Map();
  for (const c of eligible) { let list=eligibleByBefore.get(c.i); if (!list) eligibleByBefore.set(c.i,list=[]); list.push(c); }
  for (const list of eligibleByBefore.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.j-b.j);

  const selected = maximumWeightCandidateMatching(eligible);""",
"""  const eligibleByBefore = new Map(), eligibleByAfter = new Map();
  for (const c of eligible) {
    let left=eligibleByBefore.get(c.i); if (!left) eligibleByBefore.set(c.i,left=[]); left.push(c);
    let right=eligibleByAfter.get(c.j); if (!right) eligibleByAfter.set(c.j,right=[]); right.push(c);
  }
  for (const list of eligibleByBefore.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.j-b.j);
  for (const list of eligibleByAfter.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.i-b.i);

  const selected = maximumWeightCandidateMatching(eligible);""", '#194 indexes')
s = replace_once(s,
"""    const alternatives = (eligibleByBefore.get(c.i) || []).filter((x) => x.j !== c.j && x.confidence >= c.confidence - ambiguityWindow)
      .slice(0, 4).map((x) => ({ index: x.j, address: after[x.j].address, confidence: x.confidence, identity: x.identity, reasons: x.reasons }));
    const ambiguous = alternatives.length > 0;""",
"""    const forwardAlternatives = (eligibleByBefore.get(c.i) || []).filter((x) => x.j !== c.j && x.confidence >= c.confidence - ambiguityWindow)
      .slice(0, 4).map((x) => ({ side:'after', index:x.j, address:after[x.j].address, confidence:x.confidence, identity:x.identity, reasons:x.reasons }));
    const reverseAlternatives = (eligibleByAfter.get(c.j) || []).filter((x) => x.i !== c.i && x.confidence >= c.confidence - ambiguityWindow)
      .slice(0, 4).map((x) => ({ side:'before', index:x.i, address:before[x.i].address, confidence:x.confidence, identity:x.identity, reasons:x.reasons }));
    const alternatives = [...forwardAlternatives, ...reverseAlternatives]
      .sort((a,b)=>b.confidence-a.confidence || String(a.side).localeCompare(String(b.side)) || a.index-b.index).slice(0, 4);
    const ambiguous = alternatives.length > 0;""", '#194 alternatives')
write(p, s)

# #299 — a definition that no longer depends on the prior value ends the run.
p = 'js/comprehend.js'; s = read(p)
old = """      if (!contains(now, before)) {
        /*
         * 前の値を含まない代入。2 通りある。
         *
         *   計算した値を入れ直した   … 分岐の反対側で同じ変数を作り直しただけ。
         *                              持ち回りは続いている（入れ直し）。
         *   読み込んだ／別物を入れた … そのレジスタは別の用途に移った。区間は終わり。
         *
         * ここを区別しないと、関数の後半でループの添字に使い回された同じ
         * レジスタの `add x25, x25, #4` が、計算の工程として混ざる。
         */
        if (/^(bin|un|sel)$/.test(now.k)) {
          if (!open.has(reg)) open.set(reg, { reg, steps: [], ops: new Set() });
          open.get(reg).steps.push({
            row: insn.row, address: insn.address, reg,
            before, after: now, reseed: true, expr: now,
          });
        } else close(reg);
        continue;
      }"""
new = """      if (!contains(now, before)) {
        /* A definition independent of the reaching value may be a sibling CFG arm.
         * Linear row order cannot prove continuity, so fail closed: terminate the
         * current accumulator interval. A later dependent update may start a new one. */
        close(reg);
        continue;
      }"""
s = replace_once(s, old, new, '#299 accumulator reseed')
write(p, s)

# IR core: #408 #410 #411 #412 #413 #414 #416 #418 and Memory-SSA guard for #407.
p = 'js/ir-core.js'; s = read(p)
s = replace_once(s,
"""  if (op.k === 'imm') {
    if (op.value == null) return op.float != null ? { t: 'imm', value: null, float: op.float } : null;
    return { t: 'imm', value: op.value, shift: op.shift || null };
  }""",
"""  if (op.k === 'imm') {
    if (op.value == null) return op.float != null ? { t:'imm', value:null, float:Number(op.float), constKind:'float', bits:op.bits || 64, shift:op.shift || null } : null;
    return { t:'imm', value:op.value, bits:op.bits || 64, shift:op.shift || null };
  }""", '#408 operand float')

anchor = """function lift(insn, opts = {}) {"""
helper = """function functionReturnLocation(opts) {
  const proto = opts?.functionPrototype || opts?.prototype || null;
  const type = String(opts?.returnType || proto?.returnType || proto?.ret || proto?.result || '').toLowerCase();
  const cls = String(opts?.returnClass || proto?.returnClass || proto?.abiClass || proto?.resultClass || '').toLowerCase();
  if (opts?.returnsValue === false || proto?.returnsValue === false || proto?.void === true || type === 'void' || cls === 'void') return null;
  if (proto?.indirectResult === true || cls === 'indirect') return null;
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:Number(proto?.returnBits || proto?.bits || opts?.returnBits || 64) || 64 };
  }
  if (type || cls || opts?.returnsValue === true || proto?.returnsValue === true) {
    return { reg:'x0', bits:Number(proto?.returnBits || proto?.bits || opts?.returnBits || 64) || 64 };
  }
  return null;
}

function lift(insn, opts = {}) {"""
s = replace_once(s, anchor, helper, '#411 function return ABI')
s = replace_once(s,
"""  if (insn.isReturn) { push({ op: OP.RET, srcs: [] }); return out; }""",
"""  if (insn.isReturn) {
    const result = functionReturnLocation(opts);
    push({ op:OP.RET, srcs:result ? [{ t:'reg', reg:result.reg, bits:result.bits }] : [], returnReg:result?.reg || null, returnEvidence:result ? 'prototype' : null });
    return out;
  }""", '#411 ret source')
s = replace_once(s,
"""    if (base === 'movn' && src.t === 'imm' && src.value != null) {
      push({ op: OP.CONST, dstReg: dstReg(), dstBits: dstBits(),
        value: mask(~src.value, dstBits()), srcs: [] });
      return out;
    }""",
"""    if (base === 'movn' && src.t === 'imm' && src.value != null) {
      let v = src.value;
      if (src.shift && src.shift.op === 'lsl') v <<= BigInt(src.shift.amount || 0);
      push({ op:OP.CONST, dstReg:dstReg(), dstBits:dstBits(), value:mask(~v, dstBits()), srcs:[] });
      return out;
    }""", '#414 movn')
s = replace_once(s,
"""  if (base === 'movk') {
    const src = opnd(ops[1]);
    push({ op: OP.BFI, dstReg: dstReg(), dstBits: dstBits(),
      lsb: src && src.shift && src.shift.op === 'lsl' ? (src.shift.amount || 0) : 0, width: 16,
      srcs: [{ t: 'reg', reg: dstReg(), bits: dstBits() }, src || { t: 'imm', value: 0n }] });
    return out;
  }""",
"""  if (base === 'movk') {
    const src = opnd(ops[1]);
    const lsb = src?.shift?.op === 'lsl' ? (src.shift.amount || 0) : 0;
    const insert = src ? { ...src, shift:null } : { t:'imm', value:0n };
    push({ op:OP.BFI, dstReg:dstReg(), dstBits:dstBits(), lsb, width:16,
      srcs:[{ t:'reg', reg:dstReg(), bits:dstBits() }, insert] });
    return out;
  }""", '#416 movk')
s = replace_once(s,
"""      push({ op: OP.BFI, dstReg: dstReg(), dstBits: dstBits(), lsb, width,
        srcs: [{ t: 'reg', reg: dstReg(), bits: dstBits() }, opnd(ops[1])].filter(Boolean) });""",
"""      push({ op:OP.BFI, dstReg:dstReg(), dstBits:dstBits(), lsb, width, bitfieldKind:base,
        srcs:[{ t:'reg', reg:dstReg(), bits:dstBits() }, opnd(ops[1])].filter(Boolean) });""", '#418 bitfield kind')
s = replace_once(s,
"""const CALL_CLOBBERS = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8',
  'x9', 'x10', 'x11', 'x12', 'x13', 'x14', 'x15', 'x16', 'x17', 'x30', 'nzcv'];""",
"""const CALL_CLOBBERS = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8',
  'x9', 'x10', 'x11', 'x12', 'x13', 'x14', 'x15', 'x16', 'x17', 'x30', 'nzcv',
  ...Array.from({length:8}, (_x,i)=>`v${i}`), ...Array.from({length:16}, (_x,i)=>`v${i+16}`)];""", '#410 SIMD clobbers')
s = replace_once(s,
"""    if (src.t === 'imm') {
      const v = newValue(VK.CONST, { const: src.value, bits: 64 });
      if (src.float != null) v.float = src.float;
      return { value: v, shift: src.shift || null, bits: src.bits || 64 };
    }""",
"""    if (src.t === 'imm') {
      const v = newValue(VK.CONST, { const:src.value, bits:src.bits || 64 });
      if (src.float != null) { v.float=Number(src.float); v.floatConst=Number(src.float); v.constKind='float'; }
      return { value:v, shift:src.shift || null, bits:src.bits || 64 };
    }""", '#408 resolve float')
# #413: extension is followed by the encoded left shift.
for opname, expr0 in [
    ('uxtb', 'v & 0xffn'), ('uxth', 'v & 0xffffn'), ('uxtw', 'v & 0xffffffffn'),
    ('sxtb', 'BigInt.asIntN(8, v)'), ('sxth', 'BigInt.asIntN(16, v)'), ('sxtw', 'BigInt.asIntN(32, v)')]:
    old = f"    case '{opname}': return mask({expr0}, bits);"
    new = f"    case '{opname}': return mask(({expr0}) << n, bits);"
    s = replace_once(s, old, new, '#413 ' + opname)
# #412: unsigned loads truncate to memory access width before destination widening.
s = replace_once(s,
"""          if (!inst.extra || !inst.extra.signed) setConst(inst.dst, store.args[0].value.const);
          else setConst(inst.dst, mask(signedOf(mask(store.args[0].value.const, (inst.extra.size || 8) * 8), (inst.extra.size || 8) * 8), bits));""",
"""          const loadBits = Math.max(1, Math.min(64, Number(inst.extra?.size || 8) * 8));
          if (!inst.extra || !inst.extra.signed) setConst(inst.dst, mask(store.args[0].value.const, Math.min(bits, loadBits)));
          else setConst(inst.dst, mask(signedOf(mask(store.args[0].value.const, loadBits), loadBits), bits));""", '#412 load width')
write(p, s)

# #407 — RMW proof must use the exact Memory-SSA version read by the load.
p = 'js/ir-core.js'; s = read(p)
# Insert a guard where the RMW candidate has found its load and before it is emitted.
needle = """    if (!load) continue;
    const chain = [];"""
if needle in s:
    s = replace_once(s, needle, """    if (!load) continue;
    // The load must read the Memory-SSA version immediately preceding this store.
    // Otherwise an intervening same-location store makes the apparent RMW stale.
    if (store.memDef && load.memUse !== store.memDef.prev) continue;
    const chain = [];""", '#407 memory version')
else:
    # Alternate current layout: guard just before the result is accepted.
    s = regex_once(s, r"(if \(!load\) continue;\n)(\s*)(?=let cur =|const chain =)", r"\1\2if (store.memDef && load.memUse !== store.memDef.prev) continue;\n\2", '#407 memory version regex')
write(p, s)

# Typed AST and pretty printer for #408.
p='js/decompiler/ast/nodes.js'; s=read(p)
s=replace_once(s,
"""  constant(value, bits = 64, signed = null, source = null) { return node('const', { value: BigInt(value), bits: Number(bits || 64), signed, effect: 'pure' }, source); },""",
"""  constant(value, bits = 64, signed = null, source = null) { return node('const', { value: BigInt(value), bits: Number(bits || 64), signed, effect: 'pure' }, source); },
  floatConstant(value, bits = 64, source = null) { return node('float-const', { value:Number(value), bits:Number(bits || 64), signed:null, floating:true, effect:'pure' }, source); },""", '#408 float AST')
s=replace_once(s,
"""      case 'const': value = `c:${semanticTag(n)}:${n.value}`; break;""",
"""      case 'const': value = `c:${semanticTag(n)}:${n.value}`; break;
      case 'float-const': { const fv=Number.isNaN(n.value)?'NaN':n.value===Infinity?'Infinity':n.value===-Infinity?'-Infinity':Object.is(n.value,-0)?'-0':String(n.value); value=`fc:${semanticTag(n)}:${fv}`; break; }""", '#408 float key')
write(p,s)

p='js/decompiler/pretty/c.js'; s=read(p)
s=replace_once(s, """function wrap(text, p, parent) { return p < parent ? `(${text})` : text; }""",
"""function floatText(value, bits = 64) {
  const n = Number(value);
  if (Number.isNaN(n)) return 'NAN';
  if (n === Infinity) return 'INFINITY';
  if (n === -Infinity) return '-INFINITY';
  let text = Object.is(n, -0) ? '-0.0' : String(n);
  if (!/[.eE]/.test(text)) text += '.0';
  return Number(bits || 64) <= 32 ? text + 'f' : text;
}

function wrap(text, p, parent) { return p < parent ? `(${text})` : text; }""", '#408 float text')
s=replace_once(s, """    case 'const': return integerText(n.value, n.bits, n.signed);""",
"""    case 'const': return integerText(n.value, n.bits, n.signed);
    case 'float-const': return floatText(n.value, n.bits);""", '#408 pretty case')
write(p,s)

# Shared exact NZCV semantics: #404 TST/ANDS and #419 FCMP unordered.
p='js/decompiler/flag-semantics.js'; s=read(p)
s=replace_once(s, """const FLAG_SUBS = new Set(['sub', 'add', 'and']);""", """const FLAG_SUBS = new Set(['sub', 'add', 'and', 'fsub']);""", '#419 flag subs')
s=replace_once(s, """function flagsFor(sub, left, right, bits = 64) {
  bits = widthOf(bits);""",
"""function flagsFor(sub, left, right, bits = 64) {
  if (sub === 'fsub') {
    const a=Number(left), b=Number(right);
    if (Number.isNaN(a) || Number.isNaN(b)) return { n:false, z:false, c:true, v:true, result:NaN, bits:widthOf(bits) };
    if (a === b) return { n:false, z:true, c:true, v:false, result:0, bits:widthOf(bits) };
    if (a < b) return { n:true, z:false, c:false, v:false, result:a-b, bits:widthOf(bits) };
    return { n:false, z:false, c:true, v:false, result:a-b, bits:widthOf(bits) };
  }
  bits = widthOf(bits);""", '#419 fp flags')
insert = """  if (sub === 'fsub') {
    switch (cond) {
      case 'eq': return directCompare('eq', left, right, false, bits, source);
      case 'ne': return directCompare('ne', left, right, false, bits, source);
      case 'mi': case 'lo': case 'cc': return directCompare('lt', left, right, true, bits, source);
      case 'ls': return directCompare('le', left, right, true, bits, source);
      case 'ge': return directCompare('ge', left, right, true, bits, source);
      case 'gt': return directCompare('gt', left, right, true, bits, source);
      default: return intrinsicCondition(sub, cond, left, right, bits, source);
    }
  }

"""
s=replace_once(s, """  if (sub === 'sub') {""", insert + """  if (sub === 'sub') {""", '#419 fp expression')
write(p,s)

# Pipeline consumes shared NZCV semantics, handles float constants, bitfield aliases, and typed returns.
p='js/decompiler/pipeline-core.js'; s=read(p)
s=replace_once(s, """import { explainSemanticFacts } from './explain.js';""", """import { explainSemanticFacts } from './explain.js';
import { buildNZCVConditionExpression } from './flag-semantics.js';""", '#404 import')
# Replace compareFromFlags ordinary mapping block while preserving conditional-compare fallback below.
s=regex_once(s,
 r"  const map = \{ eq:\['eq',null\].*?\n  if \(!d\.extra\?\.conditional\) return normal;",
 """  let normal;
  if (cond === 'al' || cond === 'nv') normal = expr.constant(1, 1, false, origin(d));
  else normal = buildNZCVConditionExpression(d.sub || 'sub', cond, a, b, Number(d.bits || a.bits || b.bits || 64), origin(d))
    || expr.intrinsic(`__arm64_nzcv_${d.sub || 'unknown'}_${cond || 'flags'}`, [a,b], 1, false, origin(d), { nzcvCondition:true });
  if (!d.extra?.conditional) return normal;""", '#404 shared NZCV', flags=re.S)
# Extended-register shift in high-level AST.
for opname, width, signed in [('uxtb',8,False),('uxth',16,False),('uxtw',32,False),('sxtb',8,True),('sxth',16,True),('sxtw',32,True)]:
    signop='sext' if signed else 'zext'; truncsign='true' if signed else 'false'; outsign='true' if signed else 'false'
    old=f"    case '{opname}': return expr.unary('{signop}', expr.unary('trunc', base, {width}, {truncsign}, base.source), bits, {outsign}, base.source, {{ fromBits: {width} }});"
    new=f"    case '{opname}': {{ const e=expr.unary('{signop}', expr.unary('trunc', base, {width}, {truncsign}, base.source), bits, {outsign}, base.source, {{ fromBits:{width} }}); return Number(shift.amount || 0) ? expr.binary('shl', e, amount, bits, {outsign}, base.source) : e; }}"
    s=replace_once(s, old, new, '#413 pipeline '+opname)
# Float constants take precedence over integer const==null fallback.
s=replace_once(s, """  let out = null;
  const d = v.def;
  if (v.const != null && d?.op !== 'addr') out = constNode(v);""",
"""  let out = null;
  const d = v.def;
  if (v.constKind === 'float' || v.floatConst != null || (v.float != null && v.const == null)) out = expr.floatConstant(v.floatConst ?? v.float, v.bits || 64, origin(d, v));
  if (!out && v.const != null && d?.op !== 'addr') out = constNode(v);""", '#408 pipeline float')
s=replace_once(s, """    if (d.op === 'const') out = constNode(v, v.const ?? d.extra?.value ?? 0n);""",
"""    if (d.op === 'const') out = (v.constKind === 'float' || v.floatConst != null || v.float != null)
      ? expr.floatConstant(v.floatConst ?? v.float, v.bits || 64, origin(d, v))
      : constNode(v, v.const ?? d.extra?.value ?? 0n);""", '#408 const def')
# #417/#418 exact bitfield reconstruction.
s=replace_once(s,
"""    } else if (d.op === 'bfx') {
      out = expr.intrinsic('bit_extract', [buildArg(d.args?.[0], state), expr.constant(d.extra?.lsb ?? 0, 64), expr.constant(d.extra?.width ?? v.bits ?? 64, 64)], v.bits || 64, d.extra?.signed ?? d.signed ?? false, origin(d, v));
    } else if (d.op === 'bfi') {
      out = expr.intrinsic('bit_insert', [buildArg(d.args?.[0], state), buildArg(d.args?.[1], state), expr.constant(d.extra?.lsb ?? 0, 64), expr.constant(d.extra?.width ?? 16, 64)], v.bits || 64, signedFor(state, v), origin(d, v));
    }""",
"""    } else if (d.op === 'bfx') {
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
    }""", '#417 #418 pipeline bitfields')
# Typed return helper in pipeline.
s=replace_once(s, """function expressionFor(v, state) { return state.expressions?.get(v?.id) || walkIdiom(buildValue(v, state)); }""",
"""function expressionFor(v, state) { return state.expressions?.get(v?.id) || walkIdiom(buildValue(v, state)); }
function returnRegisterForState(state) {
  const type=String(state.opts?.returnType || state.opts?.functionPrototype?.returnType || state.opts?.prototype?.returnType || state.prototype?.returnType || '').toLowerCase();
  if (!type || type === 'void') return null;
  return /^(float|double|__fp16)/.test(type) || /vector|simd/.test(type) ? 'v0' : 'x0';
}
function returnValueAt(inst, state) {
  const explicit=valueOf(inst?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForState(state);
  return reg ? reachingRegisterValue(state.ir, inst, reg) : null;
}""", '#411 pipeline return helper')
s=s.replace("valueOf(inst.args?.[0]) || reachingRegisterValue(state.ir, inst, 'x0')", "returnValueAt(inst, state)")
s=s.replace("valueOf(ret.args?.[0]) || reachingRegisterValue(state.ir, ret, 'x0')", "returnValueAt(ret, state)")
write(p,s)

# Legacy semantic decompiler: exact one-op RMW, floats, typed return fallback.
p='js/decompiler/semantic.js'; s=read(p)
s=replace_once(s, """function formatConst(v, bits = 64) {""",
"""function formatFloatConst(v, bits = 64) {
  const n=Number(v);
  if (Number.isNaN(n)) return 'NAN';
  if (n === Infinity) return 'INFINITY';
  if (n === -Infinity) return '-INFINITY';
  let text=Object.is(n,-0) ? '-0.0' : String(n);
  if (!/[.eE]/.test(text)) text += '.0';
  return Number(bits || 64) <= 32 ? text + 'f' : text;
}

function formatConst(v, bits = 64) {""", '#408 semantic float formatter')
s=replace_once(s, """  let out = null;
  if (value.const != null && value.def?.op !== OP.ADDR) out = stringLiteralForValue(value, ctx) || formatConst(value.const, value.bits);""",
"""  let out = null;
  if (value.constKind === 'float' || value.floatConst != null || (value.float != null && value.const == null)) out = formatFloatConst(value.floatConst ?? value.float, value.bits);
  if (!out && value.const != null && value.def?.op !== OP.ADDR) out = stringLiteralForValue(value, ctx) || formatConst(value.const, value.bits);""", '#408 semantic float')
s=replace_once(s, """    if (d.op === OP.CONST) out = formatConst(value.const ?? d.extra?.value ?? 0n, value.bits);""",
"""    if (d.op === OP.CONST) out = (value.constKind === 'float' || value.floatConst != null || value.float != null)
      ? formatFloatConst(value.floatConst ?? value.float, value.bits)
      : formatConst(value.const ?? d.extra?.value ?? 0n, value.bits);""", '#408 semantic const')
s=replace_once(s,
"""function rmwOperand(rmw, ctx) {
  const loadValue = rmw.load?.dst;
  for (const inst of rmw.chain || []) {
    if (inst.op !== OP.BIN || !['add', 'sub', 'mul', 'sdiv', 'udiv'].includes(inst.sub)) continue;
    const a = valueOf(inst.args?.[0]), b = valueOf(inst.args?.[1]);
    if (sameValue(a, loadValue)) return { op: inst.sub, other: b, reversed: false };
    if (sameValue(b, loadValue)) return { op: inst.sub, other: a, reversed: true };
  }
  return null;
}""",
"""function rmwOperand(rmw, ctx) {
  void ctx;
  const loadValue=rmw.load?.dst;
  const written=valueOf(rmw.store?.args?.[0]);
  const inst=written?.def;
  if (!inst || inst.op !== OP.BIN || !['add','sub','mul','sdiv','udiv'].includes(inst.sub)) return null;
  const a=valueOf(inst.args?.[0]), b=valueOf(inst.args?.[1]);
  if (sameValue(a,loadValue)) return { op:inst.sub, other:b, reversed:false };
  if (sameValue(b,loadValue)) return { op:inst.sub, other:a, reversed:true };
  return null;
}""", '#406 exact RMW')
# Replace hardwired x0 return lookup with return ABI helper.
s=replace_once(s, """function feedsReturn(value, ctx) {""",
"""function returnRegisterForContext(ctx) {
  const type=String(ctx.opts?.returnType || ctx.opts?.functionPrototype?.returnType || ctx.opts?.prototype?.returnType || ctx.types?.ret?.type || '').toLowerCase();
  if (!type || type === 'void') return null;
  return /^(float|double|__fp16)/.test(type) || /vector|simd/.test(type) ? 'v0' : 'x0';
}
function returnValueAt(ret, ctx) {
  const explicit=valueOf(ret?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForContext(ctx);
  return reg ? reachingRegisterValue(ctx.ir, ret, reg) : null;
}

function feedsReturn(value, ctx) {""", '#411 semantic return helper')
s=s.replace("reachingRegisterValue(ctx.ir, ret, 'x0') || valueOf(ret.args?.[0])", "returnValueAt(ret, ctx)")
s=s.replace("reachingRegisterValue(ctx.ir, term2, 'x0') || valueOf(term2.args?.[0])", "returnValueAt(term2, ctx)")
write(p,s)

# #422/#423 — only explicit proof/completed runtime results can enter VERIFIED family.
p='js/semantic-evidence.js'; s=read(p)
s=replace_once(s, """function boundedStrength(v) {
  if (v == null || !Number.isFinite(Number(v))) return 1;
  return Math.max(0, Math.min(1, Number(v)));
}""",
"""function boundedStrength(v) {
  if (v == null || !Number.isFinite(Number(v))) return 0;
  return Math.max(0, Math.min(1, Number(v)));
}
function isExplicitSemanticProof(f, e) {
  const grade=String(f?.proofGrade || e?.proofGrade || f?.grade || e?.grade || '').toLowerCase();
  return f?.verified === true || e?.verified === true || !!(f?.verificationOrigin || e?.verificationOrigin)
    || ['verified','proof','proof-grade','deterministic'].includes(grade);
}
function runtimeCompleted(r) {
  if (!r || typeof r !== 'object') return false;
  const status=String(r.status || r.state || '').toLowerCase();
  if (r.ok === false || r.success === false || r.complete === false || r.completed === false || r.truncated === true
      || r.timedOut === true || r.timeout === true || r.budgetExceeded === true
      || ['timeout','timed-out','failed','failure','error','crashed','truncated','partial','aborted','budget-exceeded'].includes(status)) return false;
  return r.ok === true || r.success === true || r.complete === true || r.completed === true
    || ['ok','success','succeeded','complete','completed'].includes(status);
}""", '#422 strength helpers')
s=replace_once(s, """      out.push({
        code: 'semantic-ir-proof',
        strength: boundedStrength(f.confidence),
        lr,
        family: FAMILY.VERIFIED,
        kind: 'verified',""",
"""      const strength=boundedStrength(f.confidence);
      if (strength <= 0) continue;
      const verified=isExplicitSemanticProof(f,e);
      out.push({
        code: verified ? 'semantic-ir-proof' : 'semantic-ir-observation',
        strength,
        lr: verified ? lr : Math.min(lr, 4),
        family: verified ? FAMILY.VERIFIED : FAMILY.USAGE,
        kind: verified ? 'verified' : 'semantic',""", '#422 verified family')
s=replace_once(s, """export function runtimeEvidenceItems(runtimeResult, opts) {
  if (!runtimeResult) return [];""",
"""export function runtimeEvidenceItems(runtimeResult, opts) {
  if (!runtimeCompleted(runtimeResult)) return [];""", '#423 runtime completion')
s=replace_once(s, """  const strength = boundedStrength(o.strength == null ? 1 : o.strength);""",
"""  const strength = boundedStrength(o.strength == null ? 1 : o.strength);
  if (strength <= 0) return [];""", '#423 runtime strength')
write(p,s)

# #432 — legacy FAT migration must use the active slice, never the first UUID by accident.
p='js/names.js'; s=read(p)
s=replace_once(s,
"""export function legacyNoteKeyFor(file, fileInfo) {
  const parts = [];
  if (file && file.name) parts.push(file.name);
  if (file && file.size != null) parts.push(String(file.size));
  const slice = fileInfo && fileInfo.slices
    ? fileInfo.slices.find((s) => s.info && s.info.uuid)
    : null;
  if (slice) parts.push(slice.info.uuid);
  return parts.length ? parts.join('|') : null;
}""",
"""export function legacyNoteKeyFor(file, fileInfo, sliceIndex = null) {
  const parts=[];
  if (file?.name) parts.push(file.name);
  if (file?.size != null) parts.push(String(file.size));
  const slices=fileInfo?.slices || [];
  const selected=Number.isInteger(sliceIndex) && sliceIndex >= 0 ? slices[sliceIndex] : null;
  // A legacy FAT key is safe only when the caller identifies the active slice.
  // For a single-slice image the sole UUID is unambiguous.
  const slice=selected || (slices.length === 1 ? slices[0] : null);
  if (slice?.info?.uuid) parts.push(slice.info.uuid);
  else if (slices.length > 1) return null;
  return parts.length ? parts.join('|') : null;
}""", '#432 legacy key')
write(p,s)

p='js/app.js'; s=read(p)
s=s.replace("legacyNoteKeyFor(file, info)]", "legacyNoteKeyFor(file, info, sliceIndex)]", 1)
s=s.replace("legacyNoteKeyFor(file, info)]", "legacyNoteKeyFor(file, info, index)]", 1)
write(p,s)

# Type recovery uses explicit prototype return type even if a legacy RET has no source.
p='js/decompiler/type-recovery.js'; s=read(p)
anchor="""  if (rets.length) {
    const vals = rets.map((r) => valueOf(r.args && r.args[0])).filter(Boolean);"""
if anchor in s:
    # append fallback after the enclosing rets block by targeting the next stable prototype-signature section if available
    marker="""  return { values, locations, ret, evidence };"""
    if marker in s:
        s=s.replace(marker, """  const declaredReturn=opts?.returnType || opts?.functionPrototype?.returnType || opts?.prototype?.returnType;
  if (declaredReturn && ret.type === 'void') ret={ type:String(declaredReturn), conf:0.95, why:['prototype return type'] };
  return { values, locations, ret, evidence };""",1)
write(p,s)

# Regression tests for the batch; #409 and #430 also remain covered by their existing tests/suites.
test = r'''import assert from 'node:assert/strict';
import { matchFunctions } from '../js/recognition/matcher.js';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';
import { expr } from '../js/decompiler/ast/nodes.js';
import { printExpression } from '../js/decompiler/pretty/c.js';
import { buildExpressionForTesting } from '../js/decompiler/pipeline-core.js';
import { evaluateNZCVCondition, buildNZCVConditionExpression } from '../js/decompiler/flag-semantics.js';
import { semanticEvidenceItems, runtimeEvidenceItems } from '../js/semantic-evidence.js';
import { FAMILY } from '../js/evidence.js';
import { legacyNoteKeyFor } from '../js/names.js';

const bytes=(...xs)=>Uint8Array.from(xs);
// #194: reverse-side competition alone is ambiguity.
{
  const common={bytes:bytes(1,2,3,4,5,6,7,8),cfg:{blocks:1,edges:0,exits:1},strings:['same'],imports:[]};
  const before=[{...common,address:1n},{...common,address:2n}];
  const after=[{...common,address:3n}];
  const r=matchFunctions(before,after,{threshold:0.5});
  assert.equal(r.matches.length,1); assert.equal(r.matches[0].ambiguous,true);
  assert.ok(r.matches[0].candidates.some((x)=>x.side==='before'));
}
function asm(lines, base=0x100000000n){return lines.map((line,i)=>{const s=line.trim(),sp=s.indexOf(' ');return {row:i,address:base+BigInt(i)*4n,mn:sp<0?s:s.slice(0,sp),ops:sp<0?'':s.slice(sp+1)};});}
function build(lines,opts={}){const base=0x100000000n;const rowOfAddress=(a)=>{const r=a-base;return r<0n||r>=BigInt(lines.length)*4n?null:Number(r/4n)};const model=buildSemanticModel(asm(lines,base),{startRow:0,endRow:lines.length-1,rowOfAddress});return buildIR(model,{rowOfAddress,...opts});}
// #410: caller-saved SIMD/FP regs are clobbered, while a typed v0 result survives.
{
  const ir=build(['fmov d16, #1.0','bl #0x100001000','fmov d1, d16','ret']);
  const call=ir.instructions.find((x)=>x.op===OP.CALL); assert.ok(call);
  assert.ok(ir.values.some((v)=>v.reg==='v16'&&v.def===call&&v.clobbered));
}
{
  const ir=build(['bl #0x100001000','ret'],{callPrototypeFor:()=>({returnType:'double',returnBits:64})});
  const call=ir.instructions.find((x)=>x.op===OP.CALL); assert.equal(call.dst?.reg,'v0');
}
// #411: RET is void when unknown, v0 when function prototype says floating point.
{
  const ir=build(['ret']); const ret=ir.instructions.find((x)=>x.op===OP.RET); assert.equal(ret.args.length,0);
}
{
  const ir=build(['fmov d0, #1.0','ret'],{returnType:'double'}); const ret=ir.instructions.find((x)=>x.op===OP.RET); assert.equal(ret.args[0]?.value?.reg,'v0');
}
// #412 unsigned narrow load truncates a wider stored constant.
{
  const ir=build(['mov x8, #0x1234','str x8, [sp, #8]','ldrb w9, [sp, #8]','ret']);
  const load=ir.instructions.find((x)=>x.op===OP.LOAD); assert.equal(load.dst.const,0x34n);
}
// #413 extension then shift.
{
  const ir=build(['mov x8, #0xFFFFFFFF','add x9, x0, w8, uxtw #2','ret']);
  const v=ir.values.filter((x)=>x.reg==='x9').pop();
  // x0 is unknown, but the shifted constant operand must be represented on the BIN arg.
  const bin=v.def; assert.equal(bin.args[1].shift.op,'uxtw'); assert.equal(bin.args[1].shift.amount,2);
}
// #414 MOVN shift precedes complement; #416 MOVK source is not shifted twice.
{
  const ir=build(['movn x8, #1, lsl #16','ret']); const v=ir.values.filter((x)=>x.reg==='x8').pop(); assert.equal(v.const,BigInt.asUintN(64,~(1n<<16n)));
}
{
  const ir=build(['movz x8, #0','movk x8, #0x1234, lsl #16','ret']); const v=ir.values.filter((x)=>x.reg==='x8').pop(); assert.equal(v.const,0x12340000n);
}
// #417 UBFIZ/SBFIZ are insertion/left-shift semantics, not bit_extract.
{
  const src={id:1,bits:64,kind:'arg',reg:'x1',uses:[]}; const inst={id:1,op:'bfx',extra:{toward:'left',lsb:8,width:8,signed:false},args:[{value:src}],dst:null}; const v={id:2,bits:64,def:inst,uses:[]};inst.dst=v;
  const out=buildExpressionForTesting(v,{ir:{values:[src,v],args:new Map()},model:{calls:[]}}); assert.notEqual(out.kind==='intrinsic'&&out.name==='bit_extract',true); assert.match(printExpression(out),/<< 8/);
}
// #418 BFXIL selects source bits at lsb but inserts at destination bit 0.
{
  const old={id:1,bits:64,kind:'arg',reg:'x0',uses:[]},src={id:2,bits:64,kind:'arg',reg:'x1',uses:[]}; const inst={id:3,op:'bfi',extra:{bitfieldKind:'bfxil',lsb:8,width:8},args:[{value:old},{value:src}],dst:null};const v={id:3,bits:64,def:inst,uses:[]};inst.dst=v;
  const text=printExpression(buildExpressionForTesting(v,{ir:{values:[old,src,v],args:new Map()},model:{calls:[]}})); assert.match(text,/>> 8/); assert.doesNotMatch(text,/bit_insert/);
}
// #404 logical flags and #419 unordered FP flags are exact.
assert.equal(evaluateNZCVCondition('and','cs',0x80n,0xffn,8),false);
assert.equal(evaluateNZCVCondition('and','mi',0x80n,0xffn,8),true);
assert.equal(evaluateNZCVCondition('fsub','vs',NaN,1,64),true);
assert.equal(evaluateNZCVCondition('fsub','cs',NaN,1,64),true);
assert.equal(evaluateNZCVCondition('fsub','eq',NaN,1,64),false);
{
  const c=buildNZCVConditionExpression('fsub','vs',expr.floatConstant(NaN),expr.floatConstant(1),64); assert.equal(c.kind,'intrinsic');
}
// #408 float constants have distinct AST/literal identity.
assert.equal(printExpression(expr.floatConstant(1.5,64)),'1.5');
assert.equal(printExpression(expr.floatConstant(1,32)),'1.0f');
assert.equal(printExpression(expr.floatConstant(NaN,64)),'NAN');
// #422 confidence is fail-closed; non-proof facts are not VERIFIED.
{
  assert.equal(semanticEvidenceItems([{kind:'read',confidence:NaN,evidence:[{row:1}]}]).length,0);
  const weak=semanticEvidenceItems([{kind:'read',confidence:0.8,evidence:[{row:1}]}]); assert.equal(weak[0].family,FAMILY.USAGE);
  const proof=semanticEvidenceItems([{kind:'read',confidence:0.8,verified:true,evidence:[{row:1}]}]); assert.equal(proof[0].family,FAMILY.VERIFIED);
}
// #423 partial/failed runtime execution never becomes VERIFIED.
for (const bad of [{ok:false},{status:'timeout'},{complete:false,touchedFields:[{offset:1}]},{truncated:true,touchedFields:[{offset:1}]}]) assert.equal(runtimeEvidenceItems(bad).length,0);
assert.equal(runtimeEvidenceItems({ok:true,touchedFields:[{offset:1}]}).length,1);
// #432 active FAT slice UUID is mandatory and selected explicitly.
{
  const file={name:'A',size:10},info={slices:[{info:{uuid:'U0'}},{info:{uuid:'U1'}}]};
  assert.equal(legacyNoteKeyFor(file,info),null); assert.equal(legacyNoteKeyFor(file,info,1),'A|10|U1');
}
console.log('lowest-20 issue regression tests: ok');
'''
write('tests/issues-lowest-20-20260815.mjs', test)
print('patch applied')
