/**
 * #1366 — `.hexproj` の BigInt タグが通常オブジェクトと衝突する。
 *
 * serializer は BigInt を `{ $hexBigInt: hex }` という単一キー object にします。
 * reader はその形を無条件に BigInt へ戻していたので、ユーザーが元から持って
 * いた `{ $hexBigInt: '10' }` が `16n` になり、保存して開き直すだけでデータの
 * 型と構造が変わっていました。'deadbeef' のように hex として読める文字列なら
 * エラーにもならず静かに壊れます。
 *
 * タグ名を変えるだけでは新しい形とまた衝突するので、タグ名を予約して通常
 * データ側を escape します。このテストは round-trip の可逆性と、既存ファイル
 * の読み込み互換・malformed の error contract を同時に固定します。
 */
import assert from 'node:assert/strict';
import { createHexProject, parseHexProject, serializeHexProject, tryParseHexProject } from '../js/project/index.js';

console.log('Testing .hexproj bigint tag round-trip...');

const roundtrip = (metadata) => parseHexProject(serializeHexProject(createHexProject({ binaryMetadata: metadata }))).binary.metadata;

/* ── BigInt は今までどおり BigInt として往復する ────────────── */

{
  const out = roundtrip({ zero: 0n, small: 123n, negative: -255n, large: 0x100000000n, max: (1n << 127n) - 1n });
  assert.equal(out.zero, 0n);
  assert.equal(out.small, 123n);
  assert.equal(out.negative, -255n);
  assert.equal(out.large, 0x100000000n);
  assert.equal(out.max, (1n << 127n) - 1n);
  for (const key of Object.keys(out)) assert.equal(typeof out[key], 'bigint', `${key} must stay a bigint`);
}
console.log('  ok 1 BigInt values still round-trip');

/* ── タグと同じ形の通常オブジェクトも往復する ───────────────── */

{
  // Issue の最小反例。
  const out = roundtrip({ custom: { $hexBigInt: '10' } });
  assert.deepEqual(out.custom, { $hexBigInt: '10' }, 'a plain object shaped like the tag must stay an object (#1366)');
  assert.notEqual(typeof out.custom, 'bigint');
}

{
  // hex として読める文字列でも静かに変換されない。
  const out = roundtrip({ custom: { $hexBigInt: 'deadbeef' } });
  assert.deepEqual(out.custom, { $hexBigInt: 'deadbeef' });
}

{
  // タグキーが他のキーと同居していても保持される。
  const out = roundtrip({ custom: { $hexBigInt: '10', other: 1 } });
  assert.deepEqual(out.custom, { $hexBigInt: '10', other: 1 });
}

{
  // escape は繰り返しても一意。
  assert.deepEqual(roundtrip({ a: { $$hexBigInt: 'x' } }).a, { $$hexBigInt: 'x' });
  assert.deepEqual(roundtrip({ a: { $$$hexBigInt: 'x' } }).a, { $$$hexBigInt: 'x' });
}

{
  // 入れ子・配列の中でも同じ。
  const out = roundtrip({ deep: { list: [{ $hexBigInt: '10' }, 5n], nested: { inner: { $hexBigInt: 'ff' } } } });
  assert.deepEqual(out.deep.list[0], { $hexBigInt: '10' });
  assert.equal(out.deep.list[1], 5n);
  assert.deepEqual(out.deep.nested.inner, { $hexBigInt: 'ff' });
}

{
  // BigInt と衝突形が同じ object に同居しても両方生き残る。
  const out = roundtrip({ mixed: { tagged: { $hexBigInt: '10' }, real: 16n } });
  assert.deepEqual(out.mixed.tagged, { $hexBigInt: '10' });
  assert.equal(out.mixed.real, 16n);
}
console.log('  ok 2 plain objects shaped like the tag survive unchanged (#1366)');

/* ── 既存ファイルの読み込み互換 ─────────────────────────────── */

{
  // 旧 serializer が実 BigInt に対して書いた形は、今までどおり BigInt。
  const text = serializeHexProject(createHexProject({ binaryMetadata: { base: 0x100000000n } }));
  assert.ok(text.includes('"$hexBigInt"'), 'the on-disk tag name is unchanged, so old readers still see it');
  assert.equal(parseHexProject(text).binary.metadata.base, 0x100000000n);
}
console.log('  ok 3 the on-disk BigInt encoding is unchanged for real BigInts');

/* ── malformed の error contract は維持 ────────────────────── */

for (const bad of ['zz', '-', '0xff', '']) {
  const text = serializeHexProject(createHexProject({ binaryMetadata: { base: 1n } }))
    .replace('"$hexBigInt": "1"', `"$hexBigInt": ${JSON.stringify(bad)}`);
  const result = tryParseHexProject(text);
  assert.equal(result.ok, false, `a malformed bigint wrapper (${JSON.stringify(bad)}) must still be rejected`);
  assert.match(result.error, /invalid bigint encoding|malformed/, `unexpected error for ${JSON.stringify(bad)}: ${result.error}`);
}
console.log('  ok 4 malformed BigInt wrappers still fail closed');

console.log('.hexproj bigint tag round-trip: PASS');
