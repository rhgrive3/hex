import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function accuracyFeatureOrder(source = fs.readFileSync(path.join(HERE, 'accuracy.mjs'), 'utf8')) {
  const ids = [...source.matchAll(/\bfeature\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.ok(ids.length > 0, 'accuracy.mjs must declare at least one feature');
  assert.equal(new Set(ids).size, ids.length, 'accuracy.mjs feature ids must be unique');
  return ids;
}

// Partitions are only a scheduling optimization. The merged result must still
// contain every feature exactly once and in the same canonical order as a
// serial accuracy.mjs run.
export function mergeAccuracyRows(parts, order = accuracyFeatureOrder()) {
  const byId = new Map();
  const expected = new Set(order);

  for (const rows of parts) {
    assert.ok(Array.isArray(rows), 'accuracy partition must be a JSON array');
    for (const row of rows) {
      assert.ok(row && typeof row === 'object', 'accuracy row must be an object');
      assert.equal(typeof row.id, 'string', 'accuracy row must have a string id');
      assert.ok(expected.has(row.id), `unknown accuracy feature: ${row.id}`);
      assert.ok(!byId.has(row.id), `duplicate accuracy feature: ${row.id}`);
      byId.set(row.id, row);
    }
  }

  const missing = order.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `missing accuracy features: ${missing.join(', ')}`);
  return order.map((id) => byId.get(id));
}

function selfTest() {
  const order = ['a', 'b', 'c', 'd', 'e'];
  const rows = order.map((id, i) => ({ id, score: i / 10 }));
  const merged = mergeAccuracyRows([[rows[3]], rows.slice(0, 2), rows.slice(4), [rows[2]]], order);
  assert.deepEqual(merged.map((row) => row.id), order);
  assert.throws(() => mergeAccuracyRows([rows, [rows[0]]], order), /duplicate accuracy feature/);
  assert.throws(() => mergeAccuracyRows([rows.slice(1)], order), /missing accuracy features/);
  assert.throws(() => mergeAccuracyRows([[{ id: 'not-a-feature', score: 1 }]], order), /unknown accuracy feature/);
  assert.deepEqual(accuracyFeatureOrder("feature('x', '', null);\nfeature(\"y\", '', null);"), ['x', 'y']);
  console.log('accuracy merge regression passed');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    selfTest();
    return;
  }
  if (args.length < 2) {
    console.error('usage: node tests/accuracy-merge.mjs <output.json> <part1.json> [part2.json ...]');
    process.exit(2);
  }
  const [output, ...inputs] = args;
  const parts = inputs.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const merged = mergeAccuracyRows(parts);
  fs.writeFileSync(output, JSON.stringify(merged, null, 2) + '\n');
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
