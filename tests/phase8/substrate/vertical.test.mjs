import assert from 'node:assert/strict';
import test from 'node:test';

import { createPassDescriptor } from '../../../js/decompiler/phase8/contract.js';
import { INTERACTIVE_STAGES, PASS_STAGES, passRegistryDigest, phase8Passes, runPassTransaction, runPhase8Stage, runPhase8Vertical, seedAnalysisState } from '../../../js/decompiler/phase8/index.js';

/**
 * A minimal IR carrying exactly the canonical facts the identity pass declares
 * it consumes: blocks (cfg), values (ssa) and origins. Anything less and the
 * transaction correctly refuses to run the pass, which is a different case and
 * is covered separately below.
 */
const CONTEXT = Object.freeze({
  ir: {
    values: [{ id: 1, origin: { instructionIds: ['instruction_1'] } }, { id: 2, origin: { instructionIds: ['instruction_2'] } }],
    blocks: [{ id: 'entry' }],
    entry: 'entry',
    origin: { instructionIds: ['instruction_1'] },
  },
  types: null,
  opts: {},
});

test('the vertical publishes a frozen deterministic ledger', () => {
  const first = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  const second = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  assert.equal(first.ledger.status, 'published');
  assert.equal(first.ledger.published, true);
  assert.equal(first.ledger.transformCount, 0, 'the identity pass must not transform anything');
  assert.deepEqual(first.ledger.invalidated, []);
  assert.ok(Object.isFrozen(first.ledger));
  // Same input, same registry, same digest. Timings are excluded on purpose.
  assert.equal(first.ledger.publicationDigest, second.ledger.publicationDigest);
});

test('the enabled stage set is part of the ledger and of its registry digest', () => {
  // A ledger produced without the optimizer stages must never be servable for a
  // request that wanted them, so the two must be distinguishable.
  const interactive = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  const everything = runPhase8Vertical({ ...CONTEXT, enabledStages: PASS_STAGES }, {});
  assert.deepEqual([...interactive.ledger.enabledStages], [...INTERACTIVE_STAGES]);
  assert.notEqual(interactive.ledger.registryDigest, everything.ledger.registryDigest);
  assert.ok(everything.ledger.passes.length > interactive.ledger.passes.length);
});

test('cancellation before the first pass publishes nothing', () => {
  const { ledger } = runPhase8Vertical(CONTEXT, { shouldAbort: () => true });
  assert.equal(ledger.published, false);
  assert.equal(ledger.status, 'cancelled');
  assert.deepEqual(ledger.passes, []);
  assert.equal(ledger.completeness, 'unknown', 'a cancelled run knows nothing, it does not know that nothing was needed');
  assert.equal(ledger.stopReason, 'cancelled-before-start');
  assert.ok(ledger.diagnostics.length > 0, 'a withheld ledger must say why');
});

test('cancellation observed after a pass still withholds the whole ledger', () => {
  // The predicate returns false on the pre-flight check and true afterwards,
  // which is exactly the case where a partial optimizer set could be published.
  let calls = 0;
  const { ledger } = runPhase8Vertical(CONTEXT, { shouldAbort: () => (calls += 1) > 1 });
  assert.equal(ledger.published, false);
  assert.equal(ledger.status, 'cancelled');
  assert.deepEqual(ledger.passes, []);
});

test('a cancellation predicate that throws is treated as cancelled', () => {
  const { ledger } = runPhase8Vertical(CONTEXT, { shouldAbort() { throw new Error('gone'); } });
  assert.equal(ledger.published, false);
});

test('a failure while reading upstream facts withholds the ledger', () => {
  // Exercised through the public runner by making the context hostile, so the
  // failure path is the real one rather than a private test-only registry.
  const hostile = { get ir() { throw new Error('boom'); } };
  const { ledger, analysis } = runPhase8Vertical(hostile, {});
  assert.equal(ledger.published, false);
  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.stopReason, 'analysis-seed-failed');
  assert.equal(ledger.diagnostics[0].severity, 'error');
  assert.equal(analysis, null, 'no state may be handed on when the facts could not be read');
});

test('a pass that throws is not committed and withholds the ledger', () => {
  const throwing = {
    descriptor: createPassDescriptor({ id: 'phase8.throwing', version: '1.0.0', stage: 'scalar-optimization', consumes: ['ssa'], produces: ['ranges'] }),
    run() { throw new Error('boom'); },
  };
  const state = seedAnalysisState(CONTEXT.ir);
  const before = state.snapshot();
  const outcome = runPassTransaction(state, throwing, { analysis: state }, {});
  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^failed:/);
  assert.deepEqual(state.snapshot(), before, 'a thrown pass must leave no residue');
});

test('a pass whose declared inputs are absent does not run and is not complete', () => {
  // The transaction refuses rather than letting the pass improvise a substitute
  // for a missing upstream fact. The ledger still publishes, because "this pass
  // could not run and here is which fact was missing" is real information.
  const { ledger } = runPhase8Vertical({ ir: { values: [] }, enabledStages: INTERACTIVE_STAGES }, {});
  assert.equal(ledger.published, true);
  assert.equal(ledger.completeness, 'unknown');
  assert.equal(ledger.passes[0].status, 'unsupported');
  assert.match(ledger.passes[0].stopReason, /^missing-input:/);
  assert.equal(ledger.transformCount, 0);
  assert.equal(ledger.diagnostics[0].code, 'phase8.pass.missing-input');
});

test('the analysis state is seeded from upstream facts, never approximated', () => {
  const { analysis } = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  assert.deepEqual([...analysis.available()], ['cfg', 'ssa', 'origins']);
  // MemorySSA, alias, types and the rest were not supplied and stay absent at
  // version 0 rather than being invented.
  assert.equal(analysis.version('memorySsa'), 0);
  assert.equal(analysis.version('alias'), 0);
});

test('a committed no-op moves no analysis version', () => {
  const { ledger } = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, {});
  assert.deepEqual(ledger.analysisVersions.before, ledger.analysisVersions.after);
  assert.deepEqual(ledger.invalidated, []);
});

test('a withheld ledger reports the state as untouched', () => {
  const { ledger } = runPhase8Vertical({ ...CONTEXT, enabledStages: INTERACTIVE_STAGES }, { shouldAbort: () => true });
  assert.equal(ledger.published, false);
  assert.deepEqual(ledger.analysisVersions.before, ledger.analysisVersions.after);
});

test('the registry digest changes with the pass set and is stable otherwise', () => {
  const passes = phase8Passes();
  assert.equal(passRegistryDigest(passes), passRegistryDigest(phase8Passes()));
  const bumped = passes.map(({ descriptor }) => ({ descriptor: { ...descriptor, version: '9.9.9' } }));
  assert.notEqual(passRegistryDigest(passes), passRegistryDigest(bumped),
    'a version bump must change the registry digest, or a stale result stays servable');
});

test('passes are ordered by declared stage, not by registration order', () => {
  const stages = phase8Passes().map(({ descriptor }) => descriptor.stageIndex);
  assert.deepEqual(stages, [...stages].sort((left, right) => left - right));
});

test('the stage honours its own budget and reports its cost', () => {
  const outcome = runPhase8Stage(CONTEXT, { timeBudgetMs: 15 });
  assert.deepEqual([...outcome.ledger.enabledStages], [...INTERACTIVE_STAGES], 'the stage defaults to the interactive set, not the whole middle end');
  assert.equal(outcome.ledger.published, true);
  assert.ok(Number.isFinite(outcome.elapsedMs));
  const cancelled = runPhase8Stage(CONTEXT, { timeBudgetMs: 15, shouldAbort: () => true });
  assert.equal(cancelled.ledger.published, false);
});

test('a zero budget cancels rather than running unbounded', () => {
  assert.equal(runPhase8Stage(CONTEXT, { timeBudgetMs: 0 }).ledger.published, false);
});
