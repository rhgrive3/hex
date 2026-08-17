import assert from 'node:assert/strict';
import fs from 'node:fs';

const DETAIL = /^(\d+)\/(\d+) 行が C の式になった（関数 (\d+) 本）$/;

export function mergePseudocRows(parts) {
  assert.ok(Array.isArray(parts) && parts.length > 0, 'pseudoc shard parts are required');
  let good = 0;
  let total = 0;
  let done = 0;
  let ms = 0;
  let template = null;

  for (const rows of parts) {
    assert.ok(Array.isArray(rows), 'pseudoc shard must be a JSON array');
    assert.equal(rows.length, 1, 'pseudoc shard must contain exactly one feature row');
    const row = rows[0];
    assert.equal(row?.id, 'pseudoc', 'pseudoc shard row id mismatch');
    const match = String(row.detail || '').match(DETAIL);
    assert.ok(match, `unexpected pseudoc detail: ${row.detail}`);
    good += Number(match[1]);
    total += Number(match[2]);
    done += Number(match[3]);
    ms += Number(row.ms || 0);
    template ||= row;
  }

  assert.ok(total > 0, 'pseudoc shard merge produced no scored lines');
  return [{
    ...template,
    score: good / total,
    detail: `${good}/${total} 行が C の式になった（関数 ${done} 本）`,
    ms,
  }];
}

function selfTest() {
  const row = (good, total, done, ms) => [{
    id: 'pseudoc', label: '逆コンパイルで訳せない命令が残らない',
    score: good / total, detail: `${good}/${total} 行が C の式になった（関数 ${done} 本）`, ms,
  }];
  const [merged] = mergePseudocRows([row(10, 12, 3, 5), row(17, 18, 4, 7)]);
  assert.equal(merged.score, 27 / 30);
  assert.equal(merged.detail, '27/30 行が C の式になった（関数 7 本）');
  assert.equal(merged.ms, 12);
  assert.throws(() => mergePseudocRows([[{ id: 'core', detail: 'x' }]]), /id mismatch/);
  console.log('accuracy pseudoc shard merge regression passed');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (args.length < 2) {
    console.error('usage: node tests/accuracy-pseudoc-shard-merge.mjs <output.json> <shard1.json> [shard2.json ...]');
    process.exit(2);
  }
  const [output, ...inputs] = args;
  const merged = mergePseudocRows(inputs.map((file) => JSON.parse(fs.readFileSync(file, 'utf8'))));
  fs.writeFileSync(output, JSON.stringify(merged, null, 2) + '\n');
}

main();
