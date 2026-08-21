import { deepFreeze, stableDigest } from "../../core/identity/index.js";

export const ANALYSIS_SNAPSHOT_SCHEMA_VERSION = 1;

export class AnalysisSnapshotStaleError extends Error {
  constructor(message, { snapshotId, expectedEpoch, currentEpoch } = {}) {
    super(message || "analysis snapshot is stale");
    this.name = "AnalysisSnapshotStaleError";
    this.code = "analysis-snapshot-stale";
    this.snapshotId = snapshotId ?? null;
    this.expectedEpoch = expectedEpoch ?? null;
    this.currentEpoch = currentEpoch ?? null;
  }
}

export function createAnalysisSnapshot({
  binaryId,
  projectRevision = 0,
  artifactVersions = {},
  analysisEpoch = 0,
  createdAt = new Date().toISOString(),
} = {}) {
  if (!binaryId) {
    throw new TypeError("analysis-snapshot-binary-id-required");
  }
  if (analysisEpoch == null) {
    throw new TypeError("analysis-snapshot-epoch-required");
  }

  const sortedArtifacts = {};
  for (const k of Object.keys(artifactVersions || {}).sort()) {
    sortedArtifacts[k] = artifactVersions[k];
  }

  const identityTuple = {
    schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
    binaryId: String(binaryId),
    projectRevision: Number(projectRevision || 0),
    analysisEpoch: Number(analysisEpoch),
    artifactVersions: sortedArtifacts,
  };

  const snapshotId = `snapshot_${stableDigest(identityTuple)}`;

  return deepFreeze({
    schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    binaryId: String(binaryId),
    projectRevision: Number(projectRevision || 0),
    analysisEpoch: Number(analysisEpoch),
    artifactVersions: deepFreeze(sortedArtifacts),
    createdAt: String(createdAt),
  });
}

export function assertAnalysisSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new TypeError("analysis-snapshot-required");
  }
  if (snapshot.schemaVersion !== ANALYSIS_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError("analysis-snapshot-version-mismatch");
  }
  if (!snapshot.snapshotId) {
    throw new TypeError("analysis-snapshot-id-required");
  }
  if (!snapshot.binaryId) {
    throw new TypeError("analysis-snapshot-binary-id-required");
  }
  if (snapshot.analysisEpoch == null) {
    throw new TypeError("analysis-snapshot-epoch-required");
  }
  return snapshot;
}
