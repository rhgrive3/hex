import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONSTRAINT_ORIGINS,
  HARD_CONSTRAINT_KINDS,
  SOFT_EVIDENCE_KINDS,
  TYPE_LAYERS,
  claimsConflict,
  createHardConstraint,
  createSoftEvidence,
  createTypeClaim,
} from '../../../js/analysis/types/constraints.js';
import {
  TypeConstraintGraph,
  certainConclusions,
  selectedTypeIfCertain,
} from '../../../js/analysis/types/graph.js';
import { collectTypeMetrics } from '../../../tools/validation/phase7/lanes/types.mjs';
import { TYPE_CASES, caseConstraints } from '../corpus/types.mjs';

const machine = (entityId, widthBits, klass = 'integer') => ({
  layer: 'machine', entityId, descriptor: { widthBits, class: klass },
});

function graphFor(hard = [], soft = []) {
  const graph = new TypeConstraintGraph({ snapshotId: 'snapshot_types' });
  for (const constraint of hard) graph.addHardConstraint(constraint);
  for (const evidence of soft) graph.addSoftEvidence(evidence);
  return graph;
}

test('the four type layers stay separate', () => {
  assert.deepEqual([...TYPE_LAYERS], ['machine', 'abi', 'structural', 'nominal']);
  // A claim at one layer never conflicts with a claim at another, however
  // similar the descriptors look.
  const machineClaim = createTypeClaim(machine('e', 32));
  const nominalClaim = createTypeClaim({ layer: 'nominal', entityId: 'e', descriptor: { name: 'int32' } });
  assert.equal(claimsConflict(machineClaim, nominalClaim), false);
});

test('only an authoritative origin may state a hard constraint', () => {
  // FM-7 in structural form: a heuristic or an unverified debug file cannot
  // state a hard fact, however confident it sounds.
  for (const origin of ['heuristic', 'debug-unmatched', 'runtime-observed', 'library-model']) {
    assert.throws(() => createHardConstraint({ kind: 'access-width', origin, claim: machine('e', 32) }),
      /origin-not-authoritative/, `origin must not state hard facts: ${origin}`);
  }
  for (const origin of ['binary-evidence', 'abi-boundary', 'debug-matched', 'runtime-verified', 'user-approved']) {
    assert.doesNotThrow(() => createHardConstraint({ kind: 'access-width', origin, claim: machine('e', 32) }));
  }
  assert.ok(CONSTRAINT_ORIGINS.includes('debug-unmatched'), 'unmatched debug data must still be nameable');
});

test('hard and soft evidence use disjoint vocabularies', () => {
  const overlap = HARD_CONSTRAINT_KINDS.filter((kind) => SOFT_EVIDENCE_KINDS.includes(kind));
  assert.deepEqual(overlap, [], 'a kind that is both hard and soft erases the distinction');
});

test('an uncontradicted hard constraint yields a certain answer', () => {
  const result = graphFor([{ kind: 'access-width', origin: 'binary-evidence', claim: machine('e', 32) }]).solveEntity('e');
  assert.equal(result.layers.machine.confidence, 'certain');
  assert.equal(selectedTypeIfCertain(result, 'machine').descriptor.widthBits, 32);
});

test('contradicting hard constraints withhold selection entirely', () => {
  // Not "lower confidence" — no selection at all. A 70%-certain answer between
  // two mutually exclusive hard facts is a fabrication (FM-6).
  const result = graphFor([
    { kind: 'access-width', origin: 'binary-evidence', claim: machine('e', 32) },
    { kind: 'debug-type', origin: 'debug-matched', claim: machine('e', 64) },
  ]).solveEntity('e');
  assert.equal(result.layers.machine.contradictions.length, 1);
  assert.equal(result.layers.machine.confidence, 'unknown');
  assert.equal(result.layers.machine.selected, null);
  assert.equal(selectedTypeIfCertain(result, 'machine'), null);
});

test('soft evidence cannot break a hard contradiction', () => {
  const result = graphFor([
    { kind: 'access-width', origin: 'binary-evidence', claim: machine('e', 32) },
    { kind: 'debug-type', origin: 'debug-matched', claim: machine('e', 64) },
  ], [
    { kind: 'use-shape', origin: 'heuristic', weight: 1, claim: machine('e', 64) },
  ]).solveEntity('e');
  assert.equal(result.layers.machine.confidence, 'unknown');
});

test('soft evidence cannot overrule a hard constraint', () => {
  const result = graphFor(
    [{ kind: 'access-width', origin: 'binary-evidence', claim: machine('e', 8) }],
    [{ kind: 'array-stride-heuristic', origin: 'heuristic', weight: 1, claim: machine('e', 64) }],
  ).solveEntity('e');
  assert.equal(result.layers.machine.confidence, 'certain');
  assert.equal(result.layers.machine.selected.descriptor.widthBits, 8);
  assert.ok(!result.layers.machine.candidates.some((candidate) => candidate.claim.descriptor.widthBits === 64),
    'a soft candidate excluded by a hard constraint must not appear as a candidate at all');
});

test('soft evidence alone never reaches certainty', () => {
  const result = graphFor([], [
    { kind: 'symbol-spelling', origin: 'heuristic', weight: 0.99, claim: { layer: 'nominal', entityId: 'e', descriptor: { name: 'FILE' } } },
  ]).solveEntity('e');
  assert.equal(result.layers.nominal.confidence, 'probable');
  assert.equal(selectedTypeIfCertain(result, 'nominal'), null);
});

test('a tie between soft candidates is ambiguity, not a coin flip', () => {
  const result = graphFor([], [
    { kind: 'symbol-spelling', origin: 'heuristic', weight: 0.5, claim: { layer: 'nominal', entityId: 'e', descriptor: { name: 'Alpha' } } },
    { kind: 'signature-candidate', origin: 'heuristic', weight: 0.5, claim: { layer: 'nominal', entityId: 'e', descriptor: { name: 'Beta' } } },
  ]).solveEntity('e');
  assert.equal(result.layers.nominal.confidence, 'unknown');
  assert.equal(result.layers.nominal.selected, null);
});

test('overlapping storage with incompatible members is a conflict', () => {
  const overlapping = graphFor([
    { kind: 'debug-type', origin: 'debug-matched', claim: { layer: 'structural', entityId: 'u', descriptor: { offset: 0, sizeBytes: 8, memberType: { name: 'int64' } } } },
    { kind: 'debug-type', origin: 'debug-matched', claim: { layer: 'structural', entityId: 'u', descriptor: { offset: 0, sizeBytes: 8, memberType: { name: 'double' } } } },
  ]).solveEntity('u');
  assert.equal(overlapping.layers.structural.contradictions.length, 1);
});

test('disjoint fields coexist in one aggregate', () => {
  const disjoint = graphFor([
    { kind: 'debug-type', origin: 'debug-matched', claim: { layer: 'structural', entityId: 's', descriptor: { offset: 0, sizeBytes: 4, memberType: { name: 'int32' } } } },
    { kind: 'debug-type', origin: 'debug-matched', claim: { layer: 'structural', entityId: 's', descriptor: { offset: 8, sizeBytes: 4, memberType: { name: 'int32' } } } },
  ]).solveEntity('s');
  assert.equal(disjoint.layers.structural.contradictions.length, 0);
});

test('a declared alias is not a nominal conflict', () => {
  const aliased = graphFor([
    { kind: 'debug-type', origin: 'debug-matched', claim: { layer: 'nominal', entityId: 'a', descriptor: { name: 'uint32_t', aliases: ['uint32_t', 'unsigned int'] } } },
    { kind: 'call-prototype', origin: 'binary-evidence', claim: { layer: 'nominal', entityId: 'a', descriptor: { name: 'unsigned int', aliases: ['uint32_t', 'unsigned int'] } } },
  ]).solveEntity('a');
  assert.equal(aliased.layers.nominal.contradictions.length, 0);
  assert.equal(aliased.layers.nominal.confidence, 'certain');
});

test('a contradiction stays local to its entity and layer', () => {
  // One bad debug record must not poison unrelated components of the graph.
  const graph = graphFor([
    { kind: 'access-width', origin: 'binary-evidence', claim: machine('conflicted', 32) },
    { kind: 'debug-type', origin: 'debug-matched', claim: machine('conflicted', 64) },
    { kind: 'access-width', origin: 'binary-evidence', claim: machine('clean', 16) },
  ]);
  assert.equal(graph.solveEntity('conflicted').layers.machine.confidence, 'unknown');
  assert.equal(graph.solveEntity('clean').layers.machine.confidence, 'certain');
});

test('a user-approved constraint is provenance-tagged', () => {
  const result = graphFor([
    { kind: 'user-declared', origin: 'user-approved', claim: { layer: 'nominal', entityId: 'u', descriptor: { name: 'MyHandle' } } },
  ]).solveEntity('u');
  assert.equal(result.userConstrained, true);
  assert.equal(result.layers.nominal.hardConstraints[0].origin, 'user-approved');
});

test('a cancelled solve never presents a certain type', () => {
  const graph = graphFor([{ kind: 'access-width', origin: 'binary-evidence', claim: machine('e', 32) }]);
  const controller = new AbortController();
  controller.abort();
  const result = graph.solveEntity('e', { signal: controller.signal });
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(selectedTypeIfCertain(result, 'machine'), null);
  assert.deepEqual(certainConclusions(result), []);
});

test('an entity with no evidence reports unsupported, not a default type', () => {
  const result = graphFor().solveEntity('missing');
  assert.equal(result.status.completeness, 'unsupported');
  assert.deepEqual(certainConclusions(result), []);
});

test('the type corpus improves accuracy without increasing false certainty', () => {
  const metrics = collectTypeMetrics();
  assert.equal(metrics.candidate.falseCertainty, 0, 'a conclusion was presented as certain against exact truth');
  assert.equal(metrics.candidate.missedContradictions, 0, 'a declared contradiction went undetected');
  assert.equal(metrics.guardHolds, true, 'selectedTypeIfCertain must refuse on a contradicted layer');
  // Reported separately so debug ingestion cannot hide an inference regression.
  assert.equal(metrics.debugAssisted.falseCertainty, 0);
  assert.equal(metrics.noDebug.falseCertainty, 0);
  assert.ok(metrics.debugAssisted.accuracy >= metrics.noDebug.accuracy - 1e-9);
});

test('every corpus case declares constraints that build', () => {
  for (const testCase of TYPE_CASES) {
    for (const withDebug of [true, false]) {
      const { hard, soft } = caseConstraints(testCase, { withDebug });
      for (const constraint of hard) assert.doesNotThrow(() => createHardConstraint(constraint), testCase.id);
      for (const evidence of soft) assert.doesNotThrow(() => createSoftEvidence(evidence), testCase.id);
    }
  }
});
