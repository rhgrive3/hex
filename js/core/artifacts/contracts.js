import {
  createArtifactId,
  deepFreeze,
  jsonSafe,
  stableDigest,
  stableStringify,
} from '../identity/index.js';

export const ARTIFACT_CONTRACT_VERSION = 'hex-artifact-contract-v1';
export const ARTIFACT_RECORD_SCHEMA_VERSION = 1;
export const ARTIFACT_STORE_VERSION = 'hex-artifact-store-v1';
export const ARTIFACT_PAYLOAD_ENCODING = 'canonical-json-v1';
export const ARTIFACT_NOT_APPLICABLE_VERSION = 'n/a';

const COMPLETENESS = new Set(['complete', 'bounded', 'partial', 'truncated', 'unsupported']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ArtifactError extends Error {
  constructor(code, message = code, detail = null) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
    this.detail = detail;
  }
}
export class ArtifactCorruptionError extends ArtifactError { constructor(code, message = code, detail = null) { super(code, message, detail); this.name = 'ArtifactCorruptionError'; } }
export class ArtifactStorageError extends ArtifactError { constructor(code, message = code, detail = null) { super(code, message, detail); this.name = 'ArtifactStorageError'; } }
export class ArtifactUnsupportedError extends ArtifactError { constructor(code = 'artifact-storage-unsupported', message = code, detail = null) { super(code, message, detail); this.name = 'ArtifactUnsupportedError'; } }

function required(value, code) { const text = String(value ?? '').trim(); if (!text) throw new ArtifactError(code); return text; }
function optional(value) { return value == null ? null : String(value); }
function version(value, relevant = true) { if (!relevant) return ARTIFACT_NOT_APPLICABLE_VERSION; return required(value, 'artifact-version-required'); }
function sortedStrings(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new ArtifactError('artifact-upstream-ids-invalid');
  return [...new Set(values.map(String).filter(Boolean))].sort();
}

/**
 * Reserved tag names. A canonical form uses these as the single key of a
 * wrapper object, so an ordinary object is not allowed to present the same
 * shape: its own keys are escaped on the way in (see `escapeKey`).
 */
const RESERVED_TAGS = Object.freeze(['$map', '$set', '$bigint']);

/**
 * Escapes an ordinary object key so it can never collide with a reserved tag.
 *
 * Every key that already starts with `$` gains one more `$`. That is
 * injective -- `$set` becomes `$$set`, `$$set` becomes `$$$set` -- so the
 * escaped space and the tag space stay disjoint no matter what a caller
 * supplies, and only configs that actually use `$`-prefixed keys change
 * representation at all.
 */
function escapeKey(key) { return key.startsWith('$') ? `$${key}` : key; }

/** Canonicalizes JS containers before handing them to the one repository digest. */
export function canonicalArtifactKeyValue(value, seen = new WeakSet()) {
  // A BigInt used to canonicalize to a bare decimal string, so `1n` and the
  // string `'1'` produced identical key material even though downstream code
  // distinguishes them (#1263). The tagged form keeps them apart.
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ArtifactError('artifact-key-invalid-number', 'Artifact key values must be finite numbers');
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    throw new ArtifactError('artifact-key-invalid-type', `Artifact key values must be JSON-serializable, received ${typeof value}`);
  }
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) throw new ArtifactError('artifact-key-cyclic-value');
  seen.add(value);
  let out;
  if (value instanceof Map) {
    out = [...value.entries()].map(([key, entryValue]) => [canonicalArtifactKeyValue(key, seen), canonicalArtifactKeyValue(entryValue, seen)]);
    out.sort((a, b) => stableStringify(a[0]).localeCompare(stableStringify(b[0])) || stableStringify(a[1]).localeCompare(stableStringify(b[1])));
    out = { $map: out };
  } else if (value instanceof Set) {
    const values = [...value].map((entry) => canonicalArtifactKeyValue(entry, seen));
    values.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
    out = { $set: values };
  } else if (Array.isArray(value)) {
    out = value.map((entry) => canonicalArtifactKeyValue(entry, seen));
  } else {
    // Ordinary objects used to share the tag namespace, so `new Set([1])` and
    // the plain object `{ $set: [1] }` canonicalized identically (#1282).
    // Escaping the input's own `$` keys keeps container type part of identity.
    out = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(out, escapeKey(key), {
        value: canonicalArtifactKeyValue(value[key], seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  seen.delete(value);
  return out;
}

export function canonicalConfigHash(config = {}) { return stableDigest(canonicalArtifactKeyValue(config)); }

/**
 * Normalizes only behavior-affecting key material. Callers explicitly mark
 * semantic dimensions irrelevant rather than inheriting ambient defaults.
 */
export function createArtifactDescriptor(input = {}) {
  const relevance = input.relevance || {};
  const versions = input.versions || {};
  const config = canonicalArtifactKeyValue(input.config ?? {});
  const keyExtras = canonicalArtifactKeyValue(input.keyExtras ?? {});
  const upstreamArtifactIds = sortedStrings(input.upstreamArtifactIds ?? input.inputArtifactIds ?? []);
  const canonicalConfig = canonicalConfigHash(config);
  const keyMaterialHash = stableDigest({ config, keyExtras });
  const descriptor = {
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    binaryId: required(input.binaryId, 'artifact-binary-id-required'),
    sliceId: optional(input.sliceId),
    entityId: optional(input.entityId),
    artifactKind: required(input.artifactKind ?? input.kind, 'artifact-kind-required'),
    producerId: required(input.producerId ?? input.passId, 'artifact-producer-id-required'),
    producerVersion: required(input.producerVersion ?? input.passVersion ?? '1', 'artifact-producer-version-required'),
    versions: {
      loader: version(versions.loader ?? input.loaderVersion, relevance.loader !== false),
      architectureSemantic: version(versions.architectureSemantic ?? input.architectureSemanticVersion, relevance.architectureSemantic !== false),
      abiSemantic: version(versions.abiSemantic ?? input.abiSemanticVersion, relevance.abiSemantic !== false),
      semanticSchema: version(versions.semanticSchema ?? input.semanticSchemaVersion, relevance.semanticSchema !== false),
      platform: version(versions.platform ?? input.platformVersion, relevance.platform === true),
      runtime: version(versions.runtime ?? input.runtimeVersion, relevance.runtime === true),
      plugin: version(versions.plugin ?? input.pluginVersion, relevance.plugin === true),
      provider: version(versions.provider ?? input.providerVersion, relevance.provider === true),
    },
    runtimeSnapshotId: relevance.runtimeSnapshot === true ? required(input.runtimeSnapshotId, 'artifact-runtime-snapshot-required') : null,
    canonicalConfigHash:canonicalConfig,
    keyMaterialHash,
    upstreamArtifactIds,
    originRefs:sortedStrings(input.originRefs ?? []),
  };
  // `createArtifactId()` is a shared identity primitive with no notion of
  // artifact kind, and the descriptor forwarded every dimension except that
  // one -- so two different kinds from the same producer under otherwise
  // identical inputs collided on one store/cache key (#1281). Kind belongs to
  // the descriptor, not to the generic primitive, so it enters identity through
  // the one payload the descriptor owns rather than by widening a primitive
  // every other caller shares. The contract version travels with it so a
  // canonical-format change is visible in the id it produces.
  const optionsHash = stableDigest({
    artifactContractVersion:ARTIFACT_CONTRACT_VERSION,
    artifactKind:required(input.artifactKind ?? input.kind, 'artifact-kind-required'),
    configHash:canonicalConfig,
    keyExtrasHash:stableDigest(keyExtras),
    platformVersion:descriptor.versions.platform,
    runtimeVersion:descriptor.versions.runtime,
    pluginVersion:descriptor.versions.plugin,
    providerVersion:descriptor.versions.provider,
    runtimeSnapshotId:descriptor.runtimeSnapshotId,
  });
  descriptor.artifactId = createArtifactId({
    binaryId:descriptor.binaryId,
    sliceId:descriptor.sliceId,
    loaderVersion:descriptor.versions.loader,
    architectureSemanticVersion:descriptor.versions.architectureSemantic,
    abiSemanticVersion:descriptor.versions.abiSemantic,
    semanticSchemaVersion:descriptor.versions.semanticSchema,
    entityId:descriptor.entityId,
    passId:descriptor.producerId,
    passVersion:descriptor.producerVersion,
    optionsHash,
    inputArtifactIds:upstreamArtifactIds,
  });
  return deepFreeze(descriptor);
}

export function encodeArtifactPayload(payload) { return encoder.encode(stableStringify(payload)); }
export function decodeArtifactPayload(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try { return JSON.parse(decoder.decode(view)); }
  catch (error) { throw new ArtifactCorruptionError('artifact-payload-malformed', 'Artifact payload is not valid canonical JSON', { cause:String(error) }); }
}
export function artifactPayloadChecksum(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return stableDigest(Array.from(view));
}

export function createArtifactRecord(descriptor, payloadBytes, metadata = {}) {
  if (!descriptor?.artifactId) throw new ArtifactError('artifact-descriptor-required');
  const bytes = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes);
  const completeness = metadata.completeness ?? 'complete';
  if (!COMPLETENESS.has(completeness)) throw new ArtifactError('artifact-completeness-invalid');
  return deepFreeze({
    recordSchemaVersion:ARTIFACT_RECORD_SCHEMA_VERSION,
    artifactContractVersion:ARTIFACT_CONTRACT_VERSION,
    artifactId:descriptor.artifactId,
    artifactKind:descriptor.artifactKind,
    producerId:descriptor.producerId,
    producerVersion:descriptor.producerVersion,
    versions:descriptor.versions,
    canonicalConfigHash:descriptor.canonicalConfigHash,
    upstreamArtifactIds:descriptor.upstreamArtifactIds,
    binaryId:descriptor.binaryId,
    sliceId:descriptor.sliceId,
    entityId:descriptor.entityId,
    runtimeSnapshotId:descriptor.runtimeSnapshotId,
    originRefs:descriptor.originRefs,
    payloadEncoding:ARTIFACT_PAYLOAD_ENCODING,
    payloadEncodingVersion:1,
    payloadChecksum:artifactPayloadChecksum(bytes),
    payloadSize:bytes.byteLength,
    completeness,
    creation:jsonSafe(metadata.creation ?? {}),
  });
}

export function validateArtifactRecord(record, payloadBytes, expected = {}) {
  if (!record || typeof record !== 'object') throw new ArtifactCorruptionError('artifact-record-malformed');
  if (record.recordSchemaVersion !== ARTIFACT_RECORD_SCHEMA_VERSION) throw new ArtifactCorruptionError('artifact-record-schema-mismatch');
  if (record.artifactContractVersion !== ARTIFACT_CONTRACT_VERSION) throw new ArtifactCorruptionError('artifact-contract-version-mismatch');
  if (!record.artifactId || !record.producerId || !record.producerVersion) throw new ArtifactCorruptionError('artifact-record-required-field-missing');
  if (record.payloadEncoding !== ARTIFACT_PAYLOAD_ENCODING || record.payloadEncodingVersion !== 1) throw new ArtifactCorruptionError('artifact-payload-encoding-unsupported');
  if (record.completeness !== 'complete' && expected.allowIncomplete !== true) throw new ArtifactCorruptionError('artifact-incomplete');
  const bytes = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes ?? 0);
  if (bytes.byteLength !== record.payloadSize) throw new ArtifactCorruptionError('artifact-payload-truncated');
  if (artifactPayloadChecksum(bytes) !== record.payloadChecksum) throw new ArtifactCorruptionError('artifact-payload-checksum-mismatch');
  if (expected.artifactId && record.artifactId !== expected.artifactId) throw new ArtifactCorruptionError('artifact-id-mismatch');
  if (expected.producerVersion && record.producerVersion !== expected.producerVersion) throw new ArtifactCorruptionError('artifact-producer-version-mismatch');
  if (expected.semanticSchemaVersion && record.versions?.semanticSchema !== expected.semanticSchemaVersion) throw new ArtifactCorruptionError('artifact-semantic-schema-mismatch');
  return true;
}
export function canonicalSerializeArtifactRecord(record) { return stableStringify(record); }
