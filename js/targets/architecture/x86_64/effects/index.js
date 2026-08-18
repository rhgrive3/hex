import { liftX86ControlEffects } from './control.js';
import { liftX86IntegerEffects, liftX86LeaEffects } from './integer.js';
import { liftX86ImplicitSignExtensionEffects } from './implicit-sign-extension.js';
import { liftX86MemoryEffects } from './memory.js';
import { liftX86StringEffects } from './string.js';
import { liftX86AtomicEffects } from './atomic.js';
import { liftX86FloatingPointEffects } from './fp.js';
import { liftX86SimdEffects } from './simd.js';
import { liftX86SystemEffects } from './system.js';
import { normalizeX86Instruction, X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION } from './common.js';

function liftX86IntegerFamily(instruction, context) {
  return liftX86ImplicitSignExtensionEffects(instruction, context) ?? liftX86IntegerEffects(instruction, context);
}

const FAMILIES = Object.freeze([
  Object.freeze({ id:'control', lift:liftX86ControlEffects }),
  Object.freeze({ id:'memory', lift:liftX86MemoryEffects }),
  Object.freeze({ id:'lea', lift:liftX86LeaEffects }),
  Object.freeze({ id:'integer', lift:liftX86IntegerFamily }),
  Object.freeze({ id:'string', lift:liftX86StringEffects }),
  Object.freeze({ id:'atomic', lift:liftX86AtomicEffects }),
  Object.freeze({ id:'fp', lift:liftX86FloatingPointEffects }),
  Object.freeze({ id:'simd', lift:liftX86SimdEffects }),
  Object.freeze({ id:'system', lift:liftX86SystemEffects }),
]);

export { X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION };

export function liftX86MachineEffects(decoded, context = {}) {
  const instruction = normalizeX86Instruction(decoded, context);
  if (!instruction.detailAvailable) return null;
  for (const family of FAMILIES) {
    const result = family.lift(instruction, context);
    if (result != null) return result;
  }
  return null;
}

export function x86MachineEffectFamilies() { return Object.freeze(FAMILIES.map(({ id }) => id)); }
