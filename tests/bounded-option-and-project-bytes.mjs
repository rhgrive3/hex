/**
 * 明示された値が「未指定」に化ける欠陥の回帰テスト。
 *
 *   #1385  query/causal の boundedOption が数値 0 を未指定扱いして既定値へ戻す
 *   #1388  .hexproj の byte 入力が不正 UTF-8 を U+FFFD へ置換して正常読込になる
 *
 * どちらも「利用者が言ったことが、言わなかったことにされる」形です。
 * #1385 は同じ意図の 0 と '0' が別の上限になり、#1388 は壊れたファイルが
 * 別内容の正常な project として読めてしまいます。
 */
import assert from 'node:assert/strict';
import { functionPaths, minimalCausalPath } from '../js/query/causal.js';
import { createHexProject, serializeHexProject, parseHexProject, tryParseHexProject, importHexProject } from '../js/project/index.js';

console.log('Testing explicit-zero options and .hexproj byte decoding...');

/* ── #1385 数値 0 は「未指定」ではない ─────────────────────── */

/**
 * 到達可能な呼び出しグラフ。深さも分岐も上限より大きいので、上限が実際に
 * 効いているかどうかが結果に出ます。
 */
function program(depth = 8) {
  return {
    functionRange: (addr) => ({ start: addr, end: addr + 4 }),
    calleesOf: (addr) => (addr < depth ? [{ addr: addr + 1 }] : []),
    graphCompleteness: { callsComplete: true },
  };
}

/** 0 -> {1,2} -> 3 のダイヤモンド。目的地まで 2 経路あるので maxPaths が効く。 */
function diamond() {
  return {
    functionRange: (addr) => ({ start: addr, end: addr + 4 }),
    calleesOf: (addr) => (addr === 0 ? [{ addr: 1 }, { addr: 2 }] : (addr === 1 || addr === 2 ? [{ addr: 3 }] : [])),
    graphCompleteness: { callsComplete: true },
  };
}

{
  // maxPaths: 0 と '0' は同じ意味でなければならない。既定の 8 では 2 経路
  // 返るので、最小値 1 へ clamp されたかどうかが結果に出る。
  const zeroNumber = functionPaths(diamond(), 0, 3, { maxPaths: 0 });
  const zeroString = functionPaths(diamond(), 0, 3, { maxPaths: '0' });
  assert.deepEqual(
    { paths: zeroNumber.paths.length, complete: zeroNumber.complete },
    { paths: zeroString.paths.length, complete: zeroString.complete },
    'maxPaths: 0 and maxPaths: "0" must request the same bound (#1385)',
  );
  assert.equal(zeroNumber.paths.length, 1, 'maxPaths: 0 must clamp to the minimum of 1, not fall back to 8 (#1385)');
  assert.equal(functionPaths(diamond(), 0, 3, {}).paths.length, 2, 'the default of 8 still returns both paths');
}

{
  // maxDepth: 0 は最小値 1 へ clamp され、既定の 6 へは戻らない。
  const clamped = functionPaths(program(), 0, 5, { maxDepth: 0 });
  const dflt = functionPaths(program(), 0, 5, {});
  assert.notDeepEqual(
    clamped.reasons, [],
    'maxDepth: 0 must clamp to the minimum and hit the depth limit, not fall back to the default (#1385)',
  );
  assert.equal(clamped.paths.length, 0, 'a depth of 1 cannot reach a target 5 calls away');
  assert.equal(dflt.paths.length, 1, 'the default depth of 6 still reaches it');
}

{
  // minimalCausalPath の limit: 0 も同じ。
  const zeroNumber = minimalCausalPath(program(), 0, 3, { limit: 0 });
  const zeroString = minimalCausalPath(program(), 0, 3, { limit: '0' });
  assert.deepEqual(zeroNumber, zeroString, 'limit: 0 and limit: "0" must agree (#1385)');
}

{
  // 未指定の合図は今までどおり fallback。
  for (const absent of [null, undefined, '', false]) {
    const withAbsent = functionPaths(program(), 0, 5, { maxDepth: absent });
    const dflt = functionPaths(program(), 0, 5, {});
    assert.deepEqual(withAbsent.paths.length, dflt.paths.length, `${JSON.stringify(absent)} must still mean "not supplied"`);
  }
  // 正常な値も従来どおり。
  assert.equal(functionPaths(program(), 0, 5, { maxDepth: 12 }).paths.length, 1);
  assert.equal(functionPaths(program(), 0, 5, { maxDepth: 2 }).paths.length, 0);
  // 範囲外は clamp、非数は fallback。
  assert.deepEqual(functionPaths(program(), 0, 5, { maxDepth: 999 }).paths.length, 1);
  assert.deepEqual(
    functionPaths(program(), 0, 5, { maxDepth: Number.NaN }).paths.length,
    functionPaths(program(), 0, 5, {}).paths.length,
    'NaN must still fall back',
  );
}
console.log('  ok 1 an explicit 0 is a requested bound, not an absent one (#1385)');

/* ── #1388 byte 入力は正しい UTF-8 でなければ拒否 ──────────── */

const validText = serializeHexProject(createHexProject({ binaryMetadata: { note: 'ok' } }));
const validBytes = new TextEncoder().encode(validText);

{
  // 正しい bytes は今までどおり読める。
  assert.ok(parseHexProject(validBytes), 'valid UTF-8 bytes must still parse');
  assert.ok(parseHexProject(validBytes.buffer.slice(0)), 'an ArrayBuffer must still parse');
  assert.ok(parseHexProject(validText), 'text input is unaffected');
  // 非 ASCII も壊さない。
  const unicode = new TextEncoder().encode(serializeHexProject(createHexProject({ binaryMetadata: { note: '日本語 · ✓ · 𝔘' } })));
  assert.equal(parseHexProject(unicode).binary.metadata.note, '日本語 · ✓ · 𝔘', 'multi-byte UTF-8 must survive');
}

{
  // 不正な UTF-8 は fail closed。置換して読み進めてはいけない。
  for (const bad of [[0xC3, 0x28], [0xE2, 0x28, 0xA1], [0xF0, 0x28, 0x8C, 0x28], [0x80], [0xFF]]) {
    const bytes = new Uint8Array(validBytes.length + bad.length);
    // JSON 構文が壊れない位置（文字列値の中）へ差し込む。
    const at = validText.indexOf('"ok"') + 1;
    bytes.set(validBytes.subarray(0, at), 0);
    bytes.set(bad, at);
    bytes.set(validBytes.subarray(at), at + bad.length);

    const result = tryParseHexProject(bytes);
    assert.equal(result.ok, false, `invalid UTF-8 ${JSON.stringify(bad)} must be rejected, not repaired (#1388)`);
    assert.match(result.error, /not valid UTF-8/, `unexpected error for ${JSON.stringify(bad)}: ${result.error}`);
  }
}

{
  // ArrayBuffer 経路も同じ。
  const bytes = Uint8Array.from(validBytes);
  bytes[bytes.length - 8] = 0xC3;
  bytes[bytes.length - 7] = 0x28;
  assert.equal(tryParseHexProject(bytes.buffer).ok, false, 'the ArrayBuffer path must fail closed too (#1388)');
}

if (typeof Blob !== 'undefined') {
  // Blob 経路は Blob.text() ではなく同じ strict parser を通る。
  const bytes = Uint8Array.from(validBytes);
  bytes[bytes.length - 8] = 0xC3;
  bytes[bytes.length - 7] = 0x28;
  await assert.rejects(
    () => importHexProject(new Blob([bytes])),
    /not valid UTF-8/,
    'the Blob path must use the same strict decode (#1388)',
  );
  assert.ok(await importHexProject(new Blob([validBytes])), 'a valid Blob must still import');
}
console.log('  ok 2 .hexproj bytes must be valid UTF-8 or fail closed (#1388)');

console.log('explicit-zero options and .hexproj byte decoding: PASS');
