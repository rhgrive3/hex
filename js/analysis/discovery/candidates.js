/**
 * P7-6 — FunctionCandidate contract.
 *
 * The rule this file enforces is P7-INV-006: a function's *start* and its
 * *extent* are separate facts. A precise start with an unknown extent is a
 * perfectly good answer, and inventing one contiguous body to make downstream
 * analysis simpler is how false merges get published (FM-8).
 *
 * So a candidate carries two independent evidence lists and two independent
 * states. Nothing here lets a strong start upgrade a weak extent.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';

export const FUNCTION_CANDIDATE_SCHEMA_VERSION = 1;

/**
 * Evidence classes, ordered by the authority they carry.
 *
 * `authoritative` producers can establish an exact start on their own;
 * `corroborating` ones support a start but cannot establish it alone;
 * `heuristic` ones only ever raise a candidate for consideration.
 */
export const EVIDENCE_AUTHORITY = Object.freeze({
  'loader-function-start': 'authoritative',
  'unwind-entry': 'authoritative',
  'debug-symbol': 'authoritative',
  'export': 'authoritative',
  'entrypoint': 'authoritative',
  'symbol-table': 'corroborating',
  'direct-call-target': 'corroborating',
  'relocation-target': 'corroborating',
  'vtable-entry': 'corroborating',
  'runtime-metadata': 'corroborating',
  'exception-metadata': 'corroborating',
  'runtime-observation': 'corroborating',
  'prologue-candidate': 'heuristic',
  'alignment-heuristic': 'heuristic',
});

export const EVIDENCE_KINDS = Object.freeze(Object.keys(EVIDENCE_AUTHORITY));

/** Candidate states. `contradicted` is a first-class outcome, not an error. */
export const CANDIDATE_STATES = Object.freeze(['exact', 'probable', 'heuristic', 'contradicted']);

/** How a byte range is owned. Shared ownership is representable on purpose. */
export const REGION_OWNERSHIP = Object.freeze(['exclusive', 'shared', 'ambiguous']);

const KIND_SET = new Set(EVIDENCE_KINDS);
const OWNERSHIP_SET = new Set(REGION_OWNERSHIP);

function fail(code) { throw new TypeError(code); }

function address(value, code) {
  if (value == null) fail(code);
  try { return BigInt(value); }
  catch { fail(code); return 0n; }
}

/**
 * How much of a function's extent one piece of evidence describes.
 *
 * `complete` claims the whole body; `partial` claims one range of a body that
 * may have others. The distinction is what lets a non-contiguous function be
 * assembled from several unwind entries without those entries looking like
 * competing answers to the same question.
 */
export const EXTENT_ROLES = Object.freeze(['complete', 'partial']);

/** One piece of evidence about a start or an extent. */
export function createDiscoveryEvidence(input = {}) {
  const kind = String(input.kind ?? '');
  if (!KIND_SET.has(kind)) fail(`discovery-evidence-unknown-kind:${kind}`);
  const extentRole = String(input.extentRole ?? 'complete');
  if (!EXTENT_ROLES.includes(extentRole)) fail('discovery-evidence-invalid-extent-role');
  return deepFreeze({
    kind,
    authority: EVIDENCE_AUTHORITY[kind],
    extentRole,
    start: input.start == null ? null : address(input.start, 'discovery-evidence-invalid-start').toString(),
    regions: deepFreeze((input.regions ?? []).map((region) => createRegion(region))),
    // The producer that supplied this. Architecture-specific producers are
    // fine; what must not happen is the *fusion* knowing what they mean.
    producerId: String(input.producerId ?? 'unknown'),
    architectureId: input.architectureId == null ? null : String(input.architectureId),
    name: input.name == null ? null : String(input.name),
    confidence: input.confidence == null ? null : String(input.confidence),
    evidenceIds: [...new Set((input.evidenceIds ?? []).map(String))].sort(),
  });
}

export function createRegion(input = {}) {
  const start = address(input.start, 'discovery-region-invalid-start');
  const end = address(input.end, 'discovery-region-invalid-end');
  if (end <= start) fail('discovery-region-empty');
  const ownership = String(input.ownership ?? 'exclusive');
  if (!OWNERSHIP_SET.has(ownership)) fail('discovery-region-invalid-ownership');
  return deepFreeze({ start: start.toString(), end: end.toString(), ownership });
}

export function regionsOverlap(a, b) {
  return BigInt(a.start) < BigInt(b.end) && BigInt(b.start) < BigInt(a.end);
}

/**
 * A discovered function candidate.
 *
 * `extentState` defaults to `unknown` and stays there unless extent evidence
 * actually supports something better. That default is the whole point: an
 * unknown extent must be cheap to report and impossible to forget.
 */
export function createFunctionCandidate(input = {}) {
  const start = address(input.start, 'discovery-candidate-invalid-start');
  const startState = String(input.startState ?? 'heuristic');
  if (!CANDIDATE_STATES.includes(startState)) fail('discovery-candidate-invalid-start-state');
  const extentState = input.extentState == null ? 'unknown' : String(input.extentState);
  if (extentState !== 'unknown' && !CANDIDATE_STATES.includes(extentState)) fail('discovery-candidate-invalid-extent-state');

  const regions = (input.regions ?? []).map((region) => createRegion(region));
  regions.sort((left, right) => {
    const leftStart = BigInt(left.start);
    const rightStart = BigInt(right.start);
    if (leftStart < rightStart) return -1;
    if (leftStart > rightStart) return 1;
    const leftEnd = BigInt(left.end);
    const rightEnd = BigInt(right.end);
    if (leftEnd < rightEnd) return -1;
    if (leftEnd > rightEnd) return 1;
    return left.ownership.localeCompare(right.ownership);
  });
  if (extentState === 'unknown' && regions.length > 0 && input.allowRegionsWithUnknownExtent !== true) {
    fail('discovery-candidate-unknown-extent-cannot-claim-regions');
  }

  const candidate = {
    schemaVersion: FUNCTION_CANDIDATE_SCHEMA_VERSION,
    start: start.toString(),
    name: input.name == null ? null : String(input.name),
    regions: deepFreeze(regions),
    startEvidence: deepFreeze((input.startEvidence ?? []).map((evidence) => createDiscoveryEvidence(evidence))),
    extentEvidence: deepFreeze((input.extentEvidence ?? []).map((evidence) => createDiscoveryEvidence(evidence))),
    startState,
    extentState,
    conflicts: deepFreeze([...(input.conflicts ?? [])]),
    architectureId: input.architectureId == null ? null : String(input.architectureId),
  };
  candidate.digest = stableDigest({
    start: candidate.start,
    regions: candidate.regions,
    startState: candidate.startState,
    extentState: candidate.extentState,
    conflicts: candidate.conflicts,
  });
  return deepFreeze(candidate);
}

/**
 * The single accessor for "is this definitely a function start?".
 *
 * A contradicted candidate is never exact, whatever its evidence count says.
 */
export function hasExactStart(candidate) {
  return candidate.startState === 'exact' && !candidate.conflicts.some((conflict) => conflict.kind === 'start');
}

export function hasKnownExtent(candidate) {
  return candidate.extentState !== 'unknown' && candidate.regions.length > 0;
}
