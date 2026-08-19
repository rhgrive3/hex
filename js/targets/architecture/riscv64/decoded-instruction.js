import { decodeRiscv64InstructionWord, riscvInstructionLength } from './instruction-word.js';
import { riscv64RegisterDescriptor } from './registers.js';

export const RISCV64_DECODED_INSTRUCTION_CONTRACT_VERSION = 'riscv64-decoded-instruction/v1';
export const RISCV64_DECODER_SEMANTIC_VERSION = 'capstone-5-riscv64-word-exact-v1';
export const RISCV64_DECODE_MODES = Object.freeze(['rv64im', 'rv64imc']);

function text(value, code) {
  const out = String(value ?? '').trim();
  if (!out) throw new TypeError(code);
  return out;
}
function bigint(value, code) {
  try { return BigInt(value); } catch { throw new TypeError(code); }
}

/**
 * Normalize one decoder row into the canonical RISC-V decoded instruction.
 *
 * `rawBytes` is authoritative: architectural fields come from
 * `decodeRiscv64InstructionWord`, not from `mnemonic`/`opStr`. The display
 * strings are carried through for the viewer and for decoder differential
 * tests, and no semantic consumer is permitted to read them.
 */
export function createRiscv64DecodedInstruction(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('riscv64-decoded-instruction-invalid');
  const address = bigint(input.address, 'riscv64-decoded-instruction-invalid-address');
  const size = Number(input.size ?? input.length);
  if (size !== 2 && size !== 4) throw new TypeError('riscv64-decoded-instruction-invalid-length');
  const rawBytes = input.rawBytes instanceof Uint8Array ? input.rawBytes.slice() : Uint8Array.from(input.rawBytes || []);
  if (rawBytes.length !== size) throw new TypeError('riscv64-decoded-instruction-byte-length-mismatch');
  const encodedLength = riscvInstructionLength(rawBytes[0] | (rawBytes[1] << 8));
  if (encodedLength !== size) throw new TypeError('riscv64-decoded-instruction-length-disagrees-with-encoding');

  const fields = decodeRiscv64InstructionWord(rawBytes);
  const mode = text(input.mode ?? 'rv64imc', 'riscv64-decoded-instruction-mode-required');
  if (!RISCV64_DECODE_MODES.includes(mode)) throw new TypeError('riscv64-decoded-instruction-unsupported-mode');
  if (mode === 'rv64im' && size === 2) throw new TypeError('riscv64-decoded-instruction-compressed-disabled');
  const instructionAlignment = Number(input.instructionAlignment ?? (mode === 'rv64im' ? 4 : 2));
  if (!Number.isSafeInteger(instructionAlignment) || ![2,4].includes(instructionAlignment)) {
    throw new TypeError('riscv64-decoded-instruction-invalid-instruction-alignment');
  }
  if (mode === 'rv64im' && instructionAlignment !== 4) throw new TypeError('riscv64-decoded-instruction-mode-alignment-mismatch');
  if (mode === 'rv64imc' && instructionAlignment !== 2) throw new TypeError('riscv64-decoded-instruction-mode-alignment-mismatch');

  return Object.freeze({
    architecture: 'riscv64',
    mode,
    instructionAlignment,
    ...(input.isaIdentity == null ? {} : { isaIdentity:String(input.isaIdentity) }),
    ...(input.isaEvidence == null ? {} : { isaEvidence:String(input.isaEvidence) }),
    ...(input.compressedInstructions == null ? {} : { compressedInstructions:input.compressedInstructions === true }),
    address,
    size,
    length: size,
    rawBytes,
    // Display-only. Never read by the lifter or by any generic consumer.
    mnemonic: String(input.mnemonic ?? ''),
    opStr: String(input.opStr ?? ''),
    contractVersion: RISCV64_DECODED_INSTRUCTION_CONTRACT_VERSION,
    decoderContractVersion: RISCV64_DECODED_INSTRUCTION_CONTRACT_VERSION,
    decoderSemanticVersion: String(input.decoderSemanticVersion ?? RISCV64_DECODER_SEMANTIC_VERSION),
    // Structured architectural truth.
    fields,
    // `instructionFamily` is the canonical architectural operation recovered
    // from the encoding (`addi`, `beq`, `jal`, ...), not the printer's alias.
    instructionFamily: fields.supported ? fields.op : 'unsupported',
    compressed: fields.supported ? fields.compressed === true : null,
    detailAvailable: fields.supported === true,
    detailStatus: fields.supported ? 'complete' : 'unsupported-encoding',
    ...(input.instructionId == null ? {} : { instructionId: String(input.instructionId) }),
    ...(input.origin == null ? {} : { origin: input.origin }),
  });
}

/** True when every register field of a decoded instruction resolves physically. */
export function riscv64DecodedRegistersResolve(decoded) {
  const fields = decoded?.fields;
  if (!fields?.supported) return false;
  return [fields.rd, fields.rs1, fields.rs2]
    .filter((value) => value != null)
    .every((value) => riscv64RegisterDescriptor(value) != null);
}
