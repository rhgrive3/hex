import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeRiscv64InstructionWord, riscvInstructionLength } from '../../../js/targets/architecture/riscv64/instruction-word.js';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';

const DIRECT_RISCV_TRANSFERS = new Set(['jal', 'beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu']);

function bytesOf(entry) {
  return Uint8Array.from(Buffer.from(entry.bytes, 'hex'));
}

test('frozen RISC-V corpus has relocation-resolved direct control transfers', () => {
  const corpus = loadCorpus();
  const failures = [];

  for (const entry of corpus.functions.filter((item) => item.architectureId === 'riscv64')) {
    const bytes = bytesOf(entry);
    for (let offset = 0; offset < bytes.length;) {
      const length = riscvInstructionLength(bytes[offset] | (bytes[offset + 1] << 8));
      assert.ok(length === 2 || length === 4, `${entry.id}: unsupported instruction length at +${offset}`);
      const fields = decodeRiscv64InstructionWord(bytes.subarray(offset, offset + length));
      if (fields?.supported && DIRECT_RISCV_TRANSFERS.has(fields.op) && fields.imm === 0n) {
        failures.push(`${entry.id}@+${offset}:${fields.op}`);
      }
      offset += length;
    }
  }

  assert.deepEqual(failures, [],
    'the Phase 8 source corpus contains no intentional self-loop; zero direct branch displacements here mean ET_REL relocation placeholders leaked into frozen product evidence');
});
