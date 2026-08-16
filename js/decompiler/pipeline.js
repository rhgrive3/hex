import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackReturn } from './passes/stack-return-recovery.js';
import { expr, mergeSource, sourceOf } from './ast/nodes.js';
import { printProgram } from './pretty/c.js';

export { buildExpressionForTesting } from './pipeline-core.js';

function valueOf(arg) { return arg?.value || null; }

const INVERSE_CONDITION = {
  eq:'ne', ne:'eq', hs:'lo', lo:'hs', cs:'cc', cc:'cs',
  hi:'ls', ls:'hi', ge:'lt', lt:'ge', gt:'le', le:'gt',
  mi:'pl', pl:'mi', vs:'vc', vc:'vs',
};

function isZeroValue(value) {
  return value?.const === 0n || (value?.def?.op === 'const' && (value.def.extra?.value ?? value.const) === 0n);
}

/* pipeline-core expresses ordinary CMP relations but intentionally leaves raw
 * N-flag conditions conservative. For the extremely common `cmp value,#0`, MI
 * and PL are exactly signed `< 0` and `>= 0`, so normalize them to the relational
 * conditions the semantic AST already models. */
function relationalSignCondition(inst, cond) {
  if (cond !== 'mi' && cond !== 'pl') return cond;
  const flags = valueOf(inst?.args?.[2] || inst?.args?.at?.(-1));
  const compare = flags?.def;
  if (compare?.op !== 'cmp' || compare?.sub !== 'sub' || !isZeroValue(valueOf(compare.args?.[1]))) return cond;
  return cond === 'mi' ? 'lt' : 'ge';
}

/* CNEG/CINC/CINV are aliases of CSNEG/CSINC/CSINV with the condition inverted. */
function normalizeConditionalSelectAliases(ir) {
  const changes = [];
  const alias = { cneg:'neg', cinc:'inc', cinv:'inv' };
  for (const inst of ir?.instructions || []) {
    const replacement = alias[inst?.sub];
    if (replacement) {
      let inverse = INVERSE_CONDITION[inst.cond];
      if (!inverse) continue;
      inverse = relationalSignCondition(inst, inverse);
      changes.push({ inst, sub:inst.sub, cond:inst.cond });
      inst.sub = replacement;
      inst.cond = inverse;
      continue;
    }
    const relational = relationalSignCondition(inst, inst?.cond);
    if (relational !== inst?.cond) {
      changes.push({ inst, sub:inst.sub, cond:inst.cond });
      inst.cond = relational;
    }
  }
  return () => {
    for (let i = changes.length - 1; i >= 0; i--) {
      const { inst, sub, cond } = changes[i];
      inst.sub = sub;
      inst.cond = cond;
    }
  };
}

function constrainSemanticValueWidths(result) {
  if (!result?.semanticAst?.values || !result?.ir?.values) return result;
  const irValues = new Map((result.ir.values || []).map((value) => [value.id, value]));
  for (const item of result.semanticAst.values) {
    const value = irValues.get(item.valueId);
    const node = item.expression;
    const targetBits = Number(value?.bits || 0);
    const sourceBits = Number(node?.bits || 0);
    if (!node || !targetBits || !sourceBits || sourceBits <= targetBits) continue;
    item.expression = expr.unary('trunc', node, targetBits, value?.signed ?? node.signed ?? null, node.source,
      { fromBits: sourceBits, proof: 'SSA value width after Memory-SSA substitution' });
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
  let value = null, bestRow = -Infinity;
  for (const candidate of ir?.values || []) {
    const def = candidate?.def;
    if (candidate?.reg !== 'x0' || !def || (ret?.row != null && def.row >= ret.row)) continue;
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
  output.expression = expr.load({ kind:'stack', key:load.loc.key, name:load.loc.name || `stack_${load.loc.key}`, text:load.loc.name || `stack_${load.loc.key}` },
    value?.bits || Number((load.size || 8) * 8), {
      address:load.address, row:load.row, ir:load.id, ssaDef:value?.id ?? null,
      evidence:[{ reason:'SSA return stack load re-anchor' }],
    }, { signed:load.signed ?? value?.signed ?? null });
  return result;
}

/* Exact stack-return recovery deliberately replaces a compiler spill with the
 * committed high-level lvalue. Keep the semantic expression's deep proof, but
 * source-map the emitted `return` statement to the machine LOAD that materialized
 * the return value plus RET. The eliminated spill STORE is proof provenance, not
 * source ownership of the reconstructed C statement. */
function reanchorRecoveredReturnSource(result, opts = {}) {
  if (!result?.ctx?.decompilerPipeline?.exactStackReturnRecovered || !result?.ir || !result?.cAst) return result;
  const ret = [...(result.ir.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  if (!ret) return result;
  let changed = false;
  for (const node of result.cAst.body || []) {
    if (!(node.semantic?.op === 'return' || /^return\b/.test(String(node.text || '').trim()))) continue;
    const addresses = new Set((node.source?.addresses || []).map((address) => String(address)));
    let load = null;
    for (const inst of result.ir.instructions || []) {
      if (inst?.op !== 'load' || inst?.loc?.kind !== 'stack' || inst?.row == null || ret.row == null || inst.row >= ret.row) continue;
      if (!addresses.has(String(inst.address))) continue;
      if (!load || inst.row > load.row) load = inst;
    }
    if (!load) continue;
    node.source = mergeSource(
      sourceOf({ address:load.address, row:load.row, ir:load.id, ssaDef:load.dst?.id ?? null,
        evidence:[{ reason:'exact recovered return load' }] }),
      sourceOf({ address:ret.address, row:ret.row, ir:ret.id,
        evidence:[{ reason:'return transfer' }] }),
    );
    changed = true;
  }
  if (!changed) return result;
  const printed = printProgram(result.cAst, { columnWidth:opts.columnWidth || opts.prettyColumnWidth || 88 });
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  result.metrics = { ...(result.metrics || {}), sourceMappedNodes:result.sourceMap?.length || 0 };
  return result;
}

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  const restore = normalizeConditionalSelectAliases(result?.ir);
  let core;
  try { core = constrainSemanticValueWidths(enhanceCore(result, model, opts)); }
  finally { restore(); }
  const recovered = recoverExactStackReturn(reanchorExactStackReturn(core), opts);
  return reanchorRecoveredReturnSource(recovered, opts);
}
