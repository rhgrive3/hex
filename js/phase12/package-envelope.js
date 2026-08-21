import { stableDigest, stableStringify, deepFreeze } from '../core/identity/index.js';
import { importKnowledgePack } from '../signature/index.js';
import { createArtifactDescriptor } from '../core/artifacts/contracts.js';
import { createResourceBudget } from './resource-budget.js';

export const PACKAGE_ENVELOPE_VERSION = 'hex-phase12-package-envelope-v1';
export const PACKAGE_SCHEMA_VERSION = 1;
export const MAX_PACKAGE_INPUT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PACKAGE_LIMITS = Object.freeze({ maxDepth: 64, maxStrings: 200_000, maxStringBytes: 4 * 1024 * 1024, maxTokens: 2_000_000, maxEntries: 1_000_000 });

export class PackageValidationError extends Error {
  constructor(code, message = code, detail = null) { super(message); this.name = 'PackageValidationError'; this.code = code; this.detail = detail; }
}

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new PackageValidationError(code);
  return text;
}

function bytesOf(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new PackageValidationError('package-input-type-invalid');
}

function scanJsonBudget(bytes, limits = {}) {
  const maxDepth = Number(limits.maxDepth || DEFAULT_PACKAGE_LIMITS.maxDepth);
  const maxStrings = Number(limits.maxStrings || DEFAULT_PACKAGE_LIMITS.maxStrings);
  const maxStringBytes = Number(limits.maxStringBytes || DEFAULT_PACKAGE_LIMITS.maxStringBytes);
  const maxTokens = Number(limits.maxTokens || DEFAULT_PACKAGE_LIMITS.maxTokens);
  let depth = 0, strings = 0, stringBytes = 0, tokens = 0, inString = false, escaped = false, currentStringBytes = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    tokens++;
    if (tokens > maxTokens) throw new PackageValidationError('package-token-budget-exceeded');
    if (inString) {
      if (escaped) { escaped = false; currentStringBytes++; continue; }
      if (byte === 92) { escaped = true; continue; }
      if (byte === 34) {
        inString = false; strings++; stringBytes += currentStringBytes; currentStringBytes = 0;
        if (strings > maxStrings || stringBytes > maxStringBytes) throw new PackageValidationError('package-string-budget-exceeded');
      } else currentStringBytes++;
      continue;
    }
    if (byte === 34) { inString = true; currentStringBytes = 0; continue; }
    if (byte === 123 || byte === 91) { depth++; if (depth > maxDepth) throw new PackageValidationError('package-nesting-budget-exceeded'); }
    else if (byte === 125 || byte === 93) depth--;
    if (depth < 0) throw new PackageValidationError('package-json-structure-invalid');
  }
  if (inString || depth !== 0) throw new PackageValidationError('package-json-structure-invalid');
  return Object.freeze({ bytes: bytes.byteLength, depth: maxDepth, strings, stringBytes, tokens });
}

function countEntries(value, limits, depth = 0, state = { entries: 0 }) {
  if (!value || typeof value !== 'object') return state;
  if (depth > limits.maxDepth) throw new PackageValidationError('package-nesting-budget-exceeded');
  if (Array.isArray(value)) {
    state.entries += value.length;
    for (const item of value) countEntries(item, limits, depth + 1, state);
  } else {
    const keys = Object.keys(value);
    state.entries += keys.length;
    for (const key of keys) countEntries(value[key], limits, depth + 1, state);
  }
  if (state.entries > limits.maxEntries) throw new PackageValidationError('package-entry-budget-exceeded');
  return state;
}

export function parseBoundedPackageInput(value, options = {}) {
  const bytes = bytesOf(value);
  const maxBytes = Number(options.maxBytes || MAX_PACKAGE_INPUT_BYTES);
  if (bytes.byteLength > maxBytes) throw new PackageValidationError('package-input-too-large', 'package input exceeds pre-parse byte budget');
  scanJsonBudget(bytes, options);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch (error) { throw new PackageValidationError('package-json-malformed', error.message); }
  const limits = { ...DEFAULT_PACKAGE_LIMITS, ...options };
  countEntries(parsed, limits);
  return Object.freeze({ value: parsed, inputBytes: bytes.byteLength, scan: scanJsonBudget(bytes, options) });
}

function packageKey(input) {
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    kind: input.kind,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    requiredHexApi: input.requiredHexApi || null,
    requiredSemanticVersions: input.requiredSemanticVersions || null,
    supportedTargets: input.supportedTargets || null,
    dependencies: input.dependencies || [],
    payload: input.payload,
  };
}

function normalizeDependencies(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new PackageValidationError('package-dependencies-invalid');
  return value.map((dependency) => {
    if (!dependency || typeof dependency !== 'object') throw new PackageValidationError('package-dependency-invalid');
    const id = required(dependency.packageId ?? dependency.id, 'package-dependency-id-required');
    const contentHash = required(dependency.contentHash, 'package-dependency-content-identity-required');
    if (!/^[a-z0-9:_-]{4,256}$/i.test(contentHash)) throw new PackageValidationError('package-dependency-content-identity-invalid');
    return { packageId: id, contentHash, packageVersion: required(dependency.packageVersion ?? dependency.version, 'package-dependency-version-required') };
  }).sort((a, b) => a.packageId.localeCompare(b.packageId) || a.contentHash.localeCompare(b.contentHash));
}

export function packageContentIdentity(input) { return stableDigest(packageKey(input)); }

export function createPackageEnvelope(input = {}) {
  const kind = required(input.kind, 'package-kind-required');
  const packageId = required(input.packageId ?? `${kind}-local`, 'package-id-required');
  const packageVersion = required(input.packageVersion ?? input.version ?? '1', 'package-version-required');
  if (input.payload === undefined) throw new PackageValidationError('package-payload-required');
  const dependencies = normalizeDependencies(input.dependencies);
  const envelope = {
    format: PACKAGE_ENVELOPE_VERSION,
    manifestVersion: PACKAGE_SCHEMA_VERSION,
    packageId,
    packageVersion,
    kind,
    provenance: input.provenance && typeof input.provenance === 'object' ? input.provenance : { source: 'local' },
    license: String(input.license || 'unspecified'),
    requiredHexApi: input.requiredHexApi || null,
    requiredSemanticVersions: input.requiredSemanticVersions || null,
    supportedTargets: input.supportedTargets || null,
    dependencies,
    payloadIndex: input.payloadIndex || null,
    payload: input.payload,
  };
  envelope.contentHash = packageContentIdentity(envelope);
  return deepFreeze(envelope);
}

function validateEnvelopeShape(envelope, options = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new PackageValidationError('package-envelope-invalid');
  if (envelope.format !== PACKAGE_ENVELOPE_VERSION) throw new PackageValidationError('package-envelope-format-invalid');
  if (envelope.manifestVersion !== PACKAGE_SCHEMA_VERSION) throw new PackageValidationError('package-envelope-version-unsupported');
  required(envelope.packageId, 'package-id-required');
  required(envelope.packageVersion, 'package-version-required');
  required(envelope.kind, 'package-kind-required');
  required(envelope.contentHash, 'package-content-identity-required');
  if (envelope.payload === undefined) throw new PackageValidationError('package-payload-required');
  countEntries(envelope.payload, { ...DEFAULT_PACKAGE_LIMITS, ...options });
  const dependencies = normalizeDependencies(envelope.dependencies);
  const expected = packageContentIdentity({ ...envelope, dependencies });
  if (expected !== envelope.contentHash) throw new PackageValidationError('package-content-identity-mismatch', 'package content identity does not match canonical payload');
  return deepFreeze({ ...envelope, dependencies });
}

export function validatePackageEnvelope(envelope, options = {}) {
  try { return { ok: true, value: validateEnvelopeShape(envelope, options) }; }
  catch (error) { return { ok: false, error: error.message, code: error.code, detail: error.detail || null }; }
}

export function importPhase12Package(value, options = {}) {
  const parsed = typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)
    ? { value }
    : parseBoundedPackageInput(value, options);
  const input = parsed.value;
  if (input?.format === 'hex-knowledge-pack') {
    const legacy = importKnowledgePack(input);
    if (!legacy.ok) throw new PackageValidationError('legacy-knowledge-pack-invalid', legacy.error);
    return createPackageEnvelope({
      kind: 'knowledge', packageId: input.packageId || `legacy-knowledge-${stableDigest(input)}`,
      packageVersion: `v${input.version}`, payload: legacy.pack,
      provenance: input.provenance, license: input.license,
      requiredSemanticVersions: { knowledge: '3', signature: String(input.version) },
      payloadIndex: { signatures: legacy.pack.signatures.length, mappings: legacy.pack.mappings.length },
    });
  }
  const checked = validateEnvelopeShape(input, options);
  return checked;
}

export function resolvePackageDependencies(envelope, dependencies = []) {
  const checked = validateEnvelopeShape(envelope);
  const available = new Map((dependencies || []).map((item) => [item.packageId, item]));
  const resolved = [];
  for (const dependency of checked.dependencies) {
    const found = available.get(dependency.packageId);
    if (!found || found.contentHash !== dependency.contentHash || String(found.packageVersion) !== dependency.packageVersion) {
      throw new PackageValidationError('package-dependency-not-pinned', `dependency ${dependency.packageId} is not resolved to its exact identity`);
    }
    resolved.push(Object.freeze({ packageId: dependency.packageId, contentHash: dependency.contentHash, packageVersion: dependency.packageVersion }));
  }
  return Object.freeze(resolved);
}

export function createPackageArtifactDescriptor(envelope, input = {}) {
  const checked = validateEnvelopeShape(envelope);
  return createArtifactDescriptor({
    binaryId: required(input.binaryId, 'package-artifact-binary-id-required'),
    entityId: input.entityId || null,
    artifactKind: required(input.artifactKind || `phase12.package.${checked.kind}`, 'package-artifact-kind-required'),
    producerId: `package:${checked.packageId}`,
    producerVersion: checked.packageVersion,
    versions: { loader: input.loaderVersion || 'n/a', architectureSemantic: input.architectureSemanticVersion || 'n/a', abiSemantic: input.abiSemanticVersion || 'n/a', semanticSchema: input.semanticSchemaVersion || 'n/a' },
    relevance: { loader: input.loaderVersion != null, architectureSemantic: input.architectureSemanticVersion != null, abiSemantic: input.abiSemanticVersion != null, semanticSchema: input.semanticSchemaVersion != null },
    providerVersion: checked.packageVersion,
    config: input.options || {},
    keyExtras: { packageContentHash: checked.contentHash, packageId: checked.packageId, packageKind: checked.kind },
    upstreamArtifactIds: input.upstreamArtifactIds || [],
    originRefs: input.originRefs || [],
  });
}

export function validateProviderOutput(value, options = {}) {
  const maxEntries = Number(options.maxEntries || 100_000);
  const maxBytes = Number(options.maxBytes || 8 * 1024 * 1024);
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PackageValidationError('provider-output-schema-invalid');
    const encoded = stableStringify(value);
    if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new PackageValidationError('provider-output-too-large');
    const entries = Array.isArray(value.items) ? value.items : Array.isArray(value.results) ? value.results : [];
    if (entries.length > maxEntries) throw new PackageValidationError('provider-output-entry-budget-exceeded');
    if (value.schemaVersion == null || value.provenance == null) throw new PackageValidationError('provider-output-provenance-required');
    if (value.completeness === 'truncated' && value.unique === true) throw new PackageValidationError('provider-output-truncated-unique-invalid');
    for (const item of entries) {
      if (!item || typeof item !== 'object') throw new PackageValidationError('provider-output-item-invalid');
      if (item.id == null || item.targetIdentity == null) throw new PackageValidationError('provider-output-item-identity-required');
    }
    if (options.targetIdentity != null && value.targetIdentity !== options.targetIdentity) throw new PackageValidationError('provider-output-target-mismatch');
    return { ok: true, value: deepFreeze(value) };
  } catch (error) { return { ok: false, error: error.message, code: error.code }; }
}

export function createPackageBudget(options = {}) { return createResourceBudget({ maxBytes: options.maxBytes || MAX_PACKAGE_INPUT_BYTES, maxEntries: options.maxEntries || DEFAULT_PACKAGE_LIMITS.maxEntries, ...options }); }
