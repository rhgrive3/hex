import assert from 'node:assert/strict';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildMinimalDex } from './dex-parser.test.mjs';

console.log('[phase11] running dex adversarial tests...');

// 1. Truncated header
assert.throws(() => {
  parseDex(new Uint8Array([0x64, 0x65, 0x78, 0x0a, 0x30]));
}, /dex-unsupported-binary/);

// 2. File size mismatch / overflow
const badSizeDex = buildMinimalDex();
new DataView(badSizeDex.buffer).setUint32(32, 0x100000, true); // claims 1MB
assert.throws(() => {
  parseDex(badSizeDex);
}, /dex-file-size-mismatch/);

// 3. Bad string offset
const badStrDex = buildMinimalDex();
new DataView(badStrDex.buffer).setUint32(0x70, 0xffff, true); // string 0 offset out of bounds
assert.throws(() => {
  parseDex(badStrDex);
}, /dex-invalid-string-data-offset/);

console.log('  ok dex adversarial tests passed');
