/**
 * Artifact 識別の衝突に対する回帰テスト。
 *
 *   #1263  BigInt が untagged な 10 進文字列になり、通常の文字列と衝突する
 *   #1282  Map / Set が `$map` / `$set` という *普通の* object key で表現され、
 *          同じ key を持つ通常 object と衝突する
 *   #1281  artifactKind が artifactId の次元に入っておらず、別種の artifact が
 *          同じ store / cache key を共有できる
 *
 * どれも「意味の違うものが同じ鍵になる」欠陥です。artifact identity は
 * cache 再利用の根拠なので、衝突はそのまま「別の成果物を返す」ことになります。
 */
import assert from 'node:assert/strict';
import { canonicalConfigHash, canonicalArtifactKeyValue, createArtifactDescriptor } from '../js/core/artifacts/contracts.js';

console.log('Testing artifact key collisions...');

const BIN = `bin_sha256_${'00'.repeat(32)}`;

/* ── #1263 BigInt は文字列と別物 ───────────────────────────── */

assert.notEqual(canonicalConfigHash({ value: 1n }), canonicalConfigHash({ value: '1' }), 'BigInt must not alias a decimal string (#1263)');
assert.notEqual(canonicalConfigHash({ value: 1n }), canonicalConfigHash({ value: 1 }), 'BigInt must not alias a number (#1263)');
assert.notEqual(canonicalConfigHash(1n), canonicalConfigHash('1'), 'a bare BigInt must not alias a bare string');
// Map の key 側でも同じ。
assert.notEqual(
  canonicalConfigHash(new Map([[1n, 'x']])),
  canonicalConfigHash(new Map([['1', 'x']])),
  'a BigInt map key must not alias a string map key (#1263)',
);
// 同じ BigInt は同じ鍵（決定性は落とさない）。
assert.equal(canonicalConfigHash({ value: 1n }), canonicalConfigHash({ value: BigInt(1) }));
assert.notEqual(canonicalConfigHash({ value: 1n }), canonicalConfigHash({ value: 2n }));
console.log('  ok 1 BigInt keeps its own canonical form (#1263)');

/* ── #1282 容器の型は identity の一部 ──────────────────────── */

assert.notEqual(canonicalConfigHash(new Set([1])), canonicalConfigHash({ $set: [1] }), 'a Set must not alias an object with a $set key (#1282)');
assert.notEqual(canonicalConfigHash(new Map([['a', 1]])), canonicalConfigHash({ $map: [['a', 1]] }), 'a Map must not alias an object with a $map key (#1282)');
assert.notEqual(canonicalConfigHash({ value: 1n }), canonicalConfigHash({ value: { $bigint: '1' } }), 'a BigInt must not alias an object with a $bigint key');
assert.notEqual(canonicalConfigHash(new Set([1])), canonicalConfigHash([1]), 'a Set must not alias an array');

// escape は繰り返しても衝突しない。
assert.notEqual(canonicalConfigHash({ $$set: [1] }), canonicalConfigHash(new Set([1])));
assert.notEqual(canonicalConfigHash({ $$set: [1] }), canonicalConfigHash({ $set: [1] }));
assert.notEqual(canonicalConfigHash({ $$$set: [1] }), canonicalConfigHash({ $$set: [1] }));

// `$` で始まらない普通の key は表現が変わらない。
{
  const canonical = canonicalArtifactKeyValue({ alpha: 1, beta: 'two' });
  assert.deepEqual(Object.keys(canonical), ['alpha', 'beta'], 'ordinary keys must not be rewritten');
}

// 同じ内容の Set / Map は今までどおり同じ鍵。
assert.equal(canonicalConfigHash(new Set([1, 2])), canonicalConfigHash(new Set([2, 1])), 'Set order must stay irrelevant');
assert.equal(canonicalConfigHash(new Map([['a', 1], ['b', 2]])), canonicalConfigHash(new Map([['b', 2], ['a', 1]])), 'Map insertion order must stay irrelevant');
assert.equal(canonicalConfigHash({ a: 1, b: 2 }), canonicalConfigHash({ b: 2, a: 1 }), 'object key order must stay irrelevant');
console.log('  ok 2 container type is part of artifact key material (#1282)');

/* ── #1281 artifactKind は identity の次元 ─────────────────── */

const base = Object.freeze({
  binaryId: BIN,
  artifactKind: 'kind-a',
  producerId: 'pass',
  producerVersion: '1',
  versions: { loader: '1', architectureSemantic: '1', abiSemantic: '1', semanticSchema: '1' },
});

{
  const a = createArtifactDescriptor(base);
  const b = createArtifactDescriptor({ ...base, artifactKind: 'kind-b' });
  assert.notEqual(a.artifactKind, b.artifactKind);
  assert.notEqual(a.artifactId, b.artifactId, 'a different artifact kind must produce a different artifactId (#1281)');
}

{
  // 決定性: 同じ入力は同じ id。
  const a = createArtifactDescriptor(base);
  const b = createArtifactDescriptor({ ...base });
  assert.equal(a.artifactId, b.artifactId, 'identical descriptors must keep one id');
}

{
  // 既存の次元も引き続き id を変える（過剰無効化ではなく、次元が増えただけ）。
  const a = createArtifactDescriptor(base);
  for (const patch of [
    { producerId: 'other' },
    { producerVersion: '2' },
    { versions: { ...base.versions, loader: '2' } },
    { entityId: 'entity_1' },
    { sliceId: 'slice_1' },
    { config: { flag: true } },
    { upstreamArtifactIds: ['artifact_1'] },
  ]) {
    const b = createArtifactDescriptor({ ...base, ...patch });
    assert.notEqual(a.artifactId, b.artifactId, `changing ${Object.keys(patch)[0]} must still change the id`);
  }
}

{
  // config 内の衝突も id へ伝わる。
  const withBigint = createArtifactDescriptor({ ...base, config: { v: 1n } });
  const withString = createArtifactDescriptor({ ...base, config: { v: '1' } });
  assert.notEqual(withBigint.artifactId, withString.artifactId, 'a config collision must not become an id collision (#1263)');

  const withSet = createArtifactDescriptor({ ...base, config: { v: new Set([1]) } });
  const withTagObject = createArtifactDescriptor({ ...base, config: { v: { $set: [1] } } });
  assert.notEqual(withSet.artifactId, withTagObject.artifactId, 'a container collision must not become an id collision (#1282)');
}
console.log('  ok 3 artifact kind is a canonical identity dimension (#1281)');

console.log('artifact key collisions: PASS');
