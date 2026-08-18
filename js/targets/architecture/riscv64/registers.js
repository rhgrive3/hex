/**
 * RISC-V64 physical state model.
 *
 * Authority: "The RISC-V Instruction Set Manual, Volume I: Unprivileged
 * Architecture" (RV64I base integer ISA) and the RISC-V psABI register
 * convention table.
 *
 * Two rules drive this file and are asserted by tests/phase6/registers/**:
 *
 *  1. There are exactly 32 integer physical registers, `x0`..`x31`. The psABI
 *     names (`zero`, `ra`, `sp`, `a0`, `s0`, ...) are *views* of that same
 *     physical state, never independent state. The deployed Capstone RISC-V
 *     printer emits only psABI names, so normalization happens at this decoder
 *     boundary and nowhere else.
 *  2. `x0` is architecturally hardwired to zero. Reads produce the constant 0
 *     and writes are discarded. It is therefore NOT a normal mutable register,
 *     and the lifter must never emit a `register-write` naming it.
 *
 * There is deliberately no flags/condition-code register: RV64 has none, and
 * Phase 6 exists to prove the generic middle-end does not require one.
 */

export const RISCV64_PHYSICAL_STATE_CONTRACT_VERSION = 'riscv64-physical-state/v1';

/** Index-ordered psABI names for x0..x31 (psABI "Integer Register Convention"). */
const ABI_NAMES = Object.freeze([
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
  's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
]);

/** `fp` is an additional accepted spelling of x8; it is not extra state. */
const EXTRA_ALIASES = Object.freeze({ fp: 8, s0: 8 });

export const RISCV64_XLEN = 64;
export const RISCV64_ZERO_REGISTER = 'x0';

function roleOf(index) {
  if (index === 0) return 'hardwired-zero';
  if (index === 1) return 'return-address';
  if (index === 2) return 'stack-pointer';
  if (index === 3) return 'global-pointer';
  if (index === 4) return 'thread-pointer';
  if (index === 8) return 'frame-pointer';
  return 'general';
}

function kindOf(index) {
  // `kind` is consumed by the generic region resolver in
  // js/semantics/compat/index.js to recognise stack-like roots. Only the
  // architectural stack pointer may carry 'stack-pointer'.
  if (index === 2) return 'stack-pointer';
  if (index === 0) return 'hardwired-zero';
  return 'gp';
}

const DESCRIPTORS = new Map();
const PHYSICAL = [];

for (let index = 0; index < 32; index += 1) {
  const physicalId = `x${index}`;
  const descriptor = Object.freeze({
    id: physicalId,
    physicalId,
    index,
    abiName: ABI_NAMES[index],
    bits: RISCV64_XLEN,
    physicalBits: RISCV64_XLEN,
    viewBits: RISCV64_XLEN,
    lsb: 0,
    // RV64 integer registers have exactly one architectural view: the whole
    // XLEN-wide value. There is no sub-register write policy to model.
    writePolicy: 'replace',
    kind: kindOf(index),
    role: roleOf(index),
    hardwiredZero: index === 0,
  });
  PHYSICAL.push(descriptor);
  DESCRIPTORS.set(physicalId, descriptor);
  DESCRIPTORS.set(ABI_NAMES[index], descriptor);
}
for (const [alias, index] of Object.entries(EXTRA_ALIASES)) DESCRIPTORS.set(alias, PHYSICAL[index]);

export const RISCV64_PHYSICAL_REGISTERS = Object.freeze(PHYSICAL.slice());
export const RISCV64_ABI_NAMES = ABI_NAMES;

/**
 * Resolve any accepted spelling (physical `xN`, psABI name, or `fp`) to the one
 * canonical physical descriptor. Returns null for anything else, including the
 * floating-point register file, which is outside the frozen Phase 6 profile.
 */
export function riscv64RegisterDescriptor(value) {
  if (value && typeof value === 'object') {
    return riscv64RegisterDescriptor(value.physicalId ?? value.id ?? value.registerId ?? value.name ?? null);
  }
  const name = String(value ?? '').trim().toLowerCase();
  if (!name) return null;
  return DESCRIPTORS.get(name) ?? null;
}

/** Canonical physical id (`xN`) for any accepted spelling, else null. */
export function normalizeRiscv64RegisterName(value) {
  return riscv64RegisterDescriptor(value)?.physicalId ?? null;
}

export function isRiscv64ZeroRegister(value) {
  return riscv64RegisterDescriptor(value)?.hardwiredZero === true;
}

/**
 * The ArchitecturePluginV2 register file. Only physical state appears here: the
 * psABI aliases are resolvable through `riscv64RegisterDescriptor` but are not
 * separate entries, so no generic pass can mistake `a0` and `x10` for two
 * distinct locations.
 */
export function riscv64RegisterFile() {
  return RISCV64_PHYSICAL_REGISTERS;
}
