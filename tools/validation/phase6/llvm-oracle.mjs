import { decodeRiscv64InstructionWord } from '../../../js/targets/architecture/riscv64/instruction-word.js';
import { normalizeRiscv64RegisterName } from '../../../js/targets/architecture/riscv64/registers.js';

/**
 * Independent decoder oracles for Phase 6.
 *
 * Two oracles, neither of them the implementation under test:
 *
 *  1. `parseLlvmObjdump` reads LLVM's own disassembly of the exact fixture. It
 *     is authoritative for instruction boundaries and raw bytes.
 *  2. `compareWithCapstoneOperands` checks Hex's ISA-encoding field extraction
 *     against Capstone's independently implemented structured operands.
 *
 * Together they mean the RISC-V decode path is never validated only by itself.
 */

function parseByteField(text) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.some((token) => !/^[0-9a-f]{2}$/i.test(token))) return null;
  return Uint8Array.from(tokens.map((token) => Number.parseInt(token, 16)));
}

export function parseLlvmObjdump(text, { symbolPrefix = 'p6_' } = {}) {
  const functions = new Map();
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const heading = /^\s*([0-9a-f]+)\s+<([^>]+)>:\s*$/i.exec(rawLine);
    if (heading) {
      const name = heading[2];
      current = name.startsWith(symbolPrefix) ? { name, address: BigInt(`0x${heading[1]}`), instructions: [] } : null;
      if (current) functions.set(name, current);
      continue;
    }
    if (!current) continue;
    const match = /^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2}(?:\s+|$))+)\s*(.*)$/i.exec(rawLine);
    if (!match) continue;
    const bytes = parseByteField(match[2]);
    if (!bytes?.length) continue;
    const asm = match[3].trim();
    const [mnemonic = '', ...rest] = asm.split(/\s+/);
    current.instructions.push(Object.freeze({
      address: BigInt(`0x${match[1]}`),
      bytes,
      length: bytes.length,
      mnemonic,
      operands: rest.join(' '),
      asm,
    }));
  }
  for (const entry of functions.values()) {
    entry.instructions = Object.freeze(entry.instructions);
    const last = entry.instructions.at(-1);
    entry.endAddress = last ? last.address + BigInt(last.length) : entry.address;
    entry.bytes = Uint8Array.from(entry.instructions.flatMap((instruction) => [...instruction.bytes]));
    Object.freeze(entry);
  }
  return functions;
}

/** Boundary/byte differential between a Hex decoded instruction and LLVM's row. */
export function compareDecodedWithOracle(decoded, oracle) {
  const mismatches = [];
  if (BigInt(decoded.address) !== BigInt(oracle.address)) {
    mismatches.push({ kind: 'address', expected: `0x${oracle.address.toString(16)}`, actual: `0x${BigInt(decoded.address).toString(16)}` });
  }
  if (Number(decoded.length ?? decoded.size) !== oracle.length) {
    mismatches.push({ kind: 'length', expected: oracle.length, actual: Number(decoded.length ?? decoded.size) });
  }
  const actualBytes = Buffer.from(decoded.rawBytes || []).toString('hex');
  const expectedBytes = Buffer.from(oracle.bytes).toString('hex');
  if (actualBytes !== expectedBytes) mismatches.push({ kind: 'bytes', expected: expectedBytes, actual: actualBytes });
  if (decoded.fields?.supported !== true) {
    mismatches.push({ kind: 'unsupported-encoding', expected: `decodable ${oracle.asm}`, actual: decoded.fields?.reason ?? 'unknown' });
  }
  return mismatches;
}

/**
 * Cross-check Hex's instruction-word field extraction against Capstone's own
 * structured operands.
 *
 * Capstone's RISC-V printer normalises to pseudo-instructions and omits
 * implicit operands, so it is used as a containment oracle: every register and
 * memory base Capstone names must appear among the register fields Hex
 * recovered. A register Capstone reports that Hex did not recover is a real
 * decode divergence.
 */
export function compareWithCapstoneOperands(decoded, capstoneOperands) {
  if (!Array.isArray(capstoneOperands) || decoded?.fields?.supported !== true) return [];
  const fields = decoded.fields;
  const recovered = [fields.rd, fields.rs1, fields.rs2]
    .filter(Boolean)
    .map((value) => normalizeRiscv64RegisterName(value))
    .filter(Boolean);
  const mismatches = [];
  for (const operand of capstoneOperands) {
    const reported = operand.type === 'register' ? operand.registerId
      : operand.type === 'memory' ? operand.base
        : null;
    if (reported) {
      const canonical = normalizeRiscv64RegisterName(reported);
      if (!canonical) {
        mismatches.push({ kind: 'unresolvable-capstone-register', expected: 'canonical physical register', actual: reported });
        continue;
      }
      if (!recovered.includes(canonical)) {
        mismatches.push({ kind: 'register-field', expected: canonical, actual: recovered.join(',') || '(none)' });
      }
    }
    // Immediates matter as much as registers: a wrong compressed offset would
    // still name the right registers. Capstone prints control-transfer
    // immediates as absolute targets and everything else as the raw value.
    if (operand.type === 'memory' && operand.displacement != null) {
      const expected = BigInt(operand.displacement);
      const actual = fields.imm == null ? null : BigInt(fields.imm);
      if (actual == null || actual !== expected) {
        mismatches.push({ kind: 'memory-displacement', expected: String(expected), actual: String(actual) });
      }
    } else if (operand.type === 'immediate' && operand.value != null) {
      const expected = BigInt(operand.value);
      const actual = capstoneImmediateEquivalent(decoded);
      if (actual == null || actual !== expected) {
        mismatches.push({ kind: 'immediate-field', expected: String(expected), actual: actual == null ? '(none)' : String(actual) });
      }
    }
  }
  return mismatches;
}

/**
 * The value Capstone reports for this instruction's immediate operand,
 * expressed from the fields Hex recovered.
 *
 * The Capstone RISC-V module reports branch and jump immediates as the raw
 * PC-relative offset (its printer shows the same number), so those compare
 * directly. Shift amounts compare as shift amounts, and the upper-immediate
 * forms report the unshifted encoded field rather than the formed value.
 */
function capstoneImmediateEquivalent(decoded) {
  const fields = decoded.fields;
  if (fields.shamt != null) return BigInt(fields.shamt);
  if (fields.imm == null) return null;
  if (fields.op === 'lui') {
    // Capstone prints the raw 20-bit LUI field, while the decoded value is the
    // sign-extended result. `c.lui` places its bits directly, so it has no shift.
    return fields.expandedFrom === 'c.lui'
      ? BigInt(fields.imm)
      : BigInt.asUintN(20, BigInt(fields.imm) >> 12n);
  }
  if (fields.op === 'auipc') return BigInt.asUintN(20, BigInt(fields.imm) >> 12n);
  return BigInt(fields.imm);
}

/** Re-decode raw bytes independently of any session state. */
export function decodeOracleBytes(bytes) {
  return decodeRiscv64InstructionWord(bytes);
}
