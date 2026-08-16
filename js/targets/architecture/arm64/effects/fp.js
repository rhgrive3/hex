import {
  createBitVectorValue,
  createFloatValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';

const ARCHITECTURE_ID = 'arm64';
const MODE = 'a64';
const FPCR = 'fpcr';
const FPSR = 'fpsr';
const NZCV = 'nzcv';

const FP_ENV_INTRINSICS = new Set([
  'fadd','fsub','fmul','fdiv','fsqrt','fmadd','fmsub','fnmadd','fnmsub',
  'fmax','fmin','fmaxnm','fminnm','frecpe','frecps','frsqrte','frsqrts',
  'fcvt','scvtf','ucvtf',
  'fcvtas','fcvtau','fcvtms','fcvtmu','fcvtns','fcvtnu','fcvtps','fcvtpu','fcvtzs','fcvtzu',
  'frinta','frintm','frintn','frintp','frintx','frinti','frintz',
]);
const FP_COMPARE = new Set(['fcmp','fcmpe','fccmp','fccmpe']);
const FP_BITWISE = new Set(['fmov','fabs','fneg']);
const FP_SELECT = new Set(['fcsel']);
const OWNED = new Set([...FP_ENV_INTRINSICS, ...FP_COMPARE, ...FP_BITWISE, ...FP_SELECT]);

const FLOAT_FORMAT = Object.freeze({
  16: 'ieee754-binary16',
  32: 'ieee754-binary32',
  64: 'ieee754-binary64',
});

function mnemonicOf(instruction) {
  return String(instruction?.mnemonic || '').trim().toLowerCase();
}

function operandsOf(instruction) {
  if (Array.isArray(instruction?.ops)) return instruction.ops;
  if (Array.isArray(instruction?.parsed)) return instruction.parsed;
  if (Array.isArray(instruction?.operandsParsed)) return instruction.operandsParsed;
  return [];
}

function isSve(instruction) {
  const text = `${instruction?.operands || ''} ${instruction?.opStr || ''}`.toLowerCase();
  return /(?:^|[\s,{])(?:z|p)\d+(?:\.|\b)/.test(text) || /\bffr\b/.test(text);
}

function isVectorOperand(op) {
  return op?.k === 'elem' || op?.k === 'list' || (op?.k === 'reg' && op?.cls === 'vec' && op?.arr);
}

function instructionIdOf(instruction, context) {
  const id = instruction?.instructionId ?? context?.instructionId;
  if (!id) throw new TypeError('arm64-fp-machine-effects-instruction-id-required');
  return String(id);
}

function originOf(instruction, context, instructionId) {
  return instruction?.origin ?? context?.origin ?? { instructionIds: [instructionId] };
}

function bundle(instruction, context, fields) {
  const instructionId = instructionIdOf(instruction, context);
  return createMachineEffectBundle({
    instructionId,
    architectureId: ARCHITECTURE_ID,
    mode: MODE,
    operations: fields.operations,
    controlEffect: fields.controlEffect || { kind: 'fallthrough' },
    possibleFaults: fields.possibleFaults || [],
    origin: originOf(instruction, context, instructionId),
    completeness: fields.completeness,
    ...(fields.unknownEffects ? { unknownEffects: fields.unknownEffects } : {}),
    ...(fields.statePreservation ? { statePreservation: fields.statePreservation } : {}),
    metadata: { family: 'arm64-fp', mnemonic: mnemonicOf(instruction), ...(fields.metadata || {}) },
  }, context?.machineEffectsOptions || {});
}

function partial(instruction, context, reason, categories = ['registers','flags','other'], operations = []) {
  return bundle(instruction, context, {
    operations: [
      ...operations,
      createMachineOperation({ kind: 'unknown', reason, categories }),
    ],
    completeness: 'partial',
    unknownEffects: { categories, reason },
  });
}

function scalarWidth(op) {
  const bits = Number(op?.bits || 0);
  return Number.isSafeInteger(bits) && bits > 0 ? bits : null;
}

function floatType(bits) {
  const format = FLOAT_FORMAT[bits];
  return format ? createFloatValue(bits, format) : null;
}

function bitType(bits) {
  return createBitVectorValue(bits);
}

function physicalRegisterId(op) {
  if (!op || op.k !== 'reg') return null;
  if (op.cls === 'zr') return null;
  if (op.cls === 'sp') return 'sp';
  if (op.cls === 'gp') return `x${op.num}`;
  if (op.cls === 'fp' || op.cls === 'vec') return `v${op.num}`;
  return null;
}

function registerValue(op, width = scalarWidth(op)) {
  const id = physicalRegisterId(op);
  if (!id || !width) return null;
  return createRegisterValue(id, width, { view: String(op.text || id).toLowerCase() });
}

function temp(id, valueType) {
  return createTemporaryValue(id, valueType);
}

function appendRegisterRead(operations, op, valueType, id) {
  const reg = registerValue(op, valueType?.widthBits || scalarWidth(op));
  if (!reg) return null;
  const value = temp(id, valueType);
  operations.push(createMachineOperation({ kind: 'register-read', register: reg, value }));
  return value;
}

function appendNamedRegisterRead(operations, registerId, widthBits, id) {
  const value = temp(id, bitType(widthBits));
  operations.push(createMachineOperation({
    kind: 'register-read',
    register: createRegisterValue(registerId, widthBits),
    value,
  }));
  return value;
}

function appendNamedRegisterWrite(operations, registerId, widthBits, value) {
  operations.push(createMachineOperation({
    kind: 'register-write',
    register: createRegisterValue(registerId, widthBits),
    value,
  }));
}

function appendDestinationWrite(operations, dst, semanticValue, idPrefix) {
  if (!dst || dst.k !== 'reg' || dst.cls === 'zr') return;
  if (dst.cls === 'gp') {
    const id = physicalRegisterId(dst);
    const bits = scalarWidth(dst);
    if (bits === 32) {
      const physical = temp(`${idPrefix}:w-write`, bitType(64));
      operations.push(createMachineOperation({
        kind: 'value',
        opcode: 'arm64.zero-extend-w-write',
        inputs: [semanticValue],
        outputs: [physical],
        metadata: { sourceWidthBits: 32, destinationWidthBits: 64 },
      }));
      operations.push(createMachineOperation({
        kind: 'register-write',
        register: createRegisterValue(id, 64, { view: id }),
        value: physical,
        metadata: { architecturalViewWritten: String(dst.text || `w${dst.num}`).toLowerCase() },
      }));
      return;
    }
    operations.push(createMachineOperation({
      kind: 'register-write',
      register: registerValue(dst, bits),
      value: semanticValue,
    }));
    return;
  }
  operations.push(createMachineOperation({
    kind: 'register-write',
    register: registerValue(dst, scalarWidth(dst)),
    value: semanticValue,
  }));
}

function immediateValue(op, widthBits, asFloat) {
  if (!op || op.k !== 'imm') return null;
  if (asFloat) {
    const format = FLOAT_FORMAT[widthBits];
    if (!format) return null;
    if (op.bitPattern != null) return createFloatValue(widthBits, format, { bitPattern: op.bitPattern });
    if (op.float === 0 || op.float === 0.0) return createFloatValue(widthBits, format, { bitPattern: 0n });
    if (op.float != null) return createFloatValue(widthBits, format, { semanticValue: String(op.float) });
    return null;
  }
  if (op.value == null) return null;
  const value = BigInt.asUintN(widthBits, BigInt(op.value));
  return createBitVectorValue(widthBits, value);
}

function sourceValue(operations, op, valueType, id) {
  if (!op) return null;
  if (op.k === 'reg') return appendRegisterRead(operations, op, valueType, id);
  if (op.k === 'imm') return immediateValue(op, valueType.widthBits, valueType.kind === 'float');
  return null;
}

function registerIdsOf(ops) {
  return [...new Set(ops.map(physicalRegisterId).filter(Boolean))];
}

function roundingMode(mnemonic) {
  if (/^fcvt[azmnp][su]$/.test(mnemonic)) {
    const mode = mnemonic[4];
    return { a:'ties-away', z:'toward-zero', m:'toward-minus-infinity', n:'ties-to-even', p:'toward-plus-infinity' }[mode] || 'encoded';
  }
  if (/^frint[amnpz]$/.test(mnemonic)) {
    const mode = mnemonic[5];
    return { a:'ties-away', z:'toward-zero', m:'toward-minus-infinity', n:'ties-to-even', p:'toward-plus-infinity' }[mode] || 'encoded';
  }
  return 'fpcr';
}

function exactBitwise(instruction, context, mnemonic, ops) {
  const dst = ops[0];
  const src = ops[1];
  const dstBits = scalarWidth(dst);
  const srcBits = scalarWidth(src) || dstBits;
  if (!dst || !dstBits || !src || dstBits !== srcBits) {
    return partial(instruction, context, `${mnemonic}-operand-width-unavailable`, ['registers','other']);
  }

  const operations = [];
  const type = bitType(dstBits);
  let input;
  if (src.k === 'imm') {
    if (src.bitPattern == null) {
      const unknownFloat = FLOAT_FORMAT[dstBits] ? createFloatValue(dstBits, FLOAT_FORMAT[dstBits], { semanticValue: String(src.float ?? src.text ?? 'unknown') }) : type;
      appendDestinationWrite(operations, dst, unknownFloat, `${mnemonic}:dst`);
      return partial(instruction, context, 'fp-immediate-bit-pattern-unavailable', ['other'], operations);
    }
    input = createBitVectorValue(dstBits, BigInt.asUintN(dstBits, BigInt(src.bitPattern)));
  } else {
    input = sourceValue(operations, src, type, `${mnemonic}:src0`);
  }
  if (!input) return partial(instruction, context, `${mnemonic}-source-unavailable`, ['registers','other'], operations);

  const output = temp(`${mnemonic}:result`, type);
  const opcode = mnemonic === 'fabs' ? 'arm64.fp.clear-sign-bit'
    : mnemonic === 'fneg' ? 'arm64.fp.toggle-sign-bit'
      : 'arm64.fp.bitcopy';
  operations.push(createMachineOperation({ kind: 'value', opcode, inputs: [input], outputs: [output] }));
  appendDestinationWrite(operations, dst, output, `${mnemonic}:dst`);
  return bundle(instruction, context, { operations, completeness: 'exact', metadata: { widthBits: dstBits } });
}

function exactSelect(instruction, context, mnemonic, ops) {
  const dst = ops[0];
  const a = ops[1];
  const b = ops[2];
  const width = scalarWidth(dst);
  const type = width ? floatType(width) : null;
  if (!type || scalarWidth(a) !== width || scalarWidth(b) !== width) {
    return partial(instruction, context, 'fcsel-width-or-operands-unavailable', ['registers','flags','other']);
  }
  const operations = [];
  const av = sourceValue(operations, a, type, 'fcsel:src0');
  const bv = sourceValue(operations, b, type, 'fcsel:src1');
  const flags = appendNamedRegisterRead(operations, NZCV, 4, 'fcsel:nzcv');
  const result = temp('fcsel:result', type);
  const summary = createIntrinsicEffectSummary({
    inputs: [av, bv, flags],
    outputs: [result],
    registersRead: [...registerIdsOf([a,b]), NZCV],
    registersWritten: registerIdsOf([dst]),
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'deterministic',
    symbolicDetail: 'summary-only',
  });
  operations.push(createMachineOperation({
    kind: 'intrinsic', intrinsicId: 'arm64.fp.fcsel', effectSummary: summary,
    metadata: { condition: ops.find((op) => op?.k === 'cond')?.text || null, widthBits: width },
  }));
  appendDestinationWrite(operations, dst, result, 'fcsel:dst');
  return bundle(instruction, context, { operations, completeness: 'exact-with-intrinsic', metadata: { widthBits: width } });
}

function compare(instruction, context, mnemonic, ops) {
  const lhs = ops[0];
  const width = scalarWidth(lhs);
  const type = width ? floatType(width) : null;
  if (!type) return partial(instruction, context, `${mnemonic}-float-width-unavailable`, ['registers','flags','other']);

  const rhs = ops[1];
  const operations = [];
  const inputs = [];
  const left = sourceValue(operations, lhs, type, `${mnemonic}:src0`);
  const right = sourceValue(operations, rhs, type, `${mnemonic}:src1`);
  if (!left || !right) return partial(instruction, context, `${mnemonic}-operands-unavailable`, ['registers','flags','other'], operations);
  inputs.push(left, right);

  if (mnemonic.startsWith('fccmp')) {
    inputs.push(appendNamedRegisterRead(operations, NZCV, 4, `${mnemonic}:old-nzcv`));
  }
  inputs.push(appendNamedRegisterRead(operations, FPCR, 32, `${mnemonic}:fpcr`));
  inputs.push(appendNamedRegisterRead(operations, FPSR, 32, `${mnemonic}:fpsr`));

  const nzcv = temp(`${mnemonic}:nzcv`, bitType(4));
  const fpsr = temp(`${mnemonic}:fpsr-out`, bitType(32));
  const outputs = [nzcv, fpsr];
  const reads = [...registerIdsOf([lhs, rhs]), FPCR, FPSR];
  if (mnemonic.startsWith('fccmp')) reads.push(NZCV);
  const summary = createIntrinsicEffectSummary({
    inputs,
    outputs,
    registersRead: reads,
    registersWritten: [NZCV, FPSR],
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'input-dependent',
    symbolicDetail: 'summary-only',
  });
  operations.push(createMachineOperation({
    kind: 'intrinsic', intrinsicId: `arm64.fp.${mnemonic}`, effectSummary: summary,
    metadata: {
      widthBits: width,
      signalingNaN: mnemonic.endsWith('e'),
      condition: ops.find((op) => op?.k === 'cond')?.text || null,
      fallbackNzcv: ops.find((op, index) => index >= 2 && op?.k === 'imm' && op?.value != null)?.value ?? null,
    },
  }));
  appendNamedRegisterWrite(operations, NZCV, 4, nzcv);
  appendNamedRegisterWrite(operations, FPSR, 32, fpsr);
  return bundle(instruction, context, { operations, completeness: 'exact-with-intrinsic', metadata: { widthBits: width } });
}

function envIntrinsic(instruction, context, mnemonic, ops) {
  const dst = ops[0];
  const sourceOps = ops.slice(1).filter((op) => op?.k === 'reg' || op?.k === 'imm');
  const dstWidth = scalarWidth(dst);
  if (!dst || !dstWidth) return partial(instruction, context, `${mnemonic}-destination-width-unavailable`, ['registers','other']);

  const conversionToInteger = /^fcvt[a-z]*[su]$/.test(mnemonic);
  const integerToFloat = mnemonic === 'scvtf' || mnemonic === 'ucvtf';
  const floatToFloat = mnemonic === 'fcvt';
  const resultType = conversionToInteger ? bitType(dstWidth) : floatType(dstWidth);
  if (!resultType) return partial(instruction, context, `${mnemonic}-result-type-unavailable`, ['registers','other']);

  const operations = [];
  const inputs = [];
  for (let i = 0; i < sourceOps.length; i++) {
    const op = sourceOps[i];
    let valueType;
    if (integerToFloat && i === 0) valueType = bitType(scalarWidth(op) || 64);
    else valueType = floatType(scalarWidth(op) || dstWidth);
    if (!valueType) return partial(instruction, context, `${mnemonic}-source-type-unavailable`, ['registers','other'], operations);
    const value = sourceValue(operations, op, valueType, `${mnemonic}:src${i}`);
    if (!value) return partial(instruction, context, `${mnemonic}-source-unavailable`, ['registers','other'], operations);
    if (op.k === 'imm' && value.kind === 'float' && value.bitPattern == null && op.float != null && op.float !== 0) {
      return partial(instruction, context, `${mnemonic}-immediate-bit-pattern-unavailable`, ['other'], operations);
    }
    inputs.push(value);
  }
  if (inputs.length === 0 && !floatToFloat) {
    return partial(instruction, context, `${mnemonic}-source-unavailable`, ['registers','other'], operations);
  }

  const fpcr = appendNamedRegisterRead(operations, FPCR, 32, `${mnemonic}:fpcr`);
  const oldFpsr = appendNamedRegisterRead(operations, FPSR, 32, `${mnemonic}:fpsr`);
  inputs.push(fpcr, oldFpsr);

  const result = temp(`${mnemonic}:result`, resultType);
  const newFpsr = temp(`${mnemonic}:fpsr-out`, bitType(32));
  const outputs = [result, newFpsr];
  const registersRead = [...registerIdsOf(sourceOps), FPCR, FPSR];
  const registersWritten = [...registerIdsOf([dst]), FPSR];
  const summary = createIntrinsicEffectSummary({
    inputs,
    outputs,
    registersRead,
    registersWritten,
    memoryRead: { scope: 'none' },
    memoryWrite: { scope: 'none' },
    controlEffects: [],
    determinism: 'input-dependent',
    symbolicDetail: 'summary-only',
  });
  operations.push(createMachineOperation({
    kind: 'intrinsic', intrinsicId: `arm64.fp.${mnemonic}`, effectSummary: summary,
    metadata: {
      destinationWidthBits: dstWidth,
      sourceWidthBits: sourceOps.map(scalarWidth),
      roundingMode: roundingMode(mnemonic),
      fused: /^(?:fmadd|fmsub|fnmadd|fnmsub)$/.test(mnemonic),
      nanAndExceptionSemantics: 'architectural-intrinsic',
    },
  }));
  appendDestinationWrite(operations, dst, result, `${mnemonic}:dst`);
  appendNamedRegisterWrite(operations, FPSR, 32, newFpsr);

  return bundle(instruction, context, {
    operations,
    completeness: 'exact-with-intrinsic',
    metadata: { destinationWidthBits: dstWidth, roundingMode: roundingMode(mnemonic) },
  });
}

export function liftArm64FpEffects(instruction, context = {}) {
  const mnemonic = mnemonicOf(instruction);
  const ops = operandsOf(instruction);

  if (isSve(instruction)) {
    if (mnemonic.startsWith('f') || OWNED.has(mnemonic)) {
      return partial(instruction, context, 'arm64-sve-scalable-vector-semantics-unsupported', ['registers','flags','other']);
    }
    return null;
  }

  if (ops.some(isVectorOperand)) return null;
  if (!OWNED.has(mnemonic)) {
    return mnemonic.startsWith('f')
      ? partial(instruction, context, `arm64-fp-instruction-unsupported:${mnemonic || 'unknown'}`, ['registers','flags','other'])
      : null;
  }

  if (FP_BITWISE.has(mnemonic)) return exactBitwise(instruction, context, mnemonic, ops);
  if (FP_SELECT.has(mnemonic)) return exactSelect(instruction, context, mnemonic, ops);
  if (FP_COMPARE.has(mnemonic)) return compare(instruction, context, mnemonic, ops);
  return envIntrinsic(instruction, context, mnemonic, ops);
}

export const arm64FpMachineEffects = liftArm64FpEffects;
