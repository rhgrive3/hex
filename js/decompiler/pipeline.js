import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackPhiExpressions } from './passes/stack-phi-recovery.js';
import { expr } from './ast/nodes.js';

export { buildExpressionForTesting } from './pipeline-core.js';

function valueOf(arg) { return arg?.value || null; }

function latestReturnStackLoad(ir, ret) {
  const explicit = valueOf(ret?.args?.[0]);
  if (explicit?.def?.op === 'load' && explicit.def.loc?.kind === 'stack') {
    return { value: explicit, load: explicit.def };
  }

  // Scan IR instructions directly rather than relying on a value's clobber flag:
  // the final w0/x0 load can legitimately be marked clobbered by later ABI state
  // bookkeeping even though it is exactly the value consumed by RET.
  let best = null;
  for (const inst of ir?.instructions || []) {
    if (inst?.op !== 'load' || inst?.loc?.kind !== 'stack' || inst?.dst?.reg !== 'x0') continue;
    if (ret?.row != null && inst.row >= ret.row) continue;
    if (!best || (inst.row ?? -1) > (best.load.row ?? -1)) best = { value: inst.dst, load: inst };
  }
  if (best) return best;

  // Last conservative fallback: follow the latest x0 SSA definition before RET.
  let value = null;
  let bestRow = -Infinity;
  for (const candidate of ir?.values || []) {
    const def = candidate?.def;
    if (candidate?.reg !== 'x0' || !def) continue;
    if (ret?.row != null && def.row >= ret.row) continue;
    if (def.row > bestRow) { value = candidate; bestRow = def.row; }
  }
  return value?.def?.op === 'load' && value.def.loc?.kind === 'stack' ? { value, load: value.def } : null;
}

function reanchorExactStackReturn(result) {
  if (!result?.semanticAst || !result?.ir) return result;
  const ret = [...(result.ir.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  if (!ret) return result;
  const found = latestReturnStackLoad(result.ir, ret);
  if (!found) return result;
  const { value, load } = found;
  if (!load.loc?.key) return result;
  const output = result.semanticAst.outputs?.find((x) => x.name === 'return');
  if (!output) return result;

  output.expression = expr.load({
    kind: 'stack',
    key: load.loc.key,
    name: load.loc.name || `stack_${load.loc.key}`,
    text: load.loc.name || `stack_${load.loc.key}`,
  }, value?.bits || Number((load.size || 8) * 8), {
    address: load.address,
    row: load.row,
    ir: load.id,
    ssaDef: value?.id ?? null,
    evidence: [{ reason: 'SSA return stack load re-anchor' }],
  }, { signed: load.signed ?? value?.signed ?? null });
  return result;
}

/**
 * Public semantic-decompiler pipeline. The core builds typed/re-written ASTs;
 * this final exact-stack pass repairs source variables that Clang -O0 spills
 * through multiple CFG arms when Memory-SSA phi incoming lists are incomplete.
 */
export function enhanceSemanticDecompilation(result, model, opts = {}) {
  const core = enhanceCore(result, model, opts);
  return recoverExactStackPhiExpressions(reanchorExactStackReturn(core), opts);
}
