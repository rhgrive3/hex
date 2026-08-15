from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    p.write_text(text.replace(old, new, 1))


replace_once('js/ir.js',
"""import {
  buildIR as buildCoreIR,
  readModifyWrite as coreReadModifyWrite,
  OP, MK, VK, COND,
} from './ir-core.js';
""",
"""import {
  buildIR as buildCoreIR,
  readModifyWrite as coreReadModifyWrite,
  OP, MK, VK, COND,
} from './ir-core.js';
import { mergeRangeDomain, normalizeIntegerValue, normalizeRangeDomain, rangeWithDomain } from './range-domain.js';
""")

replace_once('js/ir.js',
"""function mergeRange(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return { min: a.min < b.min ? a.min : b.min, max: a.max > b.max ? a.max : b.max };
}

function rangeEq(a, b) {
  return !!a === !!b && (!a || (a.min === b.min && a.max === b.max));
}

function argumentRange(arg) {
  return arg && arg.value ? arg.value.range : null;
}
""",
"""function mergeRange(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return mergeRangeDomain(a, b, a.bits || b.bits, a.signed);
}

function rangeEq(a, b) {
  return !!a === !!b && (!a || (
    a.min === b.min && a.max === b.max && Number(a.bits || 64) === Number(b.bits || 64) && a.signed === b.signed
  ));
}

function argumentRange(arg, bits = null, signed = undefined) {
  const range = arg && arg.value ? arg.value.range : null;
  if (!range || bits == null) return range;
  return normalizeRangeDomain(range, bits, signed);
}
""")

replace_once('js/ir.js',
"""  for (const v of ir.values) {
    if (v.const != null) v.range = { min: v.const, max: v.const };
  }
""",
"""  for (const v of ir.values) {
    if (v.const != null) {
      const bits = v.bits || 64;
      const value = normalizeIntegerValue(v.const, bits, v.signed);
      v.range = rangeWithDomain(value, value, bits, v.signed);
    }
  }
""")

replace_once('js/ir.js',
"""      if (inst.op === OP.MOV && inst.args[0]) next = argumentRange(inst.args[0]);
      else if (inst.op === OP.UN && inst.args[0] && /^(uxt8|uxt16|uxt32)$/.test(inst.sub || '')) {
        const b = Number((inst.sub.match(/\d+/) || ['64'])[0]);
        next = { min: 0n, max: (1n << BigInt(b)) - 1n };
      } else if (inst.op === OP.BIN && inst.args.length >= 2) {
        const a = argumentRange(inst.args[0]);
        const b = argumentRange(inst.args[1]);
""",
"""      if (inst.op === OP.MOV && inst.args[0]) next = argumentRange(inst.args[0], bits, inst.dst.signed);
      else if (inst.op === OP.UN && inst.args[0] && /^(uxt8|uxt16|uxt32)$/.test(inst.sub || '')) {
        const b = Number((inst.sub.match(/\d+/) || ['64'])[0]);
        next = rangeWithDomain(0n, (1n << BigInt(b)) - 1n, bits, false);
      } else if (inst.op === OP.BIN && inst.args.length >= 2) {
        const a = argumentRange(inst.args[0], bits, inst.dst.signed);
        const b = argumentRange(inst.args[1], bits, inst.dst.signed);
""")

replace_once('js/ir.js',
"""          const r = argumentRange(a);
          if (!r) { complete = false; break; }
          merged = mergeRange(merged, r);
""",
"""          const r = argumentRange(a, bits, inst.dst.signed);
          if (!r) { complete = false; break; }
          merged = mergeRange(merged, r);
""")

replace_once('js/ir.js',
"""      } else if (inst.op === OP.SEL && inst.args.length >= 2) {
        const a = argumentRange(inst.args[0]), b = argumentRange(inst.args[1]);
        if (a && b) next = mergeRange(a, b);
      }
      if (next && !rangeEq(inst.dst.range, next)) { inst.dst.range = { ...next }; changed = true; }
""",
"""      } else if (inst.op === OP.SEL && inst.args.length >= 2) {
        const a = argumentRange(inst.args[0], bits, inst.dst.signed), b = argumentRange(inst.args[1], bits, inst.dst.signed);
        if (a && b) next = mergeRange(a, b);
      }
      if (next && next.bits == null) next = rangeWithDomain(next.min, next.max, bits, inst.dst.signed);
      if (next && !rangeEq(inst.dst.range, next)) { inst.dst.range = { ...next }; changed = true; }
""")

replace_once('js/ir.js',
"""export function valueRange(value) {
  if (!value) return null;
  if (value.const != null) return { min: value.const, max: value.const };
  return value.range ? { min: value.range.min, max: value.range.max } : null;
}
""",
"""export function valueRange(value) {
  if (!value) return null;
  if (value.const != null) {
    const n = normalizeIntegerValue(value.const, value.bits || 64, value.signed);
    return { min:n, max:n };
  }
  return value.range ? { min: value.range.min, max: value.range.max } : null;
}
""")

replace_once('js/decompiler/rewrite/rules.js',
"""import { evalBinary, evalUnary, fullMask, isPowerOfTwo, log2Exact, u } from '../truth/integer.js';
""",
"""import { evalBinary, evalUnary, fullMask, isPowerOfTwo, log2Exact, u } from '../truth/integer.js';
import { normalizeIntegerValue, normalizeRangeDomain } from '../../range-domain.js';
""")

replace_once('js/decompiler/rewrite/rules.js',
"""const rangeRules = [{
  name:'range-proven-compare', phase:'range',
  match:(n)=>{
    if (n?.kind!=='compare' || !n.left?.range || !isConst(n.right)) return null;
    const r=n.left.range, c=n.right.value;
    if (r.min==null || r.max==null) return null;
    let value=null;
    if (n.op==='eq' && (c<r.min || c>r.max)) value=0;
    else if (n.op==='ne' && (c<r.min || c>r.max)) value=1;
    else if (n.op==='lt' && r.max<c) value=1;
    else if (n.op==='lt' && r.min>=c) value=0;
    else if (n.op==='le' && r.max<=c) value=1;
    else if (n.op==='le' && r.min>c) value=0;
    else if (n.op==='gt' && r.min>c) value=1;
    else if (n.op==='gt' && r.max<=c) value=0;
    else if (n.op==='ge' && r.min>=c) value=1;
    else if (n.op==='ge' && r.max<c) value=0;
    return value==null ? null : { value, range:{min:String(r.min),max:String(r.max)}, constant:String(c) };
  },
""",
"""const rangeRules = [{
  name:'range-proven-compare', phase:'range',
  match:(n)=>{
    if (n?.kind!=='compare' || !n.left?.range || !isConst(n.right)) return null;
    const source=n.left.range;
    const bits=Number(n.left.bits || source.bits || 64);
    const relational=!['eq','ne'].includes(n.op);
    const compareSigned=relational ? n.compareSigned : (source.signed ?? n.compareSigned);
    if (relational && compareSigned == null) return null;
    const r=normalizeRangeDomain(source,bits,compareSigned);
    if (!r) return null;
    const c=normalizeIntegerValue(n.right.value,bits,compareSigned);
    let value=null;
    if (n.op==='eq' && (c<r.min || c>r.max)) value=0;
    else if (n.op==='ne' && (c<r.min || c>r.max)) value=1;
    else if (n.op==='lt' && r.max<c) value=1;
    else if (n.op==='lt' && r.min>=c) value=0;
    else if (n.op==='le' && r.max<=c) value=1;
    else if (n.op==='le' && r.min>c) value=0;
    else if (n.op==='gt' && r.min>c) value=1;
    else if (n.op==='gt' && r.max<=c) value=0;
    else if (n.op==='ge' && r.min>=c) value=1;
    else if (n.op==='ge' && r.max<c) value=0;
    return value==null ? null : {
      value,
      range:{min:String(r.min),max:String(r.max),bits:r.bits,signed:r.signed},
      constant:String(c),
    };
  },
""")

replace_once('package.json',
"""\"decompiler:test\": \"node tests/decompile-cfg.mjs""",
"""\"decompiler:test\": \"node tests/issue-429-range-domain.mjs && node tests/decompile-cfg.mjs""")
