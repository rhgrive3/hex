/**
 * P7-4 — TypeConstraintGraph.
 *
 * Constraints are added per entity and per layer; solving produces one
 * `TypeResult` per entity. The graph's job is not to pick the nicest-looking
 * type — it is to keep hard facts, soft rankings and contradictions apart so
 * that a consumer can tell the difference (P7-INV-005, FM-6).
 *
 * Two rules decide every answer:
 *
 *  1. A layer with contradictory *hard* constraints has no selected type.
 *     Confidence is not lowered — selection is withheld entirely, because a
 *     "70% certain" answer between two mutually exclusive hard facts is a
 *     fabrication.
 *  2. Soft evidence orders the candidates that survive the hard constraints. It
 *     never introduces a candidate that a hard constraint excludes, and it
 *     never raises a conclusion to `certain`.
 *
 * Contradictions stay localized to the entity and layer that carry them, so one
 * bad debug record cannot poison unrelated components of the graph.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createAnalysisStatus, isCompleteStatus } from '../status.js';
import {
  TYPE_LAYERS,
  claimsConflict,
  createContradiction,
  createHardConstraint,
  createSoftEvidence,
} from './constraints.js';

export const TYPE_GRAPH_ANALYZER_ID = 'phase7.types.constraint-graph';
export const TYPE_GRAPH_ANALYZER_VERSION = '1.0.0';
export const TYPE_RESULT_SCHEMA_VERSION = 1;

/**
 * Confidence bands. `certain` is reachable only from an uncontradicted hard
 * constraint; everything soft tops out at `probable`.
 */
export const TYPE_CONFIDENCE = Object.freeze(['certain', 'probable', 'possible', 'unknown']);

function fail(code) { throw new TypeError(code); }

export class TypeConstraintGraph {
  constructor({ snapshotId = 'snapshot-unbound', budgetClass = null } = {}) {
    this.snapshotId = snapshotId;
    this.budgetClass = budgetClass;
    /** entityId -> layer -> { hard: [], soft: [] } */
    this.entities = new Map();
    this.userConstraintDigests = new Set();
  }

  #bucket(entityId, layer) {
    if (!this.entities.has(entityId)) this.entities.set(entityId, new Map());
    const layers = this.entities.get(entityId);
    if (!layers.has(layer)) layers.set(layer, { hard: [], soft: [] });
    return layers.get(layer);
  }

  addHardConstraint(input) {
    const constraint = createHardConstraint(input);
    const bucket = this.#bucket(constraint.claim.entityId, constraint.claim.layer);
    const isDuplicate = bucket.hard.some((c) => (
      c.kind === constraint.kind &&
      c.origin === constraint.origin &&
      c.claim.key === constraint.claim.key &&
      c.providerVersion === constraint.providerVersion &&
      c.buildIdentity === constraint.buildIdentity
    ));
    if (!isDuplicate) bucket.hard.push(constraint);
    if (constraint.origin === 'user-approved') {
      this.userConstraintDigests.add(stableDigest(constraint.claim));
    }
    return constraint;
  }

  addSoftEvidence(input) {
    const evidence = createSoftEvidence(input);
    const bucket = this.#bucket(evidence.claim.entityId, evidence.claim.layer);
    const isDuplicate = bucket.soft.some((e) => (
      e.kind === evidence.kind &&
      e.origin === evidence.origin &&
      e.claim.key === evidence.claim.key &&
      e.weight === evidence.weight
    ));
    if (!isDuplicate) bucket.soft.push(evidence);
    return evidence;
  }

  entityIds() {
    return [...this.entities.keys()].sort();
  }

  /** Every layer's answer for one entity. */
  solveEntity(entityId, { signal = null } = {}) {
    const layers = this.entities.get(entityId);
    if (!layers) {
      return createTypeResult({
        entityId,
        status: this.#status('unsupported', 'evidence-missing'),
        layers: {},
      });
    }
    if (signal?.aborted) {
      return createTypeResult({ entityId, status: this.#status('partial', 'cancelled'), layers: {} });
    }

    const solvedLayers = {};
    for (const layer of TYPE_LAYERS) {
      const bucket = layers.get(layer);
      if (!bucket) continue;
      solvedLayers[layer] = solveLayer(entityId, layer, bucket);
    }
    return createTypeResult({
      entityId,
      status: this.#status('complete', null),
      layers: solvedLayers,
      userConstrained: [...this.userConstraintDigests].some((digest) => (
        Object.values(solvedLayers).some((solved) => solved.hardConstraints.some((constraint) => (
          constraint.origin === 'user-approved' && stableDigest(constraint.claim) === digest
        )))
      )),
    });
  }

  #status(completeness, stopReason) {
    return createAnalysisStatus({
      snapshotId: this.snapshotId,
      analyzerId: TYPE_GRAPH_ANALYZER_ID,
      analyzerVersion: TYPE_GRAPH_ANALYZER_VERSION,
      completeness,
      budgetClass: this.budgetClass,
      stopReason,
    });
  }
}

function solveLayer(entityId, layer, bucket) {
  const contradictions = [];
  for (let i = 0; i < bucket.hard.length; i += 1) {
    for (let j = i + 1; j < bucket.hard.length; j += 1) {
      if (claimsConflict(bucket.hard[i].claim, bucket.hard[j].claim)) {
        contradictions.push(createContradiction({
          layer,
          entityId,
          left: bucket.hard[i],
          right: bucket.hard[j],
          detail: `hard constraints disagree: ${bucket.hard[i].kind} vs ${bucket.hard[j].kind}`,
        }));
      }
    }
  }

  // Candidates that survive the hard constraints. A soft claim that conflicts
  // with any hard one is excluded outright rather than down-weighted: soft
  // evidence ranks, it does not overrule.
  const hardClaims = bucket.hard.map((constraint) => constraint.claim);
  const candidates = new Map();
  const add = (claim, weight, source) => {
    const existing = candidates.get(claim.key);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      existing.sources.add(source);
      return;
    }
    candidates.set(claim.key, { claim, weight, sources: new Set([source]) });
  };
  for (const constraint of bucket.hard) add(constraint.claim, 1, 'hard');
  for (const evidence of bucket.soft) {
    if (hardClaims.some((hard) => claimsConflict(hard, evidence.claim))) continue;
    add(evidence.claim, evidence.weight, 'soft');
  }

  const ranked = [...candidates.values()].sort((left, right) => (
    right.weight - left.weight || left.claim.key.localeCompare(right.claim.key)
  ));

  let selected = null;
  let confidence = 'unknown';
  if (contradictions.length > 0) {
    // Withhold selection entirely. Picking the highest-scoring side of a hard
    // contradiction is precisely the false certainty this layer exists to stop.
    confidence = 'unknown';
  } else if (bucket.hard.length > 0) {
    selected = bucket.hard[0].claim;
    confidence = 'certain';
  } else if (ranked.length === 1) {
    selected = ranked[0].claim;
    confidence = ranked[0].weight >= 0.75 ? 'probable' : 'possible';
  } else if (ranked.length > 1 && ranked[0].weight > ranked[1].weight) {
    selected = ranked[0].claim;
    confidence = ranked[0].weight >= 0.75 ? 'probable' : 'possible';
  } else if (ranked.length > 1) {
    // A tie between soft candidates is ambiguity, not a coin flip.
    confidence = 'unknown';
  }

  return deepFreeze({
    layer,
    candidates: deepFreeze(ranked.map((entry) => ({
      claim: entry.claim,
      weight: entry.weight,
      sources: [...entry.sources].sort(),
    }))),
    selected,
    confidence,
    hardConstraints: deepFreeze([...bucket.hard]),
    softEvidence: deepFreeze([...bucket.soft]),
    contradictions: deepFreeze(contradictions),
  });
}

export function createTypeResult(input = {}) {
  const layers = input.layers ?? {};
  const contradictions = Object.values(layers).flatMap((layer) => layer.contradictions ?? []);
  const status = input.status;
  if (!status) fail('type-result-status-required');
  return deepFreeze({
    schemaVersion: TYPE_RESULT_SCHEMA_VERSION,
    entityId: String(input.entityId ?? ''),
    layers: deepFreeze(layers),
    contradictions: deepFreeze(contradictions),
    userConstrained: input.userConstrained === true,
    status,
  });
}

/**
 * The one question a consumer may ask before printing a type as fact.
 *
 * It requires an uncontradicted hard constraint *and* a sound status, so a
 * cancelled or budget-limited solve can never present a certain type.
 */
export function selectedTypeIfCertain(result, layer) {
  const solved = result?.layers?.[layer];
  if (!solved) return null;
  if (!isCompleteStatus(result.status)) return null;
  if (solved.contradictions.length > 0) return null;
  if (solved.confidence !== 'certain') return null;
  return solved.selected;
}

/** Counts conclusions presented as certain, for the false-certainty metric. */
export function certainConclusions(result) {
  return Object.entries(result.layers ?? {})
    .filter(([, solved]) => solved.confidence === 'certain' && solved.contradictions.length === 0)
    .map(([layer, solved]) => ({ layer, claim: solved.selected }));
}
