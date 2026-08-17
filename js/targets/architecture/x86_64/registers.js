import './registers-core.js';

const api = globalThis.HexX86Registers;
if (!api) throw new Error('x86-physical-state-contract-unavailable');

export const X86_PHYSICAL_STATE_CONTRACT_VERSION = api.contractVersion;
export const X86_MODELED_FLAGS = api.modeledFlags;
export const X86_REGISTER_DESCRIPTORS = api.descriptors;
export const X86_PHYSICAL_REGISTERS = api.physicalRegisters;
export const normalizeX86RegisterName = api.normalizeName;
export const x86RegisterDescriptor = api.registerDescriptor;
export const x86RegisterFile = api.registerFile;
