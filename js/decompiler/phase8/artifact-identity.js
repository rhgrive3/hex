/**
 * Phase 8 artifact identity.
 *
 * Phase 8 publishes derived facts (constants, value numbers, induction
 * summaries, structured regions, aggregate candidates). Every one of them is
 * keyed through the core ArtifactStore descriptor contract rather than a new
 * cache identity, because a second identity scheme is how a stale result gets
 * served after the thing it was derived from changed (Master Architecture §2,
 * ENGINEERING_PROCESS_GUARDRAILS §1.1).
 *
 * The Phase 8 specific part is only the key material: which upstream versions
 * and which pass registry a Phase 8 result actually depends on.
 */

import { createArtifactDescriptor } from '../../core/artifacts/contracts.js';
import { deepFreeze } from '../../core/identity/index.js';

import { PHASE8_CONTRACT_VERSION } from './contract.js';

export const PHASE8_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Artifact kinds Phase 8 may publish, and the upstream dependency classes each
 * one is keyed by. A kind that is not listed cannot be published: an unlisted
 * kind would have no declared invalidation dependencies at all.
 */
export const PHASE8_ARTIFACT_KINDS = Object.freeze({
  'phase8.passLedger': Object.freeze(['cfg', 'ssa']),
  'phase8.constants': Object.freeze(['cfg', 'ssa']),
  'phase8.ranges': Object.freeze(['cfg', 'ssa']),
  'phase8.valueNumbers': Object.freeze(['cfg', 'ssa', 'memoryssa']),
  'phase8.induction': Object.freeze(['cfg', 'ssa']),
  'phase8.structuredRegions': Object.freeze(['cfg']),
  'phase8.aggregates': Object.freeze(['cfg', 'ssa', 'memoryssa']),
});

const KIND_SET = new Set(Object.keys(PHASE8_ARTIFACT_KINDS));

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

function optional(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Presentation state must never enter an artifact key. A cached analysis that
 * depends on the column width of the pretty printer is not an analysis.
 */
const FORBIDDEN_KEY_FIELDS = Object.freeze([
  'columnWidth', 'prettyColumnWidth', 'theme', 'locale', 'language', 'selection', 'scrollTop', 'highlight',
]);

function assertNoPresentationState(config) {
  if (!config || typeof config !== 'object') return;
  for (const key of Object.keys(config)) {
    if (FORBIDDEN_KEY_FIELDS.includes(key)) fail(`phase8-artifact-presentation-state-in-key:${key}`);
    const value = config[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) assertNoPresentationState(value);
  }
}

/**
 * Builds the canonical descriptor for one Phase 8 artifact.
 *
 * `passRegistryDigest` is the load-bearing Phase 8 field: it changes whenever a
 * pass is added, removed or version-bumped, so a result produced by an older
 * optimizer set can never be served for a newer one. `upstreamArtifactIds` does
 * the same job for the facts the pass consumed.
 */
export function createPhase8ArtifactDescriptor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('phase8-artifact-invalid-input');
  const kind = nonEmpty(input.kind ?? input.artifactKind, 'phase8-artifact-kind-required');
  if (!KIND_SET.has(kind)) fail(`phase8-artifact-unknown-kind:${kind}`);
  const classes = PHASE8_ARTIFACT_KINDS[kind];

  const options = input.options ?? {};
  assertNoPresentationState(options);

  const keyExtras = {
    phase8SchemaVersion: PHASE8_ARTIFACT_SCHEMA_VERSION,
    phase8ContractVersion: PHASE8_CONTRACT_VERSION,
    passRegistryDigest: nonEmpty(input.passRegistryDigest, 'phase8-artifact-pass-registry-digest-required'),
    architectureId: nonEmpty(input.architectureId, 'phase8-artifact-architecture-required'),
    abiId: optional(input.abiId),
    snapshotId: nonEmpty(input.snapshotId, 'phase8-artifact-snapshot-required'),
    cfgVersion: classes.includes('cfg') ? nonEmpty(input.cfgVersion, 'phase8-artifact-cfg-version-required') : null,
    ssaVersion: classes.includes('ssa') ? nonEmpty(input.ssaVersion, 'phase8-artifact-ssa-version-required') : null,
    memorySsaVersion: classes.includes('memoryssa')
      ? nonEmpty(input.memorySsaVersion, 'phase8-artifact-memoryssa-version-required')
      : null,
    // Budget class only belongs in the key when completeness can depend on it.
    // A result computed under an exhaustive budget is not interchangeable with
    // one truncated under an interactive budget.
    budgetClass: input.budgetAffectsCompleteness === false ? null : optional(input.budgetClass),
  };

  return createArtifactDescriptor({
    binaryId: nonEmpty(input.binaryId, 'phase8-artifact-binary-id-required'),
    sliceId: optional(input.sliceId),
    entityId: optional(input.functionId ?? input.entityId),
    artifactKind: kind,
    producerId: nonEmpty(input.producerId ?? input.passId, 'phase8-artifact-producer-required'),
    producerVersion: nonEmpty(input.producerVersion ?? input.passVersion, 'phase8-artifact-producer-version-required'),
    versions: {
      loader: input.loaderVersion ?? 'n/a',
      architectureSemantic: input.architectureSemanticVersion ?? 'n/a',
      abiSemantic: input.abiSemanticVersion ?? 'n/a',
      semanticSchema: nonEmpty(input.semanticSchemaVersion, 'phase8-artifact-semantic-schema-required'),
    },
    relevance: {
      loader: input.loaderVersion != null,
      architectureSemantic: input.architectureSemanticVersion != null,
      abiSemantic: input.abiSemanticVersion != null,
      semanticSchema: true,
    },
    config: options,
    keyExtras,
    upstreamArtifactIds: [...new Set((input.upstreamArtifactIds ?? []).map((id) => nonEmpty(id, 'phase8-artifact-invalid-upstream-id')))],
    originRefs: [...new Set((input.originRefs ?? []).map((ref) => nonEmpty(ref, 'phase8-artifact-invalid-origin-ref')))],
  });
}

/** Explains why two descriptors are not interchangeable, for diagnostics. */
export function explainPhase8ArtifactMismatch(expected, observed) {
  const differences = [];
  if (!expected || !observed) return deepFreeze(['missing descriptor']);
  if (expected.artifactId !== observed.artifactId) differences.push('artifactId');
  if (expected.keyMaterialHash !== observed.keyMaterialHash) differences.push('keyMaterialHash');
  if (expected.producerVersion !== observed.producerVersion) differences.push('producerVersion');
  if (expected.versions.semanticSchema !== observed.versions.semanticSchema) differences.push('semanticSchema');
  return deepFreeze(differences);
}
