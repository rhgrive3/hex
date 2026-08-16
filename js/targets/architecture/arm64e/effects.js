import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../semantics/effects/index.js';

export const ARM64E_EFFECTS_SEMANTIC_VERSION = '1';

const POINTER_BITS = 64;
const KEY_BITS = 128;
const PAUTH_STATE_BITS = 64;
const PAUTH_STATE_ID = 'PAuthState';

export const ARM64E_PAUTH_KEYS = Object.freeze({
  ia: 'APIAKey',
  ib: 'APIBKey',
  da: 'APDAKey',
  db: 'APDBKey',
  ga: 'APGAKey',
});

const SIGN = Object.freeze({
  pacia: { key: 'ia', modifier: 'operand' },
  pacib: { key: 'ib', modifier: 'operand' },
  pacda: { key: 'da', modifier: 'operand' },
  pacdb: { key: 'db', modifier: 'operand' },
  paciza: { key: 'ia', modifier: 'zero' },
  pacizb: { key: 'ib', modifier: 'zero' },
  pacdza: { key: 'da', modifier: 'zero' },
  pacdzb: { key: 'db', modifier: 'zero' },
  paciasp: { key: 'ia', destination: 'x30', modifier: 'sp' },
  pacibsp: { key: 'ib', destination: 'x30', modifier: 'sp' },
  pacia1716: { key: 'ia', destination: 'x17', modifier: 'x16' },
  pacib1716: { key: 'ib', destination: 'x17', modifier: 'x16' },
});

const AUTH = Object.freeze({
  autia: { key: 'ia', modifier: 'operand' },
  autib: { key: 'ib', modifier: 'operand' },
  autda: { key: 'da', modifier: 'operand' },
  autdb: { key: 'db', modifier: 'operand' },
  autiza: { key: 'ia', modifier: 'zero' },
  autizb: { key: 'ib', modifier: 'zero' },
  autdza: { key: 'da', modifier: 'zero' },
  autdzb: { key: 'db', modifier: 'zero' },
  autiasp: { key: 'ia', destination: 'x30', modifier: 'sp' },
  autibsp: { key: 'ib', destination: 'x30', modifier: 'sp' },
  autia1716: { key: 'ia', destination: 'x17', modifier: 'x16' },
  autib1716: { key: 'ib', destination: 'x17', modifier: 'x16' },
});

const STRIP = Object.freeze({
  xpaci: { kind: 'instruction', destination: 'operand' },
  xpacd: { kind: 'data', destination: 'operand' },
  xpaclri: { kind: 'instruction', destination: 'x30' },
});

const AUTH_BRANCH = Object.freeze({
  braa: { key: 'ia', modifier: 'operand' },
  brab: { key: 'ib', modifier: 'operand' },
  braaz: { key: 'ia', modifier: 'zero' },
  brabz: { key: 'ib', modifier: 'zero' },
});

const AUTH_CALL = Object.freeze({
  blraa: { key: 'ia', modifier: 'operand' },
  blrab: { key: 'ib', modifier: 'operand' },
  blraaz: { key: 'ia', modifier: 'zero' },
  blrabz: { key: 'ib', modifier: 'zero' },
});

const AUTH_RETURN = Object.freeze({
  retaa: { key: 'ia' },
  retab: { key: 'ib' },
});

function mnemonicOf(decoded) {
  return String(decoded?.mnemonic ?? decoded?.opcode ?? '').trim().toLowerCase();
}

function splitOperands(text) {
  return String(text || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function operandList(decoded) {
  if (Array.isArray(decoded?.operands)) return decoded.operands;
  if (typeof decoded?.operands === 'string') return splitOperands(decoded.operands);
  return splitOperands(decoded?.opStr ?? decoded?.op_str ?? decoded?.operandString ?? decoded?.args);
}

function operandRegisterId(operand) {
  if (operand == null) return null;
  const raw = typeof operand === 'string'
    ? operand
    : operand.registerId ?? operand.register ?? operand.reg ?? operand.name ?? operand.text ?? operand.value?.registerId ?? operand.value?.reg;
  if (raw == null || (typeof raw !== 'string' && typeof raw !== 'number')) return null;
  let id = String(raw).trim().toLowerCase().replace(/^%/, '');
  if (id === 'lr') id = 'x30';
  if (id === 'fp') id = 'x29';
  if (/^x(?:[0-9]|[12][0-9]|30)$/.test(id) || id === 'sp') return id;
  return null;
}

function instructionIdOf(decoded, context) {
  const instructionId = String(context?.instructionId ?? decoded?.instructionId ?? '').trim();
  if (!instructionId) throw new TypeError('arm64e-instruction-id-required');
  return instructionId;
}

function originOf(decoded, context, instructionId) {
  const origin = context?.origin ?? decoded?.origin;
  if (origin != null) return origin;
  return { instructionIds: [instructionId] };
}

function modeOf(decoded, context) {
  return String(context?.mode ?? decoded?.mode ?? 'arm64e').trim() || 'arm64e';
}

function addressOf(decoded, context) {
  const value = context?.address ?? decoded?.address ?? decoded?.virtualAddress;
  if (value == null) return null;
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { return null; }
}

function reg(id, bits = POINTER_BITS) {
  return createRegisterValue(id, bits);
}

function tmp(id, bits = POINTER_BITS) {
  return createTemporaryValue(id, createBitVectorValue(bits));
}

function readRegister(operations, registerId, temporaryId, bits = POINTER_BITS, metadata) {
  const value = tmp(temporaryId, bits);
  operations.push(createMachineOperation({
    kind: 'register-read',
    register: reg(registerId, bits),
    value,
    ...(metadata == null ? {} : { metadata }),
  }));
  return value;
}

function writeRegister(operations, registerId, value, metadata) {
  operations.push(createMachineOperation({
    kind: 'register-write',
    register: reg(registerId, POINTER_BITS),
    value,
    ...(metadata == null ? {} : { metadata }),
  }));
}

function readPAuthState(operations, keyCode, prefix) {
  const keyId = ARM64E_PAUTH_KEYS[keyCode];
  const keyValue = readRegister(operations, keyId, `${prefix}.key`, KEY_BITS, {
    implicit: true,
    stateKind: 'pointer-authentication-key',
    keyIdentity: keyId,
  });
  const architectureState = readRegister(operations, PAUTH_STATE_ID, `${prefix}.state`, PAUTH_STATE_BITS, {
    implicit: true,
    stateKind: 'pointer-authentication-architecture-state',
  });
  return { keyId, keyValue, architectureState };
}

function modifierInput(operations, descriptor, operands, operandIndex, prefix) {
  if (descriptor.modifier === 'zero') {
    return { value: createBitVectorValue(POINTER_BITS, 0n), metadata: { kind: 'constant-zero' } };
  }
  const registerId = descriptor.modifier === 'operand'
    ? operandRegisterId(operands[operandIndex])
    : descriptor.modifier;
  if (!registerId) return null;
  return {
    value: readRegister(operations, registerId, `${prefix}.modifier`, POINTER_BITS, {
      stateKind: 'pointer-authentication-modifier',
    }),
    metadata: { kind: 'register', registerId },
  };
}

function intrinsicOperation({ intrinsicId, inputs, output, registersRead, metadata }) {
  return createMachineOperation({
    kind: 'intrinsic',
    intrinsicId,
    effectSummary: createIntrinsicEffectSummary({
      inputs,
      outputs: [output],
      registersRead,
      registersWritten: [],
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      controlEffects: [],
      determinism: 'input-dependent',
      symbolicDetail: 'summary-only',
    }),
    metadata,
  });
}

function authFault(mnemonic, keyId, use) {
  return {
    kind: use === 'control-target' ? 'instruction-address-fault' : 'pointer-authentication-fault',
    condition: {
      kind: 'pointer-authentication-failed',
      keyIdentity: keyId,
      architectureStateInput: PAUTH_STATE_ID,
      use,
    },
    detail: {
      mnemonic,
      behavior: use === 'control-target'
        ? 'authenticated target is not a valid instruction address'
        : 'immediate fault behavior depends on pointer-authentication architectural state',
    },
  };
}

function baseBundle(decoded, context, instructionId, operations, controlEffect, completeness, extra = {}) {
  return createMachineEffectBundle({
    instructionId,
    architectureId: 'arm64e',
    mode: modeOf(decoded, context),
    operations,
    controlEffect,
    possibleFaults: extra.possibleFaults ?? [],
    origin: originOf(decoded, context, instructionId),
    completeness,
    ...(extra.unknownEffects == null ? {} : { unknownEffects: extra.unknownEffects }),
    metadata: {
      semanticVersion: ARM64E_EFFECTS_SEMANTIC_VERSION,
      family: 'arm64e-pointer-authentication',
      mnemonic: mnemonicOf(decoded),
      ...(extra.metadata ?? {}),
    },
  }, context?.machineEffectsOptions);
}

function partialMissing(decoded, context, instructionId, reason, { control = false, fault = false } = {}) {
  const categories = control ? ['control', 'registers'] : ['registers'];
  const operations = [createMachineOperation({ kind: 'unknown', reason, categories })];
  return baseBundle(
    decoded,
    context,
    instructionId,
    operations,
    control ? { kind: 'unknown', reason } : { kind: 'fallthrough' },
    'partial',
    {
      possibleFaults: fault ? [{ kind: 'pointer-authentication-fault', condition: { kind: 'unresolved-arm64e-state' } }] : [],
      unknownEffects: { categories, reason, detail: { mnemonic: mnemonicOf(decoded) } },
      metadata: { unresolved: true },
    },
  );
}

function transformPointer(decoded, context, instructionId, descriptor, transform) {
  const operands = operandList(decoded);
  const destination = descriptor.destination && descriptor.destination !== 'operand'
    ? descriptor.destination
    : operandRegisterId(operands[0]);
  const modifierIndex = descriptor.destination && descriptor.destination !== 'operand' ? 0 : 1;
  if (!destination) return partialMissing(decoded, context, instructionId, `${transform}: destination register is unavailable`);

  const operations = [];
  const pointer = readRegister(operations, destination, `${instructionId}.pointer`, POINTER_BITS, {
    stateKind: 'pointer-authentication-pointer',
  });
  const modifier = modifierInput(operations, descriptor, operands, modifierIndex, instructionId);
  if (!modifier) return partialMissing(decoded, context, instructionId, `${transform}: modifier register is unavailable`);

  const { keyId, keyValue, architectureState } = readPAuthState(operations, descriptor.key, instructionId);
  const result = tmp(`${instructionId}.${transform}.result`, POINTER_BITS);
  operations.push(intrinsicOperation({
    intrinsicId: `arm64e.pointer.${transform}`,
    inputs: [pointer, modifier.value, keyValue, architectureState],
    output: result,
    registersRead: [destination, ...(modifier.metadata.registerId ? [modifier.metadata.registerId] : []), keyId, PAUTH_STATE_ID],
    metadata: {
      transform,
      keyIdentity: keyId,
      modifier: modifier.metadata,
      pointerRegister: destination,
      architectureStateInput: PAUTH_STATE_ID,
      cryptographicAlgorithm: 'not-modelled',
    },
  }));
  writeRegister(operations, destination, result, { transform, keyIdentity: keyId });

  return baseBundle(decoded, context, instructionId, operations, { kind: 'fallthrough' }, 'exact-with-intrinsic', {
    possibleFaults: transform === 'authenticate' ? [authFault(mnemonicOf(decoded), keyId, 'data-result')] : [],
    metadata: {
      transform,
      destinationRegister: destination,
      keyIdentity: keyId,
      modifier: modifier.metadata,
      architectureStateInput: PAUTH_STATE_ID,
    },
  });
}

function stripPointer(decoded, context, instructionId, descriptor) {
  const operands = operandList(decoded);
  const destination = descriptor.destination === 'operand' ? operandRegisterId(operands[0]) : descriptor.destination;
  if (!destination) return partialMissing(decoded, context, instructionId, 'strip: destination register is unavailable');

  const operations = [];
  const pointer = readRegister(operations, destination, `${instructionId}.pointer`, POINTER_BITS);
  const architectureState = readRegister(operations, PAUTH_STATE_ID, `${instructionId}.state`, PAUTH_STATE_BITS, {
    implicit: true,
    stateKind: 'pointer-authentication-architecture-state',
  });
  const result = tmp(`${instructionId}.strip.result`, POINTER_BITS);
  operations.push(intrinsicOperation({
    intrinsicId: 'arm64e.pointer.strip',
    inputs: [pointer, architectureState],
    output: result,
    registersRead: [destination, PAUTH_STATE_ID],
    metadata: {
      transform: 'strip',
      pointerKind: descriptor.kind,
      pointerRegister: destination,
      architectureStateInput: PAUTH_STATE_ID,
      authenticationPerformed: false,
    },
  }));
  writeRegister(operations, destination, result, { transform: 'strip', pointerKind: descriptor.kind });

  return baseBundle(decoded, context, instructionId, operations, { kind: 'fallthrough' }, 'exact-with-intrinsic', {
    metadata: {
      transform: 'strip',
      pointerKind: descriptor.kind,
      destinationRegister: destination,
      architectureStateInput: PAUTH_STATE_ID,
    },
  });
}

function genericCode(decoded, context, instructionId) {
  const operands = operandList(decoded);
  const destination = operandRegisterId(operands[0]);
  const valueRegister = operandRegisterId(operands[1]);
  const modifierRegister = operandRegisterId(operands[2]);
  if (!destination || !valueRegister || !modifierRegister) {
    return partialMissing(decoded, context, instructionId, 'pacga: destination, value, or modifier register is unavailable');
  }

  const operations = [];
  const value = readRegister(operations, valueRegister, `${instructionId}.value`, POINTER_BITS);
  const modifier = readRegister(operations, modifierRegister, `${instructionId}.modifier`, POINTER_BITS);
  const { keyId, keyValue, architectureState } = readPAuthState(operations, 'ga', instructionId);
  const result = tmp(`${instructionId}.generic-code.result`, POINTER_BITS);
  operations.push(intrinsicOperation({
    intrinsicId: 'arm64e.pointer.generic-code',
    inputs: [value, modifier, keyValue, architectureState],
    output: result,
    registersRead: [valueRegister, modifierRegister, keyId, PAUTH_STATE_ID],
    metadata: {
      transform: 'generic-code',
      keyIdentity: keyId,
      modifier: { kind: 'register', registerId: modifierRegister },
      architectureStateInput: PAUTH_STATE_ID,
      cryptographicAlgorithm: 'not-modelled',
    },
  }));
  writeRegister(operations, destination, result, { transform: 'generic-code', keyIdentity: keyId });

  return baseBundle(decoded, context, instructionId, operations, { kind: 'fallthrough' }, 'exact-with-intrinsic', {
    metadata: {
      transform: 'generic-code',
      destinationRegister: destination,
      keyIdentity: keyId,
      modifier: { kind: 'register', registerId: modifierRegister },
      architectureStateInput: PAUTH_STATE_ID,
    },
  });
}

function authenticateControlTarget(decoded, context, instructionId, descriptor, controlKind) {
  const operands = operandList(decoded);
  const targetRegister = controlKind === 'return' ? 'x30' : operandRegisterId(operands[0]);
  const modifierIndex = controlKind === 'return' ? 0 : 1;
  const effectiveDescriptor = controlKind === 'return' ? { ...descriptor, modifier: 'sp' } : descriptor;
  if (!targetRegister) {
    return partialMissing(decoded, context, instructionId, 'authenticated control target register is unavailable', { control: true, fault: true });
  }

  const operations = [];
  const target = readRegister(operations, targetRegister, `${instructionId}.target`, POINTER_BITS, {
    stateKind: 'authenticated-control-target',
  });
  const modifier = modifierInput(operations, effectiveDescriptor, operands, modifierIndex, instructionId);
  if (!modifier) {
    return partialMissing(decoded, context, instructionId, 'authenticated control modifier register is unavailable', { control: true, fault: true });
  }

  const { keyId, keyValue, architectureState } = readPAuthState(operations, descriptor.key, instructionId);
  const authenticatedTarget = tmp(`${instructionId}.authenticated-target`, POINTER_BITS);
  operations.push(intrinsicOperation({
    intrinsicId: 'arm64e.pointer.authenticate',
    inputs: [target, modifier.value, keyValue, architectureState],
    output: authenticatedTarget,
    registersRead: [targetRegister, ...(modifier.metadata.registerId ? [modifier.metadata.registerId] : []), keyId, PAUTH_STATE_ID],
    metadata: {
      transform: 'authenticate',
      use: 'control-target',
      keyIdentity: keyId,
      modifier: modifier.metadata,
      targetRegister,
      architectureStateInput: PAUTH_STATE_ID,
      cryptographicAlgorithm: 'not-modelled',
    },
  }));

  let completeness = 'exact-with-intrinsic';
  let unknownEffects;
  if (controlKind === 'call') {
    const address = addressOf(decoded, context);
    if (address == null) {
      const reason = 'authenticated call return address is unavailable';
      operations.push(createMachineOperation({ kind: 'unknown', reason, categories: ['registers'] }));
      completeness = 'partial';
      unknownEffects = { categories: ['registers'], reason, detail: { registerId: 'x30' } };
    } else {
      writeRegister(operations, 'x30', createBitVectorValue(POINTER_BITS, address + 4n), {
        stateKind: 'link-register',
        source: 'next-instruction-address',
      });
    }
  }

  return baseBundle(decoded, context, instructionId, operations, {
    kind: controlKind,
    target: authenticatedTarget,
  }, completeness, {
    possibleFaults: [authFault(mnemonicOf(decoded), keyId, 'control-target')],
    unknownEffects,
    metadata: {
      transform: 'authenticate',
      authenticatedControlTransfer: true,
      indirect: true,
      controlKind,
      targetRegister,
      keyIdentity: keyId,
      modifier: modifier.metadata,
      architectureStateInput: PAUTH_STATE_ID,
    },
  });
}

export function isArm64ePointerAuthenticationInstruction(decoded) {
  const mnemonic = mnemonicOf(decoded);
  return mnemonic === 'pacga'
    || Object.hasOwn(SIGN, mnemonic)
    || Object.hasOwn(AUTH, mnemonic)
    || Object.hasOwn(STRIP, mnemonic)
    || Object.hasOwn(AUTH_BRANCH, mnemonic)
    || Object.hasOwn(AUTH_CALL, mnemonic)
    || Object.hasOwn(AUTH_RETURN, mnemonic);
}

export function liftArm64eEffects(decoded, context = {}) {
  const mnemonic = mnemonicOf(decoded);
  if (!isArm64ePointerAuthenticationInstruction(decoded)) return null;
  const instructionId = instructionIdOf(decoded, context);

  if (Object.hasOwn(SIGN, mnemonic)) return transformPointer(decoded, context, instructionId, SIGN[mnemonic], 'sign');
  if (Object.hasOwn(AUTH, mnemonic)) return transformPointer(decoded, context, instructionId, AUTH[mnemonic], 'authenticate');
  if (Object.hasOwn(STRIP, mnemonic)) return stripPointer(decoded, context, instructionId, STRIP[mnemonic]);
  if (mnemonic === 'pacga') return genericCode(decoded, context, instructionId);
  if (Object.hasOwn(AUTH_BRANCH, mnemonic)) return authenticateControlTarget(decoded, context, instructionId, AUTH_BRANCH[mnemonic], 'branch');
  if (Object.hasOwn(AUTH_CALL, mnemonic)) return authenticateControlTarget(decoded, context, instructionId, AUTH_CALL[mnemonic], 'call');
  if (Object.hasOwn(AUTH_RETURN, mnemonic)) return authenticateControlTarget(decoded, context, instructionId, AUTH_RETURN[mnemonic], 'return');
  return null;
}

export function extendArm64WithArm64eEffects(baseLiftExact) {
  if (baseLiftExact != null && typeof baseLiftExact !== 'function') {
    throw new TypeError('arm64e-base-lifter-must-be-function');
  }
  return function liftArm64eExtension(decoded, context = {}) {
    const refined = liftArm64eEffects(decoded, context);
    if (refined != null) return refined;
    return baseLiftExact ? baseLiftExact(decoded, context) : null;
  };
}

export function createArm64eEffectsExtension(baseLiftExact = null) {
  return Object.freeze({
    architectureId: 'arm64e',
    semanticVersion: ARM64E_EFFECTS_SEMANTIC_VERSION,
    canHandle: isArm64ePointerAuthenticationInstruction,
    liftExact: extendArm64WithArm64eEffects(baseLiftExact),
  });
}
