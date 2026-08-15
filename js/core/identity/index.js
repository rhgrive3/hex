const ID_SCHEMA_VERSION = 1;
const HEX_RE = /^[0-9a-f]+$/i;

function fail(code) {
  throw new TypeError(code);
}

function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}

function nonNegativeInteger(value, fallback, code) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(code);
  return number;
}

function sortedStrings(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  return [...new Set(value.map(String).filter(Boolean))].sort();
}

export function jsonSafe(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return value.toString();
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null;
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) fail('identity-cyclic-value');
  seen.add(value);
  let out;
  if (Array.isArray(value)) out = value.map((item) => jsonSafe(item, seen));
  else {
    out = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = jsonSafe(value[key], seen);
      if (normalized !== null || value[key] === null) out[key] = normalized;
    }
  }
  seen.delete(value);
  return out;
}

export function stableStringify(value) {
  return JSON.stringify(jsonSafe(value));
}

function fnv64(text, seed) {
  let hash = BigInt.asUintN(64, seed);
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function stableDigest(value) {
  const text = stableStringify(value);
  return fnv64(text, 0xcbf29ce484222325n) + fnv64(text, 0x84222325cbf29ce4n);
}

function typedId(prefix, payload) {
  return `${prefix}_${stableDigest({ schema: ID_SCHEMA_VERSION, payload })}`;
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail('binary-id-bytes-required');
}

function hex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function createBinaryIdFromDigest(digest) {
  const normalized = nonEmpty(digest, 'binary-id-digest-required').toLowerCase().replace(/^sha256:/, '');
  if (normalized.length !== 64 || !HEX_RE.test(normalized)) fail('binary-id-invalid-sha256');
  return `bin_sha256_${normalized}`;
}

export async function createBinaryId(content) {
  const bytes = bytesOf(content);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('binary-id-sha256-unavailable');
  const digest = await subtle.digest('SHA-256', bytes);
  return createBinaryIdFromDigest(hex(new Uint8Array(digest)));
}

export function createSliceId(input = {}) {
  return typedId('slice', {
    binaryId: nonEmpty(input.binaryId, 'slice-binary-id-required'),
    containerId: input.containerId == null ? null : String(input.containerId),
    index: nonNegativeInteger(input.index, 0, 'slice-index-invalid'),
    architecture: input.architecture == null ? null : String(input.architecture),
    sourceRange: input.sourceRange == null ? null : jsonSafe(input.sourceRange),
  });
}

export function createImageId(input = {}) {
  return typedId('image', {
    binaryId: nonEmpty(input.binaryId, 'image-binary-id-required'),
    sliceId: input.sliceId == null ? null : String(input.sliceId),
    loaderId: nonEmpty(input.loaderId ?? 'unknown', 'image-loader-id-required'),
    imageBase: input.imageBase == null ? null : canonicalAddress(input.imageBase),
  });
}

export function createArtifactId(input = {}) {
  return typedId('artifact', {
    binaryId: nonEmpty(input.binaryId, 'artifact-binary-id-required'),
    sliceId: input.sliceId == null ? null : String(input.sliceId),
    entityId: input.entityId == null ? null : String(input.entityId),
    passId: nonEmpty(input.passId, 'artifact-pass-id-required'),
    passVersion: nonEmpty(input.passVersion ?? '1', 'artifact-pass-version-required'),
    optionsHash: input.optionsHash == null ? null : String(input.optionsHash),
    inputArtifactIds: sortedStrings(input.inputArtifactIds, 'artifact-input-ids-invalid'),
  });
}

export function createEntityId(input = {}) {
  return typedId('entity', {
    binaryId: nonEmpty(input.binaryId, 'entity-binary-id-required'),
    sliceId: input.sliceId == null ? null : String(input.sliceId),
    kind: nonEmpty(input.kind, 'entity-kind-required'),
    identity: jsonSafe(input.identity),
  });
}

export function createFunctionId(input = {}) {
  return typedId('function', {
    binaryId: nonEmpty(input.binaryId, 'function-binary-id-required'),
    sliceId: nonEmpty(input.sliceId, 'function-slice-id-required'),
    canonicalStartIdentity: normalizeIdentity(input.canonicalStartIdentity, 'function-start-identity-required'),
  });
}

export function createInstructionId(input = {}) {
  return typedId('instruction', {
    domain: 'native',
    binaryId: nonEmpty(input.binaryId, 'instruction-binary-id-required'),
    sliceId: nonEmpty(input.sliceId, 'instruction-slice-id-required'),
    virtualAddress: canonicalAddress(input.virtualAddress),
    decodeMode: nonEmpty(input.decodeMode ?? 'default', 'instruction-decode-mode-required'),
    decoderSemanticVersion: nonEmpty(input.decoderSemanticVersion, 'instruction-semantic-version-required'),
  });
}

export function createVmOperationId(input = {}) {
  return typedId('operation', {
    domain: 'vm',
    binaryId: nonEmpty(input.binaryId, 'operation-binary-id-required'),
    sliceId: input.sliceId == null ? null : String(input.sliceId),
    vm: nonEmpty(input.vm, 'operation-vm-required'),
    methodId: nonEmpty(input.methodId, 'operation-method-id-required'),
    operationOffset: normalizeIdentity(input.operationOffset, 'operation-offset-required'),
    semanticVersion: nonEmpty(input.semanticVersion, 'operation-semantic-version-required'),
  });
}

export function createEvidenceId(input = {}) {
  return typedId('evidence', {
    binaryId: input.binaryId == null ? null : String(input.binaryId),
    kind: nonEmpty(input.kind ?? 'evidence', 'evidence-kind-required'),
    sourceId: input.sourceId == null ? null : String(input.sourceId),
    identity: jsonSafe(input.identity),
  });
}

export function createRuntimeSessionId(input = {}) {
  return typedId('runtime', {
    binaryId: nonEmpty(input.binaryId, 'runtime-binary-id-required'),
    provider: nonEmpty(input.provider, 'runtime-provider-required'),
    targetIdentity: normalizeIdentity(input.targetIdentity, 'runtime-target-required'),
    sessionNonce: nonEmpty(input.sessionNonce ?? input.startedAt, 'runtime-session-nonce-required'),
  });
}

export function canonicalAddress(value) {
  try {
    const n = typeof value === 'bigint' ? value : BigInt(value);
    if (n < 0n) fail('identity-negative-address');
    return `0x${n.toString(16)}`;
  } catch (error) {
    if (error instanceof TypeError && error.message === 'identity-negative-address') throw error;
    fail('identity-invalid-address');
  }
}

function normalizeIdentity(value, code) {
  if (value == null) fail(code);
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return nonEmpty(value, code);
  return jsonSafe(value);
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export const IDENTITY_SCHEMA_VERSION = ID_SCHEMA_VERSION;
