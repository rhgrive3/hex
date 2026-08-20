import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackReturn } from './passes/stack-return-recovery.js';
import { expr, sourceOf } from './ast/nodes.js';
import { printProgram } from './pretty/c.js';
import { PASS_STAGES as PHASE8_ALL_STAGES, runPhase8Stage } from './phase8/index.js';
import { applyPhase8Projection } from './phase8/projection.js';

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

  // For implicit ABI returns, only the actual latest reaching definition of x0
  // may authorize a stack-load re-anchor. A historical stack load is not return
  // truth when a later ADD/SUB/call/etc. redefines x0 (#914).
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

/* When a return stack LOAD has a proven same-slot reaching STORE, the spill
 * STORE remains proof provenance but does not own the reconstructed C return
 * statement after the stack temporary has been eliminated. Drop only that one
 * statement-level source row; every other source/proof entry is preserved. */
function reanchorRecoveredReturnSource(result, opts = {}) {
  if (!result?.ir || !result?.cAst) return result;
  const ret = [...(result.ir.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  if (!ret) return result;
  let changed = false;
  for (const node of result.cAst.body || []) {
    if (!(node.semantic?.op === 'return' || /^return\b/.test(String(node.text || '').trim()))) continue;
    if (/\blocal_[0-9A-F]+\b/i.test(String(node.text || ''))) continue;
    const current = sourceOf(node.source);
    const sourceRows = new Set((current.rows || []).map((row) => String(row)));
    let load = null;
    for (const inst of result.ir.instructions || []) {
      if (inst?.op !== 'load' || inst?.loc?.kind !== 'stack' || inst?.row == null || ret.row == null || inst.row >= ret.row) continue;
      if (!sourceRows.has(String(inst.row))) continue;
      const store = inst.reachingStore;
      if (store?.op !== 'store' || store?.loc?.kind !== 'stack' || store.loc.key !== inst.loc.key || store.row == null) continue;
      if (!sourceRows.has(String(store.row))) continue;
      if (!load || inst.row > load.row) load = inst;
    }
    const spill = load?.reachingStore;
    if (!load || !spill) continue;
    const spillRow = String(spill.row);
    const alignedAddresses = current.addresses.length === current.rows.length;
    const alignedIr = current.ir.length === current.rows.length;
    node.source = {
      ...current,
      rows:current.rows.filter((row) => String(row) !== spillRow),
      addresses:alignedAddresses
        ? current.addresses.filter((_, index) => String(current.rows[index]) !== spillRow)
        : current.addresses,
      ir:alignedIr
        ? current.ir.filter((_, index) => String(current.rows[index]) !== spillRow)
        : current.ir,
      evidence:[...(current.evidence || []), { reason:'eliminated stack spill is proof-only provenance' }],
    };
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

function fullPhase8Projection(result, model, opts) {
  if (opts.phase8Optimize !== true || !result?.semantic || !result?.ir) return result;
  const stage = runPhase8Stage(
    { ir:result.ir, types:result.types, opts },
    {
      stages:PHASE8_ALL_STAGES,
      timeBudgetMs:Number(opts.phase8TimeBudgetMs ?? 250),
      shouldAbort:opts.shouldAbort,
      budgetClass:'standard',
    },
  );
  const priorPipeline = result.ctx?.decompilerPipeline || {};
  let updated = {
    ...result,
    phase8:stage.ledger,
    ctx:{
      ...(result.ctx || {}),
      decompilerPipeline:{
        ...priorPipeline,
        completeness:stage.ledger?.published === true && stage.ledger?.completeness === 'complete'
          ? priorPipeline.completeness
          : 'partial',
        phase8:stage.ledger,
        phase8Timings:stage.timings,
        phase8ElapsedMs:stage.elapsedMs,
      },
    },
  };
  if (stage.ledger?.published !== true || stage.ledger?.completeness !== 'complete' || !stage.analysis) return updated;
  updated = applyPhase8Projection(updated, stage.analysis, opts);
  return updated;
}

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  const restore = normalizeConditionalSelectAliases(result?.ir);
  let core;
  try {
    // The final Phase 8 path executes the full optimizer set once below, after
    // the existing representation pipeline reaches its stable AST. The core is
    // kept on its interactive/canonical lane here so the optimizer is not run
    // twice and does not borrow the PassManager rewrite deadline.
    core = constrainSemanticValueWidths(enhanceCore(result, model, { ...opts, phase8Optimize:false }));
  } finally { restore(); }
  const recovered = recoverExactStackReturn(reanchorExactStackReturn(core), opts);
  return fullPhase8Projection(reanchorRecoveredReturnSource(recovered, opts), model, opts);
}
