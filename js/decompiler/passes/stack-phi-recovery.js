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

const CONDITION_OP = Object.freeze({
  eq: 'eq', ne: 'ne', hs: 'ge', cs: 'ge', lo: 'lt', cc: 'lt', hi: 'gt', ls: 'le',
  ge: 'ge', lt: 'lt', gt: 'gt', le: 'le',
});
const INVERT_OP = Object.freeze({ eq: 'ne', ne: 'eq', lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' });

function signednessForCondition(cond) {
  if (['ge', 'lt', 'gt', 'le'].includes(cond)) return true;
  if (['hs', 'cs', 'lo', 'cc', 'hi', 'ls'].includes(cond)) return false;
  return null;
}

function expressionOfValue(value, maps) {
  return value ? maps.values.get(value.id) || null : null;
}

/*
 * IR-core intentionally models flag-setting arithmetic as two semantic ops on the
 * same source row: BIN followed by CMP/NZCV. During SSA rename the CMP's first
 * register read can bind to the just-defined BIN destination (e.g. SUBS becomes
 * `(a-b) ? b`) even though NZCV was produced from the original `a ? b` operands.
 *
 * The decompiler repairs only this provable shadow shape. We never alter IR and
 * never guess across rows: the CMP first value must be defined by a same-row BIN
 * with the same arithmetic sub-op. This also covers ADDS/ANDS without weakening
 * general compare semantics.
 */
function repairedFlagComparison(flagsValue, cond, maps) {
  const cmp = flagsValue?.def;
  if (cmp?.op !== 'cmp') return null;

  let leftValue = valueOf(cmp.args?.[0]);
  let rightValue = valueOf(cmp.args?.[1]);
  const shadow = leftValue?.def;
  if (shadow?.op === 'bin' && shadow.row === cmp.row && shadow.sub === cmp.sub) {
    const originalLeft = valueOf(shadow.args?.[0]);
    const originalRight = valueOf(shadow.args?.[1]);
    if (originalLeft && originalRight) {
      leftValue = originalLeft;
      rightValue = originalRight;
    }
  }

  const left = expressionOfValue(leftValue, maps);
  const right = expressionOfValue(rightValue, maps);
  const op = CONDITION_OP[cond];
  if (!left || !right || !op) return null;
  return expr.compare(op, left, right, signednessForCondition(cond), {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    ssaUses: [leftValue?.id, rightValue?.id].filter((x) => x != null),
    evidence: [{ reason: shadow?.row === cmp.row ? 'same-row flag shadow repaired from arithmetic operands' : 'NZCV comparison' }],
  });
}

function invertCondition(condition) {
  if (condition?.kind === 'compare' && INVERT_OP[condition.op]) {
    return expr.compare(INVERT_OP[condition.op], condition.left, condition.right, condition.compareSigned, condition.source);
  }
  return expr.unary('lnot', condition, 1, false, condition?.source);
}

function materializedFlagCondition(term, maps) {
  const kind = term?.extra?.kind || term?.sub || '';
  if (!['tbz', 'tbnz', 'cbz', 'cbnz'].includes(kind)) return null;
  const tested = valueOf(term.args?.[0]);
  const select = tested?.def;
  if (select?.op !== 'sel' || !['set', 'setm'].includes(select.sub)) return null;

  const flagsValue = valueOf(select.args?.at?.(-1));
  const condition = repairedFlagComparison(flagsValue, select.cond, maps);
  if (!condition) return null;

  // cset/csetm materialize true as a non-zero value and false as zero. Branches
  // on non-zero therefore preserve the condition; zero branches invert it.
  return kind === 'tbz' || kind === 'cbz' ? invertCondition(condition) : condition;
}

function controlCondition(term, maps, engine) {
  return simplify(materializedFlagCondition(term, maps) || maps.conditions.get(term.id), engine);
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
    const condition = controlCondition(control.term, maps, engine);
    if (!condition) return null;
    const bits = incoming[0]?.bits || incoming[1]?.bits || 64;
    const signed = incoming[0]?.signed ?? incoming[1]?.signed ?? null;

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
