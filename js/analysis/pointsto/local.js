/**
 * P7-2 — A2 field-sensitive local points-to analysis.
 *
 * A2 sits directly on top of the canonical address/root service in
 * `js/analysis/alias/canonical-address-v2-core.js`. That service already proves
 * exact roots and exact offsets for straight-line address computations; what it
 * cannot do is close a cycle. It returns `canonical-address-semantic-cycle` for
 * a loop-carried pointer and `root-only` for a merge whose offsets disagree.
 *
 * A2's whole job is those two cases: run a real fixed point over the SSA phi
 * graph so a merged or loop-carried pointer keeps its root and gains a bounded
 * *offset range* instead of collapsing to "somewhere in this object". That is
 * what turns overlapping-field questions from `may` into `no`.
 *
 * A2 deliberately does not resolve loads or calls. A pointer read out of memory
 * or returned by a call is an unresolved boundary until P7-3 summary evidence
 * exists; pretending otherwise is how field-sensitive analyses become unsound.
 */

import { createAnalysisStatus } from '../status.js';
import {
  defaultRootEntityId,
  deriveCanonicalAddressProof,
  normalizeRootIdentity,
} from '../alias/canonical-address-v2.js';
import { deterministicTraversal } from '../../semantics/cfg/index.js';
import {
  BOTTOM_POINTS_TO,
  POINTS_TO_DEFAULT_BUDGET,
  addRange,
  createPointsToSet,
  createPointsToTarget,
  UNBOUNDED_RANGE,
  exactRange,
  joinPointsTo,
  pointsToEqual,
  pointsToIsBottom,
  topPointsTo,
  widenPointsTo,
} from './lattice.js';

export const A2_ANALYZER_ID = 'phase7.pointsto.a2-local';
export const A2_ANALYZER_VERSION = '1.0.0';

/** Casts that keep pointer provenance intact when the width does not change. */
const WIDTH_PRESERVING_CASTS = new Set(['copy', 'bitcast']);
const WIDTH_CHANGING_CASTS = new Set(['zext', 'sext', 'trunc']);

function parseInteger(candidate) {
  if (candidate == null) return null;
  const raw = typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate.value ?? candidate.bits ?? null)
    : candidate;
  if (raw == null) return null;
  try {
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? BigInt(raw) : null;
    const text = String(raw).trim();
    if (!/^[+-]?(0x[0-9a-fA-F]+|\d+)$/.test(text)) return null;
    return BigInt(text);
  } catch { return null; }
}

/**
 * Reads a compile-time constant the same way the canonical address derivation
 * does, so A2 and the root service never disagree about what "constant" means.
 */
function constantOf(value, node) {
  for (const candidate of [value?.metadata?.constant, node?.attributes?.constant, node?.metadata?.constant]) {
    const parsed = parseInteger(candidate);
    if (parsed != null) return parsed;
  }
  return null;
}

function widthOf(value, node) {
  const fromValue = Number(value?.machineType?.widthBits);
  if (Number.isSafeInteger(fromValue) && fromValue > 0) return fromValue;
  const fromNode = Number(node?.attributes?.widthBits);
  return Number.isSafeInteger(fromNode) && fromNode > 0 ? fromNode : null;
}

/** Turns an exact canonical proof into a singleton points-to set. */
function targetFromCanonicalProof(proof, evidenceIds) {
  if (!proof || proof.kind === 'unknown' || proof.kind === 'root-only') return null;
  if (proof.kind === 'constant') {
    return createPointsToTarget({
      addressSpace: 'memory', rootKind: 'absolute', address: String(proof.value), offsetRange: exactRange(0n),
      widthBits: proof.widthBits, evidenceIds,
    });
  }
  if (proof.kind === 'absolute') {
    return createPointsToTarget({
      addressSpace: proof.addressSpace, rootKind: 'absolute', address: String(proof.address),
      offsetRange: exactRange(0n), widthBits: proof.widthBits, evidenceIds,
    });
  }
  if (proof.kind === 'stack-like' || proof.kind === 'rooted') {
    return createPointsToTarget({
      addressSpace: proof.addressSpace,
      rootKind: proof.kind,
      rootIdentity: proof.rootIdentity,
      rootEntityId: proof.rootEntityId ?? null,
      offsetRange: exactRange(proof.offset),
      widthBits: proof.widthBits,
      evidenceIds,
    });
  }
  return null;
}

/**
 * The root of a `root-only` proof, with the offset left unbounded.
 *
 * This is the key A2 seed: the canonical service proved the *root* even though
 * it could not prove the offset, so A2 starts from the right object and only
 * has to bound the displacement.
 */
function rootOnlySeed(proof, evidenceIds) {
  if (!proof || proof.kind !== 'root-only') return null;
  return createPointsToTarget({
    addressSpace: proof.addressSpace,
    rootKind: proof.rootKind,
    rootIdentity: proof.rootIdentity,
    rootEntityId: proof.rootEntityId ?? null,
    offsetRange: { min: null, max: null, exact: false },
    widthBits: proof.widthBits,
    evidenceIds,
  });
}

function shiftSet(set, delta, widthBits) {
  if (set.top) return set;
  const lossReasons = [...set.lossReasons];
  const targets = set.targets.map((target) => {
    const { range, lost } = addRange(target.offsetRange, delta, widthBits ?? target.widthBits);
    if (lost) lossReasons.push(lost);
    return createPointsToTarget({ ...target, offsetRange: range });
  });
  return createPointsToSet({ targets, lossReasons });
}

/**
 * Runs the local points-to fixed point for one function.
 *
 * Returns a map from IR value id to `PointsToSet`, plus the status describing
 * how the run terminated. A run that hits its iteration cap is reported as
 * `truncated`, never as complete.
 */
/**
 * Root singleton for an SSA `entry` definition: the incoming machine state a
 * function was handed. The root identity is built with the canonical helpers so
 * A2 and the exact derivation name the same object.
 */
function entryRootTarget(definition, functionId, values) {
  const variable = definition.proof?.variableIdentity ?? {
    key: definition.variableKey ?? `ssa-entry:${definition.definitionId}`,
    kind: 'logical-state',
    scope: 'function',
  };
  const identity = normalizeRootIdentity(variable, functionId);
  const semanticValue = definition.proof?.sourceSemanticValueId == null
    ? null
    : values.get(String(definition.proof.sourceSemanticValueId));
  const widthBits = Number(semanticValue?.machineType?.widthBits)
    || Number(definition.proof?.machineType?.widthBits)
    || null;
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootIdentity: identity,
    rootEntityId: defaultRootEntityId(identity),
    offsetRange: exactRange(0n),
    widthBits,
  });
}

/**
 * Runs the local points-to fixed point for one function.
 *
 * Two coupled maps are solved together: one over IR values and one over SSA
 * value ids. They have to be one fixed point rather than two passes because the
 * interesting case is a cycle that runs through both — a loop-carried pointer
 * is an SSA phi whose incoming value is an IR add of the phi itself.
 *
 * Returns the IR-value map plus the status describing how the run terminated. A
 * run that hits its iteration cap reports `truncated`, never `complete`.
 */
export function analyzeLocalPointsTo(ir, cfg, ssa, options = {}) {
  const budget = { ...POINTS_TO_DEFAULT_BUDGET, ...(options.budget ?? {}) };
  const values = new Map((ir.values ?? []).map((value) => [String(value.id), value]));
  const nodes = new Map((ir.nodes ?? []).map((node) => [String(node.id), node]));
  const functionId = String(ir.functionId);

  const ssaDefinitions = new Map((ssa?.definitions ?? []).map((definition) => [String(definition.valueId), definition]));
  const ssaUsesByEntity = new Map();
  for (const use of ssa?.uses ?? []) {
    const key = String(use.sourceEntityId);
    if (!ssaUsesByEntity.has(key)) ssaUsesByEntity.set(key, []);
    ssaUsesByEntity.get(key).push(use);
  }

  const fallbackStatus = (completeness, stopReason) => createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: A2_ANALYZER_ID,
    analyzerVersion: A2_ANALYZER_VERSION,
    completeness,
    budgetClass: options.budgetClass ?? null,
    stopReason,
  });

  if (values.size > budget.maxValues) {
    return { pointsTo: new Map(), ssaPointsTo: new Map(), iterations: 0, status: fallbackStatus('unsupported', 'budget-exhausted') };
  }

  // Canonical proofs are computed once per value. They are the exact answers;
  // the fixed point only has to improve on the merged and cyclic ones.
  const canonical = new Map();
  for (const id of values.keys()) {
    let proof;
    try { proof = deriveCanonicalAddressProof(ir, id, { ssa, ...(options.canonicalOptions ?? {}) }); }
    catch { proof = null; }
    canonical.set(id, proof);
  }

  const blockOrder = cfg ? deterministicTraversal(cfg) : [];
  const blockRank = new Map(blockOrder.map((blockId, index) => [blockId, index]));
  const rankOf = (valueId) => {
    const value = values.get(String(valueId));
    const node = value?.definitionNodeId == null ? null : nodes.get(String(value.definitionNodeId));
    return blockRank.get(node?.blockId) ?? Number.MAX_SAFE_INTEGER;
  };
  const irOrder = [...values.keys()].sort((left, right) => rankOf(left) - rankOf(right) || left.localeCompare(right));
  const ssaOrder = [...ssaDefinitions.keys()].sort((left, right) => {
    const leftRank = blockRank.get(ssaDefinitions.get(left).blockId) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = blockRank.get(ssaDefinitions.get(right).blockId) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });

  const irState = new Map(irOrder.map((id) => [id, BOTTOM_POINTS_TO]));
  const ssaState = new Map(ssaOrder.map((id) => [id, BOTTOM_POINTS_TO]));
  const irPrevious = new Map();
  const ssaPrevious = new Map();

  const irGet = (id) => irState.get(String(id)) ?? topPointsTo('unsupported-operation');
  const ssaGet = (id) => ssaState.get(String(id)) ?? topPointsTo('unsupported-operation');

  /** Reaching SSA values for one `state-read`, matched on variable identity. */
  function reachingSsaValues(node) {
    const variableKey = String(node.variable?.key ?? '');
    if (!variableKey) return [];
    const uses = (ssaUsesByEntity.get(String(node.id)) ?? []).filter((use) => (
      String(use.proof?.variableIdentity?.key ?? use.proof?.sourceVariableKey ?? '') === variableKey
    ));
    return [...new Set(uses.map((use) => String(use.valueId)))].sort();
  }

  function transferSsa(ssaValueId) {
    const definition = ssaDefinitions.get(ssaValueId);
    if (!definition) return topPointsTo('unsupported-operation');
    if (definition.kind === 'unknown') return topPointsTo('unresolved-call');
    if (definition.kind === 'undef') {
      // An implicit-undef seed means "no earlier semantic definition", not a
      // clobber. Treat it as the incoming entry root rather than as TOP,
      // matching the canonical derivation's reading of the same sentinel.
      if (definition.proof?.kind === 'implicit-undef') {
        return createPointsToSet({ targets: [entryRootTarget(definition, functionId, values)] });
      }
      return topPointsTo('unsupported-operation');
    }
    if (definition.kind === 'entry') {
      return createPointsToSet({ targets: [entryRootTarget(definition, functionId, values)] });
    }
    if (definition.kind === 'phi') {
      let merged = BOTTOM_POINTS_TO;
      for (const incoming of definition.incoming ?? []) merged = joinPointsTo(merged, ssaGet(incoming.valueId), budget);
      return merged;
    }
    const sourceSemanticValueId = definition.proof?.sourceSemanticValueId;
    if (sourceSemanticValueId == null) return topPointsTo('unsupported-operation');
    return irGet(sourceSemanticValueId);
  }

  function transferIr(id) {
    const value = values.get(id);
    if (!value) return topPointsTo('unsupported-operation');
    if (value.kind === 'unknown' || value.kind === 'undef') return topPointsTo('unsupported-operation');

    const proof = canonical.get(id);
    const evidenceIds = [...(value.origin?.instructionIds ?? [])].map(String);
    const exact = targetFromCanonicalProof(proof, evidenceIds);
    if (exact) return createPointsToSet({ targets: [exact] });

    const node = value.definitionNodeId == null ? null : nodes.get(String(value.definitionNodeId));
    if (!node) {
      const seed = rootOnlySeed(proof, evidenceIds);
      return seed ? createPointsToSet({ targets: [seed] }) : topPointsTo('unresolved-load');
    }

    const width = widthOf(value, node);

    if (node.kind === 'state-read') {
      const reaching = reachingSsaValues(node);
      if (!reaching.length) {
        const seed = rootOnlySeed(proof, evidenceIds);
        return seed ? createPointsToSet({ targets: [seed] }) : topPointsTo('unsupported-operation');
      }
      let merged = BOTTOM_POINTS_TO;
      for (const ssaValueId of reaching) merged = joinPointsTo(merged, ssaGet(ssaValueId), budget);
      return merged;
    }

    if (WIDTH_PRESERVING_CASTS.has(node.kind) && node.inputs.length === 1) return irGet(node.inputs[0]);
    if (WIDTH_CHANGING_CASTS.has(node.kind) && node.inputs.length === 1) {
      const inputValue = values.get(String(node.inputs[0]));
      const inputWidth = widthOf(inputValue, null);
      // Narrowing or re-widening a pointer destroys provenance: the recovered
      // bits are no longer proof of which object the pointer came from.
      if (inputWidth == null || width == null || inputWidth !== width) return topPointsTo('integer-to-pointer');
      return irGet(node.inputs[0]);
    }
    if (node.kind === 'select') {
      const arms = node.inputs.length === 3 ? node.inputs.slice(1) : node.inputs;
      let merged = BOTTOM_POINTS_TO;
      for (const arm of arms) merged = joinPointsTo(merged, irGet(arm), budget);
      return merged;
    }
    if (node.kind === 'binary' && node.inputs.length === 2) {
      const operator = String(node.operator ?? '').toLowerCase();
      if (operator !== 'add' && operator !== 'sub') return topPointsTo('non-linear-arithmetic');
      const leftValue = values.get(String(node.inputs[0]));
      const rightValue = values.get(String(node.inputs[1]));
      const leftNode = leftValue?.definitionNodeId == null ? null : nodes.get(String(leftValue.definitionNodeId));
      const rightNode = rightValue?.definitionNodeId == null ? null : nodes.get(String(rightValue.definitionNodeId));
      const leftConstant = constantOf(leftValue, leftNode);
      const rightConstant = constantOf(rightValue, rightNode);
      if (rightConstant != null) {
        return shiftSet(irGet(node.inputs[0]), operator === 'sub' ? -rightConstant : rightConstant, width);
      }
      if (leftConstant != null && operator === 'add') {
        return shiftSet(irGet(node.inputs[1]), leftConstant, width);
      }
      // A pointer displaced by a value we cannot bound. Unbounding the offset
      // is the sound answer; keeping the base offset would be a false interval.
      const base = irGet(node.inputs[0]);
      if (base.top || pointsToIsBottom(base)) return topPointsTo('non-linear-arithmetic');
      return createPointsToSet({
        targets: base.targets.map((target) => createPointsToTarget({ ...target, offsetRange: UNBOUNDED_RANGE })),
        lossReasons: [...base.lossReasons, 'non-linear-arithmetic'],
      });
    }
    if (node.kind === 'load') return topPointsTo('unresolved-load');
    if (node.kind === 'call') return topPointsTo('unresolved-call');

    const seed = rootOnlySeed(proof, evidenceIds);
    if (seed) return createPointsToSet({ targets: [seed] });
    return topPointsTo('unsupported-operation');
  }

  let iterations = 0;
  let changed = true;
  let stopReason = null;
  while (changed) {
    if (options.signal?.aborted) { stopReason = 'cancelled'; break; }
    if (iterations >= budget.maxIterations) { stopReason = 'iteration-limit'; break; }
    iterations += 1;
    changed = false;
    const widening = iterations > budget.widenAfterIterations;

    const step = (order, state, previous, transfer) => {
      for (const id of order) {
        const current = state.get(id);
        const joined = joinPointsTo(current, transfer(id), budget);
        const next = widening ? widenPointsTo(previous.get(id) ?? current, joined, budget) : joined;
        if (!pointsToEqual(current, next)) {
          previous.set(id, current);
          state.set(id, next);
          changed = true;
        }
      }
    };
    step(ssaOrder, ssaState, ssaPrevious, transferSsa);
    step(irOrder, irState, irPrevious, transferIr);
  }

  // Bottom is the fixed-point seed, never an answer. A value the solve never
  // reached is unreachable or unmodelled, and TOP is the only sound report:
  // an empty points-to set would falsely separate it from everything.
  for (const [id, set] of irState) if (pointsToIsBottom(set)) irState.set(id, topPointsTo('unsupported-operation'));
  for (const [id, set] of ssaState) if (pointsToIsBottom(set)) ssaState.set(id, topPointsTo('unsupported-operation'));

  const completeness = stopReason == null ? 'complete' : stopReason === 'cancelled' ? 'partial' : 'truncated';
  return {
    pointsTo: irState,
    ssaPointsTo: ssaState,
    iterations,
    status: fallbackStatus(completeness, stopReason),
  };
}
