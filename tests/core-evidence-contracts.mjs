import assert from 'node:assert/strict';
import {
  EvidenceGraph, createEvidenceNode, createClaimNode, createEvidenceEdge,
  EVIDENCE_NODE_FAMILIES, EVIDENCE_EDGE_FAMILIES,
} from '../js/core/evidence/index.js';
import {
  legacyAiEvidenceToCanonical, runtimeEvidenceToCanonical, legacyEvidenceToCanonicalGraph,
} from '../js/core/evidence/compat.js';

for (const family of ['BinaryEvidence','DecodeEvidence','SemanticEvidence','DataflowEvidence','TypeEvidence','ControlFlowEvidence','SignatureEvidence','KnowledgeEvidence','SymbolicEvidence','RuntimeEvidence','UserEvidence','Claim']) {
  assert.ok(EVIDENCE_NODE_FAMILIES.includes(family));
}
for (const edge of ['derived-from','supports','contradicts','refines','observed-at','originates-from','verified-by','matched-by','supersedes']) {
  assert.ok(EVIDENCE_EDGE_FAMILIES.includes(edge));
}

const support = createEvidenceNode({ id:'ev-support', family:'SemanticEvidence', semanticKind:'constant-proof', deterministic:false, confidence:1, completeness:'complete', payload:{ value:7n } });
assert.ok(Object.isFrozen(support));
assert.ok(Object.isFrozen(support.payload));
assert.throws(() => { support.payload.value = 'changed'; }, TypeError, 'evidence must be immutable');
assert.doesNotThrow(() => JSON.stringify(support), 'evidence must be serialization-safe');

const confidenceOnly = createClaimNode({
  id:'claim-confidence-only', family:'Claim', targetEntityIds:['entity-a'], semanticKind:'purpose', confidence:1, verdict:'confirmed', completeness:'complete',
});
assert.equal(confidenceOnly.verdict, 'unverified', 'confidence alone must never promote a claim to confirmed');

const graph = new EvidenceGraph();
graph.addNode(support);
graph.addNode({ id:'ev-contradiction', family:'DataflowEvidence', semanticKind:'counterexample', completeness:'complete', deterministic:true });
graph.addNode({
  id:'claim-a', family:'Claim', targetEntityIds:['entity-a'], semanticKind:'purpose', supportingEvidenceIds:['ev-support'],
  contradictingEvidenceIds:['ev-contradiction'], completeness:'bounded', verdict:'supported', confidence:0.99,
});
const result = graph.evaluateClaim('claim-a');
assert.equal(result.verdict, 'contradicted');
assert.deepEqual(result.supportingEvidenceIds, ['ev-support']);
assert.deepEqual(result.contradictingEvidenceIds, ['ev-contradiction']);
assert.equal(graph.allEdges().length, 0, 'claim reference lists are preserved without rewriting evidence into edges');

const confirmedGraph = new EvidenceGraph({ nodes:[
  { id:'proof', family:'SemanticEvidence', semanticKind:'deterministic-proof', completeness:'complete', deterministic:true },
  { id:'claim-confirmed', family:'Claim', targetEntityIds:['entity-b'], semanticKind:'identity', supportingEvidenceIds:['proof'], completeness:'complete', verdict:'confirmed', confirmedByEvidenceIds:['proof'], confidence:0.2 },
]});
assert.equal(confirmedGraph.evaluateClaim('claim-confirmed').verdict, 'confirmed', 'direct deterministic proof may confirm regardless of confidence score');

const missing = graph.evaluateClaim('unknown-id');
assert.equal(missing.verdict, 'unknown');
assert.deepEqual(missing.missingEvidenceIds, ['unknown-id']);
graph.addEdge(createEvidenceEdge({ type:'supports', from:'claim-a', to:'missing-evidence' }));
assert.deepEqual(graph.unresolvedReferences(), ['missing-evidence'], 'unknown evidence IDs must be reported without crashing');

const serialized = JSON.stringify(graph.toJSON());
const roundTrip = EvidenceGraph.fromJSON(JSON.parse(serialized));
assert.equal(roundTrip.evaluateClaim('claim-a').verdict, 'contradicted', 'contradiction must survive serialization');
assert.throws(() => graph.addNode({ ...support, payload:{ different:true } }), /evidence-id-conflict/, 'evidence id cannot be mutated in place');
assert.throws(() => createEvidenceNode({ id:'bad', family:'NotEvidence' }), /evidence-invalid-family/);
assert.throws(() => createEvidenceEdge({ type:'not-an-edge', from:'a', to:'b' }), /evidence-invalid-edge-family/);
assert.throws(() => createClaimNode({ id:'bad-claim', family:'Claim', semanticKind:'x' }), /evidence-claim-target-required/);
assert.throws(() => createClaimNode({ id:'bad-assumptions', family:'Claim', targetEntityIds:['entity-a'], semanticKind:'x', assumptions:'not-an-array' }), /evidence-invalid-assumptions/);
assert.throws(() => new EvidenceGraph({ nodes:'not-an-array', edges:[] }), /evidence-invalid-nodes/);

const ai = legacyAiEvidenceToCanonical({ id:'legacy-ai', kind:'alias', status:'verified', sourceTool:'prove_alias', confidence:1, timestamp:'2026-08-16T00:00:00.000Z' });
assert.equal(ai.id, 'legacy-ai', 'compatibility adapter must preserve legacy evidence IDs');
assert.equal(ai.family, 'DataflowEvidence');
assert.equal(ai.deterministic, true, 'legacy AI verified status already carries deterministic verifier authority');
const runtime = runtimeEvidenceToCanonical({ id:'runtime-1', source:'runtime', kind:'experiment', binaryHash:'bin-x', sessionId:'session-x', verdict:'confirmed', confidence:1 });
assert.equal(runtime.family, 'RuntimeEvidence');
assert.equal(runtime.deterministic, false, 'runtime compatibility must not convert a confidence/verdict field into deterministic confirmation authority');
const compatGraph = legacyEvidenceToCanonicalGraph({ aiEvidence:[{ id:'legacy-ai-2', kind:'type', status:'supported', sourceTool:'type_recovery' }], runtimeEvidence:[{ id:'runtime-2', source:'runtime', kind:'trace' }] });
assert.equal(compatGraph.allNodes().length, 2);

console.log('core evidence contracts: ok');
