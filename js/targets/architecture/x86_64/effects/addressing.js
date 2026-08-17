import { x86RegisterOperand } from './common.js';

const ADDRESS_WIDTHS = new Set([32, 64]);
const LEGACY_SEGMENTS = new Set(['cs', 'ds', 'es', 'ss']);
const TLS_SEGMENTS = new Set(['fs', 'gs']);
const MASK64 = (1n << 64n) - 1n;

function unsigned(value, bits) {
  const mask = (1n << BigInt(bits)) - 1n;
  return BigInt(value) & mask;
}

function bitvector(value, widthBits) {
  return Object.freeze({ kind:'bitvector', widthBits, value:unsigned(value, widthBits) });
}

function registerExpr(descriptor, widthBits) {
  if (!descriptor || descriptor.viewBits !== widthBits) return null;
  return Object.freeze({
    kind:'register',
    registerId:descriptor.physicalId,
    view:descriptor.id,
    widthBits,
  });
}

function add(left, right, widthBits, metadata = {}) {
  if (left == null) return right;
  if (right == null) return left;
  return Object.freeze({ kind:'add', left, right, widthBits, wrap:true, ...metadata });
}

function scaledIndex(index, scale, widthBits) {
  if (scale === 1) return index;
  return Object.freeze({
    kind:'scaled-index',
    index,
    scale,
    widthBits,
    calculation:Object.freeze({
      kind:'shift-left',
      value:index,
      amount:Math.log2(scale),
      widthBits,
      wrap:true,
    }),
  });
}

function addressSizeBits(instruction, memory) {
  const detailWidth = Number(instruction?.detail?.addressSizeBits);
  if (Number.isFinite(detailWidth) && detailWidth !== 0) {
    return ADDRESS_WIDTHS.has(detailWidth) ? detailWidth : null;
  }
  const operandWidth = Number(memory?.addressSizeBits);
  return ADDRESS_WIDTHS.has(operandWidth) ? operandWidth : null;
}

function segmentSemantics(segment) {
  if (segment == null || segment === '') {
    return Object.freeze({ segment:null, space:'memory', baseRule:'default-long-mode' });
  }
  const normalized = String(segment).toLowerCase();
  if (TLS_SEGMENTS.has(normalized)) {
    return Object.freeze({ segment:normalized, space:'tls', baseRule:'tls-segment-base-unknown' });
  }
  if (LEGACY_SEGMENTS.has(normalized)) {
    return Object.freeze({ segment:normalized, space:'memory', baseRule:'ignored-base-in-long-mode' });
  }
  return null;
}

function validatedComponents(instruction, memory) {
  if (!memory || ![1, 2, 4, 8].includes(Number(memory.scale))) return null;
  const widthBits = addressSizeBits(instruction, memory);
  if (!widthBits) return null;
  const segment = segmentSemantics(memory.segment);
  if (!segment) return null;

  const ripRelative = memory.base?.physicalId === 'rip';
  if (ripRelative && widthBits !== 64) return null;

  if (memory.base && !ripRelative && memory.base.viewBits !== widthBits) return null;
  if (memory.index && memory.index.viewBits !== widthBits) return null;
  if (memory.index?.physicalId === 'rip') return null;

  return Object.freeze({ widthBits, segment, ripRelative });
}

function structuredCalculation(instruction, memory, state) {
  const widthBits = state.widthBits;
  let calculation = null;
  let base = null;
  let index = null;
  let nextInstructionAddress = null;

  if (memory.base) {
    if (state.ripRelative) {
      nextInstructionAddress = (BigInt(instruction.address) + BigInt(instruction.length)) & MASK64;
      base = Object.freeze({
        kind:'next-instruction-address',
        widthBits:64,
        value:nextInstructionAddress,
        instructionAddress:BigInt(instruction.address) & MASK64,
        instructionLength:Number(instruction.length),
      });
    } else {
      base = registerExpr(memory.base, widthBits);
      if (!base) return null;
    }
    calculation = base;
  }

  if (memory.index) {
    const indexRegister = registerExpr(memory.index, widthBits);
    if (!indexRegister) return null;
    index = scaledIndex(indexRegister, Number(memory.scale), widthBits);
    calculation = add(calculation, index, widthBits, { addressComponent:'index' });
  }

  const displacement = BigInt(memory.displacement ?? 0n);
  if (displacement !== 0n || calculation == null) {
    calculation = add(calculation, bitvector(displacement, widthBits), widthBits, { addressComponent:'displacement' });
  }

  if (widthBits === 32) {
    calculation = Object.freeze({
      kind:'zero-extend',
      fromWidthBits:32,
      toWidthBits:64,
      value:Object.freeze({ kind:'wrap', widthBits:32, value:calculation }),
    });
  }

  return Object.freeze({ calculation, base, index, displacement, nextInstructionAddress });
}

export function x86EffectiveAddressExpression(instruction, memoryOperand) {
  const memory = memoryOperand?.memory;
  const state = validatedComponents(instruction, memory);
  if (!state) return null;
  const structured = structuredCalculation(instruction, memory, state);
  if (!structured) return null;
  const originInstructionId = instruction?.instructionId == null ? null : String(instruction.instructionId);

  const expression = Object.freeze({
    kind:'x86-effective-address',
    widthBits:64,
    addressSizeBits:state.widthBits,
    calculation:structured.calculation,
    base:structured.base,
    index:structured.index,
    scale:Number(memory.scale),
    displacement:structured.displacement,
    ripRelative:state.ripRelative,
    nextInstructionAddress:structured.nextInstructionAddress,
    segment:state.segment.segment,
    segmentBaseRule:state.segment.baseRule,
    originInstructionId,
  });

  return Object.freeze({
    expression,
    space:state.segment.space,
    metadata:Object.freeze({
      base:memory.base?.id ?? null,
      basePhysical:memory.base?.physicalId ?? null,
      index:memory.index?.id ?? null,
      indexPhysical:memory.index?.physicalId ?? null,
      scale:Number(memory.scale),
      displacement:structured.displacement,
      segment:state.segment.segment,
      segmentBaseRule:state.segment.baseRule,
      ripRelative:state.ripRelative,
      addressSizeBits:state.widthBits,
      instructionAddress:BigInt(instruction.address),
      instructionLength:Number(instruction.length),
      originInstructionId,
    }),
  });
}

export function materializeX86Address(ctx, memoryOperand) {
  const memory = memoryOperand?.memory;
  const state = validatedComponents(ctx?.instruction, memory);
  if (!state) return null;
  const widthBits = state.widthBits;
  let value = null;

  if (memory.base) {
    if (state.ripRelative) {
      value = ctx.constant(64, BigInt(ctx.instruction.address) + BigInt(ctx.instruction.length));
    } else {
      const operand = x86RegisterOperand(memory.base.id);
      if (!operand || operand.widthBits !== widthBits) return null;
      value = ctx.readRegister(operand);
      if (!value) return null;
    }
  }

  if (memory.index) {
    const operand = x86RegisterOperand(memory.index.id);
    if (!operand || operand.widthBits !== widthBits) return null;
    let index = ctx.readRegister(operand);
    if (!index) return null;
    if (memory.scale !== 1) {
      index = ctx.valueOp('shl', [index, ctx.constant(widthBits, BigInt(Math.log2(memory.scale)))], widthBits, {
        addressComponent:'scaled-index',
        scale:memory.scale,
        addressSizeBits:widthBits,
      });
    }
    value = value == null
      ? index
      : ctx.valueOp('add', [value,index], widthBits, { addressComponent:'index', addressSizeBits:widthBits, wrap:true });
  }

  if (memory.displacement !== 0n || value == null) {
    const displacement = ctx.constant(widthBits, memory.displacement);
    value = value == null
      ? displacement
      : ctx.valueOp('add', [value,displacement], widthBits, { addressComponent:'displacement', addressSizeBits:widthBits, wrap:true });
  }

  if (widthBits === 32) {
    value = ctx.coerce(value, 32, 64, false);
  }
  return value;
}
