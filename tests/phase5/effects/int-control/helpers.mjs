import { liftX86MachineEffects } from '../../../../js/targets/architecture/x86_64/effects/index.js';

let sequence = 0;

export function reg(name, access = 'unknown') { return { type:'register', register:name, access }; }
export function imm(value, widthBits = null) {
  return { type:'immediate', value:BigInt(value), access:'read', ...(widthBits == null ? {} : { widthBits }) };
}
export function mem(widthBits = 64, options = {}) {
  return {
    type:'memory', widthBits, access:options.access ?? 'read',
    memory:{
      base:options.base ?? 'rax',
      index:options.index ?? null,
      scale:options.scale ?? 1,
      displacement:BigInt(options.displacement ?? 0),
      segment:options.segment ?? null,
      addressSizeBits:options.addressSizeBits ?? 64,
    },
  };
}

export function instruction(family, operands = [], options = {}) {
  const length = options.length ?? 1;
  const instructionId = options.instructionId ?? `p5-1:${family}:${++sequence}`;
  return {
    instructionId,
    instructionCode:options.instructionCode ?? 1,
    instructionFamily:family,
    address:BigInt(options.address ?? 0x1000n),
    length,
    rawBytes:options.rawBytes ?? new Uint8Array(length),
    mode:'long-64',
    detailAvailable:options.detailAvailable ?? true,
    detailStatus:options.detailAvailable === false ? 'unavailable' : 'complete',
    mnemonic:options.mnemonic ?? 'misleading-formatted-text',
    opStr:options.opStr ?? 'intentionally not semantic input',
    detail:{
      operandCount:operands.length,
      operands,
      implicitReads:options.implicitReads ?? [],
      implicitWrites:options.implicitWrites ?? [],
      conditionCode:options.conditionCode ?? null,
    },
  };
}

export function lift(family, operands = [], options = {}) {
  return liftX86MachineEffects(instruction(family, operands, options));
}

export function operations(bundle, kind) { return bundle.operations.filter((operation) => operation.kind === kind); }
export function flagWrites(bundle, flag = null) {
  return operations(bundle, 'flag-write').filter((operation) => flag == null || operation.flag.flagId === `RFLAGS.${flag}`);
}
export function flagReads(bundle, flag = null) {
  return operations(bundle, 'flag-read').filter((operation) => flag == null || operation.flag.flagId === `RFLAGS.${flag}`);
}
export function registerWrites(bundle, physical = null) {
  return operations(bundle, 'register-write').filter((operation) => physical == null || operation.register.registerId === physical);
}
export function registerReads(bundle, physical = null) {
  return operations(bundle, 'register-read').filter((operation) => physical == null || operation.register.registerId === physical);
}
export function intrinsics(bundle, prefix = null) {
  return operations(bundle, 'intrinsic').filter((operation) => prefix == null || operation.intrinsicId.startsWith(prefix));
}
