import assert from 'node:assert/strict';
import { parseJvm } from '../../../js/managed/jvm/parser.js';

console.log('[phase11] running jvm adversarial tests...');

// 1. Truncated header
assert.throws(() => {
  parseJvm(new Uint8Array([0xca, 0xfe]));
}, /jvm-unsupported-binary/);

// 2. Truncated constant pool
assert.throws(() => {
  parseJvm(new Uint8Array([
    0xca, 0xfe, 0xba, 0xbe,
    0x00, 0x00, 0x00, 0x3d, // major 61
    0x00, 0x10,             // claims 16 CP entries but truncated
  ]));
}, /jvm-truncated-constant-pool/);

console.log('  ok jvm adversarial tests passed');
