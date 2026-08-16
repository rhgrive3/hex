import { OP } from '../../architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { validateMachineEffectBundle } from '../effects/index.js';

const ARM64_ARCHITECTURES = new Set(['arm64', 'arm64e', 'aarch64']);
const TEMP_PREFIX = '$me:';
const FLAG_PREFIX = '$flag:';

const BIN_OPS = Object.freeze({
  add: 'add', sub: 'sub', mul: 'mul', smull: 'smull', umull: 'umull',
  smulh: 'smulh', umulh: 'umulh', sdiv: 'sdiv', udiv: 'udiv',
  and: 'and', or: 'or', orr: 'or', xor: 'xor', eor: 'xor', bic: 'bic',
  orn: 'orn', eon: 'eon', shl: 'shl', lsl: 'shl', lshr: 'lshr', lsr: 'lshr',
  ashr: 'ashr', asr: 'ashr', ror: 'ror', fadd: 'fadd', fsub: 'fsub',
  fmul: 'fmul', fdiv: 'fdiv',
});

const UN_OPS = Object.freeze({
  neg: 'neg', not: 'not', fneg: 'fneg', fabs: 'fabs', fsqrt: 'fsqrt',
  sxt8: 'sxt8', sxt16: 'sxt16', sxt32: 'sxt32',
  uxt8: 'uxt8', uxt16: 'uxt16', uxt32: 'uxt32',
  clz: 'clz', rbit: 'rbit', rev: 'rev', rev16: 'rev16', rev32: 'rev32',
  i2f: 'i2f', u2f: 'u2f', f2i: 'f2i', f2u: 'f2u', fmov: 'fmov', abs: 'abs',
});

const COPY_OPS = new Set(['copy', 'mov', 'move', 'identity', 'bitcast']);
const SELECT_OPS = new Set(['select', 'sel']);
const COMPARE_OPS = new Set(['cmp', 'compare', 'icmp', 'fcmp', 'test']);
const ADDRESS_OPS = new Set(['addr', 'address']);
const MAC_OPS = new Set(['mac', 'madd', 'msub']);
const BFX_OPS = new Set(['bfx', 'extract', 'bit-extract']);
const BFI_OPS = new Set(['bfi', 'insert', 'bit-insert']);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function safeBigInt(value) {
  if (value == null) return null;
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { return null; }
}

function valueWidth(value) {
  if (!value || typeof value !== 'object') return 64;
  if (value.kind === 'temporary') return valueWidth(value.valueType);
  if (value.kind === 'vector') return value.laneCount * valueWidth(value.elementType);
  return Number(value.widthBits || 64) || 64;
}

function temporaryRegister(value) {
  return `${TEMP_PREFIX}${value.temporaryId}`;
}

function flagRegister(value) {
  const id = String(value.flagId || '').trim();
  return id.toLowerCase() === 'nzcv' ? 'nzcv' : `${FLAG_PREFIX}${id}`;
}

function registerForValue(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind === 'register') return value.registerId;
  if (value.kind === 'temporary') return temporaryRegister(value);
  if (value.kind === 'flag') return flagRegister(value);
  return null;
}

function sourceOf(value) {
  if (!value || typeof value !== 'object') return null;
  switch (value.kind) {
    case 'register':
      return { t: 'reg', reg: value.registerId, bits: valueWidth(value) };
    case 'temporary':
      return { t: 'reg', reg: temporaryRegister(value), bits: valueWidth(value) };
    case 'flag':
      return { t: 'reg', reg: flagRegister(value), bits: valueWidth(value) };
    case 'bitvector': {
      const immediate = safeBigInt(value.value);
      return immediate == null ? null : { t: 'imm', value: immediate, bits: valueWidth(value) };
    }
    case 'float': {
      if (value.semanticValue != null && Number.isFinite(Number(value.semanticValue))) {
        return { t: 'imm', value: null, float: Number(value.semanticValue), constKind: 'float', bits: valueWidth(value) };
      }
      const bits = safeBigInt(value.bitPattern);
      return bits == null ? null : { t: 'imm', value: bits, bits: valueWidth(value), constKind: 'float-bits' };
    }
    default:
      return null;
  }
}

function directTargetOf(value) {
  if (value == null) return null;
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') {
    const n = safeBigInt(value);
    return n == null ? value : n;
  }
  if (typeof value !== 'object') return null;
  if (value.kind === 'bitvector') return safeBigInt(value.value);
  if (value.address != null) return safeBigInt(value.address) ?? value.address;
  if (value.value != null && value.kind == null) return safeBigInt(value.value) ?? value.value;
  return null;
}

function originAddress(bundle, options) {
  if (options.address != null) return options.address;
  const start = bundle.origin?.virtualRanges?.[0]?.start;
  return start == null ? null : (safeBigInt(start) ?? start);
}

function baseFields(bundle, operation, options) {
  const out = {
    row: options.row ?? null,
    address: originAddress(bundle, options),
    text: options.text ?? `machine-effects ${bundle.instructionId}`,
    instructionId: bundle.instructionId,
    origin: bundle.origin,
    possibleFaults: bundle.possibleFaults,
  };
  if (operation?.id != null) out.effectOperationId = operation.id;
  if (operation?.metadata != null) out.effectMetadata = operation.metadata;
  return out;
}

function legacy(bundle, operation, options, op, fields = {}) {
  return { ...baseFields(bundle, operation, options), op, ...fields };
}

function writeFields(outputs) {
  const entries = outputs
    .map((value) => ({ reg: registerForValue(value), bits: valueWidth(value) }))
    .filter((entry) => entry.reg);
  if (!entries.length) return { dstReg: null, dstBits: 64, extraWrites: [], writeWidths: {} };
  return {
    dstReg: entries[0].reg,
    dstBits: entries[0].bits,
    extraWrites: entries.slice(1).map((entry) => entry.reg),
    writeWidths: Object.fromEntries(entries.map((entry) => [entry.reg, entry.bits])),
  };
}

function unknownInstruction(bundle, operation, options, reason, categories, writes = {}) {
  const registerUniverse = Array.isArray(options.registerUniverse) ? options.registerUniverse.map(String) : [];
  const categoriesList = unique((categories || ['other']).map(String)).sort();
  const clobbers = categoriesList.includes('registers') ? unique(registerUniverse) : [];
  return legacy(bundle, operation, options, OP.UNKNOWN, {
    reason,
    unknownCategories: categoriesList,
    srcs: [],
    dstReg: writes.dstReg || null,
    dstBits: writes.dstBits || 64,
    extraWrites: writes.extraWrites || [],
    clobbers,
    unknownRegisters: categoriesList.includes('registers') && clobbers.length === 0,
  });
}

function lowerRegisterLikeRead(bundle, operation, options, sourceValue, resultValue) {
  const src = sourceOf(sourceValue);
  const writes = writeFields([resultValue]);
  if (!src || !writes.dstReg) {
    return [unknownInstruction(bundle, operation, options, 'unrepresentable-machine-read', ['registers'], writes)];
  }
  return [legacy(bundle, operation, options, OP.MOV, { ...writes, srcs: [src] })];
}

function lowerRegisterLikeWrite(bundle, operation, options, targetValue, sourceValue) {
  const target = registerForValue(targetValue);
  const bits = valueWidth(targetValue);
  const src = sourceOf(sourceValue);
  const writes = { dstReg: target, dstBits: bits, extraWrites: [], writeWidths: target ? { [target]: bits } : {} };
  if (!target || !src) {
    return [unknownInstruction(bundle, operation, options, 'unrepresentable-machine-write', ['registers'], writes)];
  }
  if (src.t === 'imm' && src.value != null && src.float == null) {
    return [legacy(bundle, operation, options, OP.CONST, { ...writes, value: src.value, srcs: [] })];
  }
  return [legacy(bundle, operation, options, OP.MOV, { ...writes, srcs: [src] })];
}

function normalizeOpcode(opcode) {
  return String(opcode || '').trim().toLowerCase().replaceAll('_', '-');
}

function opcodeHead(opcode) {
  return opcode.split(/[.:/]/, 1)[0];
}

function lowerValue(bundle, operation, options) {
  const opcode = normalizeOpcode(operation.opcode);
  const head = opcodeHead(opcode);
  const writes = writeFields(operation.outputs || []);
  const srcs = (operation.inputs || []).map(sourceOf);
  if (!writes.dstReg || srcs.some((src) => !src)) {
    return [unknownInstruction(bundle, operation, options, `unrepresentable-value-op:${opcode}`, ['registers', 'flags'], writes)];
  }

  if (COPY_OPS.has(head)) {
    if (srcs[0]?.t === 'imm' && srcs[0].value != null && srcs[0].float == null) {
      return [legacy(bundle, operation, options, OP.CONST, { ...writes, value: srcs[0].value, srcs: [] })];
    }
    return [legacy(bundle, operation, options, OP.MOV, { ...writes, srcs: srcs.slice(0, 1) })];
  }
  if (BIN_OPS[head]) {
    return [legacy(bundle, operation, options, OP.BIN, { ...writes, sub: BIN_OPS[head], srcs })];
  }
  if (UN_OPS[head]) {
    return [legacy(bundle, operation, options, OP.UN, { ...writes, sub: UN_OPS[head], srcs: srcs.slice(0, 1) })];
  }
  if (COMPARE_OPS.has(head)) {
    const predicate = operation.metadata?.predicate ?? opcode.split(/[.:/]/)[1] ?? null;
    const sub = operation.metadata?.sub ?? (head === 'test' ? 'and' : head === 'fcmp' ? 'fsub' : 'sub');
    return [legacy(bundle, operation, options, OP.CMP, {
      ...writes,
      sub,
      bits: Math.max(...(operation.inputs || []).map(valueWidth), 1),
      comparison: predicate,
      signed: operation.metadata?.signed ?? null,
      float: head === 'fcmp' || operation.metadata?.float === true,
      srcs,
    })];
  }
  if (SELECT_OPS.has(head)) {
    return [legacy(bundle, operation, options, OP.SEL, {
      ...writes,
      sub: operation.metadata?.sub || 'sel',
      cond: operation.metadata?.conditionCode ?? null,
      srcs,
    })];
  }
  if (MAC_OPS.has(head)) {
    return [legacy(bundle, operation, options, OP.MAC, {
      ...writes,
      sub: head === 'msub' || operation.metadata?.subtract === true ? 'msub' : 'madd',
      widen: operation.metadata?.widen ?? null,
      srcs,
    })];
  }
  if (BFX_OPS.has(head)) {
    return [legacy(bundle, operation, options, OP.BFX, {
      ...writes,
      lsb: operation.metadata?.lsb ?? null,
      width: operation.metadata?.width ?? writes.dstBits,
      signed: operation.metadata?.signed === true,
      toward: operation.metadata?.toward ?? 'right',
      srcs,
    })];
  }
  if (BFI_OPS.has(head)) {
    return [legacy(bundle, operation, options, OP.BFI, {
      ...writes,
      lsb: operation.metadata?.lsb ?? null,
      width: operation.metadata?.width ?? null,
      bitfieldKind: operation.metadata?.bitfieldKind ?? 'bfi',
      srcs,
    })];
  }
  if (ADDRESS_OPS.has(head)) {
    const direct = directTargetOf(operation.inputs?.[0]);
    if (direct != null) {
      return [legacy(bundle, operation, options, OP.ADDR, { ...writes, sub: head, value: direct, srcs: [] })];
    }
    return [legacy(bundle, operation, options, OP.MOV, { ...writes, srcs: srcs.slice(0, 1), addressSemantic: true })];
  }

  return [unknownInstruction(bundle, operation, options, `unsupported-value-op:${opcode}`, ['registers', 'flags'], writes)];
}

function addressPart(value) {
  const src = sourceOf(value);
  return src?.t === 'reg' ? src : null;
}

function lowerAddressExpr(addressExpr, access) {
  const base = {
    base: null,
    disp: null,
    index: null,
    scale: 0,
    extend: null,
    mode: 'offset',
    stack: false,
    size: Math.ceil(access.widthBits / 8),
    widthBits: access.widthBits,
    rawAddressExpr: addressExpr,
  };
  if (!addressExpr || typeof addressExpr !== 'object') return base;

  if (addressExpr.kind === 'register' || addressExpr.kind === 'temporary' || addressExpr.kind === 'flag') {
    const src = addressPart(addressExpr);
    if (src) return { ...base, base: src.reg, disp: 0n };
  }
  if (addressExpr.kind === 'bitvector') {
    const absolute = safeBigInt(addressExpr.value);
    if (absolute != null) return { ...base, absolute, disp: absolute };
  }

  const baseValue = addressExpr.base ?? addressExpr.baseValue ?? null;
  const indexValue = addressExpr.index ?? addressExpr.indexValue ?? null;
  const baseSrc = addressPart(baseValue);
  const indexSrc = addressPart(indexValue);
  const disp = safeBigInt(addressExpr.disp ?? addressExpr.displacement ?? addressExpr.offset);
  if (baseSrc || indexSrc || disp != null) {
    return {
      ...base,
      base: baseSrc?.reg || null,
      disp,
      index: indexSrc?.reg || null,
      scale: Number(addressExpr.scale || 0) || 0,
      extend: addressExpr.extend ?? null,
      mode: addressExpr.mode ?? 'offset',
      stack: addressExpr.stack === true,
    };
  }
  return base;
}

function lowerMemoryRead(bundle, operation, options) {
  const writes = writeFields([operation.value]);
  const addr = lowerAddressExpr(operation.access.addressExpr, operation.access);
  if (!writes.dstReg) {
    return [unknownInstruction(bundle, operation, options, 'unrepresentable-memory-read-result', ['registers', 'memory'], writes)];
  }
  return [legacy(bundle, operation, options, OP.LOAD, {
    ...writes,
    addr,
    size: Math.ceil(operation.access.widthBits / 8),
    widthBits: operation.access.widthBits,
    signed: operation.metadata?.signed === true,
    srcs: [],
    memoryAccess: operation.access,
  })];
}

function lowerMemoryWrite(bundle, operation, options) {
  const src = sourceOf(operation.value);
  const addr = lowerAddressExpr(operation.access.addressExpr, operation.access);
  if (!src) {
    return [unknownInstruction(bundle, operation, options, 'unrepresentable-memory-write-value', ['memory'], {})];
  }
  return [legacy(bundle, operation, options, OP.STORE, {
    addr,
    size: Math.ceil(operation.access.widthBits / 8),
    widthBits: operation.access.widthBits,
    srcs: [src],
    memoryAccess: operation.access,
  })];
}

function lowerIntrinsic(bundle, operation, options) {
  const summary = operation.effectSummary;
  const srcs = [];
  for (const value of summary.inputs) {
    const src = sourceOf(value);
    if (src) srcs.push(src);
  }
  for (const register of summary.registersRead) srcs.push({ t: 'reg', reg: register, bits: 64 });

  const outputWrites = writeFields(summary.outputs || []);
  const clobbers = unique(summary.registersWritten || []);
  const extraWrites = unique([...(outputWrites.dstReg ? [outputWrites.dstReg] : []), ...outputWrites.extraWrites]);
  const out = [legacy(bundle, operation, options, OP.CLOBBER, {
    intrinsicId: operation.intrinsicId,
    intrinsicSummary: summary,
    srcs,
    clobbers,
    extraWrites,
    writeWidths: outputWrites.writeWidths,
  })];

  if (summary.memoryWrite.scope !== 'none') {
    out.push(unknownInstruction(bundle, operation, options,
      `intrinsic-memory-write:${operation.intrinsicId}`, ['memory'], {}));
  }
  if (summary.controlEffects.some((effect) => effect.kind !== 'fallthrough')) {
    out.push(unknownInstruction(bundle, operation, options,
      `intrinsic-control-effect:${operation.intrinsicId}`, ['control'], {}));
  }
  return out;
}

function lowerOperation(bundle, operation, options) {
  switch (operation.kind) {
    case 'register-read': return lowerRegisterLikeRead(bundle, operation, options, operation.register, operation.value);
    case 'register-write': return lowerRegisterLikeWrite(bundle, operation, options, operation.register, operation.value);
    case 'flag-read': return lowerRegisterLikeRead(bundle, operation, options, operation.flag, operation.value);
    case 'flag-write': return lowerRegisterLikeWrite(bundle, operation, options, operation.flag, operation.value);
    case 'value': return lowerValue(bundle, operation, options);
    case 'memory-read': return lowerMemoryRead(bundle, operation, options);
    case 'memory-write': return lowerMemoryWrite(bundle, operation, options);
    case 'intrinsic': return lowerIntrinsic(bundle, operation, options);
    case 'barrier':
      return [unknownInstruction(bundle, operation, options, 'memory-ordering-barrier-not-representable-in-v1', ['memory'], {})];
    case 'unknown':
      return [unknownInstruction(bundle, operation, options, operation.reason, operation.categories, {})];
    default:
      return [unknownInstruction(bundle, operation, options, `unsupported-machine-operation:${operation.kind}`, ['other'], {})];
  }
}

function controlSource(value) {
  const src = sourceOf(value);
  if (src) return src;
  if (value && typeof value === 'object') {
    const nested = value.value ?? value.input ?? value.source;
    return sourceOf(nested);
  }
  return null;
}

function lowerControl(bundle, options, unknownControlAlreadyRepresented) {
  const effect = bundle.controlEffect;
  const base = baseFields(bundle, null, options);
  const target = directTargetOf(effect.target);
  const targetSrc = controlSource(effect.target);

  switch (effect.kind) {
    case 'fallthrough':
      return [];
    case 'call':
      return [{ ...base, op: OP.CALL, target, indirect: target == null, srcs: target == null && targetSrc ? [targetSrc] : [],
        callArguments: null, stackArguments: null, stackArgsUnknown: true, stackArgsMayContainPointers: true,
        argumentEvidence: 'not-classified-by-machine-effects-compat', clobbers: unique(options.callClobbers || []),
        architectureControlEffect: effect }];
    case 'return':
      return [{ ...base, op: OP.RET, srcs: [], returnReg: null, returnEvidence: null, architectureReturnTarget: effect.target ?? null,
        architectureControlEffect: effect }];
    case 'branch':
    case 'indirect':
      return [{ ...base, op: OP.BR, target, indirect: effect.kind === 'indirect' || target == null,
        srcs: target == null && targetSrc ? [targetSrc] : [], architectureControlEffect: effect }];
    case 'conditional-branch': {
      const cond = effect.condition;
      const condSrc = controlSource(cond);
      const conditionCode = cond && typeof cond === 'object' ? (cond.conditionCode ?? cond.cond ?? cond.code ?? null) : null;
      return [{ ...base, op: OP.CBR, kind: conditionCode ? 'cond' : 'cbnz', cond: conditionCode,
        target, srcs: condSrc ? [condSrc] : [], fallthrough: effect.fallthrough ?? null,
        rawCondition: cond ?? null, architectureControlEffect: effect }];
    }
    case 'trap':
      return [unknownInstruction(bundle, null, options, effect.reason || 'trap-not-representable-in-v1', ['control', 'faults'], {})];
    case 'unknown':
      return unknownControlAlreadyRepresented ? []
        : [unknownInstruction(bundle, null, options, effect.reason || 'unknown-control-effect', ['control'], {})];
    default:
      return [unknownInstruction(bundle, null, options, `unsupported-control-effect:${effect.kind}`, ['control'], {})];
  }
}

/**
 * Deterministically lower one canonical MachineEffectBundle into the raw
 * instruction vocabulary consumed by the current legacy ARM64 Semantic IR v1.
 *
 * This is a compatibility projection, not the Phase 2 production cutover.
 * ABI argument/return classification is deliberately absent. Call clobbers may
 * only be supplied by an external ABI layer through options.callClobbers.
 */
export function lowerMachineEffectsToLegacyV1(input, options = {}) {
  const bundle = validateMachineEffectBundle(input, options.validationOptions || {});
  if (!ARM64_ARCHITECTURES.has(String(bundle.architectureId).toLowerCase())) {
    throw new TypeError('machine-effects-v1-compat-unsupported-architecture');
  }

  const out = [];
  for (const operation of bundle.operations) out.push(...lowerOperation(bundle, operation, options));

  let unknownControlAlreadyRepresented = false;
  if (bundle.unknownEffects) {
    out.push(unknownInstruction(bundle, null, options, bundle.unknownEffects.reason, bundle.unknownEffects.categories, {}));
    unknownControlAlreadyRepresented = bundle.unknownEffects.categories.includes('control');
  }

  if (bundle.possibleFaults.length) {
    out.push(unknownInstruction(bundle, null, options, 'possible-faults-not-representable-in-v1', ['faults'], {}));
  }

  out.push(...lowerControl(bundle, options, unknownControlAlreadyRepresented));
  return out;
}

export const MACHINE_EFFECTS_V1_COMPAT = Object.freeze({
  temporaryRegisterPrefix: TEMP_PREFIX,
  flagRegisterPrefix: FLAG_PREFIX,
  supportedArchitectures: Object.freeze([...ARM64_ARCHITECTURES].sort()),
});
