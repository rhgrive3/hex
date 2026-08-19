import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
} from '../../../../semantics/effects/index.js';

export const ARM64_BTYPE_REGISTER_ID = 'pstate.btype';
export const ARM64_BTYPE_WIDTH_BITS = 2;
export const ARM64_BTYPE_REGISTER = createRegisterValue(ARM64_BTYPE_REGISTER_ID, ARM64_BTYPE_WIDTH_BITS);

const DIRECT_RESET = /^(?:b|bl|cbz|cbnz|tbz|tbnz|b\.(?:eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al|nv))$/;
const INDIRECT_JUMP = new Set(['br','braa','brab','braaz','brabz']);
const INDIRECT_CALL = new Set(['blr','blraa','blrab','blraaz','blrabz']);

function mnemonicOf(decoded) {
  return String(decoded?.mnemonic ?? decoded?.opcode ?? '').trim().toLowerCase();
}

function registerIdFromOperand(operand) {
  if (operand == null) return null;
  if (operand?.k === 'reg') {
    if (operand.cls === 'gp' && Number.isInteger(operand.num) && operand.num >= 0 && operand.num <= 30) return `x${operand.num}`;
    if (operand.cls === 'sp') return 'sp';
  }
  const raw = typeof operand === 'string'
    ? operand
    : operand.registerId ?? operand.register ?? operand.reg ?? operand.name ?? operand.text ?? operand.value?.registerId ?? operand.value?.reg;
  if (raw == null || (typeof raw !== 'string' && typeof raw !== 'number')) return null;
  let id = String(raw).trim().toLowerCase().replace(/^%/, '');
  if (id === 'lr') id = 'x30';
  if (id === 'fp') id = 'x29';
  return /^x(?:[0-9]|[12][0-9]|30)$/.test(id) || id === 'sp' ? id : null;
}

function targetRegisterOf(decoded) {
  const operands = Array.isArray(decoded?.ops)
    ? decoded.ops
    : Array.isArray(decoded?.operands)
      ? decoded.operands
      : String(decoded?.operands ?? decoded?.opStr ?? decoded?.op_str ?? '')
          .split(',').map((part) => part.trim()).filter(Boolean);
  return registerIdFromOperand(operands[0]);
}

function guardedPageState(context) {
  const value = context?.branchTargetIdentification?.currentPageGuarded;
  return value === true || value === false ? value : null;
}

/**
 * Resolve the architectural PSTATE.BTYPE post-state for A64 control transfers.
 *
 * For BR-family transfers through IP0/IP1 (x16/x17), the branch type is always
 * the jump-compatible value 1. Other BR-family transfers depend on whether the
 * source page is guarded: non-guarded -> 1, guarded -> 3. BLR-family transfers
 * set call type 2. Direct branch families reset BTYPE to 0.
 *
 * The current guarded-page state is a loader/runtime input, not instruction
 * syntax. If it is absent, return an explicit unknown transition so callers can
 * fail closed rather than choosing a convenient branch type.
 */
export function resolveArm64BtypeTransition(decoded, context = {}) {
  const mnemonic = mnemonicOf(decoded);
  if (DIRECT_RESET.test(mnemonic)) {
    return Object.freeze({ kind:'known', value:0, branchKind:'direct', mnemonic });
  }
  if (INDIRECT_CALL.has(mnemonic)) {
    return Object.freeze({ kind:'known', value:2, branchKind:'indirect-call', mnemonic, sourceRegister:targetRegisterOf(decoded) });
  }
  if (!INDIRECT_JUMP.has(mnemonic)) return null;

  const sourceRegister = targetRegisterOf(decoded);
  if (!sourceRegister) {
    return Object.freeze({
      kind:'unknown', branchKind:'indirect-jump', mnemonic,
      reason:'arm64-btype-target-register-unavailable', sourceRegister:null,
    });
  }
  if (sourceRegister === 'x16' || sourceRegister === 'x17') {
    return Object.freeze({ kind:'known', value:1, branchKind:'indirect-jump', mnemonic, sourceRegister, currentPageGuarded:guardedPageState(context) });
  }

  const currentPageGuarded = guardedPageState(context);
  if (currentPageGuarded === false) {
    return Object.freeze({ kind:'known', value:1, branchKind:'indirect-jump', mnemonic, sourceRegister, currentPageGuarded });
  }
  if (currentPageGuarded === true) {
    return Object.freeze({ kind:'known', value:3, branchKind:'indirect-jump', mnemonic, sourceRegister, currentPageGuarded });
  }
  return Object.freeze({
    kind:'unknown', branchKind:'indirect-jump', mnemonic, sourceRegister,
    currentPageGuarded:null,
    reason:'arm64-btype-current-page-guarded-state-unavailable',
  });
}

function transitionMetadata(transition) {
  return {
    stateKind:'branch-target-identification',
    branchKind:transition.branchKind,
    mnemonic:transition.mnemonic,
    ...(transition.sourceRegister ? { sourceRegister:transition.sourceRegister } : {}),
    ...(transition.currentPageGuarded == null ? {} : { currentPageGuarded:transition.currentPageGuarded }),
    ...(transition.kind === 'known' ? { architecturalValue:transition.value } : { unresolved:true }),
  };
}

export function arm64BtypeOperationInputs(transition) {
  if (!transition) return Object.freeze([]);
  const value = transition.kind === 'known'
    ? createBitVectorValue(ARM64_BTYPE_WIDTH_BITS, BigInt(transition.value))
    : createBitVectorValue(ARM64_BTYPE_WIDTH_BITS);
  const write = createMachineOperation({
    kind:'register-write',
    register:ARM64_BTYPE_REGISTER,
    value,
    metadata:transitionMetadata(transition),
  });
  if (transition.kind === 'known') return Object.freeze([write]);
  const unknown = createMachineOperation({
    kind:'unknown',
    reason:transition.reason,
    categories:['registers'],
    metadata:{ stateKind:'branch-target-identification', registerId:ARM64_BTYPE_REGISTER_ID },
  });
  return Object.freeze([write, unknown]);
}

function hasBtypeWrite(bundle) {
  return bundle.operations.some((operation) => operation.kind === 'register-write' && operation.register?.registerId === ARM64_BTYPE_REGISTER_ID);
}

function mergedUnknownEffects(existing, transition) {
  const categories = [...new Set([...(existing?.categories || []), 'registers'])].sort();
  if (!existing) {
    return {
      categories,
      reason:transition.reason,
      detail:{
        stateKind:'branch-target-identification',
        registerId:ARM64_BTYPE_REGISTER_ID,
        branchKind:transition.branchKind,
        sourceRegister:transition.sourceRegister ?? null,
        currentPageGuarded:transition.currentPageGuarded ?? null,
      },
    };
  }
  return {
    categories,
    reason:existing.reason,
    detail:{
      existing:existing.detail ?? null,
      additionalUnknown:{
        reason:transition.reason,
        stateKind:'branch-target-identification',
        registerId:ARM64_BTYPE_REGISTER_ID,
        branchKind:transition.branchKind,
        sourceRegister:transition.sourceRegister ?? null,
        currentPageGuarded:transition.currentPageGuarded ?? null,
      },
    },
  };
}

/**
 * Decorate an already-lifted control bundle with the canonical BTYPE post-state.
 * This is also used by the arm64e wrapper so authenticated BR/BLR variants share
 * exactly the same state model as their non-authenticated counterparts.
 */
export function decorateArm64BtypeEffects(decoded, context, bundle) {
  if (!bundle || hasBtypeWrite(bundle)) return bundle;
  const transition = resolveArm64BtypeTransition(decoded, context);
  if (!transition) return bundle;

  const operations = [...bundle.operations, ...arm64BtypeOperationInputs(transition)];
  const completeness = transition.kind === 'unknown' ? 'partial' : bundle.completeness;
  const unknownEffects = transition.kind === 'unknown'
    ? mergedUnknownEffects(bundle.unknownEffects, transition)
    : bundle.unknownEffects;
  const metadata = {
    ...(bundle.metadata || {}),
    btypeTransition:{
      kind:transition.kind,
      branchKind:transition.branchKind,
      ...(transition.kind === 'known' ? { value:transition.value } : { reason:transition.reason }),
      ...(transition.sourceRegister ? { sourceRegister:transition.sourceRegister } : {}),
      ...(transition.currentPageGuarded == null ? {} : { currentPageGuarded:transition.currentPageGuarded }),
    },
  };
  return createMachineEffectBundle({
    ...bundle,
    operations,
    completeness,
    ...(unknownEffects ? { unknownEffects } : {}),
    metadata,
  }, context?.machineEffectsOptions || context?.options || {});
}
