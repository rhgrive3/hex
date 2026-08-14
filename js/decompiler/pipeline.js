import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackPhiExpressions } from './passes/stack-phi-recovery.js';
import { expr } from './ast/nodes.js';

export { buildExpressionForTesting } from './pipeline-core.js';

function valueOf(arg) { return arg?.value || null; }
const truthNames = new Set(['max_i32','min_i32','clamp0_i32','extract8','muladd_i32','bool_i32']);

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
  return value?.def?.op === 'load' && value.def.loc?.kind === 'stack' ? { value, load: value.def } : null;
}

function reanchorExactStackReturn(result, opts) {
  if (!result?.semanticAst || !result?.ir) return result;
  const ret = [...(result.ir.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  const found = ret ? latestReturnStackLoad(result.ir, ret) : null;
  if (truthNames.has(String(opts?.name || ''))) {
    const loads = (result.ir.instructions || []).filter((i) => i.op === 'load').map((i) => ({ row:i.row, block:i.block, reg:i.dst?.reg, locKind:i.loc?.kind, locKey:i.loc?.key }));
    console.log('COMPILER_TRUTH_STACK_DEBUG ' + JSON.stringify({ name:opts.name, ret:ret ? {row:ret.row,block:ret.block,args:(ret.args||[]).map((a)=>valueOf(a)?.id ?? null)} : null, found:found ? {row:found.load.row,block:found.load.block,reg:found.value?.reg,key:found.load.loc?.key} : null, loads, before:result.semanticAst.outputs?.find((x)=>x.name==='return')?.expression?.kind || null }));
  }
  if (!found) return result;
  const { value, load } = found;
  if (!load.loc?.key) return result;
  const output = result.semanticAst.outputs?.find((x) => x.name === 'return');
  if (!output) return result;
  output.expression = expr.load({ kind:'stack', key:load.loc.key, name:load.loc.name || `stack_${load.loc.key}`, text:load.loc.name || `stack_${load.loc.key}` }, value?.bits || Number((load.size || 8) * 8), { address:load.address, row:load.row, ir:load.id, ssaDef:value?.id ?? null, evidence:[{ reason:'SSA return stack load re-anchor' }] }, { signed:load.signed ?? value?.signed ?? null });
  return result;
}

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  const core = enhanceCore(result, model, opts);
  const anchored = reanchorExactStackReturn(core, opts);
  const final = recoverExactStackPhiExpressions(anchored, opts);
  if (truthNames.has(String(opts?.name || ''))) console.log('COMPILER_TRUTH_STACK_DEBUG_AFTER ' + JSON.stringify({ name:opts.name, after:final.semanticAst?.outputs?.find((x)=>x.name==='return')?.expression?.kind || null, recovered:!!final.ctx?.decompilerPipeline?.exactStackPhiRecovered, text:final.pseudocode }));
  return final;
}
