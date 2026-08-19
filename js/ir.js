export * from './ir-base.js';

import { OP, COND } from './ir-core.js';
import { normalizeIntegerValue, normalizeRangeDomain } from './range-domain.js';
import { valueRange } from './ir-base.js';

function projectedConstant(value, active = new Set()) {
  if (!value || active.has(value)) return null;
  const bits = Math.max(1, Math.min(64, Number(value.bits || 64)));
  if (value.const != null) return BigInt.asUintN(bits, BigInt(value.const));
  const def = value.def;
  if (!def || !Array.isArray(def.args)) return null;
  active.add(value);
  const input = (index) => projectedConstant(def.args[index]?.value, active);
  let result = null;
  if (def.op === OP.MOV && def.args.length === 1) {
    const v = input(0);
    if (v != null) result = BigInt.asUintN(bits, v);
  } else if (def.op === OP.UN && (def.sub === 'sext' || def.extra?.castKind === 'sext') && def.args.length === 1) {
    const v = input(0);
    const sourceBits = Math.max(1, Math.min(64, Number(def.extra?.sourceBits || def.args[0]?.bits || def.args[0]?.value?.bits || bits)));
    if (v != null) result = BigInt.asUintN(bits, BigInt.asIntN(sourceBits, v));
  } else if (def.op === OP.BIN && ['shl','lsl','lshr','lsr','ashr','asr','ror'].includes(def.sub) && def.args.length >= 2) {
    const lhs = input(0);
    const rhs = input(1);
    if (lhs != null && rhs != null) result = applyProjectedShift(def.sub, lhs, rhs, bits);
  }
  active.delete(value);
  return result;
}

function applyProjectedShift(op, rawValue, rawAmount, bits) {
  const widthBits = Math.max(1, Math.min(64, Number(bits || 64)));
  const width = BigInt(widthBits);
  const amount = BigInt(rawAmount);
  if (amount < 0n || amount >= width) return null;
  const value = BigInt.asUintN(widthBits, BigInt(rawValue));
  if (op === 'shl' || op === 'lsl') return BigInt.asUintN(widthBits, value << amount);
  if (op === 'lshr' || op === 'lsr') return value >> amount;
  if (op === 'ashr' || op === 'asr') return BigInt.asUintN(widthBits, BigInt.asIntN(widthBits, value) >> amount);
  if (op === 'ror') {
    if (amount === 0n) return value;
    return BigInt.asUintN(widthBits, (value >> amount) | (value << (width - amount)));
  }
  return null;
}

function shiftedConstant(arg, fallbackBits = null) {
  if (!arg || !arg.value) return null;
  const bits = Math.max(1, Math.min(64, Number(fallbackBits || arg.value.bits || 64)));
  const exact = projectedConstant(arg.value);
  if (exact == null) return null;
  const shift = arg.shift;
  if (!shift) return BigInt.asUintN(bits, exact);
  return applyProjectedShift(shift.op, exact, shift.amount || 0, bits);
}

function sameSourceInstruction(left, right) {
  const a = new Set((left?.sourceInstructionIds || []).map(String));
  const b = (right?.sourceInstructionIds || []).map(String);
  if (a.size && b.length) return b.some((id) => a.has(id));
  return left?.row != null && right?.row != null && left.row === right.row;
}

function projectedShiftOperand(ir, cmp, bits) {
  const shifts = new Set(['shl','lsl','lshr','lsr','ashr','asr','ror']);
  const candidates = (ir?.instructions || []).filter((candidate) =>
    candidate !== cmp
    && candidate.op === OP.CMP
    && shifts.has(candidate.sub)
    && sameSourceInstruction(candidate, cmp)
    && candidate.args?.length >= 2);
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  const value = projectedConstant(candidate.args[0]?.value);
  const amount = projectedConstant(candidate.args[1]?.value);
  if (value == null || amount == null) return null;
  return applyProjectedShift(candidate.sub, value, amount, bits);
}

function comparisonOfBranch(ir, branch) {
  if (!branch || branch.op !== OP.CBR) return null;
  const kind = branch.extra?.kind;
  if ((kind === 'cbz' || kind === 'cbnz') && branch.args?.[0]?.value) {
    return {
      lhs:branch.args[0].value,
      rhs:0n,
      cond:kind === 'cbz' ? 'eq' : 'ne',
      cmp:null,
      bits:branch.args[0].bits || branch.args[0].value.bits || 64,
    };
  }
  const flags = branch.args?.[0]?.value;
  const cmp = flags?.def?.op === OP.CMP ? flags.def : null;
  if (!cmp?.args?.[0]?.value || !cmp.args?.[1]?.value) return null;
  const bits = cmp.args[0].bits || cmp.extra?.bits || cmp.args[0].value.bits || 64;
  let rhs = shiftedConstant(cmp.args[1], bits);
  if (rhs == null) rhs = projectedShiftOperand(ir, cmp, bits);
  if (rhs == null) return null;
  return { lhs:cmp.args[0].value, rhs, cond:branch.cond || null, cmp, bits };
}

function invertRel(op) {
  return ({ '==':'!=', '!=':'==', '<':'>=', '<=':'>', '>':'<=', '>=':'<' })[op] || null;
}

function typeBounds(bits, signed) {
  const n = BigInt(Math.max(1, Math.min(64, bits || 64)));
  if (signed === true) return { min:-(1n << (n - 1n)), max:(1n << (n - 1n)) - 1n };
  return { min:0n, max:(1n << n) - 1n };
}

function constrainedRange(value, op, constant, signed, compareBits = null) {
  const bits = compareBits || value?.bits || 64;
  const rhs = normalizeIntegerValue(constant, bits, signed);
  const bounds = typeBounds(bits, signed);
  let min = bounds.min;
  let max = bounds.max;
  if (op === '==') min = max = rhs;
  else if (op === '<') max = rhs - 1n;
  else if (op === '<=') max = rhs;
  else if (op === '>') min = rhs + 1n;
  else if (op === '>=') min = rhs;
  else return null;
  const existing = valueRange(value);
  const comparableExisting = existing
    ? normalizeRangeDomain(existing, bits, signed)
    : null;
  if (comparableExisting) {
    if (comparableExisting.min > min) min = comparableExisting.min;
    if (comparableExisting.max < max) max = comparableExisting.max;
  }
  if (min > max) return { min, max, impossible:true };
  return { min, max };
}

function zeroFactOnEdge(op, constant) {
  if (constant !== 0n) return 'unknown';
  if (op === '==') return 'zero';
  if (op === '!=' || op === '>') return 'non-zero';
  return 'unknown';
}

function nullabilityFromZero(zero) {
  if (zero === 'zero') return 'null';
  if (zero === 'non-zero') return 'non-null';
  return 'unknown';
}

export function rangeOnBranch(ir, branch, taken = true) {
  const comparison = comparisonOfBranch(ir, branch);
  if (!comparison?.cond) return null;
  const info = comparison.cond === 'eq' || comparison.cond === 'ne'
    ? { op:comparison.cond === 'eq' ? '==' : '!=', signed:null }
    : COND[comparison.cond];
  if (!info?.op) return null;
  const relation = taken ? info.op : invertRel(info.op);
  const signedForBounds = info.signed == null ? comparison.lhs.signed === true : info.signed;
  const signedness = info.signed === true ? 'signed'
    : info.signed === false ? 'unsigned'
      : comparison.lhs.signed === true ? 'signed'
        : comparison.lhs.signed === false ? 'unsigned' : 'unknown';
  const compareBits = comparison.bits || comparison.lhs.bits || 64;
  const rhs = normalizeIntegerValue(comparison.rhs, compareBits, signedForBounds);
  const range = constrainedRange(comparison.lhs, relation, rhs, signedForBounds, compareBits);
  const zero = zeroFactOnEdge(relation, rhs);
  return {
    value:comparison.lhs,
    condition:relation,
    constant:rhs,
    signedness,
    range,
    zero,
    nullability:nullabilityFromZero(zero),
    taken:!!taken,
    branch,
    compare:comparison.cmp,
  };
}

export function branchConstraints(ir) {
  if (!ir) return [];
  const out = [];
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.CBR) continue;
    const yes = rangeOnBranch(ir, inst, true);
    const no = rangeOnBranch(ir, inst, false);
    if (yes || no) out.push({ branch:inst, taken:yes, fallthrough:no });
  }
  ir._branchConstraints = out;
  return out;
}
