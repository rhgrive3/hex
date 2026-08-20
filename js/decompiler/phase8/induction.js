/**
 * Loop induction and loop simplification facts.
 *
 * This pass answers one question per loop: which SSA values advance by a fixed
 * amount every time round, and what — if anything — can be proved about where
 * they start, where they stop and how many times the loop runs.
 *
 * Three rules shape the whole file.
 *
 * The first is that it does not detect loops. The CFG, the dominator facts and
 * the loop set all arrive from the canonical upstream analysis; this pass reads
 * them. What it does add is a *check*: a loop record is only treated as a
 * natural loop when the dominator facts actually say the header dominates every
 * node in it. An irreducible region that reached here would otherwise be given
 * an init/step/trip-count it does not have, which is exactly the false
 * confidence P8-4 forbids.
 *
 * The second is that exit edges are preserved exactly, kind and all. Structuring
 * (P8-5) consumes this artifact, and a loop fact that has quietly forgotten an
 * unwinding edge is how a decompiler draws a tidy `while` around code that can
 * leave three other ways.
 *
 * The third is that every refusal states its reason. "Step unknown" and "step
 * not looked at" are different facts, and a consumer that cannot tell them apart
 * will eventually treat one as the other.
 *
 * Like the other Phase 8 optimizer passes so far, this one produces facts and
 * transforms nothing. Loop simplification candidates are published with their
 * proofs for P8-5/P8-6 to consume; the rewrite itself is not this checkpoint's
 * job, and doing it here would put a second induction analyzer inside aggregate
 * recovery later — the merge blocker this artifact exists to prevent.
 */

import { maxSigned, maxUnsigned, minSigned, signedOf, unsignedOf } from './bitvector.js';
import { createPassDescriptor, createPassResult } from './contract.js';

export const INDUCTION_PASS = createPassDescriptor({
  id: 'phase8.induction',
  version: '1.0.0',
  stage: 'loop-facts',
  budgetClass: 'standard',
  // Loops and dominators come from upstream. Ranges come from P8-2 and are what
  // lets a bound be reported as a proved constant rather than a rendered guess.
  consumes: ['cfg', 'dominators', 'loops', 'ssa', 'ranges'],
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'valueNumbers', 'deadCode', 'types', 'aggregates', 'summaries', 'origins', 'structuredRegions', 'providerHints'],
  invalidates: [],
  produces: ['induction'],
  description: 'Derives induction, bound and trip facts for each upstream natural loop, and refuses the loops it cannot prove.',
});

/** The artifact shape version, separate from the pass version. */
export const INDUCTION_SUMMARY_VERSION = 1;

/**
 * Comparison predicates this pass can read.
 *
 * A predicate that is not in this table is not guessed at. `cmp/sub` — a flag
 * computation whose meaning depends on which flag a later branch reads — is
 * deliberately absent: reading it would require knowing an architecture's
 * condition codes, and the generic optimizer is not allowed to know that.
 */
const PREDICATES = Object.freeze({
  eq: { signedness: 'unknown', mirror: 'eq', negation: 'ne' },
  ne: { signedness: 'unknown', mirror: 'ne', negation: 'eq' },
  ult: { signedness: 'unsigned', mirror: 'ugt', negation: 'uge' },
  ule: { signedness: 'unsigned', mirror: 'uge', negation: 'ugt' },
  ugt: { signedness: 'unsigned', mirror: 'ult', negation: 'ule' },
  uge: { signedness: 'unsigned', mirror: 'ule', negation: 'ult' },
  slt: { signedness: 'signed', mirror: 'sgt', negation: 'sge' },
  sle: { signedness: 'signed', mirror: 'sge', negation: 'sgt' },
  sgt: { signedness: 'signed', mirror: 'slt', negation: 'sle' },
  sge: { signedness: 'signed', mirror: 'sle', negation: 'slt' },
});

/** Casts change where the value wraps, so an update behind one is not a step. */
const WIDTH_CASTS = new Set(['trunc', 'zext', 'sext', 'zx', 'sx']);

const DEFAULT_LIMITS = Object.freeze({ maxCopyChain: 8, maxLoops: 512, maxPhisPerLoop: 256 });

function argValue(instruction, index) {
  return instruction?.args?.[index]?.value ?? null;
}

function originIdsOf(node) {
  const ids = node?.origin?.instructionIds;
  return Array.isArray(ids) ? ids : [];
}

/** A dominator query answered from upstream facts, never recomputed. */
function createDominance(dominators) {
  const sets = dominators?.dominators ?? null;
  const idom = dominators?.idom ?? null;
  return function dominates(ancestor, node) {
    const set = sets?.[node];
    if (set != null) {
      if (typeof set.has === 'function') return set.has(ancestor);
      if (Array.isArray(set)) return set.includes(ancestor);
    }
    if (idom == null) return null; // Unknown, which is not the same as false.
    let current = node;
    for (let step = 0; current != null && current >= 0 && step <= 4096; step += 1) {
      if (current === ancestor) return true;
      const next = idom[current];
      if (next == null || next === current) return false;
      current = next;
    }
    return false;
  };
}

function nodeSetOf(loop) {
  const nodes = loop?.nodes;
  if (nodes == null) return null;
  if (typeof nodes.has === 'function') return nodes;
  if (Array.isArray(nodes)) return new Set(nodes);
  return null;
}

function listOf(collection) {
  if (collection == null) return [];
  if (Array.isArray(collection)) return [...collection];
  if (typeof collection[Symbol.iterator] === 'function') return [...collection];
  return [];
}

function sortedNumbers(values) {
  return Object.freeze([...new Set(values)].sort((left, right) => left - right));
}

/**
 * Classifies one upstream loop record against the dominator facts.
 *
 * `natural` means the header dominates every node and every latch branches back
 * to the header. `irreducible` means it does not — a region with more than one
 * entry, which has no single init point and therefore no induction variable in
 * the sense this artifact reports. `unverified` means the facts needed to decide
 * were not available, which is reported as its own answer rather than folded
 * into either of the others.
 */
export function classifyLoop(loop, { byIndex, dominates }) {
  const header = loop?.header;
  if (header == null || !byIndex.has(header)) {
    return { classification: 'unverified', reason: 'the loop record names no header block in this CFG' };
  }
  const nodes = nodeSetOf(loop);
  if (nodes == null || nodes.size === 0) {
    return { classification: 'unverified', reason: 'the loop record carries no node set' };
  }
  for (const node of [...nodes].sort((left, right) => left - right)) {
    if (!byIndex.has(node)) {
      return { classification: 'unverified', reason: `the loop names block ${node}, which is not in this CFG` };
    }
    const dominated = dominates(header, node);
    if (dominated == null) {
      return { classification: 'unverified', reason: `dominance of block ${node} by header ${header} is not available` };
    }
    if (dominated !== true) {
      // A node inside the region that the header does not dominate is a second
      // entry. Calling this a natural loop would invent an initialization point.
      return { classification: 'irreducible', reason: `block ${node} is reachable without passing through header ${header}` };
    }
  }
  const latches = listOf(loop.latches);
  if (latches.length === 0) return { classification: 'unverified', reason: 'the loop record carries no latch' };
  for (const latch of latches) {
    if (!nodes.has(latch)) return { classification: 'unverified', reason: `latch ${latch} is not inside the loop body` };
    if (!(byIndex.get(latch)?.succ ?? []).includes(header)) {
      return { classification: 'unverified', reason: `latch ${latch} does not branch to header ${header}` };
    }
  }
  return { classification: 'natural', reason: null };
}

/**
 * Every edge that leaves the loop, with its kind intact.
 *
 * The kinds matter: a `conditional-false` exit and an exception edge are both
 * exits, and only one of them can become the `while` condition. Dropping either
 * is the P8-5 merge blocker.
 */
function exitEdgesOf(loop, nodes, byIndex) {
  const edges = [];
  for (const index of [...nodes].sort((left, right) => left - right)) {
    const block = byIndex.get(index);
    if (block == null) continue;
    const declared = Array.isArray(block.successorEdges) && block.successorEdges.length > 0
      ? block.successorEdges
      : (block.succ ?? []).map((to) => ({ to, kind: 'branch' }));
    for (const edge of declared) {
      if (edge?.to == null || nodes.has(edge.to)) continue;
      edges.push(Object.freeze({ from: index, to: edge.to, kind: edge.kind ?? 'branch' }));
    }
  }
  return Object.freeze(edges);
}

function terminatorOf(block) {
  const insts = block?.insts ?? [];
  for (let index = insts.length - 1; index >= 0; index -= 1) {
    const instruction = insts[index];
    if (instruction?.op === 'cbr' || instruction?.op === 'br' || instruction?.op === 'ret') return instruction;
  }
  return null;
}

/** Follows same-width copies. A copy is not a step; a cast is not transparent. */
function unwrapCopies(value, limits) {
  const chain = [];
  let current = value;
  for (let step = 0; step < limits.maxCopyChain; step += 1) {
    const definition = current?.def;
    if (definition?.op !== 'mov') break;
    if (definition.sub != null) break;
    const source = argValue(definition, 0);
    if (source == null || source.bits !== current.bits) break;
    chain.push(definition);
    current = source;
  }
  return { value: current, chain };
}

function sameValue(left, right) {
  return left != null && right != null && left.id === right.id;
}

/** A constant from the IR, or from the constants P8-2 proved. */
function constantOf(value, rangeFacts) {
  if (value == null) return null;
  if (value.const != null) return BigInt(value.const);
  const proven = rangeFacts?.constants?.get?.(value.id) ?? null;
  if (proven != null && proven.value != null) return BigInt(proven.value);
  return null;
}

/**
 * Resolves the loop-carried update of one phi into a step.
 *
 * Answers with a reason on every path. `step: null` with no reason would be a
 * fact nobody can act on.
 */
export function resolveStep(incomingValue, phiValue, { rangeFacts = null, limits = DEFAULT_LIMITS } = {}) {
  const { value: resolved, chain } = unwrapCopies(incomingValue, limits);
  const origins = chain.flatMap((instruction) => originIdsOf(instruction));
  const definition = resolved?.def ?? null;
  if (definition == null) {
    return { step: null, reason: 'the loop-carried value has no defining operation in this function', origins, copies: chain.length };
  }
  if (definition.op === 'mov' && WIDTH_CASTS.has(definition.sub)) {
    // A widening or narrowing cast between the add and the phi moves the point
    // at which the counter wraps, so the arithmetic below would be arithmetic
    // about a different value.
    return { step: null, reason: `the update passes through a ${definition.sub} cast, which moves the wrap boundary`, origins, copies: chain.length };
  }
  if (definition.op !== 'bin' || (definition.sub !== 'add' && definition.sub !== 'sub')) {
    return { step: null, reason: `the update is ${definition.op}/${definition.sub ?? '-'}, not an add or a subtract`, origins, copies: chain.length };
  }
  const updateOrigins = [...origins, ...originIdsOf(definition)];
  const left = unwrapCopies(argValue(definition, 0), limits).value;
  const right = unwrapCopies(argValue(definition, 1), limits).value;
  const leftIsPhi = sameValue(left, phiValue);
  const rightIsPhi = sameValue(right, phiValue);
  if (!leftIsPhi && !rightIsPhi) {
    return { step: null, reason: 'the update does not read the loop variable', origins: updateOrigins, copies: chain.length };
  }
  if (definition.sub === 'sub' && rightIsPhi) {
    // `c - i` reverses the variable rather than advancing it.
    return { step: null, reason: 'the update subtracts the loop variable from a value, which is not a monotone step', origins: updateOrigins, copies: chain.length };
  }
  const other = leftIsPhi ? right : left;
  const constant = constantOf(other, rangeFacts);
  if (constant == null) {
    return { step: null, reason: 'the step is a variable value', origins: updateOrigins, copies: chain.length, update: resolved };
  }
  const bits = phiValue?.bits ?? resolved?.bits ?? null;
  if (bits == null) {
    return { step: null, reason: 'the loop variable has no declared width', origins: updateOrigins, copies: chain.length, update: resolved };
  }
  const magnitude = signedOf(constant, bits);
  const step = definition.sub === 'sub' ? -magnitude : magnitude;
  return { step, reason: null, origins: updateOrigins, copies: chain.length, update: resolved };
}

/**
 * Reads a comparison out of a branch condition, or says why it could not.
 *
 * Three generic shapes are understood, and only three. A one-bit logical `not`
 * inverts the sense of whatever it wraps. `is-zero(a - b)` is `a == b` at any
 * width, because the subtract is modular and wraps to zero exactly when the two
 * are equal. A `bin` whose sub is one of the named predicates is that predicate.
 *
 * `cmp/sub` and a comparison against extracted flag bits are deliberately not
 * understood: their meaning depends on which condition flag the branch reads,
 * and that is architecture knowledge the generic optimizer must not contain.
 * Refusing them costs a trip count; guessing them would cost correctness.
 */
export function readGuardPredicate(condition, limits = DEFAULT_LIMITS) {
  let negated = false;
  let current = condition;
  for (let depth = 0; depth <= limits.maxCopyChain; depth += 1) {
    const { value } = unwrapCopies(current, limits);
    const definition = value?.def ?? null;
    if (definition == null) return { predicate: null, negated, reason: 'the branch condition has no defining operation' };
    if (definition.op === 'un' && definition.sub === 'not' && value.bits === 1) {
      negated = !negated;
      current = argValue(definition, 0);
      continue;
    }
    if (definition.op === 'un' && definition.sub === 'is-zero') {
      const operand = unwrapCopies(argValue(definition, 0), limits).value;
      const inner = operand?.def ?? null;
      if (inner?.op === 'bin' && inner.sub === 'sub') {
        // `(a - b) == 0` is `a == b` for every width, wrapping included.
        return { predicate: 'eq', left: argValue(inner, 0), right: argValue(inner, 1), rightIsZero: false, negated, instruction: inner, reason: null };
      }
      return { predicate: 'eq', left: operand, right: null, rightIsZero: true, negated, instruction: definition, reason: null };
    }
    if (definition.op === 'bin' && Object.hasOwn(PREDICATES, definition.sub ?? '')) {
      return { predicate: definition.sub, left: argValue(definition, 0), right: argValue(definition, 1), rightIsZero: false, negated, instruction: definition, reason: null };
    }
    return { predicate: null, negated, reason: `the branch condition is ${definition.op}/${definition.sub ?? '-'}, which is not a comparison this pass reads` };
  }
  return { predicate: null, negated, reason: 'the branch condition nests deeper than this pass follows' };
}

function fitsWidth(value, bits, signedness) {
  if (signedness === 'signed') return value >= minSigned(bits) && value <= maxSigned(bits);
  return value >= 0n && value <= maxUnsigned(bits);
}

/**
 * Iteration count for a counted loop, or a reason it is not exact.
 *
 * Every guard here is a condition under which the closed form would be a lie:
 * the wrong direction, a step that never reaches the bound, or a counter that
 * wraps before the guard fails. Exactness is claimed only when all of them pass.
 */
export function tripCountOf({ predicate, init, bound, step, bits, signedness }) {
  if (step === 0n) return { exact: null, reason: 'the step is zero, so the loop variable never advances' };
  const interpret = (value) => (signedness === 'signed' ? signedOf(value, bits) : unsignedOf(value, bits));
  const start = interpret(init);
  const limit = interpret(bound);
  const ascending = step > 0n;
  let iterations = null;
  switch (predicate) {
    case 'ult': case 'slt':
      if (!ascending) return { exact: null, reason: 'the guard is an upper bound but the step decreases' };
      iterations = start >= limit ? 0n : (limit - start + step - 1n) / step;
      break;
    case 'ule': case 'sle':
      if (!ascending) return { exact: null, reason: 'the guard is an upper bound but the step decreases' };
      iterations = start > limit ? 0n : (limit - start) / step + 1n;
      break;
    case 'ugt': case 'sgt':
      if (ascending) return { exact: null, reason: 'the guard is a lower bound but the step increases' };
      iterations = start <= limit ? 0n : (start - limit + (-step) - 1n) / (-step);
      break;
    case 'uge': case 'sge':
      if (ascending) return { exact: null, reason: 'the guard is a lower bound but the step increases' };
      iterations = start < limit ? 0n : (start - limit) / (-step) + 1n;
      break;
    case 'ne': {
      const distance = limit - start;
      if (distance === 0n) { iterations = 0n; break; }
      if ((distance > 0n) !== ascending) {
        return { exact: null, reason: 'the step moves away from the bound, so an inequality guard may never fail' };
      }
      if (distance % step !== 0n) {
        return { exact: null, reason: 'the step does not divide the distance to the bound, so the guard is never exactly met' };
      }
      iterations = distance / step;
      break;
    }
    default:
      return { exact: null, reason: `predicate ${predicate ?? 'unknown'} does not bound the iteration count` };
  }
  const final = start + iterations * step;
  if (!fitsWidth(final, bits, signedness === 'signed' ? 'signed' : 'unsigned')) {
    return { exact: null, reason: 'the counter wraps its width before the guard fails' };
  }
  return { exact: iterations, reason: null };
}

/**
 * Value ids that appear as the base or index of a memory address.
 *
 * This is how a pointer induction variable is told from an integer one without
 * asking the type layer: the value the loop advances is the value a load or
 * store computes its address from. Copies are followed, because a copy of an
 * address is still that address.
 */
function addressOperandRoles(blocks, limits) {
  const roles = new Map();
  const record = (value, role) => {
    if (value?.id == null) return;
    if (role === 'index' || !roles.has(value.id)) roles.set(value.id, role);
    const { value: source } = unwrapCopies(value, limits);
    if (source?.id != null && (role === 'index' || !roles.has(source.id))) roles.set(source.id, role);
  };
  for (const block of blocks) {
    for (const instruction of block.insts ?? []) {
      const address = instruction?.addr;
      if (address == null) continue;
      record(address.base, 'base');
      record(address.index, 'index');
    }
  }
  return roles;
}

function weakest(values) {
  const rank = { complete: 2, partial: 1, unknown: 0 };
  return values.reduce((worst, value) => (rank[value] < rank[worst] ? value : worst), 'complete');
}

/**
 * Derives induction and loop facts for every upstream loop.
 *
 * Publishes `induction`. Transforms nothing.
 */
export function runInductionPass(context = {}, budget = {}, area = null) {
  const analysis = context.analysis;
  if (area == null) throw new TypeError('phase8-induction-requires-staging-area');
  const cfg = analysis?.get('cfg');
  const ssa = analysis?.get('ssa');
  const loopFacts = analysis?.get('loops');
  const rangeFacts = analysis?.get('ranges');
  const dominates = createDominance(analysis?.get('dominators'));
  const limits = { ...DEFAULT_LIMITS, ...(budget.limits ?? {}) };

  const blocks = cfg?.blocks ?? [];
  const byIndex = new Map(blocks.map((block) => [block.index, block]));
  const upstreamLoops = listOf(loopFacts?.loops);
  const addressRoles = addressOperandRoles(blocks, limits);
  const valueById = new Map((ssa?.values ?? []).map((value) => [value.id, value]));

  const abortedNow = () => {
    try { return typeof budget.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  // Nesting is read off the node sets that arrived, not rediscovered from the
  // CFG: the parent of a loop is the smallest other loop that contains all of
  // its blocks.
  const prepared = upstreamLoops.slice(0, limits.maxLoops).map((loop) => ({ loop, nodes: nodeSetOf(loop) }));
  const parentOf = new Map();
  for (const entry of prepared) {
    if (entry.nodes == null) continue;
    let best = null;
    for (const other of prepared) {
      if (other === entry || other.nodes == null) continue;
      if (other.nodes.size <= entry.nodes.size) continue;
      if (![...entry.nodes].every((node) => other.nodes.has(node))) continue;
      if (best == null || other.nodes.size < best.nodes.size) best = other;
    }
    parentOf.set(entry.loop, best?.loop ?? null);
  }
  const depthOf = (loop) => {
    let depth = 0;
    let current = parentOf.get(loop) ?? null;
    for (let step = 0; current != null && step <= prepared.length; step += 1) {
      depth += 1;
      current = parentOf.get(current) ?? null;
    }
    return depth;
  };

  const loops = [];
  const refusals = [];
  const simplificationCandidates = [];
  let budgetExhausted = false;

  for (const { loop, nodes } of prepared) {
    if (abortedNow()) { budgetExhausted = true; break; }
    const { classification, reason } = classifyLoop(loop, { byIndex, dominates });
    const header = loop?.header ?? null;
    const nodeList = nodes == null ? [] : sortedNumbers([...nodes]);
    const exitEdges = nodes == null ? Object.freeze([]) : exitEdgesOf(loop, nodes, byIndex);
    const provenance = new Set(nodeList.flatMap((index) => originIdsOf(byIndex.get(index))));

    if (classification !== 'natural') {
      // Refused loops still appear in the artifact. A loop that is simply absent
      // is indistinguishable from a loop nobody looked at.
      refusals.push(Object.freeze({ header, classification, reason }));
      loops.push(Object.freeze({
        header,
        classification,
        classificationReason: reason,
        latches: sortedNumbers(listOf(loop?.latches)),
        nodes: nodeList,
        exits: sortedNumbers(listOf(loop?.exits)),
        exitEdges,
        depth: depthOf(loop),
        parentHeader: parentOf.get(loop)?.header ?? null,
        multipleBackEdges: listOf(loop?.latches).length > 1,
        guardBlock: null,
        guardBlockReason: reason,
        earlyExitEdges: exitEdges,
        inductions: Object.freeze([]),
        unresolvedLoopValues: Object.freeze([]),
        completeness: 'unknown',
        completenessReason: reason,
        origin: Object.freeze({ instructionIds: Object.freeze([...provenance].sort()) }),
      }));
      continue;
    }

    const latches = sortedNumbers(listOf(loop.latches));
    const headerBlock = byIndex.get(header);

    // The block whose conditional decides whether the loop runs again. A
    // pre-test loop decides at the header; a post-test loop decides at its
    // latch. Anything else that leaves the loop is an early exit, and a loop
    // where neither of those two shapes is present has no single guard — which
    // is reported rather than resolved by picking one.
    const exiting = nodeList.filter((index) => {
      const block = byIndex.get(index);
      if (terminatorOf(block)?.op !== 'cbr') return false;
      const successors = block.succ ?? [];
      if (successors.length !== 2) return false;
      return successors.filter((target) => nodes.has(target)).length === 1;
    });
    let guardBlock = null;
    let guardBlockReason = null;
    if (exiting.includes(header)) guardBlock = header;
    else {
      const exitingLatches = latches.filter((latch) => exiting.includes(latch));
      if (exitingLatches.length === 1) [guardBlock] = exitingLatches;
      else guardBlockReason = exitingLatches.length === 0
        ? 'neither the header nor a latch decides whether the loop repeats'
        : 'more than one latch decides whether the loop repeats';
    }
    // The guard has to hold for every latch, or it is not the loop's guard.
    if (guardBlock != null && !latches.every((latch) => dominates(guardBlock, latch) === true)) {
      guardBlock = null;
      guardBlockReason = 'the deciding conditional does not dominate every back edge';
    }
    const earlyExitEdges = Object.freeze(exitEdges.filter((edge) => edge.from !== guardBlock));

    const guardTerminator = guardBlock == null ? null : terminatorOf(byIndex.get(guardBlock));
    const guard = guardTerminator == null
      ? { predicate: null, reason: guardBlockReason ?? 'no conditional decides whether the loop repeats' }
      : readGuardPredicate(guardTerminator.conditionValue ?? argValue(guardTerminator, 0), limits);

    // Which way the branch has to go to stay in the loop. Without this the
    // predicate is only half of the condition.
    let continuesOnTrue = null;
    if (guardBlock != null) {
      const edges = byIndex.get(guardBlock)?.successorEdges ?? [];
      const trueEdge = edges.find((edge) => edge.kind === 'conditional-true');
      if (trueEdge != null) continuesOnTrue = nodes.has(trueEdge.to);
    }

    const inductions = [];
    // Loop-carried values whose step could not be proved. They are published
    // with their reason rather than dropped: "no step could be proved for this
    // value" and "nobody looked at this value" are different facts, and a
    // consumer that cannot tell them apart will eventually treat one as the
    // other.
    const unresolved = [];
    const phis = (headerBlock?.phis ?? []).slice(0, limits.maxPhisPerLoop);
    for (const phi of phis) {
      if (abortedNow()) { budgetExhausted = true; break; }
      const target = phi?.dst ?? null;
      const incoming = phi?.incoming ?? [];
      if (target == null || incoming.length === 0) continue;
      const outside = incoming.filter((entry) => !nodes.has(entry.from));
      const inside = incoming.filter((entry) => nodes.has(entry.from));
      if (outside.length === 0 || inside.length === 0) continue;

      const evidence = [];
      const origins = new Set(originIdsOf(phi));
      const initValues = [...new Map(outside.map((entry) => [entry.value?.id ?? null, entry.value])).values()];
      const init = initValues.length === 1 ? initValues[0] : null;
      if (init == null) evidence.push('the loop is entered with more than one distinct initial value');
      const initConstant = constantOf(init, rangeFacts);

      const resolutions = inside.map((entry) => resolveStep(entry.value, target, { rangeFacts, limits }));
      for (const resolution of resolutions) for (const id of resolution.origins) origins.add(id);
      const distinctSteps = new Set(resolutions.map((resolution) => (resolution.step == null ? 'unknown' : String(resolution.step))));
      let step = null;
      let stepReason = null;
      if (resolutions.length === 0) {
        stepReason = 'the loop carries no value back to this phi';
      } else if (distinctSteps.size > 1) {
        // Two back edges that update the variable differently do not give it one
        // step, and averaging them would be an invention.
        stepReason = 'the back edges update the loop variable by different amounts';
      } else if (resolutions[0].step == null) {
        stepReason = resolutions[0].reason;
      } else {
        step = resolutions[0].step;
      }
      if (resolutions.some((resolution) => resolution.copies > 0)) evidence.push('the update reaches the phi through a copy chain');
      if (step == null) {
        unresolved.push(Object.freeze({
          valueId: target.id,
          bits: target.bits ?? null,
          init: Object.freeze({ valueId: init?.id ?? null, constant: initConstant }),
          reason: stepReason,
          evidence: Object.freeze([...new Set(evidence)]),
          origin: Object.freeze({ instructionIds: Object.freeze([...origins].sort()) }),
        }));
        for (const id of origins) provenance.add(id);
        continue;
      }

      // Which value the guard compares. A header guard normally tests the phi
      // itself; a latch guard normally tests the value after the update.
      const updateValue = resolutions[0]?.update ?? null;
      let bound = null;
      let boundReason = guard.reason ?? null;
      let comparesUpdated = false;
      let predicate = null;
      let signedness = 'unknown';
      if (guard.predicate != null) {
        const left = guard.left == null ? null : unwrapCopies(guard.left, limits).value;
        const right = guard.rightIsZero ? null : (guard.right == null ? null : unwrapCopies(guard.right, limits).value);
        const matches = (candidate) => sameValue(candidate, target) || (updateValue != null && sameValue(candidate, updateValue));
        if (matches(left)) {
          predicate = guard.predicate;
          bound = guard.rightIsZero ? { valueId: null, constant: 0n } : { valueId: right?.id ?? null, constant: constantOf(right, rangeFacts) };
          comparesUpdated = updateValue != null && sameValue(left, updateValue) && !sameValue(left, target);
        } else if (right != null && matches(right)) {
          // The variable is on the right, so the predicate reads the other way.
          predicate = PREDICATES[guard.predicate].mirror;
          bound = { valueId: left?.id ?? null, constant: constantOf(left, rangeFacts) };
          comparesUpdated = updateValue != null && sameValue(right, updateValue) && !sameValue(right, target);
        } else {
          boundReason = 'the loop guard does not compare this variable';
        }
        // The condition may be wrapped in a logical `not`, and the branch may
        // stay in the loop on either edge. Both invert the predicate, so an odd
        // number of inversions flips it and an even number leaves it alone.
        const inverted = (guard.negated === true) !== (continuesOnTrue === false);
        if (predicate != null && inverted) predicate = PREDICATES[predicate].negation;
        if (predicate != null && continuesOnTrue == null) {
          predicate = null;
          boundReason = 'the guard branch does not say which edge stays in the loop';
        }
        if (predicate != null) signedness = PREDICATES[predicate].signedness;
      }
      if (signedness === 'unknown' && target.signed === true) signedness = 'signed';
      else if (signedness === 'unknown' && target.signed === false) signedness = 'unsigned';
      if (boundReason != null) evidence.push(boundReason);

      const role = addressRoles.get(target.id) ?? (updateValue == null ? null : addressRoles.get(updateValue.id) ?? null);
      const kind = role == null ? 'integer' : 'pointer';

      // Everything an exact trip count needs, each checked separately so the
      // reason for refusing is the reason, not the first one on the list.
      const blockers = [];
      if (latches.length > 1) blockers.push('the loop has more than one back edge');
      if (earlyExitEdges.length > 0) blockers.push(`the loop has ${earlyExitEdges.length} early exit edge(s)`);
      if (predicate == null) blockers.push(boundReason ?? guard.reason ?? 'the loop guard could not be read');
      if (initConstant == null) blockers.push('the initial value is not a proved constant');
      if (bound?.constant == null && predicate != null) blockers.push('the bound is not a proved constant');
      if (target.bits == null) blockers.push('the loop variable has no declared width');

      let trip = { exact: null, minimum: null, maximum: null, completeness: 'unknown', reason: blockers[0] ?? null };
      if (blockers.length === 0) {
        const counted = tripCountOf({
          predicate,
          init: initConstant,
          bound: bound.constant,
          step,
          bits: target.bits,
          signedness: signedness === 'signed' ? 'signed' : 'unsigned',
          // A post-test guard compares the value after the update, so the loop
          // runs once more than the pre-test form with the same numbers.
        });
        if (counted.exact != null) {
          const iterations = comparesUpdated ? counted.exact + 1n : counted.exact;
          trip = { exact: iterations, minimum: iterations, maximum: iterations, completeness: 'complete', reason: null };
        } else {
          trip = { exact: null, minimum: null, maximum: null, completeness: 'partial', reason: counted.reason };
        }
      } else if (blockers.length === 1 && earlyExitEdges.length > 0 && predicate != null && step != null && initConstant != null && bound?.constant != null && target.bits != null) {
        // An early exit can only make the loop run fewer times, so the counted
        // form is still a sound upper bound.
        const counted = tripCountOf({ predicate, init: initConstant, bound: bound.constant, step, bits: target.bits, signedness: signedness === 'signed' ? 'signed' : 'unsigned' });
        trip = counted.exact != null
          ? { exact: null, minimum: 0n, maximum: comparesUpdated ? counted.exact + 1n : counted.exact, completeness: 'partial', reason: 'an early exit can end the loop sooner' }
          : { exact: null, minimum: null, maximum: null, completeness: 'partial', reason: counted.reason };
      } else {
        trip = { exact: null, minimum: null, maximum: null, completeness: 'partial', reason: blockers[0] };
      }

      // Wrapping is only ruled out when the whole sequence was proved to stay
      // inside the width. Anywhere else it stays unknown, which is the IR's own
      // vocabulary for "nothing proved this either way".
      const wraps = trip.exact != null ? false : 'unknown';

      const factCompleteness = weakest([
        step == null ? 'partial' : 'complete',
        init == null ? 'partial' : 'complete',
        predicate == null ? 'partial' : 'complete',
        trip.completeness === 'complete' ? 'complete' : 'partial',
      ]);

      inductions.push(Object.freeze({
        valueId: target.id,
        bits: target.bits ?? null,
        kind,
        addressRole: role,
        init: Object.freeze({ valueId: init?.id ?? null, constant: initConstant }),
        step,
        stepReason,
        signedness,
        wraps,
        guard: predicate == null ? null : Object.freeze({
          blockIndex: guardBlock,
          predicate,
          continuesOnTrue,
          comparesUpdatedValue: comparesUpdated,
          conditionValueId: guardTerminator?.conditionValue?.id ?? null,
        }),
        bound: bound == null ? null : Object.freeze({ valueId: bound.valueId, constant: bound.constant }),
        tripCount: Object.freeze(trip),
        evidence: Object.freeze([...new Set(evidence)]),
        completeness: factCompleteness,
        origin: Object.freeze({ instructionIds: Object.freeze([...origins].sort()) }),
      }));
      for (const id of origins) provenance.add(id);
    }

    inductions.sort((left, right) => left.valueId - right.valueId);
    unresolved.sort((left, right) => left.valueId - right.valueId);
    const loopCompleteness = inductions.length === 0
      ? 'partial'
      : weakest([...inductions.map((fact) => fact.completeness), unresolved.length > 0 ? 'partial' : 'complete']);

    loops.push(Object.freeze({
      header,
      classification,
      classificationReason: null,
      latches,
      nodes: nodeList,
      exits: sortedNumbers(listOf(loop.exits)),
      // Exact exit edges with their kinds. Structuring consumes these; nothing
      // here may drop one to make the shape simpler.
      exitEdges,
      depth: depthOf(loop),
      parentHeader: parentOf.get(loop)?.header ?? null,
      multipleBackEdges: latches.length > 1,
      guardBlock,
      guardBlockReason,
      earlyExitEdges,
      inductions: Object.freeze(inductions),
      unresolvedLoopValues: Object.freeze(unresolved),
      completeness: loopCompleteness,
      completenessReason: inductions.length === 0
        ? (unresolved[0]?.reason ?? 'no loop-carried value in this header resolved to an induction variable')
        : (unresolved.length > 0 ? `${unresolved.length} loop-carried value(s) have no provable step` : null),
      origin: Object.freeze({ instructionIds: Object.freeze([...provenance].sort()) }),
    }));

    // A simplification candidate is only offered when the whole loop is proved:
    // one back edge, one exit, one counted variable with an exact trip count.
    const counted = inductions.filter((fact) => fact.tripCount.exact != null && fact.completeness === 'complete');
    if (classification === 'natural' && latches.length === 1 && earlyExitEdges.length === 0 && counted.length === 1) {
      simplificationCandidates.push(Object.freeze({
        kind: 'counted-loop',
        header,
        valueId: counted[0].valueId,
        tripCount: counted[0].tripCount.exact,
        targets: Object.freeze([`block:${header}`, `value:${counted[0].valueId}`]),
        proof: `the header dominates every block in the loop, one back edge returns to it, one edge leaves it, and ${counted[0].valueId} advances by ${counted[0].step} from a constant start to a constant bound without wrapping`,
      }));
    }
  }

  loops.sort((left, right) => (left.header ?? -1) - (right.header ?? -1));

  const facts = Object.freeze({
    contractVersion: INDUCTION_PASS.contractVersion,
    passVersion: INDUCTION_PASS.version,
    summaryVersion: INDUCTION_SUMMARY_VERSION,
    loops: Object.freeze(loops),
    inductionCount: loops.reduce((total, entry) => total + entry.inductions.length, 0),
    unresolvedLoopValueCount: loops.reduce((total, entry) => total + entry.unresolvedLoopValues.length, 0),
    countedLoopCount: simplificationCandidates.length,
    simplificationCandidates: Object.freeze(simplificationCandidates),
    refusals: Object.freeze(refusals),
    completeness: budgetExhausted ? 'partial' : 'complete',
  });
  area.stage('induction', facts);

  const diagnostics = [];
  if (budgetExhausted) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.induction.budget',
      message: 'Loop fact recovery stopped before every loop was analysed.',
      reason: 'The pass was cancelled; the loops published are a subset of the loops present, which is the safe direction.',
    });
  }
  if (refusals.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.induction.refused',
      message: `${refusals.length} loop region(s) were not treated as natural loops.`,
      reason: [...new Set(refusals.map((entry) => entry.reason))].slice(0, 4).join('; '),
    });
  }
  const missed = loops.flatMap((entry) => entry.inductions.filter((fact) => fact.tripCount.exact == null).map((fact) => fact.tripCount.reason)).filter(Boolean);
  if (missed.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.induction.no-trip-count',
      message: `${missed.length} induction variable(s) have no exact trip count.`,
      reason: [...new Set(missed)].slice(0, 4).join('; '),
    });
  }

  return createPassResult({
    descriptor: INDUCTION_PASS,
    status: 'changed',
    changed: true,
    completeness: facts.completeness,
    transforms: [],
    produced: ['induction'],
    diagnostics,
    invalidated: [],
  });
}

/** Human-readable form of one loop's facts, for diagnostics and evidence. */
export function describeLoopFacts(entry) {
  if (entry == null) return 'no loop';
  if (entry.classification !== 'natural') return `loop@${entry.header}: ${entry.classification} (${entry.classificationReason})`;
  const parts = entry.inductions.map((fact) => {
    const start = fact.init.constant == null ? '?' : String(fact.init.constant);
    const step = fact.step == null ? '?' : String(fact.step);
    const trip = fact.tripCount.exact != null ? `${fact.tripCount.exact} iterations` : `trip unknown (${fact.tripCount.reason})`;
    return `${fact.kind} v${fact.valueId}: start ${start}, step ${step}, ${trip}`;
  });
  return `loop@${entry.header} depth ${entry.depth}, ${entry.exitEdges.length} exit edge(s): ${parts.join('; ') || 'no induction variable'}`;
}
