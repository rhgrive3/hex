import {
  canonicalAddress,
  createBlockId,
  createFunctionId,
  createInstructionId,
  deepFreeze,
  stableStringify,
} from '../../core/identity/index.js';
import { createOriginSet, mergeOriginSets } from '../../core/identity/origin.js';
import { classifySemanticMemoryRegion } from '../../analysis/alias/index-v2.js';
import { createPhase7AliasSolver } from '../../analysis/alias/solver.js';
import { createSemanticCfg } from '../cfg/index.js';
import {
  createMachineEffectBundle,
  validateMachineEffectBundle,
} from '../effects/index.js';
import {
  SEMANTIC_IR_SCHEMA_VERSION,
  createSemanticIrFunction,
  lowerMachineEffectBundleToSemanticIr,
} from '../ir/index.js';
import {
  SEMANTIC_SSA_BUILD_VERSION,
  buildSemanticSsa,
  validateSemanticSsa,
} from '../ssa/index.js';
import {
  MEMORY_SSA_BUILD_VERSION,
  buildMemorySsa,
  validateMemorySsa,
} from '../memoryssa/index.js';
import { projectSemanticIrV2ToLegacyV1 } from './semantic-ir-v2-to-v1.js';

export {
  MACHINE_EFFECTS_V1_COMPAT,
  lowerMachineEffectsToLegacyV1,
} from './machine-effects-to-v1.js';
export {
  SEMANTIC_IR_V2_V1_COMPAT,
  projectSemanticIrV2ToLegacyV1,
} from './semantic-ir-v2-to-v1.js';

export const SEMANTIC_V2_MIGRATION_MODES = Object.freeze({
  LEGACY: 'legacy-v1',
  V2_COMPAT: 'semantic-v2-compat',
  SHADOW_DIFFERENTIAL: 'semantic-v2-shadow-differential',
});

export const SEMANTIC_V2_COMPAT_PIPELINE_VERSION = '1.1.0';
export const SEMANTIC_V2_COMPAT_PATH = Object.freeze([
  'machine-effects',
  'semantic-ir-v2',
  'scalar-ssa',
  'region-resolver',
  'memoryssa',
  'v1-compat',
]);

const COMPLETENESS_RANK = Object.freeze({ complete: 0, partial: 1, unknown: 2 });
const UNKNOWN_CATEGORIES = Object.freeze(['registers', 'flags', 'memory', 'control', 'faults', 'other']);

function fail(code) { throw new TypeError(code); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}
function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}
function array(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-v2-integration-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function integerBytes(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function instructionAddress(item) {
  const raw = item.address ?? item.decoded?.address;
  if (raw == null) fail('semantic-v2-integration-instruction-address-required');
  try { return BigInt(raw); }
  catch { fail('semantic-v2-integration-invalid-instruction-address'); }
}
function instructionLength(item, architecturePlugin) {
  return integerBytes(item.size ?? item.decoded?.size ?? architecturePlugin.fixedInstructionSize) ?? null;
}
function originWithInstruction(item, instructionId, architecturePlugin) {
  const address = instructionAddress(item);
  const length = instructionLength(item, architecturePlugin);
  const generated = createOriginSet({
    instructionIds: [instructionId],
    ...(length == null ? {} : { virtualRanges: [{ start: address, end: address + BigInt(length) }] }),
  });
  return mergeOriginSets(item.origin ?? item.decoded?.origin ?? createOriginSet({}), generated);
}
function unknownBundle({ architecturePlugin, instructionId, mode, origin }) {
  return createMachineEffectBundle({
    instructionId,
    architectureId: architecturePlugin.id,
    mode,
    operations: [],
    controlEffect: { kind: 'unknown', reason: 'architecture-lifter-returned-no-exact-effects' },
    possibleFaults: [],
    origin,
    completeness: 'unknown',
    unknownEffects: {
      categories: UNKNOWN_CATEGORIES,
      reason: 'architecture-lifter-returned-no-exact-effects',
      preservation: 'not-assumed',
    },
    metadata: { phase: 3, explicitUnknown: true },
  });
}
function mergeById(map, item, code) {
  const prior = map.get(item.id);
  if (!prior) {
    map.set(item.id, item);
    return;
  }
  if (stableStringify(prior) !== stableStringify(item)) fail(code);
}
function promotedCompleteness(current, next) {
  return COMPLETENESS_RANK[next] > COMPLETENESS_RANK[current] ? next : current;
}
function targetAddress(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  if (String(target.kind ?? '') !== 'absolute-address' || target.value == null) return null;
  try { return canonicalAddress(target.value); }
  catch { return null; }
}
function bundleTargets(bundle) {
  const control = bundle.controlEffect;
  const targets = [];
  if (control.target != null) targets.push(control.target);
  for (const target of control.targets ?? []) targets.push(target);
  if (control.fallthrough != null) targets.push(control.fallthrough);
  return targets;
}
function semanticEdgeKind(node, index) {
  if (node.kind === 'branch') return 'branch';
  if (node.kind === 'conditional-branch') return index === 0 ? 'conditional-true' : 'conditional-false';
  if (node.kind === 'switch') return 'switch-case';
  if (node.kind === 'unknown-control-effect'
      && node.attributes?.indirectControl?.targetState === 'candidate') return 'indirect-candidate';
  return 'unknown';
}
function normalizeSuccessor(input) {
  if (typeof input === 'string') return { to: input, kind: 'fallthrough' };
  input = object(input, 'semantic-v2-integration-invalid-successor');
  return {
    to: nonEmpty(input.to, 'semantic-v2-integration-successor-target-required'),
    kind: nonEmpty(input.kind ?? 'fallthrough', 'semantic-v2-integration-successor-kind-required'),
    ...(input.metadata == null ? {} : { metadata: input.metadata }),
  };
}

function architectureRegisterDescriptors(architecturePlugin) {
  if (typeof architecturePlugin.registerFile !== 'function') return [];
  let descriptors;
  try { descriptors = architecturePlugin.registerFile(); }
  catch { return []; }
  return Array.isArray(descriptors) ? descriptors : [];
}

function createRegionRootDescriptorProvider(architecturePlugin, architectureId, input, options) {
  const explicitProvider = input.rootDescriptorProvider
    ?? options.regionOptions?.rootDescriptorProvider
    ?? options.rootDescriptorProvider
    ?? null;
  const stackRegisterIds = new Set(architectureRegisterDescriptors(architecturePlugin)
    .filter((descriptor) => descriptor && String(descriptor.kind ?? '') === 'stack-pointer' && descriptor.id != null)
    .map((descriptor) => String(descriptor.id)));

  if (typeof explicitProvider !== 'function' && !stackRegisterIds.size) return null;
  return (request) => {
    if (typeof explicitProvider === 'function') {
      const supplied = explicitProvider(request);
      if (supplied != null) return supplied;
    }
    const identity = request?.variable?.physicalIdentity;
    if (identity?.kind !== 'register' || !stackRegisterIds.has(String(identity.registerId ?? ''))) return null;
    return {
      kind: 'stack-like',
      addressSpace: request.expectedAddressSpace ?? 'memory',
      baseOffset: 0,
      linearOffsets: true,
      rootIdentity: {
        kind: 'architecture-register-role',
        architectureId,
        role: 'stack-pointer',
        registerId: String(identity.registerId),
      },
    };
  };
}

/**
 * Build the explicit Phase 3 migration route. There is deliberately no legacy
 * fallback here: callers either request this route and get a complete/partial/
 * explicit-unknown v2 result, or the call fails.
 *
 * Input blocks are discovery facts supplied by the caller. This function does
 * not rediscover CFG structure or parse mnemonics. Stable FunctionId, BlockId,
 * and InstructionId values are minted only through the canonical identity API.
 */
export function buildSemanticV2CompatibilityPipeline(input, options = {}) {
  assertNotAborted(options);
  input = object(input, 'semantic-v2-integration-input-required');
  const architecturePlugin = object(input.architecturePlugin, 'semantic-v2-integration-architecture-plugin-required');
  if (typeof architecturePlugin.liftExact !== 'function') fail('semantic-v2-lift-exact-required');
  const architectureId = nonEmpty(architecturePlugin.id, 'semantic-v2-integration-architecture-id-required');
  const architectureSemanticVersion = nonEmpty(architecturePlugin.semanticVersion, 'semantic-v2-integration-architecture-semantic-version-required');
  const decoderSemanticVersion = nonEmpty(input.decoderSemanticVersion, 'semantic-v2-integration-decoder-semantic-version-required');
  const binaryId = nonEmpty(input.binaryId, 'semantic-v2-integration-binary-id-required');
  const sliceId = nonEmpty(input.sliceId, 'semantic-v2-integration-slice-id-required');
  const rawBlocks = array(input.blocks, 'semantic-v2-integration-blocks-required');
  if (!rawBlocks.length) fail('semantic-v2-integration-blocks-required');
  const machineEffectsContext = input.machineEffectsContext == null
    ? {}
    : object(input.machineEffectsContext, 'semantic-v2-integration-machine-effects-context-invalid');

  const canonicalStartIdentity = input.canonicalStartIdentity ?? { address: canonicalAddress(rawBlocks[0].startAddress) };
  const functionId = createFunctionId({ binaryId, sliceId, canonicalStartIdentity });

  const blockRecords = [];
  const blockByKey = new Map();
  const blockByAddress = new Map();
  for (let index = 0; index < rawBlocks.length; index++) {
    assertNotAborted(options);
    const raw = object(rawBlocks[index], 'semantic-v2-integration-invalid-block');
    const key = nonEmpty(raw.key ?? `block-${index}`, 'semantic-v2-integration-block-key-required');
    if (blockByKey.has(key)) fail('semantic-v2-integration-duplicate-block-key');
    if (raw.startAddress == null) fail('semantic-v2-integration-block-start-address-required');
    const startAddress = canonicalAddress(raw.startAddress);
    if (blockByAddress.has(startAddress)) fail('semantic-v2-integration-duplicate-block-address');
    const id = createBlockId({
      functionId,
      canonicalBlockIdentity: raw.canonicalIdentity ?? { startAddress },
    });
    const record = {
      key,
      id,
      startAddress,
      instructions: array(raw.instructions ?? [], 'semantic-v2-integration-invalid-block-instructions'),
      successors: array(raw.successors ?? [], 'semantic-v2-integration-invalid-block-successors').map(normalizeSuccessor),
      origin: raw.origin == null ? null : createOriginSet(raw.origin),
    };
    blockRecords.push(record);
    blockByKey.set(key, record);
    blockByAddress.set(startAddress, record);
  }

  const entryKey = nonEmpty(input.entryBlockKey ?? blockRecords[0].key, 'semantic-v2-integration-entry-block-required');
  const entryRecord = blockByKey.get(entryKey);
  if (!entryRecord) fail('semantic-v2-integration-entry-block-not-found');

  const blocks = new Map(blockRecords.map((record) => [record.id, {
    id: record.id,
    nodeIds: [],
    ...(record.origin == null ? {} : { origin: record.origin }),
  }]));
  const values = new Map();
  const nodes = new Map();
  const issues = new Map();
  const bundles = [];
  const instructionTelemetry = [];
  let completeness = 'complete';
  let unsupportedInstructionCount = 0;

  function mergeBlock(fragmentBlock) {
    const prior = blocks.get(fragmentBlock.id);
    if (!prior) {
      blocks.set(fragmentBlock.id, {
        id: fragmentBlock.id,
        nodeIds: fragmentBlock.nodeIds.slice(),
        ...(fragmentBlock.origin == null ? {} : { origin: fragmentBlock.origin }),
      });
      return;
    }
    prior.nodeIds.push(...fragmentBlock.nodeIds.filter((id) => !prior.nodeIds.includes(id)));
    if (prior.origin != null || fragmentBlock.origin != null) {
      prior.origin = mergeOriginSets(prior.origin ?? createOriginSet({}), fragmentBlock.origin ?? createOriginSet({}));
    }
  }

  for (const block of blockRecords) {
    for (const item of block.instructions) {
      assertNotAborted(options);
      object(item, 'semantic-v2-integration-invalid-instruction');
      const address = instructionAddress(item);
      const mode = nonEmpty(item.mode ?? item.decoded?.mode ?? input.mode ?? 'default', 'semantic-v2-integration-instruction-mode-required');
      const instructionId = createInstructionId({
        binaryId,
        sliceId,
        virtualAddress: address,
        decodeMode: mode,
        decoderSemanticVersion,
      });
      const origin = originWithInstruction(item, instructionId, architecturePlugin);
      const decoded = object(item.decoded ?? item, 'semantic-v2-integration-decoded-instruction-required');
      const prepared = { ...decoded, instructionId, origin, mode };
      let bundle = architecturePlugin.liftExact(prepared, {
        ...machineEffectsContext,
        instructionId,
        origin,
        mode,
        signal: options.signal,
        machineEffectsOptions: options.machineEffectsOptions ?? {},
      });
      if (bundle && typeof bundle.then === 'function') fail('semantic-v2-integration-async-lifter-not-supported');
      if (bundle == null) {
        unsupportedInstructionCount++;
        bundle = unknownBundle({ architecturePlugin, instructionId, mode, origin });
      } else {
        bundle = validateMachineEffectBundle(bundle, options.machineEffectsOptions ?? {});
        if (bundle.instructionId !== instructionId) fail('semantic-v2-integration-instruction-id-mismatch');
        if (bundle.architectureId !== architectureId) fail('semantic-v2-integration-architecture-id-mismatch');
      }
      bundles.push(bundle);

      const autoTargets = [];
      for (const target of bundleTargets(bundle)) {
        const addressKey = targetAddress(target);
        const targetBlock = addressKey == null ? null : blockByAddress.get(addressKey);
        if (targetBlock) autoTargets.push({ target, blockId: targetBlock.id });
      }
      for (const explicit of item.controlTargets ?? []) {
        const target = object(explicit, 'semantic-v2-integration-invalid-control-target');
        const targetBlock = blockByKey.get(nonEmpty(target.to, 'semantic-v2-integration-control-target-block-required'));
        if (!targetBlock) fail('semantic-v2-integration-control-target-block-not-found');
        autoTargets.push({ target: target.target, blockId: targetBlock.id, ...(target.role == null ? {} : { role: target.role }) });
      }

      const fragment = lowerMachineEffectBundleToSemanticIr(bundle, {
        functionId,
        blockId: block.id,
        entryBlockId: block.id,
        addressWidthBits: input.addressWidthBits,
        controlTargets: autoTargets,
      }, options.semanticIrOptions ?? {});
      completeness = promotedCompleteness(completeness, fragment.completeness);
      for (const issue of fragment.unknowns) issues.set(stableStringify(issue), issue);
      for (const value of fragment.values) mergeById(values, value, 'semantic-v2-integration-conflicting-value-id');
      for (const node of fragment.nodes) mergeById(nodes, node, 'semantic-v2-integration-conflicting-node-id');
      for (const fragmentBlock of fragment.blocks) mergeBlock(fragmentBlock);
      instructionTelemetry.push(deepFreeze({
        instructionId,
        blockId: block.id,
        address: canonicalAddress(address),
        machineEffectsCompleteness: bundle.completeness,
        semanticIrCompleteness: fragment.completeness,
        explicitUnknown: bundle.completeness === 'unknown',
      }));
    }
  }

  if (!bundles.length) fail('semantic-v2-integration-function-has-no-instructions');
  const functionOrigin = mergeOriginSets(...bundles.map((bundle) => bundle.origin));
  for (const block of blockRecords) {
    const merged = blocks.get(block.id);
    if (merged && block.origin != null) merged.origin = mergeOriginSets(merged.origin ?? createOriginSet({}), block.origin);
  }
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: entryRecord.id,
    blocks: [...blocks.values()],
    values: [...values.values()],
    nodes: [...nodes.values()],
    completeness,
    unknowns: [...issues.values()],
    origin: functionOrigin,
  }, options.semanticIrOptions ?? {});

  const nodeById = new Map(ir.nodes.map((node) => [node.id, node]));
  const successorMap = new Map();
  function addSuccessor(from, edge) {
    let list = successorMap.get(from);
    if (!list) { list = new Map(); successorMap.set(from, list); }
    const key = `${edge.to}\u0000${edge.kind}\u0000${stableStringify(edge.metadata ?? null)}`;
    list.set(key, edge);
  }
  for (const block of blockRecords) {
    for (const successor of block.successors) {
      const target = blockByKey.get(successor.to);
      if (!target) fail('semantic-v2-integration-successor-block-not-found');
      addSuccessor(block.id, { to: target.id, kind: successor.kind, ...(successor.metadata == null ? {} : { metadata: successor.metadata }) });
    }
  }
  for (const block of ir.blocks) {
    for (const nodeId of block.nodeIds) {
      const node = nodeById.get(nodeId);
      if (!node?.targets?.length) continue;
      node.targets.forEach((to, index) => addSuccessor(block.id, { to, kind: semanticEdgeKind(node, index) }));
    }
  }
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: entryRecord.id,
    blocks: ir.blocks.map((block) => ({
      id: block.id,
      successors: [...(successorMap.get(block.id)?.values() ?? [])],
    })),
  }, options.cfgOptions ?? {});

  const ssa = buildSemanticSsa(ir, cfg, options.ssaOptions ?? {});
  validateSemanticSsa(ssa, ir, cfg, options.ssaValidationOptions ?? {});

  const regionOptions = options.regionOptions ?? {};
  const rootDescriptors = input.rootDescriptors ?? regionOptions.rootDescriptors ?? options.rootDescriptors;
  const rootDescriptorProvider = createRegionRootDescriptorProvider(architecturePlugin, architectureId, input, options);
  const aliasSolver = createPhase7AliasSolver({
    ir,
    cfg,
    ssa,
    options: {
      ...(options.aliasOptions ?? {}),
      // The points-to solve must see exactly the root descriptors the region
      // classification sees, or the two would name the same object differently
      // and every refinement would be silently discarded.
      canonicalOptions: {
        ...(rootDescriptors == null ? {} : { rootDescriptors }),
        ...(rootDescriptorProvider == null ? {} : { rootDescriptorProvider }),
        ...(options.aliasOptions?.canonicalOptions ?? {}),
      },
      ...(options.signal == null ? {} : { signal: options.signal }),
    },
  });
  const memorySsa = buildMemorySsa(ir, cfg, {
    ...(options.memorySsaOptions ?? {}),
    resolveRegion(memory, context) {
      return classifySemanticMemoryRegion(ir, context.node, {
        binaryId,
        ssa,
        ...(rootDescriptors == null ? {} : { rootDescriptors }),
        ...(rootDescriptorProvider == null ? {} : { rootDescriptorProvider }),
      });
    },
    // The canonical alias provider. The Phase 7 solver answers region-identity
    // questions through the same conservative floor it always did, and adds a
    // field-sensitive refinement on top when — and only when — the points-to
    // solve proves one. Consumers get the stronger answer here rather than
    // building a private one, which is what keeps a single semantic truth.
    queryAlias: aliasSolver.queryAlias,
  });
  validateMemorySsa(memorySsa, { cfg, ...(options.memorySsaValidationOptions ?? {}) });

  const legacyV1 = projectSemanticIrV2ToLegacyV1(ir, {
    ...(options.compatOptions ?? {}),
    cfg,
    ssa,
    memorySsa,
    abiAdapter: input.abiAdapter ?? options.abiAdapter ?? options.compatOptions?.abiAdapter,
  });

  // The wrapper object is immutable, and every canonical v2 artifact is already
  // frozen by its contract constructor. The legacy v1 compatibility projection
  // intentionally remains mutable because the existing public js/ir.js facade
  // attaches conservative safety/query caches to it after construction.
  return Object.freeze({
    mode: SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT,
    pipelineVersion: SEMANTIC_V2_COMPAT_PIPELINE_VERSION,
    path: SEMANTIC_V2_COMPAT_PATH,
    semanticSchemaVersion: SEMANTIC_IR_SCHEMA_VERSION,
    architectureId,
    architectureSemanticVersion,
    decoderSemanticVersion,
    scalarSsaPassVersion: SEMANTIC_SSA_BUILD_VERSION,
    memorySsaPassVersion: MEMORY_SSA_BUILD_VERSION,
    binaryId,
    sliceId,
    functionId,
    machineEffects: Object.freeze(bundles.slice()),
    semanticIr: ir,
    cfg,
    ssa,
    regions: memorySsa.regions,
    memorySsa,
    legacyV1,
    instrumentation: deepFreeze({
      v2Executed: true,
      path: SEMANTIC_V2_COMPAT_PATH,
      instructionCount: bundles.length,
      unsupportedInstructionCount,
      semanticUnknownCount: ir.unknowns.length,
      provenanceLossCount: 0,
      instructions: instructionTelemetry,
    }),
  });
}