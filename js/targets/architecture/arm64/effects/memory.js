import {
  createBitVectorValue,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
} from '../../../../semantics/effects/index.js';
import {
  Arm64AddressingError,
  arm64AddressOffset,
  arm64ConstantExpr,
  arm64RegisterOperand,
  arm64Temporary,
  buildArm64EffectiveAddress,
  createArm64RegisterRead,
  createArm64RegisterWrite,
} from './addressing.js';
import { isArm64AtomicInstruction, liftArm64AtomicEffects } from './atomic.js';

export const LEGACY_ARM64_MEMORY_INVENTORY = Object.freeze({
  loads: Object.freeze(['ldr','ldrb','ldrh','ldrsb','ldrsh','ldrsw','ldur','ldurb','ldurh','ldursb','ldursh','ldursw','ldp','ldpsw','ldnp','ldar','ldarb','ldarh','ldxr','ldaxr','ldtr']),
  stores: Object.freeze(['str','strb','strh','stur','sturb','sturh','stp','stnp','stlr','stlrb','stlrh','sttr','stxr','stlxr']),
  atomicHandlers: Object.freeze(['cas','casa','casl','casal','swp','swpa','swpl','swpal','ldadd','ldadda','ldaddl','ldaddal','ldset','ldclr','ldeor']),
  barriersAndHints: Object.freeze(['dmb','dsb','isb','clrex','prfm']),
  simdMemoryDeferred: Object.freeze(['ld1','ld2','ld3','ld4','st1','st2','st3','st4']),
});

const SIMPLE_LOADS = new Set(['ldr','ldrb','ldrh','ldrsb','ldrsh','ldrsw','ldur','ldurb','ldurh','ldursb','ldursh','ldursw','ldtr','ldar','ldarb','ldarh']);
const SIMPLE_STORES = new Set(['str','strb','strh','stur','sturb','sturh','sttr','stlr','stlrb','stlrh']);
const PAIR_LOADS = new Set(['ldp','ldnp','ldpsw']);
const PAIR_STORES = new Set(['stp','stnp']);
const ALL_NON_ATOMIC = new Set([...SIMPLE_LOADS, ...SIMPLE_STORES, ...PAIR_LOADS, ...PAIR_STORES, 'prfm']);
const SIGNED_LOADS = new Set(['ldrsb','ldrsh','ldrsw','ldursb','ldursh','ldursw','ldpsw']);
const ACQUIRE_LOADS = new Set(['ldar','ldarb','ldarh']);
const RELEASE_STORES = new Set(['stlr','stlrb','stlrh']);
const BASE_ONLY = new Set([...ACQUIRE_LOADS, ...RELEASE_STORES]);
const UNSCALED_ONLY = /^(?:ldur|stur|ldtr|sttr)/;
const NON_TEMPORAL_PAIR = new Set(['ldnp','stnp']);
const UNPRIVILEGED = new Set(['ldtr','sttr']);

const WIDTH_OVERRIDE = Object.freeze({
  ldrb:8, ldrsb:8, ldurb:8, ldursb:8, ldarb:8,
  strb:8, sturb:8, stlrb:8,
  ldrh:16, ldrsh:16, ldurh:16, ldursh:16, ldarh:16,
  strh:16, sturh:16, stlrh:16,
  ldrsw:32, ldursw:32, ldpsw:32,
});

function mnemonicOf(decoded) { return String(decoded?.mnemonic || '').trim().toLowerCase(); }
function contextOf(decoded, context = {}) {
  const instructionId = String(context.instructionId || decoded?.instructionId || '').trim();
  if (!instructionId) throw new TypeError('arm64-machine-effects-instruction-id-required');
  return {
    instructionId,
    architectureId: String(context.architectureId || decoded?.architectureId || 'arm64'),
    mode: String(context.mode || decoded?.mode || 'a64'),
    endian: String(context.endian || decoded?.endian || 'little'),
    origin: context.origin || decoded?.origin || { instructionIds:[instructionId] },
    options: context.options || {},
  };
}

function bundle(decoded, context, body) {
  const ctx = contextOf(decoded, context);
  return createMachineEffectBundle({
    instructionId:ctx.instructionId,
    architectureId:ctx.architectureId,
    mode:ctx.mode,
    operations:body.operations || [],
    controlEffect:body.controlEffect || { kind:'fallthrough' },
    possibleFaults:body.possibleFaults || [],
    origin:ctx.origin,
    completeness:body.completeness || 'exact',
    ...(body.unknownEffects ? { unknownEffects:body.unknownEffects } : {}),
    ...(body.metadata ? { metadata:body.metadata } : {}),
  }, ctx.options);
}

function partial(decoded, context, reason, categories = ['memory','registers','faults']) {
  return bundle(decoded, context, {
    completeness:'partial',
    operations:[],
    unknownEffects:{ categories, reason },
    metadata:{ family:'arm64-memory', unsupported:true, mnemonic:mnemonicOf(decoded) },
  });
}

function operands(decoded) {
  return Array.isArray(decoded?.ops) ? decoded.ops : Array.isArray(decoded?.operands) ? decoded.operands : [];
}
function dataRegisters(decoded) { return operands(decoded).map((operand) => arm64RegisterOperand(operand)).filter(Boolean); }
function memoryOperand(decoded) { return operands(decoded).find((operand) => operand?.k === 'mem' || operand?.kind === 'memory') || null; }
function immediateOperand(decoded) { return operands(decoded).find((operand, index) => index > 0 && (operand?.k === 'imm' || operand?.kind === 'immediate')) || null; }
function immediateValue(operand) {
  const value = operand?.value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(value)) return BigInt(value);
  return null;
}

function memoryWidthBits(mnemonic, reg) {
  if (WIDTH_OVERRIDE[mnemonic]) return WIDTH_OVERRIDE[mnemonic];
  if (!reg) return null;
  return Number(reg.bits || 0) || null;
}
function accessAlignment(mnemonic, widthBits) {
  if (ACQUIRE_LOADS.has(mnemonic) || RELEASE_STORES.has(mnemonic)) return Math.max(1, widthBits / 8);
  return undefined;
}
function accessFor({ ctx, addressExpr, widthBits, atomic = null, ordering = null, alignment = null, volatility = null }) {
  const input = { space:'memory', addressExpr, widthBits, endian:ctx.endian };
  if (alignment) input.alignment = alignment;
  if (typeof atomic === 'boolean') input.atomic = atomic;
  if (ordering) input.ordering = ordering;
  if (typeof volatility === 'boolean') input.volatility = volatility;
  return createMemoryAccess(input, ctx.options);
}

function isTagChecked(addressing) {
  return addressing?.base?.kind !== 'sp' || addressing?.mode !== 'offset';
}
function possibleFaults(direction, { alignment = null, addressExpr = null, accessIndex = 0, tagChecked = false } = {}) {
  const causes = ['address-size','translation','access-flag','permission','external'];
  if (tagChecked) causes.push('tag-check');
  const faults = [{
    kind:'data-abort',
    condition:{ kind:'memory-access-fault', access:direction, accessIndex },
    detail:{ causes, tagChecked, ...(addressExpr ? { addressExpr } : {}) },
  }];
  if (alignment && alignment > 1) {
    faults.push({
      kind:'alignment-fault',
      condition:{ kind:'misaligned', alignment, accessIndex },
      detail:{ access:direction, alignment },
    });
  }
  return faults;
}
function stackPointerAlignmentFault(addressing, accessIndex = 0) {
  if (addressing?.base?.kind !== 'sp') return [];
  return [{
    kind:'stack-pointer-alignment-fault',
    condition:{ kind:'sp-misaligned', alignment:16, accessIndex },
    detail:{ baseRegister:'sp', architecturalCheck:'CheckSPAlignment' },
  }];
}

function zeroConstant(widthBits) { return createBitVectorValue(widthBits, 0n); }
function valueOp(opcode, input, fromBits, toBits, id, metadata = {}) {
  const output = arm64Temporary(id, toBits);
  return {
    output,
    operation:createMachineOperation({
      kind:'value', opcode, inputs:[input], outputs:[output],
      metadata:{ architecture:'arm64', fromBits, toBits, ...metadata },
    }),
  };
}

function loadedValueToRegister(regInput, rawValue, memoryBits, { signed = false, idPrefix = 'load' } = {}) {
  const reg = arm64RegisterOperand(regInput);
  if (!reg) throw new TypeError('arm64-load-destination-register-required');
  if (reg.zero) return { operations:[], discarded:true };
  if (reg.kind === 'sp') throw new TypeError('arm64-load-to-sp-unsupported');

  const operations = [];
  let value = rawValue;
  const viewBits = Number(reg.bits);
  if (memoryBits > viewBits) throw new TypeError('arm64-load-width-exceeds-destination-view');
  if (memoryBits < viewBits) {
    const ext = valueOp(signed ? 'sign-extend' : 'zero-extend', value, memoryBits, viewBits, `${idPrefix}.view`, { signed });
    operations.push(ext.operation);
    value = ext.output;
  }

  if (reg.kind === 'gp') {
    if (![32,64].includes(viewBits)) throw new TypeError('arm64-invalid-gp-load-width');
    if (viewBits === 32) {
      const ext = valueOp('zero-extend', value, 32, 64, `${idPrefix}.physical`, { writePolicy:'zero-upper-32' });
      operations.push(ext.operation);
      value = ext.output;
    }
    operations.push(createArm64RegisterWrite(reg, value, {
      physicalWidth:64,
      metadata:{ purpose:'memory-load', writePolicy:viewBits === 32 ? 'zero-upper-32' : 'full-width' },
    }));
    return { operations, discarded:false };
  }

  if (reg.kind === 'vector') {
    if (viewBits < 128) {
      const ext = valueOp('zero-extend', value, viewBits, 128, `${idPrefix}.physical`, { writePolicy:'zero-upper-vector-bits' });
      operations.push(ext.operation);
      value = ext.output;
    }
    operations.push(createArm64RegisterWrite(reg, value, {
      physicalWidth:128,
      metadata:{ purpose:'memory-load', writePolicy:viewBits < 128 ? 'zero-upper-vector-bits' : 'full-width' },
    }));
    return { operations, discarded:false };
  }
  throw new TypeError('arm64-unsupported-load-register-class');
}

function storeValueFromRegister(regInput, widthBits, idPrefix) {
  const reg = arm64RegisterOperand(regInput);
  if (!reg) throw new TypeError('arm64-store-source-register-required');
  if (reg.zero) return { operations:[], value:zeroConstant(widthBits) };
  if (reg.kind === 'sp') throw new TypeError('arm64-store-from-sp-unsupported');
  if (widthBits > reg.bits) throw new TypeError('arm64-store-width-exceeds-source-view');
  const read = createArm64RegisterRead(reg, `${idPrefix}.source`, reg.bits);
  const operations = [read.operation];
  let value = read.value;
  if (widthBits < reg.bits) {
    const trunc = valueOp('truncate', value, reg.bits, widthBits, `${idPrefix}.truncated`, { purpose:'memory-store-width' });
    operations.push(trunc.operation);
    value = trunc.output;
  }
  return { operations, value };
}

function overlapIsConstrained(addressing, regs) {
  if (addressing.mode === 'offset') return false;
  return regs.some((operand) => {
    const reg = arm64RegisterOperand(operand);
    return reg && !reg.zero && reg.physicalId === addressing.base.physicalId;
  });
}
function zeroDisplacement(addressing) {
  const raw = addressing?.metadata?.addressDisplacement;
  return raw == null || BigInt(raw) === 0n;
}
function validateSimpleAddressing(mnemonic, addressing) {
  if (BASE_ONLY.has(mnemonic)) {
    if (addressing.mode !== 'offset' || addressing.index || !zeroDisplacement(addressing)) return `${mnemonic} requires base-only addressing`;
  }
  if (UNSCALED_ONLY.test(mnemonic)) {
    if (addressing.mode !== 'offset' || addressing.index) return `${mnemonic} requires unscaled immediate offset addressing without writeback`;
  }
  return null;
}

function simpleMemory(decoded, context, mnemonic, isLoad) {
  const ctx = contextOf(decoded, context);
  const reg = dataRegisters(decoded)[0];
  if (!reg) return partial(decoded, context, 'memory instruction data register is missing');
  const widthBits = memoryWidthBits(mnemonic, reg);
  if (![8,16,32,64,128].includes(widthBits)) return partial(decoded, context, 'unsupported memory transfer width');
  if ((mnemonic === 'ldrsw' || mnemonic === 'ldursw') && (reg.kind !== 'gp' || reg.bits !== 64)) return partial(decoded, context, `${mnemonic} requires an X destination register`);

  let addressing;
  try { addressing = buildArm64EffectiveAddress(decoded, { prefix:'addr', accessWidthBits:widthBits }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code);
    throw error;
  }
  const addressError = validateSimpleAddressing(mnemonic, addressing);
  if (addressError) return partial(decoded, context, addressError);
  if (overlapIsConstrained(addressing, [reg])) return partial(decoded, context, 'writeback overlaps data register and is constrained-unpredictable');

  const signed = isLoad && SIGNED_LOADS.has(mnemonic);
  const atomic = BASE_ONLY.has(mnemonic) ? true : null;
  const ordering = ACQUIRE_LOADS.has(mnemonic) ? 'acquire' : RELEASE_STORES.has(mnemonic) ? 'release' : null;
  const alignment = accessAlignment(mnemonic, widthBits);
  const access = accessFor({ ctx, addressExpr:addressing.addressExpr, widthBits, atomic, ordering, alignment });
  const operations = [...addressing.readOperations];
  const faults = [
    ...stackPointerAlignmentFault(addressing, 0),
    ...possibleFaults(isLoad?'read':'write', { alignment, addressExpr:addressing.addressExpr, tagChecked:isTagChecked(addressing) }),
  ];
  const accessMetadata = {
    architecture:'arm64', mnemonic, signed, addressing:addressing.metadata, accessIndex:0,
    ...(UNPRIVILEGED.has(mnemonic) ? { unprivileged:true } : {}),
  };

  if (isLoad) {
    const raw = arm64Temporary('load.raw.0', widthBits);
    operations.push(createMachineOperation({ kind:'memory-read', access, value:raw, metadata:accessMetadata }));
    try {
      const write = loadedValueToRegister(reg, raw, widthBits, { signed, idPrefix:'load.0' });
      operations.push(...write.operations);
    } catch (error) { return partial(decoded, context, error.message || 'unsupported load destination'); }
  } else {
    let source;
    try { source = storeValueFromRegister(reg, widthBits, 'store.0'); }
    catch (error) { return partial(decoded, context, error.message || 'unsupported store source'); }
    operations.push(...source.operations);
    operations.push(createMachineOperation({ kind:'memory-write', access, value:source.value, metadata:accessMetadata }));
  }

  if (addressing.mode !== 'offset') operations.push(...addressing.writebackOperations);
  return bundle(decoded, context, {
    operations,
    possibleFaults:faults,
    metadata:{
      family:'arm64-memory', mnemonic, transfer:'single', widthBits, signed,
      addressing:addressing.metadata,
      ...(atomic === true ? { atomic:true } : {}),
      ...(ordering ? { ordering } : {}),
      ...(UNPRIVILEGED.has(mnemonic) ? { unprivileged:true } : {}),
    },
  });
}

function pairMemory(decoded, context, mnemonic, isLoad) {
  const ctx = contextOf(decoded, context);
  const regs = dataRegisters(decoded).slice(0, 2);
  if (regs.length !== 2) return partial(decoded, context, 'pair memory instruction requires two data registers');
  const widthBits = mnemonic === 'ldpsw' ? 32 : memoryWidthBits(mnemonic, regs[0]);
  const secondWidth = mnemonic === 'ldpsw' ? 32 : memoryWidthBits(mnemonic, regs[1]);
  if (!widthBits || widthBits !== secondWidth || ![32,64,128].includes(widthBits)) return partial(decoded, context, 'unsupported or mismatched pair widths');
  if (mnemonic === 'ldpsw' && regs.some((reg) => reg.kind !== 'gp' || reg.bits !== 64)) return partial(decoded, context, 'ldpsw requires two X destination registers');
  if (isLoad && !regs[0].zero && !regs[1].zero && regs[0].physicalId === regs[1].physicalId) return partial(decoded, context, 'pair load destinations overlap and are constrained-unpredictable');

  let addressing;
  try { addressing = buildArm64EffectiveAddress(decoded, { prefix:'addr', accessWidthBits:widthBits }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code);
    throw error;
  }
  if (addressing.index) return partial(decoded, context, `${mnemonic} does not support register-offset addressing`);
  if (NON_TEMPORAL_PAIR.has(mnemonic) && addressing.mode !== 'offset') return partial(decoded, context, `${mnemonic} does not support writeback addressing`);
  if (overlapIsConstrained(addressing, regs)) return partial(decoded, context, 'pair writeback overlaps data register and is constrained-unpredictable');

  const strideBytes = widthBits / 8;
  const signed = mnemonic === 'ldpsw';
  const nonTemporal = NON_TEMPORAL_PAIR.has(mnemonic);
  const operations = [...addressing.readOperations];
  const faults = [...stackPointerAlignmentFault(addressing, 0)];
  for (let i = 0; i < 2; i++) {
    const addressExpr = arm64AddressOffset(addressing.addressExpr, BigInt(i * strideBytes));
    const access = accessFor({ ctx, addressExpr, widthBits });
    faults.push(...possibleFaults(isLoad?'read':'write', { addressExpr, accessIndex:i, tagChecked:isTagChecked(addressing) }));
    const metadata = {
      architecture:'arm64', mnemonic, pair:true, pairIndex:i, pairStrideBytes:strideBytes,
      accessOrder:i, signed, addressing:addressing.metadata, ...(nonTemporal ? { nonTemporal:true } : {}),
    };
    if (isLoad) {
      const raw = arm64Temporary(`load.raw.${i}`, widthBits);
      operations.push(createMachineOperation({ kind:'memory-read', access, value:raw, metadata }));
      try {
        const write = loadedValueToRegister(regs[i], raw, widthBits, { signed, idPrefix:`load.${i}` });
        operations.push(...write.operations);
      } catch (error) { return partial(decoded, context, error.message || 'unsupported pair load destination'); }
    } else {
      let source;
      try { source = storeValueFromRegister(regs[i], widthBits, `store.${i}`); }
      catch (error) { return partial(decoded, context, error.message || 'unsupported pair store source'); }
      operations.push(...source.operations);
      operations.push(createMachineOperation({ kind:'memory-write', access, value:source.value, metadata }));
    }
  }

  if (addressing.mode !== 'offset') operations.push(...addressing.writebackOperations);
  return bundle(decoded, context, {
    operations,
    possibleFaults:faults,
    metadata:{ family:'arm64-memory', mnemonic, transfer:'pair', elementWidthBits:widthBits, pairStrideBytes:strideBytes, signed, addressing:addressing.metadata, ...(nonTemporal ? { nonTemporal:true } : {}) },
  });
}

function literalLoad(decoded, context, mnemonic) {
  const ctx = contextOf(decoded, context);
  const reg = dataRegisters(decoded)[0];
  if (!reg) return partial(decoded, context, 'literal load destination register is missing');
  const immediate = immediateValue(immediateOperand(decoded));
  let target = decoded?.pcRelTarget ?? decoded?.literalTarget ?? immediate;
  if (typeof target === 'number' && Number.isSafeInteger(target)) target = BigInt(target);
  if (typeof target === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(target)) target = BigInt(target);
  if (typeof target !== 'bigint') return partial(decoded, context, 'literal load target is unresolved');

  const widthBits = memoryWidthBits(mnemonic, reg);
  if (![32,64,128].includes(widthBits)) return partial(decoded, context, 'unsupported literal load width');
  if (mnemonic === 'ldrsw' && (reg.kind !== 'gp' || reg.bits !== 64)) return partial(decoded, context, 'literal ldrsw requires an X destination register');
  const signed = SIGNED_LOADS.has(mnemonic);
  const addressExpr = arm64ConstantExpr(target, 64);
  const access = accessFor({ ctx, addressExpr, widthBits });
  const raw = arm64Temporary('load.literal.raw', widthBits);
  const operations = [createMachineOperation({
    kind:'memory-read', access, value:raw,
    metadata:{ architecture:'arm64', mnemonic, literal:true, signed, target:target.toString(), tagChecked:false },
  })];
  try {
    const write = loadedValueToRegister(reg, raw, widthBits, { signed, idPrefix:'load.literal' });
    operations.push(...write.operations);
  } catch (error) { return partial(decoded, context, error.message || 'unsupported literal load destination'); }
  return bundle(decoded, context, {
    operations,
    possibleFaults:possibleFaults('read', { addressExpr, tagChecked:false }),
    metadata:{ family:'arm64-memory', mnemonic, transfer:'literal', widthBits, signed, target:target.toString() },
  });
}

function prefetch(decoded, context) {
  let addressing;
  try { addressing = buildArm64EffectiveAddress(decoded, { prefix:'prefetch.addr' }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code, ['memory','other']);
    throw error;
  }
  if (addressing.mode !== 'offset') return partial(decoded, context, 'prfm does not support writeback addressing', ['memory','other']);
  return bundle(decoded, context, {
    operations:[...addressing.readOperations],
    completeness:'partial',
    unknownEffects:{ categories:['memory','other'], reason:'PRFM is an implementation-defined memory-system hint without an exact accessed width' },
    metadata:{ family:'arm64-memory', mnemonic:'prfm', addressing:addressing.metadata, hint:true },
  });
}

export function isArm64MemoryInstruction(decodedOrMnemonic) {
  const mnemonic = typeof decodedOrMnemonic === 'string' ? decodedOrMnemonic.toLowerCase() : mnemonicOf(decodedOrMnemonic);
  return ALL_NON_ATOMIC.has(mnemonic) || isArm64AtomicInstruction(mnemonic);
}

export function liftArm64MemoryEffects(decoded, context = {}) {
  const mnemonic = mnemonicOf(decoded);
  if (isArm64AtomicInstruction(mnemonic)) return liftArm64AtomicEffects(decoded, context);
  if (!ALL_NON_ATOMIC.has(mnemonic)) return null;
  if (mnemonic === 'prfm') return prefetch(decoded, context);

  const hasMem = !!memoryOperand(decoded);
  if (!hasMem && (mnemonic === 'ldr' || mnemonic === 'ldrsw')) return literalLoad(decoded, context, mnemonic);
  if (!hasMem) return partial(decoded, context, 'recognized memory instruction has no supported memory operand');
  if (SIMPLE_LOADS.has(mnemonic)) return simpleMemory(decoded, context, mnemonic, true);
  if (SIMPLE_STORES.has(mnemonic)) return simpleMemory(decoded, context, mnemonic, false);
  if (PAIR_LOADS.has(mnemonic)) return pairMemory(decoded, context, mnemonic, true);
  if (PAIR_STORES.has(mnemonic)) return pairMemory(decoded, context, mnemonic, false);
  return partial(decoded, context, 'recognized memory instruction family is not fully modeled');
}

export const liftMemoryEffects = liftArm64MemoryEffects;
