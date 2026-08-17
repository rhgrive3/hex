import assert from 'node:assert/strict';
import { pseudocSamples } from './accuracy-pseudoc-shard-oracle.mjs';

const starts = [];
let addr = 0x1000;
for (let i = 0; i < 400; i++) {
  starts.push(addr);
  addr += i % 7 === 0 ? 4096 : 64 + (i % 9) * 16;
}

const first = pseudocSamples(starts);
const second = pseudocSamples(starts);
assert.equal(first.length, 120, 'fixture must exercise the same 120-sample cap as accuracy.mjs');
assert.deepEqual(second, first, 'canonical pseudoc sampling must remain deterministic');
for (const [start, end] of first) {
  const bytes = end - start;
  assert.ok(bytes >= 64 && bytes <= 2048, `sample size must remain eligible: ${bytes}`);
}
assert.equal(new Set(first.map(([start]) => start)).size, first.length, 'canonical samples must be unique');

console.log('accuracy pseudoc canonical sampling regression passed');
