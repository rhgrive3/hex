import { stableDigest } from '../core/identity/index.js';

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

export function createProjectIdentity(input = {}) {
  const projectId = required(input.projectId ?? input.id, 'phase12-project-id-required');
  const binaryKey = required(input.binaryId ?? input.binaryKey, 'phase12-project-binary-id-required');
  return `hex-project:${projectId}:${binaryKey}`;
}

export function createBinaryIdentity(input = {}) {
  const projectId = required(input.projectId, 'phase12-binary-project-id-required');
  const contentHash = required(input.contentHash ?? input.binaryHash, 'phase12-binary-content-hash-required');
  const format = required(input.format, 'phase12-binary-format-required');
  const architecture = required(input.architecture, 'phase12-binary-architecture-required');
  return `hex-binary:${projectId}:${contentHash}:${format}:${architecture}`;
}

export function createEntityIdentity(input = {}) {
  const binaryId = required(input.binaryId, 'phase12-entity-binary-id-required');
  const kind = required(input.kind, 'phase12-entity-kind-required');
  const stableKey = required(input.stableKey ?? input.key, 'phase12-entity-stable-key-required');
  return `hex-entity:${binaryId}:${kind}:${stableKey}`;
}

export function createOperationIdentity(input = {}) {
  const projectId = required(input.projectId, 'phase12-operation-project-id-required');
  const operationId = required(input.operationId, 'phase12-operation-id-required');
  return `hex-operation:${projectId}:${operationId}`;
}

export function identityDigest(value) { return stableDigest(value); }

export function assertIdentityMatch(actual, expected, code = 'phase12-identity-mismatch') {
  if (String(actual ?? '') !== String(expected ?? '')) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return true;
}
