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
    if (lhs != null && rhs != null) {
      const width = BigInt(bits);
      const amount = BigInt(rhs);
      if (amount >= 0n && amount < width) {
        const v = BigInt.asUintN(bits, lhs);
        if (def.sub === 'shl' || def.sub === 'lsl') result = BigInt.asUintN(bits, v << amount);
        else if (def.sub === 'lshr' || def.sub === 'lsr') result = v >> amount;
        else if (def.sub === 'ashr' || def.sub === 'asr') result = BigInt.asUintN(bits, BigInt.asIntN(bits, v) >> amount);
        else if (amount === 0n) result = v;
        else result = BigInt.asUintN(bits, (v >> amount) | (v << (width - amount)));
      }
    }
  }
  active.delete(value);
  return result;
}

function shiftedConstant(arg, fallbackBits = null) {
  if (!arg || !arg.value) return null;
  const bits = Math.max(1, Math.min(64, Number(fallbackBits || arg.value.bits || 64)));
  const width = BigInt(bits);
  const exact = projectedConstant(arg.value);
  if (exact == null) return null;
  let value = BigInt.asUintN(bits, exact);
  const shift = arg.shift;
  if (!shift) return value;
  const amount = BigInt(shift.amount || 0);
  if (amount < 0n || amount >= width) return null;
  if (shift.op === 'lsl') return BigInt.asUintN(bits, value << amount);
  if (shift.op === 'lsr') return value >> amount;
  if (shift.op === 'asr') return BigInt.asUintN(bits, BigInt.asIntN(bits, value) >> amount);
  if (shift.op === 'ror') {
    if (amount === 0n) return value;
    return BigInt.asUintN(bits, (value >> amount) | (value << (width - amount)));
  }
  return null;
}

function comparisonOfBranch(branch) {
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
  // Semantic-v2 compatibility can expose a 64-bit physical register view while
  // the machine comparison itself is width-exact W32. MachineEffects metadata
  // is the authoritative machine-width evidence; projected compatibility width
  // can be widened by a later physical-state view and is only a fallback.
  const semanticBits = Number(
    cmp.extra?.attributes?.machineEffects?.operationMetadata?.widthBits
      ?? cmp.extra?.attributes?.machineEffects?.bundleMetadata?.widthBits
      ?? cmp.extra?.widthBits
      ?? 0,
  );
  const bits = (semanticBits === 32 || semanticBits === 64)
    ? semanticBits
    : (cmp.bits || cmp.args[0].bits || cmp.args[0].value.bits || 64);
  const rhs = shiftedConstant(cmp.args[1], bits);
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
  const existing = value?.range ?? null;
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
  void ir;
  const comparison = comparisonOfBranch(branch);
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
  if (ir._branchConstraints) return ir._branchConstraints;
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