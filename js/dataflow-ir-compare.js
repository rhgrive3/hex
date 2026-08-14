/*
 * SSA-backed constant-comparison recovery for the stable dataflow API.
 *
 * The legacy scanner only sees literals written directly in `cmp ..., #N`.
 * SSA also proves cases such as `mov w9, #100 ; cmp w8, w9`, which matter for
 * cap/threshold detection in pinpoint and role inference.
 */

import { irFor, OP } from './ir.js';

function sourceMnemonic(sourceByRow, row) {
  const insn = sourceByRow.get(row);
  return insn && insn.mnemonic ? String(insn.mnemonic).toLowerCase() : 'cmp';
}

function originalHasImmediate(sourceByRow, row) {
  const insn = sourceByRow.get(row);
  return !!(insn && (insn.ops || []).some((o) => o && o.k === 'imm' && (o.value != null || o.float != null)));
}

function mask(v, bits) {
  if (v == null) return null;
  return BigInt.asUintN(bits || 64, BigInt(v));
}

/**
 * Local, proof-only constant evaluator.
 * ir-core already propagates most arithmetic. The notable gap is MOVK/BFI, the
 * normal ARM64 way to assemble constants larger than 16 bits. We evaluate that
 * SSA expression here rather than guessing from the last MOVK fragment.
 */
function provenConstant(value, memo, active = new Set()) {
  if (!value) return null;
  if (value.const != null) return value.const;
  if (memo.has(value.id)) return memo.get(value.id);
  if (active.has(value.id)) return null;
  active.add(value.id);

  let result = null;
  const def = value.def;
  if (def && def.op === OP.MOV && def.args && def.args[0]) {
    result = provenConstant(def.args[0].value, memo, active);
  } else if (def && def.op === OP.PHI && def.args && def.args.length) {
    const vals = def.args.map((a) => provenConstant(a && a.value, memo, active));
    if (vals.length && vals.every((v) => v != null && v === vals[0])) result = vals[0];
  } else if (def && def.op === OP.BFI && def.args && def.args.length >= 2) {
    const old = provenConstant(def.args[0].value, memo, active);
    const inserted = provenConstant(def.args[1].value, memo, active);
    const lsb = def.extra && Number.isInteger(def.extra.lsb) ? def.extra.lsb : null;
    const width = def.extra && Number.isInteger(def.extra.width) ? def.extra.width : null;
    if (old != null && inserted != null && lsb != null && width != null && width > 0 && width <= 64 && lsb >= 0 && lsb + width <= 64) {
      const fieldMask = ((1n << BigInt(width)) - 1n) << BigInt(lsb);
      const piece = (inserted & ((1n << BigInt(width)) - 1n)) << BigInt(lsb);
      result = mask((old & ~fieldMask) | piece, value.bits || 64);
    }
  } else if (def && def.op === OP.BFX && def.args && def.args[0]) {
    const src = provenConstant(def.args[0].value, memo, active);
    const lsb = def.extra && Number.isInteger(def.extra.lsb) ? def.extra.lsb : null;
    const width = def.extra && Number.isInteger(def.extra.width) ? def.extra.width : null;
    if (src != null && lsb != null && width != null && width > 0 && width <= 64) {
      const low = (src >> BigInt(lsb)) & ((1n << BigInt(width)) - 1n);
      result = mask(low, value.bits || 64);
    }
  }

  active.delete(value.id);
  memo.set(value.id, result);
  return result;
}

/**
 * Return integer thresholds that SSA can prove at compare sites.
 * We deliberately require exactly one constant and one non-constant operand in
 * the comparison pair. Two constants are compiler-folding noise; zero constants
 * means there is no threshold we can state.
 */
export function findIrConstantComparisons(model, opts) {
  if (!model || !model.instructions || !model.instructions.length) return [];
  const ir = irFor(model, opts && opts.ir);
  if (!ir) return [];

  // Large game functions can contain thousands of comparisons. Row lookup used
  // to scan model.instructions for every comparison, making this path O(n²).
  const sourceByRow = new Map(model.instructions.map((i) => [i.row, i]));
  const constMemo = new Map();
  const out = [];
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.CMP) continue;
    const pair = (inst.args || []).slice(0, 2).filter((a) => a && a.value);
    if (pair.length !== 2) continue;

    const evaluated = pair.map((a) => ({ arg: a, constant: provenConstant(a.value, constMemo) }));
    const constants = evaluated.filter((x) => x.constant != null);
    const variables = evaluated.filter((x) => x.constant == null);
    if (constants.length !== 1 || variables.length !== 1) continue;

    const c = constants[0].constant;
    const v = variables[0].arg.value;
    out.push({
      row: inst.row,
      address: inst.address,
      register: v.reg || null,
      value: c,
      float: null,
      mnemonic: sourceMnemonic(sourceByRow, inst.row),
      engine: 'ir-ssa',
      propagated: !originalHasImmediate(sourceByRow, inst.row),
    });
  }
  return out;
}

export function mergeConstantComparisons(legacy, proven) {
  const out = (legacy || []).slice();
  const at = new Map(out.map((c, i) => [c.row, i]));
  for (const ir of proven || []) {
    const pos = at.get(ir.row);
    if (pos == null) {
      at.set(ir.row, out.length);
      out.push(ir);
      continue;
    }
    // Same machine comparison: enrich, never duplicate it as independent proof.
    out[pos] = { ...out[pos], ...ir, legacy: true };
  }
  out.sort((a, b) => a.row - b.row);
  return out;
}
