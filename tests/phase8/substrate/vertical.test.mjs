import assert from 'node:assert/strict';
import test from 'node:test';

import { passRegistryDigest, phase8Passes, runPhase8Stage, runPhase8Vertical } from '../../../js/decompiler/phase8/index.js';

const CONTEXT = Object.freeze({
  ir: { values: [{ id: 1 }, { id: 2 }], blocks: [{ id: 'entry' }] },
  types: null,
  opts: {},
});

test('the vertical publishes a frozen deterministic ledger', () => {
  const first = runPhase8Vertical(CONTEXT, {});
  const second = runPhase8Vertical(CONTEXT, {});
  assert.equal(first.ledger.status, 'published');
  assert.equal(first.ledger.published, true);
  assert.equal(first.ledger.transformCount, 0, 'the identity pass must not transform anything');
  assert.deepEqual(first.ledger.invalidated, []);
  assert.ok(Object.isFrozen(first.ledger));
  // Same input, same registry, same digest. Timings are excluded on purpose.
  assert.equal(first.ledger.publicationDigest, second.ledger.publicationDigest);
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

test('a pass that throws withholds the ledger instead of publishing a partial one', () => {
  // Exercised through the public runner by making the context hostile: the
  // identity pass reads ir.values, so a throwing accessor reproduces a pass
  // failure without a private test-only registry.
  const hostile = { get ir() { throw new Error('boom'); } };
  const { ledger } = runPhase8Vertical(hostile, {});
  assert.equal(ledger.published, false);
  assert.equal(ledger.status, 'failed');
  assert.match(ledger.stopReason, /^pass-failed:/);
  assert.equal(ledger.diagnostics[0].severity, 'error');
});

test('a function with no canonical values is unsupported, never complete', () => {
  const { ledger } = runPhase8Vertical({ ir: { values: [] } }, {});
  assert.equal(ledger.published, true);
  assert.equal(ledger.completeness, 'unknown');
  assert.equal(ledger.passes[0].status, 'unsupported');
  assert.equal(ledger.passes[0].stopReason, 'no-canonical-ssa-values');
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
  assert.equal(outcome.ledger.published, true);
  assert.ok(Number.isFinite(outcome.elapsedMs));
  const cancelled = runPhase8Stage(CONTEXT, { timeBudgetMs: 15, shouldAbort: () => true });
  assert.equal(cancelled.ledger.published, false);
});

test('a zero budget cancels rather than running unbounded', () => {
  assert.equal(runPhase8Stage(CONTEXT, { timeBudgetMs: 0 }).ledger.published, false);
});
