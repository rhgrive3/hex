import { expr, structuralKey } from '../ast/nodes.js';
import { RewriteEngine } from '../rewrite/engine.js';
import { DEFAULT_RULES } from '../rewrite/rules.js';
import { printExpression, printProgram } from '../pretty/c.js';

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
  if (term?.op !== 'cbr' || successors.length < 2) return { yes: successors[0] ?? null, no: successors[1] ?? null };
  const yes = targetBlock(ir, term, opts);
  if (yes == null || !successors.includes(yes)) return { yes: successors[0] ?? null, no: successors[1] ?? null };
  return { yes, no: successors.find((x) => x !== yes) ?? null };
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

function controllerForMerge(ir, mergeBlock, predecessors, opts) {
  const candidates = [];
  for (const block of ir.blocks || []) {
    const term = terminal(block);
    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;
    const { yes, no } = branchSuccessors(ir, block, term, opts);
    const yesIndex = armIndex(ir, block, yes, mergeBlock, predecessors);
    const noIndex = armIndex(ir, block, no, mergeBlock, predecessors);
    if (yesIndex < 0 || noIndex < 0 || yesIndex === noIndex) continue;
    candidates.push({ term, yesIndex, noIndex, row: term.row ?? -1 });
  }
  candidates.sort((a, b) => b.row - a.row);
  return candidates[0] || null;
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

function exactStoreExpression(inst, key, maps) {
  if (inst?.op !== 'store' || inst.loc?.key !== key) return null;
  const value = valueOf(inst.args?.[0]);
  return value ? maps.values.get(value.id) || null : null;
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
      const stored = exactStoreExpression(inst, key, maps);
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
    const condition = simplify(maps.conditions.get(control.term.id), engine);
    if (!condition) return null;
    const bits = incoming[0]?.bits || incoming[1]?.bits || 64;
    const signed = incoming[0]?.signed ?? incoming[1]?.signed ?? null;
    // semanticAst.conditions describes the fallthrough truth predicate used by
    // structured output, while targetBlock() names the taken machine branch.
    // Therefore the exact-stack incoming values are intentionally opposite the
    // machine-edge yes/no indices here. This is source-ground-truth verified by
    // O0 max/min/clamp fixtures and prevents globally inverted branch joins.
    return simplify(expr.select(condition, incoming[control.noIndex], incoming[control.yesIndex], bits, signed, {
      address: control.term.address,
      row: control.term.row,
      ir: control.term.id,
      evidence: [{ reason: 'exact stack Memory-SSA/CFG join' }],
    }), engine);
  } finally {
    active.delete(visitKey);
  }
}

function recoverReturnExpression(result, maps, opts, engine) {
  const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
  const root = output?.expression;
  if (root?.kind !== 'load' || root.location?.kind !== 'stack' || !root.location?.key) return null;
  const retInst = [...(result.ir?.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  if (!retInst) return null;
  return resolveStackBefore(result.ir, retInst.block, retInst.row, root.location.key, maps, opts, engine, new Set());
}

function rewriteReturnInAst(result, expression) {
  let changed = false;
  for (const node of result.cAst?.body || []) {
    if (node.semantic?.op === 'return' || /^return\b/.test(String(node.text || '').trim())) {
      node.text = `return ${printExpression(expression)};`;
      if (node.semantic) node.semantic.expression = expression;
      changed = true;
    }
  }
  return changed;
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
  const recovered = recoverReturnExpression(result, maps, opts, engine);
  if (!recovered || recovered.kind === 'load') return result;

  const output = result.semanticAst.outputs.find((x) => x.name === 'return');
  output.expression = recovered;
  if (!rewriteReturnInAst(result, recovered)) return result;

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
    evidence: { kind: 'cfg-memory-ssa', detail: 'two-path exact stack value reconstructed without crossing unknown memory effects' },
  }];
  result.metrics = {
    ...(result.metrics || {}),
    rewrittenExpressions: (result.metrics?.rewrittenExpressions || 0) + 1,
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
