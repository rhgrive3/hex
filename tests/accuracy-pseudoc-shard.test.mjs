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

const shardCount = 24;
const shards = Array.from({ length: shardCount }, (_, index) => shardFunctionStarts(starts, index, shardCount).selected);
assert.deepEqual(
  shards.flat().sort((a, b) => a[0] - b[0]),
  serial.slice().sort((a, b) => a[0] - b[0]),
  '24 shards must cover the exact serial sample set once',
);
assert.deepEqual(shards.map((rows) => rows.length), Array(shardCount).fill(5));

console.log('accuracy pseudoc exact five-function sharding regression passed');
