import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_KEYS, PASS_STAGES, PHASE8_CONTRACT_VERSION,
  createPassDescriptor, createPassResult, unchangedResult,
} from '../../../js/decompiler/phase8/contract.js';

function descriptor(overrides = {}) {
  return createPassDescriptor({
    id: 'phase8.test', version: '1.0.0', stage: 'scalar-optimization',
    consumes: ['ssa'], preserves: ['cfg'], invalidates: ['ranges'], ...overrides,
  });
}

test('a descriptor declares what it reads, keeps and destroys', () => {
  const pass = descriptor();
  assert.equal(pass.contractVersion, PHASE8_CONTRACT_VERSION);
  assert.equal(pass.stageIndex, PASS_STAGES.indexOf('scalar-optimization'));
  assert.deepEqual(pass.consumes, ['ssa']);
  assert.ok(Object.isFrozen(pass));
});

test('a descriptor that both preserves and invalidates an analysis is rejected', () => {
  // Not a style rule: downstream reuse would depend on which check ran first.
  assert.throws(() => descriptor({ preserves: ['ranges'], invalidates: ['ranges'] }),
    /preserves-and-invalidates:ranges/);
});

test('unknown stages, budget classes and analysis keys are rejected', () => {
  assert.throws(() => descriptor({ stage: 'whenever' }), /unknown-stage/);
  assert.throws(() => descriptor({ budgetClass: 'free' }), /unknown-budget-class/);
  assert.throws(() => descriptor({ consumes: ['vibes'] }), /unknown-consumed-analysis:vibes/);
  assert.throws(() => descriptor({ invalidates: ['vibes'] }), /unknown-invalidated-analysis:vibes/);
  assert.ok(ANALYSIS_KEYS.includes('memorySsa'));
});

test('a changed result must carry a transform, and a transform must carry provenance', () => {
  const pass = descriptor();
  assert.throws(() => createPassResult({ descriptor: pass, status: 'changed' }),
    /changed-without-transform-or-production/, 'a change with nothing to show for it is unauditable');
  assert.throws(() => createPassResult({
    descriptor: pass, status: 'changed',
    transforms: [{ kind: 'fold', proof: 'constant', targets: [] }],
  }), /transform-targets-required|transform-target-invalid/);
  assert.throws(() => createPassResult({
    descriptor: pass, status: 'changed',
    transforms: [{ kind: 'fold', targets: ['value_1'] }],
  }), /transform-proof-required/);

  const ok = createPassResult({
    descriptor: pass, status: 'changed',
    transforms: [{ kind: 'fold', targets: ['value_1'], proof: 'both operands constant', originRefs: ['instruction_1'] }],
    invalidated: ['ranges'],
  });
  assert.equal(ok.changed, true);
  assert.deepEqual(ok.invalidated, ['ranges']);
  assert.deepEqual(ok.preserved, ['cfg'], 'preserved analyses come from the declaration, not from the pass body');
});

test('a result may not invalidate what its descriptor never declared', () => {
  assert.throws(() => createPassResult({
    descriptor: descriptor(), status: 'changed',
    transforms: [{ kind: 'fold', targets: ['value_1'], proof: 'p' }],
    invalidated: ['types'],
  }), /undeclared-invalidation:types/);
});

test('an unchanged result cannot invalidate, and an unsupported result cannot claim completeness', () => {
  const pass = descriptor();
  assert.throws(() => createPassResult({ descriptor: pass, status: 'unchanged', invalidated: ['ranges'] }),
    /unchanged-invalidates/);
  assert.throws(() => createPassResult({ descriptor: pass, status: 'unsupported', completeness: 'complete' }),
    /unsupported-claims-complete/);
  assert.equal(unchangedResult(pass).status, 'unchanged');
});

test('an unchanged result may not carry transforms', () => {
  assert.throws(() => createPassResult({
    descriptor: descriptor(), status: 'unchanged', changed: false,
    transforms: [{ kind: 'fold', targets: ['value_1'], proof: 'p' }],
  }), /transform-without-change/);
});

test('an analysis pass may change the state by producing a fact, without a transform', () => {
  // SCCP rewrites nothing but still changes the state: "the optimizer ran and
  // found nothing" is not the same fact as "the optimizer never ran".
  const producer = createPassDescriptor({
    id: 'phase8.producer', version: '1.0.0', stage: 'scalar-optimization',
    consumes: ['ssa'], preserves: ['cfg'], produces: ['ranges'],
  });
  const result = createPassResult({ descriptor: producer, status: 'changed', produced: ['ranges'] });
  assert.equal(result.changed, true);
  assert.deepEqual(result.transforms, []);
  assert.deepEqual(result.produced, ['ranges']);
  assert.throws(() => createPassResult({ descriptor: producer, status: 'changed', produced: ['types'] }),
    /undeclared-production:types/);
  assert.throws(() => createPassResult({ descriptor: producer, status: 'unchanged', produced: ['ranges'] }),
    /production-without-change/);
});

test('a diagnostic must say why, not only what', () => {
  assert.throws(() => createPassResult({
    descriptor: descriptor(), status: 'unchanged',
    diagnostics: [{ severity: 'info', code: 'x' }],
  }), /diagnostic-message-required/);
});
