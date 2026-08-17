import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import '../../../js/targets/architecture/x86_64/capstone-structured.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export async function createCapstoneX86Session() {
  const modulePath = path.join(os.tmpdir(), `hex-p5-capstone-session-${process.pid}-${Date.now()}.cjs`);
  fs.copyFileSync(path.join(root, 'capstone.js'), modulePath);
  const require = createRequire(import.meta.url);
  const factory = require(modulePath);
  const M = await factory({ locateFile:(name) => path.join(root, name), print:()=>{}, printErr:()=>{} });
  const bridge = globalThis.HexX86CapstoneStructured;
  bridge.verifyVersion(M);
  const handlePointer = M._malloc(4);
  const outputPointer = M._malloc(4);
  const opened = M.ccall('cs_open', 'number', ['number','number','pointer'], [M.ARCH_X86, M.MODE_64 | M.MODE_LITTLE_ENDIAN, handlePointer]);
  if (opened !== 0) throw new Error(`phase5-capstone-open-failed:${opened}`);
  const handle = M.getValue(handlePointer, 'i32');
  const detail = M.ccall('cs_option', 'number', ['number','number','number'], [handle, M.OPT_DETAIL, M.OPT_ON]);
  if (detail !== 0) throw new Error(`phase5-capstone-detail-failed:${detail}`);

  function decode(bytes, startAddress) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const buffer = M._malloc(Math.max(1, input.length));
    if (input.length) M.writeArrayToMemory(input, buffer);
    const count = M.ccall('cs_disasm', 'number', ['number','number','number','number','number','number'], [handle, buffer, input.length, BigInt(startAddress), 0, outputPointer]);
    const pointer = M.getValue(outputPointer, 'i32');
    try {
      const instructions = [];
      for (let index = 0; index < count; index++) {
        const instructionPointer = pointer + index * bridge.ABI.instructionSize;
        const address = BigInt(M.getValue(instructionPointer + 8, 'i64'));
        instructions.push(bridge.parseInstruction(M, handle, instructionPointer, { address, mode:'long-64' }));
      }
      return instructions;
    } finally {
      if (pointer) M.ccall('cs_free', 'void', ['number','number'], [pointer, count]);
      M._free(buffer);
    }
  }

  function close() {
    M.ccall('cs_close', 'number', ['pointer'], [handlePointer]);
    M._free(outputPointer);
    M._free(handlePointer);
    try { fs.unlinkSync(modulePath); } catch { /* best effort */ }
  }
  return Object.freeze({ decode, close });
}
