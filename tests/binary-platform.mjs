import assert from 'node:assert/strict';
import { auditBinary, openBinarySource } from '../js/binary/index.js';
import { makeElf64Fixture, makePe64Fixture } from './universal-binary.mjs';

for (const [name, bytes, format] of [['elf', makeElf64Fixture(), 'elf'], ['pe', makePe64Fixture(), 'pe']]) {
  let largest = 0;
  const source = {
    size: BigInt(bytes.length),
    async read(offset, length) {
      largest = Math.max(largest, length);
      const start = Number(offset);
      return bytes.subarray(start, start + length);
    },
  };
  const image = await openBinarySource(source, { ranges: { pageSize: 64, maxCachedBytes: 1024 * 1024 } });
  assert.equal(image.format, format, name);
  assert.equal(image.bytes, null, `${name}: source-backed image must not retain full bytes`);
  assert.equal(auditBinary(image).errors, 0, `${name}: source-backed audit`);
  assert.ok(largest < bytes.length, `${name}: parser requested entire binary in one read`);
}
console.log('binary-platform: PASS');
