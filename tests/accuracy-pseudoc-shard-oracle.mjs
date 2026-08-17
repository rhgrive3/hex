import fs from 'node:fs';
import zlib from 'node:zlib';

function stride(list, n) {
  if (list.length <= n) return list.slice();
  const step = list.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

export function pseudocSamples(functionStarts) {
  const cands = [];
  for (let i = 0; i < functionStarts.length - 1; i++) {
    const a = functionStarts[i];
    const end = functionStarts[i + 1];
    if (end - a >= 64 && end - a <= 2048) cands.push([a, end]);
  }
  return stride(cands, 120);
}

/**
 * Split the exact serial sample set into deterministic, cost-balanced shards.
 *
 * Decompiled-function cost is highly non-linear with function size. A simple
 * modulo split can accidentally place multiple very large functions in the
 * same worker (the BattleCats regression that motivated this helper did
 * exactly that). Longest-processing-time scheduling using span^2 as a stable
 * cost proxy separates those outliers while preserving every sampled function
 * exactly once. Shard capacities differ by at most one item.
 */
export function balancedPseudocShards(functionStarts, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('shardCount must be a positive integer');
  }
  const samples = pseudocSamples(functionStarts);
  if (shardCount > samples.length) throw new Error('shardCount exceeds pseudoc sample count');

  const baseCapacity = Math.floor(samples.length / shardCount);
  const remainder = samples.length % shardCount;
  const capacities = Array.from(
    { length: shardCount },
    (_, i) => baseCapacity + (i < remainder ? 1 : 0),
  );
  const shards = Array.from({ length: shardCount }, () => []);
  const costs = Array(shardCount).fill(0);

  const work = samples.map((pair, serialIndex) => {
    const span = pair[1] - pair[0];
    return { pair, serialIndex, cost: span * span };
  }).sort((a, b) => b.cost - a.cost || a.serialIndex - b.serialIndex);

  for (const item of work) {
    let best = -1;
    for (let i = 0; i < shardCount; i++) {
      if (shards[i].length >= capacities[i]) continue;
      if (best < 0 || costs[i] < costs[best] ||
          (costs[i] === costs[best] && shards[i].length < shards[best].length) ||
          (costs[i] === costs[best] && shards[i].length === shards[best].length && i < best)) {
        best = i;
      }
    }
    if (best < 0) throw new Error('failed to place pseudoc sample');
    shards[best].push(item);
    costs[best] += item.cost;
  }

  return shards.map((items, index) => ({
    selected: items.sort((a, b) => a.serialIndex - b.serialIndex).map((item) => item.pair),
    estimatedCost: costs[index],
  }));
}

export function shardFunctionStarts(functionStarts, shardIndex, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('shardCount must be a positive integer');
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) throw new Error('shardIndex out of range');
  const all = balancedPseudocShards(functionStarts, shardCount);
  const { selected, estimatedCost } = all[shardIndex];
  if (!selected.length) throw new Error(`pseudoc shard ${shardIndex}/${shardCount} is empty`);
  const separator = Number.MAX_SAFE_INTEGER;
  const starts = [];
  for (const [a, end] of selected) starts.push(a, end, separator);
  const rebuilt = pseudocSamples(starts);
  if (rebuilt.length !== selected.length || rebuilt.some((pair, i) => pair[0] !== selected[i][0] || pair[1] !== selected[i][1])) {
    throw new Error('sharded pseudoc oracle does not reconstruct the exact selected sample set');
  }
  return { starts, selected, estimatedCost };
}

function main() {
  const [input, output, rawIndex, rawCount] = process.argv.slice(2);
  if (!input || !output || rawIndex == null || rawCount == null) {
    console.error('usage: node tests/accuracy-pseudoc-shard-oracle.mjs <input.json.gz> <output.json.gz> <shard-index> <shard-count>');
    process.exit(2);
  }
  const shardIndex = Number(rawIndex);
  const shardCount = Number(rawCount);
  const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(input)).toString('utf8'));
  if (!Array.isArray(oracle.functionStarts)) throw new Error('oracle.functionStarts is required');
  const full = pseudocSamples(oracle.functionStarts);
  const { starts, selected, estimatedCost } = shardFunctionStarts(oracle.functionStarts, shardIndex, shardCount);
  // `accuracy.mjs --only=pseudoc` reads only functionStarts. Keeping the huge
  // full oracle in every runner-local shard wasted gzip/JSON work and memory.
  fs.writeFileSync(output, zlib.gzipSync(Buffer.from(JSON.stringify({ functionStarts: starts }))));
  process.stderr.write(
    `pseudoc shard ${shardIndex + 1}/${shardCount}: ${selected.length}/${full.length} exact serial samples, cost=${estimatedCost}\n`,
  );
}

if (process.argv[1]?.endsWith('accuracy-pseudoc-shard-oracle.mjs')) main();
