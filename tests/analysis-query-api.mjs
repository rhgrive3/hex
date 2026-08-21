import assert from "node:assert/strict";
import {
  AnalysisQueryAPI,
  createAnalysisSnapshot,
  AnalysisSnapshotStaleError,
} from "../js/analysis/query/index.js";

console.log("Testing AnalysisQuery API contract...");

class FakeAdapter {
  constructor(initialEpoch = 1) {
    this.binaryId = "bin_test";
    this.analysisEpoch = initialEpoch;
    this.calls = [];
  }
  async currentIdentity() {
    return {
      binaryId: this.binaryId,
      projectRevision: 0,
      artifactVersions: {},
      analysisEpoch: this.analysisEpoch,
    };
  }
  async functionById(snapshot, functionId, options) {
    this.calls.push(["functionById", functionId]);
    return { functionId, status: { completeness: "complete" }, value: { name: "fn_" + functionId } };
  }
  async semanticIR(snapshot, functionId, options) {
    this.calls.push(["semanticIR", functionId]);
    return { functionId, nodes: [] };
  }
  async cfg(snapshot, functionId, options) {
    this.calls.push(["cfg", functionId]);
    return { functionId, blocks: [] };
  }
}

// 1. all query methods reject missing snapshot
{
  const adapter = new FakeAdapter();
  const api = new AnalysisQueryAPI(adapter);
  await assert.rejects(async () => api.function(null, "f1"), TypeError);
  await assert.rejects(async () => api.semanticIR(null, "f1"), TypeError);
  await assert.rejects(async () => api.cfg(null, "f1"), TypeError);
  console.log("  ok 1 rejects missing snapshot");
}

// 2. same snapshot generation returns envelope with same snapshotId
{
  const adapter = new FakeAdapter();
  const api = new AnalysisQueryAPI(adapter);
  const snap = await api.snapshot();
  const res = await api.function(snap, "f1");
  assert.equal(res.snapshotId, snap.snapshotId);
  assert.equal(res.analysisEpoch, snap.analysisEpoch);
  assert.equal(res.completeness, "complete");
  assert.deepEqual(res.value, { name: "fn_f1" });
  console.log("  ok 2 same snapshot generation returns envelope");
}

// 3. stale-before-start throws analysis-snapshot-stale and adapter query is not called
{
  const adapter = new FakeAdapter(1);
  const api = new AnalysisQueryAPI(adapter);
  const snap = await api.snapshot();
  adapter.analysisEpoch = 2; // epoch changed
  adapter.calls = [];
  await assert.rejects(async () => api.function(snap, "f1"), (err) => {
    return err instanceof AnalysisSnapshotStaleError && err.code === "analysis-snapshot-stale";
  });
  assert.equal(adapter.calls.length, 0);
  console.log("  ok 3 stale-before-start throws and avoids adapter query");
}

// 4. generation change during an awaited query throws stale after await
{
  const adapter = new FakeAdapter(1);
  adapter.functionById = async (snapshot, functionId) => {
    adapter.analysisEpoch = 2; // epoch bumps while in flight
    return { value: "result" };
  };
  const api = new AnalysisQueryAPI(adapter);
  const snap = createAnalysisSnapshot({ binaryId: "bin_test", analysisEpoch: 1 });
  await assert.rejects(async () => api.function(snap, "f1"), (err) => {
    return err instanceof AnalysisSnapshotStaleError && err.code === "analysis-snapshot-stale";
  });
  console.log("  ok 4 generation change during await throws stale");
}

// 5. aborted signal stops before adapter call
{
  const adapter = new FakeAdapter(1);
  const api = new AnalysisQueryAPI(adapter);
  const snap = await api.snapshot();
  const controller = new AbortController();
  controller.abort();
  adapter.calls = [];
  await assert.rejects(async () => api.function(snap, "f1", { signal: controller.signal }), (err) => {
    return err.name === "AbortError";
  });
  assert.equal(adapter.calls.length, 0);
  console.log("  ok 5 aborted signal stops before adapter call");
}

// 6. legacy result without completeness becomes partial
{
  const adapter = new FakeAdapter(1);
  adapter.functionById = async () => ({ legacy: true });
  const api = new AnalysisQueryAPI(adapter);
  const snap = await api.snapshot();
  const res = await api.function(snap, "f1");
  assert.equal(res.completeness, "partial");
  console.log("  ok 6 legacy result without completeness becomes partial");
}

// 7. query methods never call snapshot() implicitly
{
  let snapshotCalled = 0;
  const adapter = new FakeAdapter(1);
  const origCurrentIdentity = adapter.currentIdentity.bind(adapter);
  adapter.currentIdentity = async () => {
    snapshotCalled++;
    return origCurrentIdentity();
  };
  const api = new AnalysisQueryAPI(adapter);
  const snap = createAnalysisSnapshot({ binaryId: "bin_test", analysisEpoch: 1 });
  snapshotCalled = 0;
  await api.function(snap, "f1");
  // currentIdentity is called to check staleness (twice: before and after), not to mint a new snapshot
  assert.equal(snapshotCalled, 2);
  console.log("  ok 7 query methods never call snapshot() implicitly");
}

// 8. one fake UI transaction can query function + IR + CFG with one snapshot ID
{
  const adapter = new FakeAdapter(1);
  const api = new AnalysisQueryAPI(adapter);
  const snap = await api.snapshot();
  const fnRes = await api.function(snap, "f10");
  const irRes = await api.semanticIR(snap, "f10");
  const cfgRes = await api.cfg(snap, "f10");
  assert.equal(fnRes.snapshotId, snap.snapshotId);
  assert.equal(irRes.snapshotId, snap.snapshotId);
  assert.equal(cfgRes.snapshotId, snap.snapshotId);
  console.log("  ok 8 single snapshot queries function + IR + CFG");
}

console.log("All AnalysisQuery API tests PASS!");
