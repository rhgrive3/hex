import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import {
  createFunctionSummary,
  functionSummaryDigest,
  summaryIsPure,
  summaryMayWriteRegion,
} from '../../../js/analysis/summary/contract.js';

const complete = createAnalysisStatus({
  snapshotId: 's', analyzerId: 'phase7.summary.local', analyzerVersion: '1.0.0', completeness: 'complete',
});
const partial = createAnalysisStatus({
  snapshotId: 's', analyzerId: 'phase7.summary.local', analyzerVersion: '1.0.0',
  completeness: 'partial', stopReason: 'evidence-missing',
});

const base = (overrides = {}) => createFunctionSummary({
  functionId: 'fn_test', status: complete, noreturn: false, mayThrow: false, ...overrides,
});

test('an unresolved call can never coexist with a complete status', () => {
  assert.throws(() => createFunctionSummary({
    functionId: 'fn', status: complete,
    unknownCallEffects: [{ callSiteId: 'cs', reason: 'unresolved-target' }],
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, source: 'unknown-call-fallback' }],
  }), /unknown-call-cannot-be-complete/);
});

test('an unresolved call must contribute a broad write effect', () => {
  // Without it, a consumer reading only the region list would see an empty list
  // and treat the call as harmless — the exact shape of FM-4.
  assert.throws(() => createFunctionSummary({
    functionId: 'fn', status: partial,
    unknownCallEffects: [{ callSiteId: 'cs', reason: 'unresolved-target' }],
    memoryWriteRegions: [],
  }), /unknown-call-requires-broad-write-effect/);
});

test('an unresolved call cannot settle control-flow facts', () => {
  assert.throws(() => createFunctionSummary({
    functionId: 'fn', status: partial, noreturn: false, mayThrow: false,
    unknownCallEffects: [{ callSiteId: 'cs', reason: 'unresolved-target' }],
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, source: 'unknown-call-fallback' }],
  }), /unknown-call-cannot-settle-control-facts/);
});

test('a non-exhaustive indirect call must carry an unknown effect', () => {
  assert.throws(() => createFunctionSummary({
    functionId: 'fn', status: complete,
    indirectCallSets: [{ callSiteId: 'cs', candidateEntityIds: ['fn_a'], exhaustive: false }],
  }), /nonexhaustive-indirect-requires-unknown-effect/);
});

test('an effect source outside the fixed priority order is rejected', () => {
  assert.throws(() => createFunctionSummary({
    functionId: 'fn', status: complete,
    memoryWriteRegions: [{ regionId: 'r', regionKind: 'stack-fixed', source: 'vibes' }],
  }), /invalid-effect-source/);
});

test('an unknown-call reason outside the declared vocabulary is rejected', () => {
  assert.throws(() => createFunctionSummary({
    functionId: 'fn', status: partial,
    unknownCallEffects: [{ callSiteId: 'cs', reason: 'probably-fine' }],
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, source: 'unknown-call-fallback' }],
  }), /invalid-unknown-call-reason/);
});

test('an incomplete summary is never treated as pure', () => {
  const incomplete = base({
    status: partial,
    noreturn: 'unknown',
    mayThrow: 'unknown',
    unknownCallEffects: [{ callSiteId: 'cs', reason: 'summary-missing' }],
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, source: 'unknown-call-fallback' }],
  });
  assert.equal(summaryIsPure(incomplete), false);
  assert.equal(summaryMayWriteRegion(incomplete, 'any_region'), true);
});

test('a stale or missing summary reads as may-write, not as pure', () => {
  assert.equal(summaryMayWriteRegion(null, 'region_a'), true);
  assert.equal(summaryMayWriteRegion(undefined, null), true);
});

test('a proven effect-free summary is allowed to be pure', () => {
  // Conservatism must come from missing evidence, not from a blanket refusal —
  // otherwise precision can never be recovered.
  const pure = base({});
  assert.equal(summaryIsPure(pure), true);
  assert.equal(summaryMayWriteRegion(pure, 'region_a'), false);
});

test('a broad write effect covers every region', () => {
  const broad = base({
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, source: 'abi-rule', addressSpaces: ['memory'] }],
  });
  assert.equal(summaryMayWriteRegion(broad, 'region_anything'), true);
});

test('the digest changes when any effect-bearing field changes', () => {
  const reference = functionSummaryDigest(base({ memoryWriteRegions: [{ regionId: 'r1', regionKind: 'stack-fixed', source: 'proven-summary' }] }));
  assert.notEqual(reference, functionSummaryDigest(base({ memoryWriteRegions: [{ regionId: 'r2', regionKind: 'stack-fixed', source: 'proven-summary' }] })));
  assert.notEqual(reference, functionSummaryDigest(base({
    memoryWriteRegions: [{ regionId: 'r1', regionKind: 'stack-fixed', source: 'proven-summary' }], mayThrow: true,
  })));
  assert.equal(reference, functionSummaryDigest(base({ memoryWriteRegions: [{ regionId: 'r1', regionKind: 'stack-fixed', source: 'proven-summary' }] })));
});
