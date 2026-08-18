import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateBundle, liftBytes, sampleValues, u64 } from './helpers.mjs';
import { createCapstoneRiscv64Session } from '../helpers/capstone-session.mjs';

/**
 * The "C" standard extension defines each compressed encoding as expanding to
 * exactly one base instruction. So the strongest available check is a
 * differential: lift the compressed form and the base form it expands to, and
 * require both to compute the same architectural state from the same inputs.
 */
const EXPANSIONS = Object.freeze([
  { name: 'c.addi a0, 1', compressed: [0x05, 0x05], base: [0x13, 0x05, 0x15, 0x00], inputs: { x10: 0n } },
  { name: 'c.addi a0, -1', compressed: [0x7d, 0x15], base: [0x13, 0x05, 0xf5, 0xff], inputs: { x10: 0n } },
  { name: 'c.li a0, 7', compressed: [0x1d, 0x45], base: [0x13, 0x05, 0x70, 0x00], inputs: {} },
  { name: 'c.mv a0, a1', compressed: [0x2e, 0x85], base: [0x33, 0x05, 0xb0, 0x00], inputs: { x11: 0n } },
  { name: 'c.add a0, a1', compressed: [0x2e, 0x95], base: [0x33, 0x05, 0xb5, 0x00], inputs: { x10: 0n, x11: 0n } },
  { name: 'c.addiw a0, 1', compressed: [0x05, 0x25], base: [0x1b, 0x05, 0x15, 0x00], inputs: { x10: 0n } },
  { name: 'c.slli a0, 3', compressed: [0x0e, 0x05], base: [0x13, 0x15, 0x35, 0x00], inputs: { x10: 0n } },
  { name: 'c.and a0, a1', compressed: [0x6d, 0x8d], base: [0x33, 0x75, 0xb5, 0x00], inputs: { x10: 0n, x11: 0n } },
  { name: 'c.or a0, a1', compressed: [0x4d, 0x8d], base: [0x33, 0x65, 0xb5, 0x00], inputs: { x10: 0n, x11: 0n } },
  { name: 'c.xor a0, a1', compressed: [0x2d, 0x8d], base: [0x33, 0x45, 0xb5, 0x00], inputs: { x10: 0n, x11: 0n } },
  { name: 'c.sub a0, a1', compressed: [0x0d, 0x8d], base: [0x33, 0x05, 0xb5, 0x40], inputs: { x10: 0n, x11: 0n } },
  { name: 'c.subw a0, a1', compressed: [0x0d, 0x9d], base: [0x3b, 0x05, 0xb5, 0x40], inputs: { x10: 0n, x11: 0n } },
  { name: 'c.addw a0, a1', compressed: [0x2d, 0x9d], base: [0x3b, 0x05, 0xb5, 0x00], inputs: { x10: 0n, x11: 0n } },
  { name: 'c.srli a0, 3', compressed: [0x0d, 0x81], base: [0x13, 0x55, 0x35, 0x00], inputs: { x10: 0n } },
  { name: 'c.srai a0, 3', compressed: [0x0d, 0x85], base: [0x13, 0x55, 0x35, 0x40], inputs: { x10: 0n } },
  { name: 'c.andi a0, 7', compressed: [0x1d, 0x89], base: [0x13, 0x75, 0x75, 0x00], inputs: { x10: 0n } },
]);

test('every compressed encoding lifts to the same effects as the base instruction it expands to', () => {
  for (const item of EXPANSIONS) {
    const compressed = liftBytes(item.compressed, 0x1000n);
    const base = liftBytes(item.base, 0x1000n);
    assert.ok(compressed.bundle, `${item.name} compressed form must lift`);
    assert.ok(base.bundle, `${item.name} base form must lift`);
    assert.equal(compressed.decoded.size, 2, `${item.name} must be a 2-byte encoding`);
    assert.equal(base.decoded.size, 4, `${item.name} base form must be a 4-byte encoding`);
    assert.equal(compressed.bundle.completeness, 'exact');
    assert.equal(compressed.bundle.metadata.compressed, true);
    assert.ok(compressed.bundle.metadata.compressedEncoding, 'the originating compressed encoding must be recorded');
    assert.equal(compressed.decoded.fields.op, base.decoded.fields.op, `${item.name} must expand to the same base operation`);

    const registerKeys = Object.keys(item.inputs);
    for (const a of sampleValues(13n, 8)) {
      for (const b of sampleValues(17n, 4)) {
        const inputs = {};
        registerKeys.forEach((key, index) => { inputs[key] = index === 0 ? a : b; });
        const left = evaluateBundle(compressed.bundle, inputs).registers;
        const right = evaluateBundle(base.bundle, inputs).registers;
        for (const register of new Set([...left.keys(), ...right.keys()])) {
          assert.equal(left.get(register), right.get(register),
            `${item.name}: register ${register} differs between compressed and base form for inputs ${JSON.stringify(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.toString(16)])))}`);
        }
      }
    }
  }
});

test('reserved compressed encodings fail closed instead of decoding to something plausible', () => {
  const reserved = [
    { bytes: [0x00, 0x00], reason: /c-addi4spn-reserved-zero-immediate/ },  // c.addi4spn with nzuimm=0
    { bytes: [0x02, 0x80], reason: /c-jr-reserved-zero-rs1/ },              // c.jr x0
  ];
  for (const item of reserved) {
    const { decoded } = liftBytes(item.bytes);
    assert.equal(decoded.fields.supported, false, `${item.bytes.map((b) => b.toString(16))} must not decode`);
    assert.match(decoded.fields.reason, item.reason);
  }
});

test('a mixed-width stream keeps decoder-proven boundaries across the compressed/uncompressed transition', async () => {
  const capstone = await createCapstoneRiscv64Session();
  try {
    // c.li a0,7 | addi a1,a1,1 | c.add a0,a1 | ld a2,0(a0)
    const bytes = Uint8Array.from([
      0x1d, 0x45,
      0x93, 0x85, 0x15, 0x00,
      0x2e, 0x95,
      0x03, 0x36, 0x05, 0x00,
    ]);
    const decoded = capstone.decode(bytes, 0x4000n);
    assert.deepEqual(decoded.map((i) => i.size), [2, 4, 2, 4]);
    assert.deepEqual(decoded.map((i) => i.address), [0x4000n, 0x4002n, 0x4006n, 0x4008n]);
    // Instruction starts must never be derived from an address/4 assumption.
    assert.equal(decoded[2].address % 4n, 2n, 'a 4-byte instruction may start at a non-4-aligned address');
    for (const instruction of decoded) assert.equal(instruction.fields.supported, true);
  } finally { capstone.close(); }
});
