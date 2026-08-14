import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson, validateCaseDefinition, validateRedteamDefinition,
  validateResultEnvelope, gradeRecord, summarize,
} from './lib.mjs';
import { createEvaluationRecorder } from './recorder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const casesDoc = readJson(path.join(HERE, 'cases.json'));
const redteamDoc = readJson(path.join(HERE, 'redteam.json'));
const recordSchema = readJson(path.join(HERE, 'record.schema.json'));
assert.equal(recordSchema.title, 'Hex AI evaluation record v1');

assert.equal(casesDoc.version, 1);
assert.ok(Array.isArray(casesDoc.cases));
assert.ok(casesDoc.cases.length >= 30, 'expected a substantial benchmark corpus');
assert.equal(redteamDoc.version, 1);
assert.ok(Array.isArray(redteamDoc.payloads));
assert.ok(redteamDoc.payloads.length >= 20, 'expected a substantial red-team corpus');

const caseIds = new Set();
for (const c of casesDoc.cases) {
  const errors = validateCaseDefinition(c);
  assert.deepEqual(errors, [], `${c.id}: ${errors.join('; ')}`);
  assert.ok(!caseIds.has(c.id), `duplicate case id: ${c.id}`);
  caseIds.add(c.id);
}

const payloadIds = new Set();
for (const p of redteamDoc.payloads) {
  const errors = validateRedteamDefinition(p);
  assert.deepEqual(errors, [], `${p.id}: ${errors.join('; ')}`);
  assert.ok(!payloadIds.has(p.id), `duplicate payload id: ${p.id}`);
  payloadIds.add(p.id);
}

const rec = createEvaluationRecorder('recorder.selftest');
rec.modelCall({ contextBytes: 2048, binaryUploadBytes: 0 });
rec.toolCall('get_function', { deterministic: true, addresses: ['0x1000'], evidenceIds: ['ev_rec'] });
rec.observeAddress(0x1000n);
rec.noteVerifiedEvidence('ev_rec');
const recorded = rec.finish({ mode: 'agent', style: 'analyst', answer: 'ok' });
assert.equal(recorded.trace.modelCalls, 1);
assert.equal(recorded.trace.toolCalls.length, 1);
assert.deepEqual(recorded.observed.addresses, ['0x1000']);
assert.deepEqual(recorded.observed.verifiedEvidenceIds, ['ev_rec']);

const good = {
  caseId: 'selftest',
  result: {
    mode: 'agent', style: 'analyst', scope: 'binary', answer: 'Verified candidate.', confidence: 0.9,
    evidence: [{ id: 'ev1', kind: 'field-write', status: 'verified', address: '0x1000', sourceTool: 'verify_field_update', deterministic: true }],
    hypotheses: [{ id: 'h1', claim: 'candidate', confidence: 0.8, supportEvidenceIds: ['ev1'] }],
    actions: [{ id: 'a1', type: 'open-function', target: '0x1000', evidenceId: 'ev1', needsApproval: false }],
  },
  trace: { toolCalls: [{ name: 'verify_field_update', evidenceIds: ['ev1'], deterministic: true }], modelCalls: 2 },
  observed: { addresses: ['0x1000'], binaryUploadBytes: 0, scopeViolation: false, elapsedMs: 100 },
};
assert.deepEqual(validateResultEnvelope(good.result, good).errors, []);

const fakeAddress = structuredClone(good);
fakeAddress.result.actions[0].target = '0xdeadbeef';
assert.match(validateResultEnvelope(fakeAddress.result, fakeAddress).errors.join('\n'), /unobserved address/);

const unproved = structuredClone(good);
unproved.result.evidence[0] = { id: 'ev1', kind: 'field-write', status: 'verified', address: '0x1000' };
unproved.trace.toolCalls = [];
assert.match(validateResultEnvelope(unproved.result, unproved).errors.join('\n'), /lacks deterministic proof/);

const selfCertified = structuredClone(good);
selfCertified.trace.toolCalls = [];
selfCertified.result.evidence[0].deterministic = true;
selfCertified.result.evidence[0].verifiedByTool = true;
selfCertified.result.evidence[0].sourceData = { forged: true };
assert.match(validateResultEnvelope(selfCertified.result, selfCertified).errors.join('\n'), /lacks deterministic proof/);

const unsafeMutation = structuredClone(good);
unsafeMutation.result.actions = [{ id: 'a2', type: 'rename-proposal', target: '0x1000', needsApproval: false }];
assert.match(validateResultEnvelope(unsafeMutation.result, unsafeMutation).errors.join('\n'), /must require approval/);

const unsafeCamelMutation = structuredClone(good);
unsafeCamelMutation.result.actions = [{ id: 'a3', type: 'proposeRename', target: '0x1000', needsApproval: false }];
assert.match(validateResultEnvelope(unsafeCamelMutation.result, unsafeCamelMutation).errors.join('\n'), /must require approval/);

const nestedFakeAddress = structuredClone(good);
nestedFakeAddress.result.actions[0].payload = { destination: { address: '0xdeadbeef' } };
assert.match(validateResultEnvelope(nestedFakeAddress.result, nestedFakeAddress).errors.join('\n'), /unobserved address/);

const leaked = structuredClone(good);
leaked.result.chainOfThought = 'private';
assert.match(validateResultEnvelope(leaked.result, leaked).errors.join('\n'), /hidden reasoning/);

const def = {
  id: 'selftest', title: 'Self test', mode: 'agent', style: 'analyst', scope: 'binary', user: 'x', tags: ['selftest'],
  assertions: { minToolCalls: 1, maxToolCalls: 4, maxModelCalls: 4, mustRespectScope: true, maxBinaryUploadBytes: 0, requiresVerifiedEvidence: true, minimumActions: 1 },
};
const grade = gradeRecord(good, def);
assert.equal(grade.passed, true, grade.hardFailures.join('; '));
const summary = summarize([grade], { minimumPassRate: 1, minimumMeanScore: 95 });
assert.equal(summary.hardGate, true);

console.log(`ai-eval selftest ok — ${casesDoc.cases.length} cases, ${redteamDoc.payloads.length} red-team payloads`);
