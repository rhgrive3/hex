import {
  createBitVectorValue,
  createFloatValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
  createVectorValue,
} from '../../../../semantics/effects/index.js';

const ARCHITECTURE_ID = 'arm64';
const MODE = 'a64';
const FPCR = 'fpcr';
const FPSR = 'fpsr';

const ELEMENT_BITS = Object.freeze({ b:8, h:16, s:32, d:64 });
const FLOAT_FORMAT = Object.freeze({
  16:'ieee754-binary16',
  32:'ieee754-binary32',
  64:'ieee754-binary64',
});

const MEMORY_FAMILIES = /^(?:ld[1-4]|st[1-4]|ldr|str|ldur|stur|ldp|stp)/;
const LANE_MNEMONICS = new Set(['dup','ins','umov','smov','mov']);
const IMMEDIATE_MNEMONICS = new Set(['movi','mvni']);
const PERMUTE_MNEMONICS = new Set(['tbl','tbx','zip1','zip2','uzp1','uzp2','trn1','trn2','ext','rev64','rev64_v']);
const REDUCE_MNEMONICS = new Set(['addv','uaddlv','saddlv','smaxv','sminv','umaxv','uminv']);
const NARROW_MNEMONICS = new Set(['xtn','xtn2','sqxtn','sqxtn2','uqxtn','uqxtn2','sqxtun','sqxtun2']);
const INTEGER_VECTOR_MNEMONICS = new Set([
  'add','sub','mul','mla','mls','abs','neg','and','orr','orr_v','eor','bic','orn','not',
  'cmeq','cmge','cmgt','cmhi','cmhs','cmtst','smax','smin','umax','umin','addp',
  'smaxp','sminp','umaxp','uminp','shl','sshl','ushl','sshr','ushr','sli','sri',
  'sqadd','uqadd','sqsub','uqsub','suqadd',
]);
const FP_VECTOR_MNEMONICS = new Set([
  'fadd','fsub','fmul','fdiv','fmla','fmls','fabs','fneg','fsqrt','fmax','fmin','fmaxnm','fminnm',
  'fcmeq','fcmge','fcmgt','facge','facgt','frecpe','frecps','frsqrte','frsqrts',
  'fcvtzs','fcvtzu','scvtf','ucvtf','frinta','frintm','frintn','frintp','frintx','frinti','frintz',
]);
const FP_VECTOR_NO_STATUS = new Set(['fabs','fneg']);
const SATURATING_MNEMONICS = new Set([
  'sqadd','uqadd','sqsub','uqsub','suqadd','sqxtn','sqxtn2','uqxtn','uqxtn2','sqxtun','sqxtun2',
]);
const DESTINATION_IS_INPUT = new Set([
  'ins','tbx','mla','mls','fmla','fmls','sli','sri','xtn2','sqxtn2','uqxtn2','sqxtun2',
]);
const OWNED = new Set([
  ...LANE_MNEMONICS, ...IMMEDIATE_MNEMONICS, ...PERMUTE_MNEMONICS, ...REDUCE_MNEMONICS,
  ...NARROW_MNEMONICS, ...INTEGER_VECTOR_MNEMONICS, ...FP_VECTOR_MNEMONICS,
]);

function mnemonicOf(instruction) {
  return String(instruction?.mnemonic || '').trim().toLowerCase();
}
function operandsOf(instruction) {
  if (Array.isArray(instruction?.ops)) return instruction.ops;
  if (Array.isArray(instruction?.parsed)) return instruction.parsed;
  if (Array.isArray(instruction?.operandsParsed)) return instruction.operandsParsed;
  return [];
}
function operandText(instruction) {
  return String(instruction?.operands ?? instruction?.opStr ?? '');
}
function isSve(instruction) {
  return /(?:^|[\s,{])(?:z|p)\d+(?:\.|\b)|\bffr\b/i.test(operandText(instruction));
}
function hasVectorOperand(ops) {
  return ops.some((op) => op?.k === 'elem' || op?.k === 'list' || (op?.k === 'reg' && (op.cls === 'vec' || (op.cls === 'fp' && op.bits === 128))));
}
function instructionIdOf(instruction, context) {
  const id = instruction?.instructionId ?? context?.instructionId;
  if (!id) throw new TypeError('arm64-simd-machine-effects-instruction-id-required');
  return String(id);
}
function originOf(instruction, context, instructionId) {
  return instruction?.origin ?? context?.origin ?? { instructionIds:[instructionId] };
}
function bundle(instruction, context, fields) {
  const instructionId = instructionIdOf(instruction, context);
  return createMachineEffectBundle({
    instructionId,
    architectureId:ARCHITECTURE_ID,
    mode:MODE,
    operations:fields.operations,
    controlEffect:fields.controlEffect || { kind:'fallthrough' },
    possibleFaults:fields.possibleFaults || [],
    origin:originOf(instruction, context, instructionId),
    completeness:fields.completeness,
    ...(fields.unknownEffects ? { unknownEffects:fields.unknownEffects } : {}),
    metadata:{ family:'arm64-simd', mnemonic:mnemonicOf(instruction), ...(fields.metadata || {}) },
  }, context?.machineEffectsOptions || {});
}
function partial(instruction, context, reason, categories = ['registers','other'], operations = []) {
  return bundle(instruction, context, {
    operations:[...operations, createMachineOperation({ kind:'unknown', reason, categories })],
    completeness:'partial',
    unknownEffects:{ categories, reason },
  });
}
function temp(id, valueType) {
  return createTemporaryValue(id, valueType);
}
function physicalRegisterId(op) {
  if (!op) return null;
  if (op.k === 'elem') return `v${op.num}`;
  if (op.k !== 'reg' || op.cls === 'zr') return null;
  if (op.cls === 'sp') return 'sp';
  if (op.cls === 'gp') return `x${op.num}`;
  if (op.cls === 'fp' || op.cls === 'vec') return `v${op.num}`;
  return null;
}
function registerIdsOf(ops) {
  const out = [];
  for (const op of ops) {
    if (op?.k === 'list') {
      for (const reg of op.regs || []) {
        const id = physicalRegisterId(reg);
        if (id) out.push(id);
      }
      continue;
    }
    const id = physicalRegisterId(op);
    if (id) out.push(id);
  }
  return [...new Set(out)];
}
function parseArrangement(op, elementKind = 'bitvector') {
  const arr = String(op?.arr || '').toLowerCase();
  const match = /^(\d+)([bhsd])$/.exec(arr);
  if (!match) return null;
  const laneCount = Number(match[1]);
  const elementBits = ELEMENT_BITS[match[2]];
  if (!laneCount || !elementBits) return null;
  const widthBits = laneCount * elementBits;
  if (widthBits !== 64 && widthBits !== 128) return null;
  let elementType;
  if (elementKind === 'float') {
    const format = FLOAT_FORMAT[elementBits];
    if (!format) return null;
    elementType = createFloatValue(elementBits, format);
  } else {
    elementType = createBitVectorValue(elementBits);
  }
  return { arr, laneCount, elementBits, widthBits, elementType, valueType:createVectorValue(laneCount, elementType) };
}
function elementInfo(op, elementKind = 'bitvector') {
  if (op?.k !== 'elem') return null;
  const size = String(op.size || '').toLowerCase();
  const elementBits = ELEMENT_BITS[size];
  if (!elementBits) return null;
  const laneCount = 128 / elementBits;
  if (!Number.isInteger(op.index) || op.index < 0 || op.index >= laneCount) return null;
  let valueType;
  if (elementKind === 'float') {
    const format = FLOAT_FORMAT[elementBits];
    if (!format) return null;
    valueType = createFloatValue(elementBits, format);
  } else valueType = createBitVectorValue(elementBits);
  return { elementBits, laneCount, index:op.index, size, valueType };
}
function registerValueForVector(op, arrangement) {
  const id = physicalRegisterId(op);
  if (!id || !arrangement) return null;
  return createRegisterValue(id, arrangement.widthBits, { view:String(op.text || `${id}.${arrangement.arr}`).toLowerCase() });
}
function appendVectorRead(operations, op, arrangement, id) {
  const reg = registerValueForVector(op, arrangement);
  if (!reg) return null;
  const value = temp(id, arrangement.valueType);
  operations.push(createMachineOperation({ kind:'register-read', register:reg, value }));
  return value;
}
function appendElementRead(operations, op, info, id) {
  if (!info) return null;
  const fullValue = temp(`${id}:full-vector`, createVectorValue(info.laneCount, info.valueType));
  operations.push(createMachineOperation({
    kind:'register-read',
    register:createRegisterValue(`v${op.num}`, 128, { view:`v${op.num}` }),
    value:fullValue,
    metadata:{ canonicalPhysicalStorage:true, projectedView:String(op.text || `v${op.num}.${info.size}[${info.index}]`).toLowerCase() },
  }));
  const value = temp(id, info.valueType);
  operations.push(createMachineOperation({
    kind:'value', opcode:'extract-lane', inputs:[fullValue], outputs:[value],
    metadata:{ laneIndex:info.index, laneWidthBits:info.elementBits, sourceWidthBits:128 },
  }));
  return value;
}
function appendGpRead(operations, op, id) {
  if (!op || op.k !== 'reg' || op.cls !== 'gp') return null;
  const bits = Number(op.bits || 64);
  const value = temp(id, createBitVectorValue(bits));
  operations.push(createMachineOperation({
    kind:'register-read',
    register:createRegisterValue(`x${op.num}`, bits, { view:String(op.text || `x${op.num}`).toLowerCase() }),
    value,
  }));
  return value;
}
function appendNamedRead(operations, registerId, widthBits, id) {
  const value = temp(id, createBitVectorValue(widthBits));
  operations.push(createMachineOperation({ kind:'register-read', register:createRegisterValue(registerId, widthBits), value }));
  return value;
}
function appendNamedWrite(operations, registerId, widthBits, value) {
  operations.push(createMachineOperation({ kind:'register-write', register:createRegisterValue(registerId, widthBits), value }));
}
function appendVectorWrite(operations, dst, arrangement, value, metadata = {}) {
  operations.push(createMachineOperation({
    kind:'register-write',
    register:registerValueForVector(dst, arrangement),
    value,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  }));
}
function appendGpWrite(operations, dst, semanticValue, idPrefix) {
  if (!dst || dst.k !== 'reg' || dst.cls !== 'gp') return false;
  const bits = Number(dst.bits || 64);
  if (bits === 32) {
    const physical = temp(`${idPrefix}:w-write`, createBitVectorValue(64));
    operations.push(createMachineOperation({ kind:'value', opcode:'arm64.zero-extend-w-write', inputs:[semanticValue], outputs:[physical] }));
    operations.push(createMachineOperation({
      kind:'register-write', register:createRegisterValue(`x${dst.num}`, 64, { view:`x${dst.num}` }), value:physical,
      metadata:{ architecturalViewWritten:String(dst.text || `w${dst.num}`).toLowerCase() },
    }));
  } else {
    operations.push(createMachineOperation({
      kind:'register-write', register:createRegisterValue(`x${dst.num}`, 64, { view:String(dst.text || `x${dst.num}`).toLowerCase() }), value:semanticValue,
    }));
  }
  return true;
}
function immediateValue(op) {
  if (op?.k !== 'imm' || op.value == null) return null;
  return createBitVectorValue(64, BigInt.asUintN(64, BigInt(op.value)));
}
function fullVectorFromElement(op, elementKind = 'bitvector') {
  const info = elementInfo(op, elementKind);
  if (!info) return null;
  const elementType = elementKind === 'float'
    ? createFloatValue(info.elementBits, FLOAT_FORMAT[info.elementBits])
    : createBitVectorValue(info.elementBits);
  return {
    arr:`${info.laneCount}${info.size}`,
    laneCount:info.laneCount,
    elementBits:info.elementBits,
    widthBits:128,
    elementType,
    valueType:createVectorValue(info.laneCount, elementType),
  };
}

function laneEffects(instruction, context, mnemonic, ops) {
  const dst = ops[0];
  const src = ops[1];
  const operations = [];

  if (mnemonic === 'ins' || (mnemonic === 'mov' && dst?.k === 'elem')) {
    const dstInfo = elementInfo(dst);
    const full = fullVectorFromElement(dst);
    if (!dstInfo || !full) return partial(instruction, context, `${mnemonic}-destination-lane-unavailable`);
    const prior = appendVectorRead(operations, { k:'reg', cls:'vec', num:dst.num, bits:128, arr:full.arr, text:`v${dst.num}.${full.arr}` }, full, `${mnemonic}:prior`);
    let source;
    if (src?.k === 'elem') source = appendElementRead(operations, src, elementInfo(src), `${mnemonic}:src`);
    else source = appendGpRead(operations, src, `${mnemonic}:src`);
    if (!source) return partial(instruction, context, `${mnemonic}-source-lane-unavailable`, ['registers','other'], operations);
    const result = temp(`${mnemonic}:result`, full.valueType);
    const summary = createIntrinsicEffectSummary({
      inputs:[prior, source], outputs:[result],
      registersRead:[`v${dst.num}`, ...registerIdsOf([src])], registersWritten:[`v${dst.num}`],
      memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[],
      determinism:'deterministic', symbolicDetail:'summary-only',
    });
    operations.push(createMachineOperation({
      kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}.lane-insert`, effectSummary:summary,
      metadata:{ destinationLane:dstInfo.index, laneWidthBits:dstInfo.elementBits, sourceLane:src?.k === 'elem' ? src.index : null },
    }));
    appendVectorWrite(operations, { k:'reg', cls:'vec', num:dst.num, arr:full.arr, text:`v${dst.num}.${full.arr}` }, full, result, { laneWritten:dstInfo.index });
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ laneWidthBits:dstInfo.elementBits, laneIndex:dstInfo.index } });
  }

  if (mnemonic === 'umov' || mnemonic === 'smov' || (mnemonic === 'mov' && src?.k === 'elem' && dst?.cls === 'gp')) {
    const srcInfo = elementInfo(src);
    if (!srcInfo || dst?.k !== 'reg' || dst?.cls !== 'gp') return partial(instruction, context, `${mnemonic}-lane-move-operands-unavailable`);
    const source = appendElementRead(operations, src, srcInfo, `${mnemonic}:src`);
    const semanticBits = Number(dst.bits || 64);
    const result = temp(`${mnemonic}:result`, createBitVectorValue(semanticBits));
    const summary = createIntrinsicEffectSummary({
      inputs:[source], outputs:[result], registersRead:[`v${src.num}`], registersWritten:[`x${dst.num}`],
      memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[], determinism:'deterministic', symbolicDetail:'summary-only',
    });
    operations.push(createMachineOperation({
      kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}.lane-extract`, effectSummary:summary,
      metadata:{ sourceLane:srcInfo.index, laneWidthBits:srcInfo.elementBits, extension:mnemonic === 'smov' ? 'sign' : 'zero-or-bitcopy', destinationWidthBits:semanticBits },
    }));
    appendGpWrite(operations, dst, result, `${mnemonic}:dst`);
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ laneWidthBits:srcInfo.elementBits, laneIndex:srcInfo.index } });
  }

  if (mnemonic === 'dup' || (mnemonic === 'mov' && dst?.k === 'reg' && dst?.cls === 'vec')) {
    const arrangement = parseArrangement(dst);
    if (!arrangement) return partial(instruction, context, `${mnemonic}-vector-arrangement-unavailable`);
    let source;
    if (src?.k === 'elem') source = appendElementRead(operations, src, elementInfo(src), `${mnemonic}:src`);
    else source = appendGpRead(operations, src, `${mnemonic}:src`);
    if (!source) return partial(instruction, context, `${mnemonic}-duplicate-source-unavailable`, ['registers','other'], operations);
    const result = temp(`${mnemonic}:result`, arrangement.valueType);
    const summary = createIntrinsicEffectSummary({
      inputs:[source], outputs:[result], registersRead:registerIdsOf([src]), registersWritten:[`v${dst.num}`],
      memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[], determinism:'deterministic', symbolicDetail:'summary-only',
    });
    operations.push(createMachineOperation({ kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}.duplicate`, effectSummary:summary, metadata:{ arrangement:arrangement.arr } }));
    appendVectorWrite(operations, dst, arrangement, result);
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ arrangement:arrangement.arr } });
  }

  return partial(instruction, context, `${mnemonic}-lane-form-unsupported`);
}

function vectorImmediate(instruction, context, mnemonic, ops) {
  const dst = ops[0];
  const imm = ops[1];
  const arrangement = parseArrangement(dst);
  const immediate = immediateValue(imm);
  if (!arrangement || !immediate) return partial(instruction, context, `${mnemonic}-arrangement-or-immediate-unavailable`);
  const operations = [];
  const result = temp(`${mnemonic}:result`, arrangement.valueType);
  const summary = createIntrinsicEffectSummary({
    inputs:[immediate], outputs:[result], registersRead:[], registersWritten:[`v${dst.num}`],
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[], determinism:'deterministic', symbolicDetail:'summary-only',
  });
  operations.push(createMachineOperation({
    kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}`, effectSummary:summary,
    metadata:{ arrangement:arrangement.arr, shift:imm?.shift || null },
  }));
  appendVectorWrite(operations, dst, arrangement, result);
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ arrangement:arrangement.arr } });
}

function listReads(operations, list, elementKind, idPrefix) {
  if (list?.k !== 'list' || !Array.isArray(list.regs) || list.regs.length === 0) return null;
  const values = [];
  const arrangements = [];
  for (let i = 0; i < list.regs.length; i++) {
    const reg = list.regs[i];
    const arrangement = parseArrangement(reg, elementKind);
    if (!arrangement) return null;
    const value = appendVectorRead(operations, reg, arrangement, `${idPrefix}:${i}`);
    if (!value) return null;
    values.push(value);
    arrangements.push(arrangement);
  }
  return { values, arrangements };
}

function genericVectorIntrinsic(instruction, context, mnemonic, ops) {
  const floating = FP_VECTOR_MNEMONICS.has(mnemonic);
  const elementKind = floating ? 'float' : 'bitvector';
  const dst = ops[0];
  const dstArrangement = parseArrangement(dst, elementKind);
  if (!dstArrangement) return partial(instruction, context, `${mnemonic}-destination-arrangement-unavailable`);

  const operations = [];
  const inputs = [];
  const sourceOps = [];
  if (DESTINATION_IS_INPUT.has(mnemonic)) {
    const prior = appendVectorRead(operations, dst, dstArrangement, `${mnemonic}:prior`);
    if (!prior) return partial(instruction, context, `${mnemonic}-destination-read-unavailable`);
    inputs.push(prior);
    sourceOps.push(dst);
  }

  for (let i = 1; i < ops.length; i++) {
    const op = ops[i];
    if (op?.k === 'cond') continue;
    if (op?.k === 'imm') {
      const iv = immediateValue(op);
      if (!iv) return partial(instruction, context, `${mnemonic}-immediate-unavailable`, ['other'], operations);
      inputs.push(iv);
      continue;
    }
    if (op?.k === 'list') {
      const list = listReads(operations, op, elementKind, `${mnemonic}:table`);
      if (!list) return partial(instruction, context, `${mnemonic}-vector-list-arrangement-unavailable`, ['registers','other'], operations);
      inputs.push(...list.values);
      sourceOps.push(...op.regs);
      continue;
    }
    if (op?.k === 'elem') {
      const ev = appendElementRead(operations, op, elementInfo(op, elementKind), `${mnemonic}:src${i}`);
      if (!ev) return partial(instruction, context, `${mnemonic}-source-lane-unavailable`, ['registers','other'], operations);
      inputs.push(ev);
      sourceOps.push(op);
      continue;
    }
    if (op?.k === 'reg' && op.cls === 'gp') {
      const gv = appendGpRead(operations, op, `${mnemonic}:src${i}`);
      if (!gv) return partial(instruction, context, `${mnemonic}-gp-source-unavailable`, ['registers','other'], operations);
      inputs.push(gv);
      sourceOps.push(op);
      continue;
    }
    const arrangement = parseArrangement(op, elementKind);
    if (!arrangement) return partial(instruction, context, `${mnemonic}-source-arrangement-unavailable`, ['registers','other'], operations);
    const vv = appendVectorRead(operations, op, arrangement, `${mnemonic}:src${i}`);
    if (!vv) return partial(instruction, context, `${mnemonic}-source-register-unavailable`, ['registers','other'], operations);
    inputs.push(vv);
    sourceOps.push(op);
  }

  let statusInput = null;
  let statusOutput = null;
  let fpcrInput = null;
  const usesFpStatus = floating && !FP_VECTOR_NO_STATUS.has(mnemonic);
  const usesSaturationStatus = SATURATING_MNEMONICS.has(mnemonic);
  if (usesFpStatus) {
    fpcrInput = appendNamedRead(operations, FPCR, 32, `${mnemonic}:fpcr`);
    inputs.push(fpcrInput);
  }
  if (usesFpStatus || usesSaturationStatus) {
    statusInput = appendNamedRead(operations, FPSR, 32, `${mnemonic}:fpsr`);
    inputs.push(statusInput);
    statusOutput = temp(`${mnemonic}:fpsr-out`, createBitVectorValue(32));
  }

  const result = temp(`${mnemonic}:result`, dstArrangement.valueType);
  const outputs = statusOutput ? [result, statusOutput] : [result];
  const registersRead = registerIdsOf(sourceOps);
  if (usesFpStatus) registersRead.push(FPCR);
  if (usesFpStatus || usesSaturationStatus) registersRead.push(FPSR);
  const registersWritten = [`v${dst.num}`];
  if (statusOutput) registersWritten.push(FPSR);

  const summary = createIntrinsicEffectSummary({
    inputs, outputs, registersRead, registersWritten,
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[],
    determinism:'input-dependent', symbolicDetail:'summary-only',
  });
  operations.push(createMachineOperation({
    kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}`, effectSummary:summary,
    metadata:{
      arrangement:dstArrangement.arr,
      laneCount:dstArrangement.laneCount,
      laneWidthBits:dstArrangement.elementBits,
      floating,
      saturation:usesSaturationStatus,
      laneSemantics:'fixed-width',
    },
  }));
  appendVectorWrite(operations, dst, dstArrangement, result);
  if (statusOutput) appendNamedWrite(operations, FPSR, 32, statusOutput);
  return bundle(instruction, context, {
    operations,
    completeness:'exact-with-intrinsic',
    metadata:{ arrangement:dstArrangement.arr, laneCount:dstArrangement.laneCount, laneWidthBits:dstArrangement.elementBits },
  });
}

function reduction(instruction, context, mnemonic, ops) {
  const dst = ops[0];
  const src = ops[1];
  const srcArrangement = parseArrangement(src);
  const dstBits = Number(dst?.bits || 0);
  if (!srcArrangement || !dstBits || dst?.k !== 'reg' || (dst.cls !== 'fp' && dst.cls !== 'vec')) {
    return partial(instruction, context, `${mnemonic}-reduction-shape-unavailable`);
  }
  const operations = [];
  const source = appendVectorRead(operations, src, srcArrangement, `${mnemonic}:src`);
  const result = temp(`${mnemonic}:result`, createBitVectorValue(dstBits));
  const summary = createIntrinsicEffectSummary({
    inputs:[source], outputs:[result], registersRead:[`v${src.num}`], registersWritten:[`v${dst.num}`],
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[], determinism:'deterministic', symbolicDetail:'summary-only',
  });
  operations.push(createMachineOperation({
    kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}`, effectSummary:summary,
    metadata:{ sourceArrangement:srcArrangement.arr, resultWidthBits:dstBits },
  }));
  operations.push(createMachineOperation({
    kind:'register-write', register:createRegisterValue(`v${dst.num}`, dstBits, { view:String(dst.text || '').toLowerCase() }), value:result,
  }));
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ sourceArrangement:srcArrangement.arr, resultWidthBits:dstBits } });
}

function narrow(instruction, context, mnemonic, ops) {
  const dst = ops[0];
  const src = ops[1];
  const dstArrangement = parseArrangement(dst);
  const srcArrangement = parseArrangement(src);
  if (!dstArrangement || !srcArrangement) return partial(instruction, context, `${mnemonic}-narrow-arrangement-unavailable`);
  if (srcArrangement.elementBits !== dstArrangement.elementBits * 2) {
    return partial(instruction, context, `${mnemonic}-narrow-lane-width-mismatch`);
  }
  return genericVectorIntrinsic(instruction, context, mnemonic, ops);
}

function tableOrPermute(instruction, context, mnemonic, ops) {
  if (mnemonic === 'tbl' || mnemonic === 'tbx') {
    const dst = ops[0];
    const table = ops[1];
    const index = ops[2];
    const dstArrangement = parseArrangement(dst);
    const indexArrangement = parseArrangement(index);
    if (!dstArrangement || !indexArrangement || table?.k !== 'list') {
      return partial(instruction, context, `${mnemonic}-table-shape-unavailable`);
    }
  }
  return genericVectorIntrinsic(instruction, context, mnemonic, ops);
}

export function liftArm64SimdEffects(instruction, context = {}) {
  const mnemonic = mnemonicOf(instruction);
  const ops = operandsOf(instruction);

  if (MEMORY_FAMILIES.test(mnemonic)) return null;
  if (isSve(instruction)) {
    if (hasVectorOperand(ops) || OWNED.has(mnemonic) || /^(?:f|s|u|sq|uq)/.test(mnemonic)) {
      return partial(instruction, context, 'arm64-sve-scalable-vector-semantics-unsupported', ['registers','flags','other']);
    }
    return null;
  }
  if (!hasVectorOperand(ops)) return null;

  if (LANE_MNEMONICS.has(mnemonic)) return laneEffects(instruction, context, mnemonic, ops);
  if (IMMEDIATE_MNEMONICS.has(mnemonic)) return vectorImmediate(instruction, context, mnemonic, ops);
  if (REDUCE_MNEMONICS.has(mnemonic)) return reduction(instruction, context, mnemonic, ops);
  if (NARROW_MNEMONICS.has(mnemonic)) return narrow(instruction, context, mnemonic, ops);
  if (PERMUTE_MNEMONICS.has(mnemonic)) return tableOrPermute(instruction, context, mnemonic, ops);
  if (INTEGER_VECTOR_MNEMONICS.has(mnemonic) || FP_VECTOR_MNEMONICS.has(mnemonic)) {
    return genericVectorIntrinsic(instruction, context, mnemonic, ops);
  }

  return partial(instruction, context, `arm64-simd-instruction-unsupported:${mnemonic || 'unknown'}`, ['registers','flags','other']);
}

export const arm64SimdMachineEffects = liftArm64SimdEffects;
