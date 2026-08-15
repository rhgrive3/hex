import { expr, structuralKey } from '../ast/nodes.js';
import { RewriteEngine } from '../rewrite/engine.js';
import { DEFAULT_RULES } from '../rewrite/rules.js';
import { printExpression, printProgram } from '../pretty/c.js';
import { buildNZCVConditionExpression } from '../flag-semantics.js';

const INVERSE = Object.freeze({ eq:'ne', ne:'eq', lt:'ge', le:'gt', gt:'le', ge:'lt' });

function valueOf(a) { return a?.value || null; }

function mapsOf(result) {
  return new Map((result.semanticAst?.values || []).map((v) => [v.valueId, v.expression]));
}

function fitWidth(node, bits, source = null) {
  bits = Number(bits || 0);
  if (!node || !bits || Number(node.bits || bits) <= bits) return node;
  return expr.unary('trunc', node, bits, node.signed ?? null, source || node.source, { fromBits:Number(node.bits || bits) });
}

function expressionOf(value, values) {
  const node = value ? values.get(value.id) || null : null;
  return node ? fitWidth(node, value?.bits, {
    row:value?.def?.row ?? null,
    address:value?.def?.address ?? null,
    ir:value?.def?.id ?? null,
    ssaUse:value?.id ?? null,
    evidence:[{ reason:'SSA value-width boundary' }],
  }) : null;
}

function simplify(node, engine) {
  return node ? engine.rewrite(node).root : null;
}

function invert(node) {
  if (node?.kind === 'compare' && INVERSE[node.op]) {
    return expr.compare(INVERSE[node.op], node.left, node.right, node.compareSigned, node.source);
  }
  return expr.unary('lnot', node, 1, false, node?.source);
}

function sameRowArithmetic(ir, cmp) {
  const row = ir.byRow?.get?.(cmp.row) || (ir.instructions || []).filter((i) => i.row === cmp.row);
  let best = null;
  for (const inst of row) {
    if (inst.id >= cmp.id) continue;
    if (inst.op !== 'bin' || inst.sub !== cmp.sub) continue;
    if (!best || inst.id > best.id) best = inst;
  }
  return best;
}

function compareFromFlags(ir, flagsValue, cond, values) {
  const cmp = flagsValue?.def;
  if (cmp?.op !== 'cmp') return null;

  // Flag-setting arithmetic is lifted as BIN then CMP on the same ARM64 row.
  // SSA renaming can make CMP read the just-written destination. The preceding
  // same-row BIN is an exact proof of the original flag-producing operands.
  const arithmetic = sameRowArithmetic(ir, cmp);
  const leftValue = valueOf(arithmetic?.args?.[0] || cmp.args?.[0]);
  const rightValue = valueOf(arithmetic?.args?.[1] || cmp.args?.[1]);
  const left = expressionOf(leftValue, values);
  const right = expressionOf(rightValue, values);
  if (!left || !right) return null;
  const bits = Number(cmp.bits || leftValue?.bits || rightValue?.bits || left.bits || right.bits || 64);

  return buildNZCVConditionExpression(cmp.sub || 'sub', cond, left, right, bits, {
    address: cmp.address,
    row: cmp.row,
    ir: cmp.id,
    ssaUses: [leftValue?.id, rightValue?.id].filter((x) => x != null),
    evidence: [{ reason: arithmetic ? 'same-row flag-producing arithmetic operands' : 'NZCV compare operands' }],
  });
}

function branchCondition(ir, term, values) {
  const kind = term?.extra?.kind || term?.sub || '';
  const tested = valueOf(term?.args?.[0]);

  if (kind === 'cbz' || kind === 'cbnz') {
    const x = expressionOf(tested, values);
    return x ? expr.compare(kind === 'cbz' ? 'eq' : 'ne', x, expr.constant(0, x.bits || 64), null, term.source) : null;
  }

  if (kind === 'tbz' || kind === 'tbnz') {
    const select = tested?.def;
    if (select?.op === 'sel' && (select.sub === 'set' || select.sub === 'setm')) {
      const flags = valueOf(select.args?.[select.args.length - 1]);
      const materialized = compareFromFlags(ir, flags, select.cond, values);
      if (materialized) return kind === 'tbz' ? invert(materialized) : materialized;
    }

    const x = expressionOf(tested, values);
    if (!x) return null;
    const bit = Number(term.extra?.bit ?? 0);
    const bits = Number(tested?.bits || x.bits || 64);
    if (bit === bits - 1) {
      return expr.compare(kind === 'tbz' ? 'ge' : 'lt', x, expr.constant(0, bits, true), true, term.source);
    }
    const shifted = expr.binary('lshr', x, expr.constant(bit, bits, false), bits, false, term.source);
    const masked = expr.binary('and', shifted, expr.constant(1, bits, false), bits, false, term.source);
    return expr.compare(kind === 'tbz' ? 'eq' : 'ne', masked, expr.constant(0, bits, false), false, term.source);
  }

  if (kind === 'cond' || term?.cond) {
    const flags = valueOf(term.args?.[term.args.length - 1]);
    return compareFromFlags(ir, flags, term.cond || term.extra?.cond, values);
  }
  return null;
}

function targetBlock(ir, term, opts) {
  const address = term?.extra?.target;
  if (address == null) return null;
  const row = opts.rowOfAddress?.(address);
  if (row == null) return null;
  return ir.blocks?.find((b) => row >= b.startRow && row <= b.endRow)?.index ?? null;
}

function terminal(block) {
  const xs = block?.insts || [];
  for (let i = xs.length - 1; i >= 0; i--) if (['cbr','br','ret'].includes(xs[i]?.op)) return xs[i];
  return null;
}

function branchArms(ir, block, term, opts) {
  const succ = block?.succ || [];
  if (term?.op !== 'cbr' || succ.length < 2) return { yes:succ[0] ?? null, no:succ[1] ?? null, exact:term?.op !== 'cbr' };
  const yes = targetBlock(ir, term, opts);
  return yes != null && succ.includes(yes)
    ? { yes, no:succ.find((x) => x !== yes) ?? null, exact:true }
    : { yes:null, no:null, exact:false };
}

function canReach(ir, start, target, blocked, cap = 256) {
  if (start == null || target == null) return false;
  const queue = [start], seen = new Set();
  while (queue.length && cap-- > 0) {
    const at = queue.shift();
    if (at === target) return true;
    if (at === blocked || seen.has(at)) continue;
    seen.add(at);
    for (const next of ir.blocks?.[at]?.succ || []) if (!seen.has(next)) queue.push(next);
  }
  return false;
}

function armPredecessorIndex(ir, controller, successor, merge, predecessors) {
  if (successor === merge) return predecessors.indexOf(controller.index);
  return predecessors.findIndex((pred) => canReach(ir, successor, pred, merge));
}

function dominates(ir, candidate, node) {
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

function controller(ir, merge, predecessors, opts) {
  const candidates = [];
  for (const block of ir.blocks || []) {
    if (!dominates(ir, block.index, merge)) continue;
    const term = terminal(block);
    if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;
    const arms = branchArms(ir, block, term, opts);
    if (!arms.exact) continue;
    const yesIndex = armPredecessorIndex(ir, block, arms.yes, merge, predecessors);
    const noIndex = armPredecessorIndex(ir, block, arms.no, merge, predecessors);
    if (yesIndex >= 0 && noIndex >= 0 && yesIndex !== noIndex) candidates.push({ term, yesIndex, noIndex, depth:domDepth(ir, block.index) });
  }
  candidates.sort((a,b) => b.depth - a.depth);
  if (!candidates.length) return null;
  if (candidates.length > 1 && candidates[0].depth === candidates[1].depth) return null;
  return candidates[0];
}

function storeValue(inst, key, values) {
  if (inst?.op !== 'store' || inst.loc?.key !== key) return null;
  let node = expressionOf(valueOf(inst.args?.[0]), values);
  if (!node) return null;
  const bytes = Number(inst.size || inst.loc?.size || inst.addr?.size || 0);
  const bits = bytes > 0 ? bytes * 8 : 0;
  if (bits) node = fitWidth(node, bits, {
    address:inst.address,
    row:inst.row,
    ir:inst.id,
    evidence:[{ reason:`exact ${bits}-bit stack-store boundary` }],
  });
  return node;
}

function reachingRegisterDefinition(ir, atInst, reg) {
  let best = null, bestDepth = -1, bestRow = -Infinity;
  for (const value of ir?.values || []) {
    if (value?.reg !== reg || !value.def || value.clobbered) continue;
    const def = value.def;
    if (def.block === atInst.block) {
      if (def.row == null || atInst.row == null || def.row >= atInst.row) continue;
      if (def.row > bestRow) { best = value; bestRow = def.row; bestDepth = Number.MAX_SAFE_INTEGER; }
      continue;
    }
    if (!dominates(ir, def.block, atInst.block)) continue;
    const depth = domDepth(ir, def.block);
    if (bestDepth !== Number.MAX_SAFE_INTEGER && (depth > bestDepth || (depth === bestDepth && (def.row ?? -Infinity) > bestRow))) {
      best = value; bestDepth = depth; bestRow = def.row ?? -Infinity;
    }
  }
  return best;
}

function latestStoreTo(ir, blockIndex, beforeRow, key) {
  let best = null;
  for (const inst of ir?.blocks?.[blockIndex]?.insts || []) {
    if (inst?.op !== 'store' || inst.loc?.key !== key) continue;
    if (beforeRow != null && inst.row >= beforeRow) continue;
    if (!best || (inst.row ?? -1) > (best.row ?? -1)) best = inst;
  }
  return best;
}

function storeOfExactValue(ir, blockIndex, value) {
  let best = null;
  for (const inst of ir?.blocks?.[blockIndex]?.insts || []) {
    if (inst?.op !== 'store' || inst.loc?.kind === 'stack' || inst.loc?.kind === 'unknown') continue;
    if (valueOf(inst.args?.[0])?.id !== value?.id) continue;
    if (!best || (inst.row ?? -1) > (best.row ?? -1)) best = inst;
  }
  return best;
}

function semanticLocationForStore(result, store) {
  return (result.semanticAst?.stores || []).find((item) =>
    (item.source?.ir || []).some((id) => Number(id) === Number(store?.id)))?.location || null;
}

function locationIdentity(location) {
  if (!location) return null;
  if (location.kind === 'field') {
    return `field:${location.offset ?? ''}:${location.name || ''}:${structuralKey(location.base)}`;
  }
  if (location.kind === 'index') {
    return `index:${location.scale || 1}:${structuralKey(location.base)}:${structuralKey(location.index)}`;
  }
  return `${location.kind}:${location.key || location.text || location.name || ''}`;
}

function committedLocationForPhi(result, value) {
  const phi = value?.def;
  if (phi?.op !== 'phi' || !(phi.incoming || []).length) return null;
  const locations = [];
  for (const incoming of phi.incoming || []) {
    const store = storeOfExactValue(result.ir, incoming.from, incoming.value);
    if (!store) return null;
    const location = semanticLocationForStore(result, store);
    if (!location) return null;
    locations.push(location);
  }
  const identity = locationIdentity(locations[0]);
  if (!identity || locations.some((loc) => locationIdentity(loc) !== identity)) return null;
  return locations[0];
}

function committedReturnValue(result, root, ret) {
  if (root?.kind !== 'load' || root.location?.kind !== 'stack' || !root.location?.key) return null;
  const reaching = reachingRegisterDefinition(result.ir, ret, 'x0');
  const load = reaching?.def;
  if (load?.op !== 'load' || load.loc?.key !== root.location.key) return null;
  const stackStore = load.reachingStore || latestStoreTo(result.ir, load.block, load.row, root.location.key);
  const spilled = valueOf(stackStore?.args?.[0]);
  const location = committedLocationForPhi(result, spilled);
  if (!location) return null;
  return expr.load(location, root.bits || 64, root.source, {
    signed: root.signed ?? null,
    proof: 'all SSA phi predecessors committed the exact spilled value to one lvalue',
  });
}

function unsafeBarrier(inst, key) {
  if (inst?.op === 'clobber' || inst?.op === 'unknown') return true;
  if (inst?.op === 'call') {
    // buildMemorySSA has already proven which locations this call can kill.
    // A private caller stack slot is absent from memKills and is safe to carry
    // through the call; an escaped stack address is present and remains a barrier.
    return (inst.memKills || []).some((loc) => loc?.key === key);
  }
  return inst?.op === 'store' && inst.loc?.key !== key && (!inst.loc?.key || inst.loc?.kind === 'unknown');
}

function before(ir, block, row) {
  return (ir.instructions || [])
    .filter((i) => i.block === block && (row == null || i.row < row))
    .sort((a,b) => (b.row ?? -1) - (a.row ?? -1));
}

function resolve(ir, blockIndex, beforeRow, key, values, opts, engine, active, depth = 0) {
  if (blockIndex == null || depth > 64) return null;
  const token = `${blockIndex}:${beforeRow ?? 'end'}:${key}`;
  if (active.has(token)) return null;
  active.add(token);
  try {
    for (const inst of before(ir, blockIndex, beforeRow)) {
      const stored = storeValue(inst, key, values);
      if (stored) return stored;
      if (unsafeBarrier(inst, key)) return null;
    }

    const block = ir.blocks?.[blockIndex];
    const predecessors = [...(block?.pred || [])];
    if (!predecessors.length) return null;
    const incoming = predecessors.map((pred) => resolve(ir, pred, null, key, values, opts, engine, active, depth + 1));
    if (incoming.some((x) => !x)) return null;
    const unique = new Map(incoming.map((x) => [structuralKey(x), x]));
    if (unique.size === 1) return incoming[0];
    if (predecessors.length !== 2 || unique.size !== 2) return null;

    const control = controller(ir, blockIndex, predecessors, opts);
    if (!control) return null;
    const condition = simplify(branchCondition(ir, control.term, values), engine);
    if (!condition) return null;
    const bits = incoming[0]?.bits || incoming[1]?.bits || 64;
    const signed = condition.compareSigned ?? incoming[0]?.signed ?? incoming[1]?.signed ?? null;
    return simplify(expr.select(condition, incoming[control.yesIndex], incoming[control.noIndex], bits, signed, {
      address:control.term.address,
      row:control.term.row,
      ir:control.term.id,
      evidence:[{ reason:'exact stack CFG join' }],
    }), engine);
  } finally {
    active.delete(token);
  }
}

function rewriteReturn(result, expression, opts) {
  const output = result.semanticAst?.outputs?.find((x) => x.name === 'return');
  if (!output) return false;
  output.expression = expression;
  let changed = false;
  for (const node of result.cAst?.body || []) {
    if (node.semantic?.op === 'return' || /^return\b/.test(String(node.text || '').trim())) {
      node.text = `return ${printExpression(expression)};`;
      if (node.semantic) node.semantic.expression = expression;
      changed = true;
    }
  }
  if (!changed) return false;
  const printed = printProgram(result.cAst, { columnWidth:opts.columnWidth || opts.prettyColumnWidth || 88 });
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  return true;
}

export function recoverExactStackReturn(result, opts = {}) {
  if (!result?.semantic || !result.ir || !result.semanticAst || !result.cAst) return result;
  const output = result.semanticAst.outputs?.find((x) => x.name === 'return');
  const root = output?.expression;
  if (root?.kind !== 'load' || root.location?.kind !== 'stack' || !root.location?.key) return result;
  const ret = [...(result.ir.instructions || [])].reverse().find((i) => i.op === 'ret');
  if (!ret) return result;

  const values = mapsOf(result);
  const engine = new RewriteEngine(DEFAULT_RULES, {
    maxIterations:10,
    nodeBudget:Math.min(2048, Number(opts.decompilerNodeBudget || 12000)),
    timeBudgetMs:Math.min(12, Math.max(4, Number(opts.decompilerTimeBudgetMs || 50) / 4)),
    maxApplications:512,
  });
  const committed = committedReturnValue(result, root, ret);
  const recovered = committed || resolve(result.ir, ret.block, ret.row, root.location.key, values, opts, engine, new Set());
  // A stack load means no useful reconstruction happened. A committed non-stack
  // field/global load is an intentional high-level return and must be retained.
  if (!recovered || (recovered.kind === 'load' && recovered.location?.kind === 'stack') || !rewriteReturn(result, recovered, opts)) return result;

  result.rewriteProof = [...(result.rewriteProof || []), {
    rule:'exact-stack-return-recovery', phase:'memory-ssa',
    evidence:{ kind:'cfg-memory-ssa', detail:'exact stack return reconstructed from predecessor stores and flag-producing SSA evidence' },
  }];
  result.metrics = { ...(result.metrics || {}), rewrittenExpressions:(result.metrics?.rewrittenExpressions || 0) + 1, sourceMappedNodes:result.sourceMap?.length || 0 };
  result.ctx = { ...(result.ctx || {}), decompilerPipeline:{ ...(result.ctx?.decompilerPipeline || {}), exactStackReturnRecovered:true } };
  return result;
}
