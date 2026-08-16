import { assemble as assembleArm64 } from '../../patch.js';
import { extendArm64WithArm64eEffects } from './arm64e/effects.js';
import { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, liftArm64MachineEffects } from './arm64/effects/index.js';
import { ArchitecturePluginV2, registerArchitecturePlugin, architecturePluginV2, architecturePluginsV2 } from './registry.js';

function arm64ControlFlow(instruction) {
  const op = String(instruction?.mnemonic || '').toLowerCase();
  if (/^ret(?:aa|ab)?$/.test(op)) return 'return';
  if (/^(?:bl|blr|blraa|blrab|blraaz|blrabz)$/.test(op)) return 'call';
  if (/^(?:b|br|braa|brab|braaz|brabz)$/.test(op)) return 'branch';
  if (op.startsWith('b.') || op === 'cbz' || op === 'cbnz' || op === 'tbz' || op === 'tbnz') return 'conditional-branch';
  return 'fallthrough';
}

function x86ControlFlow(instruction) {
  const op = String(instruction?.mnemonic || '').toLowerCase();
  if (op.startsWith('ret')) return 'return';
  if (op === 'call') return 'call';
  if (op === 'jmp') return 'branch';
  if (/^j[^m]/.test(op)) return 'conditional-branch';
  return 'fallthrough';
}

const ARM64_REGISTERS = Object.freeze([
  ...Array.from({length:31}, (_x,i) => Object.freeze({ id:`x${i}`, bits:64, kind:'gp' })),
  Object.freeze({ id:'sp', bits:64, kind:'stack-pointer' }),
  Object.freeze({ id:'nzcv', bits:4, kind:'flags' }),
  ...Array.from({length:32}, (_x,i) => Object.freeze({ id:`v${i}`, bits:128, kind:'vector' })),
]);

const X86_64_REGISTERS = Object.freeze([
  ...['rax','rbx','rcx','rdx','rsi','rdi','rbp','rsp','r8','r9','r10','r11','r12','r13','r14','r15','rip'].map((id) => Object.freeze({ id, bits:64, kind:id === 'rsp' ? 'stack-pointer' : id === 'rip' ? 'program-counter' : 'gp' })),
  Object.freeze({ id:'rflags', bits:64, kind:'flags' }),
  ...Array.from({length:16}, (_x,i) => Object.freeze({ id:`xmm${i}`, bits:128, kind:'vector' })),
]);

const liftArm64eMachineEffects = extendArm64WithArm64eEffects(liftArm64MachineEffects);

export const ARM64_ARCHITECTURE = registerArchitecturePlugin({
  id:'arm64', semanticVersion:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:4, fixedInstructionSize:4, viewerCompatible:true,
  modes:()=>Object.freeze(['a64']), registerFile:()=>ARM64_REGISTERS,
  decodeProvider:'capstone/backend', liftExact:liftArm64MachineEffects, assemble:assembleArm64, classifyControlFlow:arm64ControlFlow,
  // Phase 2 exposes exact low-level effects where implemented. Coverage is not
  // complete yet, so the proven legacy v1 path remains active and MachineEffects
  // stays a shadow semantic source until the compatibility differential is zero.
  capabilities:{ decode:'external', exactEffects:'partial', semanticAnalysis:'legacy-v1' },
});

export const ARM64E_ARCHITECTURE = registerArchitecturePlugin({
  id:'arm64e', semanticVersion:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:4, fixedInstructionSize:4, viewerCompatible:true,
  modes:()=>Object.freeze(['a64','arm64e']), registerFile:()=>ARM64_REGISTERS,
  decodeProvider:'capstone/backend', liftExact:liftArm64eMachineEffects, assemble:assembleArm64, classifyControlFlow:arm64ControlFlow,
  capabilities:{ decode:'external', exactEffects:'partial', semanticAnalysis:'legacy-v1-partial' },
});

export const X86_64_ARCHITECTURE = registerArchitecturePlugin({
  id:'x86_64', semanticVersion:'1', instructionAlignment:1, fixedInstructionSize:null, viewerCompatible:false,
  modes:()=>Object.freeze(['long-64']), registerFile:()=>X86_64_REGISTERS,
  decodeProvider:'capstone/backend', classifyControlFlow:x86ControlFlow,
  // Decode availability is intentionally not semantic-analysis availability.
  capabilities:{ decode:'external', exactEffects:'unsupported', semanticAnalysis:'unsupported' },
});

export const UNKNOWN_ARCHITECTURE = registerArchitecturePlugin({
  id:'unknown', semanticVersion:'1', instructionAlignment:1, fixedInstructionSize:null, viewerCompatible:false,
  capabilities:{ decode:'unsupported', exactEffects:'unsupported', semanticAnalysis:'unsupported' },
});

export { ArchitecturePluginV2, registerArchitecturePlugin, architecturePluginV2, architecturePluginsV2 };
