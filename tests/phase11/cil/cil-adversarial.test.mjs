import assert from 'node:assert/strict';
import { parseCil, readCompressedInt } from '../../../js/managed/cil/parser.js';

console.log('[phase11] running cil adversarial tests...');

// 1. Truncated binary
assert.throws(() => {
  parseCil(new Uint8Array([0x4d, 0x5a]));
}, /cil-unsupported-binary/);

// 2. Corrupted compressed int
assert.throws(() => {
  readCompressedInt(new Uint8Array([0xff]), 0);
}, /cil-invalid-compressed-int/);

console.log('  ok cil adversarial tests passed');
