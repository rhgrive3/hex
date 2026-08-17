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

export function shardFunctionStarts(functionStarts, shardIndex, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('shardCount must be a positive integer');
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) throw new Error('shardIndex out of range');
  const selected = pseudocSamples(functionStarts).filter((_, index) => index % shardCount === shardIndex);
  if (!selected.length) throw new Error(`pseudoc shard ${shardIndex}/${shardCount} is empty`);
  const separator = Number.MAX_SAFE_INTEGER;
  const starts = [];
  for (const [a, end] of selected) starts.push(a, end, separator);
  const rebuilt = pseudocSamples(starts);
  if (rebuilt.length !== selected.length || rebuilt.some((pair, i) => pair[0] !== selected[i][0] || pair[1] !== selected[i][1])) {
    throw new Error('sharded pseudoc oracle does not reconstruct the exact selected sample set');
  }
  return { starts, selected };
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
  const { starts, selected } = shardFunctionStarts(oracle.functionStarts, shardIndex, shardCount);
  fs.writeFileSync(output, zlib.gzipSync(Buffer.from(JSON.stringify({ ...oracle, functionStarts: starts }))));
  process.stderr.write(`pseudoc shard ${shardIndex + 1}/${shardCount}: ${selected.length}/${full.length} exact serial samples\n`);
}

if (process.argv[1]?.endsWith('accuracy-pseudoc-shard-oracle.mjs')) main();
