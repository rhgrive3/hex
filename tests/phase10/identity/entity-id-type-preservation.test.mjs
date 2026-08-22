/**
 * #1283 — createEntityId() must not collapse distinct identity types.
 *
 * `jsonSafe()` is deliberately lossy: it exists to make anything JSON-encodable
 * for a digest, so a BigInt becomes a bare decimal string. `createEntityId()`
 * hashed that already-collapsed form, so an identity of `1n` and an identity of
 * `'1'` received the same persistent entity id. Anything keyed by entity id --
 * lookups, references, cached state -- could then alias.
 *
 * The repair must not move ids that were never ambiguous, because entity ids
 * are persistent. The type witness is therefore absent for every identity
 * `jsonSafe()` can carry without changing a type, and the "unchanged" half of
 * this test is as load-bearing as the "distinct" half.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createEntityId, lossyTypeWitness } from '../../../js/core/identity/index.js';

const BASE = Object.freeze({ binaryId: `bin_sha256_${'00'.repeat(32)}`, kind: 'demo' });
const idFor = (identity) => createEntityId({ ...BASE, identity });

test('P10 entity identity: a BigInt never aliases its decimal string', () => {
  assert.notEqual(idFor(1n), idFor('1'), 'bigint vs string must not collide (#1283)');
  assert.notEqual(idFor(1n), idFor(1), 'bigint vs number must not collide (#1283)');
  assert.notEqual(idFor({ offset: 1n }), idFor({ offset: '1' }), 'a nested bigint must not collide (#1283)');
  assert.notEqual(idFor([1n]), idFor(['1']), 'a bigint in an array must not collide (#1283)');
  assert.notEqual(idFor({ a: { b: 1n } }), idFor({ a: { b: '1' } }), 'a deeply nested bigint must not collide');
});

test('P10 entity identity: other lossy encodings stay distinguishable', () => {
  assert.notEqual(idFor(new Date(0)), idFor('1970-01-01T00:00:00.000Z'), 'a Date must not alias its ISO string');
  assert.notEqual(idFor(Number.NaN), idFor(null), 'a non-finite number must not alias null');
  assert.notEqual(idFor(Number.POSITIVE_INFINITY), idFor(null), 'Infinity must not alias null');
  assert.notEqual(idFor(new Uint8Array([1, 2])), idFor([1, 2]), 'a byte view must not alias an ordinary array');
  assert.notEqual(idFor({ a: undefined }), idFor({}), 'an explicitly undefined member must not alias its absence');
});

test('P10 entity identity: identical identities keep one id', () => {
  assert.equal(idFor(1n), idFor(BigInt(1)), 'the same bigint must be stable');
  assert.equal(idFor({ a: 1, b: 'x' }), idFor({ b: 'x', a: 1 }), 'key order must stay irrelevant');
  assert.equal(idFor([1, 2]), idFor([1, 2]), 'the same array must be stable');
  assert.equal(idFor(new Date(0)), idFor(new Date(0)), 'the same Date must be stable');
});

test('P10 entity identity: every dimension still separates', () => {
  const a = createEntityId({ ...BASE, identity: 'x' });
  assert.notEqual(a, createEntityId({ ...BASE, kind: 'other', identity: 'x' }));
  assert.notEqual(a, createEntityId({ ...BASE, sliceId: 'slice:1', identity: 'x' }));
  assert.notEqual(a, createEntityId({ ...BASE, binaryId: `bin_sha256_${'11'.repeat(32)}`, identity: 'x' }));
  assert.notEqual(a, createEntityId({ ...BASE, identity: 'y' }));
});

test('P10 entity identity: an identity with nothing lossy carries no witness', () => {
  // This is what keeps existing persistent ids exactly where they are.
  for (const value of ['abc', 123, true, false, null, { a: 1, b: 'x' }, [1, 2, 3], { nested: { deep: [1, 'two', false] } }]) {
    assert.equal(lossyTypeWitness(value), null, `${JSON.stringify(value)} must need no type witness`);
  }
});

test('P10 entity identity: the witness names the path and the kind', () => {
  assert.deepEqual(lossyTypeWitness(1n), [['', 'bigint']]);
  assert.deepEqual(lossyTypeWitness({ offset: 1n }), [['.offset', 'bigint']]);
  assert.deepEqual(lossyTypeWitness([1n]), [['[0]', 'bigint']]);
  assert.deepEqual(lossyTypeWitness({ b: 1n, a: Number.NaN }), [['.a', 'non-finite-number'], ['.b', 'bigint']]);
});

test('P10 entity identity: a cyclic identity does not hang the witness', () => {
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.equal(lossyTypeWitness(cyclic), null, 'a cycle with nothing lossy still terminates with no witness');

  const cyclicLossy = { at: 1n };
  cyclicLossy.self = cyclicLossy;
  assert.deepEqual(lossyTypeWitness(cyclicLossy), [['.at', 'bigint']], 'a cycle must not lose the lossy member');
});
