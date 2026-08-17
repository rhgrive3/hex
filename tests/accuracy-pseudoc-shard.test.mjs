import assert from 'node:assert/strict';
import {
  balancedPseudocShards,
  pseudocSamples,
  shardFunctionStarts,
} from './accuracy-pseudoc-shard-oracle.mjs';

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
const balanced = balancedPseudocShards(starts, shardCount);
const shards = Array.from(
  { length: shardCount },
  (_, index) => shardFunctionStarts(starts, index, shardCount).selected,
);
assert.deepEqual(
  shards.flat().sort((a, b) => a[0] - b[0]),
  serial.slice().sort((a, b) => a[0] - b[0]),
  '8 runner-local shards must cover the exact serial sample set once',
);
assert.deepEqual(shards.map((rows) => rows.length), Array(shardCount).fill(15));

const costs = balanced.map((shard) => shard.estimatedCost);
assert.ok(
  Math.max(...costs) <= Math.min(...costs) * 1.25,
  `estimated shard cost must stay balanced (${costs.join(', ')})`,
);

const outer0 = [0, 2, 4, 6].flatMap((index) => shards[index]);
const outer1 = [1, 3, 5, 7].flatMap((index) => shards[index]);
assert.equal(outer0.length, 60);
assert.equal(outer1.length, 60);
assert.deepEqual(
  [...outer0, ...outer1].sort((a, b) => a[0] - b[0]),
  serial.slice().sort((a, b) => a[0] - b[0]),
  'the two outer GitHub jobs must remain an exact partition of all samples',
);

// Regression for the real failure mode: large functions must not cluster in
// one modulo bucket merely because their serial sample indices line up.
const skewedStarts = [];
let skewAddr = 0x100000;
const longSpans = [2048, 1984, 1920, 1856, 1792, 1728, 1664, 1600];
for (let i = 0; i < 120; i++) {
  skewedStarts.push(skewAddr);
  skewAddr += i < longSpans.length ? longSpans[i] : 64 + (i % 4) * 16;
  skewedStarts.push(skewAddr);
  skewAddr += 4096; // ineligible separator range
}
skewedStarts.push(skewAddr);
const skewedSerial = pseudocSamples(skewedStarts);
assert.equal(skewedSerial.length, 120);
const skewed = balancedPseudocShards(skewedStarts, 8);
const owners = new Map();
for (let shard = 0; shard < skewed.length; shard++) {
  for (const pair of skewed[shard].selected) owners.set(pair[0], shard);
}
const longOwners = skewedSerial.slice(0, 8).map((pair) => owners.get(pair[0]));
assert.equal(new Set(longOwners).size, 8, 'the eight largest functions must start on distinct workers');

console.log('accuracy pseudoc cost-balanced runner-local sharding regression passed');
