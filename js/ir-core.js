/*
 * Semantic IR public-core compatibility facade.
 *
 * Legacy ARM64 remains the default/oracle until the Phase 3 shadow
 * differential is complete. The explicit semantic-v2-compat mode exercises
 * the canonical Phase 3 pipeline without a catch-and-fallback path.
 */
export * from './architecture/compat/ir-core-arm64-aapcs64-v1.js';

import { buildIR as buildLegacyIR } from './architecture/compat/ir-core-arm64-aapcs64-v1.js';
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
  };
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
  const result = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: String(opts.decoderSemanticVersion ?? 'legacy-model-decoder-v1'),
    binaryId,
    sliceId,
    addressWidthBits: 64,
    canonicalStartIdentity: { address: model.startAddress ?? model.instructions[0].address },
    entryBlockKey: legacyCfg.entry >= 0 ? `legacy-block-${legacyCfg.entry}` : blocks[0]?.key,
    blocks,
    abiAdapter: opts.abiAdapter ?? aapcs64CompatAbiAdapter(opts),
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