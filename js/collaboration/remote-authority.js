import { deepFreeze, jsonSafe, stableDigest } from '../core/identity/index.js';
import { CHANGELOG_SCHEMA_VERSION, ChangeLog, createProjectOperation } from './index.js';
import { applyRemoteEnvelopeQueued } from './remote-delivery.js';

export const REMOTE_COLLAB_SCHEMA = 'hex-remote-collaboration-envelope/v1';
export const REMOTE_GATE_SCHEMA = 'hex-remote-collaboration-gate/v1';

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function positive(value, fallback, max, code) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(code);
  return n;
}

function list(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort();
}

function byteLength(value) {
  const text = JSON.stringify(jsonSafe(value));
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
}

function normalizePermissions(value) {
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([actor, permissions]) => [String(actor), list(permissions)]));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([actor, permissions]) => [String(actor), list(permissions)]));
}

function authorized(permissions, operation) {
  if (permissions.includes('*')) return true;
  const fact = `fact:${operation.factKind}`;
  const action = `action:${operation.action}`;
  const combined = `${fact}:action:${operation.action}`;
  return permissions.includes(combined) || (permissions.includes(fact) && permissions.includes(action));
}

export function createRemoteCollaborationEnvelope(input = {}) {
  const projectIdentity = required(input.projectIdentity, 'remote-project-identity-required');
  const binaryIdentity = input.binaryIdentity == null ? null : required(input.binaryIdentity, 'remote-binary-identity-invalid');
  const sessionIdentity = required(input.sessionIdentity, 'remote-session-identity-required');
  const actorIdentity = required(input.actorIdentity, 'remote-actor-identity-required');
  const deviceIdentity = required(input.deviceIdentity, 'remote-device-identity-required');
  const messageId = required(input.messageId, 'remote-message-id-required');
  const sequence = Number(input.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('remote-sequence-invalid');
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new TypeError('remote-operations-required');
  const operations = input.operations.map((operation) => createProjectOperation({
    ...operation,
    projectIdentity,
    binaryIdentity,
    authorIdentity: actorIdentity,
    deviceIdentity,
    provenance: { ...(operation.provenance || {}), source: 'collaborator', transport: 'remote', actorIdentity, deviceIdentity },
  }));
  const envelope = {
    schemaVersion: REMOTE_COLLAB_SCHEMA,
    operationSchemaVersion: CHANGELOG_SCHEMA_VERSION,
    projectIdentity,
    binaryIdentity,
    sessionIdentity,
    actorIdentity,
    deviceIdentity,
    messageId,
    sequence,
    operations,
    transportProof: {
      authenticated: input.transportProof?.authenticated === true,
      confidentiality: input.transportProof?.confidentiality === 'verified' ? 'verified' : 'unverified',
      integrity: input.transportProof?.integrity === 'verified' ? 'verified' : 'unverified',
      proofIdentity: input.transportProof?.proofIdentity == null ? null : String(input.transportProof.proofIdentity),
    },
    egress: {
      userAuthorized: input.egress?.userAuthorized === true,
      rawBinaryBytes: input.egress?.rawBinaryBytes === true,
      derivedDataOnly: input.egress?.derivedDataOnly !== false,
    },
  };
  return deepFreeze({ ...envelope, envelopeId: `remote-envelope:${stableDigest(envelope)}` });
}

export class RemoteCollaborationGate {
  constructor(input = {}) {
    this.schemaVersion = REMOTE_GATE_SCHEMA;
    this.projectIdentity = required(input.projectIdentity, 'remote-gate-project-required');
    this.binaryIdentity = input.binaryIdentity == null ? null : required(input.binaryIdentity, 'remote-gate-binary-invalid');
    this.sessionIdentity = required(input.sessionIdentity, 'remote-gate-session-required');
    this.allowedActors = normalizePermissions(input.allowedActors);
    this.revokedActors = new Set(list(input.revokedActors));
    this.supportedEnvelopeSchemas = new Set(list(input.supportedEnvelopeSchemas || [REMOTE_COLLAB_SCHEMA]));
    this.supportedOperationSchemas = new Set(list(input.supportedOperationSchemas || [CHANGELOG_SCHEMA_VERSION]));
    this.maxBatch = positive(input.maxBatch, 256, 4096, 'remote-gate-max-batch-invalid');
    this.maxMessageBytes = positive(input.maxMessageBytes, 1024 * 1024, 32 * 1024 * 1024, 'remote-gate-max-message-invalid');
    this.seenMessages = new Set();
    this.seenEnvelopeIds = new Set();
    this.lastSequenceByActor = new Map();
    this.verifyTransportProof = typeof input.verifyTransportProof === 'function' ? input.verifyTransportProof : null;
  }

  validate(envelope) {
    if (!envelope || !this.supportedEnvelopeSchemas.has(envelope.schemaVersion)) return { ok: false, reason: 'remote-envelope-schema-unsupported' };
    if (!this.supportedOperationSchemas.has(envelope.operationSchemaVersion)) return { ok: false, reason: 'remote-operation-schema-unsupported' };
    if (envelope.projectIdentity !== this.projectIdentity) return { ok: false, reason: 'remote-wrong-project' };
    if ((envelope.binaryIdentity ?? null) !== this.binaryIdentity) return { ok: false, reason: 'remote-wrong-binary' };
    if (envelope.sessionIdentity !== this.sessionIdentity) return { ok: false, reason: 'remote-wrong-session' };
    if (this.revokedActors.has(envelope.actorIdentity)) return { ok: false, reason: 'remote-actor-revoked' };
    const permissions = this.allowedActors[envelope.actorIdentity];
    if (!permissions) return { ok: false, reason: 'remote-actor-unauthorized' };
    if (this.seenMessages.has(envelope.messageId) || this.seenEnvelopeIds.has(envelope.envelopeId)) return { ok: false, reason: 'remote-replay-or-duplicate' };
    const previous = this.lastSequenceByActor.get(envelope.actorIdentity);
    if (previous != null && envelope.sequence <= previous) return { ok: false, reason: 'remote-stale-sequence' };
    if (!Array.isArray(envelope.operations) || envelope.operations.length === 0 || envelope.operations.length > this.maxBatch) return { ok: false, reason: 'remote-batch-budget-exceeded' };
    if (byteLength(envelope) > this.maxMessageBytes) return { ok: false, reason: 'remote-message-budget-exceeded' };
    if (envelope.transportProof?.authenticated !== true || envelope.transportProof?.confidentiality !== 'verified' || envelope.transportProof?.integrity !== 'verified') {
      return { ok: false, reason: 'remote-transport-security-unverified' };
    }
    if (this.verifyTransportProof && this.verifyTransportProof(envelope.transportProof, envelope) !== true) return { ok: false, reason: 'remote-transport-proof-rejected' };
    if (envelope.egress?.userAuthorized !== true) return { ok: false, reason: 'remote-egress-user-authorization-required' };
    if (envelope.egress?.rawBinaryBytes === true || envelope.egress?.derivedDataOnly !== true) return { ok: false, reason: 'remote-raw-binary-egress-forbidden' };
    for (const operation of envelope.operations) {
      if (operation.projectIdentity !== this.projectIdentity || (operation.binaryIdentity ?? null) !== this.binaryIdentity) return { ok: false, reason: 'remote-operation-scope-mismatch' };
      if (operation.authorIdentity !== envelope.actorIdentity || operation.deviceIdentity !== envelope.deviceIdentity) return { ok: false, reason: 'remote-operation-actor-binding-mismatch' };
      if (operation.provenance?.transport !== 'remote') return { ok: false, reason: 'remote-operation-provenance-invalid' };
      if (!authorized(permissions, operation)) return { ok: false, reason: 'remote-operation-not-authorized', factKind: operation.factKind, action: operation.action };
    }
    return { ok: true };
  }

  accept(envelope) {
    const checked = this.validate(envelope);
    if (!checked.ok) return Object.freeze({ status: 'rejected', reason: checked.reason });
    this.seenMessages.add(envelope.messageId);
    this.seenEnvelopeIds.add(envelope.envelopeId);
    this.lastSequenceByActor.set(envelope.actorIdentity, envelope.sequence);
    return Object.freeze({ status: 'accepted', envelopeId: envelope.envelopeId, operationCount: envelope.operations.length });
  }

  revoke(actorIdentity) {
    this.revokedActors.add(required(actorIdentity, 'remote-revoke-actor-required'));
  }

  snapshot() {
    return deepFreeze({
      schemaVersion: this.schemaVersion,
      projectIdentity: this.projectIdentity,
      binaryIdentity: this.binaryIdentity,
      sessionIdentity: this.sessionIdentity,
      actors: Object.keys(this.allowedActors).sort(),
      revokedActors: [...this.revokedActors].sort(),
      seenMessageCount: this.seenMessages.size,
    });
  }
}

export function applyRemoteEnvelope(log, gate, envelope) {
  return applyRemoteEnvelopeQueued(log, gate, envelope);
}

export class RemoteCollaborationChannel {
  constructor({ gate, log, transport } = {}) {
    if (!(gate instanceof RemoteCollaborationGate)) throw new TypeError('RemoteCollaborationGate required');
    if (!(log instanceof ChangeLog)) throw new TypeError('ChangeLog required');
    if (!transport || typeof transport.send !== 'function') throw new TypeError('remote-transport-send-required');
    this.gate = gate;
    this.log = log;
    this.transport = transport;
  }

  async send(envelope) {
    const checked = this.gate.validate(envelope);
    if (!checked.ok) return { status: 'rejected', reason: checked.reason };
    await this.transport.send(envelope);
    return { status: 'sent', envelopeId: envelope.envelopeId };
  }

  receive(envelope) {
    return applyRemoteEnvelopeQueued(this.log, this.gate, envelope);
  }
}

export function remoteCollaborationSupport({ gate, securityProfileId = null, proof = {} } = {}) {
  const ready = gate instanceof RemoteCollaborationGate
    && !!String(securityProfileId || '').trim()
    && proof.exactHead === true
    && proof.replayTests === true
    && proof.identityTests === true
    && proof.authorizationTests === true
    && proof.transportSecurityTests === true
    && proof.privacyTests === true
    && proof.convergenceTests === true
    && proof.revocationTests === true
    && proof.outOfOrderTests === true;
  return Object.freeze({
    status: ready ? 'supported-for-exact-security-profile' : 'unsupported',
    securityProfileId: securityProfileId == null ? null : String(securityProfileId),
    authority: ready ? 'remote-authorized-canonical-operations' : 'none',
  });
}
