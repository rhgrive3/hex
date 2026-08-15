from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "js/ir-core.js",
    "      scale: mem && mem.shift && mem.shift.op === 'lsl' ? mem.shift.amount : 0,",
    "      scale: mem && mem.shift ? (mem.shift.amount || 0) : 0,",
)

replace_once(
    "js/decompiler/semantic.js",
    "import { sourceOf, mergeSource } from './ast/nodes.js';",
    "import { sourceOf, mergeSource } from './ast/nodes.js';\n"
    "import { isNZCVCondition, renderNZCVCondition } from './flag-semantics.js';\n"
    "import { renderIndexedMemory } from './address-semantics.js';",
)

replace_once(
    "js/decompiler/semantic.js",
    """  if (loc.kind === MK.UNKNOWN) {
    if (addr.base && addr.index && addr.scale != null) {
      const base = renderValue(addr.base, ctx);
      const index = renderValue(addr.index, ctx);
      const size = Number(addr.size || 0);
      const scaleBytes = 1 << Number(addr.scale || 0);
      if (size && scaleBytes === size) return `${paren(base)}[${index}]`;
      return `memory[${base} + (${index} << ${Number(addr.scale || 0)})]`;
    }
    return 'memory_unknown';
  }""",
    """  if (loc.kind === MK.UNKNOWN) {
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
  }""",
)

replace_once(
    "js/decompiler/semantic.js",
    """function renderCmp(cmp, cond, ctx, atInst = cmp) {
  if (!cmp) return cond ? `condition_${cond}` : 'condition';
  const info = COND[cond] || null;
  const a = renderValueAt(valueOf(cmp.args?.[0]), atInst, ctx);
  const b = renderValueAt(valueOf(cmp.args?.[1]), atInst, ctx);
  if (!info) return `${a} /* ${cond || 'flags'} */`;
  if (info.vsZero) return `${a} ${info.op} 0`;
  return `${a} ${info.op} ${b}`;
}""",
    """function renderCmp(cmp, cond, ctx, atInst = cmp) {
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
}""",
)

replace_once(
    "js/decompiler/semantic.js",
    """    if (!cond || !Object.prototype.hasOwnProperty.call(COND, cond) || !COND[cond]) {
      return `__arm64_condition_${safeIdent(cond || 'unknown')}(/* NZCV */)`;
    }""",
    """    if (!cond || !isNZCVCondition(cond)) {
      return `__arm64_condition_${safeIdent(cond || 'unknown')}(/* NZCV */)`;
    }""",
)

replace_once(
    "js/decompiler/semantic.js",
    """      if (!inverse || !Object.prototype.hasOwnProperty.call(COND, inverse) || !COND[inverse]) {
        return `!(__arm64_condition_${safeIdent(cond)}(/* NZCV */))`;
      }""",
    """      if (!inverse || !isNZCVCondition(inverse)) {
        return `!(__arm64_condition_${safeIdent(cond)}(/* NZCV */))`;
      }""",
)

replace_once(
    "js/decompiler/passes/stack-return-recovery.js",
    "import { printExpression, printProgram } from '../pretty/c.js';",
    "import { printExpression, printProgram } from '../pretty/c.js';\n"
    "import { buildNZCVConditionExpression } from '../flag-semantics.js';",
)

replace_once(
    "js/decompiler/passes/stack-return-recovery.js",
    """const COND = Object.freeze({
  eq: ['eq', null], ne: ['ne', null],
  hs: ['ge', false], cs: ['ge', false], lo: ['lt', false], cc: ['lt', false],
  hi: ['gt', false], ls: ['le', false],
  ge: ['ge', true], lt: ['lt', true], gt: ['gt', true], le: ['le', true],
});
""",
    "",
)

replace_once(
    "js/decompiler/passes/stack-return-recovery.js",
    """function compareFromFlags(ir, flagsValue, cond, values) {
  const cmp = flagsValue?.def;
  const spec = COND[cond];
  if (cmp?.op !== 'cmp' || !spec) return null;

  // Flag-setting arithmetic is lifted as BIN then CMP on the same ARM64 row.
  // SSA renaming can make CMP read the just-written destination. The preceding
  // same-row BIN is an exact proof of the original flag-producing operands.
  const arithmetic = sameRowArithmetic(ir, cmp);
  const leftValue = valueOf(arithmetic?.args?.[0] || cmp.args?.[0]);
  const rightValue = valueOf(arithmetic?.args?.[1] || cmp.args?.[1]);
  const left = expressionOf(leftValue, values);
  const right = expressionOf(rightValue, values);
  if (!left || !right) return null;

  return expr.compare(spec[0], left, right, spec[1], {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    ssaUses: [leftValue?.id, rightValue?.id].filter((x) => x != null),
    evidence: [{ reason: arithmetic ? 'same-row flag-producing arithmetic operands' : 'NZCV compare operands' }],
  });
}""",
    """function compareFromFlags(ir, flagsValue, cond, values) {
  const cmp = flagsValue?.def;
  if (cmp?.op !== 'cmp') return null;

  // Flag-setting arithmetic is lifted as BIN then CMP on the same ARM64 row.
  // SSA renaming can make CMP read the just-written destination. The preceding
  // same-row BIN is an exact proof of the original flag-producing operands.
  const arithmetic = sameRowArithmetic(ir, cmp);
  const leftValue = valueOf(arithmetic?.args?.[0] || cmp.args?.[0]);
  const rightValue = valueOf(arithmetic?.args?.[1] || cmp.args?.[1]);
  const left = expressionOf(leftValue, values);
  const right = expressionOf(rightValue, values);
  if (!left || !right) return null;
  const bits = Number(cmp.bits || leftValue?.bits || rightValue?.bits || left.bits || right.bits || 64);

  return buildNZCVConditionExpression(cmp.sub || 'sub', cond, left, right, bits, {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    ssaUses: [leftValue?.id, rightValue?.id].filter((x) => x != null),
    evidence: [{ reason: arithmetic ? 'same-row flag-producing arithmetic operands' : 'NZCV compare operands' }],
  });
}""",
)

replace_once(
    "js/decompiler/passes/stack-phi-recovery.js",
    "import { printExpression, printProgram } from '../pretty/c.js';",
    "import { printExpression, printProgram } from '../pretty/c.js';\n"
    "import { buildNZCVConditionExpression } from '../flag-semantics.js';",
)

replace_once(
    "js/decompiler/passes/stack-phi-recovery.js",
    """const CONDITION_OP = Object.freeze({
  eq: 'eq', ne: 'ne', hs: 'ge', cs: 'ge', lo: 'lt', cc: 'lt', hi: 'gt', ls: 'le',
  ge: 'ge', lt: 'lt', gt: 'gt', le: 'le',
});
const INVERT_OP = Object.freeze({ eq: 'ne', ne: 'eq', lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' });

function signednessForCondition(cond) {
  if (['ge', 'lt', 'gt', 'le'].includes(cond)) return true;
  if (['hs', 'cs', 'lo', 'cc', 'hi', 'ls'].includes(cond)) return false;
  return null;
}""",
    """const INVERT_OP = Object.freeze({ eq: 'ne', ne: 'eq', lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' });""",
)

replace_once(
    "js/decompiler/passes/stack-phi-recovery.js",
    """  const left = expressionOfValue(leftValue, maps);
  const right = expressionOfValue(rightValue, maps);
  const op = CONDITION_OP[cond];
  if (!left || !right || !op) return null;

  if (cmp.sub === 'sub') {
    return expr.compare(op, left, right, signednessForCondition(cond), {
      address: cmp.address,
      row: cmp.row,
      ir: cmp.id,
      ssaUses: [leftValue?.id, rightValue?.id].filter((x) => x != null),
      evidence: [{ reason: producer ? 'same-row flag producer operands' : 'NZCV comparison' }],
    });
  }

  // TST/ANDS compare the bitwise result with zero. For CMN/ADDS, only
  // conditions whose truth is expressible as the arithmetic result vs zero are
  // reconstructed here; carry/borrow forms remain conservative.
  const bits = Math.max(Number(left.bits || 0), Number(right.bits || 0), 1);
  if (cmp.sub === 'and' && ['eq', 'ne'].includes(cond)) {
    const result = expr.binary('and', left, right, bits, false, cmp.source);
    return expr.compare(op, result, expr.constant(0, bits, false), false, cmp.source);
  }
  if (cmp.sub === 'add' && ['eq', 'ne', 'ge', 'lt', 'gt', 'le'].includes(cond)) {
    const signed = signednessForCondition(cond);
    const result = expr.binary('add', left, right, bits, signed, cmp.source);
    return expr.compare(op, result, expr.constant(0, bits, signed), signed, cmp.source);
  }
  return null;""",
    """  const left = expressionOfValue(leftValue, maps);
  const right = expressionOfValue(rightValue, maps);
  if (!left || !right) return null;
  const bits = Math.max(Number(cmp.bits || 0), Number(left.bits || 0), Number(right.bits || 0), 1);
  return buildNZCVConditionExpression(cmp.sub || 'sub', cond, left, right, bits, {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    ssaUses: [leftValue?.id, rightValue?.id].filter((x) => x != null),
    evidence: [{ reason: producer ? 'same-row flag producer operands' : 'NZCV comparison' }],
  });""",
)

replace_once(
    "js/decompiler/switch.js",
    "return { value: c.value, address, label: labelForAddress(address) };",
    "return { value: c.value, address, label: labelForAddress(address), bits: c.bits ?? c.width ?? null, signed: c.signed ?? null };",
)

replace_once(
    "js/decompiler/switch.js",
    """function caseLiteral(v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && /^-?(?:0x[0-9a-f]+|\\d+)$/i.test(v.trim())) return v.trim();
  return null;
}""",
    """function canonicalCaseValue(v, sw = {}, c = {}) {
  let raw;
  try {
    if (typeof v === 'bigint') raw = v;
    else if (typeof v === 'number' && Number.isSafeInteger(v)) raw = BigInt(v);
    else if (typeof v === 'string' && /^-?(?:0x[0-9a-f]+|\\d+)$/i.test(v.trim())) raw = BigInt(v.trim());
    else return null;
  } catch { return null; }
  const requestedBits = c.bits ?? c.width ?? sw.bits ?? sw.width ?? sw.valueBits ?? null;
  const numericBits = Number(requestedBits);
  const bits = Number.isInteger(numericBits) && numericBits > 0 && numericBits <= 128 ? numericBits : null;
  const signed = c.signed ?? sw.signed ?? null;
  const canonicalBits = bits ? BigInt.asUintN(bits, raw) : raw;
  const literal = bits
    ? (signed === true ? BigInt.asIntN(bits, raw) : BigInt.asUintN(bits, raw)).toString()
    : raw.toString();
  return { key:`${bits || 'integer'}:${canonicalBits}`, literal, bits, signed };
}""",
)

replace_once(
    "js/decompiler/switch.js",
    """    const values = cases.map((c) => caseLiteral(c.value));
    if (values.some((v) => v == null) || new Set(values).size !== values.length) continue;""",
    """    const normalizedValues = cases.map((c) => canonicalCaseValue(c.value, sw, c));
    if (normalizedValues.some((v) => v == null)) continue;
    const seenValues = new Map();
    let duplicate = null;
    for (let i = 0; i < normalizedValues.length; i++) {
      const key = normalizedValues[i].key;
      if (seenValues.has(key)) { duplicate = { first:seenValues.get(key), second:i, key }; break; }
      seenValues.set(key, i);
    }
    if (duplicate) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} descriptor conflict: duplicate case values after integer canonicalization (${duplicate.key}).`];
      result.evidence = [...(result.evidence || []), {
        row:sw.row, address:sw.address ?? null, op:'switch-conflict',
        reason:'duplicate case values after width-aware integer canonicalization',
        cases:cases.map((c, i) => ({ value:normalizedValues[i].literal, target:c.address })),
      }];
      continue;
    }
    const values = normalizedValues.map((v) => v.literal);""",
)

# AL/NV are not part of the flag-tested reconstruction contract here; keep the
# existing semantic decompiler fallback for those encodings.
replace_once(
    "js/decompiler/flag-semantics.js",
    "  'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv',",
    "  'hi', 'ls', 'ge', 'lt', 'gt', 'le',",
)
replace_once(
    "js/decompiler/flag-semantics.js",
    "    case 'al': return true;\n    case 'nv': return false;\n",
    "",
)
replace_once(
    "js/decompiler/flag-semantics.js",
    "  if (cond === 'al') return expr.constant(1n, 1, false, source);\n  if (cond === 'nv') return expr.constant(0n, 1, false, source);\n",
    "",
)
