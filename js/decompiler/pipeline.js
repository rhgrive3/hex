import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackReturn } from './passes/stack-return-recovery.js';
import { expr } from './ast/nodes.js';

export { buildExpressionForTesting } from './pipeline-core.js';

function valueOf(arg) { return arg?.value || null; }

/*
 * Memory-SSA can prove that a load reads an earlier store and pipeline-core can
 * therefore replace the load with the stored expression. That proof is about
 * memory identity, not register width. In particular, `str w0` / `ldr w8`
 * round-trips only 32 bits even when the stored source originated as AAPCS64 x0.
 * Re-attach the SSA value width before later signed comparisons/bit tests.
 */
function constrainSemanticValueWidths(result) {
  if (!result?.semanticAst?.values || !result?.ir?.values) return result;
  const irValues = new Map((result.ir.values || []).map((value) => [value.id, value]));
  for (const item of result.semanticAst.values) {
    const value = irValues.get(item.valueId);
    const node = item.expression;
    const targetBits = Number(value?.bits || 0);
    const sourceBits = Number(node?.bits || 0);
    if (!node || !targetBits || !sourceBits || sourceBits <= targetBits) continue;
    item.expression = expr.unary(
      'trunc',
      node,
      targetBits,
      value?.signed ?? node.signed ?? null,
      node.source,
      { fromBits: sourceBits, proof: 'SSA value width after Memory-SSA substitution' },
    );
  }
  return result;
}

function latestReturnStackLoad(ir, ret) {
  const explicit = valueOf(ret?.args?.[0]);
  if (explicit?.def?.op === 'load' && explicit.def.loc?.kind === 'stack') return { value: explicit, load: explicit.def };

  let best = null;
  for (const inst of ir?.instructions || []) {
    if (inst?.op !== 'load' || inst?.loc?.kind !== 'stack' || inst?.dst?.reg !== 'x0') continue;
    if (ret?.row != null && inst.row >= ret.row) continue;
    if (!best || (inst.row ?? -1) > (best.load.row ?? -1)) best = { value: inst.dst, load: inst };
  }
  if (best) return best;

  let value = null;
  let bestRow = -Infinity;
  for (const candidate of ir?.values || []) {
    const def = candidate?.def;
    if (candidate?.reg !== 'x0' || !def) continue;
    if (ret?.row != null && def.row >= ret.row) continue;
    if (def.row > bestRow) { value = candidate; bestRow = def.row; }
  }
  return value?.def?.op === 'load' && value.def.loc?.kind === 'stack' ? { value, load:value.def } : null;
}

function reanchorExactStackReturn(result) {
  if (!result?.semanticAst || !result?.ir) return result;
  const ret = [...(result.ir.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  const found = ret ? latestReturnStackLoad(result.ir, ret) : null;
  if (!found?.load?.loc?.key) return result;

  const output = result.semanticAst.outputs?.find((x) => x.name === 'return');
  if (!output) return result;
  const { value, load } = found;
  output.expression = expr.load({
    kind:'stack',
    key:load.loc.key,
    name:load.loc.name || `stack_${load.loc.key}`,
    text:load.loc.name || `stack_${load.loc.key}`,
  }, value?.bits || Number((load.size || 8) * 8), {
    address:load.address,
    row:load.row,
    ir:load.id,
    ssaDef:value?.id ?? null,
    evidence:[{ reason:'SSA return stack load re-anchor' }],
  }, { signed:load.signed ?? value?.signed ?? null });
  return result;
}

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  const core = constrainSemanticValueWidths(enhanceCore(result, model, opts));
  return recoverExactStackReturn(reanchorExactStackReturn(core), opts);
}
