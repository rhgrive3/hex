import assert from 'node:assert/strict';
import { EvidenceStore } from '../js/ai/evidence.js';
import { ProposalStore } from '../js/ai/proposals.js';

const evidence = new EvidenceStore();
const verified = evidence.ingest('verify_field_update', { verified: true, evidence: ['ev1'], results: [{ id: 'write', kind: 'function', functionAddress: '0x1000', evidence: ['ev1'] }] }, { verifier: true })[0];
const proposals = new ProposalStore({ evidenceStore: evidence });
const rename = proposals.create({ kind: 'rename', target: '0x1000', before: 'sub_1000', after: 'addCoins', reason: 'verified role', evidenceIds: [verified.id] });
await assert.rejects(() => proposals.apply(rename.id, { currentState: 'sub_1000', apply: async () => {} }), (error) => error.type === 'approval_required');
const approved = proposals.approve(rename.id);
await assert.rejects(() => proposals.apply(rename.id, { approvalToken: approved.approvalToken, currentState: 'changed', apply: async () => {} }), (error) => error.type === 'tool_failed');
assert.equal(rename.status, 'failed');

const rejected = proposals.create({ kind: 'comment', target: '0x1000', before: '', after: 'candidate', evidenceIds: [verified.id] });
proposals.reject(rejected.id);
await assert.rejects(() => proposals.apply(rejected.id, { approvalToken: 'fake', currentState: '', apply: async () => {} }), (error) => error.type === 'approval_required');

const applied = proposals.create({ kind: 'type', target: '0x1000', before: 'void()', after: 'int()', evidenceIds: [verified.id] });
const token = proposals.approve(applied.id).approvalToken;
let invoked = false;
await proposals.apply(applied.id, { approvalToken: token, currentState: 'void()', apply: async () => { invoked = true; } });
assert.equal(invoked, true);
assert.equal(applied.status, 'applied');
console.log('ai-approval: PASS');
