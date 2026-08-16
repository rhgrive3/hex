import assert from 'node:assert/strict';
import {
  addWithFlags,
  arm64GpRegisterWrite,
  arm64VariableShift,
  asr,
  calculateArm64Address,
  compareSigned,
  compareUnsigned,
  conditionHolds,
  lsl,
  lsr,
  pcRelativeTarget,
  ror,
  subWithFlags,
} from '../../tools/validation/machine-effects/independent-oracle.mjs';

// Overflow/carry are intentionally checked independently from legacy v1 IR.
assert.deepEqual(addWithFlags(0xffffffffn, 1n, 32), { result:0n, N:0, Z:1, C:1, V:0 });
assert.deepEqual(addWithFlags(0x7fffffffn, 1n, 32), { result:0x80000000n, N:1, Z:0, C:0, V:1 });
assert.deepEqual(addWithFlags(0xffffffffffffffffn, 1n, 64), { result:0n, N:0, Z:1, C:1, V:0 });
assert.deepEqual(subWithFlags(0n, 1n, 32), { result:0xffffffffn, N:1, Z:0, C:0, V:0 });
assert.deepEqual(subWithFlags(0x80000000n, 1n, 32), { result:0x7fffffffn, N:0, Z:0, C:1, V:1 });

// Signedness must not be inferred from the same bit pattern.
assert.equal(compareSigned(0xffffffffn, 1n, 32), -1);
assert.equal(compareUnsigned(0xffffffffn, 1n, 32), 1);
assert.equal(compareSigned(0x8000000000000000n, 0n, 64), -1);

// Shift/rotate edge vectors, including ARM64 variable-shift modulo register width.
assert.equal(lsl(1n, 31, 32), 0x80000000n);
assert.equal(lsl(1n, 32, 32), 0n);
assert.equal(lsr(0x80000000n, 1, 32), 0x40000000n);
assert.equal(asr(0x80000000n, 1, 32), 0xc0000000n);
assert.equal(asr(0x80000000n, 32, 32), 0xffffffffn);
assert.equal(ror(0x80000001n, 1, 32), 0xc0000000n);
assert.equal(arm64VariableShift('lsl', 0x12345678n, 32n, 32), 0x12345678n);
assert.equal(arm64VariableShift('ror', 0x12345678n, 36n, 32), ror(0x12345678n, 4, 32));

// Address calculation: offset/pre/post and signed register-offset extension.
assert.deepEqual(calculateArm64Address({ base:0x1000n, displacement:0x20n, mode:'offset' }), { address:0x1020n, writeback:null });
assert.deepEqual(calculateArm64Address({ base:0x1000n, displacement:-0x10n, mode:'pre' }), { address:0xff0n, writeback:0xff0n });
assert.deepEqual(calculateArm64Address({ base:0x1000n, displacement:0x10n, mode:'post' }), { address:0x1000n, writeback:0x1010n });
assert.deepEqual(calculateArm64Address({ base:0x1000n, index:0xffffffffn, indexBits:32, extend:'sxtw', shift:2, mode:'offset' }), { address:0xffcn, writeback:null });
assert.deepEqual(calculateArm64Address({ base:0x1000n, index:3n, indexBits:32, extend:'uxtw', shift:2, mode:'offset' }), { address:0x100cn, writeback:null });

// A W-register write zero-extends into the 64-bit physical X register; ZR discards writes.
assert.deepEqual(arm64GpRegisterWrite('w8', 0xffffffffffffffffn, 32), {
  ignored:false,
  physicalRegister:'x8',
  value:0xffffffffn,
  widthBits:64,
  sourceWidthBits:32,
});
assert.deepEqual(arm64GpRegisterWrite('x8', 0xffffffffffffffffn, 64).value, 0xffffffffffffffffn);
assert.equal(arm64GpRegisterWrite('wzr', 123n, 32).ignored, true);

// Condition-code truth table samples from independently calculated NZCV.
const signedOverflow = addWithFlags(0x7fffffffn, 1n, 32);
assert.equal(signedOverflow.N, 1);
assert.equal(signedOverflow.V, 1);
assert.equal(conditionHolds(signedOverflow, 'lt'), false, 'LT is N != V; overflow correction makes this false');
assert.equal(conditionHolds(signedOverflow, 'ge'), true, 'GE is N == V');
const unsignedBorrow = subWithFlags(0n, 1n, 32);
assert.equal(conditionHolds(unsignedBorrow, 'lo'), true);
assert.equal(conditionHolds(unsignedBorrow, 'hs'), false);
const equal = subWithFlags(42n, 42n, 64);
assert.equal(conditionHolds(equal, 'eq'), true);
assert.equal(conditionHolds(equal, 'ne'), false);

// Branch targets are bit-width wrapped addresses, independent of disassembly text.
assert.equal(pcRelativeTarget(0x1000n, 0x40n), 0x1040n);
assert.equal(pcRelativeTarget(0x1000n, -4n), 0xffcn);
assert.equal(pcRelativeTarget(0xfffffffffffffffcn, 8n), 4n);

console.log('machine-effects independent semantic properties: PASS');
