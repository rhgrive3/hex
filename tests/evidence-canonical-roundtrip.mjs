import assert from "node:assert/strict";
import { legacyAiEvidenceToCanonical, canonicalEvidenceToLegacyAi } from "../js/core/evidence/compat.js";
import { EvidenceStore } from "../js/ai/evidence.js";

console.log("Testing Evidence canonical roundtrip...");

const fixtures = [
  {
    id: "ev-verified-1",
    kind: "candidate-verification",
    status: "verified",
    title: "Verified candidate main",
    sourceTool: "deterministic-goal-planner",
    sourceId: "candidate:0x1000",
    sourceRef: { evidenceSourceId: "src-1" },
    sourceBinding: { type: "function", target: "0x1000" },
    address: "0x1000",
    functionAddress: "0x1000",
    functionName: "main",
    summary: "Confirmed candidate",
    sourceData: { score: 100, sources: ["s1", "s2"], nested: { val: 42 } },
    navigation: { address: "0x1000" },
    confidence: 1,
    timestamp: "2026-08-21T00:00:00.000Z",
    completeness: "complete",
    entityId: "ent-1",
    functionId: "fn-1",
    instructionId: "inst-1",
    binaryId: "bin-1",
    binaryHash: "hash-1",
  },
  {
    id: "ev-supported-1",
    kind: "type-recovery",
    status: "supported",
    title: "Supported type int",
    sourceTool: "type-inference",
    sourceId: "src-2",
    confidence: 1, // confidence 1 must NOT make it verified
    timestamp: "2026-08-21T01:00:00.000Z",
    completeness: "partial",
    address: "0x2000",
  },
  {
    id: "ev-hypothesis-1",
    kind: "heuristic-role",
    status: "hypothesis",
    title: "Possible crypto handler",
    sourceTool: "role-heuristics",
    confidence: 0.6,
    completeness: "bounded",
  },
  {
    id: "ev-unknown-1",
    kind: "unknown-observation",
    status: "unknown",
    title: "Unknown state",
    sourceTool: "scanner",
    confidence: 0.1,
    completeness: "unsupported",
  },
];

for (const input of fixtures) {
  const canonical = legacyAiEvidenceToCanonical(input);
  const roundTrip = canonicalEvidenceToLegacyAi(canonical);

  assert.equal(roundTrip.id, input.id);
  assert.equal(roundTrip.kind, input.kind);
  assert.equal(roundTrip.status, input.status);
  assert.equal(roundTrip.title, input.title);
  assert.equal(roundTrip.sourceTool, input.sourceTool);
  if (input.sourceId !== undefined) assert.equal(roundTrip.sourceId, input.sourceId);
  if (input.sourceRef !== undefined) assert.deepEqual(roundTrip.sourceRef, input.sourceRef);
  if (input.sourceBinding !== undefined) assert.deepEqual(roundTrip.sourceBinding, input.sourceBinding);
  if (input.address !== undefined) assert.equal(roundTrip.address, input.address);
  if (input.functionAddress !== undefined) assert.equal(roundTrip.functionAddress, input.functionAddress);
  if (input.functionName !== undefined) assert.equal(roundTrip.functionName, input.functionName);
  if (input.summary !== undefined) assert.equal(roundTrip.summary, input.summary);
  if (input.sourceData !== undefined) assert.deepEqual(roundTrip.sourceData, input.sourceData);
  if (input.navigation !== undefined) assert.deepEqual(roundTrip.navigation, input.navigation);
  if (input.confidence !== undefined) assert.equal(roundTrip.confidence, input.confidence);
  if (input.timestamp !== undefined) assert.equal(roundTrip.timestamp, input.timestamp);
  if (input.completeness !== undefined) assert.equal(roundTrip.completeness, input.completeness);
  if (input.entityId !== undefined) assert.equal(roundTrip.entityId, input.entityId);
  if (input.functionId !== undefined) assert.equal(roundTrip.functionId, input.functionId);
  if (input.instructionId !== undefined) assert.equal(roundTrip.instructionId, input.instructionId);
  if (input.binaryId !== undefined) assert.equal(roundTrip.binaryId, input.binaryId);
  if (input.binaryHash !== undefined) assert.equal(roundTrip.binaryHash, input.binaryHash);
}
console.log("  ok fixtures round trip");

// Dedicated assertions:
// 1. verified remains verified and deterministic
const vCanonical = legacyAiEvidenceToCanonical(fixtures[0]);
assert.equal(vCanonical.deterministic, true);
assert.equal(canonicalEvidenceToLegacyAi(vCanonical).status, "verified");

// 2. supported does not become verified
const sCanonical = legacyAiEvidenceToCanonical(fixtures[1]);
assert.equal(sCanonical.deterministic, false);
assert.equal(canonicalEvidenceToLegacyAi(sCanonical).status, "supported");

// 3. hypothesis remains hypothesis
const hCanonical = legacyAiEvidenceToCanonical(fixtures[2]);
assert.equal(canonicalEvidenceToLegacyAi(hCanonical).status, "hypothesis");

// 4. unknown remains unknown
const uCanonical = legacyAiEvidenceToCanonical(fixtures[3]);
assert.equal(canonicalEvidenceToLegacyAi(uCanonical).status, "unknown");

// 5. confidence 1 on non-deterministic supported evidence does not become verified
assert.equal(sCanonical.confidence, 1);
assert.equal(sCanonical.deterministic, false);
assert.equal(canonicalEvidenceToLegacyAi(sCanonical).status, "supported");

// 6. timestamp is unchanged
assert.equal(canonicalEvidenceToLegacyAi(vCanonical).timestamp, fixtures[0].timestamp);

// 7. sourceRef/sourceBinding are unchanged
assert.deepEqual(canonicalEvidenceToLegacyAi(vCanonical).sourceRef, fixtures[0].sourceRef);
assert.deepEqual(canonicalEvidenceToLegacyAi(vCanonical).sourceBinding, fixtures[0].sourceBinding);

// 8. sourceData nested objects survive JSON-safe conversion
assert.deepEqual(canonicalEvidenceToLegacyAi(vCanonical).sourceData, fixtures[0].sourceData);

// 9. address/functionAddress survive
assert.equal(canonicalEvidenceToLegacyAi(vCanonical).address, fixtures[0].address);
assert.equal(canonicalEvidenceToLegacyAi(vCanonical).functionAddress, fixtures[0].functionAddress);

// 10. original target-key ownership survives
assert.equal(canonicalEvidenceToLegacyAi(vCanonical).entityId, fixtures[0].entityId);
assert.equal(canonicalEvidenceToLegacyAi(vCanonical).functionId, fixtures[0].functionId);
assert.equal(canonicalEvidenceToLegacyAi(vCanonical).instructionId, fixtures[0].instructionId);

// 11. completeness survives
assert.equal(canonicalEvidenceToLegacyAi(vCanonical).completeness, fixtures[0].completeness);

// 12. converting the same record twice yields deeply equal canonical JSON
const c1 = legacyAiEvidenceToCanonical(fixtures[0]);
const c2 = legacyAiEvidenceToCanonical(fixtures[0]);
assert.deepEqual(JSON.stringify(c1), JSON.stringify(c2));

// EvidenceStore snapshot tests
const store = new EvidenceStore();
store.add({ id: "e1", kind: "test", status: "supported", title: "E1" });
store.add({ id: "e2", kind: "test", status: "supported", title: "E2" });

const snap1 = store.canonicalSnapshot();
// 13. graph.toJSON().nodes.length === store.all().length
assert.equal(snap1.toJSON().nodes.length, store.all().length);

// 14. prior graph snapshot does not change after another store.add()
const jsonBefore = JSON.stringify(snap1.toJSON());
store.add({ id: "e3", kind: "test", status: "supported", title: "E3" });
assert.equal(JSON.stringify(snap1.toJSON()), jsonBefore);

// 15. a fresh snapshot contains the new record
const snap2 = store.canonicalSnapshot();
assert.equal(snap2.toJSON().nodes.length, 3);
assert.ok(snap2.hasNode("e3"));

// 16. calling canonicalSnapshot does not change store.all()
const storeAllBefore = JSON.stringify(store.all());
store.canonicalSnapshot();
assert.equal(JSON.stringify(store.all()), storeAllBefore);

console.log("All Evidence canonical roundtrip tests PASS!");
