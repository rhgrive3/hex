import { deepFreeze, jsonSafe, stableDigest } from "../../core/identity/index.js";

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

function nonNegativeSafeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(code);
  return number;
}

function normalizeArtifacts(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("analysis-snapshot-artifact-versions-invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("analysis-snapshot-artifact-versions-invalid");
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const cleanKey = String(key).trim();
    if (!cleanKey) throw new TypeError("analysis-snapshot-artifact-version-key-invalid");
    if (Object.prototype.hasOwnProperty.call(normalized, cleanKey)) {
      throw new TypeError("analysis-snapshot-artifact-version-key-ambiguous");
    }
    normalized[cleanKey] = jsonSafe(value[key]);
  }
  return normalized;
}

function identityTuple(value) {
  return {
    schemaVersion: ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
    binaryId: String(value.binaryId),
    projectRevision: nonNegativeSafeInteger(value.projectRevision ?? 0, "analysis-snapshot-project-revision-invalid"),
    analysisEpoch: nonNegativeSafeInteger(value.analysisEpoch, "analysis-snapshot-epoch-invalid"),
    artifactVersions: normalizeArtifacts(value.artifactVersions),
  };
}

function snapshotIdentity(tuple) {
  return `snapshot_${stableDigest(tuple)}`;
}

function normalizeCreatedAt(value) {
  const timestamp = String(value ?? "").trim();
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) throw new TypeError("analysis-snapshot-created-at-invalid");
  return timestamp;
}

export function createAnalysisSnapshot({
  binaryId,
  projectRevision = 0,
  artifactVersions = {},
  analysisEpoch = 0,
  createdAt = new Date().toISOString(),
} = {}) {
  const id = String(binaryId ?? "").trim();
  if (!id) throw new TypeError("analysis-snapshot-binary-id-required");
  const tuple = identityTuple({ binaryId: id, projectRevision, artifactVersions, analysisEpoch });
  return deepFreeze({
    ...tuple,
    snapshotId: snapshotIdentity(tuple),
    artifactVersions: deepFreeze(tuple.artifactVersions),
    createdAt: normalizeCreatedAt(createdAt),
  });
}

export function assertAnalysisSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new TypeError("analysis-snapshot-required");
  if (snapshot.schemaVersion !== ANALYSIS_SNAPSHOT_SCHEMA_VERSION) throw new TypeError("analysis-snapshot-version-mismatch");
  const id = String(snapshot.binaryId ?? "").trim();
  if (!id) throw new TypeError("analysis-snapshot-binary-id-required");
  // createdAt is not part of semantic identity. Older schema-v1 callers may
  // omit it; validate it only when supplied while keeping identity fields
  // strictly self-verifying.
  if (snapshot.createdAt != null) normalizeCreatedAt(snapshot.createdAt);
  const tuple = identityTuple({
    binaryId: id,
    projectRevision: snapshot.projectRevision,
    artifactVersions: snapshot.artifactVersions,
    analysisEpoch: snapshot.analysisEpoch,
  });
  const expected = snapshotIdentity(tuple);
  if (snapshot.snapshotId !== expected) throw new TypeError("analysis-snapshot-identity-mismatch");
  return snapshot;
}
