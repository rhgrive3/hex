import assert from 'node:assert/strict';
import test from 'node:test';

import { symbolizePeDisassembly } from '../../../tools/validation/phase5/build-verification-corpus.mjs';
import { parseLlvmObjdump } from '../../../tools/validation/phase5/llvm-oracle.mjs';

test('LLVM oracle fuses a standalone lock prefix with its contiguous instruction', () => {
  const functions = parseLlvmObjdump(`
0000000000401000 <p5_atomic_rmw>:
  401000: f0                           lock
  401001: 48 0f c1 05 01 00 00 00      xaddq %rax, 0x1(%rip)
  401009: c3                           retq
`);
  const fn = functions.get('p5_atomic_rmw');
  assert.ok(fn);
  assert.equal(fn.instructions.length, 2);
  assert.equal(fn.instructions[0].address, 0x401000n);
  assert.deepEqual([...fn.instructions[0].bytes], [0xf0,0x48,0x0f,0xc1,0x05,0x01,0x00,0x00,0x00]);
  assert.equal(fn.instructions[0].mnemonic, 'xaddq');
  assert.match(fn.instructions[0].asm, /^lock xaddq/);
});

test('PE export RVAs inject independent function boundaries into section-only objdump', () => {
  const raw = `
0000000140001000 <.text>:
140001000: 55                           pushq %rbp
140001001: c3                           retq
140001010: 55                           pushq %rbp
140001011: c3                           retq
`;
  const metadata = `
Export {
  Ordinal: 1
  Name: p5_scalar_integer_arithmetic
  RVA: 0x1000
}
Export {
  Ordinal: 2
  Name: p5_atomic_rmw
  RVA: 0x1010
}
`;
  const symbolized = symbolizePeDisassembly(raw, metadata);
  const functions = parseLlvmObjdump(symbolized);
  assert.equal(functions.get('p5_scalar_integer_arithmetic')?.address, 0x140001000n);
  assert.equal(functions.get('p5_atomic_rmw')?.address, 0x140001010n);
  assert.equal(functions.get('p5_scalar_integer_arithmetic')?.instructions.length, 2);
  assert.equal(functions.get('p5_atomic_rmw')?.instructions.length, 2);
});
