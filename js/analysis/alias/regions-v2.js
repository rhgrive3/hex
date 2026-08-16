import {
  canonicalAddress,
  createMemoryRegionId,
  deepFreeze,
  jsonSafe,
} from '../../core/identity/index.js';
import { createOriginSet, mergeOriginSets } from '../../core/identity/origin.js';
import { createMemoryRegionRef } from '../../semantics/memoryssa/contract.js';
import { normalizeAddressProofIr } from './address-ir-normalize-v2.js';
import {
  canonicalAddressProofToRegionEvidence,
  deriveCanonicalAddressProof,
} from './canonical-address-v2.js';

export const REGION_ALIAS_FLOOR_VERSION = '1.0.0';

const PRECISE_KINDS = new Set([
  'stack-fixed',
  'global-absolute',
  'rooted-offset',
  'tls',
  'io',
  'physical-space',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function toBigIntString(value) {
  try { return (typeof value === 'bigint' ? value : BigInt(value)).toString(); }
  catch { return null; }
}

function originHasEvidence(origin) {
  return !!origin && [
    'byteRanges', 'virtualRanges', 'instructionIds', 'operationIds',
    'sourceLocations', 'parentEntityIds', 'transforms',
  ].some((key) => Array.isArray(origin[key]) && origin[key].length > 0);
}

function normalizedOrigin(...origins) {
  const present = origins.filter((value) => value && typeof value === 'object');
  if (!present.length) return createOriginSet({});
  try { return mergeOriginSets(...present); }
  catch { return createOriginSet({}); }
}

function uniqueBinaryId(origin, explicit) {
  if (nonEmpty(explicit)) return nonEmpty(explicit);
  const ids = new Set((origin?.byteRanges ?? []).map((range) => nonEmpty(range.binaryId)).filter(Boolean));
  return ids.size === 1 ? [...ids][0] : null;
}

function descriptorFrom(value) {
  const source = object(value);
  if (!source) return null;
  const direct = object(source.memoryRegion);
  if (direct) return direct;
  const provenance = object(source.provenance);
  return object(provenance?.memoryRegion) ?? object(provenance?.region) ?? null;
}

function descriptorCandidates(node, value, definingNode, explicit) {
  return [
    descriptorFrom(explicit) ?? object(explicit),
    descriptorFrom(node?.attributes),
    descriptorFrom(node?.metadata),
    descriptorFrom(value?.metadata),
    descriptorFrom(definingNode?.attributes),
    descriptorFrom(definingNode?.metadata),
  ].filter(Boolean);
}

function normalizeDescriptor(raw) {
  const descriptor = object(raw);
  if (!descriptor) return null;
  const kind = nonEmpty(descriptor.kind);
  if (!kind) return null;
  return { ...descriptor, kind };
}

function descriptorWithProofMetadata(descriptor, proof) {
  if (!descriptor || !proof) return descriptor;
  const rootIdentity = object(proof.rootIdentity);
  const storageClass = nonEmpty(rootIdentity?.storageClass);
  if (!storageClass) return descriptor;
  return {
    ...descriptor,
    metadata: {
      ...(object(descriptor.metadata) ?? {}),
      canonicalRootStorageClass: storageClass,
    },
  };
}

function unknownRegion({ functionId, binaryId, widthBits, origin, sourceEntityId, addressValueId, addressSpace, reason, metadata }) {
  const normalizedWidth = Number.isSafeInteger(Number(widthBits)) && Number(widthBits) > 0 ? Number(widthBits) : null;
  const uncertaintyIdentity = {
    sourceEntityId: nonEmpty(sourceEntityId),
    addressValueId: nonEmpty(addressValueId),
    addressSpace: nonEmpty(addressSpace),
    ...(normalizedWidth == null ? {} : { widthBits: normalizedWidth }),
    reason: nonEmpty(reason) ?? 'unproven-memory-region',
  };
  const scope = functionId ? { functionId, binaryId } : { binaryId };
  if (!scope.functionId && !scope.binaryId) {
    throw new TypeError('alias-region-scope-required');
  }
  const id = createMemoryRegionId({
    ...scope,
    regionKind: 'unknown',
    canonicalRegionIdentity: uncertaintyIdentity,
  });
  return createMemoryRegionRef({
    id,
    kind: 'unknown',
    ...scope,
    uncertaintyIdentity,
    ...(normalizedWidth == null ? {} : { widthBits: normalizedWidth }),
    ...(originHasEvidence(origin) ? { origin } : {}),
    metadata: jsonSafe({ reason: uncertaintyIdentity.reason, ...(object(metadata) ?? {}) }),
  });
}

function preciseRegion({ descriptor, functionId, binaryId, widthBits, origin, addressSpace, addressValueId }) {
  const kind = descriptor.kind;
  if (!PRECISE_KINDS.has(kind) || !originHasEvidence(origin)) return null;
  const normalizedWidth = Number(widthBits);
  const scope = { functionId: functionId ?? null, binaryId: binaryId ?? null };
  const common = { kind, widthBits: normalizedWidth, origin };
  let canonicalRegionIdentity;
  let specific;

  if (kind === 'stack-fixed') {
    const offset = toBigIntString(descriptor.offset);
    if (!scope.functionId || offset == null) return null;
    canonicalRegionIdentity = { offset, widthBits: normalizedWidth };
    specific = { functionId: scope.functionId, ...(scope.binaryId ? { binaryId: scope.binaryId } : {}), offset };
  } else if (kind === 'global-absolute') {
    const rawAddress = descriptor.address ?? descriptor.absoluteAddress;
    if (!scope.binaryId || rawAddress == null) return null;
    let address;
    try { address = canonicalAddress(rawAddress); }
    catch { return null; }
    canonicalRegionIdentity = { address, widthBits: normalizedWidth };
    specific = { binaryId: scope.binaryId, ...(scope.functionId ? { functionId: scope.functionId } : {}), address };
  } else if (kind === 'rooted-offset') {
    const rootEntityId = nonEmpty(descriptor.rootEntityId ?? descriptor.rootId);
    const offset = toBigIntString(descriptor.offset ?? 0);
    if (!rootEntityId || offset == null || (!scope.functionId && !scope.binaryId)) return null;
    canonicalRegionIdentity = { rootEntityId, offset, widthBits: normalizedWidth };
    specific = { ...(scope.functionId ? { functionId: scope.functionId } : {}), ...(scope.binaryId ? { binaryId: scope.binaryId } : {}), rootEntityId, offset };
  } else {
    const explicitSpace = nonEmpty(descriptor.addressSpace ?? addressSpace);
    if (!explicitSpace || (!scope.functionId && !scope.binaryId)) return null;
    const rootIdentity = descriptor.rootIdentity ?? (addressValueId ? { addressValueId } : null);
    canonicalRegionIdentity = { addressSpace: explicitSpace, rootIdentity: jsonSafe(rootIdentity), widthBits: normalizedWidth };
    specific = {
      ...(scope.functionId ? { functionId: scope.functionId } : {}),
      ...(scope.binaryId ? { binaryId: scope.binaryId } : {}),
      addressSpace: explicitSpace,
      ...(rootIdentity == null ? {} : { rootIdentity }),
    };
  }

  const id = createMemoryRegionId({
    functionId: specific.functionId ?? null,
    binaryId: specific.binaryId ?? null,
    regionKind: kind,
    canonicalRegionIdentity,
  });
  return createMemoryRegionRef({
    id,
    ...common,
    ...specific,
    ...(descriptor.metadata == null ? {} : { metadata: descriptor.metadata }),
  });
}

export function deriveMemoryRegion(input = {}) {
  const memory = object(input.memory) ?? {};
  const origin = normalizedOrigin(input.origin);
  const functionId = nonEmpty(input.functionId);
  const binaryId = uniqueBinaryId(origin, input.binaryId);
  const widthBits = Number(memory.widthBits ?? input.widthBits);
  const addressSpace = nonEmpty(memory.addressSpace ?? input.addressSpace);
  const addressValueId = nonEmpty(memory.addressExpr?.valueId ?? input.addressValueId);
  const descriptor = normalizeDescriptor(input.regionEvidence ?? input.provenance ?? input.metadata);

  const precise = descriptor && Number.isSafeInteger(widthBits) && widthBits > 0
    ? preciseRegion({ descriptor, functionId, binaryId, widthBits, origin, addressSpace, addressValueId })
    : null;
  if (precise) return precise;

  if (originHasEvidence(origin) && Number.isSafeInteger(widthBits) && widthBits > 0 && (addressSpace === 'tls' || addressSpace === 'io')) {
    const inferred = preciseRegion({
      descriptor: { kind: addressSpace, addressSpace, rootIdentity: addressValueId ? { addressValueId } : null },
      functionId,
      binaryId,
      widthBits,
      origin,
      addressSpace,
      addressValueId,
    });
    if (inferred) return inferred;
  }

  return unknownRegion({
    functionId,
    binaryId,
    widthBits,
    origin,
    sourceEntityId: input.sourceEntityId,
    addressValueId,
    addressSpace,
    reason: descriptor ? 'malformed-or-unproven-region-evidence' : 'missing-region-provenance',
    metadata: object(input.unknownMetadata),
  });
}

function irForAddressRootDerivation(ir) {
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  // A flags-only unknown state effect cannot mutate a non-flag physical root.
  // Only apply this projection when no flag state value is read anywhere in the
  // function, so a flag-derived address can never gain precision accidentally.
  const readsFlagState = nodes.some((node) => node?.kind === 'state-read' && node.variable?.physicalIdentity?.kind === 'flag');
  if (readsFlagState) return ir;
  const ignored = new Set(nodes.filter((node) => {
    if (node?.kind !== 'unknown-state-write') return false;
    const categories = Array.isArray(node.unknown?.categories) ? node.unknown.categories.map(String) : [];
    return categories.length > 0 && categories.every((category) => category === 'flags');
  }).map((node) => String(node.id)));
  if (!ignored.size) return ir;
  return {
    ...ir,
    nodes: nodes.filter((node) => !ignored.has(String(node.id))),
    blocks: (ir.blocks ?? []).map((block) => ({
      ...block,
      nodeIds: (block.nodeIds ?? []).filter((nodeId) => !ignored.has(String(nodeId))),
    })),
  };
}

export function classifySemanticMemoryRegion(ir, nodeOrId, options = {}) {
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  const values = Array.isArray(ir?.values) ? ir.values : [];
  const node = typeof nodeOrId === 'string' ? nodes.find((item) => item.id === nodeOrId) : nodeOrId;
  if (!node || (node.kind !== 'load' && node.kind !== 'store') || !object(node.memory)) {
    return unknownRegion({
      functionId: nonEmpty(ir?.functionId),
      binaryId: nonEmpty(options.binaryId),
      origin: normalizedOrigin(node?.origin, ir?.origin),
      sourceEntityId: node?.id ?? null,
      reason: 'malformed-memory-node',
    });
  }

  const addressValueId = nonEmpty(node.memory.addressExpr?.valueId);
  const value = addressValueId ? values.find((item) => item.id === addressValueId) : null;
  const definingNode = value?.definitionNodeId ? nodes.find((item) => item.id === value.definitionNodeId) : null;
  const accessOrigin = normalizedOrigin(node.origin, value?.origin, definingNode?.origin);
  const explicitDescriptor = descriptorCandidates(node, value, definingNode, options.regionEvidence)
    .map(normalizeDescriptor)
    .find(Boolean) ?? null;

  let proof = null;
  let graphDescriptor = null;
  if (!explicitDescriptor && addressValueId) {
    const proofIr = normalizeAddressProofIr(irForAddressRootDerivation(ir));
    proof = deriveCanonicalAddressProof(proofIr, addressValueId, {
      addressSpace: node.memory.addressSpace,
      ssa: options.ssa,
      rootDescriptors: options.rootDescriptors,
      rootDescriptorProvider: options.rootDescriptorProvider,
    });
    graphDescriptor = descriptorWithProofMetadata(canonicalAddressProofToRegionEvidence(proof), proof);
  }
  const descriptor = explicitDescriptor ?? graphDescriptor;
  const derivationMetadata = proof == null ? null : {
    canonicalAddressKind: proof.kind,
    ...(proof.reason == null ? {} : { canonicalAddressReason: proof.reason }),
  };
  // A canonical region is shared by every equivalent access. Its descriptor
  // therefore uses the function-level IR origin instead of an access-local
  // origin; otherwise equal MemoryRegionIds would carry conflicting objects.
  const regionOrigin = graphDescriptor ? normalizedOrigin(ir.origin) : accessOrigin;

  return deriveMemoryRegion({
    functionId: ir.functionId,
    binaryId: options.binaryId ?? ir.binaryId ?? ir.metadata?.binaryId,
    memory: node.memory,
    origin: regionOrigin,
    sourceEntityId: node.id,
    addressValueId,
    regionEvidence: descriptor,
    unknownMetadata: {
      ...(object(options.unknownMetadata) ?? {}),
      ...(derivationMetadata ?? {}),
    },
  });
}

export function isPreciseMemoryRegion(region) {
  return !!region && PRECISE_KINDS.has(region.kind) && originHasEvidence(region.origin);
}

export function sameMemoryRegionIdentity(a, b) {
  return !!a && !!b && a.id === b.id;
}

export const __regionInternalsForTests = deepFreeze({ originHasEvidence });