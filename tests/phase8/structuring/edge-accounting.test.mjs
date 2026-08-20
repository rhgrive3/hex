/**
 * P8-5 — every edge accounted for.
 *
 * The claim under test is not "this CFG became a tidy while loop". It is that
 * every edge in the original CFG is still there and can be named: a structured
 * construct, an explicit jump, or an explicit unknown. An edge in none of those
 * three answers has been lost, and a lost edge is a path through the program the
 * reader will never see.
 *
 * `gotoCount` is checked here only to prove it is *not* a gate. A correct jump
 * beats a false loop; driving that number down is not an objective and no
 * assertion in this file rewards it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS_STAGES } from '../../../js/decompiler/phase8/contract.js';
import {
  EDGE_CONSTRUCTS, STRUCTURING_PASS, STRUCTURING_SUMMARY_VERSION,
  describeStructuring, edgeAccountingFailures, observableEffectsIn,
  runPhase8Stage, successorEdgesOf,
} from '../../../js/decompiler/phase8/index.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function structuring(ir, { timeBudgetMs = 2000, shouldAbort = undefined } = {}) {
  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs, shouldAbort });
  return { ledger, facts: ledger.published ? analysis.get('structuredRegions') : null };
}

/** Every edge, as `from->to:construct`, sorted. The whole accounting at a glance. */
function accounting(facts) {
  return facts.edges.map((edge) => `${edge.from}->${edge.to}:${edge.construct}`).sort();
}

test('an if/else has two arms and a join, and every edge is named', () => {
  const f = fixture('if-else');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  const ir = f.build();
  const { facts } = structuring(ir);
  assert.deepEqual(accounting(facts), ['0->1:if-branch', '0->2:if-branch', '1->3:sequence', '2->3:sequence']);
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
  const region = facts.regions.find((entry) => entry.kind === 'conditional');
  assert.equal(region.entry, 0);
  assert.deepEqual([...region.exits], [3]);
});

test('a switch names each case and its join', () => {
  const f = fixture('switch');
  const selector = f.block(0, { succ: [1, 2, 3] }).opaque(32);
  f.switchBranch(selector, [1, 2], 3);
  f.block(1, { succ: [4] }).branch(4);
  f.block(2, { succ: [4] }).branch(4);
  f.block(3, { succ: [4] }).branch(4);
  f.block(4).ret();
  const ir = f.build();
  const { facts } = structuring(ir);
  const constructs = facts.edges.filter((edge) => edge.from === 0).map((edge) => edge.construct);
  assert.deepEqual(constructs, ['switch-case', 'switch-case', 'switch-case']);
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
  const region = facts.regions.find((entry) => entry.kind === 'switch');
  assert.equal(region.entry, 0);
  assert.deepEqual([...region.exits], [4]);
  // The default edge keeps its own kind; it is not relabelled to look like a case.
  const defaultEdge = facts.edges.find((edge) => edge.from === 0 && edge.to === 3);
  assert.ok(defaultEdge.kinds.includes('switch-default'));
});

test('nested loops name the back edge, the entry and the guard exit at each level', () => {
  const f = fixture('nested');
  f.block(0);
  const zero = f.constant(0, 32);
  const outerLimit = f.constant(4, 32);
  const innerLimit = f.constant(3, 32);
  f.branch(1);
  f.block(1, { succ: [2, 6] });
  const outer = f.phi([[0, zero], [5, null]], 32);
  f.conditionalBranch(f.binary('ult', outer, outerLimit, 1), 2, 6);
  f.block(2, { succ: [3, 5] });
  const inner = f.phi([[1, zero], [3, null]], 32);
  f.conditionalBranch(f.binary('ult', inner, innerLimit, 1), 3, 5);
  f.block(3, { succ: [2] });
  f.closePhi(inner, 3, f.binary('add', inner, f.constant(1, 32), 32));
  f.branch(2);
  f.block(5, { succ: [1] });
  f.closePhi(outer, 5, f.binary('add', outer, f.constant(1, 32), 32));
  f.branch(1);
  f.block(6).ret();
  const ir = f.build();
  const { facts } = structuring(ir);
  assert.deepEqual(accounting(facts), [
    '0->1:loop-entry',
    '1->2:loop-entry',
    '1->6:loop-guard-exit',
    '2->3:loop-body',
    '2->5:loop-guard-exit',
    '3->2:loop-back-edge',
    '5->1:loop-back-edge',
  ]);
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
  const loops = facts.regions.filter((entry) => entry.kind === 'loop');
  assert.deepEqual(loops.map((entry) => entry.entry), [1, 2]);
  assert.equal(loops.find((entry) => entry.entry === 2).parentEntry, 1);
});

test('a loop with two break targets keeps one as an explicit jump', () => {
  const f = fixture('multi-exit');
  f.block(0);
  const zero = f.constant(0, 32);
  const limit = f.constant(9, 32);
  const bail = f.opaque(1);
  f.branch(1);
  f.block(1, { succ: [2, 5] });
  const counter = f.phi([[0, zero], [3, null]], 32);
  f.conditionalBranch(f.binary('ult', counter, limit, 1), 2, 5);
  f.block(2, { succ: [3, 6] });
  f.closePhi(counter, 3, f.binary('add', counter, f.constant(1, 32), 32));
  f.conditionalBranch(bail, 6, 3);
  f.block(3, { succ: [1] }).branch(1);
  f.block(5).ret();
  f.block(6).ret();
  const ir = f.build();
  const { facts } = structuring(ir);
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
  const guardExit = facts.edges.find((edge) => edge.from === 1 && edge.to === 5);
  assert.equal(guardExit.construct, 'loop-guard-exit');
  // One break target besides the guard exit is a plain break.
  const breakEdge = facts.edges.find((edge) => edge.from === 2 && edge.to === 6);
  assert.equal(breakEdge.construct, 'loop-break');
});

test('an edge whose kind this pass does not know becomes a constraint, never a construct', () => {
  const f = fixture('unwind');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3, 4], edges: [{ to: 3, kind: 'branch' }, { to: 4, kind: 'unwind' }] });
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  f.block(4).ret();
  const ir = f.build();
  const { facts } = structuring(ir);
  const unwind = facts.edges.find((edge) => edge.from === 1 && edge.to === 4);
  assert.equal(unwind.construct, 'constraint-edge');
  assert.match(unwind.reason, /"unwind"/);
  assert.equal(facts.constraintEdgeCount, 1);
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
});

test('a foreign kind on an edge that also looks ordinary still makes it a constraint', () => {
  const f = fixture('mixed-kind');
  f.block(0, { succ: [1], edges: [{ to: 1, kind: 'branch' }, { to: 1, kind: 'indirect-candidate' }] });
  f.opaque(32);
  f.branch(1);
  f.block(1).ret();
  const ir = f.build();
  const { facts } = structuring(ir);
  assert.equal(facts.edges.length, 1, 'two labels on one target are one edge');
  assert.equal(facts.edges[0].construct, 'constraint-edge');
  assert.deepEqual([...facts.edges[0].kinds], ['branch', 'indirect-candidate']);
});

test('an irreducible region becomes explicit jumps, never a loop', () => {
  const f = fixture('irreducible');
  const pick = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(pick, 1, 2);
  f.block(1, { succ: [2] }).branch(2);
  f.block(2, { succ: [1, 3] });
  f.conditionalBranch(f.opaque(1), 1, 3);
  f.block(3).ret();
  const ir = f.build({ loops: [{ header: 1, latches: new Set([2]), nodes: new Set([1, 2]), exits: new Set([3]) }] });
  const { facts } = structuring(ir);
  assert.ok(facts.regions.some((entry) => entry.kind === 'irreducible'), 'the region must be reported as irreducible');
  assert.ok(!facts.regions.some((entry) => entry.kind === 'loop'), 'nothing here is a loop');
  for (const edge of facts.edges.filter((entry) => entry.from === 1 || entry.from === 2)) {
    assert.equal(edge.construct, 'residual-goto', `${edge.from}->${edge.to} was structured inside an irreducible region`);
  }
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
});

test('false structuring: an arm that does not reach the join is an explicit jump', () => {
  const f = fixture('no-converge');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  // Arm 1 rejoins at 3. Arm 2 jumps into the middle of the other arm's tail, so
  // the two arms do not form a region with one exit.
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [4] }).branch(4);
  f.block(3, { succ: [4] }).branch(4);
  f.block(4).ret();
  const ir = f.build();
  const { facts } = structuring(ir);
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);
  // Whatever it decides, it must not claim a join the CFG does not have.
  const join = facts.regions.find((entry) => entry.kind === 'conditional');
  if (join != null) assert.deepEqual([...join.exits], [4]);
});

test('a necessary jump is preserved, and nothing in the artifact rewards removing it', () => {
  const f = fixture('necessary-goto');
  const pick = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(pick, 1, 2);
  f.block(1, { succ: [2] }).branch(2);
  f.block(2, { succ: [1, 3] });
  f.conditionalBranch(f.opaque(1), 1, 3);
  f.block(3).ret();
  const ir = f.build({ loops: [{ header: 1, latches: new Set([2]), nodes: new Set([1, 2]), exits: new Set([3]) }] });
  const { facts } = structuring(ir);
  assert.ok(facts.residualGotoCount > 0, 'the jump this CFG needs was removed');
  // The count is published as an observation. It is not part of any pass status,
  // completeness or gate, and a run with jumps is as complete as one without.
  assert.equal(facts.completeness, 'complete');
});

test('a block carrying an observable effect is not offered for splitting', () => {
  const f = fixture('split-effects');
  const pick = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(pick, 1, 2);
  f.block(1, { succ: [2] }).branch(2);
  f.block(2, { succ: [1, 3] });
  f.call(64);
  f.conditionalBranch(f.opaque(1), 1, 3);
  f.block(3).ret();
  const ir = f.build({ loops: [{ header: 1, latches: new Set([2]), nodes: new Set([1, 2]), exits: new Set([3]) }] });
  const { facts } = structuring(ir);
  const withCall = facts.splitCandidates.find((candidate) => candidate.blockIndex === 2);
  assert.ok(withCall, 'the jump target should have been considered');
  assert.equal(withCall.offered, false);
  assert.match(withCall.proof, /duplicate observable operations/);
  assert.ok(withCall.observableEffects.length > 0);
  // Provenance survives on every candidate, offered or not.
  assert.ok(withCall.origin.instructionIds.length > 0);
});

test('observableEffectsIn names what it found rather than answering yes or no', () => {
  const f = fixture('effects');
  f.block(0);
  f.store(f.constant(1, 32), { locKey: 'stack:-4' });
  f.call(64);
  f.binary('add', f.constant(1, 32), f.constant(2, 32), 32);
  f.ret();
  const [block] = f.build().blocks;
  const effects = observableEffectsIn(block);
  assert.ok(effects.some((entry) => entry.startsWith('store')));
  assert.ok(effects.some((entry) => entry.startsWith('call')));
  assert.ok(!effects.some((entry) => entry.startsWith('bin')));
});

test('the independent recount catches an accounting that has quietly dropped an edge', () => {
  const f = fixture('doctored');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  const ir = f.build();
  const { facts } = structuring(ir);
  assert.deepEqual(edgeAccountingFailures(ir, facts), []);

  const missing = { ...facts, edges: facts.edges.filter((edge) => !(edge.from === 0 && edge.to === 2)) };
  const dropped = edgeAccountingFailures(ir, missing);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].problem, 'unaccounted-edge');

  const invented = { ...facts, edges: [...facts.edges, { from: 3, to: 0, kinds: ['branch'], construct: 'sequence', reason: 'made up' }] };
  assert.ok(edgeAccountingFailures(ir, invented).some((failure) => failure.problem === 'invented-edge'));

  const unlabelled = { ...facts, edges: facts.edges.map((edge) => (edge.from === 0 && edge.to === 1 ? { ...edge, kinds: [] } : edge)) };
  assert.ok(edgeAccountingFailures(ir, unlabelled).some((failure) => failure.problem === 'dropped-edge-kind'));

  const unreasoned = { ...facts, edges: facts.edges.map((edge) => ({ ...edge, reason: '' })) };
  assert.ok(edgeAccountingFailures(ir, unreasoned).some((failure) => failure.problem === 'no-reason'));

  assert.deepEqual(edgeAccountingFailures(ir, null), [{ problem: 'no-accounting', detail: 'the structuring pass published nothing for this function' }]);
});

test('two labels on one target are one edge, and both labels survive', () => {
  // The upstream CFG names the not-taken arm twice, `conditional-false` and
  // `fallthrough`, for the same block. Counting that as two edges would let the
  // accounting agree with itself while disagreeing with the CFG.
  const block = {
    index: 0,
    succ: [1, 2],
    successorEdges: [
      { to: 1, kind: 'conditional-false' },
      { to: 1, kind: 'fallthrough' },
      { to: 2, kind: 'conditional-true' },
    ],
  };
  const edges = successorEdgesOf(block);
  assert.equal(edges.length, 2);
  assert.deepEqual(edges.find((edge) => edge.to === 1).kinds, ['conditional-false', 'fallthrough']);
});

test('every construct the pass can emit is one the contract declares', () => {
  const f = fixture('constructs');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  const { facts } = structuring(f.build());
  for (const edge of facts.edges) assert.ok(EDGE_CONSTRUCTS.includes(edge.construct), edge.construct);
  for (const key of Object.keys(facts.edgesByConstruct)) assert.ok(EDGE_CONSTRUCTS.includes(key), key);
});

test('the pass transforms nothing and publishes exactly one analysis', () => {
  const f = fixture('no-transform');
  f.block(0, { succ: [1] });
  f.opaque(32);
  f.branch(1);
  f.block(1).ret();
  const { ledger, facts } = structuring(f.build());
  const result = ledger.passes.find((entry) => entry.passId === 'phase8.structuring');
  assert.equal(result.transforms.length, 0);
  assert.deepEqual([...result.produced], ['structuredRegions']);
  assert.deepEqual([...result.invalidated], []);
  assert.equal(facts.summaryVersion, STRUCTURING_SUMMARY_VERSION);
  assert.equal(STRUCTURING_PASS.stage, 'structuring');
  assert.ok(STRUCTURING_PASS.consumes.includes('induction'), 'loop facts come from P8-4, not from a second detector');
});

test('every edge record carries provenance and a reason', () => {
  const f = fixture('provenance');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  const { facts } = structuring(f.build());
  for (const edge of facts.edges) {
    assert.ok(edge.origin.instructionIds.length > 0, `${edge.from}->${edge.to} lost its origin`);
    assert.ok(edge.reason.length > 0);
  }
  for (const region of facts.regions) assert.ok(region.origin.instructionIds.length > 0);
});

test('the accounting is identical across runs', () => {
  const f = fixture('deterministic');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  const ir = f.build();
  assert.equal(JSON.stringify(structuring(ir).facts), JSON.stringify(structuring(ir).facts));
});

test('cancellation withholds the whole ledger rather than publishing a partial accounting', () => {
  const f = fixture('cancelled');
  const condition = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(condition, 1, 2);
  f.block(1, { succ: [3] }).branch(3);
  f.block(2, { succ: [3] }).branch(3);
  f.block(3).ret();
  let calls = 0;
  const { ledger, facts } = structuring(f.build(), { shouldAbort: () => { calls += 1; return calls > 2; } });
  assert.equal(ledger.published, false);
  assert.equal(facts, null);
});

test('describeStructuring reports the constructs rather than a score', () => {
  const f = fixture('describe');
  f.block(0, { succ: [1] });
  f.opaque(32);
  f.branch(1);
  f.block(1).ret();
  const { facts } = structuring(f.build());
  assert.match(describeStructuring(facts), /1 edges: sequence 1/);
  assert.equal(describeStructuring(null), 'no structuring facts');
});
