import assert from 'node:assert/strict';
import { pseudocSamples, shardFunctionStarts } from './accuracy-pseudoc-shard-oracle.mjs';

const starts = [];
let addr = 0x1000;
for (let i = 0; i < 400; i++) {
  starts.push(addr);
  addr += i % 7 === 0 ? 4096 : 64 + (i % 9) * 16;
}

const serial = pseudocSamples(starts);
assert.equal(serial.length, 120, 'fixture must exercise the same 120-sample cap as accuracy.mjs');

// Two GitHub jobs per target each own four runner-local workers. The eight
// local shards must still cover the exact serial 120-function sample once.
const shardCount = 8;
const shards = Array.from({ length: shardCount }, (_, index) => shardFunctionStarts(starts, index, shardCount).selected);
assert.deepEqual(
  shards.flat().sort((a, b) => a[0] - b[0]),
  serial.slice().sort((a, b) => a[0] - b[0]),
  '8 runner-local shards must cover the exact serial sample set once',
);
assert.deepEqual(shards.map((rows) => rows.length), Array(shardCount).fill(15));

for (let outer = 0; outer < 2; outer++) {
  const local = [0, 1, 2, 3].map((worker) => shards[outer + worker * 2]).flat();
  const expected = serial.filter((_, index) => index % 2 === outer);
  assert.deepEqual(
    local.slice().sort((a, b) => a[0] - b[0]),
    expected.slice().sort((a, b) => a[0] - b[0]),
    `outer shard ${outer} must be the exact union of its four local workers`,
  );
}

console.log('accuracy pseudoc runner-local sharding regression passed');
