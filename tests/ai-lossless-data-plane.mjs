import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { FACT } from '../js/semantic.js';
import { EvidenceStore } from '../js/ai/evidence.js';
import { createHexToolRegistry } from '../js/ai/tools/index.js';
import { AI_TOOL_NAMES } from '../js/ai/tools/names.js';
import {
  projectCompare, projectObjcDispatch, projectSignature, projectVerification,
} from '../js/ai/tools/projections/index.js';

const BASE = 0x100000000n;
function asm(lines, base = BASE) {
  return lines.map((line, i) => {
    const s = String(line).trim();
    const sp = s.indexOf(' ');
    return { row:i, address:base + BigInt(i) * 4n, mn:sp < 0 ? s : s.slice(0, sp), ops:sp < 0 ? '' : s.slice(sp + 1).trim() };
  });
}
function modelFor(lines, base = BASE) {
  const rowOfAddress = (address) => {
    const rel = address - base;
    if (rel < 0n || rel >= BigInt(lines.length) * 4n) return null;
    return Number(rel / 4n);
  };
  return buildSemanticModel(asm(lines, base), { startRow:0, endRow:lines.length - 1, rowOfAddress });
}

// A. 500 deterministic semantic facts: page 1 must not be mistaken for the whole result.
// Use the host's deterministic fact index so this test measures Data Plane paging,
// not O(n^2)-style stress in the Semantic IR builder.
const indexedFacts = Array.from({ length:500 }, (_, i) => ({
  id:`fact:rmw:${i}`, kind:FACT.RMW, row:i, address:BASE + BigInt(i * 4),
  location:{ key:'field:0x20', kind:'field', disp:0x20n, size:4 },
  operation:'add', evidence:[{ id:`ir:${i}`, instructionId:i, row:i, address:BASE + BigInt(i * 4) }],
}));
// B. A distinct 500-instruction function proves late-region and local Semantic IR access.
const regionLines = Array.from({ length:500 }, () => 'mov x8, x0');
regionLines.push('ret');
const regionModel = modelFor(regionLines);
const evidence = new EvidenceStore();
let signatureCalls = 0;
const context = {
  binaryId:'binary:A', analysisRevision:'rev:1',
  addressExists:() => true,
  analyze:async () => regionModel,
  semanticFactsFor:async (_address, { kinds, limit, offset }) => {
    let rows = indexedFacts;
    if (Array.isArray(kinds) && kinds.length) {
      const wanted = new Set(kinds);
      rows = rows.filter((fact) => wanted.has(fact.kind));
    }
    return { results:rows.slice(offset, offset + limit), total:rows.length, offset, engine:'semantic-facts-index' };
  },
  program:{ functionRange:() => ({ start:BASE, end:BASE + BigInt(regionLines.length * 4) }) },
  resolveObjcDispatch:async () => ({
    resolved:{ address:'0x100001000', method:'-[Wallet addCoins:]' }, confidence:0.74,
    candidates:[{ address:'0x100001000', class:'Wallet' }, { address:'0x100002000', class:'WalletCategory' }],
    requirements:['receiver-dynamic-type'], ambiguity:{ reason:'category-override' },
  }),
  lookupSignature:async () => {
    signatureCalls++;
    return { address:'0x1000', name:'reward_add', signature:'int reward_add(Player *self, int amount)', source:'recovered-type', confidence:0.91, blob:'z'.repeat(9000) };
  },
  compareFunctions:async () => ({
    left:{ address:'0x1000', role:'old' }, right:{ address:'0x2000', role:'new' }, similarity:0.82,
    instructionSimilarity:0.77, semanticDifferences:[{ kind:'field-write', before:'coins', after:'premiumCoins' }],
    changedFields:['coins', 'premiumCoins'], changedCalls:['saveProfile'], summary:'reward path changed',
    fullGraph:Array.from({ length:120 }, (_, i) => ({ id:i, payload:`node-${i}` })),
  }),
};
const registry = createHexToolRegistry(context, { evidenceStore:evidence, maxFunctions:8, maxDisassembly:10000 });

const facts1 = await registry.execute('get_semantic_facts', { functionAddress:'0x100000000', kinds:[FACT.RMW], limit:100 }, { scope:'function' });
assert.equal(facts1.result.total, 500);
assert.equal(facts1.result.returned, 100);
assert.equal(facts1.result.complete, false);
assert.equal(facts1.completeness.total, 500);
assert.ok(facts1.continuation?.cursor);
const facts2 = await registry.execute('get_semantic_facts', { functionAddress:'0x100000000', kinds:[FACT.RMW], limit:100, cursor:facts1.continuation.cursor }, { scope:'function' });
assert.equal(facts2.result.offset, 100);
assert.equal(facts2.result.total, 500);
assert.equal(facts2.result.returned, 100);
assert.equal(facts2.result.engine, 'semantic-facts-index');

const fn = await registry.execute('get_function', { address:'0x100000000' }, { scope:'function' });
assert.equal(fn.result.total, regionLines.length);
assert.equal(fn.result.returned, 160);
assert.equal(fn.result.truncated, true);
const later = await registry.execute('inspect_function_region', { functionAddress:'0x100000000', view:'assembly', start:400, count:50 }, { scope:'function' });
assert.equal(later.result.offset, 400);
assert.equal(later.result.returned, 50);
assert.ok(later.result.results[0].address);
const irRegion = await registry.execute('inspect_function_region', { functionAddress:'0x100000000', view:'semantic-ir', start:400, count:20 }, { scope:'function' });
assert.equal(irRegion.result.returned, 20);
assert.ok(irRegion.result.results.every((row) => row.id != null && row.op));

// C-F. Tool-specific semantic projections retain each tool's meaning.
const objcProjected = projectObjcDispatch(await context.resolveObjcDispatch());
assert.equal(objcProjected.candidates.length, 2);
assert.equal(objcProjected.requirements[0], 'receiver-dynamic-type');
const sigProjected = projectSignature(await context.lookupSignature());
assert.match(sigProjected.signature, /reward_add/);
const verifyProjected = projectVerification({ verified:true, updates:[{ kind:'rmw', location:{ key:'field:coins' } }], causalPaths:[{ nodes:[{ id:1, op:'arg' }, { id:2, op:'add' }, { id:3, op:'store' }] }] });
assert.equal(verifyProjected.causalPaths[0].nodes.length, 3);
const compareProjected = projectCompare(await context.compareFunctions());
assert.equal(compareProjected.similarity, 0.82);
assert.equal(compareProjected.semanticDifferences[0].kind, 'field-write');
assert.deepEqual(compareProjected.changedCalls, ['saveProfile']);

const objc = await registry.execute('resolve_objc_dispatch', { receiverClass:'Wallet', selector:'addCoins:' }, { scope:'binary' });
assert.equal(objc.modelData.candidates.length, 2);
assert.equal(objc.modelData.requirements[0], 'receiver-dynamic-type');
const sig = await registry.execute('lookup_signature', { address:'0x1000' }, { scope:'binary' });
assert.match(sig.modelData.signature, /Player/);
assert.ok(!('blob' in sig.modelData), 'large irrelevant source payload must stay out of model projection');
const cmp = await registry.execute('compare_functions', { leftAddress:'0x1000', rightAddress:'0x2000' }, { scope:'binary' });
assert.equal(cmp.modelData.instructionSimilarity, 0.77);
assert.equal(cmp.modelData.changedFields.length, 2);

// G. Full result is retrievable by detailRef and deterministic repeats reuse it.
const detail = await registry.execute('get_observation_detail', { detailRef:cmp.detailRef, path:'$.fullGraph', limit:40 }, { scope:'binary' });
assert.equal(detail.result.relevantSourceRecords ?? detail.result.data?.length, detail.result.relevantSourceRecords ?? 40);
assert.equal(detail.result.data.length, 40);
assert.equal(detail.result.completeness.total, 120);
assert.ok(detail.result.continuation?.cursor);
const sigAgain = await registry.execute('lookup_signature', { address:'0x1000' }, { scope:'binary' });
assert.equal(sigAgain.cached, true);
assert.equal(signatureCalls, 2, 'one direct projection fixture call plus one registry execution; cached execution must not call provider again');

// H. Evidence source >4KB remains recoverable, while the evidence record itself stays compact.
assert.ok(sig.evidenceIds.length > 0);
const sigEvidence = evidence.get(sig.evidenceIds[0]);
assert.ok(sigEvidence.sourceRef?.detailRef);
assert.equal(sigEvidence.sourceData?.oversized, true);
const evidenceDetail = await registry.execute('get_evidence_detail', { evidenceId:sig.evidenceIds[0], limit:50 }, { scope:'binary' });
assert.equal(evidenceDetail.result.found, true);
assert.equal(evidenceDetail.result.relevantSourceRecords.blob.length, 9000);
assert.match(evidenceDetail.modelData.record.signature ?? evidenceDetail.modelData.semanticFact?.semantic?.signature ?? '', /reward_add/);

// Every evidence-backed observation is pinned, not only oversized sources, and
// pinned provenance remains dereferenceable past the normal observation TTL.
const smallEvidence = evidence.add({ sourceTool:'fixture', kind:'small-source', sourceData:{ tiny:'keep-me' } });
assert.ok(smallEvidence.sourceRef?.detailRef);
const smallRecord = evidence.observationStore.records.get(smallEvidence.sourceRef.detailRef);
assert.equal(smallRecord?.pinned, true);
smallRecord.createdAt = Date.now() - evidence.observationStore.maxAgeMs - 1000;
assert.equal(evidence.observationStore.get(smallEvidence.sourceRef.detailRef).fullResult.tiny, 'keep-me');

// ObservationStore follows the session-namespaced EvidenceStore across registry
// instances, so a later turn can still dereference and reuse deterministic work.
const nextTurnRegistry = createHexToolRegistry(context, { evidenceStore:evidence, maxFunctions:8, maxDisassembly:10000 });
const nextTurnDetail = await nextTurnRegistry.execute('get_evidence_detail', { evidenceId:sig.evidenceIds[0], limit:50 }, { scope:'binary' });
assert.equal(nextTurnDetail.result.relevantSourceRecords.blob.length, 9000);
const nextTurnSig = await nextTurnRegistry.execute('lookup_signature', { address:'0x1000' }, { scope:'binary' });
assert.equal(nextTurnSig.cached, true);
assert.equal(signatureCalls, 2, 'session-bound ObservationStore must reuse deterministic results across registry turns');

// I/J. detail/cursor capabilities are bound to binary + analysis revision.
const boundRef = cmp.detailRef;
context.binaryId = 'binary:B';
await assert.rejects(() => registry.execute('get_observation_detail', { detailRef:boundRef }, { scope:'binary' }), (error) => error.type === 'invalid_tool_call');
context.binaryId = 'binary:A';
const cursorPage = await registry.execute('get_semantic_facts', { functionAddress:'0x100000000', kinds:[FACT.RMW], limit:20 }, { scope:'function' });
context.analysisRevision = 'rev:2';
await assert.rejects(() => registry.execute('get_semantic_facts', { functionAddress:'0x100000000', kinds:[FACT.RMW], limit:20, cursor:cursorPage.continuation.cursor }, { scope:'function' }), (error) => error.type === 'invalid_tool_call');
context.analysisRevision = 'rev:1';
await assert.rejects(() => registry.execute('get_semantic_facts', { functionAddress:'0x100000000', kinds:[FACT.RMW], limit:20, cursor:cursorPage.continuation.cursor.slice(0, -1) + 'x' }, { scope:'function' }), (error) => error.type === 'invalid_tool_call');

// O/P. Symbolic execution remains capped; model-supplied verification cannot self-authorize.
const sym = registry.get('symbolic_execute');
assert.equal(sym.inputSchema.properties.maxPaths.maximum, 32);
assert.equal(sym.inputSchema.properties.maxSteps.maximum, 5000);
assert.equal(sym.inputSchema.properties.timeoutMs.maximum, 1000);
await assert.rejects(() => registry.execute('symbolic_execute', { functionAddress:'0x100000000', maxPaths:33 }, { scope:'function' }), (error) => error.type === 'invalid_tool_call');
const spoof = new EvidenceStore().add({ id:'spoof', sourceTool:'model', kind:'claim', status:'verified', sourceData:{ verified:true } });
assert.equal(spoof.status, 'supported');

// Public contract: missing deterministic tools + capability metadata are discoverable without hardcoded runtime edits.
for (const name of ['find_constant', 'find_paths', 'explain_evidence', 'symbolic_execute', 'resolve_objc_dispatch', 'inspect_function_region', 'get_observation_detail', 'get_evidence_detail']) {
  assert.ok(AI_TOOL_NAMES.includes(name), `${name} missing from AI_TOOL_NAMES`);
  assert.ok(registry.has(name), `${name} missing from registry`);
}
const metadata = registry.definitionsForModel({ scope:'binary' });
const compareMeta = metadata.find((tool) => tool.name === 'compare_functions');
assert.equal(compareMeta.category, 'semantic');
assert.equal(compareMeta.resultKind, 'function-comparison');

console.log('ai-lossless-data-plane: PASS');
