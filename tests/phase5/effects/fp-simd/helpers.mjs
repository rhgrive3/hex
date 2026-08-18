import { liftX86MachineEffects } from '../../../../js/targets/architecture/x86_64/effects/index.js';

let code = 1000;
let sequence = 0;

export function reg(name, access = 'unknown') { return { type:'register', register:name, access }; }
export function imm(value, widthBits = 8) { return { type:'immediate', value:BigInt(value), widthBits, encodedWidthBits:widthBits, access:'read' }; }
export function mem(widthBits, { base='rax', index=null, scale=1, displacement=0n, segment=null, addressSizeBits=64, access='read' } = {}) {
  return { type:'memory', widthBits, access, memory:{ base, index, scale, displacement:BigInt(displacement), segment, addressSizeBits } };
}
export function legacy() { return { legacy:[], rex:null, vector:null }; }
export function legacyPrefix(...bytes) { return { legacy:bytes, rex:null, vector:null }; }
export function vex2(byte2 = 0xf8) { return { legacy:[], rex:null, vector:{ kind:'vex2', bytes:[0xc5,byte2] } }; }
export function evex() { return { legacy:[], rex:null, vector:{ kind:'evex', bytes:[0x62,0xf1,0x7c,0x08] } }; }

export function instruction(family, operands = [], options = {}) {
  sequence += 1;
  const rawBytes = Uint8Array.from(options.rawBytes ?? [0x90]);
  const instructionId = options.instructionId ?? `p5-3:test:${family}:${sequence}`;
  return {
    address:BigInt(options.address ?? 0x401000), length:rawBytes.length, rawBytes, mode:'long-64',
    instructionCode:code++, instructionFamily:family, instructionId,
    detailAvailable:true, detailStatus:'complete',
    mnemonic:options.mnemonic ?? 'misleading-display-text',
    opStr:options.opStr ?? 'zmm31, [misleading display string]',
    detail:{ operandCount:operands.length, operands, prefixes:options.prefixes ?? legacy(), implicitReads:options.implicitReads ?? [], implicitWrites:options.implicitWrites ?? [], conditionCode:null },
  };
}

export function effects(family, operands = [], options = {}) {
  const input = instruction(family, operands, options);
  return liftX86MachineEffects(input, { instructionId:input.instructionId });
}
export function ops(bundle, kind) { return bundle.operations.filter((operation) => operation.kind === kind); }
export function physicalWrites(bundle, id) { return ops(bundle, 'register-write').filter((operation) => operation.register.registerId === id); }
export function physicalReads(bundle, id) { return ops(bundle, 'register-read').filter((operation) => operation.register.registerId === id); }
export function intrinsics(bundle, id = null) { return ops(bundle, 'intrinsic').filter((operation) => id == null || operation.intrinsicId === id); }
