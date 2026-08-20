import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import {
  appendTransform,
  createOriginSet,
  createTransformRecord,
  mergeOriginSets,
} from '../../core/identity/origin.js';
import { validateMachineEffectBundle } from '../effects/index.js';

export const MACHINE_EFFECTS_TO_SEMANTIC_IR_PASS_ID = 'semantic-ir.from-machine-effects';
export const MACHINE_EFFECTS_TO_SEMANTIC_IR_PASS_VERSION = '1.0.0';

const BINARY_OPS = new Set([
  'add', 'sub', 'mul', 'sdiv', 'udiv', 'div', 'srem', 'urem', 'and', 'or', 'orr', 'xor', 'eor', 'bic', 'orn', 'eon',
  'shl', 'lsl', 'lshr', 'lsr', 'ashr', 'asr', 'ror', 'fadd', 'fsub', 'fmul', 'fdiv', 'min', 'max',
]);
const UNARY_OPS = new Set([
  'neg', 'not', 'abs', 'fneg', 'fabs', 'fsqrt', 'clz', 'rbit', 'rev', 'rev16', 'rev32',
  'i2f', 'u2f', 'f2i', 'f2u', 'fmov',
]);
const COPY_OPS = new Set(['copy', 'mov', 'move', 'identity']);
const COMPARE_OPS = new Set(['cmp', 'compare', 'icmp', 'fcmp', 'test']);
const SELECT_OPS = new Set(['select', 'sel']);
const ZEXT_OPS = new Set(['zext', 'zero-extend', 'zeroextend']);
const SEXT_OPS = new Set(['sext', 'sign-extend', 'signextend']);
const TRUNC_OPS = new Set(['trunc', 'truncate']);
const BITCAST_OPS = new Set(['bitcast']);
const EXTRACT_OPS = new Set(['extract', 'bfx', 'bit-extract', 'extract-lane']);
const INSERT_OPS = new Set(['insert', 'bfi', 'bit-insert', 'insert-lane']);
const CONCAT_OPS = new Set(['concat', 'concatenate']);
const ADDRESS_OPS = new Set(['addr', 'address']);

function fail(code) { throw new TypeError(code); }
function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function assertNotAborted(options) {
  if (options?.signal?.aborted) {
    const error = new Error('semantic-ir-lowering-cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
function normalizeOpcode(opcode) {
  return String(opcode ?? '').trim().toLowerCase().replaceAll('_', '-');
}
function opcodeHead(opcode) {
  return normalizeOpcode(opcode).split(/[.:/]/, 1)[0];
}

export function classifyMachineValueOpcode(opcode) {
  const normalized = normalizeOpcode(opcode);
  const head = opcodeHead(normalized);
  if (!normalized) return deepFreeze({ kind: 'intrinsic', operator: 'unknown-value-operation' });
  if (COPY_OPS.has(head)) return deepFreeze({ kind: 'copy', operator: normalized });
  if (BINARY_OPS.has(head)) return deepFreeze({ kind: 'binary', operator: normalized });
  if (UNARY_OPS.has(head)) return deepFreeze({ kind: 'unary', operator: normalized });
  if (COMPARE_OPS.has(head)) return deepFreeze({ kind: 'compare', operator: normalized });
  if (SELECT_OPS.has(head)) return deepFreeze({ kind: 'select', operator: normalized });
  if (ZEXT_OPS.has(head)) return deepFreeze({ kind: 'zext', operator: normalized });
  if (SEXT_OPS.has(head)) return deepFreeze({ kind: 'sext', operator: normalized });
  if (TRUNC_OPS.has(head)) return deepFreeze({ kind: 'trunc', operator: normalized });
  if (BITCAST_OPS.has(head)) return deepFreeze({ kind: 'bitcast', operator: normalized });
  if (EXTRACT_OPS.has(head)) return deepFreeze({ kind: 'extract', operator: normalized });
  if (INSERT_OPS.has(head)) return deepFreeze({ kind: 'insert', operator: normalized });
  if (CONCAT_OPS.has(head)) return deepFreeze({ kind: 'concat', operator: normalized });
  if (ADDRESS_OPS.has(head)) return deepFreeze({ kind: 'address', operator: normalized });
  return deepFreeze({ kind: 'intrinsic', operator: normalized });
}

/*
 * MachineEffects may qualify a canonical scalar opcode with the bundle's
 * architecture id or execution mode when the operation also carries target-
 * specific edge-case metadata. Semantic IR must not learn those architecture
 * names. Strip only the namespace declared by this very bundle, and only when
 * the remaining opcode is already a known canonical Semantic IR operation.
 * Preserve the original opcode in metadata so target-specific behavior (for
 * example division edge cases) remains inspectable after normalization.
 */
function canonicalMachineValueOperation(operation, bundle) {
  if (operation?.kind !== 'value') return operation;
  const originalOpcode = String(operation.opcode ?? '');
  const normalized = normalizeOpcode(originalOpcode);
  const namespaces = [bundle?.architectureId, bundle?.mode]
    .map(normalizeOpcode)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const namespace of namespaces) {
    const prefix = `${namespace}-`;
    if (!normalized.startsWith(prefix)) continue;
    const canonicalOpcode = normalized.slice(prefix.length);
    if (!canonicalOpcode || classifyMachineValueOpcode(canonicalOpcode).kind === 'intrinsic') continue;
    return deepFreeze({
      ...operation,
      opcode: canonicalOpcode,
      metadata: {
        ...(operation.metadata || {}),
        qualifiedMachineOpcode: originalOpcode,
        semanticOpcodeNormalization: 'declared-bundle-namespace',
      },
    });
  }
  return operation;
}

export function machineValueMachineType(value, options = {}) {
  if (!value || typeof value !== 'object') return null;
  switch (value.kind) {
    case 'temporary':
      return machineValueMachineType(value.valueType, options);
    case 'register':
    case 'flag': {
      const widthBits = positiveInteger(value.widthBits);
      return widthBits == null ? null : { kind: 'bitvector', widthBits };
    }
    case 'bitvector': {
      const widthBits = positiveInteger(value.widthBits);
      return widthBits == null ? null : { kind: 'bitvector', widthBits };
    }
    case 'float': {
      const widthBits = positiveInteger(value.widthBits);
      return widthBits == null || !value.format ? null : { kind: 'float', widthBits, format: String(value.format) };
    }
    case 'vector': {
      const laneCount = positiveInteger(value.laneCount);
      const elementType = machineValueMachineType(value.elementType, options);
      return laneCount == null || !elementType || elementType.kind === 'address'
        ? null
        : { kind: 'vector', laneCount, elementType };
    }
    case 'predicate': {
      const widthBits = positiveInteger(value.widthBits);
      if (widthBits == null) return null;
      return {
        kind: 'predicate',
        widthBits,
        ...(value.laneCount == null ? {} : { laneCount: positiveInteger(value.laneCount) }),
      };
    }
    case 'memory':
    case 'code':
    case 'tls':
    case 'io': {
      const widthBits = positiveInteger(value.addressExpr?.widthBits)
        ?? positiveInteger(options.addressWidthBits)
        ?? positiveInteger(value.widthBits);
      if (widthBits == null) return null;
      return { kind: 'address', widthBits, addressSpace: String(options.addressSpace ?? value.kind) };
    }
    default:
      return null;
  }
}

export function machineValueReferenceKey(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind === 'temporary' && value.temporaryId != null) return `temporary:${String(value.temporaryId)}`;
  if (value.kind === 'register' && value.registerId != null) return `register:${String(value.registerId)}`;
  if (value.kind === 'flag' && value.flagId != null) return `flag:${String(value.flagId)}`;
  return null;
}

export function createPhysicalStateVariable(value) {
  if (!value || typeof value !== 'object') fail('semantic-ir-lowering-invalid-physical-state');
  if (value.kind === 'register' && value.registerId != null) {
    const registerId = String(value.registerId);
    return deepFreeze({
      key: `physical-state:${stableDigest({ kind: 'register', registerId })}`,
      kind: 'physical-state',
      scope: 'function',
      // widthBits/view describe an access view of the register, not the
      // identity of the physical state cell. MachineType preserves width on
      // values; keeping view metadata here would give the same canonical key
      // multiple identities (for example AArch64 w8 versus x8).
      physicalIdentity: { kind: 'register', registerId },
    });
  }
  if (value.kind === 'flag' && value.flagId != null) {
    const flagId = String(value.flagId);
    return deepFreeze({
      key: `physical-state:${stableDigest({ kind: 'flag', flagId })}`,
      kind: 'physical-state',
      scope: 'function',
      physicalIdentity: { kind: 'flag', flagId },
    });
  }
  fail('semantic-ir-lowering-nonphysical-machine-value');
}

export function createLoweringOrigin(baseOrigin, input = {}) {
  const sourceEffectIds = [...new Set((input.sourceEffectIds ?? []).map(String).filter(Boolean))].sort();
  const producedEntityIds = [...new Set((input.producedEntityIds ?? []).map(String).filter(Boolean))].sort();
  const withEffects = mergeOriginSets(
    createOriginSet(baseOrigin),
    sourceEffectIds.length ? createOriginSet({ operationIds: sourceEffectIds }) : null,
  );
  return appendTransform(withEffects, createTransformRecord({
    passId: MACHINE_EFFECTS_TO_SEMANTIC_IR_PASS_ID,
    passVersion: MACHINE_EFFECTS_TO_SEMANTIC_IR_PASS_VERSION,
    ruleId: String(input.ruleId ?? 'projection'),
    consumedEntityIds: sourceEffectIds,
    producedEntityIds,
    preconditions: ['validated-machine-effect-bundle'],
    proofKind: 'deterministic-normalized-projection',
  }));
}

function syntheticEffectId(bundle, role, payload) {
  return `machine-effect-${role}:${stableDigest({ instructionId: bundle.instructionId, role, payload })}`;
}

export function normalizeMachineEffectBundleForSemanticIr(input, options = {}) {
  assertNotAborted(options);
  const bundle = validateMachineEffectBundle(input, options);
  const effects = bundle.operations.map((operation, index) => {
    assertNotAborted(options);
    const sourceEffectId = operation.id ?? syntheticEffectId(bundle, `operation-${index}`, operation);
    return deepFreeze({
      index,
      sourceEffectId,
      operation: canonicalMachineValueOperation(operation, bundle),
      origin: mergeOriginSets(bundle.origin, createOriginSet({ operationIds: [sourceEffectId] })),
    });
  });
  const control = deepFreeze({
    sourceEffectId: syntheticEffectId(bundle, 'control', bundle.controlEffect),
    effect: bundle.controlEffect,
  });
  const unknown = bundle.unknownEffects == null ? null : deepFreeze({
    sourceEffectId: syntheticEffectId(bundle, 'unknown-effects', bundle.unknownEffects),
    effect: bundle.unknownEffects,
  });
  const annotation = (bundle.statePreservation != null || bundle.metadata != null || bundle.possibleFaults.length)
    ? deepFreeze({
      sourceEffectId: syntheticEffectId(bundle, 'bundle-annotation', {
        statePreservation: bundle.statePreservation ?? null,
        metadata: bundle.metadata ?? null,
        possibleFaults: bundle.possibleFaults,
      }),
    })
    : null;
  return deepFreeze({ bundle, effects, control, unknown, annotation });
}

export function semanticCompletenessFromMachineEffects(completeness) {
  if (completeness === 'unknown') return 'unknown';
  if (completeness === 'partial') return 'partial';
  return 'complete';
}