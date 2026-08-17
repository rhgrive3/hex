import {
  ArtifactCorruptionError,
  canonicalSerializeArtifactRecord,
  decodeArtifactPayload,
  encodeArtifactPayload,
  validateArtifactRecord,
} from '../contracts.js';
import { stableDigest } from '../../identity/index.js';

export const ARTIFACT_STORAGE_ENVELOPE_SCHEMA_VERSION = 1;

const encoder = new TextEncoder();

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new ArtifactCorruptionError(code);
}

function stringArray(value, code) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new ArtifactCorruptionError(code);
  }
  for (let i = 1; i < value.length; i++) {
    if (value[i - 1].localeCompare(value[i]) >= 0) throw new ArtifactCorruptionError(code);
  }
}

function nullableString(value, code) {
  if (value != null && typeof value !== 'string') throw new ArtifactCorruptionError(code);
}

function equalBytes(left, right) {
  const a = left instanceof Uint8Array ? left : new Uint8Array(left);
  const b = right instanceof Uint8Array ? right : new Uint8Array(right);
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

export function normalizeStoredPayloadBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(view);
  }
  throw new ArtifactCorruptionError('artifact-payload-missing');
}

export function validateArtifactRecordShape(record) {
  if (!isObject(record)) throw new ArtifactCorruptionError('artifact-record-malformed');
  requiredString(record.artifactId, 'artifact-record-required-field-missing');
  requiredString(record.artifactKind, 'artifact-record-required-field-missing');
  requiredString(record.producerId, 'artifact-record-required-field-missing');
  requiredString(record.producerVersion, 'artifact-record-required-field-missing');
  requiredString(record.binaryId, 'artifact-record-required-field-missing');
  nullableString(record.sliceId, 'artifact-record-malformed');
  nullableString(record.entityId, 'artifact-record-malformed');
  nullableString(record.runtimeSnapshotId, 'artifact-record-malformed');
  requiredString(record.canonicalConfigHash, 'artifact-record-required-field-missing');
  requiredString(record.payloadChecksum, 'artifact-record-required-field-missing');
  if (!Number.isSafeInteger(record.payloadSize) || record.payloadSize < 0) throw new ArtifactCorruptionError('artifact-record-malformed');
  if (!isObject(record.versions)) throw new ArtifactCorruptionError('artifact-record-malformed');
  for (const key of ['loader', 'architectureSemantic', 'abiSemantic', 'semanticSchema', 'platform', 'runtime', 'plugin', 'provider']) {
    requiredString(record.versions[key], 'artifact-record-required-field-missing');
  }
  stringArray(record.upstreamArtifactIds, 'artifact-record-malformed');
  stringArray(record.originRefs, 'artifact-record-malformed');
  return true;
}

export function canonicalStoredRecord(record) {
  validateArtifactRecordShape(record);
  try {
    return freeze(JSON.parse(canonicalSerializeArtifactRecord(record)));
  } catch (error) {
    if (error instanceof ArtifactCorruptionError) throw error;
    throw new ArtifactCorruptionError('artifact-record-malformed', 'Artifact record cannot be canonically serialized', { cause:String(error) });
  }
}

export function artifactRecordChecksum(record) {
  return stableDigest({ storageEnvelopeSchemaVersion:ARTIFACT_STORAGE_ENVELOPE_SCHEMA_VERSION, record:JSON.parse(canonicalSerializeArtifactRecord(record)) });
}

export function createStorageEnvelopeFields(record) {
  return Object.freeze({
    storageEnvelopeSchemaVersion:ARTIFACT_STORAGE_ENVELOPE_SCHEMA_VERSION,
    recordChecksum:artifactRecordChecksum(record),
  });
}

export function validateStorageEnvelope(raw, record) {
  const hasVersion = Object.hasOwn(raw, 'storageEnvelopeSchemaVersion');
  const hasChecksum = Object.hasOwn(raw, 'recordChecksum');
  if (!hasVersion && !hasChecksum) return Object.freeze({ legacy:true });
  if (!hasVersion || !hasChecksum || raw.storageEnvelopeSchemaVersion !== ARTIFACT_STORAGE_ENVELOPE_SCHEMA_VERSION) {
    throw new ArtifactCorruptionError('artifact-storage-envelope-schema-mismatch');
  }
  requiredString(raw.recordChecksum, 'artifact-storage-envelope-malformed');
  if (raw.recordChecksum !== artifactRecordChecksum(record)) {
    throw new ArtifactCorruptionError('artifact-record-checksum-mismatch');
  }
  return Object.freeze({ legacy:false });
}

export function validateDescriptorRecord(record, descriptor) {
  if (!descriptor) return true;
  const mismatches = [];
  const compare = (name, actual, expected) => {
    if ((actual ?? null) !== (expected ?? null)) mismatches.push(name);
  };
  compare('artifactId', record.artifactId, descriptor.artifactId);
  compare('producerId', record.producerId, descriptor.producerId);
  compare('producerVersion', record.producerVersion, descriptor.producerVersion);
  compare('binaryId', record.binaryId, descriptor.binaryId);
  compare('sliceId', record.sliceId, descriptor.sliceId);
  compare('entityId', record.entityId, descriptor.entityId);
  compare('runtimeSnapshotId', record.runtimeSnapshotId, descriptor.runtimeSnapshotId);
  compare('canonicalConfigHash', record.canonicalConfigHash, descriptor.canonicalConfigHash);
  for (const key of Object.keys(descriptor.versions || {})) compare(`versions.${key}`, record.versions?.[key], descriptor.versions[key]);
  const expectedUpstreams = descriptor.upstreamArtifactIds || [];
  if (record.upstreamArtifactIds.length !== expectedUpstreams.length || record.upstreamArtifactIds.some((id, index) => id !== expectedUpstreams[index])) {
    mismatches.push('upstreamArtifactIds');
  }
  if (mismatches.length) {
    throw new ArtifactCorruptionError(
      'artifact-record-identity-mismatch',
      'Artifact record does not match the requested canonical descriptor',
      { mismatches },
    );
  }
  return true;
}

export function decodeCanonicalArtifactPayload(bytes) {
  const view = normalizeStoredPayloadBytes(bytes);
  const payload = decodeArtifactPayload(view);
  const canonical = encodeArtifactPayload(payload);
  if (!equalBytes(view, canonical)) {
    throw new ArtifactCorruptionError('artifact-payload-noncanonical', 'Artifact payload does not match canonical-json-v1 encoding');
  }
  return payload;
}

export function validateStoredArtifact(raw, { artifactId, descriptor = null, allowIncomplete = false } = {}) {
  if (!raw || typeof raw !== 'object') throw new ArtifactCorruptionError('artifact-record-malformed');
  if (!Object.hasOwn(raw, 'record')) throw new ArtifactCorruptionError('artifact-record-malformed');
  if (!Object.hasOwn(raw, 'payload')) throw new ArtifactCorruptionError('artifact-payload-missing');
  const payloadBytes = normalizeStoredPayloadBytes(raw.payload);
  const record = canonicalStoredRecord(raw.record);
  validateArtifactRecord(record, payloadBytes, {
    artifactId,
    producerVersion:descriptor?.producerVersion,
    semanticSchemaVersion:descriptor?.versions?.semanticSchema,
    allowIncomplete,
  });
  validateDescriptorRecord(record, descriptor);
  const envelope = validateStorageEnvelope(raw, record);
  const payload = decodeCanonicalArtifactPayload(payloadBytes);
  return { record, payloadBytes, payload, legacyStorageEnvelope:envelope.legacy };
}

export function artifactHotEntrySize(record, payloadBytes) {
  const bytes = payloadBytes instanceof Uint8Array ? payloadBytes : normalizeStoredPayloadBytes(payloadBytes);
  return bytes.byteLength + encoder.encode(canonicalSerializeArtifactRecord(record)).byteLength;
}

export function storageRecordIdentity(record) {
  if (!record || typeof record !== 'object') return null;
  try { return canonicalSerializeArtifactRecord(record); }
  catch { return null; }
}

export function compatiblePublishedArtifact(existingRecord, newRecord, existingPayload, newPayload) {
  if (!existingRecord || !newRecord) return false;
  for (const key of [
    'recordSchemaVersion',
    'artifactContractVersion',
    'artifactId',
    'payloadEncoding',
    'payloadEncodingVersion',
    'payloadChecksum',
    'payloadSize',
    'completeness',
  ]) {
    if (existingRecord[key] !== newRecord[key]) return false;
  }
  try { return equalBytes(existingPayload, newPayload); }
  catch { return false; }
}

export function sameObservedArtifact(existingRecord, expectedRecord, existingPayload, expectedPayload) {
  const leftIdentity = storageRecordIdentity(existingRecord);
  const rightIdentity = storageRecordIdentity(expectedRecord);
  if (!leftIdentity || leftIdentity !== rightIdentity) return false;
  try { return equalBytes(existingPayload, expectedPayload); }
  catch { return false; }
}
