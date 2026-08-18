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

/* Little-endian byte-addressed memory, so overlapping widths stay consistent. */
function readMemory(memory, address, widthBits) {
  let value = 0n;
  for (let index = BigInt(widthBits) / 8n - 1n; index >= 0n; index -= 1n) {
    value = (value << 8n) | BigInt(memory.get((BigInt(address) + index).toString()) ?? 0);
  }
  return value;
}
function writeMemory(memory, address, widthBits, value) {
  let remaining = BigInt.asUintN(widthBits, value);
  for (let index = 0n; index < BigInt(widthBits) / 8n; index += 1n) {
    memory.set((BigInt(address) + index).toString(), Number(remaining & 0xffn));
    remaining >>= 8n;
  }
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
    if (operation.kind === 'memory-read') {
      const address = read(operation.access.addressExpr);
      write(operation.value, readMemory(memory, address, operation.access.widthBits));
      continue;
    }
    if (operation.kind === 'memory-write') {
      const address = read(operation.access.addressExpr);
      writeMemory(memory, address, operation.access.widthBits, read(operation.value));
      continue;
    }
    if (operation.kind === 'barrier') continue;
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

/**
 * Execute a whole lifted RV64 function.
 *
 * This is the layer that turns "the pipeline completed" into "the semantics are
 * right". It interprets only the generic MachineEffects vocabulary and the
 * generic control-effect contract -- it knows no RISC-V -- and follows the
 * control effects the lifter produced. Comparing its result against the
 * behaviour of the C source the corpus was compiled from is a genuine
 * source-level oracle: neither side is the implementation under test.
 *
 * `bundlesByAddress` maps an instruction address to its lifted bundle.
 * Execution stops at the first `return`, and anything it cannot follow (an
 * indirect transfer, a trap, an unknown effect) stops with a reason rather than
 * guessing.
 */
export function executeFunction(bundlesByAddress, {
  registers = {},
  memory = new Map(),
  entryAddress,
  maxSteps = 20000,
} = {}) {
  const state = new Map(Object.entries(registers).map(([id, value]) => [id, u64(value)]));
  let pc = BigInt(entryAddress);
  let steps = 0;

  while (steps < maxSteps) {
    steps += 1;
    const bundle = bundlesByAddress.get(pc.toString());
    if (!bundle) return { status: 'no-bundle', pc, steps, registers: state, memory };
    if (bundle.completeness !== 'exact' && bundle.completeness !== 'exact-with-intrinsic') {
      return { status: `non-exact:${bundle.completeness}`, pc, steps, registers: state, memory };
    }

    const result = evaluateBundle(bundle, Object.fromEntries(state), memory);
    for (const [id, value] of result.registers) state.set(id, value);

    const control = bundle.controlEffect;
    const resolve = (reference) => {
      if (reference == null) return null;
      if (reference.kind === 'absolute-address') return BigInt(reference.value);
      if (reference.kind === 'temporary') {
        const value = result.temporaries.get(reference.temporaryId);
        return value == null ? null : BigInt.asUintN(64, value);
      }
      return null;
    };

    if (control.kind === 'return') return { status: 'returned', pc, steps, registers: state, memory };
    if (control.kind === 'fallthrough') { pc += BigInt(instructionLengthOf(bundle)); continue; }
    if (control.kind === 'branch' || control.kind === 'indirect') {
      // An indirect transfer is followable exactly when its target value is
      // computable from the state we have -- which, with the image mapped into
      // memory, includes real jump tables.
      const target = resolve(control.target);
      if (target == null) return { status: `unresolved-${control.kind}-target`, pc, steps, registers: state, memory };
      pc = target;
      continue;
    }
    if (control.kind === 'conditional-branch') {
      const conditionId = control.condition?.temporaryId;
      const taken = conditionId == null ? null : result.temporaries.get(conditionId);
      if (taken == null) return { status: 'unresolved-condition', pc, steps, registers: state, memory };
      const target = taken === 1n ? resolve(control.target) : resolve(control.fallthrough);
      if (target == null) return { status: 'unresolved-branch-target', pc, steps, registers: state, memory };
      pc = target;
      continue;
    }
    return { status: `unfollowable-control:${control.kind}`, pc, steps, registers: state, memory };
  }
  return { status: 'step-budget-exhausted', pc, steps, registers: state, memory };
}

function instructionLengthOf(bundle) {
  const range = bundle.origin?.virtualRanges?.[0];
  if (range?.start != null && range?.end != null) return Number(BigInt(range.end) - BigInt(range.start));
  return bundle.metadata?.compressed === true ? 2 : 4;
}


/**
 * A byte-addressed memory view layered over a shared read-only base.
 *
 * The base holds the fixture's mapped image, so real `.rodata` jump tables and
 * globals read correctly. Writes land in a per-execution overlay, so one input
 * tuple cannot leak state into the next.
 */
export function layeredMemory(base) {
  const overlay = new Map();
  return {
    get(key) { return overlay.has(key) ? overlay.get(key) : base.get(key); },
    set(key, value) { overlay.set(key, value); return this; },
    has(key) { return overlay.has(key) || base.has(key); },
  };
}

/** Map an ELF image's loadable segments into a byte-addressed memory base. */
export function imageMemory(image, bytes) {
  const base = new Map();
  for (const segment of image.segments || []) {
    if (segment.address == null || segment.fileSize == null) continue;
    const start = Number(segment.fileOffset ?? 0);
    const length = Number(segment.fileSize);
    for (let index = 0; index < length; index += 1) {
      base.set((BigInt(segment.address) + BigInt(index)).toString(), bytes[start + index] ?? 0);
    }
  }
  return base;
}
