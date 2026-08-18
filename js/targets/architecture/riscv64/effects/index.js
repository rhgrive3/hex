import { liftRiscv64ControlEffects } from './control.js';
import { liftRiscv64IntegerEffects } from './integer.js';
import { liftRiscv64MemoryEffects } from './memory.js';
import { liftRiscv64MulDivEffects } from './muldiv.js';
import { liftRiscv64SystemEffects } from './system.js';
import {
  RISCV64_ARCHITECTURE_ID,
  RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION,
  RISCV64_MODE,
  normalizeRiscv64Instruction,
} from './common.js';

const FAMILIES = Object.freeze([
  Object.freeze({ id: 'control', lift: liftRiscv64ControlEffects }),
  Object.freeze({ id: 'memory', lift: liftRiscv64MemoryEffects }),
  Object.freeze({ id: 'muldiv', lift: liftRiscv64MulDivEffects }),
  Object.freeze({ id: 'integer', lift: liftRiscv64IntegerEffects }),
  Object.freeze({ id: 'system', lift: liftRiscv64SystemEffects }),
]);

export { RISCV64_ARCHITECTURE_ID, RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION, RISCV64_MODE };

/**
 * Lift one decoded RV64 instruction to exact MachineEffects.
 *
 * Returning null means "this architecture plugin produced no effects", and the
 * generic pipeline turns that into an explicit `unknown` bundle. Nothing here
 * may return an empty exact bundle, which would silently claim the instruction
 * preserves all state.
 */
export function liftRiscv64MachineEffects(decoded, context = {}) {
  const instruction = normalizeRiscv64Instruction(decoded, context);
  if (!instruction.fields?.supported) return null;
  for (const family of FAMILIES) {
    const result = family.lift(instruction, context);
    if (result != null) return result;
  }
  return null;
}

export function riscv64MachineEffectFamilies() { return Object.freeze(FAMILIES.map(({ id }) => id)); }
