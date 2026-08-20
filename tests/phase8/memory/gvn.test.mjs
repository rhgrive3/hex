import assert from 'node:assert/strict';
import test from 'node:test';

import { runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { GVN_PASS, loadIsReusable, runGvnPass } from '../../../js/decompiler/phase8/valuenumber.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

/**
 * The GVN contract. Every negative case here is a shape that looks like the
 * positive one and is not it: same operator with a different width, the same
 * location behind a barrier, the same call twice. A pass that cannot tell those
 * apart is a pass that rewrites one computation into another.
 */

function analyze(ir) {
  const state = seedAnalysisState(ir);
  const context = { analysis: state, ir };
  runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, context, {});
  const outcome = runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, context, {});
  return { outcome, facts: state.get('valueNumbers'), state };
}

const congruent = (facts, left, right) => facts.numbers.get(left.id) === facts.numbers.get(right.id);

test('the same computation over the same operands is one class', () => {
  const f = fixture('cse');
  f.block(0);
  const a = f.opaque(32);
  const b = f.opaque(32);
  const first = f.binary('add', a, b, 32);
  const second = f.binary('add', a, b, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), true);
  assert.equal(facts.reuseCandidates.some((entry) => entry.valueId === second.id && entry.reuseOf === first.id), true);
});

test('a commutative operator is congruent with its operands swapped, a non-commutative one is not', () => {
  const f = fixture('commutative');
  f.block(0);
  const a = f.opaque(32);
  const b = f.opaque(32);
  const sum = f.binary('add', a, b, 32);
  const swappedSum = f.binary('add', b, a, 32);
  const difference = f.binary('sub', a, b, 32);
  const swappedDifference = f.binary('sub', b, a, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, sum, swappedSum), true);
  assert.equal(congruent(facts, difference, swappedDifference), false, 'a - b is not b - a');
});

test('the same operator at a different width is a different computation', () => {
  const f = fixture('width');
  f.block(0);
  const a = f.opaque(64);
  const narrow = f.cast('trunc', a, 32);
  const wide = f.copy(a, 64);
  const first = f.binary('add', narrow, narrow, 32);
  const second = f.binary('add', wide, wide, 64);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
});

test('two calls are never congruent, even with identical operands', () => {
  const f = fixture('calls');
  f.block(0);
  const first = f.call(32);
  const second = f.call(32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
  assert.match(facts.singletonReasons.get(second.id) ?? '', /different value each time/);
});

test('an unrepresented operation is never congruent', () => {
  const f = fixture('unknown');
  f.block(0);
  const first = f.unknown(32);
  const second = f.unknown(32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
});

/**
 * A load with every machine fact proved, spelled in the Semantic IR's own
 * vocabulary: knowledge is `true | false | 'unknown'`, ordering is one of
 * `relaxed | acquire | release | acq-rel | seq-cst | unknown`. Writing `'no'`
 * here would silently never match anything.
 */
const PROVED_LOAD = Object.freeze({
  locKey: 'field:root+0', addressSpace: 'memory', volatility: 'unknown', atomic: false, ordering: 'unknown',
  memDefs: ['store_1'], addressPrecise: true,
});

test('two loads are reused only when the memory facts prove it', () => {
  const f = fixture('load-reuse');
  f.block(0);
  const first = f.load(32, PROVED_LOAD);
  const second = f.load(32, PROVED_LOAD);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), true);
  const candidate = facts.reuseCandidates.find((entry) => entry.valueId === second.id);
  assert.ok(candidate, 'the proved case must produce a reuse candidate');
  assert.match(candidate.proof, /same reaching memory definitions/);
});

test('a changed memory version blocks load reuse', () => {
  // The near miss: same location, same width, different reaching store.
  const f = fixture('load-version');
  f.block(0);
  const first = f.load(32, PROVED_LOAD);
  const second = f.load(32, { ...PROVED_LOAD, memDefs: ['store_2'] });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
});

test('an unknown store between the loads blocks reuse', () => {
  const f = fixture('load-barrier');
  f.block(0);
  const first = f.load(32, PROVED_LOAD);
  const second = f.load(32, { ...PROVED_LOAD, barrier: { op: 'store' } });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
  assert.match(facts.singletonReasons.get(second.id) ?? '', /unknown store/);
});

test('unknown atomicity, real ordering, device memory or known volatility each block reuse', () => {
  for (const [field, value, pattern] of [
    ['atomic', 'unknown', /atomicity is unknown/],
    ['atomic', true, /atomicity is yes/],
    ['ordering', 'acquire', /imposes ordering: acquire/],
    ['ordering', 'seq-cst', /imposes ordering: seq-cst/],
    ['addressSpace', 'device', /not ordinary memory/],
    ['volatility', true, /known to be volatile/],
  ]) {
    const f = fixture(`load-${field}-${value}`);
    f.block(0);
    const first = f.load(32, PROVED_LOAD);
    const second = f.load(32, { ...PROVED_LOAD, [field]: value });
    f.ret();
    const { facts } = analyze(f.build());
    assert.equal(congruent(facts, first, second), false, `${field}=${value} must block reuse`);
    assert.match(facts.singletonReasons.get(second.id) ?? '', pattern);
  }
});

test('unproved volatility does not block reuse, because it is not machine-recoverable', () => {
  // `volatile` is a source annotation. Demanding proof of its absence would make
  // load reuse unreachable on every stripped binary forever, rather than merely
  // until an upstream fact lands. What governs re-execution at machine level is
  // the address space, atomicity and ordering, and those are all proved above.
  const f = fixture('load-unknown-volatility');
  f.block(0);
  const first = f.load(32, PROVED_LOAD);
  const second = f.load(32, PROVED_LOAD);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(PROVED_LOAD.volatility, 'unknown');
  assert.equal(congruent(facts, first, second), true);
});

test('the predicate uses the Semantic IR vocabulary, not an invented one', () => {
  // A predicate written against `'no'` or `'unordered'` compiles, runs, and
  // never matches anything the IR emits.
  assert.equal(loadIsReusable({
    extra: { memoryAccess: { addressSpace: 'memory', atomic: 'no', ordering: 'unordered' }, addressPrecise: true },
    loc: { key: 'k' },
  }).ok, false, "'no' is not a value the Semantic IR ever produces for atomicity");
  assert.equal(loadIsReusable({
    extra: { memoryAccess: { addressSpace: 'memory', atomic: false, ordering: 'relaxed' }, addressPrecise: true },
    loc: { key: 'k' },
  }).ok, true);
});

test('an imprecise address blocks reuse', () => {
  const f = fixture('load-imprecise');
  f.block(0);
  const first = f.load(32, PROVED_LOAD);
  const second = f.load(32, { ...PROVED_LOAD, addressPrecise: false });
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, first, second), false);
  assert.match(facts.singletonReasons.get(second.id) ?? '', /address is not proved precise/);
});

test('reuse requires the earlier definition to dominate the later one', () => {
  // Both arms compute the same expression, but neither dominates the other, so
  // neither may be replaced by the other.
  const f = fixture('dominance');
  f.block(0);
  const a = f.opaque(32);
  const b = f.opaque(32);
  f.conditionalBranch(f.opaque(1), 1, 2);
  f.block(1);
  const left = f.binary('add', a, b, 32);
  f.branch(3);
  f.block(2);
  const right = f.binary('add', a, b, 32);
  f.branch(3);
  f.block(3).ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, left, right), true, 'they are the same computation');
  assert.equal(facts.reuseCandidates.some((entry) => entry.valueId === right.id), false,
    'but neither block dominates the other, so neither may be reused');
});

test('every proved constant of the same width is one class, however it was produced', () => {
  const f = fixture('constants');
  f.block(0);
  const direct = f.constant(7n, 32);
  const computed = f.binary('add', f.constant(3n, 32), f.constant(4n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(congruent(facts, direct, computed), true);
});

test('the pass refuses to run before the facts it consumes exist', () => {
  const f = fixture('no-sccp');
  f.block(0);
  f.binary('add', f.opaque(32), f.opaque(32), 32);
  f.ret();
  const state = seedAnalysisState(f.build());
  const outcome = runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, { analysis: state }, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^missing-input:.*ranges/);
});

test('the load reusability predicate answers with a reason, never a bare false', () => {
  assert.equal(loadIsReusable({ extra: { memoryAccess: { addressSpace: 'memory', atomic: false }, addressPrecise: true }, loc: { key: 'k' } }).ok, true);
  const refused = loadIsReusable({ extra: {} });
  assert.equal(refused.ok, false);
  assert.ok(refused.reason.length > 0);
});
