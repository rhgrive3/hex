import assert from 'node:assert/strict';
import { compileCapabilityRule, compileCapabilityRules, evaluateCapabilityRule, evaluateCapabilityRules } from '../../../js/knowledge/phase12-rules.js';

const rule = compileCapabilityRule({ id: 'has-xor', version: '1', capabilityId: 'crypto.xor', scope: 'function', requiredFeatures: ['effects'], when: { op: 'all', args: [{ op: 'contains', path: 'effects', value: 'xor' }, { op: 'gte', path: 'loopCount', value: 1 }] } });
const positive = evaluateCapabilityRule(rule, { snapshotId: 'snap-a', entityId: 'fn-a', features: { effects: ['load', 'xor'], loopCount: 2 }, evidenceIds: ['ev-a'], completeness: 'complete' });
assert.equal(positive.verdict, 'supported');
assert.equal(positive.confirmed, false);
assert.deepEqual(positive.evidenceIds, ['ev-a']);
const nearMiss = evaluateCapabilityRule(rule, { snapshotId: 'snap-b', entityId: 'fn-b', features: { effects: ['load'], loopCount: 2 }, completeness: 'complete' });
assert.equal(nearMiss.verdict, 'not-detected');
const partial = evaluateCapabilityRule(rule, { snapshotId: 'snap-c', entityId: 'fn-c', features: { effects: ['xor'], loopCount: 2 }, completeness: 'partial' });
assert.equal(partial.verdict, 'partial');
assert.ok(partial.assumptions.includes('upstream-analysis-incomplete'));

const ordered = compileCapabilityRules([
  { id: 'root', version: '1', capabilityId: 'root', dependencies: ['base'], when: { op: 'exists', path: 'marker' } },
  { id: 'base', version: '1', capabilityId: 'base', when: { op: 'equals', path: 'marker', value: true } },
]);
assert.deepEqual(ordered.map((item) => item.id), ['base', 'root']);
assert.equal(evaluateCapabilityRules(ordered, { features: { marker: true } }).length, 2);
assert.throws(() => compileCapabilityRules([
  { id: 'a', dependencies: ['b'], when: { op: 'exists', path: 'x' } },
  { id: 'b', dependencies: ['a'], when: { op: 'exists', path: 'x' } },
]), /cycle/);
console.log('[phase12] deterministic capability-rule tests passed');
