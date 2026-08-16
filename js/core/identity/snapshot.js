import { deepFreeze, jsonSafe, stableDigest } from './index.js';

function fail(code) { throw new TypeError(code); }
function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function sortedStrings(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  return [...new Set(value.map(String).filter(Boolean))].sort();
}

export function createDeterminismMetadata(input = {}) {
  const passVersions = input.passVersions == null ? {} : jsonSafe(input.passVersions);
  const targetSemanticVersions = input.targetSemanticVersions == null ? {} : jsonSafe(input.targetSemanticVersions);
  return deepFreeze({
    engineBuild: required(input.engineBuild, 'determinism-engine-build-required'),
    schemaVersion: required(input.schemaVersion, 'determinism-schema-version-required'),
    passVersions,
    targetSemanticVersions,
    optionsHash: required(input.optionsHash, 'determinism-options-hash-required'),
    inputArtifactIds: sortedStrings(input.inputArtifactIds, 'determinism-input-artifacts-invalid'),
    outputArtifactId: required(input.outputArtifactId, 'determinism-output-artifact-required'),
    backend: input.backend == null ? 'local' : String(input.backend),
  });
}

export function createAnalysisSnapshot(input = {}) {
  const binaryId = required(input.binaryId, 'snapshot-binary-id-required');
  const projectRevision = required(input.projectRevision ?? '0', 'snapshot-project-revision-required');
  const analysisEpoch = required(input.analysisEpoch ?? '0', 'snapshot-analysis-epoch-required');
  const artifactVersions = jsonSafe(input.artifactVersions ?? {});
  const snapshotId = input.snapshotId == null
    ? `snapshot_${stableDigest({ binaryId, projectRevision, analysisEpoch, artifactVersions })}`
    : required(input.snapshotId, 'snapshot-id-required');
  return deepFreeze({
    snapshotId,
    binaryId,
    projectRevision,
    artifactVersions,
    analysisEpoch,
    createdAt: required(input.createdAt, 'snapshot-created-at-required'),
  });
}
