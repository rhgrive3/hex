// #971: ARM_THREAD_STATE64.__pc is at +256; +264 is CPSR/pad and must never become entrypoint truth.
// Keep PC and CPSR deliberately distinct so any future offset regression fails deterministically.
import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho.js';

function makeMachO({ pc = 0x100000100n, cpsr = 0x60000000, count = 68 } = {}) {
  const segCmdSize = 72;
  const threadStateBytes = count * 4;
  const threadCmdSize = 16 + threadStateBytes;
  const size = 32 + segCmdSize + threadCmdSize;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  const u32 = (o, x) => v.setUint32(o, x >>> 0, true);
  const i32 = (o, x) => v.setInt32(o, x, true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const ascii = (o, s) => { for (let i=0;i<s.length;i++) b[o+i]=s.charCodeAt(i); };
  u32(0, 0xfeedfacf); i32(4, 0x0100000c); i32(8, 0); u32(12, 2);
  u32(16, 2); u32(20, segCmdSize + threadCmdSize); u32(24, 0); u32(28, 0);
  let p = 32;
  u32(p, 0x19); u32(p+4, segCmdSize); ascii(p+8, '__TEXT');
  u64(p+24, 0x100000000n); u64(p+32, 0x1000n); u64(p+40, 0n); u64(p+48, BigInt(size));
  i32(p+56, 5); i32(p+60, 5); u32(p+64, 0); u32(p+68, 0);
  p += segCmdSize;
  u32(p, 0x5); u32(p+4, threadCmdSize); u32(p+8, 6); u32(p+12, count);
  const state = p + 16;
  if (count >= 66) u64(state + 256, pc);
  if (count >= 67) u32(state + 264, cpsr);
  return b;
}

const image = parseMachO(makeMachO());
assert.equal(image.entrypoint, 0x100000100n);
assert.equal(image.metadata.entrypointSource, 'LC_UNIXTHREAD');
assert.ok(image.functions.some((f) => f.address === 0x100000100n && f.source === 'entrypoint'));
assert.notEqual(image.entrypoint, 0x60000000n);
const truncated = parseMachO(makeMachO({ count:67 }));
assert.equal(truncated.entrypoint, null);
console.log('issue 971 Mach-O ARM64 LC_UNIXTHREAD PC regression: PASS');
