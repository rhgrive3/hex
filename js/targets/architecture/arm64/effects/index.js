import { liftArm64ControlEffects } from './control.js';
import { directTargetOf, immediateOf, instructionMnemonic } from './common.js';
import { liftArm64FlagEffects } from './flags.js';
import { liftArm64FpEffects } from './fp.js';
import { liftArm64IntegerEffects } from './integer.js';
import { liftArm64MemoryEffects } from './memory.js';
import { liftArm64SimdEffects } from './simd.js';
import { liftArm64SystemEffects } from './system.js';

export const ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION = '3';

// This order is part of the Phase 2 semantic contract. Shape-sensitive families
// precede scalar families when A64 reuses a mnemonic (for example ADD/MOV in
// SIMD versus integer code). They must return null when the operand shape is not
// theirs. Memory intentionally precedes system so DMB/DSB/ISB/CLREX have one
// canonical implementation: the atomic/memory model, which validates barrier
// options and models exclusive-monitor state.
const ARM64_EFFECT_FAMILIES = Object.freeze([
  Object.freeze({ id:'flags', lift:liftArm64FlagEffects }),
  Object.freeze({ id:'control', lift:liftArm64ControlEffects }),
  Object.freeze({ id:'memory', lift:liftArm64MemoryEffects }),
  Object.freeze({ id:'simd', lift:liftArm64SimdEffects }),
  Object.freeze({ id:'fp', lift:liftArm64FpEffects }),
  Object.freeze({ id:'integer', lift:liftArm64IntegerEffects }),
  Object.freeze({ id:'system', lift:liftArm64SystemEffects }),
]);

function normalizedInstruction(decoded, context) {
  if (!decoded || typeof decoded !== 'object') throw new TypeError('arm64-decoded-instruction-required');
  const instructionId = decoded.instructionId ?? context?.instructionId;
  const origin = decoded.origin ?? context?.origin;
  const mode = decoded.mode ?? context?.mode;
  const mnemonic = instructionMnemonic(decoded);
  // Current decoded-model producers are allowed to carry ADR/ADRP's resolved
  // absolute target either in pcRelTarget or in the already-decoded immediate
  // operand. Normalize those architecture-layer representations before
  // MachineEffects are created, so generic Semantic IR/SSA consumers never need
  // to inspect instruction text or reconstruct PC-relative semantics.
  const operands = Array.isArray(decoded.ops) ? decoded.ops : Array.isArray(decoded.operands) ? decoded.operands : [];
  const adrImmediate = operands.length > 1 ? immediateOf(operands[1]) : null;
  const normalizedPcRelTarget = (mnemonic === 'adr' || mnemonic === 'adrp') && decoded.pcRelTarget == null
    ? (adrImmediate ?? directTargetOf(decoded))
    : decoded.pcRelTarget;
  if (instructionId == null && origin == null && mode == null && normalizedPcRelTarget === decoded.pcRelTarget) return decoded;
  return {
    ...decoded,
    ...(instructionId == null ? {} : { instructionId }),
    ...(origin == null ? {} : { origin }),
    ...(mode == null ? {} : { mode }),
    ...(normalizedPcRelTarget == null ? {} : { pcRelTarget: normalizedPcRelTarget }),
  };
}

function normalizedContext(context = {}) {
  const machineEffectsOptions = context.machineEffectsOptions ?? context.options ?? {};
  return {
    ...context,
    ...machineEffectsOptions,
    options: machineEffectsOptions,
    machineEffectsOptions,
  };
}

export function liftArm64MachineEffects(decoded, context = {}) {
  const instruction = normalizedInstruction(decoded, context);
  const familyContext = normalizedContext(context);
  for (const family of ARM64_EFFECT_FAMILIES) {
    const result = family.lift(instruction, familyContext);
    if (result != null) return result;
  }
  return null;
}

export function arm64MachineEffectFamilies() {
  return Object.freeze(ARM64_EFFECT_FAMILIES.map(({ id }) => id));
}

export const liftExact = liftArm64MachineEffects;