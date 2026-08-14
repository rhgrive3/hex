/*
 * SSA-backed constant-comparison recovery for the stable dataflow API.
 *
 * The legacy scanner only sees literals written directly in `cmp ..., #N`.
 * SSA also proves cases such as `mov w9, #100 ; cmp w8, w9`, which matter for
 * cap/threshold detection in pinpoint and role inference.
 */

import { irFor, OP } from './ir.js';

function sourceMnemonic(model, row) {
  const insn = (model && model.instructions || []).find((i) => i.row === row);
  return insn && insn.mnemonic ? String(insn.mnemonic).toLowerCase() : 'cmp';
}

function originalHasImmediate(model, row) {
  const insn = (model && model.instructions || []).find((i) => i.row === row);
  return !!(insn && (insn.ops || []).some((o) => o && o.k === 'imm' && (o.value != null || o.float != null)));
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

  const out = [];
  for (const inst of ir.instructions || []) {
    if (inst.op !== OP.CMP) continue;
    const pair = (inst.args || []).slice(0, 2).filter((a) => a && a.value);
    if (pair.length !== 2) continue;

    const constants = pair.filter((a) => a.value.const != null);
    const variables = pair.filter((a) => a.value.const == null);
    if (constants.length !== 1 || variables.length !== 1) continue;

    const c = constants[0].value.const;
    const v = variables[0].value;
    if (c == null) continue;
    out.push({
      row: inst.row,
      address: inst.address,
      register: v.reg || null,
      value: c,
      float: null,
      mnemonic: sourceMnemonic(model, inst.row),
      engine: 'ir-ssa',
      propagated: !originalHasImmediate(model, inst.row),
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
