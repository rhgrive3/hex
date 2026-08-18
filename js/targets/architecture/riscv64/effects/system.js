import { createRiscv64EffectContext } from './common.js';

/**
 * FENCE and the two base-ISA environment-call instructions.
 *
 * `fence` is a memory-ordering barrier; its predecessor/successor sets are
 * carried into the barrier scope so the ordering is not silently widened or
 * narrowed. `ecall`/`ebreak` transfer control to the execution environment,
 * whose effects Hex cannot see, so they are explicit traps with unknown
 * environment effects rather than convenient no-ops.
 */

const FENCE_BIT_NAMES = Object.freeze(['input', 'output', 'read', 'write']);

function fenceSet(mask) {
  const value = Number(mask) & 0b1111;
  return Object.freeze(FENCE_BIT_NAMES.filter((_name, index) => (value & (1 << (3 - index))) !== 0));
}

export function liftRiscv64SystemEffects(decoded, context = {}) {
  const ctx = createRiscv64EffectContext(decoded, context);
  const fields = ctx.fields;
  if (!fields.supported) return null;

  if (fields.op === 'fence') {
    ctx.addOperation({
      kind: 'barrier',
      scope: {
        kind: 'riscv64-fence',
        predecessor: fenceSet(fields.predecessor),
        successor: fenceSet(fields.successor),
        fenceMode: Number(fields.fenceMode) === 0b1000 ? 'tso' : 'normal',
      },
    });
    return ctx.finish({ family: 'barrier', metadata: { operation: 'fence' } });
  }

  if (fields.op === 'fence.i') {
    ctx.addOperation({ kind: 'barrier', scope: { kind: 'riscv64-instruction-fence' } });
    return ctx.finish({ family: 'barrier', metadata: { operation: 'fence.i', extension: 'Zifencei' } });
  }

  if (fields.op === 'ecall' || fields.op === 'ebreak') {
    // The environment's register and memory effects are outside the binary, so
    // they must stay explicitly unknown. Nothing may be assumed preserved.
    return ctx.partial(
      `riscv64-${fields.op}-environment-effects-unknown`,
      ['registers', 'memory', 'control', 'other'],
      {
        controlEffect: { kind: 'trap', reason: `riscv64-${fields.op}` },
        family: 'system',
        metadata: { operation: fields.op, environmentCall: true },
      },
    );
  }

  return null;
}
