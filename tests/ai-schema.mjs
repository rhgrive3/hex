import assert from 'node:assert/strict';
import { EvidenceStore } from '../js/ai/evidence.js';
import { HypothesisStore } from '../js/ai/hypothesis.js';
import { aiBudget, AI_BUDGETS } from '../js/ai/schema.js';
import { validateAIResult, sanitizeActions } from '../js/ai/validation.js';

const valid = validateAIResult({ mode: 'chat', style: 'analyst', answer: 'ok', futureField: { accepted: true } });
assert.equal(valid.futureField.accepted, true, 'unknown future fields remain forward compatible');
assert.throws(() => validateAIResult({ mode: 'invalid', style: 'analyst', answer: 'no' }), /unsupported value/);
assert.throws(() => validateAIResult({ mode: 'chat', style: 'analyst', answer: 'no', evidence: [{ status: 'verified' }] }), /required/);
assert.throws(() => validateAIResult({ mode: 'chat', style: 'analyst', answer: 'no', actions: [{ kind: 'invented-action' }] }), /unsupported value/);

const hugeBudget = aiBudget('agent', {
  maxModelCalls: 1e9, maxToolCalls: 1e9, maxFunctions: 1e9, maxDisassembly: 1e12,
  maxCost: 1e9, timeoutMs: 24 * 60 * 60 * 1000, contextBytes: 1024 * 1024 * 1024,
});
assert.deepEqual(hugeBudget, AI_BUDGETS.agent, 'untrusted overrides cannot enlarge the reviewed agent budget ceiling');
const reducedBudget = aiBudget('agent', { maxModelCalls: 3, maxToolCalls: 5, maxFunctions: 6, timeoutMs: 2000 });
assert.equal(reducedBudget.maxModelCalls, 3);
assert.equal(reducedBudget.maxToolCalls, 5);
assert.equal(reducedBudget.maxFunctions, 6);
assert.equal(reducedBudget.timeoutMs, 2000);

const evidence = new EvidenceStore();
assert.equal(evidence.add({ id: 'model_fake', kind: 'write', status: 'verified', sourceTool: 'model', title: 'fake' }).status, 'supported');
const verified = evidence.ingest('verify_field_update', {
  verified: true,
  address: '0x1000',
  evidence: ['semantic:write:1'],
  results: [{ id: 'ev_real', kind: 'write', verified: true, functionAddress: '0x1000', evidence: ['semantic:write:1'] }],
}, { verifier: true })[0];
assert.equal(verified.status, 'verified');
const hypotheses = new HypothesisStore(evidence);
assert.equal(hypotheses.upsert({ claim: 'model-only claim', status: 'verified', supportEvidenceIds: [] }).status, 'open');
const modelWithRealEvidence = hypotheses.upsert({ claim: 'arbitrary model claim using real evidence', status: 'verified', supportEvidenceIds: [verified.id] });
assert.equal(modelWithRealEvidence.status, 'supported', 'verified evidence ID alone cannot let the model verify an arbitrary claim');
const pending = hypotheses.upsert({ claim: 'proven claim', status: 'open' });
assert.equal(hypotheses.verify(pending.id, [verified.id]).status, 'verified', 'trusted deterministic verify() creates the terminal verdict');

const actions = sanitizeActions([
  { kind: 'open-function', target: '0x1000' },
  { kind: 'open-function', target: '0xdeadbeef' },
  { kind: 'unknown-action', target: '0x1000' },
], { evidenceStore: evidence, addressExists: (address) => address === '0x1000' });
assert.deepEqual(actions.map((action) => action.target), ['0x1000']);
console.log('ai-schema: PASS');
