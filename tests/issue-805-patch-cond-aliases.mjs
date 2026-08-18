import assert from 'node:assert/strict';
import { assemble, suggestPatches } from '../js/patch.js';

const AT = 0x1000n;
const TARGET = 0x1010n;

function assembleBranch(cond) {
  const result = assemble(`b.${cond} 0x${TARGET.toString(16)}`, AT);
  assert.equal(result.error, undefined, `b.${cond} must assemble without fallback`);
  assert.equal(result.bytes?.length, 4, `b.${cond} must produce one ARM64 instruction`);
  return result.bytes;
}

function wordOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

assert.deepEqual(Array.from(assembleBranch('hs')), Array.from(assembleBranch('cs')),
  'hs must encode identically to cs');
assert.deepEqual(Array.from(assembleBranch('lo')), Array.from(assembleBranch('cc')),
  'lo must encode identically to cc');
assert.equal(wordOf(assembleBranch('hs')) & 0xf, 0x2, 'hs/cs condition code must be 0x2');
assert.equal(wordOf(assembleBranch('lo')) & 0xf, 0x3, 'lo/cc condition code must be 0x3');

for (const alias of ['hs', 'lo']) {
  const invert = suggestPatches(`b.${alias}`, `#0x${TARGET.toString(16)}`, AT)
    .find((candidate) => candidate.id === 'invert');
  assert.ok(invert, `b.${alias} must offer an invert patch`);
  const roundTrip = assemble(invert.text, AT);
  assert.equal(roundTrip.error, undefined,
    `${invert.text} emitted by suggestPatches must round-trip through assemble`);
  assert.equal(roundTrip.bytes?.length, 4, 'round-trip patch must encode to one instruction');
}

process.stdout.write('issue #805 patch condition aliases: ok\n');
