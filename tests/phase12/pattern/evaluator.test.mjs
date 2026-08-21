import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern, parsePattern, patternSupportTruth } from '../../../js/pattern/index.js';

const compiled = compilePattern('struct Header { magic: u32le; count: u8[4]; }', { snapshotId: 'snapshot-a' });
const bytes = Uint8Array.from([0x78, 0x56, 0x34, 0x12, 1, 2, 3, 4]);
const result = evaluatePattern(compiled, { snapshotId: 'snapshot-a', read: (offset, length) => bytes.slice(Number(offset), Number(offset) + length), size: bytes.length });
assert.equal(result.status, 'complete');
assert.equal(result.value.fields.magic.value, 0x12345678);
assert.equal(result.value.fields.count.length, 4);
assert.equal(result.value.fields.count.expand(2).value, 3);
assert.equal(result.value.fields.count.expand(2).provenance.offset, '6');
assert.equal(patternSupportTruth().mutation, 'unsupported');
assert.throws(() => evaluatePattern(compiled, bytes, { snapshotId: 'snapshot-b' }), /snapshot-mismatch/);

const dynamic = compilePattern({ kind: 'struct', name: 'Dynamic', fields: [
  { name: 'count', type: { kind: 'primitive', name: 'u8' } },
  { name: 'values', type: { kind: 'array', element: { kind: 'primitive', name: 'u8' }, count: 'count' } },
] });
const dynamicResult = evaluatePattern(dynamic, Uint8Array.from([3, 9, 8, 7]), { maxEntries: 1 });
assert.equal(dynamicResult.status, 'complete');
assert.equal(dynamicResult.value.fields.values.length, 3);
assert.equal(dynamicResult.value.fields.values.expand(0).value, 9);
const bomb = evaluatePattern(dynamic, Uint8Array.from([255, 1, 2, 3]), { maxEntries: 1 });
assert.equal(bomb.status, 'complete', 'lazy array declaration itself is bounded');
assert.equal(bomb.value.fields.values.expand(0).value, 1);
assert.throws(() => compilePattern('{"kind":"script","source":"while(true){}"}'), /pattern-root-must-be-struct/);
console.log('[phase12] bounded declarative pattern tests passed');
