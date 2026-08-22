import { AIError } from './schema.js';
import { jsonSafe } from './validation.js';
import { stableDigest } from '../core/identity/index.js';

const PROPOSAL_KINDS = new Set(['rename', 'comment', 'type', 'struct-field', 'patch', 'project-annotation']);
let proposalSequence = 1;

export class ProposalStore {
  constructor({ evidenceStore, binding = null } = {}) {
    this.evidenceStore = evidenceStore;
    this.binding = typeof binding === 'function' ? binding : null;
    this.records = new Map();
    this.approvals = new Map();
    this.audit = [];
  }

  create(input = {}) {
    if (!PROPOSAL_KINDS.has(input.kind)) throw new AIError('invalid_tool_call', `Unsupported proposal kind: ${input.kind}`);
    const evidenceIds = Array.from(new Set((input.evidenceIds || []).map(String).filter((id) => this.evidenceStore?.has(id))));
    if (!evidenceIds.length) throw new AIError('invalid_tool_call', 'A proposal requires deterministic evidence.');
    let id;
    if (input.id) {
      id = String(input.id);
      if (this.records.has(id)) throw new AIError('invalid_tool_call', `Proposal id already exists: ${id}`);
    } else {
      do id = `proposal_${proposalSequence++}`;
      while (this.records.has(id));
    }
    const binding = this.binding?.() || null;
    const record = {
      id, kind: input.kind, target: jsonSafe(input.target), before: jsonSafe(input.before), after: jsonSafe(input.after),
      reason: String(input.reason || '').slice(0, 2000), evidenceIds,
      createdAt: new Date().toISOString(), status: 'pending',
      // Identity/staleness checks use the complete value, never jsonSafe's
      // display-oriented depth/item truncation.
      revision: fingerprint(input.before),
      binding: jsonSafe(binding),
      bindingRevision: fingerprint(binding),
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

    // Consume approval and move to the in-flight state synchronously before any
    // await. A second caller with the same token can no longer pass validation.
    proposal.status = 'applying';
    this.approvals.delete(proposal.id);
    this.audit.push({ type: 'proposal-applying', proposalId: proposal.id, timestamp: new Date().toISOString() });

    if (proposal.bindingRevision !== fingerprint(this.binding?.() || null)) {
      proposal.status = 'failed';
      this.audit.push({ type: 'proposal-binding-mismatch', proposalId: proposal.id, timestamp: new Date().toISOString() });
      throw new AIError('scope_violation', 'The proposal belongs to a different binary, project, or runtime session.');
    }

    if (fingerprint(currentState) !== proposal.revision) {
      proposal.status = 'failed';
      this.audit.push({ type: 'proposal-stale', proposalId: proposal.id, timestamp: new Date().toISOString() });
      throw new AIError('tool_failed', 'The proposal target changed after it was created.');
    }
    if (typeof apply !== 'function') {
      proposal.status = 'failed';
      throw new AIError('tool_failed', 'No mutation adapter is available.');
    }
    try {
      await apply(proposal);
      proposal.status = 'applied';
      this.audit.push({ type: 'proposal-applied', proposalId: proposal.id, timestamp: new Date().toISOString() });
      return proposal;
    } catch (error) {
      proposal.status = 'failed';
      this.audit.push({ type: 'proposal-failed', proposalId: proposal.id, timestamp: new Date().toISOString() });
      throw error;
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

/**
 * Stale-state fingerprint.
 *
 * `revision` and `bindingRevision` are safety checks: they decide whether the
 * thing the user approved is still the thing about to be written. A 32-bit
 * hash is far too small for that job — with a 32-bit digest an unrelated state
 * passes the guard by accident often enough to matter, and it is trivially
 * steerable. The canonical text is therefore digested with the same 128-bit
 * primitive the rest of the product uses for identity.
 *
 * `stableDigest` is given the canonical *text*, never the raw value: the text
 * already carries the type tags, so nothing is lost to `jsonSafe` on the way in.
 */
function fingerprint(value) {
  return stableDigest(canonicalIdentity(value));
}

/**
 * Domain-separated canonical text for one value.
 *
 * The previous encoding described non-JSON values with ordinary objects
 * (`{"$bigint":"1"}`, `{"$number":"NaN"}`, `{"$undefined":true}`) while the
 * ordinary-object branch was free to use those very keys. So `1n` and
 * `{ $bigint: '1' }` produced the same text, and a proposal approved against
 * `before: 1n` passed its stale-state guard against a completely different
 * current state (#1299).
 *
 * Renaming the magic keys only moves that collision. Instead every value kind
 * now carries its own leading tag, and no tag's payload can be produced by
 * another kind:
 *
 *   z null · v undefined · b boolean · i bigint · d number · s string
 *   x symbol/function · t Date · y bytes · m Map · e Set · a array · o object
 *
 * Strings are JSON-quoted after their tag, numbers and bigints are terminated,
 * so concatenating elements with `,` stays unambiguous.
 */
function canonicalIdentity(value, stack = new Set()) {
  if (value === null) return 'z';
  if (value === undefined) return 'v';
  const type = typeof value;
  if (type === 'boolean') return value ? 'b1' : 'b0';
  if (type === 'bigint') return `i${value.toString(10)};`;
  if (type === 'number') {
    if (Number.isNaN(value)) return 'dNaN;';
    if (value === Infinity) return 'dInfinity;';
    if (value === -Infinity) return 'd-Infinity;';
    if (Object.is(value, -0)) return 'd-0;';
    return `d${JSON.stringify(value)};`;
  }
  if (type === 'string') return `s${JSON.stringify(value)}`;
  if (type !== 'object') return `x${JSON.stringify(String(value))}`;

  if (stack.has(value)) throw new AIError('tool_failed', 'Proposal state contains a cyclic value and cannot be fingerprinted safely.');
  stack.add(value);
  try {
    if (value instanceof Date) return `t${JSON.stringify(Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString())}`;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let hexText = '';
      for (const byte of bytes) hexText += byte.toString(16).padStart(2, '0');
      return `y${JSON.stringify(hexText)}`;
    }
    // Map/Set entry order is part of the value, so it is preserved rather than
    // sorted: two maps built in a different order are different states.
    if (value instanceof Map) {
      return `m[${Array.from(value.entries()).map(([k, v]) => `${canonicalIdentity(k, stack)}:${canonicalIdentity(v, stack)}`).join(',')}]`;
    }
    if (value instanceof Set) {
      return `e[${Array.from(value.values()).map((item) => canonicalIdentity(item, stack)).join(',')}]`;
    }
    if (Array.isArray(value)) return `a[${value.map((item) => canonicalIdentity(item, stack)).join(',')}]`;
    // Own keys only, and `__proto__` among them is data here, not a mutation:
    // it is read with Object.keys/direct access and never assigned onto a
    // result object, so it cannot reach a prototype.
    const keys = Object.keys(value).sort();
    return `o{${keys.map((key) => `${JSON.stringify(key)}:${canonicalIdentity(value[key], stack)}`).join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

function randomToken() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
