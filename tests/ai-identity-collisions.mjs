/**
 * AI サブシステムの identity 衝突に対する回帰テスト。
 *
 *   #1302  EvidenceStore の 32-bit 自動 ID が別々の evidence を 1 件へ潰す
 *   #1299  ProposalStore の fingerprint が型付き sentinel と通常 object を
 *          同一視し、stale-state guard を通過させる
 *
 * どちらも「別のものを同じものとして扱う」欠陥です。provenance loss と
 * 承認済み変更の取り違えに直結するので、恒久的な回帰として固定します。
 */
import assert from 'node:assert/strict';
import { EvidenceStore } from '../js/ai/evidence.js';
import { ProposalStore } from '../js/ai/proposals.js';

console.log('Testing AI identity collisions...');

/* ── #1302 evidence の自動 ID は衝突しない ─────────────────── */

{
  // Issue に記録された実際の衝突ペア。旧 32-bit FNV-1a ではどちらも
  // 'ev_094147e9' になり、2 件目が 1 件目へ merge されていた。
  const store = new EvidenceStore();
  const a = store.add({ sourceId: 's470399' });
  const b = store.add({ sourceId: 's1000830' });
  assert.notEqual(a.id, b.id, 'distinct evidence identities must not share an id (#1302)');
  assert.equal(store.records.size, 2, 'both records must survive (#1302)');
  assert.equal(store.get(a.id).id, a.id);
  assert.equal(store.get(b.id).id, b.id);
}

{
  // 同じ identity は同じ ID（決定性は落とさない）。
  const one = new EvidenceStore();
  const two = new EvidenceStore();
  const input = { sourceTool: 'semantic', sourceId: 's1', kind: 'read', title: 'same', address: '0x1000' };
  assert.equal(one.add({ ...input }).id, two.add({ ...input }).id, 'identical identities must stay stable');
}

{
  // identity の各次元が実際に ID を変える。
  const base = { sourceTool: 'semantic', sourceId: 's1', kind: 'read', title: 't', address: '0x1000', functionAddress: '0x2000' };
  const store = new EvidenceStore();
  const ids = new Set();
  for (const patch of [
    {},
    { sourceTool: 'runtime' },
    { sourceId: 's2' },
    { kind: 'write' },
    { title: 'u' },
    { address: '0x1004' },
    { functionAddress: '0x3000' },
  ]) ids.add(store.add({ ...base, ...patch }).id);
  assert.equal(ids.size, 7, 'every identity dimension must change the evidence id');
  assert.equal(store.records.size, 7);
}

{
  // 広めの掃き出し。旧 32-bit ID ではこの規模で birthday collision が現実的。
  const store = new EvidenceStore();
  for (let i = 0; i < 20000; i++) store.add({ sourceId: `s${i}` });
  assert.equal(store.records.size, 20000, '20k distinct identities must produce 20k records (#1302)');
}
console.log('  ok 1 evidence ids no longer collide (#1302)');

/* ── #1299 fingerprint は型を保つ ──────────────────────────── */

function proposalFor(before) {
  const evidence = new EvidenceStore([{ id: 'ev_fixed', kind: 'read', status: 'unknown', title: 'fixed' }]);
  const store = new ProposalStore({ evidenceStore: evidence });
  const proposal = store.create({
    kind: 'rename', target: { at: '0x1000' }, before, after: 'renamed',
    reason: 'regression fixture', evidenceIds: ['ev_fixed'],
  });
  const { approvalToken } = store.approve(proposal.id);
  return { store, proposal, approvalToken };
}

async function assertStale(before, currentState, label) {
  const { store, proposal, approvalToken } = proposalFor(before);
  await assert.rejects(
    () => store.apply(proposal.id, { approvalToken, currentState, apply: async () => {} }),
    /changed after it was created/,
    `${label} must be detected as a changed state (#1299)`,
  );
  assert.equal(store.get(proposal.id).status, 'failed');
}

async function assertFresh(before, currentState, label) {
  const { store, proposal, approvalToken } = proposalFor(before);
  let applied = false;
  await store.apply(proposal.id, { approvalToken, currentState, apply: async () => { applied = true; } });
  assert.ok(applied, `${label} must still apply when the state is genuinely unchanged`);
  assert.equal(store.get(proposal.id).status, 'applied');
}

// 旧 encoding で衝突していた組み合わせ。
await assertStale(1n, { $bigint: '1' }, 'bigint vs $bigint object');
await assertStale(NaN, { $number: 'NaN' }, 'NaN vs $number object');
await assertStale(Infinity, { $number: 'Infinity' }, 'Infinity vs $number object');
await assertStale(-Infinity, { $number: '-Infinity' }, '-Infinity vs $number object');
await assertStale(undefined, { $undefined: true }, 'undefined vs $undefined object');
// 入れ子でも同じこと。
await assertStale({ v: 1n }, { v: { $bigint: '1' } }, 'nested bigint vs sentinel object');
await assertStale([1n], [{ $bigint: '1' }], 'bigint in array vs sentinel object');
// 型そのものの取り違え。
await assertStale(1n, '1', 'bigint vs decimal string');
await assertStale(1n, 1, 'bigint vs number');
await assertStale('1', 1, 'string vs number');
await assertStale(0, -0, 'positive zero vs negative zero');
await assertStale(null, undefined, 'null vs undefined');
await assertStale(new Set([1]), { $set: [1] }, 'Set vs $set object');
await assertStale(new Map([['a', 1]]), { $map: [['a', 1]] }, 'Map vs $map object');
await assertStale(new Set([1]), [1], 'Set vs array');
await assertStale({}, new Map(), 'empty object vs empty Map');
await assertStale({ a: 1 }, { a: 1, b: undefined }, 'an added undefined-valued key is a change');

// 本当に変わっていないものは通る（guard を厳しくしただけで壊していない）。
await assertFresh(1n, 1n, 'identical bigint');
await assertFresh({ a: [1, 'x', null], b: { c: true } }, { b: { c: true }, a: [1, 'x', null] }, 'key order does not matter');
await assertFresh(undefined, undefined, 'identical undefined');
await assertFresh(NaN, NaN, 'identical NaN');
await assertFresh(new Set([1, 2]), new Set([1, 2]), 'identical Set');
await assertFresh(new Map([['a', 1n]]), new Map([['a', 1n]]), 'identical Map');
await assertFresh(null, null, 'identical null');
console.log('  ok 2 proposal fingerprints preserve value type (#1299)');

/* ── binding 側の guard も同じ encoding を使う ───────────────── */

{
  const evidence = new EvidenceStore([{ id: 'ev_b', kind: 'read', status: 'unknown', title: 'b' }]);
  let binding = 1n;
  const store = new ProposalStore({ evidenceStore: evidence, binding: () => binding });
  const proposal = store.create({
    kind: 'rename', target: { at: '0x1000' }, before: 'a', after: 'b',
    reason: 'binding fixture', evidenceIds: ['ev_b'],
  });
  const { approvalToken } = store.approve(proposal.id);
  binding = { $bigint: '1' };
  await assert.rejects(
    () => store.apply(proposal.id, { approvalToken, currentState: 'a', apply: async () => {} }),
    /different binary, project, or runtime session/,
    'a binding whose type changed must not pass the scope guard (#1299)',
  );
}
console.log('  ok 3 binding revision guard uses the same encoding (#1299)');

/* ── 循環参照は今までどおり明示的に失敗する ─────────────────── */

{
  const evidence = new EvidenceStore([{ id: 'ev_c', kind: 'read', status: 'unknown', title: 'c' }]);
  const store = new ProposalStore({ evidenceStore: evidence });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => store.create({ kind: 'rename', target: {}, before: cyclic, after: 'x', reason: 'r', evidenceIds: ['ev_c'] }),
    /cyclic/,
    'a cyclic state must fail loudly, never fingerprint to something',
  );
}
console.log('  ok 4 cyclic state still fails closed');

console.log('AI identity collisions: PASS');
