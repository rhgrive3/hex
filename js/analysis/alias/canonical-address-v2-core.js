import {
  canonicalAddress,
  deepFreeze,
  jsonSafe,
  stableDigest,
  stableStringify,
} from '../../core/identity/index.js';

export const CANONICAL_ADDRESS_DERIVATION_VERSION = '1.0.2';
export const GENERIC_ROOT_DESCRIPTOR_KINDS = Object.freeze([
  'stack-like',
  'rooted-object',
  'absolute-address',
  'global-like',
  'heap-like',
  'tls-like',
]);

const ROOT_KINDS = new Set(GENERIC_ROOT_DESCRIPTOR_KINDS);
const MAX_DERIVATION_DEPTH = 128;

function parseInteger(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'value')) value = value.value;
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(value.trim())) return BigInt(value.trim());
  } catch {}
  return null;
}

function positiveWidth(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function addressWidth(value, node = null) {
  return positiveWidth(value?.machineType?.widthBits)
    ?? positiveWidth(node?.attributes?.widthBits)
    ?? null;
}

function normalizeModulo(value, widthBits) {
  if (widthBits == null) return value;
  return BigInt.asUintN(widthBits, value);
}

function unknown(reason, detail = null) {
  return deepFreeze({
    kind: 'unknown',
    reason: String(reason),
    ...(detail == null ? {} : { detail: jsonSafe(detail) }),
  });
}

function scalarConstant(value, widthBits, sourceEntityId) {
  return deepFreeze({
    kind: 'constant',
    value: normalizeModulo(value, widthBits),
    widthBits,
    sourceEntityId: sourceEntityId == null ? null : String(sourceEntityId),
  });
}

function proofRootKind(root) {
  return root?.kind === 'root-only' ? root.rootKind : root?.kind;
}

function rootIdentityKey(root) {
  const kind = proofRootKind(root);
  if (!root || !['rooted', 'stack-like'].includes(kind)) return null;
  return stableStringify({
    kind,
    addressSpace: root.addressSpace,
    rootIdentity: root.rootIdentity,
    rootEntityId: root.rootEntityId ?? null,
  });
}

// Exported so P7-2's range-valued points-to solver can name exactly the same
// root as the exact canonical derivation. Two spellings of one root identity
// would silently split every A2 refinement away from the A1 answer.
export function normalizeRootIdentity(variable, functionId) {
  const identity = {
    kind: 'semantic-state-root',
    functionId: String(functionId),
    variable: {
      key: String(variable?.key ?? ''),
      kind: String(variable?.kind ?? 'unknown-state'),
      scope: String(variable?.scope ?? 'unknown'),
      ...(variable?.physicalIdentity == null ? {} : { physicalIdentity: jsonSafe(variable.physicalIdentity) }),
    },
  };
  return deepFreeze(identity);
}

export function defaultRootEntityId(rootIdentity) {
  return `entity_memory_root_${stableDigest({
    version: CANONICAL_ADDRESS_DERIVATION_VERSION,
    rootIdentity,
  })}`;
}

function normalizeGenericDescriptor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const kind = String(input.kind ?? '');
  if (!ROOT_KINDS.has(kind)) return null;
  const addressSpace = input.addressSpace == null ? null : String(input.addressSpace);
  if (kind === 'stack-like') {
    const baseOffset = parseInteger(input.baseOffset ?? 0);
    if (baseOffset == null) return null;
    return deepFreeze({
      kind,
      baseOffset,
      addressSpace,
      linearOffsets: input.linearOffsets !== false,
      ...(input.rootIdentity == null ? {} : { rootIdentity: jsonSafe(input.rootIdentity) }),
    });
  }
  if (kind === 'rooted-object' || kind === 'global-like' || kind === 'heap-like' || kind === 'tls-like') {
    const baseOffset = parseInteger(input.baseOffset ?? 0);
    if (baseOffset == null) return null;
    const rootEntityId = input.rootEntityId == null ? null : String(input.rootEntityId).trim();
    if (input.rootEntityId != null && !rootEntityId) return null;
    const resolvedSpace = addressSpace ?? (kind === 'tls-like' ? 'tls' : null);
    return deepFreeze({
      kind: 'rooted-object',
      baseOffset,
      addressSpace: resolvedSpace,
      linearOffsets: input.linearOffsets !== false,
      ...(rootEntityId ? { rootEntityId } : {}),
      ...(input.rootIdentity == null ? {} : { rootIdentity: jsonSafe(input.rootIdentity) }),
    });
  }
  let address;
  try { address = BigInt(canonicalAddress(input.address)); }
  catch { return null; }
  return deepFreeze({ kind, address, addressSpace });
}

function descriptorLookup(source, keys) {
  if (source == null) return null;
  if (source instanceof Map) {
    for (const key of keys) if (source.has(key)) return source.get(key);
    return null;
  }
  if (typeof source !== 'object' || Array.isArray(source)) return null;
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  return null;
}

function semanticDescriptorCandidates(value, node, variable) {
  return [
    value?.metadata?.canonicalRoot,
    node?.metadata?.canonicalRoot,
    node?.attributes?.canonicalRoot,
    variable?.metadata?.canonicalRoot,
  ].filter(Boolean);
}

function suppliedRootDescriptor(ctx, value, node, variable, expectedAddressSpace) {
  for (const candidate of semanticDescriptorCandidates(value, node, variable)) {
    const normalized = normalizeGenericDescriptor(candidate);
    if (normalized) return normalized;
  }

  const keys = [
    ...(variable?.key == null ? [] : [`variable:${String(variable.key)}`, String(variable.key)]),
    ...(value?.id == null ? [] : [`value:${String(value.id)}`, String(value.id)]),
  ];
  const fromTable = normalizeGenericDescriptor(descriptorLookup(ctx.options.rootDescriptors, keys));
  if (fromTable) return fromTable;

  const provider = ctx.options.rootDescriptorProvider;
  if (typeof provider !== 'function') return null;
  const request = deepFreeze({
    functionId: String(ctx.ir.functionId),
    valueId: value?.id == null ? null : String(value.id),
    machineType: value?.machineType == null ? null : jsonSafe(value.machineType),
    expectedAddressSpace: expectedAddressSpace == null ? null : String(expectedAddressSpace),
    variable: variable == null ? null : jsonSafe({
      key: variable.key,
      kind: variable.kind,
      scope: variable.scope,
      ...(variable.physicalIdentity == null ? {} : { physicalIdentity: variable.physicalIdentity }),
      ...(variable.metadata == null ? {} : { metadata: variable.metadata }),
    }),
  });
  const raw = provider(request);
  if (raw && typeof raw.then === 'function') throw new TypeError('canonical-address-async-root-provider-unsupported');
  return normalizeGenericDescriptor(raw);
}

function rootFromDescriptor(descriptor, fallbackIdentity, expectedAddressSpace, widthBits) {
  if (!descriptor) return null;
  const addressSpace = descriptor.addressSpace ?? expectedAddressSpace ?? 'memory';
  if (expectedAddressSpace != null && descriptor.addressSpace != null && String(expectedAddressSpace) !== descriptor.addressSpace) {
    return unknown('canonical-root-address-space-mismatch');
  }
  if (descriptor.kind === 'absolute-address') {
    return deepFreeze({
      kind: 'absolute',
      addressSpace,
      address: descriptor.address,
      widthBits,
    });
  }
  const rootIdentity = descriptor.rootIdentity ?? fallbackIdentity;
  if (descriptor.kind === 'stack-like') {
    return deepFreeze({
      kind: 'stack-like',
      addressSpace,
      rootIdentity,
      // Root-relative offsets are signed mathematical offsets, not machine
      // addresses. Modulo wrapping here makes linear interval aliasing unsound.
      offset: descriptor.baseOffset,
      widthBits,
      separationSafe: descriptor.linearOffsets,
    });
  }
  const rootEntityId = descriptor.rootEntityId ?? defaultRootEntityId(rootIdentity);
  return deepFreeze({
    kind: 'rooted',
    addressSpace,
    rootIdentity,
    rootEntityId,
    offset: descriptor.baseOffset,
    widthBits,
    separationSafe: descriptor.linearOffsets,
  });
}

function buildContext(ir, options) {
  const values = new Map((ir.values ?? []).map((value) => [String(value.id), value]));
  const nodes = new Map((ir.nodes ?? []).map((node) => [String(node.id), node]));
  const blocks = new Map((ir.blocks ?? []).map((block) => [String(block.id), block]));
  const nodePosition = new Map();
  for (const block of blocks.values()) {
    (block.nodeIds ?? []).forEach((nodeId, index) => nodePosition.set(String(nodeId), { blockId: String(block.id), index }));
  }
  const ssaDefinitions = new Map((options.ssa?.definitions ?? []).map((definition) => [String(definition.valueId), definition]));
  const ssaUsesByEntity = new Map();
  for (const use of options.ssa?.uses ?? []) {
    const key = String(use.sourceEntityId);
    const list = ssaUsesByEntity.get(key) ?? [];
    list.push(use);
    ssaUsesByEntity.set(key, list);
  }
  for (const list of ssaUsesByEntity.values()) list.sort((a, b) => String(a.useId).localeCompare(String(b.useId)));
  return { ir, options, values, nodes, blocks, nodePosition, ssaDefinitions, ssaUsesByEntity };
}

function constantFromNode(value, node) {
  const candidates = [
    value?.metadata?.constant,
    node?.attributes?.constant,
    node?.metadata?.constant,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = parseInteger(candidate);
    if (parsed == null) continue;
    const widthBits = positiveWidth(candidate?.widthBits) ?? addressWidth(value, node);
    return scalarConstant(parsed, widthBits, node?.id ?? value?.id ?? null);
  }
  return null;
}

function sameRoot(left, right) {
  const leftKind = proofRootKind(left);
  const rightKind = proofRootKind(right);
  if (!left || !right || leftKind !== rightKind) return false;
  if (!['rooted', 'stack-like'].includes(leftKind)) return false;
  return rootIdentityKey(left) === rootIdentityKey(right);
}

function mergeAlternatives(proofs, reason) {
  if (!proofs.length) return unknown(reason);
  if (proofs.length === 1) return proofs[0];
  if (proofs.some((proof) => proof.kind === 'unknown' || proof.kind === 'constant')) return unknown(reason);
  if (proofs.every((proof) => proof.kind === 'absolute')) {
    const first = proofs[0];
    return proofs.every((proof) => proof.addressSpace === first.addressSpace && proof.address === first.address)
      ? first
      : unknown(reason);
  }
  const first = proofs[0];
  if (!proofs.every((proof) => sameRoot(first, proof) && proof.addressSpace === first.addressSpace)) return unknown(reason);
  const exactOffsets = proofs.every((proof) => proof.kind !== 'root-only' && proof.offset === first.offset);
  if (exactOffsets) {
    return deepFreeze({
      ...first,
      separationSafe: proofs.every((proof) => proof.separationSafe === true),
    });
  }
  return deepFreeze({
    kind: 'root-only',
    addressSpace: first.addressSpace,
    rootKind: proofRootKind(first),
    rootIdentity: first.rootIdentity,
    ...(first.rootEntityId == null ? {} : { rootEntityId: first.rootEntityId }),
    widthBits: first.widthBits,
    reason: String(reason),
  });
}

function stateBarrierMatches(node, variableKey) {
  if (!node) return false;
  if (node.kind === 'unknown-state-write') return true;
  if (node.kind === 'state-write' && String(node.variable?.key ?? '') === variableKey) return true;
  const summary = node.kind === 'call' ? node.call : node.kind === 'intrinsic' ? node.intrinsic : null;
  if (summary?.stateWrites?.some((ref) => String(ref.key) === variableKey)) return true;
  if (node.kind === 'call' && node.call?.unknownEffects?.categories?.some((category) => {
    const text = String(category).toLowerCase();
    return text.includes('state') || text.includes('register');
  })) return true;
  return false;
}

function earlierLocalStateSource(ctx, node, variableKey) {
  const position = ctx.nodePosition.get(String(node.id));
  if (!position) return { kind: 'none' };
  const block = ctx.blocks.get(position.blockId);
  if (!block) return { kind: 'none' };
  for (let index = position.index - 1; index >= 0; index--) {
    const candidate = ctx.nodes.get(String(block.nodeIds[index]));
    if (!stateBarrierMatches(candidate, variableKey)) continue;
    if (candidate.kind === 'state-write'
      && String(candidate.variable?.key ?? '') === variableKey
      && candidate.completeness === 'complete'
      && candidate.inputs?.length === 1) {
      return { kind: 'source', valueId: String(candidate.inputs[0]), node: candidate };
    }
    return { kind: 'barrier', node: candidate };
  }
  return { kind: 'none' };
}

function hasPotentialEarlierNonlocalMutation(ctx, node, variableKey) {
  const current = ctx.nodePosition.get(String(node.id));
  for (const candidate of ctx.nodes.values()) {
    if (!stateBarrierMatches(candidate, variableKey)) continue;
    const position = ctx.nodePosition.get(String(candidate.id));
    if (current && position && position.blockId === current.blockId && position.index >= current.index) continue;
    if (current && position && position.blockId === current.blockId) continue;
    return true;
  }
  return false;
}

function entryRoot(ctx, value, node, variable, expectedAddressSpace) {
  const identity = normalizeRootIdentity(variable, ctx.ir.functionId);
  const descriptor = suppliedRootDescriptor(ctx, value, node, variable, expectedAddressSpace);
  const supplied = rootFromDescriptor(descriptor, identity, expectedAddressSpace, addressWidth(value, node));
  if (supplied) return supplied;
  return deepFreeze({
    kind: 'rooted',
    addressSpace: expectedAddressSpace ?? 'memory',
    rootIdentity: identity,
    rootEntityId: defaultRootEntityId(identity),
    offset: 0n,
    widthBits: addressWidth(value, node),
    separationSafe: false,
  });
}

function deriveSsaValue(ctx, ssaValueId, expectedAddressSpace, state) {
  const id = String(ssaValueId);
  const visitKey = `ssa:${id}`;
  if (state.visiting.has(visitKey)) return unknown('canonical-address-ssa-cycle');
  if (state.depth >= MAX_DERIVATION_DEPTH) return unknown('canonical-address-depth-exceeded');
  const definition = ctx.ssaDefinitions.get(id);
  if (!definition) return unknown('canonical-address-ssa-definition-missing');
  const nextState = { visiting: new Set(state.visiting).add(visitKey), depth: state.depth + 1 };
  if (definition.kind === 'unknown' || definition.kind === 'undef') return unknown('canonical-address-ssa-unknown-definition');
  if (definition.kind === 'phi') {
    const incoming = definition.incoming ?? [];
    if (!incoming.length) return unknown('canonical-address-ssa-phi-empty');
    return mergeAlternatives(
      incoming.map((item) => deriveSsaValue(ctx, item.valueId, expectedAddressSpace, nextState)),
      'canonical-address-ssa-phi-not-exact',
    );
  }
  if (definition.kind === 'entry') {
    const variable = definition.proof?.variableIdentity ?? {
      key: definition.variableKey ?? `ssa-entry:${definition.definitionId}`,
      kind: 'logical-state',
      scope: 'function',
    };
    const semanticValue = definition.proof?.sourceSemanticValueId == null
      ? null
      : ctx.values.get(String(definition.proof.sourceSemanticValueId));
    return entryRoot(ctx, semanticValue, null, variable, expectedAddressSpace);
  }
  const sourceSemanticValueId = definition.proof?.sourceSemanticValueId;
  if (sourceSemanticValueId == null) return unknown('canonical-address-ssa-source-value-missing');
  return deriveValue(ctx, sourceSemanticValueId, expectedAddressSpace, nextState);
}

function isImplicitEntryUndef(ctx, ssaValueId) {
  const definition = ctx.ssaDefinitions.get(String(ssaValueId));
  return definition?.kind === 'undef' && definition.proof?.kind === 'implicit-undef';
}

function deriveStateRead(ctx, value, node, expectedAddressSpace, state) {
  const variable = node.variable;
  const variableKey = String(variable?.key ?? '');
  if (!variableKey) return unknown('canonical-address-state-root-missing');

  if (ctx.ssaDefinitions.size) {
    const uses = (ctx.ssaUsesByEntity.get(String(node.id)) ?? [])
      .filter((use) => String(use.proof?.variableIdentity?.key ?? use.proof?.sourceVariableKey ?? '') === variableKey);
    const reaching = [...new Set(uses.map((use) => String(use.valueId)))].sort();
    if (reaching.length && !reaching.every((ssaValueId) => isImplicitEntryUndef(ctx, ssaValueId))) {
      return mergeAlternatives(
        reaching.map((ssaValueId) => deriveSsaValue(ctx, ssaValueId, expectedAddressSpace, state)),
        'canonical-address-state-ssa-uses-disagree',
      );
    }
    // Generic SSA uses an explicit implicit-undef seed when the IR did not
    // materialize incoming machine state as an entry value. That sentinel
    // means "no earlier semantic definition", not "a clobber occurred". Let
    // the state-read variable identity (and any architecture-neutral root
    // descriptor supplied by the target boundary) establish the incoming root.
    // Any real definition/unknown/phi above still takes the SSA path and keeps
    // conservative clobber behavior.
  }

  const local = earlierLocalStateSource(ctx, node, variableKey);
  if (local.kind === 'source') return deriveValue(ctx, local.valueId, expectedAddressSpace, state);
  if (local.kind === 'barrier') return unknown('canonical-address-state-clobbered-before-read');
  if (hasPotentialEarlierNonlocalMutation(ctx, node, variableKey)) {
    return unknown('canonical-address-state-reaching-definition-needs-ssa');
  }
  return entryRoot(ctx, value, node, variable, expectedAddressSpace);
}

function addToRoot(proof, delta, widthBits, preserveSeparation) {
  if (proof.kind === 'root-only') return proof;
  if (proof.kind === 'absolute') {
    const width = widthBits ?? proof.widthBits;
    const address = normalizeModulo(proof.address + delta, width);
    return deepFreeze({ ...proof, address, widthBits: width });
  }
  if (!['rooted', 'stack-like'].includes(proof.kind)) return unknown('canonical-address-nonroot-offset');
  const width = widthBits ?? proof.widthBits;
  return deepFreeze({
    ...proof,
    offset: proof.offset + delta,
    widthBits: width,
    separationSafe: proof.separationSafe === true && preserveSeparation === true,
  });
}

function constantValue(proof) {
  return proof?.kind === 'constant' ? proof.value : null;
}

function deriveArithmetic(ctx, value, node, expectedAddressSpace, state) {
  if (!Array.isArray(node.inputs) || node.inputs.length !== 2) return unknown('canonical-address-arithmetic-arity');
  const left = deriveValue(ctx, node.inputs[0], expectedAddressSpace, state);
  const right = deriveValue(ctx, node.inputs[1], expectedAddressSpace, state);
  const operator = String(node.operator ?? '').toLowerCase();
  const widthBits = addressWidth(value, node) ?? left.widthBits ?? right.widthBits ?? null;
  const leftConstant = constantValue(left);
  const rightConstant = constantValue(right);

  if (operator === 'add') {
    if (leftConstant != null && rightConstant != null) {
      return scalarConstant(normalizeModulo(leftConstant + rightConstant, widthBits), widthBits, node.id);
    }
    if (rightConstant != null && left.kind !== 'unknown' && left.kind !== 'constant') {
      if (rightConstant === 0n) return left;
      return addToRoot(left, rightConstant, widthBits, node.kind === 'address');
    }
    if (leftConstant != null && right.kind !== 'unknown' && right.kind !== 'constant') {
      if (leftConstant === 0n) return right;
      return addToRoot(right, leftConstant, widthBits, node.kind === 'address');
    }
    return unknown('canonical-address-indexed-or-nonconstant-add');
  }
  if (operator === 'sub') {
    if (leftConstant != null && rightConstant != null) {
      return scalarConstant(normalizeModulo(leftConstant - rightConstant, widthBits), widthBits, node.id);
    }
    if (rightConstant != null && left.kind !== 'unknown' && left.kind !== 'constant') {
      if (rightConstant === 0n) return left;
      return addToRoot(left, -rightConstant, widthBits, node.kind === 'address');
    }
    return unknown('canonical-address-indexed-or-nonconstant-sub');
  }
  return unknown('canonical-address-arithmetic-operator-unsupported');
}

function operationMetadata(node) {
  return node?.attributes?.machineEffects?.operationMetadata ?? {};
}

function deriveAddWithCarry(ctx, value, node, expectedAddressSpace, state) {
  if (!Array.isArray(node.inputs) || node.inputs.length < 3) return unknown('canonical-address-add-with-carry-arity');
  const metadata = operationMetadata(node);
  const subtract = metadata.subtract === true;
  const carry = deriveValue(ctx, node.inputs[2], expectedAddressSpace, state);
  const expectedCarry = subtract ? 1n : 0n;
  if (constantValue(carry) !== expectedCarry) return unknown('canonical-address-add-with-carry-noncanonical-carry');

  let rhsId = node.inputs[1];
  if (subtract) {
    const rhsValue = ctx.values.get(String(rhsId));
    const rhsNode = rhsValue?.definitionNodeId == null ? null : ctx.nodes.get(String(rhsValue.definitionNodeId));
    if (rhsNode?.kind !== 'unary' || String(rhsNode.operator ?? '').toLowerCase() !== 'not' || rhsNode.inputs?.length !== 1) {
      return unknown('canonical-address-add-with-carry-subtract-rhs-not-proven');
    }
    rhsId = rhsNode.inputs[0];
  }

  const left = deriveValue(ctx, node.inputs[0], expectedAddressSpace, state);
  const right = deriveValue(ctx, rhsId, expectedAddressSpace, state);
  const widthBits = addressWidth(value, node) ?? left.widthBits ?? right.widthBits ?? null;
  const leftConstant = constantValue(left);
  const rightConstant = constantValue(right);

  if (leftConstant != null && rightConstant != null) {
    const result = subtract ? leftConstant - rightConstant : leftConstant + rightConstant;
    return scalarConstant(normalizeModulo(result, widthBits), widthBits, node.id);
  }
  if (rightConstant != null && left.kind !== 'unknown' && left.kind !== 'constant') {
    if (rightConstant === 0n) return left;
    return addToRoot(left, subtract ? -rightConstant : rightConstant, widthBits, true);
  }
  if (!subtract && leftConstant != null && right.kind !== 'unknown' && right.kind !== 'constant') {
    if (leftConstant === 0n) return right;
    return addToRoot(right, leftConstant, widthBits, true);
  }
  return unknown('canonical-address-add-with-carry-nonconstant-offset');
}

function deriveValue(ctx, valueId, expectedAddressSpace, state) {
  const id = String(valueId);
  const visitKey = `semantic:${id}`;
  if (state.visiting.has(visitKey)) return unknown('canonical-address-semantic-cycle');
  if (state.depth >= MAX_DERIVATION_DEPTH) return unknown('canonical-address-depth-exceeded');
  const value = ctx.values.get(id);
  if (!value) return unknown('canonical-address-value-missing');
  if (value.kind === 'unknown' || value.kind === 'undef') return unknown('canonical-address-value-unknown');
  const node = value.definitionNodeId == null ? null : ctx.nodes.get(String(value.definitionNodeId));
  const nextState = { visiting: new Set(state.visiting).add(visitKey), depth: state.depth + 1 };

  const semanticDescriptor = suppliedRootDescriptor(ctx, value, node, node?.variable ?? null, expectedAddressSpace);
  if (semanticDescriptor && node?.kind !== 'state-read') {
    const identity = deepFreeze({
      kind: 'semantic-value-root',
      functionId: String(ctx.ir.functionId),
      valueIdentity: value.variableKey == null ? String(value.id) : String(value.variableKey),
    });
    const supplied = rootFromDescriptor(semanticDescriptor, identity, expectedAddressSpace, addressWidth(value, node));
    if (supplied) return supplied;
  }

  if (value.kind === 'entry') {
    if (value.variableKey == null) return unknown('canonical-address-entry-root-identity-missing');
    const variable = { key: value.variableKey, kind: 'logical-state', scope: 'function' };
    return entryRoot(ctx, value, null, variable, expectedAddressSpace);
  }
  if (!node) return unknown('canonical-address-definition-node-missing');

  if (node.kind === 'const') {
    return constantFromNode(value, node) ?? unknown('canonical-address-constant-not-exact');
  }
  if (node.kind === 'state-read') return deriveStateRead(ctx, value, node, expectedAddressSpace, nextState);
  if (node.kind === 'copy') {
    if (!Array.isArray(node.inputs) || node.inputs.length !== 1) return unknown('canonical-address-copy-arity');
    return deriveValue(ctx, node.inputs[0], expectedAddressSpace, nextState);
  }
  if ((node.kind === 'intrinsic' || node.kind === 'binary') && String(node.operator ?? '').toLowerCase() === 'add-with-carry') {
    return deriveAddWithCarry(ctx, value, node, expectedAddressSpace, nextState);
  }
  if (node.kind === 'address' || node.kind === 'binary') {
    return deriveArithmetic(ctx, value, node, expectedAddressSpace, nextState);
  }
  return unknown(`canonical-address-transform-not-proven:${String(node.kind ?? 'unknown')}`);
}

function exactAddressRootId(proof) {
  return `entity_memory_address_${stableDigest({
    version: CANONICAL_ADDRESS_DERIVATION_VERSION,
    addressSpace: proof.addressSpace,
    rootKind: proof.kind,
    rootIdentity: proof.rootIdentity,
    rootEntityId: proof.rootEntityId ?? null,
    canonicalOffset: proof.offset.toString(),
    widthBits: proof.widthBits ?? null,
  })}`;
}

export function canonicalAddressProofToRegionEvidence(proof) {
  if (!proof || proof.kind === 'unknown' || proof.kind === 'constant' || proof.kind === 'root-only') return null;
  if (proof.kind === 'absolute') {
    return deepFreeze({ kind: 'global-absolute', address: canonicalAddress(proof.address) });
  }
  if (proof.kind === 'stack-like') {
    return deepFreeze({ kind: 'stack-fixed', offset: proof.offset.toString() });
  }
  if (proof.kind !== 'rooted') return null;
  if (proof.separationSafe) {
    return deepFreeze({
      kind: 'rooted-offset',
      rootEntityId: proof.rootEntityId,
      offset: proof.offset.toString(),
    });
  }
  return deepFreeze({
    kind: 'rooted-offset',
    rootEntityId: exactAddressRootId(proof),
    offset: '0',
  });
}

export function deriveCanonicalAddressProof(ir, addressValueId, options = {}) {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return unknown('canonical-address-ir-required');
  if (addressValueId == null) return unknown('canonical-address-value-id-required');
  const ctx = buildContext(ir, options);
  const expectedAddressSpace = options.addressSpace == null ? 'memory' : String(options.addressSpace);
  let proof = deriveValue(ctx, String(addressValueId), expectedAddressSpace, { visiting: new Set(), depth: 0 });
  if (proof.kind === 'constant') {
    proof = deepFreeze({
      kind: 'absolute',
      addressSpace: expectedAddressSpace,
      address: proof.value,
      widthBits: proof.widthBits,
    });
  }
  return proof;
}

export function deriveCanonicalRegionEvidence(ir, addressValueId, options = {}) {
  return canonicalAddressProofToRegionEvidence(deriveCanonicalAddressProof(ir, addressValueId, options));
}

export function sameCanonicalAddressProof(left, right) {
  if (!left || !right) return false;
  if (left.kind === 'unknown' || right.kind === 'unknown') return false;
  if (left.kind === 'constant' || right.kind === 'constant') return false;
  if (left.kind === 'absolute' || right.kind === 'absolute') {
    return left.kind === 'absolute' && right.kind === 'absolute'
      && left.addressSpace === right.addressSpace
      && left.address === right.address;
  }
  if (left.kind === 'root-only' || right.kind === 'root-only') return false;
  return sameRoot(left, right) && left.offset === right.offset;
}