import assert from 'node:assert/strict';
import { Emulator } from '../../js/emu.js';

async function exec(emu, mnemonic, operands) { return emu.execute(mnemonic, operands, 0x1000n); }
async function setD(emu, index, bits) {
  emu.set(`x${index}`, BigInt(bits));
  await exec(emu, 'fmov', `d${index}, x${index}`);
}
async function setS(emu, index, bits) {
  emu.set(`w${index}`, BigInt(bits));
  await exec(emu, 'fmov', `s${index}, w${index}`);
}
async function rawD(emu, fp, gp) {
  await exec(emu, 'fmov', `x${gp}, d${fp}`);
  return emu.get(`x${gp}`);
}
async function rawS(emu, fp, gp) {
  await exec(emu, 'fmov', `w${gp}, s${fp}`);
  return emu.get(`w${gp}`);
}

// #833 — canonical GP<->FP bit-transfer examples in addition to payload tests.
{
  const emu = new Emulator();
  await setD(emu, 0, 0x3ff0000000000000n); // +1.0
  assert.equal(await rawD(emu, 0, 1), 0x3ff0000000000000n);
  await setS(emu, 2, 0x3fc00000n); // +1.5f
  assert.equal(await rawS(emu, 2, 3), 0x3fc00000n);
  await setD(emu, 4, 0n); // +0
  assert.equal(await rawD(emu, 4, 5), 0n);
  await setD(emu, 6, 0x7ff0000000000000n); // +inf
  assert.equal(await rawD(emu, 6, 7), 0x7ff0000000000000n);
  await setS(emu, 8, 0xff800000n); // -inf
  assert.equal(await rawS(emu, 8, 9), 0xff800000n);
  await setD(emu, 10, 0x7ff8123456789abcn); // quiet NaN with payload
  assert.equal(await rawD(emu, 10, 11), 0x7ff8123456789abcn);
  await exec(emu, 'fmov', 'd12, d10');
  assert.equal(await rawD(emu, 12, 13), 0x7ff8123456789abcn, 'FP-to-FP keeps the payload bit-for-bit');
}

// #803 — subnormal, infinity and NaN behavior remains inside the fused helper.
{
  const emu = new Emulator();
  await setD(emu, 0, 0x1n);                  // minimum positive binary64 subnormal
  await setD(emu, 1, 0x3ff0000000000000n);   // 1
  await setD(emu, 2, 0n);                    // +0
  await exec(emu, 'fmadd', 'd3, d0, d1, d2');
  assert.equal(await rawD(emu, 3, 4), 0x1n, 'minimum binary64 subnormal survives exact fused multiply-add');
}
{
  const emu = new Emulator();
  await setS(emu, 0, 0x1n);          // minimum positive binary32 subnormal
  await setS(emu, 1, 0x3f800000n);   // 1
  await setS(emu, 2, 0n);
  await exec(emu, 'fmadd', 's3, s0, s1, s2');
  assert.equal(await rawS(emu, 3, 4), 0x1n, 'minimum binary32 subnormal survives exact fused multiply-add');
}
{
  const emu = new Emulator();
  await setD(emu, 0, 0x7ff0000000000000n); // +inf
  await setD(emu, 1, 0x4000000000000000n); // 2
  await setD(emu, 2, 0x3ff0000000000000n); // 1
  await exec(emu, 'fmadd', 'd3, d0, d1, d2');
  assert.equal(await rawD(emu, 3, 4), 0x7ff0000000000000n);
}
{
  const emu = new Emulator();
  // Signaling NaN is quieted while retaining payload bits.
  await setD(emu, 0, 0x7ff0123456789abcn);
  await setD(emu, 1, 0x3ff0000000000000n);
  await setD(emu, 2, 0n);
  await exec(emu, 'fmadd', 'd3, d0, d1, d2');
  assert.equal(await rawD(emu, 3, 4), 0x7ff8123456789abcn);
}

// Negated fused forms share the same exact helper with the correct A64 signs.
{
  const emu = new Emulator();
  await setD(emu, 0, 0x4000000000000000n); // 2
  await setD(emu, 1, 0x4008000000000000n); // 3
  await setD(emu, 2, 0x4010000000000000n); // 4
  await exec(emu, 'fmadd',  'd3, d0, d1, d2');
  await exec(emu, 'fmsub',  'd4, d0, d1, d2');
  await exec(emu, 'fnmadd', 'd5, d0, d1, d2');
  await exec(emu, 'fnmsub', 'd6, d0, d1, d2');
  assert.equal(await rawD(emu, 3, 7), 0x4024000000000000n); // 10
  assert.equal(await rawD(emu, 4, 7), 0xc000000000000000n); // 4 - 6 = -2
  assert.equal(await rawD(emu, 5, 7), 0xc024000000000000n); // -(6) - 4 = -10
  assert.equal(await rawD(emu, 6, 7), 0x4000000000000000n); // 6 - 4 = 2
}

console.log('issues #803/#833 FP edge-case regressions: ok');
