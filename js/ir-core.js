/*
 * Semantic IR public-core compatibility facade.
 *
 * Legacy ARM64 remains the default/oracle until the Phase 3 shadow
 * differential is complete. The explicit semantic-v2-compat mode exercises
 * the canonical Phase 3 pipeline without a catch-and-fallback path.
 */
export * from './architecture/compat/ir-core-arm64-aapcs64-v1.js';

import {
  buildIR as buildLegacyIR,
  OP as LEGACY_OP,
  VK as LEGACY_VK,
} from './architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { buildCfg, EDGE } from './cfg.js';
import { stableDigest } from './core/identity/index.js';
import {
  SEMANTIC_V2_MIGRATION_MODES,
  buildSemanticV2CompatibilityPipeline,
} from './semantics/compat/index.js';
import { ARM64_ARCHITECTURE } from './targets/architecture/index.js';
import { AAPCS64_ABI, classifyAAPCS64Arguments } from './targets/abi/aapcs64.js';

export { classifyAAPCS64Arguments as classifyCallArguments };

let semanticMigrationMode = SEMANTIC_V2_MIGRATION_MODES.LEGACY;
let lastSemanticV2Instrumentation = null;

function normalizeMode(mode) {
  const value = mode ?? semanticMigrationMode;
  if (value === SEMANTIC_V2_MIGRATION_MODES.LEGACY || value === SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT) return value;
  throw new TypeError('semantic-migration-mode-unsupported');
}

/** Explicit process/session migration switch. Default remains legacy-v1. */
export function setSemanticMigrationMode(mode) {
  semanticMigrationMode = normalizeMode(mode);
  lastSemanticV2Instrumentation = null;
  return semanticMigrationMode;
}

export function getSemanticMigrationMode() { return semanticMigrationMode; }
export function getLastSemanticV2Instrumentation() { return lastSemanticV2Instrumentation; }

function asLegacyAddress(address) {
  if (address == null) return null;
  try { return typeof address === 'bigint' ? address : BigInt(address); }
  catch { return null; }
}

function rowResolver(model, opts) {
  if (typeof opts?.rowOfAddress === 'function') {
    return (address) => {
      const normalized = asLegacyAddress(address);
      return normalized == null ? null : opts.rowOfAddress(normalized);
    };
  }
  const rows = new Map();
  for (const instruction of model?.instructions ?? []) {
    if (instruction?.address != null && Number.isSafeInteger(instruction.row)) rows.set(instruction.address.toString(), instruction.row);
  }
  return (address) => address == null ? null : (rows.get(address.toString()) ?? null);
}

function edgeKind(edge) {
  if (edge.kind === EDGE.TAKEN) return 'conditional-true';
  if (edge.kind === EDGE.JUMP) return 'branch';
  if (edge.kind === EDGE.UNKNOWN) return 'unknown';
  return 'fallthrough';
}

function ephemeralBinaryId(model) {
  const identity = (model?.instructions ?? []).map((instruction) => ({
    address: instruction?.address ?? null,
    mnemonic: instruction?.mnemonic ?? null,
    operands: instruction?.operands ?? null,
  }));
  return `migration-model-${stableDigest(identity)}`;
}

function aapcs64FunctionReturnLocation(options = {}) {
  const proto = options.functionPrototype || options.prototype || null;
  const type = String(options.returnType || proto?.returnType || proto?.ret || proto?.result || '').toLowerCase();
  const cls = String(options.returnClass || proto?.returnClass || proto?.abiClass || proto?.resultClass || '').toLowerCase();
  if (options.returnsValue === false || proto?.returnsValue === false || proto?.void === true || type === 'void' || cls === 'void') return null;
  if (proto?.indirectResult === true || cls === 'indirect') return null;
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:Number(proto?.returnBits || proto?.bits || options.returnBits || 64) || 64 };
  }
  if (type || cls || options.returnsValue === true || proto?.returnsValue === true) {
    return { reg:'x0', bits:Number(proto?.returnBits || proto?.bits || options.returnBits || 64) || 64 };
  }
  return null;
}

function aapcs64CompatAbiAdapter(options) {
  return {
    classifyCall({ node }) {
      const control = node?.attributes?.machineControlEffect ?? null;
      const callSite = {
        callTarget: control?.target ?? null,
        callPrototype: node?.attributes?.callPrototype ?? null,
      };
      const classified = classifyAAPCS64Arguments(callSite, options);
      const returnValue = AAPCS64_ABI.classifyCallReturn(callSite, options);
      const callArguments = (classified.srcs ?? [])
        .filter((source) => source?.t === 'reg' && source.reg)
        .map((source) => ({ reg: String(source.reg), bits: Number(source.bits ?? 0) || null }));
      return {
        callArguments,
        stackArguments: classified.stackArguments ?? [],
        stackArgsUnknown: classified.stackArgsUnknown !== false,
        stackArgsMayContainPointers: classified.stackArgsMayContainPointers !== false,
        argumentEvidence: classified.evidence ?? 'aapcs64-plugin',
        clobbers: AAPCS64_ABI.callerSaved(),
        returnReg: returnValue?.reg ?? null,
        returnBits: returnValue?.bits ?? null,
        returnEvidence: returnValue == null ? null : 'aapcs64-plugin',
      };
    },
    classifyFunctionReturn() {
      const result = aapcs64FunctionReturnLocation(options);
      return result == null ? null : { ...result, evidence:'prototype-aapcs64' };
    },
  };
}

function aapcs64RegionRootDescriptorProvider(options = {}) {
  const explicit = options.rootDescriptorProvider ?? options.regionOptions?.rootDescriptorProvider ?? null;
  return (request) => {
    if (typeof explicit === 'function') {
      const supplied = explicit(request);
      if (supplied != null) return supplied;
    }
    const identity = request?.variable?.physicalIdentity;
    if (identity?.kind !== 'register') return null;
    const registerId = String(identity.registerId ?? '');
    if (registerId === 'sp') {
      return {
        kind: 'stack-like',
        addressSpace: request.expectedAddressSpace ?? 'memory',
        baseOffset: 0,
        linearOffsets: true,
        rootIdentity: {
          kind: 'abi-storage-root',
          abi: 'aapcs64',
          storageClass: 'function-local-stack',
          registerId,
        },
      };
    }
    const argument = /^x([0-7])$/.exec(registerId);
    if (!argument) return null;
    return {
      kind: 'rooted-object',
      addressSpace: request.expectedAddressSpace ?? 'memory',
      baseOffset: 0,
      linearOffsets: true,
      rootIdentity: {
        kind: 'abi-entry-argument-root',
        abi: 'aapcs64',
        storageClass: 'external-entry-memory',
        argumentIndex: Number(argument[1]),
        registerId,
      },
    };
  };
}

function valueDominatesLegacyInstruction(value, inst, projected) {
  if (!value || !inst) return false;
  if (value.kind === LEGACY_VK.ARG) return true;
  const definition = value.def;
  if (!definition || definition === inst) return false;
  if (definition.block === inst.block) return Number(definition.row) <= Number(inst.row);
  const dominators = projected.dominators?.[inst.block];
  return dominators instanceof Set && dominators.has(definition.block);
}

function legacyDefinitionRecency(value, inst, projected) {
  if (!value || value.kind === LEGACY_VK.ARG || !value.def) return { scope:0, depth:0, row:Number.NEGATIVE_INFINITY };
  const definition = value.def;
  if (definition.block === inst.block) {
    return { scope:2, depth:Number.MAX_SAFE_INTEGER, row:Number(definition.row ?? Number.NEGATIVE_INFINITY) };
  }
  const dominators = projected.dominators?.[inst.block];
  if (!(dominators instanceof Set) || !dominators.has(definition.block)) {
    return { scope:-1, depth:-1, row:Number.NEGATIVE_INFINITY };
  }
  const definitionDominators = projected.dominators?.[definition.block];
  return {
    scope:1,
    depth:definitionDominators instanceof Set ? definitionDominators.size : 0,
    row:Number(definition.row ?? Number.NEGATIVE_INFINITY),
  };
}

function detachLegacyArguments(inst) {
  for (const arg of inst.args ?? []) {
    const value = arg?.value;
    if (!Array.isArray(value?.uses)) continue;
    value.uses = value.uses.filter((use) => use !== inst);
  }
  inst.args = [];
}

/**
 * Semantic IR return nodes carry the architectural control target (for A64 RET,
 * typically the link register). That is not a source-language return value.
 * Match the legacy AAPCS64 facade: expose a return data value only when function
 * prototype/return-type evidence declares one, then bind that ABI location to an
 * already-existing dominating projected value. No value is synthesized.
 */
function attachAapcs64FunctionReturns(projected, adapter) {
  const result = adapter?.classifyFunctionReturn?.() ?? null;
  for (const inst of projected?.instructions ?? []) {
    if (inst.op !== LEGACY_OP.RET) continue;
    detachLegacyArguments(inst);
    inst.returnReg = null;
    inst.returnEvidence = null;
    if (!result?.reg) continue;
    const candidates = (projected.values ?? [])
      .filter((value) => value.reg === result.reg && valueDominatesLegacyInstruction(value, inst, projected))
      .sort((left, right) => {
        const leftRecency = legacyDefinitionRecency(left, inst, projected);
        const rightRecency = legacyDefinitionRecency(right, inst, projected);
        if (leftRecency.scope !== rightRecency.scope) return rightRecency.scope - leftRecency.scope;
        if (leftRecency.depth !== rightRecency.depth) return rightRecency.depth - leftRecency.depth;
        if (leftRecency.row !== rightRecency.row) return rightRecency.row - leftRecency.row;
        const leftWidth = Number(result.bits) > 0 && left.bits === Number(result.bits) ? 1 : 0;
        const rightWidth = Number(result.bits) > 0 && right.bits === Number(result.bits) ? 1 : 0;
        if (leftWidth !== rightWidth) return rightWidth - leftWidth;
        return (right.id ?? 0) - (left.id ?? 0);
      });
    const value = candidates[0] ?? null;
    if (!value) continue;
    inst.args = [{ value, bits:value.bits || result.bits || 64 }];
    if (!Array.isArray(value.uses)) value.uses = [];
    if (!value.uses.includes(inst)) value.uses.push(inst);
    inst.returnReg = result.reg;
    inst.returnEvidence = result.evidence ?? 'aapcs64-plugin';
    inst.extra = {
      ...(inst.extra ?? {}),
      abiProjectedReturnValueId: value.semanticSsaValueId ?? value.semanticValueId ?? value.id,
      abiProjectedReturnEvidence: inst.returnEvidence,
    };
  }
}

function buildV2CompatFromLegacyModel(model, opts = {}) {
  if (!model?.instructions?.length) return null;
  const rowOfAddress = rowResolver(model, opts);
  const legacyCfg = opts.cfg ?? buildCfg(model, { rowOfAddress });
  const instructionByRow = new Map(model.instructions.map((instruction) => [instruction.row, instruction]));
  const blocks = legacyCfg.nodes.map((node) => {
    const instructions = [];
    for (let row = node.startRow; row <= node.endRow; row++) {
      const instruction = instructionByRow.get(row);
      if (!instruction || instruction.data) continue;
      instructions.push({
        decoded: instruction,
        address: instruction.address,
        size: 4,
        mode: 'a64',
      });
    }
    const first = instructions[0]?.decoded?.address;
    if (first == null) throw new TypeError('semantic-v2-compat-empty-basic-block');
    return {
      key: `legacy-block-${node.index}`,
      startAddress: first,
      instructions,
      successors: node.succ
        .filter((successor) => successor.to >= 0)
        .map((successor) => ({ to: `legacy-block-${successor.to}`, kind: edgeKind(successor) })),
    };
  });
  const binaryId = String(opts.binaryId ?? model.binaryId ?? ephemeralBinaryId(model));
  const sliceId = String(opts.sliceId ?? model.sliceId ?? `migration-slice-${stableDigest({ binaryId, architecture: 'arm64' })}`);
  const abiAdapter = opts.abiAdapter ?? aapcs64CompatAbiAdapter(opts);
  const result = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: String(opts.decoderSemanticVersion ?? 'legacy-model-decoder-v1'),
    binaryId,
    sliceId,
    addressWidthBits: 64,
    canonicalStartIdentity: { address: model.startAddress ?? model.instructions[0].address },
    entryBlockKey: legacyCfg.entry >= 0 ? `legacy-block-${legacyCfg.entry}` : blocks[0]?.key,
    blocks,
    abiAdapter,
    rootDescriptorProvider: aapcs64RegionRootDescriptorProvider(opts),
  }, {
    signal: opts.signal,
    semanticIrOptions: opts.semanticIrOptions,
    ssaOptions: opts.ssaOptions,
    memorySsaOptions: opts.memorySsaOptions,
    compatOptions: {
      rowOfNode(node) {
        const address = node?.origin?.virtualRanges?.[0]?.start;
        return address == null ? null : rowOfAddress(address);
      },
      textOfNode(node) {
        const address = node?.origin?.virtualRanges?.[0]?.start;
        const row = address == null ? null : rowOfAddress(address);
        const instruction = row == null ? null : instructionByRow.get(row);
        return instruction ? `${instruction.mnemonic} ${instruction.operands ?? ''}`.trim() : `semantic-v2 ${node.kind}`;
      },
      ...(opts.compatOptions ?? {}),
    },
  });
  attachAapcs64FunctionReturns(result.legacyV1, abiAdapter);
  lastSemanticV2Instrumentation = result.instrumentation;
  return result.legacyV1;
}

/**
 * Explicit semantic-engine dispatch. No v2 exception is caught and rerouted to
 * legacy; semantic-v2-compat either returns its compatibility projection or
 * fails/returns explicit unknowns from the v2 pipeline.
 */
export function buildIR(model, opts = {}) {
  const mode = normalizeMode(opts.semanticMigrationMode);
  if (mode === SEMANTIC_V2_MIGRATION_MODES.LEGACY) return buildLegacyIR(model, opts);
  lastSemanticV2Instrumentation = null;
  return buildV2CompatFromLegacyModel(model, opts);
}