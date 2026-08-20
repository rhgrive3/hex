/**
 * Phase 7 derived-artifact identity and dependency contract.
 *
 * Phase 7 caches expensive derived analysis (points-to sets, function
 * summaries, escape facts, type graphs, debug-derived facts, function
 * candidates). Reusing one of those against the wrong inputs is not a
 * performance bug, it is a semantic correctness bug: a caller that keeps a
 * precise `NoAlias` after its callee's summary changed is now publishing a
 * false strong conclusion.
 *
 * This module does not introduce a second cache. It builds the canonical
 * `createArtifactDescriptor` key from the Phase 7 dimensions listed in the
 * execution plan, so every Phase 7 producer keys the same way and the existing
 * ArtifactStore dependency validation does the invalidation work.
 */

import { createArtifactDescriptor } from '../core/artifacts/contracts.js';
import { deepFreeze, stableDigest } from '../core/identity/index.js';

export const PHASE7_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Every Phase 7 artifact kind. Naming them here (rather than passing free
 * strings) is what lets the ownership/verifier tests enumerate the set and
 * check that each kind declares its dependency class.
 */
export const PHASE7_ARTIFACT_KINDS = Object.freeze([
  'phase7.alias.region',
  'phase7.pointsto.local',
  'phase7.summary.local',
  'phase7.summary.escape',
  'phase7.summary.interprocedural',
  'phase7.types.constraint-graph',
  'phase7.debug.facts',
  'phase7.discovery.candidates',
]);

const KIND_SET = new Set(PHASE7_ARTIFACT_KINDS);

/**
 * Which semantic inputs each kind is actually derived from.
 *
 * This is the machine-readable form of the plan's change-impact table. It is
 * consulted by `dependencyClassFor` so that invalidation is neither broader
 * (FM-14) nor narrower (FM-15) than the real dependency edges.
 */
export const PHASE7_DEPENDENCY_CLASSES = deepFreeze({
  'phase7.alias.region': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions'],
  'phase7.pointsto.local': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions', 'pointsToOptions'],
  'phase7.summary.local': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions', 'pointsToOptions'],
  'phase7.summary.escape': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions', 'pointsToOptions', 'calleeSummaries'],
  'phase7.summary.interprocedural': ['binary', 'semantic', 'cfg', 'ssa', 'memoryssa', 'aliasOptions', 'pointsToOptions', 'calleeSummaries', 'libraryModel'],
  'phase7.types.constraint-graph': ['binary', 'semantic', 'abi', 'calleeSummaries', 'debugIdentity', 'userConstraints'],
  'phase7.debug.facts': ['binary', 'debugIdentity', 'debugProvider'],
  'phase7.discovery.candidates': ['binary', 'loaderEvidence', 'debugIdentity', 'calleeSummaries', 'architecture'],
});

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}

function optional(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function sortedIds(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return [...new Set(values.map((value) => nonEmpty(value, code)))].sort();
}

export function dependencyClassFor(kind) {
  const classes = PHASE7_DEPENDENCY_CLASSES[kind];
  if (!classes) fail('phase7-artifact-unknown-kind');
  return classes;
}

/**
 * Presentation state that must never enter a semantic cache key.
 *
 * Keying alias analysis by "which tab is open" or "what the user renamed this
 * function to" both over-invalidates and makes the cache non-reproducible, so
 * the descriptor builder rejects these outright instead of silently hashing
 * them.
 */
const FORBIDDEN_KEY_FIELDS = Object.freeze([
  'fileName', 'filename', 'path', 'tabId', 'displayAddress', 'addressText',
  'userName', 'userComment', 'bookmark', 'selection', 'scrollOffset', 'theme',
]);

function assertNoPresentationState(config) {
  if (!config || typeof config !== 'object') return;
  for (const key of Object.keys(config)) {
    if (FORBIDDEN_KEY_FIELDS.includes(key)) fail(`phase7-artifact-presentation-state-in-key:${key}`);
    const value = config[key];
    if (value && typeof value === 'object') assertNoPresentationState(value);
  }
}

/**
 * Builds the canonical descriptor for one Phase 7 artifact.
 *
 * `upstreamArtifactIds` is the load-bearing field: the ArtifactStore refuses to
 * serve a record whose upstreams no longer validate, which is what makes stale
 * reuse impossible rather than merely discouraged.
 */
export function createPhase7ArtifactDescriptor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('phase7-artifact-invalid-input');
  const kind = nonEmpty(input.kind ?? input.artifactKind, 'phase7-artifact-kind-required');
  if (!KIND_SET.has(kind)) fail('phase7-artifact-unknown-kind');
  const classes = dependencyClassFor(kind);

  const budgetClass = optional(input.budgetClass);
  // Budget class only belongs in the key when completeness can depend on it.
  // An artifact produced under an exhaustive budget is not interchangeable with
  // one truncated under an interactive budget.
  const keyExtras = {
    phase7SchemaVersion: PHASE7_ARTIFACT_SCHEMA_VERSION,
    architectureId: classes.includes('architecture') || classes.includes('semantic')
      ? nonEmpty(input.architectureId, 'phase7-artifact-architecture-required')
      : optional(input.architectureId),
    abiId: classes.includes('abi') ? optional(input.abiId) : optional(input.abiId),
    platformId: optional(input.platformId),
    snapshotId: nonEmpty(input.snapshotId, 'phase7-artifact-snapshot-required'),
    cfgVersion: classes.includes('cfg') ? nonEmpty(input.cfgVersion, 'phase7-artifact-cfg-version-required') : null,
    ssaVersion: classes.includes('ssa') ? nonEmpty(input.ssaVersion, 'phase7-artifact-ssa-version-required') : null,
    memorySsaVersion: classes.includes('memoryssa')
      ? nonEmpty(input.memorySsaVersion, 'phase7-artifact-memoryssa-version-required')
      : null,
    budgetClass: input.budgetAffectsCompleteness === false ? null : budgetClass,
    calleeSummaryIds: classes.includes('calleeSummaries')
      ? sortedIds(input.calleeSummaryIds, 'phase7-artifact-invalid-callee-summary-id')
      : [],
    libraryModelId: classes.includes('libraryModel') ? optional(input.libraryModelId) : null,
    debugProviderVersion: classes.includes('debugProvider') || classes.includes('debugIdentity')
      ? optional(input.debugProviderVersion)
      : null,
    debugBuildIdentity: classes.includes('debugIdentity') ? optional(input.debugBuildIdentity) : null,
    loaderEvidenceId: classes.includes('loaderEvidence') ? optional(input.loaderEvidenceId) : null,
    userConstraintDigest: classes.includes('userConstraints') ? optional(input.userConstraintDigest) : null,
  };

  const options = input.options ?? {};
  assertNoPresentationState(options);

  return createArtifactDescriptor({
    binaryId: nonEmpty(input.binaryId, 'phase7-artifact-binary-id-required'),
    sliceId: optional(input.sliceId),
    entityId: optional(input.functionId ?? input.entityId),
    artifactKind: kind,
    producerId: nonEmpty(input.analyzerId, 'phase7-artifact-analyzer-required'),
    producerVersion: nonEmpty(input.analyzerVersion, 'phase7-artifact-analyzer-version-required'),
    versions: {
      loader: input.loaderVersion ?? 'n/a',
      architectureSemantic: input.architectureSemanticVersion ?? 'n/a',
      abiSemantic: input.abiSemanticVersion ?? 'n/a',
      semanticSchema: nonEmpty(input.semanticSchemaVersion, 'phase7-artifact-semantic-schema-required'),
    },
    relevance: {
      loader: input.loaderVersion != null,
      architectureSemantic: input.architectureSemanticVersion != null,
      abiSemantic: input.abiSemanticVersion != null,
      semanticSchema: true,
      provider: keyExtras.debugProviderVersion != null,
    },
    providerVersion: keyExtras.debugProviderVersion ?? undefined,
    config: options,
    keyExtras,
    upstreamArtifactIds: sortedIds(input.upstreamArtifactIds, 'phase7-artifact-invalid-upstream-id'),
    originRefs: sortedIds(input.originRefs, 'phase7-artifact-invalid-origin-ref'),
  });
}

/**
 * Explains why a cached artifact does not match a request.
 *
 * Consumers use the returned reason to schedule recomputation. They must never
 * treat "no reason found but ids differ" as permission to use the old record,
 * which is why an unexplained mismatch still reports `identity`.
 */
export function explainArtifactMismatch(expected, observed) {
  if (!expected || !observed) return 'missing';
  if (expected.artifactId === observed.artifactId) return null;
  if (expected.artifactKind !== observed.artifactKind) return 'kind';
  if (expected.binaryId !== observed.binaryId) return 'binary';
  if (expected.producerVersion !== observed.producerVersion) return 'analyzer-version';
  if (stableDigest(expected.versions) !== stableDigest(observed.versions)) return 'semantic-version';
  if (stableDigest(expected.upstreamArtifactIds) !== stableDigest(observed.upstreamArtifactIds)) return 'dependency';
  if (expected.keyMaterialHash !== observed.keyMaterialHash) return 'options';
  return 'identity';
}
