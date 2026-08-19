import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackReturn } from './passes/stack-return-recovery.js';
import { expr, sourceOf } from './ast/nodes.js';
import { printProgram } from './pretty/c.js';

export { buildExpressionForTesting } from './pipeline-core.js';

function valueOf(arg) { return arg?.value || null; }

const INVERSE_CONDITION = {
  eq:'ne', ne:'eq', hs:'lo', lo:'hs', cs:'cc', cc:'cs',
  hi:'ls', ls:'hi', ge:'lt', lt:'ge', gt:'le', le:'gt',
  mi:'pl', pl:'mi', vs:'vc', vc:'vs',
};

function wrappedSignedStackName(key) {
  const match = /^stack:(\d+)$/.exec(String(key || ''));
  if (!match) return null;
  const raw = BigInt(match[1]);
  if (raw < (1n << 63n) || raw >= (1n << 64n)) return null;
  const signed = BigInt.asIntN(64, raw);
  if (signed >= 0n) return null;
  return {
    oldName:`local_p${raw.toString(16).toUpperCase()}`,
    canonicalName:`local_m${(-signed).toString(16).toUpperCase()}`,
  };
}

function wrappedStackAliases(result) {
  const aliasesByRow = new Map();
  for (const line of result?.lines || []) {
    if (line?.row == null) continue;
    const alias = /\b(var_[A-Za-z0-9_$]+)\b/.exec(String(line.text || ''))?.[1] || null;
    if (alias) aliasesByRow.set(String(line.row), alias);
  }
  const byKey = new Map();
  for (const inst of result?.ir?.instructions || []) {
    if (!['load','store'].includes(inst?.op) || inst?.loc?.kind !== 'stack' || !wrappedSignedStackName(inst.loc.key) || inst.row == null) continue;
    const alias = aliasesByRow.get(String(inst.row));
    if (alias && !byKey.has(inst.loc.key)) byKey.set(inst.loc.key, alias);
  }
  return byKey;
}

function normalizeWrappedStackDisplay(result, aliasesByKey, opts = {}) {
  if (!result?.ir) return result;
  const replacementsByRow = new Map();
  for (const inst of result.ir.instructions || []) {
    if (!['load','store'].includes(inst?.op) || inst?.loc?.kind !== 'stack' || inst.row == null) continue;
    const names = wrappedSignedStackName(inst.loc.key);
    if (!names) continue;
    const alias = aliasesByKey?.get?.(inst.loc.key) || null;
    const newName = alias ? `${names.canonicalName}_${alias}` : names.canonicalName;
    replacementsByRow.set(String(inst.row), { ...names, newName, key:inst.loc.key });
  }
  if (!replacementsByRow.size) return result;

  for (const store of result.semanticFacts?.stores || []) {
    const names = wrappedSignedStackName(store?.location?.key);
    if (!names) continue;
    const alias = aliasesByKey?.get?.(store.location.key) || null;
    const newName = alias ? `${names.canonicalName}_${alias}` : names.canonicalName;
    store.location = { ...store.location, name:newName, text:newName };
    store.lhsText = newName;
  }

  let changed = false;
  for (const node of result.cAst?.body || []) {
    const rows = node.source?.rows || [];
    let text = String(node.text || '');
    for (const row of rows) {
      const replacement = replacementsByRow.get(String(row));
      if (!replacement) continue;
      text = text.split(replacement.oldName).join(replacement.newName);
      if (node.semantic?.location?.key === replacement.key) {
        node.semantic.location = { ...node.semantic.location, name:replacement.newName, text:replacement.newName };
      }
    }
    if (text !== node.text) { node.text = text; changed = true; }
  }
  if (!changed || !result.cAst) return result;
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
    if (/\blocal_(?:[mp])?[0-9A-F]+(?:_var_[A-Za-z0-9_$]+)?\b/i.test(String(node.text || ''))) continue;
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

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  const aliasesByKey = wrappedStackAliases(result);
  const restore = normalizeConditionalSelectAliases(result?.ir);
  let core;
  try { core = constrainSemanticValueWidths(enhanceCore(result, model, opts)); }
  finally { restore(); }
  const recovered = recoverExactStackReturn(reanchorExactStackReturn(core), opts);
  return reanchorRecoveredReturnSource(normalizeWrappedStackDisplay(recovered, aliasesByKey, opts), opts);
}
