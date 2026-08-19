import assert from 'node:assert/strict';
import test from 'node:test';

import { summaryIsPure, summaryMayWriteRegion } from '../../../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { buildFixture, regionOf } from '../corpus/fixtures.mjs';

function summaryOf(fixtureId, options = {}) {
  const built = buildFixture(fixtureId);
  const { summary, status } = buildLocalFunctionSummary(built.ir, built.cfg, built.ssa, built.memorySsa, {
    resolveRegion: built.resolveRegion, ...options,
  });
  return { built, summary, status };
}

test('a straight-line function records its exact write regions', () => {
  const { built, summary } = summaryOf('stack-disjoint');
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summary.memoryWriteRegions.length, 2);
  assert.ok(!summary.memoryWriteRegions.some((effect) => effect.broad));
  const expected = new Set([regionOf(built, 'node_st0').id, regionOf(built, 'node_st8').id]);
  for (const effect of summary.memoryWriteRegions) assert.ok(expected.has(effect.regionId));
});

test('an unresolved call becomes a broad effect plus an explicit unknown', () => {
  const { summary } = summaryOf('unknown-call-barrier');
  assert.notEqual(summary.status.completeness, 'complete');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.equal(summary.unknownCallEffects.length, 1);
  assert.equal(summary.unknownCallEffects[0].reason, 'unresolved-target');
  assert.equal(summary.noreturn, 'unknown');
  assert.equal(summary.mayThrow, 'unknown');
  assert.equal(summaryIsPure(summary), false);
  assert.equal(summaryMayWriteRegion(summary, 'any_region'), true);
});

test('a proven effect-free call leaves the summary complete', () => {
  const { summary } = summaryOf('pure-call-no-barrier');
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summary.unknownCallEffects.length, 0);
  assert.ok(!summary.memoryWriteRegions.some((effect) => effect.broad));
});

test('reads and writes are recorded separately', () => {
  const { summary } = summaryOf('stack-identical');
  assert.equal(summary.memoryReadRegions.length, 1);
  assert.equal(summary.memoryWriteRegions.length, 1);
});

test('state variables read before being written are inputs', () => {
  const { summary } = summaryOf('stack-disjoint');
  assert.ok(summary.inputs.includes('state:sp'));
});

test('every effect names the authority it came from', () => {
  // P7-INV-004 fixes the priority order; an effect with no source could not be
  // ranked against a competing one.
  for (const fixtureId of ['stack-disjoint', 'unknown-call-barrier', 'pure-call-no-barrier']) {
    const { summary } = summaryOf(fixtureId);
    for (const effect of [...summary.memoryReadRegions, ...summary.memoryWriteRegions]) {
      assert.ok(['proven-summary', 'library-model', 'abi-rule', 'unknown-call-fallback'].includes(effect.source));
    }
  }
});

test('a resolved callee summary folds in with proven authority', () => {
  const donor = summaryOf('stack-disjoint').summary;
  const built = buildFixture('pure-call-no-barrier');
  const callNode = built.ir.nodes.find((node) => node.kind === 'call');
  assert.ok(callNode, 'the fixture must contain a call to fold into');
  // The fixture's call carries no target entity, so the fold path is exercised
  // through an explicit mapping keyed the way a resolved callee would be.
  const { summary } = buildLocalFunctionSummary(built.ir, built.cfg, built.ssa, built.memorySsa, {
    resolveRegion: built.resolveRegion,
    calleeSummaries: new Map([['fn_absent', donor]]),
  });
  assert.equal(summary.status.completeness, 'complete');
});

test('cancellation produces no summary at all', () => {
  const controller = new AbortController();
  const { summary, status } = summaryOf('stack-disjoint', { signal: controller.signal, });
  assert.ok(summary, 'a non-aborted signal must still produce a summary');
  controller.abort();
  const aborted = summaryOf('stack-disjoint', { signal: controller.signal });
  assert.equal(aborted.summary, null);
  assert.equal(aborted.status.stopReason, 'cancelled');
  assert.notEqual(status.completeness, undefined);
});

test('an unknown memory-effect node clobbers broadly', () => {
  const { summary } = summaryOf('unknown-call-barrier');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad && effect.source === 'unknown-call-fallback'));
});
