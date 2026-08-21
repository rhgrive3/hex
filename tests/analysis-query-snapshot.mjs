import assert from "node:assert/strict";
import {
  ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
  createAnalysisSnapshot,
  assertAnalysisSnapshot,
} from "../js/analysis/query/index.js";

console.log("Testing AnalysisQuery snapshot contract...");

// 1. deterministic tuple -> deterministic snapshotId
{
  const s1 = createAnalysisSnapshot({ binaryId: "bin1", projectRevision: 1, analysisEpoch: 2, artifactVersions: { a: "1", b: "2" } });
  const s2 = createAnalysisSnapshot({ binaryId: "bin1", projectRevision: 1, analysisEpoch: 2, artifactVersions: { b: "2", a: "1" } });
  assert.equal(s1.snapshotId, s2.snapshotId);
  console.log("  ok 1 deterministic snapshotId");
}

// 2. createdAt difference does not change snapshotId
{
  const s1 = createAnalysisSnapshot({ binaryId: "bin1", analysisEpoch: 1, createdAt: "2026-01-01T00:00:00Z" });
  const s2 = createAnalysisSnapshot({ binaryId: "bin1", analysisEpoch: 1, createdAt: "2026-01-02T00:00:00Z" });
  assert.equal(s1.snapshotId, s2.snapshotId);
  assert.notEqual(s1.createdAt, s2.createdAt);
  console.log("  ok 2 createdAt does not change snapshotId");
}

// 3. different binary -> different snapshotId
{
  const s1 = createAnalysisSnapshot({ binaryId: "bin1", analysisEpoch: 1 });
  const s2 = createAnalysisSnapshot({ binaryId: "bin2", analysisEpoch: 1 });
  assert.notEqual(s1.snapshotId, s2.snapshotId);
  console.log("  ok 3 different binary -> different snapshotId");
}

// 4. different epoch -> different snapshotId
{
  const s1 = createAnalysisSnapshot({ binaryId: "bin1", analysisEpoch: 1 });
  const s2 = createAnalysisSnapshot({ binaryId: "bin1", analysisEpoch: 2 });
  assert.notEqual(s1.snapshotId, s2.snapshotId);
  console.log("  ok 4 different epoch -> different snapshotId");
}

// 5. artifact version difference -> different snapshotId
{
  const s1 = createAnalysisSnapshot({ binaryId: "bin1", analysisEpoch: 1, artifactVersions: { a: "1" } });
  const s2 = createAnalysisSnapshot({ binaryId: "bin1", analysisEpoch: 1, artifactVersions: { a: "2" } });
  assert.notEqual(s1.snapshotId, s2.snapshotId);
  console.log("  ok 5 artifact version difference -> different snapshotId");
}

// 6. snapshot and artifactVersions are frozen
{
  const s = createAnalysisSnapshot({ binaryId: "bin1", analysisEpoch: 1, artifactVersions: { a: "1" } });
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.artifactVersions));
  console.log("  ok 6 snapshot and artifactVersions frozen");
}

// 7. malformed / version-mismatched snapshot is rejected
{
  assert.throws(() => createAnalysisSnapshot({}), (err) => err.message.includes("analysis-snapshot-binary-id-required"));
  assert.throws(() => assertAnalysisSnapshot(null), (err) => err.message.includes("analysis-snapshot-required"));
  assert.throws(() => assertAnalysisSnapshot({ schemaVersion: 999 }), (err) => err.message.includes("analysis-snapshot-version-mismatch"));
  console.log("  ok 7 malformed snapshot rejected");
}

console.log("All AnalysisQuery snapshot tests PASS!");
