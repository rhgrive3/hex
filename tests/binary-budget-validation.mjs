/**
 * バイナリ decode 予算の入力検証に対する回帰テスト。
 *
 *   #1376  Mach-O metadata budget が不正な上限値で無制限化・NaN 化する
 *   #1377  relocation budget の step() が負数・小数 cost を受理する
 *
 * どちらも「呼び出し側の値が上限そのものを無効化できる」欠陥です。
 * 予算は敵対的な入力を境界付けるためにあるので、予算自身が入力で
 * 壊れてはいけません。
 */
import assert from 'node:assert/strict';
import { createRelocationBudget } from '../js/binary/relocation-budget.js';
import { createMachOMetadataBudget, MACHO_METADATA_LIMITS } from '../js/binary/macho-budget.js';

console.log('Testing binary decode budget validation...');

/* ── #1377 step() の cost は非負の safe integer だけ ────────── */

{
  // Issue の最小反例: 負の cost で消費済みの work を取り戻せた。
  const budget = createRelocationBudget({ limits: { maxOperations: 2 } });
  assert.equal(budget.step(1), true);
  assert.equal(budget.step(-1), false, 'a negative cost must stop the budget, not refund work (#1377)');
  assert.equal(budget.stopped, true);
  assert.match(budget.reason, /operation cost is invalid/);
  assert.equal(budget.step(1), false, 'a stopped budget stays stopped');
}

for (const bad of [-1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
  const budget = createRelocationBudget({});
  assert.equal(budget.step(bad), false, `step(${String(bad)}) must fail closed (#1377)`);
  assert.equal(budget.stopped, true, `step(${String(bad)}) must stop the budget`);
  assert.equal(budget.snapshot().operations, 0, `step(${String(bad)}) must not move the counter`);
}

{
  // 既存の正常な挙動は維持。
  const budget = createRelocationBudget({ limits: { maxOperations: 5 } });
  assert.equal(budget.step(), true, 'the default cost of 1 must still work');
  assert.equal(budget.snapshot().operations, 1);
  assert.equal(budget.step(0), true, 'step(0) must stay a successful no-op');
  assert.equal(budget.snapshot().operations, 1, 'step(0) must not move the counter');
  assert.equal(budget.step(3), true);
  assert.equal(budget.snapshot().operations, 4);
  assert.equal(budget.step(1), true, 'reaching the limit exactly is allowed');
  assert.equal(budget.step(1), false, 'exceeding the limit still stops');
  assert.match(budget.reason, /exceeds 5 operations/);
}

{
  // counter は決して減らない。
  const budget = createRelocationBudget({ limits: { maxOperations: 100 } });
  let previous = 0;
  for (const cost of [1, 0, 5, 0, 3]) {
    budget.step(cost);
    const now = budget.snapshot().operations;
    assert.ok(now >= previous, 'the operation counter must never decrease (#1377)');
    previous = now;
  }
  assert.equal(previous, 9);
}
console.log('  ok 1 relocation step() only spends non-negative safe integers (#1377)');

/* ── #1376 上限値は有限の正整数へ正規化 ─────────────────────── */

{
  // Issue の最小反例: records: NaN で 250000 の上限が消えていた。
  const image = { metadata: {}, warnings: [] };
  const budget = createMachOMetadataBudget(image, { limits: { records: Number.NaN } });
  assert.equal(budget.limits.records, MACHO_METADATA_LIMITS.records, 'an invalid limit must fall back to the default (#1376)');

  let taken = 0;
  while (budget.take({ records: 1 })) {
    taken += 1;
    if (taken > MACHO_METADATA_LIMITS.records + 10) break;
  }
  assert.equal(taken, MACHO_METADATA_LIMITS.records, 'the record ceiling must still hold (#1376)');
}

// A numeric string coerces to a valid limit and is accepted, matching the
// `positiveLimit` helpers elsewhere in the loader; only values that cannot be
// a finite positive integer fall back.
for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 0, 1.5, 'lots', null, undefined, {}, []]) {
  const budget = createMachOMetadataBudget({ metadata: {}, warnings: [] }, {
    limits: { records: bad, stringBytes: bad, warnings: bad, wallClockMs: bad, objects: bad, operations: bad, inputBytes: bad, estimatedHeapBytes: bad },
  });
  for (const [key, expected] of Object.entries(MACHO_METADATA_LIMITS)) {
    assert.equal(budget.limits[key], expected, `limit ${key}=${String(bad)} must fall back to ${expected} (#1376)`);
  }
  assert.ok(Number.isFinite(budget.remainingStringBytes), `remainingStringBytes must stay finite for ${String(bad)}`);
  assert.ok(budget.remainingStringBytes >= 0);
  for (const key of Object.keys(MACHO_METADATA_LIMITS)) {
    const remaining = budget.remaining(key);
    assert.ok(Number.isFinite(remaining) && remaining >= 0, `remaining(${key}) must stay finite and non-negative for ${String(bad)}`);
  }
}

{
  // 正常な override は今までどおり効く。
  const budget = createMachOMetadataBudget({ metadata: {}, warnings: [] }, { limits: { records: 10, stringBytes: 4096 } });
  assert.equal(budget.limits.records, 10, 'a valid override must be kept');
  assert.equal(budget.limits.stringBytes, 4096);
  assert.equal(budget.limits.objects, MACHO_METADATA_LIMITS.objects, 'unspecified limits keep their defaults');

  let taken = 0;
  while (budget.take({ records: 1 })) taken += 1;
  assert.equal(taken, 10, 'a valid override must actually bound the budget');
}

{
  // metadataLimits 側の別名でも同じ正規化が効く。
  const budget = createMachOMetadataBudget({ metadata: {}, warnings: [] }, { metadataLimits: { warnings: Number.NaN } });
  assert.equal(budget.limits.warnings, MACHO_METADATA_LIMITS.warnings);
}

{
  // warning 初期値も正規化済み上限で clamp される。
  const image = { metadata: {}, warnings: new Array(5000).fill('w') };
  const budget = createMachOMetadataBudget(image, { limits: { warnings: Number.NaN } });
  assert.equal(budget.used.warnings, MACHO_METADATA_LIMITS.warnings, 'the seeded warning count must clamp to the resolved limit (#1376)');
}
console.log('  ok 2 Mach-O metadata limits normalize to finite positive integers (#1376)');

console.log('binary decode budget validation: PASS');
