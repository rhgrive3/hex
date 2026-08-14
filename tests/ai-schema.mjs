import assert from 'node:assert/strict';
import { EvidenceStore } from '../js/ai/evidence.js';
import { HypothesisStore } from '../js/ai/hypothesis.js';
import { validateAIResult, sanitizeActions } from '../js/ai/validation.js';

const valid = validateAIResult({ mode: 'chat', style: 'analyst', answer: 'ok', futureField: { accepted: true } });
assert.equal(valid.futureField.accepted, true, 'unknown future fields remain forward compatible');
assert.throws(() => validateAIResult({ mode: 'invalid', style: 'analyst', answer: 'no' }), /unsupported value/);
assert.throws(() => validateAIResult({ mode: 'chat', style: 'analyst', answer: 'no', evidence: [{ status: 'verified' }] }), /required/);
assert.throws(() => validateAIResult({ mode: 'chat', style: 'analyst', answer: 'no', actions: [{ kind: 'invented-action' }] }), /unsupported value/);

const evidence = new EvidenceStore();
assert.equal(evidence.add({ id: 'model_fake', kind: 'write', status: 'verified', sourceTool: 'model', title: 'fake' }).status, 'supported');
const verified = evidence.ingest('verify_field_update', { verified: true, address: '0x1000', evidence: ['semantic:write:1'], results: [{ id: 'ev_real', kind: 'write', functionAddress: '0x1000', evidence: ['semantic:write:1'] }] }, { verifier: true })[0];
assert.equal(verified.status, 'verified');
const hypotheses = new HypothesisStore(evidence);
assert.equal(hypotheses.upsert({ claim: 'model-only claim', status: 'verified', supportEvidenceIds: [] }).status, 'open');
assert.equal(hypotheses.upsert({ claim: 'proven claim', status: 'verified', supportEvidenceIds: [verified.id] }).status, 'verified');

const actions = sanitizeActions([
  { kind: 'open-function', target: '0x1000' },
  { kind: 'open-function', target: '0xdeadbeef' },
  { kind: 'unknown-action', target: '0x1000' },
], { evidenceStore: evidence, addressExists: (address) => address === '0x1000' });
assert.deepEqual(actions.map((action) => action.target), ['0x1000']);
console.log('ai-schema: PASS');
