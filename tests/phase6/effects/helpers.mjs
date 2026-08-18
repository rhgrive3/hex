import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { liftRiscv64MachineEffects } from '../../../js/targets/architecture/riscv64/effects/index.js';

export const MASK64 = (1n << 64n) - 1n;
export const u64 = (value) => BigInt.asUintN(64, BigInt(value));
export const s64 = (value) => BigInt.asIntN(64, BigInt(value));

export function liftBytes(bytes, address = 0x1000n) {
  const raw = Uint8Array.from(bytes);
  const decoded = createRiscv64DecodedInstruction({
    address, size: raw.length, rawBytes: raw,
    instructionId: `i@${address}`, origin: { instructionIds: [`i@${address}`] },
  });
  const bundle = liftRiscv64MachineEffects(decoded, {
    instructionId: `i@${address}`, origin: { instructionIds: [`i@${address}`] }, mode: 'rv64imc',
  });
  return { decoded, bundle };
}

function widthOf(value) {
  if (value?.kind === 'temporary') return Number(value.valueType?.widthBits || 64);
  return Number(value?.widthBits || 64);
}

/**
 * A minimal evaluator for the MachineEffects vocabulary the RV64 lifter emits.
 *
 * It knows nothing about RISC-V: it interprets generic operations only. That is
 * the point. Comparing its result against an independent, ISA-derived reference
 * model checks that the *lifted effects* compute what the instruction computes,
 * rather than checking the lifter against itself.
 */
export function evaluateBundle(bundle, initialRegisters = {}, memory = new Map()) {
  const registers = new Map(Object.entries(initialRegisters).map(([id, value]) => [id, u64(value)]));
  const temporaries = new Map();

  const read = (value) => {
    if (value == null) throw new Error('missing operand');
    switch (value.kind) {
      case 'bitvector': return BigInt.asUintN(widthOf(value), BigInt(value.value ?? 0n));
      case 'temporary': {
        if (!temporaries.has(value.temporaryId)) throw new Error(`unset temporary ${value.temporaryId}`);
        return temporaries.get(value.temporaryId);
      }
      case 'register': return registers.get(value.registerId) ?? 0n;
      default: throw new Error(`unsupported value kind ${value.kind}`);
    }
  };
  const write = (value, result) => {
    const bits = widthOf(value);
    if (value.kind === 'temporary') temporaries.set(value.temporaryId, BigInt.asUintN(bits, result));
    else if (value.kind === 'register') registers.set(value.registerId, BigInt.asUintN(bits, result));
    else throw new Error(`cannot write value kind ${value.kind}`);
  };

  for (const operation of bundle.operations) {
    if (operation.kind === 'register-read') { write(operation.value, registers.get(operation.register.registerId) ?? 0n); continue; }
    if (operation.kind === 'register-write') { registers.set(operation.register.registerId, read(operation.value)); continue; }
    if (operation.kind === 'memory-read') { write(operation.value, memory.get(String(read(operation.access.addressExpr ?? { kind: 'bitvector', widthBits: 64, value: 0n }))) ?? 0n); continue; }
    if (operation.kind === 'memory-write' || operation.kind === 'barrier') continue;
    if (operation.kind !== 'value') throw new Error(`unsupported operation kind ${operation.kind}`);

    const output = operation.outputs[0];
    const bits = widthOf(output);
    const inputs = operation.inputs.map(read);
    const opcode = String(operation.opcode);
    const signedInput = (index) => BigInt.asIntN(widthOf(operation.inputs[index]), inputs[index]);
    let result;
    switch (opcode) {
      case 'add': result = inputs[0] + inputs[1]; break;
      case 'sub': result = inputs[0] - inputs[1]; break;
      case 'mul': result = inputs[0] * inputs[1]; break;
      case 'and': result = inputs[0] & inputs[1]; break;
      case 'or': result = inputs[0] | inputs[1]; break;
      case 'xor': result = inputs[0] ^ inputs[1]; break;
      case 'shl': result = inputs[0] << inputs[1]; break;
      case 'lshr': result = inputs[0] >> inputs[1]; break;
      case 'ashr': result = signedInput(0) >> inputs[1]; break;
      case 'sdiv': result = signedInput(0) / signedInput(1); break;
      case 'udiv': result = inputs[0] / inputs[1]; break;
      case 'srem': result = signedInput(0) % signedInput(1); break;
      case 'urem': result = inputs[0] % inputs[1]; break;
      case 'trunc': result = BigInt.asUintN(bits, inputs[0]); break;
      case 'zext': result = BigInt.asUintN(widthOf(operation.inputs[0]), inputs[0]); break;
      case 'sext': result = BigInt.asUintN(bits, signedInput(0)); break;
      case 'select': result = inputs[0] & 1n ? inputs[1] : inputs[2]; break;
      case 'icmp.eq': result = inputs[0] === inputs[1] ? 1n : 0n; break;
      case 'icmp.ne': result = inputs[0] === inputs[1] ? 0n : 1n; break;
      case 'icmp.slt': result = signedInput(0) < signedInput(1) ? 1n : 0n; break;
      case 'icmp.sge': result = signedInput(0) >= signedInput(1) ? 1n : 0n; break;
      case 'icmp.ult': result = inputs[0] < inputs[1] ? 1n : 0n; break;
      case 'icmp.uge': result = inputs[0] >= inputs[1] ? 1n : 0n; break;
      default: throw new Error(`unsupported opcode ${opcode}`);
    }
    write(output, result);
  }
  return { registers, temporaries };
}

/** Deterministic pseudo-random 64-bit values, seeded so failures reproduce exactly. */
export function* sampleValues(seed = 1n, count = 24) {
  let state = BigInt.asUintN(64, seed * 6364136223846793005n + 1442695040888963407n);
  const fixed = [0n, 1n, 2n, 7n, 63n, 64n, MASK64, MASK64 - 1n, 1n << 63n, (1n << 63n) - 1n, (1n << 31n), (1n << 32n) - 1n, u64(-1n), u64(-2n)];
  for (const value of fixed) yield value;
  for (let index = 0; index < count; index += 1) {
    state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
    yield state;
  }
}
