import { AIError } from './schema.js';
import { jsonSafe } from './validation.js';

const PROPOSAL_KINDS = new Set(['rename', 'comment', 'type', 'struct-field', 'patch', 'project-annotation']);
let proposalSequence = 1;

export class ProposalStore {
  constructor({ evidenceStore } = {}) {
    this.evidenceStore = evidenceStore;
    this.records = new Map();
    this.approvals = new Map();
    this.audit = [];
  }

  create(input = {}) {
    if (!PROPOSAL_KINDS.has(input.kind)) throw new AIError('invalid_tool_call', `Unsupported proposal kind: ${input.kind}`);
    const evidenceIds = Array.from(new Set((input.evidenceIds || []).map(String).filter((id) => this.evidenceStore?.has(id))));
    if (!evidenceIds.length) throw new AIError('invalid_tool_call', 'A proposal requires deterministic evidence.');
    const id = String(input.id || `proposal_${proposalSequence++}`);
    const record = {
      id, kind: input.kind, target: jsonSafe(input.target), before: jsonSafe(input.before), after: jsonSafe(input.after),
      reason: String(input.reason || '').slice(0, 2000), evidenceIds,
      createdAt: new Date().toISOString(), status: 'pending',
      revision: fingerprint(input.before),
    };
    this.records.set(id, record);
    this.audit.push({ type: 'proposal-created', proposalId: id, timestamp: record.createdAt });
    return record;
  }

  approve(id) {
    const proposal = this.require(id);
    if (proposal.status !== 'pending') throw new AIError('approval_required', 'Only pending proposals can be approved.');
    proposal.status = 'approved';
    const token = randomToken();
    this.approvals.set(proposal.id, token);
    this.audit.push({ type: 'proposal-approved', proposalId: proposal.id, timestamp: new Date().toISOString() });
    return { proposal, approvalToken: token };
  }

  reject(id) {
    const proposal = this.require(id);
    if (proposal.status !== 'pending' && proposal.status !== 'approved') return proposal;
    proposal.status = 'rejected';
    this.approvals.delete(proposal.id);
    this.audit.push({ type: 'proposal-rejected', proposalId: proposal.id, timestamp: new Date().toISOString() });
    return proposal;
  }

  async apply(id, { approvalToken, currentState, apply } = {}) {
    const proposal = this.require(id);
    if (proposal.status !== 'approved' || this.approvals.get(proposal.id) !== approvalToken) throw new AIError('approval_required', 'A valid user approval token is required.');
    if (fingerprint(currentState) !== proposal.revision) {
      proposal.status = 'failed';
      this.approvals.delete(proposal.id);
      this.audit.push({ type: 'proposal-stale', proposalId: proposal.id, timestamp: new Date().toISOString() });
      throw new AIError('tool_failed', 'The proposal target changed after it was created.');
    }
    if (typeof apply !== 'function') throw new AIError('tool_failed', 'No mutation adapter is available.');
    try {
      await apply(proposal);
      proposal.status = 'applied';
      this.audit.push({ type: 'proposal-applied', proposalId: proposal.id, timestamp: new Date().toISOString() });
      return proposal;
    } catch (error) {
      proposal.status = 'failed';
      this.audit.push({ type: 'proposal-failed', proposalId: proposal.id, timestamp: new Date().toISOString() });
      throw error;
    } finally {
      this.approvals.delete(proposal.id);
    }
  }

  require(id) {
    const value = this.records.get(String(id));
    if (!value) throw new AIError('invalid_tool_call', 'Unknown proposal.');
    return value;
  }
  has(id) { return this.records.has(String(id)); }
  get(id) { return this.records.get(String(id)) || null; }
  all() { return Array.from(this.records.values()); }
}

function fingerprint(value) {
  const text = JSON.stringify(jsonSafe(value));
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  return (hash >>> 0).toString(16);
}

function randomToken() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
