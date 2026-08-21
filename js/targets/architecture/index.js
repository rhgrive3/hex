import { assemble as assembleArm64 } from '../../patch.js';
import { extendArm64WithArm64eEffects } from './arm64e/effects.js';
import { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, liftArm64MachineEffects } from './arm64/effects/index.js';
import { decorateArm64BtypeEffects } from './arm64/effects/btype.js';
import { X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION, liftX86MachineEffects } from './x86_64/effects/index.js';
import { x86RegisterFile } from './x86_64/registers.js';
import { RISCV64_INSTRUCTION_ALIGNMENT, RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION, liftRiscv64MachineEffects } from './riscv64/effects/index.js';
import { riscv64RegisterFile } from './riscv64/registers.js';
import { ArchitecturePluginV2, registerArchitecturePlugin, architecturePluginV2, architecturePluginsV2, canonicalArchitectureId, normalizeArchitecturePositiveInteger } from './registry.js';

function arm64ControlFlow(instruction) {
  const op = String(instruction?.mnemonic || '').toLowerCase();
  if (/^ret(?:aa|ab)?$/.test(op)) return 'return';
  if (/^(?:bl|blr|blraa|blrab|blraaz|blrabz)$/.test(op)) return 'call';
  if (/^(?:b|br|braa|brab|braaz|brabz)$/.test(op)) return 'branch';
  if (op.startsWith('b.') || op === 'cbz' || op === 'cbnz' || op === 'tbz' || op === 'tbnz') return 'conditional-branch';
  if (/^(?:eret|eretaa|eretab|brk|svc|hvc|smc)$/.test(op)) return 'unknown';
  return 'fallthrough';
}

function x86ControlFlow(instruction) {
  const op = String(instruction?.instructionFamily || instruction?.mnemonic || '').toLowerCase();
  if (op.startsWith('ret')) return 'return';
  if (op === 'call') return 'call';
  if (op === 'jmp') return 'branch';
  if (/^(?:loop|loope|loopz|loopne|loopnz)$/.test(op)) return 'conditional-branch';
  if (op === 'ud2' || op === 'int3') return 'unknown';
  if (/^j[^m]/.test(op)) return 'conditional-branch';
  return 'fallthrough';
}

/**
 * RV64 control-flow classification.
 *
 * Derived from the decoded instruction word, never from the printed mnemonic:
 * the Capstone RISC-V printer collapses `jal rd, off` and `jal x0, off` to the
 * same display form, so mnemonics cannot distinguish a call from a jump.
 *
 * rd == x0 means no link value is produced, which is the architectural
 * difference between a call and a plain jump. For `jalr` with rd == x0, the
 * ISA's return-address-stack prediction table treats rs1 in {x1, x5} as a
 * return; that hint lives in the unprivileged ISA, not in the psABI.
 */
function riscv64ControlFlow(instruction) {
  const fields = instruction?.fields;
  if (!fields?.supported) return 'unknown';
  const op = fields.op;
  if (op === 'jal') return fields.rd === 'x0' ? 'branch' : ['x1', 'x5'].includes(fields.rd) ? 'call' : 'branch';
  if (op === 'jalr') {
    if (['x1', 'x5'].includes(fields.rd)) return 'call';
    if (fields.rd !== 'x0') return 'branch';
    if (['x1', 'x5'].includes(fields.rs1)) return 'return';
    // An indirect jump. It is reported as a branch, matching how x86 classifies
    // an indirect `jmp`: the block ends and no fallthrough edge is invented,
    // because the transfer does not fall through. The honest "the target is a
    // computed value" statement lives in the MachineEffects control effect,
    // which records kind `indirect` with the computed target expression.
    return 'branch';
  }
  if (['beq','bne','blt','bge','bltu','bgeu'].includes(op)) return 'conditional-branch';
  if (op === 'ecall' || op === 'ebreak') return 'unknown';
  return 'fallthrough';
}

/** Decode-time constant target of a direct RV64 transfer, else null. */
function riscv64DirectControlTarget(instruction) {
  const fields = instruction?.fields;
  if (!fields?.supported || fields.imm == null) return null;
  if (!['jal','beq','bne','blt','bge','bltu','bgeu'].includes(fields.op)) return null;
  try { return BigInt(instruction.address) + BigInt(fields.imm); }
  catch { return null; }
}

/**
 * Decode-time constant target of a direct ARM64 transfer, else null. The ARM64
 * decoder resolves PC-relative branch targets during decode and publishes them
 * as `branchTarget`, so no operand text is parsed here.
 */
function arm64DirectControlTarget(instruction) {
  if (instruction?.branchTarget == null) return null;
  if (!['branch','conditional-branch','call'].includes(arm64ControlFlow(instruction))) return null;
  try { return BigInt(instruction.branchTarget); }
  catch { return null; }
}

/** Decode-time constant target of a direct x86-64 transfer, else null. */
function x86DirectControlTarget(instruction) {
  const operand = instruction?.detail?.operands?.[0];
  if (operand?.type !== 'immediate' || operand.value == null) return null;
  const kind = x86ControlFlow(instruction);
  if (!['branch','conditional-branch','call'].includes(kind)) return null;
  try { return BigInt(operand.value); }
  catch { return null; }
}

const ARM64_REGISTERS = Object.freeze([
  ...Array.from({length:31}, (_x,i) => Object.freeze({ id:`x${i}`, bits:64, kind:'gp' })),
  Object.freeze({ id:'sp', bits:64, kind:'stack-pointer' }),
  Object.freeze({ id:'nzcv', bits:4, kind:'flags' }),
  Object.freeze({ id:'pstate.btype', bits:2, kind:'system-state' }),
  ...Array.from({length:32}, (_x,i) => Object.freeze({ id:`v${i}`, bits:128, kind:'vector' })),
]);

const liftArm64eMachineEffectsBase = extendArm64WithArm64eEffects(liftArm64MachineEffects);
const liftArm64eMachineEffects = (decoded, context = {}) => {
  const bundle = liftArm64eMachineEffectsBase(decoded, context);
  return bundle == null ? null : decorateArm64BtypeEffects(decoded, context, bundle);
};

export const ARM64_ARCHITECTURE = registerArchitecturePlugin({
  id:'arm64', semanticVersion:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:4, fixedInstructionSize:4, viewerCompatible:true,
  modes:()=>Object.freeze(['a64']), registerFile:()=>ARM64_REGISTERS,
  decodeProvider:'capstone/backend', liftExact:liftArm64MachineEffects, assemble:assembleArm64, classifyControlFlow:arm64ControlFlow,
  directControlTarget:arm64DirectControlTarget,
  // Phase 2 exposes exact low-level effects where implemented. Coverage is not
  // complete yet, so the proven legacy v1 path remains active and MachineEffects
  // stays a shadow semantic source until the compatibility differential is zero.
  capabilities:{ decode:'external', exactEffects:'partial', semanticAnalysis:'legacy-v1' },
});

export const ARM64E_ARCHITECTURE = registerArchitecturePlugin({
  id:'arm64e', semanticVersion:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:4, fixedInstructionSize:4, viewerCompatible:true,
  modes:()=>Object.freeze(['a64','arm64e']), registerFile:()=>ARM64_REGISTERS,
  decodeProvider:'capstone/backend', liftExact:liftArm64eMachineEffects, assemble:assembleArm64, classifyControlFlow:arm64ControlFlow,
  directControlTarget:arm64DirectControlTarget,
  capabilities:{ decode:'external', exactEffects:'partial', semanticAnalysis:'legacy-v1-partial' },
});

export const X86_64_ARCHITECTURE = registerArchitecturePlugin({
  id:'x86_64', semanticVersion:X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:1, fixedInstructionSize:null, viewerCompatible:false,
  modes:()=>Object.freeze(['long-64']), registerFile:x86RegisterFile,
  decodeProvider:'capstone/backend', liftExact:liftX86MachineEffects, classifyControlFlow:x86ControlFlow,
  directControlTarget:x86DirectControlTarget,
  // P5-5's bounded variable-length viewer implementation is integrated and
  // verified under tests/phase5/viewer/**. Public capability promotion is kept
  // conservative because the frozen global capability regression is outside
  // P5-I ownership; semantic/A6 maturity also remains partial pending P5-6.
  capabilities:{ decode:'external-structured-v1', exactEffects:'partial', semanticAnalysis:'phase5-shadow-partial' },
});

/**
 * RISC-V64, frozen Phase 6 profile RV64IMC / LP64 little-endian.
 *
 * `instructionAlignment` is 2 and `fixedInstructionSize` is null because the
 * "C" standard extension makes the instruction stream variable-width. There is
 * deliberately no flags register in `registerFile()`: RV64 has none, and the
 * whole point of Phase 6 is that the generic middle-end does not need one.
 */
export const RISCV64_ARCHITECTURE = registerArchitecturePlugin({
  id:'riscv64', semanticVersion:RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:RISCV64_INSTRUCTION_ALIGNMENT, fixedInstructionSize:null, viewerCompatible:false,
  modes:()=>Object.freeze(['rv64im','rv64imc']), registerFile:riscv64RegisterFile,
  decodeProvider:'capstone/backend', liftExact:liftRiscv64MachineEffects, classifyControlFlow:riscv64ControlFlow,
  directControlTarget:riscv64DirectControlTarget, supportedMemoryEndianness:Object.freeze(['little']),
  capabilities:{ decode:'external-structured-v1', exactEffects:'exact-for-rv64imc-profile', semanticAnalysis:'phase6-shared-middle-end' },
});

export const UNKNOWN_ARCHITECTURE = registerArchitecturePlugin({
  id:'unknown', semanticVersion:'1', instructionAlignment:1, fixedInstructionSize:null, viewerCompatible:false,
  capabilities:{ decode:'unsupported', exactEffects:'unsupported', semanticAnalysis:'unsupported' },
});

export { ArchitecturePluginV2, registerArchitecturePlugin, architecturePluginV2, architecturePluginsV2, canonicalArchitectureId, normalizeArchitecturePositiveInteger };
