import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEPLOYED_CAPSTONE_SUPPORT } from '../../../js/platform/capstone-capability.js';
import { decodeRiscv64InstructionWord, riscvInstructionLength } from '../../../js/targets/architecture/riscv64/instruction-word.js';
import { createRiscv64DecodedInstruction } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { compareWithCapstoneOperands } from '../../../tools/validation/phase6/llvm-oracle.mjs';
import { createCapstoneRiscv64Session } from '../helpers/capstone-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase6/profile.json'), 'utf8'));

test('the frozen profile is bound to the exact deployed decoder artifacts', () => {
  for (const artifact of PROFILE.decoder.deployedArtifacts) {
    const bytes = fs.readFileSync(path.join(ROOT, artifact.path));
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, artifact.sha256,
      `${artifact.path} changed. Upstream capability is not evidence about the shipped Hex artifact: re-probe the bundle and update the frozen profile deliberately.`);
    assert.ok(bytes.length > 0, `${artifact.path} must not be empty`);
  }
});

test('the deployed Capstone build really opens RISC-V64 with the compressed extension and structured detail', async () => {
  const capstone = await createCapstoneRiscv64Session();
  try {
    assert.ok(capstone.mode > 0, 'RV64 + compressed + little-endian mode must be constructible');
    // `nop` (addi x0, x0, 0) followed by `c.nop`: proves both widths decode.
    const bytes = Uint8Array.from([0x13, 0x00, 0x00, 0x00, 0x01, 0x00]);
    const rows = capstone.decodeRaw(bytes, 0x1000n);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].size, 4);
    assert.equal(rows[1].size, 2);
    assert.equal(rows[1].address, 0x1004n);
    assert.ok(Array.isArray(rows[0].capstoneOperands), 'structured detail must be available, not just display text');
  } finally { capstone.close(); }
});

test('RISC-V decode support is declared only where the deployed bundle proves it', () => {
  // Phase 6 declares RISC-V decode through the architecture plugin and the
  // capability profile. The legacy DEPLOYED_CAPSTONE_SUPPORT map describes the
  // two architectures the legacy probe worker offers and is left alone here so
  // no capability is claimed by editing a constant instead of probing.
  assert.equal(DEPLOYED_CAPSTONE_SUPPORT.arm64, true);
  assert.equal(DEPLOYED_CAPSTONE_SUPPORT.x86_64, true);
  assert.equal(Object.prototype.hasOwnProperty.call(DEPLOYED_CAPSTONE_SUPPORT, 'riscv64'), false);
});

test('instruction length comes from the encoding, and malformed widths fail closed', () => {
  assert.equal(riscvInstructionLength(0x0001), 2);
  assert.equal(riscvInstructionLength(0x0013), 4);
  assert.equal(riscvInstructionLength(0x001f), 6);
  assert.equal(riscvInstructionLength(0x003f), 8);

  // A 4-byte encoding handed over as 2 bytes must not be silently accepted.
  const truncated = decodeRiscv64InstructionWord(Uint8Array.from([0x13, 0x00]));
  assert.equal(truncated.supported, false);
  assert.equal(truncated.reason, 'riscv64-instruction-length-disagrees-with-encoding');

  assert.throws(() => createRiscv64DecodedInstruction({
    address: 0x1000n, size: 4, rawBytes: Uint8Array.from([0x13, 0x00, 0x00]),
  }), /byte-length-mismatch/);

  assert.throws(() => createRiscv64DecodedInstruction({
    address: 0x1000n, size: 3, rawBytes: Uint8Array.from([0x13, 0x00, 0x00]),
  }), /invalid-length/);
});

test('encodings outside the frozen profile decode to explicit unsupported, never to a nop', () => {
  const cases = [
    { bytes: [0x2f, 0xa5, 0xb5, 0x00], expect: /atomic-extension-outside-phase6-profile/ },   // amoadd.w
    { bytes: [0x53, 0x75, 0xb5, 0x02], expect: /floating-point-extension-outside-phase6-profile/ }, // fadd.d
    { bytes: [0x73, 0x25, 0x00, 0xc0], expect: /zicsr-outside-phase6-profile/ },              // csrr a0, cycle
  ];
  for (const item of cases) {
    const decoded = decodeRiscv64InstructionWord(Uint8Array.from(item.bytes));
    assert.equal(decoded.supported, false, `expected unsupported for ${item.bytes.map((b) => b.toString(16)).join(' ')}`);
    assert.match(decoded.reason, item.expect);
  }
});

test('ISA field extraction agrees with Capstone structured operands across the profile', async () => {
  const capstone = await createCapstoneRiscv64Session();
  try {
    // A representative mixed-width stream: compressed and uncompressed forms of
    // arithmetic, loads, stores, branches and control transfers.
    const bytes = Uint8Array.from([
      0x13, 0x05, 0xb5, 0xff,       // addi a0, a0, -5
      0x3b, 0x85, 0xb5, 0x00,       // addw a0, a1, a1
      0x83, 0x35, 0x05, 0x00,       // ld a1, 0(a0)
      0x23, 0x30, 0xb5, 0x00,       // sd a1, 0(a0)
      0x63, 0x04, 0xb5, 0x00,       // beq a0, a1, +8
      0x97, 0x05, 0x00, 0x00,       // auipc a1, 0
      0x67, 0x80, 0x00, 0x00,       // jr ra
      0x2a, 0x95,                   // c.add a0, a0
      0x81, 0x45,                   // c.li a1, 0
    ]);
    const raw = capstone.decodeRaw(bytes, 0x2000n);
    const decoded = capstone.decode(bytes, 0x2000n);
    assert.equal(raw.length, decoded.length);
    assert.ok(decoded.length >= 8);
    for (let index = 0; index < decoded.length; index += 1) {
      assert.equal(decoded[index].fields.supported, true, `instruction ${index} must decode within the frozen profile`);
      assert.deepEqual(
        compareWithCapstoneOperands(decoded[index], raw[index].capstoneOperands),
        [],
        `ISA field extraction disagrees with Capstone at ${decoded[index].mnemonic} ${decoded[index].opStr}`,
      );
    }
  } finally { capstone.close(); }
});

test('the decoded-instruction contract carries display text but the semantic layer never needs it', async () => {
  const capstone = await createCapstoneRiscv64Session();
  try {
    // `jal ra, 0` and `jal x0, 0` print identically through Capstone's RISC-V
    // pseudo-instruction printer, which is exactly why the semantic front end
    // reads the instruction word instead of the mnemonic.
    const call = createRiscv64DecodedInstruction(capstone.decodeRaw(Uint8Array.from([0xef, 0x00, 0x00, 0x00]), 0x3000n)[0]);
    const jump = createRiscv64DecodedInstruction(capstone.decodeRaw(Uint8Array.from([0x6f, 0x00, 0x00, 0x00]), 0x3000n)[0]);
    assert.equal(call.fields.op, 'jal');
    assert.equal(jump.fields.op, 'jal');
    assert.equal(call.fields.rd, 'x1', 'jal with rd=ra must be recovered as writing x1');
    assert.equal(jump.fields.rd, 'x0', 'jal with rd=zero must be recovered as writing x0');
    assert.notEqual(call.fields.rd, jump.fields.rd, 'the two encodings differ architecturally even when they print alike');
  } finally { capstone.close(); }
});
