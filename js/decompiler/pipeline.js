import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackPhiExpressions } from './passes/stack-phi-recovery.js';
import { expr } from './ast/nodes.js';

export { buildExpressionForTesting } from './pipeline-core.js';

function valueOf(arg) { return arg?.value || null; }

function latestReturnValue(ir, ret) {
  const explicit = valueOf(ret?.args?.[0]);
  if (explicit) return explicit;
  let best = null;
  let bestRow = -Infinity;
  for (const value of ir?.values || []) {
    const def = value?.def;
    if (value?.reg !== 'x0' || !def || value.clobbered) continue;
    if (def.block === ret.block && def.row < ret.row && def.row > bestRow) {
      best = value;
      bestRow = def.row;
    }
  }
  return best;
}

function reanchorExactStackReturn(result) {
  if (!result?.semanticAst || !result?.ir) return result;
  const ret = [...(result.ir.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  if (!ret) return result;
  const value = latestReturnValue(result.ir, ret);
  const load = value?.def;
  if (load?.op !== 'load' || load.loc?.kind !== 'stack' || !load.loc?.key) return result;
  const output = result.semanticAst.outputs?.find((x) => x.name === 'return');
  if (!output) return result;

  // pipeline-core may already have folded an incomplete Memory-SSA phi into a
  // select. Re-anchor to the concrete SSA return load so the exact-stack pass
  // can reconstruct the two incoming stores from CFG evidence instead of
  // trusting that premature arm ordering.
  output.expression = expr.load({
    kind: 'stack',
    key: load.loc.key,
    name: load.loc.name || `stack_${load.loc.key}`,
    text: load.loc.name || `stack_${load.loc.key}`,
  }, value.bits || Number((load.size || 8) * 8), {
    address: load.address,
    row: load.row,
    ir: load.id,
    ssaDef: value.id,
    evidence: [{ reason: 'SSA return stack load re-anchor' }],
  }, { signed: load.signed ?? value.signed ?? null });
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
