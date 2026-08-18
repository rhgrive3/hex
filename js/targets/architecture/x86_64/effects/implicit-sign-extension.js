import { createX86EffectContext, x86RegisterOperand } from './common.js';

const LOW_HALF_EXTENSIONS = Object.freeze({
  cbw:Object.freeze({ source:'al', destination:'ax', fromBits:8, toBits:16 }),
  cwde:Object.freeze({ source:'ax', destination:'eax', fromBits:16, toBits:32 }),
  cdqe:Object.freeze({ source:'eax', destination:'rax', fromBits:32, toBits:64 }),
});

const HIGH_HALF_EXTENSIONS = Object.freeze({
  cwd:Object.freeze({ source:'ax', destination:'dx', fromBits:16, wideBits:32, highBits:16 }),
  cdq:Object.freeze({ source:'eax', destination:'edx', fromBits:32, wideBits:64, highBits:32 }),
  cqo:Object.freeze({ source:'rax', destination:'rdx', fromBits:64, wideBits:128, highBits:64 }),
});

export function liftX86ImplicitSignExtensionEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  const low = LOW_HALF_EXTENSIONS[family];
  const high = HIGH_HALF_EXTENSIONS[family];
  if (!low && !high) return null;

  const ctx = createX86EffectContext(instruction, context);
  if (ctx.operands.length !== 0) {
    return ctx.partial(`x86-${family}-unexpected-explicit-operands`, ['registers']);
  }

  if (low) {
    const source = x86RegisterOperand(low.source);
    const destination = x86RegisterOperand(low.destination);
    const value = source ? ctx.readRegister(source) : null;
    if (!value || !destination) return ctx.partial(`x86-${family}-implicit-register-unavailable`, ['registers']);
    const extended = ctx.coerce(value, low.fromBits, low.toBits, true);
    if (!ctx.writeRegister(destination, extended)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers']);
    return ctx.finish({
      family:'integer',
      metadata:{ operation:family, implicitOperands:true, signExtension:true, fromBits:low.fromBits, toBits:low.toBits, flagsModified:false },
    });
  }

  const source = x86RegisterOperand(high.source);
  const destination = x86RegisterOperand(high.destination);
  const value = source ? ctx.readRegister(source) : null;
  if (!value || !destination) return ctx.partial(`x86-${family}-implicit-register-unavailable`, ['registers']);
  const widened = ctx.coerce(value, high.fromBits, high.wideBits, true);
  const upper = ctx.valueOp('extract', [widened], high.highBits, {
    lsb:high.fromBits,
    widthBits:high.highBits,
    sourceWidthBits:high.wideBits,
    semantic:`x86-${family}-sign-extension-high-half`,
  });
  if (!ctx.writeRegister(destination, upper)) return ctx.partial(`x86-${family}-destination-unmodelled`, ['registers']);
  return ctx.finish({
    family:'integer',
    metadata:{ operation:family, implicitOperands:true, signExtension:true, fromBits:high.fromBits, toBits:high.wideBits, highHalfDestination:high.destination, flagsModified:false },
  });
}
