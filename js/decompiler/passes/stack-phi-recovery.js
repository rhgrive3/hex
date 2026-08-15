import { expr, structuralKey } from '../ast/nodes.js';
import { RewriteEngine } from '../rewrite/engine.js';
import { DEFAULT_RULES } from '../rewrite/rules.js';
import { printExpression, printProgram } from '../pretty/c.js';
import { buildNZCVConditionExpression } from '../flag-semantics.js';

function valueOf(arg) { return arg?.value || null; }

function targetBlock(ir, term, opts) {
  const address = term?.extra?.target;
  if (address == null) return null;
  const row = opts?.rowOfAddress?.(address);
  if (row == null) return null;
  return ir.blocks?.find((b) => row >= b.startRow && row <= b.endRow)?.index ?? null;
}

function terminal(block) {
  const insts = block?.insts || [];
  for (let i = insts.length - 1; i >= 0; i--) {
    if (['cbr', 'br', 'ret'].includes(insts[i]?.op)) return insts[i];
  }
  return null;
}

function branchSuccessors(ir, block, term, opts) {
  const successors = block?.succ || [];
  if (term?.op !== 'cbr' || successors.length < 2) return { yes: successors[0] ?? null, no: successors[1] ?? null, exact: term?.op !== 'cbr' };
  const yes = targetBlock(ir, term, opts);
  if (yes == null || !successors.includes(yes)) return { yes: null, no: null, exact: false };
  return { yes, no: successors.find((x) => x !== yes) ?? null, exact: true };
}

function canReach(ir, start, target, blocked, cap = 256) {
  if (start == null || target == null) return false;
  const queue = [start];
  const seen = new Set();
  while (queue.length && cap-- > 0) {
    const current = queue.shift();
    if (current === target) return true;
    if (current === blocked || seen.has(current)) continue;
    seen.add(current);
    for (const next of ir.blocks?.[current]?.succ || []) if (!seen.has(next)) queue.push(next);
  }
  return false;
}

function armIndex(ir, controller, successor, mergeBlock, predecessors) {
  if (successor === mergeBlock) return predecessors.indexOf(controller.index);
  return predecessors.findIndex((pred) => canReach(ir, successor, pred, mergeBlock));
}

function dominates(ir, candidate, node) {
  if (candidate == null || node == null) return false;
  const view = ir.dominators?.[node];
  if (view?.has) return view.has(candidate);
  let cur = node, guard = (ir.blocks?.length || 0) + 2;
  while (cur != null && cur >= 0 && guard-- > 0) {
    if (cur === candidate) return true;
    cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1;
  }
  return false;
}

function domDepth(ir, block) {
  let depth = 0, cur = block, guard = (ir.blocks?.length || 0) + 2;
  while (cur != null && cur >= 0 && guard-- > 0) { depth++; cur = ir.idom?.[cur] ?? ir.blocks?.[cur]?.idom ?? -1; }
  return depth;
}

function controllerForMerge(ir, mergeBlock, predecessors, opts) {
  const candidates = [];
  for (const block of ir.blocks || []) {
    if (!dominates(ir, block.index, mergeBlock)) continue;
    const term = terminal(block);
    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;
    const arms = branchSuccessors(ir, block, term, opts);
    if (!arms.exact) continue;
    const yesIndex = armIndex(ir, block, arms.yes, mergeBlock, predecessors);
    const noIndex = armIndex(ir, block, arms.no, mergeBlock, predecessors);
    if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) continue;
    candidates.push({ term, yesIndex, noIndex, depth: domDepth(ir, block.index) });
  }
  candidates.sort((a, b) => b.depth - a.depth);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].depth === candidates[1].depth) return null;
  return candidates[0];
}

function expressionMaps(result) {
  const values = new Map();
  for (const item of result.semanticAst?.values || []) values.set(item.valueId, item.expression);
  const conditions = new Map();
  for (const item of result.semanticAst?.conditions || []) {
    if (item.ir != null) conditions.set(item.ir, item.expression);
  }
  return { values, conditions };
}

function simplify(expression, engine) {
  if (!expression) return null;
  return engine.rewrite(expression).root;
}

const INVERT_OP = Object.freeze({ eq: 'ne', ne: 'eq', lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' });

function expressionOfValue(value, maps) {
  return value ? maps.values.get(value.id) || null : null;
}

/*
 * Flag-setting ARM64 arithmetic is lifted as a value-producing BIN followed by
 * a same-row CMP/NZCV operation. SSA rename may bind the CMP's first register
 * read to the BIN result (SUBS: (a-b) ? b) rather than the pre-write a. Repair
 * only when the Semantic IR itself proves a unique same-row companion BIN with
 * the same arithmetic sub-op. No ARM64 text is reparsed here.
 */
function sameRowFlagProducer(cmp, ir) {
  if (!cmp || cmp.row == null || !['sub', 'add', 'and'].includes(cmp.sub)) return null;
  const candidates = (ir?.instructions || []).filter((inst) =>
    inst !== cmp && inst.op === 'bin' && inst.row === cmp.row && inst.sub === cmp.sub &&
    (inst.args || []).length >= 2 && inst.dst);
  if (candidates.length !== 1) return null;
  const producer = candidates[0];
  const observed = valueOf(cmp.args?.[0]);
  if (observed?.reg && producer.dst?.reg && observed.reg !== producer.dst.reg) return null;
  return producer;
}

function repairedFlagComparison(flagsValue, cond, maps, ir) {
  const cmp = flagsValue?.def;
  if (cmp?.op !== 'cmp') return null;

  let leftValue = valueOf(cmp.args?.[0]);
  let rightValue = valueOf(cmp.args?.[1]);
  const shadow = leftValue?.def;
  let producer = null;
  if (shadow?.op === 'bin' && shadow.row === cmp.row && shadow.sub === cmp.sub) producer = shadow;
  if (!producer) producer = sameRowFlagProducer(cmp, ir);
  if (producer) {
    const originalLeft = valueOf(producer.args?.[0]);
    const originalRight = valueOf(producer.args?.[1]);
    if (originalLeft && originalRight) {
      leftValue = originalLeft;
      rightValue = originalRight;
    }
  }

  const left = expressionOfValue(leftValue, maps);
  const right = expressionOfValue(rightValue, maps);
  if (!left || !right) return null;
  const bits = Math.max(Number(cmp.bits || 0), Number(left.bits || 0), Number(right.bits || 0), 1);
  return buildNZCVConditionExpression(cmp.sub || 'sub', cond, left, right, bits, {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    ssaUses: [leftValue?.id, rightValue?.id].filter((x) => x != null),
    evidence: [{ reason: producer ? 'same-row flag producer operands' : 'NZCV comparison' }],
  });
}

function invertCondition(condition) {
  if (condition?.kind === 'compare' && INVERT_OP[condition.op]) {
    return expr.compare(INVERT_OP[condition.op], condition.left, condition.right, condition.compareSigned, condition.source);
  }
  return expr.unary('lnot', condition, 1, false, condition?.source);
}

function materializedFlagCondition(term, maps, ir) {
  const kind = term?.extra?.kind || term?.sub || '';
  if (!['tbz', 'tbnz', 'cbz', 'cbnz'].includes(kind)) return null;
  const tested = valueOf(term.args?.[0]);
  const select = tested?.def;
  if (select?.op !== 'sel' || !['set', 'setm'].includes(select.sub)) return null;

  const flagsValue = valueOf(select.args?.at?.(-1));
  const condition = repairedFlagComparison(flagsValue, select.cond, maps, ir);
  if (!condition) return null;

  // cset/csetm materialize true as a non-zero value and false as zero. Branches
  // on non-zero therefore preserve the condition; zero branches invert it.
  return kind === 'tbz' || kind === 'cbz' ? invertCondition(condition) : condition;
}

function controlCondition(term, maps, engine, ir) {
  return simplify(materializedFlagCondition(term, maps, ir) || maps.conditions.get(term.id), engine);
}

function exactStoreExpression(inst, key, maps, engine) {
  if (inst?.op !== 'store' || inst.loc?.key !== key) return null;
  const value = valueOf(inst.args?.[0]);
  let expression = value ? maps.values.get(value.id) || null : null;
  if (!expression) return null;

  // A W-register store is an exact truncation boundary. Keep that width in the
  // recovered source value instead of leaking the 64-bit entry-register width
  // through an -O0 spill. This is essential for signed int32 comparisons such
  // as clamp(x,0) when x has bit 31 set.
  const bytes = Number(inst.size || inst.loc?.size || inst.addr?.size || 0);
  const storeBits = bytes > 0 ? bytes * 8 : 0;
  if (storeBits > 0 && Number(expression.bits || storeBits) > storeBits) {
    expression = simplify(expr.unary('trunc', expression, storeBits, expression.signed, {
      address: inst.address,
      row: inst.row,
      ir: inst.id,
      evidence: [{ reason: `exact ${storeBits}-bit stack store width` }],
    }, { fromBits: expression.bits }), engine);
  }
  return expression;
}

function instructionsBefore(ir, blockIndex, beforeRow) {
  return (ir.instructions || [])
    .filter((inst) => inst.block === blockIndex && (beforeRow == null || inst.row < beforeRow))
    .sort((a, b) => (b.row ?? -1) - (a.row ?? -1));
}

function hasUnsafeBarrier(inst, key) {
  if (inst?.op === 'call' || inst?.op === 'clobber' || inst?.op === 'unknown') return true;
  return inst?.op === 'store' && inst.loc?.key !== key && (!inst.loc?.key || inst.loc?.kind === 'unknown');
}

function resolveStackBefore(ir, blockIndex, beforeRow, key, maps, opts, engine, active, depth = 0) {
  if (blockIndex == null || depth > 64) return null;
  const visitKey = `${blockIndex}:${beforeRow ?? 'end'}:${key}`;
  if (active.has(visitKey)) return null;
  active.add(visitKey);
  try {
    for (const inst of instructionsBefore(ir, blockIndex, beforeRow)) {
      const stored = exactStoreExpression(inst, key, maps, engine);
      if (stored) return stored;
      if (hasUnsafeBarrier(inst, key)) return null;
    }

    const block = ir.blocks?.[blockIndex];
    const predecessors = [...(block?.pred || [])];
    if (!predecessors.length) return null;
    const incoming = predecessors.map((pred) => resolveStackBefore(ir, pred, null, key, maps, opts, engine, active, depth + 1));
    if (incoming.some((x) => !x)) return null;
    const unique = new Map(incoming.map((x) => [structuralKey(x), x]));
    if (unique.size === 1) return incoming[0];
    if (predecessors.length !== 2 || unique.size !== 2) return null;

    const control = controllerForMerge(ir, blockIndex, predecessors, opts);
    if (!control) return null;
    const condition = controlCondition(control.term, maps, engine, ir);
    if (!condition) return null;
    const bits = incoming[0]?.bits || incoming[1]?.bits || 64;
    const signed = condition.compareSigned ?? incoming[0]?.signed ?? incoming[1]?.signed ?? null;

    // `yesIndex` is the machine branch target (condition true), `noIndex` is the
    // fallthrough arm. armIndex() handles a direct-to-merge edge by selecting the
    // controller block's value, so the mapping is valid for both diamonds and
    // guard-style shapes such as Clang's O0 clamp.
    return simplify(expr.select(condition, incoming[control.yesIndex], incoming[control.noIndex], bits, signed, {
      address: control.term.address,
      row: control.term.row,
      ir: control.term.id,
      evidence: [{ reason: 'exact stack Memory-SSA/CFG join' }],
    }), engine);
  } finally {
    active.delete(visitKey);
  }
}

function isReturnNode(node) {
  return node?.semantic?.op === 'return' || /^return\b/.test(String(node?.text || '').trim());
}

function stackReturnKey(expression) {
  return expression?.kind === 'load' && expression.location?.kind === 'stack' && expression.location?.key
    ? expression.location.key : null;
}

function returnSiteForNode(node, ir, allowSingleFallback = false) {
  const rets = (ir?.instructions || []).filter((inst) => inst.op === 'ret');
  if (!rets.length) return null;
  const source = node?.source || {};
  const rows = new Set((source.rows || []).map(Number));
  const irIds = new Set((source.ir || []).map(Number));
  const addresses = new Set((source.addresses || []).map((x) => String(x)));
  const matches = rets.filter((ret) => rows.has(Number(ret.row)) || irIds.has(Number(ret.id)) || addresses.has(String(ret.address)));
  if (matches.length === 1) return matches[0];
  if (!matches.length && allowSingleFallback && rets.length === 1) return rets[0];
  return null;
}

function recoverReturnExpressionAt(result, node, maps, opts, engine, allowSingleFallback) {
  const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
  const expression = node?.semantic?.expression || (allowSingleFallback ? output?.expression : null);
  const key = stackReturnKey(expression);
  if (!key) return null;
  const retInst = returnSiteForNode(node, result.ir, allowSingleFallback);
  if (!retInst) return null;
  return resolveStackBefore(result.ir, retInst.block, retInst.row, key, maps, opts, engine, new Set());
}

function rewriteReturnsInAst(result, maps, opts, engine) {
  const nodes = (result.cAst?.body || []).filter(isReturnNode);
  if (!nodes.length) return { changed:0, recovered:[] };
  const recovered = [];
  const allowSingleFallback = nodes.length === 1;
  for (const node of nodes) {
    const expression = recoverReturnExpressionAt(result, node, maps, opts, engine, allowSingleFallback);
    if (!expression || expression.kind === 'load') continue;
    node.text = `return ${printExpression(expression)};`;
    if (node.semantic) node.semantic.expression = expression;
    recovered.push({ node, expression });
  }
  if (recovered.length === 1 && nodes.length === 1) {
    const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
    if (output) output.expression = recovered[0].expression;
  }
  return { changed:recovered.length, recovered };
}

export function recoverExactStackPhiExpressions(result, opts = {}) {
  if (!result?.semantic || !result.ir || !result.semanticAst || !result.cAst) return result;
  const maps = expressionMaps(result);
  const engine = new RewriteEngine(DEFAULT_RULES, {
    maxIterations: 10,
    nodeBudget: Math.min(2048, Number(opts.decompilerNodeBudget || 12000)),
    timeBudgetMs: Math.min(10, Math.max(3, Number(opts.decompilerTimeBudgetMs || 50) / 5)),
    maxApplications: 512,
  });
  const rewrite = rewriteReturnsInAst(result, maps, opts, engine);
  if (!rewrite.changed) return result;

  const printed = printProgram(result.cAst, { columnWidth: opts.columnWidth || opts.prettyColumnWidth || 88 });
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind: node.kind,
    indent: node.indent,
    text: node.text,
    row: node.source?.rows?.[0] ?? null,
    addr: node.source?.addresses?.[0] ?? null,
    note: null,
    source: node.source,
  }));
  result.rewriteProof = [...(result.rewriteProof || []), {
    rule: 'exact-stack-phi-recovery',
    phase: 'memory-ssa',
    evidence: { kind: 'cfg-memory-ssa', detail: `${rewrite.changed} return site(s) reconstructed from exact RET provenance without crossing unknown memory effects` },
  }];
  result.metrics = {
    ...(result.metrics || {}),
    rewrittenExpressions: (result.metrics?.rewrittenExpressions || 0) + rewrite.changed,
    sourceMappedNodes: printed.mapping.length,
  };
  result.ctx = {
    ...(result.ctx || {}),
    decompilerPipeline: {
      ...(result.ctx?.decompilerPipeline || {}),
      exactStackPhiRecovered: true,
    },
  };
  return result;
}
