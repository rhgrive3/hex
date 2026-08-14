import assert from 'node:assert/strict';
import { functionSeed, mergeFunctionSeeds } from '../js/binary/index.js';

// Adjacent linker-emitted starts prove two starts, not the bytes in-between.
// Padding, literal pools or code islands may exist before the next function.
const starts = mergeFunctionSeeds([
  functionSeed(0x1000n, { source: 'function_starts', confidence: 0.995 }),
  functionSeed(0x1010n, { source: 'function_starts', confidence: 0.995 }),
]);
assert.equal(starts[0].size, null);
assert.equal(starts[0].end, null);
assert.equal(starts[0].nextStart, 0x1010n);
assert.equal(starts[1].nextStart, null);

// PE x64 RUNTIME_FUNCTION / other explicit begin-end metadata is an exact size.
const exact = mergeFunctionSeeds([
  functionSeed(0x2000n, { size: 0x34n, source: 'exception', confidence: 0.999 }),
  functionSeed(0x2034n, { source: 'exception', confidence: 0.999 }),
]);
assert.equal(exact[0].size, 0x34n);
assert.equal(exact[0].end, 0x2034n);
assert.equal(exact[0].nextStart, 0x2034n);

// Multiple independent sources at one address retain provenance without
// downgrading the exact size supplied by the stronger source.
const merged = mergeFunctionSeeds([
  functionSeed(0x3000n, { source: 'entrypoint', confidence: 0.9 }),
  functionSeed(0x3000n, { size: 0x20n, source: 'exception', confidence: 0.999 }),
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].size, 0x20n);
assert.equal(merged[0].end, 0x3020n);
assert.ok(merged[0].sources.includes('entrypoint'));
assert.ok(merged[0].sources.includes('exception'));

console.log('universal-binary-boundaries: PASS');
