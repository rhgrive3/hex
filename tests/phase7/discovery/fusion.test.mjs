import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANDIDATE_STATES,
  EVIDENCE_AUTHORITY,
  createDiscoveryEvidence,
  createFunctionCandidate,
  hasExactStart,
  hasKnownExtent,
} from '../../../js/analysis/discovery/candidates.js';
import {
  DiscoveryProducerRegistry,
  fuseFunctionCandidates,
} from '../../../js/analysis/discovery/fusion.js';
import { GENERIC_PRODUCERS, createPatternProducer } from '../../../js/analysis/discovery/producers.js';
import { collectDiscoveryMetrics, runDiscoveryCase } from '../../../tools/validation/phase7/lanes/discovery.mjs';
import { DISCOVERY_TRUTH } from '../corpus/discovery.mjs';

const truthById = new Map(DISCOVERY_TRUTH.map((truth) => [truth.id, truth]));
const runById = (id, options) => runDiscoveryCase(truthById.get(id), options);
const at = (candidates, address) => candidates.find((candidate) => BigInt(candidate.start) === BigInt(address));

test('start and extent are independent facts', () => {
  // P7-INV-006. A candidate may know exactly where a function begins and
  // nothing about where it ends.
  const { candidates } = runById('d-start-without-extent');
  const candidate = at(candidates, 0x6000);
  assert.equal(candidate.startState, 'exact');
  assert.equal(candidate.extentState, 'unknown');
  assert.equal(hasExactStart(candidate), true);
  assert.equal(hasKnownExtent(candidate), false);
});

test('a candidate with an unknown extent cannot claim regions', () => {
  assert.throws(() => createFunctionCandidate({
    start: 0x1000, extentState: 'unknown', regions: [{ start: 0x1000, end: 0x1010 }],
  }), /unknown-extent-cannot-claim-regions/);
});

test('a byte pattern alone never establishes a function start', () => {
  const { candidates } = runById('d-stripped-heuristic-only');
  assert.ok(candidates.length > 0, 'the pattern producer must still raise candidates');
  for (const candidate of candidates) {
    assert.equal(candidate.startState, 'heuristic',
      'a prologue scanner must not manufacture exact functions on its own');
  }
});

test('two independent corroborating producers reach probable; one does not', () => {
  const { candidates } = runById('d-tail-call');
  // The tail-call target is named by a symbol and reached by a call edge.
  assert.equal(at(candidates, 0x3020).startState, 'probable');
  // The shared epilogue is reached by exception metadata only.
  const shared = at(runById('d-shared-epilogue').candidates, 0x2078);
  assert.equal(shared.startState, 'heuristic',
    'a single reference into the middle of a function is not a function start');
});

test('a non-contiguous function stays one function with two ranges', () => {
  const { candidates } = runById('d-non-contiguous');
  const starts = candidates.map((candidate) => BigInt(candidate.start));
  assert.deepEqual(starts, [0x5000n], 'a continuation range must not become a second function');
  const candidate = at(candidates, 0x5000);
  assert.equal(candidate.regions.length, 2);
  assert.equal(candidate.extentState, 'exact');
});

test('a tail-call target is not swallowed by its caller extent', () => {
  const { candidates } = runById('d-tail-call');
  const caller = at(candidates, 0x3000);
  assert.equal(BigInt(caller.regions[0].end), 0x3020n);
  assert.ok(at(candidates, 0x3020), 'the tail-call target must survive as its own candidate');
});

test('disagreeing extents are a conflict, not a preference', () => {
  const { candidates } = runById('d-contradictory-extents');
  const candidate = at(candidates, 0x8000);
  assert.equal(candidate.startState, 'exact', 'the start is not in dispute');
  assert.equal(candidate.extentState, 'unknown');
  assert.ok(candidate.conflicts.some((conflict) => conflict.kind === 'extent'));
});

test('an extent that swallows another function start is withdrawn', () => {
  // Either a false merge or a genuinely shared range. The fusion cannot tell,
  // so it records the conflict rather than picking an owner.
  const evidence = [
    createDiscoveryEvidence({ kind: 'loader-function-start', start: 0x100, producerId: 'p', regions: [{ start: 0x100, end: 0x200 }] }),
    createDiscoveryEvidence({ kind: 'loader-function-start', start: 0x180, producerId: 'p' }),
  ];
  const { candidates } = fuseFunctionCandidates(evidence, {});
  const outer = at(candidates, 0x100);
  assert.equal(outer.extentState, 'unknown');
  assert.ok(outer.conflicts.some((conflict) => conflict.detail.includes('contains another function start')));
  assert.equal(outer.startState, 'exact', 'the start survives the extent conflict');
});

test('authoritative sources disagreeing about a name is recorded', () => {
  const evidence = [
    createDiscoveryEvidence({ kind: 'export', start: 0x100, name: 'alpha', producerId: 'a' }),
    createDiscoveryEvidence({ kind: 'debug-symbol', start: 0x100, name: 'beta', producerId: 'b' }),
  ];
  const { candidates } = fuseFunctionCandidates(evidence, {});
  assert.ok(candidates[0].conflicts.some((conflict) => conflict.kind === 'name'));
});

test('every evidence kind declares its authority', () => {
  for (const [kind, authority] of Object.entries(EVIDENCE_AUTHORITY)) {
    assert.ok(['authoritative', 'corroborating', 'heuristic'].includes(authority), kind);
  }
  assert.throws(() => createDiscoveryEvidence({ kind: 'vibes', start: 0 }), /unknown-kind/);
});

test('candidate states are a closed set including contradicted', () => {
  assert.ok(CANDIDATE_STATES.includes('contradicted'));
  assert.throws(() => createFunctionCandidate({ start: 0, startState: 'probably' }), /invalid-start-state/);
});

test('the fusion never inspects a producer beyond its declared contract', () => {
  // A producer that returns evidence with an unknown-to-the-fusion field must
  // not change the fusion's behaviour: the boundary is one-directional.
  const registry = new DiscoveryProducerRegistry();
  registry.register({
    id: 'exotic',
    architectureId: 'made-up-arch',
    produce: () => [createDiscoveryEvidence({ kind: 'loader-function-start', start: 0x900, producerId: 'exotic' })],
  });
  const { evidence } = registry.collect({}, 'made-up-arch');
  const { candidates } = fuseFunctionCandidates(evidence, { architectureId: 'made-up-arch' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].startState, 'exact');
});

test('producers are selected by architecture and run in a deterministic order', () => {
  const registry = new DiscoveryProducerRegistry();
  for (const producer of GENERIC_PRODUCERS) registry.register(producer);
  registry.register(createPatternProducer({ id: 'zz.pattern.a', architectureId: 'arch-a', patterns: [] }));
  registry.register(createPatternProducer({ id: 'zz.pattern.b', architectureId: 'arch-b', patterns: [] }));
  const forA = registry.for('arch-a').map((producer) => producer.id);
  assert.ok(forA.includes('zz.pattern.a'));
  assert.ok(!forA.includes('zz.pattern.b'), 'another architecture\'s producer must not run');
  assert.deepEqual(forA, [...forA].sort(), 'producer order must be deterministic');
});

test('cancellation yields no candidates', () => {
  const controller = new AbortController();
  controller.abort();
  const result = fuseFunctionCandidates([
    createDiscoveryEvidence({ kind: 'export', start: 0x100, producerId: 'p' }),
  ], { signal: controller.signal });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.status.stopReason, 'cancelled');
});

test('a candidate budget that cannot hold the image fails closed', () => {
  const evidence = [];
  for (let index = 0; index < 10; index += 1) {
    evidence.push(createDiscoveryEvidence({ kind: 'export', start: 0x100 + index * 8, producerId: 'p' }));
  }
  const result = fuseFunctionCandidates(evidence, { budget: { maxCandidates: 2 } });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.status.stopReason, 'budget-exhausted');
});

test('start and extent metrics are reported independently and are sound', () => {
  const metrics = collectDiscoveryMetrics();
  assert.equal(metrics.candidate.falseStarts, 0, 'a start was asserted that the corpus says is not one');
  assert.equal(metrics.candidate.missedStarts, 0);
  assert.equal(metrics.candidate.startRecall, 1);
  assert.equal(metrics.candidate.falseSplit, 0);
  assert.equal(metrics.candidate.falseMerge, 0);
  assert.equal(metrics.candidate.overclaimedExtents, 0);
  assert.equal(metrics.candidate.missedConflicts, 0);
  // The two dimensions are separate numbers, not one blended score.
  assert.ok(typeof metrics.candidate.startPrecision === 'number');
  assert.ok(typeof metrics.candidate.extentPrecision === 'number');
});
