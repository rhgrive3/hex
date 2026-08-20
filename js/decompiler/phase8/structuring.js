/**
 * Control-flow structuring facts, with every edge accounted for.
 *
 * The claim a structurer has to be able to make is not "this function became a
 * tidy while loop". It is: *every edge in the original CFG is still there*, and
 * for each one you can say what became of it — a structured construct, an
 * explicit jump, or an explicit unknown. An edge that appears in none of those
 * three answers has been lost, and a lost edge is a path through the program the
 * reader will never see.
 *
 * So this pass is built around the accounting rather than around the prettiness.
 * It reads the canonical CFG, dominance, post-dominance and the P8-4 loop facts,
 * classifies each edge, and publishes the classification together with the
 * regions it implies. `lostCfgEdgeCount` is then a number a verifier can
 * recompute from the CFG alone, which is the point: the pass does not get to
 * mark its own work.
 *
 * Three rules follow from that.
 *
 * `gotoCount = 0` is not a goal and is not a gate. A correct `goto` beats a
 * false `while` every time, so an edge that cannot be structured safely is
 * accounted as a residual jump and left alone.
 *
 * An edge whose kind this pass does not recognise — an unwind edge, an indirect
 * candidate, anything a later phase adds — is never quietly folded into a
 * structured construct. It becomes an explicit constraint on the region that
 * contains it.
 *
 * A region is not split to make it structurable unless duplicating it is
 * provably free of observable effects, and even then this checkpoint only
 * publishes the candidate. Duplicating a call or a store to tidy a diamond is
 * the merge blocker this pass exists to avoid.
 */

import { createPassDescriptor, createPassResult } from './contract.js';

export const STRUCTURING_PASS = createPassDescriptor({
  id: 'phase8.structuring',
  version: '1.0.0',
  stage: 'structuring',
  budgetClass: 'standard',
  consumes: ['cfg', 'dominators', 'loops', 'ssa', 'induction'],
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'valueNumbers', 'deadCode', 'induction', 'types', 'aggregates', 'summaries', 'providerHints', 'origins'],
  invalidates: [],
  produces: ['structuredRegions'],
  description: 'Accounts for every CFG edge as a structured construct, an explicit jump or an explicit unknown, and publishes the regions that follow.',
});

export const STRUCTURING_SUMMARY_VERSION = 1;

/**
 * Edge kinds that describe ordinary structured control transfer.
 *
 * Anything outside this set is a constraint, not a candidate for structuring.
 * The set is deliberately closed: a kind added by a later phase — an unwind
 * edge, an exception edge — must be handled deliberately rather than inherit
 * whatever the fallback branch happens to do.
 */
const STRUCTURED_EDGE_KINDS = new Set([
  'branch', 'fallthrough', 'conditional-true', 'conditional-false', 'switch-case', 'switch-default',
]);

/** Constructs an edge may be accounted by. `unknown` is a real answer. */
export const EDGE_CONSTRUCTS = Object.freeze([
  'sequence',
  'if-branch',
  'if-join',
  'switch-case',
  'switch-join',
  'loop-entry',
  'loop-body',
  'loop-back-edge',
  'loop-guard-exit',
  'loop-break',
  'residual-goto',
  'constraint-edge',
  'unknown',
]);

/** Constructs that mean "an explicit jump survived here". Never a gate. */
const GOTO_CONSTRUCTS = new Set(['residual-goto']);

/** Operations whose duplication would duplicate something observable. */
const OBSERVABLE_OPS = new Set(['store', 'call', 'ret', 'clobber', 'unknown', 'intrinsic', 'trap', 'fence', 'syscall', 'load']);

const DEFAULT_LIMITS = Object.freeze({ maxBlocks: 4096, maxChainWalk: 4096 });

function originIdsOf(node) {
  const ids = node?.origin?.instructionIds;
  return Array.isArray(ids) ? ids : [];
}

function listOf(collection) {
  if (collection == null) return [];
  if (Array.isArray(collection)) return [...collection];
  if (typeof collection[Symbol.iterator] === 'function') return [...collection];
  return [];
}

/** Reads a relation off upstream sets, falling back to the upstream tree. */
function createRelation(sets, tree, limits) {
  return function relates(ancestor, node) {
    if (ancestor == null || node == null) return null;
    const set = sets?.[node];
    if (set != null) {
      if (typeof set.has === 'function') return set.has(ancestor);
      if (Array.isArray(set)) return set.includes(ancestor);
    }
    if (tree == null) return null;
    let current = node;
    for (let step = 0; current != null && current >= 0 && step <= limits.maxChainWalk; step += 1) {
      if (current === ancestor) return true;
      const next = tree[current];
      if (next == null || next === current) return false;
      current = next;
    }
    return false;
  };
}

/**
 * The successor edges of a block: one record per distinct target, carrying every
 * kind the projection declared for it.
 *
 * The upstream CFG labels the not-taken arm of a conditional twice — once
 * `conditional-false` and once `fallthrough` — for the same target. Those are
 * two names for one edge, not two edges. Counting them separately would inflate
 * the edge total and, worse, would let the accounting agree with itself while
 * disagreeing with the CFG. So targets are merged and every label is kept: no
 * kind is dropped, and the edge count matches `succ`.
 */
export function successorEdgesOf(block) {
  const merged = new Map();
  const add = (to, kind) => {
    if (to == null) return;
    if (!merged.has(to)) merged.set(to, new Set());
    merged.get(to).add(kind);
  };
  for (const edge of block?.successorEdges ?? []) add(edge?.to, edge?.kind ?? 'branch');
  for (const to of block?.succ ?? []) if (!merged.has(to)) add(to, 'branch');
  return [...merged.entries()].map(([to, kinds]) => ({ to, kinds: [...kinds].sort() }));
}

function terminatorOf(block) {
  const insts = block?.insts ?? [];
  for (let index = insts.length - 1; index >= 0; index -= 1) {
    const op = insts[index]?.op;
    if (op === 'cbr' || op === 'br' || op === 'ret' || op === 'switch') return insts[index];
  }
  return null;
}

/**
 * Classifies one edge.
 *
 * Exported because the classification is the whole contract, and a rule that can
 * only be exercised through a full pass run is a rule nobody tests properly.
 */
export function classifyEdge(edge, context) {
  const { from, to } = edge;
  const kinds = edge.kinds ?? [edge.kind];
  const { byIndex, loopsByHeader, innermostLoopOf, postDominates, ipdom } = context;

  // 1. A kind this pass does not recognise makes the whole edge a constraint,
  //    even if another label on it looks ordinary. Folding an unwind edge into
  //    an `if` because it also carries a `branch` label is how an exception path
  //    disappears.
  const foreign = kinds.filter((kind) => !STRUCTURED_EDGE_KINDS.has(kind));
  if (foreign.length > 0) {
    return {
      construct: 'constraint-edge',
      reason: `edge kind ${foreign.map((kind) => `"${kind}"`).join(', ')} is not ordinary structured control transfer, so the edge is preserved as a constraint on the enclosing region`,
    };
  }

  const enclosing = innermostLoopOf(from);

  // 2. An edge inside an irreducible region is emitted as an explicit jump. The
  //    region has more than one entry, so no loop construct describes it.
  if (enclosing != null && enclosing.classification !== 'natural') {
    return {
      construct: 'residual-goto',
      reason: `block ${from} is inside a region classified ${enclosing.classification}, which no loop construct describes`,
    };
  }

  // 3. Back edge: the latch returning to its header.
  const targetLoop = loopsByHeader.get(to) ?? null;
  if (targetLoop != null && targetLoop.classification === 'natural' && targetLoop.latches.includes(from)) {
    return { construct: 'loop-back-edge', reason: `latch ${from} returns to header ${to}` };
  }

  // 4. Leaving a loop.
  const exitedLoop = context.loopExitedBy(from, to);
  if (exitedLoop != null) {
    if (exitedLoop.classification !== 'natural') {
      return { construct: 'residual-goto', reason: `the loop at header ${exitedLoop.header} is ${exitedLoop.classification}` };
    }
    if (from === exitedLoop.guardBlock) {
      return { construct: 'loop-guard-exit', reason: `the loop guard at block ${from} leaves the loop at header ${exitedLoop.header}` };
    }
    // The guard's own exit is the loop's normal way out; `break` is what every
    // other exit means, and it only says where to go if they all agree.
    const breakTargets = new Set(exitedLoop.exitEdges
      .filter((exit) => exit.from !== exitedLoop.guardBlock)
      .map((exit) => exit.to));
    if (breakTargets.size === 1) {
      return { construct: 'loop-break', reason: `block ${from} breaks out of the loop at header ${exitedLoop.header} to its single break target` };
    }
    return {
      construct: 'residual-goto',
      reason: `the loop at header ${exitedLoop.header} is left at ${breakTargets.size} different blocks besides its guard exit, so this exit is not a plain break`,
    };
  }

  // 5. Entering a loop from outside it.
  if (targetLoop != null && !targetLoop.nodes.includes(from)) {
    if (targetLoop.classification !== 'natural') {
      return { construct: 'residual-goto', reason: `the region at header ${to} is ${targetLoop.classification}` };
    }
    return { construct: 'loop-entry', reason: `block ${from} enters the loop at header ${to}` };
  }

  // 5b. The loop guard's other arm: it stays in the loop, so it is the body,
  //     not an unrelated `if`.
  if (enclosing != null && from === enclosing.guardBlock && enclosing.nodes.includes(to)) {
    return { construct: 'loop-body', reason: `the guard at block ${from} enters the body of the loop at header ${enclosing.header}` };
  }

  const block = byIndex.get(from);
  const successors = successorEdgesOf(block);
  const join = ipdom?.[from] ?? null;

  // 6. A switch. Cases that do not converge on the join are explicit jumps.
  const terminator = terminatorOf(block);
  if (terminator?.op === 'switch' || kinds.includes('switch-case') || kinds.includes('switch-default')) {
    if (join == null) return { construct: 'residual-goto', reason: `the switch at block ${from} has no common join point` };
    if (to === join) return { construct: 'switch-join', reason: `block ${to} is the join of the switch at block ${from}` };
    if (postDominates(join, to) === true) return { construct: 'switch-case', reason: `case block ${to} converges on join ${join}` };
    return { construct: 'residual-goto', reason: `case block ${to} does not converge on the switch join ${join}` };
  }

  // 7. A two-way conditional. Without a join point there is no `if` region, and
  //    an arm that does not reach the join is not one either.
  if (successors.length === 2) {
    if (join == null) {
      // No join point does not automatically mean no `if`. `if (c) return a;`
      // has arms that never meet again inside the function, and that is an
      // ordinary conditional with an early return — provided they really never
      // meet. If they share any post-dominator the shape is something else and
      // an explicit jump is the honest answer.
      const [first, second] = successors.map((edge) => edge.to);
      const shared = context.sharedPostDominator(first, second);
      if (shared === null) {
        return { construct: 'if-branch', reason: `the arms of block ${from} never meet again; each leaves the function on its own path` };
      }
      return { construct: 'residual-goto', reason: `the conditional at block ${from} has no immediate join even though its arms meet at block ${shared}` };
    }
    if (to === join) return { construct: 'if-join', reason: `block ${to} is the join of the conditional at block ${from}` };
    if (postDominates(join, to) === true) return { construct: 'if-branch', reason: `arm ${to} converges on join ${join}` };
    return { construct: 'residual-goto', reason: `arm ${to} does not converge on the join ${join} of block ${from}` };
  }

  // 8. One successor is a sequence, whatever else merges into the target.
  if (successors.length === 1) {
    return { construct: 'sequence', reason: `block ${from} continues into block ${to}` };
  }

  return {
    construct: 'unknown',
    reason: `block ${from} has ${successors.length} successors and no construct this pass recognises`,
  };
}

/**
 * Accounts for every edge in the CFG.
 *
 * Returns one record per edge, in a deterministic order. Nothing is filtered:
 * the count of records is the count of edges, which is what makes the
 * independent recount in the verifier meaningful.
 */
export function accountEdges(context) {
  const records = [];
  for (const index of context.blockOrder) {
    const block = context.byIndex.get(index);
    for (const edge of successorEdgesOf(block)) {
      const input = { from: index, to: edge.to, kinds: edge.kinds };
      const { construct, reason } = classifyEdge(input, context);
      records.push(Object.freeze({
        from: index,
        to: edge.to,
        kinds: Object.freeze([...edge.kinds]),
        construct,
        reason,
        origin: Object.freeze({ instructionIds: Object.freeze(originIdsOf(block)) }),
      }));
    }
  }
  return records;
}

/** Whether duplicating a block would duplicate something observable. */
export function observableEffectsIn(block) {
  const reasons = [];
  for (const instruction of block?.insts ?? []) {
    if (OBSERVABLE_OPS.has(instruction?.op)) reasons.push(`${instruction.op}/${instruction.sub ?? '-'}`);
  }
  return reasons;
}

/**
 * Publishes the structured-region facts.
 *
 * Rewrites nothing. What it produces is the accounting, the regions the
 * accounting implies, the residual jumps it could not remove and would not
 * pretend away, and node-split candidates that are provably safe to consider.
 */
export function runStructuringPass(context = {}, budget = {}, area = null) {
  if (area == null) throw new TypeError('phase8-structuring-requires-staging-area');
  const analysis = context.analysis;
  const cfg = analysis?.get('cfg');
  const dominatorFacts = analysis?.get('dominators');
  const inductionFacts = analysis?.get('induction');
  const limits = { ...DEFAULT_LIMITS, ...(budget.limits ?? {}) };

  const blocks = (cfg?.blocks ?? []).slice(0, limits.maxBlocks);
  const byIndex = new Map(blocks.map((block) => [block.index, block]));
  const blockOrder = blocks.map((block) => block.index).sort((left, right) => left - right);
  const postDominates = createRelation(dominatorFacts?.postDominators, dominatorFacts?.ipdom, limits);
  const ipdom = dominatorFacts?.ipdom ?? null;

  // Loop facts come from P8-4. This pass does not re-derive loops, latches,
  // exits or guards; it consumes the artifact that already proved them.
  const loops = (inductionFacts?.loops ?? []).map((loop) => ({
    header: loop.header,
    classification: loop.classification,
    latches: [...loop.latches],
    nodes: [...loop.nodes],
    exitEdges: [...loop.exitEdges],
    guardBlock: loop.guardBlock,
    depth: loop.depth,
    parentHeader: loop.parentHeader,
  }));
  const loopsByHeader = new Map(loops.map((loop) => [loop.header, loop]));
  const nodeSets = new Map(loops.map((loop) => [loop.header, new Set(loop.nodes)]));

  const innermostLoopOf = (index) => {
    let best = null;
    for (const loop of loops) {
      if (!nodeSets.get(loop.header).has(index)) continue;
      if (best == null || loop.nodes.length < best.nodes.length) best = loop;
    }
    return best;
  };
  // The loop an edge actually leaves: the smallest one containing the source and
  // not the target. A nested edge leaves the inner loop, not the outer.
  const loopExitedBy = (from, to) => {
    let best = null;
    for (const loop of loops) {
      const nodes = nodeSets.get(loop.header);
      if (!nodes.has(from) || nodes.has(to)) continue;
      if (best == null || loop.nodes.length < best.nodes.length) best = loop;
    }
    return best;
  };

  const abortedNow = () => {
    try { return typeof budget.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  // A block that post-dominates both arms, if there is one. Read off the
  // upstream post-dominator sets; nothing is recomputed here.
  const postDominatorSets = dominatorFacts?.postDominators ?? null;
  const sharedPostDominator = (left, right) => {
    const leftSet = postDominatorSets?.[left];
    const rightSet = postDominatorSets?.[right];
    if (leftSet == null || rightSet == null) return undefined; // Not known.
    const candidates = [...leftSet].filter((block) => block !== left && block !== right
      && (typeof rightSet.has === 'function' ? rightSet.has(block) : [...rightSet].includes(block)));
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => a - b)[0];
  };

  const accountingContext = { byIndex, blockOrder, loopsByHeader, innermostLoopOf, loopExitedBy, postDominates, ipdom, sharedPostDominator };
  const edges = abortedNow() ? [] : accountEdges(accountingContext);
  const budgetExhausted = abortedNow();

  const byConstruct = new Map(EDGE_CONSTRUCTS.map((construct) => [construct, 0]));
  for (const record of edges) byConstruct.set(record.construct, (byConstruct.get(record.construct) ?? 0) + 1);

  const residualGotoEdges = edges.filter((record) => GOTO_CONSTRUCTS.has(record.construct));
  const constraintEdges = edges.filter((record) => record.construct === 'constraint-edge');
  const unknownEdges = edges.filter((record) => record.construct === 'unknown');

  // Regions. A loop region per loop the artifact proved; a conditional or switch
  // region per branching block that has a join. Nothing is invented for a block
  // whose shape was not established.
  const regions = [];
  for (const loop of loops) {
    const exits = [...new Set(loop.exitEdges.map((edge) => edge.to))].sort((left, right) => left - right);
    regions.push(Object.freeze({
      kind: loop.classification === 'natural' ? 'loop' : 'irreducible',
      entry: loop.header,
      exits: Object.freeze(exits),
      members: Object.freeze([...loop.nodes].sort((left, right) => left - right)),
      depth: loop.depth,
      parentEntry: loop.parentHeader,
      // Edges the region must honour but no construct describes.
      constraints: Object.freeze(constraintEdges.filter((edge) => nodeSets.get(loop.header).has(edge.from))
        .map((edge) => `${edge.from}->${edge.to}:${edge.kinds.join('|')}`)),
      residualGotos: Object.freeze(residualGotoEdges.filter((edge) => nodeSets.get(loop.header).has(edge.from))
        .map((edge) => `${edge.from}->${edge.to}`)),
      origin: Object.freeze({ instructionIds: Object.freeze([...new Set(loop.nodes.flatMap((index) => originIdsOf(byIndex.get(index))))].sort()) }),
    }));
  }
  for (const index of blockOrder) {
    const block = byIndex.get(index);
    const successors = successorEdgesOf(block);
    if (successors.length < 2) continue;
    if (loopsByHeader.has(index) && loopsByHeader.get(index).guardBlock === index) continue;
    const terminator = terminatorOf(block);
    const isSwitch = terminator?.op === 'switch' || successors.some((edge) => edge.kinds.includes('switch-case') || edge.kinds.includes('switch-default'));
    const join = ipdom?.[index] ?? null;
    if (join == null) continue;
    regions.push(Object.freeze({
      kind: isSwitch ? 'switch' : 'conditional',
      entry: index,
      exits: Object.freeze([join]),
      members: Object.freeze(successors.map((edge) => edge.to).filter((target) => target !== join).sort((left, right) => left - right)),
      depth: innermostLoopOf(index)?.depth ?? null,
      parentEntry: innermostLoopOf(index)?.header ?? null,
      constraints: Object.freeze(constraintEdges.filter((edge) => edge.from === index).map((edge) => `${edge.from}->${edge.to}:${edge.kinds.join('|')}`)),
      residualGotos: Object.freeze(residualGotoEdges.filter((edge) => edge.from === index).map((edge) => `${edge.from}->${edge.to}`)),
      origin: Object.freeze({ instructionIds: Object.freeze(originIdsOf(block)) }),
    }));
  }
  regions.sort((left, right) => (left.entry - right.entry) || left.kind.localeCompare(right.kind));

  // Node-split candidates. A split is only ever *offered*: it is applied by
  // nobody in this checkpoint. A block carrying an observable effect is not
  // offered at all, because duplicating it would duplicate the effect.
  const splitCandidates = [];
  const gotoTargets = new Map();
  for (const record of residualGotoEdges) {
    if (!gotoTargets.has(record.to)) gotoTargets.set(record.to, []);
    gotoTargets.get(record.to).push(record);
  }
  for (const [target, records] of [...gotoTargets.entries()].sort((left, right) => left[0] - right[0])) {
    const block = byIndex.get(target);
    if (block == null) continue;
    const effects = observableEffectsIn(block);
    splitCandidates.push(Object.freeze({
      blockIndex: target,
      predecessorCount: (block.pred ?? []).length,
      gotoEdges: Object.freeze(records.map((record) => `${record.from}->${record.to}`)),
      observableEffects: Object.freeze(effects),
      offered: effects.length === 0,
      proof: effects.length === 0
        ? `block ${target} contains no store, call, load or unrepresented operation, so a copy of it would compute the same values with no second observable effect`
        : `block ${target} would duplicate observable operations (${[...new Set(effects)].join(', ')}), so it is not offered for splitting`,
      origin: Object.freeze({ instructionIds: Object.freeze(originIdsOf(block)) }),
    }));
  }

  const facts = Object.freeze({
    contractVersion: STRUCTURING_PASS.contractVersion,
    passVersion: STRUCTURING_PASS.version,
    summaryVersion: STRUCTURING_SUMMARY_VERSION,
    blockCount: blocks.length,
    edgeCount: edges.length,
    edges: Object.freeze(edges),
    edgesByConstruct: Object.freeze(Object.fromEntries([...byConstruct.entries()].sort())),
    regions: Object.freeze(regions),
    // Reported, never gated. A correct jump is a better answer than a false
    // loop, so driving this number down is not an objective.
    residualGotoCount: residualGotoEdges.length,
    constraintEdgeCount: constraintEdges.length,
    unknownEdgeCount: unknownEdges.length,
    splitCandidates: Object.freeze(splitCandidates),
    completeness: budgetExhausted ? 'partial' : 'complete',
  });
  area.stage('structuredRegions', facts);

  const diagnostics = [];
  if (budgetExhausted) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.structuring.budget',
      message: 'Edge accounting stopped before every edge was classified.',
      reason: 'The pass was cancelled; the accounting published is incomplete and must not be read as proof that no edge was lost.',
    });
  }
  if (constraintEdges.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.structuring.constraint-edges',
      message: `${constraintEdges.length} edge(s) are constraints rather than structured control transfer.`,
      reason: [...new Set(constraintEdges.flatMap((edge) => edge.kinds))].slice(0, 4).join('; '),
    });
  }
  if (residualGotoEdges.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.structuring.residual-goto',
      message: `${residualGotoEdges.length} edge(s) remain explicit jumps.`,
      reason: [...new Set(residualGotoEdges.map((edge) => edge.reason))].slice(0, 4).join('; '),
    });
  }
  if (unknownEdges.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.structuring.unknown-edges',
      message: `${unknownEdges.length} edge(s) could not be classified at all.`,
      reason: [...new Set(unknownEdges.map((edge) => edge.reason))].slice(0, 4).join('; '),
    });
  }

  return createPassResult({
    descriptor: STRUCTURING_PASS,
    status: 'changed',
    changed: true,
    completeness: facts.completeness,
    transforms: [],
    produced: ['structuredRegions'],
    diagnostics,
    invalidated: [],
  });
}

/**
 * The independent edge-accounting check.
 *
 * Recomputes the edge set straight from the CFG and compares it with what the
 * pass published. The pass does not get to mark its own work: an edge the
 * accounting never mentions, or mentions twice, is reported here.
 */
export function edgeAccountingFailures(ir, facts) {
  const failures = [];
  if (facts == null) {
    return [{ problem: 'no-accounting', detail: 'the structuring pass published nothing for this function' }];
  }
  const seen = new Map();
  for (const record of facts.edges) {
    const key = `${record.from}->${record.to}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!EDGE_CONSTRUCTS.includes(record.construct)) {
      failures.push({ problem: 'unknown-construct', detail: `${key} was accounted as "${record.construct}"` });
    }
    if (record.reason == null || record.reason.length === 0) {
      failures.push({ problem: 'no-reason', detail: `${key} was accounted with no reason` });
    }
  }
  // The expectation is rebuilt from the CFG's own successor list and its
  // declared edge labels, independently of how the pass merged them. Reusing the
  // pass's own view here would let it agree with itself.
  const expected = new Map();
  for (const block of ir?.blocks ?? []) {
    for (const target of block.succ ?? []) {
      if (target == null) continue;
      const key = `${block.index}->${target}`;
      if (!expected.has(key)) expected.set(key, new Set());
    }
    for (const edge of block.successorEdges ?? []) {
      if (edge?.to == null) continue;
      const key = `${block.index}->${edge.to}`;
      if (!expected.has(key)) expected.set(key, new Set());
      expected.get(key).add(edge.kind ?? 'branch');
    }
  }
  const recorded = new Map(facts.edges.map((record) => [`${record.from}->${record.to}`, new Set(record.kinds ?? [])]));
  for (const [key, kinds] of expected) {
    if (!seen.has(key)) {
      failures.push({ problem: 'unaccounted-edge', detail: `${key} is in the CFG and not in the accounting` });
      continue;
    }
    for (const kind of kinds) {
      if (!recorded.get(key)?.has(kind)) {
        failures.push({ problem: 'dropped-edge-kind', detail: `${key} is declared "${kind}" in the CFG and the accounting does not carry that kind` });
      }
    }
  }
  for (const [key, count] of seen) {
    if (!expected.has(key)) failures.push({ problem: 'invented-edge', detail: `${key} was accounted but is not in the CFG` });
    else if (count > 1) failures.push({ problem: 'duplicated-edge', detail: `${key} was accounted ${count} times` });
  }
  return failures;
}

/** A readable summary of one function's accounting, for evidence. */
export function describeStructuring(facts) {
  if (facts == null) return 'no structuring facts';
  const parts = Object.entries(facts.edgesByConstruct).filter(([, count]) => count > 0).map(([construct, count]) => `${construct} ${count}`);
  return `${facts.edgeCount} edges: ${parts.join(', ')}`;
}
