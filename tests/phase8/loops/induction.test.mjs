/**
 * P8-4 — loop induction and loop simplification facts.
 *
 * The fixtures here name no register, no flag and no ABI. Their CFG, dominator
 * and loop facts all come from the product's own `analyzeGraph`, so what these
 * tests prove is that the Phase 8 pass reads the canonical loop facts correctly
 * — not that a second loop detector agrees with itself.
 *
 * Every transform-shaped claim gets the same seven questions: does it apply when
 * it should, does it stay away when it nearly should, does partial evidence stay
 * partial, does width and signedness change the answer, does a barrier stop it,
 * is the provenance intact, and is the result the same twice.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS_STAGES } from '../../../js/decompiler/phase8/contract.js';
import {
  INDUCTION_PASS, INDUCTION_SUMMARY_VERSION, classifyLoop, describeLoopFacts,
  readGuardPredicate, runPhase8Stage, tripCountOf,
} from '../../../js/decompiler/phase8/index.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

/** Runs the whole Phase 8 vertical and returns the published loop facts. */
function inductionFacts(ir, { timeBudgetMs = 2000, shouldAbort = undefined } = {}) {
  const { ledger, analysis } = runPhase8Stage({ ir }, { stages: PASS_STAGES, timeBudgetMs, shouldAbort });
  return { ledger, facts: ledger.published ? analysis.get('induction') : null };
}

function onlyLoop(ir) {
  const { facts } = inductionFacts(ir);
  assert.ok(facts, 'the vertical published nothing');
  assert.equal(facts.loops.length, 1, `expected one loop, got ${facts.loops.length}`);
  return { summary: facts, loop: facts.loops[0] };
}

/**
 * `i = start; while (i <pred> bound) { body; i += step }` — a pre-test counted
 * loop, built out of nothing but generic SSA.
 */
function countedLoop({ start = 0, bound = 10, step = 1n, predicate = 'ult', bits = 32, name = 'counted' } = {}) {
  const f = fixture(name);
  f.block(0);
  const init = f.constant(start, bits);
  const limit = f.constant(bound, bits);
  f.branch(1);
  f.block(1, { succ: [2, 3] });
  const counter = f.phi([[0, init], [2, null]], bits);
  const condition = f.binary(predicate, counter, limit, 1);
  f.conditionalBranch(condition, 2, 3);
  f.block(2, { succ: [1] });
  const magnitude = f.constant(step < 0n ? -step : step, bits);
  const next = f.binary(step < 0n ? 'sub' : 'add', counter, magnitude, bits);
  f.closePhi(counter, 2, next);
  f.branch(1);
  f.block(3);
  f.ret();
  return { ir: f.build(), counter, next, init, limit };
}

test('a canonical counted loop yields init, step, bound and an exact trip count', () => {
  const { loop } = onlyLoop(countedLoop().ir);
  assert.equal(loop.classification, 'natural');
  assert.equal(loop.inductions.length, 1);
  const [fact] = loop.inductions;
  assert.equal(fact.kind, 'integer');
  assert.equal(fact.init.constant, 0n);
  assert.equal(fact.step, 1n);
  assert.equal(fact.guard.predicate, 'ult');
  assert.equal(fact.bound.constant, 10n);
  assert.equal(fact.tripCount.exact, 10n);
  assert.equal(fact.tripCount.completeness, 'complete');
  assert.equal(fact.wraps, false);
  assert.equal(fact.completeness, 'complete');
});

test('a decrementing loop is counted in its own direction', () => {
  const { loop } = onlyLoop(countedLoop({ start: 10, bound: 0, step: -1n, predicate: 'ugt' }).ir);
  const [fact] = loop.inductions;
  assert.equal(fact.step, -1n);
  assert.equal(fact.guard.predicate, 'ugt');
  assert.equal(fact.tripCount.exact, 10n);
});

test('a non-unit step counts the iterations, not the distance', () => {
  const { loop } = onlyLoop(countedLoop({ start: 0, bound: 10, step: 3n }).ir);
  const [fact] = loop.inductions;
  assert.equal(fact.step, 3n);
  // 0, 3, 6, 9 — four iterations, not ten.
  assert.equal(fact.tripCount.exact, 4n);
});

test('a counter that wraps its width before the guard fails has no exact trip count', () => {
  const { loop } = onlyLoop(countedLoop({ start: 250, bound: 255, step: 10n, bits: 8 }).ir);
  const [fact] = loop.inductions;
  assert.equal(fact.step, 10n);
  assert.equal(fact.tripCount.exact, null);
  assert.equal(fact.tripCount.completeness, 'partial');
  assert.match(fact.tripCount.reason, /wraps its width/);
  assert.equal(fact.wraps, 'unknown');
});

test('the same numbers at a wider width do not wrap', () => {
  const { loop } = onlyLoop(countedLoop({ start: 250, bound: 255, step: 10n, bits: 16 }).ir);
  assert.equal(loop.inductions[0].tripCount.exact, 1n);
});

test('signedness comes from the predicate, and a signed bound is read as signed', () => {
  // -3 as an 8-bit pattern is 253. Read unsigned it is above the start; read
  // signed it is below it, and the loop does not run at all.
  const { loop } = onlyLoop(countedLoop({ start: 0, bound: 253, step: 1n, predicate: 'slt', bits: 8 }).ir);
  const [fact] = loop.inductions;
  assert.equal(fact.signedness, 'signed');
  assert.equal(fact.tripCount.exact, 0n);
  const unsigned = onlyLoop(countedLoop({ start: 0, bound: 253, step: 1n, predicate: 'ult', bits: 8 }).ir);
  assert.equal(unsigned.loop.inductions[0].signedness, 'unsigned');
  assert.equal(unsigned.loop.inductions[0].tripCount.exact, 253n);
});

test('a variable step stays unresolved with its reason, and never becomes a fact', () => {
  const f = fixture('variable-step');
  f.block(0);
  const init = f.constant(0, 32);
  const limit = f.constant(10, 32);
  const amount = f.opaque(32);
  f.branch(1);
  f.block(1, { succ: [2, 3] });
  const counter = f.phi([[0, init], [2, null]], 32);
  f.conditionalBranch(f.binary('ult', counter, limit, 1), 2, 3);
  f.block(2, { succ: [1] });
  f.closePhi(counter, 2, f.binary('add', counter, amount, 32));
  f.branch(1);
  f.block(3);
  f.ret();
  const { loop } = onlyLoop(f.build());
  assert.equal(loop.inductions.length, 0);
  assert.equal(loop.unresolvedLoopValues.length, 1);
  assert.equal(loop.unresolvedLoopValues[0].reason, 'the step is a variable value');
  assert.equal(loop.completeness, 'partial');
});

test('a value the loop advances into a load address is a pointer induction', () => {
  const f = fixture('pointer');
  f.block(0);
  const base = f.opaque(64);
  const limit = f.opaque(64);
  f.branch(1);
  f.block(1, { succ: [2, 3] });
  const cursor = f.phi([[0, base], [2, null]], 64);
  f.conditionalBranch(f.binary('ult', cursor, limit, 1), 2, 3);
  f.block(2, { succ: [1] });
  f.load(32, { addrBase: cursor, locKey: 'array:0' });
  f.closePhi(cursor, 2, f.binary('add', cursor, f.constant(4, 64), 64));
  f.branch(1);
  f.block(3);
  f.ret();
  const { loop } = onlyLoop(f.build());
  assert.equal(loop.inductions.length, 1);
  assert.equal(loop.inductions[0].kind, 'pointer');
  assert.equal(loop.inductions[0].addressRole, 'base');
  assert.equal(loop.inductions[0].step, 4n);
  // The bound is not a constant, so no trip count may be claimed.
  assert.equal(loop.inductions[0].tripCount.exact, null);
});

test('an early exit bounds the trip count from above instead of fixing it', () => {
  const f = fixture('early-exit');
  f.block(0);
  const init = f.constant(0, 32);
  const limit = f.constant(8, 32);
  const bail = f.opaque(1);
  f.branch(1);
  f.block(1, { succ: [2, 4] });
  const counter = f.phi([[0, init], [2, null]], 32);
  f.conditionalBranch(f.binary('ult', counter, limit, 1), 2, 4);
  f.block(2, { succ: [3, 4] });
  f.closePhi(counter, 2, f.binary('add', counter, f.constant(1, 32), 32));
  f.conditionalBranch(bail, 4, 3);
  f.block(3, { succ: [1] });
  f.branch(1);
  f.block(4);
  f.ret();
  const ir = f.build();
  const { facts } = inductionFacts(ir);
  const loop = facts.loops.find((entry) => entry.header === 1);
  assert.ok(loop, 'the header loop was not reported');
  assert.equal(loop.guardBlock, 1);
  assert.equal(loop.earlyExitEdges.length, 1);
  const [fact] = loop.inductions;
  assert.equal(fact.tripCount.exact, null);
  assert.equal(fact.tripCount.minimum, 0n);
  assert.equal(fact.tripCount.maximum, 8n);
  assert.match(fact.tripCount.reason, /early exit/);
  // A loop that can leave early is not a counted loop.
  assert.equal(facts.simplificationCandidates.length, 0);
});

test('nested loops get their depth and their parent, from the node sets they arrived with', () => {
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
  f.block(6);
  f.ret();
  const { facts } = inductionFacts(f.build());
  assert.equal(facts.loops.length, 2);
  const outerLoop = facts.loops.find((entry) => entry.header === 1);
  const innerLoop = facts.loops.find((entry) => entry.header === 2);
  assert.equal(outerLoop.depth, 0);
  assert.equal(outerLoop.parentHeader, null);
  assert.equal(innerLoop.depth, 1);
  assert.equal(innerLoop.parentHeader, 1);
  assert.equal(outerLoop.inductions[0].tripCount.exact, 4n);
  assert.equal(innerLoop.inductions[0].tripCount.exact, 3n);
});

test('a copy between the update and the phi is transparent; a width cast is not', () => {
  const build = (hide) => {
    const f = fixture(`hidden-${hide}`);
    f.block(0);
    const init = f.constant(0, 32);
    const limit = f.constant(6, 32);
    f.branch(1);
    f.block(1, { succ: [2, 3] });
    const counter = f.phi([[0, init], [2, null]], 32);
    f.conditionalBranch(f.binary('ult', counter, limit, 1), 2, 3);
    f.block(2, { succ: [1] });
    const raw = f.binary('add', counter, f.constant(1, 32), 32);
    const hidden = hide === 'copy' ? f.copy(raw, 32) : f.cast('trunc', f.cast('zext', raw, 64), 32);
    f.closePhi(counter, 2, hidden);
    f.branch(1);
    f.block(3);
    f.ret();
    return f.build();
  };
  const copied = onlyLoop(build('copy')).loop;
  assert.equal(copied.inductions.length, 1);
  assert.equal(copied.inductions[0].step, 1n);
  assert.equal(copied.inductions[0].tripCount.exact, 6n);
  assert.ok(copied.inductions[0].evidence.includes('the update reaches the phi through a copy chain'));

  const cast = onlyLoop(build('cast')).loop;
  assert.equal(cast.inductions.length, 0);
  assert.match(cast.unresolvedLoopValues[0].reason, /trunc cast, which moves the wrap boundary/);
});

test('two back edges agree on a step but still refuse an exact trip count', () => {
  const f = fixture('two-latches');
  f.block(0);
  const init = f.constant(0, 32);
  const limit = f.constant(9, 32);
  const pick = f.opaque(1);
  f.branch(1);
  f.block(1, { succ: [2, 5] });
  const counter = f.phi([[0, init], [3, null], [4, null]], 32);
  f.conditionalBranch(f.binary('ult', counter, limit, 1), 2, 5);
  f.block(2, { succ: [3, 4] });
  const next = f.binary('add', counter, f.constant(1, 32), 32);
  f.conditionalBranch(pick, 3, 4);
  f.block(3, { succ: [1] });
  f.closePhi(counter, 3, next);
  f.branch(1);
  f.block(4, { succ: [1] });
  f.closePhi(counter, 4, f.copy(next, 32));
  f.branch(1);
  f.block(5);
  f.ret();
  const { loop } = onlyLoop(f.build());
  assert.equal(loop.multipleBackEdges, true);
  assert.equal(loop.latches.length, 2);
  assert.equal(loop.inductions[0].step, 1n);
  assert.equal(loop.inductions[0].tripCount.exact, null);
  assert.match(loop.inductions[0].tripCount.reason, /more than one back edge/);
});

test('back edges that update the variable differently give it no step at all', () => {
  const f = fixture('disagreeing-latches');
  f.block(0);
  const init = f.constant(0, 32);
  const limit = f.constant(9, 32);
  const pick = f.opaque(1);
  f.branch(1);
  f.block(1, { succ: [2, 5] });
  const counter = f.phi([[0, init], [3, null], [4, null]], 32);
  f.conditionalBranch(f.binary('ult', counter, limit, 1), 2, 5);
  f.block(2, { succ: [3, 4] });
  f.conditionalBranch(pick, 3, 4);
  f.block(3, { succ: [1] });
  f.closePhi(counter, 3, f.binary('add', counter, f.constant(1, 32), 32));
  f.branch(1);
  f.block(4, { succ: [1] });
  f.closePhi(counter, 4, f.binary('add', counter, f.constant(2, 32), 32));
  f.branch(1);
  f.block(5);
  f.ret();
  const { loop } = onlyLoop(f.build());
  assert.equal(loop.inductions.length, 0);
  assert.equal(loop.unresolvedLoopValues[0].reason, 'the back edges update the loop variable by different amounts');
});

test('a region the header does not dominate is refused, and keeps every exit edge', () => {
  // A two-entry cycle. `analyzeGraph` never calls this a natural loop, so the
  // record is injected by hand: the point of the check is that a loop record
  // arriving from anywhere is verified against the dominator facts rather than
  // believed.
  const f = fixture('irreducible');
  const pick = f.block(0, { succ: [1, 2] }).opaque(1);
  f.conditionalBranch(pick, 1, 2);
  f.block(1, { succ: [2] });
  f.branch(2);
  f.block(2, { succ: [1, 3] });
  f.conditionalBranch(f.opaque(1), 1, 3);
  f.block(3);
  f.ret();
  const ir = f.build({ loops: [{ header: 1, latches: new Set([2]), nodes: new Set([1, 2]), exits: new Set([3]) }] });
  const { facts } = inductionFacts(ir);
  const [loop] = facts.loops;
  assert.equal(loop.classification, 'irreducible');
  assert.match(loop.classificationReason, /reachable without passing through header 1/);
  assert.equal(loop.inductions.length, 0);
  assert.equal(facts.refusals.length, 1);
  assert.equal(facts.simplificationCandidates.length, 0);
  // The exit edge is still reported, with its kind, for structuring to consume.
  assert.deepEqual(loop.exitEdges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`), ['2->3:conditional-false']);
});

test('exit edges keep their kinds, including edges that are not the loop guard', () => {
  const f = fixture('exit-kinds');
  f.block(0);
  const init = f.constant(0, 32);
  const limit = f.constant(4, 32);
  f.branch(1);
  f.block(1, { succ: [2, 4] });
  const counter = f.phi([[0, init], [2, null]], 32);
  f.conditionalBranch(f.binary('ult', counter, limit, 1), 2, 4);
  f.block(2, { succ: [1, 5], edges: [{ to: 1, kind: 'branch' }, { to: 5, kind: 'unwind' }] });
  f.closePhi(counter, 2, f.binary('add', counter, f.constant(1, 32), 32));
  f.block(4);
  f.ret();
  f.block(5);
  f.ret();
  const { loop } = onlyLoop(f.build());
  const kinds = loop.exitEdges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`).sort();
  assert.deepEqual(kinds, ['1->4:conditional-false', '2->5:unwind']);
  // An unwind edge out of the body is an early exit like any other; it is not
  // quietly dropped to make the loop look counted.
  assert.equal(loop.earlyExitEdges.length, 1);
  assert.equal(loop.inductions[0].tripCount.exact, null);
});

test('a guard behind a logical not is read, and a flag comparison is refused', () => {
  const f = fixture('guard-shapes');
  f.block(0);
  const init = f.constant(0, 32);
  const limit = f.constant(5, 32);
  f.branch(1);
  f.block(1, { succ: [2, 3] });
  const counter = f.phi([[0, init], [2, null]], 32);
  // `not(is-zero(i - 5))` is `i != 5`, and the branch stays in the loop while it
  // holds. Both the `not` and the subtract-to-zero form are generic bitvector
  // facts, so both may be read.
  const difference = f.binary('sub', counter, limit, 32);
  const isZero = f.unary('is-zero', difference, 1);
  f.conditionalBranch(f.unary('not', isZero, 1), 2, 3);
  f.block(2, { succ: [1] });
  f.closePhi(counter, 2, f.binary('add', counter, f.constant(1, 32), 32));
  f.branch(1);
  f.block(3);
  f.ret();
  const { loop } = onlyLoop(f.build());
  assert.equal(loop.inductions[0].guard.predicate, 'ne');
  assert.equal(loop.inductions[0].bound.constant, 5n);
  assert.equal(loop.inductions[0].tripCount.exact, 5n);

  // A comparison of extracted condition-flag bits carries no generic meaning.
  const flags = readGuardPredicate({ id: 1, bits: 1, def: { op: 'cmp', sub: 'sub', args: [] } });
  assert.equal(flags.predicate, null);
  assert.match(flags.reason, /not a comparison this pass reads/);
});

test('near miss: an update that reverses or reads another variable is not a step', () => {
  const reversed = fixture('reversed');
  reversed.block(0);
  const init = reversed.constant(0, 32);
  const limit = reversed.constant(9, 32);
  reversed.branch(1);
  reversed.block(1, { succ: [2, 3] });
  const counter = reversed.phi([[0, init], [2, null]], 32);
  reversed.conditionalBranch(reversed.binary('ult', counter, limit, 1), 2, 3);
  reversed.block(2, { succ: [1] });
  // `9 - i`, not `i - 1`.
  reversed.closePhi(counter, 2, reversed.binary('sub', limit, counter, 32));
  reversed.branch(1);
  reversed.block(3);
  reversed.ret();
  const { loop } = onlyLoop(reversed.build());
  assert.equal(loop.inductions.length, 0);
  assert.match(loop.unresolvedLoopValues[0].reason, /not a monotone step/);
});

test('a call or a load in the body neither blocks a pure counter nor becomes one', () => {
  const f = fixture('barrier');
  f.block(0);
  const init = f.constant(0, 32);
  const limit = f.constant(7, 32);
  f.branch(1);
  f.block(1, { succ: [2, 3] });
  const counter = f.phi([[0, init], [2, null]], 32);
  const fromMemory = f.phi([[0, init], [2, null]], 32);
  f.conditionalBranch(f.binary('ult', counter, limit, 1), 2, 3);
  f.block(2, { succ: [1] });
  f.call(64);
  f.closePhi(counter, 2, f.binary('add', counter, f.constant(1, 32), 32));
  // A value reloaded from memory each iteration has no provable step, whatever
  // the counter beside it does.
  f.closePhi(fromMemory, 2, f.load(32, { locKey: 'stack:-4' }));
  f.branch(1);
  f.block(3);
  f.ret();
  const { loop } = onlyLoop(f.build());
  assert.equal(loop.inductions.length, 1);
  assert.equal(loop.inductions[0].tripCount.exact, 7n);
  assert.equal(loop.unresolvedLoopValues.length, 1);
  assert.match(loop.unresolvedLoopValues[0].reason, /not an add or a subtract/);
  assert.equal(loop.completeness, 'partial', 'one unresolved loop value keeps the loop partial');
});

test('a counted loop with a proved trip count is offered as a simplification candidate', () => {
  const { summary } = onlyLoop(countedLoop({ start: 0, bound: 12, step: 2n }).ir);
  assert.equal(summary.simplificationCandidates.length, 1);
  const [candidate] = summary.simplificationCandidates;
  assert.equal(candidate.kind, 'counted-loop');
  assert.equal(candidate.tripCount, 6n);
  assert.ok(candidate.targets.includes('block:1'));
  assert.match(candidate.proof, /without wrapping/);
  // The pass publishes candidates. It rewrites nothing.
  assert.equal(summary.loops.length, 1);
});

test('the pass transforms nothing and publishes exactly one analysis', () => {
  const { ledger } = inductionFacts(countedLoop().ir);
  const result = ledger.passes.find((entry) => entry.passId === 'phase8.induction');
  assert.ok(result);
  assert.equal(result.transforms.length, 0);
  assert.deepEqual([...result.produced], ['induction']);
  assert.deepEqual([...result.invalidated], []);
  assert.equal(ledger.transformCount, 0);
  assert.ok(ledger.produced.includes('induction'));
});

test('provenance survives: every loop and every fact names the instructions it came from', () => {
  const { loop } = onlyLoop(countedLoop().ir);
  assert.ok(loop.origin.instructionIds.length > 0);
  for (const fact of loop.inductions) {
    assert.ok(fact.origin.instructionIds.length > 0, `value ${fact.valueId} lost its origin`);
    for (const id of fact.origin.instructionIds) assert.equal(typeof id, 'string');
  }
});

test('the published facts are identical across runs', () => {
  const encode = (value) => JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? `${item}n` : item));
  // The same function, run twice. Two separately built fixtures would differ
  // only in their value numbering, which would test the fixture, not the pass.
  const { ir } = countedLoop();
  const first = inductionFacts(ir).facts;
  const second = inductionFacts(ir).facts;
  assert.equal(encode(first), encode(second));
});

test('cancellation withholds the whole ledger rather than publishing half the loops', () => {
  const { ir } = countedLoop();
  let calls = 0;
  const { ledger, facts } = inductionFacts(ir, { shouldAbort: () => { calls += 1; return calls > 3; } });
  assert.equal(ledger.published, false);
  assert.equal(facts, null);
  assert.equal(ledger.status, 'cancelled');
});

test('classifyLoop answers unverified when the dominator facts are missing', () => {
  const byIndex = new Map([[1, { index: 1, succ: [1] }]]);
  const outcome = classifyLoop(
    { header: 1, latches: [1], nodes: new Set([1]) },
    { byIndex, dominates: () => null },
  );
  assert.equal(outcome.classification, 'unverified');
  assert.match(outcome.reason, /is not available/);
});

test('tripCountOf refuses every direction and divisibility case it cannot close', () => {
  const base = { init: 0n, bound: 10n, bits: 32, signedness: 'unsigned' };
  assert.equal(tripCountOf({ ...base, predicate: 'ult', step: 0n }).exact, null);
  assert.match(tripCountOf({ ...base, predicate: 'ult', step: -1n }).reason, /upper bound but the step decreases/);
  assert.match(tripCountOf({ ...base, predicate: 'ugt', step: 1n }).reason, /lower bound but the step increases/);
  assert.match(tripCountOf({ ...base, predicate: 'ne', step: 3n }).reason, /does not divide the distance/);
  assert.equal(tripCountOf({ ...base, predicate: 'ne', step: 5n }).exact, 2n);
  assert.equal(tripCountOf({ ...base, predicate: 'ule', step: 1n }).exact, 11n);
  assert.equal(tripCountOf({ ...base, init: 20n, predicate: 'ult', step: 1n }).exact, 0n);
});

test('the pass and the artifact carry their own versions', () => {
  assert.equal(INDUCTION_PASS.stage, 'loop-facts');
  assert.deepEqual([...INDUCTION_PASS.produces], ['induction']);
  assert.ok(INDUCTION_PASS.consumes.includes('loops'));
  assert.ok(INDUCTION_PASS.consumes.includes('dominators'));
  const { summary } = onlyLoop(countedLoop().ir);
  assert.equal(summary.summaryVersion, INDUCTION_SUMMARY_VERSION);
  assert.equal(summary.passVersion, INDUCTION_PASS.version);
});

test('describeLoopFacts states the refusal rather than an empty loop', () => {
  const text = describeLoopFacts({ header: 3, classification: 'irreducible', classificationReason: 'two entries' });
  assert.match(text, /loop@3: irreducible \(two entries\)/);
});
