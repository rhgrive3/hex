import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisState, runPassTransaction, seedAnalysisState } from '../../../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../../../js/decompiler/phase8/sccp.js';
import { isFull } from '../../../js/decompiler/phase8/range.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

/**
 * The SCCP contract, proved on architecture-neutral IR.
 *
 * The frozen AArch64 corpus proves the pass is wired into the product. These
 * prove the algorithm: a fixture assembled from one target's assembly would
 * prove things about that target as much as about the optimizer.
 */

const PASS = { descriptor: SCCP_PASS, run: runSccpPass };

function analyze(ir, context = {}) {
  const state = seedAnalysisState(ir);
  const outcome = runPassTransaction(state, PASS, { analysis: state, ...context }, {});
  return { outcome, facts: state.get('ranges'), state };
}

function constantOf(facts, value) {
  return facts.constants.get(value.id) ?? null;
}

test('constants fold at exact width, wrapping rather than growing', () => {
  const f = fixture('wrap');
  f.block(0);
  const big = f.constant(0xFFFFFFF0n, 32);
  const small = f.constant(0x20n, 32);
  const sum = f.binary('add', big, small, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, sum)?.value, 0x10n, 'a 32-bit add must wrap, not become a 33-bit value');
  assert.equal(constantOf(facts, sum)?.bits, 32);
});

test('zero and sign extension of the same bits give different constants', () => {
  const f = fixture('extend');
  f.block(0);
  const narrow = f.constant(0x80n, 8);
  const zero = f.cast('zext', narrow, 32);
  const sign = f.cast('sext', narrow, 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, zero)?.value, 0x80n);
  assert.equal(constantOf(facts, sign)?.value, 0xFFFFFF80n);
});

test('a proved branch makes exactly one arm executable', () => {
  const f = fixture('dead-branch');
  f.block(0).conditionalBranch(f.constant(0n, 1), 1, 2);
  f.block(1).branch(3);
  f.block(2).branch(3);
  f.block(3).ret();
  const { facts } = analyze(f.build());
  assert.deepEqual([...facts.unreachableBlockIndexes], [1], 'the true arm of a false condition is unreachable');
  assert.ok(facts.executableEdges.some((edge) => edge.startsWith('0->2:')));
  assert.ok(!facts.executableEdges.some((edge) => edge.startsWith('0->1:')));
});

test('a phi meets only its executable predecessors', () => {
  // The whole point of the "conditional" in SCCP: the value is constant even
  // though a dead predecessor assigns something else.
  const f = fixture('phi-executable');
  f.block(0).conditionalBranch(f.constant(0n, 1), 1, 2);
  const dead = (() => { f.block(1); const value = f.constant(111n, 32); f.branch(3); return value; })();
  const live = (() => { f.block(2); const value = f.constant(222n, 32); f.branch(3); return value; })();
  f.block(3);
  const merged = f.phi([[1, dead], [2, live]], 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, merged)?.value, 222n, 'the unreachable predecessor must contribute nothing');
});

test('a phi over two reachable predecessors with different constants is not constant', () => {
  // The near miss: same shape, both arms live, so the answer is unknown.
  const f = fixture('phi-overdefined');
  f.block(0).conditionalBranch(f.opaque(1), 1, 2);
  const left = (() => { f.block(1); const value = f.constant(111n, 32); f.branch(3); return value; })();
  const right = (() => { f.block(2); const value = f.constant(222n, 32); f.branch(3); return value; })();
  f.block(3);
  const merged = f.phi([[1, left], [2, right]], 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, merged), null);
  assert.match(facts.overdefinedReasons.get(merged.id) ?? '', /disagree/);
  // The range still says something useful even though the constant does not.
  assert.equal(facts.ranges.get(merged.id) != null, true);
});

test('an unresolved branch leaves both arms executable', () => {
  const f = fixture('unresolved');
  f.block(0).conditionalBranch(f.opaque(1), 1, 2);
  f.block(1).branch(3);
  f.block(2).branch(3);
  f.block(3).ret();
  const { facts } = analyze(f.build());
  assert.deepEqual([...facts.unreachableBlockIndexes], []);
  assert.ok(facts.executableEdges.some((edge) => edge.startsWith('0->1:')));
  assert.ok(facts.executableEdges.some((edge) => edge.startsWith('0->2:')));
});

test('a value from memory stays unknown and says why', () => {
  const f = fixture('memory');
  f.block(0);
  const loaded = f.load(32);
  const sum = f.binary('add', loaded, f.constant(1n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, loaded), null);
  assert.equal(facts.overdefinedReasons.get(loaded.id), 'value comes from memory');
  assert.equal(constantOf(facts, sum), null, 'a constant added to an unknown is not a constant');
});

test('an operation the semantic IR could not represent stays unknown', () => {
  const f = fixture('unknown-op');
  f.block(0);
  const opaque = f.unknown(64);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(facts.overdefinedReasons.get(opaque.id), 'operation is not represented in the semantic IR');
  assert.equal(isFull(facts.ranges.get(opaque.id)), true, 'an unknown value has the full range, not a guessed one');
});

test('a shift past the width is not folded', () => {
  const f = fixture('wide-shift');
  f.block(0);
  const shifted = f.binary('shl', f.constant(1n, 32), f.constant(32n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, shifted), null, 'a shift at the width is target-defined and must not be folded');
  assert.match(facts.overdefinedReasons.get(shifted.id) ?? '', /not exactly modelled/);
});

test('division by a constant zero is not folded', () => {
  const f = fixture('div-zero');
  f.block(0);
  const divided = f.binary('udiv', f.constant(10n, 32), f.constant(0n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, divided), null);
});

test('a select with a proved condition takes the chosen arm only', () => {
  const f = fixture('select');
  f.block(0);
  const chosen = f.select(f.constant(1n, 1), f.constant(7n, 32), f.constant(9n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, chosen)?.value, 7n);
});

test('a select with an unknown condition is the union of its arms', () => {
  const f = fixture('select-unknown');
  f.block(0);
  const chosen = f.select(f.opaque(1), f.constant(7n, 32), f.constant(9n, 32), 32);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(constantOf(facts, chosen), null);
  const range = facts.ranges.get(chosen.id);
  assert.equal(range.lower, 7n);
  assert.equal(range.upper, 9n);
});

test('a loop-carried value converges under a bounded number of visits', () => {
  const f = fixture('loop');
  f.block(0);
  const start = f.constant(0n, 32);
  f.branch(1);
  f.block(1);
  const counter = f.phi([[0, start]], 32);
  const next = f.binary('add', counter, f.constant(1n, 32), 32);
  counter.def.incoming.push({ from: 1, value: next });
  next.uses.push(counter.def);
  f.conditionalBranch(f.opaque(1), 1, 2);
  f.block(2).ret();
  const { facts, outcome } = analyze(f.build());
  assert.equal(outcome.committed, true);
  assert.equal(facts.completeness, 'complete', 'the analysis must reach a fixed point, not run out of budget');
  assert.ok(facts.workItems < 5000, `convergence took ${facts.workItems} work items`);
  // The counter is not a single constant, and the domain says so rather than
  // claiming the initial value.
  assert.equal(constantOf(facts, counter), null);
});

test('the pass produces a fact, rewrites nothing, and invalidates nothing', () => {
  const f = fixture('facts');
  f.block(0);
  f.binary('add', f.constant(1n, 32), f.constant(2n, 32), 32);
  f.ret();
  const { outcome, state } = analyze(f.build());
  assert.equal(outcome.committed, true);
  assert.deepEqual([...outcome.staged], ['ranges']);
  assert.deepEqual([...outcome.result.transforms], [], 'SCCP is an analysis; it must not claim a program transformation');
  assert.deepEqual([...outcome.result.produced], ['ranges']);
  assert.deepEqual([...outcome.invalidated], [], 'publishing a fact must not discard unrelated analyses');
  assert.equal(state.version('ssa'), 1, 'SSA must keep its version and its reuse');
});

test('the pass refuses to run without the facts it declares it consumes', () => {
  const state = createAnalysisState({});
  const outcome = runPassTransaction(state, PASS, { analysis: state }, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^missing-input:/);
});

test('cancellation leaves no facts behind', () => {
  const f = fixture('cancelled');
  f.block(0);
  f.binary('add', f.constant(1n, 32), f.constant(2n, 32), 32);
  f.ret();
  const state = seedAnalysisState(f.build());
  const outcome = runPassTransaction(state, PASS, { analysis: state }, { shouldAbort: () => true });
  assert.equal(outcome.committed, false);
  assert.equal(state.version('ranges'), 0, 'a cancelled analysis must not publish partial facts');
});

test('a work budget that runs out reports partial, not complete', () => {
  const f = fixture('budget');
  f.block(0);
  let previous = f.constant(1n, 32);
  for (let index = 0; index < 200; index += 1) previous = f.binary('add', previous, f.constant(1n, 32), 32);
  f.ret();
  const state = seedAnalysisState(f.build());
  runPassTransaction(state, PASS, { analysis: state, sccpLimits: { maxWorkItems: 20, maxVisitsPerValue: 2 } }, {});
  const facts = state.get('ranges');
  assert.equal(facts.completeness, 'partial', 'a fixed point that was not reached is not a fixed point');
});

test('two runs over the same input agree exactly', () => {
  const build = () => {
    const f = fixture('determinism');
    f.block(0).conditionalBranch(f.constant(1n, 1), 1, 2);
    const left = (() => { f.block(1); const value = f.constant(5n, 32); f.branch(3); return value; })();
    const right = (() => { f.block(2); const value = f.constant(6n, 32); f.branch(3); return value; })();
    f.block(3);
    f.phi([[1, left], [2, right]], 32);
    f.ret();
    return f.build();
  };
  const [first, second] = [analyze(build()).facts, analyze(build()).facts];
  assert.deepEqual([...first.executableEdges], [...second.executableEdges]);
  assert.deepEqual([...first.unreachableBlockIndexes], [...second.unreachableBlockIndexes]);
  assert.equal(first.constants.size, second.constants.size);
  assert.equal(first.workItems, second.workItems);
});

test('an unsupported width is unknown rather than approximated', () => {
  const f = fixture('odd-width');
  f.block(0);
  const odd = f.copy(f.constant(1n, 32), 24);
  f.ret();
  const { facts } = analyze(f.build());
  assert.equal(facts.constants.get(odd.id), undefined);
  assert.match(facts.overdefinedReasons.get(odd.id) ?? '', /unsupported width/);
});
