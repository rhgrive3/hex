import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import '../../../js/targets/architecture/riscv64/capstone-structured.js';
import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Open the *deployed* capstone.js/capstone.wasm for RV64 with the compressed
 * extension enabled and structured detail on.
 *
 * This deliberately probes the shipped artifact rather than trusting upstream
 * Capstone release notes: what upstream supports is not evidence about what
 * Hex actually ships.
 */
export async function createCapstoneRiscv64Session() {
  const modulePath = path.join(os.tmpdir(), `hex-p6-capstone-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.copyFileSync(path.join(root, 'capstone.js'), modulePath);
  const require = createRequire(import.meta.url);
  const factory = require(modulePath);
  const M = await factory({ locateFile:(name) => path.join(root, name), print:()=>{}, printErr:()=>{} });
  const bridge = globalThis.HexRiscv64CapstoneStructured;
  bridge.verifyVersion(M);
  const handlePointer = M._malloc(4);
  const outputPointer = M._malloc(4);
  const mode = M.MODE_RISCV64 | M.MODE_RISCVC | M.MODE_LITTLE_ENDIAN;
  const opened = M.ccall('cs_open', 'number', ['number','number','pointer'], [M.ARCH_RISCV, mode, handlePointer]);
  if (opened !== 0) throw new Error(`phase6-capstone-open-failed:${opened}`);
  const handle = M.getValue(handlePointer, 'i32');
  const detail = M.ccall('cs_option', 'number', ['number','number','number'], [handle, M.OPT_DETAIL, M.OPT_ON]);
  if (detail !== 0) throw new Error(`phase6-capstone-detail-failed:${detail}`);

  /** Raw decoder rows: boundaries, bytes, display text, Capstone's own operands. */
  function decodeRaw(bytes, startAddress) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const buffer = M._malloc(Math.max(1, input.length));
    if (input.length) M.writeArrayToMemory(input, buffer);
    const count = M.ccall('cs_disasm', 'number', ['number','number','number','number','number','number'], [handle, buffer, input.length, BigInt(startAddress), 0, outputPointer]);
    const pointer = count ? M.getValue(outputPointer, 'i32') : 0;
    try {
      const rows = [];
      for (let index = 0; index < count; index += 1) {
        const instructionPointer = pointer + index * bridge.ABI.instructionSize;
        const address = BigInt(M.getValue(instructionPointer + 8, 'i64'));
        rows.push(bridge.parseInstruction(M, handle, instructionPointer, { address, mode:'rv64imc' }));
      }
      return rows;
    } finally {
      if (pointer) M.ccall('cs_free', 'void', ['number','number'], [pointer, count]);
      M._free(buffer);
    }
  }

  /** Decoder rows normalized through the canonical decoded-instruction contract. */
  function decode(bytes, startAddress) {
    return decodeRaw(bytes, startAddress).map((raw) => createRiscv64DecodedInstruction(raw));
  }

  function close() {
    M.ccall('cs_close', 'number', ['pointer'], [handlePointer]);
    M._free(outputPointer);
    M._free(handlePointer);
    try { fs.unlinkSync(modulePath); } catch { /* best effort */ }
  }

  return Object.freeze({ decode, decodeRaw, close, mode });
}
