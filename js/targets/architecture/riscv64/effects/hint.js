import { createRiscv64EffectContext } from './common.js';

/**
 * RVC HINTs and C.NOP are architecturally state-preserving instructions.
 *
 * They still advance control normally, but must not manufacture register reads
 * or writes merely because their encoding reuses a computational instruction.
 * The explicit state-preservation proof is required for an exact empty bundle.
 */
export function liftRiscv64HintEffects(decoded, context = {}) {
  const ctx = createRiscv64EffectContext(decoded, context);
  const fields = ctx.fields;
  if (!fields.supported || fields.architecturalNoOp !== true) return null;

  return ctx.finish({
    family: 'hint',
    statePreservation: {
      proven: true,
      reason: 'riscv64-rvc-architectural-noop',
    },
    metadata: {
      operation: fields.op,
      architecturalNoOp: true,
      hint: fields.hint === true,
    },
  });
}
